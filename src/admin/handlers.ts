// All /api/* management endpoints (ports of server.go admin handlers,
// admin_security.go, settings.go adminSettings, usage_http.go, conversations.go
// and graceful stubs for endpoints whose upstream features are not portable).

import type { HandlerCtx } from "../router";
import {
  jsonOut,
  writeOpenAIError,
  nowIso,
  extractOIDTID,
} from "../util";
import { describeUpstream } from "../errors";
import { effectiveOAuthConfig, type Env } from "../env";
import * as accountsStore from "../store/accounts";
import type { AccountToken } from "../types";
import * as keysStore from "../store/keys";
import * as adminStore from "../store/admin";
import * as settingsStore from "../store/settings";
import * as usageStore from "../store/usage";
import * as convStore from "../store/conversations";
import { healthSnapshot, clearAllCooldowns } from "../pipeline/account";
import {
  newVerifier,
  pkceChallenge,
  authorizationURL,
  newPKCEState,
  savePendingPKCE,
  loadPendingPKCE,
  exchangeCode,
  ropcToken,
} from "../auth/oauth";
import { modelCatalog, reasoningTone } from "../pipeline/catalog";
import { firstAccountCloudClient } from "../pipeline/m365cloud";
import { coordLockoutCheck, coordLockoutRecord } from "../do/coordination";

function clientIP(ctx: HandlerCtx): string {
  return (
    ctx.req.headers.get("CF-Connecting-IP") ??
    ctx.req.headers.get("X-Forwarded-For")?.split(",")[0].trim() ??
    ""
  );
}

function cookieValue(ctx: HandlerCtx, name: string): string | undefined {
  const cookie = ctx.req.headers.get("Cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}

function secureCookie(ctx: HandlerCtx): boolean {
  return ctx.url.protocol === "https:" || (ctx.req.headers.get("X-Forwarded-Proto") ?? "") === "https";
}

function sessionCookie(token: string, secure: boolean): string {
  return `m365_admin_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure ? "; Secure" : ""}`;
}

function clearCookie(secure: boolean): string {
  return `m365_admin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export async function hasValidAdminSession(ctx: HandlerCtx): Promise<boolean> {
  const token = cookieValue(ctx, adminStore.ADMIN_COOKIE);
  if (!token) return false;
  return adminStore.validAdminSession(ctx.env, token);
}

// ------------------------------------------------------------------ login ---
export async function handleLogin(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "POST") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  let password = "";
  try {
    const b = (await ctx.req.json()) as { password?: string };
    password = b.password ?? "";
  } catch {
    return writeOpenAIError(400, "invalid_request_error", "bad json");
  }
  // Global login-failure lockout (5 failures / 15 min) when the coordination
  // DO is bound; unbound deployments keep the previous behavior.
  const ip = clientIP(ctx);
  if (ip !== "") {
    const lock = await coordLockoutCheck(ctx.env, ip);
    if (lock?.locked) {
      return jsonOut(
        {
          error: {
            message: "too many failed login attempts; try again later",
            type: "rate_limit_error",
          },
        },
        429,
        { "Retry-After": String(lock.retryAfterSec ?? 900) }
      );
    }
  }
  const { ok, mustChange } = await adminStore.verifyAdminPassword(ctx.env, password);
  if (!ok || password === "") {
    if (ip !== "") await coordLockoutRecord(ctx.env, ip);
    return writeOpenAIError(401, "auth_error", "invalid administrator password");
  }
  const token = await adminStore.createAdminSession(ctx.env);
  const headers = { "Set-Cookie": sessionCookie(token, secureCookie(ctx)) };
  const passwordSource = await adminStore.adminPasswordSource(ctx.env);
  return jsonOut(
    { status: "authenticated", must_change_password: mustChange, password_source: passwordSource },
    200,
    headers
  );
}

export async function handleLogout(ctx: HandlerCtx): Promise<Response> {
  const token = cookieValue(ctx, adminStore.ADMIN_COOKIE);
  await adminStore.destroyAdminSession(ctx.env, token);
  return jsonOut(
    { status: "logged_out" },
    200,
    { "Set-Cookie": clearCookie(secureCookie(ctx)) }
  );
}

export async function handleSessionStatus(ctx: HandlerCtx): Promise<Response> {
  const authenticated = await hasValidAdminSession(ctx);
  const mustChange = authenticated ? await adminStore.currentMustChange(ctx.env) : false;
  const passwordSource = await adminStore.adminPasswordSource(ctx.env);
  return jsonOut({ authenticated, must_change_password: authenticated && mustChange, password_source: passwordSource });
}

export async function handleChangePassword(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "POST") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  if (!(await hasValidAdminSession(ctx))) {
    return writeOpenAIError(401, "auth_error", "administrator login required");
  }
  let current = "";
  let newPassword = "";
  try {
    const b = (await ctx.req.json()) as { current_password?: string; new_password?: string };
    current = b.current_password ?? "";
    newPassword = b.new_password ?? "";
  } catch {
    return writeOpenAIError(400, "invalid_request_error", "bad json");
  }
  const { ok } = await adminStore.verifyAdminPassword(ctx.env, current);
  if (!ok) {
    return writeOpenAIError(401, "auth_error", "current password is invalid");
  }
  const invalid = adminStore.validNewAdminPassword(newPassword);
  if (invalid) {
    return writeOpenAIError(400, "invalid_request_error", invalid);
  }
  await adminStore.changeAdminPassword(ctx.env, newPassword);
  return jsonOut(
    { status: "password_changed", reauthenticate: true },
    200,
    { "Set-Cookie": clearCookie(secureCookie(ctx)) }
  );
}

// ------------------------------------------------------------------- PKCE ---
interface PkceAccountView {
  id: string;
  email: string;
  displayName?: string;
  status: string;
  oid?: string;
  tid?: string;
}

export async function handleAuthStart(ctx: HandlerCtx): Promise<Response> {
  const env = ctx.env;
  const verifier = await newVerifier();
  const state = await newPKCEState(env);
  const challenge = await pkceChallenge(verifier);
  const cfg = await effectiveOAuthConfig(env);
  await savePendingPKCE(env, state, {
    verifier,
    created: nowIso(),
    status: "pending",
    redirectURI: cfg.redirectUri,
  });
  const { url } = await authorizationURL(env, state, challenge);
  return jsonOut({
    status: "pkce_ready",
    state,
    url,
    redirectUri: cfg.redirectUri,
    note: "If redirect is nativeclient, paste the final URL/code into /api/auth/callback after login.",
  });
}

export async function handleAuthStatus(ctx: HandlerCtx): Promise<Response> {
  const state = ctx.url.searchParams.get("state") ?? "";
  if (!state) {
    return writeOpenAIError(400, "invalid_request_error", "missing state");
  }
  const p = await loadPendingPKCE(ctx.env, state);
  if (!p) {
    return jsonOut({ status: "expired" });
  }
  const out: Record<string, unknown> = { status: p.status };
  if (p.account) out["account"] = p.account;
  if (p.error) out["error"] = p.error;
  return jsonOut(out);
}

export async function handleAuthCallback(ctx: HandlerCtx): Promise<Response> {
  const q = ctx.url.searchParams;
  let state = q.get("state") ?? "";
  let code = q.get("code") ?? "";
  let oauthError = q.get("error") ?? "";
  if (code === "" && oauthError === "") {
    const pasted = q.get("url");
    if (pasted) {
      try {
        const parsed = new URL(pasted);
        code = parsed.searchParams.get("code") ?? "";
        oauthError = parsed.searchParams.get("error") ?? "";
        if (!state) state = parsed.searchParams.get("state") ?? "";
      } catch {
        /* fallthrough */
      }
    }
  }
  if (!state || (code === "" && oauthError === "")) {
    return writeOpenAIError(400, "invalid_request_error", "missing state or authorization result");
  }
  const p = await loadPendingPKCE(ctx.env, state);
  if (!p) {
    return writeOpenAIError(400, "invalid_request_error", "invalid or expired state");
  }
  if (p.status !== "pending") {
    return writeOpenAIError(409, "invalid_request_error", "authorization result already consumed");
  }
  p.status = "processing";
  await savePendingPKCE(ctx.env, state, p);

  if (oauthError !== "") {
    p.status = "error";
    p.error = oauthError;
    await savePendingPKCE(ctx.env, state, p);
    return writeOpenAIError(400, "auth_error", `Microsoft authorization failed: ${oauthError}`);
  }

  try {
    const tok = await exchangeCode(ctx.env, code, p.verifier, p.redirectURI);
    const acc = await accountsStore.upsertAccount(ctx.env, tok);
    p.status = "authenticated";
    p.account = accountView(acc);
    await savePendingPKCE(ctx.env, state, p);

    // Loopback redirects get a friendly auto-closing page like the upstream.
    if (/^http:\/\/(127\.0\.0\.1|localhost):/.test(p.redirectURI)) {
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>M365 Copilot2API 授权完成</title><style>body{font:16px system-ui;text-align:center;padding:15vh 20px;color:#242424}main{max-width:520px;margin:auto}h1{font-size:26px}</style><main><h1>授权完成</h1><p>账号已经自动加入账号池，可以关闭此页面。</p><script>if(window.opener){window.opener.postMessage({type:"m365-auth-complete"},window.location.origin);setTimeout(()=>window.close(),300)}</script></main>`,
        { headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }
    return jsonOut({ status: "authenticated", account: accountView(acc) });
  } catch (e) {
    p.status = "error";
    p.error = e instanceof Error ? e.message : String(e);
    await savePendingPKCE(ctx.env, state, p);
    return writeOpenAIError(
      e instanceof Error && e.name === "OAuthError" ? 400 : 500,
      "auth_error",
      p.error!
    );
  }
}

function accountView(a: AccountToken): Record<string, unknown> {
  return {
    id: a.id,
    email: a.email,
    displayName: a.displayName,
    status: a.status,
    oid: a.oid,
    tid: a.tid,
  };
}

// ------------------------------------------------------------- health etc ---
export async function handleHealth(ctx: HandlerCtx): Promise<Response> {
  const list = await accountsStore.listAccounts(ctx.env);
  const cfg = await effectiveOAuthConfig(ctx.env);
  return jsonOut({
    status: "ok",
    auth: ["pkce"],
    chat: "chathub",
    clientId: cfg.clientId,
    scope: cfg.scope,
    tokenCache: "kv:m365-copilot2api_KV/accounts",
    accountCount: list.length,
    accountConcurrency: {},
  });
}

const VERSION = "0.5.0-cfworker.0.1.0";

export async function handleVersion(ctx: HandlerCtx): Promise<Response> {
  return jsonOut({
    version: VERSION,
    commit: "unknown",
    buildTime: "unknown",
    go: "cloudflare-workers",
    uptimeSeconds: 0,
    accounts: await accountsStore.countAccounts(ctx.env),
  });
}

export async function handleUpdate(_ctx: HandlerCtx): Promise<Response> {
  return jsonOut({
    current: VERSION,
    channel: "stable",
    updateAvailable: false,
    recommendUpdate: false,
    message: "当前为稳定版，可检查稳定版更新",
  });
}

// --------------------------------------------------------------- accounts ---
export async function handleAccountsList(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "GET") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  const list = await accountsStore.listAccounts(ctx.env);
  const health = await healthSnapshot(ctx.env);
  const out = list.map((a) => {
    let status = a.status;
    let cooldownUntil: string | undefined;
    const h = health[a.id];
    if (h && h["cooldownUntil"]) {
      status = "cooldown";
      cooldownUntil = String(h["cooldownUntil"]);
    }
    return {
      id: a.id,
      email: a.email,
      displayName: a.displayName,
      status,
      scheduleEnabled: !a.scheduleDisabled,
      callCount: 0,
      rateLimited: !!(h && h["authFailed"] !== true && status === "cooldown"),
      cooldownUntil,
      oid: a.oid,
      tid: a.tid,
      expiresAt: a.expiresAt,
      updatedAt: a.updatedAt,
    };
  });
  return jsonOut({ accounts: out, health });
}

export async function handleAccountRefresh(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "POST") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  let id = "";
  try {
    const b = (await ctx.req.json()) as { id?: string };
    id = (b.id ?? "").trim();
  } catch {
    return writeOpenAIError(400, "invalid_request_error", "bad json");
  }
  if (!id) return writeOpenAIError(400, "invalid_request_error", "bad json");
  try {
    const acc = await accountsStore.ensureValid(ctx.env, id);
    return jsonOut({
      status: "refreshed",
      account: {
        id: acc.id,
        email: acc.email,
        displayName: acc.displayName,
        status: acc.status,
        expiresAt: acc.expiresAt,
        updatedAt: acc.updatedAt,
      },
    });
  } catch (e) {
    return writeOpenAIError(502, "token_refresh_error", e instanceof Error ? e.message : String(e));
  }
}

export async function handleAccountSchedule(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "POST") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  let id = "";
  let enabled = true;
  try {
    const b = (await ctx.req.json()) as { id?: string; enabled?: boolean };
    id = (b.id ?? "").trim();
    enabled = !!b.enabled;
  } catch {
    return writeOpenAIError(400, "invalid_request_error", "bad json");
  }
  if (!id) return writeOpenAIError(400, "invalid_request_error", "bad json");
  const found = await accountsStore.setScheduleEnabled(ctx.env, id, enabled);
  if (!found) return writeOpenAIError(404, "not_found", "account not found");
  return jsonOut({ status: "updated", scheduleEnabled: enabled });
}

export async function handleTokenHealth(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method === "POST") {
    const results = await accountsStore.refreshAllExpired(ctx.env);
    const refreshed = results.filter((r) => r.success).length;
    return jsonOut({ refreshed, failed: results.length - refreshed, results });
  }
  const list = await accountsStore.listAccounts(ctx.env);
  const now = Date.now();
  const out = list.map((a) => {
    const expiresAtMs = Date.parse(a.expiresAt);
    const expired = now > expiresAtMs;
    return {
      id: a.id,
      email: a.email,
      status: a.status,
      expires_at: a.expiresAt,
      expired,
      expires_in: expired
        ? "expired"
        : `${Math.floor((expiresAtMs - now) / 1000)}s`,
    };
  });
  return jsonOut({ accounts: out, now: new Date().toISOString() });
}

export async function handleClearCooldown(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "POST") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  await clearAllCooldowns(ctx.env);
  return jsonOut({ status: "ok" });
}

export async function handleDeleteAccount(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "POST") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  let id = "";
  try {
    const b = (await ctx.req.json()) as { id?: string };
    id = b.id ?? "";
  } catch {
    return writeOpenAIError(400, "invalid_request_error", "bad json");
  }
  if (!id) return writeOpenAIError(400, "invalid_request_error", "bad json");
  await accountsStore.deleteAccount(ctx.env, id);
  return jsonOut({ status: "deleted" });
}

export async function handleProvisionAccount(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "POST") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  let email = "";
  let password = "";
  try {
    const b = (await ctx.req.json()) as { email?: string; password?: string };
    email = b.email ?? "";
    password = b.password ?? "";
  } catch {
    return writeOpenAIError(400, "invalid_request_error", "email and password required");
  }
  if (!email || !password) {
    return writeOpenAIError(400, "invalid_request_error", "email and password required");
  }
  try {
    const set = await ropcToken(ctx.env, email, password);
    const acc = await accountsStore.upsertAccount(ctx.env, set);
    return jsonOut({
      status: "provisioned",
      account: {
        id: acc.id,
        email: acc.email,
        displayName: acc.displayName,
        status: acc.status,
        expiresAt: acc.expiresAt,
      },
    });
  } catch (e) {
    return writeOpenAIError(502, "ropc_error", e instanceof Error ? e.message : String(e));
  }
}

// ------------------------------------------------------------------- keys ---
export async function handleAdminKeys(ctx: HandlerCtx): Promise<Response> {
  switch (ctx.req.method) {
    case "GET":
      return jsonOut({ keys: await keysStore.listKeys(ctx.env) });
    case "POST": {
      let name = "API key";
      try {
        const b = (await ctx.req.json()) as { name?: string };
        if (b.name && b.name.trim() !== "") name = b.name;
      } catch {
        return writeOpenAIError(400, "invalid_request_error", "bad json");
      }
      const { record, raw } = await keysStore.createKey(ctx.env, name);
      const view = { ...record, hash: undefined, raw: undefined };
      return jsonOut({ key: raw, record: view });
    }
    case "DELETE": {
      const id = ctx.url.searchParams.get("id") ?? "";
      const deleted = await keysStore.deleteKey(ctx.env, id);
      if (!deleted) return writeOpenAIError(404, "not_found", "key not found");
      return jsonOut({ status: "deleted" });
    }
    case "PUT": {
      let id = "";
      let name = "";
      let revoked: boolean | undefined;
      try {
        const b = (await ctx.req.json()) as { id?: string; name?: string; revoked?: boolean };
        id = b.id ?? "";
        name = b.name ?? "";
        revoked = b.revoked;
      } catch {
        return writeOpenAIError(400, "invalid_request_error", "bad json");
      }
      if (!id) return writeOpenAIError(400, "invalid_request_error", "bad json");
      const updated = await keysStore.updateKey(ctx.env, id, name, revoked);
      if (!updated) return writeOpenAIError(404, "not_found", "key not found");
      return jsonOut({ status: "updated" });
    }
    default:
      return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
}

// ----------------------------------------------------------------- models ---
export async function handleAdminModels(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "GET") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  const settings = await settingsStore.getSettings(ctx.env);
  return jsonOut({ object: "list", data: modelCatalog(settings) });
}

export async function handleAdminModelSync(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "POST") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  // Overall race guard: AbortSignal.timeout covers per-request stalls, but a
  // connect-phase hang once slipped past it (>40s). This guarantees the
  // endpoint always answers within ~31s so the console button never appears
  // dead.
  const tones = await Promise.race([
    fetchUpstreamTonesAll(ctx),
    new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 31_000)),
  ]);
  await persistDiscoveredTones(ctx.env, tones);
  return jsonOut({ synced: tones.length > 0, upstream_tones: tones, count: tones.length });
}

// Shared by the manual sync endpoint and the 24h auto-resync in `scheduled`.
export async function persistDiscoveredTones(env: Env, tones: string[]): Promise<void> {
  if (tones.length === 0) return;
  const s = await settingsStore.getSettings(env);
  const err = await settingsStore.saveSettings(env, {
    ...s,
    discoveredTones: tones,
    discoveredTonesAt: new Date().toISOString(),
  });
  if (err) console.warn("[tone-sync] persist failed:", err);
}

// Port of fetchUpstreamTones from codex_catalog.go.
async function fetchUpstreamTones(): Promise<string[]> {
  // Bounded fetches: without these the admin UI appears frozen while
  // Microsoft endpoints stall (the upstream Go version had a 30s client
  // timeout that was lost in the initial port).
  const pageResp = await fetch("https://m365.cloud.microsoft/", {
    signal: AbortSignal.timeout(15_000),
  });
  const page = await pageResp.text();
  const m = page.match(/main\.[a-f0-9]{8}\.js/);
  if (!m) return [];
  const bundleResp = await fetch(
    `https://res.public.onecdn.static.microsoft/midgard/versionless-v2/${m[0]}`,
    { signal: AbortSignal.timeout(15_000) }
  );
  const bundle = await bundleResp.text();
  return extractTones(bundle);
}

// Authenticated fallback: the tone-bearing SPA bundle only loads for signed-in
// sessions now, so retry the app pages with an account pool token attached.
// Best-effort — any failure simply yields no additional tones.
async function fetchUpstreamTonesAuthed(ctx: HandlerCtx): Promise<string[]> {
  let accessToken = "";
  try {
    const { resolveAccount } = await import("../pipeline/account");
    const acc = await resolveAccount(ctx.env, "");
    accessToken = acc.accessToken;
  } catch {
    return [];
  }
  if (!accessToken) return [];
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0",
    accept: "text/html,application/xhtml+xml,*/*;q=0.8",
  };
  const pages = [
    "https://m365.cloud.microsoft/chat",
    "https://m365.cloud.microsoft/",
  ];
  for (const u of pages) {
    try {
      const r = await fetch(u, { headers, signal: AbortSignal.timeout(7_000), redirect: "follow" });
      if (!r.ok) continue;
      const html = await r.text();
      const direct = extractTones(html);
      if (direct.length) return direct;
      // Scan referenced bundles, preferring main/midgard ones.
      const urls = [...new Set(html.match(/https:\/\/[^\s"']+?\.js\b/g) ?? [])];
      urls.sort((a, b) => Number(b.includes("midgard") || /main\./.test(b)) - Number(a.includes("midgard") || /main\./.test(a)));
      for (const bu of urls.slice(0, 4)) {
        try {
          const br = await fetch(bu, { headers, signal: AbortSignal.timeout(7_000) });
          if (!br.ok) continue;
          const found = extractTones(await br.text());
          if (found.length) return found;
        } catch {}
      }
    } catch {}
  }
  return [];
}

function extractTones(text: string): string[] {
  const seen = new Set<string>();
  for (const t of text.match(/(?:Gpt_[0-9]_[0-9]_[A-Za-z_]+|Claude_[A-Za-z0-9_]+|Magic)/g) ?? []) seen.add(t);
  return [...seen].sort();
}

// Tries anonymous scraping first, then the authenticated fallback while the
// overall 31s sync budget still allows it.
export async function fetchUpstreamTonesAll(ctx: HandlerCtx): Promise<string[]> {
  const started = Date.now();
  try {
    const anon = await fetchUpstreamTones();
    if (anon.length) return anon;
  } catch {}
  if (Date.now() - started < 15_000) {
    try {
      return await fetchUpstreamTonesAuthed(ctx);
    } catch {}
  }
  return [];
}

export async function handleAdminModelTest(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "POST") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  let model = "";
  let toneOverride = "";
  try {
    const b = (await ctx.req.json()) as { model?: string; tone?: string };
    model = (b.model ?? "").trim();
    toneOverride = (b.tone ?? "").trim();
  } catch {
    return writeOpenAIError(400, "invalid_request_error", "bad json: model required");
  }
  if (!model) return writeOpenAIError(400, "invalid_request_error", "bad json: model required");

  const settings = await settingsStore.getSettings(ctx.env);
  let toneOrErr: string | Error;
  if (toneOverride) {
    toneOrErr = /^[A-Za-z0-9_]{1,128}$/.test(toneOverride)
      ? toneOverride
      : new Error(`unsupported tone: ${toneOverride}`);
  } else {
    toneOrErr = reasoningTone(model, "", settings);
  }
  if (toneOrErr instanceof Error) {
    return writeOpenAIError(400, "invalid_request_error", toneOrErr.message);
  }

  const started = Date.now();
  const { resolveAccount } = await import("../pipeline/account");
  const { chat } = await import("../chathub/client");
  let acc: AccountToken;
  try {
    acc = await resolveAccount(ctx.env, "");
  } catch (e) {
    return writeUpstreamErrResponse(e);
  }
  if (!acc.oid || !acc.tid) {
    const { oid, tid } = extractOIDTID(acc.accessToken);
    acc.oid = acc.oid || oid;
    acc.tid = acc.tid || tid;
  }
  if (!acc.oid || !acc.tid) {
    return writeOpenAIError(400, "account_error", "account missing oid/tid");
  }
  try {
    const res = await chat(
      { accessToken: acc.accessToken, oid: acc.oid, tid: acc.tid },
      { text: 'Say "OK" in one word.', tone: toneOrErr },
      {},
      { timeoutMs: settings.chatTimeoutSeconds * 1000 }
    );
    return jsonOut({
      ok: true,
      model,
      reply: res.text,
      latency_ms: Date.now() - started,
    });
  } catch (e) {
    return writeOpenAIError(
      502,
      "m365_error",
      e instanceof Error ? sanitizeUpstream(e) : "upstream request failed"
    );
  }
}

function sanitizeUpstream(e: unknown): string {
  console.error("[admin] upstream failure:", e instanceof Error ? e.stack : String(e));
  return describeUpstream(e);
}

function writeUpstreamErrResponse(e: unknown): Response {
  const err = e as { name?: string; retryAfter?: number; status?: number } | null;
  console.error("[admin/model-test] resolve account failed:", e instanceof Error ? e.stack : String(e));
  const limited =
    err?.name === "RateLimitNotice" ||
    (err?.name === "UpstreamHTTPError" && err.status === 429);
  if (limited) {
    return jsonOut(
      { error: { message: "all accounts are cooling down; try again later", type: "rate_limit_error" } },
      429,
      { "Retry-After": String(err?.retryAfter && err.retryAfter > 0 ? err.retryAfter : 30) }
    );
  }
  return writeOpenAIError(502, "upstream_error", describeUpstream(e));
}

// --------------------------------------------------------------- settings ---
export async function handleAdminSettings(ctx: HandlerCtx): Promise<Response> {
  switch (ctx.req.method) {
    case "GET": {
      const settings = await settingsStore.getSettings(ctx.env);
      return jsonOut({
        settings,
        codexModels: settingsStore.CONFIGURABLE_CODEX_MODELS,
        upstreamTones: settingsStore.KNOWN_UPSTREAM_TONES,
        restartRequiredFields: settingsStore.RESTART_REQUIRED_FIELDS,
      });
    }
    case "PUT": {
      let patch: Record<string, unknown>;
      try {
        patch = (await ctx.req.json()) as Record<string, unknown>;
      } catch {
        return writeOpenAIError(400, "invalid_request_error", "bad json");
      }
      const cur = await settingsStore.getSettings(ctx.env);
      const merged = { ...(cur as unknown as Record<string, unknown>), ...patch };
      const v = merged as unknown as settingsStore.RuntimeSettings;
      const err = await settingsStore.saveSettings(ctx.env, v);
      if (err) return writeOpenAIError(400, "invalid_request_error", err);
      return jsonOut({ ok: true, settings: v });
    }
    default:
      return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
}

// ------------------------------------------------------------- usage/stats ---
export async function handleUsage(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "GET") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  let days = 7;
  const v = ctx.url.searchParams.get("days");
  if (v) {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n) && n > 0 && n <= 365) days = n;
  }
  return jsonOut({ days, stats: await usageStore.usageSnapshot(ctx.env, days) });
}

export async function handleUsageLogs(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "GET") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  let limit = 50;
  let offset = 0;
  const limitStr = ctx.url.searchParams.get("limit");
  if (limitStr) {
    const n = Number.parseInt(limitStr, 10);
    if (Number.isFinite(n) && n > 0 && n <= 2000) limit = n;
  }
  const offsetStr = ctx.url.searchParams.get("offset");
  if (offsetStr) {
    const n = Number.parseInt(offsetStr, 10);
    if (Number.isFinite(n) && n >= 0) offset = n;
  }
  return jsonOut(await usageStore.usageLogs(ctx.env, limit, offset));
}

export async function handleStats(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "GET") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  const { getCacheStats } = await import("../store/cacheStats");
  const stats = await getCacheStats(ctx.env);
  const sessions = (await import("../pipeline/resolver")).listResolverSessions;
  const activeSessions = (await sessions(ctx.env)).length;
  return jsonOut({
    object: "cache_stats",
    stats: { ...stats, active_sessions: activeSessions },
    conv_cache: { entries: activeSessions, hits: stats.cache_hits, misses: stats.cache_misses },
  });
}

export async function handleStatsReset(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "POST") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  const { resetCacheStats } = await import("../store/cacheStats");
  await resetCacheStats(ctx.env);
  return jsonOut({ status: "reset" });
}

// ----------------------------------------------------------- conversations ---
export async function handleConversations(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "GET") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  const bindings = await convStore.listSessionBindings(ctx.env);
  const conversations = bindings.map((b) => ({
    id: b.id,
    accountId: b.accountID,
    conversationId: b.conversationID,
    sessionId: b.sessionID,
    title: b.title,
    createdAt: b.updatedAt,
    updatedAt: b.updatedAt,
  }));
  return jsonOut({ conversations });
}

export async function handleConversationDelete(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "POST") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  let id = "";
  try {
    const b = (await ctx.req.json()) as { id?: string };
    id = b.id ?? "";
  } catch {
    return writeOpenAIError(400, "invalid_request_error", "bad json");
  }
  if (!id) return writeOpenAIError(400, "invalid_request_error", "bad json");
  await convStore.deleteLocalConversation(ctx.env, id);
  await convStore.deleteSessionBinding(ctx.env, id);
  const { deleteByConversation } = await import("../store/chatMessages");
  await deleteByConversation(ctx.env, id);
  return jsonOut({ status: "deleted" });
}

export async function handleConversationCleanup(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "POST") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  return jsonOut({ status: "cleaned", mode: "after_response", deleted: [], remaining: 0 });
}

export async function handleConversationWhitelist(ctx: HandlerCtx): Promise<Response> {
  return jsonOut({ whitelist: [] });
}

export async function handleSessionsV1(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method === "GET") {
    const { listResolverSessions } = await import("../pipeline/resolver");
    const resolved = await listResolverSessions(ctx.env);
    const legacy = await convStore.listSessionBindings(ctx.env);
    const seen = new Set(resolved.map((s) => s.sessionId));
    return jsonOut({
      object: "list",
      data: [
        ...resolved.map((s) => ({
          session_id: s.sessionId,
          conversation_id: s.conversationId,
          account_id: s.accountId,
          last_used_at: s.lastUsedAt,
        })),
        ...legacy
          .filter((b) => !seen.has(b.sessionID))
          .map((b) => ({
            session_id: b.sessionID,
            conversation_id: b.conversationID,
            account_id: b.accountID,
            last_used_at: b.updatedAt,
          })),
      ],
    });
  }
  if (ctx.req.method === "POST") {
    let sessionID = "";
    try {
      const b = (await ctx.req.json()) as { session_id?: string };
      sessionID = b.session_id ?? "";
    } catch {
      /* optional body */
    }
    const binding = sessionID ? await convStore.getSessionBinding(ctx.env, sessionID) : null;
    if (!binding) {
      return jsonOut({
        object: "session",
        id: sessionID,
        created: Math.floor(Date.now() / 1000),
        expires_in: 1800,
        status: "created",
      });
    }
    return jsonOut({
      object: "session",
      id: sessionID,
      conversation_id: binding.conversationID,
      created: Math.floor(Date.parse(binding.updatedAt) / 1000),
      status: "active",
    });
  }
  return writeOpenAIError(405, "invalid_request_error", "method not allowed");
}

export async function handleSessionDeleteV1(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "DELETE") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  const id = decodeURIComponent(ctx.url.pathname.slice("/v1/sessions/".length));
  const deleted = await convStore.deleteSessionBinding(ctx.env, id);
  if (!deleted) return writeOpenAIError(404, "not_found", "session not found");
  return jsonOut({ status: "deleted" });
}

// ------------------------------------------------------ m365 cloud convos ---
export async function handleM365Conversations(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "GET") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  const { listAccounts } = await import("../store/accounts");
  const accounts = await listAccounts(ctx.env);
  if (accounts.length === 0) {
    return writeOpenAIError(
      503,
      "m365_not_configured",
      "M365 cloud client not configured. Please add an M365 account first via PKCE authorization."
    );
  }
  const { listConversationsResilient } = await import("../pipeline/m365cloud");
  const { chats, error } = await listConversationsResilient(ctx.env);
  if (!chats) return writeOpenAIError(502, "m365_error", sanitizeUpstream(error));
  // Merge gateway-side resolver sessions so both sources are visible (#8).
  const merged: Record<string, unknown>[] = [...chats];
  try {
    const cloudIds = new Set(chats.map((c) => String(c["conversationId"] ?? "")));
    const { listResolverSessions } = await import("../pipeline/resolver");
    for (const r of await listResolverSessions(ctx.env)) {
      if (!r.conversationId || cloudIds.has(r.conversationId)) continue;
      merged.push({
        conversationId: r.conversationId,
        title: r.sessionId ? r.sessionId.slice(0, 24) : "(gateway)",
        source: "gateway",
        accountId: r.accountId,
        lastUsedAt: r.lastUsedAt,
      });
    }
  } catch {}
  return jsonOut({ data: merged });
}

export async function handleM365ConversationDetail(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "GET") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  const id = ctx.url.searchParams.get("id") ?? "";
  if (!id) {
    return writeOpenAIError(400, "invalid_request_error", "id required");
  }
  // Transcript rows captured on the /v1/* success path (batch C). Without the
  // D1 binding there is no stored history; the viewer shows an empty timeline.
  const { listMessages } = await import("../store/chatMessages");
  const rows = await listMessages(ctx.env, id);
  const conv = (await convStore.listConversations(ctx.env)).find((c) => c.id === id);
  let accountEmail = "";
  if (conv?.accountID) {
    const acc = await accountsStore.getAccount(ctx.env, conv.accountID);
    accountEmail = acc?.email ?? "";
  }
  return jsonOut({
    conversationId: id,
    chatName: conv?.title ?? "",
    accountId: conv?.accountID ?? "",
    accountEmail,
    createdAt: conv?.createdAt ?? "",
    updatedAt: conv?.updatedAt ?? "",
    messageCount: rows.length,
    messages: rows.map((r) => ({ role: r.role, content: r.content, createdAt: r.createdAt })),
    detail_unavailable: !ctx.env.DB,
  });
}

export async function handleM365Delete(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "POST") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  let conversationId = "";
  try {
    const b = (await ctx.req.json()) as { conversation_id?: string; id?: string };
    conversationId = b.conversation_id ?? b.id ?? "";
  } catch {
    return writeOpenAIError(400, "invalid_request_error", "bad json");
  }
  if (!conversationId) {
    return writeOpenAIError(400, "invalid_request_error", "conversation_id required");
  }
  const client = await firstAccountCloudClient(ctx.env);
  if (!client) {
    return writeOpenAIError(
      503,
      "m365_not_configured",
      "M365 cloud client not configured. Please add an M365 account first via PKCE authorization."
    );
  }
  try {
    await client.deleteConversation(conversationId);
    await convStore.deleteLocalConversation(ctx.env, conversationId);
    const { deleteByConversation } = await import("../store/chatMessages");
    await deleteByConversation(ctx.env, conversationId);
    return jsonOut({ status: "deleted" });
  } catch (e) {
    return writeOpenAIError(502, "m365_error", sanitizeUpstream(e));
  }
}

export async function handleM365Cleanup(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "POST") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  return jsonOut({ status: "cleaned", deleted: [] });
}

// ------------------------------------------------------------- debug stubs ---
export async function handleDebugLogs(_ctx: HandlerCtx): Promise<Response> {
  return jsonOut({ logs: [], total: 0 });
}

export async function handleDebugDetail(_ctx: HandlerCtx): Promise<Response> {
  return jsonOut({ detail: null });
}

export async function handleDeployments(_ctx: HandlerCtx): Promise<Response> {
  return jsonOut({ deployments: [] });
}

export async function handleDeploymentAction(_ctx: HandlerCtx): Promise<Response> {
  return writeOpenAIError(400, "unsupported_on_workers", "deployments are not supported here yet");
}

export async function handleDeploymentCheck(_ctx: HandlerCtx): Promise<Response> {
  return jsonOut({ ok: true, checked: 0 });
}

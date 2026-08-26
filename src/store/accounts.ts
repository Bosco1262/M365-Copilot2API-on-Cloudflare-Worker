// Account store on KV (port of internal/auth/cache.go Store).

import type { AccountToken, TokenSet } from "../types";
import { firstNonEmpty, nowIso } from "../util";
import { oauthConfig, type Env } from "../env";
import { OAuthError } from "../auth/oauth";
import { getJSON, putJSON } from "../kv";

interface AccountsDoc {
  accounts: AccountToken[];
  nextIdx: number;
}

const KEY = "accounts";

function emptyDoc(): AccountsDoc {
  return { accounts: [], nextIdx: 0 };
}

export async function listAccounts(env: Env): Promise<AccountToken[]> {
  const doc = await getJSON<AccountsDoc>(env["m365-copilot2api_KV"], KEY);
  return doc?.accounts ?? [];
}

async function saveDoc(env: Env, doc: AccountsDoc): Promise<void> {
  await putJSON(env["m365-copilot2api_KV"], KEY, doc);
}

async function loadDoc(env: Env): Promise<AccountsDoc> {
  return (await getJSON<AccountsDoc>(env["m365-copilot2api_KV"], KEY)) ?? emptyDoc();
}

// Round-robin over all accounts (port of Store.Next).
export async function nextAccount(env: Env): Promise<AccountToken | null> {
  const doc = await loadDoc(env);
  const n = doc.accounts.length;
  if (n === 0) return null;
  const acc = doc.accounts[doc.nextIdx % n];
  doc.nextIdx = (doc.nextIdx + 1) % n;
  await saveDoc(env, doc); // persist rotation; cheap and keeps behavior stable
  return acc;
}

export async function getAccount(env: Env, id: string): Promise<AccountToken | null> {
  const accounts = await listAccounts(env);
  return (
    accounts.find((a) => a.id === id || a.oid === id || a.email === id) ?? null
  );
}

export async function upsertAccount(env: Env, tok: TokenSet): Promise<AccountToken> {
  let id = tok.home_oid || tok.email || "";
  if (!id) id = `account-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}-${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0")}`;
  const acc: AccountToken = {
    id,
    email: tok.email ?? "",
    displayName: tok.display_name,
    status: "online",
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresAt: tok.expires_at,
    updatedAt: nowIso(),
    oid: firstNonEmpty(tok.home_oid, id),
    tid: tok.tenant_id,
    clientId: oauthConfig(env).clientId,
  };
  const doc = await loadDoc(env);
  let found = false;
  for (let i = 0; i < doc.accounts.length; i++) {
    const existing = doc.accounts[i];
    if (existing.id === acc.id || (acc.email !== "" && existing.email === acc.email)) {
      if (!acc.refreshToken) acc.refreshToken = existing.refreshToken;
      if (!acc.tid) acc.tid = existing.tid;
      if (!acc.oid) acc.oid = existing.oid;
      acc.scheduleDisabled = existing.scheduleDisabled;
      doc.accounts[i] = acc;
      found = true;
      break;
    }
  }
  if (!found) doc.accounts.push(acc);
  await saveDoc(env, doc);
  return acc;
}

export async function deleteAccount(env: Env, id: string): Promise<void> {
  const doc = await loadDoc(env);
  doc.accounts = doc.accounts.filter((a) => a.id !== id);
  await saveDoc(env, doc);
}

export async function setScheduleEnabled(env: Env, id: string, enabled: boolean): Promise<boolean> {
  const doc = await loadDoc(env);
  for (const a of doc.accounts) {
    if (a.id === id) {
      a.scheduleDisabled = !enabled;
      a.updatedAt = nowIso();
      await saveDoc(env, doc);
      return true;
    }
  }
  return false;
}

export function scheduleEnabled(acc: AccountToken): boolean {
  return !acc.scheduleDisabled;
}

export function tokenValid(acc: AccountToken): boolean {
  return acc.accessToken !== "" && Date.now() < Date.parse(acc.expiresAt) - 30_000;
}

export async function countAccounts(env: Env): Promise<number> {
  return (await listAccounts(env)).length;
}

// Port of Store.UpdateRefreshToken.
export async function updateRefreshToken(env: Env, id: string, refreshToken: string): Promise<boolean> {
  const trimmed = refreshToken.trim();
  if (trimmed === "") return true;
  const doc = await loadDoc(env);
  for (const a of doc.accounts) {
    if (a.id === id) {
      a.refreshToken = trimmed;
      a.updatedAt = nowIso();
      await saveDoc(env, doc);
      return true;
    }
  }
  return false;
}

// In-flight refresh coalescing (per isolate). AAD refresh tokens are
// single-use; concurrent EnsureValid calls for the same account must not each
// redeem one. Cross-isolate races remain possible but are unlikely for the
// single-operator deployments this Worker targets.
const inflight = new Map<string, Promise<{ acc: AccountToken; err: string | null }>>();

export async function ensureValid(env: Env, id: string): Promise<AccountToken> {
  const accounts = await listAccounts(env);
  const found = accounts.find((a) => a.id === id || a.oid === id || a.email === id);
  if (!found) throw new Error("account not found");
  if (tokenValid(found)) return found;
  if (!found.refreshToken) {
    await markStatus(env, found.id, "expired");
    found.status = "expired";
    throw new Error("token_expired: refresh token missing or expired");
  }
  let flight = inflight.get(found.id);
  if (!flight) {
    flight = performRefresh(env, found);
    inflight.set(found.id, flight);
    try {
      const { acc, err } = await flight;
      if (err) throw new Error(err);
      return acc;
    } finally {
      inflight.delete(found.id);
    }
  }
  const { acc, err } = await flight;
  if (err) throw new Error(err);
  return acc;
}

async function markStatus(env: Env, id: string, status: string): Promise<void> {
  const doc = await loadDoc(env);
  for (const a of doc.accounts) {
    if (a.id === id) {
      a.status = status;
      a.updatedAt = nowIso();
      await putJSON(env["m365-copilot2api_KV"], KEY, doc);
      return;
    }
  }
}

async function performRefresh(
  env: Env,
  acc: AccountToken
): Promise<{ acc: AccountToken; err: string | null }> {
  const cfg = oauthConfig(env);
  const endpoint =
    acc.clientId && acc.clientId === cfg.deviceClientId
      ? `${cfg.authority}/oauth2/v2.0/token`
      : cfg.tokenEndpoint;
  try {
    const tok = await refreshTokenRequest(acc.refreshToken!, acc.clientId || cfg.clientId, endpoint, cfg.scope);
    if (!tok.email) tok.email = acc.email;
    if (!tok.display_name) tok.display_name = acc.displayName;
    if (!tok.home_oid) tok.home_oid = firstNonEmpty(acc.oid, acc.id);
    if (!tok.tenant_id) tok.tenant_id = acc.tid;
    const saved = await upsertAccount(env, tok);
    return { acc: saved, err: null };
  } catch (e) {
    await markStatus(env, acc.id, "expired");
    return { acc, err: e instanceof Error ? e.message : String(e) };
  }
}

export interface TokenRefreshResult {
  id: string;
  email: string;
  success: boolean;
  error?: string;
  expires_at?: string;
}

export async function refreshAllExpired(env: Env): Promise<TokenRefreshResult[]> {
  const accounts = await listAccounts(env);
  const candidates = accounts.filter(
    (a) => Date.now() > Date.parse(a.expiresAt) - 30_000 && !!a.refreshToken
  );
  const results: TokenRefreshResult[] = [];
  for (const a of candidates) {
    try {
      const acc = await ensureValid(env, a.id);
      results.push({ id: a.id, email: a.email, success: true, expires_at: acc.expiresAt });
    } catch (e) {
      results.push({
        id: a.id,
        email: a.email,
        success: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}

// Port of auth.Refresh / requestTokenTenant (subset needed here).
async function refreshTokenRequest(
  refreshToken: string,
  clientId: string,
  tokenEndpoint: string,
  scope: string
): Promise<TokenSet> {
  const form = new URLSearchParams();
  form.set("client_id", clientId);
  form.set("grant_type", "refresh_token");
  form.set("refresh_token", refreshToken);
  form.set("scope", scope);
  const resp = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const text = await resp.text();
  let tr: Record<string, unknown>;
  try {
    tr = JSON.parse(text);
  } catch {
    throw new Error(`decode token response: invalid json`);
  }
  const errCode = tr["error"] as string | undefined;
  if (errCode) {
    throw new OAuthError(errCode, (tr["error_description"] as string) ?? "", resp.status);
  }
  const accessToken = tr["access_token"] as string | undefined;
  if (!accessToken) {
    throw new Error(`Refresh HTTP ${resp.status}: empty access token`);
  }
  const expiresIn = (tr["expires_in"] as number) ?? 3600;
  const set: TokenSet = {
    access_token: accessToken,
    refresh_token: tr["refresh_token"] as string | undefined,
    id_token: tr["id_token"] as string | undefined,
    token_type: tr["token_type"] as string | undefined,
    scope: tr["scope"] as string | undefined,
    expires_in: expiresIn,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
  const claims = claimsOf(accessToken, tr["id_token"] as string | undefined);
  set.email = firstNonEmpty(claims["unique_name"], claims["upn"], claims["preferred_username"], claims["email"]);
  set.display_name = firstNonEmpty(claims["name"], set.email);
  set.home_oid = firstNonEmpty(claims["oid"], claims["sub"]);
  set.tenant_id = firstNonEmpty(claims["tid"], claims["tenant_id"]);
  return set;
}

function claimsOf(accessToken: string, idToken?: string): Record<string, string> {
  // decodeJwtClaims import avoided to prevent cycle at module init cost; small dup ok.
  for (const t of [accessToken, idToken ?? ""]) {
    if (!t) continue;
    const parts = t.split(".");
    if (parts.length < 2) continue;
    try {
      const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
      const raw = atob(padded);
      const m = JSON.parse(new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0))));
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(m)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    } catch {
      continue;
    }
  }
  return {};
}

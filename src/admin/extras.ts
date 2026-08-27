// Port of remaining upstream web features that had no Worker home yet:
// conversation whitelist (conversation_manager.go), user sessions
// (sessions.go userSessions part), debug logging (debug.go, KV-backed ring),
// memory passthrough (memory_handlers.go) and deployment stubs
// (deployments.go).

import type { HandlerCtx } from "../router";
import type { Env } from "../env";
import { getJSON, putJSON, listPrefix } from "../kv";
import { jsonOut, writeOpenAIError, extractOIDTID, uuid } from "../util";
import * as accountsStore from "../store/accounts";
import { hasValidAdminSession } from "./handlers";

function kv(env: Env): KVNamespace {
  return env["m365-copilot2api_KV"];
}

async function readJsonBody(ctx: HandlerCtx): Promise<Record<string, unknown>> {
  try {
    return (await ctx.req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ------------------------------------------------------------ whitelist ----

const WHITELIST_KEY = "conv_whitelist";

export async function whitelistIDs(env: Env): Promise<string[]> {
  return (await getJSON<string[]>(kv(env), WHITELIST_KEY)) ?? [];
}

export async function handleConversationWhitelist(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method === "GET") {
    return jsonOut({ whitelist: await whitelistIDs(ctx.env) });
  }
  if (ctx.req.method !== "POST") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  const b = await readJsonBody(ctx);
  const action = String(b["action"] ?? "add").toLowerCase();
  const ids = Array.isArray(b["ids"])
    ? b["ids"].map(String)
    : typeof b["id"] === "string"
      ? [String(b["id"])]
      : [];
  if (ids.length === 0 || ids.some((i) => i.trim() === "")) {
    return writeOpenAIError(400, "invalid_request_error", "id(s) required");
  }
  const list = new Set(await whitelistIDs(ctx.env));
  if (action === "remove") ids.forEach((i) => list.delete(i.trim()));
  else ids.forEach((i) => list.add(i.trim()));
  await putJSON(kv(ctx.env), WHITELIST_KEY, [...list]);
  return jsonOut({ ok: true, whitelist: [...list] });
}

// ---------------------------------------------------------- userSessions ----
// Storage audit P2-1: each binding is an independent KV key
// `usess/<apiKeyHash>|<user>` with a 7-day TTL instead of one shared document
// that every request rewrote (RMW lost updates + write amplification). The
// legacy `user_sessions` document is migrated by the cron enumeration pass.

const USER_SESSIONS_PREFIX = "usess/";
const LEGACY_USER_SESSIONS_KEY = "user_sessions";
const USER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const USER_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
// Bound on enumerated entries per cron sweep (subrequest budget guard).
const USER_SESSION_MAX_SCAN = 200;

export interface UserSessionEntry {
  conversationId: string;
  sessionId: string;
  accountId: string;
  lastUsedAt: string;
}

// Tenant = SHA-256 of the API key so different keys never share bindings.
function userSessionKey(apiKeyHash: string, user: string): string {
  return USER_SESSIONS_PREFIX + apiKeyHash + "|" + user;
}

export async function getUserSession(
  env: Env,
  apiKeyHash: string,
  user: string
): Promise<UserSessionEntry | null> {
  if (!apiKeyHash || !user) return null;
  const entry = await getJSON<UserSessionEntry>(kv(env), userSessionKey(apiKeyHash, user));
  if (!entry) return null;
  if (Date.now() - Date.parse(entry.lastUsedAt) > USER_SESSION_TTL_MS) return null;
  return entry;
}

export async function putUserSession(
  env: Env,
  apiKeyHash: string,
  user: string,
  conversationId: string,
  sessionId: string,
  accountId: string
): Promise<void> {
  if (!apiKeyHash || !user || !conversationId) return;
  await putJSON(
    kv(env),
    userSessionKey(apiKeyHash, user),
    {
      conversationId,
      sessionId,
      accountId,
      lastUsedAt: new Date().toISOString(),
    } satisfies UserSessionEntry,
    { expirationTtl: USER_SESSION_TTL_SECONDS }
  );
}

export async function activeUserConversations(env: Env): Promise<Set<string>> {
  const out = new Set<string>();
  const store = kv(env);
  const now = Date.now();

  // One-time legacy migration: copy the old shared document into individual
  // keys, then clear it. Runs on the cron sweep only.
  try {
    const legacy = await getJSON<Record<string, UserSessionEntry>>(store, LEGACY_USER_SESSIONS_KEY);
    if (legacy && Object.keys(legacy).length > 0) {
      for (const [k, entry] of Object.entries(legacy)) {
        if (now - Date.parse(entry.lastUsedAt) > USER_SESSION_TTL_MS) continue;
        const sep = k.indexOf("|");
        if (sep <= 0) continue;
        await putUserSession(env, k.slice(0, sep), k.slice(sep + 1), entry.conversationId, entry.sessionId, entry.accountId);
      }
      await putJSON(store, LEGACY_USER_SESSIONS_KEY, {});
    }
  } catch {
    /* legacy migration is best-effort */
  }

  try {
    let cursor: string | undefined;
    let scanned = 0;
    do {
      const page = await store.list({ prefix: USER_SESSIONS_PREFIX, cursor });
      for (const k of page.keys) {
        if (scanned++ >= USER_SESSION_MAX_SCAN) return out;
        const entry = await getJSON<UserSessionEntry>(store, k.name);
        if (entry && now - Date.parse(entry.lastUsedAt) <= USER_SESSION_TTL_MS) {
          out.add(entry.conversationId);
        }
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  } catch {
    /* enumeration is best-effort */
  }
  return out;
}

// ----------------------------------------------------------- debug logs ----

const DEBUG_INDEX_KEY = "dbg:index";
const DEBUG_PREFIX = "dbg:";
const DEBUG_MAX_RECORDS = 500;
const DEBUG_TTL_SECONDS = 48 * 60 * 60;
const DEBUG_CAPTURE_LIMIT = 256 * 1024;

// Port of debug.go sensitive-key table (lowercase match, values replaced).
const REDACTED_KEYS = new Set([
  "api_key", "apikey", "accesstoken", "authorization", "access_token",
  "refreshtoken", "refresh_token", "clientsecret", "client_secret",
  "password", "current_password", "new_password", "currentpassword",
  "newpassword", "token", "bearer", "session_key", "secret", "next_token",
  "pkce_verifier", "code_verifier", "sessionkey", "nexttoken", "pkceverifier",
  "codeverifier",
]);

function sanitizeValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sanitizeValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = REDACTED_KEYS.has(k.toLowerCase()) && !(val && typeof val === "object")
        ? "[redacted]"
        : sanitizeValue(val);
    }
    return out;
  }
  return v;
}

function sanitizeBody(text: string): unknown {
  try {
    return sanitizeValue(JSON.parse(text));
  } catch {
    return text.slice(0, DEBUG_CAPTURE_LIMIT);
  }
}

function levelFor(status: number): string {
  return status >= 500 ? "error" : status >= 400 ? "warn" : "info";
}

export async function captureDebugRecord(
  env: Env,
  input: {
    path: string;
    method: string;
    status: number;
    durationMs: number;
    requestBody?: string;
    responseBody?: string;
    responseTruncated?: boolean;
  }
): Promise<void> {
  try {
    const recordId = "dbg_" + uuid();
    const record: Record<string, unknown> = {
      id: recordId,
      at: new Date().toISOString(),
      path: input.path,
      method: input.method,
      status: input.status,
      level: levelFor(input.status),
      durationMs: Math.round(input.durationMs),
      inputTokens: null,
      outputTokens: null,
      tokenSource: "unavailable_from_chathub",
      cacheHit: null,
      cacheSource: "not_reported_by_upstream",
      client: input.requestBody ? sanitizeBody(input.requestBody) : undefined,
      upstream: { captured: false, reason: "not_proxied_directly" },
      gateway:
        input.responseBody !== undefined
          ? { body: sanitizeBody(input.responseBody), truncated: !!input.responseTruncated }
          : { captured: false, reason: "streaming_or_empty_response" },
    };
    if (env.DB) {
      await env.DB
        .prepare(
          "INSERT INTO debug_records (id, at, path, method, status, level, duration_ms, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(
          recordId,
          String(record["at"]),
          input.path,
          input.method,
          input.status,
          String(record["level"]),
          Math.round(input.durationMs),
          JSON.stringify(record)
        )
        .run();
      // Retention sweep moved to the 30-minute cron (see index.ts scheduled):
      // running a DELETE on every insert duplicated the cron's job and added
      // one extra D1 write transaction per request.
      return;
    }
    await kv(env).put(DEBUG_PREFIX + recordId, JSON.stringify(record), {
      expirationTtl: DEBUG_TTL_SECONDS,
    });
    const index = (await getJSON<string[]>(kv(env), DEBUG_INDEX_KEY)) ?? [];
    index.unshift(recordId);
    while (index.length > DEBUG_MAX_RECORDS) {
      const dropped = index.pop();
      if (dropped) await kv(env).delete(DEBUG_PREFIX + dropped);
    }
    await putJSON(kv(env), DEBUG_INDEX_KEY, index);
  } catch (e) {
    // debugging must never break the request path
    console.warn("[debug-capture] failed:", e instanceof Error ? e.message : e);
  }
}

export async function handleDebugLogs(ctx: HandlerCtx): Promise<Response> {
  if (ctx.env.DB) {
    const res = await ctx.env.DB
      .prepare("SELECT json FROM debug_records ORDER BY at DESC LIMIT 500")
      .all<{ json: string }>();
    const records: unknown[] = [];
    for (const row of res.results) {
      try {
        records.push(JSON.parse(row.json));
      } catch {}
    }
    return jsonOut({ records });
  }
  const ids = (await getJSON<string[]>(kv(ctx.env), DEBUG_INDEX_KEY)) ?? [];
  const records: unknown[] = [];
  for (const id of ids) {
    const raw = await kv(ctx.env).get(DEBUG_PREFIX + id);
    if (raw) records.push(JSON.parse(raw));
  }
  return jsonOut({ records });
}

export async function handleDebugDetail(ctx: HandlerCtx): Promise<Response> {
  const id = ctx.url.searchParams.get("id") ?? "";
  if (ctx.env.DB) {
    const row = await ctx.env.DB
      .prepare("SELECT json FROM debug_records WHERE id = ?")
      .bind(id)
      .first<{ json: string }>();
    if (!row) return writeOpenAIError(404, "not_found", "debug record not found");
    return jsonOut(JSON.parse(row.json));
  }
  const raw = id ? await kv(ctx.env).get(DEBUG_PREFIX + id) : null;
  if (!raw) return writeOpenAIError(404, "not_found", "debug record not found");
  return jsonOut(JSON.parse(raw));
}

// One-shot migration: copy legacy KV usage day-buckets into D1 (idempotent —
// clears the D1 table first). Requires an admin session.
export async function handleUsageKvBackfill(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "POST") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  if (!ctx.env.DB) {
    return writeOpenAIError(400, "invalid_request_error", "no D1 binding configured");
  }
  const { listLegacyRecords } = await import("../store/usage");
  const records = await listLegacyRecords(ctx.env, 90);
  const db = ctx.env.DB;
  await db.prepare("DELETE FROM usage_events").run();
  let imported = 0;
  for (const rec of records) {
    try {
      await db
        .prepare("INSERT INTO usage_events (ts, api_key_prefix, model, json) VALUES (?, ?, ?, ?)")
        .bind(rec.time, rec.api_key_prefix ?? "", rec.model ?? "", JSON.stringify(rec))
        .run();
      imported++;
    } catch {}
  }
  return jsonOut({ ok: true, imported });
}

// -------------------------------------------------------- memory passthrough ----
// Port of memory_handlers.go: thin proxies over substrate.office.com using the
// account pool token. Mutations additionally require an admin session cookie.

const SUBSTRATE_BASE = "https://substrate.office.com";
const MEMORY_VARIANTS = "feature.EnablePersonalization";

async function m365Proxy(
  ctx: HandlerCtx,
  method: string,
  pathWithQuery: string,
  body?: string
): Promise<Response> {
  let acc;
  try {
    acc = await accountsStore.nextAccount(ctx.env);
  } catch (e) {
    return writeOpenAIError(502, "account_error", e instanceof Error ? e.message : "no account");
  }
  if (!acc) return writeOpenAIError(400, "account_error", "no M365 account configured");
  if (!acc.oid || !acc.tid) {
    const ids = extractOIDTID(acc.accessToken);
    acc.oid = acc.oid || ids.oid;
    acc.tid = acc.tid || ids.tid;
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${acc.accessToken}`,
    "x-anchormailbox": `Oid:${acc.oid}@${acc.tid}`,
    "x-routingparameter-sessionkey": acc.oid,
    "x-scenario": "OfficeWebIncludedCopilot",
    "x-clientrequestid": uuid().replace(/-/g, "").slice(0, 16),
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  const resp = await fetch(SUBSTRATE_BASE + pathWithQuery, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await resp.text();
  return jsonOut(
    text ? (JSON.parse(text) as unknown) : {},
    resp.status as 200,
    { "X-M365-Account": acc.id }
  );
}

async function requireAdmin(ctx: HandlerCtx): Promise<Response | null> {
  if (!(await hasValidAdminSession(ctx))) {
    return writeOpenAIError(403, "auth_error", "admin session required");
  }
  return null;
}

export async function handleMemoryFlags(ctx: HandlerCtx): Promise<Response> {
  const path = `/m365Copilot/PersonalizationUserFlags?variants=${MEMORY_VARIANTS}`;
  if (ctx.req.method === "GET") return m365Proxy(ctx, "GET", path);
  if (ctx.req.method === "PATCH") {
    const denied = await requireAdmin(ctx);
    if (denied) return denied;
    const body = await ctx.req.text();
    if (body.length > 1024 * 1024) {
      return writeOpenAIError(413, "invalid_request_error", "body too large");
    }
    return m365Proxy(ctx, "POST", path, body); // upstream PATCHes via POST
  }
  return writeOpenAIError(405, "invalid_request_error", "method not allowed");
}

export async function handleMemoryInstructions(ctx: HandlerCtx): Promise<Response> {
  const path = `/m365Copilot/CustomInstructions?variants=${MEMORY_VARIANTS}`;
  if (ctx.req.method === "GET") return m365Proxy(ctx, "GET", path);
  if (ctx.req.method === "PUT") {
    const denied = await requireAdmin(ctx);
    if (denied) return denied;
    const body = await ctx.req.text();
    if (body.length > 1024 * 1024) {
      return writeOpenAIError(413, "invalid_request_error", "body too large");
    }
    return m365Proxy(ctx, "POST", path, body);
  }
  return writeOpenAIError(405, "invalid_request_error", "method not allowed");
}

export async function handleMemoryInstructionDelete(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "DELETE") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  const denied = await requireAdmin(ctx);
  if (denied) return denied;
  const id = ctx.url.pathname.split("/").pop() ?? "";
  if (!id) return writeOpenAIError(400, "invalid_request_error", "instruction id required");
  return m365Proxy(
    ctx,
    "DELETE",
    `/m365Copilot/CustomInstructions/${encodeURIComponent(id)}?variants=${MEMORY_VARIANTS}`
  );
}

export async function handleMemorySettings(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "PATCH") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  const denied = await requireAdmin(ctx);
  if (denied) return denied;
  const body = await ctx.req.text();
  if (body.length > 1024 * 1024) {
    return writeOpenAIError(413, "invalid_request_error", "body too large");
  }
  return m365Proxy(ctx, "PATCH", "/puds/v1/me/settings/copilot", body);
}

// ------------------------------------------------- console memory card ----
// Admin-session variants of the memory proxies so the console (cookie auth,
// no API key) can drive the same substrate endpoints. GET is also gated —
// the console is the only intended consumer.

export async function handleAdminMemoryFlags(ctx: HandlerCtx): Promise<Response> {
  const denied = await requireAdmin(ctx);
  if (denied) return denied;
  const path = `/m365Copilot/PersonalizationUserFlags?variants=${MEMORY_VARIANTS}`;
  if (ctx.req.method === "GET") return m365Proxy(ctx, "GET", path);
  if (ctx.req.method === "PATCH") {
    const body = await ctx.req.text();
    if (body.length > 1024 * 1024) return writeOpenAIError(413, "invalid_request_error", "body too large");
    return m365Proxy(ctx, "POST", path, body); // upstream PATCHes via POST
  }
  return writeOpenAIError(405, "invalid_request_error", "method not allowed");
}

export async function handleAdminMemoryInstructions(ctx: HandlerCtx): Promise<Response> {
  const denied = await requireAdmin(ctx);
  if (denied) return denied;
  const path = `/m365Copilot/CustomInstructions?variants=${MEMORY_VARIANTS}`;
  if (ctx.req.method === "GET") return m365Proxy(ctx, "GET", path);
  if (ctx.req.method === "PUT") {
    const body = await ctx.req.text();
    if (body.length > 1024 * 1024) return writeOpenAIError(413, "invalid_request_error", "body too large");
    return m365Proxy(ctx, "POST", path, body);
  }
  return writeOpenAIError(405, "invalid_request_error", "method not allowed");
}

export async function handleAdminMemoryInstructionDelete(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "DELETE" && ctx.req.method !== "POST") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  const denied = await requireAdmin(ctx);
  if (denied) return denied;
  let id = ctx.url.pathname.split("/").pop() ?? "";
  if (!id || id === "delete") {
    try {
      const b = (await ctx.req.json()) as { id?: string };
      id = b.id ?? "";
    } catch {}
  }
  if (!id) return writeOpenAIError(400, "invalid_request_error", "instruction id required");
  return m365Proxy(
    ctx,
    "DELETE",
    `/m365Copilot/CustomInstructions/${encodeURIComponent(id)}?variants=${MEMORY_VARIANTS}`
  );
}

// ----------------------------------------------------------- deployments ----
// Upstream manages Cloudflare deployments from a self-hosted box; on Workers
// the list is always empty and mutations are rejected.

export async function handleDeploymentsList(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "GET") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  return jsonOut({ items: [] });
}

export async function handleDeploymentsMutate(ctx: HandlerCtx): Promise<Response> {
  return writeOpenAIError(
    501,
    "invalid_request_error",
    "deployment management is not applicable when running on Workers"
  );
}

// ------------------------------------------------------------- /api/plugins ----
// Port of plugins.go: passthrough of the substrate EventListener plugin list,
// per-account 5-minute cache. Accepts API key OR admin session (upstream used
// the API-key middleware on this path).

export async function handlePluginsList(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "GET") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  const { validAPIKey } = await import("../api/auth");
  if (!(await validAPIKey(ctx)) && !(await hasValidAdminSession(ctx))) {
    return writeOpenAIError(401, "auth_error", "valid API key required");
  }
  const accountId = ctx.url.searchParams.get("account") ?? "";
  let acc;
  try {
    acc = accountId
      ? await accountsStore.getAccount(ctx.env, accountId)
      : await accountsStore.nextAccount(ctx.env);
  } catch {
    acc = null;
  }
  if (!acc) return writeOpenAIError(400, "account_error", "no M365 account configured");

  const cacheKey = `plugins_cache:${acc.id}`;
  const cached = (await getJSON<{ at: string; body: string }>(kv(ctx.env), cacheKey)) ?? null;
  if (cached && Date.now() - Date.parse(cached.at) < 5 * 60_000) {
    return new Response(cached.body, {
      headers: { "Content-Type": "application/json", "X-Cache": "HIT" },
    });
  }

  const resp = await fetch(
    `${SUBSTRATE_BASE}/m365Copilot/EventListener/Client?EventId=ExecuteAction`,
    {
      headers: { authorization: `Bearer ${acc.accessToken}`, "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0" },
      signal: AbortSignal.timeout(30_000),
    }
  );
  const text = (await resp.text()).slice(0, 2 * 1024 * 1024);
  await putJSON(kv(ctx.env), cacheKey, { at: new Date().toISOString(), body: text });
  return new Response(text, {
    status: resp.status,
    headers: { "Content-Type": resp.headers.get("content-type") ?? "application/json", "X-Cache": "MISS", "X-M365-Account": acc.id },
  });
}

// Content-key session resolver (port of internal/web/session_resolver.go).
//
// Sessions are keyed by ChatHub sessionId; resolution order mirrors upstream:
//   1. explicit id (X-M365-Session-Id) — highest priority, no identity checks
//   2. strict context-prefix match (same IP fingerprint, within context TTL),
//      longest prefix wins -> HistoryLen enables incremental sending
//   3. common-suffix fallback (min 2 messages) -> reuse
//   4. new session
//
// Storage audit P0-1: sessions used to live in ONE KV document
// ("resolver-sessions") holding up to 1000 sessions x 512 messages each —
// every request read and rewrote the whole multi-megabyte blob, and the
// read-modify-write pattern silently lost concurrent sessions. Now each
// session is an independent KV key `resolver/<sessionId>` (TTL 2h) and the
// candidate index is a small lightweight summary.
//
// Storage review (low #1): the index itself is now a D1 table
// (resolver_sessions, migrations/0004_resolver_sessions.sql) so concurrent
// binds no longer lose entries through single-document RMW. The KV
// "resolver-index" document remains as the no-D1 fallback and as the one-time
// lazy backfill source; the legacy "resolver-sessions" document is still
// migrated on first load.

import type { Env } from "../env";
import { getJSON, putJSON } from "../kv";
import { sha256Hex } from "../util";
import type { OaiMsg } from "./prompt";
import { contentToString } from "./prompt";

const PREFIX = "resolver/";
const INDEX_KEY = "resolver-index";
const LEGACY_KEY = "resolver-sessions";
const SESSION_TTL_SECONDS = 2 * 3600;

export const DEFAULT_MAX_SESSIONS = 1000;
export const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_CONTEXT_TTL_MS = 2 * 60 * 60 * 1000;

// Index entries are refreshed on touch at most this often, so a request that
// only continues an existing session performs no index write at all.
const INDEX_TOUCH_THROTTLE_MS = 5 * 60_000;
// Session blob rewrites on the touch path are throttled to this window; the
// 2h KV TTL only needs a refresh every ~10min to stay warm, so a busy session
// does not pay one blob write per request. bindSession refreshes lastWriteAt
// on every turn, so the steady-state cost is one blob write per exchange.
const SESSION_TOUCH_THROTTLE_MS = 10 * 60_000;
// Slack added when filtering candidates by the (throttled) index timestamps.
const INDEX_STALE_SLACK_MS = 6 * 60_000;
// Upper bound of full session reads per resolve (subrequest budget guard).
const MAX_CANDIDATES = 24;
// Upper bound of full session reads for console/listing paths.
const LIST_MAX_FULL_READS = 50;

const INDEX_UPSERT_SQL = `INSERT INTO resolver_sessions (session_id, conversation_id, account_id, last_used_at, ip_fingerprint)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
  conversation_id = excluded.conversation_id,
  account_id = excluded.account_id,
  last_used_at = excluded.last_used_at,
  ip_fingerprint = excluded.ip_fingerprint`;

export interface ResolverSession {
  sessionId: string;
  conversationId: string;
  accountId: string;
  createdAt: string;
  lastUsedAt: string;
  ipFingerprint?: string;
  userField?: string;
  contextFinger?: string;
  contextHistory?: OaiMsg[];
  /** Last time the blob itself was persisted (touch-write throttle). */
  lastWriteAt?: string;
}

export interface IndexEntry {
  sessionId: string;
  conversationId: string;
  accountId: string;
  lastUsedAt: string;
  ipFingerprint?: string;
}

export interface ResolveResult {
  sessionId: string;
  conversationId: string;
  accountId: string;
  matchedBy: string;
  isNew: boolean;
  historyLen: number;
}

function sessionKey(sessionId: string): string {
  return PREFIX + sessionId;
}

// ------------------------------------------------------------- storage ---

function toIndexEntry(s: ResolverSession): IndexEntry {
  return {
    sessionId: s.sessionId,
    conversationId: s.conversationId,
    accountId: s.accountId,
    lastUsedAt: s.lastUsedAt,
    ipFingerprint: s.ipFingerprint,
  };
}

// ------------------------------------------------------------- D1 layer ---
// Storage review (Phase 3): per-session blobs move to D1
// (migrations/0006_resolver_blobs_d1.sql) so the last per-request KV write
// (bindSession) disappears — KV writes were the binding free-tier quota.
// Oversized blobs (rare; D1 rows cap at 2 MB) and no-DB deployments stay on
// KV, which also remains the read fallback on a D1 miss so pre-migration
// entries keep working. KV TTL parity: freshness is enforced on read and
// stale rows are pruned on a subset of writes.
const MAX_D1_BLOB_CHARS = 1_500_000; // CJK-heavy outliers beyond this fail the insert and fall back to KV
const BLOB_PRUNE_EVERY = 100;
let blobWritesSincePrune = 0;

interface BlobRow {
  data: string;
  last_used_at: string;
}

function parseBlob(json: string): ResolverSession | null {
  try {
    const s = JSON.parse(json) as ResolverSession;
    if (!s || typeof s.sessionId !== "string" || s.sessionId === "") return null;
    return s;
  } catch {
    return null;
  }
}

/** Freshness check (KV TTL parity): expired blobs read as misses. */
function blobExpired(lastUsedAt: string): boolean {
  const t = Date.parse(lastUsedAt);
  return !Number.isFinite(t) || Date.now() - t > SESSION_TTL_SECONDS * 1000;
}

const BLOB_UPSERT_SQL = `INSERT INTO resolver_session_blobs (session_id, data, last_used_at)
VALUES (?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
  data = excluded.data,
  last_used_at = excluded.last_used_at`;

async function getSession(env: Env, sessionId: string): Promise<ResolverSession | null> {
  if (env.DB) {
    try {
      const row = await env.DB!
        .prepare("SELECT data, last_used_at FROM resolver_session_blobs WHERE session_id = ?")
        .bind(sessionId)
        .first<BlobRow>();
      if (row) return blobExpired(row.last_used_at) ? null : parseBlob(row.data);
    } catch (e) {
      console.warn("[resolver] D1 blob get failed, falling back to KV:", e instanceof Error ? e.message : e);
    }
  }
  return (await getJSON<ResolverSession>(env["m365-copilot2api_KV"], sessionKey(sessionId))) ?? null;
}

/** Batched blob fetch — one query for up to ~50 ids. The D1 free plan allows
 *  only 50 queries per invocation, so point-query loops over the candidate
 *  window are not an option. Returns null when D1 is unbound or errored so
 *  callers fall back to per-id reads (D1 point + KV). */
async function getSessionsBatch(
  env: Env,
  ids: string[]
): Promise<Map<string, ResolverSession> | null> {
  if (!env.DB || ids.length === 0) return null;
  try {
    const placeholders = ids.map(() => "?").join(", ");
    const res = await env.DB!
      .prepare(
        `SELECT session_id, data, last_used_at FROM resolver_session_blobs WHERE session_id IN (${placeholders})`
      )
      .bind(...ids)
      .all<{ session_id: string; data: string; last_used_at: string }>();
    const map = new Map<string, ResolverSession>();
    for (const r of res.results) {
      if (blobExpired(r.last_used_at)) continue;
      const s = parseBlob(r.data);
      if (s) map.set(r.session_id, s);
    }
    return map;
  } catch (e) {
    console.warn("[resolver] D1 blob batch failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

async function putSession(env: Env, s: ResolverSession): Promise<void> {
  const json = JSON.stringify(s);
  if (env.DB && json.length <= MAX_D1_BLOB_CHARS) {
    try {
      await env.DB!.prepare(BLOB_UPSERT_SQL).bind(s.sessionId, json, s.lastUsedAt).run();
      blobWritesSincePrune++;
      if (blobWritesSincePrune >= BLOB_PRUNE_EVERY) {
        blobWritesSincePrune = 0;
        await env.DB!
          .prepare("DELETE FROM resolver_session_blobs WHERE last_used_at < ?")
          .bind(new Date(Date.now() - SESSION_TTL_SECONDS * 1000).toISOString())
          .run();
      }
      return;
    } catch (e) {
      console.warn("[resolver] D1 blob put failed, falling back to KV:", e instanceof Error ? e.message : e);
    }
  }
  await putJSON(env["m365-copilot2api_KV"], sessionKey(s.sessionId), s, {
    expirationTtl: SESSION_TTL_SECONDS,
  });
}

async function deleteSession(env: Env, sessionId: string): Promise<void> {
  if (env.DB) {
    try {
      await env.DB!
        .prepare("DELETE FROM resolver_session_blobs WHERE session_id = ?")
        .bind(sessionId)
        .run();
    } catch (e) {
      console.warn("[resolver] D1 blob delete failed:", e instanceof Error ? e.message : e);
    }
  }
  try {
    await env["m365-copilot2api_KV"].delete(sessionKey(sessionId));
  } catch {
    /* best-effort */
  }
}

/**
 * Loads the index. With the DB binding the D1 resolver_sessions table is the
 * source (SQL window filter + recency order + cap); the KV document is the
 * no-D1 fallback and the one-time backfill source for a fresh table.
 */
async function loadIndex(env: Env): Promise<IndexEntry[]> {
  if (env.DB) {
    const rows = await d1LoadIndex(env);
    if (rows) return rows;
  }
  return kvLoadIndex(env);
}

interface IndexRow {
  session_id: string;
  conversation_id: string;
  account_id: string;
  last_used_at: string;
  ip_fingerprint: string;
}

function rowToEntry(r: IndexRow): IndexEntry {
  return {
    sessionId: r.session_id,
    conversationId: r.conversation_id,
    accountId: r.account_id,
    lastUsedAt: r.last_used_at,
    ipFingerprint: r.ip_fingerprint || undefined,
  };
}

function entryValues(e: IndexEntry): (string)[] {
  return [e.sessionId, e.conversationId, e.accountId, e.lastUsedAt, e.ipFingerprint ?? ""];
}

/** D1 index read: fresh sessions only, newest first, capped at maxSessions. */
async function d1LoadIndex(env: Env): Promise<IndexEntry[] | null> {
  try {
    const cutoffIso = new Date(Date.now() - DEFAULT_TTL_MS - INDEX_STALE_SLACK_MS).toISOString();
    const res = await env.DB!
      .prepare(
        `SELECT session_id, conversation_id, account_id, last_used_at, ip_fingerprint
         FROM resolver_sessions WHERE last_used_at >= ? ORDER BY last_used_at DESC LIMIT ?`
      )
      .bind(cutoffIso, DEFAULT_MAX_SESSIONS)
      .all<IndexRow>();
    if (res.results.length > 0) return res.results.map(rowToEntry);
    // Empty table: one-time lazy backfill from the KV index/legacy document.
    const backfilled = await d1BackfillIndexFromKV(env);
    return backfilled
      .filter((e) => Date.parse(e.lastUsedAt) >= Date.parse(cutoffIso))
      .slice(0, DEFAULT_MAX_SESSIONS);
  } catch (e) {
    console.warn("[resolver] D1 index load failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** One-time migration: KV index (or legacy resolver-sessions doc) -> D1. */
async function d1BackfillIndexFromKV(env: Env): Promise<IndexEntry[]> {
  const kv = env["m365-copilot2api_KV"];
  let entries = (await getJSON<IndexEntry[]>(kv, INDEX_KEY)) ?? null;
  if (!entries) {
    const legacy = await getJSON<ResolverSession[]>(kv, LEGACY_KEY);
    if (legacy && legacy.length > 0) entries = legacy.map(toIndexEntry);
  }
  if (!entries || entries.length === 0) return [];
  const db = env.DB!;
  for (const e of entries) {
    try {
      await db.prepare(INDEX_UPSERT_SQL).bind(...entryValues(e)).run();
    } catch {}
  }
  console.log(`[resolver] backfilled ${entries.length} KV index entries into D1`);
  return entries;
}

// Storage review P1-4: COUNT(*) scans resolver_sessions on every bind. The
// cap is also enforced by the LIMIT on loadIndex, so the trim is a periodic
// guard rather than a per-write invariant — run it every N binds.
const TRIM_EVERY_N_BINDS = 100;
let bindsSinceTrim = 0;

/** Bounded trim: drop rows beyond the newest maxSessions (bind path). */
async function d1TrimIndex(env: Env, maxSessions: number): Promise<void> {
  bindsSinceTrim++;
  if (bindsSinceTrim < TRIM_EVERY_N_BINDS) return;
  bindsSinceTrim = 0;
  try {
    const row = await env.DB!
      .prepare("SELECT COUNT(*) AS n FROM resolver_sessions")
      .first<{ n: number }>();
    if ((row?.n ?? 0) <= maxSessions) return;
    await env.DB!
      .prepare(
        "DELETE FROM resolver_sessions WHERE session_id NOT IN (SELECT session_id FROM resolver_sessions ORDER BY last_used_at DESC LIMIT ?)"
      )
      .bind(maxSessions)
      .run();
  } catch (e) {
    console.warn("[resolver] D1 index trim failed:", e instanceof Error ? e.message : e);
  }
}

/** KV fallback read, including the legacy single-document migration. */
async function kvLoadIndex(env: Env): Promise<IndexEntry[]> {
  const stored = await getJSON<IndexEntry[]>(env["m365-copilot2api_KV"], INDEX_KEY);
  if (stored) return stored;
  const legacy = await getJSON<ResolverSession[]>(env["m365-copilot2api_KV"], LEGACY_KEY);
  if (!legacy || legacy.length === 0) return [];
  for (const s of legacy) {
    try {
      await putSession(env, s);
    } catch {}
  }
  const index = legacy.map(toIndexEntry);
  await putJSON(env["m365-copilot2api_KV"], INDEX_KEY, index);
  await env["m365-copilot2api_KV"].delete(LEGACY_KEY);
  console.log(`[resolver] migrated ${legacy.length} legacy sessions to individual keys`);
  return index;
}

function evictIndex(index: IndexEntry[], ttlMs: number, maxSessions: number): IndexEntry[] {
  const cutoff = Date.now() - ttlMs - INDEX_STALE_SLACK_MS;
  const out = index.filter((e) => Date.parse(e.lastUsedAt) > cutoff);
  if (out.length > maxSessions) {
    out.sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt));
    out.length = maxSessions;
  }
  return out;
}

async function saveIndex(env: Env, index: IndexEntry[]): Promise<void> {
  await putJSON(env["m365-copilot2api_KV"], INDEX_KEY, index);
}

/** Throttled index refresh for the touch path (no index write per request). */
async function touchIndexEntry(env: Env, index: IndexEntry[], sessionId: string): Promise<void> {
  const entry = index.find((e) => e.sessionId === sessionId);
  const now = Date.now();
  if (!entry || now - Date.parse(entry.lastUsedAt) < INDEX_TOUCH_THROTTLE_MS) return;
  entry.lastUsedAt = new Date(now).toISOString();
  if (env.DB) {
    try {
      await env.DB
        .prepare("UPDATE resolver_sessions SET last_used_at = ? WHERE session_id = ?")
        .bind(entry.lastUsedAt, sessionId)
        .run();
      return;
    } catch (e) {
      console.warn("[resolver] D1 index touch failed:", e instanceof Error ? e.message : e);
    }
  }
  await saveIndex(env, index);
}

// ------------------------------------------------------- pure functions ---

// Port of clientIPFingerprint; Workers expose the client IP via CF-Connecting-IP.
export async function clientIPFingerprint(ip: string, userAgent: string): Promise<string> {
  const hex = await sha256Hex(`${ip}|${userAgent}`);
  return hex.slice(0, 32);
}

// Port of contextFingerprint (diagnostic field only; matching uses history).
export async function contextFingerprint(messages: OaiMsg[]): Promise<string> {
  if (!messages || messages.length === 0) return "";
  const limit = Math.min(3, messages.length);
  const parts: string[] = [];
  for (let i = messages.length - limit; i < messages.length; i++) {
    const m = messages[i];
    parts.push(`${m.role}:${contentToString(m.content)}`);
  }
  const hex = await sha256Hex(parts.join("||"));
  return hex.slice(0, 32);
}

// Port of toolCallEqual: name + arguments compared, IDs ignored.
function toolCallEqual(x: Record<string, unknown>, y: Record<string, unknown>): boolean {
  const xFunc = x["function"] as Record<string, unknown> | undefined;
  const yFunc = y["function"] as Record<string, unknown> | undefined;
  if ((xFunc?.["name"] ?? "") !== (yFunc?.["name"] ?? "")) return false;
  return (xFunc?.["arguments"] ?? "") === (yFunc?.["arguments"] ?? "");
}

// Port of messagesEqual.
export function messagesEqual(a: OaiMsg, b: OaiMsg): boolean {
  if ((a.role ?? "") !== (b.role ?? "")) return false;
  if (contentToString(a.content) !== contentToString(b.content)) return false;
  const aCalls = a.tool_calls ?? [];
  const bCalls = b.tool_calls ?? [];
  if (aCalls.length !== bCalls.length) return false;
  for (let i = 0; i < aCalls.length; i++) {
    if (!toolCallEqual(aCalls[i], bCalls[i])) return false;
  }
  return true;
}

// Port of contextPrefixLen: len(hist) when hist is a strict prefix of msgs.
export function contextPrefixLen(hist: OaiMsg[], msgs: OaiMsg[]): number {
  if (!hist || hist.length === 0 || msgs.length < hist.length) return 0;
  for (let i = 0; i < hist.length; i++) {
    if (!messagesEqual(hist[i], msgs[i])) return 0;
  }
  return hist.length;
}

// Port of suffixMatchLen.
export function suffixMatchLen(hist: OaiMsg[], msgs: OaiMsg[]): number {
  const maxN = Math.min(hist.length, msgs.length);
  let n = 0;
  for (let i = 1; i <= maxN; i++) {
    if (messagesEqual(hist[hist.length - i], msgs[msgs.length - i])) n = i;
    else break;
  }
  return n;
}

function cloneMessages(msgs: OaiMsg[]): OaiMsg[] {
  const trimmed = msgs.length > 512 ? msgs.slice(msgs.length - 512) : msgs;
  return trimmed.map((m) => ({ ...m }));
}

interface ResolveParams {
  explicitId?: string;
  ipFingerprint?: string;
  messages: OaiMsg[];
  ttlMs?: number;
  contextTtlMs?: number;
  maxSessions?: number;
}

// Port of sessionResolver.Resolve.
export async function resolveSession(env: Env, params: ResolveParams): Promise<ResolveResult> {
  const ttlMs = params.ttlMs ?? DEFAULT_TTL_MS;
  const contextTtlMs = params.contextTtlMs ?? DEFAULT_CONTEXT_TTL_MS;
  const maxSessions = params.maxSessions ?? DEFAULT_MAX_SESSIONS;

  const touch = async (sess: ResolverSession, index: IndexEntry[]): Promise<ResolveResult> => {
    const now = Date.now();
    sess.lastUsedAt = new Date(now).toISOString();
    // Storage review P0: the session blob rewrite used to sit on the critical
    // path with no failure isolation — a KV quota-exceeded throw surfaced as a
    // user-facing 500. The refresh is now throttled (TTL-safe via lastWriteAt)
    // and best-effort: losing a touch costs lastUsedAt freshness at most,
    // never the conversation binding.
    const lastWrite = Date.parse(sess.lastWriteAt ?? "");
    if (!Number.isFinite(lastWrite) || now - lastWrite >= SESSION_TOUCH_THROTTLE_MS) {
      sess.lastWriteAt = sess.lastUsedAt;
      try {
        await putSession(env, sess);
      } catch (e) {
        console.warn("[resolver] session touch write failed:", e instanceof Error ? e.message : e);
      }
    }
    try {
      await touchIndexEntry(env, index, sess.sessionId);
    } catch (e) {
      console.warn("[resolver] index touch failed:", e instanceof Error ? e.message : e);
    }
    return {
      sessionId: sess.sessionId,
      conversationId: sess.conversationId,
      accountId: sess.accountId,
      matchedBy: "",
      isNew: false,
      historyLen: sess.contextHistory?.length ?? 0,
    };
  };

  // 1. explicit id — highest priority continuation semantics.
  const explicitID = (params.explicitId ?? "").trim();
  if (explicitID !== "") {
    const hit = await getSession(env, explicitID);
    if (hit) {
      const index = evictIndex(await loadIndex(env), ttlMs, maxSessions);
      const r = await touch(hit, index);
      r.matchedBy = "explicit";
      return r;
    }
  }

  const messages = params.messages ?? [];
  const finger = params.ipFingerprint ?? "";
  const index = evictIndex(await loadIndex(env), ttlMs, maxSessions);

  // Candidates: same IP fingerprint, inside the context TTL, newest first,
  // bounded so one resolve never burns the subrequest budget.
  const contextCutoff = Date.now() - contextTtlMs - INDEX_STALE_SLACK_MS;
  const candidates = index
    .filter(
      (e) =>
        Date.parse(e.lastUsedAt) > contextCutoff &&
        !!finger &&
        !!e.ipFingerprint &&
        e.ipFingerprint === finger
    )
    .sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt))
    .slice(0, MAX_CANDIDATES);

  if (messages.length > 0 && candidates.length > 0) {
    const sessions: ResolverSession[] = [];
    // One batched read instead of up to MAX_CANDIDATES point queries (the D1
    // free plan allows 50 queries per invocation). Ids missing from the batch
    // (KV-only blobs, or expired) fall back to getSession, which resolves both.
    const batch = await getSessionsBatch(env, candidates.map((c) => c.sessionId));
    for (const c of candidates) {
      const s =
        batch !== null && batch.has(c.sessionId)
          ? batch.get(c.sessionId) ?? null
          : await getSession(env, c.sessionId);
      if (s) sessions.push(s);
    }

    // 2. strict context-prefix match, longest wins.
    let best: { s: ResolverSession; n: number } | null = null;
    for (const sess of sessions) {
      if (Date.now() - Date.parse(sess.lastUsedAt) > contextTtlMs) continue;
      if (!finger || !sess.ipFingerprint || sess.ipFingerprint !== finger) continue;
      const n = contextPrefixLen(sess.contextHistory ?? [], messages);
      if (
        n >= 1 &&
        (!best || n > best.n || (n === best.n && Date.parse(sess.lastUsedAt) > Date.parse(best.s.lastUsedAt)))
      ) {
        best = { s: sess, n };
      }
    }
    if (best) {
      const r = await touch(best.s, index);
      r.matchedBy = `context_prefix_${best.n}`;
      r.historyLen = best.n;
      return r;
    }

    // 3. common-suffix fallback (min 2 messages).
    if (messages.length >= 2) {
      let bestSuffix: { s: ResolverSession; n: number } | null = null;
      for (const sess of sessions) {
        if (Date.now() - Date.parse(sess.lastUsedAt) > contextTtlMs) continue;
        if (!finger || !sess.ipFingerprint || sess.ipFingerprint !== finger) continue;
        const hist = sess.contextHistory ?? [];
        if (hist.length < 2) continue;
        const n = suffixMatchLen(hist, messages);
        if (
          n >= 2 &&
          (!bestSuffix ||
            n > bestSuffix.n ||
            (n === bestSuffix.n && Date.parse(sess.lastUsedAt) > Date.parse(bestSuffix.s.lastUsedAt)))
        ) {
          bestSuffix = { s: sess, n };
        }
      }
      if (bestSuffix) {
        const r = await touch(bestSuffix.s, index);
        r.matchedBy = `context_suffix_${bestSuffix.n}`;
        r.historyLen = bestSuffix.n;
        return r;
      }
    }
  }

  return { sessionId: "", conversationId: "", accountId: "", matchedBy: "", isNew: true, historyLen: 0 };
}

interface BindParams {
  sessionId: string;
  conversationId: string;
  accountId: string;
  messages: OaiMsg[];
  assistantText?: string;
  userField?: string;
  ipFingerprint?: string;
  ttlMs?: number;
  maxSessions?: number;
}

// Port of sessionResolver.Bind.
export async function bindSession(env: Env, params: BindParams): Promise<void> {
  const ttlMs = params.ttlMs ?? DEFAULT_TTL_MS;
  const maxSessions = params.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const index = evictIndex(await loadIndex(env), ttlMs, maxSessions);
  const now = new Date().toISOString();

  let sessionId = params.sessionId;
  const history = cloneMessages(params.messages ?? []);
  if ((params.assistantText ?? "").trim() !== "") {
    history.push({ role: "assistant", content: params.assistantText });
  }
  const finger = await contextFingerprint(history);

  const applyTo = (sess: ResolverSession): void => {
    sess.conversationId = params.conversationId;
    sess.accountId = params.accountId;
    sess.lastUsedAt = now;
    // bindSession always persists the blob (history changed); refresh the
    // touch-throttle anchor so the next touch does not rewrite it again.
    sess.lastWriteAt = now;
    sess.userField = params.userField ?? sess.userField;
    sess.ipFingerprint = params.ipFingerprint ?? sess.ipFingerprint;
    sess.contextFinger = finger;
    sess.contextHistory = history;
  };

  let target: ResolverSession | null = null;
  if (sessionId !== "") {
    target = await getSession(env, sessionId);
  } else {
    const byConv = index.find((e) => e.conversationId === params.conversationId);
    if (byConv) target = await getSession(env, byConv.sessionId);
    if (!target) sessionId = crypto.randomUUID();
  }

  if (target) {
    sessionId = target.sessionId;
    applyTo(target);
    await putSession(env, target);
  } else {
    target = {
      sessionId,
      conversationId: params.conversationId,
      accountId: params.accountId,
      createdAt: now,
      lastUsedAt: now,
      lastWriteAt: now,
      ipFingerprint: params.ipFingerprint,
      userField: params.userField,
      contextFinger: finger,
      contextHistory: history,
    };
    await putSession(env, target);
  }

  // Index upsert (binds always refresh: the entry feeds candidate filtering,
  // dedupe-by-conversation and unbind-by-conversation). D1: single-row
  // upsert + occasional trim; KV: array upsert with recency cap.
  const entry = toIndexEntry(target);
  if (env.DB) {
    try {
      await env.DB.prepare(INDEX_UPSERT_SQL).bind(...entryValues(entry)).run();
      await d1TrimIndex(env, maxSessions);
      return;
    } catch (e) {
      console.warn("[resolver] D1 index upsert failed, falling back to KV:", e instanceof Error ? e.message : e);
    }
  }
  const existing = index.findIndex((e) => e.sessionId === sessionId);
  if (existing >= 0) index[existing] = entry;
  else index.push(entry);
  if (index.length > maxSessions) {
    index.sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt));
    index.length = maxSessions;
  }
  await saveIndex(env, index);
}

// Port of UnbindByConversation: drop every session bound to a deleted cloud
// conversation so the resolver never reuses dead conversations.
export async function unbindByConversation(env: Env, conversationId: string): Promise<number> {
  if (env.DB) {
    try {
      const res = await env.DB!
        .prepare("SELECT session_id FROM resolver_sessions WHERE conversation_id = ?")
        .bind(conversationId)
        .all<{ session_id: string }>();
      for (const r of res.results) {
        await deleteSession(env, r.session_id);
      }
      await env.DB!
        .prepare("DELETE FROM resolver_sessions WHERE conversation_id = ?")
        .bind(conversationId)
        .run();
      return res.results.length;
    } catch (e) {
      console.warn("[resolver] D1 unbind failed, falling back to KV:", e instanceof Error ? e.message : e);
    }
  }
  const index = await loadIndex(env);
  const kept: IndexEntry[] = [];
  let removed = 0;
  for (const e of index) {
    if (e.conversationId === conversationId) {
      await deleteSession(env, e.sessionId);
      removed++;
    } else {
      kept.push(e);
    }
  }
  if (removed > 0) await saveIndex(env, kept);
  return removed;
}

export async function listResolverSessions(env: Env): Promise<ResolverSession[]> {
  const index = evictIndex(
    await loadIndex(env),
    DEFAULT_TTL_MS,
    DEFAULT_MAX_SESSIONS
  );
  const sorted = [...index].sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt));
  const out: ResolverSession[] = [];
  // Full transcripts only for the most recent sessions (console views); the
  // rest are returned as lightweight summaries straight from the index. One
  // batched D1 read covers the full-read window — console loads must not burn
  // the 50-queries-per-invocation budget on point queries.
  const fullIds = sorted.slice(0, LIST_MAX_FULL_READS).map((e) => e.sessionId);
  const batch = fullIds.length > 0 ? await getSessionsBatch(env, fullIds) : null;
  for (let i = 0; i < sorted.length; i++) {
    if (i < LIST_MAX_FULL_READS) {
      const id = sorted[i].sessionId;
      const s =
        batch !== null && batch.has(id) ? batch.get(id) ?? null : await getSession(env, id);
      if (s) {
        out.push(s);
        continue;
      }
    }
    out.push({
      sessionId: sorted[i].sessionId,
      conversationId: sorted[i].conversationId,
      accountId: sorted[i].accountId,
      createdAt: sorted[i].lastUsedAt,
      lastUsedAt: sorted[i].lastUsedAt,
      ipFingerprint: sorted[i].ipFingerprint,
    });
  }
  return out;
}

/** Cheap session count for stats paths: index only, zero blob reads
 * (storage review P0-1 — listResolverSessions used to fetch up to 50 full
 * transcripts just to read `.length`). */
export async function countResolverSessions(env: Env): Promise<number> {
  const index = evictIndex(await loadIndex(env), DEFAULT_TTL_MS, DEFAULT_MAX_SESSIONS);
  return index.length;
}

/** Index entries only (no session blob reads). Enough for callers that only
 * need conversationId + lastUsedAt, e.g. the cleanup sweep's active set. */
export async function listResolverIndex(env: Env): Promise<IndexEntry[]> {
  return evictIndex(await loadIndex(env), DEFAULT_TTL_MS, DEFAULT_MAX_SESSIONS);
}

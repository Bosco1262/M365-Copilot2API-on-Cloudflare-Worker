// Account store (port of internal/auth/cache.go Store).
//
// Storage audit P1-1: with the D1 binding present, accounts live in the
// accounts table (migrations/0003_storage_audit.sql) and are written with
// row-scoped / conditional statements, because AAD refresh tokens are
// single-use: the old whole-document KV read-modify-write could interleave
// with status/schedule writes and silently drop a freshly redeemed refresh
// token (which permanently kills the account). The legacy KV "accounts"
// document is mirrored on every mutation for rollback safety, and legacy
// KV-only accounts are backfilled lazily on first read.

import type { AccountToken, TokenSet } from "../types";
import { firstNonEmpty, nowIso } from "../util";
import { oauthConfig, type Env } from "../env";
import { OAuthError } from "../auth/oauth";
import { getJSON, putJSON } from "../kv";
import {
  coordMutexAcquire,
  coordMutexRelease,
  coordNextAccountID,
  coordGetAccounts,
  coordSetAccounts,
  coordInvalidateAccounts,
} from "../do/coordination";

interface AccountsDoc {
  accounts: AccountToken[];
  nextIdx: number;
}

const KEY = "accounts";
const CURSOR_KEY = "accounts-cursor";

function emptyDoc(): AccountsDoc {
  return { accounts: [], nextIdx: 0 };
}

// ------------------------------------------------------------- D1 layer ---

interface AccountRow {
  id: string;
  email: string;
  display_name: string;
  status: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  updated_at: string;
  oid: string;
  tid: string;
  client_id: string;
  schedule_disabled: number;
}

const ACCOUNT_COLS =
  "id, email, display_name, status, access_token, refresh_token, expires_at, updated_at, oid, tid, client_id, schedule_disabled";

function rowToAccount(r: AccountRow): AccountToken {
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    status: r.status,
    accessToken: r.access_token,
    refreshToken: r.refresh_token || undefined,
    expiresAt: r.expires_at,
    updatedAt: r.updated_at,
    oid: r.oid || undefined,
    tid: r.tid || undefined,
    clientId: r.client_id || undefined,
    scheduleDisabled: !!r.schedule_disabled,
  };
}

function accountValues(a: AccountToken): (string | number | null)[] {
  return [
    a.id,
    a.email ?? "",
    a.displayName ?? "",
    a.status,
    a.accessToken ?? "",
    a.refreshToken ?? "",
    a.expiresAt ?? "",
    a.updatedAt,
    a.oid ?? "",
    a.tid ?? "",
    a.clientId ?? "",
    a.scheduleDisabled ? 1 : 0,
  ];
}

// Full-row insert; on an id conflict (concurrent create) the caller retries
// through the update path.
const INSERT_SQL = `INSERT INTO accounts (${ACCOUNT_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// Row write guarded by the expected updated_at (optimistic lock): a lost race
// yields changes=0 and the caller re-reads and retries instead of clobbering
// the concurrent writer. The empty-refresh-token CASE keeps an existing
// refresh token when the incoming TokenSet carries none.
const UPDATE_SQL = `UPDATE accounts SET
  email = ?, display_name = ?, status = ?, access_token = ?,
  refresh_token = CASE WHEN ? <> '' THEN ? ELSE refresh_token END,
  expires_at = ?, updated_at = ?, oid = ?, tid = ?, client_id = ?, schedule_disabled = ?
WHERE id = ? AND updated_at = ?`;

async function d1List(env: Env): Promise<AccountToken[] | null> {
  if (!env.DB) return null;
  try {
    const res = await env.DB
      .prepare(`SELECT ${ACCOUNT_COLS} FROM accounts ORDER BY rowid`)
      .all<AccountRow>();
    return res.results.map(rowToAccount);
  } catch (e) {
    console.warn("[accounts] D1 list failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** One-time lazy migration: KV doc -> D1 rows when the table is still empty. */
async function d1BackfillFromKV(env: Env): Promise<void> {
  if (!env.DB) return;
  const rows = await d1List(env);
  if (!rows || rows.length > 0) return;
  const doc = await loadDoc(env);
  if (doc.accounts.length === 0) return;
  for (const a of doc.accounts) {
    try {
      await env.DB.prepare(INSERT_SQL).bind(...accountValues(a)).run();
    } catch {}
  }
  console.log(`[accounts] backfilled ${doc.accounts.length} KV accounts into D1`);
}

/** Mirror one mutation into the legacy KV document (rollback safety net).
 *  Storage review P2-4: mirrored copies deliberately carry NO tokens —
 *  refresh tokens are single-use, so the mirrored copy is always stale after
 *  the first D1-side refresh, and redeeming a stale token can permanently
 *  kill the account (see the file header). The mirror stays a structural
 *  listing (ids / emails / flags) for rollback; live tokens live in D1 only.
 *  KV-only deployments are unaffected: they write through saveDoc instead. */
async function mirrorToKV(
  env: Env,
  mutate: (accounts: AccountToken[]) => boolean
): Promise<void> {
  try {
    const doc = await loadDoc(env);
    if (mutate(doc.accounts)) {
      for (const a of doc.accounts) {
        a.refreshToken = "";
        a.accessToken = "";
      }
      await putJSON(env["m365-copilot2api_KV"], KEY, doc);
    }
  } catch (e) {
    console.warn("[accounts] KV mirror failed:", e instanceof Error ? e.message : e);
  }
}

/** Atomic row upsert with one optimistic-lock retry (see UPDATE_SQL).
 *  Returns whether the row was INSERTed (new account) so callers can decide
 *  which side effects (KV mirror, DO cache invalidation) apply. */
async function d1Upsert(
  env: Env,
  acc: AccountToken,
  expectedUpdatedAt?: string
): Promise<{ ok: boolean; inserted: boolean }> {
  const db = env.DB!;
  const existing = (
    await db
      .prepare(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE id = ? OR (? <> '' AND email = ?)`)
      .bind(acc.id, acc.email ?? "", acc.email ?? "")
      .first<AccountRow>()
  );
  if (!existing) {
    try {
      await db.prepare(INSERT_SQL).bind(...accountValues(acc)).run();
      return { ok: true, inserted: true };
    } catch {
      // Concurrent insert won the race: fall through to the update path.
    }
  }
  const cur = existing ?? (
    await db
      .prepare(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE id = ?`)
      .bind(acc.id)
      .first<AccountRow>()
  );
  if (!cur) return { ok: false, inserted: false };
  // Merge semantics ported from the old KV upsert: never blank out fields the
  // new token set does not carry.
  const merged: AccountToken = { ...acc };
  merged.refreshToken = acc.refreshToken || rowToAccount(cur).refreshToken;
  merged.tid = acc.tid ?? rowToAccount(cur).tid;
  merged.oid = acc.oid ?? rowToAccount(cur).oid;
  merged.scheduleDisabled = acc.scheduleDisabled ?? rowToAccount(cur).scheduleDisabled;
  const expect = expectedUpdatedAt ?? cur.updated_at;
  const res = (await db
    .prepare(UPDATE_SQL)
    .bind(
      merged.email ?? "",
      merged.displayName ?? "",
      merged.status,
      merged.accessToken ?? "",
      merged.refreshToken ?? "",
      merged.refreshToken ?? "",
      merged.expiresAt ?? "",
      merged.updatedAt,
      merged.oid ?? "",
      merged.tid ?? "",
      merged.clientId ?? "",
      merged.scheduleDisabled ? 1 : 0,
      cur.id,
      expect
    )
    .run()) as { meta?: { changes?: number } };
  if ((res?.meta?.changes ?? 0) > 0) return { ok: true, inserted: false };
  // Optimistic-lock miss: another writer updated the row concurrently.
  // Re-read once and retry against its updated_at.
  const fresh = (
    await db
      .prepare(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE id = ?`)
      .bind(cur.id)
      .first<AccountRow>()
  );
  if (!fresh) return { ok: false, inserted: false };
  const retry: AccountToken = { ...merged };
  retry.refreshToken = merged.refreshToken || rowToAccount(fresh).refreshToken;
  const res2 = (await db
    .prepare(UPDATE_SQL)
    .bind(
      retry.email ?? "",
      retry.displayName ?? "",
      retry.status,
      retry.accessToken ?? "",
      retry.refreshToken ?? "",
      retry.refreshToken ?? "",
      retry.expiresAt ?? "",
      retry.updatedAt,
      retry.oid ?? "",
      retry.tid ?? "",
      retry.clientId ?? "",
      retry.scheduleDisabled ? 1 : 0,
      fresh.id,
      fresh.updated_at
    )
    .run()) as { meta?: { changes?: number } };
  return { ok: (res2?.meta?.changes ?? 0) > 0, inserted: false };
}

// ---------------------------------------------------------- KV helpers ---

async function loadDoc(env: Env): Promise<AccountsDoc> {
  return (await getJSON<AccountsDoc>(env["m365-copilot2api_KV"], KEY)) ?? emptyDoc();
}

async function saveDoc(env: Env, doc: AccountsDoc): Promise<void> {
  await putJSON(env["m365-copilot2api_KV"], KEY, doc);
}

// ---------------------------------------------------------- public API ---

export async function listAccounts(env: Env): Promise<AccountToken[]> {
  if (env.DB) {
    // Storage review: the hot path (every /v1/* request) reads the account
    // list. With the coordination DO bound, a short-lived in-DO cache serves
    // it instead of a full D1 scan per request; on miss we refetch (with the
    // lazy KV backfill) and push the rows back. Structural changes
    // invalidate the cache, so admin views stay fresh.
    const cached = await coordGetAccounts(env);
    if (cached?.cached && cached.accounts) return cached.accounts;
    await d1BackfillFromKV(env);
    const rows = await d1List(env);
    if (rows) {
      await coordSetAccounts(env, rows);
      return rows;
    }
  }
  const doc = await loadDoc(env);
  return doc.accounts;
}

// Round-robin over all accounts (port of Store.Next). With the coordination
// DO bound the cursor lives in the DO (atomic across isolates). Without it the
// fallback cursor is a tiny dedicated KV key, so the (potentially large)
// accounts document is no longer rewritten on every rotation.
export async function nextAccount(env: Env): Promise<AccountToken | null> {
  const accounts = await listAccounts(env);
  const n = accounts.length;
  if (n === 0) return null;
  const picked = await coordNextAccountID(
    env,
    accounts.map((a) => a.id)
  );
  if (picked !== null) {
    const idx = Math.max(0, accounts.findIndex((a) => a.id === picked));
    return accounts[idx];
  }
  let cursorDoc = await getJSON<{ nextIdx: number }>(env["m365-copilot2api_KV"], CURSOR_KEY);
  if (!cursorDoc) {
    // First rotation after the storage-audit change: inherit the legacy
    // nextIdx so the round-robin position stays continuous.
    const legacy = await loadDoc(env);
    cursorDoc = { nextIdx: legacy.nextIdx ?? 0 };
  }
  const acc = accounts[cursorDoc.nextIdx % n];
  cursorDoc.nextIdx = (cursorDoc.nextIdx + 1) % Number.MAX_SAFE_INTEGER;
  await putJSON(env["m365-copilot2api_KV"], CURSOR_KEY, cursorDoc);
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
  if (env.DB) {
    try {
      const { ok, inserted } = await d1Upsert(env, acc);
      if (ok) {
        // Mirror + cache invalidation only for structural changes (new
        // account). Token refresh / status updates no longer rewrite the
        // legacy KV document on every write (storage review: 镜像降频).
        if (inserted) {
          await mirrorToKV(env, (list) => {
            const i = list.findIndex(
              (a) => a.id === acc.id || (acc.email !== "" && a.email === acc.email)
            );
            if (i >= 0) list[i] = acc;
            else list.push(acc);
            return true;
          });
          await coordInvalidateAccounts(env);
        }
        return acc;
      }
      console.warn("[accounts] D1 upsert reported no changes; KV path used");
    } catch (e) {
      console.warn("[accounts] D1 upsert failed, falling back to KV:", e instanceof Error ? e.message : e);
    }
  }
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
  if (env.DB) {
    try {
      await env.DB.prepare("DELETE FROM accounts WHERE id = ? OR oid = ? OR email = ?")
        .bind(id, id, id)
        .run();
      await coordInvalidateAccounts(env);
    } catch (e) {
      console.warn("[accounts] D1 delete failed:", e instanceof Error ? e.message : e);
    }
  }
  await mirrorToKV(env, (list) => {
    const before = list.length;
    const kept = list.filter((a) => a.id !== id);
    list.length = 0;
    list.push(...kept);
    return before !== kept.length;
  });
}

export async function setScheduleEnabled(env: Env, id: string, enabled: boolean): Promise<boolean> {
  if (env.DB) {
    try {
      const res = (await env.DB
        .prepare("UPDATE accounts SET schedule_disabled = ?, updated_at = ? WHERE id = ?")
        .bind(enabled ? 0 : 1, nowIso(), id)
        .run()) as { meta?: { changes?: number } };
      // No KV mirror: schedule toggles are high-frequency writes and the KV
      // document is only a rollback safety net for structural changes.
      return (res?.meta?.changes ?? 0) > 0;
    } catch (e) {
      console.warn("[accounts] D1 schedule update failed, falling back to KV:", e instanceof Error ? e.message : e);
    }
  }
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
  if (env.DB) {
    try {
      const res = (await env.DB
        .prepare("UPDATE accounts SET refresh_token = ?, updated_at = ? WHERE id = ?")
        .bind(trimmed, nowIso(), id)
        .run()) as { meta?: { changes?: number } };
      // No KV mirror (see setScheduleEnabled): refresh-token writes are the
      // hottest account mutation and the KV doc is only a structural mirror.
      return (res?.meta?.changes ?? 0) > 0;
    } catch (e) {
      console.warn("[accounts] D1 refresh update failed, falling back to KV:", e instanceof Error ? e.message : e);
    }
  }
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
// redeem one. With the coordination DO bound, a named mutex additionally
// serialises the redeeming across isolates; without it only the local
// coalescing below applies (cross-isolate races remain possible but are
// unlikely for the single-operator deployments this Worker targets).
const inflight = new Map<string, Promise<{ acc: AccountToken; err: string | null }>>();

const REFRESH_MUTEX_TTL_MS = 30_000;
const REFRESH_REMOTE_WAIT_MS = 15_000;

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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
  if (flight) {
    const { acc, err } = await flight;
    if (err) throw new Error(err);
    return acc;
  }

  // Cross-isolate single-flight when the coordination DO is bound.
  const muxKey = "refresh:" + found.id;
  const mux = await coordMutexAcquire(env, muxKey, REFRESH_MUTEX_TTL_MS);
  if (mux && !mux.ok) {
    // Another isolate is redeeming the refresh token right now: wait for its
    // result to land in storage instead of burning a second single-use token.
    const deadline = Date.now() + REFRESH_REMOTE_WAIT_MS;
    while (Date.now() < deadline) {
      await sleepMs(400);
      const cur = await getAccount(env, found.id);
      if (cur && tokenValid(cur)) return cur;
      const local = inflight.get(found.id);
      if (local) {
        const { acc, err } = await local;
        if (err) throw new Error(err);
        return acc;
      }
    }
    // Still stale after the wait — fall through and refresh ourselves.
  }

  flight = performRefresh(env, found);
  inflight.set(found.id, flight);
  try {
    const { acc, err } = await flight;
    if (err) throw new Error(err);
    return acc;
  } finally {
    inflight.delete(found.id);
    if (mux?.ok && mux.token) await coordMutexRelease(env, muxKey, mux.token);
  }
}

async function markStatus(env: Env, id: string, status: string): Promise<void> {
  if (env.DB) {
    try {
      // Column-scoped update: never touches the token columns, so it cannot
      // clobber a concurrently redeemed refresh token (audit P1-1). No KV
      // mirror (structural-only mirror policy).
      await env.DB
        .prepare("UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?")
        .bind(status, nowIso(), id)
        .run();
      return;
    } catch (e) {
      console.warn("[accounts] D1 status update failed, falling back to KV:", e instanceof Error ? e.message : e);
    }
  }
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

// API key store (port of internal/web/keys.go).
//
// Storage audit P0-2: with the D1 binding present, keys live in the api_keys
// table (migrations/0003_storage_audit.sql) so that revocation takes effect
// immediately — KV is eventually consistent and kept a ~60s window where a
// revoked key still authenticated. The KV "api-keys" document is still
// mirrored on every mutation so a code revert (or dropping the DB binding)
// transparently falls back to the previous behavior. Legacy KV-only keys are
// backfilled lazily on first read. lastUsedAt is updated at most once per
// minute per key (throttled, off the critical path via waitUntil) instead of
// rewriting the whole key list on every authenticated request.

import type { Env } from "../env";
import { getJSON, putJSON } from "../kv";
import { sha256Hex } from "../util";

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  hash: string;
  createdAt: string;
  lastUsedAt?: string;
  revoked: boolean;
}

interface KeysDoc {
  keys: ApiKeyRecord[];
}

const KEY = "api-keys";

// Per-isolate throttle for lastUsedAt writes (one D1 UPDATE per minute/key).
const LAST_USED_THROTTLE_MS = 60_000;
const lastUsedTouch = new Map<string, number>();

async function loadDoc(env: Env): Promise<KeysDoc> {
  return (await getJSON<KeysDoc>(env["m365-copilot2api_KV"], KEY)) ?? { keys: [] };
}

export async function keyHash(k: string): Promise<string> {
  return sha256Hex(k);
}

// ------------------------------------------------------------- D1 layer ---

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  hash: string;
  created_at: string;
  last_used_at: string | null;
  revoked: number;
}

function rowToRecord(r: ApiKeyRow): ApiKeyRecord {
  return {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    hash: r.hash,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at ?? undefined,
    revoked: !!r.revoked,
  };
}

function recordValues(k: ApiKeyRecord): (string | number | null)[] {
  return [
    k.id,
    k.name,
    k.prefix,
    k.hash,
    k.createdAt,
    k.lastUsedAt ?? null,
    k.revoked ? 1 : 0,
  ];
}

const UPSERT_SQL = `INSERT INTO api_keys (id, name, prefix, hash, created_at, last_used_at, revoked)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  prefix = excluded.prefix,
  hash = excluded.hash,
  created_at = excluded.created_at,
  last_used_at = excluded.last_used_at,
  revoked = excluded.revoked`;

async function d1List(env: Env): Promise<ApiKeyRecord[] | null> {
  if (!env.DB) return null;
  try {
    const res = await env.DB
      .prepare("SELECT id, name, prefix, hash, created_at, last_used_at, revoked FROM api_keys")
      .all<ApiKeyRow>();
    return res.results.map(rowToRecord);
  } catch (e) {
    console.warn("[keys] D1 list failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** One-time lazy migration: KV doc -> D1 rows when the table is still empty. */
async function d1BackfillFromKV(env: Env): Promise<void> {
  const rows = await d1List(env);
  if (!rows || rows.length > 0) return;
  const doc = await loadDoc(env);
  if (doc.keys.length === 0) return;
  for (const k of doc.keys) {
    try {
      await env.DB!.prepare(UPSERT_SQL).bind(...recordValues(k)).run();
    } catch {}
  }
  console.log(`[keys] backfilled ${doc.keys.length} KV keys into D1`);
}

/** Mirror one record into the legacy KV document (rollback safety net). */
async function mirrorToKV(env: Env, next: ApiKeyRecord, remove?: boolean): Promise<void> {
  try {
    const doc = await loadDoc(env);
    const idx = doc.keys.findIndex((k) => k.id === next.id);
    if (remove) {
      if (idx >= 0) doc.keys.splice(idx, 1);
    } else if (idx >= 0) {
      doc.keys[idx] = next;
    } else {
      doc.keys.push(next);
    }
    await putJSON(env["m365-copilot2api_KV"], KEY, doc);
  } catch (e) {
    console.warn("[keys] KV mirror failed:", e instanceof Error ? e.message : e);
  }
}

// ---------------------------------------------------------- public API ---

export async function createKey(
  env: Env,
  name: string
): Promise<{ record: ApiKeyRecord; raw: string }> {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  const raw = "m365_" + hex;
  const record: ApiKeyRecord = {
    id: hex.slice(0, 16),
    name: name.trim() || "API key",
    prefix: raw.slice(0, 12),
    hash: await keyHash(raw),
    createdAt: new Date().toISOString(),
    revoked: false,
  };
  if (env.DB) {
    try {
      await env.DB.prepare(UPSERT_SQL).bind(...recordValues(record)).run();
      await mirrorToKV(env, record);
      return { record, raw };
    } catch (e) {
      console.warn("[keys] D1 insert failed, falling back to KV:", e instanceof Error ? e.message : e);
    }
  }
  const doc = await loadDoc(env);
  doc.keys.push(record);
  await putJSON(env["m365-copilot2api_KV"], KEY, doc);
  return { record, raw };
}

export async function listKeys(env: Env): Promise<ApiKeyRecord[]> {
  if (env.DB) {
    await d1BackfillFromKV(env);
    const rows = await d1List(env);
    if (rows) return rows.map((k) => ({ ...k, hash: undefined as unknown as string }));
  }
  const doc = await loadDoc(env);
  return doc.keys.map((k) => ({ ...k, hash: undefined as unknown as string }));
}

export async function revokeKey(env: Env, id: string): Promise<boolean> {
  const updated = await updateKey(env, id, "", true);
  return updated;
}

export async function updateKey(
  env: Env,
  id: string,
  name: string,
  revoked?: boolean
): Promise<boolean> {
  if (env.DB) {
    try {
      const existing = (
        await env.DB
          .prepare("SELECT id, name, prefix, hash, created_at, last_used_at, revoked FROM api_keys WHERE id = ?")
          .bind(id)
          .first<ApiKeyRow>()
      );
      if (!existing) return false;
      const rec = rowToRecord(existing);
      const wasRevoked = !!existing.revoked;
      if (name !== "") rec.name = name;
      if (revoked !== undefined) rec.revoked = revoked;
      await env.DB.prepare(UPSERT_SQL).bind(...recordValues(rec)).run();
      // Structural-only mirror: only revoke state changes rewrite the legacy
      // KV document (rename/revoke are the rollback-relevant mutations; the
      // throttled lastUsedAt touch already avoids the doc entirely).
      if (revoked !== undefined && rec.revoked !== wasRevoked) {
        await mirrorToKV(env, rec);
      }
      return true;
    } catch (e) {
      console.warn("[keys] D1 update failed, falling back to KV:", e instanceof Error ? e.message : e);
    }
  }
  const doc = await loadDoc(env);
  const k = doc.keys.find((x) => x.id === id);
  if (!k) return false;
  if (name !== "") k.name = name;
  if (revoked !== undefined) k.revoked = revoked;
  await putJSON(env["m365-copilot2api_KV"], KEY, doc);
  return true;
}

export async function deleteKey(env: Env, id: string): Promise<boolean> {
  if (env.DB) {
    try {
      const existing = (
        await env.DB
          .prepare("SELECT id, name, prefix, hash, created_at, last_used_at, revoked FROM api_keys WHERE id = ?")
          .bind(id)
          .first<ApiKeyRow>()
      );
      if (!existing) return false;
      await env.DB.prepare("DELETE FROM api_keys WHERE id = ?").bind(id).run();
      await mirrorToKV(env, rowToRecord(existing), true);
      return true;
    } catch (e) {
      console.warn("[keys] D1 delete failed, falling back to KV:", e instanceof Error ? e.message : e);
    }
  }
  const doc = await loadDoc(env);
  const before = doc.keys.length;
  doc.keys = doc.keys.filter((x) => x.id !== id);
  if (doc.keys.length === before) return false;
  await putJSON(env["m365-copilot2api_KV"], KEY, doc);
  return true;
}

export async function validKey(
  env: Env,
  raw: string,
  waitUntil?: (p: Promise<unknown>) => void
): Promise<boolean> {
  if (!raw) return false;
  const h = await keyHash(raw);
  if (env.DB) {
    try {
      await d1BackfillFromKV(env);
      const row = await env.DB
        .prepare("SELECT id, name, prefix, hash, created_at, last_used_at, revoked FROM api_keys WHERE hash = ?")
        .bind(h)
        .first<ApiKeyRow>();
      if (row) {
        if (row.revoked) return false;
        touchLastUsed(env, row.id, row.last_used_at, waitUntil);
        return true;
      }
      // Unknown hash in D1: fall through to the KV doc in case the table is
      // stale (e.g. keys created while D1 writes were failing).
    } catch (e) {
      console.warn("[keys] D1 lookup failed, falling back to KV:", e instanceof Error ? e.message : e);
    }
  }
  const doc = await loadDoc(env);
  const k = doc.keys.find((x) => x.hash === h && !x.revoked);
  if (!k) return false;
  // Throttled best-effort lastUsedAt (no critical-path write per request).
  const write = (async () => {
    const now = Date.now();
    const last = lastUsedTouch.get(k.id) ?? 0;
    if (now - last < LAST_USED_THROTTLE_MS) return;
    lastUsedTouch.set(k.id, now);
    const fresh = await loadDoc(env);
    const cur = fresh.keys.find((x) => x.id === k.id);
    if (!cur || cur.revoked) return;
    cur.lastUsedAt = new Date().toISOString();
    await putJSON(env["m365-copilot2api_KV"], KEY, fresh);
  })();
  if (waitUntil) waitUntil(write);
  else await write;
  return true;
}

/** Throttled lastUsedAt UPDATE for the D1 path (once per minute per key). */
function touchLastUsed(
  env: Env,
  id: string,
  rowLastUsed: string | null,
  waitUntil?: (p: Promise<unknown>) => void
): void {
  const now = Date.now();
  const last = lastUsedTouch.get(id) ?? 0;
  if (now - last < LAST_USED_THROTTLE_MS) return;
  if (rowLastUsed && now - Date.parse(rowLastUsed) < LAST_USED_THROTTLE_MS) return;
  lastUsedTouch.set(id, now);
  const write = (async () => {
    try {
      await env.DB!
        .prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), id)
        .run();
    } catch {}
  })();
  if (waitUntil) waitUntil(write);
}

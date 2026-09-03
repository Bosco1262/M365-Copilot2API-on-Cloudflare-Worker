// Session-key bindings and local conversation records
// (simplified ports of sessions.go / conversation_manager.go).
//
// Storage audit P3: session-key bindings used to live in one shared KV
// document ("sessions") rewritten on every console chat turn. Each binding is
// now an independent key `sessbind/<id>` (point read/write, no RMW, no
// cross-binding lost updates). The legacy document is migrated lazily on
// first list/upsert and then deleted.
//
// Storage review P1-1 (Phase 2): with the DB binding, bindings and the
// conversations index live in D1 (migrations/0005_background_writes_d1.sql) —
// together with user sessions and the conv cache they used to burn ~4 of the
// 1,000/day free-tier KV writes per request. KV stays as the no-D1 fallback
// and the one-time lazy backfill source (keys.ts / resolver.ts pattern); the
// fallback copies are no longer written on the hot path, so a code revert
// surfaces the last pre-migration state until entries age back in.

import type { Env } from "../env";
import type { ConversationRecord, SessionBinding } from "../types";
import { getJSON, putJSON } from "../kv";

const SESSBIND_PREFIX = "sessbind/";
const LEGACY_SESSIONS_KEY = "sessions";
const CONVERSATIONS_KEY = "conversations";
const LIST_CAP = 500;

// One-time backfill latches (per isolate; same pattern as keys.ts).
let conversationsBackfilled = false;
let sessionBindingsBackfilled = false;

// Bounded maintenance: the ≤500-entry cap is also enforced by the LIMIT on
// every read, so the prune runs on a subset of writes, not all of them.
const CONV_PRUNE_EVERY = 50;
let convWritesSincePrune = 0;

function d1Msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ------------------------------------------------------------- D1 layer ---

interface BindingRow {
  id: string;
  account_id: string;
  conversation_id: string;
  session_id: string;
  title: string;
  updated_at: string;
}

interface ConvRow {
  id: string;
  account_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

function rowToBinding(r: BindingRow): SessionBinding {
  return {
    id: r.id,
    accountID: r.account_id,
    conversationID: r.conversation_id,
    sessionID: r.session_id,
    title: r.title,
    updatedAt: r.updated_at,
  };
}

function rowToConv(r: ConvRow): ConversationRecord {
  return {
    id: r.id,
    accountID: r.account_id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function bindingValues(b: SessionBinding): string[] {
  return [b.id, b.accountID, b.conversationID, b.sessionID, b.title, b.updatedAt];
}

function convValues(r: ConversationRecord): string[] {
  return [r.id, r.accountID, r.title, r.createdAt, r.updatedAt];
}

const BINDING_SELECT_SQL =
  "SELECT id, account_id, conversation_id, session_id, title, updated_at FROM session_bindings";

const BINDING_UPSERT_SQL = `INSERT INTO session_bindings (id, account_id, conversation_id, session_id, title, updated_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  account_id = excluded.account_id,
  conversation_id = excluded.conversation_id,
  session_id = excluded.session_id,
  title = excluded.title,
  updated_at = excluded.updated_at`;

const CONV_SELECT_SQL = "SELECT id, account_id, title, created_at, updated_at FROM conversations";

// Mirrors the KV RMW semantics: refresh updatedAt always, title only when the
// incoming record carries a non-empty one.
const CONV_UPSERT_SQL = `INSERT INTO conversations (id, account_id, title, created_at, updated_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  updated_at = excluded.updated_at,
  title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE conversations.title END`;

function bindingKey(id: string): string {
  return SESSBIND_PREFIX + id;
}

/** One-time legacy migration: shared "sessions" document -> individual keys. */
async function migrateLegacyBindings(env: Env): Promise<void> {
  if (legacyBindingsMigrated) return;
  const doc = await getJSON<Record<string, SessionBinding>>(
    env["m365-copilot2api_KV"],
    LEGACY_SESSIONS_KEY
  );
  if (!doc || Object.keys(doc).length === 0) {
    legacyBindingsMigrated = true;
    return;
  }
  for (const [id, binding] of Object.entries(doc)) {
    if (id && binding) {
      await putJSON(env["m365-copilot2api_KV"], bindingKey(id), binding);
    }
  }
  await env["m365-copilot2api_KV"].delete(LEGACY_SESSIONS_KEY);
  legacyBindingsMigrated = true;
  console.log(`[sessions] migrated ${Object.keys(doc).length} legacy bindings to individual keys`);
}

// Storage review P1-3: this check used to run a KV read on EVERY upsert/list
// even long after the legacy document was deleted. Latch it per isolate once
// the document is confirmed absent (or migrated); getSessionBinding keeps its
// legacy-fallback read, so a missed migration still resolves correctly.
let legacyBindingsMigrated = false;

/** One-time lazy backfill: KV `sessbind/*` keys -> D1 (latched). */
async function backfillBindingsFromKV(env: Env): Promise<SessionBinding[] | null> {
  if (sessionBindingsBackfilled) return null;
  const fromKV: SessionBinding[] = [];
  try {
    let cursor: string | undefined;
    do {
      const page = await env["m365-copilot2api_KV"].list({
        prefix: SESSBIND_PREFIX,
        cursor,
      });
      for (const k of page.keys) {
        if (fromKV.length >= LIST_CAP) break;
        const b = await getJSON<SessionBinding>(env["m365-copilot2api_KV"], k.name);
        if (b) fromKV.push(b);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  } catch {
    /* enumeration is best-effort */
  }
  if (fromKV.length === 0) return null; // nothing anywhere: keep probing (cheap)
  for (const b of fromKV) {
    try {
      await env.DB!.prepare(BINDING_UPSERT_SQL).bind(...bindingValues(b)).run();
    } catch {}
  }
  sessionBindingsBackfilled = true;
  console.log(`[sessions] backfilled ${fromKV.length} KV bindings into D1`);
  return fromKV;
}

/** One-time lazy backfill: KV conversations index document -> D1 (latched). */
async function backfillConversationsFromKV(env: Env): Promise<ConversationRecord[] | null> {
  if (conversationsBackfilled) return null;
  const doc = (await getJSON<ConversationRecord[]>(env["m365-copilot2api_KV"], CONVERSATIONS_KEY)) ?? [];
  if (doc.length === 0) return null; // nothing anywhere: keep probing (cheap)
  for (const rec of doc) {
    try {
      await env.DB!.prepare(CONV_UPSERT_SQL).bind(...convValues(rec)).run();
    } catch {}
  }
  conversationsBackfilled = true;
  console.log(`[conversations] backfilled ${doc.length} KV index entries into D1`);
  return doc;
}

// ------------------------------------------------------------ public API ---

export async function getSessionBinding(env: Env, key: string): Promise<SessionBinding | null> {
  if (env.DB) {
    try {
      const row = await env.DB.prepare(`${BINDING_SELECT_SQL} WHERE id = ?`)
        .bind(key)
        .first<BindingRow>();
      if (row) return rowToBinding(row);
    } catch (e) {
      console.warn("[sessions] D1 get failed, falling back to KV:", d1Msg(e));
    }
  }
  const direct = await getJSON<SessionBinding>(env["m365-copilot2api_KV"], bindingKey(key));
  if (direct) return direct;
  // Legacy fallback (pre-migration deployments).
  const doc = await getJSON<Record<string, SessionBinding>>(env["m365-copilot2api_KV"], LEGACY_SESSIONS_KEY);
  return doc?.[key] ?? null;
}

export async function upsertSessionBinding(env: Env, binding: SessionBinding): Promise<void> {
  if (env.DB) {
    try {
      await env.DB.prepare(BINDING_UPSERT_SQL).bind(...bindingValues(binding)).run();
      return;
    } catch (e) {
      console.warn("[sessions] D1 upsert failed, falling back to KV:", d1Msg(e));
    }
  }
  await putJSON(env["m365-copilot2api_KV"], bindingKey(binding.id), binding);
  await migrateLegacyBindings(env);
}

export async function deleteSessionBinding(env: Env, key: string): Promise<boolean> {
  const existed = (await getSessionBinding(env, key)) !== null;
  if (env.DB) {
    try {
      await env.DB.prepare("DELETE FROM session_bindings WHERE id = ?").bind(key).run();
    } catch (e) {
      console.warn("[sessions] D1 delete failed:", d1Msg(e));
    }
  }
  try {
    await env["m365-copilot2api_KV"].delete(bindingKey(key));
  } catch {
    /* best-effort: keep the fallback store from resurrecting the binding */
  }
  // Legacy cleanup (pre-migration deployments).
  const doc = await getJSON<Record<string, SessionBinding>>(env["m365-copilot2api_KV"], LEGACY_SESSIONS_KEY);
  if (doc && key in doc) {
    delete doc[key];
    await putJSON(env["m365-copilot2api_KV"], LEGACY_SESSIONS_KEY, doc);
  }
  return existed;
}

export async function listSessionBindings(env: Env): Promise<SessionBinding[]> {
  await migrateLegacyBindings(env);
  if (env.DB) {
    try {
      const res = await env.DB.prepare(`${BINDING_SELECT_SQL} ORDER BY updated_at DESC LIMIT ?`)
        .bind(LIST_CAP)
        .all<BindingRow>();
      if (res.results.length > 0) return res.results.map(rowToBinding);
      // Empty table: one-time lazy backfill from the KV fallback keys.
      const backfilled = await backfillBindingsFromKV(env);
      return backfilled ?? [];
    } catch (e) {
      console.warn("[sessions] D1 list failed, falling back to KV:", d1Msg(e));
    }
  }
  const out: SessionBinding[] = [];
  try {
    let cursor: string | undefined;
    do {
      const page = await env["m365-copilot2api_KV"].list({
        prefix: SESSBIND_PREFIX,
        cursor,
      });
      for (const k of page.keys) {
        if (out.length >= LIST_CAP) return out;
        const b = await getJSON<SessionBinding>(env["m365-copilot2api_KV"], k.name);
        if (b) out.push(b);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  } catch {
    /* enumeration is best-effort */
  }
  return out;
}

export async function recordConversation(env: Env, rec: ConversationRecord): Promise<void> {
  if (env.DB) {
    try {
      await env.DB.prepare(CONV_UPSERT_SQL).bind(...convValues(rec)).run();
      convWritesSincePrune++;
      if (convWritesSincePrune >= CONV_PRUNE_EVERY) {
        convWritesSincePrune = 0;
        await env.DB
          .prepare(
            "DELETE FROM conversations WHERE id NOT IN (SELECT id FROM conversations ORDER BY updated_at DESC LIMIT 500)"
          )
          .run();
      }
      return;
    } catch (e) {
      console.warn("[conversations] D1 upsert failed, falling back to KV:", d1Msg(e));
    }
  }
  const doc = (await getJSON<ConversationRecord[]>(env["m365-copilot2api_KV"], CONVERSATIONS_KEY)) ?? [];
  const existing = doc.find((c) => c.id === rec.id);
  if (existing) {
    existing.updatedAt = rec.updatedAt;
    existing.title = rec.title || existing.title;
  } else {
    doc.unshift(rec);
  }
  // Keep the index bounded.
  if (doc.length > 500) doc.length = 500;
  await putJSON(env["m365-copilot2api_KV"], CONVERSATIONS_KEY, doc);
}

export async function listConversations(env: Env): Promise<ConversationRecord[]> {
  if (env.DB) {
    try {
      const res = await env.DB.prepare(`${CONV_SELECT_SQL} ORDER BY updated_at DESC LIMIT 500`).all<ConvRow>();
      if (res.results.length > 0) return res.results.map(rowToConv);
      // Empty table: one-time lazy backfill from the KV fallback document.
      const backfilled = await backfillConversationsFromKV(env);
      if (backfilled) return backfilled;
      return []; // latched or nothing anywhere: D1 is authoritative
    } catch (e) {
      console.warn("[conversations] D1 list failed, falling back to KV:", d1Msg(e));
    }
  }
  return (await getJSON<ConversationRecord[]>(env["m365-copilot2api_KV"], CONVERSATIONS_KEY)) ?? [];
}

export async function deleteLocalConversation(env: Env, id: string): Promise<void> {
  if (env.DB) {
    try {
      await env.DB.prepare("DELETE FROM conversations WHERE id = ?").bind(id).run();
      return;
    } catch (e) {
      console.warn("[conversations] D1 delete failed, falling back to KV:", d1Msg(e));
    }
  }
  const doc = await listConversations(env);
  const next = doc.filter((c) => c.id !== id);
  await putJSON(env["m365-copilot2api_KV"], CONVERSATIONS_KEY, next);
}

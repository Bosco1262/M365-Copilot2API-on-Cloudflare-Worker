// Session-key bindings and local conversation records on KV
// (simplified ports of sessions.go / conversation_manager.go; the full
// content-fingerprint session resolver arrives in a later phase).
//
// Storage audit P3: session-key bindings used to live in one shared KV
// document ("sessions") rewritten on every console chat turn. Each binding is
// now an independent key `sessbind/<id>` (point read/write, no RMW, no
// cross-binding lost updates). The legacy document is migrated lazily on
// first list/upsert and then deleted. The bounded `conversations` index
// document (≤500 small entries) is intentionally left as-is.

import type { Env } from "../env";
import type { ConversationRecord, SessionBinding } from "../types";
import { getJSON, putJSON } from "../kv";

const SESSBIND_PREFIX = "sessbind/";
const LEGACY_SESSIONS_KEY = "sessions";
const CONVERSATIONS_KEY = "conversations";
const LIST_CAP = 500;

function bindingKey(id: string): string {
  return SESSBIND_PREFIX + id;
}

/** One-time legacy migration: shared "sessions" document -> individual keys. */
async function migrateLegacyBindings(env: Env): Promise<void> {
  const doc = await getJSON<Record<string, SessionBinding>>(
    env["m365-copilot2api_KV"],
    LEGACY_SESSIONS_KEY
  );
  if (!doc || Object.keys(doc).length === 0) return;
  for (const [id, binding] of Object.entries(doc)) {
    if (id && binding) {
      await putJSON(env["m365-copilot2api_KV"], bindingKey(id), binding);
    }
  }
  await env["m365-copilot2api_KV"].delete(LEGACY_SESSIONS_KEY);
  console.log(`[sessions] migrated ${Object.keys(doc).length} legacy bindings to individual keys`);
}

export async function getSessionBinding(env: Env, key: string): Promise<SessionBinding | null> {
  const direct = await getJSON<SessionBinding>(env["m365-copilot2api_KV"], bindingKey(key));
  if (direct) return direct;
  // Legacy fallback (pre-migration deployments).
  const doc = await getJSON<Record<string, SessionBinding>>(env["m365-copilot2api_KV"], LEGACY_SESSIONS_KEY);
  return doc?.[key] ?? null;
}

export async function upsertSessionBinding(env: Env, binding: SessionBinding): Promise<void> {
  await putJSON(env["m365-copilot2api_KV"], bindingKey(binding.id), binding);
  await migrateLegacyBindings(env);
}

export async function deleteSessionBinding(env: Env, key: string): Promise<boolean> {
  const existed = (await getSessionBinding(env, key)) !== null;
  await env["m365-copilot2api_KV"].delete(bindingKey(key));
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

export async function recordConversation(
  env: Env,
  rec: ConversationRecord
): Promise<void> {
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
  return (await getJSON<ConversationRecord[]>(env["m365-copilot2api_KV"], CONVERSATIONS_KEY)) ?? [];
}

export async function deleteLocalConversation(env: Env, id: string): Promise<void> {
  const doc = await listConversations(env);
  const next = doc.filter((c) => c.id !== id);
  await putJSON(env["m365-copilot2api_KV"], CONVERSATIONS_KEY, next);
}

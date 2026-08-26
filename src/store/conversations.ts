// Session-key bindings and local conversation records on KV
// (simplified ports of sessions.go / conversation_manager.go; the full
// content-fingerprint session resolver arrives in a later phase).

import type { Env } from "../env";
import type { ConversationRecord, SessionBinding } from "../types";
import { getJSON, putJSON } from "../kv";

const SESSIONS_KEY = "sessions";
const CONVERSATIONS_KEY = "conversations";

export async function getSessionBinding(env: Env, key: string): Promise<SessionBinding | null> {
  const doc = await getJSON<Record<string, SessionBinding>>(env["m365-copilot2api_KV"], SESSIONS_KEY);
  return doc?.[key] ?? null;
}

export async function upsertSessionBinding(env: Env, binding: SessionBinding): Promise<void> {
  const doc = (await getJSON<Record<string, SessionBinding>>(env["m365-copilot2api_KV"], SESSIONS_KEY)) ?? {};
  doc[binding.id] = binding;
  await putJSON(env["m365-copilot2api_KV"], SESSIONS_KEY, doc);
}

export async function deleteSessionBinding(env: Env, key: string): Promise<boolean> {
  const doc = (await getJSON<Record<string, SessionBinding>>(env["m365-copilot2api_KV"], SESSIONS_KEY)) ?? {};
  if (!doc[key]) return false;
  delete doc[key];
  await putJSON(env["m365-copilot2api_KV"], SESSIONS_KEY, doc);
  return true;
}

export async function listSessionBindings(env: Env): Promise<SessionBinding[]> {
  const doc = (await getJSON<Record<string, SessionBinding>>(env["m365-copilot2api_KV"], SESSIONS_KEY)) ?? {};
  return Object.values(doc);
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

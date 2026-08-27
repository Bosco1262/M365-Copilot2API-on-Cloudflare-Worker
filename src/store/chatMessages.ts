// Conversation transcript rows in D1 for the console detail viewer
// (batch C). One row per user prompt and per assistant answer, appended on
// the success path of /v1/* chat pipelines. D1-only: without the DB binding
// nothing is stored and the detail endpoint reports no history. Rows stay
// under the 1MiB D1 bound-parameter limit (with safety margin); TTL is a
// cron DELETE by age.

import type { Env } from "../env";

export const MAX_MESSAGE_BYTES = 900 * 1024;
export const CHAT_MESSAGES_TTL_DAYS = 7;

export interface ChatMessageRow {
  seq: number;
  role: string;
  content: string;
  createdAt: string;
}

function clip(text: string): string {
  return text.length > MAX_MESSAGE_BYTES ? text.slice(0, MAX_MESSAGE_BYTES) : text;
}

async function nextSeq(env: Env, conversationId: string): Promise<number> {
  const res = await env.DB!
    .prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM chat_messages WHERE conversation_id = ?")
    .bind(conversationId)
    .first<{ max_seq: number }>();
  return (res?.max_seq ?? 0) + 1;
}

/**
 * Appends one completed turn (user prompt + assistant answer). Best-effort:
 * returns silently when D1 is unbound; insert races on the same conversation
 * retry once against a fresh MAX(seq).
 */
export async function appendChatTurn(
  env: Env,
  conversationId: string,
  userText: string,
  assistantText: string
): Promise<void> {
  if (!env.DB || conversationId === "") return;
  if (userText.trim() === "" && assistantText.trim() === "") return;
  const createdAt = new Date().toISOString();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const seq = await nextSeq(env, conversationId);
      await env.DB.batch([
        env.DB
          .prepare("INSERT INTO chat_messages (conversation_id, seq, role, content, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(conversationId, seq, "user", clip(userText), createdAt),
        env.DB
          .prepare("INSERT INTO chat_messages (conversation_id, seq, role, content, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(conversationId, seq + 1, "assistant", clip(assistantText), createdAt),
      ]);
      return;
    } catch (e) {
      if (attempt === 1) {
        console.warn("[chat-messages] append failed:", e instanceof Error ? e.message : e);
      }
    }
  }
}

/** Ordered transcript for one conversation (ContextHistory shape source). */
export async function listMessages(env: Env, conversationId: string): Promise<ChatMessageRow[]> {
  if (!env.DB || conversationId === "") return [];
  try {
    const res = await env.DB
      .prepare("SELECT seq, role, content, created_at FROM chat_messages WHERE conversation_id = ? ORDER BY seq ASC LIMIT 1000")
      .bind(conversationId)
      .all<{ seq: number; role: string; content: string; created_at: string }>();
    return (res.results ?? []).map((r) => ({
      seq: r.seq,
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
    }));
  } catch (e) {
    console.warn("[chat-messages] list failed:", e instanceof Error ? e.message : e);
    return [];
  }
}

/** Purges the transcript when its conversation is deleted locally. */
export async function deleteByConversation(env: Env, conversationId: string): Promise<void> {
  if (!env.DB || conversationId === "") return;
  try {
    await env.DB
      .prepare("DELETE FROM chat_messages WHERE conversation_id = ?")
      .bind(conversationId)
      .run();
  } catch (e) {
    console.warn("[chat-messages] purge failed:", e instanceof Error ? e.message : e);
  }
}

/** Cron TTL sweep (chat_messages older than N days). */
export async function cleanupOld(env: Env, days: number = CHAT_MESSAGES_TTL_DAYS): Promise<void> {
  if (!env.DB) return;
  try {
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    await env.DB
      .prepare("DELETE FROM chat_messages WHERE created_at < ?")
      .bind(cutoff)
      .run();
  } catch (e) {
    console.warn("[chat-messages] cleanup failed:", e instanceof Error ? e.message : e);
  }
}

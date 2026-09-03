// Conversation cache (port of internal/web/conv_cache.go):
// per (API key, account, model) bucket remembering the last conversation used
// with a given system-prompt hash, so follow-up turns with more messages are
// sent incrementally into the SAME cloud conversation instead of rebuilding
// context from scratch. Pure optimization: any miss falls back to the
// content-key session resolver.
//
// Storage review P1-1 (Phase 2): with the DB binding the cache lives in D1
// (migrations/0005_background_writes_d1.sql) — one of the ~4 per-request KV
// writes. KV stays as the no-D1 fallback and is still consulted on a D1 miss
// so pre-migration entries keep working; freshness is enforced on read (KV
// TTL parity) and stale rows are pruned on a subset of writes.

import type { Env } from "../env";
import type { OaiMsg } from "../pipeline/prompt";
import { sha256Hex } from "../util";

export interface ConvCacheEntry {
  accountId: string;
  conversationId: string;
  sessionId: string;
  /** Number of request messages already covered by the cached conversation. */
  messageCount: number;
  sysHash: string;
  lastUsedAt: string;
}

const TTL_SECONDS = 2 * 3600; // same window as session reuse
const CONV_CACHE_PRUNE_EVERY = 100;
let writesSincePrune = 0;

interface ConvCacheRow {
  account_id: string;
  conversation_id: string;
  session_id: string;
  message_count: number;
  sys_hash: string;
  last_used_at: string;
}

/** SHA-256 over system/developer message contents ("" when none present). */
export async function computeSysHash(messages: OaiMsg[]): Promise<string> {
  const parts: string[] = [];
  for (const m of messages ?? []) {
    const role = (m.role ?? "").trim().toLowerCase();
    if (role !== "system" && role !== "developer") continue;
    parts.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""));
  }
  if (parts.length === 0) return "";
  return sha256Hex(parts.join("\n"));
}

// Port of conv_cache.go key(accountID, model): the bucket is per
// (account, model) — API key is deliberately NOT part of the key, matching
// the upstream single-instance cache (C7).
export function convCacheKeyFor(accountId: string, model: string): string {
  return `convcache:${accountId || "auto"}|${model || "default"}`;
}

export async function getConvCache(env: Env, key: string): Promise<ConvCacheEntry | null> {
  if (env.DB) {
    try {
      const row = await env.DB
        .prepare(
          "SELECT account_id, conversation_id, session_id, message_count, sys_hash, last_used_at FROM conv_cache WHERE cache_key = ?"
        )
        .bind(key)
        .first<ConvCacheRow>();
      if (row) {
        // KV TTL parity: expired entries are misses even though D1 has no TTL.
        if (Date.now() - Date.parse(row.last_used_at) > TTL_SECONDS * 1000) return null;
        return {
          accountId: row.account_id,
          conversationId: row.conversation_id,
          sessionId: row.session_id,
          messageCount: row.message_count,
          sysHash: row.sys_hash,
          lastUsedAt: row.last_used_at,
        };
      }
    } catch {
      /* fall back to KV below */
    }
  }
  try {
    const raw = await env["m365-copilot2api_KV"].get(key);
    if (!raw) return null;
    const e = JSON.parse(raw) as ConvCacheEntry;
    if (!e || typeof e.conversationId !== "string" || e.conversationId === "") return null;
    return e;
  } catch {
    return null;
  }
}

export async function putConvCache(env: Env, key: string, entry: ConvCacheEntry): Promise<void> {
  try {
    entry.lastUsedAt = new Date().toISOString();
    if (env.DB) {
      await env.DB
        .prepare(`INSERT INTO conv_cache (cache_key, account_id, conversation_id, session_id, message_count, sys_hash, last_used_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(cache_key) DO UPDATE SET
  account_id = excluded.account_id,
  conversation_id = excluded.conversation_id,
  session_id = excluded.session_id,
  message_count = excluded.message_count,
  sys_hash = excluded.sys_hash,
  last_used_at = excluded.last_used_at`)
        .bind(
          key,
          entry.accountId,
          entry.conversationId,
          entry.sessionId,
          entry.messageCount,
          entry.sysHash,
          entry.lastUsedAt
        )
        .run();
      writesSincePrune++;
      if (writesSincePrune >= CONV_CACHE_PRUNE_EVERY) {
        writesSincePrune = 0;
        await env.DB
          .prepare("DELETE FROM conv_cache WHERE last_used_at < ?")
          .bind(new Date(Date.now() - TTL_SECONDS * 1000).toISOString())
          .run();
      }
      return;
    }
    await env["m365-copilot2api_KV"].put(key, JSON.stringify(entry), {
      expirationTtl: TTL_SECONDS,
    });
  } catch {
    /* cache write failures are non-fatal */
  }
}

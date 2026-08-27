// Conversation cache (port of internal/web/conv_cache.go, KV storage):
// per (API key, account, model) bucket remembering the last conversation used
// with a given system-prompt hash, so follow-up turns with more messages are
// sent incrementally into the SAME cloud conversation instead of rebuilding
// context from scratch. Pure optimization: any miss falls back to the
// content-key session resolver.

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
    await env["m365-copilot2api_KV"].put(key, JSON.stringify(entry), {
      expirationTtl: TTL_SECONDS,
    });
  } catch {
    /* cache write failures are non-fatal */
  }
}

// Cloud conversation auto-cleanup (port of internal/web/auto_cleanup.go).
// Conversations are treated as cache entries: hits refresh their lifetime,
// idle ones past maxAge (default 2h) or beyond keepN (default 5, per upstream
// code) are recycled via the M365 cloud API.

import type { Env } from "../env";
import { firstAccountCloudClient } from "./m365cloud";
import { listResolverSessions, unbindByConversation } from "./resolver";
import { listConversations, deleteLocalConversation } from "../store/conversations";

export interface CleanupEnvConfig {
  enabled: boolean;
  maxAgeMs: number;
  keepN: number;
}

export function cleanupConfig(env: Env): CleanupEnvConfig {
  const flag = (env as unknown as Record<string, string | undefined>)["M365_AUTO_CLEANUP"];
  const disabled = ["0", "false", "no", "off"].includes((flag ?? "").trim().toLowerCase());
  const hours = numVar(env, "M365_AUTO_CLEANUP_MAX_AGE_HOURS", 2);
  return {
    enabled: !disabled,
    maxAgeMs: Math.max(1, hours) * 3600_000,
    keepN: numVar(env, "M365_AUTO_CLEANUP_KEEP_N", 5),
  };
}

function numVar(env: Env, name: string, fallback: number): number {
  const v = (env as unknown as Record<string, string | undefined>)[name];
  const n = Number.parseInt((v ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Protected conversations: resolver sessions still inside the window and
// recently used local records. They correspond to live cache entries.
async function activeConversationSet(env: Env, windowMs: number): Promise<Set<string>> {
  const active = new Set<string>();
  const cutoff = Date.now() - windowMs;
  for (const sess of await listResolverSessions(env)) {
    if (Date.parse(sess.lastUsedAt) > cutoff) active.add(sess.conversationId);
  }
  for (const conv of await listConversations(env)) {
    if (Date.parse(conv.updatedAt) > cutoff) active.add(conv.id);
  }
  return active;
}

async function dropConversation(env: Env, conversationId: string): Promise<void> {
  await deleteLocalConversation(env, conversationId);
  await unbindByConversation(env, conversationId);
}

export async function autoCleanupOnce(
  env: Env,
  config: CleanupEnvConfig
): Promise<{ deleted: number; skipped: string }> {
  const client = await firstAccountCloudClient(env);
  if (!client) {
    return { deleted: 0, skipped: "m365 cloud client not configured" };
  }
  // Subrequest budget guard (Free plan allows ~50 per invocation).
  let deleteBudget = 30;

  const active = await activeConversationSet(env, config.maxAgeMs);
  const nowMs = Date.now();
  let deleted = 0;

  for (let round = 0; round < 100; round++) {
    let chats: Record<string, unknown>[];
    try {
      chats = await client.listConversations();
    } catch (e) {
      console.error("[auto-cleanup] list failed:", e);
      return { deleted, skipped: "list failed" };
    }
    if (chats.length === 0) break;

    const stale: { id: string; createMs: number }[] = [];
    const rest: { id: string; createMs: number }[] = [];
    for (const chat of chats) {
      const convId = typeof chat["conversationId"] === "string" ? chat["conversationId"] : "";
      if (!convId || active.has(convId)) continue;
      const createMs = chat["createTimeUtc"];
      if (typeof createMs !== "number") continue; // never guess for fresh chats
      if (nowMs - createMs > config.maxAgeMs) stale.push({ id: convId, createMs });
      else rest.push({ id: convId, createMs });
    }

    let anyDeleted = false;
    for (const c of stale) {
      if (deleteBudget <= 0) return { deleted, skipped: "delete budget exhausted" };
      try {
        await client.deleteConversation(c.id);
        await dropConversation(env, c.id);
        deleted++;
        anyDeleted = true;
        deleteBudget--;
      } catch (e) {
        console.error(`[auto-cleanup] delete ${c.id} failed:`, e);
      }
    }
    rest.sort((a, b) => a.createMs - b.createMs);
    for (let i = config.keepN; i < rest.length; i++) {
      if (deleteBudget <= 0) return { deleted, skipped: "delete budget exhausted" };
      try {
        await client.deleteConversation(rest[i].id);
        await dropConversation(env, rest[i].id);
        deleted++;
        anyDeleted = true;
        deleteBudget--;
      } catch (e) {
        console.error(`[auto-cleanup] delete ${rest[i].id} failed:`, e);
      }
    }
    if (!anyDeleted) break;
  }
  if (deleted > 0) console.log(`[auto-cleanup] removed ${deleted} idle conversations`);
  return { deleted, skipped: "" };
}

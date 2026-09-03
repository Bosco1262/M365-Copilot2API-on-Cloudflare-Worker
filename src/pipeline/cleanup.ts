// Cloud conversation auto-cleanup (port of internal/web/auto_cleanup.go).
// Conversations are treated as cache entries: hits refresh their lifetime,
// idle ones past maxAge (default 2h) or beyond keepN (default 5, per upstream
// code) are recycled via the M365 cloud API.

import type { Env } from "../env";
import { firstAccountCloudClient } from "./m365cloud";
import { listResolverIndex, unbindByConversation } from "./resolver";
import { listConversations, deleteLocalConversation } from "../store/conversations";

export interface CleanupEnvConfig {
  enabled: boolean;
  maxAgeMs: number;
  keepN: number;
  // conversation_manager.go modes mapped onto the cron sweep:
  //   after_response -> age + keepN (cron approximation of per-turn clearing)
  //   keep_n         -> only keepN newest survive
  //   max_age        -> only age-based deletion
  mode: "after_response" | "keep_n" | "max_age";
}

export function cleanupConfig(env: Env): CleanupEnvConfig {
  const flag = (env as unknown as Record<string, string | undefined>)["M365_AUTO_CLEANUP"];
  const disabled = ["0", "false", "no", "off"].includes((flag ?? "").trim().toLowerCase());
  const hours = numVar(env, "M365_AUTO_CLEANUP_MAX_AGE_HOURS", 2);
  const modeRaw = ((env as unknown as Record<string, string | undefined>)["M365_CLEANUP_MODE"] ?? "")
    .trim()
    .toLowerCase();
  const mode =
    modeRaw === "keep_n" || modeRaw === "max_age" || modeRaw === "after_response"
      ? modeRaw
      : ("after_response" as const);
  return {
    enabled: !disabled,
    maxAgeMs: Math.max(1, hours) * 3600_000,
    keepN: numVar(env, "M365_AUTO_CLEANUP_KEEP_N", 5),
    mode,
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
  // Storage review P0-1: index entries already carry conversationId and
  // lastUsedAt — no need to read up to 50 full session transcripts here.
  for (const e of await listResolverIndex(env)) {
    if (Date.parse(e.lastUsedAt) > cutoff) active.add(e.conversationId);
  }
  for (const conv of await listConversations(env)) {
    if (Date.parse(conv.updatedAt) > cutoff) active.add(conv.id);
  }
  // Whitelisted conversations are never recycled (conversation_manager.go).
  const { whitelistIDs, activeUserConversations } = await import("../admin/extras");
  for (const id of await whitelistIDs(env)) active.add(id);
  for (const id of await activeUserConversations(env)) active.add(id);
  return active;
}

async function dropConversation(env: Env, conversationId: string): Promise<void> {
  await deleteLocalConversation(env, conversationId);
  await unbindByConversation(env, conversationId);
  // The viewer transcript dies with its conversation.
  const { deleteByConversation } = await import("../store/chatMessages");
  await deleteByConversation(env, conversationId);
}

export async function autoCleanupOnce(
  env: Env,
  config: CleanupEnvConfig
): Promise<{ deleted: number; skipped: string }> {
  const client = await firstAccountCloudClient(env);
  if (!client) {
    return { deleted: 0, skipped: "m365 cloud client not configured" };
  }
  // Subrequest budget guard (Free plan allows ~50 per invocation). Storage
  // review P1-6: each cloud delete is followed by 1-3 local KV deletes
  // (conversation record + session bindings), and the cron fires 48x/day —
  // 30/run peaked at ~1,440+ deletes/day against the 1,000/day free budget.
  // 20/run keeps the worst case near the ceiling without stalling cleanup.
  let deleteBudget = 20;

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

    const useAge = config.mode === "after_response" || config.mode === "max_age";
    const stale: { id: string; createMs: number }[] = [];
    const rest: { id: string; createMs: number }[] = [];
    for (const chat of chats) {
      const convId = typeof chat["conversationId"] === "string" ? chat["conversationId"] : "";
      if (!convId || active.has(convId)) continue;
      const createMs = chat["createTimeUtc"];
      if (typeof createMs !== "number") continue; // never guess for fresh chats
      if (useAge && nowMs - createMs > config.maxAgeMs) stale.push({ id: convId, createMs });
      else rest.push({ id: convId, createMs });
    }

    let anyDeleted = false;
    if (useAge) {
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
    }
    if (config.mode !== "max_age") {
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
    }
    if (!anyDeleted) break;
  }
  if (deleted > 0) console.log(`[auto-cleanup] removed ${deleted} idle conversations`);
  return { deleted, skipped: "" };
}

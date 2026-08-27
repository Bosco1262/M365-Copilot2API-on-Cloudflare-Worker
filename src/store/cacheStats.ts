// Cache-hit statistics (port of internal/web/cache_stats.go).
//
// Storage audit P2-1: with the D1 binding present, counters live in the
// cache_stats table and are incremented atomically (UPSERT with
// col = col + excluded.col), eliminating the lost-update races of the old
// KV read-modify-write. The write itself already runs inside the
// recordFinalize waitUntil task, so it stays off the request critical path.
// The legacy KV document remains as the no-D1 fallback.

import type { Env } from "../env";
import { getJSON, putJSON } from "../kv";

export interface KeyStat {
  api_key: string;
  total_requests: number;
  cache_hits: number;
  cache_misses: number;
  tokens_sent: number;
  tokens_saved: number;
  hit_rate: number;
  last_used: string;
}

export interface CacheStatsDoc {
  total_requests: number;
  cache_hits: number;
  cache_misses: number;
  tokens_sent: number;
  tokens_saved: number;
  active_sessions: number;
  hit_rate: number;
  savings_percent: number;
  key_stats: Record<string, KeyStat>;
}

const KEY = "cache-stats";
const META_ACTIVE_SESSIONS = "active_sessions";

function empty(): CacheStatsDoc {
  return {
    total_requests: 0,
    cache_hits: 0,
    cache_misses: 0,
    tokens_sent: 0,
    tokens_saved: 0,
    active_sessions: 0,
    hit_rate: 0,
    savings_percent: 0,
    key_stats: {},
  };
}

interface StatRow {
  api_key: string;
  hits: number;
  misses: number;
  tokens_sent: number;
  tokens_saved: number;
  last_used: string;
}

const UPSERT_SQL = `INSERT INTO cache_stats (api_key, hits, misses, tokens_sent, tokens_saved, last_used)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(api_key) DO UPDATE SET
  hits = hits + excluded.hits,
  misses = misses + excluded.misses,
  tokens_sent = tokens_sent + excluded.tokens_sent,
  tokens_saved = tokens_saved + excluded.tokens_saved,
  last_used = excluded.last_used`;

// Port of RecordRequest.
export async function recordCacheRequest(
  env: Env,
  apiKey: string,
  hit: boolean,
  tokensSent: number,
  tokensSaved: number,
  activeSessions: number
): Promise<void> {
  if (env.DB) {
    try {
      await env.DB
        .prepare(UPSERT_SQL)
        .bind(apiKey, hit ? 1 : 0, hit ? 0 : 1, tokensSent, tokensSaved, new Date().toISOString())
        .run();
      await env.DB
        .prepare(
          "INSERT INTO cache_stats_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        )
        .bind(META_ACTIVE_SESSIONS, String(activeSessions))
        .run();
      return;
    } catch (e) {
      console.warn("[cache-stats] D1 write failed, falling back to KV:", e instanceof Error ? e.message : e);
    }
  }
  const s = (await getJSON<CacheStatsDoc>(env["m365-copilot2api_KV"], KEY)) ?? empty();
  s.total_requests++;
  s.tokens_sent += tokensSent;
  s.tokens_saved += tokensSaved;
  s.active_sessions = activeSessions;
  if (hit) s.cache_hits++;
  else s.cache_misses++;
  if (s.total_requests > 0) {
    s.hit_rate = (s.cache_hits / s.total_requests) * 100;
  }
  if (s.tokens_sent + s.tokens_saved > 0) {
    s.savings_percent = (s.tokens_saved / (s.tokens_sent + s.tokens_saved)) * 100;
  }
  const ks = (s.key_stats[apiKey] ??= {
    api_key: apiKey,
    total_requests: 0,
    cache_hits: 0,
    cache_misses: 0,
    tokens_sent: 0,
    tokens_saved: 0,
    hit_rate: 0,
    last_used: "",
  });
  ks.total_requests++;
  ks.tokens_sent += tokensSent;
  ks.tokens_saved += tokensSaved;
  ks.last_used = new Date().toISOString();
  if (hit) ks.cache_hits++;
  else ks.cache_misses++;
  if (ks.total_requests > 0) {
    ks.hit_rate = (ks.cache_hits / ks.total_requests) * 100;
  }
  await putJSON(env["m365-copilot2api_KV"], KEY, s);
}

export async function getCacheStats(env: Env): Promise<CacheStatsDoc> {
  if (env.DB) {
    try {
      const totals = await env.DB
        .prepare(
          "SELECT COALESCE(SUM(hits),0) AS hits, COALESCE(SUM(misses),0) AS misses, COALESCE(SUM(tokens_sent),0) AS tokens_sent, COALESCE(SUM(tokens_saved),0) AS tokens_saved FROM cache_stats"
        )
        .first<{ hits: number; misses: number; tokens_sent: number; tokens_saved: number }>();
      const rows = await env.DB
        .prepare("SELECT api_key, hits, misses, tokens_sent, tokens_saved, last_used FROM cache_stats")
        .all<StatRow>();
      const meta = await env.DB
        .prepare("SELECT value FROM cache_stats_meta WHERE key = ?")
        .bind(META_ACTIVE_SESSIONS)
        .first<{ value: string }>();
      const hits = totals?.hits ?? 0;
      const misses = totals?.misses ?? 0;
      const tokensSent = totals?.tokens_sent ?? 0;
      const tokensSaved = totals?.tokens_saved ?? 0;
      const total = hits + misses;
      const key_stats: Record<string, KeyStat> = {};
      for (const r of rows.results) {
        const reqs = r.hits + r.misses;
        key_stats[r.api_key] = {
          api_key: r.api_key,
          total_requests: reqs,
          cache_hits: r.hits,
          cache_misses: r.misses,
          tokens_sent: r.tokens_sent,
          tokens_saved: r.tokens_saved,
          hit_rate: reqs > 0 ? (r.hits / reqs) * 100 : 0,
          last_used: r.last_used,
        };
      }
      return {
        total_requests: total,
        cache_hits: hits,
        cache_misses: misses,
        tokens_sent: tokensSent,
        tokens_saved: tokensSaved,
        active_sessions: meta ? Number(meta.value) || 0 : 0,
        hit_rate: total > 0 ? (hits / total) * 100 : 0,
        savings_percent:
          tokensSent + tokensSaved > 0 ? (tokensSaved / (tokensSent + tokensSaved)) * 100 : 0,
        key_stats,
      };
    } catch (e) {
      console.warn("[cache-stats] D1 read failed, falling back to KV:", e instanceof Error ? e.message : e);
    }
  }
  return (await getJSON<CacheStatsDoc>(env["m365-copilot2api_KV"], KEY)) ?? empty();
}

export async function resetCacheStats(env: Env): Promise<void> {
  if (env.DB) {
    try {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM cache_stats"),
        env.DB.prepare("DELETE FROM cache_stats_meta"),
      ]);
      return;
    } catch (e) {
      console.warn("[cache-stats] D1 reset failed, falling back to KV:", e instanceof Error ? e.message : e);
    }
  }
  await putJSON(env["m365-copilot2api_KV"], KEY, empty());
}

// Cache-hit statistics on KV (port of internal/web/cache_stats.go).

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

// Port of RecordRequest.
export async function recordCacheRequest(
  env: Env,
  apiKey: string,
  hit: boolean,
  tokensSent: number,
  tokensSaved: number,
  activeSessions: number
): Promise<void> {
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
  return (await getJSON<CacheStatsDoc>(env["m365-copilot2api_KV"], KEY)) ?? empty();
}

export async function resetCacheStats(env: Env): Promise<void> {
  await putJSON(env["m365-copilot2api_KV"], KEY, empty());
}

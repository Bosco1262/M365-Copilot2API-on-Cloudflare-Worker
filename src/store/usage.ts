// Usage statistics on KV (port of internal/web/usage.go, storage adapted):
// records are appended into daily buckets "usage/<yyyyMMdd>" to keep the
// number of KV reads bounded for dashboard aggregation. Concurrent appends
// may rarely lose a record (read-modify-write); acceptable for stats.

import type { Env } from "../env";
import type { UsageRecord } from "../types";
import { getJSON } from "../kv";

const MAX_PER_BUCKET = 5000;

function bucketKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `usage/${y}${m}${day}`;
}

export async function recordUsage(env: Env, rec: UsageRecord): Promise<void> {
  if (env.DB) {
    try {
      await env.DB
        .prepare("INSERT INTO usage_events (ts, api_key_prefix, model, json) VALUES (?, ?, ?, ?)")
        .bind(rec.time, rec.api_key_prefix ?? "", rec.model ?? "", JSON.stringify(rec))
        .run();
      return;
    } catch (e) {
      console.warn("[usage] D1 insert failed:", e instanceof Error ? e.message : e);
    }
  }
  const key = bucketKey(new Date(rec.time));
  const arr = (await getJSON<UsageRecord[]>(env["m365-copilot2api_KV"], key)) ?? [];
  arr.push(rec);
  if (arr.length > MAX_PER_BUCKET) arr.splice(0, arr.length - MAX_PER_BUCKET);
  await env["m365-copilot2api_KV"].put(key, JSON.stringify(arr), { expirationTtl: 90 * 86400 });
}

interface UsageCountStat {
  requests: number;
  tokens: number;
}
interface UsageTrendPoint {
  date: string;
  requests: number;
  tokens: number;
}

async function loadWindow(env: Env, days: number): Promise<UsageRecord[]> {
  if (env.DB) {
    const cutoffIso =
      days > 0 ? new Date(Date.now() - days * 86400_000).toISOString() : "1970-01-01T00:00:00Z";
    const res = await env.DB
      .prepare("SELECT json FROM usage_events WHERE ts >= ? ORDER BY ts ASC LIMIT 50000")
      .bind(cutoffIso)
      .all<{ json: string }>();
    const out: UsageRecord[] = [];
    for (const row of res.results) {
      try {
        out.push(JSON.parse(row.json) as UsageRecord);
      } catch {}
    }
    return out;
  }
  return loadWindowKV(env, days);
}

// Legacy KV day-bucket reader (used when no D1 binding is configured, and by
// the one-shot KV→D1 backfill endpoint).
export async function listLegacyRecords(env: Env, days: number): Promise<UsageRecord[]> {
  return loadWindowKV(env, days);
}

async function loadWindowKV(env: Env, days: number): Promise<UsageRecord[]> {
  // list keys with prefix usage/ (lexicographic == chronological)
  let keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env["m365-copilot2api_KV"].list({ prefix: "usage/", cursor });
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
    if (keys.length > 400) break; // safety cap on list pages
  } while (cursor);
  keys.sort();
  if (days > 0) {
    const cutoff = bucketKey(new Date(Date.now() - days * 86400_000));
    keys = keys.filter((k) => k >= `usage/` && k >= cutoff);
  }
  // Bound subrequests (Free plan allows ~50 per invocation).
  keys = keys.slice(-30);
  const out: UsageRecord[] = [];
  for (const key of keys) {
    const arr = await getJSON<UsageRecord[]>(env["m365-copilot2api_KV"], key);
    if (arr) out.push(...arr);
  }
  out.sort((a, b) => a.time.localeCompare(b.time));
  return out;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${m}-${day}`;
}

export async function usageSnapshot(env: Env, days: number): Promise<Record<string, unknown>> {
  const recs = await loadWindow(env, days);
  const cutoff = Date.now() - days * 86400_000;
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  let requests = 0;
  let inTok = 0;
  let outTok = 0;
  let cacheTok = 0;
  let durationMs = 0;
  let todayReq = 0;
  let todayTok = 0;
  let h24Req = 0;
  let h24Tok = 0;
  const keyCounts: Record<string, UsageCountStat> = {};
  const modelCounts: Record<string, UsageCountStat> = {};
  const endpointCounts: Record<string, UsageCountStat> = {};
  const trendMap: Record<string, UsageTrendPoint> = {};

  for (const rec of recs) {
    const t = Date.parse(rec.time);
    if (t < cutoff) continue;
    requests++;
    const reqTok = rec.input_tokens + rec.output_tokens + rec.cache_tokens;
    inTok += rec.input_tokens;
    outTok += rec.output_tokens;
    cacheTok += rec.cache_tokens;
    durationMs += rec.duration_ms;
    if (t >= todayStart.getTime()) {
      todayReq++;
      todayTok += reqTok;
    }
    if (t >= Date.now() - 86400_000) {
      h24Req++;
      h24Tok += reqTok;
    }
    const ks = (keyCounts[rec.api_key_prefix] ??= { requests: 0, tokens: 0 });
    ks.requests++;
    ks.tokens += reqTok;
    const mc = (modelCounts[rec.model] ??= { requests: 0, tokens: 0 });
    mc.requests++;
    mc.tokens += reqTok;
    const ec = (endpointCounts[rec.endpoint] ??= { requests: 0, tokens: 0 });
    ec.requests++;
    ec.tokens += reqTok;
    const date = dayLabel(rec.time);
    const tp = (trendMap[date] ??= { date, requests: 0, tokens: 0 });
    tp.requests++;
    tp.tokens += reqTok;
  }

  const avgMs = requests > 0 ? Math.floor(durationMs / requests) : 0;
  const models = Object.entries(modelCounts)
    .map(([name, c]) => ({ name, requests: c.requests, tokens: c.tokens }))
    .sort((a, b) => b.tokens - a.tokens);
  const endpoints = Object.entries(endpointCounts)
    .map(([endpoint, c]) => ({ endpoint, requests: c.requests, tokens: c.tokens }))
    .sort((a, b) => b.tokens - a.tokens);
  const keys = Object.entries(keyCounts)
    .map(([api_key_prefix, c]) => ({ api_key_prefix, requests: c.requests, tokens: c.tokens }))
    .sort((a, b) => b.requests - a.requests);
  const trend = Object.values(trendMap).sort((a, b) => a.date.localeCompare(b.date));

  return {
    summary: {
      requests,
      tokens: inTok + outTok + cacheTok,
      input: inTok,
      output: outTok,
      cache: cacheTok,
      avg_ms: avgMs,
      today_requests: todayReq,
      today_tokens: todayTok,
      last24h_requests: h24Req,
      last24h_tokens: h24Tok,
    },
    models,
    endpoints,
    keys,
    trend,
  };
}

export async function usageLogs(
  env: Env,
  limit: number,
  offset: number
): Promise<{ logs: UsageRecord[]; total: number }> {
  const recs = await loadWindow(env, 90);
  const total = recs.length;
  let off = offset;
  if (off > total) off = total;
  const start = Math.max(0, total - off - limit);
  const end = Math.max(0, total - off);
  if (start >= end) return { logs: [], total };
  const out = recs.slice(start, end);
  out.sort((a, b) => b.time.localeCompare(a.time));
  return { logs: out, total };
}

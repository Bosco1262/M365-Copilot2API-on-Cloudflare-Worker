// CoordinationDO: singleton Durable Object ("gateway-coord") providing the
// cross-isolate primitives the gateway previously kept per isolate (or not at
// all):
//   - POST /lockout        admin-login failure lockout, 5 failures / 15 min
//   - POST /next-account   atomic round-robin cursor over the account ids
//   - POST /acquire        per-account concurrency semaphore (bounded wait)
//   - POST /release        frees a semaphore slot held by this request
//   - POST /mutex          named single-flight mutex with TTL (token refresh)
//
// Every Worker-side helper below returns null when env.COORD is unbound or on
// any stub failure, so callers transparently keep the legacy behavior.

import type { Env, DurableObjectStateLite } from "../env";

const STATE_KEY = "state";
const LOCKOUT_WINDOW_MS = 15 * 60_000;
const LOCKOUT_MAX_FAILURES = 5;
const HOLDER_TTL_MS = 15 * 60_000; // stale lease reaping (crashed isolates)
const DEFAULT_ACQUIRE_WAIT_MS = 15_000;
const DEFAULT_MUTEX_TTL_MS = 30_000;

interface CoordState {
  cursor: number;
  failures: Record<string, number[]>; // ip -> failure timestamps (ms)
  mutexes: Record<string, { token: string; expires: number }>;
  semaphores: Record<string, Record<string, number>>; // accountId -> holderId -> acquiredAt
}

function emptyState(): CoordState {
  return { cursor: 0, failures: {}, mutexes: {}, semaphores: {} };
}

function now(): number {
  return Date.now();
}

function reap(st: CoordState): void {
  const t = now();
  for (const [ip, list] of Object.entries(st.failures)) {
    const kept = list.filter((ts) => t - ts < LOCKOUT_WINDOW_MS);
    if (kept.length !== list.length) {
      if (kept.length === 0) delete st.failures[ip];
      else st.failures[ip] = kept;
    }
  }
  for (const [key, m] of Object.entries(st.mutexes)) {
    if (m.expires <= t) delete st.mutexes[key];
  }
  for (const [acc, holders] of Object.entries(st.semaphores)) {
    for (const [holder, ts] of Object.entries(holders)) {
      if (t - ts > HOLDER_TTL_MS) delete holders[holder];
    }
    if (Object.keys(holders).length === 0) delete st.semaphores[acc];
  }
}

function earliestExpiry(st: CoordState): number | null {
  let min: number | null = null;
  for (const m of Object.values(st.mutexes)) {
    if (min === null || m.expires < min) min = m.expires;
  }
  for (const holders of Object.values(st.semaphores)) {
    for (const ts of Object.values(holders)) {
      const exp = ts + HOLDER_TTL_MS;
      if (min === null || exp < min) min = exp;
    }
  }
  return min;
}

export class CoordinationDO {
  private state?: CoordState;

  constructor(private ctx: DurableObjectStateLite) {}

  private async load(): Promise<CoordState> {
    if (!this.state) {
      this.state = (await this.ctx.storage.get<CoordState>(STATE_KEY)) ?? emptyState();
    }
    return this.state;
  }

  private async save(st: CoordState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, st);
    const next = earliestExpiry(st);
    if (next !== null) {
      try {
        await this.ctx.storage.setAlarm(Math.max(now() + 1, next));
      } catch {
        /* alarm support optional */
      }
    }
  }

  // Alarm handler: reaps expired leases/mutexes and reschedules if needed.
  async alarm(): Promise<void> {
    const st = await this.load();
    reap(st);
    await this.ctx.storage.put(STATE_KEY, st);
    const next = earliestExpiry(st);
    if (next !== null) {
      try {
        await this.ctx.storage.setAlarm(Math.max(now() + 1, next));
      } catch {
        /* ignore */
      }
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const st = await this.load();
    reap(st);
    switch (url.pathname) {
      case "/lockout":
      case "/lockout/check": {
        const ip = typeof body["ip"] === "string" ? body["ip"] : "";
        if (ip === "") return json({ locked: false, remaining: LOCKOUT_MAX_FAILURES });
        const record = url.pathname === "/lockout";
        if (record) {
          const list = st.failures[ip] ?? [];
          list.push(now());
          st.failures[ip] = list;
        }
        const failures = (st.failures[ip] ?? []).length;
        const locked = failures >= LOCKOUT_MAX_FAILURES;
        await this.save(st);
        return json({
          locked,
          remaining: Math.max(0, LOCKOUT_MAX_FAILURES - failures),
          retryAfterSec: Math.ceil(LOCKOUT_WINDOW_MS / 1000),
        });
      }
      case "/next-account": {
        const ids = Array.isArray(body["ids"]) ? body["ids"].map(String) : [];
        if (ids.length === 0) {
          await this.save(st);
          return json({ id: null });
        }
        const idx = st.cursor % ids.length;
        st.cursor = (st.cursor + 1) % Number.MAX_SAFE_INTEGER;
        await this.save(st);
        return json({ id: ids[idx] });
      }
      case "/acquire": {
        const accountId = String(body["accountId"] ?? "");
        const limit = positiveInt(body["limit"], 1);
        // 0 is a meaningful maxWaitMs ("deny immediately if full").
        const maxWaitMs = nonNegativeInt(body["maxWaitMs"], DEFAULT_ACQUIRE_WAIT_MS);
        const ttlMs = positiveInt(body["ttlMs"], HOLDER_TTL_MS);
        if (accountId === "") return json({ acquired: false, retryAfterMs: 0 });
        const deadline = now() + maxWaitMs;
        for (;;) {
          reap(st);
          const holders = st.semaphores[accountId] ?? {};
          if (Object.keys(holders).length < limit) {
            const holder = crypto.randomUUID();
            holders[holder] = now();
            st.semaphores[accountId] = holders;
            await this.save(st);
            return json({ acquired: true, holder });
          }
          if (now() >= deadline) {
            await this.save(st);
            return json({ acquired: false, retryAfterMs: 1000 });
          }
          await sleep(Math.min(250, deadline - now()));
        }
      }
      case "/release": {
        const accountId = String(body["accountId"] ?? "");
        const holder = typeof body["holder"] === "string" ? body["holder"] : "";
        const holders = st.semaphores[accountId];
        if (holders) {
          if (holder !== "" && holder in holders) {
            delete holders[holder];
          } else if (holder === "") {
            // No holder id: drop the oldest lease for this account.
            const oldest = Object.entries(holders).sort((a, b) => a[1] - b[1])[0];
            if (oldest) delete holders[oldest[0]];
          }
          if (Object.keys(holders).length === 0) delete st.semaphores[accountId];
        }
        await this.save(st);
        return json({ ok: true });
      }
      case "/mutex": {
        const key = String(body["key"] ?? "");
        const ttlMs = positiveInt(body["ttlMs"], DEFAULT_MUTEX_TTL_MS);
        if (key === "") return json({ ok: false });
        const existing = st.mutexes[key];
        if (existing && existing.expires > now()) return json({ ok: false });
        const token = crypto.randomUUID();
        st.mutexes[key] = { token, expires: now() + ttlMs };
        await this.save(st);
        return json({ ok: true, token });
      }
      case "/mutex/release": {
        const key = String(body["key"] ?? "");
        const token = String(body["token"] ?? "");
        const existing = st.mutexes[key];
        if (existing && existing.token === token) delete st.mutexes[key];
        await this.save(st);
        return json({ ok: true });
      }
      default:
        return json({ error: "not found" }, 404);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(1, ms)));
}

function positiveInt(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function nonNegativeInt(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ------------------------------------------------------------ client side ---

async function coordAction<T>(env: Env, action: string, payload: unknown): Promise<T | null> {
  const ns = env.COORD;
  if (!ns) return null;
  try {
    const stub = ns.get(ns.idFromName("gateway-coord"));
    const resp = await stub.fetch(`https://coordination.local${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null; // any DO hiccup degrades to legacy behavior
  }
}

export interface LockoutResult {
  locked: boolean;
  remaining: number;
  retryAfterSec?: number;
}

/** Records one failed admin login for ip. Null when coordination is unbound. */
export function coordLockoutRecord(env: Env, ip: string): Promise<LockoutResult | null> {
  return coordAction<LockoutResult>(env, "/lockout", { ip });
}

/** Checks (without recording) whether ip is currently locked out. */
export function coordLockoutCheck(env: Env, ip: string): Promise<LockoutResult | null> {
  return coordAction<LockoutResult>(env, "/lockout/check", { ip });
}

/**
 * Atomic round-robin pick across isolates. Returns the selected id, or null
 * when unbound (caller falls back to the KV nextIdx rotation).
 */
export function coordNextAccountID(env: Env, ids: string[]): Promise<string | null> {
  return coordAction<{ id: string | null }>(env, "/next-account", { ids }).then(
    (r) => r?.id ?? null
  );
}

export interface AcquireResult {
  acquired: boolean;
  holder?: string;
  retryAfterMs?: number;
}

/** Takes a concurrency slot for accountId (bounded wait). */
export function coordAcquireAccount(
  env: Env,
  accountId: string,
  limit: number,
  maxWaitMs = DEFAULT_ACQUIRE_WAIT_MS
): Promise<AcquireResult | null> {
  return coordAction<AcquireResult>(env, "/acquire", { accountId, limit, maxWaitMs });
}

export async function coordReleaseAccount(
  env: Env,
  accountId: string,
  holder: string
): Promise<void> {
  await coordAction(env, "/release", { accountId, holder });
}

export interface MutexResult {
  ok: boolean;
  token?: string;
}

/** Single-flight mutex acquire around key (e.g. "refresh:<accountId>"). */
export function coordMutexAcquire(
  env: Env,
  key: string,
  ttlMs = DEFAULT_MUTEX_TTL_MS
): Promise<MutexResult | null> {
  return coordAction<MutexResult>(env, "/mutex", { key, ttlMs });
}

export async function coordMutexRelease(env: Env, key: string, token: string): Promise<void> {
  await coordAction(env, "/mutex/release", { key, token });
}

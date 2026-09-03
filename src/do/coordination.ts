// CoordinationDO: singleton Durable Object ("gateway-coord") providing the
// cross-isolate primitives the gateway previously kept per isolate (or not at
// all):
//   - POST /lockout / /lockout/check  admin-login failure lockout, 5/15 min
//   - POST /next-account   atomic round-robin cursor over the account ids
//   - POST /acquire        per-account concurrency semaphore (bounded wait)
//   - POST /release        frees a semaphore slot held by this request
//   - POST /mutex          named single-flight mutex with TTL (token refresh)
//   - GET  /accounts-cache / POST update|invalidate  account-list cache
//     (hot-path listAccounts() avoids a full D1 scan per request; the Worker
//     refetches on miss and pushes the rows back, the DO only stores them)
//   - POST /health/available|mark-failure|image-limited|mark-success|clear|snapshot
//     account health state (cooldown/authFail/limited) moved up from the KV
//     document so cooldown decisions are strongly consistent across isolates
//
// Every Worker-side helper below returns null when env.COORD is unbound or on
// any stub failure, so callers transparently keep the legacy behavior.

import type { Env, DurableObjectStateLite } from "../env";
import type { AccountToken } from "../types";
import {
  classifyError,
  cooldownMsForCategory,
  circuitIsOpen,
  circuitRecord,
  emptyCircuit,
  isClientCanceledCategory,
  type ErrorCategory,
  type GlobalCircuitState,
} from "../errors";

const STATE_KEY = "state";
const LOCKOUT_WINDOW_MS = 15 * 60_000;
const LOCKOUT_MAX_FAILURES = 5;
const HOLDER_TTL_MS = 15 * 60_000; // stale lease reaping (crashed isolates)
const DEFAULT_ACQUIRE_WAIT_MS = 15_000;
const DEFAULT_MUTEX_TTL_MS = 30_000;
const ACCOUNTS_CACHE_TTL_MS = 30_000;

// Upstream accountHealth.authFailReason values (account_health.go:577-584).
const AUTH_FAIL_REASON: Record<string, string> = {
  AUTH_EXPIRED_401: "401",
  FORBIDDEN_403: "403",
  USER_BANNED: "banned",
  USER_THROTTLED: "throttled",
};

interface HealthEntry {
  cooldown?: string; // expiry ISO
  authFail?: boolean;
  limited?: boolean;
  imageLimited?: boolean;
  calls?: number;
  quotaAttempts?: number;
  authFailReason?: string;
  throttling?: unknown;
}

interface CoordState {
  cursor: number;
  failures: Record<string, number[]>; // ip -> failure timestamps (ms)
  mutexes: Record<string, { token: string; expires: number }>;
  semaphores: Record<string, Record<string, number>>; // accountId -> holderId -> acquiredAt
  health: Record<string, HealthEntry>; // accountId -> health state
  circuit: GlobalCircuitState; // global circuit breaker (upstream globalCircuit)
}

function emptyState(): CoordState {
  return { cursor: 0, failures: {}, mutexes: {}, semaphores: {}, health: {}, circuit: emptyCircuit() };
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
  for (const [id, h] of Object.entries(st.health)) {
    // Port of account_health.go cleanupExpiredCooldownLocked: an expired
    // cooldown clears the cooldown-class flags but keeps calls/throttling
    // unless the account was rate-limited (then calls reset too).
    if (h.cooldown && Date.parse(h.cooldown) <= t) {
      const wasLimited = !!h.limited;
      delete h.cooldown;
      delete h.limited;
      delete h.authFail;
      delete h.imageLimited;
      delete h.quotaAttempts;
      delete h.authFailReason;
      if (wasLimited) delete h.calls;
      if (Object.keys(h).length === 0) delete st.health[id];
    }
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
  for (const h of Object.values(st.health)) {
    const exp = h.cooldown ? Date.parse(h.cooldown) : Number.NaN;
    if (Number.isFinite(exp) && (min === null || exp < min)) min = exp;
  }
  if (st.circuit && st.circuit.openUntil > 0) {
    if (min === null || st.circuit.openUntil < min) min = st.circuit.openUntil;
  }
  return min;
}

export class CoordinationDO {
  private state?: CoordState;
  private accountCache: { at: number; accounts: AccountToken[] } | null = null;

  constructor(private ctx: DurableObjectStateLite) {}

  private async load(): Promise<CoordState> {
    if (!this.state) {
      this.state = (await this.ctx.storage.get<CoordState>(STATE_KEY)) ?? emptyState();
      if (!this.state.health) this.state.health = {};
      if (!this.state.circuit) this.state.circuit = emptyCircuit();
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
    if (req.method === "GET" && url.pathname === "/accounts-cache") {
      if (this.accountCache && now() - this.accountCache.at < ACCOUNTS_CACHE_TTL_MS) {
        return json({ cached: true, accounts: this.accountCache.accounts });
      }
      return json({ cached: false });
    }
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    if (url.pathname === "/accounts-cache/update") {
      const accounts = Array.isArray(body["accounts"]) ? (body["accounts"] as AccountToken[]) : [];
      this.accountCache = { at: now(), accounts };
      return json({ ok: true });
    }
    if (url.pathname === "/accounts-cache/invalidate") {
      this.accountCache = null;
      return json({ ok: true });
    }
    const st = await this.load();
    reap(st);
    switch (url.pathname) {
      case "/health/available": {
        const accountId = String(body["accountId"] ?? "");
        if (circuitIsOpen(st.circuit)) return json({ available: false });
        const h = accountId !== "" ? st.health[accountId] : undefined;
        if (h?.authFail) return json({ available: false });
        if (h?.cooldown && Date.parse(h.cooldown) > now()) return json({ available: false });
        return json({ available: true });
      }
      case "/health/mark-failure": {
        const accountId = String(body["accountId"] ?? "");
        if (accountId === "") return json({ ok: false });
        // New path: the Worker classifies the error and sends the category;
        // the DO owns quotaAttempts (exponential backoff) and the circuit.
        const catRaw = String(body["cat"] ?? "");
        const retryAfter = nonNegativeInt(body["retryAfter"], 0);
        const h = (st.health[accountId] ??= { cooldown: "" });
        if (catRaw !== "") {
          const cat = catRaw as ErrorCategory;
          let attempt = 1;
          if (cat === "QUOTA_429") {
            attempt = (h.quotaAttempts ?? 0) + 1;
            h.quotaAttempts = attempt;
            h.limited = true;
            delete h.imageLimited;
          } else if (cat === "INSUFFICIENT_TOKENS") {
            h.limited = true;
          } else if (cat === "AUTH_EXPIRED_401" || cat === "FORBIDDEN_403" || cat === "USER_BANNED" || cat === "USER_THROTTLED") {
            h.authFail = true;
            h.authFailReason = AUTH_FAIL_REASON[cat] ?? "401";
            delete h.limited;
          }
          h.cooldown = new Date(now() + cooldownMsForCategory(cat, retryAfter, attempt)).toISOString();
          // Circuit: client cancels and circuit-induced failures never re-arm.
          if (!isClientCanceledCategory(cat) && cat !== "GLOBAL_UNAVAILABLE") {
            circuitRecord(st.circuit, cat);
          }
          await this.save(st);
          return json({ ok: true });
        }
        // Legacy path (kind + cooldownMs) kept for callers that precompute.
        const kind = String(body["kind"] ?? "rate");
        const cooldownMs = positiveInt(body["cooldownMs"], 30_000);
        if (kind === "auth") {
          h.authFail = true;
          h.authFailReason = "401";
          delete h.limited;
        } else {
          h.limited = true;
          delete h.imageLimited;
        }
        h.cooldown = new Date(now() + cooldownMs).toISOString();
        circuitRecord(st.circuit, kind === "auth" ? "AUTH_EXPIRED_401" : "QUOTA_429");
        await this.save(st);
        return json({ ok: true });
      }
      case "/health/image-limited": {
        const accountId = String(body["accountId"] ?? "");
        const cooldownMs = positiveInt(body["cooldownMs"], 30_000);
        if (accountId === "") return json({ ok: false });
        const h = (st.health[accountId] ??= { cooldown: "" });
        h.limited = true;
        h.imageLimited = true;
        h.cooldown = new Date(now() + cooldownMs).toISOString();
        await this.save(st);
        return json({ ok: true });
      }
      case "/health/mark-call": {
        const accountId = String(body["accountId"] ?? "");
        if (accountId === "") return json({ ok: false });
        const h = (st.health[accountId] ??= { cooldown: "" });
        h.calls = (h.calls ?? 0) + 1;
        await this.save(st);
        return json({ ok: true });
      }
      case "/health/update-throttling": {
        const accountId = String(body["accountId"] ?? "");
        if (accountId === "") return json({ ok: false });
        const h = (st.health[accountId] ??= { cooldown: "" });
        h.throttling = body["throttling"];
        await this.save(st);
        return json({ ok: true });
      }
      case "/health/mark-success": {
        const accountId = String(body["accountId"] ?? "");
        const h = accountId !== "" ? st.health[accountId] : undefined;
        if (h) {
          // Upstream MarkSuccess keeps imageLimited (until its window), the
          // call counter and throttling; only the rate-limit class flags drop.
          const keepImage = h.imageLimited && h.cooldown && Date.parse(h.cooldown) > now();
          if (keepImage) {
            h.authFail = false;
            delete h.limited;
            delete h.quotaAttempts;
            delete h.authFailReason;
          } else {
            delete h.cooldown;
            delete h.authFail;
            delete h.limited;
            delete h.imageLimited;
            delete h.quotaAttempts;
            delete h.authFailReason;
            if (h.calls === undefined && h.throttling === undefined) delete st.health[accountId];
          }
        }
        circuitRecord(st.circuit, null);
        await this.save(st);
        return json({ ok: true });
      }
      case "/health/clear": {
        st.health = {};
        st.circuit = emptyCircuit();
        await this.save(st);
        return json({ ok: true });
      }
      case "/health/snapshot": {
        const cooldown: Record<string, string> = {};
        const authFail: Record<string, boolean> = {};
        const limited: Record<string, boolean> = {};
        const imageLimited: Record<string, boolean> = {};
        const calls: Record<string, number> = {};
        const authFailReason: Record<string, string> = {};
        const throttling: Record<string, unknown> = {};
        for (const [id, h] of Object.entries(st.health)) {
          if (h.cooldown) cooldown[id] = h.cooldown;
          if (h.authFail) authFail[id] = true;
          if (h.limited) limited[id] = true;
          if (h.imageLimited) imageLimited[id] = true;
          if (h.calls !== undefined && h.calls > 0) calls[id] = h.calls;
          if (h.authFailReason) authFailReason[id] = h.authFailReason;
          if (h.throttling !== undefined) throttling[id] = h.throttling;
        }
        const out: Record<string, unknown> = { cooldown, authFail, limited, imageLimited, calls, authFailReason, throttling };
        if (circuitIsOpen(st.circuit)) {
          out["circuit"] = { open: true, openUntil: new Date(st.circuit.openUntil).toISOString() };
        }
        return json(out);
      }
      case "/semaphore/snapshot": {
        const inflight: Record<string, number> = {};
        for (const [acc, holders] of Object.entries(st.semaphores)) {
          inflight[acc] = Object.keys(holders).length;
        }
        return json({ inflight });
      }
      case "/semaphore/available": {
        const accountId = String(body["accountId"] ?? "");
        const limit = positiveInt(body["limit"], 1);
        if (accountId === "") return json({ available: true });
        const holders = st.semaphores[accountId] ?? {};
        return json({ available: Object.keys(holders).length < limit });
      }
      case "/next-healthy": {
        // Atomic account pick for resolveAccount / nextHealthyAccount: advances
        // the round-robin cursor and returns the first account that is healthy
        // (no auth-failure, cooldown not active, circuit closed) AND has a free
        // concurrency slot — upstream's accountAvailable pre-filter (B1/B6).
        const ids = Array.isArray(body["ids"]) ? body["ids"].map(String) : [];
        const limit = positiveInt(body["limit"], 8);
        const avoidId = String(body["avoidId"] ?? "");
        if (ids.length === 0) {
          await this.save(st);
          return json({ id: null, lastReason: "cooldown" });
        }
        // Upstream only inspects the last candidate when the probe loop ends;
        // mirror that so the caller can pick the right 429 flavour.
        let lastReason: "cooldown" | "concurrency" = "cooldown";
        for (let i = 0; i < ids.length; i++) {
          const idx = (st.cursor + i) % ids.length;
          const id = ids[idx];
          if (avoidId !== "" && id === avoidId) continue;
          const h = st.health[id];
          if (circuitIsOpen(st.circuit) || h?.authFail || (h?.cooldown && Date.parse(h.cooldown) > now())) {
            lastReason = "cooldown";
            continue;
          }
          if (Object.keys(st.semaphores[id] ?? {}).length >= limit) {
            lastReason = "concurrency";
            continue;
          }
          st.cursor = (st.cursor + i + 1) % Number.MAX_SAFE_INTEGER;
          await this.save(st);
          return json({ id, lastReason });
        }
        st.cursor = (st.cursor + ids.length) % Number.MAX_SAFE_INTEGER;
        await this.save(st);
        return json({ id: null, lastReason });
      }
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

// ------------------------------------------------------- accounts cache ---

export interface AccountsCacheResult {
  cached: boolean;
  accounts?: AccountToken[];
}

/** Returns the DO-cached account list when fresh, { cached:false } otherwise. */
export function coordGetAccounts(env: Env): Promise<AccountsCacheResult | null> {
  const ns = env.COORD;
  if (!ns) return Promise.resolve(null);
  return ns
    .get(ns.idFromName("gateway-coord"))
    .fetch("https://coordination.local/accounts-cache", { method: "GET" })
    .then(async (resp) => {
      if (!resp.ok) return null;
      return (await resp.json()) as AccountsCacheResult;
    })
    .catch(() => null);
}

/** Pushes a freshly loaded account list into the DO cache (best-effort). */
export async function coordSetAccounts(env: Env, accounts: AccountToken[]): Promise<void> {
  await coordAction(env, "/accounts-cache/update", { accounts });
}

/** Drops the cached list after a structural change (create/delete). */
export async function coordInvalidateAccounts(env: Env): Promise<void> {
  await coordAction(env, "/accounts-cache/invalidate", {});
}

// ----------------------------------------------------- account health ----

export interface HealthSnapshot {
  cooldown: Record<string, string>;
  authFail: Record<string, boolean>;
  limited: Record<string, boolean>;
  imageLimited?: Record<string, boolean>;
  calls?: Record<string, number>;
  authFailReason?: Record<string, string>;
  throttling?: Record<string, unknown>;
  circuit?: { open: boolean; openUntil?: string };
}

/** True/False when the DO answered, null when coordination is unbound. */
export function coordHealthAvailable(env: Env, accountId: string): Promise<boolean | null> {
  return coordAction<{ available: boolean }>(env, "/health/available", { accountId }).then(
    (r) => r?.available ?? null
  );
}

/**
 * Records a failure with its error category; the DO computes the cooldown
 * (exponential backoff for QUOTA_429), bumps quotaAttempts and feeds the
 * global circuit breaker. `retryAfter` is the upstream Retry-After seconds.
 */
export function coordHealthMarkFailure(
  env: Env,
  accountId: string,
  cat: ErrorCategory,
  retryAfter = 0
): Promise<boolean | null> {
  return coordAction<{ ok: boolean }>(env, "/health/mark-failure", { accountId, cat, retryAfter }).then(
    (r) => r?.ok ?? null
  );
}

export function coordHealthImageLimited(
  env: Env,
  accountId: string,
  cooldownMs: number
): Promise<boolean | null> {
  return coordAction<{ ok: boolean }>(env, "/health/image-limited", { accountId, cooldownMs }).then(
    (r) => r?.ok ?? null
  );
}

export function coordHealthMarkSuccess(env: Env, accountId: string): Promise<boolean | null> {
  return coordAction<{ ok: boolean }>(env, "/health/mark-success", { accountId }).then(
    (r) => r?.ok ?? null
  );
}

export async function coordHealthClear(env: Env): Promise<boolean | null> {
  const r = await coordAction<{ ok: boolean }>(env, "/health/clear", {});
  return r?.ok ?? null;
}

/** Bumps the per-account call counter (port of accountPool.MarkCall).
 * True/False when the DO answered, null when coordination is unbound. */
export async function coordHealthMarkCall(env: Env, accountId: string): Promise<boolean | null> {
  const r = await coordAction<{ ok: boolean }>(env, "/health/mark-call", { accountId });
  return r?.ok ?? null;
}

/** Stores the latest ChatHub throttling payload for the account (best-effort).
 * True/False when the DO answered, null when coordination is unbound. */
export async function coordHealthUpdateThrottling(
  env: Env,
  accountId: string,
  throttling: unknown
): Promise<boolean | null> {
  const r = await coordAction<{ ok: boolean }>(env, "/health/update-throttling", {
    accountId,
    throttling,
  });
  return r?.ok ?? null;
}

export function coordHealthSnapshot(env: Env): Promise<HealthSnapshot | null> {
  return coordAction<HealthSnapshot>(env, "/health/snapshot", {});
}

// ----------------------------------------------------- concurrency / pick ----

/** True/False whether accountId still has a free concurrency slot (no claim). */
export function coordSemaphoreAvailable(
  env: Env,
  accountId: string,
  limit: number
): Promise<boolean | null> {
  return coordAction<{ available: boolean }>(env, "/semaphore/available", { accountId, limit }).then(
    (r) => r?.available ?? null
  );
}

/** In-flight count per account (port of accountConcurrency.Snapshot/Inflight). */
export function coordSemaphoreSnapshot(env: Env): Promise<Record<string, number> | null> {
  return coordAction<{ inflight: Record<string, number> }>(env, "/semaphore/snapshot", {}).then(
    (r) => r?.inflight ?? null
  );
}

export interface NextHealthyResult {
  id: string | null;
  lastReason: "cooldown" | "concurrency";
}

/**
 * Atomic round-robin pick that pre-filters health + concurrency in one call
 * (upstream resolveAccount/nextHealthyAccount accountAvailable semantics).
 * Returns null only when the coordination DO is unbound or failed — callers
 * then fall back to the legacy KV/isolate path.
 */
export function coordNextHealthy(
  env: Env,
  ids: string[],
  limit: number,
  avoidId = ""
): Promise<NextHealthyResult | null> {
  return coordAction<NextHealthyResult>(env, "/next-healthy", { ids, limit, avoidId });
}

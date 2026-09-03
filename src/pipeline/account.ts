// Account health + selection (port of internal/web/account_health.go and
// resolveAccount / nextHealthyAccount from server.go).
//
// Storage review (low #2): the health state (cooldown/authFail/limited) has
// moved up to the Coordination DO so cooldown decisions are strongly
// consistent across isolates (KV was eventually consistent, so a cooldown
// marker could take up to ~60s to propagate and several isolates would keep
// hammering the same account). With env.COORD bound the DO is the authority;
// the KV "account-health" document stays purely as the no-DO advisory
// fallback so cooldowns still survive isolate eviction in degraded setups.
// The Worker keeps the error-classification (auth vs rate-limit) and sends
// only the derived category + retry-after to the DO, which owns the
// quota-attempt counter (exponential backoff) and the global circuit breaker.

import type { Env } from "../env";
import { getJSON, putJSON } from "../kv";
import { ensureValid, listAccounts, nextAccount, scheduleEnabled } from "../store/accounts";
import { getSettings } from "../store/settings";
import type { AccountToken } from "../types";
import {
  coordHealthAvailable,
  coordHealthMarkFailure,
  coordHealthImageLimited,
  coordHealthMarkSuccess,
  coordHealthClear,
  coordHealthSnapshot,
  coordHealthMarkCall,
  coordHealthUpdateThrottling,
  coordNextHealthy,
  coordSemaphoreAvailable,
  coordSemaphoreSnapshot,
} from "../do/coordination";
import {
  classifyError,
  cooldownMsForCategory,
  circuitIsOpen,
  circuitRecord,
  emptyCircuit,
  isClientCanceledCategory,
  type GlobalCircuitState,
} from "../errors";

export const RATE_LIMIT_COOLDOWN_MS = 30_000;
const MAX_ACCOUNT_PROBE = 16;

interface HealthDoc {
  cooldown: Record<string, string>; // id -> expiry ISO
  authFail: Record<string, boolean>;
  limited: Record<string, boolean>;
  imageLimited: Record<string, boolean>;
  calls: Record<string, number>;
  quotaAttempts: Record<string, number>; // consecutive 429 counter (exponential backoff)
  authFailReason: Record<string, string>;
  throttling: Record<string, unknown>;
}

const KEY = "account-health";
const LAST_HEALTHY_KEY = "account-last-healthy";

// Isolate-local global circuit breaker for the no-DO fallback path (upstream
// globalCircuit is process-level; with the COORD bound the DO copy governs).
const globalCircuit: GlobalCircuitState = emptyCircuit();

async function load(env: Env): Promise<HealthDoc> {
  return (
    (await getJSON<HealthDoc>(env["m365-copilot2api_KV"], KEY)) ?? {
      cooldown: {},
      authFail: {},
      limited: {},
      imageLimited: {},
      calls: {},
      quotaAttempts: {},
      authFailReason: {},
      throttling: {},
    }
  );
}

// Port of Server.lastHealthyAccount: the most recently successful account is
// preferred for the next unpinned request so round-robin does not fragment
// cloud sessions (C4).
//
// Storage review P1-2: this pointer is a preference, not state — rewriting it
// on every resolveAccount burned one KV write per request against the
// 1,000/day free budget. Track the last remembered account per isolate and
// only write on change; a failed write resets the tracker so the next resolve
// retries. After 12h the TTL expires the entry (preference reverts to plain
// round-robin until the account changes again) — acceptable by design.
let lastRememberedHealthy = "";

async function rememberHealthy(env: Env, accountID: string): Promise<void> {
  if (accountID === lastRememberedHealthy) return;
  lastRememberedHealthy = "";
  try {
    await env["m365-copilot2api_KV"].put(LAST_HEALTHY_KEY, accountID, {
      expirationTtl: 12 * 3600,
    });
    lastRememberedHealthy = accountID;
  } catch {
    /* non-fatal */
  }
}

async function lastHealthyAccountID(env: Env): Promise<string> {
  try {
    return (await env["m365-copilot2api_KV"].get(LAST_HEALTHY_KEY)) ?? "";
  } catch {
    return "";
  }
}

function cleanupExpired(h: HealthDoc, id: string) {
  const until = h.cooldown[id];
  if (until && Date.now() >= Date.parse(until)) {
    // Port of upstream cleanupExpiredCooldownLocked: calls reset only when
    // the account was rate-limited; throttling survives.
    const wasLimited = h.limited[id];
    delete h.cooldown[id];
    delete h.limited[id];
    delete h.authFail[id];
    delete h.imageLimited[id];
    delete h.quotaAttempts[id];
    delete h.authFailReason[id];
    if (wasLimited) delete h.calls[id];
  }
}

// Port of accountPool.Available: auth failures, active cooldowns and an open
// global circuit all make the account unavailable.
export async function available(env: Env, accountID: string): Promise<boolean> {
  const via = await coordHealthAvailable(env, accountID);
  if (via !== null) return via;
  const h = await load(env);
  cleanupExpired(h, accountID);
  if (circuitIsOpen(globalCircuit)) return false;
  if (h.authFail[accountID]) return false;
  const until = h.cooldown[accountID];
  if (until && Date.now() < Date.parse(until)) return false;
  return true;
}

// Port of accountConcurrency.Available (account_concurrency.go:32-39): true
// while the account still has a free concurrency slot. Only meaningful when
// the coordination DO is bound; unbound -> true (K4: no gating, deliberate).
export async function concurrencyAvailable(env: Env, accountID: string): Promise<boolean> {
  if (accountID === "") return true;
  try {
    const settings = await getSettings(env);
    const via = await coordSemaphoreAvailable(env, accountID, settings.accountConcurrencyLimit);
    return via === null ? true : via;
  } catch {
    return true;
  }
}

// Port of accountPool.MarkFailure (account_health.go:586-700): full error
// taxonomy with per-category cooldowns, exponential backoff for repeated
// quota failures and the global circuit breaker.
export async function markFailure(env: Env, accountID: string, err: unknown): Promise<void> {
  const cat = classifyError(err);
  if (isClientCanceledCategory(cat)) {
    // Upstream records client cancels in the circuit but never cools down.
    circuitRecord(globalCircuit, cat);
    return;
  }
  if (cat !== "GLOBAL_UNAVAILABLE") {
    circuitRecord(globalCircuit, cat);
  }
  const retryAfter = retryAfterOf(err);
  const ok = await coordHealthMarkFailure(env, accountID, cat, retryAfter);
  if (ok) return;
  // ---- no-DO fallback: KV health document + isolate-local circuit ----
  const settings = await getSettings(env);
  const h = await load(env);
  let cd = 0;
  switch (cat) {
    case "QUOTA_429": {
      h.quotaAttempts[accountID] = (h.quotaAttempts[accountID] ?? 0) + 1;
      cd = cooldownMsForCategory(cat, retryAfter, h.quotaAttempts[accountID]);
      h.limited[accountID] = true;
      delete h.imageLimited[accountID];
      break;
    }
    case "AUTH_EXPIRED_401":
    case "FORBIDDEN_403":
    case "USER_BANNED":
    case "USER_THROTTLED":
      h.authFail[accountID] = true;
      h.authFailReason[accountID] = AUTH_FAIL_REASON[cat] ?? "401";
      delete h.limited[accountID];
      cd = cooldownMsForCategory(cat, 0, 1);
      break;
    case "INSUFFICIENT_TOKENS":
      h.limited[accountID] = true;
      cd = cooldownMsForCategory(cat, 0, 1);
      break;
    default:
      // OVERLOAD_503 / 传输类 / UPSTREAM_STRUCTURED / RETRYABLE_422 /
      // DESIGNER_DISABLED / UNKNOWN — no authFail/limited flag (upstream).
      cd = cooldownMsForCategory(cat, retryAfter, 1);
      if (cat === "UNKNOWN") {
        // Upstream default branch: min(window, 30s), window = rate-limit cooldown.
        cd = Math.min((settings.rateLimitCooldownSeconds ?? 30) * 1000, 30_000);
      }
      break;
  }
  if (cd > 0) h.cooldown[accountID] = new Date(Date.now() + cd).toISOString();
  await putJSON(env["m365-copilot2api_KV"], KEY, h);
}

// Upstream accountHealth.authFailReason values (account_health.go:577-584).
const AUTH_FAIL_REASON: Record<string, string> = {
  AUTH_EXPIRED_401: "401",
  FORBIDDEN_403: "403",
  USER_BANNED: "banned",
  USER_THROTTLED: "throttled",
};

// Port of accountPool.MarkImageLimited: the daily image-generation quota is
// per-account; the account is marked limited until the next UTC midnight so
// quota exhaustion does not consume the regular rate-limit cooldown (A7).
export async function markImageLimited(env: Env, accountID: string): Promise<void> {
  const now = new Date();
  const nextMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  const cooldownMs = Math.max(1, nextMidnight.getTime() - now.getTime());
  const ok = await coordHealthImageLimited(env, accountID, cooldownMs);
  if (ok) return;
  const h = await load(env);
  h.limited[accountID] = true;
  h.imageLimited[accountID] = true;
  h.cooldown[accountID] = nextMidnight.toISOString();
  h.calls[accountID] = h.calls[accountID] ?? 0;
  await putJSON(env["m365-copilot2api_KV"], KEY, h);
}

// Port of accountPool.MarkCall: per-account call counter (fed by every
// ChatHub round-trip through chatWithAccount, upstream account_concurrency.go).
export async function markCall(env: Env, accountID: string): Promise<void> {
  const ok = await coordHealthMarkCall(env, accountID);
  // Same contract as markFailure/markSuccess: with the DO bound it is the
  // authority — the KV "account-health" document is the no-DO fallback only,
  // so a bound DO must not pay a KV read-modify-write per ChatHub round-trip.
  if (ok) return;
  const h = await load(env);
  h.calls[accountID] = (h.calls[accountID] ?? 0) + 1;
  await putJSON(env["m365-copilot2api_KV"], KEY, h);
}

// Port of accountPool.UpdateThrottling: keep the latest ChatHub throttling
// payload so the console can show per-account usage pressure.
export async function updateThrottling(env: Env, accountID: string, data: unknown): Promise<void> {
  if (data === null || data === undefined) return;
  const ok = await coordHealthUpdateThrottling(env, accountID, data);
  if (ok) return; // DO answered: skip the no-DO KV fallback write.
  const h = await load(env);
  h.throttling[accountID] = data;
  await putJSON(env["m365-copilot2api_KV"], KEY, h);
}

export async function markSuccess(env: Env, accountID: string): Promise<void> {
  const ok = await coordHealthMarkSuccess(env, accountID);
  if (ok) {
    circuitRecord(globalCircuit, null);
    return;
  }
  const h = await load(env);
  // Upstream MarkSuccess keeps imageLimited until its window (and the call
  // counter + throttling); only the rate-limit class flags drop.
  const keepImage = h.imageLimited[accountID] && h.cooldown[accountID] && Date.now() < Date.parse(h.cooldown[accountID]);
  if (keepImage) {
    delete h.authFail[accountID];
    delete h.limited[accountID];
    delete h.quotaAttempts[accountID];
    delete h.authFailReason[accountID];
    circuitRecord(globalCircuit, null);
    await putJSON(env["m365-copilot2api_KV"], KEY, h);
    return;
  }
  if (!h.cooldown[accountID] && !h.authFail[accountID] && !h.limited[accountID]) {
    circuitRecord(globalCircuit, null);
    return;
  }
  delete h.cooldown[accountID];
  delete h.authFail[accountID];
  delete h.limited[accountID];
  delete h.imageLimited[accountID];
  delete h.quotaAttempts[accountID];
  delete h.authFailReason[accountID];
  circuitRecord(globalCircuit, null);
  await putJSON(env["m365-copilot2api_KV"], KEY, h);
}

export async function clearAllCooldowns(env: Env): Promise<void> {
  const ok = await coordHealthClear(env);
  if (ok) return;
  globalCircuit.windowStart = 0;
  globalCircuit.total = 0;
  globalCircuit.failures = 0;
  globalCircuit.openUntil = 0;
  await putJSON(env["m365-copilot2api_KV"], KEY, {
    cooldown: {},
    authFail: {},
    limited: {},
    imageLimited: {},
    calls: {},
    quotaAttempts: {},
    authFailReason: {},
    throttling: {},
  });
}

export async function healthSnapshot(
  env: Env
): Promise<Record<string, Record<string, unknown>>> {
  const via = await coordHealthSnapshot(env);
  if (via) {
    return flattenHealth(
      via.cooldown,
      via.authFail,
      via.limited,
      via.imageLimited ?? {},
      via.calls ?? {},
      via.authFailReason ?? {},
      via.throttling ?? {}
    );
  }
  const h = await load(env);
  return flattenHealth(h.cooldown, h.authFail, h.limited, h.imageLimited, h.calls, h.authFailReason, h.throttling);
}

function flattenHealth(
  cooldown: Record<string, string>,
  authFail: Record<string, boolean>,
  limited: Record<string, boolean>,
  imageLimited: Record<string, boolean>,
  calls: Record<string, number>,
  authFailReason: Record<string, string>,
  throttling: Record<string, unknown>
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [id, until] of Object.entries(cooldown)) {
    out[id] = { available: Date.now() > Date.parse(until), cooldownUntil: until };
  }
  for (const [id, failed] of Object.entries(authFail)) {
    if (failed) {
      out[id] ??= {};
      out[id]["authFailed"] = true;
    }
  }
  for (const [id, lim] of Object.entries(limited)) {
    if (lim) {
      out[id] ??= {};
      out[id]["limited"] = true;
    }
  }
  for (const [id, img] of Object.entries(imageLimited)) {
    if (img) {
      out[id] ??= {};
      out[id]["imageLimited"] = true;
    }
  }
  for (const [id, c] of Object.entries(calls)) {
    if (c > 0) {
      out[id] ??= {};
      out[id]["calls"] = c;
    }
  }
  for (const [id, r] of Object.entries(authFailReason)) {
    if (r !== "") {
      out[id] ??= {};
      out[id]["authFailReason"] = r;
    }
  }
  for (const [id, t] of Object.entries(throttling)) {
    if (t !== undefined) {
      out[id] ??= {};
      out[id]["throttling"] = t;
    }
  }
  return out;
}

/** In-flight concurrency per account (null when the DO is unbound). */
export async function semaphoreSnapshot(env: Env): Promise<Record<string, number> | null> {
  return coordSemaphoreSnapshot(env);
}

function retryAfterOf(err: unknown): number {
  const e = err as { retryAfter?: number } | null;
  return e?.retryAfter ?? 0;
}

// Earliest moment any account recovers (cooldown or circuit open). Used for
// the "all accounts are cooling down" 429 Retry-After (upstream
// accountPool.EarliestRecovery, server.go:1070-1075).
async function earliestRecoveryMs(env: Env): Promise<number> {
  const snap = await coordHealthSnapshot(env);
  if (snap) {
    let earliest = 0;
    for (const until of Object.values(snap.cooldown)) {
      const t = Date.parse(until);
      if (Number.isFinite(t) && (earliest === 0 || t < earliest)) earliest = t;
    }
    if (snap.circuit?.open && snap.circuit.openUntil) {
      const t = Date.parse(snap.circuit.openUntil);
      if (Number.isFinite(t) && (earliest === 0 || t < earliest)) earliest = t;
    }
    return Math.max(0, earliest - Date.now());
  }
  const h = await load(env);
  let earliest = 0;
  for (const until of Object.values(h.cooldown)) {
    const t = Date.parse(until);
    if (Number.isFinite(t) && (earliest === 0 || t < earliest)) earliest = t;
  }
  if (circuitIsOpen(globalCircuit) && globalCircuit.openUntil > 0 && (earliest === 0 || globalCircuit.openUntil < earliest)) {
    earliest = globalCircuit.openUntil;
  }
  return Math.max(0, earliest - Date.now());
}

function cooldown429(retryAfterSec: number, body: string): Error {
  const err = new Error(body) as Error & {
    status: number;
    retryAfter: number;
    body: string;
  };
  err.status = 429;
  err.retryAfter = retryAfterSec;
  err.body = body;
  err.name = "UpstreamHTTPError";
  return err;
}

export interface ResolvedAccount extends AccountToken {}

// Port of Server.resolveAccount (C4): prefer the last healthy account, only
// rotate on failure; round-robin over enabled, healthy accounts otherwise.
// With the coordination DO bound the pick pre-filters health AND the
// concurrency slot in one atomic call (upstream accountAvailable, B1/B6);
// the no-DO path checks health per probe and keeps concurrency ungated (K4).
export async function resolveAccount(env: Env, requestedID: string): Promise<AccountToken> {
  if (requestedID === "") {
    // Prefer the last successful account so consecutive requests land on the
    // same cloud session (upstream lastHealthyAccount semantics).
    const preferred = await lastHealthyAccountID(env);
    if (preferred !== "") {
      if ((await available(env, preferred)) && (await concurrencyAvailable(env, preferred))) {
        try {
          const acc = await ensureValid(env, preferred);
          if (acc && scheduleEnabled(acc)) return acc;
        } catch {
          /* fall through to round-robin */
        }
      }
    }
    const settings = await getSettings(env);
    const accounts = await listAccounts(env);
    const picked = await coordNextHealthy(
      env,
      accounts.map((a) => a.id),
      settings.accountConcurrencyLimit,
      ""
    );
    if (picked !== null && picked.id !== null) {
      const acc = accounts.find((a) => a.id === picked.id);
      if (acc) {
        if (!scheduleEnabled(acc)) throw new Error("no accounts enabled for scheduling");
        const validated = await ensureValid(env, acc.id);
        await rememberHealthy(env, validated.id);
        return validated;
      }
    }
    if (picked !== null && picked.id === null) {
      // Everything failed the pre-filter: mirror the upstream 429 flavours.
      if (picked.lastReason === "concurrency") {
        throw cooldown429(
          1,
          "all accounts are at their concurrency limit; try again shortly"
        );
      }
      throw cooldown429(
        Math.max(5, Math.ceil((await earliestRecoveryMs(env)) / 1000)),
        "all accounts are cooling down; try again later"
      );
    }
    // ---- no-DO fallback ----
    for (let i = 0; i < MAX_ACCOUNT_PROBE; i++) {
      const acc = await nextAccount(env);
      if (!acc) throw new Error("no accounts; login first");
      if (!(await available(env, acc.id))) continue;
      if (!(await concurrencyAvailable(env, acc.id))) continue;
      if (!scheduleEnabled(acc)) throw new Error("no accounts enabled for scheduling");
      const validated = await ensureValid(env, acc.id);
      await rememberHealthy(env, validated.id);
      return validated;
    }
    // All cooling down (upstream: Retry-After = EarliestRecovery, min 5s).
    const anyAcc = await nextAccount(env);
    if (!anyAcc) throw new Error("no accounts; login first");
    throw cooldown429(
      Math.max(5, Math.ceil((await earliestRecoveryMs(env)) / 1000)),
      "all accounts are cooling down; try again later"
    );
  }
  const acc = await ensureValid(env, requestedID);
  await rememberHealthy(env, acc.id);
  return acc;
}

// Port of Server.nextHealthyAccount: the next round-robin account that is
// still healthy, skipping the given id first, and validates its token.
export async function nextHealthyAccount(env: Env, avoidID: string): Promise<AccountToken | null> {
  const settings = await getSettings(env);
  const accounts = await listAccounts(env);
  const picked = await coordNextHealthy(
    env,
    accounts.map((a) => a.id),
    settings.accountConcurrencyLimit,
    avoidID
  );
  if (picked !== null) {
    if (picked.id === null) return null;
    const acc = accounts.find((a) => a.id === picked.id);
    if (!acc) return null;
    return ensureValid(env, acc.id);
  }
  for (let i = 0; i < MAX_ACCOUNT_PROBE; i++) {
    const acc = await nextAccount(env);
    if (!acc) return null;
    if (avoidID && acc.id === avoidID) continue;
    if (!(await available(env, acc.id))) continue;
    if (!(await concurrencyAvailable(env, acc.id))) continue;
    return ensureValid(env, acc.id);
  }
  return null;
}

export async function countAccounts(env: Env): Promise<number> {
  return (await listAccounts(env)).length;
}

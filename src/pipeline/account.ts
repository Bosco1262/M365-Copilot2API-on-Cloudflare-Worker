// Account health + selection (port of internal/web/account_health.go and
// resolveAccount / nextHealthyAccount from server.go). Health state lives in
// KV so cooldowns survive isolate eviction; writes only happen on failure or
// explicit clear paths.

import type { Env } from "../env";
import { getJSON, putJSON } from "../kv";
import { ensureValid, listAccounts, nextAccount, scheduleEnabled } from "../store/accounts";
import type { AccountToken } from "../types";

export const RATE_LIMIT_COOLDOWN_MS = 30_000;
const MAX_ACCOUNT_PROBE = 16;

interface HealthDoc {
  cooldown: Record<string, string>; // id -> expiry ISO
  authFail: Record<string, boolean>;
  limited: Record<string, boolean>;
  calls: Record<string, number>;
}

const KEY = "account-health";

async function load(env: Env): Promise<HealthDoc> {
  return (
    (await getJSON<HealthDoc>(env["m365-copilot2api_KV"], KEY)) ?? {
      cooldown: {},
      authFail: {},
      limited: {},
      calls: {},
    }
  );
}

function cleanupExpired(h: HealthDoc, id: string) {
  const until = h.cooldown[id];
  if (until && Date.now() >= Date.parse(until)) {
    const wasLimited = h.limited[id];
    delete h.cooldown[id];
    delete h.limited[id];
    delete h.authFail[id];
    if (wasLimited) delete h.calls[id];
  }
}

export async function available(env: Env, accountID: string): Promise<boolean> {
  const h = await load(env);
  cleanupExpired(h, accountID);
  if (h.authFail[accountID]) return false;
  const until = h.cooldown[accountID];
  if (until && Date.now() < Date.parse(until)) return false;
  return true;
}

export async function markFailure(env: Env, accountID: string, err: unknown): Promise<void> {
  const h = await load(env);
  if (isAuthFailureErr(err)) {
    h.cooldown[accountID] = new Date(Date.now() + Math.min(RATE_LIMIT_COOLDOWN_MS * 4, 120_000)).toISOString();
    h.authFail[accountID] = true;
    delete h.limited[accountID];
    await putJSON(env["m365-copilot2api_KV"], KEY, h);
    return;
  }
  if (isRateLimitedErr(err)) {
    h.limited[accountID] = true;
    let cd = RATE_LIMIT_COOLDOWN_MS;
    const ra = retryAfterOf(err);
    if (ra > 0) cd = Math.min(ra * 1000, 30 * 60_000);
    h.cooldown[accountID] = new Date(Date.now() + cd).toISOString();
    await putJSON(env["m365-copilot2api_KV"], KEY, h);
  }
}

export async function markSuccess(env: Env, accountID: string): Promise<void> {
  const h = await load(env);
  if (!h.cooldown[accountID] && !h.authFail[accountID] && !h.limited[accountID]) return;
  delete h.cooldown[accountID];
  delete h.authFail[accountID];
  delete h.limited[accountID];
  await putJSON(env["m365-copilot2api_KV"], KEY, h);
}

export async function clearAllCooldowns(env: Env): Promise<void> {
  await putJSON(env["m365-copilot2api_KV"], KEY, { cooldown: {}, authFail: {}, limited: {}, calls: {} });
}

export async function healthSnapshot(
  env: Env
): Promise<Record<string, Record<string, unknown>>> {
  const h = await load(env);
  const out: Record<string, Record<string, unknown>> = {};
  for (const [id, until] of Object.entries(h.cooldown)) {
    out[id] = { available: Date.now() > Date.parse(until), cooldownUntil: until };
  }
  for (const [id, failed] of Object.entries(h.authFail)) {
    if (failed) {
      out[id] ??= {};
      out[id]["authFailed"] = true;
    }
  }
  return out;
}

function isAuthFailureErr(err: unknown): boolean {
  const e = err as { name?: string; status?: number } | null;
  if (e && typeof e === "object") {
    return e.status === 401 || e.status === 403;
  }
  return false;
}
function isRateLimitedErr(err: unknown): boolean {
  const e = err as { name?: string; status?: number; __rateLimitNotice?: boolean } | null;
  if (e && typeof e === "object") {
    if ((e as Error).name === "RateLimitNotice") return true;
    if (e.status === 429 || e.status === 503) return true;
  }
  return false;
}
function retryAfterOf(err: unknown): number {
  const e = err as { retryAfter?: number } | null;
  return e?.retryAfter ?? 0;
}

export interface ResolvedAccount extends AccountToken {}

// Port of Server.resolveAccount: round-robin over enabled, healthy accounts.
export async function resolveAccount(env: Env, requestedID: string): Promise<AccountToken> {
  if (requestedID === "") {
    for (let i = 0; i < MAX_ACCOUNT_PROBE; i++) {
      const acc = await nextAccount(env);
      if (!acc) throw new Error("no accounts; login first");
      if (!(await available(env, acc.id))) continue;
      if (!scheduleEnabled(acc)) throw new Error("no accounts enabled for scheduling");
      return ensureValid(env, acc.id);
    }
    // All cooling down.
    const anyAcc = await nextAccount(env);
    if (!anyAcc) throw new Error("no accounts; login first");
    const err = new Error("all accounts are cooling down; try again later") as Error & {
      status: number;
      retryAfter: number;
      body: string;
    };
    err.status = 429;
    err.retryAfter = 5;
    err.body = "all accounts are cooling down; try again later";
    err.name = "UpstreamHTTPError";
    throw err;
  }
  return ensureValid(env, requestedID);
}

// Port of Server.nextHealthyAccount.
export async function nextHealthyAccount(env: Env, avoidID: string): Promise<AccountToken | null> {
  for (let i = 0; i < MAX_ACCOUNT_PROBE; i++) {
    const acc = await nextAccount(env);
    if (!acc) return null;
    if (avoidID && acc.id === avoidID) continue;
    if (!(await available(env, acc.id))) continue;
    return ensureValid(env, acc.id);
  }
  return null;
}

export async function countAccounts(env: Env): Promise<number> {
  return (await listAccounts(env)).length;
}

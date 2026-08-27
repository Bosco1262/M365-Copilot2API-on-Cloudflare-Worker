// Administrator credentials and sessions on KV
// (port of internal/web/admin_security.go; password stored as SHA-256 hex —
// strictly stronger than the upstream plaintext file while keeping the same
// console flows: bootstrap via ADMIN_PASSWORD, forced first-login change).

import type { Env } from "../env";
import { DEFAULT_ADMIN_PASSWORD } from "../env";
import { getJSON, putJSON } from "../kv";
import { sha256Hex } from "../util";

const PASSWORD_KEY = "admin-password-hash";
const SESSIONS_KEY = "admin-sessions";
export const ADMIN_COOKIE = "m365_admin_session";

const MAX_SESSIONS = 4096;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface AdminState {
  passwordHash: string;
  mustChange: boolean;
  sessions: Record<string, string>; // token -> expiry ISO
}

let cachedPasswordHash: { hash: string; mustChange: boolean; at: number } | null = null;

async function hashOf(v: string): Promise<string> {
  return sha256Hex(v);
}

export async function loadAdmin(env: Env): Promise<AdminState> {
  const stored = await env["m365-copilot2api_KV"].get(PASSWORD_KEY);
  let passwordHash: string;
  let mustChange: boolean;
  if (stored && stored.trim() !== "") {
    passwordHash = stored.trim();
    // A leftover persisted default-password must not defeat an explicit env secret.
    const envPassword = (env.ADMIN_PASSWORD ?? "").trim();
    if (passwordHash === (await hashOf(DEFAULT_ADMIN_PASSWORD)) && envPassword !== "") {
      passwordHash = await hashOf(envPassword);
      mustChange = envPassword === DEFAULT_ADMIN_PASSWORD;
      await env["m365-copilot2api_KV"].put(PASSWORD_KEY, passwordHash);
    } else {
      mustChange = passwordHash === (await hashOf(DEFAULT_ADMIN_PASSWORD));
    }
  } else if ((env.ADMIN_PASSWORD ?? "").trim() !== "") {
    const p = env.ADMIN_PASSWORD!.trim();
    passwordHash = await hashOf(p);
    mustChange = p === DEFAULT_ADMIN_PASSWORD;
    await env["m365-copilot2api_KV"].put(PASSWORD_KEY, passwordHash);
  } else {
    passwordHash = await hashOf(DEFAULT_ADMIN_PASSWORD);
    mustChange = true;
    await env["m365-copilot2api_KV"].put(PASSWORD_KEY, passwordHash);
  }
  cachedPasswordHash = { hash: passwordHash, mustChange, at: Date.now() };
  const sessions = (await getJSON<Record<string, string>>(env["m365-copilot2api_KV"], SESSIONS_KEY)) ?? {};
  return { passwordHash, mustChange, sessions };
}

function pruneSessions(sessions: Record<string, string>): Record<string, string> {
  const now = Date.now();
  const out: Record<string, string> = {};
  for (const [token, exp] of Object.entries(sessions)) {
    if (Date.parse(exp) > now) out[token] = exp;
  }
  return out;
}

export async function validAdminSession(env: Env, cookieValue: string | undefined): Promise<boolean> {
  if (!cookieValue) return false;
  const sessions = (await getJSON<Record<string, string>>(env["m365-copilot2api_KV"], SESSIONS_KEY)) ?? {};
  const exp = sessions[cookieValue];
  if (!exp || Date.now() > Date.parse(exp)) return false;
  return true;
}

export async function createAdminSession(env: Env): Promise<string> {
  const token = crypto.randomUUID().replace(/-/g, "");
  const sessions = pruneSessions(
    (await getJSON<Record<string, string>>(env["m365-copilot2api_KV"], SESSIONS_KEY)) ?? {}
  );
  let entries = Object.entries(sessions);
  if (entries.length >= MAX_SESSIONS) {
    entries.sort((a, b) => Date.parse(a[1]) - Date.parse(b[1]));
    entries = entries.slice(1); // evict oldest
  }
  entries.push([token, new Date(Date.now() + SESSION_TTL_MS).toISOString()]);
  const next: Record<string, string> = {};
  for (const [k, v] of entries) next[k] = v;
  await putJSON(env["m365-copilot2api_KV"], SESSIONS_KEY, next);
  return token;
}

export async function destroyAdminSession(env: Env, token?: string): Promise<void> {
  if (!token) return;
  const sessions = (await getJSON<Record<string, string>>(env["m365-copilot2api_KV"], SESSIONS_KEY)) ?? {};
  delete sessions[token];
  await putJSON(env["m365-copilot2api_KV"], SESSIONS_KEY, sessions);
}

export async function verifyAdminPassword(env: Env, password: string): Promise<{ ok: boolean; mustChange: boolean }> {
  const state = await loadAdmin(env);
  const candidate = await hashOf(password);
  return { ok: candidate === state.passwordHash, mustChange: state.mustChange };
}

export function validNewAdminPassword(p: string): string | null {
  if (p === DEFAULT_ADMIN_PASSWORD) return "新密码不能与默认密码相同";
  if (p.length < 6) return "新密码长度至少为 6 位";
  if (p.length > 256) return "新密码过长";
  return null;
}

export async function changeAdminPassword(env: Env, newPassword: string): Promise<void> {
  await env["m365-copilot2api_KV"].put(PASSWORD_KEY, await hashOf(newPassword));
  // invalidate all sessions like upstream does
  await putJSON(env["m365-copilot2api_KV"], SESSIONS_KEY, {});
  cachedPasswordHash = null;
}

export async function currentMustChange(env: Env): Promise<boolean> {
  const state = await loadAdmin(env);
  return state.mustChange;
}

export type AdminPasswordSource = "secret" | "kv";

// Where the EFFECTIVE admin password currently comes from:
//   secret – matches the deploy-time ADMIN_PASSWORD binding; changing the
//            password in the console overrides the secret going forward.
//   kv     – persisted hash from a console change (or the bootstrap default).
export async function adminPasswordSource(env: Env): Promise<AdminPasswordSource> {
  const stored = ((await env["m365-copilot2api_KV"].get(PASSWORD_KEY)) ?? "").trim();
  const envP = (env.ADMIN_PASSWORD ?? "").trim();
  if (envP === "") return "kv";
  if (stored === "") return "secret";
  return (stored === (await hashOf(envP))) ? "secret" : "kv";
}

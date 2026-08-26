// Content-key session resolver (port of internal/web/session_resolver.go).
//
// Sessions are keyed by ChatHub sessionId; resolution order mirrors upstream:
//   1. explicit id (X-M365-Session-Id) — highest priority, no identity checks
//   2. strict context-prefix match (same IP fingerprint, within context TTL),
//      longest prefix wins -> HistoryLen enables incremental sending
//   3. common-suffix fallback (min 2 messages) -> reuse
//   4. new session
// State persists in KV under "resolver-sessions".

import type { Env } from "../env";
import { getJSON, putJSON } from "../kv";
import { sha256Hex } from "../util";
import type { OaiMsg } from "./prompt";
import { contentToString } from "./prompt";

const KEY = "resolver-sessions";
export const DEFAULT_MAX_SESSIONS = 1000;
export const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_CONTEXT_TTL_MS = 2 * 60 * 60 * 1000;

export interface ResolverSession {
  sessionId: string;
  conversationId: string;
  accountId: string;
  createdAt: string;
  lastUsedAt: string;
  ipFingerprint?: string;
  userField?: string;
  contextFinger?: string;
  contextHistory?: OaiMsg[];
}

export interface ResolveResult {
  sessionId: string;
  conversationId: string;
  accountId: string;
  matchedBy: string;
  isNew: boolean;
  historyLen: number;
}

async function loadDoc(env: Env): Promise<ResolverSession[]> {
  return (await getJSON<ResolverSession[]>(env["m365-copilot2api_KV"], KEY)) ?? [];
}

async function saveDoc(env: Env, sessions: ResolverSession[]): Promise<void> {
  await putJSON(env["m365-copilot2api_KV"], KEY, sessions);
}

function evict(sessions: ResolverSession[], ttlMs: number, maxSessions: number): ResolverSession[] {
  const now = Date.now();
  let out = sessions.filter((s) => now - Date.parse(s.lastUsedAt) <= ttlMs);
  if (out.length > maxSessions) {
    out = [...out]
      .sort((a, b) => Date.parse(a.lastUsedAt) - Date.parse(b.lastUsedAt))
      .slice(out.length - maxSessions);
  }
  return out;
}

// Port of clientIPFingerprint; Workers expose the client IP via CF-Connecting-IP.
export async function clientIPFingerprint(ip: string, userAgent: string): Promise<string> {
  const hex = await sha256Hex(`${ip}|${userAgent}`);
  return hex.slice(0, 32);
}

// Port of contextFingerprint (diagnostic field only; matching uses history).
export async function contextFingerprint(messages: OaiMsg[]): Promise<string> {
  if (!messages || messages.length === 0) return "";
  const limit = Math.min(3, messages.length);
  const parts: string[] = [];
  for (let i = messages.length - limit; i < messages.length; i++) {
    const m = messages[i];
    parts.push(`${m.role}:${contentToString(m.content)}`);
  }
  const hex = await sha256Hex(parts.join("||"));
  return hex.slice(0, 32);
}

// Port of toolCallEqual: name + arguments compared, IDs ignored.
function toolCallEqual(x: Record<string, unknown>, y: Record<string, unknown>): boolean {
  const xFunc = x["function"] as Record<string, unknown> | undefined;
  const yFunc = y["function"] as Record<string, unknown> | undefined;
  if ((xFunc?.["name"] ?? "") !== (yFunc?.["name"] ?? "")) return false;
  return (xFunc?.["arguments"] ?? "") === (yFunc?.["arguments"] ?? "");
}

// Port of messagesEqual.
export function messagesEqual(a: OaiMsg, b: OaiMsg): boolean {
  if ((a.role ?? "") !== (b.role ?? "")) return false;
  if (contentToString(a.content) !== contentToString(b.content)) return false;
  const aCalls = a.tool_calls ?? [];
  const bCalls = b.tool_calls ?? [];
  if (aCalls.length !== bCalls.length) return false;
  for (let i = 0; i < aCalls.length; i++) {
    if (!toolCallEqual(aCalls[i], bCalls[i])) return false;
  }
  return true;
}

// Port of contextPrefixLen: len(hist) when hist is a strict prefix of msgs.
export function contextPrefixLen(hist: OaiMsg[], msgs: OaiMsg[]): number {
  if (!hist || hist.length === 0 || msgs.length < hist.length) return 0;
  for (let i = 0; i < hist.length; i++) {
    if (!messagesEqual(hist[i], msgs[i])) return 0;
  }
  return hist.length;
}

// Port of suffixMatchLen.
export function suffixMatchLen(hist: OaiMsg[], msgs: OaiMsg[]): number {
  const maxN = Math.min(hist.length, msgs.length);
  let n = 0;
  for (let i = 1; i <= maxN; i++) {
    if (messagesEqual(hist[hist.length - i], msgs[msgs.length - i])) n = i;
    else break;
  }
  return n;
}

function cloneMessages(msgs: OaiMsg[]): OaiMsg[] {
  const trimmed = msgs.length > 512 ? msgs.slice(msgs.length - 512) : msgs;
  return trimmed.map((m) => ({ ...m }));
}

interface ResolveParams {
  explicitId?: string;
  ipFingerprint?: string;
  messages: OaiMsg[];
  ttlMs?: number;
  contextTtlMs?: number;
  maxSessions?: number;
}

// Port of sessionResolver.Resolve.
export async function resolveSession(env: Env, params: ResolveParams): Promise<ResolveResult> {
  const ttlMs = params.ttlMs ?? DEFAULT_TTL_MS;
  const contextTtlMs = params.contextTtlMs ?? DEFAULT_CONTEXT_TTL_MS;
  const maxSessions = params.maxSessions ?? DEFAULT_MAX_SESSIONS;
  let sessions = evict(await loadDoc(env), ttlMs, maxSessions);

  const touch = async (sess: ResolverSession): Promise<ResolveResult> => {
    sess.lastUsedAt = new Date().toISOString();
    await saveDoc(env, sessions);
    return {
      sessionId: sess.sessionId,
      conversationId: sess.conversationId,
      accountId: sess.accountId,
      matchedBy: "",
      isNew: false,
      historyLen: sess.contextHistory?.length ?? 0,
    };
  };

  // 1. explicit id — highest priority continuation semantics.
  const explicitID = (params.explicitId ?? "").trim();
  if (explicitID !== "") {
    const hit =
      sessions.find((s) => s.sessionId === explicitID) ??
      sessions.find((s) => s.sessionId === explicitID);
    if (hit) {
      const r = await touch(hit);
      r.matchedBy = "explicit";
      return r;
    }
  }

  const messages = params.messages ?? [];
  const finger = params.ipFingerprint ?? "";

  // 2. strict context-prefix match, longest wins.
  if (messages.length > 0) {
    let best: { s: ResolverSession; n: number } | null = null;
    for (const sess of sessions) {
      if (Date.now() - Date.parse(sess.lastUsedAt) > contextTtlMs) continue;
      if (!finger || !sess.ipFingerprint || sess.ipFingerprint !== finger) continue;
      const n = contextPrefixLen(sess.contextHistory ?? [], messages);
      if (
        n >= 1 &&
        (!best || n > best.n || (n === best.n && Date.parse(sess.lastUsedAt) > Date.parse(best.s.lastUsedAt)))
      ) {
        best = { s: sess, n };
      }
    }
    if (best) {
      const r = await touch(best.s);
      r.matchedBy = `context_prefix_${best.n}`;
      r.historyLen = best.n;
      return r;
    }

    // 3. common-suffix fallback (min 2 messages).
    if (messages.length >= 2) {
      let bestSuffix: { s: ResolverSession; n: number } | null = null;
      for (const sess of sessions) {
        if (Date.now() - Date.parse(sess.lastUsedAt) > contextTtlMs) continue;
        if (!finger || !sess.ipFingerprint || sess.ipFingerprint !== finger) continue;
        const hist = sess.contextHistory ?? [];
        if (hist.length < 2) continue;
        const n = suffixMatchLen(hist, messages);
        if (
          n >= 2 &&
          (!bestSuffix ||
            n > bestSuffix.n ||
            (n === bestSuffix.n && Date.parse(sess.lastUsedAt) > Date.parse(bestSuffix.s.lastUsedAt)))
        ) {
          bestSuffix = { s: sess, n };
        }
      }
      if (bestSuffix) {
        const r = await touch(bestSuffix.s);
        r.matchedBy = `context_suffix_${bestSuffix.n}`;
        r.historyLen = bestSuffix.n;
        return r;
      }
    }
  }

  return { sessionId: "", conversationId: "", accountId: "", matchedBy: "", isNew: true, historyLen: 0 };
}

interface BindParams {
  sessionId: string;
  conversationId: string;
  accountId: string;
  messages: OaiMsg[];
  assistantText?: string;
  userField?: string;
  ipFingerprint?: string;
  ttlMs?: number;
  maxSessions?: number;
}

// Port of sessionResolver.Bind.
export async function bindSession(env: Env, params: BindParams): Promise<void> {
  const ttlMs = params.ttlMs ?? DEFAULT_TTL_MS;
  const maxSessions = params.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const sessions = evict(await loadDoc(env), ttlMs, maxSessions);
  const now = new Date().toISOString();

  let sessionId = params.sessionId;
  const history = cloneMessages(params.messages ?? []);
  if ((params.assistantText ?? "").trim() !== "") {
    history.push({ role: "assistant", content: params.assistantText });
  }
  const finger = await contextFingerprint(history);

  const applyTo = (sess: ResolverSession): void => {
    sess.conversationId = params.conversationId;
    sess.accountId = params.accountId;
    sess.lastUsedAt = now;
    sess.userField = params.userField ?? sess.userField;
    sess.ipFingerprint = params.ipFingerprint ?? sess.ipFingerprint;
    sess.contextFinger = finger;
    sess.contextHistory = history;
  };

  if (sessionId !== "") {
    const existing = sessions.find((s) => s.sessionId === sessionId);
    if (existing) {
      applyTo(existing);
      await saveDoc(env, sessions);
      return;
    }
  } else {
    const byConv = sessions.find((s) => s.conversationId === params.conversationId);
    if (byConv) {
      applyTo(byConv);
      await saveDoc(env, sessions);
      return;
    }
    sessionId = crypto.randomUUID();
  }

  const sess: ResolverSession = {
    sessionId,
    conversationId: params.conversationId,
    accountId: params.accountId,
    createdAt: now,
    lastUsedAt: now,
    ipFingerprint: params.ipFingerprint,
    userField: params.userField,
    contextFinger: finger,
    contextHistory: history,
  };
  sessions.push(sess);
  await saveDoc(env, sessions);
}

// Port of UnbindByConversation: drop every session bound to a deleted cloud
// conversation so the resolver never reuses dead conversations.
export async function unbindByConversation(env: Env, conversationId: string): Promise<number> {
  const sessions = await loadDoc(env);
  const kept = sessions.filter((s) => s.conversationId !== conversationId);
  const removed = sessions.length - kept.length;
  if (removed > 0) await saveDoc(env, kept);
  return removed;
}

export async function listResolverSessions(env: Env): Promise<ResolverSession[]> {
  const sessions = await loadDoc(env);
  return [...sessions].sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt));
}

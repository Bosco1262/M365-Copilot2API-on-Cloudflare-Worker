// Context budget sliding window (port of internal/web/context_budget.go).
//
// Budget B = ContextWindow - MaxOutputTokens - 512; messages over the budget
// are pruned atom-wise: pinned SYSTEM blocks, the first USER anchor and the
// trailing TOOL chain survive, then the remaining budget fills from the tail.
// Token estimation uses the gateway's heuristic counter (upstream falls back
// to the same heuristic when the GPT tokenizer is unavailable).

import type { OaiMsg } from "./prompt";
import type { Attachment } from "../chathub/protocol";
import { estimateTokens } from "../util";

export const REQUEST_PROTOCOL_TOKENS = 4;
export const MESSAGE_PROTOCOL_TOKENS = 4;
export const REPLY_PRIMING_TOKENS = 3;

type AtomKind = "SYSTEM" | "USER" | "ATOM_TOOL" | "ASSIST" | "ANCHOR";

interface ContextAtom {
  kind: AtomKind;
  msgs: OaiMsg[];
  tokens: number;
  start: number;
  end: number;
}

function msgText(m: OaiMsg): string {
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    let s = "";
    for (const part of c) {
      if (part && typeof part === "object") {
        const p = part as Record<string, unknown>;
        if (typeof p["text"] === "string") s += p["text"] as string;
      }
    }
    return s;
  }
  return "";
}

function estimateMessageTokens(m: OaiMsg): number {
  let tokens = MESSAGE_PROTOCOL_TOKENS;
  tokens += estimateTokens(m.role ?? "");
  tokens += estimateTokens(m.name ?? "");
  tokens += estimateTokens(m.tool_call_id ?? "");
  tokens += estimateTokens(msgText(m));
  if (Array.isArray(m.tool_calls)) {
    for (const call of m.tool_calls) tokens += estimateTokens(JSON.stringify(call));
  }
  return Math.max(1, tokens);
}

// buildAtoms groups consecutive same-kind messages: system/developer runs,
// assistant+tool_calls followed by tool results, tool runs, single user /
// assistant turns. The first user turn becomes the ANCHOR (kept as pinned
// context alongside the system block).
export function buildAtoms(messages: OaiMsg[]): ContextAtom[] {
  if (messages.length === 0) return [];
  const atoms: ContextAtom[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    const role = (m.role ?? "").trim().toLowerCase();
    if (role === "system" || role === "developer") {
      const start = i;
      const msgs: OaiMsg[] = [];
      let total = 0;
      while (i < messages.length) {
        const r = (messages[i].role ?? "").trim().toLowerCase();
        if (r !== "system" && r !== "developer") break;
        msgs.push(messages[i]);
        total += estimateMessageTokens(messages[i]);
        i++;
      }
      atoms.push({ kind: "SYSTEM", msgs, tokens: total, start, end: i });
      continue;
    }
    if (role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const start = i;
      const msgs: OaiMsg[] = [m];
      let total = estimateMessageTokens(m);
      i++;
      while (i < messages.length && (messages[i].role ?? "").trim().toLowerCase() === "tool") {
        msgs.push(messages[i]);
        total += estimateMessageTokens(messages[i]);
        i++;
      }
      atoms.push({ kind: "ATOM_TOOL", msgs, tokens: total, start, end: i });
      continue;
    }
    if (role === "tool") {
      const start = i;
      const msgs: OaiMsg[] = [];
      let total = 0;
      while (i < messages.length && (messages[i].role ?? "").trim().toLowerCase() === "tool") {
        msgs.push(messages[i]);
        total += estimateMessageTokens(messages[i]);
        i++;
      }
      atoms.push({ kind: "ATOM_TOOL", msgs, tokens: total, start, end: i });
      continue;
    }
    if (role === "user") {
      atoms.push({ kind: "USER", msgs: [m], tokens: estimateMessageTokens(m), start: i, end: i + 1 });
      i++;
      continue;
    }
    // assistant (or unknown) turn.
    atoms.push({ kind: "ASSIST", msgs: [m], tokens: estimateMessageTokens(m), start: i, end: i + 1 });
    i++;
  }
  for (const a of atoms) {
    if (a.kind === "USER") {
      a.kind = "ANCHOR";
      break;
    }
  }
  return atoms;
}

// slidingWindow prunes messages over budget. Returns { messages, truncated }
// or throws an Error whose message is the upstream context_length_exceeded
// text when the pinned context itself exceeds the budget.
export function slidingWindow(
  messages: OaiMsg[],
  budget: number
): { messages: OaiMsg[]; truncated: boolean } {
  if (budget <= 0) budget = 1024;
  const atoms = buildAtoms(messages);
  if (atoms.length === 0) return { messages, truncated: false };
  let total = 0;
  for (const a of atoms) total += a.tokens;
  total += REQUEST_PROTOCOL_TOKENS + REPLY_PRIMING_TOKENS;
  if (total <= budget) return { messages, truncated: false };

  const p0Indices: number[] = [];
  let anchorIdx = -1;
  for (let idx = 0; idx < atoms.length; idx++) {
    if (atoms[idx].kind === "SYSTEM") p0Indices.push(idx);
    if (atoms[idx].kind === "ANCHOR" && anchorIdx === -1) anchorIdx = idx;
  }
  // Trailing tool chain: consecutive ATOM_TOOL atoms from the end.
  const p1Indices: number[] = [];
  for (let idx = atoms.length - 1; idx >= 0; idx--) {
    if (atoms[idx].kind === "ATOM_TOOL") p1Indices.unshift(idx);
    else break;
  }

  let sumP0P1 = REQUEST_PROTOCOL_TOKENS + REPLY_PRIMING_TOKENS;
  for (const idx of p0Indices) sumP0P1 += atoms[idx].tokens;
  for (const idx of p1Indices) sumP0P1 += atoms[idx].tokens;
  if (anchorIdx !== -1) sumP0P1 += atoms[anchorIdx].tokens;
  if (sumP0P1 > budget) {
    throw new Error(
      `context_length_exceeded: pinned context (system+current task+anchor) ${sumP0P1} tokens exceed budget ${budget}; reduce tool results or start a new session`
    );
  }
  let remaining = budget - sumP0P1;
  const selected = new Set<number>();
  for (const idx of p0Indices) selected.add(idx);
  for (const idx of p1Indices) selected.add(idx);
  if (anchorIdx !== -1) selected.add(anchorIdx);
  for (let idx = atoms.length - 1; idx >= 0; idx--) {
    if (selected.has(idx)) continue;
    const tok = atoms[idx].tokens;
    if (tok <= remaining) {
      selected.add(idx);
      remaining -= tok;
    }
  }
  const out: OaiMsg[] = [];
  for (let idx = 0; idx < atoms.length; idx++) {
    if (selected.has(idx)) out.push(...atoms[idx].msgs);
  }
  let truncated = selected.size < atoms.length;
  if (out.length === 0 && atoms.length > 0) {
    out.push(...atoms[atoms.length - 1].msgs);
    truncated = true;
  }
  return { messages: out, truncated };
}

// flattenPromptMessagesWithBudget ports the upstream helper used by the
// OpenAI chat path: prune, then flatten with attachments.
export async function flattenPromptMessagesWithBudget(
  messages: OaiMsg[],
  budget: number
): Promise<{ prompt: string; attachments: Attachment[]; truncated: boolean; messages: OaiMsg[] }> {
  const { messages: kept, truncated } = slidingWindow(messages, budget);
  const { flattenPromptMessages } = await import("./prompt");
  const flat = await flattenPromptMessages(kept);
  return { prompt: flat.prompt, attachments: flat.attachments, truncated, messages: kept };
}

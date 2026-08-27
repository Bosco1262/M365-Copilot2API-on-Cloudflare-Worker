// Agent evidence ledger (port of internal/web/agent_ledger.go).
//
// Pure functions only: the ledger is rebuilt from the request messages on
// every call — there is no server-side state. It gives the model (and the
// gateway) a factual view of which tool calls completed, which are pending,
// and which signatures repeat or fail, so loops stop and unverified claims
// cannot masquerade as results.

import type { OaiMsg } from "./prompt";

export interface LedgerCompleted {
  name: string;
  args: string;
  result: string;
  failed: boolean;
}

export interface LedgerPending {
  name: string;
  args: string;
}

export interface LedgerRepeated {
  name: string;
  args: string;
  count: number;
  status: "" | "RepeatedCall" | "StuckLoop";
  failures: number;
  failureStatus: "" | "RepeatedFailure" | "StuckLoop";
}

export interface EvidenceLedger {
  completed: LedgerCompleted[];
  pending: LedgerPending[];
  repeated: LedgerRepeated[];
  /** Assistant turns that requested tool calls. */
  rounds: number;
}

export interface ContinueCheck {
  ok: boolean;
  reason: string;
}

const RESULT_LIMIT = 4000;
// Ceiling for the serialized EVIDENCE_LEDGER block injected into router
// prompts (chars). Keeps route prompts from growing without bound on long
// agent sessions.
const LEDGER_CONTEXT_BUDGET = 16_000;
const FAILURE_RE =
  /(exit\s*(code|status)?\s*[:=]?\s*[1-9]\d*|\berror\b|\bfailure\b|exception|traceback|timed?\s*out|permission denied|not found|refused)/i;

// Head limit/3 + tail limit-head-80 keeps the compacted result within the
// limit including an <=80 char truncation marker.
export function compactResult(text: string, limit: number = RESULT_LIMIT): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit / 3);
  const tail = limit - head - 80;
  const missing = text.length - head - tail;
  return `${text.slice(0, head)}\n...[truncated ${missing} chars]...\n${text.slice(text.length - tail)}`;
}

// Recursively sort object keys so signature equality matches the upstream
// Go behaviour (maps re-marshal with sorted keys).
function sortedJSON(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortedJSON);
  if (v && typeof v === "object") {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortedJSON(src[k]);
    return out;
  }
  return v;
}

// Trimmed + valid-JSON re-serialized (invalid payloads stay trimmed raw).
function canonicalArgs(args: unknown): string {
  const raw = typeof args === "string" ? args : JSON.stringify(args ?? {});
  const t = raw.trim();
  try {
    return JSON.stringify(sortedJSON(JSON.parse(t)));
  } catch {
    return t;
  }
}

// Failure-signature normalization: lowercase, digits -> #, truncate 500.
function normalizeFailureResult(result: string): string {
  return result.toLowerCase().replace(/\d/g, "#").slice(0, 500);
}

function toolContentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    let b = "";
    for (const part of content) {
      if (part && typeof part === "object") {
        const t = (part as Record<string, unknown>)["text"];
        if (typeof t === "string") b += t;
      } else if (typeof part === "string") {
        b += part;
      }
    }
    return b;
  }
  return String(content);
}

interface Rec {
  id: string;
  name: string;
  args: string;
  result: string;
  failed: boolean;
  filled: boolean;
}

// Port of BuildAgentLedger: walk the conversation once, collecting assistant
// tool_calls and backfilling results from role=tool messages via tool_call_id.
export function buildAgentLedger(messages: OaiMsg[]): EvidenceLedger {
  const byId = new Map<string, Rec>();
  const ordered: Rec[] = [];
  let rounds = 0;

  for (const m of messages ?? []) {
    const role = (m.role ?? "").trim().toLowerCase();
    if (role === "assistant") {
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      if (calls.length > 0) rounds++;
      for (const tc of calls) {
        if (!tc || typeof tc !== "object") continue;
        const t = tc as Record<string, unknown>;
        const fn = (t["function"] ?? {}) as Record<string, unknown>;
        const id = typeof t["id"] === "string" ? t["id"] : "";
        const name = typeof fn["name"] === "string" ? fn["name"] : "";
        if (id === "" || name === "") continue;
        if (byId.has(id)) continue;
        const rec: Rec = {
          id,
          name,
          args: canonicalArgs(fn["arguments"]),
          result: "",
          failed: false,
          filled: false,
        };
        byId.set(id, rec);
        ordered.push(rec);
      }
    } else if (role === "tool") {
      const id = typeof m.tool_call_id === "string" ? m.tool_call_id : "";
      const rec = id !== "" ? byId.get(id) : undefined;
      if (!rec || rec.filled) continue;
      rec.result = compactResult(toolContentToString(m.content).trim());
      rec.failed = FAILURE_RE.test(rec.result);
      rec.filled = true;
    }
  }

  // Signature counting over every recorded call (filled or not).
  const callCounts = new Map<string, number>();
  const failCounts = new Map<string, number>();
  const failMeta = new Map<string, { args: string; failures: number }>();
  for (const rec of ordered) {
    const sig = rec.name + "\u0000" + rec.args;
    callCounts.set(sig, (callCounts.get(sig) ?? 0) + 1);
    if (rec.failed) {
      const fsig = sig + "\u0000" + normalizeFailureResult(rec.result);
      const n = (failCounts.get(fsig) ?? 0) + 1;
      failCounts.set(fsig, n);
      const meta = failMeta.get(sig);
      failMeta.set(sig, { args: rec.args, failures: Math.max(meta?.failures ?? 0, n) });
    }
  }

  const completed: LedgerCompleted[] = [];
  const pending: LedgerPending[] = [];
  for (const rec of ordered) {
    if (rec.filled) {
      completed.push({ name: rec.name, args: rec.args, result: rec.result, failed: rec.failed });
    } else {
      pending.push({ name: rec.name, args: rec.args });
    }
  }

  const repeated: LedgerRepeated[] = [];
  for (const [sig, count] of callCounts) {
    const [name] = sig.split("\u0000");
    const failures = failMeta.get(sig)?.failures ?? 0;
    const status = count >= 3 ? "StuckLoop" : count >= 2 ? "RepeatedCall" : "";
    const failureStatus =
      failures >= 3 ? "StuckLoop" : failures >= 2 ? "RepeatedFailure" : "";
    if (status === "" && failureStatus === "") continue;
    repeated.push({ name, args: sig.slice(name.length + 1), count, status, failures, failureStatus });
  }

  return { completed, pending, repeated, rounds };
}

// Port of CanContinue: reports, in order, why another tool round must not
// start (rounds exceeded / StuckLoop / RepeatedFailure / pending unfilled).
export function ledgerCanContinue(l: EvidenceLedger, maxRounds: number): ContinueCheck {
  if (maxRounds > 0 && l.rounds >= maxRounds) {
    return {
      ok: false,
      reason: `tool round limit reached: ${l.rounds} of ${maxRounds} allowed rounds used`,
    };
  }
  const stuck = l.repeated.find((r) => r.status === "StuckLoop" || r.failureStatus === "StuckLoop");
  if (stuck) {
    return {
      ok: false,
      reason: `stuck loop: tool "${stuck.name}" repeated with identical arguments ${Math.max(
        stuck.status === "StuckLoop" ? stuck.count : 0,
        stuck.failureStatus === "StuckLoop" ? stuck.failures : 0
      )} times`,
    };
  }
  const repFail = l.repeated.find((r) => r.failureStatus === "RepeatedFailure");
  if (repFail) {
    return {
      ok: false,
      reason: `repeated failure: tool "${repFail.name}" failed ${repFail.failures} times with the same error`,
    };
  }
  if (l.pending.length > 0) {
    return {
      ok: false,
      reason: `${l.pending.length} pending tool call(s) without a recorded result`,
    };
  }
  return { ok: true, reason: "" };
}

// Port of RouterContext: prompt injection describing the evidence rules plus
// the serialized ledger. Empty when the conversation carries no tool history.
// The serialized ledger is capped (oldest completed entries dropped first) so
// long agent sessions cannot inflate the router prompt enough to stall the
// upstream chat call.
export function ledgerRouterContext(l: EvidenceLedger): string {
  if (l.completed.length === 0 && l.pending.length === 0 && l.repeated.length === 0) return "";
  const render = (completed: LedgerCompleted[]): string =>
    JSON.stringify({
      completed: completed.map((c) => ({
        name: c.name,
        args: c.args,
        result: c.result,
        failed: c.failed,
      })),
      pending: l.pending,
      repeated: l.repeated,
    });
  let completed = l.completed;
  let ledgerJson = render(completed);
  while (ledgerJson.length > LEDGER_CONTEXT_BUDGET && completed.length > 1) {
    // Drop the oldest half of completed entries and retry.
    completed = completed.slice(Math.ceil(completed.length / 2));
    ledgerJson = render(completed);
  }
  if (ledgerJson.length > LEDGER_CONTEXT_BUDGET) {
    ledgerJson = ledgerJson.slice(0, LEDGER_CONTEXT_BUDGET) + "...[ledger truncated]";
  }
  return [
    "A completed call is final evidence: its result is already recorded and delivered — never re-invoke it; only start a new call for fresh unfinished work.",
    "",
    `EVIDENCE_LEDGER: ${ledgerJson}`,
    "",
    "FINAL ANSWER RULE: if the ledger shows the user's request is already satisfied, or cannot make further progress, respond with the final answer to the user instead of calling more tools.",
  ].join("\n");
}

// Verbs that claim an executed outcome (used when no tool evidence exists).
const SUCCESS_VERBS = [
  "installed",
  "uninstalled",
  "completed",
  "succeeded",
  "executed",
  "deployed",
  "restarted",
  "fixed",
  "deleted",
  "removed",
];

const UNVERIFIED_PHRASES = [
  "cannot confirm",
  "can't confirm",
  "cannot verify",
  "can't verify",
  "could not confirm",
  "couldn't confirm",
  "not verified",
  "unable to confirm",
  "unable to verify",
];

// Port of completionEvidenceAllows: decides whether an answer is backed by the
// recorded evidence.
export function completionEvidenceAllows(answer: string, l: EvidenceLedger): boolean {
  if (l.pending.length > 0) return false;
  const low = answer.toLowerCase();
  if (l.completed.length === 0 && SUCCESS_VERBS.some((v) => low.includes(v))) return false;
  if (l.completed.length > 0 && UNVERIFIED_PHRASES.some((p) => low.includes(p))) return false;
  return true;
}

// Fixed body replacement when the final answer contradicts the evidence.
export const COMPLETION_DISCLAIMER =
  "The requested work could not be verified against the recorded tool execution evidence, so no result is reported here. Please retry the request or inspect the tool outputs before acting on any claimed outcome.";

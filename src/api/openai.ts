// OpenAI-compatible endpoints: /v1/models and /v1/chat/completions
// (port of openaiModels / openaiChat from server.go).
//
// Phase 2: content-key session reuse + cache stats.
// Phase 3: multimodal image input, function-calling conversion
//          (router planning, fenced/native detection, streamed tool_calls).

import type { HandlerCtx } from "../router";
import {
  jsonOut,
  writeOpenAIError,
  estimateTokens,
  uuid,
  extractOIDTID,
  nowIso,
} from "../util";
import { getSettings, type RuntimeSettings } from "../store/settings";
import { modelCatalog, reasoningTone } from "../pipeline/catalog";
import {
  flattenPromptMessages,
  normalizeJSONText,
  contentToString,
  type OaiMsg,
} from "../pipeline/prompt";
import {
  resolveAccount,
  nextHealthyAccount,
  markFailure,
  markSuccess,
  markImageLimited,
} from "../pipeline/account";
import {
  resolveSession,
  bindSession,
  listResolverSessions,
  clientIPFingerprint,
} from "../pipeline/resolver";
import { recordCacheRequest } from "../store/cacheStats";
import { chat as chathubChat, type ChatHandlers } from "../chathub/client";
import {
  type Attachment,
  type Tool,
  type ContextMessage,
  imageLimitText as imageLimitNotice,
} from "../chathub/protocol";
import {
  adaptiveToolCallLimit,
  allowedToolNames,
  buildToolResponse,
  fencedToolCalls,
  isContentPolicyBlock,
  isSandboxHallucination,
  isToolRefusal,
  limitToolCalls,
  modelToolRouterPrompt,
  nativeToolCalls,
  parseModelToolDecision,
  validateDetectedToolCalls,
  type DetectedToolCall,
} from "../pipeline/tools";
import {
  buildAgentLedger,
  COMPLETION_DISCLAIMER,
  completionEvidenceAllows,
  ledgerCanContinue,
  ledgerRouterContext,
} from "../pipeline/ledger";
import {
  describeUpstream,
  isAuthFailure,
  isRateLimited,
  isImageLimited,
  isEmptyCompletion,
} from "../errors";
import { coordAcquireAccount, coordReleaseAccount } from "../do/coordination";
import { sseHeaders } from "./sse";
import { createTextHoldback } from "./holdback";
import {
  getSessionBinding,
  upsertSessionBinding,
  recordConversation,
} from "../store/conversations";
import { recordUsage } from "../store/usage";
import { validAPIKey, extractAPIKeyPrefix } from "./auth";
import type { AccountToken } from "../types";

export const DEFAULT_MODEL = "m365-copilot";

export interface OaiReqBody {
  model?: string;
  response_format?: { type?: string; json_schema?: Record<string, unknown> };
  messages?: OaiMsg[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  user?: string;
  accountId?: string;
  account_id?: string;
  conversation_id?: string;
  conversationId?: string;
  session_id?: string;
  sessionId?: string;
  session_key?: string;
  sessionKey?: string;
  max_completion_tokens?: number;
  reasoning_effort?: string;
  reasoning?: { effort?: string };
  tools?: { type?: string; function?: Record<string, unknown> }[];
  functions?: unknown[];
  tool_choice?: unknown;
  function_call?: unknown;
  parallel_tool_calls?: boolean;
  stop?: string[];
  // CopilotTempSession: one-shot request — no cloud conversation reuse (C17).
  metadata?: { copilot_temp_session?: boolean };
}

function pickStr(...vals: (string | undefined)[]): string {
  for (const v of vals) if (v && v.trim() !== "") return v.trim();
  return "";
}

// True when the request transcript carries function-calling rows (assistant
// tool_calls or tool results). Gateway-derived conversation reuse (convCache /
// resolver / user binding) is disabled for these requests: sending only the
// incremental tail — which is then just tool metadata — to the existing cloud
// conversation regularly stalls M365 into empty/stalled completions, which
// clients observe as errors/timeouts right after the first tool round.
function hasToolHistory(messages: OaiMsg[]): boolean {
  return messages.some((m) => {
    const role = (m.role ?? "").trim().toLowerCase();
    return role === "tool" || (Array.isArray(m.tool_calls) && m.tool_calls.length > 0);
  });
}

function normalizeTools(body: OaiReqBody): { maps: Record<string, unknown>[]; choice: unknown } {
  const maps: Record<string, unknown>[] = [];
  for (const t of body.tools ?? []) {
    if (t && typeof t === "object") maps.push({ type: t.type ?? "function", function: t.function ?? {} });
  }
  if (maps.length === 0 && Array.isArray(body.functions)) {
    for (const f of body.functions) {
      if (f && typeof f === "object") maps.push({ type: "function", function: f });
    }
  }
  let choice = body.tool_choice;
  if (choice == null && body.function_call != null) choice = body.function_call;
  if (choice == null && maps.length > 0) choice = "auto";
  return { maps, choice };
}

// Answer-turn tool protocol injection. chatPayload's toolProtocolPrompt only
// emits the <tools> fenced block when plugins.length === 0, but
// buildChatPlugins always emits at least one plugin (BingWebSearch when no
// tools, one API plugin per declared tool), so the protocol path never
// reaches the model. Appending here guarantees both streaming and
// non-streaming answer turns advertise the caller's tools and steer the model
// away from its own cloud sandbox (/mnt/data).
function injectToolProtocol(text: string, toolMaps: Record<string, unknown>[]): string {
  const defs: string[] = [];
  for (const t of toolMaps) {
    const f = (t["function"] ?? t) as Record<string, unknown>;
    const name = typeof f["name"] === "string" ? f["name"] : "";
    if (name === "") continue;
    const desc = typeof f["description"] === "string" ? f["description"] : "";
    let params = f["parameters"] == null ? "{}" : JSON.stringify(f["parameters"]).trim();
    if (params === "" || params === "null") params = "{}";
    defs.push(`${name} — ${desc}\n\`\`\`${name}\n${params}\n\`\`\``);
  }
  if (defs.length === 0) return text;
  return (
    text +
    "\n\n# Tool calling\n" +
    "You are an execution agent on the caller's Windows machine. The tools below are real, active, and callable right now. The bash tool runs Windows PowerShell 5.1; Windows paths like C:\\ and D:\\ are directly accessible.\n" +
    "Do NOT use any built-in code interpreter, Python sandbox, or cloud execution environment. Do NOT emit python/code fenced blocks for execution — if you need to run code, use the bash tool. Do NOT mention Linux containers, /mnt/data, cloud sandboxes, or claim the execution environment has changed. Do NOT say a tool is unavailable — they are all available.\n" +
    "Available tools:\n<tools>\n" +
    defs.join("\n\n") +
    "\n</tools>\n" +
    "When the user's request requires a tool, call it by emitting one or more fenced blocks. Each block's info string is the exact tool name and its body is a JSON object of arguments. For independent operations, emit multiple blocks in one response. Do not wrap the call in XML or Markdown prose. Wait for the tool result before claiming completion."
  );
}

// Port of validateToolConversation (toolloop.go validateToolResult): tool
// messages must carry a tool_call_id, and once the transcript declares
// assistant tool_calls any later tool id must be one of them (A3).
export function validateToolConversation(messages: OaiMsg[]): string | null {
  const known = new Set<string>();
  for (const m of messages) {
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      for (const tc of m.tool_calls) {
        if (tc && typeof tc === "object") {
          const id = (tc as Record<string, unknown>)["id"];
          if (typeof id === "string" && id !== "") known.add(id);
        }
      }
    }
    if ((m.role ?? "").trim().toLowerCase() === "tool") {
      const id = (m.tool_call_id ?? "").trim();
      if (id === "") return "tool_call_id required";
      if (known.size > 0 && !known.has(id)) return `unknown tool_call_id: ${id}`;
    }
  }
  return null;
}

// Port of parseLocaleFromHeaders (server.go 2900-2940): locale/market/tz/
// deviceOS are resolved from request headers with en-us/UTC/Windows defaults.
export interface ChathubLocale {
  locale: string;
  market: string;
  timeZone: string;
  timeZoneOffset: number;
  deviceOS: string;
}

export function parseLocaleFromHeaders(ctx: HandlerCtx): ChathubLocale {
  const h = ctx.req.headers;
  let locale = (h.get("X-M365-Locale") ?? "").trim();
  if (locale === "") {
    const al = h.get("Accept-Language") ?? "";
    const cleaned = al.split(";")[0].split(",")[0].trim();
    locale = cleaned === "" ? "en-us" : cleaned.toLowerCase();
  } else {
    locale = locale.toLowerCase();
  }
  let market = (h.get("X-M365-Market") ?? "").trim();
  if (market === "") market = "en-us";
  else market = market.toLowerCase();
  let timeZone = (h.get("X-M365-TimeZone") ?? "").trim();
  let timeZoneOffset = 0;
  if (timeZone === "") {
    timeZone = "UTC";
  } else {
    try {
      const now = new Date();
      const fmt = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" });
      const parts = fmt.formatToParts(now);
      const off = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
      const m = /GMT([+-]\d{1,2})/.exec(off);
      if (m) timeZoneOffset = Number(m[1]);
    } catch {
      timeZoneOffset = 0;
    }
  }
  const deviceOS = (h.get("X-M365-DeviceOS") ?? "").trim() || "Windows";
  return { locale, market, timeZone, timeZoneOffset, deviceOS };
}

// Workers port of downloadImageAsDataURIWithToken (server.go image response
// path): fetch a generated image with the account bearer token and re-encode
// as a base64 data URI (A6). Capped at 10 MiB like the upstream download.
export async function downloadImageAsDataURI(
  url: string,
  accessToken: string
): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    });
    if (!resp.ok) return null;
    const mime = resp.headers.get("content-type") ?? "image/png";
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.byteLength > 10 << 20) return null;
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) {
      binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
    }
    return `data:${mime};base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}

function toolMapsToTools(toolMaps: Record<string, unknown>[]): Tool[] {
  const out: Tool[] = [];
  for (const t of toolMaps) {
    const f = (t["function"] ?? {}) as Record<string, unknown>;
    out.push({ type: (t["type"] as string) ?? "function", function: f });
  }
  return out;
}

// ---------------------------------------------------------------- /v1/models
export async function handleModels(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "GET") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  const settings = await getSettings(ctx.env);
  const created = Math.floor(Date.now() / 1000);
  const data = modelCatalog(settings).map((m) => ({ ...m, created }));
  return jsonOut({ object: "list", data, models: data });
}

interface UpstreamErr extends Error {
  status?: number;
  retryAfter?: number;
  body?: string;
}

function upstreamStatusOf(err: unknown): number {
  if (isRateLimited(err)) return 429;
  if (isAuthFailure(err)) return 401;
  return 502;
}

export function writeUpstreamError(err: unknown): Response {
  const e = err as UpstreamErr | null;
  const retry = e?.retryAfter ?? 0;
  const status = upstreamStatusOf(err);
  console.error("[chat] upstream failure:", err instanceof Error ? err.stack : String(err));
  if (status === 429) {
    return jsonOut(
      { error: { message: describeUpstream(err), type: "rate_limit_error" } },
      status,
      { "Retry-After": String(retry > 0 ? retry : 30) }
    );
  }
  return writeOpenAIError(status, "upstream_error", describeUpstream(err));
}

interface ChatOutcome {
  text: string;
  reasoning: string;
  conversationId: string;
  sessionId: string;
  requestId: string;
  throttling?: unknown;
  rawResult: string;
  events: unknown[];
  images: string[];
  // Extended result fields (B14): surfaced on the OpenAI responses.
  suggestedResponses?: import("../chathub/protocol").SuggestedResponse[];
  offense?: string;
  scores?: import("../chathub/protocol").Score[];
  conversationTransferToken?: string;
  meteringInformation?: unknown;
  spokenText?: string;
  storageMessageId?: string;
  references?: Record<string, import("../chathub/protocol").Reference>;
  timestamps?: import("../chathub/protocol").Timestamps;
}

export interface CoreSuccess {
  res: ChatOutcome;
  acc: AccountToken;
  model: string;
  prompt: string;
  sentPrompt: string;
  promptTokens: number;
  completionTokens: number;
  text: string;
  // Set when the answer turned out to be a tool invocation; callers render it
  // via buildToolResponse instead of normal content.
  toolCalls?: DetectedToolCall[];
  // Context budget pruning flag (X-M365-Context-Truncated header parity).
  contextTruncated?: boolean;
}

export interface PreparedRequest {
  tone: string;
  prompt: string; // full flattened prompt
  answerPrompt: string; // possibly incremental
  attachments: Attachment[];
  messages: OaiMsg[];
  toolMaps: Record<string, unknown>[];
  toolChoice: unknown;
  sessionKey: string;
  conversationID: string;
  cloudSessionID: string;
  accountID: string;
  resolvedConversationID: string;
  // body.user fixed binding (sessions.go userSessions port)
  user?: string;
  apiKeyHash?: string;
  // native planning / MCP gateway advertisement
  toolPlugins?: { name: string; description?: string; parameters?: unknown }[];
  mcpServerUrl?: string;
  // convCache bucket (conv_cache.go port): set when a lookup was attempted.
  convCache?: { key: string; sysHash: string };
  // Locale resolved from request headers (parseLocaleFromHeaders port, B4).
  locale?: ChathubLocale;
  // Context budget (context_budget.go port): set when messages were pruned.
  contextTruncated?: boolean;
}

export async function prepareCore(
  ctx: HandlerCtx,
  rawBody: OaiReqBody
): Promise<{ ok: false; error: Response } | { ok: true; prepared: PreparedRequest }> {
  const settings = await getSettings(ctx.env);
  const effort = pickStr(rawBody.reasoning?.effort, rawBody.reasoning_effort);
  const toneOrErr = reasoningTone(rawBody.model ?? "", effort, settings);
  if (toneOrErr instanceof Error) {
    return { ok: false, error: writeOpenAIError(400, "invalid_request_error", toneOrErr.message) };
  }
  const tone = toneOrErr;

  const messages = rawBody.messages ?? [];

  // Tool-bearing requests never reuse gateway-derived conversations (see
  // hasToolHistory) — computed on the ORIGINAL transcript before any budget
  // pruning so the tool round limit is judged on what the client actually sent.
  const toolHistory = hasToolHistory(messages);

  // A3: tool transcript validation (toolloop.go validateToolResult port).
  const toolErr = validateToolConversation(messages);
  if (toolErr) {
    return { ok: false, error: writeOpenAIError(400, "tool_protocol_error", toolErr) };
  }

  // A2: context budget sliding window (context_budget.go port). Budget B =
  // ContextWindow - MaxOutputTokens - 512; over-budget transcripts are pruned
  // atom-wise, over-budget pinned context is a hard 400.
  let contextTruncated = false;
  let budgetMessages = messages;
  {
    let budget = settings.contextWindow - settings.maxOutputTokens - 512;
    if (budget < 1024) budget = 1024;
    try {
      const { slidingWindow } = await import("../pipeline/contextBudget");
      const res = slidingWindow(messages, budget);
      if (res.truncated) {
        contextTruncated = true;
        budgetMessages = res.messages;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        error: new Response(
          JSON.stringify({ error: { message: msg, type: "context_length_exceeded" } }) + "\n",
          { status: 400, headers: { "Content-Type": "application/json", "X-M365-Context-Truncated": "1" } }
        ),
      };
    }
  }

  const attachments: Attachment[] = [];
  let prompt = (await flattenPromptMessages(budgetMessages, attachments)).prompt;
  const rf = rawBody.response_format;
  if (rf?.type === "json_object") {
    prompt += "\nYou must respond with valid JSON.";
  } else if (rf?.type === "json_schema" && rf.json_schema) {
    const schema = rf.json_schema["schema"];
    prompt += schema
      ? `\nYou must respond with valid JSON that conforms to this schema:\n${JSON.stringify(schema)}`
      : "\nYou must respond with valid JSON.";
  }
  if (!prompt && attachments.length === 0) {
    return { ok: false, error: writeOpenAIError(400, "invalid_request_error", "messages required") };
  }

  const { maps: toolMaps, choice: toolChoice } = normalizeTools(rawBody);

  const sessionKey = pickStr(rawBody.session_key, rawBody.sessionKey);
  let accountID = pickStr(rawBody.accountId, rawBody.account_id);
  let conversationID = pickStr(rawBody.conversation_id, rawBody.conversationId);
  let cloudSessionID = pickStr(rawBody.session_id, rawBody.sessionId);

  if (sessionKey) {
    const binding = await getSessionBinding(ctx.env, sessionKey);
    if (binding) {
      accountID = pickStr(accountID, binding.accountID);
      conversationID = pickStr(conversationID, binding.conversationID);
      cloudSessionID = pickStr(cloudSessionID, binding.sessionID);
    }
  }

  // body.user fixed account+conversation binding (userSessions port).
  const rawUser = typeof (rawBody as Record<string, unknown>)["user"] === "string"
    ? String((rawBody as Record<string, unknown>)["user"])
    : "";
  let apiKeyHash = "";
  {
    const auth = ctx.req.headers.get("authorization") ?? "";
    const xk = ctx.req.headers.get("x-api-key") ?? "";
    const rawKey = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : xk.trim();
    if (rawKey !== "") {
      const { keyHash } = await import("../store/keys");
      apiKeyHash = await keyHash(rawKey);
      if (rawUser !== "" && !conversationID && !toolHistory) {
        const { getUserSession } = await import("../admin/extras");
        const us = await getUserSession(ctx.env, apiKeyHash, rawUser);
        if (us) {
          conversationID = conversationID || us.conversationId;
          cloudSessionID = cloudSessionID || us.sessionId;
          accountID = accountID || us.accountId;
        }
      }
    }
  }

  let answerPrompt = prompt;
  let resolvedConversationID = "";

  // CopilotTempSession (C17): one-shot request — clear any conversation/session
  // binding and skip every gateway-derived reuse path below (upstream
  // server.go 1724-1728 + convCache/resolver guards).
  const tempSession = rawBody.metadata?.copilot_temp_session === true;
  if (tempSession) {
    conversationID = "";
    cloudSessionID = "";
  }

  // convCache hit (#3): same account + model bucket + system-prompt
  // hash and MORE messages than cached -> continue the cached conversation
  // incrementally instead of rebuilding context. Skipped for tool-bearing
  // requests (see hasToolHistory) — their incremental tail is tool metadata
  // that M365 cannot answer on its own.
  let convCache: { key: string; sysHash: string } | undefined;
  if (!conversationID && !toolHistory && !tempSession && budgetMessages.length > 0) {
    const { computeSysHash, convCacheKeyFor, getConvCache } = await import("../store/convCache");
    const sysHash = await computeSysHash(budgetMessages);
    if (sysHash !== "") {
      const key = convCacheKeyFor(accountID, rawBody.model || DEFAULT_MODEL);
      convCache = { key, sysHash };
      const hit = await getConvCache(ctx.env, key);
      if (hit && hit.sysHash === sysHash && budgetMessages.length > hit.messageCount) {
        conversationID = hit.conversationId;
        cloudSessionID = pickStr(cloudSessionID, hit.sessionId);
        accountID = pickStr(accountID, hit.accountId);
        const inc = await flattenPromptMessages(budgetMessages.slice(hit.messageCount));
        const incPrompt = inc.prompt.trim();
        if (incPrompt !== "") answerPrompt = incPrompt;
      }
    }
  }

  if (!conversationID && !toolHistory && !tempSession && budgetMessages.length > 0) {
    const ip =
      ctx.req.headers.get("CF-Connecting-IP") ??
      ctx.req.headers.get("X-Forwarded-For")?.split(",")[0].trim() ??
      "";
    const ipFinger = await clientIPFingerprint(ip, ctx.req.headers.get("User-Agent") ?? "");
    const resolved = await resolveSession(ctx.env, {
      explicitId: ctx.req.headers.get("X-M365-Session-Id") ?? undefined,
      ipFingerprint: ipFinger,
      messages: budgetMessages,
    });
    if (!resolved.isNew) {
      resolvedConversationID = resolved.conversationId;
      conversationID = resolved.conversationId;
      cloudSessionID = pickStr(cloudSessionID, resolved.sessionId);
      accountID = pickStr(accountID, resolved.accountId);
      if (
        resolved.historyLen > 0 &&
        resolved.historyLen < budgetMessages.length
      ) {
        const inc = await flattenPromptMessages(budgetMessages.slice(resolved.historyLen));
        const incPrompt = inc.prompt.trim();
        if (incPrompt !== "") answerPrompt = incPrompt;
      }
    }
  }

  // MCP gateway: advertise request tools + our own SSE endpoint to the cloud.
  let toolPlugins: { name: string; description?: string; parameters?: unknown }[] | undefined;
  let mcpServerUrl: string | undefined;
  if (settings.mcpServers && settings.mcpServers.length > 0) {
    // External server bridge (#19): merge their tools into the registry so
    // the cloud can discover them via /v1/mcp/tools (5min cache per URL).
    try {
      const { syncOutboundTools } = await import("../mcp/outbound");
      await syncOutboundTools(settings.mcpServers);
    } catch {
      /* bridging must never break the request path */
    }
  }
  const rawTools = Array.isArray((rawBody as Record<string, unknown>)["tools"])
    ? ((rawBody as Record<string, unknown>)["tools"] as Record<string, unknown>[])
    : [];
  if (rawTools.length > 0) {
    toolPlugins = [];
    for (const t of rawTools) {
      const fn = (t["function"] ?? t) as Record<string, unknown>;
      const name = typeof fn["name"] === "string" ? fn["name"] : "";
      if (name === "") continue;
      toolPlugins.push({
        name,
        description: typeof fn["description"] === "string" ? fn["description"] : undefined,
        parameters: fn["parameters"],
      });
    }
    if (toolPlugins.length > 0) {
      try {
        const { globalToolRegistry } = await import("../mcp/server");
        globalToolRegistry.mergeTools(toolPlugins);
        mcpServerUrl = `${ctx.url.origin}/v1/mcp/sse`;
      } catch {}
    } else {
      toolPlugins = undefined;
    }
  }

  // Answer-turn tool protocol: chatPayload's toolProtocolPrompt only injects
  // the <tools> fenced block when plugins.length === 0, but buildChatPlugins
  // always emits a plugin (BingWebSearch when empty, one API plugin per tool),
  // so the model never sees tool definitions through the protocol path. Inject
  // the tool protocol text here instead so BOTH streaming and non-streaming
  // answer turns expose the caller's tools and the anti-sandbox directive.
  if (toolMaps.length > 0 && String(toolChoice ?? "").toLowerCase() !== "none") {
    answerPrompt = injectToolProtocol(answerPrompt, toolMaps);
  }

  const locale = parseLocaleFromHeaders(ctx);

  return {
    ok: true,
    prepared: {
      tone,
      prompt,
      answerPrompt,
      attachments,
      messages: budgetMessages,
      toolMaps,
      toolChoice,
      sessionKey,
      conversationID,
      cloudSessionID,
      accountID,
      resolvedConversationID,
      user: rawUser || undefined,
      apiKeyHash: apiKeyHash || undefined,
      toolPlugins,
      mcpServerUrl,
      convCache,
      locale,
      contextTruncated: contextTruncated || undefined,
    },
  };
}

export interface AccountResolution {
  ok: boolean;
  error?: Response;
  acc?: AccountToken;
  // Present when a per-account concurrency slot was taken via the
  // coordination DO (#11 executor); callers MUST invoke it once the upstream
  // work for this request has finished.
  release?: () => Promise<void>;
}

export async function resolveAndValidateAccount(
  ctx: HandlerCtx,
  prepared: PreparedRequest
): Promise<{ ok: false; error: Response } | { ok: true; acc: AccountToken; release?: () => Promise<void> }> {
  let acc: AccountToken;
  try {
    acc = await resolveAccount(ctx.env, prepared.accountID);
  } catch (e) {
    return { ok: false, error: writeUpstreamError(e) };
  }
  if (!acc.oid || !acc.tid) {
    const { oid, tid } = extractOIDTID(acc.accessToken);
    acc.oid = acc.oid || oid;
    acc.tid = acc.tid || tid;
  }
  if (!acc.oid || !acc.tid) {
    return {
      ok: false,
      error: writeOpenAIError(
        400,
        "account_error",
        "account missing oid/tid — re-login with PKCE browser client"
      ),
    };
  }
  return await acquireAccountSlot(ctx, acc);
}
// Per-account concurrency gate (port of account_concurrency.go). Only active
// when the coordination DO is bound; the limit comes from runtime settings.
async function acquireAccountSlot(
  ctx: HandlerCtx,
  acc: AccountToken
): Promise<
  | { ok: true; acc: AccountToken; release?: () => Promise<void> }
  | { ok: false; error: Response }
> {
  try {
    const settings = await getSettings(ctx.env);
    const slot = await coordAcquireAccount(ctx.env, acc.id, settings.accountConcurrencyLimit);
    if (!slot) return { ok: true, acc }; // unbound / stub failure -> no gating
    if (!slot.acquired) {
      // Natural backpressure semantics like upstream's limiter.
      const retrySec = Math.max(1, Math.ceil((slot.retryAfterMs ?? 1000) / 1000));
      return {
        ok: false,
        error: jsonOut(
          {
            error: {
              message: `account ${acc.id} is at its concurrency limit (${settings.accountConcurrencyLimit}); retry later`,
              type: "rate_limit_error",
            },
          },
          429,
          { "Retry-After": String(retrySec) }
        ),
      };
    }
    const holder = slot.holder ?? "";
    let released = false;
    return {
      ok: true,
      acc,
      release: async () => {
        if (released || holder === "") return;
        released = true;
        await coordReleaseAccount(ctx.env, acc.id, holder);
      },
    };
  } catch {
    return { ok: true, acc }; // gating must never break request flow
  }
}

// Builds the ChatHub client request from a prepared request. Tools are handed
// to the client only in native planning mode or when the MCP gateway is
// advertised (buildAnswerRequest parity); otherwise the client's
// toolProtocolPrompt falls back to the plain no-truncation prefix.
function chathubRequest(
  prepared: PreparedRequest,
  settings: RuntimeSettings,
  acc: AccountToken,
  opts: { text?: string; tone?: string }
): Parameters<typeof chathubChat>[1] {
  const planningMode = settings.toolPlanningMode ?? "router";
  const nativeTools =
    prepared.toolMaps.length > 0 && (planningMode === "native" || prepared.mcpServerUrl)
      ? toolMapsToTools(prepared.toolMaps)
      : undefined;
  return {
    text: opts.text ?? prepared.answerPrompt,
    tone: opts.tone ?? prepared.tone,
    conversationId: prepared.conversationID || undefined,
    sessionId: prepared.cloudSessionID || undefined,
    attachments: prepared.attachments,
    toolPlugins: prepared.toolPlugins,
    mcpServerUrl: prepared.mcpServerUrl,
    featureFlags: settings.featureFlags ?? { memoryV2: true },
    tools: nativeTools,
    toolChoice: nativeTools ? prepared.toolChoice : undefined,
    locale: prepared.locale?.locale,
    market: prepared.locale?.market,
    timeZone: prepared.locale?.timeZone,
    timeZoneOffset: prepared.locale?.timeZoneOffset,
    deviceOS: prepared.locale?.deviceOS,
    licenseType: settings.licenseType,
    scenario: settings.scenario,
  };
}

export async function chatCall(
  ctx: HandlerCtx,
  prepared: PreparedRequest,
  acc: AccountToken,
  opts: {
    textOverride?: string;
    toneOverride?: string;
    onDelta?: (t: string) => void;
    onReasoning?: (t: string) => void;
    onTool?: (name: string, args: unknown) => void;
  }
): Promise<ChatOutcome> {
  const settings = await getSettings(ctx.env);
  const handlers: ChatHandlers = {};
  if (opts.onDelta) handlers.onDelta = opts.onDelta;
  if (opts.onReasoning) handlers.onReasoning = opts.onReasoning;
  if (opts.onTool) handlers.onTool = opts.onTool;
  return chathubChat(
    { accessToken: acc.accessToken, oid: acc.oid ?? "", tid: acc.tid ?? "", licenseType: settings.licenseType, scenario: settings.scenario },
    chathubRequest(prepared, settings, acc, { text: opts.textOverride, tone: opts.toneOverride }),
    handlers,
    { timeoutMs: settings.chatTimeoutSeconds * 1000 }
  );
}

// Failover guard: mirrors server.go — failover only when nothing pins the
// request to an account or (resolved) conversation, and only for rate-limit /
// auth failures. Resolver-bound conversations are cleared for the retry so a
// fresh chat can safely start on the next healthy account.
export function canFailover(prepared: PreparedRequest, err: unknown): boolean {
  if (prepared.accountID) return false;
  if (prepared.conversationID !== "" && prepared.conversationID !== prepared.resolvedConversationID) {
    return false;
  }
  return isRateLimited(err) || isAuthFailure(err);
}

export async function failoverChat(
  ctx: HandlerCtx,
  prepared: PreparedRequest,
  failedAcc: AccountToken,
  firstErr: unknown,
  handlers?: { onDelta?: (t: string) => void; onReasoning?: (t: string) => void; onTool?: (name: string, args: unknown) => void }
): Promise<{ acc: AccountToken; res: ChatOutcome }> {
  const next = await nextHealthyAccount(ctx.env, failedAcc.id);
  if (!next) throw firstErr;
  if (!next.oid || !next.tid) {
    const { oid, tid } = extractOIDTID(next.accessToken);
    next.oid = next.oid || oid;
    next.tid = next.tid || tid;
  }
  // Resolver-bound conversation: clear it for the retried request (upstream
  // failoverReq semantics) so the fresh account starts a new cloud session.
  const failoverPrepared: PreparedRequest =
    prepared.conversationID !== "" && prepared.conversationID === prepared.resolvedConversationID
      ? { ...prepared, conversationID: "", cloudSessionID: "" }
      : prepared;
  try {
    const res = await chatCall(ctx, failoverPrepared, next, { onDelta: handlers?.onDelta, onReasoning: handlers?.onReasoning, onTool: handlers?.onTool });
    await markSuccess(ctx.env, next.id);
    return { acc: next, res };
  } catch (e2) {
    await markFailure(ctx.env, next.id, e2);
    if (isImageLimited(e2)) await markImageLimited(ctx.env, next.id);
    throw e2; // upstream returns the second account's error (err2)
  }
}

export async function recordFinalize(
  ctx: HandlerCtx,
  prepared: PreparedRequest,
  acc: AccountToken,
  res: ChatOutcome,
  opts: { model: string; endpoint: string; stream: boolean; sentPrompt: string; startedAt: number }
): Promise<void> {
  const messages = prepared.messages;
  if (res.conversationId !== "") {
    const ip =
      ctx.req.headers.get("CF-Connecting-IP") ??
      ctx.req.headers.get("X-Forwarded-For")?.split(",")[0].trim() ??
      "";
    const ipFinger = await clientIPFingerprint(ip, ctx.req.headers.get("User-Agent") ?? "");
    await bindSession(ctx.env, {
      sessionId: res.sessionId,
      conversationId: res.conversationId,
      accountId: acc.id,
      messages,
      assistantText: res.text,
      userField: undefined,
      ipFingerprint: ipFinger,
    });
    await recordConversation(ctx.env, {
      id: res.conversationId,
      accountID: acc.id,
      title: prepared.prompt.slice(0, 80),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    // Conversation detail viewer transcript (batch C): capture the current
    // turn's user prompt + assistant answer. Router planning turns are
    // skipped — their prompt/answer are synthetic tool-selection traffic.
    if (opts.sentPrompt === prepared.answerPrompt) {
      try {
        const { appendChatTurn } = await import("../store/chatMessages");
        let lastUser = "";
        for (let i = messages.length - 1; i >= 0; i--) {
          if ((messages[i].role ?? "").toLowerCase() === "user") {
            lastUser = contentToString(messages[i].content);
            break;
          }
        }
        await appendChatTurn(ctx.env, res.conversationId, lastUser, res.text);
      } catch (e) {
        console.warn("[chat-messages] transcript append failed:", e instanceof Error ? e.message : e);
      }
      // convCache write-back (#3): remember this conversation for the
      // key+account+model bucket so the next turn with more messages can be
      // sent incrementally.
      if (prepared.convCache) {
        const { putConvCache } = await import("../store/convCache");
        await putConvCache(ctx.env, prepared.convCache.key, {
          accountId: acc.id,
          conversationId: res.conversationId,
          sessionId: res.sessionId,
          messageCount: messages.length,
          sysHash: prepared.convCache.sysHash,
          lastUsedAt: nowIso(),
        });
      }
    }
  }
  if (prepared.sessionKey) {
    await upsertSessionBinding(ctx.env, {
      id: prepared.sessionKey,
      accountID: acc.id,
      conversationID: res.conversationId,
      sessionID: res.sessionId,
      title: prepared.prompt.slice(0, 80),
      updatedAt: nowIso(),
    });
  }
  if (prepared.user && prepared.apiKeyHash && res.conversationId !== "") {
    const { putUserSession } = await import("../admin/extras");
    await putUserSession(
      ctx.env,
      prepared.apiKeyHash,
      prepared.user,
      res.conversationId,
      res.sessionId,
      acc.id
    );
  }
  let historyTokens = 0;
  const upper = Math.max(0, messages.length - 1);
  for (const m of messages.slice(0, upper)) {
    historyTokens += estimateTokens(contentToString(m.content));
  }
  const apiKeyPrefix = extractAPIKeyPrefix(ctx);
  const pt = estimateTokens(opts.sentPrompt);
  const ct = estimateTokens(res.text);
  const activeSessions = (await listResolverSessions(ctx.env)).length;
  await recordCacheRequest(ctx.env, apiKeyPrefix, historyTokens > 0, pt, historyTokens, activeSessions);
  await recordUsage(ctx.env, {
    time: new Date().toISOString(),
    api_key_prefix: apiKeyPrefix,
    account_email: acc.email,
    model: opts.model,
    endpoint: opts.endpoint,
    stream: opts.stream,
    input_tokens: pt,
    output_tokens: ct,
    cache_tokens: historyTokens,
    duration_ms: Date.now() - opts.startedAt,
    status: 200,
  });
}

// Shared non-stream pipeline used by /v1/chat/completions and /v1/messages.
export async function runCompletionsCore(
  ctx: HandlerCtx,
  rawBody: OaiReqBody
): Promise<{ ok: false; error: Response } | { ok: true; success: CoreSuccess }> {
  const startedAt = Date.now();
  const prep = await prepareCore(ctx, rawBody);
  if (!prep.ok) return prep;
  const prepared = prep.prepared;

  const accRes = await resolveAndValidateAccount(ctx, prepared);
  if (!accRes.ok) return accRes;
  let acc = accRes.acc;

  const settings = await getSettings(ctx.env);
  // Failover only for rate-limit/auth failures on unpinned requests (A1).
  const failoverable = (err: unknown): boolean => canFailover(prepared, err);
  // Agent evidence ledger: rebuilt from the request messages on every call
  // (no server-side state). Only meaningful when tools are declared.
  const ledger =
    prepared.toolMaps.length > 0 ? buildAgentLedger(prepared.messages) : null;

  try {
    // --- Router planning mode: ask the model to pick the next tool first ---
    // Runs on EVERY tool round (the answer prompt carries no tool-use
    // instructions, so without the router nothing converts replies into
    // tool_calls). The stall risk is bounded elsewhere: tool-bearing requests
    // always send the full transcript (see hasToolHistory) and the ledger
    // block is size-capped in ledgerRouterContext.
    if (
      settings.toolPlanningMode === "router" &&
      prepared.toolMaps.length > 0 &&
      normalizedChoice(prepared.toolChoice) !== "none" &&
      (!ledger || ledgerCanContinue(ledger, settings.maxToolRounds).ok)
    ) {
      const ledgerBlock = ledger ? ledgerRouterContext(ledger) : "";
      const routePrompt =
        modelToolRouterPrompt(prepared.answerPrompt, prepared.toolMaps, prepared.toolChoice) +
        (ledgerBlock !== "" ? `\n\n${ledgerBlock}` : "");
      let routeRes: ChatOutcome;
      try {
        routeRes = await chatCall(ctx, prepared, acc, { textOverride: routePrompt });
      } catch (routeErr) {
        if (failoverable(routeErr)) {
          ({ acc } = await failoverChat(ctx, prepared, acc, routeErr));
          routeRes = await chatCall(ctx, prepared, acc, { textOverride: routePrompt });
        } else {
          throw routeErr;
        }
      }
      const decision = parseModelToolDecision(routeRes.text, prepared.toolMaps, prepared.toolChoice);
      const { valid } = validateDetectedToolCalls(decision.calls, prepared.toolMaps, prepared.toolChoice);
      if (decision.parsed && valid.length > 0) {
        let calls = limitToolCalls(valid, adaptiveToolCallLimit(valid, settings.maxToolCallsPerTurn));
        if (rawBody.parallel_tool_calls === false && calls.length > 1) calls = calls.slice(0, 1);
        ctx.waitUntil(recordFinalize(ctx, prepared, acc, routeRes, {
          model: rawBody.model || DEFAULT_MODEL,
          endpoint: "/v1/chat/completions",
          stream: false,
          sentPrompt: routePrompt,
          startedAt,
        }));
        return {
          ok: true,
          success: {
            res: routeRes,
            acc,
            model: rawBody.model || DEFAULT_MODEL,
            prompt: prepared.prompt,
            sentPrompt: routePrompt,
            promptTokens: estimateTokens(routePrompt),
            completionTokens: estimateTokens(routeRes.text),
            text: routeRes.text,
            toolCalls: calls,
            contextTruncated: prepared.contextTruncated,
          },
        };
      }
    }

    // --- Answer turn -------------------------------------------------------
    let res: ChatOutcome;
    try {
      res = await chatCall(ctx, prepared, acc, {});
    } catch (err) {
      if (isEmptyCompletion(err) && prepared.tone !== "magic") {
        try {
          res = await chatCall(ctx, prepared, acc, { toneOverride: "magic" });
        } catch {
          throw err;
        }
      } else if (failoverable(err)) {
        ({ acc, res } = await failoverChat(ctx, prepared, acc, err));
      } else {
        throw err;
      }
    }
    await markSuccess(ctx.env, acc.id);

    // Content policy block -> 503 like upstream; the account is marked
    // failed so cooldown applies (server.go MarkFailure(ErrOffensiveContent)).
    if (isContentPolicyBlock(res.text)) {
      await markFailure(ctx.env, acc.id, new Error("upstream content policy block"));
      return {
        ok: false,
        error: writeOpenAIError(
          503,
          "upstream_content_blocked",
          "M365 content policy blocked this request; try again or switch account"
        ),
      };
    }
    // Image quota exhaustion: mark the account image-limited until midnight
    // (accountPool.MarkImageLimited parity, A7).
    if (res.text && imageLimitNotice(res.text)) {
      await markImageLimited(ctx.env, acc.id);
    }

    // Tool refusal / sandbox hallucination corrections when tools declared.
    if (prepared.toolMaps.length > 0 && isToolRefusal(res.text)) {
      const correction =
        "Your previous response incorrectly denied that caller tools are available. They are real, active, and callable on the caller's Windows machine. Call the appropriate tool now. Do not explain tool availability.\n\nUser request:\n" +
        prepared.prompt;
      try {
        const res2 = await chatCall(ctx, prepared, acc, { textOverride: correction });
        if (!isToolRefusal(res2.text)) res = res2;
      } catch {
        /* keep original */
      }
    }
    if (prepared.toolMaps.length > 0 && isSandboxHallucination(res.text)) {
      const correction =
        "CRITICAL: You must NOT use any built-in code interpreter, Python sandbox, or cloud execution environment. The caller has provided a bash tool that runs Windows PowerShell 5.1 on their local machine — use it to execute any commands or code. Do NOT say you cannot run code. Do NOT say you only have a Linux container. Do NOT say you have no Windows execution channel. You DO have a bash tool that runs on Windows. Call the bash tool NOW with the appropriate PowerShell command.\n\nUser request:\n" +
        prepared.prompt;
      try {
        const res2 = await chatCall(ctx, prepared, acc, { textOverride: correction });
        if (!isSandboxHallucination(res2.text)) res = res2;
      } catch {
        /* keep original */
      }
    }

    // Post-answer tool detection: fenced blocks first, then native events.
    let toolCalls: DetectedToolCall[] = [];
    let invalidDetectedTool = false;
    if (prepared.toolMaps.length > 0) {
      const raw = fencedToolCalls(res.text, prepared.toolMaps, prepared.toolChoice);
      const validated = validateDetectedToolCalls(raw, prepared.toolMaps, prepared.toolChoice);
      invalidDetectedTool = validated.rejected.length > 0;
      if (validated.valid.length > 0) {
        toolCalls = validated.valid;
      } else {
        const nativeRaw = nativeToolCalls(res.events, allowedToolNames(prepared.toolMaps));
        const nv = validateDetectedToolCalls(nativeRaw, prepared.toolMaps, prepared.toolChoice);
        invalidDetectedTool = invalidDetectedTool || nv.rejected.length > 0;
        toolCalls = nv.valid;
      }
    }

    // Native-mode / invalid-event recovery (server.go 2604-2626 port, A5):
    // ask the router to map the intent onto exactly one declared tool.
    if (
      toolCalls.length === 0 &&
      (settings.toolPlanningMode === "native" || invalidDetectedTool) &&
      prepared.toolMaps.length > 0 &&
      String(prepared.toolChoice ?? "") !== "none"
    ) {
      try {
        const routePrompt =
          modelToolRouterPrompt(prepared.prompt + "\n" + (ledger ? ledgerRouterContext(ledger) : ""), prepared.toolMaps, prepared.toolChoice) +
          "\nREPAIR RULE: The previous upstream event selected an undeclared tool. Select one declared tool that performs the intended operation. Never return unknown_tool.";
        const routeRes = await chatCall(ctx, prepared, acc, { textOverride: routePrompt });
        let decision = parseModelToolDecision(routeRes.text, prepared.toolMaps, prepared.toolChoice);
        if (!decision.parsed) {
          const repairPrompt =
            `Repair this tool routing output into JSON only with shape {"calls":[{"name":"function_name","arguments":{}}]}. Use {"calls":[]} if no tool is needed. OUTPUT:\n` +
            routeRes.text.slice(0, 6000);
          const repairRes = await chatCall(ctx, prepared, acc, { textOverride: repairPrompt });
          decision = parseModelToolDecision(repairRes.text, prepared.toolMaps, prepared.toolChoice);
        }
        const { valid } = validateDetectedToolCalls(decision.calls, prepared.toolMaps, prepared.toolChoice);
        if (decision.parsed && valid.length > 0) {
          toolCalls = valid;
        }
      } catch {
        /* keep original text answer */
      }
    }

    // Completion evidence gate: an answer that contradicts the ledger (claims
    // success with no tool evidence, disowns recorded evidence, or leaves
    // pending calls) is replaced with a fixed disclaimer.
    let text = res.text;
    if (ledger && toolCalls.length === 0 && !completionEvidenceAllows(text, ledger)) {
      console.error("[chat] completion evidence gate:", JSON.stringify({
        pending: ledger.pending.length,
        completed: ledger.completed.length,
      }));
      text = COMPLETION_DISCLAIMER;
      res.text = text;
    }
    const rf = rawBody.response_format;
    if ((rf?.type === "json_object" || rf?.type === "json_schema") && toolCalls.length === 0) {
      text = normalizeJSONText(text);
    }
    const pt = estimateTokens(prepared.answerPrompt);
    const ct = estimateTokens(res.text);

    ctx.waitUntil(
      recordFinalize(ctx, prepared, acc, res, {
        model: rawBody.model || DEFAULT_MODEL,
        endpoint: "/v1/chat/completions",
        stream: false,
        sentPrompt: prepared.answerPrompt,
        startedAt,
      })
    );

    return {
      ok: true,
      success: {
        res,
        acc,
        model: rawBody.model || DEFAULT_MODEL,
        prompt: prepared.prompt,
        sentPrompt: prepared.answerPrompt,
        promptTokens: pt,
        completionTokens: ct,
        text,
        toolCalls: toolCalls.length > 0 ? limitToolCalls(toolCalls, adaptiveToolCallLimit(toolCalls, settings.maxToolCallsPerTurn)) : undefined,
        contextTruncated: prepared.contextTruncated,
      },
    };
  } catch (err) {
    await markFailure(ctx.env, acc.id, err);
    if (isImageLimited(err)) await markImageLimited(ctx.env, acc.id);
    return { ok: false, error: writeUpstreamError(err) };
  } finally {
    // Free the per-account concurrency slot (no-op when ungated).
    await accRes.release?.();
  }
}

function normalizedChoice(choice: unknown): string {
  if (typeof choice === "string") return choice;
  return choice == null ? "" : "obj";
}

// ------------------------------------------------------ /v1/chat/completions
export async function handleChatCompletions(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "POST") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  let body: OaiReqBody;
  try {
    body = (await ctx.req.json()) as OaiReqBody;
  } catch {
    return writeOpenAIError(400, "invalid_request_error", "bad json");
  }

  if (body.stream) {
    return streamChatCompletions(ctx, body);
  }

  const core = await runCompletionsCore(ctx, body);
  if (!core.ok) return core.error;
  const s = core.success;

  if (s.toolCalls && s.toolCalls.length > 0) {
    return buildToolResponse(
      "chatcmpl-" + uuid(),
      s.model,
      false,
      body.stream_options?.include_usage !== false,
      s.toolCalls,
      s.res
    );
  }

  // A6: multimodal answer — generated/reference images are downloaded and
  // returned as image_url blocks (server.go 2705-2712 parity).
  let content: unknown = s.text;
  if (s.res.images && s.res.images.length > 0) {
    const parts: Record<string, unknown>[] = [{ type: "text", text: s.text }];
    for (const u of s.res.images) {
      const du = await downloadImageAsDataURI(u, s.acc.accessToken);
      if (du) parts.push({ type: "image_url", image_url: { url: du } });
    }
    if (parts.length > 1) content = parts;
  }

  const assistant: Record<string, unknown> = { role: "assistant", content };
  if (s.res.reasoning) assistant["reasoning_content"] = s.res.reasoning;

  const headers: Record<string, string> = {};
  if (s.contextTruncated) headers["X-M365-Context-Truncated"] = "1";
  // C14: throttling / scores / metrics headers (server.go 2727-2736 parity).
  if (s.res.throttling != null) headers["X-M365-Throttling"] = JSON.stringify(s.res.throttling);
  if (s.res.scores && s.res.scores.length > 0) headers["X-M365-Scores"] = JSON.stringify(s.res.scores);
  if (s.res.timestamps?.requestSent) headers["X-M365-Metrics"] = JSON.stringify(s.res.timestamps);

  return jsonOut(
    {
      id: "chatcmpl-" + uuid(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: s.model,
      choices: [{ index: 0, message: assistant, finish_reason: "stop" }],
      m365: m365Metadata(s.res),
      usage: {
        prompt_tokens: s.promptTokens,
        completion_tokens: s.completionTokens,
        total_tokens: s.promptTokens + s.completionTokens,
      },
    },
    200,
    headers
  );
}

function m365Metadata(res: {
  conversationId: string;
  sessionId: string;
  requestId: string;
}): Record<string, unknown> {
  return {
    conversationId: res.conversationId,
    sessionId: res.sessionId,
    requestId: res.requestId,
    usage_source: "unavailable_from_chathub",
  };
}

// --------------------------------------------------------- streaming path ---
// Ports the upstream streamed tool holdback: text that looks like a fenced
// tool call is buffered instead of emitted; after completion it becomes a
// streamed tool_calls response when validation accepts it. Native tool events
// are collected live via onTool (A4) and repair runs for undeclared calls (A5).
// Exported for the Responses stream adapter (streamResponsesAdapter port, C12).
export async function streamChatCompletions(ctx: HandlerCtx, body: OaiReqBody): Promise<Response> {
  const startedAt = Date.now();
  const prep = await prepareCore(ctx, body);
  if (!prep.ok) return prep.error;
  const prepared = prep.prepared;

  const accRes = await resolveAndValidateAccount(ctx, prepared);
  if (!accRes.ok) return accRes.error;
  let acc = accRes.acc;

  const settings = await getSettings(ctx.env);
  const hasTools = prepared.toolMaps.length > 0;
  const declaredNames = hasTools ? allowedToolNames(prepared.toolMaps) : new Set<string>();
  const sendUsage = body.stream_options?.include_usage !== false;
  const ledger = prepared.toolMaps.length > 0 ? buildAgentLedger(prepared.messages) : null;

  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const raw = (payload: string) => writer.write(encoder.encode(payload));
  const id = "chatcmpl-" + uuid();
  const model = body.model || DEFAULT_MODEL;
  let firstDelta = true;
  // Streamed-content guard (A1): once any chunk reached the client (or a
  // native tool event was observed) failover must not switch accounts.
  let emittedAny = false;
  const releaseAcc = accRes.release;

  const work = (async () => {
    try {
      raw(": connected\n\n");
      const writeChunk = (delta: Record<string, unknown>) => {
        emittedAny = true;
        let d = delta;
        if (firstDelta) {
          firstDelta = false;
          d = { role: "assistant", content: null, ...delta };
        }
        raw(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: d }],
          })}\n\n`
        );
      };

      // --- Router planning mode for STREAMING (parity with upstream
      // server.go stream path) ---. Upstream runs the tool router BEFORE the
      // answer turn even for stream:true requests: the router prompt embeds
      // the full tool definitions, so the model returns CALL_TOOL/JSON and
      // the gateway emits tool_calls — the model never reaches an answer turn
      // where it would fall back to its own cloud sandbox (/mnt/data). The
      // Worker port originally skipped this on the streaming path, which is
      // why streamed tool-enabled chats hallucinated a sandbox instead of
      // calling the caller's tools.
      if (
        settings.toolPlanningMode === "router" &&
        prepared.toolMaps.length > 0 &&
        String(prepared.toolChoice ?? "").toLowerCase() !== "none" &&
        (!ledger || ledgerCanContinue(ledger, settings.maxToolRounds).ok)
      ) {
        const ledgerBlock = ledger ? ledgerRouterContext(ledger) : "";
        const routePrompt =
          modelToolRouterPrompt(prepared.answerPrompt, prepared.toolMaps, prepared.toolChoice) +
          (ledgerBlock !== "" ? `\n\n${ledgerBlock}` : "");
        let routeRes: ChatOutcome;
        try {
          routeRes = await chatCall(ctx, prepared, acc, { textOverride: routePrompt });
        } catch (routeErr) {
          if (canFailover(prepared, routeErr)) {
            ({ acc } = await failoverChat(ctx, prepared, acc, routeErr));
            routeRes = await chatCall(ctx, prepared, acc, { textOverride: routePrompt });
          } else {
            throw routeErr;
          }
        }
        const decision = parseModelToolDecision(routeRes.text, prepared.toolMaps, prepared.toolChoice);
        const { valid } = validateDetectedToolCalls(decision.calls, prepared.toolMaps, prepared.toolChoice);
        if (decision.parsed && valid.length > 0) {
          let calls = limitToolCalls(valid, adaptiveToolCallLimit(valid, settings.maxToolCallsPerTurn));
          if (body.parallel_tool_calls === false && calls.length > 1) calls = calls.slice(0, 1);
          const toolResponse = buildToolResponse(id, model, true, sendUsage, calls, routeRes);
          const reader = (toolResponse.body as ReadableStream<Uint8Array>).getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            await writer.write(value);
          }
          await writer.close();
          ctx.waitUntil(
            recordFinalize(ctx, prepared, acc, routeRes, {
              model,
              endpoint: "/v1/chat/completions",
              stream: true,
              sentPrompt: routePrompt,
              startedAt,
            })
          );
          return;
        }
      }

      // Holdback state for tool-fence detection while streaming.
      const holdback = createTextHoldback(hasTools);
      // Suppression flag: when the accumulated text matches a sandbox
      // hallucination / tool-refusal pattern early on, stop emitting so the
      // post-stream correction can take over without the delusion prose
      // already shown to the caller.
      let suppressed = false;
      let suppressedText = "";
      const emitTextHoldback = (part: string): void => {
        if (suppressed) {
          // Already suppressed — keep accumulating for post-stream detection
          // and for the correction-failure fallback, but never ship more text.
          suppressedText += part;
          holdback.push(part, () => {});
          return;
        }
        // Pre-flight check: if this delta pushes the accumulated text into a
        // sandbox-hallucination / tool-refusal pattern early on, withhold the
        // WHOLE delta (including its prefix) so the post-stream correction can
        // take over without any delusion prose reaching the caller.
        const upcoming = holdback.buffered() + part;
        if (hasTools && upcoming.length < 400 && (isSandboxHallucination(upcoming) || isToolRefusal(upcoming))) {
          suppressed = true;
          suppressedText = upcoming;
          holdback.push(part, () => {});
          return;
        }
        holdback.push(part, (t) => {
          if (t !== "" && !suppressed) writeChunk({ content: t });
        });
      };
      // Native tool events observed in ChatHub frames (A4).
      const streamedTools: DetectedToolCall[] = [];
      const onTool = (name: string, args: unknown): void => {
        emittedAny = true;
        streamedTools.push({
          id: "call_" + uuid().replace(/-/g, ""),
          type: "",
          name,
          arguments: args == null ? "{}" : JSON.stringify(args),
        });
      };

      let res: ChatOutcome;
      const chathubHandlers = {
        onDelta: (p: string) => emitTextHoldback(p),
        onReasoning: (p: string) => {
          if (p !== "") writeChunk({ reasoning_content: p });
        },
        onTool,
      };
      try {
        res = await chathubChat(
          { accessToken: acc.accessToken, oid: acc.oid ?? "", tid: acc.tid ?? "", licenseType: settings.licenseType, scenario: settings.scenario },
          chathubRequest(prepared, settings, acc, {}),
          chathubHandlers,
          { timeoutMs: settings.chatTimeoutSeconds * 1000 }
        );
      } catch (err) {
        // Failover only when nothing has been emitted and the failure is a
        // rate-limit / auth failure (server.go text.Len()==0 guard, A1).
        if (!emittedAny && canFailover(prepared, err)) {
          ({ acc, res } = await failoverChat(ctx, prepared, acc, err, chathubHandlers));
        } else {
          throw err;
        }
      }
      await markSuccess(ctx.env, acc.id);
      if (res.text && imageLimitNotice(res.text)) {
        await markImageLimited(ctx.env, acc.id);
      }

      // Streamed sandbox-hallucination / tool-refusal correction (parity with
      // runCompletionsCore): once the stream ends, if the accumulated text
      // denies tools or claims a cloud sandbox (/mnt/data), re-ask with a
      // correction prompt and prefer the corrected outcome.
      const accText = holdback.totalText() || res.text;
      let corrected = false;
      if (hasTools && (isSandboxHallucination(accText) || isToolRefusal(accText))) {
        const correction =
          (isSandboxHallucination(accText)
            ? "CRITICAL: You must NOT use any built-in code interpreter, Python sandbox, or cloud execution environment. The caller has provided a bash tool that runs Windows PowerShell 5.1 on their local machine — use it to execute any commands or code. Do NOT say you cannot run code. Do NOT say you only have a Linux container. Do NOT mention /mnt/data or claim the execution environment has changed. Call the bash tool NOW with the appropriate PowerShell command.\n\nUser request:\n"
            : "Your previous response incorrectly denied that caller tools are available. They are real, active, and callable on the caller's Windows machine. Call the appropriate tool now. Do not explain tool availability.\n\nUser request:\n") + prepared.prompt;
        try {
          const res2 = await chatCall(ctx, prepared, acc, { textOverride: correction });
          if (!isSandboxHallucination(res2.text) && !isToolRefusal(res2.text)) {
            res = res2;
            corrected = true;
          }
        } catch {
          /* keep the original streamed outcome */
        }
      }
      // If the correction failed (or never applied), the suppressed state is
      // preserved so the flush branch below can release the withheld text —
      // the caller must never be left with an empty stream.

      // Post-stream tool detection: live native events first, then fenced
      // blocks from the held-back text, then a late native scan (A4).
      let toolCalls: DetectedToolCall[] = [];
      if (hasTools) {
        if (streamedTools.length > 0) {
          const { valid } = validateDetectedToolCalls(streamedTools, prepared.toolMaps, prepared.toolChoice);
          toolCalls = valid;
        } else {
          const detectSource = (corrected ? res.text : holdback.totalText()) || res.text;
          const rawCalls = fencedToolCalls(detectSource, prepared.toolMaps, prepared.toolChoice);
          const validated = validateDetectedToolCalls(rawCalls, prepared.toolMaps, prepared.toolChoice);
          toolCalls = validated.valid;
          if (toolCalls.length === 0 && validated.rejected.length > 0) {
            // A5 repair: an upstream event selected an undeclared tool — ask
            // the router to remap the intent onto exactly one declared tool.
            try {
              const repairPrompt =
                modelToolRouterPrompt(prepared.prompt + "\n" + (ledger ? ledgerRouterContext(ledger) : ""), prepared.toolMaps, "required") +
                "\nREPAIR RULE: The previous upstream event selected an undeclared tool. Select one declared tool that performs the intended operation. Never return unknown_tool.";
              const repairRes = await chatCall(ctx, prepared, acc, { textOverride: repairPrompt });
              const decision = parseModelToolDecision(repairRes.text, prepared.toolMaps, prepared.toolChoice);
              const { valid: repaired } = validateDetectedToolCalls(decision.calls, prepared.toolMaps, prepared.toolChoice);
              if (decision.parsed && repaired.length > 0) {
                toolCalls = repaired;
                res = repairRes;
              }
            } catch {
              /* keep plain-text fallthrough */
            }
          }
          if (toolCalls.length === 0) {
            const nativeRaw = nativeToolCalls(res.events, declaredNames);
            const nv = validateDetectedToolCalls(nativeRaw, prepared.toolMaps, prepared.toolChoice);
            toolCalls = nv.valid;
          }
        }
        if (toolCalls.length > 0) {
          const calls = limitToolCalls(toolCalls, adaptiveToolCallLimit(toolCalls, settings.maxToolCallsPerTurn));
          const toolResponse = buildToolResponse(id, model, true, sendUsage, calls, res);
          const reader = (toolResponse.body as ReadableStream<Uint8Array>).getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            await writer.write(value);
          }
          await writer.close();
          ctx.waitUntil(
            recordFinalize(ctx, prepared, acc, res, {
              model,
              endpoint: "/v1/chat/completions",
              stream: true,
              sentPrompt: prepared.answerPrompt,
              startedAt,
            })
          );
          return;
        }
      }
      // No tool call materialised — flush whatever is still held back. The
      // holdback ALWAYS retains the last few runes (fence-split guard), so
      // this must run for plain conversations too or their tail never ships.
      if (suppressed && corrected) {
        // Delusion text withheld AND the correction produced a clean answer
        // with no tool call — ship the corrected text instead.
        if (!emittedAny) writeChunk({ content: res.text });
      } else if (suppressed && !corrected) {
        // Correction failed — release the withheld text so the caller is
        // never left with an empty stream. The holdback tail is already part
        // of suppressedText, so do not re-flush it.
        if (suppressedText !== "") writeChunk({ content: suppressedText });
      } else {
        holdback.flush((t) => {
          if (t !== "" && !suppressed) writeChunk({ content: t });
        });
      }

      const pt = estimateTokens(prepared.answerPrompt);
      const ct = estimateTokens(res.text);
      const finishChunk: Record<string, unknown> = {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct },
      };
      // C14: throttling / scores carried on the final chunk.
      if (res.throttling != null) finishChunk["x_m365_throttling"] = res.throttling;
      if (res.scores && res.scores.length > 0) finishChunk["x_m365_scores"] = res.scores;
      raw(`data: ${JSON.stringify(finishChunk)}\n\n`);
      raw("data: [DONE]\n\n");
      if (res.timestamps?.requestSent) {
        raw(`: m365-metrics ${JSON.stringify(res.timestamps)}\n\n`);
      }
      await writer.close();

      ctx.waitUntil(
        recordFinalize(ctx, prepared, acc, res, {
          model,
          endpoint: "/v1/chat/completions",
          stream: true,
          sentPrompt: prepared.answerPrompt,
          startedAt,
        })
      );
    } catch (err) {
      await markFailure(ctx.env, acc.id, err);
      if (isImageLimited(err)) await markImageLimited(ctx.env, acc.id);
      console.error("[chat:stream] upstream failure:", err instanceof Error ? err.stack : String(err));
      raw(
        `data: ${JSON.stringify({
          error: { message: describeUpstream(err), code: "rate_limit" },
        })}\n\n`
      );
      raw("data: [DONE]\n\n");
      await writer.close();
    } finally {
      await releaseAcc?.();
    }
  })();
  ctx.waitUntil(work);

  return new Response(readable, { headers: sseHeaders() });
}

// Re-exported for protocol adapters.
export { m365Metadata, type ChatOutcome };

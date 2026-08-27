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
import { getSettings } from "../store/settings";
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
} from "../pipeline/account";
import {
  resolveSession,
  bindSession,
  listResolverSessions,
  clientIPFingerprint,
} from "../pipeline/resolver";
import { recordCacheRequest } from "../store/cacheStats";
import { chat as chathubChat } from "../chathub/client";
import type { Attachment } from "../chathub/protocol";
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
  const attachments: Attachment[] = [];
  let prompt = (await flattenPromptMessages(messages, attachments)).prompt;
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

  // Tool-bearing requests never reuse gateway-derived conversations (see
  // hasToolHistory) — computed early so every reuse path below can check it.
  const toolHistory = hasToolHistory(messages);

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

  // convCache hit (#3): same API key + account bucket + model + system-prompt
  // hash and MORE messages than cached -> continue the cached conversation
  // incrementally instead of rebuilding context. Skipped for tool-bearing
  // requests (see hasToolHistory) — their incremental tail is tool metadata
  // that M365 cannot answer on its own.
  let convCache: { key: string; sysHash: string } | undefined;
  if (!conversationID && !toolHistory && messages.length > 0) {
    const { computeSysHash, convCacheKeyFor, getConvCache } = await import("../store/convCache");
    const sysHash = await computeSysHash(messages);
    if (sysHash !== "") {
      const key = convCacheKeyFor(apiKeyHash, accountID, rawBody.model || DEFAULT_MODEL);
      convCache = { key, sysHash };
      const hit = await getConvCache(ctx.env, key);
      if (hit && hit.sysHash === sysHash && messages.length > hit.messageCount) {
        conversationID = hit.conversationId;
        cloudSessionID = pickStr(cloudSessionID, hit.sessionId);
        accountID = pickStr(accountID, hit.accountId);
        const inc = await flattenPromptMessages(messages.slice(hit.messageCount));
        const incPrompt = inc.prompt.trim();
        if (incPrompt !== "") answerPrompt = incPrompt;
      }
    }
  }

  if (!conversationID && !toolHistory && messages.length > 0) {
    const ip =
      ctx.req.headers.get("CF-Connecting-IP") ??
      ctx.req.headers.get("X-Forwarded-For")?.split(",")[0].trim() ??
      "";
    const ipFinger = await clientIPFingerprint(ip, ctx.req.headers.get("User-Agent") ?? "");
    const resolved = await resolveSession(ctx.env, {
      explicitId: ctx.req.headers.get("X-M365-Session-Id") ?? undefined,
      ipFingerprint: ipFinger,
      messages,
    });
    if (!resolved.isNew) {
      resolvedConversationID = resolved.conversationId;
      conversationID = resolved.conversationId;
      cloudSessionID = pickStr(cloudSessionID, resolved.sessionId);
      accountID = pickStr(accountID, resolved.accountId);
      if (
        resolved.historyLen > 0 &&
        resolved.historyLen < messages.length
      ) {
        const inc = await flattenPromptMessages(messages.slice(resolved.historyLen));
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

  // Answer-turn tool protocol: appended AFTER incremental slicing so the
  // invocation instructions are always present regardless of how much history
  // was elided. Skipped when tool_choice disables calling entirely. This is
  // what lets the model emit fenced invocations that the streaming path (which
  // never runs the router pre-call) can convert into tool_calls.
  if (
    toolMaps.length > 0 &&
    !(typeof toolChoice === "string" && toolChoice === "none")
  ) {
    const { toolUseInstructions } = await import("../pipeline/tools");
    answerPrompt += toolUseInstructions(toolMaps);
  }

  return {
    ok: true,
    prepared: {
      tone,
      prompt,
      answerPrompt,
      attachments,
      messages,
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

export async function chatCall(
  ctx: HandlerCtx,
  prepared: PreparedRequest,
  acc: AccountToken,
  opts: {
    textOverride?: string;
    toneOverride?: string;
    onDelta?: (t: string) => void;
    onReasoning?: (t: string) => void;
  }
): Promise<ChatOutcome> {
  const settings = await getSettings(ctx.env);
  return chathubChat(
    { accessToken: acc.accessToken, oid: acc.oid ?? "", tid: acc.tid ?? "", licenseType: settings.licenseType, scenario: settings.scenario },
    {
      text: opts.textOverride ?? prepared.answerPrompt,
      tone: opts.toneOverride ?? prepared.tone,
      conversationId: prepared.conversationID || undefined,
      sessionId: prepared.cloudSessionID || undefined,
      attachments: prepared.attachments,
      toolPlugins: prepared.toolPlugins,
      mcpServerUrl: prepared.mcpServerUrl,
      featureFlags: { memoryV2: settings.featureFlags?.memoryV2 !== false },
    },
    { onDelta: opts.onDelta, onReasoning: opts.onReasoning },
    { timeoutMs: settings.chatTimeoutSeconds * 1000 }
  );
}

export async function failoverChat(
  ctx: HandlerCtx,
  prepared: PreparedRequest,
  failedAcc: AccountToken,
  firstErr: unknown,
  handlers?: { onDelta?: (t: string) => void; onReasoning?: (t: string) => void }
): Promise<{ acc: AccountToken; res: ChatOutcome }> {
  const next = await nextHealthyAccount(ctx.env, failedAcc.id);
  if (!next) throw firstErr;
  if (!next.oid || !next.tid) {
    const { oid, tid } = extractOIDTID(next.accessToken);
    next.oid = next.oid || oid;
    next.tid = next.tid || tid;
  }
  try {
    const res = await chatCall(ctx, prepared, next, { onDelta: handlers?.onDelta, onReasoning: handlers?.onReasoning });
    await markSuccess(ctx.env, next.id);
    return { acc: next, res };
  } catch (e2) {
    await markFailure(ctx.env, next.id, e2);
    throw firstErr;
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
  const canFailover = (): boolean =>
    !prepared.accountID && !prepared.conversationID;
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
        if (canFailover()) {
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
      } else if (canFailover()) {
        ({ acc, res } = await failoverChat(ctx, prepared, acc, err));
      } else {
        throw err;
      }
    }
    await markSuccess(ctx.env, acc.id);

    // Content policy block -> 503 like upstream.
    if (isContentPolicyBlock(res.text)) {
      return {
        ok: false,
        error: writeOpenAIError(
          503,
          "upstream_content_blocked",
          "M365 content policy blocked this request; try again or switch account"
        ),
      };
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
    if (prepared.toolMaps.length > 0) {
      const raw = fencedToolCalls(res.text, prepared.toolMaps, prepared.toolChoice);
      const validated = validateDetectedToolCalls(raw, prepared.toolMaps, prepared.toolChoice);
      if (validated.valid.length > 0) {
        toolCalls = validated.valid;
      } else {
        const nativeRaw = nativeToolCalls(res.events, allowedToolNames(prepared.toolMaps));
        const nv = validateDetectedToolCalls(nativeRaw, prepared.toolMaps, prepared.toolChoice);
        toolCalls = nv.valid;
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
      },
    };
  } catch (err) {
    await markFailure(ctx.env, acc.id, err);
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

  const assistant: Record<string, unknown> = { role: "assistant", content: s.text };
  if (s.res.reasoning) assistant["reasoning_content"] = s.res.reasoning;

  return jsonOut({
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
  });
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
// streamed tool_calls response when validation accepts it.
async function streamChatCompletions(ctx: HandlerCtx, body: OaiReqBody): Promise<Response> {
  const startedAt = Date.now();
  const prep = await prepareCore(ctx, body);
  if (!prep.ok) return prep.error;
  const prepared = prep.prepared;

  const accRes = await resolveAndValidateAccount(ctx, prepared);
  if (!accRes.ok) return accRes.error;
  let acc = accRes.acc;

  const settings = await getSettings(ctx.env);
  const canFailover = (): boolean => !prepared.accountID && !prepared.conversationID;
  const hasTools = prepared.toolMaps.length > 0;
  const declaredNames = hasTools ? allowedToolNames(prepared.toolMaps) : new Set<string>();
  const sendUsage = body.stream_options?.include_usage !== false;

  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const raw = (payload: string) => writer.write(encoder.encode(payload));
  const id = "chatcmpl-" + uuid();
  const model = body.model || DEFAULT_MODEL;
  let firstDelta = true;
  const releaseAcc = accRes.release;

  const work = (async () => {
    try {
      raw(": connected\n\n");
      const writeChunk = (delta: Record<string, unknown>) => {
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

      // Holdback state for tool-fence detection while streaming.
      const holdback = createTextHoldback(hasTools);
      const emitTextHoldback = (part: string): void => {
        holdback.push(part, (t) => {
          if (t !== "") writeChunk({ content: t });
        });
      };

      let res: ChatOutcome;
      try {
        res = await chathubChat(
          { accessToken: acc.accessToken, oid: acc.oid ?? "", tid: acc.tid ?? "", licenseType: settings.licenseType, scenario: settings.scenario },
          {
            text: prepared.answerPrompt,
            tone: prepared.tone,
            conversationId: prepared.conversationID || undefined,
            sessionId: prepared.cloudSessionID || undefined,
            attachments: prepared.attachments,
            toolPlugins: prepared.toolPlugins,
            mcpServerUrl: prepared.mcpServerUrl,
            featureFlags: { memoryV2: settings.featureFlags?.memoryV2 !== false },
          },
          {
            onDelta: (p) => emitTextHoldback(p),
            onReasoning: (p) => {
              if (p !== "") writeChunk({ reasoning_content: p });
            },
          },
          { timeoutMs: settings.chatTimeoutSeconds * 1000 }
        );
      } catch (err) {
        if (canFailover()) {
          ({ acc, res } = await failoverChat(ctx, prepared, acc, err, {
            onDelta: (p) => emitTextHoldback(p),
            onReasoning: (p) => {
              if (p !== "") writeChunk({ reasoning_content: p });
            },
          }));
        } else {
          throw err;
        }
      }
      await markSuccess(ctx.env, acc.id);

      // Post-stream tool detection: fenced blocks first, then native events.
      if (hasTools) {
        const detectSource = holdback.totalText() || res.text;
        const raw = fencedToolCalls(detectSource, prepared.toolMaps, prepared.toolChoice);
        let { valid } = validateDetectedToolCalls(raw, prepared.toolMaps, prepared.toolChoice);
        if (valid.length === 0) {
          // Native event path: invocations observed in ChatHub frames become
          // tool_calls — they are only collected here, never emitted as text.
          const nativeRaw = nativeToolCalls(res.events, declaredNames);
          const nv = validateDetectedToolCalls(nativeRaw, prepared.toolMaps, prepared.toolChoice);
          valid = nv.valid;
        }
        if (valid.length > 0) {
          const calls = limitToolCalls(valid, adaptiveToolCallLimit(valid, settings.maxToolCallsPerTurn));
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
      holdback.flush((t) => {
        if (t !== "") writeChunk({ content: t });
      });

      const pt = estimateTokens(prepared.answerPrompt);
      const ct = estimateTokens(res.text);
      raw(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct },
        })}\n\n`
      );
      raw("data: [DONE]\n\n");
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

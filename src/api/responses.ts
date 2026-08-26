// OpenAI Responses API endpoint /v1/responses for Codex clients
// (ports of responsesRequest.openAI() from protocol_compat.go, the
// previous_response_id history from protocol_handlers.go responses(),
// estimateResponsesUsage from codex_usage.go and writeResponsesResult from
// codex_responses.go; streaming replays the completed output as the standard
// event sequence — correct but not incremental, unlike the upstream pipe).

import type { HandlerCtx } from "../router";
import { jsonOut, uuid } from "../util";
import type { OaiMsg } from "../pipeline/prompt";
import { runCompletionsCore, m365Metadata, type OaiReqBody } from "./openai";

interface ResponsesRequest {
  model?: string;
  accountId?: string;
  instructions?: string;
  input?: unknown;
  tools?: Record<string, unknown>[];
  tool_choice?: unknown;
  stream?: boolean;
  user?: string;
  reasoning?: { effort?: string };
  previous_response_id?: string;
  conversation?: string;
  new_conversation?: boolean;
}

const USAGE_SOURCE_HEURISTIC = "heuristic_character_estimate";

function heuristicTokenCount(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    if (ch.codePointAt(0)! <= 0x7f) ascii++;
    else other++;
  }
  if (ascii === 0 && other === 0) return 0;
  return Math.floor((ascii + 3) / 4) + other;
}

// Port of estimateResponsesUsage with the heuristic counter (tiktoken is not
// bundled in the Worker).
export function estimateResponsesUsage(
  model: string,
  input: OaiMsg[],
  output: string
): { values: Record<string, unknown>; source: string } {
  void model;
  let inTok = 4 + 3; // requestProtocolTokens + replyPrimingTokens
  for (const message of input ?? []) {
    inTok += 4; // messageProtocolTokens
    const content =
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content ?? "");
    inTok += heuristicTokenCount(message.role) + heuristicTokenCount(content);
    inTok += heuristicTokenCount(message.name ?? "");
    inTok += heuristicTokenCount(message.tool_call_id ?? "");
    for (const call of message.tool_calls ?? []) {
      inTok += heuristicTokenCount(JSON.stringify(call));
    }
  }
  let out = heuristicTokenCount(output);
  if (output !== "") out += 3; // outputProtocolTokens
  return {
    values: { input_tokens: inTok, output_tokens: out, total_tokens: inTok + out },
    source: USAGE_SOURCE_HEURISTIC,
  };
}

function localUsageMetadata(source: string): Record<string, unknown> {
  return {
    usage_source: source,
    usage_values_are_estimates: true,
    usage_estimate_scope: "visible_request_and_completion",
    usage_includes: [
      "message_content",
      "message_framing",
      "tool_schemas",
      "tool_choice",
      "tool_calls",
      "completion_framing",
    ],
  };
}

// Port of responsesRequest.openAI() (text/function scope).
export function responsesToOpenAI(body: ResponsesRequest): { o: OaiReqBody; error?: string } {
  const o: OaiReqBody = {
    model: body.model,
    accountId: body.accountId,
    stream: false, // inner adapter always non-streaming (upstream parity)
    tool_choice: body.tool_choice,
    user: body.user,
  };
  if (body.reasoning?.effort) o.reasoning_effort = body.reasoning.effort;
  const messages: OaiMsg[] = [];
  const instructions = (body.instructions ?? "").trim();
  if (instructions !== "") {
    messages.push({ role: "system", content: instructions });
  }
  if (typeof body.input === "string") {
    if (body.input === "") return { o, error: "input required" };
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const raw of body.input) {
      if (!raw || typeof raw !== "object") continue;
      const m = raw as Record<string, unknown>;
      const typ = typeof m["type"] === "string" ? m["type"] : "";
      switch (typ) {
        case "function_call_progress":
          // Transport metadata; must not trigger a model turn.
          continue;
        case "function_call_output":
        case "custom_tool_call_output": {
          const id = typeof m["call_id"] === "string" ? m["call_id"] : "";
          messages.push({ role: "tool", tool_call_id: id, content: m["output"] });
          break;
        }
        case "function_call": {
          const id = typeof m["call_id"] === "string" ? m["call_id"] : "";
          const name = typeof m["name"] === "string" ? m["name"] : "";
          let args: unknown = m["arguments"];
          if (typeof args === "string") {
            try {
              args = JSON.parse(args);
            } catch {
              /* keep raw string */
            }
          }
          messages.push({
            role: "assistant",
            tool_calls: [
              { id, type: "function", function: { name, arguments: JSON.stringify(args ?? null) } },
            ],
          });
          break;
        }
        case "custom_tool_call":
          continue; // custom exec bridging arrives with MCP phase
        default: {
          let role = typeof m["role"] === "string" ? m["role"] : "";
          if (role === "") role = "user";
          let content = m["content"];
          if (content == null) content = [m];
          messages.push({ role, content });
          break;
        }
      }
    }
  } else if (body.input != null) {
    return { o, error: "input must be string or array" };
  }
  o.messages = messages;
  // Function tools map through; custom tools are bridged as JSON-schema'd
  // single-string functions like upstream's exec handling.
  const tools: { type?: string; function?: Record<string, unknown> }[] = [];
  for (const t of body.tools ?? []) {
    const typ = t["type"];
    const name = t["name"];
    if (typ === "custom") {
      tools.push({
        type: "custom",
        function: {
          name,
          description: t["description"],
          parameters:
            name === "exec"
              ? {
                  type: "object",
                  properties: { input: { type: "string" } },
                  required: ["input"],
                  additionalProperties: false,
                }
              : undefined,
        },
      });
    } else if (typ === "function") {
      tools.push({
        type: "function",
        function: (t["function"] as Record<string, unknown> | undefined) ?? { name: String(t["name"] ?? "") },
      });
    }
  }
  if (tools.length > 0) o.tools = tools;
  return { o };
}

// ---------------------------------------------------------------- history ---
interface StoredHistory {
  at: string;
  messages: OaiMsg[];
}

async function loadHistory(
  ctx: HandlerCtx,
  tenant: string,
  responseId: string
): Promise<OaiMsg[] | null> {
  const key = `resp-history/${tenant}/${responseId}`;
  const stored = await ctx.env["m365-copilot2api_KV"].get<StoredHistory>(key, "json");
  if (!stored) return null;
  if (Date.now() - Date.parse(stored.at) > 3600_000) return null;
  return stored.messages;
}

async function saveHistory(
  ctx: HandlerCtx,
  tenant: string,
  responseId: string,
  messages: OaiMsg[]
): Promise<void> {
  const key = `resp-history/${tenant}/${responseId}`;
  await ctx.env["m365-copilot2api_KV"].put(
    key,
    JSON.stringify({ at: new Date().toISOString(), messages } satisfies StoredHistory),
    { expirationTtl: 3600 }
  );
}

function openAIChoice(src: Record<string, unknown>): { msg: Record<string, unknown> | null; finish: string } {
  const choices = src["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return { msg: null, finish: "" };
  const c = choices[0] as Record<string, unknown>;
  return {
    msg: c["message"] as Record<string, unknown> | null,
    finish: typeof c["finish_reason"] === "string" ? c["finish_reason"] : "",
  };
}

// Port of writeResponsesResult (non-stream JSON + streamed replay).
export function buildResponsesResponse(model: string, stream: boolean, src: Record<string, unknown>): Response {
  const id = typeof src["m365_response_id"] === "string" && src["m365_response_id"] !== ""
    ? (src["m365_response_id"] as string)
    : "resp_" + uuid();
  const { msg } = openAIChoice(src);
  const output: Record<string, unknown>[] = [];
  const calls = msg?.["tool_calls"];
  if (Array.isArray(calls) && calls.length > 0) {
    for (const raw of calls) {
      if (!raw || typeof raw !== "object") continue;
      const tc = raw as Record<string, unknown>;
      const fn = tc["function"] as Record<string, unknown> | undefined;
      output.push({
        type: "function_call",
        id: "fc_" + uuid(),
        call_id: tc["id"],
        name: fn?.["name"],
        arguments: fn?.["arguments"],
        status: "completed",
      });
    }
  } else {
    const text = typeof msg?.["content"] === "string" ? msg!["content"] : String(msg?.["content"] ?? "");
    const messageID = "msg_" + uuid();
    output.push({
      type: "message",
      id: messageID,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  const usage =
    (src["usage"] as Record<string, unknown>) ??
    estimateResponsesUsage(model, [], "").values;  const usageSource =
    typeof src["m365_usage_source"] === "string" && src["m365_usage_source"] !== ""
      ? (src["m365_usage_source"] as string)
      : USAGE_SOURCE_HEURISTIC;

  const resp: Record<string, unknown> = {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output,
    usage,
    m365: localUsageMetadata(usageSource),
  };

  if (!stream) {
    return jsonOut(resp);
  }

  const frames: string[] = [];
  const emit = (name: string, value: unknown) => {
    frames.push(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
  };
  emit("response.created", {
    type: "response.created",
    response: { id, object: "response", status: "in_progress", model, output: [] },
  });
  output.forEach((item, i) => {
    const m = item;
    let addedItem: Record<string, unknown> = item;
    if (m["type"] === "function_call") {
      addedItem = { ...m, arguments: "", status: "in_progress" };
    }
    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: i,
      item: addedItem,
    });
    if (m["type"] === "message") {
      const content = m["content"] as Record<string, unknown>[];
      if (content.length > 0) {
        emit("response.output_text.delta", {
          type: "response.output_text.delta",
          output_index: i,
          content_index: 0,
          delta: content[0]["text"],
        });
      }
    } else if (m["type"] === "function_call") {
      const args = typeof m["arguments"] === "string" ? m["arguments"] : "";
      emit("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        output_index: i,
        item_id: m["id"],
        delta: args,
      });
      emit("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        output_index: i,
        item_id: m["id"],
        arguments: args,
      });
    }
    emit("response.output_item.done", { type: "response.output_item.done", output_index: i, item });
  });
  emit("response.completed", { type: "response.completed", response: resp });

  return new Response(frames.join(""), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function handleResponses(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "POST") {
    return jsonOut(
      { error: { message: "method not allowed", type: "invalid_request_error" } },
      405
    );
  }
  let body: ResponsesRequest;
  try {
    body = (await ctx.req.json()) as ResponsesRequest;
  } catch {
    return jsonOut({ error: { message: "bad json", type: "invalid_request_error" } }, 400);
  }

  const { o, error } = responsesToOpenAI(body);
  if (error) {
    return jsonOut({ error: { message: error, type: "invalid_request_error" } }, 400);
  }

  // previous_response_id continuation.
  const tenant = extractTenant(ctx);
  if (body.previous_response_id) {
    const prior = await loadHistory(ctx, tenant, body.previous_response_id);
    if (!prior || prior.length === 0) {
      return jsonOut(
        { error: { message: "unknown previous_response_id", type: "invalid_request_error" } },
        400
      );
    }
    o.messages = [...prior, ...(o.messages ?? [])];
  }

  const startedAt = Date.now();
  const core = await runCompletionsCore(ctx, o);
  if (!core.ok) {
    const errResp = core.error;
    const status = errResp.status;
    let message = "upstream protocol error";
    try {
      const data = (await errResp.clone().json()) as { error?: { message?: string } };
      if (data?.error?.message) message = data.error.message;
    } catch {
      /* keep */
    }
    const type = status === 401 || status === 403 ? "auth_error" : status === 429 ? "rate_limit_error" : status === 400 ? "invalid_request_error" : "upstream_error";
    return jsonOut({ error: { message, type } }, status);
  }
  const s = core.success;
  const model = body.model || "m365-copilot";

  // Build an internal OpenAI-shaped result then project it.
  const assistant: Record<string, unknown> = { role: "assistant", content: s.text };
  if (s.res.reasoning) assistant["reasoning_content"] = s.res.reasoning;
  const src: Record<string, unknown> = {
    id: "chatcmpl-" + uuid(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    m365: m365Metadata(s.res),
    choices: [
      s.toolCalls && s.toolCalls.length > 0
        ? {
            index: 0,
            message: { role: "assistant", content: null, tool_calls: s.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } })) },
            finish_reason: "tool_calls",
          }
        : { index: 0, message: assistant, finish_reason: "stop" },
    ],
    usage: {
      prompt_tokens: s.promptTokens,
      completion_tokens: s.completionTokens,
      total_tokens: s.promptTokens + s.completionTokens,
    },
  };

  // Store normalized history for future previous_response_id lookups.
  const publicID = "resp_" + uuid();
  src["m365_response_id"] = publicID;
  const storedMessages: OaiMsg[] = [...(o.messages ?? [])];
  if (s.toolCalls && s.toolCalls.length > 0) {
    storedMessages.push({
      role: "assistant",
      tool_calls: s.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } })),
    });
  } else if (s.text !== "") {
    storedMessages.push({ role: "assistant", content: s.text });
  }
  ctx.waitUntil(saveHistory(ctx, tenant, publicID, storedMessages));

  // Usage record under /v1/responses.
  const estimate = estimateResponsesUsage(model, o.messages ?? [], s.text);
  ctx.waitUntil(
    Promise.resolve().then(async () => {
      const { recordUsage } = await import("../store/usage");
      const { extractAPIKeyPrefix } = await import("./auth");
      await recordUsage(ctx.env, {
        time: new Date().toISOString(),
        api_key_prefix: extractAPIKeyPrefix(ctx),
        account_email: s.acc.email,
        model,
        endpoint: "/v1/responses",
        stream: !!body.stream,
        input_tokens: estimate.values.input_tokens as number,
        output_tokens: estimate.values.output_tokens as number,
        cache_tokens: 0,
        duration_ms: Date.now() - startedAt,
        status: 200,
      });
    })
  );

  return buildResponsesResponse(model, !!body.stream, src);
}

function extractTenant(ctx: HandlerCtx): string {
  let key = ctx.req.headers.get("X-API-Key") ?? "";
  if (key === "") {
    const auth = ctx.req.headers.get("Authorization") ?? "";
    if (auth.toLowerCase().startsWith("bearer ")) key = auth.slice(7).trim();
  }
  return key.slice(0, 16) || "anonymous";
}

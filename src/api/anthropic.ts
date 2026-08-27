// Anthropic Messages-compatible endpoint /v1/messages
// (ports of anthropicRequest.openAI() from protocol_compat.go and
// writeAnthropicResult from protocol_response.go).
//
// Streaming: unlike the upstream (which forces the inner adapter to
// non-streaming and replays events after completion), this port streams true
// ChatHub deltas as Anthropic SSE events:
//   message_start -> [thinking block deltas] -> [text block deltas]
//   -> optional tool_use blocks (post-stream detection)
//   -> message_delta(stop_reason, usage) -> message_stop

import type { HandlerCtx } from "../router";
import { uuid, estimateTokens } from "../util";
import type { OaiMsg } from "../pipeline/prompt";
import {
  runCompletionsCore,
  prepareCore,
  resolveAndValidateAccount,
  chatCall,
  failoverChat,
  canFailover,
  recordFinalize,
  DEFAULT_MODEL,
  type OaiReqBody,
  type CoreSuccess,
} from "./openai";
import { adaptiveToolCallLimit, buildToolResponse, fencedToolCalls, validateDetectedToolCalls, limitToolCalls, type DetectedToolCall } from "../pipeline/tools";
import { sseHeaders } from "./sse";
import { getSettings } from "../store/settings";
import { createTextHoldback } from "./holdback";
import { describeUpstream } from "../errors";

interface AnthropicMessage {
  role: string;
  content?: unknown;
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

interface AnthropicRequest {
  model?: string;
  system?: unknown;
  messages?: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: unknown;
  stream?: boolean;
  max_tokens?: number;
  stop_sequences?: string[];
}

function mustJSON(v: unknown): string {
  try {
    return JSON.stringify(v ?? null);
  } catch {
    return "null";
  }
}

// Port of anthropicRequest.openAI() (text scope; image blocks become
// input_image placeholders until multimodal uploads land).
export function anthropicToOpenAI(body: AnthropicRequest): { o: OaiReqBody; error?: string } {
  const o: OaiReqBody = {
    model: body.model,
    stream: false, // inner adapter always non-streaming for the replay path
  };
  if ((body.max_tokens ?? 0) > 0) {
    o.max_completion_tokens = body.max_tokens;
  }
  // C10: stop_sequences parity (protocol_compat.go 178-180).
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    o.stop = body.stop_sequences;
  }
  const messages: OaiMsg[] = [];
  if (body.system != null) {
    const sys =
      typeof body.system === "string"
        ? body.system
        : Array.isArray(body.system)
          ? (body.system as Record<string, unknown>[])
              .map((b) => (typeof b["text"] === "string" ? b["text"] : ""))
              .join("\n")
          : String(body.system);
    if (sys.trim() !== "") messages.push({ role: "system", content: sys });
  }
  for (const m of body.messages ?? []) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) {
      return { o, error: "invalid anthropic content" };
    }
    let hasText = false;
    const textParts: unknown[] = [];
    const calls: Record<string, unknown>[] = [];
    for (const raw of m.content) {
      if (!raw || typeof raw !== "object") continue;
      const b = raw as Record<string, unknown>;
      switch (b["type"]) {
        case "text":
          textParts.push(b);
          hasText = true;
          break;
        case "image": {
          const source = b["source"] as Record<string, unknown> | undefined;
          if (!source) break;
          if (source["type"] === "base64") {
            const data = source["data"];
            const media = source["media_type"];
            if (typeof data === "string" && data !== "") {
              textParts.push({
                type: "input_image",
                image_url: `data:${media || "application/octet-stream"};base64,${data}`,
              });
              hasText = true;
            }
          } else if (source["type"] === "url") {
            const url = source["url"];
            if (typeof url === "string" && url !== "") {
              textParts.push({ type: "input_image", image_url: url });
              hasText = true;
            }
          }
          break;
        }
        case "tool_use":
          // C9: structured assistant tool_calls (protocol_compat.go 231-232
          // parity) so downstream flatten/ledger logic sees real calls.
          calls.push({
            id: b["id"],
            type: "function",
            function: { name: b["name"], arguments: mustJSON(b["input"]) },
          });
          hasText = true;
          break;
        case "tool_result":
          messages.push({
            role: "tool",
            tool_call_id:
              typeof b["tool_use_id"] === "string" ? b["tool_use_id"] : "",
            content: b["content"],
          });
          break;
        default:
          break;
      }
    }
    if (hasText) {
      messages.push({
        role: m.role,
        content: textParts,
        tool_calls: calls.length > 0 ? calls : undefined,
      });
    }
  }
  o.messages = messages;
  // Port of the tool mapping tail of anthropicRequest.openAI():
  // Anthropic input_schema tools become OpenAI function tools, and
  // tool_choice is translated (auto/any/none/tool).
  const tools: NonNullable<OaiReqBody["tools"]> = [];
  for (const t of body.tools ?? []) {
    tools.push({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema ?? { type: "object", properties: {} },
      },
    });
  }
  if (tools.length > 0) o.tools = tools;
  if (body.tool_choice && typeof body.tool_choice === "object") {
    const c = body.tool_choice as Record<string, unknown>;
    switch (c["type"]) {
      case "auto":
        o.tool_choice = "auto";
        break;
      case "any":
        o.tool_choice = "required";
        break;
      case "none":
        o.tool_choice = "none";
        break;
      case "tool":
        o.tool_choice = {
          type: "function",
          function: { name: String(c["name"] ?? "") },
        };
        break;
    }
  }
  return { o };
}

// Port of the block-building half of writeAnthropicResult (incl. tool_use).
export function buildAnthropicBlocks(
  msg: Record<string, unknown>
): { blocks: Record<string, unknown>[]; stopReason: string } {
  const blocks: Record<string, unknown>[] = [];
  let stop = "end_turn";
  const reasoning = msg["reasoning_content"];
  if (typeof reasoning === "string" && reasoning !== "") {
    blocks.push({ type: "thinking", thinking: reasoning, signature: "" });
  }
  const calls = msg["tool_calls"];
  if (Array.isArray(calls) && calls.length > 0) {
    stop = "tool_use";
    for (const raw of calls) {
      if (!raw || typeof raw !== "object") continue;
      const tc = raw as Record<string, unknown>;
      const fn = tc["function"] as Record<string, unknown> | undefined;
      let input: unknown = {};
      try {
        input = JSON.parse(String(fn?.["arguments"] ?? "{}"));
      } catch {
        input = {};
      }
      blocks.push({ type: "tool_use", id: tc["id"], name: fn?.["name"], input });
    }
    return { blocks, stopReason: stop };
  }
  const content = msg["content"];
  if (typeof content === "string") {
    blocks.push({ type: "text", text: content });
  } else if (Array.isArray(content)) {
    for (const raw of content) {
      if (!raw || typeof raw !== "object") continue;
      const part = raw as Record<string, unknown>;
      if (part["type"] === "text") {
        const t = part["text"];
        if (typeof t === "string" && t !== "") blocks.push({ type: "text", text: t });
      }
    }
  }
  if (blocks.length === 0) blocks.push({ type: "text", text: "" });
  return { blocks, stopReason: stop };
}

function anthropicErrorMessage(status: number, fallbackMessage: string): Response {
  const message = fallbackMessage;
  const type =
    status === 401 || status === 403
      ? "authentication_error"
      : status === 429
        ? "rate_limit_error"
        : status === 400
          ? "invalid_request_error"
          : status === 405
            ? "invalid_request_error"
            : "api_error";
  return new Response(JSON.stringify({ type: "error", error: { type, message } }) + "\n", {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function coreErrorToAnthropic(errResp: Response, fallbackMessage: string): Promise<Response> {
  const status = errResp.status;
  let message = fallbackMessage;
  try {
    const data = (await errResp.clone().json()) as { error?: { message?: string } };
    if (data?.error?.message) message = data.error.message;
  } catch {
    /* keep fallback */
  }
  return anthropicErrorMessage(status, message);
}

// Port of writeAnthropicResult.
export function buildAnthropicResponse(model: string, stream: boolean, success: CoreSuccess): Response {
  const id = "msg_" + uuid();
  const msg: Record<string, unknown> = {
    content: success.text,
    reasoning_content: success.res.reasoning,
    ...(success.toolCalls && success.toolCalls.length > 0
      ? {
          tool_calls: success.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          })),
        }
      : {}),
  };
  const { blocks, stopReason } = buildAnthropicBlocks(msg);
  const inputTokens = success.promptTokens;
  const outputTokens = success.completionTokens;

  if (!stream) {
    const out = {
      id,
      type: "message",
      role: "assistant",
      model,
      content: blocks,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    };
    return new Response(JSON.stringify(out) + "\n", {
      headers: { "Content-Type": "application/json" },
    });
  }

  const frames: string[] = [];
  const emit = (name: string, value: unknown) => {
    frames.push(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
  };
  emit("message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });
  blocks.forEach((b, i) => {
    const m = b as Record<string, unknown>;
    const blockType = String(m["type"] ?? "");
    let startBlock: Record<string, unknown> = b;
    if (blockType === "thinking") startBlock = { type: "thinking", thinking: "", signature: "" };
    else if (blockType === "tool_use")
      startBlock = { type: "tool_use", id: m["id"], name: m["name"], input: {} };
    emit("content_block_start", { type: "content_block_start", index: i, content_block: startBlock });
    if (blockType === "text") {
      emit("content_block_delta", {
        type: "content_block_delta",
        index: i,
        delta: { type: "text_delta", text: m["text"] },
      });
    } else if (blockType === "thinking") {
      emit("content_block_delta", {
        type: "content_block_delta",
        index: i,
        delta: { type: "thinking_delta", thinking: m["thinking"] },
      });
    } else if (blockType === "tool_use") {
      emit("content_block_delta", {
        type: "content_block_delta",
        index: i,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(m["input"] ?? {}) },
      });
    }
    emit("content_block_stop", { type: "content_block_stop", index: i });
  });
  emit("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  emit("message_stop", { type: "message_stop" });

  return new Response(frames.join(""), { headers: sseHeaders() });
}

export async function handleAnthropicMessages(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "POST") {
    return anthropicErrorMessage(405, "method not allowed");
  }
  let body: AnthropicRequest;
  try {
    body = (await ctx.req.json()) as AnthropicRequest;
  } catch {
    return anthropicErrorMessage(400, "bad json");
  }

  // True streaming path.
  if (body.stream) {
    return streamAnthropicMessages(ctx, body);
  }

  const { o, error } = anthropicToOpenAI(body);
  if (error) {
    return anthropicErrorMessage(400, error);
  }

  const core = await runCompletionsCore(ctx, o);
  if (!core.ok) {
    return coreErrorToAnthropic(core.error, "upstream protocol error");
  }

  return buildAnthropicResponse(body.model || DEFAULT_MODEL, false, core.success);
}

// ------------------------------------------------------------- streaming ---
//
// True-delta Anthropic stream over the shared chat pipeline. Text that looks
// like a fenced tool call is held back (same strategy as the OpenAI stream)
// so post-stream tool detection can convert it into tool_use blocks.

interface StreamState {
  nextIndex: number;
  openBlockType: null | "thinking" | "text";
}

async function streamAnthropicMessages(ctx: HandlerCtx, body: AnthropicRequest): Promise<Response> {
  const startedAt = Date.now();
  const converted = anthropicToOpenAI(body);
  if (converted.error) {
    return anthropicErrorMessage(400, converted.error);
  }
  const prep = await prepareCore(ctx, converted.o);
  if (!prep.ok) return coreErrorToAnthropic(prep.error, "request failed");
  const prepared = prep.prepared;

  const accRes = await resolveAndValidateAccount(ctx, prepared);
  if (!accRes.ok) return coreErrorToAnthropic(accRes.error, "account resolution failed");
  let acc = accRes.acc;

  const settings = await getSettings(ctx.env);
  const hasTools = prepared.toolMaps.length > 0;
  const model = body.model || DEFAULT_MODEL;
  const id = "msg_" + uuid();
  const releaseAcc = accRes.release;
  // Streamed-content guard: once any block reached the client, failover must
  // not switch accounts (server.go streamedReasoningLen==0 guard, A1).
  let emittedAny = false;

  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const raw = (payload: string) => writer.write(encoder.encode(payload));
  const emit = (name: string, value: unknown) => {
    emittedAny = true;
    raw(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
  };

  const work = (async () => {
    const state: StreamState = { nextIndex: 0, openBlockType: null };

    try {
      emit("message_start", {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: estimateTokens(prepared.answerPrompt), output_tokens: 0 },
        },
      });

      const closeOpenBlock = () => {
        if (state.openBlockType !== null) {
          emit("content_block_stop", { type: "content_block_stop", index: state.nextIndex });
          state.nextIndex++;
          state.openBlockType = null;
        }
      };
      // Ensure the given block kind is open; closes a different open block
      // first so interleaved thinking/text deltas alternate correctly.
      const ensureBlock = (t: "thinking" | "text"): void => {
        if (state.openBlockType === t) return;
        closeOpenBlock();
        const contentBlock =
          t === "thinking"
            ? { type: "thinking", thinking: "", signature: "" }
            : { type: "text", text: "" };
        emit("content_block_start", {
          type: "content_block_start",
          index: state.nextIndex,
          content_block: contentBlock,
        });
        state.openBlockType = t;
      };
      const openThinking = () => ensureBlock("thinking");
      const openText = () => ensureBlock("text");

      // Tool-fence holdback while streaming text.
      const holdback = createTextHoldback(hasTools);
      let reasoningStarted = false;
      const emitTextDelta = (text: string): void => {
        if (text === "") return;
        openText();
        emit("content_block_delta", {
          type: "content_block_delta",
          index: state.nextIndex,
          delta: { type: "text_delta", text },
        });
      };
      const emitTextHoldback = (part: string): void => {
        holdback.push(part, emitTextDelta);
      };

      let res;
      try {
        res = await chatCall(ctx, prepared, acc, {
          onReasoning: (p) => {
            if (p === "") return;
            reasoningStarted = true;
            openThinking();
            emit("content_block_delta", {
              type: "content_block_delta",
              index: state.nextIndex,
              delta: { type: "thinking_delta", thinking: p },
            });
          },
          onDelta: (p) => emitTextHoldback(p),
        });
      } catch (err) {
        if (!emittedAny && canFailover(prepared, err)) {
          ({ acc, res } = await failoverChat(ctx, prepared, acc, err, {
            onReasoning: (p) => {
              if (p === "") return;
              reasoningStarted = true;
              openThinking();
              emit("content_block_delta", {
                type: "content_block_delta",
                index: state.nextIndex,
                delta: { type: "thinking_delta", thinking: p },
              });
            },
            onDelta: (p) => emitTextHoldback(p),
          }));
        } else {
          throw err;
        }
      }
      const { markSuccess } = await import("../pipeline/account");
      await markSuccess(ctx.env, acc.id);

      // Post-stream tool detection over the full accumulated text.
      let toolCalls: DetectedToolCall[] = [];
      if (hasTools) {
        const detectSource = holdback.totalText() || res.text;
        const detected = fencedToolCalls(detectSource, prepared.toolMaps, prepared.toolChoice);
        const { valid } = validateDetectedToolCalls(detected, prepared.toolMaps, prepared.toolChoice);
        if (valid.length > 0) {
          toolCalls = limitToolCalls(valid, adaptiveToolCallLimit(valid, settings.maxToolCallsPerTurn));
        }
      }

      // Reasoning that only materialised in the final result (snapshot mode):
      // emit it as a complete thinking block before any text/tool output,
      // mirroring the replay path's block order.
      if (!reasoningStarted && res.reasoning !== "" && state.openBlockType === null) {
        openThinking();
        emit("content_block_delta", {
          type: "content_block_delta",
          index: state.nextIndex,
          delta: { type: "thinking_delta", thinking: res.reasoning },
        });
      }

      if (toolCalls.length > 0) {
        // Discard held-back fence text; render tool_use blocks instead.
        closeOpenBlock();
        for (const tc of toolCalls) {
          emit("content_block_start", {
            type: "content_block_start",
            index: state.nextIndex,
            content_block: { type: "tool_use", id: tc.id, name: tc.name, input: {} },
          });
          emit("content_block_delta", {
            type: "content_block_delta",
            index: state.nextIndex,
            delta: { type: "input_json_delta", partial_json: tc.arguments },
          });
          emit("content_block_stop", { type: "content_block_stop", index: state.nextIndex });
          state.nextIndex++;
        }
      } else {
        // Flush any held-back tail as normal text content.
        holdback.flush(emitTextDelta);
        closeOpenBlock();
        // Spec-friendliness: a message must contain at least one content
        // block even when the upstream produced nothing visible.
        if (state.nextIndex === 0) {
          emit("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          });
          emit("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "" },
          });
          emit("content_block_stop", { type: "content_block_stop", index: 0 });
          state.nextIndex = 1;
        }
      }

      const ct = estimateTokens(res.text);
      emit("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: toolCalls.length > 0 ? "tool_use" : "end_turn",
          stop_sequence: null,
        },
        usage: { output_tokens: ct },
      });
      emit("message_stop", { type: "message_stop" });
      await writer.close();
      ctx.waitUntil(
        recordFinalize(ctx, prepared, acc, res, {
          model,
          endpoint: "/v1/messages",
          stream: true,
          sentPrompt: prepared.answerPrompt,
          startedAt,
        })
      );
    } catch (err) {
      const { markFailure } = await import("../pipeline/account");
      await markFailure(ctx.env, acc.id, err);
      console.error("[messages:stream] upstream failure:", err instanceof Error ? err.stack : String(err));
      try {
        emit("error", {
          type: "error",
          error: {
            type: "api_error",
            message: describeUpstream(err),
          },
        });
      } catch {
        /* writer already closed */
      }
      await writer.close();
    } finally {
      await releaseAcc?.();
    }
  })();
  ctx.waitUntil(work);

  return new Response(readable, { headers: sseHeaders() });
}

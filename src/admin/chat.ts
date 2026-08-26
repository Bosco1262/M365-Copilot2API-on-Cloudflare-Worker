// Console chat endpoints /api/chat and /api/chat/stream
// (ports of chatOnce from server.go and chatStream from stream.go).

import type { HandlerCtx } from "../router";
import { jsonOut, writeOpenAIError, estimateTokens } from "../util";
import { describeUpstream } from "../errors";
import { getSettings } from "../store/settings";
import { resolveAccount, markFailure, markSuccess } from "../pipeline/account";
import { chat as chathubChat } from "../chathub/client";
import { normalizeFrame, semanticEvents } from "../chathub/protocol";
import { getSessionBinding, upsertSessionBinding } from "../store/conversations";
import type { AccountToken } from "../types";

interface ChatBody {
  accountId?: string;
  message?: string;
  prompt?: string;
  tone?: string;
  conversationId?: string;
  sessionId?: string;
  sessionKey?: string;
}

async function prepare(
  ctx: HandlerCtx
): Promise<{ body: ChatBody; acc: AccountToken; prompt: string } | Response> {
  let body: ChatBody;
  try {
    body = (await ctx.req.json()) as ChatBody;
  } catch {
    return writeOpenAIError(400, "invalid_request_error", "bad json");
  }
  const text = (body.message ?? body.prompt ?? "").trim();
  if (!text) {
    return writeOpenAIError(400, "invalid_request_error", "message or attachment required");
  }
  let accountID = body.accountId ?? "";
  let conversationID = body.conversationId ?? "";
  let cloudSessionID = body.sessionId ?? "";
  if (body.sessionKey) {
    const binding = await getSessionBinding(ctx.env, body.sessionKey);
    if (binding) {
      accountID = accountID || binding.accountID;
      conversationID = conversationID || binding.conversationID;
      cloudSessionID = cloudSessionID || binding.sessionID;
    }
  }
  const accOrErr = await resolveAccount(ctx.env, accountID).catch((e) => e);
  if (accOrErr instanceof Error) {
    console.error("[api/chat] resolve account failed:", accOrErr.stack ?? String(accOrErr));
    return writeOpenAIError(502, "upstream_error", describeUpstream(accOrErr));
  }
  const acc = accOrErr;
  if (!acc.oid || !acc.tid) {
    return writeOpenAIError(400, "account_error", "account missing oid/tid — ?re-login with PKCE browser client");
  }
  return {
    body: { ...body, conversationId: conversationID, sessionId: cloudSessionID },
    acc,
    prompt: text,
  };
}

export async function handleChat(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "POST") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  const prepared = await prepare(ctx);
  if (prepared instanceof Response) return prepared;
  const { body, acc, prompt } = prepared;
  const settings = await getSettings(ctx.env);

  try {
    const res = await chathubChat(
      { accessToken: acc.accessToken, oid: acc.oid ?? "", tid: acc.tid ?? "" },
      {
        text: prompt,
        tone: body.tone,
        conversationId: body.conversationId || undefined,
        sessionId: body.sessionId || undefined,
      },
      {},
      { timeoutMs: settings.chatTimeoutSeconds * 1000 }
    );
    await markSuccess(ctx.env, acc.id);
    if (body.sessionKey) {
      ctx.waitUntil(
        upsertSessionBinding(ctx.env, {
          id: body.sessionKey,
          accountID: acc.id,
          conversationID: res.conversationId,
          sessionID: res.sessionId,
          title: prompt.slice(0, 80),
          updatedAt: new Date().toISOString(),
        })
      );
    }
    return jsonOut({
      status: "ok",
      text: res.text,
      reasoning: res.reasoning,
      conversationId: res.conversationId,
      sessionId: res.sessionId,
      requestId: res.requestId,
      throttling: res.throttling,
      result: res.rawResult,
      images: [],
      account: { id: acc.id, email: acc.email },
      usage: {
        prompt_tokens: estimateTokens(prompt),
        completion_tokens: estimateTokens(res.text),
      },
    });
  } catch (e) {
    await markFailure(ctx.env, acc.id, e);
    console.error("[api/chat] upstream failure:", e instanceof Error ? e.stack : String(e));
    return writeOpenAIError(502, "upstream_error", describeUpstream(e));
  }
}

export async function handleChatStream(ctx: HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "POST") {
    return writeOpenAIError(405, "invalid_request_error", "method not allowed");
  }
  const prepared = await prepare(ctx);
  if (prepared instanceof Response) return prepared;
  const { body, acc, prompt } = prepared;
  const settings = await getSettings(ctx.env);

  try {
    const res = await chathubChat(
      { accessToken: acc.accessToken, oid: acc.oid ?? "", tid: acc.tid ?? "" },
      {
        text: prompt,
        tone: body.tone,
        conversationId: body.conversationId || undefined,
        sessionId: body.sessionId || undefined,
      },
      {},
      { timeoutMs: settings.chatTimeoutSeconds * 1000 }
    );
    await markSuccess(ctx.env, acc.id);

    const { readable, writable } = new TransformStream<Uint8Array>();
    const work = (async () => {
      const encoder = new TextEncoder();
      const writer = writable.getWriter();
      const emit = (name: string, value: unknown) =>
        writer.write(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`));
      res.events.forEach((frame, i) => {
        const normalized = normalizeFrame(frame as Record<string, unknown>);
        writer.write(
          encoder.encode(
            `event: event\ndata: ${JSON.stringify({
              index: i,
              type: "chathub.event",
              event: { ...normalized },
              conversationId: res.conversationId,
              sessionId: res.sessionId,
              requestId: res.requestId,
            })}\n\n`
          )
        );
      });
      for (const [i, ev] of semanticEvents(res.events as Record<string, unknown>[]).entries()) {
        await emit("semantic", { index: i, type: "m365.semantic", event: ev });
      }
      await emit("done", {
        type: "done",
        text: res.text,
        conversationId: res.conversationId,
        sessionId: res.sessionId,
        requestId: res.requestId,
        throttling: res.throttling,
      });
      await writer.close();
    })();
    ctx.waitUntil(work);

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (e) {
    await markFailure(ctx.env, acc.id, e);
    console.error("[api/chat/stream] upstream failure:", e instanceof Error ? e.stack : String(e));
    return writeOpenAIError(502, "upstream_error", describeUpstream(e));
  }
}

// Buffered non-stream transport ("fake non-stream", api/buffered.ts):
// stream:false requests must return the SAME one-shot JSON body as before,
// while the generation runs inside ctx.waitUntil (Free-plan 10ms CPU guard).
// Validation errors keep their real 4xx status; mid-generation failures are
// relayed in-band because the response status was already committed.
import { describe, it, expect, vi } from "vitest";
import { MockKV } from "./helpers/mockkv";

const chatMock = vi.fn();

vi.mock("../src/chathub/client", () => ({
  chat: (...args: unknown[]) => chatMock(...(args as [unknown, unknown, unknown, unknown])),
  uploadAttachments: vi.fn(async () => {}),
}));

vi.mock("../src/pipeline/account", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/pipeline/account")>();
  return {
    ...actual,
    resolveAccount: vi.fn(async () => ({
      id: "acc-1",
      email: "t@t.local",
      status: "online",
      accessToken: "tok",
      refreshToken: "",
      expiresAt: "2099-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      oid: "oid-1",
      tid: "tid-1",
    })),
    markSuccess: vi.fn(async () => {}),
    markFailure: vi.fn(async () => {}),
    nextHealthyAccount: vi.fn(async () => null),
  };
});

import { handleChatCompletions } from "../src/api/openai";
import type { Env } from "../src/env";
import type { HandlerCtx } from "../src/router";

function makeCtx(body: Record<string, unknown>): { ctx: HandlerCtx; pending: Promise<unknown>[] } {
  const env = { "m365-copilot2api_KV": new MockKV() } as unknown as Env;
  const req = new Request("http://worker.test/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer m365_test_key" },
    body: JSON.stringify(body),
  });
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      env,
      req,
      url: new URL("http://worker.test/v1/chat/completions"),
      requestId: "req-test",
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    } as unknown as HandlerCtx,
    pending,
  };
}

function okResult(text: string) {
  return {
    text,
    reasoning: "",
    conversationId: "conv-1",
    sessionId: "sess-1",
    requestId: "r",
    rawResult: "",
    events: [],
    images: [],
  };
}

describe("buffered non-stream transport", () => {
  it("returns the full one-shot OpenAI JSON body for stream:false", async () => {
    const FULL = "A complete one-shot answer for the client.";
    chatMock.mockImplementation(async () => okResult(FULL));

    const { ctx, pending } = makeCtx({
      model: "gpt-5.2",
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    });
    const res = await handleChatCompletions(ctx);
    // Headers are committed immediately, before the work finishes.
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");

    const textPromise = res.text();
    await Promise.allSettled(pending);
    const raw = await textPromise;

    // Leading whitespace is intentional (commits headers early); every JSON
    // parser strips it.
    const data = JSON.parse(raw) as {
      object?: string;
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      m365?: Record<string, unknown>;
    };
    expect(data.object).toBe("chat.completion");
    expect(data.choices?.[0]?.message?.content).toBe(FULL);
    expect(data.choices?.[0]?.finish_reason).toBe("stop");
    expect(data.usage?.completion_tokens).toBeGreaterThan(0);
    expect(data.m365).toBeDefined();
  });

  it("keeps real 4xx statuses for request-phase validation errors", async () => {
    const { ctx } = makeCtx({
      model: "gpt-5.2",
      stream: false,
      messages: [], // no messages, no attachments -> 400 before buffering
    });
    const res = await handleChatCompletions(ctx);
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error?: { message?: string } };
    expect(data.error?.message).toBe("messages required");
  });

  it("relays mid-generation failures in-band as an error body with a committed 200", async () => {
    chatMock.mockImplementation(async () => {
      throw new Error("upstream boom");
    });

    const { ctx, pending } = makeCtx({
      model: "gpt-5.2",
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    });
    const res = await handleChatCompletions(ctx);
    // The status was already committed as 200 by the buffered transport.
    expect(res.status).toBe(200);

    const textPromise = res.text();
    await Promise.allSettled(pending);
    const data = JSON.parse(await textPromise) as { error?: { type?: string; message?: string } };
    expect(data.error?.type).toBe("upstream_error");
    // describeUpstream sanitizes generic upstream errors to a fixed notice.
    expect(data.error?.message).toBe("upstream request failed");
  });
});

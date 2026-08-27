// Regression test: plain streaming conversations (no tools declared) must
// emit the COMPLETE text — including the final few runes that the tool-fence
// holdback retains internally.
import { describe, it, expect, vi } from "vitest";
import { MockKV } from "./helpers/mockkv";

const chatMock = vi.fn();

vi.mock("../src/chathub/client", () => ({
  chat: (...args: unknown[]) => chatMock(...(args as [unknown, unknown, { onDelta?: (t: string) => void }, unknown])),
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

async function readSse(res: Response): Promise<string> {
  return res.text();
}

describe("streaming tail completeness", () => {
  it("emits the full text including the held-back tail when no tools are declared", async () => {
    const FULL = "Hello, this is a complete answer.";
    // Final delta is deliberately shorter than RUNE_HOLDBACK (8).
    chatMock.mockImplementation(async (_acc, _req, handlers) => {
      handlers?.onDelta?.("Hello, this is a ");
      handlers?.onDelta?.("complete answer.");
      return {
        text: FULL,
        reasoning: "",
        conversationId: "",
        sessionId: "",
        requestId: "r",
        rawResult: "",
        events: [],
        images: [],
      };
    });

    const body = {
      model: "gpt-5.2",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    };
    const { ctx, pending } = makeCtx(body);
    const res = await handleChatCompletions(ctx);
    expect(res.status).toBe(200);
    // Start draining the body BEFORE awaiting work — otherwise writer.write()
    // stalls on backpressure with no reader attached.
    const textPromise = readSse(res);
    await Promise.allSettled(pending);

    const raw = await textPromise;
    const emitted = [...raw.matchAll(/"delta":\s*({[^}]*})/g)]
      .map((m) => {
        try {
          return (JSON.parse(m[1]) as { content?: string }).content ?? "";
        } catch {
          return "";
        }
      })
      .join("");
    expect(emitted).toBe(FULL); // tail must not be dropped
    expect(raw).toContain("finish_reason");
    expect(raw.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("also flushes the tail when tools ARE declared but no call materialises", async () => {
    const FULL = "Answer without any tool usage at all.";
    chatMock.mockImplementation(async (_acc, _req, handlers) => {
      handlers?.onDelta?.("Answer without any tool ");
      handlers?.onDelta?.("usage at all.");
      return {
        text: FULL,
        reasoning: "",
        conversationId: "",
        sessionId: "",
        requestId: "r",
        rawResult: "",
        events: [],
        images: [],
      };
    });

    const body = {
      model: "gpt-5.2",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "bash",
            parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
          },
        },
      ],
    };
    const { ctx, pending } = makeCtx(body);
    const res = await handleChatCompletions(ctx);
    const textPromise = readSse(res);
    await Promise.allSettled(pending);
    const raw = await textPromise;
    const emitted = [...raw.matchAll(/"delta":\s*({[^}]*})/g)]
      .map((m) => {
        try {
          return (JSON.parse(m[1]) as { content?: string }).content ?? "";
        } catch {
          return "";
        }
      })
      .join("");
    expect(emitted).toBe(FULL);
    expect(raw).not.toContain("tool_calls"); // stayed a normal completion
  });
});

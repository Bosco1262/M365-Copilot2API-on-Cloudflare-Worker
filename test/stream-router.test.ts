// Regression tests: streamed router pre-call (parity with upstream Go
// server.go stream path). A streamed tool-enabled request must run the tool
// router BEFORE the answer turn: the router prompt embeds the full tool
// definitions, the model replies CALL_TOOL/JSON, and the gateway emits
// tool_calls — instead of falling into a /mnt/data sandbox hallucination on
// the answer turn. Only when the router selects NO tool do we fall through to
// the normal streamed answer.
import { describe, it, expect, vi, beforeEach } from "vitest";
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

const TOOLS = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "run a command on the caller's Windows machine",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  },
];

function outcome(text: string, events: unknown[] = []) {
  return {
    text,
    reasoning: "",
    conversationId: "",
    sessionId: "",
    requestId: "r",
    rawResult: "",
    events,
    images: [],
  };
}

async function readSse(res: Response): Promise<string> {
  return res.text();
}

describe("streamed router pre-call", () => {
  beforeEach(() => {
    chatMock.mockReset();
  });

  it("routes the tool call BEFORE the answer turn and emits tool_calls", async () => {
    // Router pre-call has no onDelta handlers; the answer turn would. If the
    // answer turn is reached, fail loudly so we know the pre-call was skipped.
    chatMock.mockImplementation(async (_acc, _req, handlers) => {
      if (handlers?.onDelta) {
        throw new Error("answer turn must not run when the router selects a tool");
      }
      return outcome('CALL_TOOL: bash({"command":"Get-ChildItem"})');
    });

    const body = {
      model: "gpt-5.2",
      stream: true,
      messages: [{ role: "user", content: "请阅读当前仓库" }],
      tools: TOOLS,
    };
    const { ctx, pending } = makeCtx(body);
    const res = await handleChatCompletions(ctx);
    expect(res.status).toBe(200);
    const rawPromise = readSse(res);
    await Promise.allSettled(pending);
    const raw = await rawPromise;

    expect(chatMock).toHaveBeenCalledTimes(1); // only the router pre-call
    expect(raw).toContain("tool_calls");
    expect(raw).toContain("Get-ChildItem");
    expect(raw).not.toContain("content\":\"");
  });

  it("falls through to the streamed answer turn when the router selects no tool", async () => {
    chatMock.mockImplementation(async (_acc, _req, handlers) => {
      if (!handlers?.onDelta) {
        return outcome("NO_TOOL_NEEDED");
      }
      handlers.onDelta("不需要调用工具，直接回答。");
      return outcome("不需要调用工具，直接回答。");
    });

    const body = {
      model: "gpt-5.2",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
      tools: TOOLS,
    };
    const { ctx, pending } = makeCtx(body);
    const res = await handleChatCompletions(ctx);
    const rawPromise = readSse(res);
    await Promise.allSettled(pending);
    const raw = await rawPromise;

    expect(chatMock).toHaveBeenCalledTimes(2); // router + answer turn
    expect(raw).toContain("直接回答");
    expect(raw).not.toContain("tool_calls");
  });
});

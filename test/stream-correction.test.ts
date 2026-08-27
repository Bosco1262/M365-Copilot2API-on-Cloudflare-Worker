// Regression tests: streamed sandbox-hallucination / tool-refusal correction.
// When the model claims a cloud sandbox (/mnt/data) or denies caller tools on
// the STREAMING path, the gateway must suppress the delusion prose, re-ask
// with a correction prompt, and prefer the corrected outcome (ideally a real
// tool_calls response for the caller's declared tools).
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

describe("streamed sandbox-hallucination correction", () => {
  beforeEach(() => {
    chatMock.mockReset();
  });

  it("suppresses /mnt/data delusion prose and returns tool_calls from the corrected turn", async () => {
    const DELUSION = "我会先检查仓库结构。执行环境中没有挂载目标仓库。目录是 /mnt/data，目录为空且不是 Git 仓库，因此暂时无法阅读。";
    const FIXED = "```bash\n{\"command\":\"Get-ChildItem\"}\n```";
    // Call 1 = router pre-call (no onDelta) -> no tool selected, fall through.
    // Call 2 = the streamed answer turn (handlers.onDelta present) -> delusion.
    // Call 3 = the correction re-ask via chatCall (no onDelta) -> fixed block.
    let callCount = 0;
    chatMock.mockImplementation(async (_acc, _req, handlers) => {
      callCount++;
      if (handlers?.onDelta) {
        handlers.onDelta(DELUSION);
        return outcome(DELUSION);
      }
      if (callCount === 1) return outcome("NO_TOOL_NEEDED");
      return outcome(FIXED);
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

    expect(chatMock).toHaveBeenCalledTimes(3); // router + answer + correction
    expect(raw).toContain("tool_calls");
    expect(raw).toContain("Get-ChildItem");
    // The delusion tail must NOT reach the caller (suppression engaged).
    expect(raw).not.toContain("不是 Git 仓库");
  });

  it("falls back to the original streamed text when the correction also hallucinates", async () => {
    const DELUSION = "没有执行通道。目录是 /mnt/data，目录为空且不是 Git 仓库。";
    // Call 1 = router pre-call -> no tool. Call 2 = streamed answer (delusion).
    // Call 3 = correction re-ask which still hallucinates.
    let callCount = 0;
    chatMock.mockImplementation(async (_acc, _req, handlers) => {
      callCount++;
      if (!handlers?.onDelta) {
        if (callCount === 1) return outcome("NO_TOOL_NEEDED");
        return outcome(DELUSION);
      }
      handlers.onDelta(DELUSION);
      return outcome(DELUSION);
    });

    const body = {
      model: "gpt-5.2",
      stream: true,
      messages: [{ role: "user", content: "请阅读当前仓库" }],
      tools: TOOLS,
    };
    const { ctx, pending } = makeCtx(body);
    const res = await handleChatCompletions(ctx);
    const rawPromise = readSse(res);
    await Promise.allSettled(pending);
    const raw = await rawPromise;

    expect(chatMock).toHaveBeenCalledTimes(3); // router + answer + failed correction
    // Correction failed -> suppression released -> the original text ships so
    // the caller is never left with an empty stream.
    expect(raw).toContain("不是 Git 仓库");
    expect(raw).not.toContain("tool_calls");
  });
});

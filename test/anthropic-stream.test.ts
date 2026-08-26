// Integration test for the Anthropic true-streaming handler: mocks the
// ChatHub client and account layer, drives handleAnthropicMessages with
// stream=true and asserts the SSE event sequence.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MockKV } from "./helpers/mockkv";

const chatMock = vi.fn();

vi.mock("../src/chathub/client", () => ({
  chat: (...args: unknown[]) => chatMock(...(args as [unknown, unknown, { onDelta?: (t: string) => void; onReasoning?: (t: string) => void }, unknown])),
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

import { handleAnthropicMessages } from "../src/api/anthropic";
import type { Env } from "../src/env";
import type { HandlerCtx } from "../src/router";

function makeCtx(body: string): { ctx: HandlerCtx; collected: string[]; pending: Promise<unknown>[] } {
  const env = { "m365-copilot2api_KV": new MockKV() } as unknown as Env;
  const req = new Request("http://worker.test/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": "m365_test" },
    body,
  });
  const collected: string[] = [];
  const pending: Promise<unknown>[] = [];
  const ctx: HandlerCtx = {
    env,
    req,
    url: new URL("http://worker.test/v1/messages"),
    requestId: "req-test",
    waitUntil: (p) => pending.push(p),
  };
  return { ctx, collected, pending };
}

async function readAll(res: Response): Promise<string> {
  return res.text();
}

function frames(raw: string): { event: string; data: any }[] {
  const out: { event: string; data: any }[] = [];
  for (const block of raw.split("\n\n").filter((b) => b.trim() !== "")) {
    let event = "";
    let data: any = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      else if (line.startsWith("data: ")) data = JSON.parse(line.slice(6));
    }
    out.push({ event, data });
  }
  return out;
}

describe("anthropic /v1/messages true streaming", () => {
  beforeEach(() => {
    chatMock.mockReset();
  });

  it("streams thinking then text deltas in spec order and closes the message", async () => {
    chatMock.mockImplementation(
      async (_acc, _req, handlers: { onDelta?: (t: string) => void; onReasoning?: (t: string) => void }) => {
        handlers.onReasoning?.("because");
        handlers.onDelta?.("Hello ");
        handlers.onDelta?.("world");
        return {
          text: "Hello world",
          reasoning: "because",
          conversationId: "conv-1",
          sessionId: "sess-1",
          requestId: "req-1",
          rawResult: "",
          events: [],
          images: [],
        };
      }
    );

    const { ctx, collected, pending } = makeCtx(
      JSON.stringify({ model: "gpt-5.5", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] })
    );
    const resPromise = handleAnthropicMessages(ctx);
    const res = await resPromise;
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const raw = await readAll(res);
    for (const p of pending) await p.catch(() => {});
    collected.push(raw);

    const fs = frames(raw);
    const names = fs.map((f) => f.event);

    // Ordering skeleton.
    expect(names[0]).toBe("message_start");
    expect(names).toContain("content_block_start");
    expect(names).toContain("message_delta");
    expect(names[names.length - 1]).toBe("message_stop");

    // thinking block precedes text block; each opens before its deltas.
    const firstThinkStart = names.indexOf("content_block_start");
    expect(fs[firstThinkStart].data.content_block.type).toBe("thinking");
    const firstTextStart = names.findIndex(
      (n, i) => n === "content_block_start" && fs[i].data.content_block.type === "text"
    );
    expect(firstTextStart).toBeGreaterThan(firstThinkStart);

    // Deltas carry incremental payloads.
    const thinkDeltas = fs.filter((f) => f.data?.delta?.type === "thinking_delta");
    expect(thinkDeltas.map((d) => d.data.delta.thinking).join("")).toBe("because");
    const textDeltas = fs.filter((f) => f.data?.delta?.type === "text_delta");
    expect(textDeltas.map((d) => d.data.delta.text).join("")).toBe("Hello world");

    // Block indices are contiguous and stops follow starts.
    const starts = fs.filter((f) => f.event === "content_block_start");
    expect(starts.map((s) => s.data.index)).toEqual([...new Set(starts.map((s) => s.data.index))].sort((a, b) => a - b));

    // Terminal frame contents.
    const md = fs.find((f) => f.event === "message_delta")!;
    expect(md.data.delta.stop_reason).toBe("end_turn");
    expect(md.data.usage.output_tokens).toBeGreaterThan(0);

    // message_start carries estimated input tokens.
    const ms = fs[0];
    expect(ms.data.message.usage.input_tokens).toBeGreaterThanOrEqual(0);
    expect(ms.data.message.stop_reason).toBeNull();
  });

  it("renders detected fenced tool calls as tool_use blocks with stop_reason tool_use", async () => {
    const args = JSON.stringify({ command: "ls -la" });
    chatMock.mockImplementation(
      async (_acc, _req, handlers: { onDelta?: (t: string) => void }) => {
        handlers.onDelta?.("```bash\n" + args + "\n```");
        return {
          text: "```bash\n" + args + "\n```",
          reasoning: "",
          conversationId: "conv-2",
          sessionId: "sess-2",
          requestId: "req-2",
          rawResult: "",
          events: [],
          images: [],
        };
      }
    );

    const { ctx, pending } = makeCtx(
      JSON.stringify({
        model: "gpt-5.5",
        stream: true,
        max_tokens: 10,
        messages: [{ role: "user", content: "list files" }],
        tools: [
          {
            name: "bash",
            description: "run shell",
            input_schema: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        ],
      })
    );
    const res = await handleAnthropicMessages(ctx);
    const raw = await readAll(res);
    for (const p of pending) await p.catch(() => {});

    const fs = frames(raw);
    const toolUse = fs.find((f) => f.data?.content_block?.type === "tool_use");
    expect(toolUse).toBeTruthy();
    expect(toolUse!.data.content_block.name).toBe("bash");
    const jsonDelta = fs.find((f) => f.data?.delta?.type === "input_json_delta");
    expect(JSON.parse(jsonDelta!.data.delta.partial_json)).toEqual({ command: "ls -la" });

    const textDeltas = fs.filter((f) => f.data?.delta?.type === "text_delta" && f.data.delta.text !== "");
    // The fence text itself must NOT leak as visible content.
    expect(textDeltas.join("")).not.toContain("```bash");

    const md = fs.find((f) => f.event === "message_delta")!;
    expect(md.data.delta.stop_reason).toBe("tool_use");
  });

  it("emits an anthropic error event when the upstream fails mid-stream", async () => {
    chatMock.mockImplementation(async () => {
      throw Object.assign(new Error("boom"), { name: "DialError", status: 502, retryAfter: 0 });
    });
    const { ctx, pending } = makeCtx(
      JSON.stringify({ model: "gpt-5.5", stream: true, messages: [{ role: "user", content: "hi" }] })
    );
    const res = await handleAnthropicMessages(ctx);
    const raw = await readAll(res);
    for (const p of pending) await p.catch(() => {});

    const fs = frames(raw);
    expect(fs[0].event).toBe("message_start"); // headers already sent
    const errFrame = fs.find((f) => f.event === "error");
    expect(errFrame).toBeTruthy();
    expect(errFrame!.data.type).toBe("error");
    expect(typeof errFrame!.data.error.message).toBe("string");
    expect(fs.some((f) => f.event === "message_stop")).toBe(false);
  });
});

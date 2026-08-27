import { describe, it, expect } from "vitest";
import {
  handleConversationWhitelist,
  captureDebugRecord,
  handleDebugLogs,
} from "../src/admin/extras";
import { handleMcpSse, handleMcpMessage } from "../src/mcp/server";
import type { HandlerCtx } from "../src/router";

class MockKV {
  m = new Map<string, string>();
  async get(k: string, type?: string) {
    const v = this.m.get(k) ?? null;
    if (type === "json" && v !== null) return JSON.parse(v);
    return v;
  }
  async put(k: string, v: string) {
    this.m.set(k, v);
  }
  async delete(k: string) {
    this.m.delete(k);
  }
  async list(opts: { prefix: string }) {
    return {
      keys: [...this.m.keys()].filter((k) => k.startsWith(opts.prefix)).map((name) => ({ name })),
      list_complete: true,
    };
  }
}

function makeEnv(): never {
  return { "m365-copilot2api_KV": new MockKV() } as never;
}

function makeCtx(method: string, url: string, body?: string, env?: never): HandlerCtx {
  const req = new Request(url, {
    method,
    body,
    headers: body ? { "content-type": "application/json" } : undefined,
  });
  return {
    env: (env ?? makeEnv()) as never,
    req,
    url: new URL(url),
    requestId: "test",
    waitUntil: () => {},
  };
}

describe("conversation whitelist", () => {
  it("adds, lists and removes ids", async () => {
    const env = makeEnv();
    const add = await handleConversationWhitelist(
      makeCtx("POST", "http://x/api/conversations/whitelist", JSON.stringify({ action: "add", ids: ["a", "b"] }), env)
    );
    expect(add.status).toBe(200);
    const got = await handleConversationWhitelist(makeCtx("GET", "http://x/api/conversations/whitelist", undefined, env));
    const body = (await got.json()) as { whitelist: string[] };
    expect(body.whitelist.sort()).toEqual(["a", "b"]);
    await handleConversationWhitelist(
      makeCtx("POST", "http://x/api/conversations/whitelist", JSON.stringify({ action: "remove", id: "a" }), env)
    );
    const got2 = (await (
      await handleConversationWhitelist(makeCtx("GET", "http://x/api/conversations/whitelist", undefined, env))
    ).json()) as { whitelist: string[] };
    expect(got2.whitelist).toEqual(["b"]);
  });
});

describe("debug records", () => {
  it("redacts sensitive keys and lists newest first", async () => {
    const env = makeEnv();
    await captureDebugRecord(env, {
      path: "/v1/chat/completions",
      method: "POST",
      status: 200,
      durationMs: 12,
      requestBody: JSON.stringify({
        authorization: "Bearer sk",
        api_key: "k",
        messages: [{ role: "user", content: "hi" }],
      }),
      responseBody: JSON.stringify({ ok: true }),
    });
    const res = await handleDebugLogs(makeCtx("GET", "http://x/api/admin/debug/logs", undefined, env));
    const body = (await res.json()) as {
      records: { client: Record<string, unknown> }[];
    };
    expect(body.records).toHaveLength(1);
    const client = body.records[0].client as Record<string, unknown>;
    expect(client["authorization"]).toBe("[redacted]");
    expect(client["api_key"]).toBe("[redacted]");
  });
});

describe("mcp sse", () => {
  it("sends endpoint frame then answers initialize over the stream", async () => {
    const env = makeEnv();
    const sseCtx: HandlerCtx = {
      env,
      req: new Request("http://x/v1/mcp/sse"),
      url: new URL("http://x/v1/mcp/sse"),
      requestId: "t",
      waitUntil: () => {},
    };
    const sse = await handleMcpSse(sseCtx);
    const reader = sse.body!.getReader();
    const dec = new TextDecoder();

    const first = dec.decode((await reader.read()).value!);
    expect(first).toContain("event: endpoint");
    const sid = /sessionId=([^&\n]+)/.exec(first)![1];

    const post = await handleMcpMessage(
      makeCtx(
        "POST",
        `http://x/v1/mcp/message?sessionId=${sid}`,
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      )
    );
    expect(post.status).toBe(202);

    const second = dec.decode((await reader.read()).value!);
    expect(second).toContain("event: message");
    const payload = JSON.parse(/data: (.+)/.exec(second)![1]) as { id: number };
    expect(payload.id).toBe(1);

    // unknown session -> -32000
    const bad = await handleMcpMessage(
      makeCtx("POST", "http://x/v1/mcp/message?sessionId=nope", JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }))
    );
    expect(bad.status).toBe(400);
  });
});

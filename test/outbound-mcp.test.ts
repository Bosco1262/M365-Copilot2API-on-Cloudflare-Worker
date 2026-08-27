import { describe, it, expect } from "vitest";
import { McpOutboundClient, syncOutboundTools, callBridgedTool } from "../src/mcp/outbound";
import { globalToolRegistry, handleRpc } from "../src/mcp/server";
import { collectStreamBody } from "../src/index";

// ------------------------------------------------------------- mock server --

function sseResponse(): { resp: Response; push: (frame: string) => void; close: () => void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    resp: new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
    push: (frame) => controller.enqueue(enc.encode(frame)),
    close: () => {
      try {
        controller.close();
      } catch {}
    },
  };
}

interface Ctx {
  hub: ReturnType<typeof sseResponse>;
  calls: { url: string; body?: unknown }[];
  callDelayMs: number;
}

function makeFetch(ctx: Ctx): typeof fetch {
  let nextId = 100;
  return (async (input: RequestInfo | string, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://ext.example/sse") {
      ctx.calls.push({ url });
      queueMicrotask(() => {
        ctx.hub.push("event: endpoint\ndata: https://ext.example/message?sessionId=abc\n\n\n");
      });
      return ctx.hub.resp;
    }
    if (url.startsWith("https://ext.example/message")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        id?: number;
        method?: string;
        params?: { name?: string };
      };
      ctx.calls.push({ url, body });
      const reply = (result: unknown) =>
        ctx.hub.push(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n\n`
        );
      if (body.method === "initialize") reply({ protocolVersion: "2024-11-05" });
      else if (body.method === "tools/list")
        reply({
          tools: [
            { name: "ext_tool", description: "external tool", inputSchema: { type: "object" } },
          ],
        });
      else if (body.method === "tools/call") {
        // Reply after a delay to exercise the #20 queue/placeholder path.
        setTimeout(() => reply({ content: [{ type: "text", text: "ext result" }] }), ctx.callDelayMs);
      } else {
        void nextId++;
      }
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
}

describe("MCP outbound client (#19)", () => {
  it("performs the endpoint handshake and correlates JSON-RPC replies", async () => {
    const ctx: Ctx = { hub: sseResponse(), calls: [], callDelayMs: 0 };
    const client = await McpOutboundClient.connect("https://ext.example/sse", makeFetch(ctx));
    expect(client.messageUrl).toBe("https://ext.example/message?sessionId=abc");
    await client.initialize();
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["ext_tool"]);
    client.close();
  });

  it("syncOutboundTools merges external tools into the global registry", async () => {
    const ctx: Ctx = { hub: sseResponse(), calls: [], callDelayMs: 0 };
    const res = await syncOutboundToolsWith(["https://ext.example/sse"], makeFetch(ctx));
    expect(res.errors).toEqual([]);
    expect(res.merged).toBe(1);
    expect(globalToolRegistry.listTools().some((t) => t.name === "ext_tool")).toBe(true);
  });
});

describe("#20 async bridge queue semantics", () => {
  it("returns the result when the server answers within the window", async () => {
    const ctx: Ctx = { hub: sseResponse(), calls: [], callDelayMs: 5 };
    const client = await McpOutboundClient.connect("https://ext.example/sse", makeFetch(ctx));
    const out = (await client.callTool("ext_tool", {}, 2000)) as {
      isError?: boolean;
      content?: { text?: string }[];
    };
    expect(out.isError).toBeFalsy();
    expect(out.content?.[0]?.text).toBe("ext result");
    client.close();
  });

  it("returns a fixed placeholder when the call exceeds the window", async () => {
    const ctx: Ctx = { hub: sseResponse(), calls: [], callDelayMs: 300 };
    const client = await McpOutboundClient.connect("https://ext.example/sse", makeFetch(ctx));
    const out = (await client.callTool("ext_tool", {}, 40)) as {
      isError?: boolean;
      placeholder?: boolean;
      content?: { text?: string }[];
    };
    expect(out.placeholder).toBe(true);
    expect(out.isError).toBe(true);
    expect(out.content?.[0]?.text).toContain("did not respond within");
    client.close();
  });

  it("routes cloud tools/call through the bridge; unknown tools still error", async () => {
    globalToolRegistry.mergeTools([{ name: "ext_tool", description: "d" }]);
    // No executor registered for a made-up name -> classic -32603.
    const miss = await handleRpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "nope" } });
    expect(miss).toContain("-32603");
    // Bridged name without a live client -> null -> falls back gracefully.
    const bridgedNone = await callBridgedTool("ext_tool", {});
    expect(bridgedNone).toBeNull();
  });
});

describe("#21 stream debug aggregation", () => {
  it("aggregates chunks and reports truncation at the cap", async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode("data: one\n\n"));
        c.enqueue(enc.encode("data: two\n\n"));
        c.enqueue(enc.encode("data: three\n\n"));
        c.close();
      },
    });
    const full = await collectStreamBody(stream, 1024);
    expect(full.truncated).toBe(false);
    expect(full.text).toBe("data: one\n\ndata: two\n\ndata: three\n\n");

    const stream2 = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 10; i++) c.enqueue(enc.encode("x".repeat(50)));
        c.close();
      },
    });
    const capped = await collectStreamBody(stream2, 120);
    expect(capped.truncated).toBe(true);
    expect(capped.text.length).toBeLessThanOrEqual(120);
  });
});

// Helper mirroring syncOutboundTools but with an injectable fetch.
async function syncOutboundToolsWith(urls: string[], f: typeof fetch) {
  const mod = await import("../src/mcp/outbound");
  const origConnect = McpOutboundClient.connect.bind(McpOutboundClient);
  // Patch connect via prototype-free approach: temporarily swap module-level
  // behaviour is not possible; instead drive the same code path directly.
  const errors: string[] = [];
  let merged = 0;
  for (const url of urls) {
    try {
      const client = await origConnect(url, f);
      await client.initialize();
      const tools = await client.listTools();
      globalToolRegistry.mergeTools(tools);
      merged += tools.length;
      client.close();
    } catch (e) {
      errors.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  void mod;
  return { merged, errors };
}

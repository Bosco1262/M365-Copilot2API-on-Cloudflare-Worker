// MCP over SSE server (port of internal/mcp/server.go + tools.go).
//
// The gateway acts as an MCP server: OpenAI tools from incoming /v1/chat/*
// requests are merged into a global registry and exposed via
//   GET  /v1/mcp/sse           (SSE stream; first frame names the message URL)
//   POST /v1/mcp/message?sessionId=...  (JSON-RPC transport)
// so M365 Copilot cloud can call back into the gateway when native planning
// hands it the mcp-gateway plugin.
//
// Workers note: sessions live in isolate memory. A POST landing on a different
// isolate than the SSE holder returns the same -32000 error as an unknown
// session upstream would.

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface CallResult {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

class GlobalToolRegistry {
  private tools = new Map<string, McpTool>();

  mergeTools(tools: McpTool[]): void {
    for (const t of tools) {
      if (t && typeof t.name === "string" && t.name !== "") this.tools.set(t.name, t);
    }
  }

  listTools(): McpTool[] {
    return [...this.tools.values()];
  }
}

export const globalToolRegistry = new GlobalToolRegistry();

interface SseSession {
  id: string;
  enqueue: (data: string) => void;
  close: () => void;
}

const globalSessions = new Map<string, SseSession>();

function registerSession(session: SseSession): void {
  globalSessions.set(session.id, session);
}

function unregisterSession(id: string): void {
  globalSessions.delete(id);
}

let nextSessionId = Date.now();

// ------------------------------------------------------------- JSON-RPC ----

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

function rpcResult(id: JsonRpcRequest["id"], result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

export async function handleRpc(req: JsonRpcRequest): Promise<string | null> {  const id = req.id ?? null;
  switch (req.method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "m365-copilot2api", version: "0.5.0-cfworker" },
      });
    case "notifications/initialized":
      return null; // notification: no response frame
    case "tools/list":
      return rpcResult(id, { tools: globalToolRegistry.listTools() });
    case "tools/call": {
      const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const name = typeof params.name === "string" ? params.name : "";
      // Bridged external servers (#19/#20): execute through the outbound
      // client with 30s queue semantics (placeholder on timeout).
      if (name !== "") {
        try {
          const { callBridgedTool } = await import("./outbound");
          const result = await callBridgedTool(name, params.arguments ?? {});
          if (result !== null) return rpcResult(id, result);
        } catch {
          /* fall through to the no-executor error below */
        }
      }
      // The registry only advertises schemas for caller-executed tools; a
      // direct cloud-initiated call has no executor here.
      return rpcError(id, -32603, "no tools available");
    }
    default:
      return rpcError(id, -32601, "method not found");
  }
}

// ---------------------------------------------------------------- routes ----

export async function handleMcpSse(ctx: import("../router").HandlerCtx): Promise<Response> {
  // Hub mode: the DO owns the stream so /message works from any isolate.
  const hub = ctx.env.MCP_HUB;
  if (hub) {
    const id = "mcp-" + (nextSessionId = nextSessionId + 1);
    const host = ctx.req.headers.get("host") ?? ctx.url.host;
    const scheme = ctx.req.headers.get("X-Forwarded-Proto") ?? ctx.url.protocol.replace(":", "");
    const first = encodeURIComponent(
      `event: endpoint\ndata: ${scheme}://${host}/v1/mcp/message?sessionId=${id}\n\n\n`
    );
    const stub = hub.get(hub.idFromName(id));
    const resp = await stub.fetch(`https://do/attach?id=${encodeURIComponent(id)}&first=${first}`);
    return new Response(resp.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
  let idRef = "";
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: string) => {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${data}\n\n\n`));
      };
      const id = "mcp-" + (nextSessionId = nextSessionId + 1);
      idRef = id;
      registerSession({
        id,
        enqueue: (data) => send("message", data),
        close: () => {
          try {
            controller.close();
          } catch {}
        },
      });
      const host = ctx.req.headers.get("host") ?? ctx.url.host;
      const scheme = ctx.req.headers.get("X-Forwarded-Proto") ?? ctx.url.protocol.replace(":", "");
      send("endpoint", `${scheme}://${host}/v1/mcp/message?sessionId=${id}`);
    },
    cancel() {
      unregisterSession(idRef);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export async function handleMcpMessage(ctx: import("../router").HandlerCtx): Promise<Response> {
  if (ctx.req.method !== "POST") {
    return jsonRpcHttp(null, -32000, "POST only");
  }
  const sessionId = ctx.url.searchParams.get("sessionId") ?? "";
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(await ctx.req.text()) as JsonRpcRequest;
  } catch {
    return jsonRpcHttp(null, -32700, "parse error");
  }
  // Hub mode: compute the reply here (registry lives with /v1/chat traffic),
  // then hand it to the session DO for delivery on any isolate.
  const hub = ctx.env.MCP_HUB;
  if (hub) {
    const reply = await handleRpc(req);
    if (reply === null) {
      return new Response(JSON.stringify({ status: "accepted" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    }
    const stub = hub.get(hub.idFromName(sessionId));
    const pushed = await stub.fetch(`https://do/push?sessionId=${encodeURIComponent(sessionId)}`, {
      method: "POST",
      body: reply,
    });
    if (pushed.status === 404) return jsonRpcHttp(req.id ?? null, -32000, "session not found");
    return new Response(JSON.stringify({ status: "accepted" }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  }
  const session = globalSessions.get(sessionId);
  if (!session) {
    return jsonRpcHttp(null, -32000, "session not found");
  }
  const reply = await handleRpc(req);
  if (reply !== null) session.enqueue(reply);
  return new Response(JSON.stringify({ status: "accepted" }), {
    status: 202,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonRpcHttp(id: JsonRpcRequest["id"], code: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );
}

export async function handleMcpToolsList(ctx: import("../router").HandlerCtx): Promise<Response> {
  const { jsonOut } = await import("../util");
  return jsonOut({ tools: globalToolRegistry.listTools() });
}

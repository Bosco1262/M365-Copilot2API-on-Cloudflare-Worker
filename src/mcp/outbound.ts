// Outbound MCP client over SSE (port of internal/mcp/client.go).
//
// Connects to an external MCP server: GET the SSE endpoint, capture the
// sessionId/message URL from the `endpoint` event, then speak JSON-RPC over
// POST with id-correlated replies read back off the same SSE stream.
// Timeouts mirror upstream: initialize/tools/list 10s, tools/call 30s.
//
// #20 async-bridge queue semantics: a bridged tools/call is enqueued and
// awaited for up to 30s; on timeout a placeholder result is returned so the
// surrounding conversation is never blocked by a slow external server.

import type { McpTool } from "./server";
import { globalToolRegistry } from "./server";

export const INIT_TIMEOUT_MS = 10_000;
export const LIST_TIMEOUT_MS = 10_000;
export const CALL_TIMEOUT_MS = 30_000;

interface RpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export class McpOutboundError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new McpOutboundError(`${what} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new McpOutboundError(String(e)));
      }
    );
  });
}

export class McpOutboundClient {
  private pending = new Map<number, (resp: RpcResponse) => void>();
  private nextId = 1;
  private buffer = "";
  private closed = false;
  private _messageUrl = "";
  private readonly fetchImpl: typeof fetch;

  /** POST target learned from the SSE endpoint handshake frame. */
  get messageUrl(): string {
    return this._messageUrl;
  }

  private constructor(
    readonly serverUrl: string,
    body: ReadableStream<Uint8Array>,
    fetchImpl: typeof fetch
  ) {
    this.fetchImpl = fetchImpl;
    void this.readLoop(body, this.fetchImpl);
  }

  /** GET the SSE endpoint and wait for the endpoint/sessionId handshake. */
  static async connect(serverUrl: string, fetchImpl: typeof fetch = fetch): Promise<McpOutboundClient> {
    const resp = await withTimeout(
      fetchImpl(serverUrl, { headers: { Accept: "text/event-stream" } }),
      INIT_TIMEOUT_MS,
      "sse connect"
    );
    if (!resp.ok || !resp.body) {
      throw new McpOutboundError(`sse connect failed: HTTP ${resp.status}`);
    }
    // The endpoint event usually arrives immediately; peek for it via a
    // handoff promise resolved by the read loop.
    let resolveEndpoint!: (url: string) => void;
    let rejectEndpoint!: (e: Error) => void;
    const endpointPromise = new Promise<string>((resolve, reject) => {
      resolveEndpoint = resolve;
      rejectEndpoint = reject;
    });
    const client = new McpOutboundClient(serverUrl, resp.body, fetchImpl);
    client.onEndpoint = (url) => {
      client._messageUrl = url;
      resolveEndpoint(url);
    };
    client.onLoopError = rejectEndpoint;
    try {
      await withTimeout(endpointPromise, INIT_TIMEOUT_MS, "endpoint handshake");
    } catch (e) {
      client.close();
      throw e;
    }
    return client;
  }

  private onEndpoint?: (url: string) => void;
  private onLoopError?: (e: Error) => void;

  close(): void {
    this.closed = true;
    for (const [id, resolve] of this.pending) {
      resolve({ error: { code: -32000, message: "connection closed" } });
      this.pending.delete(id);
    }
  }

  private async readLoop(body: ReadableStream<Uint8Array>, fetchImpl: typeof fetch): Promise<void> {
    const reader = body.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.closed) break;
        this.buffer += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = this.buffer.indexOf("\n\n")) >= 0) {
          const frame = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        this.handleFrame(frame);
        }
      }
    } catch (e) {
      this.onLoopError?.(e instanceof Error ? e : new Error(String(e)));
    } finally {
      this.close();
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    }
  }

  private handleFrame(frame: string): void {
    let event = "";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    const data = dataLines.join("\n");
    if (!data) return;
    if (event === "endpoint" || (!event && !data.startsWith("{"))) {
      // Handshake frame naming the message POST target (may be relative).
      this.handleHandshake(data);
      return;
    }
    try {
      const resp = JSON.parse(data) as RpcResponse;
      if (resp && resp.id !== undefined && resp.id !== null) {
        const resolve = this.pending.get(resp.id as number);
        if (resolve) {
          this.pending.delete(resp.id as number);
          resolve(resp);
        }
      }
    } catch {
      /* ignore malformed frames like upstream */
    }
  }

  private handleHandshake(data: string): void {
    try {
      const u = new URL(data, this.serverUrl);
      this.onEndpoint?.(u.toString());
    } catch {
      this.onLoopError?.(new McpOutboundError(`invalid endpoint frame: ${data}`));
    }
  }

  private async postRpc(method: string, params: unknown, timeoutMs: number): Promise<RpcResponse> {
    if (this.closed) throw new McpOutboundError("client closed");
    if (!this.messageUrl) throw new McpOutboundError("handshake incomplete");
    const id = this.nextId++;
    const reply = withTimeout(
      new Promise<RpcResponse>((resolve, reject) => {
        this.pending.set(id, resolve);
        this.fetchImpl(this.messageUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        })
          .then(async (resp) => {
            // Some servers answer inline over HTTP for non-streaming transports.
            if (!resp.ok) {
              this.pending.delete(id);
              reject(new McpOutboundError(`rpc ${method}: HTTP ${resp.status}`));
            }
          })
          .catch((e) => {
            this.pending.delete(id);
            reject(e instanceof Error ? e : new Error(String(e)));
          });
      }),
      timeoutMs,
      `rpc ${method}`
    );
    const resp = await reply.finally(() => this.pending.delete(id));
    if (resp.error) {
      throw new McpOutboundError(`rpc ${method} error ${resp.error.code ?? ""}: ${resp.error.message ?? ""}`);
    }
    return resp;
  }

  async initialize(): Promise<void> {
    await this.postRpc(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "m365-copilot2api-gateway", version: "0.5.0-cfworker" },
      },
      INIT_TIMEOUT_MS
    );
  }

  async listTools(): Promise<McpTool[]> {
    const resp = await this.postRpc("tools/list", {}, LIST_TIMEOUT_MS);
    const tools = (resp.result as { tools?: McpTool[] } | undefined)?.tools ?? [];
    return Array.isArray(tools) ? tools : [];
  }

  /**
   * tools/call with #20 queue semantics: wait up to timeoutMs for the
   * external server; on timeout return the fixed placeholder instead of an
   * error so callers can keep going.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number = CALL_TIMEOUT_MS
  ): Promise<unknown> {
    try {
      const resp = await this.postRpc("tools/call", { name, arguments: args }, timeoutMs);
      return resp.result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        content: [{ type: "text", text: `[bridge] tool "${name}" did not respond within ${timeoutMs / 1000}s (${msg}); no result is available.` }],
        isError: true,
        placeholder: true,
      };
    }
  }
}

// ------------------------------------------------------- registry bridge ---

const BRIDGE_TTL_MS = 5 * 60_000;
const bridgeCache = new Map<string, { at: number; tools: McpTool[]; client: McpOutboundClient }>();

/** Tool names served by an external MCP server, mapped back to its client. */
export function bridgedToolSource(name: string): McpOutboundClient | null {
  for (const entry of bridgeCache.values()) {
    if (entry.tools.some((t) => t.name === name)) return entry.client;
  }
  return null;
}

/**
 * Pulls tools from external MCP servers into the global registry (#19).
 * Cached per URL for 5 minutes; failures are reported per URL and never
 * thrown.
 */
export async function syncOutboundTools(urls: string[]): Promise<{ merged: number; errors: string[] }> {
  const errors: string[] = [];
  let merged = 0;
  const now = Date.now();
  for (const raw of urls) {
    const url = raw.trim();
    if (url === "") continue;
    try {
      const cached = bridgeCache.get(url);
      if (cached && now - cached.at < BRIDGE_TTL_MS) {
        globalToolRegistry.mergeTools(cached.tools);
        merged += cached.tools.length;
        continue;
      }
      const client = await McpOutboundClient.connect(url);
      await client.initialize();
      const tools = await client.listTools();
      bridgeCache.set(url, { at: now, tools, client });
      globalToolRegistry.mergeTools(tools);
      merged += tools.length;
    } catch (e) {
      bridgeCache.delete(url);
      errors.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { merged, errors };
}

/** #20: execute a bridged tool through its originating server. */
export async function callBridgedTool(
  name: string,
  args: Record<string, unknown>
): Promise<unknown | null> {
  const client = bridgedToolSource(name);
  if (!client) return null;
  return client.callTool(name, args);
}

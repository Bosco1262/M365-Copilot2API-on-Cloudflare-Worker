// McpSessionDO: per-session mailbox Durable Object for the MCP SSE gateway.
// The Worker computes JSON-RPC replies locally (so the global tool registry
// lives where /v1/chat requests land); this DO only relays frames to the SSE
// client no matter which isolate holds it.

export class McpSessionDO {
  private sessions = new Map<string, (data: string) => void>();

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const sseHeaders: Record<string, string> = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    };

    if (url.pathname === "/attach") {
      const id = url.searchParams.get("id") ?? "";
      const first = url.searchParams.get("first") ?? "";
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          if (first) controller.enqueue(enc.encode(first));
          this.sessions.set(id, (data) => {
            try {
              controller.enqueue(enc.encode(`event: message\ndata: ${data}\n\n\n`));
            } catch {}
          });
        },
        cancel: () => {
          this.sessions.delete(id);
        },
      });
      return new Response(stream, { headers: sseHeaders });
    }

    if (url.pathname === "/push") {
      const id = url.searchParams.get("sessionId") ?? "";
      const data = await req.text();
      const push = this.sessions.get(id);
      if (!push) return new Response(JSON.stringify({ found: false }), { status: 404 });
      push(data);
      return new Response(JSON.stringify({ ok: true }));
    }

    return new Response("not found", { status: 404 });
  }
}

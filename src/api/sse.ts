// Small helpers for Server-Sent Events responses.

export class SseWriter {
  private encoder = new TextEncoder();
  constructor(private controller: ReadableStreamDefaultController<Uint8Array>) {}

  raw(payload: string): void {
    this.controller.enqueue(this.encoder.encode(payload));
  }

  event(name: string, value: unknown): void {
    this.raw(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
  }

  data(value: unknown): void {
    this.raw(`data: ${JSON.stringify(value)}\n\n`);
  }

  done(): void {
    this.raw("data: [DONE]\n\n");
  }

  close(): void {
    try {
      this.controller.close();
    } catch {
      /* already closed */
    }
  }
}

export function sseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
}

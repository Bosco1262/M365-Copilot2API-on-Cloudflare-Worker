// Pseudo non-streaming transport ("fake non-stream", Free-plan 10ms CPU guard).
//
// Why: with the client requesting stream:false, the whole generation previously
// ran in the request phase — the Worker returned no Response until the upstream
// ChatHub WebSocket finished. On the Free plan (10 ms CPU per invocation) long
// replies hit Error 1102 there, while the streaming path survives because it
// returns a streaming Response immediately and does all the work inside
// ctx.waitUntil() where CPU is consumed in tiny bursts between I/O gaps
// (I/O waits do not count toward the CPU budget).
//
// How: the caller does the cheap request-phase part (validation, account
// resolution), then hands the expensive work here. We commit the response
// headers right away (JSON tolerates a leading whitespace byte, which also
// nudges the edge into flushing) and run the work via waitUntil. When the work
// finishes, its complete JSON body is written in one shot — the client receives
// a normal one-shot JSON body exactly like before.
//
// Trade-offs (accepted by design):
// - The HTTP status is committed as 200 before the outcome is known, so
//   mid-generation failures are delivered in-band as an error JSON body
//   (the same way OpenAI streaming reports errors) instead of a 4xx/5xx status.
// - Response headers set by the work (X-M365-*) cannot reach the client; the
//   meaningful metadata is folded into the JSON body by the callers.
import type { HandlerCtx } from "../router";
import { describeUpstream } from "../errors";

export function bufferedJsonResponse(
  ctx: HandlerCtx,
  work: () => Promise<Response>
): Response {
  const { readable, writable } = new TransformStream<Uint8Array>(
    undefined,
    undefined,
    // Generous readable HWM: queued chunks must never block the work's writes
    // even when no reader has attached yet (tests, abandoned requests).
    { highWaterMark: 16 }
  );
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  ctx.waitUntil(
    (async () => {
      try {
        // Commit the response headers immediately; a single leading space is
        // valid JSON whitespace and is stripped by every JSON parser.
        await writer.write(encoder.encode(" "));
        let res: Response;
        try {
          res = await work();
        } catch (e) {
          console.error(
            "[buffered] work failed:",
            e instanceof Error ? e.stack : String(e)
          );
          res = new Response(
            JSON.stringify({
              error: {
                message: describeUpstream(e),
                type: "upstream_error",
              },
            }) + "\n",
            { status: 502, headers: { "Content-Type": "application/json" } }
          );
        }
        // The status/headers of `res` can no longer take effect (already
        // committed); only its body is relayed.
        await writer.write(encoder.encode(await res.text()));
      } catch {
        /* client disconnected / writer closed — nothing left to do */
      } finally {
        try {
          await writer.close();
        } catch {
          /* ignore */
        }
      }
    })()
  );

  return new Response(readable, {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

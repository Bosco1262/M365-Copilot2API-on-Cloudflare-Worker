// ChatHub WebSocket client for the Workers runtime
// (port of internal/chathub/client.go chatWithHandlers).

import {
  RS,
  DEFAULT_TONE,
  USER_AGENT,
  ORIGIN,
  buildWSURL,
  chatPayload,
  rateLimitedText,
  classifyUpdateMessages,
  imageURLs,
  type ChatAccount,
  type ChatRequest,
  type ChatResult,
  type Attachment,
} from "./protocol";
import { DialError, EmptyCompletion, RateLimitNotice } from "../errors";

export interface ChatHandlers {
  onDelta?: (text: string) => void;
  onReasoning?: (text: string) => void;
}

interface Frame {
  type: number;
  target?: string;
  arguments?: unknown[];
  item?: Record<string, unknown>;
  error?: unknown;
}

function parseFrames(data: string): Frame[] {
  const out: Frame[] = [];
  for (const part of data.split(RS)) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    try {
      out.push(JSON.parse(trimmed) as Frame);
    } catch {
      // ignore non-JSON fragments like Go does
    }
  }
  return out;
}

const MAX_ATTACHMENTS = 10;

// Port of Client.uploadAttachments: images are uploaded to the UploadFile
// endpoint (x-www-form-urlencoded, NOT multipart) and mutated with docId.
export async function uploadAttachments(
  acc: ChatAccount,
  conversationID: string,
  attachments: Attachment[],
  userAgentHeaders: Record<string, string>
): Promise<void> {
  let imageCount = 0;
  for (const a of attachments) {
    if (a.type !== "image") continue;
    imageCount++;
    if (imageCount > MAX_ATTACHMENTS) {
      throw new Error(`too many image attachments: limit is ${MAX_ATTACHMENTS}`);
    }
    const form = new URLSearchParams();
    form.set("scenario", "UploadImage");
    form.set("conversationId", conversationID);
    // The browser sends the complete data URL in FileBase64.
    form.set("FileBase64", a.url);
    form.append("optionsSets", "cwcgptvsan");
    form.append("optionsSets", "flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch");
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "X-Variants": "feature.EnableImageSupportInUploadFile",
      "X-Scenario": "OfficeWebIncludedCopilot",
      Referer: "https://m365.cloud.microsoft/",
      ...userAgentHeaders,
      Authorization: `Bearer ${acc.accessToken}`,
    };
    const resp = await fetch("https://substrate.office.com/m365Copilot/UploadFile", {
      method: "POST",
      headers,
      body: form.toString(),
    });
    if (!resp.ok) continue;
    let out: Record<string, unknown>;
    try {
      out = (await resp.json()) as Record<string, unknown>;
    } catch {
      continue;
    }
    const result = out["result"] as Record<string, unknown> | undefined;
    const docId = out["docId"];
    if (result?.["value"] !== "Success" || typeof docId !== "string" || docId === "") continue;
    a.docId = docId;
    const fileType = typeof out["fileType"] === "string" ? out["fileType"].replace(/^\./, "").toLowerCase() : "";
    a.fileType = fileType === "jpeg" ? "jpg" : fileType;
    if (!a.name && typeof out["fileName"] === "string") a.name = out["fileName"];
  }
}

export async function chat(
  acc: ChatAccount,
  req: ChatRequest,
  handlers: ChatHandlers,
  opts: { timeoutMs: number; signal?: AbortSignal }
): Promise<ChatResult> {
  if (!acc.accessToken || !acc.oid || !acc.tid) {
    throw new Error("missing access token / oid / tid");
  }
  if (!req.text.trim() && !(req.attachments && req.attachments.length > 0)) {
    throw new Error("empty prompt and no attachments");
  }
  const tone = req.tone || DEFAULT_TONE;
  let firstTurn = !!req.started;
  let sessionId = req.sessionId || "";
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    firstTurn = true;
  }
  let conversationId = req.conversationId || "";
  if (!conversationId) {
    conversationId = crypto.randomUUID();
    firstTurn = true;
  }
  const requestId = crypto.randomUUID();

  // Upload attachments before opening the chat socket (mirrors the goroutine
  // in client.go; sequential here since the payload send waits for it anyway).
  const attachments = req.attachments ?? [];
  if (attachments.length > 0) {
    await uploadAttachments(acc, conversationId, attachments, {
      Origin: ORIGIN,
      "User-Agent": USER_AGENT,
    });
  }

  // --- Dial ---------------------------------------------------------------
  // A successful Workers outbound WebSocket upgrade answers with HTTP 101
  // (Switching Protocols). resp.ok only covers 2xx, so success is detected by
  // the presence of resp.webSocket — checking resp.ok here would reject every
  // healthy dial as DialError(101).
  //
  // fetch() cannot load wss:// URLs; the WS handshake is performed against
  // the https:// form of the same endpoint while keeping Upgrade: websocket.
  const wsUrl = buildWSURL(acc, sessionId, conversationId, requestId);
  const dialUrl = wsUrl.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
  const dialResp = await fetch(dialUrl, {
    headers: {
      Upgrade: "websocket",
      Origin: ORIGIN,
      "User-Agent": USER_AGENT,
    },
    signal: opts.signal,
  });
  if (!dialResp.webSocket) {
    const status = dialResp.status;
    const retryAfter = Number(dialResp.headers.get("Retry-After") ?? 0) || 0;
    try {
      await dialResp.body?.cancel();
    } catch {
      /* ignore */
    }
    throw new DialError(status, retryAfter);
  }
  const ws = dialResp.webSocket;
  ws.accept();

  return new Promise<ChatResult>((resolve, reject) => {
    let settled = false;
    let handshakeDone = false;

    let streamed = "";
    let deltasTotal = "";
    let reasoningBuf = "";
    let finalText = "";
    let rawResult = "";
    let throttling: unknown;
    const events: unknown[] = [];

    const deadline = setTimeout(() => {
      finish(new Error("chathub response deadline exceeded before completion"));
    }, opts.timeoutMs);
    function cleanup() {
      clearTimeout(deadline);
      clearTimeout(idleTimer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }

    function finish(err: unknown, result?: ChatResult) {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(result!);
    }

    // Idle watchdog mirrors the 90s read deadline in client.go.
    let idleTimer = setTimeout(() => {
      finish(new Error("ws read before completion: idle timeout"));
    }, 90_000);
    const bumpIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        finish(new Error("ws read before completion: idle timeout"));
      }, 90_000);
    };

    ws.addEventListener("close", () => {
      if (!settled) {
        finish(new Error("ws read before completion: connection closed"));
      }
    });
    ws.addEventListener("error", () => {
      if (!settled) {
        finish(new Error("ws read before completion: connection error"));
      }
    });

    ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS);

    let firstDeltaLogged = false;

    function emitDelta(d: string): string | null {
      if (d === "") return null;
      if (!firstDeltaLogged) {
        firstDeltaLogged = true;
      }
      streamed += d;
      deltasTotal += d;
      try {
        handlers.onDelta?.(d);
      } catch {
        /* consumer errors are ignored like Go's nil handler path */
      }
      return d;
    }

    function emitSnapshot(snapshot: string): string | null {
      if (snapshot === "") return null;
      if (streamed.length === 0 && rateLimitedText(snapshot)) {
        throw new RateLimitNotice();
      }
      const cur = streamed;
      if (cur === "") return emitDelta(snapshot);
      if (snapshot.startsWith(cur)) return emitDelta(snapshot.slice(cur.length));
      if (snapshot.length <= cur.length) return null;
      // non-prefix rewrite: skip (mirrors upstream logging behavior)
      return null;
    }

    ws.addEventListener("message", (ev: MessageEvent) => {
      if (settled) return;
      bumpIdle();
      const data = typeof ev.data === "string" ? ev.data : "";
      let frames: Frame[];
      try {
        frames = parseFrames(data);
      } catch {
        return;
      }
      if (!handshakeDone) {
        // First frame is the SignalR handshake ack; only then send the chat
        // invocation (mirrors client.go's handshake recv before payload send).
        handshakeDone = true;
        try {
          ws.send(
            chatPayload(req.text, sessionId, conversationId, requestId, tone, firstTurn, attachments, req)
          );
        } catch (e) {
          finish(e);
        }
        return;
      }
      for (const obj of frames) {
        events.push(obj);
        const t = Number(obj.type ?? 0);
        const target = obj.target ?? "";

        if (t === 6) {
          try {
            ws.send(JSON.stringify({ type: 6 }) + RS);
          } catch {
            /* ignore */
          }
          continue;
        }

        if (t === 1 && target === "update") {
          const args = Array.isArray(obj.arguments) ? obj.arguments : [];
          for (const raw of args) {
            if (!raw || typeof raw !== "object") continue;
            const arg = raw as Record<string, unknown>;
            const msgs = Array.isArray(arg["messages"]) ? arg["messages"] : [];

            for (const ev2 of classifyUpdateMessages(msgs)) {
              if (ev2.kind === "reasoning") reasoningBuf += ev2.text;
            }

            let toolFrame = false;
            for (const mraw of msgs) {
              if (!mraw || typeof mraw !== "object") continue;
              const m = mraw as Record<string, unknown>;
              const mt = typeof m["messageType"] === "string" ? m["messageType"] : "";
              const ct = typeof m["contentType"] === "string" ? m["contentType"] : "";
              if (mt === "Progress" || ct === "SearchResults" || ct === "Code" || ct === "ToolCall") {
                toolFrame = true;
              }
            }
            if ("throttling" in arg) throttling = arg["throttling"];
            const w = arg["writeAtCursor"];
            if (typeof w === "string" && w !== "" && !toolFrame) {
              try {
                emitSnapshot(w);
              } catch (e) {
                finish(e);
                return;
              }
            }
            for (const mraw of msgs) {
              if (!mraw || typeof mraw !== "object") continue;
              const m = mraw as Record<string, unknown>;
              const author = typeof m["author"] === "string" ? m["author"] : "";
              const text = typeof m["text"] === "string" ? m["text"] : "";
              const mt = typeof m["messageType"] === "string" ? m["messageType"] : "";
              if (author === "bot" && mt === "" && text !== "") {
                try {
                  emitSnapshot(text);
                } catch (e) {
                  finish(e);
                  return;
                }
              }
            }
          }
          continue;
        }

        if (t === 2) {
          const item = obj.item;
          if (item && typeof item === "object") {
            const it = item as Record<string, unknown>;
            if ("throttling" in it) throttling = it["throttling"];
            const res = it["result"];
            if (res && typeof res === "object") {
              const r = res as Record<string, unknown>;
              rawResult = typeof r["value"] === "string" ? r["value"] : "";
              if (typeof r["message"] === "string") {
                finalText = r["message"];
                if (rateLimitedText(finalText)) {
                  finish(new RateLimitNotice());
                  return;
                }
              }
            }
          }
          continue;
        }

        if (t === 3) {
          if (obj.error && typeof obj.error === "object") {
            finish(new Error(`chathub completion error: ${JSON.stringify(obj.error)}`));
            return;
          }
          let text = streamed;
          if (text === "") text = finalText;
          if (text === "") text = deltasTotal;
          if (rateLimitedText(text)) {
            finish(new RateLimitNotice());
            return;
          }
          if (text === "") {
            finish(new EmptyCompletion());
            return;
          }
          finish(null, {
            text,
            reasoning: reasoningBuf,
            conversationId,
            sessionId,
            requestId,
            throttling,
            rawResult,
            events,
            images: imageURLs(events),
          });
          return;
        }
      }
    });
  });
}

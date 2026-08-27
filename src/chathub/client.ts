// ChatHub WebSocket client for the Workers runtime
// (port of internal/chathub/client.go chatWithHandlers).
//
// Parity: emitSnapshot detectors (rate/image-limit/content-policy), token-level
// writeAtCursor deltas, finalizeText tail reconciliation, full Result field
// extraction and native tool-event callbacks (api-flow-code-diff A4/A7/B12-B14).

import {
  RS,
  DEFAULT_TONE,
  USER_AGENT,
  ORIGIN,
  buildWSURL,
  chatPayload,
  rateLimitedText,
  imageLimitText,
  contentPolicyText,
  classifyUpdateMessages,
  imageURLs,
  type ChatAccount,
  type ChatRequest,
  type ChatResult,
  type Attachment,
  type SuggestedResponse,
  type Score,
  type Reference,
  type Timestamps,
} from "./protocol";
import {
  DialError,
  EmptyCompletion,
  RateLimitNotice,
  ImageLimitError,
  ContentPolicyError,
  dialErrorKind,
} from "../errors";

export interface ChatHandlers {
  onDelta?: (text: string) => void;
  onReasoning?: (text: string) => void;
  // Native tool invocation observed in ChatHub frames (kind="tool" from
  // extractToolEvents). Mirrors upstream StreamHandler tool events (A4).
  onTool?: (name: string, args: unknown) => void;
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
const MAX_ATTACHMENT_MIB = 10;

// Port of chathub.validateRemoteDownloadURL (ssrf.go, C2): only https and
// public routable addresses are accepted. Workers cannot do a DNS recheck at
// runtime, so IP literals in unsafe ranges are rejected up front; hostnames
// are revalidated at every redirect hop like the upstream downloadClient.
function validateRemoteDownloadURL(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "invalid attachment URL";
  }
  if (u.protocol !== "https:") return "attachment download requires https";
  const host = u.hostname;
  if (host === "") return "attachment URL has no host";
  const ipMatch = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipMatch) {
    const octets = ipMatch.slice(1).map(Number);
    if (octets.some((o) => o > 255)) return "invalid attachment URL";
    const [a, b] = octets;
    const unsafe =
      a === 127 || // loopback
      a === 10 || // private 10/8
      (a === 172 && b >= 16 && b <= 31) || // private 172.16/12
      (a === 192 && b === 168) || // private 192.168/16
      (a === 169 && b === 254) || // link-local / cloud metadata 169.254/16
      (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
      a === 0 || // unspecified
      a >= 224; // multicast
    if (unsafe) return "attachment URL targets a non-public address";
  } else {
    // Belt-and-braces hostname guards for the cloud metadata well-known name.
    const h = host.toLowerCase();
    if (h === "169.254.169.254.nip.io" || h.endsWith(".internal") || h.endsWith(".local")) {
      return "attachment URL targets a non-public address";
    }
  }
  return null;
}

// Workers port of downloadClient: fetch with manual redirect handling, every
// hop revalidated and capped like upstream (5 hops, 10 MiB body).
async function downloadImage(raw: string): Promise<string | null> {
  let url = raw;
  for (let hop = 0; hop < 5; hop++) {
    const err = validateRemoteDownloadURL(url);
    if (err) return null;
    const resp = await fetch(url, { redirect: "manual" });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location");
      if (!loc) return null;
      url = new URL(loc, url).toString();
      continue;
    }
    if (!resp.ok) return null;
    const mime = resp.headers.get("content-type") ?? "image/png";
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.byteLength > MAX_ATTACHMENT_MIB << 20) return null;
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) {
      binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
    }
    return `data:${mime};base64,${btoa(binary)}`;
  }
  return null;
}

// Port of Client.uploadAttachments: images are uploaded to the UploadFile
// endpoint (x-www-form-urlencoded, NOT multipart) and mutated with docId.
// Remote https URLs are downloaded first with SSRF + redirect guards (C2),
// and the data URL is validated (base64, ;base64 marker) before upload.
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
    let imageData = a.url;
    if (!imageData.startsWith("data:")) {
      const downloaded = await downloadImage(imageData);
      if (downloaded === null) continue;
      imageData = downloaded;
    }
    // Upstream validation: comma separator + ;base64 marker + decodable body.
    const comma = imageData.indexOf(",");
    if (comma < 0) continue;
    if (!imageData.slice(0, comma).toLowerCase().includes(";base64")) continue;
    try {
      atob(imageData.slice(comma + 1));
    } catch {
      continue;
    }
    const form = new URLSearchParams();
    form.set("scenario", "UploadImage");
    form.set("conversationId", conversationID);
    // The browser sends the complete data URL in FileBase64.
    form.set("FileBase64", imageData);
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
  const wsUrl = buildWSURL(acc, sessionId, conversationId, requestId, {
    disableMemory: req.disableMemory,
    licenseType: req.licenseType,
    scenario: req.scenario,
  });
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
    throw new DialError(status, retryAfter, dialErrorKind(status));
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
    let conversationTransferToken = "";
    let meteringInformation: unknown;
    let offense = "";
    let spokenText = "";
    let storageMessageId = "";
    let skippedSnapshots = 0;
    const suggestions: SuggestedResponse[] = [];
    const scores: Score[] = [];
    const references: Record<string, Reference> = {};
    const seenStreamTools = new Set<string>();
    const events: unknown[] = [];
    const timestamps: Timestamps = { requestSent: new Date().toISOString() };
    let firstServiceResponse = false;

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
        timestamps.firstTokenReceived = new Date().toISOString();
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
      // Detector order matches client.go: image limit, then rate limit, then
      // content policy — all only meaningful before any real content streamed.
      if (imageLimitText(snapshot)) throw new ImageLimitError();
      if (rateLimitedText(snapshot)) throw new RateLimitNotice();
      if (contentPolicyText(snapshot)) throw new ContentPolicyError();
      const cur = streamed;
      if (cur === "") return emitDelta(snapshot);
      if (snapshot.startsWith(cur)) return emitDelta(snapshot.slice(cur.length));
      if (snapshot.length <= cur.length) return null;
      // non-prefix rewrite: skip (mirrors upstream skippedSnapshots; the tail
      // is reconciled by finalizeText on completion).
      skippedSnapshots++;
      return null;
    }

    // Port of finalizeText (#51): reconcile the incrementally streamed text
    // against the authoritative final message; emit any missing tail so
    // streaming clients receive the complete answer.
    function finalizeText(): string {
      if (finalText === "" || finalText.length <= streamed.length) {
        return streamed === "" ? finalText : streamed;
      }
      if (finalText.startsWith(streamed)) {
        const tail = finalText.slice(streamed.length);
        emitDelta(tail);
        return finalText;
      }
      // streamed diverged — already-sent deltas cannot be retracted, but the
      // final message is returned as the Result text.
      return finalText;
    }

    // Port of extractToolFields / extractToolEvents (stream_events.go) with a
    // cross-frame seen set; every object carrying a name-ish + arguments-ish
    // field counts as a tool invocation (native plugin calls live outside
    // messages[]).
    const TOOL_NAME_KEYS = ["name", "toolName", "pluginName", "functionName"];
    const TOOL_ARGS_KEYS = ["arguments", "args", "parameters", "input", "functionArguments"];
    function extractToolEvents(v: unknown): Array<{ name: string; args: unknown }> {
      const out: Array<{ name: string; args: unknown }> = [];
      const walk = (x: unknown): void => {
        if (Array.isArray(x)) {
          for (const item of x) walk(item);
          return;
        }
        if (!x || typeof x !== "object") return;
        const m = x as Record<string, unknown>;
        let name = "";
        for (const k of TOOL_NAME_KEYS) {
          const s = m[k];
          if (typeof s === "string" && s.trim() !== "") {
            name = s.trim();
            break;
          }
        }
        if (name !== "") {
          for (const k of TOOL_ARGS_KEYS) {
            if (k in m && m[k] !== null && m[k] !== undefined) {
              const key = name + "|" + JSON.stringify(m[k]);
              if (!seenStreamTools.has(key)) {
                seenStreamTools.add(key);
                out.push({ name, args: m[k] });
              }
              return; // do not descend into the invocation itself
            }
          }
        }
        for (const child of Object.values(m)) walk(child);
      };
      walk(v);
      return out;
    }

    function parseSuggestedResponse(m: Record<string, unknown>): SuggestedResponse {
      return {
        commandText: typeof m["commandText"] === "string" ? m["commandText"] : "",
        text: typeof m["text"] === "string" ? m["text"] : "",
        suggestionCategory: typeof m["suggestionCategory"] === "string" ? m["suggestionCategory"] : undefined,
        contentOrigin: typeof m["contentOrigin"] === "string" ? m["contentOrigin"] : undefined,
        hiddenText: typeof m["hiddenText"] === "string" ? m["hiddenText"] : undefined,
        messageId: typeof m["messageId"] === "string" ? m["messageId"] : undefined,
        author: typeof m["author"] === "string" ? m["author"] : undefined,
        createdAt: typeof m["createdAt"] === "string" ? m["createdAt"] : undefined,
        messageType: typeof m["messageType"] === "string" ? m["messageType"] : undefined,
        offense: typeof m["offense"] === "string" ? m["offense"] : undefined,
      };
    }

    function parseReferences(refs: unknown): void {
      if (!refs || typeof refs !== "object") return;
      for (const [k, v] of Object.entries(refs as Record<string, unknown>)) {
        if (!v || typeof v !== "object") continue;
        const rm = v as Record<string, unknown>;
        const ref: Reference = {
          targetLink: typeof rm["targetLink"] === "string" ? rm["targetLink"] : "",
          providerDisplayName: typeof rm["providerDisplayName"] === "string" ? rm["providerDisplayName"] : undefined,
          title: typeof rm["title"] === "string" ? rm["title"] : undefined,
          snippet: typeof rm["snippet"] === "string" ? rm["snippet"] : undefined,
          lastUpdatedDate: typeof rm["lastUpdatedDate"] === "string" ? rm["lastUpdatedDate"] : undefined,
        };
        if (ref.targetLink !== "" || ref.title !== "") references[k] = ref;
      }
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
            chatPayload(req.text, sessionId, conversationId, requestId, tone, firstTurn, attachments, {
              toolPlugins: req.toolPlugins,
              mcpServerUrl: req.mcpServerUrl,
              featureFlags: req.featureFlags,
              tools: req.tools,
              toolChoice: req.toolChoice,
              locale: req.locale,
              market: req.market,
              timeZone: req.timeZone,
              timeZoneOffset: req.timeZoneOffset,
              deviceOS: req.deviceOS,
              disableMemory: req.disableMemory,
              previousMessages: req.previousMessages,
              connectedFederatedIds: req.connectedFederatedIds,
            })
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

            // Native tool events anywhere in the frame (A4).
            if (handlers.onTool) {
              for (const te of extractToolEvents(arg)) {
                try {
                  handlers.onTool(te.name, te.args);
                } catch {
                  /* consumer errors ignored */
                }
              }
            }

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
            if (typeof arg["conversationTransferToken"] === "string" && arg["conversationTransferToken"] !== "") {
              conversationTransferToken = arg["conversationTransferToken"] as string;
            }
            if (arg["meteringInformation"] != null) meteringInformation = arg["meteringInformation"];
            if (Array.isArray(arg["suggestedResponses"])) {
              for (const srRaw of arg["suggestedResponses"] as unknown[]) {
                if (srRaw && typeof srRaw === "object") suggestions.push(parseSuggestedResponse(srRaw as Record<string, unknown>));
              }
            }
            // writeAtCursor: pure append fragment once a baseline exists —
            // forward as a delta for token-level streaming (B12).
            const w = arg["writeAtCursor"];
            if (typeof w === "string" && w !== "" && !toolFrame) {
              try {
                if (streamed !== "") emitDelta(w);
                else emitSnapshot(w);
              } catch (e) {
                finish(e);
                return;
              }
            }
            // patches → spokenText (B14).
            if (Array.isArray(arg["patches"])) {
              for (const praw of arg["patches"] as unknown[]) {
                if (!praw || typeof praw !== "object") continue;
                const p = praw as Record<string, unknown>;
                if (p["op"] !== "replace" || typeof p["path"] !== "string") continue;
                const path = (p["path"] as string).split("/").filter(Boolean);
                if (path[0] !== "message" || path[1] !== "spokenText") continue;
                if (typeof p["value"] === "string") spokenText = p["value"] as string;
              }
            }
            // arg-level references.
            parseReferences(arg["references"]);
            for (const mraw of msgs) {
              if (!mraw || typeof mraw !== "object") continue;
              const m = mraw as Record<string, unknown>;
              const author = typeof m["author"] === "string" ? m["author"] : "";
              const text = typeof m["text"] === "string" ? m["text"] : "";
              const mt = typeof m["messageType"] === "string" ? m["messageType"] : "";
              // offense / scores / spokenText / suggestedResponses / refs.
              const o = m["offense"];
              if (typeof o === "string" && o !== "" && o !== "Unknown" && o !== "None") offense = o;
              if (Array.isArray(m["scores"])) {
                for (const sraw of m["scores"] as unknown[]) {
                  if (!sraw || typeof sraw !== "object") continue;
                  const sm = sraw as Record<string, unknown>;
                  const comp = sm["component"];
                  const sc = sm["score"];
                  if (typeof comp === "string" && comp !== "" && typeof sc === "number") {
                    scores.push({ component: comp, score: sc });
                  }
                }
              }
              if (typeof m["spokenText"] === "string") spokenText = m["spokenText"] as string;
              if (Array.isArray(m["suggestedResponses"]) && (m["suggestedResponses"] as unknown[]).length > 0) {
                for (const srRaw of m["suggestedResponses"] as unknown[]) {
                  if (srRaw && typeof srRaw === "object") suggestions.push(parseSuggestedResponse(srRaw as Record<string, unknown>));
                }
              }
              parseReferences(m["references"]);
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
            if (typeof it["storageMessageId"] === "string" && it["storageMessageId"] !== "") {
              storageMessageId = it["storageMessageId"] as string;
            }
            if ("throttling" in it) throttling = it["throttling"];
            if (typeof it["conversationTransferToken"] === "string" && it["conversationTransferToken"] !== "") {
              conversationTransferToken = it["conversationTransferToken"] as string;
            }
            if (Array.isArray(it["suggestedResponses"]) && suggestions.length === 0) {
              for (const s of it["suggestedResponses"] as unknown[]) {
                if (s && typeof s === "object") {
                  const sr = parseSuggestedResponse(s as Record<string, unknown>);
                  if (sr.commandText !== "" || sr.text !== "") suggestions.push(sr);
                }
              }
            }
            const res = it["result"];
            if (res && typeof res === "object") {
              const r = res as Record<string, unknown>;
              rawResult = typeof r["value"] === "string" ? r["value"] : "";
              if (r["meteringInformation"] != null) meteringInformation = r["meteringInformation"];
              if (typeof r["message"] === "string") {
                finalText = r["message"] as string;
                try {
                  if (imageLimitText(finalText)) throw new ImageLimitError();
                  if (rateLimitedText(finalText)) throw new RateLimitNotice();
                  if (contentPolicyText(finalText)) throw new ContentPolicyError();
                } catch (e) {
                  finish(e);
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
          timestamps.lastTokenReceived = new Date().toISOString();
          // Guard against streaming a rate-limit notice out as content.
          if (rateLimitedText(finalText)) {
            finish(new RateLimitNotice());
            return;
          }
          // Reconcile streamed text with the authoritative final message (B13).
          let text = finalizeText();
          if (text === "") text = deltasTotal;
          try {
            if (imageLimitText(text)) throw new ImageLimitError();
            if (rateLimitedText(text)) throw new RateLimitNotice();
          } catch (e) {
            finish(e);
            return;
          }
          if (offense !== "") {
            finish(new ContentPolicyError());
            return;
          }
          if (contentPolicyText(text)) {
            finish(new ContentPolicyError());
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
            suggestedResponses: suggestions,
            offense,
            scores,
            conversationTransferToken,
            meteringInformation,
            spokenText,
            storageMessageId,
            references: Object.keys(references).length > 0 ? references : undefined,
            timestamps,
          });
          return;
        }
      }
    });
  });
}

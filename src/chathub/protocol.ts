// ChatHub SignalR protocol layer (port of internal/chathub).
//
// The upstream Go implementation speaks SignalR's JSON protocol over a
// WebSocket to wss://substrate.office.com/m365Copilot/Chathub: handshake
// frame, "\x1e"-separated records, ping keepalive, invocation (type 1)
// "update" targets with cursor snapshots, stream items (type 2) and
// completion (type 3). This module mirrors that behavior on the Workers
// runtime using fetch() WebSocket upgrades.

export const RS = "\x1e";
export const DEFAULT_TONE = "magic";
export const WS_BASE = "wss://substrate.office.com/m365Copilot/Chathub";

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0";
export const ORIGIN = "https://m365.cloud.microsoft";

// Variants mirrored from the verified browser / Python probe (verbatim from
// client.go — protocol sensitive).
export const VARIANTS =
  "EnableMcpServerWidgets,feature.EnableMcpServerWidgets,feature.EnableLuForChatCIQ,feature.enableChatCIQPlugin,EnableRequestPlugins,feature.EnableSensitivityLabels,EnableUnsupportedUrlDetector,feature.IsCustomEngineCopilotEnabled,feature.bizchatfluxv3,feature.enablechatpages,feature.enableCodeCanvas,feature.turnOnWorkTabRecommendation,turnOffWorkTabUpsellFromClient,feature.turnOnDARecommendation,feature.IsStreamingModeInChatRequestEnabled,IncludeSourceAttributionsConcise,SkipPublishEmptyMessage,feature.EnableDeduplicatingSourceAttributions,Enable3PActionProgressMessages,feature.enableClientWebRtc,feature.EnableMeetingRecapOfSeriesMeetingWithCiq,feature.EnableReferencesListCompleteSignal,feature.StorageMessageSplitDisabled,feature.EnableCuaTakeControlApi,feature.cwcallowedos,feature.disabledisallowedmsgs,feature.enableCitationsForSynthesisData,feature.enableGenerateGraphicArtOptionsSet,cdximagen,feature.EnableUpdatedUXForConfirmationDialog,feature.EnableClientFileURLSupportForOfficeWebPaidCopilot,feature.EnableDesignEditorImageGrounding,feature.EnableDesignerEditor,feature.OfficeWebToHelix,feature.OfficeDesktopToHelix,feature.M365TeamsHubToHelix,feature.OwaHubToHelix,feature.MonarchHubToHelix,feature.Win32OutlookHubToHelix,feature.MacOutlookHubToHelix,Agt_bizchat_enableGpt5ForHelix";

export interface ChatAccount {
  accessToken: string;
  oid: string;
  tid: string;
}

// Port of chathub.Attachment.
export interface Attachment {
  type: string; // "image" | "file" | "audio"
  url: string; // data URL or https URL
  mimeType?: string;
  name?: string;
  docId?: string;
  fileType?: string;
}

export interface ChatRequest {
  text: string;
  tone?: string;
  conversationId?: string;
  sessionId?: string;
  started?: boolean;
  attachments?: Attachment[];
}

export interface ChatResult {
  text: string;
  reasoning: string;
  conversationId: string;
  sessionId: string;
  requestId: string;
  throttling?: unknown;
  rawResult: string;
  events: unknown[]; // parsed SignalR frames for downstream consumers
  images: string[]; // image URLs extracted from events
}

// buildWSURL is a faithful port of chathub.buildWSURL.
export function buildWSURL(acc: ChatAccount, sessionID: string, conversationID: string, requestID: string): string {
  const q = new URLSearchParams();
  q.set("chatsessionid", requestID);
  q.set("clientrequestid", requestID);
  q.set("X-SessionId", sessionID);
  q.set("ConversationId", conversationID);
  q.set("access_token", acc.accessToken);
  q.set("variants", VARIANTS);
  // source must keep quotes like the browser probe
  q.set("source", `"officeweb"`);
  q.set("product", "Office");
  q.set("agentHost", "Bizchat.FullScreen");
  q.set("licenseType", "Starter");
  q.set("agent", "web");
  q.set("scenario", "OfficeWebIncludedCopilot");
  return `${WS_BASE}/${acc.oid}@${acc.tid}?${q.toString()}`;
}

// chatPayload is a faithful port of chathub.chatPayload including the
// multimodal attachment annotation injection path.
export function chatPayload(
  text: string,
  sessionID: string,
  conversationID: string,
  requestID: string,
  tone: string,
  firstTurn: boolean,
  attachments: Attachment[] = []
): string {
  const uploaded = attachments.filter((a) => a.type === "image" && a.docId);
  const message: Record<string, unknown> = {
    author: "user",
    attachments,
    inputMethod: "Keyboard",
    text,
    entityAnnotationTypes: ["People", "File", "Event", "Email", "TeamsMessage"],
    requestId: requestID,
    locationInfo: { timeZoneOffset: 8, timeZone: "Asia/Shanghai" },
    locale: "zh-cn",
    messageType: "Chat",
    experienceType: "Default",
    adaptiveCards: [],
    clientPreferences: {},
  };
  // File annotations after the upload (Office flow).
  if (uploaded.length > 0) {
    const annotations = uploaded.map((a) => ({
      id: a.docId,
      messageAnnotationMetadata: {
        "@type": "File",
        annotationType: "File",
        fileType: a.fileType || (a.mimeType ? a.mimeType.replace(/^image\//, "").toLowerCase() : "") || "jpg",
        fileName: a.name || `image.${a.fileType || "jpg"}`,
      },
      messageAnnotationType: "ImageFile",
    }));
    message["messageAnnotations"] = annotations;
    message["connectedFederatedConnections"] = ["dummyId"];
  }
  // Historical gateway path: merge imageUrl/imageBase64 directly into message.
  for (const a of attachments) {
    if (a.type !== "image" || !a.url) continue;
    if (a.url.startsWith("data:")) {
      const comma = a.url.indexOf(",");
      if (comma >= 0 && comma + 1 < a.url.length) {
        message["imageBase64"] = a.url.slice(comma + 1);
      }
    } else {
      message["imageUrl"] = a.url;
    }
    break;
  }
  const optionsSets = [
    "search_result_progress_messages_with_search_queries",
    "update_textdoc_response_after_streaming",
    "deepleo_networking_timeout_10minutes_canmore",
    "cwc_flux_image",
    "cwcfluxgptv",
    "flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch",
    "gptvnorm2048",
    "cwc_fileupload_odb",
    "update_memory_plugin",
    "add_custom_instructions",
    "cwc_flux_v3",
    "flux_v3_progress_messages",
    "enable_batch_token_processing",
    "enable_gg_gpt",
  ];
  const chat = {
    arguments: [
      {
        source: "officeweb",
        clientCorrelationId: crypto.randomUUID(),
        sessionId: sessionID,
        optionsSets,
        options: {},
        allowedMessageTypes: [
          "Chat",
          "Suggestion",
          "Disengaged",
          "Progress",
          "EndOfRequest",
          "InternalLoaderMessage",
        ],
        sliceIds: [],
        threadLevelGptId: {},
        conversationId: conversationID,
        traceId: crypto.randomUUID(),
        isStartOfSession: firstTurn,
        productThreadType: "Office",
        clientInfo: {
          clientPlatform: "mcmcopilot-web",
          clientAppName: "Office",
        },
        tone,
        streamingMode: "ConciseWithPadding",
        message,
        plugins: [],
      },
    ],
    invocationId: "0",
    target: "chat",
    type: 4,
  };
  const metrics = {
    arguments: [
      {
        Timestamps: {
          ConnectionStart: "",
          UserInputStart: "",
          ConnectionEstablished: "",
          UserInputSubmit: "",
        },
      },
    ],
    target: "Metrics",
    type: 1,
  };
  return JSON.stringify(chat) + RS + JSON.stringify(metrics) + RS;
}

// rateLimitedText mirrors the human-readable throttle detection in client.go.
export function rateLimitedText(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("temporarily unable to respond to this many requests") ||
    t.includes("太多请求") ||
    t.includes("无法响应这么多请求") ||
    t.includes("too many requests") ||
    (t.includes("please retry") && t.includes("later"))
  );
}

export interface ParsedUpdateMessagesEvent {
  kind: "text" | "progress" | "reasoning";
  text: string;
}

// Port of isImageURL from chathub/images.go.
export function isImageURL(s: string): boolean {
  if (s.startsWith("data:image/")) {
    try {
      const b64 = s.split(",", 2)[1] ?? "";
      atob(b64);
      return true;
    } catch {
      return false;
    }
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const p = (u.pathname + "?" + u.search).toLowerCase();
  if (p.includes("image")) return true;
  return /\.(png|jpe?g|webp|gif)(&|$)/.test(p);
}

// Port of imageURLs from chathub/images.go.
export function imageURLs(rawFrames: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const e of v) walk(e);
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, e] of Object.entries(v as Record<string, unknown>)) {
        const lk = k.toLowerCase();
        if (typeof e === "string" && ["url", "imageurl", "thumbnailurl", "downloadurl", "src", "value", "data"].includes(lk)) {
          if (isImageURL(e) && !seen.has(e)) {
            seen.add(e);
            out.push(e);
          }
          continue;
        }
        if (Array.isArray(e) && lk.includes("url")) {
          for (const item of e) {
            if (typeof item === "string" && isImageURL(item) && !seen.has(item)) {
              seen.add(item);
              out.push(item);
            }
          }
          continue;
        }
        walk(e);
      }
    }
  };
  for (const r of rawFrames) walk(r);
  return out;
}

// Port of Event / normalize() from events.go.
export interface NormalizedEvent {
  type?: number;
  target?: string;
  invocationId?: string;
  kind: string;
}

export function normalizeFrame(f: FrameLike): NormalizedEvent {
  const type = Number(f.type ?? 0);
  const target = typeof f.target === "string" ? f.target : "";
  let kind = "unknown";
  if (type === 6) kind = "ping";
  else if (type === 1 && target === "update") kind = "update";
  else if (type === 2) kind = "result";
  else if (type === 3 && f.error !== undefined) kind = "error";
  else if (type === 3) kind = "complete";
  else if (target !== "") kind = "target";
  return {
    type,
    target,
    invocationId: typeof f.invocationId === "string" ? f.invocationId : undefined,
    kind,
  };
}

interface FrameLike {
  type?: unknown;
  target?: unknown;
  invocationId?: unknown;
  error?: unknown;
  arguments?: unknown;
  item?: unknown;
}

// Port of SemanticEvents() from events.go (search/code/tool progress cards).
export interface SemanticEvent {
  kind: string;
  contentType?: string;
  messageType?: string;
  text?: string;
  queries?: string[];
  hiddenText?: string;
}

export function semanticEvents(frames: FrameLike[]): SemanticEvent[] {
  const out: SemanticEvent[] = [];
  for (const f of frames) {
    const n = normalizeFrame(f);
    if (n.kind !== "update") continue;
    const args = Array.isArray(f.arguments) ? f.arguments : [];
    for (const raw of args) {
      if (!raw || typeof raw !== "object") continue;
      const arg = raw as Record<string, unknown>;
      const msgs = Array.isArray(arg["messages"]) ? arg["messages"] : [];
      for (const mraw of msgs) {
        if (!mraw || typeof mraw !== "object") continue;
        const m = mraw as Record<string, unknown>;
        const contentType = typeof m["contentType"] === "string" ? m["contentType"] : "";
        const messageType = typeof m["messageType"] === "string" ? m["messageType"] : "";
        let kind = "message";
        if (contentType === "SearchResults") kind = "search.progress";
        else if (contentType === "Code") kind = "code.progress";
        if (messageType === "Progress" && kind === "message") kind = "tool.progress";
        out.push({
          kind,
          contentType,
          messageType,
          text: typeof m["text"] === "string" ? m["text"] : "",
          queries: Array.isArray(m["searchQueries"]) ? (m["searchQueries"] as string[]) : undefined,
          hiddenText: typeof m["hiddenText"] === "string" ? m["hiddenText"] : undefined,
        });
      }
    }
  }
  return out;
}

// classifyUpdateMessages ports stream_events.go classifyUpdateMessages for the
// fields this gateway consumes.
export function classifyUpdateMessages(messages: unknown[]): ParsedUpdateMessagesEvent[] {
  const out: ParsedUpdateMessagesEvent[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    const text = typeof m["text"] === "string" ? m["text"] : "";
    const mt = typeof m["messageType"] === "string" ? m["messageType"] : "";
    const ct = typeof m["contentType"] === "string" ? m["contentType"] : "";
    const origin = typeof m["contentOrigin"] === "string" ? m["contentOrigin"] : "";
    const cot = m["addToChainOfThought"] === true;
    let kind: "text" | "progress" | "reasoning" = "text";
    if (mt === "Progress" || ct === "SearchResults" || ct === "Code" || ct === "ToolCall") {
      kind = "progress";
    }
    if (origin === "ChainOfThoughtSummary" || cot) {
      kind = "reasoning";
    }
    if (text === "" && kind === "text") continue;
    out.push({ kind, text });
  }
  return out;
}

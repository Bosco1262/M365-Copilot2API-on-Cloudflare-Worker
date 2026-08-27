// ChatHub SignalR protocol layer (port of internal/chathub).
//
// The upstream Go implementation speaks SignalR's JSON protocol over a
// WebSocket to wss://substrate.office.com/m365Copilot/Chathub: handshake
// frame, "\x1e"-separated records, ping keepalive, invocation (type 1)
// "update" targets with cursor snapshots, stream items (type 2) and
// completion (type 3). This module mirrors that behavior on the Workers
// runtime using fetch() WebSocket upgrades.
//
// Parity note: the payload shapes below are kept in lock-step with
// internal/chathub/client.go (variants / optionsSets / allowedMessageTypes /
// clientInfo / Metrics timestamps) — see docs/api-flow-code-diff.md B1-B13.

export const RS = "\x1e";
export const DEFAULT_TONE = "Magic";
export const WS_BASE = "wss://substrate.office.com/m365Copilot/Chathub";

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0";
export const ORIGIN = "https://m365.cloud.microsoft";

// Variants mirrored from the verified browser / Python probe (verbatim from
// client.go — protocol sensitive). 62 entries, including the imagegen /
// references / code-interpreter / memory feature gates.
export const VARIANTS =
  "EnableMcpServerWidgets,feature.EnableMcpServerWidgets,feature.EnableLuForChatCIQ,feature.enableChatCIQPlugin,EnableRequestPlugins,feature.EnableSensitivityLabels,EnableUnsupportedUrlDetector,feature.IsCustomEngineCopilotEnabled,feature.bizchatfluxv3,feature.enablechatpages,feature.enableCodeCanvas,feature.turnOnDARecommendation,feature.IsStreamingModeInChatRequestEnabled,IncludeSourceAttributionsConcise,SkipPublishEmptyMessage,feature.EnableDeduplicatingSourceAttributions,Enable3PActionProgressMessages,feature.enableClientWebRtc,feature.EnableMeetingRecapOfSeriesMeetingWithCiq,feature.EnableReferencesListCompleteSignal,feature.StorageMessageSplitDisabled,feature.cwcallowedos,feature.disabledisallowedmsgs,feature.enableCitationsForSynthesisData,feature.enableGenerateGraphicArtOptionsSet,cdximagen,feature.EnableUpdatedUXForConfirmationDialog,feature.EnableClientFileURLSupportForOfficeWebPaidCopilot,feature.EnableDesignEditorImageGrounding,feature.EnableDesignerEditor,feature.OfficeWebToHelix,feature.OfficeDesktopToHelix,feature.M365TeamsHubToHelix,feature.OwaHubToHelix,feature.MonarchHubToHelix,feature.Win32OutlookHubToHelix,feature.MacOutlookHubToHelix,Agt_bizchat_enableGpt5ForHelix,feature.EnableImageGenInsufficientTokensThrottled,feature.EnableImageGenSystemCapacityThrottled,feature.EnableConversationShareApis,feature.IsCitationsReferencesOutputEnabled,feature.enableDeltaStreamingForReferences,feature.enableIncludeReferencesInDeltaResponse,feature.enablereferencesforagents,feature.EnableMergingPureDeltas,feature.EnableRemoveStreamingMode,feature.EnableCodeInterpreterConversion,agt_module_attr_enableReferencesForCodeInterpreter,agt_module_enableCodeInterpreterHallucinatedUrlFilter,SingletonEnvOn,cdxenablefccinmainline,EnableComposeWidget,feature.EnableContentApiandDocTypeHtmlInRichAnswers,cdxgrounding_api_v2_rich_web_answers_reference_bottom_force,cdxenablerenderforisocomp,feature.EnableSkipRehydrationForSpeCIdImages,feature.EnablePersonalization,feature.EnableBase64DataInMessageAnnotations,feature.EnableSkipEmittingMessageOnFlush,feature.EnableRemoveEmptySourceAttributions,agt_researcheragent_enableMemoryRead";

export interface ChatAccount {
  accessToken: string;
  oid: string;
  tid: string;
  licenseType?: string;
  scenario?: string;
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

// Port of chathub.FeatureFlags (8 knobs; only memoryV2 has a verified payload
// effect today, the rest map to optionsSets entries).
export interface FeatureFlags {
  memoryV2: boolean;
  deepWork: boolean;
  computerUse: boolean;
  realtimeVoice: boolean;
  systemPromptOverride: boolean;
  designerImageGen4o: boolean;
  codeCanvas: boolean;
  sydneyReconnect: boolean;
}

// Port of chathub.Tool.
export interface Tool {
  type: string;
  function: Record<string, unknown>;
}

// Port of chathub.ContextMessage (previousMessages entries).
export interface ContextMessage {
  author: string;
  description: string;
  contextType: string;
  messageType: string;
}

export interface ChatRequest {
  text: string;
  tone?: string;
  conversationId?: string;
  sessionId?: string;
  started?: boolean;
  attachments?: Attachment[];
  // Native planning: tools advertised as API plugins; when set the gateway's
  // own /v1/mcp/sse endpoint is offered as the mcp-gateway MCPServer plugin.
  toolPlugins?: { name: string; description?: string; parameters?: unknown }[];
  mcpServerUrl?: string;
  // ChatHub identity fields (configurable via settings since port parity pass)
  licenseType?: string;
  scenario?: string;
  // Feature-flag knobs (feature_flags.go port). All 8 map to optionsSets.
  featureFlags?: Partial<FeatureFlags>;
  // Tool protocol: raw tools + choice drive the <tools> fenced prompt
  // injection (toolProtocolPrompt) and the clientPlugins advertisement.
  tools?: Tool[];
  toolChoice?: unknown;
  // Locale / market / tz / deviceOS parsed from request headers (upstream
  // parseLocaleFromHeaders); defaults en-us / UTC / Windows.
  locale?: string;
  market?: string;
  timeZone?: string;
  timeZoneOffset?: number;
  deviceOS?: string;
  disableMemory?: boolean;
  previousMessages?: ContextMessage[];
  connectedFederatedIds?: string[];
}

// Port of chathub.SuggestedResponse.
export interface SuggestedResponse {
  commandText: string;
  text: string;
  suggestionCategory?: string;
  contentOrigin?: string;
  hiddenText?: string;
  messageId?: string;
  author?: string;
  createdAt?: string;
  messageType?: string;
  offense?: string;
}

// Port of chathub.Score.
export interface Score {
  component: string;
  score: number;
}

// Port of chathub.Reference.
export interface Reference {
  targetLink: string;
  providerDisplayName?: string;
  title?: string;
  snippet?: string;
  lastUpdatedDate?: string;
}

// Port of chathub.Timestamps.
export interface Timestamps {
  requestSent: string;
  firstServiceResponseReceived?: string;
  firstTokenReceived?: string;
  lastTokenReceived?: string;
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
  // Extended result fields (port of chathub.Result — api-flow-code-diff B14).
  suggestedResponses?: SuggestedResponse[];
  offense?: string;
  scores?: Score[];
  conversationTransferToken?: string;
  meteringInformation?: unknown;
  spokenText?: string;
  storageMessageId?: string;
  references?: Record<string, Reference>;
  timestamps?: Timestamps;
}

// Port of chathub clientPlugins.
export function buildChatPlugins(
  tools: Tool[],
  mcpServerUrl: string
): unknown[] {
  const plugins: unknown[] = [];
  if (mcpServerUrl === "" && tools.length === 0) {
    plugins.push({ Id: "BingWebSearch", Source: "BuiltIn" });
  }
  if (mcpServerUrl !== "") {
    plugins.push({
      Id: "mcp-gateway",
      Source: "MCPServer",
      Description: "MCP Gateway tools",
      Transport: "mcp",
      TransportUrl: mcpServerUrl,
      TransportProtocol:
        "https://copilot.microsoft.com/schemas/plugins/local/transport/1.0",
    });
  }
  for (const t of tools) {
    const f = t.function ?? {};
    const name = typeof f["name"] === "string" ? f["name"] : "";
    if (name === "") continue;
    plugins.push({
      Id: name,
      Source: "API",
      Description: typeof f["description"] === "string" ? f["description"] : "",
      Parameters: f["parameters"] ?? {},
    });
  }
  return plugins;
}

// buildWSURL is a faithful port of chathub.buildWSURLWithOptions (incl.
// XRoutingParameterSessionKey / isEdu / disableMemory — B3).
export function buildWSURL(
  acc: ChatAccount,
  sessionID: string,
  conversationID: string,
  requestID: string,
  opts?: { disableMemory?: boolean; licenseType?: string; scenario?: string }
): string {
  const q = new URLSearchParams();
  q.set("chatsessionid", requestID);
  q.set("clientrequestid", requestID);
  q.set("XRoutingParameterSessionKey", requestID);
  q.set("X-SessionId", sessionID);
  q.set("ConversationId", conversationID);
  q.set("access_token", acc.accessToken);
  q.set("variants", VARIANTS);
  // source must keep quotes like the browser probe
  q.set("source", `"officeweb"`);
  q.set("product", "Office");
  q.set("agentHost", "Bizchat.FullScreen");
  q.set("licenseType", opts?.licenseType || acc.licenseType || "Starter");
  q.set("agent", "web");
  q.set("scenario", opts?.scenario || acc.scenario || "OfficeWebIncludedCopilot");
  if (opts?.disableMemory) q.set("disableMemory", "1");
  q.set("isEdu", "false");
  return `${WS_BASE}/${acc.oid}@${acc.tid}?${q.toString()}`;
}

// toolProtocolPrompt follows the community-compatible M365 convention:
// definitions are wrapped in <tools>, and calls are emitted as a fenced block
// whose info string is the exact tool name (port of chathub/tool_protocol.go).
export function toolProtocolPrompt(text: string, tools: Tool[], choice: unknown, hasPlugins: boolean): string {
  if (tools.length === 0 || String(choice ?? "").toLowerCase() === "none") {
    if (hasPlugins) return text;
    return `Please answer the following request in full. Do not truncate or abbreviate your response.\n\n${text}`;
  }
  if (hasPlugins) return text;
  const defs: string[] = [];
  for (const t of tools) {
    const f = t.function ?? {};
    const name = typeof f["name"] === "string" ? f["name"] : "";
    const desc = typeof f["description"] === "string" ? f["description"] : "";
    if (name === "") continue;
    let params = f["parameters"] == null ? "" : JSON.stringify(f["parameters"]).trim();
    if (params === "" || params === "null") params = "{}";
    defs.push(`${name} — ${desc}\n\`\`\`${name}\n${params}\n\`\`\``);
  }
  if (defs.length === 0) return text;
  return `You are an execution agent on the caller's Windows machine. The tools below are real, active, and callable right now. The bash tool runs Windows PowerShell 5.1; Windows paths like D:\\ are directly accessible. Do NOT use any built-in code interpreter, Python sandbox, or cloud execution environment. Do NOT emit backtick-backtick-backtick-python or backtick-backtick-backtick-code blocks for execution — if you need to run code, use the bash tool. Do NOT mention Linux containers, /mnt/data, cloud sandboxes, or claim the execution environment has changed.\nWhen the user's request requires a tool, call it by emitting one or more fenced blocks. Each block's info string is the exact tool name and its body is a JSON object of arguments. For independent operations, emit multiple blocks in one response. Do not analyze whether tools are registered or available — they are. Do not say a tool is unavailable. Do not wrap the call in XML or Markdown prose. Wait for the tool result before claiming completion.\n\n<tools>\n${defs.join("\n\n")}\n</tools>\n\nUser request:\n${text}`;
}

export interface ChatPayloadOpts {
  toolPlugins?: { name: string; description?: string; parameters?: unknown }[];
  mcpServerUrl?: string;
  featureFlags?: Partial<FeatureFlags>;
  tools?: Tool[];
  toolChoice?: unknown;
  locale?: string;
  market?: string;
  timeZone?: string;
  timeZoneOffset?: number;
  deviceOS?: string;
  disableMemory?: boolean;
  previousMessages?: ContextMessage[];
  connectedFederatedIds?: string[];
}

// chatPayload is a faithful port of chathub.chatPayload (client.go 1320-1548):
// clientInfo, 42-entry optionsSets with all 8 feature flags, 30
// allowedMessageTypes, isStartOfSession=false, extraExtensionParameters /
// isSbsSupported / renderReferencesBehindEOS / disconnectBehavior, real
// RFC3339Nano Metrics timestamps, and the toolProtocolPrompt text injection.
export function chatPayload(
  text: string,
  sessionID: string,
  conversationID: string,
  requestID: string,
  tone: string,
  firstTurn: boolean,
  attachments: Attachment[] = [],
  chatOpts?: ChatPayloadOpts
): string {
  void firstTurn; // HAR evidence: isStartOfSession is always false
  const locale = chatOpts?.locale || "en-us";
  const tz = chatOpts?.timeZone || "UTC";
  const tzOffset = chatOpts?.timeZoneOffset ?? 0;
  const deviceOS = chatOpts?.deviceOS || "Windows";
  const tools = chatOpts?.tools ?? [];
  const plugins = buildChatPlugins(tools, chatOpts?.mcpServerUrl ?? "");
  const text2 = toolProtocolPrompt(text, tools, chatOpts?.toolChoice, plugins.length > 0);

  const uploaded = attachments.filter((a) => a.type === "image" && a.docId);
  const federatedConns = chatOpts?.connectedFederatedIds && chatOpts.connectedFederatedIds.length > 0
    ? chatOpts.connectedFederatedIds
    : ["dummyId"];

  const clientInfo: Record<string, unknown> = {
    clientPlatform: "mcmcopilot-web",
    clientAppName: "Office",
    clientEntrypoint: "mcmcopilot-officeweb",
    clientSessionId: sessionID,
    ProductCategory: "Chat",
    clientAppType: "Web",
    productEntryPoint: "ChatPanel",
    deviceOS,
    deviceType: "Desktop",
    clientPlatformVersion: "10",
  };

  const message: Record<string, unknown> = {
    author: "user",
    attachments,
    inputMethod: "Keyboard",
    text: text2,
    entityAnnotationTypes: ["People", "File", "Event", "Email", "TeamsMessage"],
    requestId: requestID,
    locationInfo: { timeZoneOffset: tzOffset, timeZone: tz },
    locale,
    messageType: "Chat",
    experienceType: "Default",
    adaptiveCards: [],
    clientPreferences: {},
    connectedFederatedConnections: federatedConns,
    clientInfo,
  };
  // File annotations after the upload (Office flow).
  if (uploaded.length > 0) {
    const annotations = uploaded.map((a) => {
      let fileType = a.fileType || "";
      if (fileType === "" && a.mimeType) fileType = a.mimeType.replace(/^image\//, "").toLowerCase();
      if (fileType === "" || fileType === "image" || fileType === "*") fileType = "jpg";
      const name = a.name || `image.${fileType}`;
      return {
        id: a.docId,
        messageAnnotationMetadata: {
          "@type": "File",
          annotationType: "File",
          fileType,
          fileName: name,
        },
        messageAnnotationType: "ImageFile",
      };
    });
    message["messageAnnotations"] = annotations;
    message["connectedFederatedConnections"] = federatedConns;
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
  const optionsSets: string[] = [
    "search_result_progress_messages_with_search_queries",
    "update_textdoc_response_after_streaming",
    "deepleo_networking_timeout_10minutes_canmore",
    "cwc_flux_image",
    "cwc_code_interpreter",
    "cwc_code_interpreter_amsfix",
    "cwcfluxgptv",
    "flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch",
    "gptvnorm2048",
    "cwc_code_interpreter_citation_fix",
    "code_interpreter_interactive_charts",
    "cwc_code_interpreter_interactive_charts_inline_image",
    "code_interpreter_matplotlib_patching",
    "cwc_fileupload_odb",
  ];
  const flags = chatOpts?.featureFlags ?? {};
  if (flags.memoryV2 !== false) {
    optionsSets.push("update_memory_plugin", "add_custom_instructions");
  }
  optionsSets.push(
    "cwc_flux_v3",
    "flux_v3_progress_messages",
    "enable_batch_token_processing",
    "enable_gg_gpt",
    "flux_v3_references",
    "flux_v3_references_entities",
    "flux_v3_references_ci",
    "add_filestore_filetype",
    "cwc_code_interpreter_citation_sourceannotations",
    "cdxcwc_code_interpreter_hallucinated_url_filter",
    "flux_v3_image_gen_enable_dimensions",
    "flux_v3_image_gen_enable_non_watermarked_storage",
    "flux_v3_image_gen_enable_icon_dimensions",
    "flux_v3_image_gen_enable_system_text_with_params",
    "flux_v3_image_gen_enable_designer_dimensions_meta_prompting_in_system_prompts",
    "flux_v3_image_gen_enable_story",
    "rich_responses"
  );
  if (flags.deepWork) optionsSets.push("enable_deep_work");
  if (flags.computerUse) optionsSets.push("enable_computer_use");
  if (flags.realtimeVoice) optionsSets.push("enable_realtime_voice");
  if (flags.systemPromptOverride) optionsSets.push("enable_system_prompt_override");
  if (flags.designerImageGen4o) optionsSets.push("enable_designer_image_gen_4o");
  if (flags.codeCanvas) optionsSets.push("feature.enableCodeCanvas");
  if (flags.sydneyReconnect) optionsSets.push("enable_sydney_reconnect");

  const arg0: Record<string, unknown> = {
    source: "officeweb",
    clientCorrelationId: requestID,
    sessionId: sessionID,
    optionsSets,
    options: {},
    allowedMessageTypes: [
      "Chat", "Suggestion", "InternalSearchQuery", "Disengaged",
      "InternalLoaderMessage", "Progress", "GeneratedCode",
      "RenderCardRequest", "AdsQuery", "SemanticSerp",
      "GenerateContentQuery", "GenerateGraphicArt", "SearchQuery",
      "ConfirmationCard", "AuthError", "DeveloperLogs",
      "TriggerPlugin", "HintInvocation", "MemoryUpdate",
      "EndOfRequest", "TriggerConfirmation", "ResumeInvokeAction",
      "ResumeUserInputRequest", "TriggerUserInputRequest",
      "EscapeHatch", "TriggerPluginAuth", "ResumePluginAuth",
      "SideBySide", "ReferencesListComplete", "SwitchRespondingEndpoint",
    ],
    sliceIds: [],
    threadLevelGptId: {},
    // HAR evidence (report 01 F12): all 12 captured sessions send
    // isStartOfSession=false even on the first turn; the WS URL already
    // binds session/conversation identity.
    isStartOfSession: false,
    traceId: requestID,
    clientInfo,
    tone,
    streamingMode: "ConciseWithPadding",
    message,
    plugins,
    extraExtensionParameters: {},
    isSbsSupported: true,
    renderReferencesBehindEOS: true,
    disconnectBehavior: "continue",
  };
  if (chatOpts?.previousMessages && chatOpts.previousMessages.length > 0) {
    arg0["previousMessages"] = chatOpts.previousMessages;
  }
  const chat = {
    arguments: [arg0],
    invocationId: "0",
    target: "chat",
    type: 4,
  };
  const now = new Date();
  const rfc3339 = (d: number): string => new Date(now.getTime() + d).toISOString();
  const connStart = rfc3339(-2000);
  const userInputStart = rfc3339(-2000);
  const connEstab = rfc3339(-500);
  const userInputSubmit = rfc3339(0);
  const metrics = {
    arguments: [
      {
        Timestamps: {
          ConnectionStart: connStart,
          UserInputStart: userInputStart,
          ConnectionEstablished: connEstab,
          UserInputSubmit: userInputSubmit,
          RequestSent: rfc3339(1),
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

// imageLimitText mirrors chathub.imageLimitDetected (A7): the daily image
// generation quota notice on the text channel.
export function imageLimitText(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("无法生成更多图像") ||
    t.includes("unable to generate more images") ||
    t.includes("cannot generate more images today")
  );
}

// contentPolicyText mirrors chathub.IsContentPolicyBlock (A7): the polite
// refusal phrasing M365 uses for content-policy blocks.
const CONTENT_POLICY_PATTERNS = [
  "很抱歉，我无法响应",
  "我很抱歉，我无法响应",
  "很抱歉，我无法",
  "抱歉，我无法",
  "i'm sorry, i can't respond",
  "i'm sorry, i cannot respond",
  "i apologize, i cannot",
];

export function contentPolicyText(text: string): boolean {
  if (text.length > 300) return false;
  const low = text.toLowerCase();
  return CONTENT_POLICY_PATTERNS.some((p) => low.includes(p.toLowerCase()));
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

// Port of chathub.StripCitationMarkers: removes the \uE200cite\uE202…\uE201
// markers and returns the citation target links (used by the console chat
// stream, aligned with chatStream in stream.go).
const CITE_OPEN = "\uE200cite\uE202";
const CITE_CLOSE = "\uE201";

export function stripCitationMarkers(text: string, refs: Record<string, Reference> | undefined): { text: string; urls: string[] } {
  if (!text.includes(CITE_OPEN)) return { text, urls: [] };
  const urls: string[] = [];
  let out = "";
  let remaining = text;
  for (;;) {
    const i = remaining.indexOf(CITE_OPEN);
    if (i < 0) {
      out += remaining;
      break;
    }
    out += remaining.slice(0, i);
    const after = remaining.slice(i + CITE_OPEN.length);
    const j = after.indexOf(CITE_CLOSE);
    if (j < 0) {
      out += remaining.slice(i);
      break;
    }
    const refId = after.slice(0, j);
    remaining = after.slice(j + CITE_CLOSE.length);
    const ref = refs?.[refId];
    if (ref && ref.targetLink !== "") urls.push(ref.targetLink);
  }
  return { text: out, urls };
}

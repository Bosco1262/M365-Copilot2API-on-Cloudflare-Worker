// Runtime settings on KV (port of internal/web/settings.go).

import type { Env } from "../env";
import { getJSON, putJSON } from "../kv";

export interface ModelMapping {
  publicModel: string;
  upstreamTone: string;
  displayName: string;
  defaultReasoningLevel: string;
}

// Port of the upstream M365_ENABLE_* feature-flag knobs (feature_flags.go).
// Only memoryV2 has a verified payload effect today (gates the
// update_memory_plugin / add_custom_instructions optionsSets); the rest are
// stored so console/env configuration survives, but remain inert until each
// flag's upstream payload effect is individually verified.
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

export interface RuntimeSettings {
  maxToolCallsPerTurn: number;
  maxToolRounds: number;
  contextWindow: number;
  maxOutputTokens: number;
  chatTimeoutSeconds: number;
  imageTimeoutSeconds: number;
  logLevel: string;
  debugLogPath: string;
  listenAddress: string;
  configPath: string;
  tokenCachePath: string;
  sessionCachePath: string;
  clientId: string;
  authority: string;
  redirectUri: string;
  scope: string;
  modelMappings: ModelMapping[];
  discoveredTones: string[];
  // Last successful manual/cron tone sync (ISO). Drives the 24h auto-resync.
  discoveredTonesAt: string;
  toolPlanningMode: string;
  // ChatHub identity fields (upstream: settings.go LicenseType/Scenario enums)
  licenseType: string;
  scenario: string;
  // Per-account concurrency cap (upstream account_concurrency default 8).
  // Enforcement lands with the Coordination DO; stored now for parity.
  accountConcurrencyLimit: number;
  // Fallback cooldown for unclassified errors and the confirm-probe
  // Retry-After (upstream settings.go RateLimitCooldownSeconds, env
  // M365_RATE_LIMIT_COOLDOWN_SECONDS, 5-3600s).
  rateLimitCooldownSeconds: number;
  // Optional external MCP servers bridged into the global tool registry.
  mcpServers?: string[];
  // Feature-flag knobs (env-seeded; see FeatureFlags).
  featureFlags?: Partial<FeatureFlags>;
}

// Default mappings seed the console's editable model table. The mapping
// table is the single source of truth at runtime: a mapped model is pinned to
// its upstreamTone; an unmapped (e.g. deleted) model is rejected outright.
export const DEFAULT_MODEL_MAPPINGS: ModelMapping[] = [
  { publicModel: "gpt-5.2", upstreamTone: "Gpt_5_2_Chat", displayName: "GPT-5.2", defaultReasoningLevel: "medium" },
  { publicModel: "gpt-5.2-reasoning", upstreamTone: "Gpt_5_2_Reasoning", displayName: "GPT-5.2 Reasoning", defaultReasoningLevel: "medium" },
  { publicModel: "gpt-5.3", upstreamTone: "Gpt_5_3_Chat", displayName: "GPT-5.3", defaultReasoningLevel: "medium" },
  { publicModel: "gpt-5.4", upstreamTone: "Gpt_5_4_Chat", displayName: "GPT-5.4", defaultReasoningLevel: "medium" },
  { publicModel: "gpt-5.4-reasoning", upstreamTone: "Gpt_5_4_Reasoning", displayName: "GPT-5.4 Reasoning", defaultReasoningLevel: "medium" },
  { publicModel: "gpt-5.5", upstreamTone: "Gpt_5_5_Chat", displayName: "GPT-5.5", defaultReasoningLevel: "medium" },
  { publicModel: "gpt-5.5-reasoning", upstreamTone: "Gpt_5_5_Reasoning", displayName: "GPT-5.5 Reasoning", defaultReasoningLevel: "medium" },
  { publicModel: "gpt-5.6-reasoning", upstreamTone: "Gpt_5_6_Reasoning", displayName: "GPT-5.6 Reasoning", defaultReasoningLevel: "medium" },
  { publicModel: "gpt-image-2", upstreamTone: "Magic", displayName: "GPT Image 2", defaultReasoningLevel: "none" },
  { publicModel: "claude-sonnet", upstreamTone: "Claude_Sonnet", displayName: "Claude Sonnet", defaultReasoningLevel: "medium" },
  { publicModel: "claude-sonnet-reasoning", upstreamTone: "Claude_Sonnet_Reasoning", displayName: "Claude Sonnet Reasoning", defaultReasoningLevel: "medium" },
];

export const CONFIGURABLE_CODEX_MODELS = [
  "gpt-5.2",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "codex-auto-review",
];

export const KNOWN_UPSTREAM_TONES = [
  "Gpt_5_2_Chat",
  "Gpt_5_2_Reasoning",
  "Gpt_5_3_Chat",
  "Gpt_5_3_Reasoning",
  "Gpt_5_4_Chat",
  "Gpt_5_4_Reasoning",
  "Gpt_5_5_Chat",
  "Gpt_5_5_Reasoning",
  "Gpt_5_6_Reasoning",
  "Claude_Sonnet",
  "Claude_Sonnet_Reasoning",
  "Magic",
];

export const RESTART_REQUIRED_FIELDS = [
  "listenAddress",
  "configPath",
  "tokenCachePath",
  "sessionCachePath",
  "clientId",
  "authority",
  "redirectUri",
  "scope",
  "debugLogPath",
];

function envInt(v: string | undefined, fallback: number): number {
  const n = Number.parseInt((v ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envBool(v: string | undefined, fallback: boolean): boolean {
  const t = (v ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(t)) return true;
  if (["0", "false", "no", "off"].includes(t)) return false;
  return fallback;
}

function envFeatureFlags(env: Env): Partial<FeatureFlags> {
  const g = (name: string, fb: boolean): boolean =>
    envBool((env as unknown as Record<string, string | undefined>)[name], fb);
  return {
    memoryV2: g("M365_ENABLE_MEMORY_V2", true),
    deepWork: g("M365_ENABLE_DEEP_WORK", false),
    computerUse: g("M365_ENABLE_COMPUTER_USE", false),
    realtimeVoice: g("M365_ENABLE_REALTIME_VOICE", false),
    systemPromptOverride: g("M365_ENABLE_SYSTEM_PROMPT_OVERRIDE", false),
    designerImageGen4o: g("M365_ENABLE_DESIGNER_IMAGE_GEN_4O", false),
    codeCanvas: g("M365_ENABLE_CODE_CANVAS", false),
    sydneyReconnect: g("M365_ENABLE_SYDNEY_RECONNECT", false),
  };
}

export function defaultSettings(env: Env): RuntimeSettings {
  return {
    maxToolCallsPerTurn: 32,
    maxToolRounds: 512,
    contextWindow: 128000,
    maxOutputTokens: 16384,
    chatTimeoutSeconds: envInt(env.M365_CHAT_TIMEOUT_SECONDS, 120),
    imageTimeoutSeconds: 150,
    logLevel: "info",
    debugLogPath: "",
    listenAddress: "",
    configPath: "",
    tokenCachePath: "",
    sessionCachePath: "",
    clientId: "",
    authority: "",
    redirectUri: "",
    scope: "",
    modelMappings: [...DEFAULT_MODEL_MAPPINGS],
    discoveredTones: [],
    discoveredTonesAt: "",
    toolPlanningMode: "router",
    licenseType: "Starter",
    scenario: "OfficeWebIncludedCopilot",
    accountConcurrencyLimit: 8,
    rateLimitCooldownSeconds: envInt(env.M365_RATE_LIMIT_COOLDOWN_SECONDS, 30),
    mcpServers: [],
    featureFlags: envFeatureFlags(env),
  };
}

const KEY = "settings";

export async function getSettings(env: Env): Promise<RuntimeSettings> {
  const defaults = defaultSettings(env);
  const stored = await getJSON<Partial<RuntimeSettings>>(env["m365-copilot2api_KV"], KEY);
  if (!stored) return defaults;
  return { ...defaults, ...stored };
}

export async function saveSettings(env: Env, v: RuntimeSettings): Promise<string | null> {
  const err = validateSettings(v);
  if (err) return err;
  await putJSON(env["m365-copilot2api_KV"], KEY, v);
  return null;
}

const PUBLIC_MODEL_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function validateSettings(v: RuntimeSettings): string | null {
  if (v.maxToolCallsPerTurn < 1 || v.maxToolCallsPerTurn > 64) return "每轮工具调用数必须为 1-64";
  if (v.maxToolRounds < 1 || v.maxToolRounds > 512) return "最大工具轮次必须为 1-512";
  if (v.contextWindow < 1024) return "上下文窗口不能小于 1024";
  if (v.maxOutputTokens < 1 || v.maxOutputTokens >= v.contextWindow)
    return "最大输出必须大于 0 且小于上下文窗口";
  if (v.chatTimeoutSeconds < 5 || v.chatTimeoutSeconds > 3600) return "聊天超时必须为 5-3600 秒";
  if (!(v.accountConcurrencyLimit >= 1 && v.accountConcurrencyLimit <= 64))
    return "账号并发上限必须为 1-64";
  if (!(v.rateLimitCooldownSeconds >= 5 && v.rateLimitCooldownSeconds <= 3600))
    return "限流冷却必须为 5-3600 秒";
  if (v.imageTimeoutSeconds < 5 || v.imageTimeoutSeconds > 3600) return "图片超时必须为 5-3600 秒";
  if (!["silent", "error", "warn", "info", "debug"].includes(v.logLevel))
    return "日志等级必须为 silent、error、warn、info 或 debug";
  if (!(v.modelMappings ?? []).length) return "至少需要配置一条模型映射";
  const seen = new Set<string>();
  for (const mapping of v.modelMappings ?? []) {
    const model = (mapping.publicModel ?? "").trim();
    if (!PUBLIC_MODEL_ID_RE.test(model))
      return "公开模型 ID 只能包含字母、数字、点、下划线或连字符，且长度为 1-128";
    const key = model.toLowerCase();
    if (seen.has(key)) return `公开模型 ID "${model}" 重复`;
    seen.add(key);
    // No static whitelist: any well-formed tone identifier is allowed so that
    // manually entered or newly fetched tones can be saved.
    if (!/^[A-Za-z0-9_]{1,128}$/.test((mapping.upstreamTone ?? "").trim()))
      return `上游 tone "${mapping.upstreamTone}" 不受支持`;
    if ((mapping.displayName ?? "").trim() === "") return `公开模型 "${model}" 缺少显示名称`;
    const level = (mapping.defaultReasoningLevel ?? "").trim().toLowerCase();
    if (!["none", "minimal", "low", "medium", "high", "xhigh"].includes(level))
      return `公开模型 "${model}" 的默认推理级别无效`;
  }
  return null;
}

// Port of configuredModelLimits.
export function modelLimits(s: RuntimeSettings): {
  contextWindow: number;
  maxInputTokens: number;
  maxOutputTokens: number;
} {
  let maxOutput = s.maxOutputTokens;
  if (maxOutput >= s.contextWindow) {
    maxOutput = Math.floor(s.contextWindow / 8);
    if (maxOutput < 1) maxOutput = 1;
  }
  return {
    contextWindow: s.contextWindow,
    maxInputTokens: s.contextWindow - maxOutput,
    maxOutputTokens: maxOutput,
  };
}

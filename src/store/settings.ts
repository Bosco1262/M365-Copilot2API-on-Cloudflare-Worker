// Runtime settings on KV (port of internal/web/settings.go).

import type { Env } from "../env";
import { getJSON, putJSON } from "../kv";

export interface ModelMapping {
  publicModel: string;
  upstreamTone: string;
  displayName: string;
  defaultReasoningLevel: string;
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
  toolPlanningMode: string;
}

export const DEFAULT_MODEL_MAPPINGS: ModelMapping[] = [
  { publicModel: "gpt-5.6-sol", upstreamTone: "Gpt_5_6_Reasoning", displayName: "GPT-5.6-Sol", defaultReasoningLevel: "low" },
  { publicModel: "gpt-5.6-terra", upstreamTone: "Gpt_5_6_Reasoning", displayName: "GPT-5.6-Terra", defaultReasoningLevel: "medium" },
  { publicModel: "gpt-5.6-luna", upstreamTone: "Gpt_5_6_Reasoning", displayName: "GPT-5.6-Luna", defaultReasoningLevel: "medium" },
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
    toolPlanningMode: "router",
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
  if (v.imageTimeoutSeconds < 5 || v.imageTimeoutSeconds > 3600) return "图片超时必须为 5-3600 秒";
  if (!["silent", "error", "warn", "info", "debug"].includes(v.logLevel))
    return "日志等级必须为 silent、error、warn、info 或 debug";
  const seen = new Set<string>();
  for (const mapping of v.modelMappings ?? []) {
    const model = (mapping.publicModel ?? "").trim();
    if (!PUBLIC_MODEL_ID_RE.test(model))
      return "公开模型 ID 只能包含字母、数字、点、下划线或连字符，且长度为 1-128";
    const key = model.toLowerCase();
    if (seen.has(key)) return `公开模型 ID "${model}" 重复`;
    seen.add(key);
    if (!KNOWN_UPSTREAM_TONES.includes((mapping.upstreamTone ?? "").trim()))
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

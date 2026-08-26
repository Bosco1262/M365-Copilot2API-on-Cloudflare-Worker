// Model catalog + tone routing (ports of internal/web/codex_catalog.go and
// modelTone/reasoningTone from server.go).

import type { RuntimeSettings, ModelMapping } from "../store/settings";
import { modelLimits } from "../store/settings";

export const GATEWAY_CODEX_BASE_INSTRUCTIONS =
  "You are a helpful AI assistant. When asked to write code, always provide the complete implementation — never truncate, abbreviate, or return only a fragment. Write full, working code with all logic included.";

const ADVERTISED_REASONING_EFFORTS = [
  { effort: "none", description: "Disable additional reasoning." },
  { effort: "minimal", description: "Fast responses with minimal reasoning." },
  { effort: "low", description: "Fast responses with lighter reasoning." },
  { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks." },
  { effort: "high", description: "Greater reasoning depth for complex problems." },
  { effort: "xhigh", description: "Extra high reasoning depth for complex problems." },
];

interface ModelSpec {
  id: string;
  owner: string;
  displayName?: string;
  defaultReasoningLevel?: string;
}

const GATEWAY_MODELS: ModelSpec[] = [
  { id: "gpt-5.2", owner: "microsoft-365" },
  { id: "gpt-5.2-reasoning", owner: "microsoft-365" },
  { id: "gpt-5.3", owner: "microsoft-365" },
  { id: "gpt-5.4", owner: "microsoft-365" },
  { id: "gpt-5.4-reasoning", owner: "microsoft-365" },
  { id: "gpt-5.5", owner: "microsoft-365" },
  { id: "gpt-5.5-reasoning", owner: "microsoft-365" },
  { id: "gpt-5.6-reasoning", owner: "microsoft-365" },
  { id: "gpt-image-2", owner: "microsoft-365", displayName: "GPT Image 2" },
  { id: "claude-sonnet", owner: "anthropic-via-microsoft-365" },
  { id: "claude-sonnet-reasoning", owner: "anthropic-via-microsoft-365" },
];

// Port of modelTone.
export function modelTone(model: string): string {
  switch ((model ?? "").trim().toLowerCase()) {
    case "gpt-5.2":
      return "Gpt_5_2_Chat";
    case "gpt-5.2-reasoning":
      return "Gpt_5_2_Reasoning";
    case "gpt-5.3":
      return "Gpt_5_3_Chat";
    case "gpt-5.4":
      return "Gpt_5_4_Chat";
    case "gpt-5.4-reasoning":
      return "Gpt_5_4_Reasoning";
    case "gpt-5.5":
      return "Gpt_5_5_Chat";
    case "gpt-5.5-reasoning":
      return "Gpt_5_5_Reasoning";
    case "gpt-5.6-reasoning":
      return "Gpt_5_6_Reasoning";
    case "claude":
    case "claude-sonnet":
      return "Claude_Sonnet";
    case "claude-sonnet-reasoning":
      return "Claude_Sonnet_Reasoning";
    case "gpt-5.4-quick":
      return "Gpt_5_4_Chat";
    case "gpt-5.3-think-deeper":
      return "Gpt_5_3_Chat";
    default:
      return "magic";
  }
}

export function normalizeReasoningEffort(e: string): string | Error {
  const v = (e ?? "").trim().toLowerCase();
  if (v === "") return "";
  if (["none", "minimal", "low", "medium", "high", "xhigh"].includes(v)) return v;
  return new Error(
    `unsupported reasoning effort "${e}"; use none, minimal, low, medium, high, or xhigh`
  );
}

function configuredModelMapping(
  model: string,
  mappings: ModelMapping[]
): ModelMapping | null {
  const m = (model ?? "").trim().toLowerCase();
  for (const mapping of mappings) {
    if ((mapping.publicModel ?? "").trim().toLowerCase() === m) return mapping;
  }
  return null;
}

// Port of reasoningTone.
export function reasoningTone(model: string, effort: string, settings: RuntimeSettings): string | Error {
  const e = normalizeReasoningEffort(effort);
  if (e instanceof Error) return e;
  const mapping = configuredModelMapping(model, settings.modelMappings);
  if (mapping) return mapping.upstreamTone;
  const base = modelTone(model);
  if (model.toLowerCase().includes("reasoning")) return base;
  if (e === "" || e === "none" || e === "minimal" || e === "low") return base;
  switch ((model ?? "").trim().toLowerCase()) {
    case "claude":
    case "claude-sonnet":
      return "Claude_Sonnet_Reasoning";
    case "gpt-5.2":
      return "Gpt_5_2_Reasoning";
    case "gpt-5.3":
      return "Gpt_5_3_Reasoning";
    case "gpt-5.4":
      return "Gpt_5_4_Reasoning";
    case "gpt-5.5":
      return "Gpt_5_5_Reasoning";
    case "gpt-5.6":
      return "Gpt_5_6_Reasoning";
    default:
      return "Gpt_5_5_Reasoning";
  }
}

function configuredModelSpecs(mappings: ModelMapping[]): ModelSpec[] {
  const models = [...GATEWAY_MODELS];
  for (const mapping of mappings) {
    const spec: ModelSpec = {
      id: (mapping.publicModel ?? "").trim(),
      owner: "microsoft-365",
      displayName: (mapping.displayName ?? "").trim(),
      defaultReasoningLevel: (mapping.defaultReasoningLevel ?? "").trim(),
    };
    let replaced = false;
    for (let i = 0; i < models.length; i++) {
      if (models[i].id.toLowerCase() === spec.id.toLowerCase()) {
        models[i] = spec;
        replaced = true;
        break;
      }
    }
    if (!replaced) models.push(spec);
  }
  return models;
}

// Port of modelCatalog (Codex-style entries).
export function modelCatalog(settings: RuntimeSettings): Record<string, unknown>[] {
  const l = modelLimits(settings);
  const models = configuredModelSpecs(settings.modelMappings);
  return models.map((m) => {
    const features = ["tools", "function_calling", "streaming", "reasoning", "vision"];
    const modalities = ["text", "image"];
    const caps = {
      chat_completions: true,
      responses: true,
      streaming: true,
      tools: true,
      reasoning: true,
      reasoning_efforts: ADVERTISED_REASONING_EFFORTS,
      supported_reasoning_levels: ADVERTISED_REASONING_EFFORTS,
      reasoning_mode: "gateway_tone_routing",
      supports_tools: true,
      tool_calls: true,
      function_calling: true,
      supports_function_calling: true,
      supports_vision: true,
      vision: true,
      modalities,
      input_modalities: modalities,
      output_modalities: ["text"],
      supported_features: features,
    };
    const displayName = m.displayName || m.id;
    const defaultReasoningLevel = m.defaultReasoningLevel || "medium";
    return {
      id: m.id,
      slug: m.id,
      display_name: displayName,
      description: "Public model endpoint.",
      base_instructions: GATEWAY_CODEX_BASE_INSTRUCTIONS,
      model_messages: {
        instructions_template: GATEWAY_CODEX_BASE_INSTRUCTIONS,
        instructions_variables: {
          personality_default: "",
          personality_friendly: "",
          personality_pragmatic: "",
        },
        approvals: null,
        auto_review: null,
      },
      default_reasoning_level: defaultReasoningLevel,
      object: "model",
      owned_by: "gateway",
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      priority: 1,
      additional_speed_tiers: [],
      service_tiers: [],
      availability_nux: null,
      upgrade: null,
      include_skills_usage_instructions: false,
      supports_reasoning_summaries: true,
      default_reasoning_summary: "none",
      support_verbosity: true,
      default_verbosity: "low",
      apply_patch_tool_type: "freeform",
      web_search_tool_type: "text_and_image",
      truncation_policy: { mode: "tokens", limit: 10000 },
      supports_parallel_tool_calls: true,
      supports_image_detail_original: true,
      max_context_window: l.contextWindow,
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      supports_search_tool: true,
      use_responses_lite: false,
      tool_mode: "code_mode_only",
      multi_agent_version: "v2",
      context_window: l.contextWindow,
      max_input_tokens: l.maxInputTokens,
      max_output_tokens: l.maxOutputTokens,
      capabilities: caps,
      supports_tools: true,
      tool_calls: true,
      supported_reasoning_levels: ADVERTISED_REASONING_EFFORTS,
      function_calling: true,
      supports_function_calling: true,
      supports_vision: true,
      modalities,
      input_modalities: modalities,
      output_modalities: ["text"],
      supported_features: features,
    };
  });
}

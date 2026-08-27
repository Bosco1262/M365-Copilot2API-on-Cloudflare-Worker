// Function-calling toolkit (ports of internal/web/toolloop.go,
// fenced_tools.go, tooldecision.go, model_tool_router.go, native_tools.go and
// the response writer from tool_response.go).

import { uuid } from "../util";

export interface DetectedToolCall {
  id: string;
  type: string;
  name: string;
  arguments: string; // JSON
}

type ToolMap = Record<string, unknown>;

export interface RejectedToolCall {
  name: string;
  reason: string;
}

export function toolFunction(name: string, tools: ToolMap[]): ToolMap | null {
  for (const t of tools) {
    const f = t["function"] as ToolMap | undefined;
    if (f && f["name"] === name) return f;
  }
  return null;
}

export function toolType(name: string, tools: ToolMap[]): string {
  for (const t of tools) {
    const f = t["function"] as ToolMap | undefined;
    if (f && f["name"] === name) {
      const typ = t["type"];
      if (typeof typ === "string" && typ !== "") return typ;
    }
  }
  return "function";
}

export function allowedToolNames(tools: ToolMap[]): Set<string> {
  const out = new Set<string>();
  for (const t of tools) {
    const f = t["function"] as ToolMap | undefined;
    const n = f?.["name"];
    if (typeof n === "string" && n !== "") out.add(n);
  }
  return out;
}

export function toolChoiceAllows(choice: unknown, name: string): boolean {
  if (choice == null) return true;
  if (typeof choice === "string") {
    return choice !== "none" && (choice !== "required" || name !== "");
  }
  if (typeof choice === "object") {
    const m = choice as ToolMap;
    const f = m["function"] as ToolMap | undefined;
    if (f) return f["name"] === name;
    if (typeof m["name"] === "string") return m["name"] === name;
  }
  return true;
}

// Globally unique ids: content hashes collided on repeated identical calls.
export function callID(_name: string, _args: string, _index: number): string {
  return "call_" + uuid().replace(/-/g, "");
}

// Port of validateJSONSchema (subset used by the gateway).
export function validateJSONSchema(value: unknown, schema: ToolMap, path: string): string | null {
  const enums = schema["enum"];
  if (Array.isArray(enums)) {
    const a = JSON.stringify(value);
    let found = false;
    for (const e of enums) {
      if (JSON.stringify(e) === a) {
        found = true;
        break;
      }
    }
    if (!found) return `${path} is not an allowed enum value`;
  }
  const typ = typeof schema["type"] === "string" ? schema["type"] : "";
  switch (typ) {
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return `${path} must be object`;
      const m = value as ToolMap;
      const req = schema["required"];
      if (Array.isArray(req)) {
        for (const raw of req) {
          const n = String(raw);
          if (!(n in m)) return `missing required argument ${n}`;
        }
      }
      const props = schema["properties"] as ToolMap | undefined;
      if (schema["additionalProperties"] === false && props) {
        for (const n of Object.keys(m)) {
          if (!(n in props)) return `${path}.${n} is not allowed`;
        }
      }
      if (props) {
        for (const [n, v] of Object.entries(m)) {
          const ps = props[n];
          if (ps && typeof ps === "object") {
            const err = validateJSONSchema(v, ps as ToolMap, `${path}.${n}`);
            if (err) return err;
          }
        }
      }
      break;
    }
    case "array": {
      if (!Array.isArray(value)) return `${path} must be array`;
      const item = schema["items"];
      if (item && typeof item === "object") {
        value.forEach((v, i) => {
          void v;
          void i;
        });
        for (let i = 0; i < value.length; i++) {
          const err = validateJSONSchema(value[i], item as ToolMap, `${path}[${i}]`);
          if (err) return err;
        }
      }
      break;
    }
    case "string":
      if (typeof value !== "string") return `${path} must be string`;
      break;
    case "number":
      if (typeof value !== "number") return `${path} must be number`;
      break;
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) return `${path} must be integer`;
      break;
    }
    case "boolean":
      if (typeof value !== "boolean") return `${path} must be boolean`;
      break;
    case "null":
      if (value !== null) return `${path} must be null`;
      break;
  }
  return null;
}

export function schemaValid(args: ToolMap, fn: ToolMap): string | null {
  const params = fn["parameters"];
  if (!params || typeof params !== "object") return null;
  return validateJSONSchema(args, params as ToolMap, "arguments");
}

// Port of validateDetectedToolCalls — final trust boundary before a
// model-selected call reaches the client.
export function validateDetectedToolCalls(
  calls: DetectedToolCall[],
  tools: ToolMap[],
  choice: unknown
): { valid: DetectedToolCall[]; rejected: RejectedToolCall[] } {
  const valid: DetectedToolCall[] = [];
  const rejected: RejectedToolCall[] = [];
  for (const call of calls) {
    const fn = toolFunction(call.name, tools);
    if (!fn) {
      rejected.push({ name: call.name, reason: "tool was not declared by the client" });
      continue;
    }
    if (!toolChoiceAllows(choice, call.name)) {
      rejected.push({ name: call.name, reason: "tool_choice does not allow this tool" });
      continue;
    }
    let args: ToolMap = {};
    if (!call.arguments || call.arguments === "null") {
      call.arguments = "{}";
    } else {
      try {
        const parsed = JSON.parse(call.arguments);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
        args = parsed as ToolMap;
      } catch {
        rejected.push({ name: call.name, reason: "arguments are not a JSON object" });
        continue;
      }
    }
    const err = schemaValid(args, fn);
    if (err) {
      rejected.push({ name: call.name, reason: err });
      continue;
    }
    if (!call.id) call.id = callID(call.name, call.arguments, valid.length);
    if (!call.type) call.type = toolType(call.name, tools);
    valid.push(call);
  }
  return { valid, rejected };
}

function declaredShell(allowed: Set<string>): string {
  for (const n of ["bash", "sh", "shell", "powershell", "cmd"]) {
    if (allowed.has(n)) return n;
  }
  return "";
}

const FENCED_RE = /```([A-Za-z0-9_-]+)\s*\n([\s\S]*?)\n```/g;

// Port of fencedToolCalls incl. bash-block auto-conversion and the plain
// {"command": ...} line scan.
export function fencedToolCalls(
  text: string,
  tools: ToolMap[],
  choice: unknown
): DetectedToolCall[] {
  const allowed = allowedToolNames(tools);
  const shell = declaredShell(allowed);
  const out: DetectedToolCall[] = [];
  for (const m of text.matchAll(FENCED_RE)) {
    const name = m[1];
    const args = m[2].trim();
    let v: unknown = undefined;
    try {
      v = JSON.parse(args);
    } catch {
      /* keep undefined */
    }
    if (["bash", "sh", "shell", "powershell", "cmd"].includes(name)) {
      let converted = name;
      if (!allowed.has(name)) {
        if (shell === "") continue;
        converted = shell;
      }
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const obj = v as ToolMap;
        const cmd = obj["command"];
        if (cmd && cmd !== "") {
          const cmdBytes = JSON.stringify({ command: cmd, timeout: obj["timeout"], workdir: obj["workdir"] });
          out.push({ id: callID(converted, cmdBytes, out.length), type: "function", name: converted, arguments: cmdBytes });
          continue;
        }
      }
      if (v === undefined || v === null) {
        const cmdBytes = JSON.stringify({ command: args });
        out.push({ id: callID(converted, cmdBytes, out.length), type: "function", name: converted, arguments: cmdBytes });
        continue;
      }
      continue;
    }
    if (!allowed.has(name) || !toolChoiceAllows(choice, name)) continue;
    if (v === undefined || v === null) continue;
    const b = JSON.stringify(v);
    out.push({ id: callID(name, b, out.length), type: toolType(name, tools), name, arguments: b });
  }
  // Plain JSON objects with a "command" field.
  if (out.length === 0 && shell !== "") {
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== "{") continue;
      let end = text.indexOf("\n", i);
      if (end < 0) end = text.length;
      const line = text.slice(i, end);
      const braceEnd = line.lastIndexOf("}");
      if (braceEnd < 0) continue;
      if (!line.slice(0, braceEnd + 1).includes('"command"')) continue;
      try {
        const obj = JSON.parse(line.slice(0, braceEnd + 1)) as ToolMap;
        const cmd = obj["command"];
        if (cmd && cmd !== "") {
          const cmdBytes = JSON.stringify({ command: cmd, timeout: obj["timeout"], workdir: obj["workdir"] });
          out.push({ id: callID(shell, cmdBytes, out.length), type: "function", name: shell, arguments: cmdBytes });
          break;
        }
      } catch {
        continue;
      }
    }
  }
  return out;
}

// Port of extractToolEvents (chathub/events.go + native_tools.go): recursively
// walks ALL levels of an update frame's raw arguments (not just messages[]) and
// records every object that carries BOTH a name-ish field and an
// arguments-ish field as a tool invocation. Dedupes by name+JSON(args).
const TOOL_NAME_KEYS = ["name", "toolName", "pluginName", "functionName"];
const TOOL_ARGS_KEYS = ["arguments", "args", "parameters", "input", "functionArguments"];

export interface ToolEvent {
  toolName: string;
  arguments: unknown;
}

export function extractToolEvents(raw: unknown): ToolEvent[] {
  const out: ToolEvent[] = [];
  const seen = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const y of v) walk(y);
      return;
    }
    if (!v || typeof v !== "object") return;
    const x = v as ToolMap;
    let name = "";
    for (const k of TOOL_NAME_KEYS) {
      const s = x[k];
      if (typeof s === "string" && s.trim() !== "") {
        name = s.trim();
        break;
      }
    }
    if (name !== "") {
      for (const k of TOOL_ARGS_KEYS) {
        if (k in x && x[k] !== null && x[k] !== undefined) {
          const key = name + "\u0000" + JSON.stringify(x[k]);
          if (!seen.has(key)) {
            seen.add(key);
            out.push({ toolName: name, arguments: x[k] });
          }
          // Recorded: do not descend into the invocation itself (the argument
          // payload frequently embeds a copy of the same call).
          return;
        }
      }
    }
    for (const y of Object.values(x)) walk(y);
  };
  walk(raw);
  return out;
}

// Port of nativeToolCalls: converts events actually present in ChatHub frames
// into detected calls, accepting ONLY client-declared tool names. Never
// inferred from prose.
export function nativeToolCalls(events: unknown[], declaredNames: Set<string>): DetectedToolCall[] {
  const out: DetectedToolCall[] = [];
  for (const ev of extractToolEvents(events)) {
    if (!declaredNames.has(ev.toolName)) continue;
    const args =
      ev.arguments === null || ev.arguments === undefined ? "{}" : JSON.stringify(ev.arguments);
    out.push({ id: "call_" + uuid(), type: "", name: ev.toolName, arguments: args });
  }
  return out;
}

// Port of extractToolCalls (<m365-tool-call> protocol blocks).
export function extractM365ToolCalls(
  text: string,
  tools: ToolMap[],
  choice: unknown
): { calls: DetectedToolCall[]; found: boolean } {
  const allowed = allowedToolNames(tools);
  const out: DetectedToolCall[] = [];
  let remaining = text;
  for (;;) {
    const start = remaining.indexOf("<m365-tool-call>");
    if (start < 0) break;
    const relEnd = remaining.slice(start).indexOf("</m365-tool-call>");
    if (relEnd < 0) break;
    const end = start + relEnd;
    const content = remaining.slice(start + "<m365-tool-call>".length, end);
    remaining = remaining.slice(end + "</m365-tool-call>".length);
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      continue;
    }
    const items = Array.isArray(raw) ? raw : [raw];
    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const m = item as ToolMap;
      const n = m["name"];
      if (typeof n !== "string" || !allowed.has(n) || !toolChoiceAllows(choice, n)) continue;
      const a = JSON.stringify(m["arguments"]);
      out.push({ id: callID(n, a, out.length), type: toolType(n, tools), name: n, arguments: a });
    }
  }
  return { calls: out, found: out.length > 0 };
}

export function normalizedToolChoiceMode(choice: unknown): string {
  if (choice == null) return "auto";
  if (typeof choice === "string") return choice;
  if (typeof choice === "object") {
    const m = choice as ToolMap;
    const f = m["function"] as ToolMap | undefined;
    if (f && typeof f["name"] === "string") return "named:" + f["name"];
    if (typeof m["name"] === "string") return "named:" + m["name"];
  }
  return "auto";
}

// Port of modelToolRouterPrompt.
export function modelToolRouterPrompt(prompt: string, tools: ToolMap[], choice: unknown): string {
  const defs = JSON.stringify(tools);
  const mode = normalizedToolChoiceMode(choice);
  let rules = `- If a tool is needed, respond with: CALL_TOOL: tool_name({"arg1":"value1"})
- If no tool is needed, respond with: NO_TOOL_NEEDED
- Only use tools from the available list above
- Validate all arguments against the tool's schema
- Do not invent tools that are not in the list`;
  if (prompt.includes("tool_calls:") || prompt.includes("tool[call_")) {
    rules += `
- Completed evidence must not be repeated: tool_calls/tool[call_x] rows are prior results already delivered to the user, never re-invoke them
- Only start a new tool call when fresh unfinished work remains on the current request`;
  }
  return `You are a tool selection assistant. Based on the user request, decide which tool to call next.

Available tools: ${defs}

MODE: ${mode}

Rules:
${rules}

User request and evidence:
${prompt}`;
}

// Answer-turn tool protocol injected into the prompt whenever the client
// declares tools. Without it the model never emits invocations in a form the
// gateway can convert (the router pre-call does not run on the streaming
// path), so streamed tool-enabled chats silently degrade to plain answers.
// Emits fenced blocks that fencedToolCalls() detects post-answer.
export function toolUseInstructions(tools: ToolMap[]): string {
  const defs = JSON.stringify(tools);
  return [
    "",
    "# Tool calling",
    "You have real tools available. They execute on the caller's machine and return results to you.",
    "Available tools:",
    defs,
    "To invoke a tool, respond with a fenced code block whose info string is the exact tool name and whose body is a JSON object of arguments, for example:",
    "```tool_name",
    '{"argument": "value"}',
    "```",
    "Rules:",
    "- When an action is required, emit the invocation block INSTEAD of describing or claiming the action.",
    "- You may add a short lead-in sentence before the block.",
    "- Only call tools from the list above; never invent tool names.",
    "- Do not claim a tool already ran unless its result appears in the conversation.",
  ].join("\n");
}

// Port of parseModelToolDecision.
export function parseModelToolDecision(
  textRaw: string,
  tools: ToolMap[],
  choice: unknown
): { calls: DetectedToolCall[]; parsed: boolean } {
  let text = textRaw.trim();
  // New natural language format first: CALL_TOOL: name({...})
  if (/^CALL_TOOL:/i.test(text)) {
    const idx = text.indexOf(":");
    const rest = text.slice(idx + 1).trim();
    const start = rest.indexOf("(");
    const end = rest.lastIndexOf(")");
    if (start > 0 && end > start) {
      const name = rest.slice(0, start).trim();
      const argsStr = rest.slice(start + 1, end);
      try {
        const args = JSON.parse(argsStr) as ToolMap;
        if (
          args &&
          typeof args === "object" &&
          !Array.isArray(args) &&
          toolChoiceAllows(choice, name)
        ) {
          const fn = toolFunction(name, tools);
          if (fn && schemaValid(args, fn) === null) {
            const b = JSON.stringify(args);
            return {
              calls: [{ id: callID(name, b, 0), type: toolType(name, tools), name, arguments: b }],
              parsed: true,
            };
          }
        }
      } catch {
        /* fallthrough */
      }
    }
  }
  if (text.includes("NO_TOOL_NEEDED") || text.includes("no_tool_needed")) {
    return { calls: [], parsed: true };
  }
  // Fallback: old JSON envelope format.
  const fenceIdx = text.indexOf("```");
  if (fenceIdx >= 0) {
    text = text
      .slice(fenceIdx + 3)
      .replace(/```$/, "")
      .replace(/^json/, "")
      .trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { calls: [], parsed: false };
  const candidate = text.slice(start, end + 1);
  try {
    const probe = JSON.parse(candidate) as ToolMap;
    if (!("calls" in probe)) return { calls: [], parsed: false };
    const envelope = probe as { calls?: { name?: string; arguments?: ToolMap | null }[] };
    const out: DetectedToolCall[] = [];
    (envelope.calls ?? []).forEach((c, i) => {
      const name = c?.name ?? "";
      const fn = toolFunction(name, tools);
      if (!fn || c.arguments == null || !toolChoiceAllows(choice, name) || schemaValid(c.arguments, fn) !== null) {
        return;
      }
      const b = JSON.stringify(c.arguments);
      out.push({ id: callID(name, b, i), type: toolType(name, tools), name, arguments: b });
    });
    return { calls: out, parsed: true };
  } catch {
    return { calls: [], parsed: false };
  }
}

export function limitToolCalls(calls: DetectedToolCall[], n: number): DetectedToolCall[] {
  if (n < 1) n = 1;
  return calls.length > n ? calls.slice(0, n) : calls;
}

function toolLooksMutating(name: string): boolean {
  return ["exec", "shell", "command", "write", "edit", "update", "delete", "remove", "move", "rename", "create", "patch", "apply", "install", "run"].some((w) =>
    name.includes(w)
  );
}
function toolLooksReadOnly(name: string): boolean {
  return ["read", "list", "search", "find", "get", "fetch", "browser", "lookup", "inspect", "stat", "status", "describe", "info"].some((w) =>
    name.includes(w)
  );
}

// Port of adaptiveToolCallLimit.
export function adaptiveToolCallLimit(calls: DetectedToolCall[], configured: number): number {
  if (calls.length < 2 || configured < 2) return 1;
  for (const call of calls) {
    const name = call.name.trim().toLowerCase();
    if (name === "" || toolLooksMutating(name) || !toolLooksReadOnly(name)) return 1;
  }
  return configured;
}

// Refusal / hallucination / policy detectors (port of toolloop.go patterns).
const TOOL_REFUSAL_PATTERNS = [
  "tools are not available",
  "tool is not available",
  "not actually registered",
  "not actually available",
  "not available in this session",
  "工具不可用",
  "工具未暴露",
];

export function isToolRefusal(text: string): boolean {
  if (text.length >= 200) return false;
  const low = text.toLowerCase();
  return TOOL_REFUSAL_PATTERNS.some((p) => low.includes(p.toLowerCase()));
}

const CONTENT_POLICY_PATTERNS = [
  "很抱歉，我无法响应",
  "我很抱歉，我无法响应",
  "i'm sorry, i can't respond",
  "i'm sorry, i cannot respond",
];

export function isContentPolicyBlock(text: string): boolean {
  if (text.length > 300) return false;
  const low = text.toLowerCase();
  return CONTENT_POLICY_PATTERNS.some((p) => low.includes(p.toLowerCase()));
}

const SANDBOX_HALLUCINATION_PATTERNS = [
  "i can run that for you",
  "i'll run that",
  "let me run that",
  "let me execute",
  "running in sandbox",
  "executing in sandbox",
  "code interpreter",
  "python sandbox",
  "sandbox environment",
  "/mnt/data",
  "linux container",
  "linux sandbox",
  "cloud sandbox",
  "execution environment has changed",
  "cannot access the windows path",
  "only provides linux",
  "只提供 linux 容器",
  "no windows execution",
  "don't have a windows",
  "cannot execute on windows",
  "no execution channel",
  "没有 windows 执行通道",
  "没有执行通道",
  "cannot run commands on",
  "don't have command execution",
  "无法执行命令",
  "执行环境已经切换",
  "i don't have ssh access tools",
  "i don't have any tools",
  "none of which can reach",
];

export function isSandboxHallucination(text: string): boolean {
  const low = text.toLowerCase();
  return SANDBOX_HALLUCINATION_PATTERNS.some((p) => low.includes(p));
}

// Port of toolCallMaps + writeToolResponse.
export function toolCallMaps(calls: DetectedToolCall[]): Record<string, unknown>[] {
  return calls.map((tc) => ({
    id: tc.id,
    type: tc.type || "function",
    function: { name: tc.name, arguments: tc.arguments },
  }));
}

export function buildToolResponse(
  id: string,
  model: string,
  stream: boolean,
  sendUsage: boolean,
  calls: DetectedToolCall[],
  res: { text: string; reasoning: string; conversationId: string; sessionId: string; requestId: string },
  promptTokensOverride?: number
): Response {
  const toolCalls = toolCallMaps(calls);
  const msg: Record<string, unknown> = { role: "assistant", content: null, tool_calls: toolCalls };
  if (res.reasoning) msg["reasoning_content"] = res.reasoning;

  let pt = promptTokensOverride ?? 0;
  for (const tc of calls) pt += Math.floor((tc.arguments.length * 2) / 3);
  const ct = Math.floor((res.text.length * 2) / 3);

  const headers: Record<string, string> =
    stream
      ? { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" }
      : {};

  if (!stream) {
    return new Response(
      JSON.stringify({
        id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: msg, finish_reason: "tool_calls" }],
        m365: {
          conversationId: res.conversationId,
          sessionId: res.sessionId,
          requestId: res.requestId,
          usage_source: "unavailable_from_chathub",
        },
        usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct },
      }) + "\n",
      { headers: { "Content-Type": "application/json", ...headers } }
    );
  }

  const frames: string[] = [];
  const emit = (obj: unknown) => frames.push(`data: ${JSON.stringify(obj)}\n\n`);
  const base = (delta: Record<string, unknown>, finish: unknown): unknown => ({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const firstDelta: Record<string, unknown> = { role: "assistant", content: null };
  if (res.reasoning) firstDelta["reasoning_content"] = res.reasoning;
  emit(base(firstDelta, null));

  const chunkSize = 512;
  calls.forEach((tc, i) => {
    const typ = tc.type || "function";
    const isLast = i === calls.length - 1;
    emit(
      base(
        { tool_calls: [{ index: i, id: tc.id, type: typ, function: { name: tc.name, arguments: "" } }] },
        null
      )
    );
    const args = tc.arguments;
    for (let off = 0; off < args.length; off += chunkSize) {
      let end = off + chunkSize;
      if (end > args.length) end = args.length;
      const argChunk = args.slice(off, end);
      const isLastArgChunk = off + chunkSize >= args.length;
      const finish = isLast && isLastArgChunk ? "tool_calls" : null;
      emit(base({ tool_calls: [{ index: i, function: { arguments: argChunk } }] }, finish));
    }
    if (args.length === 0 && isLast) {
      emit(base({}, "tool_calls"));
    }
  });
  if (sendUsage) {
    const usageChunk = base({}, null) as Record<string, unknown>;
    frames.push(
      `data: ${JSON.stringify({
        ...usageChunk,
        usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct },
      })}\n\n`
    );
  }
  frames.push("data: [DONE]\n\n");
  return new Response(frames.join(""), { headers });
}

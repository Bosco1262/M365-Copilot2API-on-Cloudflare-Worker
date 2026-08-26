import { describe, it, expect } from "vitest";
import {
  allowedToolNames,
  adaptiveToolCallLimit,
  extractM365ToolCalls,
  fencedToolCalls,
  nativeToolCalls,
  parseModelToolDecision,
  toolChoiceAllows,
  validateDetectedToolCalls,
  buildToolResponse,
} from "../src/pipeline/tools";

const TOOLS = [
  { type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" }, mode: { type: "string", enum: ["r", "rb"] } }, required: ["path"] } } },
];

describe("fencedToolCalls", () => {
  it("extracts declared fenced tool calls", () => {
    const text = 'Working...\n```read_file\n{"path":"a.txt","mode":"r"}\n```\ndone';
    const calls = fencedToolCalls(text, TOOLS, "auto");
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("read_file");
    expect(JSON.parse(calls[0].arguments)).toEqual({ path: "a.txt", mode: "r" });
  });

  it("auto-converts bash blocks only when a shell tool is declared", () => {
    const text = '```bash\nls -la\n```';
    const calls = fencedToolCalls(text, TOOLS, "auto");
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("bash");
    expect(JSON.parse(calls[0].arguments).command).toBe("ls -la");

    const noShell = [TOOLS[1]];
    expect(fencedToolCalls(text, noShell, "auto")).toHaveLength(0);
  });

  it("scans plain JSON command lines when no fences matched", () => {
    const text = 'Sure: {"command":"dir"} as requested';
    const calls = fencedToolCalls(text, TOOLS, "auto");
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("bash");
  });

  it("rejects undeclared tools", () => {
    const text = '```unknown_tool\n{"x":1}\n```';
    expect(fencedToolCalls(text, TOOLS, "auto")).toHaveLength(0);
  });
});

describe("validateDetectedToolCalls", () => {
  it("enforces the schema trust boundary", () => {
    const { valid, rejected } = validateDetectedToolCalls(
      [
        { id: "", type: "", name: "read_file", arguments: '{"path":"x"}' },
        { id: "", type: "", name: "not_declared", arguments: "{}" },
        { id: "", type: "", name: "read_file", arguments: '{"mode":"bad"}' },
        { id: "", type: "", name: "read_file", arguments: "null" },
      ],
      TOOLS,
      "auto"
    );
    expect(valid).toHaveLength(1); // null -> {} then fails required(path)
    expect(valid[0].arguments).toContain('"path"');
    expect(rejected).toHaveLength(3);
    expect(rejected[0].reason).toContain("not declared");
    // mode:"bad" violates enum OR misses required path depending on iteration order
    expect(
      rejected.some((r) => r.reason.includes("enum") || r.reason.includes("missing required"))
    ).toBe(true);
    expect(rejected.some((r) => r.reason.includes("missing required"))).toBe(true);
  });

  it("honours tool_choice named restriction", () => {
    expect(toolChoiceAllows({ type: "function", function: { name: "bash" } }, "read_file")).toBe(false);
    expect(toolChoiceAllows({ type: "function", function: { name: "bash" } }, "bash")).toBe(true);
    expect(toolChoiceAllows("none", "bash")).toBe(false);
  });
});

describe("parseModelToolDecision", () => {
  it("parses CALL_TOOL format", () => {
    const r = parseModelToolDecision('CALL_TOOL: read_file({"path":"x"} )', TOOLS, "auto");
    expect(r.parsed).toBe(true);
    expect(r.calls[0].name).toBe("read_file");
  });

  it("recognises NO_TOOL_NEEDED", () => {
    const r = parseModelToolDecision("NO_TOOL_NEEDED", TOOLS, "auto");
    expect(r.parsed).toBe(true);
    expect(r.calls).toHaveLength(0);
  });

  it("parses the JSON envelope fallback", () => {
    const r = parseModelToolDecision(
      'Here: ```json\n{"calls":[{"name":"bash","arguments":{"command":"pwd"}}]}\n```',
      TOOLS,
      "auto"
    );
    expect(r.parsed).toBe(true);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].name).toBe("bash");
  });

  it("returns parsed=false for garbage", () => {
    expect(parseModelToolDecision("just prose", TOOLS, "auto").parsed).toBe(false);
  });
});

describe("extractM365ToolCalls / nativeToolCalls", () => {
  it("extracts <m365-tool-call> payloads", () => {
    const { calls, found } = extractM365ToolCalls(
      'pre <m365-tool-call>{"name":"read_file","arguments":{"path":"p"}}</m365-tool-call> post',
      TOOLS,
      "auto"
    );
    expect(found).toBe(true);
    expect(calls[0].name).toBe("read_file");
  });

  it("walks native chathub frames for declared functions only", () => {
    const events = [
      { type: 1, target: "update", arguments: [{ messages: [{ pluginName: "read_file", args: { path: "/x" } }] }] },
    ];
    const calls = nativeToolCalls(events, [{ name: "read_file" }]);
    expect(calls).toHaveLength(1);
    expect(nativeToolCalls(events, [{ name: "other" }])).toHaveLength(0);
  });
});

describe("adaptiveToolCallLimit", () => {
  it("serialises mutating or undeclared tools to one call", () => {
    const readTools = [
      { id: "1", type: "function", name: "list_files", arguments: "{}" },
      { id: "2", type: "function", name: "search_web", arguments: "{}" },
    ];
    expect(adaptiveToolCallLimit(readTools, 4)).toBe(4);
    const mutating = [
      { id: "1", type: "function", name: "exec_command", arguments: "{}" },
      { id: "2", type: "function", name: "list_files", arguments: "{}" },
    ];
    expect(adaptiveToolCallLimit(mutating, 4)).toBe(1);
  });
});

describe("buildToolResponse", () => {
  it("emits non-stream JSON with finish_reason tool_calls", async () => {
    const resp = buildToolResponse(
      "chatcmpl-x",
      "m",
      false,
      true,
      [{ id: "call_1", type: "function", name: "bash", arguments: '{"command":"ls"}' }],
      { text: "running", reasoning: "", conversationId: "c", sessionId: "s", requestId: "r" }
    );
    const body = (await resp.json()) as Record<string, any>;
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("bash");
  });

  it("streams chunked arguments ending with finish_reason tool_calls and [DONE]", async () => {
    const resp = buildToolResponse(
      "chatcmpl-y",
      "m",
      true,
      true,
      [{ id: "call_2", type: "function", name: "bash", arguments: '{"command":"' + "x".repeat(1200) + '"}' }],
      { text: "", reasoning: "", conversationId: "c", sessionId: "s", requestId: "r" }
    );
    const text = await resp.text();
    expect(text).toContain('"name":"bash"');
    expect(text).toContain('"finish_reason":"tool_calls"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    // role delta comes first
    expect(text.indexOf('"role":"assistant"')).toBeGreaterThanOrEqual(0);
  });

  it("allowedToolNames collects declared names", () => {
    expect([...allowedToolNames(TOOLS)].sort()).toEqual(["bash", "read_file"]);
  });
});

import { describe, it, expect } from "vitest";
import { responsesToOpenAI, estimateResponsesUsage, buildResponsesResponse } from "../src/api/responses";

describe("responsesToOpenAI", () => {
  it("converts instructions and string input", () => {
    const { o, error } = responsesToOpenAI({
      model: "gpt-5.6-sol",
      instructions: "be brief",
      input: "hello",
    });
    expect(error).toBeUndefined();
    expect(o.messages![0]).toEqual({ role: "system", content: "be brief" });
    expect(o.messages![1]).toEqual({ role: "user", content: "hello" });
  });

  it("maps function_call_output / function_call items", () => {
    const { o } = responsesToOpenAI({
      model: "m",
      input: [
        { type: "function_call", call_id: "call_a", name: "bash", arguments: '{"command":"ls"}' },
        { role: "assistant", content: "checking..." },
        { type: "function_call_output", call_id: "call_a", output: "file1\nfile2" },
      ],
    });
    const msgs = o.messages!;
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].tool_calls![0]).toMatchObject({ id: "call_a", type: "function" });
    expect(JSON.parse((msgs[0].tool_calls![0]["function"] as Record<string, unknown>)["arguments"] as string)).toEqual({ command: "ls" });
    expect(msgs[2]).toEqual({ role: "tool", tool_call_id: "call_a", content: "file1\nfile2" });
  });

  it("skips valid function_call_progress metadata items and rejects invalid ones", () => {
    // Valid progress (call_id + message) is transport metadata, not a turn.
    const ok = responsesToOpenAI({
      model: "m",
      input: [
        { type: "function_call_progress", call_id: "c", message: "running" },
        { role: "user", content: "go" },
      ],
    });
    expect(ok.o.messages).toHaveLength(1);
    expect(ok.error).toBeUndefined();
    // Missing message -> invalid like upstream parseToolProgress.
    const bad = responsesToOpenAI({
      model: "m",
      input: [{ type: "function_call_progress", call_id: "c" }],
    });
    expect(bad.error).toBe("invalid function_call_progress");
  });

  it("bridges custom exec tools to JSON schema functions", () => {
    const { o } = responsesToOpenAI({
      model: "m",
      input: "run ls",
      tools: [{ type: "custom", name: "exec", description: "run commands" }],
    });
    expect(o.tools![0].type).toBe("custom");
    const fn = o.tools![0].function!;
    expect(fn["name"]).toBe("exec");
    expect(fn["parameters"]).toMatchObject({ type: "object", required: ["input"] });
  });
});

describe("estimateResponsesUsage", () => {
  it("produces codex-shaped usage with framing tokens", () => {
    const est = estimateResponsesUsage("gpt-5.6-sol", [{ role: "user", content: "abcd abcd" }], "ok");
    expect(est.values.input_tokens).toBeGreaterThan(7); // > framing constants
    expect(est.values.output_tokens).toBeGreaterThanOrEqual(3);
    expect(est.source).toContain("heuristic");
  });
});

describe("buildResponsesResponse", () => {
  it("projects text answers into message output items (non-stream)", async () => {
    const src = {
      choices: [{ message: { content: "the answer" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    };
    const resp = buildResponsesResponse("gpt-5.6-sol", false, src);
    const body = (await resp.json()) as Record<string, any>;
    expect(body.object).toBe("response");
    expect(body.output[0].type).toBe("message");
    expect(body.output[0].content[0].text).toBe("the answer");
    expect(body.usage.total_tokens).toBe(8);
  });

  it("replays function calls as function_call output items in stream order", async () => {
    const src = {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: "call_9", type: "function", function: { name: "bash", arguments: '{"command":"pwd"}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const resp = buildResponsesResponse("m", true, src);
    const text = await resp.text();
    expect(text).toContain("event: response.created");
    expect(text).toContain('"type":"function_call"');
    expect(text).toContain("response.function_call_arguments.delta");
    expect(text).toContain("event: response.completed");
  });
});

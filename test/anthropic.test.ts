import { describe, it, expect } from "vitest";
import { anthropicToOpenAI, buildAnthropicBlocks } from "../src/api/anthropic";

describe("anthropicToOpenAI", () => {
  it("maps system (string and block array) and text blocks", () => {
    const { o, error } = anthropicToOpenAI({
      model: "m",
      system: [{ type: "text", text: "be nice" }],
      max_tokens: 100,
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: "hello" },
      ],
    });
    expect(error).toBeUndefined();
    const msgs = o.messages!;
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toBe("be nice");
    expect(msgs[1].role).toBe("user");
    expect(Array.isArray(msgs[1].content)).toBe(true);
    expect(msgs[2]).toEqual({ role: "assistant", content: "hello" });
    expect(o.stream).toBe(false); // inner adapter always non-streaming
    expect(o.max_completion_tokens).toBe(100);
  });

  it("converts tool_result into tool messages and images into placeholders", () => {
    const { o } = anthropicToOpenAI({
      model: "m",
      max_tokens: 10,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AAAA" },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_7", content: "42" },
            { type: "text", text: "done?" },
          ],
        },
      ],
    });
    const first = o.messages![0].content as unknown[];
    expect((first[0] as Record<string, unknown>)["type"]).toBe("input_image");
    expect((first[0] as Record<string, unknown>)["image_url"]).toContain("data:image/png;base64,AAAA");
    expect(o.messages![1]).toEqual({
      role: "tool",
      tool_call_id: "call_7",
      content: "42",
    });
  });

  it("keeps tool_use as structured assistant tool_calls (C9)", () => {
    const { o } = anthropicToOpenAI({
      model: "m",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling..." },
            { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
          ],
        },
      ],
    });
    const m = o.messages![0];
    expect(m.role).toBe("assistant");
    expect(m.tool_calls).toHaveLength(1);
    const tc = m.tool_calls![0] as Record<string, unknown>;
    expect(tc["id"]).toBe("tu_1");
    expect(tc["type"]).toBe("function");
    const fn = tc["function"] as Record<string, unknown>;
    expect(fn["name"]).toBe("bash");
    expect(JSON.parse(fn["arguments"] as string)).toEqual({ command: "ls" });
  });

  it("passes stop_sequences through (C10)", () => {
    const { o } = anthropicToOpenAI({
      model: "m",
      stop_sequences: ["</tool>", "END"],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(o.stop).toEqual(["</tool>", "END"]);
  });
});

describe("buildAnthropicBlocks", () => {
  it("emits thinking block before text when reasoning present", () => {
    const { blocks, stopReason } = buildAnthropicBlocks({
      content: "answer",
      reasoning_content: "because...",
    });
    expect(stopReason).toBe("end_turn");
    expect(blocks[0]).toEqual({ type: "thinking", thinking: "because...", signature: "" });
    expect(blocks[1]).toEqual({ type: "text", text: "answer" });
  });

  it("never returns empty content list", () => {
    const { blocks } = buildAnthropicBlocks({ content: "" });
    expect(blocks).toEqual([{ type: "text", text: "" }]);
  });
});

import { describe, it, expect } from "vitest";
import { extractToolEvents, nativeToolCalls } from "../src/pipeline/tools";

// Frames shaped like real ChatHub update traffic carrying cloud-native tool
// invocations (pluginName/functionArguments et al).
const FRAME = {
  type: 1,
  target: "update",
  arguments: [
    {
      messages: [
        { messageType: "Progress", progress: "running" },
        {
          toolInvocation: {
            pluginName: "read_file",
            functionArguments: { path: "/tmp/a.txt" },
          },
        },
      ],
    },
  ],
};

describe("extractToolEvents", () => {
  it("finds invocations at nested levels, not only messages[]", () => {
    const events = extractToolEvents(FRAME);
    expect(events).toHaveLength(1);
    expect(events[0].toolName).toBe("read_file");
    expect(events[0].arguments).toEqual({ path: "/tmp/a.txt" });
  });

  it("recognises every documented name and arguments key", () => {
    const cases: Record<string, unknown>[] = [
      { name: "a", arguments: { x: 1 } },
      { toolName: "b", args: [1, 2] },
      { pluginName: "c", parameters: "raw" },
      { functionName: "d", input: null },
    ];
    // input:null must NOT count (null argument fields are skipped)
    const events = extractToolEvents(cases);
    const names = events.map((e) => e.toolName).sort();
    expect(names).toEqual(["a", "b", "c"]);
  });

  it("dedupes by name + JSON(arguments)", () => {
    const raw = [
      { pluginName: "bash", functionArguments: { command: "ls" } },
      { name: "bash", args: { command: "ls" } },
      { toolName: "bash", parameters: { command: "dir" } },
    ];
    const events = extractToolEvents(raw);
    expect(events).toHaveLength(2);
    expect(events.filter((e) => e.toolName === "bash")).toHaveLength(2);
  });

  it("ignores objects that only have a name or only an arguments field", () => {
    expect(extractToolEvents([{ name: "solo" }, { arguments: {} }])).toHaveLength(0);
  });

  it("does not descend into a recorded invocation's argument payload", () => {
    const raw = [
      { pluginName: "outer", functionArguments: { inner: { name: "outer", input: { deep: true } } } },
    ];
    expect(extractToolEvents(raw)).toHaveLength(1);
  });
});

describe("nativeToolCalls", () => {
  it("keeps only client-declared tool names", () => {
    const raw = [
      FRAME,
      { type: 1, target: "update", arguments: [{ pluginName: "not_declared", args: {} }] },
    ];
    const calls = nativeToolCalls(raw, new Set(["read_file"]));
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("read_file");
    expect(JSON.parse(calls[0].arguments)).toEqual({ path: "/tmp/a.txt" });
  });

  it("assigns call_ prefixed unique ids", () => {
    const calls = nativeToolCalls(
      [
        { pluginName: "bash", args: { command: "a" } },
        { pluginName: "bash", args: { command: "b" } },
      ],
      new Set(["bash"])
    );
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.id.startsWith("call_")).toBe(true);
    }
    expect(calls[0].id).not.toBe(calls[1].id);
  });

  it("never infers calls from prose-only frames", () => {
    const proseFrames = [
      { type: 1, target: "update", arguments: [{ messages: [{ text: "I will run bash ls -la now" }] }] },
      { type: 3, item: { result: { value: "Discussed the bash tool" } } },
    ];
    expect(nativeToolCalls(proseFrames, new Set(["bash"]))).toHaveLength(0);
  });
});

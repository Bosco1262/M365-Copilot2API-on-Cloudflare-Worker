import { describe, it, expect } from "vitest";
import { sha256B64Url, estimateTokens, extractOIDTID } from "../src/util";
import { normalizeJSONText } from "../src/pipeline/prompt";
import { flattenPromptMessages } from "../src/pipeline/prompt";
import { modelTone, reasoningTone, modelCatalog } from "../src/pipeline/catalog";
import { defaultSettings, DEFAULT_MODEL_MAPPINGS, validateSettings } from "../src/store/settings";

describe("sha256B64Url (PKCE S256)", () => {
  it("matches the RFC 7636 appendix B test vector", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await sha256B64Url(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("estimateTokens", () => {
  it("mirrors runeCount*2/3", () => {
    expect(estimateTokens("hello")).toBe(3); // 5*2/3 -> 3
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("你好世界")).toBe(2); // 4 runes
  });
});

describe("extractOIDTID", () => {
  it("reads oid/tid from JWT claims", () => {
    const payload = Buffer.from(
      JSON.stringify({ oid: "o1", tid: "t1", email: "a@b.c" }),
      "utf8"
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const token = `hdr.${payload}.sig`;
    expect(extractOIDTID(token)).toEqual({ oid: "o1", tid: "t1" });
  });
  it("returns blanks for garbage", () => {
    expect(extractOIDTID("not-a-jwt")).toEqual({ oid: "", tid: "" });
  });
});

describe("normalizeJSONText", () => {
  it("strips fenced json", () => {
    expect(normalizeJSONText('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(normalizeJSONText('  {"a":1}  ')).toBe('{"a":1}');
  });
});

describe("flattenPromptMessages", () => {
  it("separates system blocks and roles; images become attachments", async () => {
    const { prompt, attachments } = await flattenPromptMessages([
      { role: "system", content: "be nice" },
      { role: "user", content: "hi" },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "https://example.com/x.png" } },
        ],
      },
      { role: "assistant", content: "ok" },
    ]);
    expect(prompt).toContain("[system]\nbe nice");
    expect(prompt).toContain("[user]\nhi");
    expect(prompt).toContain("[assistant]\nok");
    expect(attachments).toHaveLength(1);
    expect(attachments[0].url).toBe("https://example.com/x.png");
  });
  it("renders tool results with ids", async () => {
    const { prompt } = await flattenPromptMessages([
      { role: "tool", tool_call_id: "call_9", content: '{"result":42}' },
    ]);
    expect(prompt).toContain("[tool result id=call_9]");
    expect(prompt).toContain('{"result":42}');
  });
});

describe("tone routing", () => {
  it("maps explicit reasoning aliases verbatim", () => {
    expect(modelTone("gpt-5.5-reasoning")).toBe("Gpt_5_5_Reasoning");
    expect(modelTone("claude-sonnet")).toBe("Claude_Sonnet");
    expect(modelTone("unknown-model")).toBe("magic");
  });

  it("uses configured mapping first", () => {
    const settings = defaultSettings({ "m365-copilot2api_KV": {} as never } as never);
    settings.modelMappings = [
      { publicModel: "my-model", upstreamTone: "Gpt_5_4_Chat", displayName: "M", defaultReasoningLevel: "low" },
    ];
    const tone = reasoningTone("My-Model", "", settings);
    expect(tone).toBe("Gpt_5_4_Chat");
  });

  it("pins mapped models to their tone regardless of effort", () => {
    const settings = defaultSettings({ "m365-copilot2api_KV": {} as never } as never);
    settings.modelMappings = [...DEFAULT_MODEL_MAPPINGS];
    expect(reasoningTone("claude-sonnet", "high", settings)).toBe("Claude_Sonnet");
    expect(reasoningTone("gpt-5.4", "high", settings)).toBe("Gpt_5_4_Chat");
    expect(reasoningTone("gpt-5.4", "low", settings)).toBe("Gpt_5_4_Chat");
  });

  it("rejects models missing from the mapping table", () => {
    const settings = defaultSettings({ "m365-copilot2api_KV": {} as never } as never);
    settings.modelMappings = [];
    expect(reasoningTone("claude-sonnet", "high", settings)).toBeInstanceOf(Error);
    expect(reasoningTone("unknown-model", "high", settings)).toBeInstanceOf(Error);
    expect(reasoningTone("unknown-model", "bad", settings)).toBeInstanceOf(Error);
  });

  it("drops deleted mappings from the catalog and rejects their use", () => {
    const settings = defaultSettings({ "m365-copilot2api_KV": {} as never } as never);
    settings.modelMappings = DEFAULT_MODEL_MAPPINGS.filter((m) => m.publicModel !== "gpt-5.4");
    expect(reasoningTone("gpt-5.4", "", settings)).toBeInstanceOf(Error);
    const ids = modelCatalog(settings).map((m) => m["id"]);
    expect(ids).not.toContain("gpt-5.4");
    expect(ids).toContain("gpt-5.2");
  });

  it("rejects invalid effort values", () => {
    const settings = defaultSettings({ "m365-copilot2api_KV": {} as never } as never);
    expect(reasoningTone("gpt-5.6-sol", "ultra", settings)).toBeInstanceOf(Error);
  });
});

describe("modelCatalog", () => {
  it("contains defaults plus mappings with codex-style fields", () => {
    const settings = defaultSettings({ "m365-copilot2api_KV": {} as never } as never);
    settings.modelMappings = [...DEFAULT_MODEL_MAPPINGS];
    const catalog = modelCatalog(settings);
    const ids = catalog.map((m) => m["id"]);
    expect(ids).toContain("gpt-5.2");
    expect(ids).toContain("claude-sonnet");
    expect(ids).toContain("gpt-image-2");
    const gpt52 = catalog.find((m) => m["id"] === "gpt-5.2")!;
    expect(gpt52["default_reasoning_level"]).toBe("medium");
    expect((gpt52["capabilities"] as Record<string, unknown>)["streaming"]).toBe(true);
    expect(typeof gpt52["context_window"]).toBe("number");
  });
});

describe("validateSettings mappings", () => {
  const base = () => defaultSettings({ "m365-copilot2api_KV": {} as never } as never);

  it("rejects empty modelMappings", () => {
    const s = base();
    s.modelMappings = [];
    expect(validateSettings(s)).toMatch(/模型映射/);
  });

  it("accepts non-whitelisted but well-formed tones", () => {
    const s = base();
    s.modelMappings = [
      { publicModel: "future-model", upstreamTone: "Gpt_9_9_From_Sync", displayName: "F", defaultReasoningLevel: "medium" },
    ];
    expect(validateSettings(s)).toBeNull();
  });

  it("rejects malformed tones", () => {
    const s = base();
    s.modelMappings = [
      { publicModel: "bad-tone", upstreamTone: "not a tone!", displayName: "B", defaultReasoningLevel: "medium" },
    ];
    expect(validateSettings(s)).toMatch(/tone/);
  });
});

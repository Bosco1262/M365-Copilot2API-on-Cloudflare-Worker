import { describe, it, expect } from "vitest";
import { sha256B64Url, estimateTokens, extractOIDTID } from "../src/util";
import { normalizeJSONText } from "../src/pipeline/prompt";
import { flattenPromptMessages } from "../src/pipeline/prompt";
import { modelTone, reasoningTone, modelCatalog } from "../src/pipeline/catalog";
import { defaultSettings, DEFAULT_MODEL_MAPPINGS } from "../src/store/settings";

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

  it("escalates to reasoning tones for higher efforts", () => {
    const settings = defaultSettings({ "m365-copilot2api_KV": {} as never } as never);
    settings.modelMappings = [...DEFAULT_MODEL_MAPPINGS];
    expect(reasoningTone("claude-sonnet", "high", settings)).toBe("Claude_Sonnet_Reasoning");
    expect(reasoningTone("gpt-5.4", "high", settings)).toBe("Gpt_5_4_Reasoning");
    expect(reasoningTone("gpt-5.4", "low", settings)).toBe("Gpt_5_4_Chat");
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
    expect(ids).toContain("gpt-5.6-sol");
    expect(ids).toContain("gpt-5.2");
    const sol = catalog.find((m) => m["id"] === "gpt-5.6-sol")!;
    expect(sol["default_reasoning_level"]).toBe("low");
    expect((sol["capabilities"] as Record<string, unknown>)["streaming"]).toBe(true);
    expect(typeof sol["context_window"]).toBe("number");
  });
});

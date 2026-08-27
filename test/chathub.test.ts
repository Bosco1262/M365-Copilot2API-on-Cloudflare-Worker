import { describe, it, expect } from "vitest";
import {
  RS,
  buildWSURL,
  chatPayload,
  rateLimitedText,
  imageLimitText,
  contentPolicyText,
  classifyUpdateMessages,
  toolProtocolPrompt,
  stripCitationMarkers,
} from "../src/chathub/protocol";

const acc = { accessToken: "tok", oid: "oid-1", tid: "tid-1" };

describe("buildWSURL", () => {
  it("includes oid@tid path and required query params", () => {
    const url = new URL(buildWSURL(acc, "sess", "conv", "req"));
    expect(url.origin).toBe("wss://substrate.office.com");
    expect(url.pathname).toBe("/m365Copilot/Chathub/oid-1@tid-1");
    expect(url.searchParams.get("X-SessionId")).toBe("sess");
    expect(url.searchParams.get("ConversationId")).toBe("conv");
    expect(url.searchParams.get("access_token")).toBe("tok");
    expect(url.searchParams.get("XRoutingParameterSessionKey")).toBe("req");
    expect(url.searchParams.get("isEdu")).toBe("false");
    // source keeps literal quotes like the browser probe
    expect(url.searchParams.get("source")).toBe('"officeweb"');
    expect(url.searchParams.get("variants")!.startsWith("EnableMcpServerWidgets")).toBe(true);
    expect(url.searchParams.get("scenario")).toBe("OfficeWebIncludedCopilot");
  });
  it("supports disableMemory", () => {
    const url = new URL(buildWSURL(acc, "sess", "conv", "req", { disableMemory: true }));
    expect(url.searchParams.get("disableMemory")).toBe("1");
  });
});

describe("chatPayload", () => {
  it("emits chat invocation frame plus metrics frame separated by RS", () => {
    const raw = chatPayload("hi", "s1", "c1", "r1", "magic", true);
    const parts = raw.split(RS).filter((x) => x.trim() !== "");
    expect(parts).toHaveLength(2);
    const chat = JSON.parse(parts[0]);
    const metrics = JSON.parse(parts[1]);
    expect(chat.type).toBe(4);
    expect(chat.target).toBe("chat");
    expect(chat.invocationId).toBe("0");
    const arg = chat.arguments[0];
    expect(arg.sessionId).toBe("s1");
    // Upstream arg0 carries no conversationId (identity lives in the WS URL).
    expect(arg.conversationId).toBeUndefined();
    // HAR evidence: isStartOfSession is always false even on the first turn.
    expect(arg.isStartOfSession).toBe(false);
    expect(arg.tone).toBe("magic");
    expect(arg.source).toBe("officeweb");
    expect(arg.isSbsSupported).toBe(true);
    expect(arg.renderReferencesBehindEOS).toBe(true);
    expect(arg.disconnectBehavior).toBe("continue");
    expect(arg.message.text).toBe("hi");
    expect(arg.message.author).toBe("user");
    expect(Array.isArray(arg.optionsSets)).toBe(true);
    expect(arg.optionsSets).toContain("cwc_code_interpreter");
    expect(arg.optionsSets).toContain("flux_v3_references");
    expect(arg.allowedMessageTypes).toContain("GeneratedCode");
    expect(arg.allowedMessageTypes).toContain("TriggerPlugin");
    expect(arg.message.clientInfo.clientPlatform).toBe("mcmcopilot-web");
    expect(metrics.type).toBe(1);
    expect(metrics.target).toBe("Metrics");
    expect(metrics.arguments[0].Timestamps.ConnectionStart).not.toBe("");
  });
});

describe("rateLimitedText", () => {
  it("detects throttling notices", () => {
    expect(rateLimitedText("I am temporarily unable to respond to this many requests")).toBe(true);
    expect(rateLimitedText("太多请求")).toBe(true);
    expect(rateLimitedText("Too many requests, please retry later")).toBe(true);
  });
  it("ignores normal answers", () => {
    expect(rateLimitedText("Hello! How can I help?")).toBe(false);
  });
});

describe("classifyUpdateMessages", () => {
  it("marks ChainOfThought messages as reasoning", () => {
    const out = classifyUpdateMessages([
      { text: "thinking...", contentOrigin: "ChainOfThoughtSummary" },
      { text: "answer text" },
      { text: "", messageType: "" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].kind).toBe("reasoning");
    expect(out[1].kind).toBe("text");
  });
  it("marks progress frames", () => {
    const out = classifyUpdateMessages([{ text: "searching", contentType: "SearchResults" }]);
    expect(out[0].kind).toBe("progress");
  });
});

describe("A7 detectors", () => {
  it("imageLimitText detects quota notices", () => {
    expect(imageLimitText("很抱歉，您今天无法生成更多图像")).toBe(true);
    expect(imageLimitText("unable to generate more images today")).toBe(true);
    expect(imageLimitText("normal answer")).toBe(false);
  });
  it("contentPolicyText detects polite refusals", () => {
    expect(contentPolicyText("很抱歉，我无法响应这个请求")).toBe(true);
    expect(contentPolicyText("i'm sorry, i can't respond to that")).toBe(true);
    expect(contentPolicyText("Here is the answer.")).toBe(false);
    // >300 chars never triggers (upstream guard)
    expect(contentPolicyText("很抱歉，我无法响应" + "x".repeat(400))).toBe(false);
  });
});

describe("B11 toolProtocolPrompt", () => {
  it("adds the no-truncation prefix when no tools/plugins", () => {
    const out = toolProtocolPrompt("hi", [], undefined, false);
    expect(out).toContain("Do not truncate or abbreviate your response.");
    expect(out).toContain("hi");
  });
  it("generates fenced <tools> defs for declared tools", () => {
    const out = toolProtocolPrompt(
      "run ls",
      [{ type: "function", function: { name: "bash", description: "run", parameters: { type: "object" } } }],
      "auto",
      false
    );
    expect(out).toContain("<tools>");
    expect(out).toContain("```bash");
    expect(out).toContain("User request:\nrun ls");
  });
  it("returns the raw text when plugins are advertised", () => {
    const out = toolProtocolPrompt("hi", [{ type: "function", function: { name: "t" } }], "auto", true);
    expect(out).toBe("hi");
  });
});

describe("C18 stripCitationMarkers", () => {
  it("removes markers and returns target links", () => {
    const refs = { "ref-1": { targetLink: "https://example.com/1" } };
    const { text, urls } = stripCitationMarkers(`see \uE200cite\uE202ref-1\uE201 for details`, refs);
    expect(text).toBe("see  for details");
    expect(urls).toEqual(["https://example.com/1"]);
  });
});

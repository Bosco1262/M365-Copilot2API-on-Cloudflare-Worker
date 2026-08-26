import { describe, it, expect } from "vitest";
import {
  RS,
  buildWSURL,
  chatPayload,
  rateLimitedText,
  classifyUpdateMessages,
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
    // source keeps literal quotes like the browser probe
    expect(url.searchParams.get("source")).toBe('"officeweb"');
    expect(url.searchParams.get("variants")!.startsWith("EnableMcpServerWidgets")).toBe(true);
    expect(url.searchParams.get("scenario")).toBe("OfficeWebIncludedCopilot");
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
    expect(arg.conversationId).toBe("c1");
    expect(arg.isStartOfSession).toBe(true);
    expect(arg.tone).toBe("magic");
    expect(arg.source).toBe("officeweb");
    expect(arg.message.text).toBe("hi");
    expect(arg.message.author).toBe("user");
    expect(Array.isArray(arg.optionsSets)).toBe(true);
    expect(metrics.type).toBe(1);
    expect(metrics.target).toBe("Metrics");
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

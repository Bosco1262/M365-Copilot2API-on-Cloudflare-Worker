import { describe, it, expect } from "vitest";
import { normalizeFrame, semanticEvents } from "../src/chathub/protocol";
import { isRateLimited, isAuthFailure, isEmptyCompletion } from "../src/errors";
import { DialError, EmptyCompletion, RateLimitNotice, UpstreamHTTPError } from "../src/errors";

describe("normalizeFrame", () => {
  it("classifies signalr frames", () => {
    expect(normalizeFrame({ type: 6 }).kind).toBe("ping");
    expect(normalizeFrame({ type: 1, target: "update" }).kind).toBe("update");
    expect(normalizeFrame({ type: 2 }).kind).toBe("result");
    expect(normalizeFrame({ type: 3 }).kind).toBe("complete");
    expect(normalizeFrame({ type: 3, error: { x: 1 } }).kind).toBe("error");
    expect(normalizeFrame({ type: 1, target: "other" }).kind).toBe("target");
  });
});

describe("semanticEvents", () => {
  it("extracts search/code/tool progress cards", () => {
    const out = semanticEvents([
      { type: 1, target: "update", arguments: [{ messages: [
        { text: "q", contentType: "SearchResults" },
        { text: "code", contentType: "Code" },
        { text: "tool", messageType: "Progress" },
        { text: "plain" },
      ] }] },
      { type: 3 },
    ]);
    expect(out.map((e) => e.kind)).toEqual([
      "search.progress",
      "code.progress",
      "tool.progress",
      "message",
    ]);
  });
});

describe("error taxonomy", () => {
  it("classifies dial and http errors", () => {
    expect(isRateLimited(new DialError(429))).toBe(true);
    expect(isRateLimited(new DialError(503))).toBe(true);
    expect(isRateLimited(new DialError(403))).toBe(false);
    expect(isAuthFailure(new DialError(401))).toBe(true);
    expect(isAuthFailure(new UpstreamHTTPError(403))).toBe(true);
    expect(isRateLimited(new RateLimitNotice())).toBe(true);
    expect(isRateLimited(new UpstreamHTTPError(503, 0, "you are limited"))).toBe(true);
    expect(isEmptyCompletion(new EmptyCompletion())).toBe(true);
    expect(isAuthFailure(new Error("plain"))).toBe(false);
  });
});

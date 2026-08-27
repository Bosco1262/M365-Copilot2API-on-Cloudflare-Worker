import { describe, it, expect } from "vitest";
import {
  DialError,
  classifyTransportError,
  dialErrorKind,
  isImageLimited,
  isContentPolicy,
  ImageLimitError,
  ContentPolicyError,
} from "../src/errors";

describe("C3 DialError kind classification", () => {
  it("maps HTTP statuses to upstream kinds", () => {
    expect(dialErrorKind(429)).toBe("QUOTA_429");
    expect(dialErrorKind(503)).toBe("OVERLOAD_503");
    expect(dialErrorKind(401)).toBe("AUTH_EXPIRED_401");
    expect(dialErrorKind(403)).toBe("FORBIDDEN_403");
  });
  it("classifies transport error messages", () => {
    expect(classifyTransportError("dial tcp: no such host")).toBe("DNS");
    expect(classifyTransportError("tls: handshake failure")).toBe("TLS");
    expect(classifyTransportError("websocket: bad handshake")).toBe("WS_HANDSHAKE");
    expect(classifyTransportError("i/o timeout")).toBe("WS_READ_TIMEOUT");
    expect(classifyTransportError("connection refused")).toBe("TCP");
    expect(classifyTransportError("proxyconnect tcp: socks5")).toBe("SOCKS5");
  });
  it("marks client cancel and carries kind on the error", () => {
    const abort = new DOMException("aborted", "AbortError");
    expect(dialErrorKind(0, abort)).toBe("CLIENT_CANCELED");
    const e = new DialError(429, 30, dialErrorKind(429));
    expect(e.kind).toBe("QUOTA_429");
    expect(e.retryAfter).toBe(30);
    expect(e.message).toContain("QUOTA_429");
  });
});

describe("A7 error helpers", () => {
  it("recognizes image-limit and content-policy errors", () => {
    expect(isImageLimited(new ImageLimitError())).toBe(true);
    expect(isImageLimited(new Error("other"))).toBe(false);
    expect(isContentPolicy(new ContentPolicyError())).toBe(true);
    expect(isContentPolicy(new Error("other"))).toBe(false);
  });
});

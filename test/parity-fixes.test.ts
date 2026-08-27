// Regression tests for the A3/A5/A9/A10 parity fixes:
//  - A3: m365Metadata gains the full compat_metadata.go fields + events opt-in
//  - A5: RateLimitNotice is verified with a fresh probe before cooling down
//  - A9: exact AAD endpoint overrides (M365_AUTHORIZE_ENDPOINT etc.)
//  - A10: responses history is isolated per (tenant, session) with a cap
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MockKV } from "./helpers/mockkv";
import { oauthConfig, type Env } from "../src/env";
import { m365Metadata } from "../src/api/openai";
import { saveHistory, loadHistory } from "../src/api/responses";
import type { HandlerCtx } from "../src/router";

const { chatMock, markSuccessMock, markFailureMock } = vi.hoisted(() => ({
  chatMock: vi.fn(),
  markSuccessMock: vi.fn(async () => {}),
  markFailureMock: vi.fn(async () => {}),
}));

vi.mock("../src/chathub/client", () => ({
  chat: (...args: unknown[]) => chatMock(...(args as [unknown, unknown, { onDelta?: (t: string) => void }, unknown])),
  uploadAttachments: vi.fn(async () => {}),
}));

vi.mock("../src/pipeline/account", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/pipeline/account")>();
  return {
    ...actual,
    resolveAccount: vi.fn(async () => ({
      id: "acc-1",
      email: "t@t.local",
      status: "online",
      accessToken: "tok",
      refreshToken: "",
      expiresAt: "2099-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      oid: "oid-1",
      tid: "tid-1",
    })),
    markSuccess: markSuccessMock,
    markFailure: markFailureMock,
    nextHealthyAccount: vi.fn(async () => null),
  };
});

import { RateLimitNotice } from "../src/errors";
import { handleChatCompletions } from "../src/api/openai";

function makeCtx(body: Record<string, unknown>, headers: Record<string, string> = {}): { ctx: HandlerCtx; pending: Promise<unknown>[] } {
  const env = { "m365-copilot2api_KV": new MockKV() } as unknown as Env;
  const req = new Request("http://worker.test/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer m365_test_key", ...headers },
    body: JSON.stringify(body),
  });
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      env,
      req,
      url: new URL("http://worker.test/v1/chat/completions"),
      requestId: "req-test",
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    } as unknown as HandlerCtx,
    pending,
  };
}

describe("A3: m365Metadata parity", () => {
  it("emits the full compat_metadata.go field set", () => {
    const res = {
      conversationId: "c1",
      sessionId: "s1",
      requestId: "r1",
      throttling: { level: 1 },
      suggestedResponses: [{ text: "ok" }],
      offense: "none",
      scores: [{ label: "x", score: 1 }],
      conversationTransferToken: "tkn",
      meteringInformation: { group: "g" },
      spokenText: "hello",
      timestamps: { requestSent: "2026-01-01T00:00:00.000Z" },
      storageMessageId: "st1",
      references: { k1: { targetLink: "https://x", title: "T", snippet: "S", providerDisplayName: "P" } },
      events: [{ type: "update" }],
    };
    const m = m365Metadata(res, {} as Env);
    expect(m.conversationId).toBe("c1");
    expect(m.throttling).toEqual({ level: 1 });
    expect(m.suggestedResponses).toHaveLength(1);
    expect(m.offense).toBe("none");
    expect(m.scores).toHaveLength(1);
    expect(m.conversationTransferToken).toBe("tkn");
    expect(m.meteringInformation).toEqual({ group: "g" });
    expect(m.spokenText).toBe("hello");
    expect(m.timestamps).toBeDefined();
    expect(m.storageMessageId).toBe("st1");
    expect(m.citations).toEqual([{ key: "k1", url: "https://x", title: "T", snippet: "S", provider: "P" }]);
    // events only when the opt-in env is truthy
    expect(m.events).toBeUndefined();
  });

  it("attaches raw events only when M365_INCLUDE_UPSTREAM_EVENTS is enabled", () => {
    const res = { conversationId: "", sessionId: "", requestId: "", events: [{ a: 1 }] };
    const off = m365Metadata(res, {} as Env);
    expect(off.events).toBeUndefined();
    const on = m365Metadata(res, { M365_INCLUDE_UPSTREAM_EVENTS: "1" } as unknown as Env);
    expect(on.events).toEqual([{ a: 1 }]);
  });
});

describe("A9: AAD endpoint overrides", () => {
  it("uses exact env endpoints when provided", () => {
    const cfg = oauthConfig({
      M365_AUTHORIZE_ENDPOINT: "https://custom.example/authorize",
      M365_TOKEN_ENDPOINT: "https://custom.example/token",
      M365_DEVICE_ENDPOINT: "https://custom.example/devicecode",
      M365_DEVICE_TOKEN_ENDPOINT: "https://custom.example/device-token",
    } as unknown as Env);
    expect(cfg.authorizeEndpoint).toBe("https://custom.example/authorize");
    expect(cfg.tokenEndpoint).toBe("https://custom.example/token");
    expect(cfg.deviceCodeEndpoint).toBe("https://custom.example/devicecode");
    expect(cfg.deviceTokenEndpoint).toBe("https://custom.example/device-token");
  });

  it("falls back to authority-derived paths", () => {
    const cfg = oauthConfig({ M365_AUTHORITY: "https://login.example/common" } as unknown as Env);
    expect(cfg.authorizeEndpoint).toBe("https://login.example/common/oauth2/v2.0/authorize");
    expect(cfg.tokenEndpoint).toBe("https://login.example/common/oauth2/v2.0/token");
    expect(cfg.deviceCodeEndpoint).toBe("https://login.example/common/oauth2/v2.0/devicecode");
  });
});

describe("A10: responses history isolation", () => {
  function kvCtx(kv: MockKV, sessionId = "sess-a"): HandlerCtx {
    return {
      env: { "m365-copilot2api_KV": kv } as unknown as Env,
      req: new Request("http://worker.test/v1/responses", { headers: { "X-M365-Session-Id": sessionId } }),
      url: new URL("http://worker.test/v1/responses"),
      requestId: "r",
      waitUntil: () => {},
    } as unknown as HandlerCtx;
  }

  it("scopes history per (tenant, session)", async () => {
    const kv = new MockKV();
    const a = kvCtx(kv, "sess-a");
    const b = kvCtx(kv, "sess-b");
    await saveHistory(a, "tenant-1", "sess-a", "resp_x", [{ role: "user", content: "hi" }]);
    // Same tenant, different session -> not visible.
    expect(await loadHistory(b, "tenant-1", "sess-b", "resp_x")).toBeNull();
    // Same session -> visible.
    expect(await loadHistory(a, "tenant-1", "sess-a", "resp_x")).toEqual([{ role: "user", content: "hi" }]);
    // Different tenant -> not visible.
    expect(await loadHistory(a, "tenant-2", "sess-a", "resp_x")).toBeNull();
  });

  it("caps the per-bucket history at MAX_RESPONSES_PER_TENANT (256)", async () => {
    const kv = new MockKV();
    const ctx = kvCtx(kv, "sess-a");
    for (let i = 0; i < 260; i++) {
      await saveHistory(ctx, "tenant-1", "sess-a", "resp_" + i, [{ role: "user", content: String(i) }]);
    }
    const listed = await kv.list({ prefix: "resp-history/tenant-1/sess-a/" });
    expect(listed.keys.length).toBeLessThanOrEqual(256);
    // The oldest entries were evicted first.
    expect(listed.keys.some((k) => k.name.endsWith("resp_0"))).toBe(false);
    expect(listed.keys.some((k) => k.name.endsWith("resp_259"))).toBe(true);
  });
});

describe("A5: rate-limit notice confirmation", () => {
  beforeEach(() => {
    chatMock.mockReset();
    markSuccessMock.mockClear();
    markFailureMock.mockClear();
  });

  it("does not cool down the account when the probe succeeds (false positive)", async () => {
    // Call 1 = the failed chat (RateLimitNotice). Call 2 = the confirmation
    // probe (fresh conversation) which succeeds -> account stays healthy.
    let call = 0;
    chatMock.mockImplementation(async () => {
      call++;
      if (call === 1) throw new RateLimitNotice();
      return {
        text: "OK",
        reasoning: "",
        conversationId: "",
        sessionId: "",
        requestId: "r",
        rawResult: "",
        events: [],
        images: [],
      };
    });

    const body = {
      model: "gpt-5.2",
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    };
    const { ctx, pending } = makeCtx(body);
    const res = await handleChatCompletions(ctx);
    await Promise.allSettled(pending);

    expect(chatMock).toHaveBeenCalledTimes(2); // chat + probe
    expect(markSuccessMock).toHaveBeenCalled(); // false positive, no cooldown
    expect(markFailureMock).not.toHaveBeenCalled();
    expect(res.status).toBe(429); // the original request still surfaced 429
  });
});

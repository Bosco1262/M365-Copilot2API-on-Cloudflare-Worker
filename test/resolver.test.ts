import { describe, it, expect } from "vitest";
import {
  contextPrefixLen,
  suffixMatchLen,
  messagesEqual,
  clientIPFingerprint,
  resolveSession,
  bindSession,
  unbindByConversation,
  listResolverSessions,
} from "../src/pipeline/resolver";
import type { OaiMsg } from "../src/pipeline/prompt";
import { MockKV } from "./helpers/mockkv";

const env = { "m365-copilot2api_KV": new MockKV() as unknown as KVNamespace } as unknown as import("../src/env").Env;

function msg(role: string, content: string): OaiMsg {
  return { role, content };
}

describe("messagesEqual", () => {
  it("compares role and text content", () => {
    expect(messagesEqual(msg("user", "hi"), msg("user", "hi"))).toBe(true);
    expect(messagesEqual(msg("user", "hi"), msg("user", "ho"))).toBe(false);
    expect(messagesEqual(msg("user", "hi"), msg("assistant", "hi"))).toBe(false);
  });
});

describe("contextPrefixLen", () => {
  it("returns history length when it is a strict prefix", () => {
    const hist = [msg("user", "a"), msg("assistant", "b")];
    const msgs = [...hist, msg("user", "c")];
    expect(contextPrefixLen(hist, msgs)).toBe(2);
    expect(contextPrefixLen(hist, [msg("user", "x")])).toBe(0);
    expect(contextPrefixLen([], msgs)).toBe(0);
    expect(contextPrefixLen(hist, hist)).toBe(2);
  });
});

describe("suffixMatchLen", () => {
  it("measures the common suffix", () => {
    const hist = [msg("user", "a"), msg("assistant", "b")];
    const msgs = [msg("user", "x"), msg("user", "y"), msg("assistant", "b"), msg("user", "z")];
    // last message differs -> suffix is only the matching tail before it
    const n = suffixMatchLen(hist, [msg("user", "q"), ...hist]);
    expect(n).toBe(2);
    void msgs;
  });
});

describe("clientIPFingerprint", () => {
  it("is deterministic and 32 hex chars", async () => {
    const a = await clientIPFingerprint("1.2.3.4", "UA");
    const b = await clientIPFingerprint("1.2.3.4", "UA");
    const c = await clientIPFingerprint("1.2.3.5", "UA");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("resolveSession / bindSession flow", () => {
  it("starts new, then hits prefix and reports HistoryLen for incremental send", async () => {
    const first = await resolveSession(env, {
      ipFingerprint: "fp1",
      messages: [msg("user", "hello")],
    });
    expect(first.isNew).toBe(true);

    await bindSession(env, {
      sessionId: "",
      conversationId: "conv-1",
      accountId: "acc-1",
      messages: [msg("user", "hello")],
      assistantText: "world",
      ipFingerprint: "fp1",
    });

    // Next turn: same history + one more user message -> prefix hit.
    const second = await resolveSession(env, {
      ipFingerprint: "fp1",
      messages: [msg("user", "hello"), msg("assistant", "world"), msg("user", "next")],
    });
    expect(second.isNew).toBe(false);
    expect(second.matchedBy).toBe("context_prefix_2");
    expect(second.historyLen).toBe(2);
    expect(second.conversationId).toBe("conv-1");

    // Different IP fingerprint must NOT match (cross-user protection).
    const other = await resolveSession(env, {
      ipFingerprint: "other-fp",
      messages: [msg("user", "hello"), msg("assistant", "world"), msg("user", "next")],
    });
    expect(other.isNew).toBe(true);
  });

  it("explicit id wins over everything", async () => {
    await bindSession(env, {
      sessionId: "my-session",
      conversationId: "conv-2",
      accountId: "acc-2",
      messages: [msg("user", "solo")],
      assistantText: "ok",
      ipFingerprint: "fpX",
    });
    const r = await resolveSession(env, {
      explicitId: "my-session",
      ipFingerprint: "different",
      messages: [],
    });
    expect(r.isNew).toBe(false);
    expect(r.matchedBy).toBe("explicit");
    expect(r.conversationId).toBe("conv-2");
  });

  it("bind dedupes by conversation when sessionId empty", async () => {
    await bindSession(env, {
      sessionId: "",
      conversationId: "conv-dup",
      accountId: "a",
      messages: [msg("user", "one")],
      ipFingerprint: "f",
    });
    await bindSession(env, {
      sessionId: "",
      conversationId: "conv-dup",
      accountId: "a",
      messages: [msg("user", "one"), msg("assistant", "r"), msg("user", "two")],
      ipFingerprint: "f",
    });
    const all = await listResolverSessions(env);
    expect(all.filter((s) => s.conversationId === "conv-dup")).toHaveLength(1);
    const dup = all.find((s) => s.conversationId === "conv-dup")!;
    expect(dup.contextHistory?.length).toBe(3);
  });

  it("unbindByConversation removes only the matching conversation", async () => {
    await bindSession(env, {
      sessionId: "keep-me",
      conversationId: "conv-keep",
      accountId: "a",
      messages: [msg("user", "k")],
    });
    await bindSession(env, {
      sessionId: "drop-me",
      conversationId: "conv-drop",
      accountId: "a",
      messages: [msg("user", "d")],
    });
    const removed = await unbindByConversation(env, "conv-drop");
    expect(removed).toBe(1);
    const all = await listResolverSessions(env);
    expect(all.find((s) => s.sessionId === "keep-me")).toBeTruthy();
    expect(all.find((s) => s.sessionId === "drop-me")).toBeUndefined();
  });

  it("contextHistory is capped at 512 messages", async () => {
    const many = Array.from({ length: 600 }, (_, i) => msg("user", `m${i}`));
    await bindSession(env, {
      sessionId: "capped",
      conversationId: "conv-capped",
      accountId: "a",
      messages: many,
    });
    const all = await listResolverSessions(env);
    expect(all.find((s) => s.sessionId === "capped")?.contextHistory?.length).toBe(512);
  });
});

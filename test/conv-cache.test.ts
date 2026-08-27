import { describe, it, expect } from "vitest";
import {
  computeSysHash,
  convCacheKeyFor,
  getConvCache,
  putConvCache,
} from "../src/store/convCache";
import { prepareCore, recordFinalize } from "../src/api/openai";
import type { HandlerCtx } from "../src/router";
import type { Env } from "../src/env";
import { MockKV } from "./helpers/mockkv";

function makeEnv(): Env {
  return { "m365-copilot2api_KV": new MockKV() } as unknown as Env;
}

function makeCtx(env: Env, body: Record<string, unknown>, key = "sk-test-123456789"): HandlerCtx {
  const req = new Request("http://x/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  return {
    env,
    req,
    url: new URL("http://x/v1/chat/completions"),
    requestId: "t",
    waitUntil: () => {},
  } as unknown as HandlerCtx;
}

describe("convCache store", () => {
  it("hashes system prompts and ignores conversations without one", async () => {
    const h1 = await computeSysHash([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ]);
    const h2 = await computeSysHash([{ role: "developer", content: "be terse" }, { role: "user", content: "yo" }]);
    expect(h1).toBe(h2); // system+developer treated the same
    const h3 = await computeSysHash([{ role: "system", content: "other" }]);
    expect(h3).not.toBe(h1);
    expect(await computeSysHash([{ role: "user", content: "no system" }])).toBe("");
  });

  it("round-trips entries under the bucket key", async () => {
    const env = makeEnv();
    const key = convCacheKeyFor("accA", "gpt-5.2");
    expect(key).toContain("convcache:accA|gpt-5.2");
    expect(await getConvCache(env, key)).toBeNull();
    await putConvCache(env, key, {
      accountId: "accA",
      conversationId: "c-1",
      sessionId: "s-1",
      messageCount: 2,
      sysHash: "h",
      lastUsedAt: "",
    });
    const got = await getConvCache(env, key);
    expect(got?.conversationId).toBe("c-1");
    expect(got?.lastUsedAt).not.toBe("");
  });
});

describe("prepareCore convCache integration", () => {
  const SYS = { role: "system", content: "You are a build assistant." };
  const M1 = { role: "user", content: "first question" };

  it("reuses the cached conversation incrementally on a hit", async () => {
    const env = makeEnv();
    // First turn populates the cache through recordFinalize.
    const body1 = { model: "gpt-5.2", messages: [SYS, M1] };
    const p1 = await prepareCore(makeCtx(env, body1), body1);
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    expect(p1.prepared.conversationID).toBe("");
    expect(p1.prepared.convCache?.sysHash).toBeTruthy();
    await recordFinalize(
      makeCtx(env, {}),
      p1.prepared,
      { id: "accX", accessToken: "", expiresAt: "" } as never,
      {
        text: "answer",
        reasoning: "",
        conversationId: "conv-777",
        sessionId: "sess-777",
        requestId: "r",
        rawResult: "",
        events: [],
        images: [],
      },
      { model: "gpt-5.2", endpoint: "/v1/chat/completions", stream: false, sentPrompt: p1.prepared.answerPrompt, startedAt: Date.now() }
    );

    // Second turn adds messages -> hit -> same conversation + incremental prompt.
    const body2 = {
      model: "gpt-5.2",
      messages: [SYS, M1, { role: "assistant", content: "answer" }, { role: "user", content: "follow-up?" }],
    };
    const p2 = await prepareCore(makeCtx(env, body2), body2);
    expect(p2.ok).toBe(true);
    if (!p2.ok) return;
    expect(p2.prepared.conversationID).toBe("conv-777");
    expect(p2.prepared.cloudSessionID).toBe("sess-777");
    expect(p2.prepared.accountID).toBe("accX"); // pinned to the cached account
    expect(p2.prepared.answerPrompt).toContain("follow-up?");
    expect(p2.prepared.answerPrompt).not.toContain("first question");
  });

  it("misses when the sys prompt differs or no new messages arrived", async () => {
    const env = makeEnv();
    const key = convCacheKeyFor("auto", "gpt-5.2");
    await putConvCache(env, key, {
      accountId: "a",
      conversationId: "c9",
      sessionId: "s9",
      messageCount: 4,
      sysHash: await computeSysHash([SYS]),
      lastUsedAt: "",
    });
    // Same-length request (no growth) -> no reuse.
    const sameBody = {
      model: "gpt-5.2",
      messages: [SYS, M1, { role: "assistant", content: "x" }, { role: "user", content: "y" }],
    };
    const same = await prepareCore(makeCtx(env, sameBody), sameBody);
    if (same.ok) expect(same.prepared.conversationID).toBe("");

    // Different system prompt -> different bucket semantics -> no reuse.
    const otherBody = {
      model: "gpt-5.2",
      messages: [{ role: "system", content: "OTHER" }, M1, { role: "user", content: "z" }],
    };
    const other = await prepareCore(makeCtx(env, otherBody), otherBody);
    if (other.ok) expect(other.prepared.conversationID).toBe("");
  });

  it("never engages without a system prompt (isolation guard)", async () => {
    const env = makeEnv();
    await putConvCache(env, convCacheKeyFor("auto", "m"), {
      accountId: "a",
      conversationId: "c",
      sessionId: "s",
      messageCount: 0,
      sysHash: "",
      lastUsedAt: "",
    });
    const body = { model: "m", messages: [{ role: "user", content: "hi" }] };
    const p = await prepareCore(makeCtx(env, body), body);
    if (p.ok) {
      expect(p.prepared.conversationID).toBe("");
      expect(p.prepared.convCache).toBeUndefined(); // lookup not even attempted
    }
  });

  it("explicit conversation ids bypass the cache entirely", async () => {
    const env = makeEnv();
    const body = {
      model: "gpt-5.2",
      conversation_id: "explicit",
      messages: [SYS, M1],
    };
    const p = await prepareCore(makeCtx(env, body), body);
    if (p.ok) {
      expect(p.prepared.conversationID).toBe("explicit");
      expect(p.prepared.convCache).toBeUndefined();
    }
  });

  it("tool-bearing requests skip reuse and send the full transcript", async () => {
    const env = makeEnv();
    // Seed a cache entry that WOULD match a plain follow-up turn.
    await putConvCache(env, convCacheKeyFor("auto", "gpt-5.2"), {
      accountId: "a",
      conversationId: "c-tool",
      sessionId: "s-tool",
      messageCount: 2,
      sysHash: await computeSysHash([SYS]),
      lastUsedAt: "",
    });
    const toolBody = {
      model: "gpt-5.2",
      messages: [
        SYS,
        M1,
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "file.txt" },
      ],
    };
    const p = await prepareCore(makeCtx(env, toolBody), toolBody);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.prepared.conversationID).toBe(""); // no cloud-conversation reuse
    expect(p.prepared.convCache).toBeUndefined(); // lookup not even attempted
    expect(p.prepared.answerPrompt).toContain("first question"); // FULL prompt sent
    expect(p.prepared.answerPrompt).toContain("[tool result id=call_1]");
  });
});

describe("featureFlags memoryV2 payload gating", () => {
  it("includes memory optionsSets by default and omits them when disabled", async () => {
    const { chatPayload, RS } = await import("../src/chathub/protocol");
    const firstFrame = (payload: string): Record<string, any> =>
      JSON.parse(payload.split(RS)[0]);
    const on = firstFrame(chatPayload("hi there", "s", "c", "r", "Gpt_5_2_Chat", true, [], undefined));
    const off = firstFrame(
      chatPayload("hi there", "s", "c", "r", "Gpt_5_2_Chat", true, [], { featureFlags: { memoryV2: false } })
    );
    const setsOn = (on.arguments[0].optionsSets as string[]).join(",");
    const setsOff = (off.arguments[0].optionsSets as string[]).join(",");
    expect(setsOn).toContain("update_memory_plugin");
    expect(setsOn).toContain("add_custom_instructions");
    expect(setsOff).not.toContain("update_memory_plugin");
    expect(setsOff).not.toContain("add_custom_instructions");
  });
});

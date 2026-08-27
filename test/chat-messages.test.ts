import { describe, it, expect } from "vitest";
import {
  appendChatTurn,
  listMessages,
  deleteByConversation,
  cleanupOld,
  MAX_MESSAGE_BYTES,
} from "../src/store/chatMessages";
import { handleM365ConversationDetail } from "../src/admin/handlers";
import type { HandlerCtx } from "../src/router";
import type { Env } from "../src/env";
import { MockKV } from "./helpers/mockkv";

// ---------------------------------------------------------- mock D1 (lite) --

interface Row {
  conversation_id: string;
  seq: number;
  role: string;
  content: string;
  created_at: string;
}

class MockStmt {
  params: unknown[] = [];
  constructor(
    private db: MockD1,
    readonly sql: string
  ) {}
  bind(...vals: unknown[]): this {
    this.params = vals;
    return this;
  }
  async run(): Promise<unknown> {
    this.exec();
    return {};
  }
  async first<T>(): Promise<T | null> {
    if (this.sql.includes("COALESCE(MAX(seq)")) {
      const cid = String(this.params[0] ?? "");
      const max = this.db.rows
        .filter((r) => r.conversation_id === cid)
        .reduce((m, r) => Math.max(m, r.seq), 0);
      return { max_seq: max } as T;
    }
    return null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("ORDER BY seq ASC")) {
      const cid = String(this.params[0] ?? "");
      const results = this.db.rows
        .filter((r) => r.conversation_id === cid)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, 1000);
      return { results: results as unknown as T[] };
    }
    return { results: [] };
  }
  exec(): void {
    if (this.sql.startsWith("INSERT INTO chat_messages")) {
      const row: Row = {
        conversation_id: String(this.params[0]),
        seq: Number(this.params[1]),
        role: String(this.params[2]),
        content: String(this.params[3]),
        created_at: String(this.params[4]),
      };
      if (this.db.rows.some((r) => r.conversation_id === row.conversation_id && r.seq === row.seq)) {
        throw new Error("UNIQUE constraint failed: chat_messages.conversation_id, chat_messages.seq");
      }
      this.db.rows.push(row);
      return;
    }
    if (this.sql.includes("DELETE FROM chat_messages WHERE conversation_id")) {
      const cid = String(this.params[0]);
      this.db.rows = this.db.rows.filter((r) => r.conversation_id !== cid);
      return;
    }
    if (this.sql.includes("DELETE FROM chat_messages WHERE created_at")) {
      const cutoff = String(this.params[0]);
      this.db.rows = this.db.rows.filter((r) => r.created_at >= cutoff);
      return;
    }
    // Plain SELECTs are handled lazily via first()/all().
  }
}

class MockD1 {
  rows: Row[] = [];
  stubMaxSeqZero = false;
  prepare(sql: string): MockStmt {
    return new MockStmt(this, sql);
  }
  batch(stmts: MockStmt[]): Promise<unknown> {
    for (const s of stmts) s.exec();
    return Promise.resolve([]);
  }
}

function makeEnv(db?: MockD1): Env {
  return {
    "m365-copilot2api_KV": new MockKV(),
    DB: db,
  } as unknown as Env;
}

function makeCtx(method: string, url: string, env: Env): HandlerCtx {
  const req = new Request(url, { method });
  return {
    env,
    req,
    url: new URL(url),
    requestId: "test",
    waitUntil: () => {},
  } as unknown as HandlerCtx;
}

// ------------------------------------------------------------------ tests --

describe("chatMessages store", () => {
  it("appends a user+assistant pair per turn with increasing seq", async () => {
    const db = new MockD1();
    const env = makeEnv(db);
    await appendChatTurn(env, "c1", "hello there", "hi!");
    await appendChatTurn(env, "c1", "run ls", "done");
    expect(db.rows.map((r) => `${r.seq}:${r.role}`)).toEqual([
      "1:user",
      "2:assistant",
      "3:user",
      "4:assistant",
    ]);
    const msgs = await listMessages(env, "c1");
    expect(msgs).toHaveLength(4);
    expect(msgs[0].content).toBe("hello there");
    expect(msgs[3].role).toBe("assistant");
  });

  it("clips single rows to 64KiB", async () => {
    const db = new MockD1();
    await appendChatTurn(makeEnv(db), "c", "x".repeat(MAX_MESSAGE_BYTES + 5000), "ok");
    expect(db.rows[0].content.length).toBe(MAX_MESSAGE_BYTES);
    expect(db.rows[1].content).toBe("ok");
  });

  it("is a no-op without a DB binding or with an empty turn", async () => {
    const db = new MockD1();
    await appendChatTurn(makeEnv(), "c", "u", "a"); // unbound -> nothing thrown
    await appendChatTurn(makeEnv(db), "c", "   ", ""); // empty turn skipped
    expect(db.rows).toHaveLength(0);
  });

  it("fails silently instead of crashing when inserts keep colliding", async () => {
    const db = new MockD1();
    db.stubMaxSeqZero = true;
    const env = makeEnv(db);
    db.rows.push({ conversation_id: "c", seq: 1, role: "user", content: "pre", created_at: "t" });
    const origFirst = MockStmt.prototype.first;
    // Force MAX(seq) to report 0 so every attempt collides with the seed row.
    MockStmt.prototype.first = async function (this: MockStmt) {
      if (this.sql.includes("COALESCE(MAX(seq)")) return { max_seq: 0 } as never;
      return origFirst.call(this) as never;
    };
    try {
      await appendChatTurn(env, "c", "u", "a");
    } finally {
      MockStmt.prototype.first = origFirst;
    }
    expect(db.rows).toHaveLength(1); // seed untouched, no partial writes
  });

  it("purges per-conversation and enforces TTL by age", async () => {
    const db = new MockD1();
    const env = makeEnv(db);
    await appendChatTurn(env, "keep", "a", "b");
    await appendChatTurn(env, "gone", "c", "d");
    const old = new Date(Date.now() - 30 * 86400_000).toISOString();
    db.rows.push({ conversation_id: "gone", seq: 99, role: "user", content: "ancient", created_at: old });

    await deleteByConversation(env, "gone");
    expect(await listMessages(env, "gone")).toHaveLength(0);

    await cleanupOld(env, 7);
    const ids = new Set(db.rows.map((r) => r.conversation_id));
    expect(ids.has("keep")).toBe(true);
  });
});

describe("conversation detail handler", () => {
  it("assembles the viewer payload from stored turns", async () => {
    const db = new MockD1();
    const env = makeEnv(db);
    const kv = env["m365-copilot2api_KV"] as unknown as MockKV;
    void kv.put(
      "conversations",
      JSON.stringify([{ id: "conv1", accountID: "acc1", title: "Fix build", createdAt: "2026-08-26T00:00:00Z", updatedAt: "2026-08-26T01:00:00Z" }])
    );
    await appendChatTurn(env, "conv1", "why is the build red?", "Because tests fail.");

    const resp = await handleM365ConversationDetail(
      makeCtx("GET", "http://x/api/m365/conversations/detail?id=conv1", env)
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body["chatName"]).toBe("Fix build");
    expect(body["messageCount"]).toBe(2);
    expect(body["detail_unavailable"]).toBe(false);
    const messages = body["messages"] as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[1].content).toBe("Because tests fail.");
  });

  it("returns an empty timeline (and unavailable flag) without D1 or id", async () => {
    const resp = await handleM365ConversationDetail(
      makeCtx("GET", "http://x/api/m365/conversations/detail?id=nope", makeEnv())
    );
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body["messages"]).toEqual([]);
    expect(body["detail_unavailable"]).toBe(true);

    const bad = await handleM365ConversationDetail(
      makeCtx("GET", "http://x/api/m365/conversations/detail", makeEnv())
    );
    expect(bad.status).toBe(400);
  });
});

import { describe, it, expect } from "vitest";
import {
  recordConversation,
  listConversations,
  deleteLocalConversation,
  upsertSessionBinding,
  getSessionBinding,
  listSessionBindings,
} from "../src/store/conversations";
import { putConvCache, getConvCache } from "../src/store/convCache";
import { putUserSession, getUserSession } from "../src/admin/extras";
import { bindSession, resolveSession, listResolverSessions } from "../src/pipeline/resolver";
import type { OaiMsg } from "../src/pipeline/prompt";
import type { Env } from "../src/env";
import type { ConversationRecord, SessionBinding } from "../src/types";
import { MockKV } from "./helpers/mockkv";

// ---------------------------------------------------------- mock D1 (lite) --
// Same pattern as chat-messages.test.ts: pattern-match the prepared SQL and
// emulate just the statements the stores under test issue.

interface BindingRow {
  id: string;
  account_id: string;
  conversation_id: string;
  session_id: string;
  title: string;
  updated_at: string;
}
interface ConvRow {
  id: string;
  account_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}
interface UserSessionRow {
  api_key_hash: string;
  user_id: string;
  conversation_id: string;
  session_id: string;
  account_id: string;
  last_used_at: string;
}
interface ConvCacheRow {
  cache_key: string;
  account_id: string;
  conversation_id: string;
  session_id: string;
  message_count: number;
  sys_hash: string;
  last_used_at: string;
}
interface ResolverBlobRow {
  session_id: string;
  data: string;
  last_used_at: string;
}
interface ResolverIndexRow {
  session_id: string;
  conversation_id: string;
  account_id: string;
  last_used_at: string;
  ip_fingerprint: string;
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
    const sql = this.sql;
    if (sql.includes("FROM session_bindings WHERE id = ?")) {
      const id = String(this.params[0] ?? "");
      return (this.db.bindings.find((r) => r.id === id) as unknown as T) ?? null;
    }
    if (sql.includes("FROM user_sessions WHERE api_key_hash")) {
      const [h, u] = this.params as string[];
      const row = this.db.userSessions.find((r) => r.api_key_hash === h && r.user_id === u);
      return (row as unknown as T) ?? null;
    }
    if (sql.includes("FROM conv_cache WHERE cache_key = ?")) {
      const key = String(this.params[0] ?? "");
      return (this.db.convCache.find((r) => r.cache_key === key) as unknown as T) ?? null;
    }
    if (sql.includes("FROM resolver_session_blobs WHERE session_id = ?")) {
      const id = String(this.params[0] ?? "");
      return (this.db.blobs.find((r) => r.session_id === id) as unknown as T) ?? null;
    }
    if (sql.includes("COUNT(*) AS n FROM resolver_sessions")) {
      return { n: this.db.resolverIndex.length } as unknown as T;
    }
    return null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    const sql = this.sql;
    if (sql.includes("FROM session_bindings ORDER BY updated_at DESC")) {
      const limit = Number(this.params[0] ?? 500);
      const rows = [...this.db.bindings]
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
        .slice(0, limit);
      return { results: rows as unknown as T[] };
    }
    if (sql.includes("FROM conversations ORDER BY updated_at DESC")) {
      const rows = [...this.db.conversations]
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
        .slice(0, 500);
      return { results: rows as unknown as T[] };
    }
    if (sql.includes("SELECT DISTINCT conversation_id FROM user_sessions")) {
      const cutoff = String(this.params[0] ?? "");
      const seen = new Set<string>();
      const results: { conversation_id: string }[] = [];
      for (const r of this.db.userSessions) {
        if (r.last_used_at >= cutoff && !seen.has(r.conversation_id)) {
          seen.add(r.conversation_id);
          results.push({ conversation_id: r.conversation_id });
        }
      }
      return { results: results as unknown as T[] };
    }
    if (sql.includes("FROM resolver_session_blobs WHERE session_id IN (")) {
      const ids = new Set(this.params.map(String));
      const rows = this.db.blobs.filter((r) => ids.has(r.session_id));
      return { results: rows as unknown as T[] };
    }
    if (sql.includes("FROM resolver_sessions WHERE last_used_at >= ?")) {
      const cutoff = String(this.params[0] ?? "");
      const limit = Number(this.params[1] ?? 1000);
      const rows = this.db.resolverIndex
        .filter((r) => r.last_used_at >= cutoff)
        .sort((a, b) => (a.last_used_at < b.last_used_at ? 1 : -1))
        .slice(0, limit);
      return { results: rows as unknown as T[] };
    }
    return { results: [] };
  }
  exec(): void {
    const sql = this.sql;
    if (sql.startsWith("INSERT INTO session_bindings")) {
      const [id, accountID, conversationID, sessionID, title, updatedAt] = this.params as string[];
      const row: BindingRow = {
        id,
        account_id: accountID,
        conversation_id: conversationID,
        session_id: sessionID,
        title,
        updated_at: updatedAt,
      };
      const i = this.db.bindings.findIndex((r) => r.id === id);
      if (i >= 0) this.db.bindings[i] = row;
      else this.db.bindings.push(row);
      return;
    }
    if (sql.startsWith("INSERT INTO conversations")) {
      const [id, accountID, title, createdAt, updatedAt] = this.params as string[];
      const i = this.db.conversations.findIndex((r) => r.id === id);
      if (i >= 0) {
        // Mirrors the CASE WHEN excluded.title <> '' upsert semantics.
        this.db.conversations[i].updated_at = updatedAt;
        if (title !== "") this.db.conversations[i].title = title;
      } else {
        this.db.conversations.push({
          id,
          account_id: accountID,
          title,
          created_at: createdAt,
          updated_at: updatedAt,
        });
      }
      return;
    }
    if (sql.startsWith("INSERT INTO user_sessions")) {
      const [h, u, conversationId, sessionId, accountId, lastUsedAt] = this.params as string[];
      const row: UserSessionRow = {
        api_key_hash: h,
        user_id: u,
        conversation_id: conversationId,
        session_id: sessionId,
        account_id: accountId,
        last_used_at: lastUsedAt,
      };
      const i = this.db.userSessions.findIndex(
        (r) => r.api_key_hash === h && r.user_id === u
      );
      if (i >= 0) this.db.userSessions[i] = row;
      else this.db.userSessions.push(row);
      return;
    }
    if (sql.startsWith("INSERT INTO conv_cache")) {
      const [key, accountId, conversationId, sessionId, messageCount, sysHash, lastUsedAt] =
        this.params as [string, string, string, string, number, string, string];
      const row: ConvCacheRow = {
        cache_key: key,
        account_id: accountId,
        conversation_id: conversationId,
        session_id: sessionId,
        message_count: Number(messageCount),
        sys_hash: sysHash,
        last_used_at: lastUsedAt,
      };
      const i = this.db.convCache.findIndex((r) => r.cache_key === key);
      if (i >= 0) this.db.convCache[i] = row;
      else this.db.convCache.push(row);
      return;
    }
    if (sql.includes("DELETE FROM session_bindings WHERE id")) {
      const id = String(this.params[0] ?? "");
      this.db.bindings = this.db.bindings.filter((r) => r.id !== id);
      return;
    }
    if (sql.includes("DELETE FROM conversations WHERE id NOT IN")) {
      const sorted = [...this.db.conversations].sort((a, b) =>
        a.updated_at < b.updated_at ? 1 : -1
      );
      const keep = new Set(sorted.slice(0, 500).map((r) => r.id));
      this.db.conversations = this.db.conversations.filter((r) => keep.has(r.id));
      return;
    }
    if (sql.includes("DELETE FROM conversations WHERE id = ?")) {
      const id = String(this.params[0] ?? "");
      this.db.conversations = this.db.conversations.filter((r) => r.id !== id);
      return;
    }
    if (sql.includes("DELETE FROM user_sessions WHERE last_used_at")) {
      const cutoff = String(this.params[0] ?? "");
      this.db.userSessions = this.db.userSessions.filter((r) => r.last_used_at >= cutoff);
      return;
    }
    if (sql.includes("DELETE FROM conv_cache WHERE last_used_at")) {
      const cutoff = String(this.params[0] ?? "");
      this.db.convCache = this.db.convCache.filter((r) => r.last_used_at >= cutoff);
      return;
    }
    if (sql.startsWith("INSERT INTO resolver_session_blobs")) {
      const [sessionId, data, lastUsedAt] = this.params as string[];
      const row: ResolverBlobRow = { session_id: sessionId, data, last_used_at: lastUsedAt };
      const i = this.db.blobs.findIndex((r) => r.session_id === sessionId);
      if (i >= 0) this.db.blobs[i] = row;
      else this.db.blobs.push(row);
      return;
    }
    if (sql.startsWith("INSERT INTO resolver_sessions")) {
      const [sessionId, conversationId, accountId, lastUsedAt, ipFingerprint] =
        this.params as string[];
      const row: ResolverIndexRow = {
        session_id: sessionId,
        conversation_id: conversationId,
        account_id: accountId,
        last_used_at: lastUsedAt,
        ip_fingerprint: ipFingerprint,
      };
      const i = this.db.resolverIndex.findIndex((r) => r.session_id === sessionId);
      if (i >= 0) this.db.resolverIndex[i] = row;
      else this.db.resolverIndex.push(row);
      return;
    }
    if (sql.includes("DELETE FROM resolver_session_blobs WHERE last_used_at")) {
      const cutoff = String(this.params[0] ?? "");
      this.db.blobs = this.db.blobs.filter((r) => r.last_used_at >= cutoff);
      return;
    }
    if (sql.includes("DELETE FROM resolver_session_blobs WHERE session_id")) {
      const id = String(this.params[0] ?? "");
      this.db.blobs = this.db.blobs.filter((r) => r.session_id !== id);
      return;
    }
  }
}

class MockD1 {
  bindings: BindingRow[] = [];
  conversations: ConvRow[] = [];
  userSessions: UserSessionRow[] = [];
  convCache: ConvCacheRow[] = [];
  blobs: ResolverBlobRow[] = [];
  resolverIndex: ResolverIndexRow[] = [];
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

function kvOf(env: Env): MockKV {
  return env["m365-copilot2api_KV"] as unknown as MockKV;
}

function conv(id: string, updatedAt: string, title = "t"): ConversationRecord {
  return { id, accountID: "acc", title, createdAt: updatedAt, updatedAt };
}

function binding(id: string, updatedAt: string): SessionBinding {
  return {
    id,
    accountID: "acc",
    conversationID: `conv-${id}`,
    sessionID: `sess-${id}`,
    title: "title",
    updatedAt,
  };
}

// ------------------------------------------------------------------ tests --

describe("conversations store on D1 (storage review P1-1)", () => {
  it("writes to D1 and keeps KV out of the hot path", async () => {
    const db = new MockD1();
    const env = makeEnv(db);
    await recordConversation(env, conv("c1", "2026-08-30T01:00:00Z"));
    await recordConversation(env, conv("c2", "2026-08-30T02:00:00Z"));
    await recordConversation(env, { ...conv("c1", "2026-08-30T03:00:00Z"), title: "" });
    expect(db.conversations).toHaveLength(2);
    // The empty-title update must not clobber the stored title.
    expect(db.conversations.find((r) => r.id === "c1")?.title).toBe("t");
    // No KV fallback document written.
    expect(kvOf(env).dump()["conversations"]).toBeUndefined();

    const list = await listConversations(env);
    expect(list.map((c) => c.id)).toEqual(["c1", "c2"]); // newest first
    expect(list[0].title).toBe("t");

    await deleteLocalConversation(env, "c1");
    expect(await listConversations(env)).toHaveLength(1);
  });

  it("backfills once from the KV document when the D1 table is empty", async () => {
    const db = new MockD1();
    const env = makeEnv(db);
    await kvOf(env).put(
      "conversations",
      JSON.stringify([conv("legacy-1", "2026-08-30T00:00:00Z", "Legacy title")])
    );
    const list = await listConversations(env);
    expect(list.map((c) => c.id)).toEqual(["legacy-1"]);
    // Latched: the second read is served from D1 without re-reading KV.
    const again = await listConversations(env);
    expect(again.map((c) => c.id)).toEqual(["legacy-1"]);
    expect(db.conversations).toHaveLength(1);
  });
});

describe("session bindings on D1 (storage review P1-1)", () => {
  it("upserts, lists and deletes on D1 without KV writes", async () => {
    const db = new MockD1();
    const env = makeEnv(db);
    await upsertSessionBinding(env, binding("b2", "2026-08-30T02:00:00Z"));
    await upsertSessionBinding(env, binding("b1", "2026-08-30T01:00:00Z"));
    expect(db.bindings).toHaveLength(2);
    expect(kvOf(env).dump()["sessbind/b1"]).toBeUndefined();

    const list = await listSessionBindings(env);
    expect(list.map((b) => b.id)).toEqual(["b2", "b1"]); // newest first
    expect(list[0].conversationID).toBe("conv-b2");

    const got = await getSessionBinding(env, "b1");
    expect(got?.sessionID).toBe("sess-b1");
  });

  it("falls back to the KV copy when D1 has no row yet", async () => {
    const env = makeEnv(new MockD1());
    await kvOf(env).put("sessbind/kv-only", JSON.stringify(binding("kv-only", "2026-08-30T00:00:00Z")));
    const got = await getSessionBinding(env, "kv-only");
    expect(got?.conversationID).toBe("conv-kv-only");
    const missing = await getSessionBinding(env, "nope");
    expect(missing).toBeNull();
  });
});

describe("user sessions on D1 (storage review P1-1)", () => {
  it("writes to D1, reads back and enforces the 7d TTL", async () => {
    const db = new MockD1();
    const env = makeEnv(db);
    await putUserSession(env, "hash1", "alice", "conv-9", "sess-9", "acc-9");
    expect(db.userSessions).toHaveLength(1);
    expect(kvOf(env).dump()["usess/hash1|alice"]).toBeUndefined();

    const got = await getUserSession(env, "hash1", "alice");
    expect(got?.conversationId).toBe("conv-9");

    db.userSessions[0].last_used_at = new Date(Date.now() - 8 * 86400_000).toISOString();
    expect(await getUserSession(env, "hash1", "alice")).toBeNull();
  });
});

describe("conv cache on D1 (storage review P1-1)", () => {
  it("writes to D1, reads back and enforces the 2h freshness window", async () => {
    const db = new MockD1();
    const env = makeEnv(db);
    await putConvCache(env, "convcache:acc|gpt-5.2", {
      accountId: "acc",
      conversationId: "conv-x",
      sessionId: "sess-x",
      messageCount: 3,
      sysHash: "abc",
      lastUsedAt: "",
    });
    expect(db.convCache).toHaveLength(1);
    expect(kvOf(env).dump()["convcache:acc|gpt-5.2"]).toBeUndefined();

    const hit = await getConvCache(env, "convcache:acc|gpt-5.2");
    expect(hit?.conversationId).toBe("conv-x");
    expect(hit?.messageCount).toBe(3);

    db.convCache[0].last_used_at = new Date(Date.now() - 3 * 3600_000).toISOString();
    expect(await getConvCache(env, "convcache:acc|gpt-5.2")).toBeNull();
  });
});

function msg(role: string, content: string): OaiMsg {
  return { role, content };
}

describe("resolver session blobs on D1 (Phase 3)", () => {
  it("bind writes the blob to D1 (no KV) and explicit resolve reads it back", async () => {
    const db = new MockD1();
    const env = makeEnv(db);
    await bindSession(env, {
      sessionId: "s1",
      conversationId: "conv-s1",
      accountId: "acc",
      messages: [msg("user", "hello")],
      assistantText: "world",
      ipFingerprint: "fp",
    });
    expect(db.blobs).toHaveLength(1);
    expect(kvOf(env).dump()["resolver/s1"]).toBeUndefined();

    const r = await resolveSession(env, {
      explicitId: "s1",
      ipFingerprint: "fp",
      messages: [],
    });
    expect(r.matchedBy).toBe("explicit");
    expect(r.conversationId).toBe("conv-s1");
    expect(r.historyLen).toBe(2); // user + assistant
  });

  it("listResolverSessions reads full transcripts via one batched query", async () => {
    const db = new MockD1();
    const env = makeEnv(db);
    await bindSession(env, {
      sessionId: "l1",
      conversationId: "conv-l1",
      accountId: "acc",
      messages: [msg("user", "a")],
      assistantText: "b",
      ipFingerprint: "fp",
    });
    const all = await listResolverSessions(env);
    expect(all).toHaveLength(1);
    expect(all[0].sessionId).toBe("l1");
    expect(all[0].contextHistory?.length).toBe(2); // full transcript from D1
  });

  it("falls back to the KV copy when the blob is not in D1 yet", async () => {
    const env = makeEnv(new MockD1());
    const legacy = {
      sessionId: "kv-only",
      conversationId: "conv-kv",
      accountId: "acc",
      createdAt: "2026-08-30T00:00:00Z",
      lastUsedAt: new Date().toISOString(),
      contextHistory: [{ role: "user", content: "hi" }],
    };
    await kvOf(env).put("resolver/kv-only", JSON.stringify(legacy));
    const r = await resolveSession(env, {
      explicitId: "kv-only",
      ipFingerprint: "fp",
      messages: [],
    });
    expect(r.matchedBy).toBe("explicit");
    expect(r.conversationId).toBe("conv-kv");
  });

  it("keeps oversized blobs in KV instead of D1", async () => {
    const db = new MockD1();
    const env = makeEnv(db);
    const big = "x".repeat(400_000);
    await bindSession(env, {
      sessionId: "big",
      conversationId: "conv-big",
      accountId: "acc",
      messages: [msg("user", big), msg("user", big), msg("user", big), msg("user", big)],
      ipFingerprint: "fp",
    });
    expect(db.blobs).toHaveLength(0);
    expect(kvOf(env).dump()["resolver/big"]).toBeDefined();
  });
});

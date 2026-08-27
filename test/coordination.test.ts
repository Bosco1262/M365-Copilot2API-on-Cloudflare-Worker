import { describe, it, expect } from "vitest";
import {
  CoordinationDO,
  coordLockoutCheck,
  coordLockoutRecord,
  coordNextAccountID,
  coordAcquireAccount,
  coordReleaseAccount,
  coordMutexAcquire,
  coordMutexRelease,
  coordGetAccounts,
  coordSetAccounts,
  coordInvalidateAccounts,
  coordHealthAvailable,
  coordHealthMarkFailure,
  coordHealthImageLimited,
  coordHealthMarkSuccess,
  coordHealthClear,
  coordHealthSnapshot,
} from "../src/do/coordination";
import type { DurableObjectNamespaceLite, DurableObjectStateLite, Env } from "../src/env";
import { nextAccount, ensureValid } from "../src/store/accounts";
import { MockKV } from "./helpers/mockkv";

function fakeStorage(init: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>(Object.entries(init));
  return {
    get: async <T>(k: string): Promise<T | undefined> => map.get(k) as T | undefined,
    put: async (k: string, v: unknown): Promise<void> => void map.set(k, v),
    delete: async (k: string): Promise<boolean> => map.delete(k),
    setAlarm: async (): Promise<void> => {},
    deleteAlarm: async (): Promise<void> => {},
  };
}

type Storage = ReturnType<typeof fakeStorage>;

function makeDO(storage: Storage = fakeStorage()): CoordinationDO {
  return new CoordinationDO({ storage } as unknown as DurableObjectStateLite);
}

function req(action: string, body: unknown): Request {
  return new Request(`https://coordination.local${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function out(doInst: CoordinationDO, action: string, body: unknown): Promise<Record<string, unknown>> {
  const resp = await doInst.fetch(req(action, body));
  expect(resp.ok).toBe(true);
  return (await resp.json()) as Record<string, unknown>;
}

async function getOut(doInst: CoordinationDO, action: string): Promise<Record<string, unknown>> {
  const resp = await doInst.fetch(new Request(`https://coordination.local${action}`));
  expect(resp.ok).toBe(true);
  return (await resp.json()) as Record<string, unknown>;
}

function fakeNamespace(instance: CoordinationDO): DurableObjectNamespaceLite {
  return {
    idFromName: () => ({ toString: () => "gateway-coord" }),
    get: () => ({
      fetch: (input: RequestInfo | string, init?: RequestInit) =>
        instance.fetch(new Request(input as string, init)),
    }),
  } as unknown as DurableObjectNamespaceLite;
}

describe("CoordinationDO /lockout", () => {
  it("records failures, locks at the 5th and reports remaining attempts", async () => {
    const d = makeDO();
    for (let i = 0; i < 4; i++) {
      const r = await out(d, "/lockout", { ip: "1.2.3.4" });
      expect(r["locked"]).toBe(false);
      expect(r["remaining"]).toBe(5 - (i + 1));
    }
    const fifth = await out(d, "/lockout", { ip: "1.2.3.4" });
    expect(fifth["locked"]).toBe(true);
    expect(fifth["remaining"]).toBe(0);
  });

  it("check does not record; other ips are independent", async () => {
    const d = makeDO();
    for (let i = 0; i < 5; i++) await out(d, "/lockout", { ip: "9.9.9.9" });
    const checked = await out(d, "/lockout/check", { ip: "8.8.8.8" });
    expect(checked["locked"]).toBe(false);
    expect(checked["remaining"]).toBe(5);
    const other = await out(d, "/lockout/check", { ip: "9.9.9.9" });
    expect(other["locked"]).toBe(true);
  });

  it("forgets failures older than the 15-minute window", async () => {
    const old = Date.now() - 16 * 60_000;
    const storage = fakeStorage({
      state: { cursor: 0, failures: { "7.7.7.7": [old, old, old, old, old] }, mutexes: {}, semaphores: {} },
    });
    const d = makeDO(storage);
    const r = await out(d, "/lockout/check", { ip: "7.7.7.7" });
    expect(r["locked"]).toBe(false);
    expect(r["remaining"]).toBe(5);
  });
});

describe("CoordinationDO /next-account", () => {
  it("rotates atomically across calls", async () => {
    const d = makeDO();
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await out(d, "/next-account", { ids: ["a", "b", "c"] });
      seen.push(String(r["id"]));
    }
    expect(seen).toEqual(["a", "b", "c", "a", "b", "c"]);
  });

  it("handles empty id lists", async () => {
    const d = makeDO();
    const r = await out(d, "/next-account", { ids: [] });
    expect(r["id"]).toBeNull();
  });
});

describe("CoordinationDO /acquire + /release", () => {
  it("grants up to the limit, denies beyond, frees on release", async () => {
    const d = makeDO();
    const g1 = await out(d, "/acquire", { accountId: "acc1", limit: 2, maxWaitMs: 0 });
    const g2 = await out(d, "/acquire", { accountId: "acc1", limit: 2, maxWaitMs: 0 });
    expect(g1["acquired"]).toBe(true);
    expect(g2["acquired"]).toBe(true);
    const g3 = await out(d, "/acquire", { accountId: "acc1", limit: 2, maxWaitMs: 0 });
    expect(g3["acquired"]).toBe(false);

    await out(d, "/release", { accountId: "acc1", holder: g1["holder"] });
    const g4 = await out(d, "/acquire", { accountId: "acc1", limit: 2, maxWaitMs: 0 });
    expect(g4["acquired"]).toBe(true);
  });

  it("isolates per-account counters", async () => {
    const d = makeDO();
    const a = await out(d, "/acquire", { accountId: "x", limit: 1, maxWaitMs: 0 });
    expect(a["acquired"]).toBe(true);
    const b = await out(d, "/acquire", { accountId: "y", limit: 1, maxWaitMs: 0 });
    expect(b["acquired"]).toBe(true);
  });
});

describe("CoordinationDO /mutex", () => {
  it("single-flights on key and honours explicit release", async () => {
    const d = makeDO();
    const first = await out(d, "/mutex", { key: "refresh:a", ttlMs: 5000 });
    expect(first["ok"]).toBe(true);
    expect(String(first["token"]).length).toBeGreaterThan(0);
    const second = await out(d, "/mutex", { key: "refresh:a", ttlMs: 5000 });
    expect(second["ok"]).toBe(false);

    // Wrong token must not free the lock.
    await out(d, "/mutex/release", { key: "refresh:a", token: "nope" });
    const third = await out(d, "/mutex", { key: "refresh:a", ttlMs: 5000 });
    expect(third["ok"]).toBe(false);

    await out(d, "/mutex/release", { key: "refresh:a", token: first["token"] });
    const fourth = await out(d, "/mutex", { key: "refresh:a", ttlMs: 5000 });
    expect(fourth["ok"]).toBe(true);
  });

  it("expires after ttlMs", async () => {
    const d = makeDO();
    await out(d, "/mutex", { key: "k", ttlMs: 20 });
    const busy = await out(d, "/mutex", { key: "k", ttlMs: 20 });
    expect(busy["ok"]).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    const freed = await out(d, "/mutex", { key: "k", ttlMs: 20 });
    expect(freed["ok"]).toBe(true);
  });
});

describe("CoordinationDO /accounts-cache", () => {
  it("returns cached:false until seeded, then serves the pushed list until invalidated", async () => {
    const d = makeDO();
    expect((await getOut(d, "/accounts-cache"))["cached"]).toBe(false);

    await out(d, "/accounts-cache/update", {
      accounts: [{ id: "a", email: "a@x.com", status: "online", accessToken: "t", expiresAt: "x", updatedAt: "u" }],
    });
    const hit = await getOut(d, "/accounts-cache");
    expect(hit["cached"]).toBe(true);
    expect(Array.isArray(hit["accounts"])).toBe(true);

    await out(d, "/accounts-cache/invalidate", {});
    expect((await getOut(d, "/accounts-cache"))["cached"]).toBe(false);
  });
});

describe("CoordinationDO /health", () => {
  it("tracks auth-failure cooldowns and clears on success", async () => {
    const d = makeDO();
    const av1 = await out(d, "/health/available", { accountId: "acc1" });
    expect(av1["available"]).toBe(true);

    await out(d, "/health/mark-failure", { accountId: "acc1", kind: "auth", cooldownMs: 60_000 });
    expect((await out(d, "/health/available", { accountId: "acc1" }))["available"]).toBe(false);

    await out(d, "/health/mark-success", { accountId: "acc1" });
    expect((await out(d, "/health/available", { accountId: "acc1" }))["available"]).toBe(true);
  });

  it("rate-limit and image-limited entries are independent and snapshotable", async () => {
    const d = makeDO();
    await out(d, "/health/mark-failure", { accountId: "rl", kind: "rate", cooldownMs: 30_000 });
    await out(d, "/health/image-limited", { accountId: "img", cooldownMs: 3_600_000 });

    const snap = await out(d, "/health/snapshot", {});
    expect(Object.keys(snap["cooldown"] as Record<string, unknown>).sort()).toEqual(["img", "rl"]);
    expect((snap["limited"] as Record<string, unknown>)["img"]).toBe(true);
    expect((snap["limited"] as Record<string, unknown>)["rl"]).toBe(true);

    await out(d, "/health/clear", {});
    expect((await out(d, "/health/available", { accountId: "rl" }))["available"]).toBe(true);
  });

  it("reaps expired cooldowns", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const storage = fakeStorage({
      state: { cursor: 0, failures: {}, mutexes: {}, semaphores: {}, health: { stale: { cooldown: past } }, circuit: { windowStart: 0, total: 0, failures: 0, openUntil: 0 } },
    });
    const d = makeDO(storage);
    expect((await out(d, "/health/available", { accountId: "stale" }))["available"]).toBe(true);
    const snap = await out(d, "/health/snapshot", {});
    expect((snap["cooldown"] as Record<string, unknown>)["stale"]).toBeUndefined();
  });

  it("computes per-category cooldowns and tracks quota attempts for backoff", async () => {
    const d = makeDO();
    // 401 -> 2min auth fail.
    await out(d, "/health/mark-failure", { accountId: "a1", cat: "AUTH_EXPIRED_401" });
    const snap1 = await out(d, "/health/snapshot", {});
    expect((snap1["authFail"] as Record<string, unknown>)["a1"]).toBe(true);
    const cd1 = Date.parse((snap1["cooldown"] as Record<string, string>)["a1"]);
    expect(cd1 - Date.now()).toBeGreaterThan(110_000);
    expect(cd1 - Date.now()).toBeLessThanOrEqual(125_000);

    // 403 -> 24h auth fail.
    await out(d, "/health/mark-failure", { accountId: "a2", cat: "FORBIDDEN_403" });
    const snap2 = await out(d, "/health/snapshot", {});
    expect((snap2["authFail"] as Record<string, unknown>)["a2"]).toBe(true);
    const cd2 = Date.parse((snap2["cooldown"] as Record<string, string>)["a2"]);
    expect(cd2 - Date.now()).toBeGreaterThan(23 * 3600_000);

    // Repeated 429 without Retry-After: 30s -> 60s -> 120s (exponential).
    await out(d, "/health/mark-failure", { accountId: "q", cat: "QUOTA_429" });
    const snap3a = await out(d, "/health/snapshot", {});
    const cd3a = Date.parse((snap3a["cooldown"] as Record<string, string>)["q"]);
    expect(cd3a - Date.now()).toBeGreaterThan(25_000);
    expect(cd3a - Date.now()).toBeLessThanOrEqual(35_000);
    await out(d, "/health/mark-failure", { accountId: "q", cat: "QUOTA_429" });
    const snap3 = await out(d, "/health/snapshot", {});
    const cd3 = Date.parse((snap3["cooldown"] as Record<string, string>)["q"]);
    expect(cd3 - Date.now()).toBeGreaterThan(55_000);
    expect(cd3 - Date.now()).toBeLessThanOrEqual(65_000);
    await out(d, "/health/mark-failure", { accountId: "q", cat: "QUOTA_429" });
    const snap3c = await out(d, "/health/snapshot", {});
    const cd3c = Date.parse((snap3c["cooldown"] as Record<string, string>)["q"]);
    expect(cd3c - Date.now()).toBeGreaterThan(110_000);
    expect(cd3c - Date.now()).toBeLessThanOrEqual(125_000);

    // 503 -> 15s, no authFail flag.
    await out(d, "/health/mark-failure", { accountId: "s", cat: "OVERLOAD_503" });
    const snap4 = await out(d, "/health/snapshot", {});
    const cd4 = Date.parse((snap4["cooldown"] as Record<string, string>)["s"]);
    expect(cd4 - Date.now()).toBeGreaterThan(10_000);
    expect(cd4 - Date.now()).toBeLessThanOrEqual(20_000);
    expect((snap4["authFail"] as Record<string, unknown>)["s"]).toBeUndefined();

    // Retry-After wins for 429 and is capped at 30min.
    await out(d, "/health/mark-failure", { accountId: "r", cat: "QUOTA_429", retryAfter: 120 });
    const snap5 = await out(d, "/health/snapshot", {});
    const cd5 = Date.parse((snap5["cooldown"] as Record<string, string>)["r"]);
    expect(cd5 - Date.now()).toBeGreaterThan(115_000);
    expect(cd5 - Date.now()).toBeLessThanOrEqual(125_000);
  });

  it("opens the global circuit after heavy failures and blocks availability", async () => {
    const d = makeDO();
    // 10 failures in the window => circuit open 30s.
    for (let i = 0; i < 10; i++) {
      await out(d, "/health/mark-failure", { accountId: `a${i}`, cat: "QUOTA_429" });
    }
    expect((await out(d, "/health/available", { accountId: "fresh" }))["available"]).toBe(false);
    const snap = await out(d, "/health/snapshot", {});
    expect((snap["circuit"] as Record<string, unknown> | undefined)?.["open"]).toBe(true);
    // Client cancels never re-arm the circuit; success clears it.
    await out(d, "/health/mark-success", { accountId: "x" });
    const snap2 = await out(d, "/health/snapshot", {});
    expect((snap2["circuit"] as Record<string, unknown> | undefined)?.["open"]).toBe(true);
    await out(d, "/health/clear", {});
    expect((await out(d, "/health/available", { accountId: "fresh" }))["available"]).toBe(true);
  });
});

describe("CoordinationDO /semaphore/available + /next-healthy", () => {
  it("reports free slots without claiming them", async () => {
    const d = makeDO();
    expect((await out(d, "/semaphore/available", { accountId: "s1", limit: 2 }))["available"]).toBe(true);
    await out(d, "/acquire", { accountId: "s1", limit: 2, maxWaitMs: 0 });
    await out(d, "/acquire", { accountId: "s1", limit: 2, maxWaitMs: 0 });
    expect((await out(d, "/semaphore/available", { accountId: "s1", limit: 2 }))["available"]).toBe(false);
    expect((await out(d, "/semaphore/available", { accountId: "s1", limit: 3 }))["available"]).toBe(true);
  });

  it("picks the first healthy account with a free slot, skipping cooldown/concurrency-full", async () => {
    const d = makeDO();
    await out(d, "/health/mark-failure", { accountId: "b", cat: "QUOTA_429" }); // cooling
    await out(d, "/acquire", { accountId: "c", limit: 1, maxWaitMs: 0 }); // concurrency full

    const r1 = await out(d, "/next-healthy", { ids: ["a", "b", "c"], limit: 1 });
    expect(r1["id"]).toBe("a");
    // Advance: a is not avoided, but b (cooldown) and c (full) are skipped.
    const r2 = await out(d, "/next-healthy", { ids: ["a", "b", "c"], limit: 1, avoidId: "a" });
    expect(r2["id"]).toBeNull();
    expect(r2["lastReason"]).toBe("concurrency");

    // Release c's slot: next pass reaches it.
    await out(d, "/release", { accountId: "c", holder: "" });
    const r3 = await out(d, "/next-healthy", { ids: ["a", "b", "c"], limit: 1, avoidId: "a" });
    expect(r3["id"]).toBe("c");
  });

  it("keeps the cursor advancing across picks", async () => {
    const d = makeDO();
    const a = await out(d, "/next-healthy", { ids: ["x", "y"], limit: 8 });
    expect(a["id"]).toBe("x");
    const b = await out(d, "/next-healthy", { ids: ["x", "y"], limit: 8 });
    expect(b["id"]).toBe("y");
    const c = await out(d, "/next-healthy", { ids: ["x", "y"], limit: 8 });
    expect(c["id"]).toBe("x");
  });
});

describe("CoordinationDO health counters (B8)", () => {
  it("mark-call accumulates per-account call counts and snapshot exposes them", async () => {
    const d = makeDO();
    await out(d, "/health/mark-call", { accountId: "a" });
    await out(d, "/health/mark-call", { accountId: "a" });
    await out(d, "/health/mark-call", { accountId: "b" });
    const snap = await out(d, "/health/snapshot", {});
    expect((snap["calls"] as Record<string, number>)["a"]).toBe(2);
    expect((snap["calls"] as Record<string, number>)["b"]).toBe(1);
  });

  it("update-throttling stores the latest payload per account", async () => {
    const d = makeDO();
    await out(d, "/health/update-throttling", { accountId: "a", throttling: { numUserMessagesInConversation: 12 } });
    const snap = await out(d, "/health/snapshot", {});
    expect(((snap["throttling"] as Record<string, Record<string, unknown>>)["a"])["numUserMessagesInConversation"]).toBe(12);
  });

  it("auth failures carry a reason; image-limited is a distinct flag", async () => {
    const d = makeDO();
    await out(d, "/health/mark-failure", { accountId: "a1", cat: "AUTH_EXPIRED_401" });
    await out(d, "/health/mark-failure", { accountId: "a2", cat: "USER_BANNED" });
    await out(d, "/health/image-limited", { accountId: "img", cooldownMs: 3600_000 });
    const snap = await out(d, "/health/snapshot", {});
    expect((snap["authFailReason"] as Record<string, string>)["a1"]).toBe("401");
    expect((snap["authFailReason"] as Record<string, string>)["a2"]).toBe("banned");
    expect((snap["imageLimited"] as Record<string, boolean>)["img"]).toBe(true);
    // image-limited keeps both flags (limited drives availability).
    expect((snap["limited"] as Record<string, boolean>)["img"]).toBe(true);
  });

  it("mark-success keeps imageLimited/calls/throttling and only clears rate flags", async () => {
    const d = makeDO();
    await out(d, "/health/image-limited", { accountId: "img", cooldownMs: 3600_000 });
    await out(d, "/health/mark-call", { accountId: "img" });
    await out(d, "/health/mark-success", { accountId: "img" });
    const snap = await out(d, "/health/snapshot", {});
    // Upstream MarkSuccess keeps imageLimited + its cooldown (availability is
    // driven by the cooldown, not the limited flag) and the call counter; the
    // limited flag itself is cleared as a rate-limit class flag.
    expect((snap["imageLimited"] as Record<string, boolean>)["img"]).toBe(true);
    expect((snap["calls"] as Record<string, number>)["img"]).toBe(1);
    expect((snap["limited"] as Record<string, boolean>)["img"]).toBeUndefined();
    expect(Date.parse((snap["cooldown"] as Record<string, string>)["img"]) - Date.now()).toBeGreaterThan(3_000_000);
    expect((await out(d, "/health/available", { accountId: "img" }))["available"]).toBe(false);

    // A rate-limited account without image limits gets fully cleared on success.
    await out(d, "/health/mark-failure", { accountId: "rl", cat: "QUOTA_429" });
    await out(d, "/health/mark-success", { accountId: "rl" });
    const snap2 = await out(d, "/health/snapshot", {});
    expect((snap2["cooldown"] as Record<string, string>)["rl"]).toBeUndefined();
  });

  it("semaphore snapshot reports in-flight counts per account", async () => {
    const d = makeDO();
    await out(d, "/acquire", { accountId: "s1", limit: 8, maxWaitMs: 0 });
    await out(d, "/acquire", { accountId: "s1", limit: 8, maxWaitMs: 0 });
    const snap = await out(d, "/semaphore/snapshot", {});
    expect((snap["inflight"] as Record<string, number>)["s1"]).toBe(2);
    expect((snap["inflight"] as Record<string, number>)["s2"]).toBeUndefined();
  });
});

describe("client helpers", () => {
  it("route actions through the namespace when COORD is bound", async () => {
    const env = { COORD: fakeNamespace(makeDO()) } as unknown as Env;
    expect(await coordNextAccountID(env, ["p", "q"])).toBe("p");
    expect(await coordNextAccountID(env, ["p", "q"])).toBe("q");

    const lock = await coordLockoutRecord(env, "5.5.5.5");
    expect(lock?.locked).toBe(false);
    const check = await coordLockoutCheck(env, "5.5.5.5");
    expect(check?.remaining).toBe(4);

    const slot = await coordAcquireAccount(env, "acc", 1, 0);
    expect(slot?.acquired).toBe(true);
    const slot2 = await coordAcquireAccount(env, "acc", 1, 0);
    expect(slot2?.acquired).toBe(false);
    await coordReleaseAccount(env, "acc", slot!.holder!);
    const slot3 = await coordAcquireAccount(env, "acc", 1, 0);
    expect(slot3?.acquired).toBe(true);

    const m = await coordMutexAcquire(env, "mx", 1000);
    expect(m?.ok).toBe(true);
    const m2 = await coordMutexAcquire(env, "mx", 1000);
    expect(m2?.ok).toBe(false);
    await coordMutexRelease(env, "mx", m!.token!);
    const m3 = await coordMutexAcquire(env, "mx", 1000);
    expect(m3?.ok).toBe(true);

    // accounts cache round-trip through the namespace.
    expect(await coordGetAccounts(env)).toEqual({ cached: false });
    await coordSetAccounts(env, [{ id: "z", email: "z@x.com", status: "online", accessToken: "t", expiresAt: "x", updatedAt: "u" }]);
    expect((await coordGetAccounts(env))?.cached).toBe(true);
    await coordInvalidateAccounts(env);
    expect((await coordGetAccounts(env))?.cached).toBe(false);

    // health round-trip through the namespace.
    expect(await coordHealthAvailable(env, "h1")).toBe(true);
    expect(await coordHealthMarkFailure(env, "h1", "AUTH_EXPIRED_401")).toBe(true);
    expect(await coordHealthAvailable(env, "h1")).toBe(false);
    expect(await coordHealthImageLimited(env, "h2", 3_600_000)).toBe(true);
    const snap = await coordHealthSnapshot(env);
    expect(Object.keys(snap?.cooldown ?? {}).sort()).toEqual(["h1", "h2"]);
    expect(await coordHealthMarkSuccess(env, "h1")).toBe(true);
    expect(await coordHealthAvailable(env, "h1")).toBe(true);
    expect(await coordHealthClear(env)).toBe(true);
  });

  it("return null fallbacks when COORD is unbound", async () => {
    const env = {} as unknown as Env;
    expect(await coordNextAccountID(env, ["a"])).toBeNull();
    expect(await coordLockoutRecord(env, "ip")).toBeNull();
    expect(await coordAcquireAccount(env, "acc", 4)).toBeNull();
    expect(await coordMutexAcquire(env, "k")).toBeNull();
    expect(await coordGetAccounts(env)).toBeNull();
    expect(await coordHealthAvailable(env, "x")).toBeNull();
    expect(await coordHealthSnapshot(env)).toBeNull();
  });
});

// ---------------------------------------------------------- store wiring ---

interface TestAccount {
  id: string;
  email: string;
  displayName?: string;
  status: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  updatedAt: string;
  oid?: string;
  tid?: string;
  clientId?: string;
}

function seedAccounts(kv: MockKV, accounts: TestAccount[], nextIdx = 0): void {
  void kv.put("accounts", JSON.stringify({ accounts, nextIdx }));
}

const ACC_A: TestAccount = {
  id: "a",
  email: "a@x.com",
  status: "online",
  accessToken: "tok-a",
  refreshToken: "r",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  updatedAt: "",
};
const ACC_B: TestAccount = { ...ACC_A, id: "b", email: "b@x.com" };

describe("store/accounts integration with COORD", () => {
  it("nextAccount uses the DO cursor and stops rewriting nextIdx into KV", async () => {
    const kv = new MockKV();
    seedAccounts(kv, [ACC_A, ACC_B]);
    const env = { "m365-copilot2api_KV": kv, COORD: fakeNamespace(makeDO()) } as never;
    const first = await nextAccount(env);
    const second = await nextAccount(env);
    expect([first?.id, second?.id]).toEqual(["a", "b"]);
    const rawDoc = JSON.parse(kv.dump()["accounts"]) as { nextIdx: number };
    expect(rawDoc.nextIdx).toBe(0); // untouched once the DO owns the cursor
  });

  it("nextAccount keeps the KV rotation when unbound, via the dedicated cursor key", async () => {
    const kv = new MockKV();
    seedAccounts(kv, [ACC_A, ACC_B], 1);
    const env = { "m365-copilot2api_KV": kv } as never;
    expect((await nextAccount(env))?.id).toBe("b");
    expect((await nextAccount(env))?.id).toBe("a");
    // Storage audit P1-1: the fallback cursor lives in its own tiny key and
    // the legacy nextIdx seeds it on the first rotation (1 -> 2 -> 3).
    const cursor = JSON.parse(kv.dump()["accounts-cursor"]) as { nextIdx: number };
    expect(cursor.nextIdx).toBe(3);
    const rawDoc = JSON.parse(kv.dump()["accounts"]) as { nextIdx: number };
    expect(rawDoc.nextIdx).toBe(1); // accounts document no longer rewritten
  });

  it("ensureValid waits for a remote refresh holding the mutex instead of redeeming again", async () => {
    const kv = new MockKV();
    const expired: TestAccount = {
      ...ACC_A,
      accessToken: "stale",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    };
    seedAccounts(kv, [expired]);
    const env = { "m365-copilot2api_KV": kv, COORD: fakeNamespace(makeDO()) } as never;

    // Another isolate already holds the refresh mutex.
    const mux = await coordMutexAcquire(env, "refresh:a", 30_000);
    expect(mux?.ok).toBe(true);

    const pending = ensureValid(env, "a");
    // The remote refresh completes shortly after: fresh token lands in KV.
    setTimeout(() => {
      seedAccounts(kv, [{ ...expired, accessToken: "fresh", expiresAt: new Date(Date.now() + 3600_000).toISOString() }]);
    }, 120);
    const acc = await pending;
    expect(acc.accessToken).toBe("fresh");

    await coordMutexRelease(env, "refresh:a", mux!.token!);
  });
});

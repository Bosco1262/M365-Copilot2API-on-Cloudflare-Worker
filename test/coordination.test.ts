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
  });

  it("return null fallbacks when COORD is unbound", async () => {
    const env = {} as unknown as Env;
    expect(await coordNextAccountID(env, ["a"])).toBeNull();
    expect(await coordLockoutRecord(env, "ip")).toBeNull();
    expect(await coordAcquireAccount(env, "acc", 4)).toBeNull();
    expect(await coordMutexAcquire(env, "k")).toBeNull();
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

  it("nextAccount keeps the legacy KV rotation when unbound", async () => {
    const kv = new MockKV();
    seedAccounts(kv, [ACC_A, ACC_B], 1);
    const env = { "m365-copilot2api_KV": kv } as never;
    expect((await nextAccount(env))?.id).toBe("b");
    expect((await nextAccount(env))?.id).toBe("a");
    const rawDoc = JSON.parse(kv.dump()["accounts"]) as { nextIdx: number };
    expect(rawDoc.nextIdx).toBe(1); // legacy rotation keeps writing nextIdx
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

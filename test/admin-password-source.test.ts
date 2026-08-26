import { describe, it, expect, beforeEach } from "vitest";
import { MockKV } from "./helpers/mockkv";
import { adminPasswordSource } from "../src/store/admin";
import { sha256Hex } from "../src/util";
import type { Env } from "../src/env";

function makeEnv(kv: MockKV, secret?: string): Env {
  return { "m365-copilot2api_KV": kv as unknown as KVNamespace, ADMIN_PASSWORD: secret } as unknown as Env;
}

const PASSWORD_KEY = "admin-password-hash";

describe("adminPasswordSource", () => {
  let kv: MockKV;
  beforeEach(() => {
    kv = new MockKV();
  });

  it("reports kv when no secret is configured (bootstrap/console-owned)", async () => {
    await kv.put(PASSWORD_KEY, await sha256Hex("console-pw"));
    expect(await adminPasswordSource(makeEnv(kv))).toBe("kv");
  });

  it("reports secret when env is set and KV has no hash yet", async () => {
    expect(await adminPasswordSource(makeEnv(kv, "deploy-secret"))).toBe("secret");
  });

  it("reports secret when stored hash matches the env password", async () => {
    await kv.put(PASSWORD_KEY, await sha256Hex("deploy-secret"));
    expect(await adminPasswordSource(makeEnv(kv, "deploy-secret"))).toBe("secret");
  });

  it("reports kv once the console changed the password away from the secret", async () => {
    await kv.put(PASSWORD_KEY, await sha256Hex("console-new-pw"));
    expect(await adminPasswordSource(makeEnv(kv, "deploy-secret"))).toBe("kv");
  });
});

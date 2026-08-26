// API key store on KV (port of internal/web/keys.go).

import type { Env } from "../env";
import { getJSON, putJSON } from "../kv";
import { sha256Hex } from "../util";

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  hash: string;
  createdAt: string;
  lastUsedAt?: string;
  revoked: boolean;
}

interface KeysDoc {
  keys: ApiKeyRecord[];
}

const KEY = "api-keys";

async function load(env: Env): Promise<KeysDoc> {
  return (await getJSON<KeysDoc>(env["m365-copilot2api_KV"], KEY)) ?? { keys: [] };
}

export async function keyHash(k: string): Promise<string> {
  return sha256Hex(k);
}

export async function createKey(
  env: Env,
  name: string
): Promise<{ record: ApiKeyRecord; raw: string }> {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  const raw = "m365_" + hex;
  const record: ApiKeyRecord = {
    id: hex.slice(0, 16),
    name: name.trim() || "API key",
    prefix: raw.slice(0, 12),
    hash: await keyHash(raw),
    createdAt: new Date().toISOString(),
    revoked: false,
  };
  const doc = await load(env);
  doc.keys.push(record);
  await putJSON(env["m365-copilot2api_KV"], KEY, doc);
  return { record, raw };
}

export async function listKeys(env: Env): Promise<ApiKeyRecord[]> {
  const doc = await load(env);
  return doc.keys.map((k) => ({ ...k, hash: undefined as unknown as string }));
}

export async function revokeKey(env: Env, id: string): Promise<boolean> {
  const doc = await load(env);
  const k = doc.keys.find((x) => x.id === id && !x.revoked);
  if (!k) return false;
  k.revoked = true;
  await putJSON(env["m365-copilot2api_KV"], KEY, doc);
  return true;
}

export async function updateKey(
  env: Env,
  id: string,
  name: string,
  revoked?: boolean
): Promise<boolean> {
  const doc = await load(env);
  const k = doc.keys.find((x) => x.id === id);
  if (!k) return false;
  if (name !== "") k.name = name;
  if (revoked !== undefined) k.revoked = revoked;
  await putJSON(env["m365-copilot2api_KV"], KEY, doc);
  return true;
}

export async function deleteKey(env: Env, id: string): Promise<boolean> {
  const doc = await load(env);
  const before = doc.keys.length;
  doc.keys = doc.keys.filter((x) => x.id !== id);
  if (doc.keys.length === before) return false;
  await putJSON(env["m365-copilot2api_KV"], KEY, doc);
  return true;
}

export async function validKey(env: Env, raw: string): Promise<boolean> {
  if (!raw) return false;
  const h = await keyHash(raw);
  const doc = await load(env);
  const k = doc.keys.find((x) => x.hash === h && !x.revoked);
  if (!k) return false;
  k.lastUsedAt = new Date().toISOString();
  await putJSON(env["m365-copilot2api_KV"], KEY, doc); // small doc; write-behind acceptable here
  return true;
}

// Thin JSON-document helper over Workers KV.

export async function getJSON<T>(kv: KVNamespace, key: string): Promise<T | null> {
  try {
    return await kv.get<T>(key, "json");
  } catch {
    // Corrupt/undecodable values must not take down request paths.
    return null;
  }
}

export async function putJSON(
  kv: KVNamespace,
  key: string,
  value: unknown,
  opts?: { expirationTtl?: number }
): Promise<void> {
  // KV requires a TTL of at least 60 seconds.
  const expirationTtl = opts?.expirationTtl ? Math.max(60, Math.floor(opts.expirationTtl)) : undefined;
  await kv.put(key, JSON.stringify(value), expirationTtl ? { expirationTtl } : undefined);
}

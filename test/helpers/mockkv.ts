// Minimal in-memory KVNamespace mock for unit tests.
export class MockKV {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null>;
  async get<T>(key: string, type: "json"): Promise<T | null>;
  async get<T>(key: string, type?: "json"): Promise<T | string | null> {
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    if (type === "json") return JSON.parse(raw) as T;
    return raw;
  }

  async put(key: string, value: string, _opts?: unknown): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  // KVNamespace.list subset: prefix scan returning keys with their metadata
  // (the "at" field embedded in the stored JSON). Ordered by key name.
  async list(opts?: { prefix?: string; limit?: number }): Promise<{
    keys: { name: string; metadata?: Record<string, unknown> }[];
    list_complete: boolean;
    cursor?: string;
  }> {
    const prefix = opts?.prefix ?? "";
    const limit = opts?.limit ?? 1000;
    const keys: { name: string; metadata?: Record<string, unknown> }[] = [];
    const names = [...this.store.keys()].sort();
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      let metadata: Record<string, unknown> | undefined;
      try {
        const parsed = JSON.parse(this.store.get(name) ?? "{}") as { at?: string };
        if (parsed.at) metadata = { at: parsed.at };
      } catch {
        /* keep */
      }
      keys.push({ name, metadata });
      if (keys.length >= limit) break;
    }
    return { keys, list_complete: true };
  }

  dump(): Record<string, string> {
    return Object.fromEntries(this.store);
  }
}

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

  dump(): Record<string, string> {
    return Object.fromEntries(this.store);
  }
}

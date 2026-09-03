-- Storage review (Phase 3): per-session resolver blobs move from KV
-- (`resolver/<sessionId>`, TTL 2h) onto D1 so the last per-request KV write
-- (bindSession) disappears — KV writes were the binding free-tier quota.
-- `data` holds the serialized ResolverSession JSON (contextHistory capped at
-- 512 messages). Writes beyond the code-level size guard stay in KV, and KV
-- remains the no-D1 fallback and the read fallback on a D1 miss.
-- No KV-style TTL (project pattern, see 0004/0005): freshness is enforced on
-- read (KV TTL parity) and stale rows are pruned on a subset of writes.

CREATE TABLE IF NOT EXISTS resolver_session_blobs (
  session_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resolver_blobs_last_used ON resolver_session_blobs (last_used_at);

-- Storage audit remediation (docs/storage-audit-report.md):
--   P0-2: api-keys move from the KV "api-keys" document to D1 so revocation
--         takes effect immediately (KV is eventually consistent, ~60s window)
--         and lastUsedAt no longer rewrites the whole key list per request.
--   P1-1: accounts move from the KV "accounts" document to D1 rows so token
--         refreshes (single-use AAD refresh tokens) are written atomically
--         instead of via whole-document read-modify-write.
--   P2-1: cache-stats move to atomic per-key counters (no lost updates).
--
-- All stores keep the KV document as a mirror/fallback so a code revert (or
-- removing the DB binding) transparently falls back to the previous behavior.

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  prefix TEXT NOT NULL DEFAULT '',
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (hash);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'online',
  access_token TEXT NOT NULL DEFAULT '',
  refresh_token TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  oid TEXT NOT NULL DEFAULT '',
  tid TEXT NOT NULL DEFAULT '',
  client_id TEXT NOT NULL DEFAULT '',
  schedule_disabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cache_stats (
  api_key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL DEFAULT 0,
  misses INTEGER NOT NULL DEFAULT 0,
  tokens_sent INTEGER NOT NULL DEFAULT 0,
  tokens_saved INTEGER NOT NULL DEFAULT 0,
  last_used TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS cache_stats_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Storage review P1-1 (Phase 2): the four per-request background KV writes
-- move onto D1 — the conversations index, session-key bindings, user sessions
-- and the conversation cache together burned ~4 of the 1,000/day free-tier KV
-- writes per request (plus one read each). With the DB binding these stores
-- live here; KV remains the no-D1 fallback and the one-time lazy backfill
-- source (project pattern, see keys.ts / resolver.ts). The fallback copies
-- are no longer written on the hot path, so a code revert surfaces the last
-- pre-migration state until entries age back in.

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations (updated_at);

CREATE TABLE IF NOT EXISTS session_bindings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_bindings_conversation ON session_bindings (conversation_id);

CREATE TABLE IF NOT EXISTS user_sessions (
  api_key_hash TEXT NOT NULL,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  account_id TEXT NOT NULL DEFAULT '',
  last_used_at TEXT NOT NULL,
  PRIMARY KEY (api_key_hash, user_id)
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_last_used ON user_sessions (last_used_at);

CREATE TABLE IF NOT EXISTS conv_cache (
  cache_key TEXT PRIMARY KEY,
  account_id TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  message_count INTEGER NOT NULL DEFAULT 0,
  sys_hash TEXT NOT NULL DEFAULT '',
  last_used_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_cache_last_used ON conv_cache (last_used_at);

-- TTL note: no KV-style expirations on D1 tables (project pattern, see
-- 0004). Freshness is enforced by the SQL window filter on read; stale rows
-- are pruned on a subset of writes (bounded maintenance), not per write.

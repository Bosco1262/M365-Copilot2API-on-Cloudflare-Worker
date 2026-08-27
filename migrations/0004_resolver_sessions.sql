-- Resolver session index (storage review, low priority #1): the content-key
-- session resolver used to keep its candidate index in a single KV document
-- ("resolver-index", <=1000 lightweight summaries) rewritten on every bind —
-- concurrent read-modify-write could drop index entries and make a follow-up
-- turn "forget" its session. The per-session payloads already live in
-- independent KV keys `resolver/<sessionId>` (TTL 2h, audit P0-1); this table
-- replaces only the index. The KV document remains as the no-D1 fallback and
-- as the one-time lazy backfill source (matching the project's
-- `if (env.DB) ... else KV` pattern).

CREATE TABLE IF NOT EXISTS resolver_sessions (
  session_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL DEFAULT '',
  account_id TEXT NOT NULL DEFAULT '',
  last_used_at TEXT NOT NULL,
  ip_fingerprint TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_resolver_last_used ON resolver_sessions (last_used_at);
CREATE INDEX IF NOT EXISTS idx_resolver_conversation ON resolver_sessions (conversation_id);

-- TTL is enforced by the SQL window filter on read and the trim on bind;
-- no KV-style expirations on D1 tables (project pattern).

-- M365-Copilot2API D1 schema (apply with:
--   npx wrangler d1 migrations apply m365-copilot2api --remote)

CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  api_key_prefix TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events (ts);
CREATE INDEX IF NOT EXISTS idx_usage_key ON usage_events (api_key_prefix);

CREATE TABLE IF NOT EXISTS debug_records (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 0,
  level TEXT NOT NULL DEFAULT 'info',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_debug_at ON debug_records (at);

DELETE FROM usage_events WHERE ts < datetime('now', '-90 days');
DELETE FROM debug_records WHERE at < datetime('now', '-7 days');

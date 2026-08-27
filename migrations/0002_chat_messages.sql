-- Conversation detail viewer storage (batch C): one row per user prompt and
-- per assistant answer, keyed by (conversation_id, seq) so the viewer can
-- replay turns in order. TTL is enforced by the cron sweep (DELETE by age),
-- matching the project pattern of no KV-style expirations on D1 tables.

CREATE TABLE IF NOT EXISTS chat_messages (
  conversation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(conversation_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages (created_at);

DELETE FROM chat_messages WHERE created_at < datetime('now', '-7 days');

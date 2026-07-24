-- chat_history — long-term conversation archive for multi-turn chat.
-- Flushed from DO conversation_buffer via the existing _flush_registry alarm.
-- Columns match conversation_buffer (minus auto-increment id) so the alarm's
-- generic PRAGMA → INSERT flush works without modification.

CREATE TABLE IF NOT EXISTS chat_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_history_device
  ON chat_history(tenant_id, device_id, created_at);

-- FunConnect v1 D1 Schema — Smoke Test
-- Only hello_log: proves the WSS→DO→D1 pipeline end-to-end.

CREATE TABLE IF NOT EXISTS hello_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id   TEXT NOT NULL,
    timestamp   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hello_device ON hello_log(device_id);
CREATE INDEX IF NOT EXISTS idx_hello_ts ON hello_log(timestamp);

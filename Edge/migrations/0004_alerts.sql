-- FunConnect v1 D1 Schema — Alerts (Phase 2)
-- Disturbance detection events with 75-sample kinetic profiles.

CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    event TEXT NOT NULL,
    accel_peak REAL,
    omega_peak REAL,
    signature INTEGER,
    samples TEXT,
    do_ms INTEGER,
    created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_alerts_device_ts ON alerts(device_id, created_at);

-- FunConnect v1 D1 Schema — Telemetry (Phase 1)
-- Cold-path storage for device state frames.

CREATE TABLE IF NOT EXISTS telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    tilt REAL,
    vibration REAL,
    acc_x REAL, acc_y REAL, acc_z REAL,
    gyro_x REAL, gyro_y REAL, gyro_z REAL,
    uptime_ms INTEGER,
    do_ms INTEGER,
    created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_telemetry_device_ts ON telemetry(device_id, created_at);

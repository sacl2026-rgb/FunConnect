-- Users table — replaces hardcoded admin/admin123 login.
-- SHA-256("admin123") = 240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9

CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    tenant_id     TEXT NOT NULL DEFAULT 'admin',
    role          TEXT NOT NULL DEFAULT 'user',
    name          TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL
);

INSERT OR IGNORE INTO users (id, tenant_id, role, name, password_hash)
VALUES ('admin', 'admin', 'admin', 'admin', '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9');

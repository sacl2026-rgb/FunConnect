-- Tenants table — multi-tenant config, one row per tenant.

CREATE TABLE IF NOT EXISTS tenants (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    jurisdiction   TEXT NOT NULL DEFAULT 'apac',
    billing_plan   TEXT NOT NULL DEFAULT 'free',
    created_at     INTEGER DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO tenants (id, name, jurisdiction, billing_plan)
VALUES ('admin', 'Default Tenant', 'apac', 'free');

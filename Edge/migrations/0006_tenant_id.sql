-- Add tenant_id to all existing tables with DEFAULT 'admin' for backward compat.
-- Existing rows automatically get tenant_id = 'admin'.

ALTER TABLE hello_log ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE telemetry ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE alerts ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'admin';

-- Composite index for tenant-scoped device queries (most common access pattern).
CREATE INDEX IF NOT EXISTS idx_telemetry_tenant_device_ts
  ON telemetry(tenant_id, device_id, created_at);

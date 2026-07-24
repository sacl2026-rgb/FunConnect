-- FunConnect v1 D1 Schema — Health (Phase 1 extension)
-- Client-side resilience counters from firmware.

ALTER TABLE telemetry ADD COLUMN health_mem INTEGER;
ALTER TABLE telemetry ADD COLUMN health_reconns INTEGER;
ALTER TABLE telemetry ADD COLUMN health_errs INTEGER;
ALTER TABLE telemetry ADD COLUMN health_rot INTEGER;

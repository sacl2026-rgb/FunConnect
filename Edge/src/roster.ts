/**
 * TenantRoster — per-tenant device registry.
 *
 * Replaces hard-coded ["mbot2-01"] with a queriable DO-local device list.
 * One DO per tenant: idFromName("admin/roster").
 *
 * Registration path: CyberpiHub hello handler → waitUntil → POST /register.
 * Query path: Worker → GET /list → replaces base-id probes.
 */

import { DurableObject } from "cloudflare:workers";

// ── Types ──────────────────────────────────────────────────────────────────

export interface RosterEntry {
  device_id: string;
  device_type: string;
  created_at: number;
  updated_at: number;
}

// Re-use the Env type from device-hub.ts for the DO binding.
// Imported as a type-only reference to avoid circular bundling issues.
import type { Env } from "./device-hub";

// ── Schema Migration ───────────────────────────────────────────────────────

const MIGRATIONS = [
  {
    id: 1, description: "devices table",
    sql: `CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY,
      device_type TEXT NOT NULL DEFAULT 'cyberpi',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  },
];

// ── DO Class ───────────────────────────────────────────────────────────────

export class TenantRoster extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Apply pending schema migrations.
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, description TEXT, applied_at INTEGER)"
    );
    for (const m of MIGRATIONS) {
      const done = ctx.storage.sql.exec(
        "SELECT 1 FROM _migrations WHERE id = ?", m.id
      );
      if ([...done].length > 0) continue;
      for (const stmt of m.sql.split(";").map(s => s.trim()).filter(s => s.length > 0)) {
        try { ctx.storage.sql.exec(stmt); } catch { /* already exists */ }
      }
      ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO _migrations (id, description, applied_at) VALUES (?, ?, ?)",
        m.id, m.description, Date.now()
      );
    }
  }

  // ── fetch() ────────────────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    const CORS = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    };
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: CORS });

    // POST /register — upsert a device (called from CyberpiHub hello handler).
    if (path === "/register" && request.method === "POST") {
      try {
        const body = await request.json() as { device_id?: string; device_type?: string };
        if (!body.device_id) return json({ error: "device_id required" }, 400);
        const now = Date.now();
        this.ctx.storage.sql.exec(
          `INSERT INTO devices (device_id, device_type, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?3)
           ON CONFLICT(device_id) DO UPDATE SET
             device_type = COALESCE(?2, device_type),
             updated_at = ?3`,
          body.device_id, body.device_type || "cyberpi", now
        );
        return json({ success: true, device_id: body.device_id });
      } catch (err) {
        return json({ error: (err as Error).message }, 500);
      }
    }

    // GET /list — all devices for this tenant, newest-updated first.
    if (path === "/list" && request.method === "GET") {
      const cursor = this.ctx.storage.sql.exec(
        "SELECT device_id, device_type, created_at, updated_at FROM devices ORDER BY updated_at DESC LIMIT 100"
      );
      const devices = [...cursor].map((r: any) => ({
        device_id: r.device_id,
        device_type: r.device_type,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }));
      return json({ devices });
    }

    // GET /:deviceId — single device lookup.
    const deviceMatch = path.match(/^\/([^/]+)$/);
    if (deviceMatch && request.method === "GET") {
      const cursor = this.ctx.storage.sql.exec(
        "SELECT device_id, device_type, created_at, updated_at FROM devices WHERE device_id = ?",
        deviceMatch[1]
      );
      const row = [...cursor][0] as any;
      if (!row) return json({ error: "device not found" }, 404);
      return json({
        device_id: row.device_id,
        device_type: row.device_type,
        created_at: row.created_at,
        updated_at: row.updated_at,
      });
    }

    return json({ error: "not found" }, 404);
  }
}

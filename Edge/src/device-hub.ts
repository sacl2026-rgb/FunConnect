/**
 * CyberpiHub — Durable Object for mBot2 CyberPi WSS pipeline.
 *
 * Non-negotiables:
 *  - ctx.acceptWebSocket(server) — NEVER server.accept()
 *  - ZERO await in webSocketMessage() — sync ctx.storage.sql.exec() only
 *  - Alarm always reschedules (finally { setAlarm }) — prototype-proven
 *
 * Structural fixes:
 *  - _flush_registry — alarm discovers buffer tables at runtime
 *  - durable-utils — tracked schema migrations (ALTER TABLE, new tables)
 */

import { DurableObject } from "cloudflare:workers";
import { madgwick } from "./madgwick";
import type { TenantRoster } from "./roster";

// ── Types ──────────────────────────────────────────────────────────────────

interface Attachment {
  role: "cyberpi" | "dashboard";
  deviceId: string;
  tenantId: string;
  deviceType: "cyberpi" | "microbit" | "musebrick";
}

export interface Env {
  CYBERPI_HUB: DurableObjectNamespace<CyberpiHub>;
  TENANT_ROSTER: DurableObjectNamespace<TenantRoster>;
  DB: D1Database;
  AI: Ai;
  DASHSCOPE_KEY?: string;   // Qwen API key (Worker secret). Absent → Workers AI.
  CHAT_THINKING?: string;   // "on" enables auto-thinking for analytical questions.
}

// ── Schema Migrations (SQLite-native — no async KV dependency) ───────────

const MIGRATIONS: { id: number; description: string; sql: string }[] = [
  {
    id: 1, description: "hello_log + _migrations + _flush_registry",
    sql: `CREATE TABLE IF NOT EXISTS hello_log (
      device_id TEXT NOT NULL, timestamp INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY, description TEXT, applied_at INTEGER);
      CREATE TABLE IF NOT EXISTS _flush_registry (
      local_table TEXT PRIMARY KEY, d1_table TEXT NOT NULL)`,
  },
  {
    id: 2, description: "telemetry_buffer",
    sql: `CREATE TABLE IF NOT EXISTS telemetry_buffer (
      device_id TEXT NOT NULL,
      tilt REAL, vibration REAL,
      acc_x REAL, acc_y REAL, acc_z REAL,
      gyro_x REAL, gyro_y REAL, gyro_z REAL,
      uptime_ms INTEGER, do_ms INTEGER)`,
  },
  {
    id: 3, description: "health columns on telemetry_buffer",
    sql: `ALTER TABLE telemetry_buffer ADD COLUMN health_mem INTEGER;
      ALTER TABLE telemetry_buffer ADD COLUMN health_reconns INTEGER;
      ALTER TABLE telemetry_buffer ADD COLUMN health_errs INTEGER;
      ALTER TABLE telemetry_buffer ADD COLUMN health_rot INTEGER`,
  },
  {
    id: 4, description: "alert_buffer",
    sql: `CREATE TABLE IF NOT EXISTS alert_buffer (
      device_id TEXT NOT NULL, event TEXT NOT NULL,
      accel_peak REAL, omega_peak REAL,
      signature INTEGER, samples TEXT, do_ms INTEGER)`,
  },
  {
    id: 5, description: "madgwick_json on alert_buffer",
    sql: `ALTER TABLE alert_buffer ADD COLUMN madgwick_json TEXT`,
  },
  {
    id: 6, description: "telemetry_buffer UPSERT — UNIQUE on device_id, WITHOUT ROWID",
    sql: `CREATE TABLE IF NOT EXISTS telemetry_buffer_v2 (
      device_id TEXT PRIMARY KEY,
      tilt REAL, vibration REAL,
      acc_x REAL, acc_y REAL, acc_z REAL,
      gyro_x REAL, gyro_y REAL, gyro_z REAL,
      uptime_ms INTEGER, do_ms INTEGER,
      health_mem INTEGER, health_reconns INTEGER, health_errs INTEGER, health_rot INTEGER
    ) WITHOUT ROWID;
    INSERT OR IGNORE INTO telemetry_buffer_v2 SELECT * FROM telemetry_buffer;
    DROP TABLE telemetry_buffer;
    ALTER TABLE telemetry_buffer_v2 RENAME TO telemetry_buffer`,
  },
  {
    id: 7, description: "tenant_id on buffer tables",
    sql: `ALTER TABLE hello_log ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'admin';
          ALTER TABLE telemetry_buffer ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'admin';
          ALTER TABLE alert_buffer ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'admin'`,
  },
  {
    id: 8, description: "conversation_buffer for multi-turn chat context",
    sql: `CREATE TABLE IF NOT EXISTS conversation_buffer (
      tenant_id  TEXT NOT NULL DEFAULT 'admin',
      device_id  TEXT NOT NULL,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  },
];

// ── DO Class ───────────────────────────────────────────────────────────────

export class CyberpiHub extends DurableObject<Env> {
  private deviceWs: WebSocket | null = null;
  private dashboards = new Map<WebSocket, Attachment>();
  private lastTelemetry: Record<string, unknown> = {};
  private lastMotors: Record<string, unknown> = {};
  private lastLeds: unknown[] = [];
  private pendingEcho: {
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  } | null = null;
  private pendingExec: {
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  } | null = null;
  private pendingFsTest: {
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  } | null = null;

  /** ledState via sync KV — survives hibernation, zero await. */
  private get ledState(): boolean {
    return (this.ctx.storage.kv.get("ledState") as boolean) ?? false;
  }
  private set ledState(v: boolean) {
    this.ctx.storage.kv.put("ledState", v);
  }

  // ── Constructor ────────────────────────────────────────────────────────

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Apply pending schema migrations via sync SQLite.
    // Tracks applied migrations in _migrations table — no async KV dependency.
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, description TEXT, applied_at INTEGER)"
    );
    for (const m of MIGRATIONS) {
      const done = ctx.storage.sql.exec(
        "SELECT 1 FROM _migrations WHERE id = ?", m.id
      );
      if ([...done].length > 0) continue;
      for (const stmt of m.sql.split(";").map(s => s.trim()).filter(s => s.length > 0)) {
        try { ctx.storage.sql.exec(stmt); } catch {}
      }
      ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO _migrations (id, description, applied_at) VALUES (?, ?, ?)",
        m.id, m.description, Date.now()
      );
    }

    // Register buffer→D1 mappings so the alarm discovers them at runtime.
    ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO _flush_registry (local_table, d1_table) VALUES (?, ?)",
      "hello_log", "hello_log"
    );
    ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO _flush_registry (local_table, d1_table) VALUES (?, ?)",
      "telemetry_buffer", "telemetry"
    );
    ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO _flush_registry (local_table, d1_table) VALUES (?, ?)",
      "alert_buffer", "alerts"
    );
    ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO _flush_registry (local_table, d1_table) VALUES (?, ?)",
      "conversation_buffer", "chat_history"
    );

    // Restore WebSockets from hibernation.
    ctx.getWebSockets().forEach((ws) => {
      const meta = ws.deserializeAttachment() as Attachment | null;
      if (meta?.role === "cyberpi") {
        this.deviceWs = ws;
      } else if (meta?.role === "dashboard") {
        this.dashboards.set(ws, meta);
      }
    });
  }

  // ── fetch(): WebSocket Upgrade + debug endpoints ────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const tenantId = url.searchParams.get("tenant") || "admin";

    // /do-hello-count
    if (url.pathname === "/do-hello-count" && request.method === "GET") {
      const deviceId = url.searchParams.get("device") || "cyberpi";
      const cursor = this.ctx.storage.sql.exec(
        "SELECT COUNT(*) as cnt FROM hello_log WHERE device_id = ?",
        deviceId
      );
      const row = [...cursor][0];
      return new Response(JSON.stringify({
        device_id: deviceId,
        count: (row?.cnt as number) || 0,
      }), { headers: { "Content-Type": "application/json" } });
    }

    // /do-telemetry-count
    if (url.pathname === "/do-telemetry-count" && request.method === "GET") {
      const deviceId = url.searchParams.get("device") || "cyberpi";
      const cursor = this.ctx.storage.sql.exec(
        "SELECT COUNT(*) as cnt FROM telemetry_buffer WHERE device_id = ?",
        deviceId
      );
      const row = [...cursor][0];
      return new Response(JSON.stringify({
        device_id: deviceId,
        count: (row?.cnt as number) || 0,
      }), { headers: { "Content-Type": "application/json" } });
    }

    // /do-telemetry-sample
    if (url.pathname === "/do-telemetry-sample" && request.method === "GET") {
      const deviceId = url.searchParams.get("device") || "cyberpi";
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "3"), 10);
      const cursor = this.ctx.storage.sql.exec(
        `SELECT device_id, tilt, vibration,
                acc_x, acc_y, acc_z,
                gyro_x, gyro_y, gyro_z,
                uptime_ms, do_ms,
                health_mem, health_reconns, health_errs, health_rot
         FROM telemetry_buffer WHERE device_id = ?
         ORDER BY rowid DESC LIMIT ?`,
        deviceId, limit
      );
      const rows = [...cursor].map((r: any) => ({
        device_id: r.device_id,
        tilt: r.tilt, vibration: r.vibration,
        acc_x: r.acc_x, acc_y: r.acc_y, acc_z: r.acc_z,
        gyro_x: r.gyro_x, gyro_y: r.gyro_y, gyro_z: r.gyro_z,
        uptime_ms: r.uptime_ms, do_ms: r.do_ms,
        health: { mem: r.health_mem, reconns: r.health_reconns, errs: r.health_errs, rot: r.health_rot },
      }));
      return new Response(JSON.stringify({ device_id: deviceId, rows }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── GET /api/live-status — live device status (DO-local, always fresh)
    if (url.pathname === "/api/live-status" && request.method === "GET") {
      const deviceId = url.searchParams.get("device") || "cyberpi";
      const att = this.deviceWs?.deserializeAttachment() as Attachment | undefined;
      const telCursor = this.ctx.storage.sql.exec(
        "SELECT COUNT(*) as cnt FROM telemetry_buffer WHERE device_id = ?", deviceId
      );
      const alertCursor = this.ctx.storage.sql.exec(
        "SELECT COUNT(*) as cnt FROM alert_buffer WHERE device_id = ?", deviceId
      );
      return new Response(JSON.stringify({
        device_id: deviceId,
        device_type: att?.deviceType || "cyberpi",
        online: this.deviceWs !== null,
        dashboard_count: this.dashboards.size,
        buffer_telemetry: ([...telCursor][0]?.cnt as number) || 0,
        buffer_alerts: ([...alertCursor][0]?.cnt as number) || 0,
      }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }

    // /do-alert-count
    if (url.pathname === "/do-alert-count" && request.method === "GET") {
      const deviceId = url.searchParams.get("device") || "cyberpi";
      const cursor = this.ctx.storage.sql.exec(
        "SELECT COUNT(*) as cnt FROM alert_buffer WHERE device_id = ?",
        deviceId
      );
      const row = [...cursor][0];
      return new Response(JSON.stringify({
        device_id: deviceId,
        count: (row?.cnt as number) || 0,
      }), { headers: { "Content-Type": "application/json" } });
    }

    // /do-recent-alerts — live (un-flushed) alert_buffer rows, for chat freshness.
    // Lets the NL layer see just-happened events even when the flush alarm lags/dies.
    if (url.pathname === "/do-recent-alerts" && request.method === "GET") {
      const deviceId = url.searchParams.get("device") || "cyberpi";
      const cursor = this.ctx.storage.sql.exec(
        `SELECT device_id, event, signature, do_ms, madgwick_json
           FROM alert_buffer WHERE device_id = ? ORDER BY do_ms DESC LIMIT 25`,
        deviceId
      );
      const alerts = [...cursor].map((r: any) => ({
        device_id: r.device_id, event: r.event, signature: r.signature,
        do_ms: r.do_ms, madgwick_json: r.madgwick_json,
      }));
      return new Response(JSON.stringify({ alerts }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // /do-conversation-buffer — live conversation turns for multi-turn chat.
    // Follows /do-recent-alerts pattern. Ordered oldest→first per Beauty contract.
    if (url.pathname === "/do-conversation-buffer" && request.method === "GET") {
      const deviceId = url.searchParams.get("device") || "cyberpi";
      const cursor = this.ctx.storage.sql.exec(
        `SELECT role, content, created_at
           FROM conversation_buffer WHERE device_id = ?
           ORDER BY created_at ASC LIMIT 8`,
        deviceId
      );
      const turns = [...cursor].map((r: any) => ({
        role: r.role, content: r.content, created_at: r.created_at,
      }));
      return new Response(JSON.stringify({ turns }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // /do-conversation-append — append turns, cap at 8 rows.
    // Fire-and-forget from the Worker. Follows existing endpoint structure.
    if (url.pathname === "/do-conversation-append" && request.method === "POST") {
      try {
        const body = await request.json() as { device_id?: string; tenant_id?: string; turns?: Array<{role: string; content: string}> };
        const did = body.device_id || "cyberpi";
        const tid = body.tenant_id || tenantId;
        const turns = body.turns || [];
        for (const t of turns) {
          if (!t.role || !t.content) continue;
          this.ctx.storage.sql.exec(
            "INSERT INTO conversation_buffer (tenant_id, device_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
            tid, did, t.role, t.content, Math.floor(Date.now() / 1000)
          );
        }
        // Sliding window cap — keep last 8 rows by created_at.
        this.ctx.storage.sql.exec(
          `DELETE FROM conversation_buffer
           WHERE rowid NOT IN (
             SELECT rowid FROM conversation_buffer
             ORDER BY created_at DESC LIMIT 8
           )`
        );
        return new Response(null, { status: 204 });
      } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // ── GET /api/device-ids — all device_ids in telemetry_buffer ─────
    if (url.pathname === "/api/device-ids" && request.method === "GET") {
      const cursor = this.ctx.storage.sql.exec(
        "SELECT device_id, COUNT(*) as cnt FROM telemetry_buffer GROUP BY device_id ORDER BY cnt DESC LIMIT 20"
      );
      const rows = [...cursor].map((r: any) => ({ device_id: r.device_id, count: r.cnt }));
      return new Response(JSON.stringify({ devices: rows }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // ── GET /api/debug — DO state (deviceWs, WS count) ──────────────
    if (url.pathname === "/api/debug" && request.method === "GET") {
      const wsList = this.ctx.getWebSockets();
      return new Response(JSON.stringify({
        deviceWs: !!this.deviceWs,
        wsCount: wsList.length,
        wsRoles: wsList.map(w => {
          try { return (w.deserializeAttachment() as Attachment)?.role || "none"; }
          catch { return "error"; }
        }),
      }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }

    // ── POST /api/echo — send echo command to device, wait for ack ────
    if (url.pathname === "/api/echo" && request.method === "POST") {
      if (!this.deviceWs) {
        return new Response(JSON.stringify({ error: "device not connected" }), {
          status: 503,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }

      let body: { text?: string } = {};
      try { body = await request.json(); } catch {
        return new Response(JSON.stringify({ error: "invalid json" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }

      const text = body.text || "hello";
      const sendTs = Date.now();

      // Promise bridge: fetch() awaits the ack, webSocketMessage() resolves it.
      const ackPromise = new Promise<{ text: string; deviceTs: number; rttMs: number }>((resolve, reject) => {
        this.pendingEcho = { resolve: resolve as any, reject };
        this.deviceWs!.send(JSON.stringify({ command: "echo", params: { text } }));
        // Timeout: if device doesn't respond in 10s, reject.
        setTimeout(() => {
          if (this.pendingEcho) {
            this.pendingEcho.reject(new Error("echo timeout"));
            this.pendingEcho = null;
          }
        }, 10_000);
      });

      try {
        const result = await ackPromise;
        const att = this.deviceWs?.deserializeAttachment() as Attachment | undefined;
        return new Response(JSON.stringify({
          device_id: att?.deviceId || "unknown",
          text: result.text,
          device_ts: result.deviceTs,
          rtt_ms: result.rttMs,
        }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 504,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // ── POST /api/exec — run Python code on device ────────────────────
    if (url.pathname === "/api/exec" && request.method === "POST") {
      if (!this.deviceWs) {
        return new Response(JSON.stringify({ error: "device not connected" }), {
          status: 503,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
      let body: { code?: string } = {};
      try { body = await request.json(); } catch {
        return new Response(JSON.stringify({ error: "invalid json" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
      const sendTs = Date.now();
      const ackPromise = new Promise<any>((resolve, reject) => {
        this.pendingExec = { resolve, reject };
        this.deviceWs!.send(JSON.stringify({ command: "exec", code: body.code || "" }));
        setTimeout(() => {
          if (this.pendingExec) { this.pendingExec.reject(new Error("exec timeout")); this.pendingExec = null; }
        }, 10_000);
      });
      try {
        const result = await ackPromise;
        return new Response(JSON.stringify({
          status: result.status, error: result.error, rtt_ms: Date.now() - sendTs,
        }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 504,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // ── POST /api/fs-test — test filesystem on device ──────────────────
    if (url.pathname === "/api/fs-test" && request.method === "POST") {
      if (!this.deviceWs) {
        return new Response(JSON.stringify({ error: "device not connected" }), {
          status: 503,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
      const ackPromise = new Promise<any>((resolve, reject) => {
        this.pendingFsTest = { resolve, reject };
        this.deviceWs!.send(JSON.stringify({ command: "fs_test" }));
        setTimeout(() => {
          if (this.pendingFsTest) { this.pendingFsTest.reject(new Error("fs_test timeout")); this.pendingFsTest = null; }
        }, 10_000);
      });
      try {
        const result = await ackPromise;
        return new Response(JSON.stringify({
          write: result.write, read: result.read, delete: result.delete, error: result.error,
        }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 504,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // WebSocket upgrade.
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    const segments = url.pathname.split("/").filter(Boolean);
    const deviceId = segments.length >= 2 ? segments[1] : "unknown";
    const isDashboard = segments[0] === "dashboard";
    const role: Attachment["role"] = isDashboard ? "dashboard" : "cyberpi";
    const att: Attachment = { role, deviceId, tenantId, deviceType: "cyberpi" };
    server.serializeAttachment(att);

    if (isDashboard) {
      this.dashboards.set(server, att);
      // Send current telemetry snapshot to the new dashboard.
      if (this.lastTelemetry && Object.keys(this.lastTelemetry).length > 0) {
        server.send(JSON.stringify({
          type: "state", device_id: deviceId,
          connected: this.deviceWs !== null,
          telemetry: this.lastTelemetry,
          motors: this.lastMotors,
          leds: this.lastLeds,
          doTs: Date.now(),
        }));
      }

      // Replay recent alerts so the dashboard doesn't lose them on refresh.
      // Two sources: alert_buffer (DO-local, unflushed, sync) is authoritative
      // for recent data. D1 (flushed history, async) only fills in when the
      // buffer is thin (fewer than 5 rows — alarm likely just flushed).
      // Deduped by do_ms.
      //
      // CONTRACT WITH BEAUTY (app.jsx:783): Beauty prepends every WebSocket
      // alert — setAlerts(prev => [a, ...prev]). To get newest-at-top after
      // prepending a batch, Edge MUST send oldest-first so the last message
      // (newest) lands at the front of the array.
      const MIN_BUFFER_FOR_SKIP_D1 = 5;
      const sentMs = new Set<number>();

      // Phase 1 — unflushed alerts from DO-local buffer (sync, zero await).
      const alertCursor = this.ctx.storage.sql.exec(
        "SELECT device_id, event, accel_peak, omega_peak, signature, do_ms, madgwick_json FROM alert_buffer WHERE device_id = ? ORDER BY do_ms DESC LIMIT 30",
        deviceId
      );
      const alertRows = [...alertCursor];
      // Query returns newest-first; iterate in reverse (oldest-first) per Beauty contract.
      for (let i = alertRows.length - 1; i >= 0; i--) {
        const r = alertRows[i] as any;
        if (r.do_ms != null) sentMs.add(r.do_ms as number);
        server.send(JSON.stringify({
          type: "alert",
          device_id: r.device_id,
          event: r.event,
          accel_peak: r.accel_peak,
          omega_peak: r.omega_peak,
          signature: r.signature,
          madgwick_json: typeof r.madgwick_json === "string" ? JSON.parse(r.madgwick_json) : null,
          do_ms: r.do_ms,
        }));
      }

      // Phase 2 — D1 fallback, only when the buffer was thin. Avoids
      // polluting the dashboard with stale D1 rows when the buffer already
      // has plenty of fresh alerts.
      if (alertRows.length < MIN_BUFFER_FOR_SKIP_D1) {
        try {
          const d1Result = await this.env.DB.prepare(
            `SELECT device_id, event, accel_peak, omega_peak, signature, do_ms, madgwick_json
             FROM alerts WHERE device_id = ?1 AND tenant_id = ?2 AND madgwick_json IS NOT NULL
             ORDER BY COALESCE(do_ms, created_at*1000) DESC LIMIT 20`
          ).bind(deviceId, tenantId).all();
          const d1Rows = (d1Result.results ?? []) as any[];
          // Same reverse iteration — oldest-first per Beauty prepend contract.
          for (let i = d1Rows.length - 1; i >= 0; i--) {
            const row = d1Rows[i];
            if (row.do_ms != null && sentMs.has(row.do_ms as number)) continue;
            if (row.do_ms != null) sentMs.add(row.do_ms as number);
            server.send(JSON.stringify({
              type: "alert",
              device_id: row.device_id,
              event: row.event,
              accel_peak: row.accel_peak,
              omega_peak: row.omega_peak,
              signature: row.signature,
              madgwick_json: typeof row.madgwick_json === "string" ? JSON.parse(row.madgwick_json) : row.madgwick_json,
              do_ms: row.do_ms,
            }));
          }
        } catch (err) {
          console.error("[CyberpiHub] D1 alert replay failed:", err);
        }
      }
    } else {
      if (this.deviceWs) {
        try { this.deviceWs.close(1000, "Replaced"); } catch { /* ok */ }
      }
      this.deviceWs = server;
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // ── webSocketMessage(): Hot Path — ZERO awaits ─────────────────────────

  async webSocketMessage(ws: WebSocket, raw: string) {
    let data: { type: string; device_id?: string };
    try {
      data = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "invalid json" }));
      return;
    }

    switch (data.type) {
      case "hello": {
        const att = ws.deserializeAttachment() as Attachment;
        const deviceId = data.device_id || att.deviceId || "cyberpi";
        const deviceType = (data.device_type || att.deviceType || "cyberpi") as Attachment["deviceType"];
        const tenant = att.tenantId || "admin";

        // Update attachment with device-reported identity.
        ws.serializeAttachment({ ...att, deviceId, deviceType });

        this.ctx.storage.sql.exec(
          "INSERT INTO hello_log (device_id, timestamp, tenant_id) VALUES (?, ?, ?)",
          deviceId, Date.now(), tenant
        );
        ws.send(JSON.stringify({ type: "welcome", device_id: deviceId }));
        ws.send(JSON.stringify({ type: "sync", device_id: deviceId, led: this.ledState, doTs: Date.now() }));

        // Register device in the tenant roster (fire-and-forget — does not block).
        this.ctx.waitUntil(this.registerInRoster(deviceId, deviceType, tenant));

        this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + 60_000));
        break;
      }

      case "state": {
        const att = ws.deserializeAttachment() as Attachment;
        const deviceId = data.device_id || att.deviceId || "cyberpi";
        const tenant = att.tenantId || "admin";
        const telemetry = (data.telemetry || {}) as Record<string, unknown>;
        const health = (data.health || {}) as Record<string, unknown>;
        const now = Date.now();

        this.ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO telemetry_buffer
             (device_id, tilt, vibration, acc_x, acc_y, acc_z,
              gyro_x, gyro_y, gyro_z, uptime_ms, do_ms,
              health_mem, health_reconns, health_errs, health_rot, tenant_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          deviceId,
          telemetry.tilt ?? null, telemetry.vibration ?? null,
          telemetry.acc_x ?? null, telemetry.acc_y ?? null, telemetry.acc_z ?? null,
          telemetry.gyro_x ?? null, telemetry.gyro_y ?? null, telemetry.gyro_z ?? null,
          data.esp32_ms ?? null, now,
          health.mem ?? null, health.reconns ?? null, health.errs ?? null, health.rot ?? null,
          tenant
        );

        // Cache for dashboard snapshots and broadcast to connected browsers.
        this.lastTelemetry = telemetry;
        this.lastMotors = (data.motors || {}) as Record<string, unknown>;
        this.lastLeds = (data.leds || []) as unknown[];
        this.broadcast({
          type: "state", device_id: deviceId,
          connected: true,
          telemetry: this.lastTelemetry,
          motors: this.lastMotors,
          leds: this.lastLeds,
          doTs: now,
        });

        // buf is always 1 post-UPSERT — kept for backward compat.
        // alert_depth is the real dead-alarm signal: alert_buffer is
        // plain INSERT, so it grows when the alarm stops flushing.
        const bufCursor = this.ctx.storage.sql.exec(
          "SELECT COUNT(*) as cnt FROM telemetry_buffer WHERE device_id = ?", deviceId
        );
        const bufRow = [...bufCursor][0];
        const alertCursor = this.ctx.storage.sql.exec(
          "SELECT COUNT(*) as cnt FROM alert_buffer WHERE device_id = ?", deviceId
        );
        const alertRow = [...alertCursor][0];
        const lastFlush = (this.ctx.storage.kv.get("last_flush_ms") as number) || 0;
        ws.send(JSON.stringify({
          type: "ack", ref: "state", doTs: now,
          buf: (bufRow?.cnt as number) || 0,
          alert_depth: (alertRow?.cnt as number) || 0,
          last_flush_ms: lastFlush,
        }));
        this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + 60_000));
        break;
      }

      case "alert": {
        const att = ws.deserializeAttachment() as Attachment;
        const deviceId = data.device_id || att.deviceId || "cyberpi";
        const tenant = att.tenantId || "admin";
        const now = Date.now();
        const samples = (data.samples || []) as number[][];

        // Server-side Madgwick AHRS — V8 runs ~5ms for 75 samples.
        const mResult = samples.length > 0 ? madgwick(samples) : null;

        this.ctx.storage.sql.exec(
          `INSERT INTO alert_buffer
             (device_id, event, accel_peak, omega_peak, signature, samples, do_ms, madgwick_json, tenant_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          deviceId,
          data.event ?? null, data.accel_peak ?? null, data.omega_peak ?? null,
          data.signature ?? null, JSON.stringify(samples), now,
          mResult ? JSON.stringify(mResult) : null,
          tenant
        );
        ws.send(JSON.stringify({ type: "ack", ref: "alert", doTs: now }));

        // Broadcast to dashboards — same shape as stored.
        this.broadcast({
          type: "alert",
          device_id: deviceId,
          event: data.event ?? null,
          accel_peak: data.accel_peak ?? null,
          omega_peak: data.omega_peak ?? null,
          signature: data.signature ?? null,
          madgwick_json: mResult,
          do_ms: now,
        });

        this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + 60_000));
        break;
      }

      case "echo_ack": {
        if (this.pendingEcho) {
          const deviceTs = (data.ts as number) || 0;
          this.pendingEcho.resolve({
            text: (data.text as string) || "",
            deviceTs,
            rttMs: Math.abs(Date.now() - (deviceTs || Date.now())),
          });
          this.pendingEcho = null;
        }
        break;
      }

      case "exec_ack": {
        if (this.pendingExec) {
          this.pendingExec.resolve({
            status: (data.status as string) || "error",
            error: data.error ?? null,
          });
          this.pendingExec = null;
        }
        break;
      }

      case "fs_ack": {
        if (this.pendingFsTest) {
          this.pendingFsTest.resolve({
            write: !!(data.write),
            read: !!(data.read),
            delete: !!(data.delete),
            error: (data.error as string) || null,
          });
          this.pendingFsTest = null;
        }
        break;
      }

      default:
        ws.send(JSON.stringify({ type: "error", message: `unknown type: ${data.type}` }));
    }
  }

  // ── alarm(): Generic D1 Flush — Cold Path ──────────────────────────────

  /**
   * Discovers buffer tables from _flush_registry at runtime.
   * Adding a new buffer table requires: constructor (CREATE TABLE + _registerBuffer)
   * and webSocketMessage (INSERT). The alarm never changes.
   *
   * Prototype pattern: try/catch per table, outer try/catch, finally { setAlarm }.
   */
  async alarm() {
    try {
      // Query _flush_registry for buffer→D1 mappings.
      // Fallback: if registry is empty (warm DO, constructor hasn't run
      // yet with new code), default to the known buffers. The constructor
      // populates the registry on cold start for future tables.
      let registry = this.ctx.storage.sql.exec(
        "SELECT local_table, d1_table FROM _flush_registry"
      ).toArray();
      if (registry.length === 0) {
        registry = [
          { local_table: "hello_log", d1_table: "hello_log" },
          { local_table: "telemetry_buffer", d1_table: "telemetry" },
          { local_table: "alert_buffer", d1_table: "alerts" },
        ] as any;
      }

      for (const entry of registry) {
        const localTable = entry.local_table as string;
        const d1Table = entry.d1_table as string;

        try {
          // Discover column names at runtime via PRAGMA.
          const colInfo = this.ctx.storage.sql.exec(
            `PRAGMA table_info(${localTable})`
          ).toArray();
          const cols = colInfo.map((c: any) => c.name as string);

          const rows = this.ctx.storage.sql.exec(
            `SELECT ${cols.join(", ")} FROM ${localTable}`
          ).toArray();

          if (rows.length === 0) continue;

          const placeholders = cols.map((_, i) => `?${i + 1}`).join(", ");
          const stmts = rows.map((row: any) =>
            this.env.DB.prepare(
              `INSERT INTO ${d1Table} (${cols.join(", ")}) VALUES (${placeholders})`
            ).bind(...cols.map((c) => row[c]))
          );

          await this.env.DB.batch(stmts);
          // UPSERT tables keep one row per device — no DELETE needed.
          // Exempt: telemetry_buffer (UPSERT, one row) and conversation_buffer
          // (sliding window, cap enforced on write). All other tables are
          // append-only and cleared after flush.
          if (localTable !== "telemetry_buffer" && localTable !== "conversation_buffer") {
            this.ctx.storage.sql.exec(`DELETE FROM ${localTable}`);
          }
        } catch (err) {
          console.error(`[CyberpiHub] ${localTable} flush failed, retaining rows:`, err);
        }
      }
      // ── D1 row-ceiling cleanup — keep telemetry under 20K rows ────
      try {
        const countRow = this.ctx.storage.sql.exec(
          "SELECT COUNT(*) as cnt FROM telemetry_buffer"
        ).toArray();
        // Estimate total D1 rows from buffer size + flush cadence.
        // Direct D1 COUNT would need an async query — we approximate.
        const bufferRows = (countRow[0]?.cnt as number) || 0;
        if (bufferRows === 0) {
          // When buffer is empty (just flushed), D1 was just written.
          // Run cleanup check every ~60 cycles (once per hour).
          const checkCycle = (this.ctx.storage.kv.get("cleanup_cycle") as number) || 0;
          this.ctx.storage.kv.put("cleanup_cycle", (checkCycle + 1) % 60);
          if (checkCycle === 0) {
            const d1Count = await this.env.DB.prepare(
              "SELECT COUNT(*) as cnt FROM telemetry"
            ).first();
            const total = (d1Count?.cnt as number) || 0;
            const CEILING = 20000;
            if (total > CEILING) {
              const excess = total - CEILING;
              await this.env.DB.prepare(
                "DELETE FROM telemetry WHERE id IN (SELECT id FROM telemetry ORDER BY id ASC LIMIT ?1)"
              ).bind(excess).run();
              console.log(`[CyberpiHub] D1 cleanup: deleted ${excess} oldest rows`);
            }
          }
        }
      } catch (err) {
        console.error("[CyberpiHub] D1 cleanup error:", err);
      }
      // ── Alert age cleanup — purge everything older than 1 day ────
      // Runs every alarm cycle (60s). Keeps buffer and D1 from growing
      // unbounded when the device is chatty and the alarm is alive.
      const oneDayAgoMs = Date.now() - 86_400_000;
      try {
        this.ctx.storage.sql.exec(
          "DELETE FROM alert_buffer WHERE do_ms < ?", oneDayAgoMs
        );
      } catch (err) {
        console.error("[CyberpiHub] alert_buffer age cleanup failed:", err);
      }
      try {
        await this.env.DB.prepare(
          "DELETE FROM alerts WHERE COALESCE(do_ms, created_at*1000) < ?1"
        ).bind(oneDayAgoMs).run();
      } catch (err) {
        console.error("[CyberpiHub] D1 alerts age cleanup failed:", err);
      }
      // Stamp successful flush — firmware reads this via last_flush_ms
      // in the state ack to detect dead alarms (stale stamp = no flush).
      this.ctx.storage.kv.put("last_flush_ms", Date.now());
    } catch (e) {
      console.error("[CyberpiHub] alarm outer error:", e);
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }

  // ── Broadcast Helper ──────────────────────────────────────────────────

  private broadcast(data: Record<string, unknown>) {
    const json = JSON.stringify(data);
    this.dashboards.forEach((_, ws) => {
      try { ws.send(json); } catch { this.dashboards.delete(ws); }
    });
  }

  // ── Roster Registration ───────────────────────────────────────────────

  /**
   * Fire-and-forget registration with the tenant's roster DO.
   * Called via waitUntil() from the hello handler — does not block the
   * hot path. Failures are logged but never surface to the device.
   */
  private async registerInRoster(deviceId: string, deviceType: string, tenant: string): Promise<void> {
    try {
      const rosterId = this.env.TENANT_ROSTER.idFromName(`${tenant}/roster`);
      const stub = this.env.TENANT_ROSTER.get(rosterId);
      const res = await stub.fetch("https://internal/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_id: deviceId, device_type: deviceType }),
      });
      if (!res.ok) {
        console.error(`[CyberpiHub] roster register failed: ${res.status}`);
      }
    } catch (err) {
      console.error("[CyberpiHub] roster registration error:", err);
    }
  }

  // ── webSocketClose / webSocketError ────────────────────────────────────

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean) {
    const meta = ws.deserializeAttachment() as Attachment | null;
    if (meta?.role === "cyberpi") this.deviceWs = null;
    else if (meta?.role === "dashboard") this.dashboards.delete(ws);
    ws.close(code, reason);
  }

  async webSocketError(ws: WebSocket, _error: unknown) {
    const meta = ws.deserializeAttachment() as Attachment | null;
    if (meta?.role === "cyberpi") this.deviceWs = null;
    else if (meta?.role === "dashboard") this.dashboards.delete(ws);
  }
}

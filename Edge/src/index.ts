/**
 * FunConnect v1 — Edge Worker
 *
 * Routes:
 *   /api/catalog              → GET list programs
 *   /api/catalog/:id          → GET download .py file
 *   /api/catalog/:id/meta     → GET program metadata
 *   /api/device/:id/status    → GET device online status (D1)
 *   /device/:deviceId         → WebSocket upgrade → CyberpiHub DO
 *   /api/device/:id/echo      → POST echo command → DO
 *   /api/device/:id/debug     → GET DO debug state
 *   /do-*                     → GET internal smoke-test queries
 *   /                         → GET health check
 */

import { CyberpiHub } from "./device-hub";
import type { Env } from "./device-hub";
import { TenantRoster } from "./roster";
import { CATALOG } from "./catalog-data";
import { SPA_HTML } from "./spa-data";
import { signToken, requireAuth } from "./auth";
import { chat, dashScope } from "./chat";
import { py2hex, validateScript } from "./py2hex";
import firmwareHex from "../firmware-microbit-universal.hex";
import firmwareDaplinkV1 from "../firmware-daplink-v1.hex";
import firmwareDaplinkV2Beta from "../firmware-daplink-v2-beta.hex";

export { CyberpiHub, TenantRoster };

// ── Helpers ────────────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

/** Extract tenant_id from JWT (decodes without verifying — routing only).
 *  Falls back to "admin" for unauthenticated/public routes. */
function getTenantId(request: Request): string {
  try {
    const auth = request.headers.get("Authorization");
    if (!auth?.startsWith("Bearer ")) return "admin";
    const payload = auth.slice(7).split(".")[1];
    const claims = JSON.parse(atob(payload));
    return claims.tenant_id || "admin";
  } catch {
    return "admin";
  }
}

/** SHA-256 hash via Web Crypto. Used for password verification. */
async function sha256(input: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── Device Discovery ────────────────────────────────────────────────

    // GET /api/devices — list recently active device_ids with live status
    if (path === "/api/devices" && request.method === "GET") {
      try {
        const tenantId = getTenantId(request);
        // Query D1 for distinct device_ids seen in the last 2 hours, tenant-scoped.
        const d1Result = await env.DB.prepare(
          `SELECT device_id, MAX(created_at) as last_seen, COUNT(*) as total
           FROM telemetry
           WHERE created_at > ?1 AND tenant_id = ?2
           GROUP BY device_id
           ORDER BY last_seen DESC
           LIMIT 20`
        ).bind(Math.floor(Date.now() / 1000) - 7200, tenantId).all();

        const devices: any[] = [];
        const seenIds = new Set<string>();

        for (const row of d1Result.results) {
          const deviceId = row.device_id as string;
          seenIds.add(deviceId);
          let online = false;
          try {
            const doId = env.CYBERPI_HUB.idFromName(`${tenantId}/${deviceId}`);
            const stub = env.CYBERPI_HUB.get(doId);
            const liveUrl = new URL(request.url);
            liveUrl.pathname = "/api/live-status";
            liveUrl.searchParams.set("device", deviceId);
            liveUrl.searchParams.set("tenant", tenantId);
            const liveRes = await stub.fetch(new Request(liveUrl.toString(), { method: "GET" }));
            const liveData = await liveRes.json() as any;
            online = liveData.online || false;
          } catch { /* DO unreachable */ }
          devices.push({
            device_id: deviceId,
            online,
            last_seen: row.last_seen as number,
            telemetry_count: row.total as number,
          });
        }

        // Fallback: check roster for devices not yet in D1 (newly registered,
        // alarm hasn't flushed yet). Roster is tenant-scoped by DO name.
        try {
          const rosterId = env.TENANT_ROSTER.idFromName(`${tenantId}/roster`);
          const rosterStub = env.TENANT_ROSTER.get(rosterId);
          const rosterUrl = new URL(request.url);
          rosterUrl.pathname = "/list";
          const rosterRes = await rosterStub.fetch(new Request(rosterUrl.toString()));
          const rosterData = await rosterRes.json() as { devices?: Array<{device_id: string; device_type: string}> };
          for (const d of (rosterData.devices || [])) {
            if (seenIds.has(d.device_id)) continue;
            let online = false;
            try {
              const doId = env.CYBERPI_HUB.idFromName(`${tenantId}/${d.device_id}`);
              const stub = env.CYBERPI_HUB.get(doId);
              const liveUrl = new URL(request.url);
              liveUrl.pathname = "/api/live-status";
              liveUrl.searchParams.set("device", d.device_id);
              liveUrl.searchParams.set("tenant", tenantId);
              const liveRes = await stub.fetch(new Request(liveUrl.toString(), { method: "GET" }));
              const liveData = await liveRes.json() as any;
              online = liveData.online || false;
            } catch { /* DO unreachable */ }
            if (online) {
              devices.unshift({
                device_id: d.device_id,
                device_type: d.device_type,
                online: true,
                last_seen: 0,
                telemetry_count: 0,
              });
            }
          }
        } catch { /* roster unreachable */ }

        return json(devices);
      } catch (err) {
        return json({ error: "query failed", message: String(err) }, 500);
      }
    }

    // ── Auth ──────────────────────────────────────────────────────────

    // POST /api/auth/login
    if (path === "/api/auth/login" && request.method === "POST") {
      try {
        const { username, password } = await request.json() as any;
        if (!username || !password) return json({ error: "username and password required" }, 400);
        const pwHash = await sha256(password);
        const user = await env.DB.prepare(
          "SELECT id, tenant_id, role, name FROM users WHERE name = ?1 AND password_hash = ?2"
        ).bind(username, pwHash).first() as any;
        if (!user) return json({ error: "invalid credentials" }, 401);
        const token = await signToken({ sub: user.name, tenant_id: user.tenant_id, role: user.role });
        return json({ token, user: { username: user.name, tenant_id: user.tenant_id, role: user.role } });
      } catch {
        return json({ error: "invalid json" }, 400);
      }
    }

    // GET /api/me — return current user from JWT
    if (path === "/api/me" && request.method === "GET") {
      try {
        const claims = await requireAuth(request);
        const user = await env.DB.prepare(
          "SELECT role FROM users WHERE name = ?1 AND tenant_id = ?2"
        ).bind(claims.sub, claims.tenant_id).first() as any;
        return json({
          username: claims.sub,
          tenant_id: claims.tenant_id,
          role: (user?.role as string) || "user",
        });
      } catch (err) {
        return json({ error: (err as Error).message }, 401);
      }
    }

    // ── Admin (auth required) ──────────────────────────────────────────

    // GET /api/admin/devices — all devices, auth required
    if (path === "/api/admin/devices" && request.method === "GET") {
      try {
        const claims = await requireAuth(request);
        const tenantId = claims.tenant_id;
        const d1Result = await env.DB.prepare(
          `SELECT device_id, MAX(created_at) as last_seen, COUNT(*) as total
           FROM telemetry WHERE created_at > ?1 AND tenant_id = ?2
           GROUP BY device_id ORDER BY last_seen DESC LIMIT 50`
        ).bind(Math.floor(Date.now() / 1000) - 7200, tenantId).all();

        const devices: any[] = [];
        const seenIds = new Set<string>();

        for (const row of d1Result.results) {
          const deviceId = row.device_id as string;
          seenIds.add(deviceId);
          let online = false;
          try {
            const doId = env.CYBERPI_HUB.idFromName(`${tenantId}/${deviceId}`);
            const stub = env.CYBERPI_HUB.get(doId);
            const liveUrl = new URL(request.url);
            liveUrl.pathname = "/api/live-status";
            liveUrl.searchParams.set("device", deviceId);
            liveUrl.searchParams.set("tenant", tenantId);
            const liveRes = await stub.fetch(new Request(liveUrl.toString(), { method: "GET" }));
            const liveData = await liveRes.json() as any;
            online = liveData.online || false;
          } catch { /* DO unreachable */ }
          devices.push({
            device_id: deviceId, online,
            last_seen: row.last_seen as number,
            telemetry_count: row.total as number,
          });
        }

        // Roster fallback for devices not yet in D1.
        try {
          const rosterId = env.TENANT_ROSTER.idFromName(`${tenantId}/roster`);
          const rosterStub = env.TENANT_ROSTER.get(rosterId);
          const rosterUrl = new URL(request.url);
          rosterUrl.pathname = "/list";
          const rosterRes = await rosterStub.fetch(new Request(rosterUrl.toString()));
          const rosterData = await rosterRes.json() as { devices?: Array<{device_id: string; device_type: string}> };
          for (const d of (rosterData.devices || [])) {
            if (seenIds.has(d.device_id)) continue;
            let online = false;
            try {
              const doId = env.CYBERPI_HUB.idFromName(`${tenantId}/${d.device_id}`);
              const stub = env.CYBERPI_HUB.get(doId);
              const liveUrl = new URL(request.url);
              liveUrl.pathname = "/api/live-status";
              liveUrl.searchParams.set("device", d.device_id);
              liveUrl.searchParams.set("tenant", tenantId);
              const liveRes = await stub.fetch(new Request(liveUrl.toString(), { method: "GET" }));
              const liveData = await liveRes.json() as any;
              online = liveData.online || false;
            } catch { /* DO unreachable */ }
            if (online) {
              devices.unshift({
                device_id: d.device_id,
                device_type: d.device_type,
                online: true,
                last_seen: 0,
                telemetry_count: 0,
              });
            }
          }
        } catch { /* roster unreachable */ }

        return json(devices);
      } catch (err) {
        const msg = (err as Error).message;
        if (msg === "missing token" || msg.includes("invalid") || msg.includes("expired")) {
          return json({ error: msg }, 401);
        }
        return json({ error: msg }, 500);
      }
    }

    // ── AI Chat ────────────────────────────────────────────────────────

    // POST /api/chat — natural-language query over Madgwick-enriched alerts
    if (path === "/api/chat" && request.method === "POST") {
      try {
        const tenantId = getTenantId(request);
        const body = await request.json() as { message?: string; device_id?: string; history?: Array<{role: string; content: string}>; focus?: { alert_id: number; signature?: number } };
        const { message, device_id, history, focus } = body;
        if (!message) return json({ error: "message required" }, 400);
        // Resolve device: explicit param > most-recently-active in D1.
        let deviceId = device_id || null;
        if (!deviceId) {
          const recent = await env.DB.prepare(
            "SELECT device_id FROM telemetry WHERE tenant_id = ?1 ORDER BY created_at DESC LIMIT 1"
          ).bind(tenantId).first() as any;
          deviceId = recent?.device_id || null;
        }
        if (!deviceId) return json({ reply: "No devices found for this tenant. Connect a device first.", context: [] });

        // Get a DO stub for this tenant+device — reused for three calls below.
        const doId = env.CYBERPI_HUB.idFromName(`${tenantId}/${deviceId}`);
        const stub = env.CYBERPI_HUB.get(doId);

        // 1. Read DO conversation buffer for multi-turn context.
        let conversationBuffer: Array<{role: string; content: string}> = [];
        try {
          const bufUrl = new URL(request.url);
          bufUrl.pathname = "/do-conversation-buffer";
          bufUrl.searchParams.set("device", deviceId);
          bufUrl.searchParams.set("tenant", tenantId);
          const bufRes = await stub.fetch(new Request(bufUrl.toString(), { method: "GET" }));
          if (bufRes.ok) conversationBuffer = ((await bufRes.json()) as { turns?: Array<{role: string; content: string}> }).turns ?? [];
        } catch { /* DO unreachable — fall back to history only */ }

        // 2. Read DO live alerts (existing pattern).
        let liveAlerts: unknown[] = [];
        try {
          const alertUrl = new URL(request.url);
          alertUrl.pathname = "/do-recent-alerts";
          alertUrl.searchParams.set("device", deviceId);
          alertUrl.searchParams.set("tenant", tenantId);
          const alertRes = await stub.fetch(new Request(alertUrl.toString(), { method: "GET" }));
          if (alertRes.ok) liveAlerts = ((await alertRes.json()) as { alerts?: unknown[] }).alerts ?? [];
        } catch { /* DO unreachable — fall back to D1 only */ }

        // 3. Chat with full multi-turn context.
        const provider = env.DASHSCOPE_KEY
          ? dashScope(env.DASHSCOPE_KEY, { model: "qwen3.7-plus" })
          : undefined;
        const result = await chat(message, env.DB, env.AI, {
          provider,
          autoThink: env.CHAT_THINKING === "on",
          deviceId,
          liveAlerts: liveAlerts as any,
          conversationBuffer,
          history,
          focus,
        });

        // 4. Fire-and-forget: append this turn to the DO buffer so the next
        //    follow-up has conversational grounding. Launched in background;
        //    student already sees the reply. Buffer loss is acceptable.
        const appendUrl = new URL(request.url);
        appendUrl.pathname = "/do-conversation-append";
        stub.fetch(new Request(appendUrl.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            device_id: deviceId,
            tenant_id: tenantId,
            turns: [
              { role: "user", content: message },
              { role: "assistant", content: result.reply },
            ],
          }),
        })).catch(() => {}); // silent — background, best-effort

        return json(result);
      } catch (err) {
        return json({ error: "chat failed", message: String(err) }, 500);
      }
    }

    // ── Catalog ────────────────────────────────────────────────────────

    // GET /api/catalog — list all programs
    if (path === "/api/catalog" && request.method === "GET") {
      const list = CATALOG.map(({ content, ...entry }) => entry);
      return json(list);
    }

    // GET /api/catalog/:id/meta — program metadata
    const metaMatch = path.match(/^\/api\/catalog\/(.+)\/meta$/);
    if (metaMatch && request.method === "GET") {
      const entry = CATALOG.find((e) => e.id === metaMatch[1]);
      if (!entry) return json({ error: "not found" }, 404);
      const { content, ...meta } = entry;
      return json(meta);
    }

    // GET /api/catalog/:id — download .py or compiled .hex
    const catalogMatch = path.match(/^\/api\/catalog\/(.+)$/);
    if (catalogMatch && request.method === "GET") {
      const entry = CATALOG.find((e) => e.id === catalogMatch[1]);
      if (!entry) return json({ error: "not found" }, 404);

      // .hex entries: compile .py → micro:bit .hex at request time.
      if (entry.format === ".hex") {
        const hex = py2hex(entry.content, firmwareHex);
        return new Response(hex, {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": `attachment; filename="${entry.id}.hex"`,
            "Access-Control-Allow-Origin": "*",
            "X-Build-Size": String(hex.length),
          },
        });
      }

      // .py entries: return source as before.
      return new Response(entry.content, {
        status: 200,
        headers: {
          "Content-Type": "text/x-python; charset=utf-8",
          "Content-Disposition": `attachment; filename="${entry.id}.py"`,
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // ── Device Status (D1) ─────────────────────────────────────────────

    // POST /api/build — compile MicroPython .py → micro:bit .hex
    if (path === "/api/build" && request.method === "POST") {
      try {
        const body = await request.json() as { script?: string; target?: string };
        const script = body.script || "";
        const target = body.target || "v2";

        if (target !== "v2") {
          return json({ error: "unsupported target", supported: ["v2"] }, 400);
        }

        const validation = validateScript(script);
        if (!validation.valid) {
          return json({ error: validation.error, size: validation.size }, 400);
        }

        const hex = py2hex(script, firmwareHex);

        return new Response(hex, {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": 'attachment; filename="script.hex"',
            "Access-Control-Allow-Origin": "*",
            "X-Build-Size": String(hex.length),
            "X-Script-Size": String(validation.size),
          },
        });
      } catch (err) {
        return json({ error: "build failed", message: String(err) }, 500);
      }
    }

    // ── DAPLink Firmware Updater ───────────────────────────────────────

    // GET /api/microbit/daplink-updater.hex — DAPLink interface firmware.
    // Flashing this updates the micro:bit's debug interface to fix
    // CMSIS-DAP buffer desync (DAPLink issue #17, affects v0249–v0257).
    // Target param: ?target=v1 (default) or ?target=v2 (v0258-beta3).
    if (path === "/api/microbit/daplink-updater.hex" && request.method === "GET") {
      const target = url.searchParams.get("target") || "v1";
      const hex = target === "v2" ? firmwareDaplinkV2Beta : firmwareDaplinkV1;
      return new Response(hex, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="daplink-updater-${target}.hex"`,
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // GET /api/microbit/relay.hex — micro:bit relay firmware (WebSerial bridge).
    // Beauty's saveHexToMicrobit fetches this; MSD/download fallback if missing.
    if (path === "/api/microbit/relay.hex" && request.method === "GET") {
      return new Response(firmwareHex, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="relay.hex"`,
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // ── Device Status (D1) ─────────────────────────────────────────────

    // GET /api/device/:id/status — live DO state + D1 history
    const statusMatch = path.match(/^\/api\/device\/(.+)\/status$/);
    if (statusMatch && request.method === "GET") {
      const deviceId = statusMatch[1];
      const tenantId = getTenantId(request);
      try {
        // Query D1 for historical count, tenant-scoped.
        const d1Result = await env.DB.prepare(
          "SELECT MAX(created_at) as last_seen, COUNT(*) as total FROM telemetry WHERE device_id = ?1 AND tenant_id = ?2"
        ).bind(deviceId, tenantId).first();
        const lastSeen = (d1Result?.last_seen as number) || 0;
        const total = (d1Result?.total as number) || 0;

        // Query DO for live WebSocket state — always accurate regardless of alarm.
        let online = false;
        let bufferTelemetry = 0;
        let bufferAlerts = 0;
        try {
          const doId = env.CYBERPI_HUB.idFromName(`${tenantId}/${deviceId}`);
          const stub = env.CYBERPI_HUB.get(doId);
          const liveUrl = new URL(request.url);
          liveUrl.pathname = "/api/live-status";
          liveUrl.searchParams.set("device", deviceId);
          liveUrl.searchParams.set("tenant", tenantId);
          const liveRes = await stub.fetch(new Request(liveUrl.toString(), { method: "GET" }));
          const liveData = await liveRes.json() as any;
          online = liveData.online || false;
          bufferTelemetry = liveData.buffer_telemetry || 0;
          bufferAlerts = liveData.buffer_alerts || 0;
        } catch { /* DO unreachable — leave online as false */ }

        return json({
          device_id: deviceId,
          online,
          last_seen_ms: lastSeen * 1000,
          telemetry_count: total + bufferTelemetry,
          alert_count: bufferAlerts,
        });
      } catch (err) {
        return json({ error: "query failed", message: String(err) }, 500);
      }
    }

    // ── DO-routed endpoints ────────────────────────────────────────────

    // GET /api/device-ids — list all device_ids in DO buffer
    if (path === "/api/device-ids" && request.method === "GET") {
      const deviceId = url.searchParams.get("device") || "1262112";
      const tenantId = getTenantId(request);
      const doId = env.CYBERPI_HUB.idFromName(`${tenantId}/${deviceId}`);
      const stub = env.CYBERPI_HUB.get(doId);
      const qUrl = new URL(request.url);
      qUrl.pathname = "/api/device-ids";
      qUrl.searchParams.set("tenant", tenantId);
      return stub.fetch(new Request(qUrl.toString(), { method: "GET" }));
    }

    // GET /api/device/:id/debug — DO debug state
    const debugMatch = path.match(/^\/api\/device\/(.+)\/debug$/);
    if (debugMatch && request.method === "GET") {
      const tenantId = getTenantId(request);
      const doId = env.CYBERPI_HUB.idFromName(`${tenantId}/${debugMatch[1]}`);
      const stub = env.CYBERPI_HUB.get(doId);
      const debugUrl = new URL(request.url);
      debugUrl.pathname = "/api/debug";
      debugUrl.searchParams.set("tenant", tenantId);
      return stub.fetch(new Request(debugUrl.toString(), { method: "GET" }));
    }

    // POST /api/device/:id/echo — echo command via DO
    const echoMatch = path.match(/^\/api\/device\/(.+)\/echo$/);
    if (echoMatch && request.method === "POST") {
      const tenantId = getTenantId(request);
      const doId = env.CYBERPI_HUB.idFromName(`${tenantId}/${echoMatch[1]}`);
      const stub = env.CYBERPI_HUB.get(doId);
      const relayUrl = new URL(request.url);
      relayUrl.pathname = "/api/echo";
      relayUrl.searchParams.set("tenant", tenantId);
      return stub.fetch(new Request(relayUrl.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(await request.json()),
      }));
    }

    // POST /api/device/:id/exec — run Python code on device
    const execMatch = path.match(/^\/api\/device\/(.+)\/exec$/);
    if (execMatch && request.method === "POST") {
      const tenantId = getTenantId(request);
      const doId = env.CYBERPI_HUB.idFromName(`${tenantId}/${execMatch[1]}`);
      const stub = env.CYBERPI_HUB.get(doId);
      const relayUrl = new URL(request.url);
      relayUrl.pathname = "/api/exec";
      relayUrl.searchParams.set("tenant", tenantId);
      return stub.fetch(new Request(relayUrl.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(await request.json()),
      }));
    }

    // POST /api/device/:id/fs-test — test filesystem on device
    const fsTestMatch = path.match(/^\/api\/device\/(.+)\/fs-test$/);
    if (fsTestMatch && request.method === "POST") {
      const tenantId = getTenantId(request);
      const doId = env.CYBERPI_HUB.idFromName(`${tenantId}/${fsTestMatch[1]}`);
      const stub = env.CYBERPI_HUB.get(doId);
      const relayUrl = new URL(request.url);
      relayUrl.pathname = "/api/fs-test";
      relayUrl.searchParams.set("tenant", tenantId);
      return stub.fetch(new Request(relayUrl.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }));
    }

    // /device/:deviceId → DO (WebSocket upgrade — CyberPi)
    const deviceMatch = path.match(/^\/device\/(.+)$/);
    if (deviceMatch) {
      const tenantId = getTenantId(request);
      const deviceId = deviceMatch[1];
      const doId = env.CYBERPI_HUB.idFromName(`${tenantId}/${deviceId}`);
      const stub = env.CYBERPI_HUB.get(doId);
      const wsUrl = new URL(request.url);
      wsUrl.searchParams.set("tenant", tenantId);
      return stub.fetch(new Request(wsUrl.toString(), request));
    }

    // /dashboard/:deviceId → DO (WebSocket upgrade — browser dashboard)
    const dashboardMatch = path.match(/^\/dashboard\/(.+)$/);
    if (dashboardMatch) {
      const tenantId = getTenantId(request);
      const deviceId = dashboardMatch[1];
      const doId = env.CYBERPI_HUB.idFromName(`${tenantId}/${deviceId}`);
      const stub = env.CYBERPI_HUB.get(doId);
      const wsUrl = new URL(request.url);
      wsUrl.searchParams.set("tenant", tenantId);
      return stub.fetch(new Request(wsUrl.toString(), request));
    }

    // /do-hello-count → DO
    if (path === "/do-hello-count" && request.method === "GET") {
      const deviceId = url.searchParams.get("device") || "cyberpi";
      const tenantId = url.searchParams.get("tenant") || getTenantId(request);
      const doId = env.CYBERPI_HUB.idFromName(`${tenantId}/${deviceId}`);
      const stub = env.CYBERPI_HUB.get(doId);
      const fwd = new URL(url.toString());
      fwd.searchParams.set("tenant", tenantId);
      return stub.fetch(new Request(fwd.toString(), { method: "GET" }));
    }

    // /do-telemetry-sample → DO
    if (path === "/do-telemetry-sample" && request.method === "GET") {
      const deviceId = url.searchParams.get("device") || "cyberpi";
      const tenantId = url.searchParams.get("tenant") || getTenantId(request);
      const doId = env.CYBERPI_HUB.idFromName(`${tenantId}/${deviceId}`);
      const stub = env.CYBERPI_HUB.get(doId);
      const fwd = new URL(url.toString());
      fwd.searchParams.set("tenant", tenantId);
      return stub.fetch(new Request(fwd.toString(), { method: "GET" }));
    }

    // /do-telemetry-count → DO
    if (path === "/do-telemetry-count" && request.method === "GET") {
      const deviceId = url.searchParams.get("device") || "cyberpi";
      const tenantId = url.searchParams.get("tenant") || getTenantId(request);
      const doId = env.CYBERPI_HUB.idFromName(`${tenantId}/${deviceId}`);
      const stub = env.CYBERPI_HUB.get(doId);
      const fwd = new URL(url.toString());
      fwd.searchParams.set("tenant", tenantId);
      return stub.fetch(new Request(fwd.toString(), { method: "GET" }));
    }

    // /do-alert-count → DO
    if (path === "/do-alert-count" && request.method === "GET") {
      const deviceId = url.searchParams.get("device") || "cyberpi";
      const tenantId = url.searchParams.get("tenant") || getTenantId(request);
      const doId = env.CYBERPI_HUB.idFromName(`${tenantId}/${deviceId}`);
      const stub = env.CYBERPI_HUB.get(doId);
      const fwd = new URL(url.toString());
      fwd.searchParams.set("tenant", tenantId);
      return stub.fetch(new Request(fwd.toString(), { method: "GET" }));
    }

    // ── Roster (auth required) ──────────────────────────────────────────

    // GET /api/roster/list — list registered devices for this tenant
    if (path === "/api/roster/list" && request.method === "GET") {
      try {
        const claims = await requireAuth(request);
        const rosterId = env.TENANT_ROSTER.idFromName(`${claims.tenant_id}/roster`);
        const stub = env.TENANT_ROSTER.get(rosterId);
        const rosterUrl = new URL(request.url);
        rosterUrl.pathname = "/list";
        return stub.fetch(new Request(rosterUrl.toString()));
      } catch (err) {
        return json({ error: (err as Error).message }, 401);
      }
    }

    // GET /api/roster/:deviceId — single device lookup
    const rosterDeviceMatch = path.match(/^\/api\/roster\/(.+)$/);
    if (rosterDeviceMatch && request.method === "GET") {
      try {
        const claims = await requireAuth(request);
        const rosterId = env.TENANT_ROSTER.idFromName(`${claims.tenant_id}/roster`);
        const stub = env.TENANT_ROSTER.get(rosterId);
        const rosterUrl = new URL(request.url);
        rosterUrl.pathname = `/${rosterDeviceMatch[1]}`;
        return stub.fetch(new Request(rosterUrl.toString()));
      } catch (err) {
        return json({ error: (err as Error).message }, 401);
      }
    }

    // ── Tenant Config ──────────────────────────────────────────────────

    // GET /api/tenant/config — tenant configuration
    if (path === "/api/tenant/config" && request.method === "GET") {
      try {
        const claims = await requireAuth(request);
        const config = await env.DB.prepare(
          "SELECT id, name, jurisdiction, billing_plan FROM tenants WHERE id = ?1"
        ).bind(claims.tenant_id).first();
        if (!config) return json({ error: "tenant not found" }, 404);
        return json(config);
      } catch (err) {
        return json({ error: (err as Error).message }, 401);
      }
    }

    // /api/health → health check JSON
    if (path === "/api/health") {
      return json({ status: "ok", service: "FunConnect v1", timestamp: Date.now() });
    }

    // GET /ws-test — diagnostic page: tests WSS + WebSerial
    if (path === "/ws-test" && request.method === "GET") {
      return new Response(`<!DOCTYPE html><html><body style="background:#0a0e14;color:#e8eef6;font:15px monospace;padding:20px">
<h2>Serial Relay Diagnostic</h2>
<button onclick="testWss()" style="padding:8px 16px;margin:4px">Test WSS Only</button>
<button onclick="testSerial()" style="padding:8px 16px;margin:4px">Test Serial + WSS</button>
<button onclick="testBareSerial()" style="padding:8px 16px;margin:4px">Test Serial Only</button>
<div id="log" style="margin-top:16px;line-height:1.6"></div>
<script>
const L=msg=>{document.getElementById('log').innerHTML+='<div>'+msg+'</div>'};
function testWss(){
L('--- Testing WSS only ---');
const ws=new WebSocket('wss://funconnect-v1.funconnect.workers.dev/device/cyberpi-relay');
ws.onopen=()=>{L('✅ WSS OPEN');ws.send(JSON.stringify({type:'hello',device_id:'cyberpi-relay',device_type:'cyberpi',ts:Date.now()}));};
ws.onmessage=e=>L('📩 '+e.data.substring(0,150));
ws.onerror=()=>L('❌ WSS ERROR');
ws.onclose=e=>L('🔴 WSS CLOSE '+e.code);
}
async function testSerial(){
L('--- Testing Serial + WSS ---');
try{
L('Step 1: requestPort...');
const port=await navigator.serial.requestPort();
L('Step 2: port selected: '+port.getInfo().usbVendorId);
L('Step 3: opening port at 115200...');
await port.open({baudRate:115200});
L('Step 4: port opened. Opening WSS...');
const ws=new WebSocket('wss://funconnect-v1.funconnect.workers.dev/device/cyberpi-relay');
ws.onopen=()=>{L('✅ WSS OPEN after serial');};
ws.onerror=()=>L('❌ WSS ERROR after serial');
ws.onclose=e=>L('🔴 WSS CLOSE '+e.code);
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=()=>reject(new Error('WSS failed after serial'));});
L('✅✅ BOTH CONNECTED!');
}catch(e){L('❌ FAILED: '+e.message+' | '+e.stack?.substring(0,200));}
}
async function testBareSerial(){
L('--- Testing Serial only ---');
try{L('requestPort...');
const port=await navigator.serial.requestPort();
L('port selected');
await port.open({baudRate:115200});
L('✅ Serial port opened at 115200');
const reader=port.readable.getReader();
const t=new TextDecoder();
let buf='';
for(let i=0;i<5;i++){
const {value,done}=await reader.read();
if(done)break;
buf+=t.decode(value);
const lines=buf.split('\\n');
buf=lines.pop();
if(lines.length)L('📟 '+lines[lines.length-1].substring(0,80));
}
reader.releaseLock();
await port.close();
L('✅ Serial test complete');
}catch(e){L('❌ Serial failed: '+e.message);}
}
</script></body></html>`, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // / → serve the SPA
    if (path === "/" && request.method === "GET") {
      return new Response(SPA_HTML, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          // SPA entry point changes on every deploy — never cache it, so
          // clients always get the latest build without a hard refresh.
          "Cache-Control": "no-store, must-revalidate",
        },
      });
    }

    return json({ error: "not found", path }, 404);
  },
};

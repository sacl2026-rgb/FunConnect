# FunConnect

**Device-to-cloud pipeline for classroom IoT.** Plug in a microcontroller, pick a program, flash it, and watch live sensor data — no MQTT broker, no Python bridge, no laptop relay.

**Live:** [funconnect-v1.funconnect.workers.dev](https://funconnect-v1.funconnect.workers.dev)

---

## What It Does

```
CyberPi -> ws:// (WiFi) --------------+
micro:bit V2 -> USB Serial -> Browser -+
micro:bit V1.5 -> WebHID flash --------+
CyberPi -> Web Serial esptool flash ---+
                                       v
                               Cloudflare Edge (TLS)
                                       v
                               Worker -> Durable Object (per-device)
                                        +-- SQLite hot buffer
                                        +-- Madgwick AHRS (~5ms)
                                        +-- Alarm flush -> D1 (cold, queryable)
                                        +-- WSS broadcast -> dashboards
```

One API token sees everything. One protocol. One deploy.

---

## Supported Devices

| Device | Flash Method | Live Telemetry | Dashboard |
|--------|-------------|----------------|-----------|
| **CyberPi** (ESP32) | Web Serial esptool or mBlock | WiFi WSS direct to cloud | IMU gauges, tilt, alerts, health |
| **micro:bit V2** (KL27Z) | WebHID zero-click or MSD save | USB Serial -> browser -> WSS relay | LED matrix, buttons, temp, accel |
| **micro:bit V1.5** (KL26Z) | WebHID or MSD save | MSD-only (CDC transmit-only) | Program running status |

---

## Quick Start

**Public Catalog (no login):** Go to [#catalog](https://funconnect-v1.funconnect.workers.dev/#catalog) — pick a device, choose a program, flash it. No account needed.

**Admin Dashboard:** Login at [#login](https://funconnect-v1.funconnect.workers.dev/#login) with `admin` / `admin123`. Manage devices, view live telemetry, deploy programs.

**Flash a Program:** Plug in your device, open the catalog, pick a program (10 available), click "Flash with FunConnect ->". First time: authorize USB in browser dialog. After that: one click.

---

## Project Structure

```
FunConnect/
+-- README.md              <-- This file
+-- AGENTS.md              <-- Multi-agent directive (read first)
+-- ALPHA.md               <-- Alpha session log (architecture decisions)
|
+-- Beauty/                <-- SPA (React, single-file HTML)
|   +-- BEAUTY.md          <-- Beauty charter + deploy procedure
|   +-- src/app.jsx        <-- SPA source
|   +-- src/relay.js       <-- WebSerial -> WSS relay
|   +-- src/webhid-flash.js<-- WebHID CMSIS-DAP zero-click flash
|   +-- src/cyberpi-serial-flash.js <-- esptool Web Serial flash
|   +-- spa/index.html     <-- Compiled single-file SPA
|
+-- Edge/                  <-- Cloudflare Worker backend
|   +-- EDGE.md            <-- Edge charter (34 sections)
|   +-- src/index.ts       <-- Worker fetch handler (34 routes)
|   +-- src/device-hub.ts  <-- CyberpiHub Durable Object
|   +-- src/catalog-data.ts<-- 10 program definitions
|   +-- src/py2hex.ts      <-- .py -> .hex compiler (MicroPython)
|   +-- src/madgwick.ts    <-- AHRS sensor fusion (adaptive beta)
|   +-- migrations/        <-- 9 D1 schema migration files
|
+-- Firmware/              <-- Device-side code
|   +-- FIRMWARE.md        <-- Firmware engineering log
|   +-- ws_client.py       <-- CyberPi production firmware (667 lines)
|   +-- microbit_relay.py  <-- micro:bit V2 serial relay client
|   +-- microbit_smoke/    <-- 8 incremental smoke tests (P1-P8)
|
+-- Researcher/            <-- Science layer
|   +-- RESEARCHER.md      <-- Researcher charter (14 sections)
|   +-- madgwick.ts        <-- Canonical AHRS implementation (217 lines)
|   +-- signature-analysis.md <-- 64-signature disturbance reference
|   +-- signature-map.json <-- Machine-readable export (v1.0.0)
|
+-- AI/                    <-- Language layer
    +-- AI.md              <-- Agent AI charter
    +-- chat.ts            <-- RAG chatbot (FTS5 corpus, Qwen 3.7)
    +-- multi-turn-design.md <-- Multi-turn conversation design
```

---

## Architecture

### Five-Layer Contract

| Layer | Owned By | What |
|--------|----------|------|
| **Transport** | Firmware + Edge | Device <-> DO via WSS + JSON wire protocol |
| **Storage** | Edge | DO-local SQLite -> D1 batch flush (alarm, 60s) |
| **Models** | Researcher | Madgwick AHRS, 64-signature classification |
| **Language** | Agent AI | RAG chatbot, FTS5 corpus search |
| **Interface** | Beauty | SPA — auth, catalog, dashboard, chat |

**Rule:** No layer reaches around the contract. Firmware doesn't touch D1. Beauty doesn't call Madgwick directly. AI doesn't bypass the DO.

### Wire Protocol

```
DEVICE -> DO:
  hello:  {"type":"hello","device_id":"mbot2-01","ts":<epoch_ms>}
  state:  {"type":"state","device_id":"...","telemetry":{...},"health":{...}}
  alert:  {"type":"alert","device_id":"...","event":"disturbance",...}

DO -> DEVICE:   welcome, sync, ack, error, echo, exec, fs_test
DO -> DASHBOARD: state, alert (with Madgwick JSON)
```

### Key REST Endpoints

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /api/catalog` | no | List 10 programs |
| `GET /api/catalog/:id` | no | Download .py or .hex |
| `POST /api/build` | no | Compile .py -> .hex (micro:bit) |
| `GET /api/devices` | no | Recently active devices |
| `GET /api/device/:id/status` | no | Device online + D1 history |
| `POST /api/chat` | no | RAG chatbot |
| `POST /api/auth/login` | no | admin/admin123 -> JWT |
| `WSS /device/:id` | -- | Device WebSocket upgrade |
| `WSS /dashboard/:id` | -- | Dashboard WebSocket upgrade |

Full API reference: [AGENTS.md](AGENTS.md) section 4.3, [EDGE.md](Edge/EDGE.md)

---

## Development

### Non-Negotiables (from AGENTS.md)

1. `ctx.acceptWebSocket(server)` — never `server.accept()` (hibernation)
2. Zero `await` in `webSocketMessage()` — sync SQLite only
3. Constructor restores from `getWebSockets()` + `deserializeAttachment()`
4. Alarm: `finally { setAlarm }` — always reschedule
5. Five-layer contract — no layer reaches around another
6. Resolve in code, not in the prompt
7. Incremental bisection — one capability per test
8. CPython-first protocol validation

### Agents

| Agent | Directory | Charter Doc |
|--------|-----------|-------------|
| **Alpha** | (root) | [ALPHA.md](ALPHA.md) — architecture, coordination |
| **Edge** | `Edge/` | [EDGE.md](Edge/EDGE.md) — Worker, DO, D1, routes |
| **Firmware** | `Firmware/` | [FIRMWARE.md](Firmware/FIRMWARE.md) — device code |
| **Beauty** | `Beauty/` | [BEAUTY.md](Beauty/BEAUTY.md) — SPA, UX |
| **Researcher** | `Researcher/` | [RESEARCHER.md](Researcher/RESEARCHER.md) — science, ML |
| **Agent AI** | `AI/` | [AI/AI.md](AI/AI.md) — chatbot, RAG |

Start with [AGENTS.md](AGENTS.md) for the multi-agent directive and inter-agent protocol.

---

## Live Infrastructure

| Resource | Name | Detail |
|----------|------|--------|
| **Worker** | `funconnect-v1` | 2.9MB bundle, deployed via API multipart |
| **Durable Object** | `CyberpiHub` | SQLite-backed, hibernation-ready, per-device |
| **Durable Object** | `TenantRoster` | Per-tenant device registry |
| **D1 Database** | `funconnect-v1-db` | 12.9MB, 84K telemetry rows, 74 FTS5 blocks |

---

## Proven Capabilities

- CyberPi WiFi WSS on port 80 (axTLS cipher gap, TLS at edge)
- CyberPi dual-state telemetry (STILL/ACTIVE, 4 Hz dashboard)
- CyberPi disturbance detection (25 Hz jerk gate, 75-sample alerts)
- CyberPi remote exec over WSS (echo, exec, fs_test)
- CyberPi esptool direct flash (sector 0x558000, CyberPiOS preserved)
- micro:bit V2 bidirectional serial relay (~184ms latency)
- micro:bit V1.5 WebHID CMSIS-DAP zero-click flash (~16s)
- micro:bit py2hex compiler (TypeScript, byte-identical to uflash 2.0.0)
- micro:bit DAPLink firmware updater
- Madgwick AHRS (adaptive beta, 6-class classification, ~5ms V8)
- 64-signature disturbance corpus (11 literature sources)
- FTS5 physics corpus search (74 blocks)
- RAG chatbot (Qwen 3.7, auto-thinking)
- JWT auth, multi-tenancy scaffolding
- Dark mode, accessibility, progressive offline timeline

---

## Recent Changes (2026-07-27)

- **Dark mode** — auto + manual toggle with persistence
- **Accessibility** — skip link, aria-live, role=alert, prefers-reduced-motion
- **SVG LED matrix** — concentric circles with feGaussianBlur glow filter
- **Declarative catalog actions** — per-device action arrays replacing nested ternaries
- **Progressive offline timeline** — connecting/waiting/timeout phases with elapsed counter
- **Skeleton loading** — shimmer animation during initial WebSocket connection
- **4 bug fixes** — MakeCode clipboard ordering, dashboard routing, transport routing, reconnect feedback

Full changelog: [git log](https://github.com/sacl2026-rgb/FunConnect/commits/master)

---

## Docs Index

Read these in order for a complete understanding:

1. **[AGENTS.md](AGENTS.md)** — Multi-agent directive, five-layer contract, wire protocol, non-negotiables, inter-agent communication. Start here.
2. **[ALPHA.md](ALPHA.md)** — Alpha's architecture decisions, session log, token verification, platform constraints, micro:bit breakthroughs.
3. **[Edge/EDGE.md](Edge/EDGE.md)** — Worker architecture (34 sections), D1 schema, deploy method, quota numbers, errors survived, py2hex design.
4. **[Beauty/BEAUTY.md](Beauty/BEAUTY.md)** — SPA charter, routing, API surface, flash overlays, deploy procedure, device profiles.
5. **[Firmware/FIRMWARE.md](Firmware/FIRMWARE.md)** — Device constraints, smoke test ladder, axTLS gap, micro:bit platform bugs, capability map.
6. **[Researcher/RESEARCHER.md](Researcher/RESEARCHER.md)** — Madgwick math (quaternions, adaptive beta), 64-signature analysis, simulation framework, ML pipeline.
7. **[AI/AI.md](AI/AI.md)** — Chatbot design, RAG pipeline, FTS5 corpus seeding, multi-turn contract, keyed reference lookup.

---

## License

Proprietary — classroom IoT research project.

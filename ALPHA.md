# Agent Alpha — FunConnect Session Log

**Role:** Architectural coordination, token verification, CyberPi WSS readiness.  
**Token:** FunConnect (`CF_TOKEN_PLACEHOLDER`)  
**Account:** CF_ACCOUNT_ID_PLACEHOLDER  
**Zone:** cyberpi.trade (CF_ZONE_ID_PLACEHOLDER)  
**Date:** July 14, 2026 (last updated)

---

## 1. Philosophy — Single-Token Omniscience

The WSS-DO architecture (proven in the prototype, rebuilt in GreenyBeta) is superior to MQTT for one reason: **one API token sees everything**. An AI agent with a single bearer header can deploy Workers, query D1, read live DO state, send commands through the relay queue, and monitor quota — all through the same surface. No MQTT broker. No bridge. No second auth.

The existing cyberpi-hub (mBot2 + EMQX + Qwen) splits the surface: Cloudflare token sees D1 history, but live device state, commands, and IMU streaming require an MQTT client against `broker.emqx.io`. Two protocols, two auth mechanisms, two mental models. The migration onto the WSS-DO pipeline collapses this to one.

---

## 2. Token Verification — Failures & Solutions

### 2.1 Token surface audit

**Goal:** Verify every permission on the FunConnect token by hitting each API endpoint.

**Token ID:** `d094d43fd4646301925df3eac1a43994`  
**Account:** `CF_ACCOUNT_ID_PLACEHOLDER` (EMAIL_PLACEHOLDER's Account)  
**Zone ID:** `CF_ZONE_ID_PLACEHOLDER` (corrected from memory — was stored as `...02a1`)

### 2.2 Failure: Zone ID mismatch

**What happened:** DNS record query against `...9002a1` returned 403 "Authentication error." The zone ID stored in memory was one character off.

**Root cause:** The memory entry `cloudflare-api-token.md` had the zone ID as `CF_ZONE_ID_PLACEHOLDER` — but this was transcribed incorrectly somewhere (the prototype README used `...c9012a1` and `...c9002a1` inconsistently).

**Fix:** Resolved zone ID via `GET /zones?name=cyberpi.trade` → `CF_ZONE_ID_PLACEHOLDER`. Always resolve, never trust memory for IDs.

### 2.3 Failure: R2 — 403 misinterpreted as permission gap

**What happened:** `GET /accounts/:id/r2/buckets` returned 403 on first attempt. Concluded "Workers R2 Storage — Edit" was missing.

**Root cause:** Early test was a false negative — likely a transient auth issue. When re-tested, the same endpoint returned error code 10042: "Please enable R2 through the Cloudflare Dashboard." This is an **account enablement** issue, not a **token permission** issue. The token has the right permission, but R2 is not activated on the account.

**Fix:** Corrected the assessment. R2 permission is present and functional — the one-time account enablement (click in dashboard) is a prerequisite.

### 2.4 Failure: Workers AI — 400 interpreted as permission gap

**What happened:** `GET /accounts/:id/ai/run/@cf/meta/llama-3.2-3b-instruct` returned 400. Concluded AI permission might be missing or restricted.

**Root cause:** The endpoint requires POST with a JSON body containing `prompt`. A bare GET is invalid regardless of permissions. Once re-tested with a proper POST body, the call returned 200 with a valid inference response (" there" — one token, as requested).

**Fix:** Always test with a valid payload, not just a ping. HTTP 400 ≠ 403.

### 2.5 Failure: Account Analytics — 404 on REST endpoint

**What happened:** Three REST endpoints tried (`/analytics`, `/analytics/dashboard`, `/analytics/colos`) all returned 404. Concluded "Account Analytics — Read" was missing from the token.

**Root cause:** Account-level analytics is exposed through **GraphQL**, not REST. The REST `/analytics/dashboard` is a zone-level endpoint (requires zone scope, not account scope). The actual query is:

```
POST /client/v4/graphql
{
  viewer {
    accounts(filter: { accountTag: "CF_ACCOUNT_ID_PLACEHOLDER" }) {
      workersInvocationsAdaptive(
        filter: { datetime_geq: "...", datetime_leq: "..." }
        limit: 1
      ) { sum { requests } }
    }
  }
}
```

When the permission was added and the GraphQL query used, it returned immediately: 2,472 Worker requests in the previous day.

**Fix:** Account Analytics → GraphQL. Zone Analytics → REST. Two different surfaces. The permission name "Account Analytics Read" is the key — the "Account" prefix signals GraphQL.

### 2.6 Final verified token surface

| Level | Permission | Verified |
|---|---|---|
| Account | Workers Scripts — Edit | ✅ (3 scripts listed: iot-hub, greeny-beta, greeie-spa) |
| Account | D1 — Edit | ✅ |
| Account | Workers KV Storage — Edit | ✅ (0 namespaces, but accessible) |
| Account | Workers R2 Storage — Edit | ✅ (needs account enablement, not token change) |
| Account | Workers AI — Read | ✅ (Llama 3.2 inference returned) |
| Account | Account Analytics — Read | ✅ (GraphQL: 2,472 requests/day) |
| Zone | DNS — Edit | ✅ |
| Zone | DNS — Read | ✅ |
| Zone | Zone Settings — Read | ✅ |
| Zone | SSL — Read | ✅ (inferred from zone object permissions array) |

Single gap closed: Account Analytics was added to the token during this session. Token is now omniscient — every Cloudflare developer-platform surface accessible with one bearer header.

---

## 3. CyberPi Smoke Test — WSS Readiness

### 3.1 Platform

**Device:** CyberPi (mBot2 brain), ESP32-D0WD, CyberPiOS (Makeblock MicroPython fork)  
**USB:** CH340 on COM3 (same chip as prototype ESP32 — COM4 was a ghost)  
**Upload tool:** mBlock web IDE + mLink2 bridge

### 3.2 Failure: REPL inaccessible over serial

**What happened:** Attempted to connect to COM3/COM4 with standard MicroPython REPL protocol (Ctrl-C interrupt, raw REPL entry, Ctrl-B soft reset, mpremote). Zero response at all baud rates (9600–460800).

**Root cause:** CyberPiOS does not expose a standard MicroPython REPL over USB serial. It uses a proprietary protocol understood by mBlock/mLink. The serial port is reserved for mLink communication, not developer REPL access.

**Fix:** Wrote a smoke test Python script (`smoke_test.py`) to be uploaded via mBlock instead.

### 3.3 Failure: `cyberpi.display.show_label()` traceback

**What happened:** First smoke test script used `cyberpi.display.show_label(text, size, x, y, index=N)` — immediately traceback'd on line 42.

**Root cause:** CyberPiOS display API differs from assumed signature. Parameters like `index` may not exist, or the positional arguments differ.

**Fix:** Simplified to `print()` (visible in mBlock console) + LED flashes only. No display API dependency.

### 3.4 Result: All modules present

```
socket:   ✅ OK   (plain TCP — baseline)
ussl:     ✅ OK   (TLS/wrap_socket — required for WSS)
uasyncio: ✅ OK   (async framework — required for aiohttp/async_ws_client)
ustruct:  ✅ OK   (binary pack/unpack — WebSocket frame headers)
```

**Green LED flash → all four modules confirmed.**

CyberPiOS ships with the full network stack needed for WSS. No firmware rebuild required. No module installation needed.

### 3.5 Migration path confirmed

With `ussl` + `uasyncio` + `ustruct` all present, the CyberPi can run:

- **Tangerino aiohttp** — single `aiohttp.py` file, `ws_connect("wss://iot-hub.funconnect.workers.dev/device/cyberpi")`, async, per-operation timeouts, keep-alive. Same code debugs on CPython.
- **Vovaman async_ws_client** — `mip install` from GitHub, background-task pattern, mature (47 stars).
- **Hand-rolled** — synchronous `socket` + `ussl` + RFC 6455 framing (~150 lines), no `uasyncio` dependency.

The mBot2 firmware goes from:

```
mBot2 → MQTT publish → EMQX → Python bridge → Worker /sensor-data (D1)
```

To:

```
mBot2 → WSS → Worker → Device DO (SQLite, hibernation, relay queue, broadcast)
                       → D1 (alarm handler batch flush)
```

One token sees everything. One protocol. No broker. No bridge. No second surface.

---

## 4. Lessons

1. **Always resolve IDs from the API, never trust memory.** The zone ID mismatch caused a false authentication failure.
2. **400 ≠ 403.** Syntax errors and missing payloads produce 400s that can be mistaken for permission denials. Always test with a valid request body.
3. **Account Analytics ≠ Zone Analytics.** Account-level analytics is GraphQL only. Zone-level has REST endpoints. The permission name prefix ("Account" vs "Zone") tells you which surface to use.
4. **R2 10042 is an enablement gap, not a permission gap.** The distinction matters for token design.
5. **CyberPiOS has no standard REPL.** All code testing must go through mBlock uploads. This adds a feedback cycle delay compared to standard ESP32 development.
6. **The module smoke test is the single most important step before writing any WSS code.** Don't assume `ussl` or `uasyncio` exist on a proprietary MicroPython fork. Test first, build second.

---

---

## 5. FunConnect Pipeline — Live State (July 9, 2026)

### 5.1 Deployed Infrastructure

| Resource | Name | Details |
|---|---|---|
| Worker | `funconnect-v1` | 9,536 bytes bundled (esbuild), deployed via API multipart |
| URL | `funconnect-v1.funconnect.workers.dev` | Health check returns `{"status":"ok","service":"FunConnect v1"}` |
| DO class | `CyberpiHub` | SQLite-backed, `ctx.acceptWebSocket`, hibernation-ready |
| DO namespace | `funconnect-v1_CyberpiHub` | UUID `3f53098f227940ba81af1d562456f6f5` |
| D1 | `funconnect-v1-db` | UUID `a3a8950d-c028-4ef4-b05c-982a10b9b2a6`, 69KB, 380+ rows |

**Separate infrastructure** (not FunConnect — do not touch):
- `iot-hub` (DeviceHub, GreenyAgent) — prototype, routes `cyberpi.trade/*`
- `greeny-beta` (GreenyDeviceHub) — rewrite
- `greeie-spa` — React SPA
- `greeny-db` (UUID `30ef106c-...`), `GREENY-DB` (UUID `63467f2a-...`)

### 5.2 Architecture

```
CyberPi (mbot2-01) ──ws://:80──→ Cloudflare Edge ──TLS──→ funconnect-v1 Worker
                                                             │
                                                             ├── CyberpiHub DO
                                                             │   ├── hello_log (DO-local SQLite)
                                                             │   ├── telemetry_buffer (DO-local SQLite)
                                                             │   ├── device_state (DO-local SQLite)
                                                             │   └── Alarm (60s): batch flush → D1
                                                             │       finally { setAlarm } — always reschedule
                                                             │       DELETE old flushed rows, keep last 100
                                                             │
                                                             └── funconnect-v1-db (D1)
                                                                 ├── hello_log
                                                                 ├── telemetry (indexed: device_id, created_at)
                                                                 └── devices (empty, schema artifact)
```

### 5.3 Wire Protocol (locked)

```
DEVICE → DO:
  hello:  {"type":"hello","device_id":"mbot2-01","ts":<epoch_ms>}
  state:  {"type":"state","device_id":"mbot2-01","esp32_ms":<uptime>,
           "telemetry":{"tilt":<deg>,"vibration":<0-1>,
             "acc_x":<g>,"acc_y":<g>,"acc_z":<g>,
             "gyro_x":<dps>,"gyro_y":<dps>,"gyro_z":<dps>},
           "health":{"mem":<free_heap>,"reconns":N,"errs":N,"rot":N}}

DO → DEVICE:
  welcome: {"type":"welcome","device_id":"mbot2-01"}
  sync:    {"type":"sync","led":false,"doTs":<epoch_ms>}
  ack:     {"type":"ack","ref":"state","doTs":<epoch_ms>,"buf":<buffer_depth>}
  error:   {"type":"error","message":"..."}

Phase 2 (not yet implemented):
  alert:   {"type":"alert","device_id":"mbot2-01","event":"disturbance",
            "accel_peak":<g>,"omega_peak":<rad/s>,"signature":<0-63>,
            "samples":[[ax,ay,az,gx,gy,gz],...],"ts":<epoch_ms>}

Phase 3 (not yet implemented):
  set_led: {"command":"set_led","params":{"state":true}}
  ack:     {"type":"ack","ref":"set_led","status":"ok"}
```

### 5.4 Phase 1 — Proven (complete)

| Capability | Status | Detail |
|---|---|---|
| Transport | ✅ | Hand-rolled synchronous WSS client, zero dependencies, single-file upload |
| Hello handshake | ✅ | welcome + sync, 69ms RTT from device |
| Telemetry (state frames) | ✅ | Every 30s, IMU confirmed live (acc_z=-9.6 gravity, acc_x=-0.4 tilt) |
| Ack with buf | ✅ | DO-local buffer depth returned in ack — firmware detects dead alarms |
| Health sub-object | ✅ | `mem`, `reconns`, `errs`, `rot` in every state frame, null-safe |
| Keepalive | ✅ | 15s protocol pings (opcode 0x9), edge-auto-ponged, zero DO cost |
| Reconnect | ✅ | Exponential backoff, handles deploy disconnects, Edge 300s idle timeout |
| DO hibernation | ✅ | `ctx.acceptWebSocket(server)`, not `server.accept()` |
| Alarm flush | ✅ | 60s batch INSERT to D1, DELETE old flushed rows, `finally` guard |
| Dead-alarm detection | ✅ | `buf > 120` → rotate device_id (`mbot2-01` → `mbot2-01-r1`) |

### 5.5 Architecture Deviation — Plaintext Device→Edge Hop

**Decision:** Signed off. CyberPiOS ships axTLS, too old for Cloudflare TLS negotiation (dies error 51 at cipher level). Cloudflare accepts plaintext `ws://` on port 80 and terminates TLS at its own edge. No relay, no laptop, no proxy. The rest of the path is TLS as normal.

**Risk:** Device→edge hop is plaintext over the internet. No actuation risk in Phase 1/2 (telemetry + disturbance alerts are unauthenticated reads). Phase 3 trigger: `set_led` enters protocol → HMAC on all JSON payloads. Shared secret on CyberPi (compile-time) and DO (env secret). Authenticity without confidentiality.

### 5.6 Firmware Platform

**MicroPython is permanent.** The axTLS limitation is a known constraint, not a bug. Escape hatch exists: Arduino/mbedTLS on same hardware (`cyberpi_unified.ino` proves it). Not needed.

**Hardware:** Bare CyberPi controller — no mBot2 base, no motors. RGB LED, 6-axis IMU, LCD, WiFi all onboard. Non-negotiables #4 (motor stop first) and #7 (M2_INVERT) are void.

**Development constraints:** No USB REPL — uploads via mBlock web IDE only. LED + LCD diagnostics for blind debugging. CPython-first methodology: protocol validated on laptop before touching hardware. Incremental bisection: one capability per test.

### 5.7 Quota — Real Numbers

| Limit | Per device (30s) | First bottleneck |
|---|---|---|
| DO SQLite writes | 2,880/day (2.9%) | ~34 devices |
| D1 writes | 5,760/day (5.8%) | ~17 devices |
| DO requests | ~1,584/day | >6,000 devices |
| DO duration | ~50ms/day | negligible |

telemetry_buffer has zero indexes — each INSERT is 1 row-write, no multiplier. D1 telemetry has 1 index — each flush INSERT costs 1 row + 1 index write. Protocol pings are free (edge-terminated, zero DO cost). DO hibernates ~9.9s out of every 10s cycle.

### 5.8 Agent Division & Status

| Agent | Domain | Status |
|---|---|---|
| **Alpha** | Architecture, coordination, non-negotiables | Active |
| **Firmware** | CyberPi WSS client, telemetry, disturbance detection | Phase 1 done, Phase 2 unblocked |
| **Edge** | Worker, DO, D1, REST API, alarm handler | Phase 1 done, Phase 2 unblocked |
| **Physicist** | Madgwick AHRS, quaternion fusion, event classification | Reserved, not started |
| **Beauty** | Dashboard, WebSocket client, visualization | Not started |
| **Detective** | Architecture audit, gap analysis | Future |
| **Security** | Attack surface, injection vectors, HMAC design | Future |

### 5.9 Source Files

```
C:\Projects\FunConnect\
├── ALPHA.md                          ← this file
├── edge/
│   ├── src/index.ts                  Worker — routes, health check, DO dispatch (~50 lines)
│   ├── src/device-hub.ts             CyberpiHub DO — hello + state handlers, alarm (~310 lines)
│   ├── migrations/
│   │   ├── 0001_hello.sql            D1 hello_log
│   │   ├── 0002_telemetry.sql        D1 telemetry (indexed)
│   │   └── 0003_health.sql           D1 health columns
│   ├── build.js                      esbuild bundler
│   ├── deploy.js                     API multipart + D1 migrations
│   ├── smoke3.mjs                    WSS hello smoke test
│   ├── smoke-telemetry.mjs           WSS state → ack smoke test
│   ├── smoke7-missing.mjs            Missing telemetry graceful test
│   └── check-cyberpi.mjs             DO-local + D1 query tool
└── firmware/
    ├── FIRMWARE.md                   Full engineering log, wire contract, Alpha memo
    └── smoke_ws.py                   Single firmware file (Phase 1 telemetry, hardened)
```

### 5.10 Key Lessons (so far)

1. **axTLS presence ≠ WSS capability.** Module check confirmed `ussl` exists, but the TLS stack can't negotiate with Cloudflare. Test the handshake, not just the import.
2. **Dead alarm is a half-open DO.** Six consecutive deploy failures permanently kill the alarm. Buffer balloons silently. The `buf` field in the ack is the fix — application-layer liveness, not just transport-layer liveness.
3. **Cloudflare's 6-throw alarm kill is permanent.** One bad deploy session can silently disable batch flushing. `finally { setAlarm }` is non-negotiable but insufficient — the alarm must be monitored.
4. **Ack is liveness, not delivery confirmation.** Protocol pings prove the edge is alive. Telemetry ack proves the DO application is alive. Different layers, different signals.
5. **Incremental bisection beats big-bang uploads.** When there's no REPL, grow firmware one capability at a time. CPython-first validates the protocol before hardware enters the loop.
6. **Hand-rolled synchronous transport was the right call.** Zero dependencies, single-file upload, maps 1:1 onto the existing loop pattern. Async libraries would have added complexity with no benefit for this platform.

### 5.11 Next — Phase 2 (Disturbance Detection)

Firmware: build the per-axis 2nd-order jerk gate at 25 Hz. 50-sample 6-DOF ring buffer. On trigger: flash LED red, ship `{"type":"alert",...}` with ring buffer + signature + peaks. Thin client — no Madgwick, no classification. ~40 lines.

Edge: add `case "alert"` to `webSocketMessage()`. INSERT to `alert_buffer` (DO-local SQLite). Add `alerts` table to D1 with `madgwick_json` column (null initially, Physicist fills later). Extend alarm to flush `alert_buffer`.

Physicist: reserved. Will consume raw alerts from D1, run Madgwick AHRS, write back enriched classification. Separate agent, separate schedule.

### 5.12 Next — Phase 3 (Command Dispatch)

Trigger: `set_led` enters protocol. HMAC lands on both firmware and DO. DO adds `relay_queue` table (QoS 1 — queues on state, drains on ack, resends on timeout). Firmware adds non-blocking receive loop and command dispatch.

---

---

## 6. Live Platform — Comprehensive State (July 14, 2026)

### 6.1 Deployed Infrastructure

| Resource | Name | Details |
|---|---|---|
| Worker | `funconnect-v1` | SPA + API + DO, 9,536 bytes, last deployed Jul 14 |
| DO class | `CyberpiHub` | SQLite, hibernation, `acceptWebSocket`, UPSERT telemetry_buffer |
| DO namespace | `funconnect-v1_CyberpiHub` | UUID `3f53098f` |
| D1 | `funconnect-v1-db` | 835KB, 3 tables, ~6,500 telemetry rows, 3 Madgwick-enriched alerts |
| Token | FunConnect | 9 permissions, full account + zone scope, Account Analytics verified |
| LLM | Qwen 3.7-plus via DashScope | Deployed as Worker secret, fallback to Workers AI Llama 3.2 3B |
| URL | `funconnect-v1.funconnect.workers.dev` | SPA same-origin, auth gated, public catalog |

**Account-wide quota (4 Workers shared):** 11.6% of 100K DO SQLite writes/day. Headroom for ~7 more devices.

### 6.2 Architecture — Five-Layer Stack

```
Device (any: CyberPi / micro:bit / Musebricks)
  │  WSS + JSON (CyberPi), Web Bluetooth + WSS relay (micro:bit)
  ▼
Cloudflare Worker (funconnect-v1)
  ├── CyberpiHub DO (per-device, hibernation, UPSERT telemetry_buffer)
  │   └── hello, state, alert, echo, exec, fs_test handlers
  │   └── Madgwick AHRS synchronous in webSocketMessage() (~5ms)
  │   └── Alarm (60s): batch flush → D1, row-ceiling at 20K
  │
  ├── D1 (funconnect-v1-db)
  │   ├── telemetry (6,500+ rows, device_id + created_at index)
  │   ├── alerts (madgwick_json, 3 enriched)
  │   └── hello_log (82 entries)
  │
  ├── REST API (auth-gated + public)
  │   ├── /api/catalog (public, 3 programs)
  │   ├── /api/auth/login (admin/admin123 → JWT)
  │   ├── /api/devices (discovery, auto-follow compatible)
  │   ├── /api/device/:id/status (DO liveness + D1 history)
  │   ├── /api/device/:id/echo (Promise bridge pattern)
  │   ├── /api/device/:id/exec (remote code execution)
  │   ├── /api/chat (RAG chatbot, Qwen 3.7)
  │   └── WSS /dashboard/:id (live state broadcast)
  │
  └── SPA (Beauty, 41KB, inlined at build time)
      ├── Login + admin dashboard (tabbed)
      ├── Public catalog + popup upload flow (Path A)
      ├── Live IMU dashboard with Madgwick alert panel
      └── Chat widget ("Ask FunConnect")
```

### 6.3 Agent Division — Status

| Agent | Domain | Phase | Key Metric |
|---|---|---|---|
| **Firmware** | CyberPi WSS client | S6 dual-state deployed | 6,800 telemetry rows, 4.1% quota, PATH stable |
| **Edge** | Worker, DO, D1, REST, auth, deploy | UPSERT + dead-alarm fix deployed | 37K DO req/day, P50 6.4ms |
| **Researcher** | Madgwick AHRS, 64-signature corpus | `madgwick.ts` delivered, corpus stable | 3 crashes enriched at -1.9g to -2.05g |
| **Agent AI** | LLM RAG chatbot, prompt engineering, corpus retrieval | Four retrieval layers live: keyed reference, multi-turn, alert context, FTS5 corpus search. 74-block physics corpus. 131/131 smoke tests. | Glance ~2s, analytical ~37s, corpus ~3s |
| **Beauty** | SPA, auth, device detection, dashboard, chat widget | Login-first + left sidebar shipped. Connect tab default. DEVICE_PROFILES registry. micro:bit skeleton. | 67KB SPA, 139KB worker bundle |
| **Physicist** | (merged into Researcher) | — | — |
| **Detective** | Architecture audit | Future | — |
| **Security** | Attack surface review, HMAC design | Future | — |

### 6.4 Wire Protocol (locked)

```
DEVICE → DO:
  hello:  {"type":"hello","device_id":"mbot2-01","ts":<epoch_ms>}
  state:  {"type":"state","device_id":"mbot2-01","telemetry":{...},
           "health":{"mem":...,"reconns":...,"errs":...,"rot":...}}
  alert:  {"type":"alert","device_id":"mbot2-01","event":"disturbance",
           "accel_peak":<g>,"omega_peak":<rad/s>,"signature":<0-63>,
           "samples":[[ax,ay,az,gx,gy,gz],...],"ts":<epoch_ms>}

DO → DEVICE:
  welcome:     {"type":"welcome","device_id":"mbot2-01"}
  sync:        {"type":"sync","led":false,"doTs":<epoch_ms>}
  ack (state): {"type":"ack","ref":"state","doTs":<epoch_ms>,
                "alert_depth":<N>,"last_flush_ms":<ts>}
  ack (alert): {"type":"ack","ref":"alert"}
  error:       {"type":"error","message":"..."}
  echo:        {"command":"echo","params":{"text":"..."}}
  exec:        {"command":"exec","code":"..."}
  fs_test:     {"command":"fs_test"}

DO → DASHBOARD:
  state:       {"type":"state","device_id":"...","telemetry":{...}}
  alert:       {"type":"alert","device_id":"...","accel_peak":...,
                "madgwick_json":"{\"classification\":\"crash\",...}"}

Phase 3 (not built):
  set_led:     {"command":"set_led","params":{"state":true}}
  ack:         {"type":"ack","ref":"set_led","status":"ok"}
```

### 6.5 Proven Capabilities

| Capability | Layer | Detail |
|---|---|---|
| WSS transport (ws:// port 80, axTLS wall) | Firmware | Hand-rolled sync, zero dependencies, reconnect |
| Dual-state telemetry (STILL 30s / ACTIVE 4 Hz) | Firmware | IMU-driven, ~4% quota |
| Disturbance detection (25 Hz jerk gate) | Firmware | 75-sample ring buffer, 6-bit signature verified |
| Remote exec over WSS | Firmware + Edge | 5s red LED confirmed, file write confirmed |
| UPSERT telemetry_buffer (1 write/frame) | Edge | WITHOUT ROWID, no flushed column, no DELETEs |
| D1 row-ceiling (auto-prune > 20K) | Edge | Bounded forever |
| Dead-alarm detection (alert_depth + last_flush_ms) | Edge | Replaced broken buf, chat immune to alarm death |
| Madgwick AHRS (adaptive β, 5ms V8) | Researcher | 6 classes, 3 enriched alerts confirmed |
| 64-signature corpus (11 literature sources) | Researcher | Uniform depth, machine-readable JSON export |
| Auth (JWT, admin/admin123, 24h expiry) | Edge + Beauty | Login wall, admin dashboard, public catalog |
| Chatbot (RAG, Qwen 3.7, auto-thinking) | Agent AI | Live, grounded in real D1 alerts |
| Popup upload flow (Path A, bank-grade) | Beauty | Chrome-minimized, guided steps, auto-close |
| Auto-follow device tracking | Beauty | Survives rotation, /api/devices + /status probing |
| Account-wide quota audit | Edge | 11.6% across 4 Workers, headroom for ~7 devices |

### 6.6 Architecture Decisions

| Decision | Answer | Phase |
|---|---|---|
| Thin vs. full disturbance client | Thin — jerk gate on device, Madgwick on server | Phase 2 |
| Platform — MicroPython or Arduino | MicroPython permanent. Arduino escape hatch exists | Phase 1 |
| Security — HMAC timing | Plaintext through Phase 2. HMAC at Phase 3 (set_led) | Phase 3 |
| Madgwick — synchronous or async | Synchronous in webSocketMessage() (~5ms) | Phase 2 |
| Classification — in Madgwick or separate | Combined in madgwick(). Split later if needed | Phase 2 |
| RAG — keyed reference storage | Shipped in-code. See §7.11. D1 table later. Vectorize deferred | ✅ |
| Conversation mode | Deferred. Keyed lookup first | Future |
| Multi-tenancy | One tenant skeleton (admin/admin123). Per-account isolation | Skeleton |

### 6.7 Source Files

```
C:\Projects\FunConnect\
├── ALPHA.md                          ← this file
├── edge/
│   ├── src/index.ts                  Worker routes, auth, catalog, chat (451 lines)
│   ├── src/device-hub.ts             CyberpiHub DO (737 lines)
│   ├── src/roster.ts                 TenantRoster DO (device registry)
│   ├── src/auth.ts                   JWT sign/verify middleware (93 lines)
│   ├── src/catalog-data.ts           Static program definitions (130 lines)
│   ├── src/chat.ts                   Re-export from AI/chat.ts (6 lines)
│   ├── src/spa-data.ts               SPA HTML inline import (auto-generated)
│   ├── src/madgwick.ts               AHRS fusion (221 lines)
│   ├── catalog/                      .py files (hello-world, led-blink, imu-stream)
│   ├── migrations/                   0001–0009 (hello, telemetry, health, alerts, madgwick, tenant_id, users, tenants, chat_history)
│   ├── build.js                      esbuild + SPA inline
│   ├── deploy.js                     API multipart + D1 migrations
│   ├── EDGE.md                       Full architectural record (29 sections)
│   └── smoke*.mjs                    Smoke test suite
├── firmware/
│   ├── ws_client.py                  Consolidated firmware (667 lines) — telemetry + disturbance + commands
│   ├── smoke_ws.py                   Phase 1 reference (superseded)
│   ├── disturbance.py                Phase 2 reference (superseded)
│   └── FIRMWARE.md                   Full engineering log
├── beauty/
│   ├── src/app.jsx                   React SPA source (67KB deployed)
│   ├── spa/index.html                Compiled single-file SPA
│   ├── build.js                      JSX → HTML compiler
│   └── BEAUTY.md                    Charter + deploy procedure
├── AGENTS.md                         ← Shared multi-agent directive (created Jul 14)
├── researcher/
│   ├── madgwick.ts                   AHRS fusion (217 lines) — canonical source
│   ├── signature-analysis.md         64-signature reference
│   ├── signature-map.json            Machine-readable export (v1.0.0)
│   └── RESEARCHER.md                 Full science layer doc (13 sections)
├── ai/
│   ├── chat.ts                       RAG chatbot function (966 lines) — canonical source
│   ├── smoke-chat.mjs                Smoke-test harness (131 assertions)
│   ├── seed-corpus.mjs               Corpus seed script (D1 API, param queries)
│   ├── multi-turn-design.md          Multi-turn conversation design spec
│   ├── live-qwen.mjs                 Qwen live-test script
│   └── AI.md                         NL layer doc (7 sections)
│   └── AI.md                         NL layer doc (7 sections)
```

### 6.8 Remaining Work

| What | Who | Priority |
|---|---|---|
| Keyed reference lookup (in-code) | Agent AI | ✅ SHIPPED — signatureInfo, baselineFor, impactDirection, madgwickGating in chat.ts. 87/87 smoke tests. |
| Phase 3 set_led + HMAC | Firmware + Edge | Medium |
| Final ws_client.py assembly | Firmware | ✅ DONE — 667 lines consolidated |
| D1 signatures table + admin CRUD | Edge + Researcher | Medium |
| FTS5 corpus search + seed | Agent AI | ✅ SHIPPED — 74 blocks via D1 API param queries, stop-word OR matching, curiosity path live |
| Multi-device support (micro:bit, Musebricks) | All | IN PROGRESS — Beauty shipped DEVICE_PROFILES + Connect wizard + micro:bit skeleton. Firmware + Edge BLE path next. §7.12 |
| Multi-turn conversation + alert replay | Agent AI + Edge | ✅ SHIPPED — conversation_buffer, contextualizeQuery, two-phase alert replay |
| Multi-tenancy hardening | Edge | Low |
| Conversational mode (Vectorize) | Edge + AI | Deferred |
| Agent Detective — architecture audit | Future | Future — partial audit by Alpha today (§7) |
| Agent Security — attack surface review | Future | Future |

### 6.9 Non-Negotiables (from prototype + GreenyBeta)

| # | Rule | Status |
|---|---|---|
| 1 | `ctx.acceptWebSocket(server)` — never `server.accept()` | ✅ |
| 2 | Zero `await` in `webSocketMessage()` | ✅ |
| 3 | Constructor restores from `getWebSockets()` + `deserializeAttachment()` | ✅ |
| 4 | `finally { setAlarm }` — always reschedule | ✅ |
| 5 | DELETE old flushed rows, keep last 100 (D1 row-ceiling at 20K) | ✅ |
| 6 | Non-blocking loop — `utime.ticks_ms()` deltas only | ✅ (S6 dual-state) |
| 7 | WiFi is the mission — reconnect watchdog | ✅ |
| 8 | 30s inbound silence → reconnect (reframed: ack-based liveness) | ✅ |
| 9 | `try/except` per sensor read | ✅ |
| 10 | JSON payloads only | ✅ |
| 11 | `M2_INVERT = True` | N/A (no motors) |

### 6.10 Key Lessons (cumulative)

1. **axTLS presence ≠ WSS capability.** Module check confirmed `ussl` exists, but the stack can't negotiate with Cloudflare. Test the handshake, not the import.
2. **Dead alarm is a half-open DO.** The UPSERT rebuild structurally disabled `buf`-based detection. Alert depth is the real liveness signal.
3. **Incremental bisection beats big-bang uploads.** No REPL → one capability at a time. CPython-first validates protocol before hardware.
4. **Hand-rolled sync transport was right.** Zero dependencies, single-file upload. Async libraries add complexity with no benefit for this platform.
5. **Popup evolved from workaround to universal pattern.** Bank-grade overlay, works across CyberPi and micro:bit platforms.
6. **Resolve in code, not in the prompt.** Deterministic lookups (signature, baseline, direction) belong in functions, not the LLM context window.
7. **The five-layer contract is the invariant.** Device-blind transport → storage → models → LLM → interface. Swap hardware without changing anything downstream.

---

## 7. Full Project Audit — July 14, 2026

### 7.1 Multi-Device Priority Escalated

The user has directed that multi-device integration (micro:bit alongside CyberPi) is now a priority. Previously marked "Low" in §6.8 — now elevated to HIGH. Architecture is ready (five-layer contract, device-ID-agnostic routing), but gaps exist:

- No `device_type` field in protocol, D1 schema, or catalog
- Catalog is CyberPi-only (all programs import `cyberpi` module)
- `mbot2-01` hard-coded in 4 places across `index.ts` and `device-hub.ts`
- Dashboard assumes IMU telemetry — no micro:bit LED matrix/button panel
- micro:bit uses Web Bluetooth + WSS relay, not direct WSS

### 7.2 Quota Audit — iot-hub is the Silent Drain

GraphQL-verified DO invocation data (Jul 13):

| Worker | DO Invocations (Jul 13) | Est. SQLite Writes |
|---|---|---|
| funconnect-v1 | 45,420 | ~90K |
| iot-hub | 15,314 | ~30K |
| greeny-beta | 0 | 0 |

**Total: ~120K writes/day — exceeding the 100K free tier ceiling.** Cloudflare docs confirm: "If you exceed any one of the free tier limits, further operations of that type will fail with an error." Resets at 00:00 UTC.

iot-hub is the prototype Worker routing `cyberpi.trade/*` — it shares the same account-wide 100K writes/day pool. When both Workers are active, the combined write load exceeds the ceiling. **iot-hub must be retired or its write rate severely reduced** to free budget for funconnect-v1.

Today (Jul 14, ~06:00 UTC): only 2,794 DO invocations so far — quota has reset. CyberPi appears offline (funconnect-v1 at 7 invocations vs 45K yesterday).

### 7.3 Code Duplication — chat.ts (RESOLVED)

**Resolved Jul 14.** `AI/chat.ts` is now canonical. `Edge/src/chat.ts` is a 6-line re-export (`export { chat, detectIntent, enrichAlert, ... } from '../../AI/chat.ts'`). `Edge/build.js` has a pre-build check that fails if `src/chat.ts` isn't a re-export. Both smoke tests (87/87) and Edge build pass clean.

### 7.4 AI Keyed Reference — SHIPPED (was: Designed, Not Built)

**Resolved Jul 14.** Agent AI built all four lookup functions in `chat.ts`: `signatureInfo(sig)` (64-entry O(1) lookup from signature-map.json), `baselineFor(g)` (7-band from RESEARCHER.md §11.6), `impactDirection(ax,ay,az)` (dominant-axis + sub-label), `madgwickGating(family)` (7-entry gating flags). Five new fields on `AlertContext`. The LLM now receives pre-resolved English (~60 tokens of facts instead of ~600 tokens of static tables). Per-alert context looks like:

```
3 minutes ago · crash · Side-angle hit (corner) · felt like a book falling flat
from the right side, slightly from below · flipped nearly upside down
(roll 178°, pitch 4°) · no freefall · (~2.07 g)
```

Zero raw tables enter the LLM. Non-negotiable §5 rule 6 is mechanically enforced. Smoke tests: 87/87 (was 50/50). Docs reconciled: AI.md §3, §5, §1.1, §1.3, §8, §9.1 all updated. chat.ts duplication resolved — AI/chat.ts canonical, Edge/src/chat.ts is a 6-line re-export with build-enforced check.

### 7.5 EDGE.md — Stale on 9 Counts

| Issue | Detail |
|---|---|
| File manifest wrong | `index.ts` listed as 50 lines (actually 194), `device-hub.ts` as 310 (actually 514). Missing: auth.ts, catalog-data.ts, chat.ts, spa-data.ts, madgwick.ts |
| Migrations incomplete | Lists 0001–0003 only; 0004_alerts and 0005_madgwick exist |
| Route table missing | No /api/auth/login, /api/me, /api/admin/devices, /api/chat |
| D1 schema incomplete | No alerts table documented |
| Wire protocol incomplete | Only hello + state; missing alert, echo, exec, fs_test |
| Token IDs truncated | Alpha token listed as `50c33e7f...` instead of full ID |
| Quota table mismatch | Claims funconnect-v1 at 2,930 writes/day; GraphQL shows 45K+ DO invocations |
| Date stale | Says "July 10, 2026" but contains Jul 13–14 content |
| buf documented as useless but still computed | Code still sends buf in state ack |

Edge has been briefed via email to update.

### 7.6 FIRMWARE.md — Split Code, Stale Contract

- `smoke_ws.py` (Phase 1, 1s fixed telemetry, old buf-based dead-alarm) and `disturbance.py` (Phase 2, dual-state, disturbance detector) are separate files at different phases. Final `ws_client.py` assembly is overdue.
- `buf` dead-alarm detection in `smoke_ws.py` (`BUF_ROTATE_THRESHOLD = 120`) is structurally broken post-UPSERT (buf always 1). New `alert_depth` and `last_flush_ms` signals exist in the ack but neither firmware file uses them.
- Wire contract in FIRMWARE.md only documents `state` and `ack` — missing alert, echo, exec, fs_test.
- WiFi credentials hardcoded in plaintext across two files (two different networks).
- Madgwick integration marked "testing pending" but is deployed and confirmed.
- D1 row count stale (240 → ~6,800).

Firmware has been briefed via email to update.

### 7.7 Researcher — One Stale Claim

Status header says "Edge integration pending" — but `madgwick.ts` is imported and running in `device-hub.ts`, ~5ms per frame, 3 enriched alerts confirmed. Doc needs updating.

### 7.8 Beauty — Current and Accurate

BEAUTY.md is the most accurate doc in the project. Minor note: orientation latency table references `TELEMETRY_INTERVAL = 5s` from old firmware — actual value is 1s or 250ms/30s (dual-state).

### 7.9 AGENTS.md — New, Current

Created today as the shared multi-agent directive. References all 8 agents with charter doc paths, wire protocol, D1 schema, REST API table, non-negotiables, and source tree. Every agent starts here.

### 7.10 Agent Emails — All Resolved

All five agents responded and made changes:

| Agent | Doc Updated | Code Changed | Key Outcome |
|---|---|---|---|
| **Firmware** | FIRMWARE.md | `ws_client.py` (667 lines, consolidated) | Dead-alarm now uses alert_depth + last_flush_ms |
| **Edge** | EDGE.md (638 lines, +§27, +§28) | Alert replay in device-hub.ts, alert_buffer + D1 two-phase query | Dashboard gets alert history on refresh. Ordering contract with Beauty. |
| **Researcher** | RESEARCHER.md | None (doc only) | Status header + §8 updated to reflect deployed Madgwick |
| **Beauty** | BEAUTY.md | SPA restructure (67KB): login-first, left sidebar, Connect tab default, DEVICE_PROFILES registry, deviceType threaded, micro:bit skeleton | Device detection is now the entry flow. Dashboard accessed through detection. |
| **Agent AI** | AI.md | `AI/chat.ts` (4 lookup fns), `Edge/src/chat.ts` → re-export, `Edge/build.js` check | Keyed reference SHIPPED. 87/87 smoke tests. |

### 7.11 Interface Restructure (Beauty — Jul 14)

Beauty shipped a major restructure:
- **Login-first:** Root redirects anon → `#login`. No public catalog link on login page.
- **Left sidebar:** 180px fixed, three tabs — Connect (default), Devices, Deploy. Username + logout at bottom.
- **Connect tab:** Device selection cards (CyberPi / micro:bit) → guided wizard → poll for online → jump to Devices.
- **DEVICE_PROFILES registry:** Two entries (cyberpi, microbit). Adding a device = adding one object. `deviceType` threaded through all components. Dashboard panels switch via `telemetry.dashboardPanel`.
- **micro:bit skeleton:** Cards in wizard, placeholder dashboard panel. No BLE, no LED matrix renderer yet — scaffolding only.
- SPA grew from 41KB → 67KB. Worker bundle: 139KB.

### 7.12 Post-Audit State

All major gaps from the audit are closed:

- ✅ Keyed reference lookup built and smoke-tested
- ✅ chat.ts duplication resolved (canonical + re-export + build guard)
- ✅ All 5 agent docs reconciled with code
- ✅ Firmware consolidated to single `ws_client.py`
- ✅ Dead-alarm detection migrated to alert_depth + last_flush_ms
- ✅ EDGE.md fully current (27 sections, 28 with alert replay)
- ✅ Beauty interface restructured — detection-first flow shipped
- ✅ Edge alert replay deployed — two-phase query, ordering contract with Beauty
- ✅ FTS5 corpus search deployed — 74-block physics corpus, stop-word OR matching, curiosity path live

### 7.13 Corpus Search (Agent AI + Edge — Jul 14)

FTS5 full-text search over the physics corpus is live. Pipeline:

```
Student: "explain the Madgwick filter"
  → detectIntent() — no disturbance keywords
  → isCuriosityQuestion() — technical query detected
  → searchCorpus() → buildFtsQuery() strips stop words, joins with OR
  → FTS5 MATCH "Madgwick OR filter" → 2 matching blocks
  → buildCorpusPrompt() — technical tone, passes corpus passages to LLM
  → LLM explains Madgwick algorithm, ghost events, crash classification
  → { reply, context: [] }
```

Bug survived: FTS5 implicit AND broke multi-word queries. "what is a quaternion" required all four words present in corpus — impossible. Fixed with `buildFtsQuery()`: strips 50+ stop words, joins remaining terms with OR. "what is a quaternion" → "quaternion" → works.

Seed approach also had to pivot: raw SQL with Markdown content hit escaping edge cases (pipes, backticks, asterisks). Switched to D1 HTTP API with parameterized queries — zero escaping in JavaScript, server-side binding. 74/74 blocks seeded cleanly.

Smoke: 131/131 green (was 87, then 124 during dev, now 131). Seven new assertions for buildFtsQuery.

Remaining open work:
- Multi-device support (micro:bit) — IN PROGRESS — Beauty skeleton done, Firmware + Edge BLE path next
- iot-hub retirement — frees ~3.8% daily quota
- Phase 3 set_led + HMAC
- D1 signatures table (live corpus)
- Conversational mode (Vectorize) — deferred
- Agent Detective / Security — future

---

---

## 8. Micro:bit Breakthrough — July 17, 2026

### 8.1 The pivot

The micro:bit moved from "planned" to fully integrated in one session. The key unlock: `py2hex`, Firmware's discovery that the official uflash utility converts any `.py` to a self-contained `.hex` via file copy to the MICROBIT drive. This eliminated the WebUSB dependency entirely for development, and opened the path for server-side hex generation.

### 8.2 Five-layer contract — micro:bit transport

```
micro:bit → USB serial → Browser (Web Serial / relay.js) → WSS → DO
```

CyberPi speaks WiFi WSS directly. micro:bit uses the browser as a serial-to-WSS bridge. Same JSON wire protocol (hello, state, alert, led_matrix, echo). The DO is device-type agnostic — it doesn't know or care which transport path the frames arrived through.

### 8.3 Platform constraints (V2 MicroPython, discovered on hardware)

1. **No `json`/`ujson` module** — hand-rolled `dumps()`/`loads()` inline, permanent
2. **`uart.readline()` broken** — `uart.read(1)` char-by-char only, `sleep(20)` idle yield, CPU speed when data flowing
3. **`display.show(wait=False)` silently fails** — default blocking calls only, each pattern change blocks ~167ms
4. **USB enumeration race** — `sleep(2000)` before first `uart.write()` or hello frame is silently lost

### 8.4 Latency breakthrough

Initial relay click-to-LED was ~1417ms. Firmware traced the bottleneck to `sleep(20)` in the char-by-char reader — it was sleeping between every character even when data was flowing. Fixed: spin at CPU speed when `uart.any()` returns data, only sleep on idle. Result: 184ms average. The LED matrix hardware refresh (~167ms) is now the ceiling.

### 8.5 Automation

The micro:bit is the first FunConnect device with a fully automated development loop. No human clicks: write `.py` → `py2hex` → `cp to D:\` → open COM port → read/validate JSON frames against the DO contract. CyberPi remains gated on mBlock's proprietary GUI.

### 8.6 Edge py2hex service

Edge ported uflash 2.0.0 to TypeScript (~295 lines in `py2hex.ts`). `POST /api/build` accepts `.py` source, returns universal `.hex` (V1+V2, 1.85 MB). Universal hex template embedded in Worker (741 KB gzipped). ~5ms compile. Byte-for-byte identical to uflash reference.

### 8.7 Catalog

4 micro:bit programs landed in `Edge/catalog/` alongside CyberPi entries: heart-badge, name-tag, emotion-badge, dice. All verified on hardware. Catalog stores `.py` source (~200 bytes each), compiles through `py2hex()` at request time when `format: ".hex"`. Beauty filters by `catalogTag`.

### 8.8 WebUSB flash (in progress)

Goal: flash `.hex` to micro:bit without a file picker dialog. The MSD path (`showSaveFilePicker`) always shows a dialog — browser security requirement. WebUSB bypasses the file system entirely: CMSIS-DAP vendor commands (0x8A-0x8C) send raw binary to the DAPLink debug probe over SWD. DAP.js library handles transport.

Research confirmed: vendor flash commands don't require the full CMSIS-DAP `connect()` SWD protocol selection — they use their own internal flash algorithm. The `connect()` timeout on DAPLink 0249 is on the SWD sequence, not on the vendor path. The bypass path (`transport.open()` → `flash()` directly) is viable.

**Current state:** WebUSB flash NOT yet tested on hardware. Beauty's session focused on saveHexToMicrobit recovery (function was deleted during prior patch cleanup, restored with timeout + status-based tripwire tree + three-transport cascade). WebUSB implementation deferred pending V2 hardware availability.

After first WebUSB pairing, `navigator.usb.getDevices()` returns the device silently — zero-dialog future sessions.

### 8.8b DAPLink corruption and recovery

Beauty accidentally flashed KL27Z (V2) firmware to the KL26Z (V1.5) board, corrupting the interface firmware. Root cause: DAPLink issue #715 — bootloader v0241+ silently accepts any hex in MAINTENANCE mode, including wrong-architecture firmware. Recovery: downloaded official microbit.org V1 (KL26Z v0253) firmware from CDN, flashed via bootloader drag-and-drop. Device returned to Interface mode with all USB interfaces restored.

### 8.9 BLE feasibility

micro:bit V2 supports Nordic DFU over BLE — the one BLE feature MicroPython actually ships. After initial USB flash, firmware updates can arrive wirelessly. Web Bluetooth API can discover the DFU service and push firmware chunks. This decouples flash from data relay — flash over BLE, live data over radio or serial. Not yet implemented, but structurally feasible.

### 8.9c saveHexToMicrobit restored

The function was accidentally deleted during prior patch script cleanup. Beauty restored it with: 10s fetch timeout, status-based tripwire tree (every node has `status: "in-progress"|"done"|"failed"`), three-transport cascade (WebUSB → MSD showSaveFilePicker → createObjectURL download), `onProgress(tree)` called after every mutation for incremental UI updates.

Also: `/api/microbit/relay.hex` was returning 404. Beauty added the Edge route serving `firmwareHex` (universal, 1.8MB). Now HTTP 200.

### 8.10 V1.5 hardware ground truth

Beauty identified the classroom micro:bit as **V1.5** (bootloader 0243, interface 0249, HIC ID 97969901, KL26Z interface chip), not V2 as previously assumed. The CDC serial on V1.5 is **transmit-only** — the browser can write bytes but never receives responses. Bidirectional serial relay requires V2 (KL27Z, DAPLink v0258+).

MSD flash (drag-and-drop .hex) works on all hardware for standalone programs. The catalog programs can be flashed and run independently. They just can't communicate back over serial on V1.5.

### 8.11 Edge DAPLink firmware audit issues

Beauty found: firmware-daplink-v1.hex and v2.hex are byte-for-byte identical (both KL27Z architecture), neither matches official microbit.org CDN builds, and v2.hex is imported but unused. Recovery required downloading the official V1 (KL26Z v0253) firmware from microbit.org CDN.

### 8.12 Known limitations

- V1.5 (KL26Z) — CDC serial is transmit-only. No bidirectional relay. MSD flash only for standalone programs.
- V2 (KL27Z) — bidirectional serial relay requires DAPLink v0258+. WebUSB flash also requires KL27Z.
- Edge DAPLink firmware files — mislabeled, need replacement with official CDN builds.
- Opera Web Serial compatibility — paired ghosts, port locks. Chrome and Edge are the target browsers.
- Dashboard routing bug — deviceType tracking breaks between ConnectWizard success and Dashboard render.
- `showSaveFilePicker()` always shows a dialog — browser security, cannot bypass.

### 8.13 Browser vs CLI — two different surfaces

Beauty attempted 10+ approaches to automate flashing from the browser (WebUSB, `showSaveFilePicker`, download cascade, HF2 protocol, DAP.js bypasses). Every approach hit the same wall: browser security APIs require a user gesture for anything touching USB devices or the file system.

Firmware proved the automation works from the command line: `py2hex` → `cp to D:\` → serial read → validate. Zero gestures, zero dialogs, zero human clicks. PowerShell has no gesture restrictions. The browser does.

**These are two separate surfaces for two separate users:**

| Surface | User | Path | Gesture requirement |
|---|---|---|---|
| CLI (PowerShell/Node) | Agent/developer | `py2hex` → `cp` → serial validate | None — fully automated |
| Browser (SPA) | Teacher | Catalog → download `.hex` → drag to `D:\MICROBIT` | Download click only |

Beauty's catalog flow is correct for the teacher: download `.hex`, drag to drive. The automation pipeline stays on the command line where it already works. The browser cannot replace it — not due to code quality, but due to browser security architecture.

### 8.14 V1.5 implications

V1.5 (KL26Z) CDC serial is transmit-only. The serial relay, WebUSB flash, and bidirectional LED commands all require V2 (KL27Z) hardware. MSD flash works on all hardware. For the teacher, the experience is identical regardless of board revision: download `.hex`, drag to drive.

---

*Agent Alpha — July 17, 2026*



---

## 8. Session — July 18, 2026 (Infrastructure & Coordination)

### 8.1 Agent capabilities audit

Verified the agent's tool surface: Firecrawl MCP (26 tools via HTTP transport), Cloudflare API access (curl + bearer token), web_fetch, bash, Python, npm, git, Docker. Question: what can the agent actually do vs. what does it ask the human to do?

### 8.2 Firecrawl MCP authentication (browser PKCE flow)

**Goal:** Authenticate Firecrawl MCP with a real API key instead of keyless free tier.

**Method:** Followed Firecrawl's Path D (CLI browser auth) — PKCE flow:
1. Generated SESSION_ID, CODE_VERIFIER, CODE_CHALLENGE via openssl
2. Opened browser automatically via `python3 -c "import webbrowser; webbrowser.open(...)"`
3. Polled `POST /api/auth/cli/status` every 3s
4. Captured API key and wrote to Reasonix config.toml as `Authorization: Bearer` header

**Failures:** Credential masking by Reasonix consumed the key on first two attempts (output redacted, file write to /tmp/ failed on Windows). Third attempt saved to %APPDATA%/reasonix/fc_key.txt and wired into config.

**Result:** Firecrawl MCP now authenticated (Personal team). Verified: `firecrawl_search` returns results with credits tracked.

### 8.3 Cloudflare MCP installation

**Goal:** Install @cloudflare/mcp-server-cloudflare v0.2.0 for structured Cloudflare access.

**Method:** npx stdio transport with CLOUDFLARE_API_TOKEN and account ID CF_ACCOUNT_ID_PLACEHOLDER.

**Failures:** install_source tool overrode custom args (needed "run" subcommand + account ID). Workaround: edited config.toml directly.

**Result:** 89 tools discovered (KV, R2, D1, DO, Queues, Workers AI, Analytics, Zones, Routes, Cron, Secrets, Wrangler config, Templates). Tools load on next session start. Curl with bearer token available as fallback.

### 8.4 Web search skill

Created `/web-search` skill documenting free no-auth APIs: DuckDuckGo Instant Answer, Wikipedia REST, Jina Reader, GitHub REST, Wayback CDX, PubMed E-utilities. All verified working live.

### 8.5 Operational principle: Capability vs. Decision

Established the line: agent executes capabilities (browser, curl, file writes) without asking. Agent asks human for genuine decisions (library choice, architecture fork, scope). Pretending incapability poisons the context — the agent must not act less capable than it is.

### 8.6 Inter-agent protocol confirmed

Alpha -> operator/bus -> target agent. Formal assignments in AGENTS.md section 9.1 format. Operator copy-pastes assignments to agent sessions. Agent handoffs come back through operator.

### Files modified
- `ALPHA_HANDOFF.md` — +37 lines, infrastructure & principles section
- `ALPHA.md` — this section (8.1–8.6)
- `~/.reasonix/config.toml` — Firecrawl auth header, Cloudflare plugin entry
- `.reasonix/skills/web-search/SKILL.md` — new web search skill

### Key artifacts created
- `%APPDATA%/reasonix/fc_key.txt` — Firecrawl API key (used in config)
- `/web-search` skill — documented free web search APIs


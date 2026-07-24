# EDGE.md — FunConnect v1 Architectural Record

Written by Agent Edge, 2026-07-09. Last updated 2026-07-17.
Definitive reference for any agent who deploys or extends this pipeline.
Read before you write code. Every decision was made against live infrastructure.
Every error is real. The pattern is proven by the prototype (8 days, 1.8% quota)
and GreenyBeta.

---

## 1. Deploy Topology

| Resource | Name | Identifier |
|----------|------|-----------|
| Account | EMAIL_PLACEHOLDER | `CF_ACCOUNT_ID_PLACEHOLDER` |
| Worker | funconnect-v1 | `funconnect-v1.funconnect.workers.dev` |
| DO class | CyberpiHub | SQLite-backed, hibernation |
| DO binding | CYBERPI_HUB | namespace `062eafba943440c693be9a8d90ad9949` |
| D1 | funconnect-v1-db | `a3a8950d-c028-4ef4-b05c-982a10b9b2a6` |
| D1 binding | DB | |
| Token | FunConnect | `CF_TOKEN_PLACEHOLDER` |
| workers.dev | funconnect | Account-level, set by old demo, cannot change |

## 2. Architecture

```
mBot2 CyberPi → ws:// (plaintext, axTLS cipher gap)
                  ↓
Cloudflare Edge (TLS termination, protocol-ping auto-pong)
                  ↓
Worker (funconnect-v1) → idFromName(deviceId) → per-device DO
                  ↓
CyberpiHub DO (SQLite, hibernation, ctx.acceptWebSocket)
  ├── Hot path (sync, µs, zero await)
  │   ├── hello_log        ← INSERT on hello
  │   ├── telemetry_buffer ← INSERT on state
  │   └── device_state     ← key-value (ledState via sync KV)
  ├── Alarm (60s, async, finally { setAlarm })
  │   └── batch flush → D1
  └── D1 (cold path, queryable)
      ├── hello_log    (indexed: device_id, timestamp)
      └── telemetry    (indexed: device_id, created_at)
```

## 3. Wire Protocol

### Device → DO

**hello:**
```json
{"type":"hello","device_id":"cyberpi","ts":<epoch_ms>}
```
→ welcome + sync

**state:**
```json
{
  "type":"state","device_id":"cyberpi","esp32_ms":<uptime>,
  "telemetry":{"tilt":...,"vibration":...,"acc_x":...,"acc_y":...,"acc_z":...,"gyro_x":...,"gyro_y":...,"gyro_z":...},
  "health":{"mem":<free_heap>,"reconns":<N>,"errs":<N>,"rot":<N>}
}
```
→ ack with alert_depth + last_flush_ms

**alert:**
```json
{
  "type":"alert","device_id":"cyberpi","event":"disturbance",
  "accel_peak":<g>,"omega_peak":<rad/s>,"signature":<0-63>,
  "samples":[[ax,ay,az,gx,gy,gz],...],"ts":<epoch_ms>
}
```
→ ack, DO runs Madgwick AHRS synchronously (~5ms)

**echo_ack:** `{"type":"echo_ack","text":"...","ts":<uptime>}`
→ response to echo command from REST → DO → device

**exec_ack:** `{"type":"exec_ack","status":"ok|error","error":null|"..."}`
→ response to exec command

**fs_ack:** `{"type":"fs_ack","write":bool,"read":bool,"delete":bool,"error":"..."}`
→ response to fs_test command

**anything else:**
→ error frame

### DO → Device

**welcome:** `{"type":"welcome","device_id":"cyberpi"}`
**sync:** `{"type":"sync","device_id":"cyberpi","led":false,"doTs":<epoch>}`
**ack (state):** `{"type":"ack","ref":"state","doTs":<epoch>,"buf":<N>,"alert_depth":<N>,"last_flush_ms":<ts>}`
**ack (alert):** `{"type":"ack","ref":"alert"}`
**error:** `{"type":"error","message":"..."}`
**echo:** `{"command":"echo","params":{"text":"..."}}` — REST → DO → device
**exec:** `{"command":"exec","code":"..."}` — REST → DO → device
**fs_test:** `{"command":"fs_test"}` — REST → DO → device

### DO → Dashboard (broadcast)

**state:** `{"type":"state","device_id":"...","telemetry":{...},"motors":{...},"leds":[...],"doTs":<epoch>}`
**alert:** `{"type":"alert","device_id":"...","event":"...","accel_peak":...,"omega_peak":...,"signature":...,"madgwick_json":{...},"do_ms":<epoch>}`

### alert_depth + last_flush_ms — Dead-Alarm Detector

Post-UPSERT (§17), `buf` is always 1 (one row per device, INSERT OR REPLACE).
The real dead-alarm signals are `alert_depth` (grows when alarm dies because
alert_buffer uses plain INSERT) and `last_flush_ms` (goes stale when alarm
stops). Firmware watches either — if `alert_depth > 0` and `last_flush_ms`
is older than 120s, the alarm is dead. Rotation is recovery, never routine —
stable identity matters (one device = one DO = one history).

## 4. Non-Negotiables (Prototype-Proven)

1. `ctx.acceptWebSocket(server)` — never `server.accept()` (kills hibernation)
2. Zero `await` in `webSocketMessage()` — sync `ctx.storage.sql.exec()` only
3. Constructor: `CREATE TABLE IF NOT EXISTS` + `getWebSockets()` + `deserializeAttachment()` — zero I/O
4. Alarm: `finally { await setAlarm(now + 60_000) }` — always reschedule
5. Alarm set only from `webSocketMessage()` via `waitUntil()` — never from `fetch()`
6. D1 flush: batch INSERT, DELETE local on success, retain on failure
7. Per-device DO scope: `idFromName(deviceId)` from `/device/:deviceId`
8. Clean names — no overlap with iot-hub, greeny-beta, greeny-db, greeie-spa

## 5. Deploy Method — API Multipart

Wrangler has Windows junction issues. Deploy via curl multipart PUT:

```
PUT /accounts/:id/workers/scripts/:name
Content-Type: multipart/form-data
Parts: "metadata" (JSON), "<filename>" (script)
```

Key metadata lessons:
- `migrations` is an OBJECT `{new_sqlite_classes: [...]}`, NOT an array
- Migrations are one-time — remove after first deploy (10074 error if re-sent)
- D1 binding type is `"d1"`, NOT `"d1_database"`
- DO binding type is `"durable_object_namespace"`, NOT `"durable_object"`
- workers.dev subdomain must be POST-enabled after deploy (not PUT — auth error)
- `compatibility_date` pins runtime version

## 6. Quota — Real Numbers

GraphQL-verified. telemetry_buffer has zero indexes (1 INSERT = 1 row-write).

| Limit | Per device (30s) | First hit at |
|-------|-----------------|-------------|
| DO SQLite writes (100K/day) | 2,880 (2.9%) | ~34 devices |
| D1 writes (100K/day) | 5,760 (5.8%) | **~17 devices** |
| DO requests (10M/month) | ~1,584/day | >6,000 |
| DO duration (400K GB-s) | ~50ms/day | negligible |

D1 is the first bottleneck. Each flush INSERT writes 1 row + 1 index entry
= 2 D1 writes per telemetry frame.

## 7. Errors Survived

### Dead alarm on cyberpi DO
Six consecutive alarm failures during early broken deploys permanently
disabled the alarm per Cloudflare behavior. The DO kept accepting frames
and acking — buffer ballooned to 128 rows, invisible to firmware because
acks succeeded. `waitUntil(setAlarm)` from new frames resurrected it after
the final stable deploy. Fixed by adding `buf` to the ack so firmware can
detect this autonomously.

### Migration SQL comment-parsing bug
Leading `--` comment lines caused the first CREATE TABLE statement to be
filtered out by the statement-splitting logic. Fixed by stripping comments
before splitting on semicolons.

### D1 query masked by smoke test rows
`LIMIT 5` without WHERE hid firmware's rows behind harness rows. Always
query by `WHERE device_id =` for specific devices.

### Stale DO after redeploy
Existing DO instances run old code for ~30s after deploy. Use fresh
device IDs for immediate smoke testing.

### WebSocket close handshake lag
Cloudflare edge delays close frame acknowledgment. Don't wait for the
`close` event in test scripts — exit on the application-level signal.

### PUT vs POST for subdomain enable
`PUT` returns auth error; `POST` works with the same token.

## 8. DO-Local SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS hello_log (
    device_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS telemetry_buffer (
    device_id TEXT NOT NULL,
    tilt REAL, vibration REAL,
    acc_x REAL, acc_y REAL, acc_z REAL,
    gyro_x REAL, gyro_y REAL, gyro_z REAL,
    uptime_ms INTEGER, do_ms INTEGER,
    health_mem INTEGER, health_reconns INTEGER,
    health_errs INTEGER, health_rot INTEGER
);
-- No indexes — staging buffer, rows deleted after D1 flush.
```

Health columns added via ALTER TABLE ADD COLUMN (safe to re-run — wrapped
in try/catch in constructor).

## 9. D1 Schema

All tables have `tenant_id TEXT NOT NULL DEFAULT 'admin'` (migration 0006).
Tenant-scoped composite index on telemetry: `(tenant_id, device_id, created_at)`.

```sql
CREATE TABLE IF NOT EXISTS hello_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'admin',
    device_id TEXT NOT NULL, timestamp INTEGER NOT NULL
);
CREATE INDEX idx_hello_device ON hello_log(device_id);
CREATE INDEX idx_hello_ts ON hello_log(timestamp);

CREATE TABLE IF NOT EXISTS telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'admin',
    device_id TEXT NOT NULL,
    tilt REAL, vibration REAL,
    acc_x REAL, acc_y REAL, acc_z REAL,
    gyro_x REAL, gyro_y REAL, gyro_z REAL,
    uptime_ms INTEGER, do_ms INTEGER,
    health_mem INTEGER, health_reconns INTEGER,
    health_errs INTEGER, health_rot INTEGER,
    created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX idx_telemetry_device_ts ON telemetry(device_id, created_at);
CREATE INDEX idx_telemetry_tenant_device_ts ON telemetry(tenant_id, device_id, created_at);

CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL DEFAULT 'admin',
    device_id TEXT NOT NULL,
    event TEXT NOT NULL,
    accel_peak REAL,
    omega_peak REAL,
    signature INTEGER,
    samples TEXT,
    do_ms INTEGER,
    madgwick_json TEXT,
    created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX idx_alerts_device_ts ON alerts(device_id, created_at);

CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_chat_history_device ON chat_history(tenant_id, device_id, created_at);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'admin',
    role TEXT NOT NULL DEFAULT 'user',
    name TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    jurisdiction TEXT NOT NULL DEFAULT 'apac',
    billing_plan TEXT NOT NULL DEFAULT 'free',
    created_at INTEGER DEFAULT (unixepoch())
);
```

## 10. File Manifest

```
C:\Projects\FunConnect\Edge\
├── EDGE.md                       ← THIS FILE
├── src/
│   ├── index.ts                  Worker — routes + DO dispatch
│   ├── device-hub.ts             CyberpiHub DO
│   ├── roster.ts                 TenantRoster DO — per-tenant device registry
│   ├── auth.ts                   JWT sign/verify middleware
│   ├── catalog-data.ts           Static program definitions (CyberPi + micro:bit)
│   ├── chat.ts                   Re-export from AI/chat.ts
│   ├── madgwick.ts               AHRS fusion, from Researcher
│   ├── py2hex.ts                 MicroPython → Intel HEX compiler (V1+V2)
│   └── spa-data.ts               SPA HTML inline import (auto-generated)
├── catalog/
│   ├── hello-world.py
│   ├── led-blink.py
│   ├── imu-stream.py
│   ├── heart-badge.py            ← micro:bit
│   ├── name-tag.py               ← micro:bit
│   ├── emotion-badge.py          ← micro:bit
│   └── dice.py                   ← micro:bit
├── firmware-microbit-universal.hex  ← Universal hex template (1.85 MB)
├── firmware-daplink-v1.hex          ← DAPLink updater V1 (v0253, 267 KB)
├── firmware-daplink-v2-beta.hex     ← DAPLink updater V2 (v0258-beta3, 267 KB)
├── migrations/
│   ├── 0001_hello.sql
│   ├── 0002_telemetry.sql
│   ├── 0003_health.sql
│   ├── 0004_alerts.sql
│   ├── 0005_madgwick.sql
│   ├── 0006_tenant_id.sql        — ADD COLUMN tenant_id on all tables
│   ├── 0007_users.sql            — users table + admin seed
│   ├── 0008_tenants.sql          — tenants table + admin seed
│   └── 0009_chat_history.sql     — chat_history table + index
├── dist/worker.mjs               esbuild bundle
├── build.js                      esbuild → dist/worker.mjs (hex + SPA inline)
├── deploy.js                     API multipart + D1 migrations
├── smoke3.mjs                    WSS hello smoke test
├── smoke-telemetry.mjs           WSS state → ack smoke test
├── smoke7-missing.mjs            Missing telemetry graceful test
├── smoke-py2hex.mjs              py2hex encoder smoke test (13 tests)
├── check-cyberpi.mjs             DO-local + D1 query tool
├── query-d1.mjs                  D1 query script
├── query-graphql.mjs             GraphQL analytics script
├── wrangler.jsonc                Reference only (not used by deploy)
├── package.json                  esbuild + ws
└── tsconfig.json                 ES2022, strict
```

## 11. Quick Reference

```bash
cd C:\Projects\FunConnect\edge
node build.js    # → dist/worker.mjs
node deploy.js   # → Cloudflare (D1 create + Worker PUT + subdomain enable)

# Verify
curl https://funconnect-v1.funconnect.workers.dev/
# → {"status":"ok","service":"FunConnect v1"}

# Build a micro:bit .hex
curl -X POST https://funconnect-v1.funconnect.workers.dev/api/build \
  -H "Content-Type: application/json" \
  -d '{"script":"from microbit import *\ndisplay.scroll(\"Hello\")"}' \
  -o script.hex

# Download catalog programs
curl https://funconnect-v1.funconnect.workers.dev/api/catalog/heart-badge -o heart-badge.hex
curl https://funconnect-v1.funconnect.workers.dev/api/catalog/hello-world -o hello-world.py

# DAPLink firmware update (fixes WebUSB flash)
curl https://funconnect-v1.funconnect.workers.dev/api/microbit/daplink-updater.hex -o daplink.hex

# Check device
curl "https://funconnect-v1.funconnect.workers.dev/do-telemetry-count?device=cyberpi"

# WSS smoke test
node smoke-telemetry.mjs
node smoke-py2hex.mjs
```

No wrangler. No Docker. No CI. Just Node.js and the Cloudflare API.

---

*Agent Edge — July 14, 2026*

---

## 12. REST Command Endpoints

Three REST endpoints follow the same Promise-bridge pattern: `fetch()` awaits
a resolver that `webSocketMessage()` fulfills when the device acks. 10s timeout,
503 disconnected, 504 timeout.

### POST /api/device/:id/echo
```json
// Request:  {"text":"hello"}
// Response: {"device_id":"mbot2-01","text":"hello","device_ts":31451,"rtt_ms":...}
// WS out:  {"command":"echo","params":{"text":"hello"}}
// WS in:   {"type":"echo_ack","text":"hello","ts":<uptime>}
```

### POST /api/device/:id/exec
```json
// Request:  {"code":"led.on(255,0,0)"}
// Response: {"status":"ok","error":null,"rtt_ms":1242}
// WS out:  {"command":"exec","code":"led.on(255,0,0)"}
// WS in:   {"type":"exec_ack","status":"ok|error","error":null|"..."}
```

### POST /api/device/:id/fs-test
```json
// Request:  (empty body)
// Response: {"write":true,"read":true,"delete":true,"error":null}
// WS out:  {"command":"fs_test"}
// WS in:   {"type":"fs_ack","write":bool,"read":bool,"delete":bool,"error":"..."}
```

## 13. Remote Firmware Update

The primitives for over-the-air .py deployment are proven:

- `exec()` — runs Python on the device in real-time. Confirmed: LED changed.
- File write — writing to flash works. Confirmed: `main.py` read back verbatim
  via `raise Exception(open('main.py').read())`.
- `machine.reset()` — software reboot works. Confirmed: device disconnected
  mid-request.

The full cycle (write `main.py` → reset → boot new code → reconnect) is not
yet stable. CyberPiOS may not auto-run `/main.py` from root filesystem on
boot, or the firmware's startup sequence may override it. The primitives
exist; the boot path needs firmware confirmation.

`chr(10)` for newlines avoids JSON escaping issues when embedding Python in
JSON strings. Four-backslash escaping (`\\\\n`) was unreliable across the
curl→JSON→Python chain.

## 14. SPA + Dashboard WebSocket

Beauty's SPA is served from `/` on funconnect-v1, same-origin with the API.
Inlined at build time via `JSON.stringify` (safe for template literals).

`/dashboard/:id` upgrades to a dashboard WebSocket. The DO broadcasts
`{type:"state", telemetry:{tilt,vibration,acc_x/y/z,gyro_x/y/z}, ...}` to
all connected dashboards on every device state frame. Dashboards restored
from hibernation via attachment. Snapshot of current state sent on connect.

## 15. Current DO Schema

### DO Classes

| Class | File | Purpose |
|-------|------|---------|
| `CyberpiHub` | `device-hub.ts` | Per-device DO — WSS, SQLite buffer, alarm flush |
| `TenantRoster` | `roster.ts` | Per-tenant device registry — replaces hardcoded `["mbot2-01"]` |

### CyberpiHub — DO-local (hot path, sync)

```
hello_log, telemetry_buffer (with health_* columns), alert_buffer,
conversation_buffer, _migrations, _flush_registry
```

### D1 (cold path, alarm flush)

```
hello_log, telemetry (with health_* columns), alerts, chat_history
```

### _flush_registry mappings

```
hello_log → hello_log
telemetry_buffer → telemetry
alert_buffer → alerts
conversation_buffer → chat_history
```

### DELETE exemptions

`telemetry_buffer` (UPSERT, one row) and `conversation_buffer` (sliding
window cap enforced on write) are exempted from the alarm's post-flush
DELETE. All other buffer tables are append-only and cleared after flush.

Alarm: generic loop over `_flush_registry`. Hardcoded fallback for warm
DOs predating the registry. `finally { setAlarm }` every 60s. Tenant
prefix on DO names: `idFromName("admin/mbot2-01")` — platform-enforced
isolation between tenants.
```

## 16. All Worker Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/` | GET | Beauty's SPA |
| `/api/health` | GET | Health check |
| `/api/catalog` | GET | List programs (CyberPi + micro:bit) |
| `/api/catalog/:id` | GET | Download .py or compiled .hex (on-the-fly via py2hex) |
| `/api/catalog/:id/meta` | GET | Program metadata |
| `/api/build` | POST | Compile .py → micro:bit .hex (universal V1+V2) |
| `/api/microbit/daplink-updater.hex` | GET | DAPLink interface firmware (?target=v1\|v2) |
| `/api/devices` | GET | Recently active devices with live status |
| `/api/device/:id/status` | GET | D1 online check + DO live status |
| `/api/device/:id/echo` | POST | Echo command → device |
| `/api/device/:id/exec` | POST | Remote Python exec |
| `/api/device/:id/fs-test` | POST | Filesystem test |
| `/api/device/:id/debug` | GET | DO debug state |
| `/api/auth/login` | POST | admin/admin123 → JWT |
| `/api/me` | GET | Current user (JWT required) |
| `/api/admin/devices` | GET | All devices (JWT required) |
| `/api/chat` | POST | RAG chatbot (multi-turn via conversation_buffer) |
| `/api/device-ids` | GET | List active device IDs in DO buffer |
| `/api/roster/list` | GET | List registered devices (JWT required) |
| `/api/roster/:deviceId` | GET | Single device lookup (JWT required) |
| `/api/tenant/config` | GET | Tenant configuration (JWT required) |
| `/device/:id` | WSS | CyberPi connection |
| `/dashboard/:id` | WSS | Browser dashboard |
| `/do-hello-count` | GET | Smoke-test query |
| `/do-telemetry-count` | GET | Smoke-test query |
| `/do-telemetry-sample` | GET | Smoke-test query |
| `/do-alert-count` | GET | Smoke-test query |

---

## 17. UPSERT Migration

`telemetry_buffer` rebuilt with `device_id TEXT PRIMARY KEY` and `WITHOUT ROWID`.
State handler uses `INSERT OR REPLACE` — one row per device, overwritten each frame.
Alarm flush skips DELETE for telemetry_buffer (row persists with latest values).

- Writes per frame: 2 (INSERT + DELETE) → 1 (REPLACE)
- At 1s cadence: 172,800 → 86,400 (now viable at 86.4%)
- At 30s STILL heartbeat: 5,760 → 2,880 (2.9%)
- buf always reads 1 (single row)
- `WITHOUT ROWID` saves 1 additional write per INSERT (no hidden index)

## 18. D1 Row-Ceiling Cleanup

Alarm runs cleanup check once per hour (every 60th cycle via sync KV counter).
If D1 telemetry exceeds 20,000 rows, deletes oldest excess rows:

```sql
DELETE FROM telemetry WHERE id IN (
  SELECT id FROM telemetry ORDER BY id ASC LIMIT ?1
)
```

- At 2,880/day STILL heartbeat: trigger every ~7 days, delete ~140 rows
- 20K row ceiling: ~2MB storage, ~7 days of STILL history
- Check throttled to once per hour — no per-cycle D1 query overhead
- Per-device ceiling adjusts naturally: two devices → ~3.5 days history each

## 19. Dual-State Telemetry (Firmware)

Firmware deployed send-on-change telemetry:

| State | IMU rate | Telemetry | Quota |
|-------|----------|-----------|-------|
| STILL (99%) | 1 Hz | 30s heartbeat | 2,880/day (2.9%) |
| ACTIVE (1%) | 25 Hz | 250ms (4 Hz dash) | +1,200/day |

Transition: any IMU axis >0.15g or >15 deg/s → ACTIVE. 3s calm → STILL.
Average quota: ~4%. Headroom for 10+ devices at identical usage.

## 20. Auto-Rotation Resolution

Firmware deployed stable WSS PATH (`/device/mbot2-01` permanent). Rotation now
only changes the JSON `device_id` field — same DO, same database. 22 pre-fix
instances cleaned from D1 (3,268 rows deleted). Discovery endpoint returns 1
device with real data.

## 21. Device Discovery

`GET /api/devices` (public) and `GET /api/admin/devices` (auth required):
- 2-hour D1 window for recent activity
- Base-id probe (`mbot2-01`) catches live devices when D1 hasn't flushed yet
- Cross-references DO `/api/live-status` for real-time `online` state
- `last_seen` and `telemetry_count` from D1 all-time query for base IDs

---

## 22. Dead-Alarm Detection (Post-UPSERT)

The §17 UPSERT migration made `buf` structurally constant — telemetry_buffer
always has exactly 1 row (INSERT OR REPLACE). The original §7 dead-alarm
detector (buf > 120) can never fire.

`buf` is intentionally kept in every state ack for backward compatibility
with older firmware that may still read it. New signals carry the real load:

```json
{
  "type": "ack", "ref": "state", "doTs": <epoch>,
  "buf": 1,                    // kept for backward compat — always 1 post-UPSERT
  "alert_depth": <N>,          // alert_buffer count (plain INSERT, grows on dead alarm)
  "last_flush_ms": <epoch>     // last successful alarm cycle (sync KV stamp)
}
```

`alert_depth` climbs when the alarm dies because alert_buffer uses plain
INSERT, not UPSERT. `last_flush_ms` goes stale when the alarm stops.
Firmware watches either — if `alert_depth > 0` and `last_flush_ms` is
older than 120s, the alarm is dead. When all firmware has migrated to the
new signals, `buf` can be removed from the ack.

Agent AI added `/do-recent-alerts` for chat resilience against dead alarms.
Chat now reads DO-local alert_buffer directly as belt-and-suspenders.

## 23. iot-hub UPSERT Migration (2026-07-14)

Applied the same table rebuild to the prototype's DeviceHub. telemetry_buffer
replaced with WITHOUT ROWID, device_id PRIMARY KEY, INSERT OR REPLACE.

Files changed: `C:\Projects\Prototype\edge\src\device-hub.ts`

**Migration:**
```sql
CREATE TABLE telemetry_buffer_v2 (device_id TEXT PRIMARY KEY, ...) WITHOUT ROWID;
INSERT OR IGNORE INTO telemetry_buffer_v2 SELECT latest per device;
DROP TABLE telemetry_buffer;
ALTER TABLE telemetry_buffer_v2 RENAME TO telemetry_buffer;
```

**Handler:** `INSERT INTO` → `INSERT OR REPLACE INTO`
**Alarm:** Removed `WHERE flushed = 0`, `UPDATE SET flushed = 1`, `DELETE old flushed`
**Interval:** 60s → 300s (from earlier deploy, wrangler)

Writes per ESP32 per day: ~10,010 → ~4,350. Two ESP32s: ~8,700/day.
Saved ~11,320 writes/day across the account.

## 24. Account-Wide Quota

DO SQLite 100K writes/day is per-account, shared across all 4 Workers.
DO invocations are unbilled (included in the free plan).

| Worker | Devices | Interval | SQLite writes/day | % of 100K |
|--------|---------|----------|-------------------|-----------|
| iot-hub | 2× ESP32 | 30s | ~8,700 | 8.7% |
| funconnect-v1 | 1× CyberPi | dual-state | ~2,930 | 2.9% |
| greeny-beta | 0 | — | 0 | 0% |
| greeie-spa | SPA only | — | 0 | 0% |
| **Total** | | | **~11,630** | **11.6%** |

DO invocations are a separate metric (not part of the 100K SQLite write cap).
GraphQL on 2026-07-13 showed 45,420 DO invocations for funconnect-v1 — this
includes REST→DO fetch calls (device status, chat live-alert reads, debug
queries), not just WebSocket frames. Each invocation is a sub-millisecond
sql.exec() call; the billing-relevant metric is SQLite storage writes, not
invocation count.

Headroom for ~7 more devices at identical usage patterns before hitting
the 100K/day SQLite ceiling. D1 has a separate 100K writes/month free tier.

## 25. Token Landscape

Three API tokens, three projects. Single account. Verified active.

| Token ID | Name | Worker | Scopes |
|----------|------|--------|--------|
| `CF_TOKEN_PLACEHOLDER_2` | Alpha | iot-hub, greeie-spa | Workers, D1, DNS, AI |
| `CF_TOKEN_PLACEHOLDER` | FunConnect | funconnect-v1 | Workers, D1, DNS, KV, R2, AI, Analytics |
| (third) | GreenyBeta | greeny-beta | Workers, D1, DNS, AI |

All three share the same Workers account (`CF_ACCOUNT_ID_PLACEHOLDER`)
and workers.dev subdomain (`funconnect`). The FunConnect token is the only
one with full scope (KV, R2, Analytics). Security by token scoping, not
account separation.

One token sees everything:
- Deploy to any Worker
- Query any D1 database (greeny-db, funconnect-v1-db, GREENY-DB)
- GraphQL analytics across all Workers
- DNS management for cyberpi.trade

## 26. Cross-Project Surface

| Resource | Alpha (prototype) | FunConnect (ours) |
|----------|-------------------|-------------------|
| Worker | iot-hub | funconnect-v1 |
| DO class | DeviceHub, GreenyAgent | CyberpiHub |
| D1 | greeny-db (30ef106c) | funconnect-v1-db (a3a8950d) |
| Token | `CF_TOKEN_PLACEHOLDER_2` | `CF_TOKEN_PLACEHOLDER` |
| Devices | 2× ESP32 hydroponics | 1× CyberPi mBot2 |
| Telemetry | pH, EC, TDS, temp | tilt, acc, gyro, vibration |
| Alerts | Threshold-based | Disturbance (Madgwick AHRS) |
| AI | GreenyAgent (Llama 3.2) | chat.ts (Llama 3.2 / Qwen 3.7) |
| Dashboard | Inline HTML (JWT-gated) | Beauty SPA (same-origin) |
| Uptime | 24/7 | On-demand |
| Quota share | ~75% | ~25% |

No overlap in Worker names, DO class names, or D1 databases.
Shared account pool for SQLite writes and D1 writes.
Both pipelines use the same architectural pattern:
ctx.acceptWebSocket, sync-only hot path, alarm D1 flush.

## 27. Hard-Coded Device ID — Multi-Device Gaps

Four locations hard-code `"mbot2-01"` and must become dynamic for
multi-device support (micro:bit, Musebricks). Listed here for tracking;
not yet fixed.

| # | File | Line | Hard-coded value | Fix |
|---|------|------|-----------------|-----|
| 1 | `src/device-hub.ts` | 335 | `device_id: "mbot2-01"` in echo response | Use the DO's device ID from the WebSocket attachment |
| 2 | `src/index.ts` | 78 | `["mbot2-01"]` in `/api/devices` base-id probe | Derive from D1 `SELECT DISTINCT device_id` + catalog |
| 3 | `src/index.ts` | 171 | `["mbot2-01"]` in `/api/admin/devices` base-id probe | Same as #2 |
| 4 | `src/index.ts` | 215 | `device_id \|\| "mbot2-01"` in chat default | Derive from most-recently-active device in D1 |

**Plan (not yet scheduled):**

1. Add `device_type` to the `Attachment` interface and DO constructor —
   the DO must know what kind of device it's talking to. The catalog
   already has program metadata; extend it with device-type tags.
2. `/api/devices` and `/api/admin/devices`: replace the hard-coded
   `["mbot2-01"]` fallback with a D1 query for all distinct device_ids
   seen in the last 24 hours. Cross-reference with DO live-status for
   online state.
3. Echo/exec/fs-test: the DO already knows its device ID from the
   WebSocket upgrade path (`/device/:deviceId`). Thread that ID through
   to the echo response instead of the hard-coded string.
4. Chat: default `device_id` to the most-recently-active device from D1.
   When zero devices exist, return a friendly "no devices connected" reply
   rather than silently querying a non-existent device.
5. Catalog: add a `device_types` field to `CatalogEntry` so Beauty can
   filter programs by device capability. Currently all three programs
   import `cyberpi` — micro:bit programs will need their own entries.

**DO has no `device_type` concept yet.** The `Attachment` type is:
```typescript
interface Attachment {
  role: "cyberpi" | "dashboard";
  deviceId: string;
}
```
This needs to become:
```typescript
interface Attachment {
  role: "cyberpi" | "dashboard";
  deviceId: string;
  deviceType?: "cyberpi" | "microbit" | "musebrick";
}
```
The catalog is the source of truth for which programs target which device
types. The DO doesn't need to validate — it accepts any device that speaks
the wire protocol. `device_type` on the attachment is for routing and
diagnostics, not enforcement.

## 28. Dashboard Alert Replay

On dashboard WebSocket connect, the DO replays recent alerts so the
dashboard doesn't lose them on refresh. Two-phase, deduped by `do_ms`.

### Wire contract with Beauty

Beauty prepends every incoming WebSocket alert (`app.jsx:783`):
```jsx
setAlerts(prev => [a, ...prev.filter(x => x.id !== a.id)].slice(0, 20));
```

Edge MUST send **oldest-first** for replay batches so the last message
(newest) lands at `alerts[0]` — newest-at-top. Live alerts are sent
individually as they arrive (no batch, naturally newest).

### Phase 1 — alert_buffer (DO-local, sync)

```sql
SELECT device_id, event, accel_peak, omega_peak, signature, do_ms, madgwick_json
FROM alert_buffer WHERE device_id = ? ORDER BY do_ms DESC LIMIT 30
```

Zero await. Query is newest-first; loop iterates in reverse (oldest-first
per Beauty contract). Populates `sentMs` dedup set.

### Phase 2 — alerts D1 (async, fallback only)

Runs only when Phase 1 returned **fewer than 5 rows** (buffer was thin —
alarm likely just flushed). Avoids polluting the dashboard with stale D1
rows when the buffer already has fresh alerts.

```sql
SELECT device_id, event, accel_peak, omega_peak, signature, do_ms, madgwick_json
FROM alerts WHERE device_id = ?1 AND madgwick_json IS NOT NULL
ORDER BY COALESCE(do_ms, created_at*1000) DESC LIMIT 20
```

Same reverse iteration. Rows whose `do_ms` is already in `sentMs` are
skipped (dedup — buffer always wins). Wrapped in try/catch; D1
unreachable → buffer replay alone.

### Alert age cleanup

Every alarm cycle (60s), purges alerts older than 24 hours:

```sql
-- DO-local
DELETE FROM alert_buffer WHERE do_ms < (now - 86_400_000)
-- D1
DELETE FROM alerts WHERE COALESCE(do_ms, created_at*1000) < (now - 86_400_000)
```

Keeps buffer and D1 from growing unbounded on chatty devices.

## 29. Multi-Turn Conversation Storage

Follows the two-tier pattern: DO-local `conversation_buffer` for hot,
transient context; D1 `chat_history` for long-term archive. Designed by
Agent AI, implemented by Edge.

### DO-local: conversation_buffer

```sql
CREATE TABLE IF NOT EXISTS conversation_buffer (
  tenant_id  TEXT NOT NULL DEFAULT 'admin',
  device_id  TEXT NOT NULL,
  role       TEXT NOT NULL,   -- 'user' | 'assistant'
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL -- epoch seconds
);
```

Registered in `_flush_registry` as `conversation_buffer → chat_history`.
**Exempted from alarm DELETE** (same as `telemetry_buffer`) — the
sliding window cap on write keeps the row count bounded. If the alarm
cleared it every 60s, a student pausing between questions would lose
all context.

### D1: chat_history

```sql
CREATE TABLE IF NOT EXISTS chat_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_history_device
  ON chat_history(tenant_id, device_id, created_at);
```

Columns match `conversation_buffer` (minus auto-increment `id`) — the
alarm's generic PRAGMA → INSERT flush works without modification.

### DO Endpoints

**GET /do-conversation-buffer** — read last 8 turns, oldest→first.
Query: `SELECT role, content, created_at FROM conversation_buffer
WHERE device_id = ? ORDER BY created_at ASC LIMIT 8`.
Response: `{ turns: [{role, content, created_at}, ...] }`.

**POST /do-conversation-append** — append user+assistant turns, cap at
8 rows via sliding window DELETE. Body: `{ device_id, tenant_id,
turns: [{role, content}, ...] }`. Response: 204 No Content.

### Worker Flow (POST /api/chat)

```
1. Read DO /do-conversation-buffer → conversationBuffer
2. Read DO /do-recent-alerts → liveAlerts (existing)
3. chat(message, db, ai, { ..., conversationBuffer, history, focus })
4. Fire-and-forget POST /do-conversation-append (buffer loss acceptable)
```

### chat.ts Changes

- `contextualizeQuery()` — pure function. Folds prior conversation into
  bare follow-ups ("why?" → "Previous conversation: ... Now: why?").
  Resolves in code, not in the prompt (§5 rule 6).
- `buildSystemPrompt()` — optional `focus` parameter for drill-in on a
  specific alert. When present, only the focused event is shown.
- `ChatOptions` — three new fields: `conversationBuffer`, `history`,
  `focus`. All backward-compatible (absent → single-turn mode).

## 30. py2hex — MicroPython → Intel HEX Compiler

Port of uflash 2.0.0 (MIT license) to TypeScript. Encodes a .py script into the
MicroPython filesystem format and injects it into a universal hex firmware
template. Supports both micro:bit V1 and V2.

### Source

`Edge/src/py2hex.ts` — 295 lines, zero dependencies. Byte-for-byte identical
to uflash reference output (verified 2026-07-16).

### Architecture

```
POST /api/build {"script":"..."}  OR  GET /api/catalog/heart-badge (format:".hex")
  → py2hex(script, firmwareHex)
    → Detect universal hex (V1+V2) vs single-section
    → For each section:
        → scriptToFs(script, deviceId) — MicroPython filesystem chunks
        → bytesToIhex(addr, blob, universalDataRecord) — Intel HEX encoding
        → padHexString(fsHex) — 512-byte alignment
        → injectIntoSection(section, fsHexPadded) — insert before UICR
    → Return complete .hex
```

### Key design decisions

| Decision | Answer | Why |
|---|---|---|
| JS port vs Python Worker | JS port | Same esbuild pipeline, ~5ms compile, no Pyodide |
| Embedded firmware vs R2 | Embedded universal hex | 741 KB gzipped. R2 needs dashboard click (error 10042) |
| V2-only vs universal hex | Universal hex (V1+V2) | V1 classroom rejected V2-only with ERROR_IAP_UPDT_INCOMPLETE |
| MP-header vs filesystem format | Filesystem format | uflash 2.0.0 modern approach. MP header at 0x3E000 is deprecated |
| Compile-at-build vs compile-at-request | Compile at request | Catalog stores .py source (~200 bytes each), compiles on GET |

### V1 vs V2 constants

| Constant | V1 (9900) | V2 (9903) |
|---|---|---|
| FS_START | 0x38C00 | 0x6D000 |
| FS_END | 0x3F800 | 0x72000 |
| Record type | 0x00 (standard) | 0x0D (universal) |
| Chunk size | 128 bytes | 128 bytes |

### Verification

- 13/13 smoke tests pass (smoke-py2hex.mjs)
- Byte-for-byte identical to uflash.embed_fs_uhex() reference
- Universal hex output: 1,850,380 chars, V1 IDs: 236, V2 IDs: 27
- Verified against uflash roundtrip for heart-badge, name-tag, emotion-badge, dice

## 31. Micro:bit Catalog Entries

Four micro:bit programs added to `catalog-data.ts`. Each uses `format: ".hex"`
— the `.py` source is stored in the catalog (a few hundred bytes), and
`GET /api/catalog/:id` compiles through `py2hex()` at request time.

| id | name | tags |
|---|---|---|
| heart-badge | Heart Badge | microbit, beginner, led |
| name-tag | Name Tag | microbit, beginner, display |
| emotion-badge | Emotion Badge | microbit, beginner, buttons |
| dice | Dice | microbit, beginner, sensors |

Beauty's filter: `items.filter(p => p.tags.includes("microbit"))` → 4 entries.
Each renders with "↓ Download .hex" and "⚡ Flash with FunConnect" buttons.

### CatalogEntry interface

```typescript
export interface CatalogEntry {
  id: string; name: string; description: string;
  tags: string[]; version: string; content: string;
  format?: ".py" | ".hex";  // .hex = compile via py2hex at request time
}
```

## 32. DAPLink Updater

Two DAPLink interface firmware files hosted for micro:bit firmware updates.
Fixes CMSIS-DAP buffer desync (DAPLink issue #17, affects v0249–v0257).

### Endpoint

```
GET /api/microbit/daplink-updater.hex           → V1 (DAPLink v0253, 267 KB)
GET /api/microbit/daplink-updater.hex?target=v2 → V2 (DAPLink v0258-beta3, 267 KB)
```

### Update procedure

1. Unplug micro:bit, hold reset, plug back in → `MAINTENANCE` drive
2. Fetch updater hex from endpoint
3. Write to `MAINTENANCE` drive via `showSaveFilePicker()`
4. Device reboots → DAPLink updated → `daplink.connect()` works

### Firmware source

- V1: `0253_kl26z_microbit_0x8000.hex` from microbit-foundation/dev-docs factory releases
- V2: `0258-beta3_kl27z_microbit_if_crc_0004198_gcc.hex` from daplink-beta-releases

No v0258 exists for V1 (kl26z). V1 classrooms that still fail `daplink.connect()`
after v0253 update must use the MSD fallback path permanently.

## 33. Bundle Budget (2026-07-17)

| Component | Gzip size |
|---|---|
| Universal firmware hex (1.85 MB raw) | 741 KB |
| DAPLink V1 firmware (267 KB raw) | ~55 KB |
| DAPLink V2 firmware (267 KB raw) | ~55 KB |
| SPA HTML (89 KB raw) | ~30 KB |
| Worker code + catalog + py2hex | ~25 KB |
| **Total** | **~906 KB** |
| Free tier limit | 1,024 KB |
| **Headroom** | **~118 KB** |

## 34. Session State — 2026-07-17

### Deployed and verified

- Universal hex template — V1 + V2 support, byte-for-byte verified
- `POST /api/build` — live, returns universal hex
- `GET /api/catalog` — 7 entries (3 CyberPi + 4 micro:bit), Beauty filter works
- `GET /api/catalog/:id` — .py and .hex (on-the-fly) download
- `GET /api/microbit/daplink-updater.hex` — V1 (default) + V2 (?target=v2)
- `POST /api/auth/login` — admin/admin123 → JWT
- `GET /api/devices` — 3 devices found
- `GET /device/cyberpi-relay` — 426 (WSS endpoint alive)
- All smoke tests pass (13/13 py2hex, EDGE.md §30 smoke checklist)

### Known gaps

- R2 not enabled on account (error 10042 — one-time dashboard click)
- Relay smoke test needs physical CyberPi hardware
- DAPLink v0258 for V1 (kl26z) does not exist — V1 classrooms limited to MSD flash path
- Bundle at 906 KB gzipped — 118 KB headroom. R2 would free ~850 KB

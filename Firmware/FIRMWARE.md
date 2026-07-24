# FIRMWARE.md — CyberPi WSS-DO Client: Development Log

Engineering log for the FunConnect CyberPi firmware. Written as a candid
record — what we tried, what broke, why, and what we proved. If you inherit
this project, read this before touching `smoke_ws.py`.

---

## TL;DR (current status)

- **Phase 1 telemetry: DONE.** `state` + 6-DOF IMU + `health` sub-object. DO acks
  with `buf` (buffer depth) + `doTs` + `alert_depth` + `last_flush_ms`. ~6,800 rows in D1 from `mbot2-01`.
- **Phase 2 disturbance detector: DONE.** 25 Hz, 6-DOF per-axis jerk gate, 75-sample
  alert frame (50 ring + 25 post-trigger), `alert_buffer` → D1. 4+ alerts confirmed.
- **Phase 3 inbound commands: DONE (echo, exec, fs_test).** DO→device round-trip
  via REST. `exec` runs arbitrary MicroPython; `fs_test` probes write/read/delete.
  `set_led` (QoS-1 relay) not yet built.
- **S6 dual-state: DONE.** Send-on-change — STILL (1 Hz poll, 30s heartbeat, 3%
  quota) ↔ ACTIVE (25 Hz, ring, jerk, alerts, 250ms telemetry fire-and-forget).
  IMU delta wakes the detector. Settle returns to idle. LED blinks only on real
  movement.
- **Robustness hardened.** Exponential-backoff reconnect, heap hygiene, error-frame
  handling, `alert_depth` + `last_flush_ms` health monitoring (stable PATH -- one DO forever).
- **The path:** `CyberPi → ws://funconnect-v1.funconnect.workers.dev:80/device/mbot2-01 → DO`
  — plaintext on the device side, TLS at Cloudflare edge, no laptop, no relay.
- **micro:bit relay: LIVE (LED matrix control).** `microbit_relay.py` — boot, hello frame,
  char-by-char serial read, led_matrix dispatch (5 patterns), echo, led_ack. Latency: ~180ms
  click-to-LED. Toolchain fully automated (`py2hex` + `cp` to `D:\`). 4 catalog programs
  verified on hardware. All 8 smoke tests (P1–P8) complete. See §micro:bit below.
- **Deploy loop:** CyberPi — proprietary mBlock GUI (human-gated). micro:bit — `py2hex` +
  file copy (agent-driven, zero clicks).

---

## The mission

Port the existing MQTT mBot2 firmware (`sacl2026-rgb/cyberpi-hub/firmware/mbot2.py`)
to a WebSocket transport against a Cloudflare Durable Object, keeping the same
JSON wire protocol. Collapse "broker + bridge + auth" into one pipe.

### Hardware reality (important corrections to the brief)

- **It's a bare CyberPi controller. No mBot2 base. NO MOTORS, no encoders.**
  This deletes a huge chunk of the original firmware (drive_power, straight,
  turn, EM_stop, M2_INVERT) and removes two of Alpha's "non-negotiables"
  (#4 motor-stop-first, #7 M2_INVERT). Everything the client needs — RGB LED,
  6-axis IMU, LCD, WiFi — is **onboard the CyberPi**, independent of the base.
- Platform: CyberPiOS (Makeblock's MicroPython fork) on ESP32. Upload via
  mBlock. **No USB REPL** — all on-device feedback is LED + LCD.

---

## Final architecture

```
   CyberPi (CyberPiOS / MicroPython)
      |
      |  ws://  (PLAINTEXT, port 80, no TLS)
      v
   Cloudflare edge  ── terminates TLS here ──> Durable Object
```

**Why plaintext on the device side:** CyberPiOS ships **axTLS**, which is too
old to complete a TLS handshake with Cloudflare (see failures below). The chip
can do modern TLS (the Arduino/mbedTLS firmware in the repo does), but the
MicroPython stack can't. The escape hatch: Cloudflare accepts a WebSocket
upgrade over **plaintext port 80** and terminates TLS at its own edge. The
device gets a direct-to-cloud pipe with zero external dependencies.

**Relay (prototyped, then deleted):** a `relay.py` laptop bridge (plaintext WS →
WSS DO) was built to debug the axTLS gap, then removed. A laptop in the
production path is a single point of failure — if the laptop sleeps, the device
is dead. It was never shippable; kept here only as a lesson. Do not reintroduce it.

---

## The journey (chronological, honest)

1. **PC-first proof.** Wrote the RFC 6455 framing in CPython, ran it against
   the live DO. `hello → welcome → sync`, RTT 58 ms. Contract + framing logic
   validated before touching hardware. This was the right call — it separated
   "is our protocol right" from "does the hardware cooperate."
2. **Ported to device — and it immediately broke.** Uploading the full file
   failed with tracebacks we couldn't see well (no REPL). Two separate causes
   masqueraded as one (base64, then non-ASCII source).
3. **Bisected.** Abandoned the big-file approach and grew a single file one
   capability at a time (P1..P6). This was the turning point — every failure
   became localized and cheap.
4. **Hit the TLS wall.** TCP reached Cloudflare; the axTLS handshake failed
   with `error 51 EIO`. NTP time-sync didn't help → it's cipher-level, not a
   clock issue → unfixable in Python.
5. **Tried a relay, rejected it.** Worked, but laptop = SPOF. Kept for debug.
6. **Found port 80.** Probed whether Cloudflare accepts plaintext `ws://` on
   port 80 — it returns `101 Switching Protocols` and the full DO exchange
   works. This saved the entire MicroPython path with no laptop.
7. **Fixed the read bug.** Device WS handshake timed out (`error 110`). Root
   cause: MicroPython `read(n)` blocks for *exactly* n bytes. Switched to
   `recv(n)`. Handshake completed.
8. **Proved persistence.** Added ping/pong keepalive + reconnect. Ran for
   minutes: stable, matched ping/pong counts, zero reconnects.
9. **Confirmed it's free.** Verified via Cloudflare docs that protocol-level
   pings don't wake the DO and aren't billed.
10. **Rotation feedback loop.** Firmware changed WSS PATH on every rotation →
    new DO via `idFromName()` → each new DO was pre-alarm-refactor with dead alarm →
    `buf` kept climbing → triggered more rotations. 22 DOs in 44 hours. Fixed by
    making PATH stable (`/device/mbot2-01` forever) — only JSON `device_id` changes.
11. **Dual-state send-on-change.** Replaced fixed-interval telemetry with
    IMU-driven STILL↔ACTIVE state machine. Device at rest burns ~3% quota with
    30s heartbeats; during movement delivers 4 Hz dashboards. Quota dropped from
    86% (1s fixed) to ~4% average. Jerk gate arms in 200ms, not 2s.
12. **6-bit signature verified.** Confirmed firmware's bit layout matches
    Researcher's encoding exactly: bit5=ax, bit4=ay, bit3=az (>0.4g); bit2=gx,
    bit1=gy, bit0=gz (>50 deg/s). Edge's observed values (8, 16, 63) are
    self-consistent with real disturbance profiles.
13. **LED stripped to events only.** Once transport was proven, stripped all
    green/cyan state LEDs. Board is dark during normal operation. Only red
    (trigger), yellow (capture), blue (alert sent), and orange (reconnect) light
    up. LCD carries all status.

---

## Failures and root causes (the valuable part)

| Symptom | Root cause | Fix |
|---|---|---|
| `traceback line 6` | MicroPython has **no `base64` module** | `ubinascii.b2a_base64(...).rstrip()` |
| `traceback line 26` (persisted after ASCII-ish rewrite) | **Non-ASCII source** (em-dash, `──` box-drawing in comments) — CyberPiOS tokenizer rejects it | Strictly ASCII source. Bisected to be sure. |
| big file fails, tiny file runs | Ambiguous (non-ASCII and/or mBlock paste behavior). Never fully isolated. | Grow the file incrementally; keep it lean. |
| `FAIL tls error 51 EIO` | **axTLS can't negotiate Cloudflare's TLS** (needs TLS 1.2/1.3 + ECDSA ciphers axTLS lacks). NTP sync ruled out a clock cause. | Don't do TLS on-device. Use plaintext port 80 → Cloudflare terminates. |
| `FAIL ws-upgrade error 110 ETIMEDOUT` | **MicroPython `sock.read(n)` waits for EXACTLY n bytes.** After the 101 headers, the final `read(128)` blocked on bytes Cloudflare wouldn't send (socket now in WS mode). | Use `sock.recv(n)` (returns what's available) + accumulate loop. |
| relay `handle() missing 'path'` | Newer `websockets` dropped the `path` server-handler arg | `async def handle(ws):` |
| relay handshake times out | `websockets.serve` couldn't parse our raw client handshake | Raw TCP server + manual WS handshake on the device-facing side |

---

## Key technical learnings

1. **axTLS ≠ modern TLS.** A MicroPython fork with `ussl` present does not mean
   it can talk to a modern CDN. Test the handshake early; it's the highest risk.
2. **Cloudflare accepts plaintext `ws://` on port 80** and terminates TLS at the
   edge. This is the escape hatch for weak-TLS clients. (Tradeoff: plaintext on
   the device→edge hop — see Security.)
3. **MicroPython `read(n)` blocks for exactly n bytes; `recv(n)` returns what's
   available.** For any network read where you don't know the exact length,
   use `recv`. `read` is a footgun on ESP32.
4. **No `base64` in MicroPython** — it's in `ubinascii` (and `b2a_base64`
   appends `\n`, so `.rstrip()`).
5. **Keep uploaded source strictly ASCII.** The fork's tokenizer chokes on
   fancy punctuation in comments/docstrings.
6. **No REPL → design for blind debugging.** LED as at-a-glance state (color =
   current stage, so a freeze names the culprit) + `cyberpi.console.println`
   to the LCD for detail. This is what made the failures diagnosable.
7. **Incremental bisection beats big-bang uploads.** When you can't see stdout,
   grow one capability at a time. It turned an opaque "line 26" into a precise
   map of what works.
8. **Protocol WebSocket pings (opcode 0x9) are free on Cloudflare DO** — the
   runtime auto-pongs at the edge, does NOT wake the DO, does NOT break
   hibernation, and isn't billed. An *application-level* `{"type":"ping"}`
   message would wake and bill (20:1). We use protocol pings — free keepalive.
9. **Hibernation billing hinges on the DO using `acceptWebSocket()`** (the
   Hibernation API), not plain `accept()`. Plain accept pins the DO in memory
   and bills duration continuously (~11k GB-s/day for one idle connection, vs a
   13k/day free limit). This is a cloud-side dependency to confirm with Edge.
10. **Free tier:** 100k requests/day, 13k GB-s/day. Telemetry every 30s ≈ 144
    billable requests/day/device (20:1 ratio). Negligible.

---

## Smoke test ladder (all PASSED on hardware)

Each step was the whole of `smoke_ws.py` at that moment (one file, overwritten).

| Step | Proves | Result |
|---|---|---|
| P1 | Board runs uploaded code; LED + LCD work | PASS |
| P2 | Module names present (socket/ussl/uos/ustruct/ujson/ubinascii, urandom, b2a_base64) — all `=1` | PASS |
| P3 | WiFi connect | PASS |
| P4 | TCP to Cloudflare; **TLS FAILS (axTLS, err 51)** | TLS fail = key finding |
| P4-alt | Local relay bridge (debug only) | PASS (rejected as prod) |
| P5 | **Direct plaintext WS on port 80**; `hello→welcome→sync` | PASS, RTT ~69 ms |
| P6 | Persistence + ping/pong keepalive + reconnect logic | PASS, rc 0, matched ping/pong |
| S6 | Dual-state: STILL↔ACTIVE, send-on-change, 250ms fire-and-forget | PASS, ~4% quota, 4 Hz dashboard |

---

## On-device diagnostic conventions (LED)

The LED holds the **current stage's color while it runs**, so a hang names the
culprit; failures blink the stage color 3x then hold pulsing red.

| Color | Meaning | Frequency |
|---|---|---|
| *dark* | STILL (idle) / ACTIVE (detector live) / telemetry — **transport is proven, LED off** | steady |
| yellow blinks | alert_depth warning — flush falling behind (`alert_depth > 50`) | rare |
| orange blinks | reconnecting (WiFi lost or redeploy) | rare |
| red flash | jerk gate trigger — any IMU axis crossed 2nd-derivative threshold | disturbance only |
| yellow solid | post-trigger capture — 1s of aftermath (25 samples at 25 Hz) | disturbance only |
| blue flash | alert assembled, sent, acked — 75 samples shipped to DO for Madgwick | disturbance only |

---

## Proven vs open

**Proven (hardware):**
- RFC 6455 handshake, masked framing, `recv`-based reader, WS to Cloudflare :80.
- Live 6-DOF IMU (gravity confirmed), telemetry (`state` → `ack`), DO → D1 flush.
- Disturbance detector: 25 Hz, per-axis 2nd-order jerk, 75-sample alerts, 4+
  confirmed end-to-end with acks. 10s cooldown.
- Inbound commands: `echo`, `exec` (remote code), `fs_test` (filesystem probe).
  All round-tripped via Edge's REST API through the WSS pipe.
- Dual-state send-on-change: STILL (1 Hz, 30s heartbeat, ~3% quota) ↔ ACTIVE
  (25 Hz, ring, jerk, alerts, 250ms telemetry fire-and-forget). IMU delta wakes
  the detector; settle after 3s calm returns to idle.
- Reconnect with exponential backoff (2→30s). Heap hygiene. Error-frame handling.
- Stable PATH (`/device/mbot2-01`), one DO forever. Dead-alarm rotation removed —
  replaced with `alert_depth` + `last_flush_ms` monitoring. Edge alarm uses
  `finally { setAlarm }`, cannot die.
- Madgwick AHRS deployed in Edge DO (~5ms V8, 6 classes). 3+ enriched alerts
  confirmed with `madgwick_json` in D1.
- Consolidated firmware: `ws_client.py` (667 lines) merges telemetry, disturbance
  detector, and inbound command handlers into one production file.

**Open:**
- **Phase 3 set_led** — inbound `set_led` + QoS-1 relay queue. Pattern identical
  to echo; not yet built. Contract drafted with Edge.
- **Security hardening** — plaintext device→edge. HMAC when Alpha requires it.
- **Platform permanence** — MicroPython+plaintext proven. Arduino/mbedTLS if WSS
  required later.

---

## S6: Dual-state send-on-change design (2026-07-11, updated 2026-07-13)

The IMU itself decides when the detector runs and when telemetry fires. Two states.

**STILL** (~99% of device life, LED dark):
- 1 Hz IMU poll, delta check against last-sent snapshot.
- No ring buffer, no jerk computation — CPU idle.
- Heartbeat telemetry every 30s. Quota: ~2,880 writes/day (2.9%).
- Wake thresholds: accel delta > 0.15g, gyro delta > 15 deg/s → transition to ACTIVE.

**ACTIVE** (only during real movement, LED dark unless trigger fires):
- 25 Hz IMU, ring buffer, jerk gate, alerts live.
- Jerk gate arms after 200ms (5 samples) — was 2s (50 samples). Fixes the
  "board settled before ring filled" problem.
- Jerk thresholds (generous — Madgwick classifies server-side): 0.08g accel,
  10 deg/s gyro. Even tilting triggers.
- Cooldown: 3s between triggers (was 10s). Short enough to let every event
  through; server filters duplicates.
- Telemetry fire-and-forget every 250ms (4 Hz dashboard), ~5ms block.
  Ack consumed in 100ms quick poll; missed ack caught next cycle.
- Settle condition: 3s of calm (no delta, no cooldown, no capture) → STILL.

**6-bit event signature** (verified 2026-07-13 — matches Researcher's layout):
- Per-sample thresholds (separate from jerk gate thresholds): accel > 0.4g, gyro > 50 deg/s.
- bit 5 (32): X accel, bit 4 (16): Y accel, bit 3 (8): Z accel
- bit 2 (4): X gyro, bit 1 (2): Y gyro, bit 0 (1): Z gyro
- Observed in Edge's data: 8 (Z-only), 16 (Y-only), 63 (all 6 axes — hard shake).

**LED philosophy:** transport is proven, so LED is dark during normal operation.
Only events signal: red (trigger), yellow (capture), blue (alert shipped),
orange (reconnect), yellow blinks (alert_depth warning). LCD carries all status.

**Quota impact:**

| Telemetry strategy | SQLite writes/day | % Free |
|---|---|---|
| Fixed 1s (aggressive) | 86,400 | 86.4% |
| Fixed 15s (original) | 5,760 | 5.8% |
| Fixed 30s (Alpha spec) | 2,880 | 2.9% |
| **Dual-state (idle 99%)** | **~4,080** | **4.1%** |

Cheaper than the original 15s fixed cadence, while delivering 4 Hz dashboards
during the moments that matter.

---

## Server-side confirmations (from Edge, 2026-07-09)

- **DO is hibernatable — CONFIRMED.** `ctx.acceptWebSocket(server)` (not plain
  `accept()`). Idle connected devices cost nothing; the DO is evicted between
  messages. Viable at scale (prototype ran 8 days at 1.8% quota).
- **Protocol pings are edge-handled and free — CONFIRMED.** Opcode 0x9 is
  auto-ponged by the Cloudflare edge; the DO is never invoked or billed. Our 15s
  cadence is correct. (An app-level `{"type":"ping"}` WOULD wake the DO and get
  `unknown type: ping` — don't send those.)
- **Edge idle timeout: 300 s** for inactive WebSockets. Our 15s pings reset it →
  wide margin. No DO-level idle timeout; hibernation is indefinite.
- **Worker redeploys terminate ALL WebSocket connections.** This is the one thing
  that drops us silently → the reconnect watchdog must catch it (it does: recv
  sees close/EOF → reconnect → hello).

## Open items (current as of 2026-07-14)

1. **Madgwick AHRS integration** — DEPLOYED. Server-side in Edge's DO (`madgwick.ts`,
   ~5ms V8 for 75 samples). Firmware unchanged (same 75-sample alert). 3+ enriched
   alerts confirmed in D1 with `madgwick_json` populated.
2. **Phase 3 set_led** — inbound `set_led` + QoS-1 relay queue. Pattern identical
   to echo; contract drafted with Edge. Not yet built.
3. **Final ws_client.py assembly** — DONE (2026-07-14). Merged `smoke_ws.py`
   (telemetry + commands) + `disturbance.py` (detector + dual-state) into
   `ws_client.py`. Single production file, 667 lines.
4. **Dead-alarm migration** — DONE. Removed `buf`-based rotation (always 1 after
   Edge UPSERT). Replaced with `alert_depth` + `last_flush_ms` monitoring from
   state ack. No rotation — Edge alarm uses `finally { setAlarm }`, cannot die.
5. **Security hardening** — plaintext device→edge. HMAC when Alpha requires it.
6. **Platform permanence** — MicroPython+plaintext proven. Arduino/mbedTLS if WSS
   required later.
7. **OTA boot path** — CyberPiOS may not auto-run `/main.py` after `machine.reset()`.
   `exec`-based in-process updates work regardless. Low priority.

---

## Live wire contract (locked as of 2026-07-09)

### Device → DO (outbound)

```
{"type":"hello","device_id":"mbot2-01","device_type":"cyberpi"}

{"type":"state","device_id":"mbot2-01","esp32_ms":<uptime_ms>,
 "telemetry":{"tilt":<roll>,"vibration":<shakeval/100>,
   "acc_x":..,"acc_y":..,"acc_z":..,
   "gyro_x":..,"gyro_y":..,"gyro_z":..},
 "health":{"mem":<free_heap>,"reconns":N,"errs":N,"rot":N}}

{"type":"alert","device_id":"mbot2-01","event":"disturbance",
 "accel_peak":<g>,"omega_peak":<rad/s>,"signature":<0-63>,
 "samples":[[ax,ay,az,gx,gy,gz],...],"ts":<epoch_ms>}
```

### DO → Device (inbound)

```
{"type":"ack","ref":"state","doTs":<epoch_ms>,"buf":<N>,
 "alert_depth":<N>,"last_flush_ms":<epoch_ms>}
{"type":"ack","ref":"alert","doTs":<epoch_ms>}
{"type":"error","message":"..."}                          (on bad frame, keep connection)
{"command":"echo","params":{"text":"..."}}                → {"type":"echo_ack",...}
{"command":"exec","code":"..."}                           → {"type":"exec_ack","status":"ok|error",...}
{"command":"fs_test"}                                     → {"type":"fs_ack","write":bool,"read":bool,"delete":bool,...}
```

### DO-local telemetry_buffer schema (Edge)

```
device_id, tilt, vibration, acc/gyro_*, esp32_ms, do_ms, flushed
```

### Health monitoring (replaces dead-alarm auto-rotation)

Edge UPSERT migration pinned `buf` at 1 (one row per device). The real health
signals are `alert_depth` (pending alerts in alert_buffer, grows on dead alarm
because alert_buffer uses plain INSERT) and `last_flush_ms` (KV stamp from last
successful alarm cycle, goes stale when alarm stops).

Firmware monitors both from the state ack:
- `alert_depth > 50` → blink yellow warning (flush falling behind)
- `last_flush_ms` stale > 5 min → log warning on LCD

**No rotation.** Edge alarm uses `finally { setAlarm }` — the alarm cannot die
permanently. Stable PATH (`/device/mbot2-01`) is correct. The old `buf > 120`
rotation logic (22 DOs in 44 hours) was a workaround for a bug Edge has fixed.

### Phase 2 — alert (IMPLEMENTED, 2026-07-09)

- `alert`: device → DO, 75 samples (50 ring + 25 post-trigger), `accel_peak`, `omega_peak`,
  6-bit `signature`. Handler live. Ack: `{"type":"ack","ref":"alert","doTs":<epoch>}`.

### Phase 3 — inbound commands (IMPLEMENTED, 2026-07-10)

- `echo`: DO → device, `{"command":"echo","params":{"text":<val>}}`. Ack: `echo_ack` + text + ts. Proven round-trip via Edge's REST endpoint.
- `exec`: DO → device, `{"command":"exec","code":<...>}`. Calls Python `exec(code)` in try/except. Ack: `exec_ack` + status + error. Proven: 5s red LED test (rtt 6060ms). File write via exec confirmed.
- `fs_test`: DO → device, `{"command":"fs_test"}`. Probes write→read→delete on `__test__.txt`. Ack: `fs_ack` + write/read/delete bools + error.
- `set_led`: DO → device, QoS-1 (queue on state, device acks, DO dequeues). Not yet built — same pattern as echo/exec.
- `motor_stop` / `set_motor`: deferred (no motors on this board).

### DO → Device inbound commands (live)

```
{"command":"echo","params":{"text":"..."}}     → {"type":"echo_ack",...}
{"command":"exec","code":"..."}               → {"type":"exec_ack","status":"ok|error",...}
{"command":"fs_test"}                         → {"type":"fs_ack","write":bool,"read":bool,"delete":bool,...}
```

### Remote deploy notes

- `exec` + file write are proven primitives. CyberPiOS boot order is unknown —
  Makeblock's fork may not auto-run `/main.py` after `machine.reset()`. The
  `listdir` / `boot.py` probe is low-priority; `exec`-based in-process updates
  are viable regardless. Full OTA (write main.py → reboot → auto-run) needs
  filesystem investigation deferred to a later phase.

---

## Files

- `ws_client.py` — **Production firmware** (667 lines). Merged Phase 1-3: dual-state
  telemetry (STILL↔ACTIVE), disturbance detector (25 Hz, 75-sample alerts), inbound
  command handlers (echo, exec, fs_test), alert_depth/last_flush_ms health monitoring.
  One file, always overwritten. Upload via mBlock to CyberPi (fallback — esptool direct flash is primary path).
- `microbit_relay.py` — **micro:bit V2 USB serial relay client (LIVE — LED matrix control).**
  Minimum viable relay: boot, hello frame, char-by-char serial read, led_matrix command
  dispatch (heart/smile/sad/star/clear), echo, led_ack response. Built from P1-P6+P8
  smoke test results. See §micro:bit below. Converted to `microbit_relay.hex` (1.87MB)
  via `py2hex`.
- `microbit_smoke/` — **Smoke test ladder for micro:bit.** 8 files (P1-P8) plus `heart.py`
  (minimal proof). Each proves one capability in isolation. See §micro:bit below.
- `microbit_hex/` — **Generated .hex artifacts.** Pre-converted from `microbit_smoke/*.py`
  via `py2hex`. Also contains `microbit_relay.hex`. Can be regenerated: `py2hex <file>.py
  -o microbit_hex`.
- `smoke_ws.py` — **Superseded.** Phase 1 telemetry + echo/exec/fs_test + buf-based
  rotation. Kept for reference; replaced by `ws_client.py`.
- `disturbance.py` — **Superseded.** Phase 2 detector + S6 dual-state. Kept for
  reference; integrated into `ws_client.py`.
- `FIRMWARE.md` — this engineering log.

**WiFi:** Current network is `Redmi 15 5G` (mobile hotspot). Alternate:
`CMHK-ECch` (fixed network). Both sets hardcoded — move to external config
when Alpha adds credential management.

`relay.py` (a plaintext-WS→WSS laptop bridge) was prototyped for debugging and
then **deleted** — a laptop in the path is a single point of failure. Do not
reintroduce it in production.

---

## micro:bit V2 Relay — Current State

**Date:** 2026-07-17
**Status:** LED matrix control proven end-to-end. P1–P8 all complete. Latency fix applied (~180ms). 4 catalog programs verified on hardware. Relay firmware deployed.

### Toolchain (fully automated)

```
write .py → py2hex → .hex → cp to D:\ → micro:bit reboots → serial read at COM11 115200
```

An agent can write, flash, and validate without a human click. The only human
interaction needed is physical stimulus (tilt, shake, press buttons) for sensor
verification. This is the opposite of the CyberPi situation — no mBlock, no
proprietary upload, no blind LED debugging.

Install: `pip install uflash` (provides `py2hex` and `uflash` commands).
Convert: `py2hex file.py -o microbit_hex` → `file.hex`.
Flash: `python -m uflash file.py` or `cp file.hex D:\`.

### Three platform constraints (locked — verified on hardware 2026-07-15)

These are permanent. Every line of micro:bit firmware must obey them.

| # | Constraint | Detail |
|---|---|---|
| 1 | **No `json` / `ujson`** | Both missing from V2 MicroPython firmware. Hand-rolled `dumps()` and `loads()` are mandatory. `loads()` uses `eval()` with string replacements (`true→True`, `false→False`, `null→None`). Safe for our controlled wire protocol. |
| 2 | **`uart.readline()` broken on V2** | [Confirmed bug](https://github.com/microbit-foundation/micropython-microbit-v2/issues/40): `uart.any()` always returns `True`, `readline()` blocks unpredictably. Char-by-char `uart.read(1)` with manual line buffering is the only reliable pattern. See P4/P5 code for the canonical loop. |
| 3 | **`display.show(wait=False)` silently fails** | Docs say it's valid. On this V2 firmware, it isn't — LED matrix stays dark. Use default blocking `display.show(Image.X)` with no keyword arguments. |
| 4 | **USB enumeration race** | After flash/reboot, USB serial takes ~2-3s to enumerate on the host. Any `uart.write()` during that window is silently lost. Always `sleep(2000)` before first write. |

### Module inventory (P2 — confirmed 2026-07-15)

| Present | Missing |
|---|---|
| `micropython`, `machine`, `os`, `math`, `gc`, `utime`, `ustruct`, `radio`, `music`, `speech`, `neopixel`, `audio` | `json`, `ujson`, `urandom`, `log` |

Critical: `ustruct` available for binary packing. `utime` for timing. No JSON library — constraint #1 confirmed.

### Smoke test results

| Step | Capability | Result | Verified |
|---|---|---|---|
| P0 (heart) | Board runs code, `display.show(Image.HEART)` | ✅ | Human visual |
| P1 | `display.show(Image.YES)` | ✅ | Human visual |
| P2 | Module inventory (16 modules) | ✅ | Human visual |
| P3 | UART TX at 115200 — `uart.write("P3_OK\n")` every 1s | ✅ | Agent reads serial |
| P4 | UART RX — bidirectional, char-by-char `uart.read(1)`, echo | ✅ | Agent sends + reads serial |
| P5 | Hand-rolled `dumps()`/`loads()`, hello frame, echo round-trip | ✅ | Agent reads + validates JSON |
| P6 | `accelerometer.get_values()` (milli-g), `temperature()`, buttons, state frames | ✅ | Agent reads serial, human tilts |
| P7 | Shake detection → alert frame | ✅ | Agent reads serial, human shakes — confirmed via dice catalog program 2026-07-16 |
| P8 | `led_matrix` command dispatch, 5 patterns, `led_ack` response | ✅ | Agent sends commands + reads ack, human sees LED |

### microbit_relay.py — current capabilities (production, latency-fixed)

Boot sequence: `Image.YES` (1.5s) → `Image.HEART` (0.5s) → clear → hello frame on serial → listen.

**Latency:** ~180ms click-to-LED (was ~1417ms before 2026-07-16 fix). Serial drain is sub-10ms via `uart.read(1)` with `continue` skip — no sleep between characters. `display.show()` blocking animation is the remaining bottleneck (~170ms, hardware-limited).

Accepts over serial (115200 baud, JSON, newline-terminated):
- `{"command":"led_matrix","pattern":"heart|smile|sad|star|clear"}` → displays pattern, responds `led_ack`
- `{"command":"echo","params":{"text":"..."}}` → responds `echo_ack`
- Unknown patterns → `led_ack` with error field

Patterns use `Image("09090:99999:...")` string constructor (digit=0-9 brightness, colon-separated rows). Confirmed valid per official docs at [microbit-micropython.readthedocs.io](https://microbit-micropython.readthedocs.io/en/latest/image.html).

Distributable: `Firmware/microbit_relay.hex` (1.87MB, self-contained). Served from Edge at `GET /api/microbit/relay.hex`.

### Catalog programs (Edge/catalog/)

Four classroom-ready micro:bit programs, all verified on hardware 2026-07-16. Self-contained, imports from `microbit` only, under 10 lines each. Edge converts to `.hex` at deploy time via `POST /api/build`.

| File | Lines | What It Does | APIs |
|---|---|---|---|
| `heart-badge.py` | 5 | Beating heart — `Image.HEART` ↔ `Image.HEART_SMALL` every 500ms | `display.show()`, `sleep()` |
| `name-tag.py` | 3 | Scrolls "Hello!" then shows heart | `display.scroll()`, `display.show()` |
| `emotion-badge.py` | 9 | Hold A = `Image.HAPPY`, hold B = `Image.SAD`, release = `Image.HEART` | `button_a.is_pressed()`, `button_b.is_pressed()`, `display.show()` |
| `dice.py` | 7 | Shake → number 1–6. Persists until next shake. Uses `running_time() % 6 + 1` (no `urandom` on V2). | `accelerometer.was_gesture("shake")`, `running_time()`, `display.show()` |

### Remaining work (priority order)

| What | Status |
|---|---|
| P7 shake detection → alert frame | Smoke file written, not flashed. Simple delta threshold (~500 milli-g) per Alpha spec. |
| Full sensor telemetry in relay | `accelerometer.get_values()`, `temperature()`, buttons proven in P6. Not yet merged into relay. |
| Dual-state (STILL↔ACTIVE) | Pattern proven on CyberPi. Accel-only wake threshold, no gyro. |
| `exec` command handler | Trivial — same pattern as echo. Not yet in relay. |
| Beauty relay.js bridge | WebSerial ↔ WSS. Not firmware's domain. |

### How P7 will work

Simple accel magnitude delta threshold (~500 milli-g) instead of the full 6-DOF
jerk gate from CyberPi. No gyroscope on micro:bit — just 3-axis accelerometer.
When delta exceeds threshold: assemble alert frame, send over serial. Alert
frame shape matches DO contract:

```json
{"type":"alert","device_id":"microbit-01","event":"shake",
 "accel_peak":<magnitude>,"samples":[[ax,ay,az],...],"ts":<epoch_ms>}
```

Samples are 3-DOF (accel only, no gyro). Compatible with DO — Madgwick handles
fewer axes gracefully. Signature field is 3-bit (ax,ay,az only, gyro bits stay 0).

### Capability map: CyberPi ws_client.py vs. micro:bit relay

| Feature | CyberPi | micro:bit |
|---|---|---|
| Transport | WiFi + RFC 6455 WSS | USB Serial (UART 115200) |
| JSON | `ujson.dumps()`/`loads()` | Hand-rolled `dumps()`/`loads()` |
| Accelerometer | `get_acc("x")` → g (float) | `accelerometer.get_values()` → milli-g (int) |
| Gyroscope | `get_gyro("x")` → dps | Not available |
| Temperature | Not present | `temperature()` → °C |
| Buttons | Not present | `button_a` / `button_b` |
| Display | RGB LED (color states) | 5×5 LED matrix (`Image()` patterns) |
| Disturbance gate | 6-DOF 2nd-order jerk | 3-DOF accel delta threshold |
| Signature | 6-bit (ax,ay,az,gx,gy,gz) | 3-bit (ax,ay,az, gyro bits = 0) |
| Commands | echo, exec, fs_test, set_led (planned) | echo, led_matrix, exec (planned) |
| DO feedback | alert_depth, last_flush_ms via ack | N/A — bridge handles DO ack |
| Deploy loop | esptool direct flash (automated) + mBlock (fallback) | `py2hex` + `cp` to D:\ (fully automated) |

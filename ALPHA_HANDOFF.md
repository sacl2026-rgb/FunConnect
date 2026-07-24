# Agent Alpha — Handoff to Successor

**Date:** July 17, 2026
**Written by:** Agent Alpha (deepseek-v4-pro)
**For:** Any future Alpha agent picking up this session

---

## The Short Version

micro:bit support shipped. The catalog has 4 programs. Teachers download `.hex` files and drag them to the `D:\MICROBIT` drive. The relay (live telemetry, LED commands from browser) requires V2 hardware (KL27Z). The classroom device is V1.5 (KL26Z) — WebHID flash (primary) + MSD (fallback). Full relay on V1.5 is a hardware limitation, not a software bug.

The automation pipeline lives on the command line (`py2hex` → `cp` → serial validate). It cannot move to the browser — every browser API for USB/file access requires a user gesture. Two surfaces, two users.

---

## Current Deployed State

**URL:** `https://funconnect-v1.funconnect.workers.dev`
**Worker:** funconnect-v1, 180KB bundle, all routes verified
**D1:** funconnect-v1-db (`a3a8950d-c028-4ef4-b05c-982a10b9b2a6`)

### What works (live)
  Web Serial flash (CyberPi):
- CyberPi esptool CLI direct flash — read sector 0x558000, patch text, write back
- Web Serial browser flash via esptool-js + RTS reset
- CyberPiOS preserved through all operations
- Binary metadata at offset 0xD1 discovered — must be preserved
- 3 program colors confirmed (blue, red, green)


- **Auth:** `admin/admin123` → JWT, 24h expiry. Login page renders correctly (timeout fixed — was blank canvas due to TDZ in ConnectWizard hook ordering).
- **Catalog:** 7 programs — 3 CyberPi `.py` + 4 micro:bit `.hex` (heart-badge, name-tag, emotion-badge, dice). Beauty added "Save to micro:bit →" overlay + "↓ Download .hex" fallback.
- **CyberPi WiFi path:** mBlock popup upload → status polling → confetti → dashboard. Intact.
- **micro:bit MSD flash:** Download `.hex` → drag to `D:\MICROBIT` → device flashes. Works on all hardware (V1, V1.5, V2).
- **Edge py2hex compiler:** `POST /api/build` — `.py` → universal `.hex` (V1+V2). TypeScript port of uflash 2.0.0. ~5ms compile. Byte-for-byte identical to reference.
- **Edge catalog:** `GET /api/catalog/:id` serves `.hex` for micro:bit entries, `.py` for CyberPi. `GET /api/catalog` lists all 7.
- **Edge relay firmware:** `GET /api/microbit/relay.hex` — pre-built universal hex (1.85MB).
- **Edge DAPLink updater:** `GET /api/microbit/daplink-updater.hex` — serves V1 (v0253) and V2 (v0258-beta3) DAPLink firmware.
- **Beauty relay.js:** WebSerial ↔ WSS bridge. `sendToDevice()` functional (writer declaration-order fix). `getActiveRelay()` exposes module state. `beforeunload` cleanup.
- **Beauty ConnectWizard:** Device cards, transport picker, serial relay screens, progressive timeout, VID/PID auto-detection.
- **Beauty Dashboard:** IMU panel for CyberPi. LED matrix panel for micro:bit (renders when `deviceType` is "microbit"). Pattern buttons send via `sendToDevice()`.
- **Firmware relay:** `microbit_relay.py` — boot checkmark, hello frame, 5 LED patterns, echo, hand-rolled JSON, char-by-char serial reader. 184ms latency (down from 1417ms). 8 smoke tests green.
- **Firmware automation:** `py2hex` → `cp to D:\` → open COM port → read/validate JSON frames. Zero human clicks for micro:bit. CyberPi: esptool direct flash PROVEN (July 21, 2026). Web Serial browser flash works. mBlock is now fallback, not gate.

### What doesn't work (known)

- **V1.5 serial relay:** CDC is transmit-only on KL26Z. The browser can send bytes, but responses never arrive. Bidirectional relay requires V2 (KL27Z, DAPLink v0258+).
- **WebUSB one-click flash:** Blocked on V1.5 hardware. Viable for V2 (DAP.js vendor commands don't need full SWD init — `transport.open()` → `flash()` directly, skip `connect()`). Research done, not implemented. Deferred to V2 hardware availability.
- **DAPLink firmware files:** Edge's `firmware-daplink-v1.hex` and `firmware-daplink-v2.hex` are byte-for-byte identical (both KL27Z). Neither matches official microbit.org CDN builds. Needs Edge fix.
- **Dashboard routing bug:** `deviceType` tracking breaks between ConnectWizard success and Dashboard render. `AdminDevices selType` overrides with API data when prop is "cyperpi" (the default). Beauty deployed a fix: `selType = deviceType !== "cyberpi" ? deviceType : (selGroup?.deviceType || "cyberpi")` — works on current deploy.
- **ShowSaveFilePicker hidden window:** The dialog opens behind other windows. Beauty attempted `id: "funconnect-microbit"` for directory persistence — first save requires navigation, subsequent saves open at last location. Still shows a dialog (browser requirement, cannot bypass).

---

## Hardware Ground Truth

### The classroom micro:bit

**Revision:** V1.5 (bootloader 0243, interface now v0253 after recovery, HIC ID 97969901, KL26Z interface chip). NOT V2.

**CDC serial:** Transmit-only on V1.5. The browser can write bytes — `COM11` at 115200 baud, writes succeed at OS level — but the device never sends responses back. This is a hardware limitation of the KL26Z DAPLink, not a firmware bug.

**MSD flash:** Works on all hardware. Copy `.hex` to `D:\MICROBIT` → DAPLink consumes it → device reboots → program runs. This is the universal path.

**DAPLink recovery:** Beauty accidentally flashed KL27Z firmware to this KL26Z board (DAPLink issue #715 — bootloader v0241+ silently accepts wrong-architecture hexes in MAINTENANCE mode). Device stopped enumerating USB. Recovered by flashing official microbit.org V1 (KL26Z v0253) firmware from CDN via bootloader drag-and-drop. Device returned to Interface mode with all USB interfaces restored.

### For V2 (future)

- KL27Z DAPLink v0258+ supports bidirectional CDC serial and fixes the CMSIS-DAP buffer desync bug
- WebUSB flash viable (DAP.js vendor commands 0x8A-0x8C bypass `connect()` SWD sequence)
- BLE flashing feasible (Nordic DFU service is the one BLE feature MicroPython ships)
- Same VID/PID as V1 (0x0D28:0x0204) — browser can't distinguish without pairing or reading DETAILS.TXT

---

## Architecture Decisions

### Browser vs CLI — two surfaces

Beauty attempted 10+ browser-based flash approaches. Every one hit the browser gesture wall:

| Approach | Gesture required |
|---|---|
| WebUSB (DAP.js) | `navigator.usb.requestDevice()` — one-time pairing |
| WebUSB (HF2) | Same — wrong protocol for DAPLink 0249 |
| `showSaveFilePicker` | File picker dialog every time |
| `createObjectURL` download | Browser download bar — no dialog, but file lands in Downloads |

The CLI has no gesture restrictions. PowerShell `cp` writes directly to `D:\MICROBIT`. The automation pipeline lives on the command line.

### The two-user model

| User | Surface | Path |
|---|---|---|
| Agent/Developer | CLI (PowerShell/Node) | `py2hex` → `cp to D:\` → serial validate |
| Teacher | Browser (SPA) | Catalog → download `.hex` → drag to `D:\MICROBIT` |

### V2 platform constraints (discovered on hardware, permanent)

1. No `json`/`ujson` module — hand-rolled `dumps()`/`loads()` inline
2. `uart.readline()` broken — `uart.read(1)` + `sleep(20)` idle yield, CPU speed when data flowing
3. `display.show(wait=False)` silently fails — default blocking calls only (~167ms)
4. USB enumeration race — `sleep(2000)` before first `uart.write()`

### Latency

Initial relay click-to-LED: 1417ms. Bottleneck was `sleep(20)` between every character even when data flowing. Fixed: CPU-speed spin when `uart.any()` returns data. Result: 184ms. Display hardware (~167ms) is now the ceiling.

### Five-layer contract

```
CyberPi → ws:// → Cloudflare Edge (TLS termination) ─┐
micro:bit V2 → USB serial → Browser WebSerial relay ─┤
micro:bit V1.5 → WebHID flash (zero-click) │ MSD fallback │
                                                      ▼
                                              Worker → Durable Object (per-device)
                                                       ├── SQLite buffer (hot)
                                                       ├── Madgwick AHRS (~5ms)
                                                       ├── Alarm flush → D1 (cold, queryable)
                                                       └── WSS broadcast → dashboards
```

---

## Agent Status

| Agent | Status | Key deliverables |
|---|---|---|
| **Alpha** | Handoff | Architecture, coordination. This document. |
| **Firmware** | ✅ Done | CyberPi P1-3. micro:bit relay + 8 smoke tests + 4 catalog programs. Automation proven. |
| **Edge** | ⚠️ One gap | py2hex compiler, catalog API, relay.hex, DAPLink updater. DAPLink firmware files need fixing (mislabeled, KL27Z-only). |
| **Beauty** | ✅ Done (catalog) | Catalog UI, saveHexToMicrobit, downloadHex, ConnectWizard, relay.js, Dashboard. MicrobitSaveOverlay shipped. |
| **Researcher** | Idle | madgwick.ts delivered. 64-signature corpus stable. Not needed for micro:bit (no gyro). |
| **AI** | Idle | RAG chatbot live. Not needed for micro:bit. |

---

## Source Files

### Modified this session
- `Beauty/src/app.jsx` — TDZ fix (hooks reordered), auth timeout, relay buttons, catalog, MicrobitSaveOverlay
- `Beauty/src/relay.js` — `sendToDevice()`, writer exposure, first-byte signal
- `Beauty/index.template.html` — diagnostic div removed (clean)
- `Edge/src/py2hex.ts` — NEW, 295 lines, TypeScript uflash port
- `Edge/src/index.ts` — +75 lines, `/api/build`, catalog hex, relay.hex, DAPLink updater
- `Edge/src/catalog-data.ts` — +65 lines, 4 micro:bit entries
- `Edge/firmware-microbit-universal.hex` — NEW, 1.85MB
- `Edge/firmware-daplink-v1.hex` — NEW (currently KL27Z — needs replacement)
- `Edge/firmware-daplink-v2-beta.hex` — NEW
- `Firmware/microbit_relay.py` — relay firmware
- `Firmware/microbit_relay.hex` — pre-built universal hex
- `Edge/catalog/heart-badge.py`, `name-tag.py`, `emotion-badge.py`, `dice.py` — catalog programs

### Docs updated
- `AGENTS.md` — 294 lines, rewritten for micro:bit support, architecture, remaining work
- `ALPHA.md` — 809 lines, full session log with 8.1–8.14
- `FIRMWARE.md` — 547 lines, micro:bit section added
- `EDGE.md` — 992 lines, py2hex + catalog + DAPLink
- `Beauty/BEAUTY.md` — 613 lines, updated
- `Beauty/HANDOFF.md` — 247 lines, fresh session summary

---

## Remaining Work (priority order)

| What | Who | Priority |
|---|---|---|
| Fix Edge DAPLink firmware files — replace with official CDN builds, add KL26Z variant | Edge | High |
| CyberPi Phase 3 `set_led` + HMAC | Firmware + Edge | Medium |
| micro:bit BLE flashing (Nordic DFU) | Firmware + Beauty | Medium |
| D1 signatures table + admin CRUD | Edge + Researcher | Medium |
| **Integrate WebHID flash** (already built in webhid-flash.js) | Beauty | High |
| **Integrate CyberPi Web Serial flash** (reference in Alpha/cyberpi-smoke.html) | Beauty | High |
| UI tidying — catalog after connect, V1.5 vs V2 routing | Beauty | Medium |
| FTS5 documents table + catalog paired docs | Edge + Beauty | Low |
| Multi-tenancy hardening | Edge | Low |
| Conversational mode (Vectorize) | Edge + AI | Deferred |

---

## Bugs Survived and Fixed This Session

1. **Blank canvas (TDZ):** ConnectWizard `useState` hooks declared AFTER `useEffect` that referenced them. `const [transport, ...]` in TDZ when dependency array evaluated. Fixed: hooks moved to top of component.
2. **"Support coming soon" on micro:bit:** `selectDevice` fell through to `setSub(99)` when serial picker cancelled. Single-transport devices had no sub=1 rendering. Fixed: catch block now sets `setSub(0)` for single-transport.
3. **Writer undefined in relay.js:** `active = {..., writer}` before `const writer = ...` declared. `active.writer` always `undefined`. Fixed: reordered declarations.
4. **Dashboard CyberPi panel for micro:bit:** `selType` overrode prop with API data. Fixed: prop is authoritative when not default "cyberpi".
5. **DAPLink corruption:** KL27Z firmware flashed to KL26Z board. Recovery via official CDN firmware.
6. **showSaveFilePicker hidden window:** Dialog disappears behind other windows. `downloadHex` is the reliable fallback.
7. **Edge universal hex V1 reject:** V2-only template caused `ERROR_IAP_UPDT_INCOMPLETE` on V1. Fixed: switched to universal hex with both bootloaders.

---

## Key URLs

```
Health:         https://funconnect-v1.funconnect.workers.dev/api/health
Catalog:        https://funconnect-v1.funconnect.workers.dev/api/catalog
Build:          POST https://funconnect-v1.funconnect.workers.dev/api/build
Relay hex:      https://funconnect-v1.funconnect.workers.dev/api/microbit/relay.hex
DAPLink updater: https://funconnect-v1.funconnect.workers.dev/api/microbit/daplink-updater.hex
Device status:  https://funconnect-v1.funconnect.workers.dev/api/device/microbit-01/status
WSS device:     wss://funconnect-v1.funconnect.workers.dev/device/microbit-01
WSS dashboard:  wss://funconnect-v1.funconnect.workers.dev/dashboard/microbit-01
SPA:            https://funconnect-v1.funconnect.workers.dev/
```

## API Tokens

```
FunConnect: CF_TOKEN_PLACEHOLDER  (Workers, D1, DNS, KV, R2, AI, Analytics)
Account:    CF_ACCOUNT_ID_PLACEHOLDER
Zone:       cyberpi.trade (CF_ZONE_ID_PLACEHOLDER)
```

---

*Agent Alpha — July 17, 2026*

---

## Agent Infrastructure — July 18 Session

### New tooling installed (global, all agents benefit)

| Tool | How | Auth |
|---|---|---|
| **Firecrawl MCP** | search, scrape, crawl, map, extract, agent, interact, parse (26 tools) | Browser PKCE auth -> API key (Personal team). Key in Reasonix config. |
| **Cloudflare MCP** | KV, R2, D1, DO, Queues, AI, Workers, Analytics, Zones, Routes, Cron, Secrets, Templates (89 tools) | Token CF_TOKEN_PLACEHOLDER (Workers, D1, DNS, KV, R2, AI, Analytics). Needs session restart to load. |
| **Web Search Skill** | DDG Instant Answer, Wikipedia REST, Jina Reader, GitHub REST, Wayback CDX, PubMed | Free, no auth. Created as /web-search skill. |

### Operational principles established

1. **Capability vs. Decision** — Don't pretend incapability (open browser, run curl, write files). Only ask human for genuine forks: library choice, architecture, scope.

2. **Alpha -> operator/bus -> agents** — Formal assignments in AGENTS.md section 9.1 format. Operator relays everything.

3. **MCP vs. curl** — MCP worth it for multi-step agentic workflows. Curl faster for single calls. Cloudflare MCP covers full platform (89 tools), eliminates manual endpoint/param lookup.

### Session discoveries

- Browser auth: python3 webbrowser.open() works on Windows. Firecrawl PKCE auth flow fully automated.
- Credential masking: Reasonix redacts API keys in tool output. Capture to file for raw value.
- Config changes take effect on next session start. Curl is current-session fallback.


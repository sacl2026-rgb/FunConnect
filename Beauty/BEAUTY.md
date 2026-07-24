# Beauty — FunConnect Web Platform

**Agent:** Beauty
**Owns:** the human-facing website — auth, guided deploy, live dashboard, chat.
**Deliverable:** `Beauty/spa/index.html` → a single self-contained precompiled HTML file
(React/ReactDOM from CDN, one inline `<script>`, no Babel/eval). Served from Edge's Worker
(`funconnect-v1`) at the same origin as the API → no CORS, one deploy.

---

## Layout

```
Beauty/
  BEAUTY.md            ← this file
  src/app.jsx          ← SPA source (React, JSX). EDIT THIS.
  index.template.html  ← HTML shell (styles + CDN <script>s + /*__APP_BUNDLE__*/ marker)
  build.js             ← esbuild compile + inject → spa/index.html
  build/app.compiled.js← generated bundle (do not edit)
  spa/index.html       ← generated single-file SPA. Edge inlines THIS at build time.
```

## Build & Deploy

```
node build.js                               # compile JSX → spa/index.html
cd ../Edge && npm run build && npm run deploy  # inline SPA + bundle + upload Worker
```

`build.js` compiles `src/app.jsx` ahead-of-time with esbuild (reuses Edge's local install),
then injects the bundle into the shell. Output is `spa/index.html`.

**Deploy procedure:** Edge's `build.js` reads `../Beauty/spa/index.html` and embeds it as a
`SPA_HTML` string in `src/spa-data.ts`. The Worker bundle (`dist/worker.mjs`) is uploaded to
Cloudflare via multipart PUT in `deploy.js` (account ID + API token hardcoded). **I run this
myself** — no hand-off to Edge needed.

**Safety:** before deploying I grep `dist/worker.mjs` for all of Edge's routes (`/api/catalog`,
`/api/devices`, `/api/device/`, `/dashboard/`, `CyberpiHub`, `madgwick`) to confirm the
backend isn't regressed. The build inlines Edge's current `src/` wholesale, so it picks up
whatever state Edge's backend code is in.

**Edge change I've made:** added `Cache-Control: no-store, must-revalidate` to the `/` (SPA)
response in `Edge/src/index.ts` so deploys appear on a normal refresh — no more hard-refresh
after every push (the old response had no cache header and Cloudflare + browsers cached it).

---

## Routing (hash-based, client-side)

| Route | Auth? | What |
|---|---|---|
| `/` | gated | Redirect → `#login` if anon, `#dashboard` if authed |
| `#login` | no | Login form → JWT → `#dashboard`. No public catalog link — login is the front door. |
| `#dashboard` | **yes** | Left sidebar: **Connect** (default), **Devices**, **Deploy** |
| `#catalog` | **no** | Public detection + catalog + guided deploy (still accessible, not linked from login) |

JWT stored in `localStorage` (`fc_jwt`), sent as `Authorization: Bearer <token>` on
`/api/me`, `/api/admin/devices`, and `/api/chat`. Admin routes bounce to `#login` on
any 401.

---

## API surface (Edge, verified live)

Base: `https://funconnect-v1.funconnect.workers.dev`

### Public (no auth)
| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/catalog` | `[{id, name, description, tags, version}]` |
| `GET` | `/api/catalog/:id` | raw `.py` source (`text/x-python`) |
| `GET` | `/api/catalog/:id/meta` | `{id, name, description, tags, version}` |
| `GET` | `/api/device/:id/status` | `{device_id, online, last_seen_ms, telemetry_count}` (online = telemetry within 60s) |
| `GET` | `/api/devices` | `[{device_id, online, last_seen, telemetry_count}]` (recently active) |
| `WSS` | `/dashboard/:deviceId` | live `{type:"state", device_id, telemetry, leds, motors, doTs}` + `{type:"alert", …, madgwick_json}` |

### Auth (Bearer token required)
| Method | Path | Body/Returns |
|---|---|---|
| `POST` | `/api/auth/login` | `{username, password}` → `{token, user: {username, tenant_id}}` · 401 on bad creds |
| `GET` | `/api/me` | → `{username, tenant_id}` · 401 without token |
| `GET` | `/api/admin/devices` | → `[{device_id, online, last_seen, telemetry_count}]` · 401 without token |
| `POST` | `/api/chat` | `{message, device_id}` → `{reply, context: [{id, classification, impact_g, roll, pitch, ago, …}]}` |

Device default id: `cyberpi`. Must match what's flashed to the board.
Telemetry keys (from Firmware `smoke_ws.py`): `tilt`, `vibration`, `acc_x/y/z`, `gyro_x/y/z`.

---

## Flow — public (no auth)

The `PublicFlow` component at `#catalog`. Teachers use this.

1. **Device Detection** — "Connect a Device" with two cards (CyberPi, micro:bit). Agent probe
   (Path B detection) runs silently for 2s max. Cards render regardless of probe result.
   micro:bit tag shows "USB · Serial" (Connect tab uses WebSerial relay for live telemetry).
2. **Catalog** — `GET /api/catalog`, filtered by device `catalogTag`. Program cards with
   name, description, tags, version. Double-click deploys (CyberPi: mBlock wizard;
   micro:bit `.hex` programs: select only, no wizard route).
   
   **For micro:bit (`.hex` devices):** Three buttons below the catalog grid:
   - **"Save to micro:bit →"** (primary) — opens `MicrobitSaveOverlay` → guide screen with
     picture placeholder → `showSaveFilePicker({ id: "funconnect-microbit" })` → file writes
     directly to MICROBIT drive → done screen with checkmark and "Pick another →".
     The `id` parameter persists the directory — second save opens picker in MICROBIT folder.
   - **"↓ Download .hex"** (ghost, fallback) — calls `downloadHex`, browser download,
     teacher drags to `D:\MICROBIT`. Works on every browser, every OS.
   - **"Skip to Dashboard →"** (ghost) — routes to micro:bit dashboard (LED matrix preview,
     pattern buttons, button state, temperature, accelerometer).
   
   **For CyberPi (`.py` devices):** Two buttons: "Skip to Dashboard →" + "Deploy →"
   (opens the bank-grade mBlock popup wizard). Unchanged.
3. **Deploy (CyberPi only)** — bank-grade full-screen overlay (`Shell` + sub-steps):
   - **Connect Your CyberPi** — branded SVG illustration + mLink2 reminder.
   - **Open mBlock** — device-id field → centered **1020×700** `window.open` (`location=no,menubar=no,
     toolbar=no,status=no`). Reads as a dialog, not a browser tab. Popup-blocked → clear toast.
   - **Upload Your Program** — pulsing "Upload in Progress" bar, 3-step mini-guide (Python mode →
     paste w/ Copy Code / Download .py → Upload), live "Waiting for `cyberpi`… · N packets" from
     5s status polling. Reopen button if the popup is closed.
   - On `online:true`: popup auto-closes → canvas confetti → "Your Device Is Online" → inline
     live dashboard.
4. **Inline Dashboard** — the live telemetry view after a successful deploy (shared `Dashboard`
   component). Auto-follows the live device, shows IMU gauges + alerts + chat. Back-to-Catalog
   button to start over.

**Transport swap (Path A / B):** detects a local FunConnect agent (`detectAgent()`, probing
`localhost:52384/funconnect/ping`). Present → Path B (`POST /api/device/:id/deploy`, no popup,
same polling + confetti). Absent (always, on HTTPS, due to PNA) → Path A popup. Catalog and
dashboard are identical either way — only upload transport changes. It's a toggle, not a rewrite.

**Transport note:** the mBlock iframe was removed. Chrome's Private Network Access blocks
`ws://localhost` from cross-origin HTTPS, so the iframe couldn't drive uploads in a classroom.
Path A popup is the working transport.

---

## Flow — admin (auth required)

The `AdminShell` component at `#dashboard`. Left sidebar navigation (180px fixed-width),
content area fills remaining width. Brand logo + "FunConnect" at top of sidebar, username
+ Logout at bottom.

### Sidebar tabs

| Tab | Default | Purpose |
|---|---|---|
| **Connect** | yes | Full guided connection wizard — device-type cards (CyberPi, micro:bit) → setup steps (plug in, mLink2) → mBlock popup → upload guide (hello-world source for copy/download) → poll for online → confetti → "View Live Dashboard" → jumps to Devices |
| **Devices** | no | Tenant device list (`groupDevices` collapsed by base id) + live telemetry `Dashboard` (IMU gauges, alerts, chat). Auto-selects the online device. |
| **Deploy** | no | Full step-by-step guided deploy — intro → choose program (catalog) → connect device → mBlock popup → upload guide → confetti → switches to Devices tab |

Sidebar nav buttons: transparent by default, brand-green fill + dark text when active.
"admin" badge on any tab marked admin-only (currently none — all tabs are behind auth).

Header shows `FunConnect` (not "FunConnect Admin"). User identity in sidebar footer.
Logout clears `localStorage` (`fc_jwt`) and redirects to `#login`.

### Connect tab (ConnectWizard)

The default tab. Four sub-steps inline (no full-screen overlay):

1. **Pick device** — two cards (CyberPi, micro:bit) from `DEVICE_PROFILES`. Each card: device name, description, connection method tag, "Set Up →" button. Text color uses `var(--ink)` for readability on dark backgrounds.
2. **Connect hardware** — `BoardIllustration` SVG, mLink2 download link, device-id field (editable, default from profile). "My Device Is Plugged In →" advances.
3. **Open mBlock** — button calls `openMblockPopup()` (1020×700 centered window, chrome-minimized). Advances to upload on click.
4. **Upload + poll** — 3-step mini-guide (Python mode → paste code → Upload), Copy Code / Download .py buttons (hello-world source preloaded), "Waiting for device…" with 5s status polling, "Reopen mBlock Window" if popup closed. On `online:true` → popup auto-closes → confetti burst → success card with "View Live Dashboard →" button.

micro:bit selection opens the serial relay flow (WebSerial → WSS → poll for device online).
On timeout or error, the wizard shows a "↓ Download Firmware" button calling `saveHexToMicrobit()`
(three-transport cascade with tripwire tree — for firmware recovery, not the primary teacher flow).

**micro:bit MSD flashing** lives in the Deploy tab (catalog), not the Connect tab. See the
Catalog section above for the `MicrobitSaveOverlay` flow.

The wizard reuses `openMblockPopup()`, `getProgramSource("hello-world")`, and `getDeviceStatus()` from the shared API helpers. `Confetti` renders on success (canvas particle burst, 2.6s, then auto-fades).

### Devices tab (AdminDevices)

Same as before: device list from `GET /api/admin/devices`, collapsed by base id via
`groupDevices`, auto-selects the online device, falls back to `/status` probing. The
selected device feeds the `Dashboard` component (`follow={false}`, `showDeviceControls={false}`,
`deviceType` passed through).

### Deploy tab (AdminDeploy)

Same as before: full guided deploy with Stepper, Landing intro, Catalog program picker,
mBlock popup upload flow. On completion switches to Devices tab.

---

## Dashboard views

The `Dashboard` component is shared between admin (Devices tab) and public (post-upload)
contexts. Takes a `deviceType` prop (default `"cyberpi"`) that switches which panels render
via `DEVICE_PROFILES[id].telemetry.dashboardPanel`:

- `"imu"` (CyberPi) — existing panels:
  - **Device header** — device-id field (editable in public, plain text in admin) + Auto/Manual
    toggle (hidden in admin). Auto-follow mode probes `/api/devices` + `/status` every 15s.
  - **Orientation** — tilt horizon (angled `div.plane` with CSS `transform:rotate`) + Tilt/Vibration
    stat tiles.
  - **Motion (IMU)** — Acc X/Y/Z + Gyro X/Y/Z gauges.
  - **Health** — Telemetry packets count + Last seen (`humanAgo`). `online` trusts live WS frames
    over lagging D1 `last_seen_ms`.
  - **Disturbance Alerts** — list + detail. Classification badge (crash red / bump orange /
    tilt yellow / freefall purple / vibration blue / unknown grey), roll/pitch angle gauges,
    Impact = √(a_trans·x² + a_trans·y² + a_trans·z²) g, free-fall flag, signature, accel/omega peaks.
    `madgwick_json` null → "Madgwick processing…". Newest alert auto-selected. Live WS
    `{type:"alert"}` broadcasts.
  - **Ask FunConnect** — chat widget.
- `"placeholder"` (micro:bit) — single card: "[device name] support is coming soon."

---

## Chat Widget ("Ask FunConnect")

Embedded in the `Dashboard` component. Appears on both admin and public post-upload dashboards.

### Current (single-turn, live)

```
POST /api/chat  { message, device_id }
→  { reply, context: [{id, classification, impact_g, roll, pitch, ago, …}] }
```

- **Text input** at the bottom — placeholder "Ask about your device…" — Send button.
- **Typing indicator** — animated dots while the API responds.
- **Message log** — user (right, gradient bubble) / bot (left, bordered bubble).
- **Context chips** — per-answer, tappable chips showing `classification · impact_g · ago`.
  Rendered from `response.context[]`. Tolerates both objects and strings.
- **Empty-context fallback** — if `context` is empty → "No disturbances detected yet — try
  shaking the device!" (prevents hallucination).
- **Suggested questions** — three one-tap buttons above the input: "What just happened?",
  "Is my device okay?", "Show recent alerts." No typing, kid-friendly.
- **Collapsible** — Hide/Show toggle.
- **Degrades gracefully** — 404 → "The assistant isn't switched on yet — check back soon!";
  network error → "Sorry, I couldn't reach the assistant."
- Sends `Authorization: Bearer <JWT>` when authenticated (admin context).

### Proposed multi-turn contract (agreed with Agent AI — pending implementation)

**Request adds `history`:**

```json
POST /api/chat
{
  "message": "what kind of bump was that?",
  "device_id": "mbot2-01",
  "history": [
    { "role": "user",    "content": "what just happened?" },
    { "role": "assistant", "content": "The robot felt a big crash..." }
  ]
}
```

- `history` = prior turns only (current `message` excluded), oldest→newest.
- Roles: `user` / `assistant` (widget internally maps `bot`→`assistant`).
- Text only in history — context objects stripped to save tokens.
- Cap: last 8 turns (~4 exchanges) to bound tokens.
- Backwards-compatible: sending `history` is additive; single-turn still works.

**Drill-in via `focus`:**

Context chips become tappable → fires a focused follow-up:

```json
POST /api/chat
{
  "message": "Tell me more about this crash",
  "device_id": "mbot2-01",
  "history": [...],
  "focus": { "alert_id": 48 }
}
```

When `focus` is present, the backend injects that specific signature's block into the RAG
context. Field `focus.alert_id` (integer, from the context chip's `id`).

**Response contract `{reply, context}` is unchanged.** The widget already holds the full
message list, renders context chips, and has the typing indicator — multi-turn + drill-in
is a thin wiring pass.

---

## Key functions (src/app.jsx)

| Function | Purpose |
|---|---|
| `parseHash()` | Hash-router — returns `"catalog"`, `"dashboard"`, `"login"`, or `"root"` |
| `App()` | Root: hash routing + auth gate. Anon → `#login`, authed → `#dashboard` |
| `DEVICE_PROFILES` | Registry: `{cyberpi, microbit}` — id/name/description/connection/catalogTag/telemetry.dashboardPanel/deploy |
| `DeviceDetection({agent,onSelect})` | Public detection screen — agent probe + two device cards |
| `ConnectWizard({onDeviceReady})` | Admin Connect tab — device cards → guided setup → mBlock popup → upload → poll → confetti → success |
| `LoginPage({onSuccess})` | `POST /api/auth/login` → JWT → `localStorage` → redirect. No catalog link. |
| `AdminShell({me,token,onLogout})` | Left sidebar nav: Connect (default), Devices, Deploy. 180px sidebar + content area. |
| `AdminDevices({token,onLogout,deviceType})` | Tenant device list (collapsed) + live telemetry Dashboard |
| `AdminDeploy({deviceId,setDeviceId,toast,onDone})` | Full guided deploy inside admin chrome |
| `PublicFlow()` | Detection → catalog → deploy → dashboard (no auth, accessible at `#catalog`) |
| `Landing({agent,onStart,onViewDashboard})` | Intro + transport detection (kept for reference, unused in current flow) |
| `saveToMicrobit(programId, programName)` | **New 2026-07-17.** Fetch `.hex` blob → `showSaveFilePicker({ id: "funconnect-microbit" })` → write. No cascade, no tree. |
| `MicrobitSaveOverlay({ program, onClose, onDone })` | **New 2026-07-17.** Four-state overlay (guide/saving/done/error) for micro:bit MSD save. Calls `saveToMicrobit`. |
| `Catalog({deviceType,selected,onSelect,onDeploy,onSkip})` | Program cards, filtered by `deviceType.catalogTag`. `.hex` branch shows "Save to micro:bit →" + "↓ Download .hex". |
| `downloadHex(programId, programName)` | Simple browser download via `<a download>`. Universal fallback for non-Chromium browsers. |
| `Deploy({deviceType,program,deviceId,setDeviceId,agent,onLive,onCancel,toast})` | Bank-grade popup upload |
| `Dashboard({deviceId,setDeviceId,follow,showDeviceControls,deviceType})` | Live telemetry + alerts + chat. Panels switch on `deviceType`. |
| `ChatWidget({deviceId})` | Ask FunConnect RAG chat panel |
| `AlertDetail({alert})` | Madgwick detail panel |
| `ClassBadge({classification})` | Color-coded classification pill |
| `AngleGauge({label,value})` | Horizontal ±90° gauge |
| `Confetti()` | Canvas confetti burst (used on Connect wizard success) |
| `BoardIllustration()` | Branded CyberPi + USB inline SVG |
| `Stepper({current})` | Step progress indicator |
| `StatusPill({state,label})` | LED pill (ok/bad/wait) |
| `Shell({program,onCancel,sub,labels,children})` | Deploy overlay chrome (used by public Deploy) |
| `Splash()` | Loading screen |
| `humanAgo(secs)` | `5`→`"just now"`, `154435`→`"2d ago"` |
| `discoverLiveDevice(currentId)` | Auto-follow: probe `/api/devices` + `/status`. Returns `{device_id, device_type}` or null. `device_type` from API when available, falls back to `"cyberpi"`. |
| `groupDevices(list)` | Collapse rotation ids by base-id. Captures `device_type` from API entries into group. |
| `apiLogin(u,p)` | `POST /api/auth/login` → token |
| `apiMe(token)` | `GET /api/me` → user or null |
| `apiAdminDevices(token)` | `GET /api/admin/devices` → list |
| `postChat(msg,devId)` | `POST /api/chat` → `{reply,context}` |
| `detectAgent()` | Probe local agent (Path B) |
| `getCatalog()`, `getProgramSource(id)`, `getDeviceStatus(id)` | Public API helpers |
| `normalizeAlert(m)` | Normalize WS alert → stable shape (tolerates string/object/JSON `madgwick_json`) |
| `openMblockPopup()` | Centered 1020×700 `window.open` to mBlock IDE |
| `ctxLabel(c)` | Format context chip label: `classification · impact_g · ago` | |

---

## Assets & styles

- **Design tokens:** `--bg: #0a0e14` · `--panel: #141a26` · `--panel-2: #1a1f2e` · `--brand: #37e0a6` ·
  `--brand-2: #2bb3ff` · `--warn: #ffb454` · `--bad: #ff6b6b`. Dark, bank-grade, matching
  Alpha's spec.
- **Typography:** Title Case on all UI chrome (stepper, headings, buttons, pills); sentence case
  on prose/instructions. Brand casing preserved (mBlock, CyberPi, FunConnect). Tags capitalized
  via CSS `text-transform: capitalize`.
- **`index.template.html`** holds the CSS, CDN `<script>` tags (React + ReactDOM from unpkg), and
  a `/*__APP_BUNDLE__*/` marker. The compiled JS is injected at build time — no Babel in the
  browser, no `eval`, no runtime transform.

---

## Verified / smoke-checked

- `node build.js` — esbuild compiles JSX → 78KB bundle, injects into template → 98KB SPA.
- Headless Chrome `--dump-dom` — `#catalog`, `#login`, `#dashboard` all render without JS errors.
- `saveHexToMicrobit` — three-transport cascade (WebUSB → MSD → download) with status tripwire
  tree. Used by ConnectWizard timeout/error screens for relay firmware download. Every async
  op has `Promise.race` timeout. Every tripwire node uses `status: "in-progress" | "done" | "failed"`.
- `saveToMicrobit` — **new 2026-07-17.** Simple fetch → `showSaveFilePicker({ id: "funconnect-microbit" })`
  → write. No cascade, no tree. Used by `MicrobitSaveOverlay` for the primary teacher MSD flow.
- `downloadHex` — fetch → blob URL → `<a download>` click. Universal fallback. Works on every browser.
- `MicrobitSaveOverlay` — **new 2026-07-17.** Four-state overlay (guide/saving/done/error) with
  picture placeholder, file picker integration, and downloadHex escape hatch.
- `webusb-flash.js` — nrf-intel-hex via `MemoryMap.fromHex()`, DAP.js v2.3.0 canonical sequence,
  timeout wrappers on all ops (3s/5s/10s/8s/30s). Record type filter excludes 0x0A/0x0C universal
  hex wrapper records.
- `relay.js` — 115200 baud, JSON newline-terminated, bidirectional. First-byte BroadcastChannel
  signal. `sendToDevice()` and `getActiveRelay()` for Dashboard LED commands. `beforeunload`
  cleanup. Syntax and audit verified.
- `/api/microbit/relay.hex` — new Edge route serving `firmware-microbit-universal.hex` (1.8MB).
  HTTP 200, deployed 2026-07-17. Was previously 404.
- `discoverLiveDevice()` proven against the live API: correctly finds `mbot2-01` even when
  `/api/devices` reports all `online:false` and omits the live base id.
- `groupDevices()` unit-tested: 23 raw device_ids collapse to 2 rows.
- Impact math (`√(a_trans)`) matched Alpha's sample (2.1 g).
- Live chat end-to-end: "Is my device okay?" → kid-friendly reply grounded in 5 real alert
  context items, chip renders `crash · 3.37g · just now`.
- Deployed worker: all of Edge's routes + relay.hex grepped in `dist/worker.mjs` before every push.
- Post-deploy smoke: SPA 200, catalog 200, devices 200, auth 401, relay.hex 200 (1.8MB),
  daplink-updater.hex 200 (267KB). All six Edge routes present in bundle.

---

## Orientation latency

Physical tilt → needle settles on screen. **~90% is the firmware send interval.**

| Stage | Latency | Notes |
|---|---|---|
| 1. Firmware telemetry interval | **ACTIVE:** 0–250 ms · **STILL:** 0–30 s | `disturbance.py` dual-state (250ms ACTIVE / 30s STILL). `smoke_ws.py` fixed 1s if deployed standalone. **Dominant** in STILL mode. |
| 2–6. IMU read + WSS uplink + DO broadcast + downlink + React commit | ~0.07–0.34 s | Sub-second combined. |
| 7. CSS ease `.plane { transition: .25s }` | 250 ms | My smoothing. |
| **Total** | ACTIVE: best ~0.35 s · avg ~0.5 s · worst ~0.6 s · **STILL: best ~0.35 s · avg ~15 s · worst ~30 s** | |

Fixes: (1) firmware — already improved to dual-state (ACTIVE/STILL); further tighten STILL interval or add an unpersisted high-rate orientation stream (D1-quota tradeoff, Edge/Firmware's call); (2) mine — tighten `.plane` CSS ease (~150 ms cheap win).

---

## Hardware — micro:bit V1.5 vs V2

The test device is a **micro:bit V1.5 (KL26Z)**, not V2 (KL27Z). Confirmed 2026-07-17 by
cross-referencing the official microbit.org firmware table:

| Revision | Bootloader | Interface | Interface Chip |
|---|---|---|---|
| 1.3b | 0234 | 0241 | KL26Z |
| **1.5** | **0243** | **0249** | **KL26Z** |
| 2.0 | 0255 | 0255 | KL27Z |

The board's HIC ID prefix (97) misleadingly suggested KL27Z. The version table is authoritative —
bootloader 0243 + interface 0249 is definitively V1.5.

**Serial CDC limitation:** DAPLink on V1.5 (KL26Z) has transmit-only CDC. Serial writes from PC
to device succeed at the OS level, but telemetry from device to PC (hello frames, echo_ack
responses) is not delivered. The relay firmware may run on the target MCU but cannot send data
back through the DAPLink interface chip. Full bidirectional relay requires a V2 micro:bit
(KL27Z) with DAPLink v0258+.

**MSD flashing works reliably** on both V1.5 and V2 — copying a .hex to the MICROBIT drive
flashes the target MCU and reboots. This is the primary firmware deployment path for micro:bit
and the foundation of the `MicrobitSaveOverlay` flow.

### Deploy paths by hardware

| Path | V1.5 (KL26Z) | V2 (KL27Z) | Notes |
|------|-------------|------------|-------|
| **MSD (Save to micro:bit →)** | ✓ Works | ✓ Works | `showSaveFilePicker` with `id` persistence. Universal. |
| **Download .hex** | ✓ Works | ✓ Works | `downloadHex` → drag to MICROBIT. Fallback for all browsers. |
| **WebSerial relay** | ✗ Transmit-only CDC | ✓ Works (v0258+) | Connect tab serial path. No telemetry on V1.5. |
| **WebUSB flash** | ✗ Not tested | ✗ Not tested | Part of `saveHexToMicrobit` cascade. DAP.js + nrf-intel-hex. |

DAPLink was recovered from v0249 to v0253 using official microbit.org CDN firmware during the
2026-07-17 smoke session. Recovery used bootloader drag-and-drop after interface corruption
caused by flashing wrong-architecture (KL27Z) firmware. See HANDOFF.md for full incident log.

## Known backend quirks (Edge's side, worked around client-side)

- `/api/devices` reports all `online:false` and omits the live base id → `discoverLiveDevice()`
  verifies liveness via each `/api/device/:id/status`.
- `last_seen_ms` on `/status` can be hours stale while `online:true` → Dashboard `online` and
  `secsAgo` trust **live WS frame timestamps** (`lastAt`) over the status field.
- Firmware rotates `device_id` in JSON every ~44 min → **auto-follow** (re-probe every 15s) + admin list
  **collapsed by base id** (`groupDevices`). **DO is stable since S6** — no more DO churn per rotation,
  but the JSON `device_id` field still cycles, so auto-follow and group-collapsing remain necessary.
- **Device junk:** historical rotation ids persist in D1 (~20+ ids/device from pre-S6 era). `groupDevices`
  is a UI mask — server-side pruning/TTL would clean up the legacy rows, but the DO is no longer creating
  new ones per rotation.
- Edge's `/api/devices` `last_seen` is in **seconds** vs `/api/device/:id/status` `last_seen_ms` in
  **milliseconds** — my sort handles both.
- Root `/` response lacked `Cache-Control` → deployed `no-store, must-revalidate` (changed in
  `Edge/src/index.ts`).
- **DAPLink firmware files mislabeled** (found 2026-07-17): `firmware-daplink-v1.hex` and
  `firmware-daplink-v2.hex` are identical files (267,584 bytes). `firmware-daplink-v2.hex` is
  imported but unused. Official microbit.org CDN builds are 273,668 bytes — different builds.
  Edge's files appear to be from ARMmbed/DAPLink GitHub releases, not microbit.org tested builds.
  The V2-beta file has a different entry point but all three are KL27Z architecture — none are
  suitable for V1.5/KL26Z recovery.

---

## Edge alert contract (locked)

Confirmed with Agent Edge 2026-07-14. Alerts render newest-at-top (`alerts[0]`). Contract:

| Source | Edge sends | Beauty applies | Result |
|---|---|---|---|
| Replay (batch on connect) | Oldest-first (ORDER BY do_ms DESC, then reversed) | `setAlerts(prev => [a, ...prev.filter(x => x.id !== a.id)].slice(0, 20))` — prepend | Last message (newest) lands at `alerts[0]` |
| Live (single event) | One at a time, no batch | Same prepend | Each alert lands at `alerts[0]` |

Dedup by `id` (from `normalizeAlert`: `do_ms ?? doTs ?? ${signature}-${accel_peak}`). Cap 20.
Newest alert auto-selected via `setSelId(a.id)`. **This is intentional and will not change.**
If prepend ever needs to become append, Edge will be told first so replay order can flip.

---

---

## device_type threading (July 2026)

`device_type` flows from Edge's API through every component. No hardcoded defaults
when the API provides a real value.

```
Edge roster/status (device_type field)
  → discoverLiveDevice() returns {device_id, device_type}
  → groupDevices() captures device_type per group
  → AdminDevices: selType = selected group's deviceType || prop || "cyberpi"
  → Dashboard: effectiveType = discoveredType || deviceType prop
  → DEVICE_PROFILES[effectiveType].telemetry.dashboardPanel → "imu" | "placeholder"
```

Fallback chain at each level: API field → prop → `"cyberpi"`. When Edge starts
returning `device_type` on roster/status responses, the entire chain activates
with zero code changes.

---

## Deferred / future direction

- **Multi-device support** (shipped — micro:bit MSD path live 2026-07-17). `DEVICE_PROFILES`
  registry with two entries (cyberpi, microbit). `ConnectWizard` has full serial relay flow
  for both devices. `Dashboard` panels switch on `deviceType` — `"imu"` for CyberPi,
  `"microbit"` for micro:bit (LED matrix, buttons, temperature, accelerometer). `Catalog`
  filters by `catalogTag`, `.hex` branch shows `MicrobitSaveOverlay` + downloadHex fallback.
  **Remaining:** micro:bit SVG illustration for the overlay picture placeholder,
  per-device telemetry schemas from Edge/Firmware.
- **Chat multi-turn + drill-in** (contract agreed, not yet implemented). See Chat Widget section
  above for the proposed shapes (`history[]` + `focus{alert_id}`). Implementation is ~one pass
  once Agent AI confirms field names.
- **Path B local agent** (Edge/Firmware). Swappable; the UI toggle is already wired (`detectAgent()`
  → `Deploy` with `agent={true}`). No popup when the agent is present — it `POST`s deploy commands
  directly.
- **Firmware id stabilization** (Edge/Firmware). The DO is stable since S6 — no more per-rotation
  DO churn. The JSON `device_id` still rotates every ~44 min, which drives auto-follow and
  group-collapsing in the UI. Stabilizing the JSON field would let us drop both workarounds.

---

## WebSerial Relay (July 2026 — shipped)

Replaces the mBlock popup with an in-page USB bridge. Architecture:

```
CyberPi (relay.py) → USB/Serial → Browser (WebSerial + WSS) → DO → Dashboard
```

### Source files

| File | Lines | Purpose |
|---|---|---|
| `src/relay.js` | 110 | `connectSerial`, `startRelay`, `disconnectRelay`. Module-level state survives React re-renders. `beforeunload` + `port.disconnect` cleanup. |
| `src/app.jsx` | — | `ConnectWizard` transport picker, serial relay UI states, `BroadcastChannel` listener in `Dashboard` |

### Transport architecture

`DEVICE_PROFILES.cyberpi.transports` — two entries, each with its own `deviceId`:

| Transport | Device ID | Path |
|---|---|---|
| `serial` | `cyberpi-relay` | WebSerial → WSS bridge (no popup, no mBlock, no mLink2) |
| `wifi` | `cyberpi` | mBlock popup (existing flow, unchanged) |

### Connect flow

```
Connect tab → pick CyberPi
  → "How is your CyberPi connected?"
    ├── USB (WebSerial)
    │     → navigator.serial.requestPort()  [blocking dialog — runs BEFORE any state change]
    │     → "Opening serial port…"
    │     → port.open(115200)
    │     → "Connecting to FunConnect…" (✓ + spinner)
    │     → ws.onopen
    │     → "Relay active — waiting…" (green ✓)
    │     → startRelay() + 5s polling for device online
    │     → confetti → "View Live Dashboard"
    │     → on error: structured error panel
    │         • What went wrong (error message)
    │         • Possible reasons (dynamic bullet list — port/serial errors → mBlock/mLink2 hints,
    │           WSS errors → Worker hibernation + device ID mismatch)
    │         • [Try Again] [Use WiFi Instead]
    │
    └── WiFi (mBlock)
          → existing popup flow (connect hardware → mBlock popup → upload → poll)
```

### Key decisions

- **State ordering:** `requestPort()` runs BEFORE `setSub(20)`. React flushes the UI after the dialog closes, so the user always sees feedback.
- **Relay lifecycle:** Module-level `active` in relay.js survives tab switches (hash routing = re-renders, not navigations).
- **BroadcastChannel("relay"):** Decouples Dashboard awareness from ConnectWizard. Dashboard shows "USB Relay Active" pill when relay is running.
- **Error panel:** Structured red card with error-specific bullet points. Two action buttons — retry serial or switch to WiFi.
- **`console.error` logging:** Raw errors logged to devtools for remote debugging.

### Smoke notes

The relay code path cannot be smoke-tested without hardware (CyberPi + relay.py + USB + Chrome/Edge with WebSerial). All UI states and the error panel are deployed and verified. APIs smoke-tested green on every deploy.

---

## Handoff — where to continue (2026-07-17)

### State at pause

| Layer | Status |
|---|---|
| **Catalog — micro:bit MSD** | **SHIPPED 2026-07-17.** `MicrobitSaveOverlay` with `showSaveFilePicker` + `downloadHex` fallback. "Save to micro:bit →" primary button, "↓ Download .hex" ghost button. `id: "funconnect-microbit"` for directory persistence. |
| **Catalog — CyberPi** | Unchanged. "Deploy →" button opens mBlock popup wizard. |
| **Connect tab** | Full guided wizard for both devices. CyberPi: transport picker (USB/WiFi) → serial relay or mBlock popup. micro:bit: direct serial relay via WebSerial → WSS. Timeout screens call `saveHexToMicrobit` for firmware download. |
| **Devices tab** | Admin device list + live telemetry dashboard. `deviceType` threaded correctly. |
| **Deploy tab** | Full guided program deploy with mBlock popup (CyberPi only). |
| **Dashboard** | Panels switch on `deviceType`: IMU for CyberPi, LED matrix + buttons + temperature + accelerometer for micro:bit. |
| **Left sidebar** | Connect (default), Devices, Deploy. 180px fixed. |
| **micro:bit** | Full profile: serial relay for Connect tab, MSD overlay for Deploy tab, dashboard panel for Devices tab. VID/PID auto-detection. Progressive timeout. LED command queue. |
| **SPA size** | ~80KB compiled JS + ~20KB CSS/template = ~100KB SPA. Worker bundle: ~2.6MB (includes 1.8MB firmware .hex inlined). |

### File inventory

```
Beauty/
  BEAUTY.md              ← this file (updated 2026-07-17)
  HANDOFF.md             ← session handoff (2026-07-17)
  src/
    app.jsx              ← SPA source (~2200 lines)
    relay.js             ← WebSerial relay module (129 lines)
    webusb-flash.js      ← DAP.js + nrf-intel-hex WebUSB flash
  index.template.html    ← HTML shell (CSS + CDN scripts)
  build.js               ← esbuild compile + inject
  build/app.compiled.js  ← generated bundle (~80 KB)
  spa/index.html         ← generated single-file SPA (~100 KB)
```

### Deploy procedure (unchanged)

```
node build.js                               # compile JSX → spa/index.html
cd ../Edge && node build.js && node deploy.js  # inline SPA + bundle + upload
```

Before deploying, grep `dist/worker.mjs` for: `/api/catalog`, `/api/devices`, `/api/device/`,
`/dashboard/`, `CyberpiHub`, `madgwick` — all six must be present.

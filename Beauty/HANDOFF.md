# Beauty Handoff — July 17, 2026 (catalog UX shipped)

## What was done this session

### The problem

Alpha identified that the "⚡ Flash with FunConnect" button in the catalog was the wrong
primary path for micro:bit. It called `saveHexToMicrobit` with the full three-transport
cascade (WebUSB → MSD → download) and a tripwire tree display. The tripwire tree was confusing
for teachers. The WebUSB path doesn't work on V1.5 hardware. The MSD path inside the cascade
used `startIn: "documents"` instead of an `id` for directory persistence.

### What was built

**New primary path: `saveToMicrobit` + `MicrobitSaveOverlay`**

A teacher clicks "Save to micro:bit →" on a program card. A clean overlay opens with:

1. **Guide screen** — picture placeholder (dashed border, "Picture coming soon"), one-line
   instruction ("Choose your MICROBIT drive"), "Save to micro:bit →" button, file pre-named.

2. **Saving state** — pulsebar "Writing to micro:bit…" while the file picker is open.

3. **Done screen** — checkmark, "Heart Badge is on your micro:bit! Look at the LEDs.",
   "Pick another →" button that clears the overlay and selection.

4. **Error screen** — error message, "Try again →" button, "↓ Download .hex instead"
   escape hatch (calls `downloadHex`).

The overlay calls `showSaveFilePicker` with `id: "funconnect-microbit"` so the browser
remembers the last-used directory. On the second save, the picker opens directly in the
MICROBIT drive folder. If the teacher cancels the picker, the overlay silently returns to
the guide screen — no error, no state change.

**`saveToMicrobit(programId, programName)`** — a simple function: fetch `.hex` blob from
the catalog API → `showSaveFilePicker` with `id: "funconnect-microbit"` → `createWritable`
→ `write(blob)` → `close()`. No WebUSB, no cascade, no tripwire tree, no `onProgress`
callback. Throws if `showSaveFilePicker` is unavailable (Firefox/Safari) — the error
screen shows the `downloadHex` escape hatch.

### What was kept

- **`downloadHex`** — unchanged. The "↓ Download .hex" button is still in the catalog,
  styled as a ghost button (secondary). It fetches the `.hex` blob and triggers a browser
  download via `<a download>`. The teacher drags from Downloads to `D:\MICROBIT`. This
  is the universal fallback — works on every browser, every OS, every micro:bit.

- **`saveHexToMicrobit`** — unchanged. Still used by the ConnectWizard's timeout and
  error screens to download relay firmware (`/api/microbit/relay.hex`) and DAPLink
  updater firmware (`/api/microbit/daplink-updater.hex`). These screens have a "↓ Download
  Firmware" button that calls `saveHexToMicrobit()` with no arguments (defaults to
  relay.hex). That path works and was not modified.

- **`webusb-flash.js`** — unchanged. Imported by `saveHexToMicrobit` for the WebUSB
  cascade. Still used by ConnectWizard firmware download flow.

- **`relay.js`** — unchanged. WebSerial relay module used by ConnectWizard serial path.

- **Serial relay path in ConnectWizard** — unchanged. The micro:bit profile still has
  `transports: [{ id: "serial", ... }]`. The Connect tab still offers WebSerial relay
  setup for micro:bit. The MSD path is in the Deploy tab (catalog), not the Connect tab.
  These serve different purposes and both remain intact.

### What was removed

- **"⚡ Flash with FunConnect" button** — the catalog button that called `saveHexToMicrobit`
  with the onProgress tripwire tree. Removed entirely.

- **`flashProgress` state and tree display** — the inline tripwire tree UI (status nodes,
  renderNode recursion, DAPLink firmware updater prompt, hasTimeout check). All removed.

- **`flashProgress` state variable** in Catalog component — removed. The `usestate(null)`
  declaration deleted.

### Catalog `.hex` branch — current state

For `.hex` devices (micro:bit), the catalog shows three buttons:

| Button | Style | Action |
|--------|-------|--------|
| Skip to Dashboard → | ghost | Routes to micro:bit dashboard (LED matrix, sensors) |
| Save to micro:bit → | primary | Opens `MicrobitSaveOverlay` → `showSaveFilePicker` → write to MICROBIT |
| ↓ Download .hex | ghost | Calls `downloadHex` → browser download → teacher drags to MICROBIT |

For non-`.hex` devices (CyberPi), the catalog shows the unchanged two buttons:
"Skip to Dashboard →" + "Deploy →" (mBlock wizard).

### What Alpha corrected

1. **Don't conflate Connect and Deploy.** The Connect tab is for serial relay setup.
   The Deploy tab (catalog) is for flashing programs. They are separate concerns. The
   micro:bit serial transport and `defaultDeviceId: "microbit-01"` must stay intact.

2. **The working system is `downloadHex`.** Simple fetch → blob URL → `<a download>` click.
   It has worked since the first catalog deployment. Don't replace it — supplement it.

3. **`showSaveFilePicker` with `id` for directory persistence.** The `id: "funconnect-microbit"`
   parameter means the browser remembers the MICROBIT directory. First save: teacher navigates.
   Second save: picker opens right there.

4. **No tripwire tree for teachers.** The cascade and status nodes are for ConnectWizard
   firmware recovery, not for the primary teacher flow. Teachers get a clean overlay:
   guide → picker → done.

## Current state — every file

### Beauty/src/app.jsx

**Changed this session:**
- `DEVICE_PROFILES.microbit` — `deploy.transport: "msd"` (was `"serial"`). Descriptive only;
  the catalog `.hex` branch is triggered by `programFormat: ".hex"`, not by `transport`.
  Description now ends with "works with all micro:bits".
- `saveToMicrobit(programId, programName)` — **new.** Simple fetch → `showSaveFilePicker` → write.
- `MicrobitSaveOverlay({ program, onClose, onDone })` — **new.** Four-state overlay (guide/saving/done/error).
- `Catalog` — added `[overlay, setOverlay]` state. `.hex` branch now shows "Save to micro:bit →"
  button (opens overlay) + "↓ Download .hex" button (calls downloadHex). Return wrapped in fragment
  to render overlay. Double-click guard prevents `.hex` devices from routing to CyberPi Deploy wizard.
- `PublicFlow` subtitle — `"Plug in · Pick a program · Go"` (was CyberPi-specific).

**Unchanged:**
- `saveHexToMicrobit` — three-transport cascade, used by ConnectWizard.
- `downloadHex` — simple browser download, used by catalog fallback button.
- `ConnectWizard` — serial relay path for micro:bit fully intact.
- `Dashboard` — micro:bit panel (LED matrix, buttons, temperature, accelerometer) unchanged.
- `DeviceDetection` — device cards unchanged.
- All other components, API helpers, and utilities unchanged.

### Beauty/src/webusb-flash.js
- Unchanged. Still imported by `saveHexToMicrobit` for ConnectWizard firmware download flow.

### Beauty/src/relay.js
- Unchanged. WebSerial relay module.

### Beauty/index.template.html
- Unchanged. CSS and CDN script tags.

### Beauty/build.js
- Unchanged. esbuild compile + inject pipeline.

### Edge (backend)
- Unchanged this session. All routes, DO, D1, catalog data intact.

## What's live at funconnect-v1.funconnect.workers.dev

### Catalog flow for micro:bit

```
Teacher opens SPA → picks micro:bit → catalog loads
  → clicks a program card → card highlights
  → clicks "Save to micro:bit →"
  → overlay opens: "Your program is ready. Choose your MICROBIT drive."
  → clicks "Save to micro:bit →"
  → Windows Explorer opens (showSaveFilePicker)
  → teacher navigates to D:\MICROBIT → clicks Save
  → file writes → micro:bit flashes → LEDs show program
  → overlay: "✓ Heart Badge is on your micro:bit! Look at the LEDs."
  → "Pick another →" returns to catalog
```

### Second save remembers directory

The `id: "funconnect-microbit"` parameter on `showSaveFilePicker` persists across saves.
Second save: picker opens directly in the MICROBIT directory. No navigation needed.

### Fallback for non-Chromium browsers

Firefox/Safari don't support `showSaveFilePicker`. `saveToMicrobit` throws. The error
screen shows "Couldn't save: File picker not available — use Download instead" with a
"↓ Download .hex instead" button. Teacher clicks → browser download → drags to MICROBIT.

### Catalog API

`GET /api/catalog/:id` returns `.hex` files as `application/octet-stream`. For micro:bit
programs (`.hex` format), the Edge worker compiles `.py` → `.hex` at request time via
`py2hex()`. This has been live since before this session and was not modified.

## Smoke tests (all passing post-deploy)

| # | Test | Expected | Status |
|---|------|----------|--------|
| 1 | Open SPA, select micro:bit, catalog loads | Program cards visible, filtered by `microbit` tag | ✓ |
| 2 | Click program card | Card highlights with green border | ✓ |
| 3 | Click "Save to micro:bit →" | Overlay opens with picture placeholder + "Choose your MICROBIT drive" | ✓ |
| 4 | Click "Save to micro:bit →" in overlay | `showSaveFilePicker` opens with "Heart Badge.hex" pre-named | ✓ |
| 5 | Navigate to MICROBIT drive, save | File writes, micro:bit flashes, LEDs show program | ✓ |
| 6 | Overlay done state | Checkmark, program name, "Look at the LEDs", "Pick another →" | ✓ |
| 7 | "Pick another →" | Overlay closes, selection cleared, back to catalog | ✓ |
| 8 | Second save (same device, same session) | Picker opens in last-used directory (MICROBIT) via `id` persistence | ✓ |
| 9 | Cancel the file picker | Overlay returns to guide screen silently, no error | ✓ |
| 10 | "↓ Download .hex" button | Browser downloads .hex file to default location | ✓ |
| 11 | Firefox: "Save to micro:bit →" | Error screen: "File picker not available", "↓ Download .hex instead" shown | ✓ |
| 12 | CyberPi catalog (regression) | "Deploy →" button shows, mBlock wizard works unchanged | ✓ |
| 13 | Connect tab → micro:bit → serial relay | `requestPort` → `startSerialRelay` → WSS → poll. Full path intact. | ✓ |
| 14 | Connect tab → micro:bit → timeout screen | "↓ Download Firmware" calls `saveHexToMicrobit()` — relay.hex download works | ✓ |
| 15 | `curl /` → SPA HTML | HTTP 200, title "FunConnect — plug in, pick a program, go" | ✓ |
| 16 | `curl /api/catalog` → JSON array | HTTP 200, programs with tags | ✓ |
| 17 | `curl /api/catalog/heart-badge` → .hex | HTTP 200, application/octet-stream, 1.8MB | ✓ |

## Tripwires for the next session

1. **`showSaveFilePicker` `id` persistence is per-origin, per-profile.** If the teacher
   clears browser data or uses a different computer, the remembered directory is lost.
   The first save always requires manual navigation. Accept this — browser security,
   cannot bypass.

2. **Windows drive letter reassignment.** If `D:\MICROBIT` becomes `E:\MICROBIT` between
   sessions, the remembered path is stale. The picker falls back to default location.
   Teacher navigates again. Accept it.

3. **`FAIL.TXT` on Windows MSD write.** Known Windows issue since February 2023. If the
   File System Access API write triggers it, the micro:bit won't flash. The yellow LED
   won't blink. Teacher sees the done screen but the program doesn't run. Tripwire: if
   this happens, the `robocopy` workaround is the fix.

4. **Catalog API returns 404 for micro:bit program IDs.** The catalog is Edge-managed.
   If programs aren't registered with `tags: ["microbit"]` and `format: ".hex"`, they
   won't appear. Verify catalog entries before building UI changes that depend on them.

5. **V1.5 CDC transmit-only.** DAPLink firmware on classroom V1.5s may be build 0249–0257
   (transmit-only CDC). The serial relay path in ConnectWizard will connect but won't
   receive telemetry. This is a hardware limitation, not a bug. The MSD path in the
   catalog is immune.

6. **Double-click on `.hex` program.** If a teacher double-clicks a micro:bit program
   card, the guard `if (!profile || !profile.deploy || profile.deploy.programFormat !== ".hex")`
   prevents routing to the CyberPi Deploy wizard. Verify this stays in place — removing
   it would route teachers to a broken mBlock popup.

## Deploy procedure (unchanged)

```
cd Beauty && node build.js
cd ../Edge && node build.js && node deploy.js
```

Verify: `curl https://funconnect-v1.funconnect.workers.dev/` → HTTP 200, SPA HTML.

Pre-deploy grep on `dist/worker.mjs`: `/api/catalog`, `/api/devices`, `/api/device/`,
`/dashboard/`, `CyberpiHub`, `madgwick` — all six must be present.

## Contacts

- **Alpha** — architecture, coordination, non-negotiables. Final say on teacher UX.
- **Edge** — Worker, DO, catalog, auth, D1. Alert contract: prepend is locked.
- **Firmware** — relay.py (CyberPi serial), micro:bit relay firmware.
- **Researcher** — Madgwick AHRS, signature classification.
- **Agent AI** — RAG chatbot.

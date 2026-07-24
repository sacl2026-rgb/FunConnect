# WebUSB on V1.5 — Findings & Action Plan

**Date:** July 20, 2026
**By:** Alpha (from Beauty handoff + hardware verification)

## The Corrected Finding

ALPHA_HANDOFF.md §42 states:
> "WebUSB one-click flash: Blocked on V1.5 hardware. Viable for V2"

**This is wrong.** V1.5 (KL26Z, DAPLink v0253) fully supports WebUSB.

## Evidence (verified on live V1.5 hardware)

| Test | Result | Source |
|------|--------|--------|
| DAPLink v0253 lists WebUSB | `USB Interfaces: MSD, CDC, HID, WebUSB` | D:\DETAILS.TXT |
| Windows recognizes WebUSB | `WebUSB: CMSIS-DAP` in Device Manager | `Get-PnpDevice` |
| VID/PID matches | `0x0D28:0x0204` | Device Manager, DETAILS.TXT |
| CMSIS-DAP probe responds | `ARM CMSIS-DAP` with matching serial | `pyocd list --probes` |
| SWD halt works | `Successfully halted device` | `pyocd cmd -t nrf51822` |
| Registers readable | Full register dump (PC, SP, LR, etc.) | `pyocd cmd` |

## What This Means

The orphaned `Beauty/src/webusb-flash.js` (73 lines) uses the canonical DAP.js flow:
`navigator.usb.requestDevice()` → `transport.open()` → `daplink.connect()` → `daplink.flash()`

The `connect()` step was assumed to fail on V1.5. That assumption was never tested on hardware. The CMSIS-DAP probe works perfectly; DAP.js should too.

## Action Plan for Beauty

1. **Re-import webusb-flash.js** into `app.jsx`
2. **Restore the three-transport cascade** in `saveHexToMicrobit()`:
   - WebUSB (silent after first pairing) → MSD showSaveFilePicker → download fallback
3. **Remove the `// WebUSB removed — non-functional on V1.5` comment** at current app.jsx line 257
4. **Test on hardware:** pair once, verify `getDevices()` returns silently, verify `connect()` succeeds, verify `flash()` completes
5. **Keep MSD as fallback** — it always works and covers browsers without WebUSB (Firefox, Safari)

## User Experience After Fix

| Session | Teacher action | Dialogs |
|---------|---------------|---------|
| First ever | Click "Save to micro:bit →" + pick device in pairing dialog | 1 click + 1 dialog |
| Every session after | Click "Save to micro:bit →" | 1 click, zero dialogs |

Compare to current MSD-only:
| Session | Teacher action | Dialogs |
|---------|---------------|---------|
| Every time | Click → pick MICROBIT drive in file picker → confirm | 1 click + 1 file picker |

## WebUSB Browser Support

- Chrome 61+ ✅
- Edge 79+ ✅
- Opera 48+ ✅
- Firefox ❌ (no WebUSB)
- Safari ❌ (no WebUSB)

For non-WebUSB browsers, MSD/download fallback still works.

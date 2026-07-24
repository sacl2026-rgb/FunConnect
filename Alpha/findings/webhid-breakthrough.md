# WebHID CMSIS-DAP Flash — V1.5 Breakthrough

**Date:** July 20, 2026
**By:** Alpha
**Status:** ✅ PROVEN ON HARDWARE

## The Discovery

V1.5 micro:bit (KL26Z, DAPLink v0253) CAN be flashed via browser with ONE pairing dialog, then ZERO clicks forever.

The path is **WebHID + raw CMSIS-DAP vendor commands**, NOT WebUSB.

## Why WebUSB Failed

The WebUSB path (DAP.js `transport.open()` → `connect()` → `flash()`) has two blocking issues on V1.5:

| Issue | Root Cause | Evidence |
|-------|-----------|----------|
| `transport.open()` hangs | Chrome WebUSB `claimInterface()` bug on interface 4 (vendor-specific) — known Chromium issue #1150758, reported on StackOverflow (Q 65703110). DAPLink v0253 on KL26Z triggers it. | 6+ attempts, `alwaysControlTransfer`, `import()` fixes, 1s delays — all failed |
| `connect()` SWD timeout | DAP.js SWJ protocol selection sequence fails on KL26Z DAPLink. SWD line-reset sequence doesn't complete. | `connect()` timed out every attempt |

## Why WebHID Works

The micro:bit exposes CMSIS-DAP over TWO interfaces:
- **Interface 3 (HID):** Standard HID class, Win32 HID driver, fully functional
- **Interface 4 (WebUSB):** Vendor-specific class, WinUSB driver, Chrome bug blocks it

WebHID accesses interface 3 directly — no `claimInterface` hang, no WinUSB. Raw HID reports carry CMSIS-DAP commands.

## The Protocol

```
Vendor flash sequence (DAPLinkFlash commands):
  0x8A → OPEN (streamType: 0 = binary)
  0x8C → WRITE (page by page, 62 bytes payload)
  0x8B → CLOSE
  0x89 → RESET

Each command = sendReport(0, [cmd, ...data]) → inputreport event → parse response
```

## Performance

| Metric | Value |
|--------|-------|
| Binary size | 254KB (V1 flash image, filtered from universal hex) |
| Page size | 62 bytes (DAP.js DEFAULT_PAGE_SIZE) |
| Total pages | ~4,200 |
| Flash time | ~16 seconds |
| Rate | ~16 KB/s (limited by HID report polling interval, ~1-2ms per report) |

Compare: MSD flash takes ~3 seconds but requires a file picker dialog. WebHID takes ~16 seconds but after first pairing it's zero-click.

## User Experience

| Session | Action | Dialogs |
|---------|--------|---------|
| First ever | Click "Flash" → pick micro:bit in HID pairing dialog | 1 dialog |
| Every session after | Click "Flash" | 0 dialogs |

`navigator.hid.getDevices()` returns silently — no pairing needed after first time.

## Browser Support

- Chrome 78+ ✅
- Edge 79+ ✅
- Opera 65+ ✅
- Firefox ❌ (no WebHID)
- Safari ❌ (no WebHID)

## HID Report Format

```
Output: [cmd_byte (1)] [data (63 max)] [padding to 64 bytes]
Input:  [cmd_echo (1)] [status (1)] [data (62 max)]
```

## Hex Filtering

Universal hex contains both V1 (0x00000-0x40000) and V2 (0x10000000+) blocks. Must filter to V1 range before flashing. The 0x0D record type (V2 universal data) is naturally excluded by the address range filter.

## What Changed From Previous Assumptions

ALPHA_HANDOFF.md previously stated: "WebUSB one-click flash: Blocked on V1.5 hardware. Viable for V2."

**Corrected:** WebUSB is blocked on V1.5 (Chrome bug, not fixable from JS). But WebHID one-click flash works on V1.5. Same one-pairing UX, different USB interface.

## Implementation Notes for Beauty

1. Use `navigator.hid.requestDevice()` instead of `navigator.usb.requestDevice()`
2. Filter hex to V1 blocks only (skip addresses >= 0x10000000)
3. Use request/response QUEUE (not single pendingResolve) — multiple HID reports can be in flight
4. 64-byte HID reports, no DAP.js dependency needed
5. Keep MSD as fallback for non-Chrome browsers

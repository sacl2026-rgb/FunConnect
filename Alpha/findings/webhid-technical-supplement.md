# WebHID Integration — Technical Supplement for Beauty

## 1. WebHID API (vs WebUSB)

| Concept | WebUSB | WebHID |
|---------|--------|--------|
| Request device | `navigator.usb.requestDevice({filters:[{vendorId:0x0D28}]})` | `navigator.hid.requestDevice({filters:[{vendorId:0x0D28}]})` |
| Returns | Single device | Array (use [0]) |
| Silent recheck | `navigator.usb.getDevices()` | `navigator.hid.getDevices()` |
| Open | `device.open()` | `device.open()` |
| Send data | `device.transferOut(endpoint, data)` | `device.sendReport(reportId, data)` |
| Receive data | `device.transferIn(endpoint, size)` | `device.addEventListener('inputreport', handler)` |
| Close | `device.close()` | `device.close()` |

## 2. HID Report Format

CMSIS-DAP over HID uses 64-byte reports:

```
OUTPUT (sendReport):
  Byte 0:     CMSIS-DAP command ID
  Byte 1..N:  Command data (max 63 bytes)
  Byte N+1..63: Zero-padded to 64 bytes

INPUT (inputreport event):
  Byte 0:     Echo of command ID
  Byte 1:     Status (0 = success, non-zero = error)
  Byte 2..N:  Response data
```

## 3. Request/Response Queue

Critical: multiple HID reports can be in flight. Use a QUEUE, not a single callback.

```javascript
// WRONG — race condition:
var pendingResolve = null;
device.addEventListener('inputreport', function(e) {
  pendingResolve(new Uint8Array(e.data.buffer));
});
function sendCmd(cmd, data) {
  return new Promise(function(ok) {
    pendingResolve = ok;  // OVERWRITTEN by next call!
    device.sendReport(0, buildReport(cmd, data));
  });
}

// RIGHT — queue-based:
var queue = [];
device.addEventListener('inputreport', function(e) {
  if (queue.length > 0) queue.shift()(new Uint8Array(e.data.buffer));
});
function sendCmd(cmd, data) {
  return new Promise(function(ok) {
    queue.push(ok);
    device.sendReport(0, buildReport(cmd, data));
  });
}
```

## 4. Vendor Flash Commands

```javascript
var OPEN  = 0x8A;  // DAPLinkFlash.OPEN  — streamType: Uint32Array([0]) = binary
var WRITE = 0x8C;  // DAPLinkFlash.WRITE — [pageSize, ...pageData]
var CLOSE = 0x8B;  // DAPLinkFlash.CLOSE — no data
var RESET = 0x89;  // DAPLinkFlash.RESET — no data
var PAGE_SIZE = 62; // DAP.js DEFAULT_PAGE_SIZE

// Sequence:
await sendCmd(OPEN, new Uint32Array([0]));
// check response[1] === 0

for (var off = 0; off < binary.length; ) {
  var end = Math.min(binary.length, off + PAGE_SIZE);
  var page = binary.slice(off, end);
  var data = new Uint8Array(page.length + 1);
  data[0] = page.length;  // first byte = payload size
  data.set(page, 1);
  await sendCmd(WRITE, data);
  off = end;
}

await sendCmd(CLOSE);
// check response[1] === 0
await sendCmd(RESET);
```

## 5. Hex Filtering (Universal Hex → V1 Binary)

The catalog API returns universal hex with BOTH V1 (nRF51822) and V2 (nRF52833) sections. Must filter to V1 only:

```javascript
function hexToV1Binary(hexText) {
  var blocks = parseIntelHex(hexText);
  var v1blocks = new Map();
  var min = Infinity, max = 0;

  blocks.forEach(function(data, addr) {
    if (addr >= 0x10000000) return;  // SKIP V2 region
    v1blocks.set(addr, data);
    min = Math.min(min, addr);
    max = Math.max(max, addr + data.length);
  });

  if (v1blocks.size === 0) return null;
  var bin = new Uint8Array(max - min);
  v1blocks.forEach(function(data, addr) {
    bin.set(data, addr - min);
  });
  return bin;  // ~254KB for V1
}
```

The existing `webusb-flash.js` filter (record type ≤ 5) can be discarded — the address range filter is cleaner and doesn't depend on record types.

## 6. What to Delete

- `Beauty/src/webusb-flash.js` — orphaned WebUSB code, now proven non-functional
- `Beauty/_write-webusb.js` — regenerator script for webusb-flash.js
- `app.jsx` line 257: "WebUSB removed — non-functional on V1.5" comment
- `app.jsx` line 231: "WebUSB flash first" comment

## 7. Browser Support

| Browser | WebHID | Fallback |
|---------|--------|----------|
| Chrome 78+ | ✅ | — |
| Edge 79+ | ✅ | — |
| Opera 65+ | ✅ | — |
| Firefox | ❌ | MSD |
| Safari | ❌ | MSD |

## 8. Performance

- Binary size: ~254KB (V1 flash image)
- Page size: 62 bytes
- Total pages: ~4,200
- Flash time: ~16 seconds
- MSD comparison: ~3 seconds (but requires file picker dialog)

## 9. Reference Implementation

Working test page at the operator's workspace:
`C:\Users\sacl2\AppData\Roaming\reasonix\global-workspace\smoke.html`

Full technical writeup:
`C:\Users\sacl2\AppData\Roaming\reasonix\global-workspace\funconnect-findings\webhid-breakthrough.md`

# FunConnect — Alpha Complete Session Record
**Agent Alpha | July 20-24, 2026**

## MOTIVATION

Classroom IoT platform. Two device types: micro:bit V1.5 (KL26Z) and CyberPi (ESP32-D0WD).
Both require human-gated upload: drag-and-drop files, mBlock GUI popups, file pickers.
Goal: zero-click browser flash. Teacher picks program from catalog, clicks, device runs it.

## micro:bit V1.5 — WebHID Breakthrough

ALPHA_HANDOFF.md stated: "WebUSB one-click flash: Blocked on V1.5. Viable for V2." This was NEVER tested on hardware.

**WebUSB Failures:**
- DAP.js transport.open() hangs — Chromium bug #1150758 on KL26Z DAPLink v0253
- claimInterface() on vendor-specific class 0xFF never returns on Windows
- StackOverflow Q65703110 confirms identical symptoms
- nrf-intel-hex CDN: UMD sets window.MemoryMap as side-effect; import() has this=undefined
- Single pendingResolve for HID: race condition. Fix: queue-based matching

**WebHID Solution:** micro:bit exposes CMSIS-DAP over interface 3 (HID, works) and interface 4 (WebUSB, broken). navigator.hid.requestDevice() — one pairing, then silent. Commands: OPEN (0x8A) -> WRITE (0x8C) page-by-page -> CLOSE (0x8B) -> RESET (0x89). 254KB V1 hex in ~16s. Filter universal hex to V1 blocks (skip >= 0x10000000).

**Ref:** Alpha/findings/webhid-breakthrough.md, webhid-technical-supplement.md, webusb-v15-findings.md

## CyberPi (ESP32) — esptool Direct Flash

**Hardware:** ESP32-D0WD rev1.1, CH340 USB bridge, CyberPiOS v44.01.016, 8MB flash. Slot at flash 0x558000 — constant across all 3 CyberPis. Discovered via baseline -> mBlock upload -> diff cycle.

**Two Program Formats:**
- Small (<207B): header + code + checksum + 0x08 + metadata. Checksum at 0xCF, 0x08 at 0xD1, metadata at 0xD2+ (MAC-specific, DO NOT MODIFY)
- Large (>4KB): fills sector, no markers, may span multiple sectors

**Format Transition Matrix:**
| From / To | Small | Large | Default |
|-----------|-------|-------|---------|
| Small | ES esptool | mBlock only | mBlock only |
| Large | mBlock only | ES esptool | mBlock only |
| Default | mBlock only | mBlock only | N/A |

ES = Our esptool works. mBlock only = proven possible by mBlock, not yet replicated.

**ALL 17 Failures:**
1. mpremote REPL — no REPL over serial
2. WebHID — CH340 has no HID interface
3. esptool --no-stub write — silent failure (says wrote, data unchanged)
4. esptool stub + zero-pad — traceback (zeros corrupt metadata)
5-7. Web Serial esptool-js v1-3 — CDN import/timeout bugs
8. Clone NVS to C3 — still traceback (NVS not the cause)
9. Clone firmware to C3 — still traceback (version not the cause)
10. Clone metadata to C3 — traceback line 9 (MAC-specific)
11. BLE brute-force 256 TYPE bytes — none trigger upload
12. BLE upload_broadcast.set() — doesn't persist (broadcast only)
13-14. Small-large transitions — NVS mismatch, multi-sector
15. Factory-fresh init — metadata validation fails
16. Restart flag after write — too late (flag checked at boot)
17. Build from scratch — always fails (must read first)

**What WORKED — Small-to-Small Algorithm:**
1. Read sector 0x558000 (STUB flasher, 115200 baud — NEVER --no-stub)
2. Find code_start = sector.find(b"from cyberpi")
3. Find code_end = sector.find(b"\x08", code_start + 20)
4. Replace bytes [code_start:code_end] with new program, space-pad (0x20) if shorter
5. Write back, touch NOTHING else — preserve checksum, 0x08, metadata

Requires prior mBlock upload. Confirmed: blue, green, red on C2. Max code: 207 bytes.

**Halocode Protocol:** Serial f3/f4 at 115200 baud over CH340. BLE over 0xffe1/0xffe3/0xffe2. TYPE_SCRIPT (0x28) sends Python to CyberPiOS, returns JSON. Makeblock library v0.1.8 documented.

**BLE Auto-ID:** C1 MAC: 24:dc:c3:8f:f1:14, C3 MAC: fc:e8:c0:92:fd:bc. Scan BLE -> match MAC -> know device.

## Beauty SPA — 4 Bugs

1. No header prepended -> traceback. Fix: prepend "# led-test.py ..."
2. No CRLF conversion -> syntax errors. Fix: .replace(/\n/g, "\r\n")
3. No overflow check -> 909B truncated to 207B. Fix: reject > 0xCF with error
4. port.open() before Transport -> "already open". Fix: let Transport handle open/close

Fixed: Alpha/cyberpi-serial-flash-fixed.js. Working ref: Alpha/cyberpi-smoke.html.
Catalog: 10 programs live, 3 direct-flash (<207B): red/green/blue-blink.

## Edge Worker — 7 Issues

1. Online false (D1 stale) — deployed: roster shows all
2. Serial DO fetches 2s — needs Promise.all
3. Telemetry double-count — deployed: fixed
4. Roster offline hidden — deployed: shows all
5. Hardcoded device IDs — needs roster discovery
6. Missing auth guard — not yet
7. conversation_buffer alarm — verified OK

## Register + Session Model

Register: BLE scan -> pick -> name -> roster stores {id, mac, label}
Session: Start -> WSS connects -> flash -> disconnect -> card greyed
Deregister: Remove -> card gone -> data stays in D1
Philosophy: All short-term. Devices reflashed, swapped, disconnected.

## LLM Lasso Techniques (10 Proven)

Plan+smoke+tripwires. Search online. Audit API surface. Talk don't code.
C3 off-limits. No auto-commit. Don't do anything unless told.
Smoke test own code. Write handoff. Give rundown table.

## Key Lessons (12)

1. Read first, never build from scratch
2. Space-pad (0x20), never zero-pad (0x00)
3. Preserve all bytes outside code region
4. New code must fit in old space
5. Stub flasher at 115200, not ROM bootloader
6. mBlock routes through CyberPiOS, esptool bypasses
7. All transitions ARE possible (mBlock proves), we have small-to-small
8. One mBlock upload enables esptool forever
9. CLI first, browser second
10. Test assumptions on hardware
11. Search online before reverse-engineering
12. Diff before/after uploads

## Device Inventory

C1: 24:dc:c3:8f:f1:14, v44.01.016, working
C2: unknown MAC, v44.01.016, working
C3: fc:e8:c0:92:fd:bc, v44.01.003->016, OFF LIMITS

## Working Commands

```bash
# Small-to-small flash
python3 -m esptool --port COM3 --baud 115200 read-flash 0x558000 0x1000 s.bin
python3 -c "
s=bytearray(open('s.bin','rb').read())
cs=s.find(b'from cyberpi'); ce=s.find(b'\x08', cs+20)
new=b'from cyberpi import *\r\nimport time\r\n\r\nwhile True:\r\n    led.on(0,0,255,1)\r\n    time.sleep(.5)\r\n    led.off(1)\r\n    time.sleep(.5)\r\n'
s[cs:cs+len(new)]=new
for i in range(cs+len(new), ce): s[i]=0x20
open('s.bin','wb').write(s)
"
python3 -m esptool --port COM3 --baud 115200 write-flash 0x558000 s.bin
```

## Repository
GitHub: https://github.com/sacl2026-rgb/FunConnect
Live: https://funconnect-v1.funconnect.workers.dev
D1: funconnect-v1-db (a3a8950d-c028-4ef4-b05c-982a10b9b2a6)
Account: 758cece0f853404f97b17f0ff86b5190

# CyberPi Direct Flash — Breakthrough

**Date:** July 21, 2026
**By:** Alpha
**Status:** ✅ PROVEN ON HARDWARE

## The Discovery

CyberPi programs can be written directly to flash via esptool, bypassing mBlock entirely. CyberPiOS is preserved — mBlock still works after direct flash writes.

This mirrors the micro:bit WebHID breakthrough (July 20, 2026): both devices now have zero-click browser flash paths.

## Hardware

| Property | Value |
|----------|-------|
| Chip | ESP32-D0WD (revision v1.1) |
| Features | Wi-Fi, BT, Dual Core, 240MHz |
| Crystal | 40MHz |
| MAC | 24:dc:c3:8f:f1:14 |
| USB bridge | CH340 (VID 0x1A86, PID 0x7523, COM3) |
| CyberPiOS | v44.01.016 (Nov 14 2025) |
| Bootloader | ESP32 ROM, auto-syncs — NO buttons needed |

## Flash Partition Layout

```
Offset       Size     Name        Purpose
0x000000     0x8000   (boot)      ESP32 ROM bootloader
0x008000     0x1000   (ptable)    Partition table
0x009000     0x4000   nvs         Non-volatile storage
0x00D000     0x2000   otadata     OTA data
0x00F000     0x1000   phy_init    PHY init data
0x010000     0xF0000  factory     CyberPiOS firmware (960KB)
0x100000    0x300000  ota_0       OTA update slot (3MB)
0x480000    0x300000  storage     FAT12 filesystem (3MB)
```

## Where Programs Are Stored

Programs are stored as raw text in the `storage` partition (0x480000), NOT in the FAT filesystem. They exist outside the FAT directory structure — likely in a dedicated slot area managed by CyberPiOS.

**Our test program was at flash 0x558034** (storage partition offset 0xD8034).

The program is plain text with Windows line endings (`\r\n`). No compilation, no bytecode, no encoding. CyberPiOS reads and executes it directly from flash.

## How To Flash

### Read the current program
```bash
python3 -m esptool --port COM3 --baud 115200 --no-stub \
  read-flash 0x558000 0x1000 sector.bin
```

### Find the program in the sector
The program starts after a header comment. Search for `from cyberpi import *` or `# Simple LED blink` to locate the exact offset.

### Patch and write
```bash
python3 -m esptool --port COM3 --baud 115200 --no-stub \
  write-flash 0x558000 sector-patched.bin
```

**Critical:** use `--no-stub` for writing. The stub flasher conflicts with the running CyberPiOS program. The ROM bootloader (`--no-stub`) writes reliably because it operates before CyberPiOS boots.

### Important constraints
- New code must be ≤ old code length (pad with spaces if shorter)
- Only the specific sector (4096 bytes) is erased — surrounding data is safe
- CyberPiOS is in the `factory` partition — physically separate from `storage`
- Writing to `storage` cannot touch `factory` — OS is safe by partition layout

## End-to-End Pipeline

```
Teacher writes Python in browser
  ↓
Edge serves it as plain text
  ↓
Beauty sends to local esptool (via Web Serial or CLI bridge)
  ↓
esptool writes to flash at known slot offset
  ↓
CyberPiOS reboots, reads the new program, executes it
```

## Browser Feasibility

esptool can run as a Web Serial application. The ESP32 ROM bootloader protocol is well-documented:
- Sync: send `0x07 0x07 0x12 0x20` + checksum
- All commands are simple serial packets
- Full protocol: https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/serial-protocol.html

A JavaScript esptool implementation (like `esptool-js`) could run entirely in the browser, talking to the CyberPi through Web Serial API. One pairing dialog, then zero clicks forever.

## Comparison with micro:bit

| | micro:bit V1.5 | CyberPi |
|---|---|---|
| Flash path | WebHID → CMSIS-DAP vendor cmds | Web Serial → esptool |
| Interface | HID (interface 3) | CH340 serial (COM port) |
| Binary size | ~254KB (V1 hex) | Variable (raw .py text) |
| Flash time | ~16 seconds | Seconds (text is tiny) |
| OS safety | Partition separation | Partition separation |
| Browser API | `navigator.hid` | `navigator.serial` |
| Fallback | MSD (`showSaveFilePicker`) | mBlock GUI |

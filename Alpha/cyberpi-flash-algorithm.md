# CyberPi Direct Flash — Complete Algorithm

**Date:** July 21, 2026  
**By:** Alpha  
**Status:** PROVEN ON HARDWARE — Multiple color cycles confirmed

---

## 1. Hardware & Firmware

| Property | Value |
|----------|-------|
| Chip | ESP32-D0WD (revision v1.1) |
| USB Bridge | CH340 (VID 0x1A86, PID 0x7523) |
| CyberPiOS | v44.01.016 (Nov 14 2025) |
| Flash Size | 8MB (detected: 0x1740c8) |
| Crystal | 40MHz |
| Flash Mode | DIO |

## 2. Flash Partition Layout

```
Offset       Size      Name        Purpose
0x000000     0x8000    (boot)      ESP32 ROM bootloader
0x008000     0x1000    (ptable)    Partition table
0x009000     0x4000    nvs         Non-volatile storage
0x00D000     0x2000    otadata     OTA data
0x00F000     0x1000    phy_init    PHY init data
0x010000    0xF0000    factory     CyberPiOS firmware (960KB)
0x100000    0x300000   ota_0       OTA update slot (3MB)
0x480000    0x300000   storage     FAT12 + program slots (3MB)
```

## 3. Program Slot Location

CyberPiOS stores user programs in **numbered slots** on the `storage` partition.

| Property | Value |
|----------|-------|
| **Slot 1 (default) address** | `0x558000` |
| **Sector size** | 4096 bytes (one flash sector) |
| **Program starts at** | Offset `0x00` within sector |
| **Program text region** | `0x00` to `0xD0` (209 bytes) |
| **Metadata starts at** | Offset `0xD1` within sector |

## 4. Sector Byte Layout

```
Offset  Size    Content
0x0000  0x00D1  Program text (ASCII, CRLF line endings, space-padded)
0x00D1  0x0F2F  Binary metadata (DO NOT MODIFY)
0x1000  (end)   Sector boundary
```

### Program Text Format

- Windows line endings (`\r\n`)
- First line: starts with `#` comment header
- Imports: `from cyberpi import *` then `import time`
- Main loop code
- **Space-padded** to fill the 0xD1-byte text region

### Binary Metadata (Offset 0xD1)

Bytes at offset 0xD1+ are **critical metadata** written by CyberPiOS:

```
08 8d e0 08 8f 00 09 91 20 09 93 40 09 95 60 09 97 80 09 ff af ...
```

**NEVER MODIFY THESE BYTES.** They contain program length markers, slot checksums, and execution flags. The first byte (`0x08`) acts as a program terminator — CyberPiOS finds the end of ASCII text by locating this byte. Zeroing or corrupting it causes CyberPiOS to fail with a Python traceback on the first corrupted byte line.

## 5. Read-Modify-Write Algorithm

### Step A: Read

```bash
python3 -m esptool --port COM3 --baud 115200 read-flash 0x558000 0x1000 sector.bin
```

Use **stub flasher** (no `--no-stub` flag). The stub is ~10x faster. Only use `--no-stub` if the stub fails (device running code that blocks SPI).

### Step B: Modify (Python)

```python
TEXT_LENGTH = 0xD1  # 209 bytes

sector = bytearray(open("sector.bin", "rb").read())

# Build new code with CRLF
new_code = (
    b'# led-test.py \xe2\x80\x94 Simple LED blink, no WiFi needed\r\n'
    b'from cyberpi import *\r\n'
    b'import time\r\n'
    b'\r\n'
    b'while True:\r\n'
    b'    led.on(0, 0, 255, 1)  # blue\r\n'
    b'    time.sleep(0.5)\r\n'
    b'    led.off(1)\r\n'
    b'    time.sleep(0.5)\r\n'
)

assert len(new_code) <= TEXT_LENGTH

# Write at offset 0
sector[0:len(new_code)] = new_code

# Space-pad remaining text region
for i in range(len(new_code), TEXT_LENGTH):
    sector[i] = 0x20  # SPACE, never zero

# Bytes TEXT_LENGTH+ are UNTOUCHED

open("sector.bin", "wb").write(sector)
```

**Three critical rules:**
1. Write ONLY to bytes [0, TEXT_LENGTH)
2. Pad with `0x20` (space), NEVER `0x00` (null)
3. Never touch bytes at offset >= TEXT_LENGTH

### Step C: Write

```bash
python3 -m esptool --port COM3 --baud 115200 write-flash 0x558000 sector.bin
```

Stub flasher. Device auto-resets via RTS after write.

## 6. Failure History

| Attempt | Method | Result |
|---------|--------|--------|
| Web Serial + esptool-js | Browser CDN | esptool-js `toString` errors, hangs |
| CLI --no-stub + zero-pad | ROM bootloader | Traceback: zeros corrupt metadata |
| CLI stub + zero-pad | Stub flasher | Traceback line 10: null bytes break parser |
| **CLI stub + space-pad + tail preserved** | Stub flasher | WORKS |

Root cause: CyberPiOS expects the program text region to end at offset 0xD1 followed immediately by metadata byte `0x08`. Zero-padding produced `0x00` bytes which CyberPiOS tried to parse as literal code, causing `NameError` or `SyntaxError` at the first null byte line.

## 7. Working One-Liner

```bash
python3 -m esptool --port COM3 --baud 115200 read-flash 0x558000 0x1000 s.bin && python3 -c "
s=bytearray(open('s.bin','rb').read())
c=b'from cyberpi import *\r\nimport time\r\n\r\nwhile True:\r\n    led.on(0,0,255,1)\r\n    time.sleep(0.5)\r\n    led.off(1)\r\n    time.sleep(0.5)\r\n'
h=b'# led-test.py \xe2\x80\x94 Simple LED blink, no WiFi needed\r\n'
full=h+c
s[0:len(full)]=full
for i in range(len(full),0xD1): s[i]=0x20
open('s.bin','wb').write(s)
" && python3 -m esptool --port COM3 --baud 115200 write-flash 0x558000 s.bin && rm s.bin
```

## 8. Program Constraints

| Rule | Detail |
|------|--------|
| Max code size | 209 bytes including header comment |
| Line endings | `\r\n` (Windows CRLF) |
| Header | First-line comment required |
| API calls | `led.on(r,g,b,index)` or `cyberpi.led.on(r,g,b,"all")` |
| No WiFi needed | LED-only programs work without WiFi config |
| CyberPiOS preserved | Writing only to storage partition, factory untouched |

## 9. Pipeline Integration

```
Teacher writes Python in browser
  -> Edge serves program text
  -> Beauty downloads text
  -> CLI esptool bridge: read sector -> patch text -> write sector
  -> CyberPiOS reboots and runs new program
```

Browser path (Web Serial + esptool-js) is feasible but currently blocked by esptool-js bugs. CLI path is proven and can serve as backend for Beauty SPA.

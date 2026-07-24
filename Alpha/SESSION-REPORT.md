# Alpha Session — July 21-22, 2026: CyberPi Direct Flash

**Author:** Alpha
**Date:** July 22, 2026
**Status:** Small-to-small proven. Format transitions and factory-fresh unsolved.

---

## 1. Successes

### 1.1 Small-to-Small esptool Flash (PROVEN)

The original algorithm works for replacing one small program with another:

```
1. Read sector 0x558000 via esptool
2. Find code_start (first "from cyberpi" after header comment)
3. Find code_end (position of 0x08 terminator byte)
4. Replace bytes [code_start:code_end] with new program code
5. Space-pad (0x20) if new code is shorter than old code
6. Write sector back via esptool
7. Touch NOTHING else — no NVS changes, no metadata changes
```

**Confirmed:** Blue, green, red — multiple color cycles on C2.
**Requirement:** Device must have prior mBlock upload to establish initial state.

### 1.2 BLE Live Mode (PROVEN)

Halocode f3/f4 protocol works over BLE (characteristics 0xffe1/0xffe2/0xffe3) and USB serial (CH340, 115200 baud).

- TYPE_SCRIPT (0x28) with MODE_RUN_WITH_RESPONSE (0x01)
- Python expressions evaluated on CyberPiOS
- No online_mode frame needed (device auto-detects)
- `cyberpi.led.on(r,g,b)` works directly

### 1.3 Full Flash Clone (PROVEN)

Full partition copies between devices:
- Factory partition (960KB): CyberPiOS firmware, cloned from C1 to C3
- NVS partition (16KB): config and WiFi settings
- Storage partition sector (4KB): program slot

### 1.4 Serial Halocode Protocol (PROVEN)

Direct f3/f4 framing over USB serial at 115200 baud. No online_mode required.
CyberPiOS responds with JSON `{"ret":...}` or `{"err":"..."}`.

### 1.5 CyberPiOS Internal API Discovery (PROVEN)

Found the CyberPiOS configuration system:
- `cyberpi.config.read_config()` returns full config dict
- `cyberpi.nvs.write(key, value)` writes to NVS
- `cyberpi.communication_o` controls protocol groups
- `cyberpi.upload_broadcast.set(code, value)` — exists but doesn't persist
- Config keys: `run_file_name`, `run_script_type`, `run_script_idx`, `gui_mode`

### 1.6 BLE Service Enumeration (PROVEN)

CyberPi BLE:
- Service: 0xffe1 (vendor-specific)
- Write char: 0xffe3 (commands TO device)
- Notify char: 0xffe2 (responses FROM device)
- Protocol: f3/f4 framing (same as USB serial)

### 1.7 Makeblock Python Library Analysis (PROVEN)

Found official makeblock library (v0.1.8) with HalocodePackData:
- Full frame construction and parsing
- TYPE_SCRIPT = 0x28
- TYPE_ONLINE = 0x0d
- MODE_RUN_WITHOUT_RESPONSE = 0x00
- MODE_RUN_WITH_RESPONSE = 0x01
- protocol group IDs: COMMON=1, FF55=3, REPL=4, FAF5=5

---

## 2. Failures & Walls

### 2.1 Large-to-Small esptool Transition (FAILED)

Cannot flash a small program over a large program slot.
- Large programs fill the entire 4KB sector (no 0x08 terminator)
- Small programs have 0x08 terminator at 0xD1 + checksum
- Writing small format over large format causes traceback or blank screen
- mBlock CAN do this transition (routes through CyberPiOS internally)

### 2.2 Small-to-Large esptool Transition (FAILED)

Cannot flash a large program over a small program slot.
- Large programs may span multiple sectors (relay.py is 15KB)
- NVS format flag (run_script_type) doesn't update automatically
- Even with matching NVS write, large program doesn't run

### 2.3 Factory-Fresh Device esptool Flash (FAILED)

Cannot flash ANY program to a device that has never seen mBlock.
- Factory default state has mBlock5 generated code (large format)
- esptool writes to 0x558000 are ignored by CyberPiOS
- Device stays at language selection page or shows blank screen
- mBlock upload "initializes" the device, enabling future esptool writes

### 2.4 Metadata Reverse-Engineering (FAILED)

The binary metadata at 0xD2+ in the small format sector cannot be:
- Cloned between devices (different MACs = different metadata)
- Generated independently (algorithm unknown, not CRC16/CRC32/XOR/Fletcher)
- Omitted (CyberPiOS requires it on first boot after write)

### 2.5 Checksum Algorithm (NOT FULLY DETERMINED)

The 2-byte checksum at 0xCF-0xD0:
- Formula `code_length * 173 - first_byte` matches one working case
- But doesn't work for blue code (same formula gives same value, yet fails)
- Checksum must include actual code CONTENT, not just length
- mBlock generates correct checksum; esptool writes with wrong checksum fail

### 2.6 mBlock Upload Protocol (NOT FOUND)

The mBlock upload protocol beyond Halocode:
- Upload is NOT Live Mode (TYPE_SCRIPT doesn't persist)
- Upload is NOT `upload_broadcast` (broadcasts but doesn't store)
- Serial protocol capture impossible (mBlock locks COM3)
- BLE monitor captures zero frames during mBlock upload
- All 256 TYPE bytes tested via BLE — none trigger upload
- All MODE values tested — none trigger upload
- CyberPiOS internal write function not found in Python API
- Compiled makeblock library has no upload function beyond broadcast

### 2.7 Web Serial esptool-js (FAILED)

Browser-based esptool approach:
- CDN import issues (UMD/ESM conflicts, timeouts)
- `toString` errors in esptool-js bundle
- Transport hangs on writeFlash
- 10+ page rewrites, none stable

### 2.8 Stub vs ROM Bootloader (WORKAROUND FOUND)

- `--no-stub` ROM bootloader: silent write failures (says wrote, data stays 0xFF)
- Stub flasher: works at 115200 baud, fails at 460800 when device running
- Must use stub flasher for writes, ROM bootloader for reads when device active

---

## 3. The Format Dichotomy

### 3.1 Small Programs (< ~200 bytes)

```
Offset  Size    Content
0x00    0x32    Header comment (52 bytes, "# led-test.py — ...")
0x32    varies  Python code (with \r\n line endings)
varies  pad     Space padding (0x20) to fill before 0xCC
0xCF    0x02    Checksum (2 bytes, big-endian, algorithm unknown)
0xD1    0x01    0x08 terminator byte
0xD2    varies  Binary metadata (device-specific, generated by CyberPiOS)
```

### 3.2 Large Programs (> 4KB)

```
Offset  Size    Content
0x0000  0x1000  Python code (fills entire sector, no markers)
                No checksum, no terminator, no metadata
                May span multiple sectors
```

### 3.3 Transition Matrix

| From \ To | Small | Large | Default |
|-----------|-------|-------|---------|
| Small | ✅ esptool | ❌ | ❌ |
| Large | ❌ | ❌ | ❌ |
| Default | ❌ | ❌ | N/A |

Only small-to-small works via esptool. All other transitions require mBlock.

---

## 4. Key Lessons

### 4.1 Read First, Then Write
Building sectors from scratch (0xFF fill, new checksum, new metadata) always fails. Must read the existing sector, find boundaries, patch only the code text.

### 4.2 Space-Pad, Never Zero-Pad
Zeros (0x00) in the code region cause CyberPiOS tracebacks. Spaces (0x20) are valid Python whitespace and don't interfere.

### 4.3 Preserve Binary Tail
Bytes after the 0x08 terminator (0xD2+) contain device-specific metadata. Must be read and preserved — never overwritten.

### 4.4 Code Must Fit In Old Space
New code must be <= old code length. Cannot expand the text region. If new code is shorter, space-pad the remainder.

### 4.5 mBlock Uploads Route Through CyberPiOS
esptool bypasses CyberPiOS entirely. mBlock talks TO CyberPiOS, which writes using its own flash driver. This internal write generates correct metadata and sets device state that esptool cannot replicate.

### 4.6 Stub Flasher Reliability
Use stub flasher (not --no-stub) for writes at 115200 baud. ROM bootloader writes silently fail on this flash chip.

### 4.7 CLI First, Browser Second
The CLI esptool path worked immediately. The browser esptool-js path took 10+ iterations and never stabilized. Prove from CLI, then port.

### 4.8 One mBlock Upload Enables esptool
After a single mBlock upload establishes the device state, esptool small-to-small writes work forever. The initial upload is the gate.

---

## 5. Unresolved

| # | Question |
|---|----------|
| 1 | How does mBlock's upload protocol actually write to flash? |
| 2 | What is the checksum algorithm? |
| 3 | What is in the binary metadata at 0xD2+? |
| 4 | How 

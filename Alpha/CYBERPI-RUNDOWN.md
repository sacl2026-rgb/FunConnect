# CyberPi Direct Flash — Complete Rundown

## CONFIRMED (proven on hardware, all 3 devices)

| # | Finding | Evidence |
|---|---------|----------|
| 1 | Slot address: 0x558000 on ALL CyberPis | Flash read confirmed on C1, C2, C3 |
| 2 | Text region: 0x00-0xD0 (209 bytes) | mBlock upload diff on C2 |
| 3 | Header: 52 bytes at 0x00, code at 0x34 | Working sector dump on C1/C2 |
| 4 | Terminator: 0x08 at 0xD1 | All working mBlock sectors |
| 5 | Tail after 0xD1: spaces (0x20) work fine | Working sector verified |
| 6 | STUB flasher writes correctly | Hash verified, byte-compared |
| 7 | --no-stub SILENTLY FAILS on some ops | Output says "wrote" but readback is 0xFF |
| 8 | C3 firmware: v44.01.003-ht1-dirty | Factory partition string |
| 9 | C1/C2 firmware: v44.01.016 | Factory partition string |
| 10 | BLE Live Mode works: f3/f4 protocol | 1+1=2 returned, beep+LED response |
| 11 | BLE chars: ffe1 service, ffe3 write, ffe2 notify | bleak connection confirmed |
| 12 | Algorithm works on C1/C2 after mBlock upload | Blue/green/red confirmed |
| 13 | C2 fixed by ONE mBlock upload | User confirmed |
| 14 | esptool writes work forever after first mBlock | Multiple color changes on C1/C2 |
| 15 | Erased sector (0xFF) causes boot loop | Confirmed on all 3 devices |

## RULED OUT (tested, not the cause)

| # | Theory | Why Ruled Out |
|---|--------|---------------|
| 16 | Sector content differences | Byte-verified identical between C1/C2 and C3 |
| 17 | NVS run_file_name entry | Identical between working and C3 |
| 18 | NVS user_script CRC | Updated to match blue code, still fails |
| 19 | NVS program entries erased | Erased run_file + user_script entries, still fails |
| 20 | Terminator variation (0x08/0x00/0xFF) | All fail on C3; 0x08 works on C1/C2 |
| 21 | Header offset (0x00 vs 0x34) | C1/C2 work with both |
| 22 | FAT filesystem entries | No relevant entries found in storage partition |
| 23 | OTA partition settings | Both C1 and C3 boot from factory |
| 24 | MAC address in tail | Not found; tail identical across different MACs |
| 25 | Firmware version | C3 now runs v44.01.016 (cloned from C1), still tracebacks |
| 26 | Space padding vs zero padding | 0x20 works on C1/C2; C3 fails with both |
| 27 | 0xFF fill vs 0x20 fill in tail | 0xFF causes boot loop; 0x20 allows traceback |
| 28 | BLE filesystem write to main1.py | CyberPiOS doesn't read filesystem on boot |
| 29 | BLE exec in Live Mode | Code runs in RAM only, doesn't persist across reset |

## ONLINE DOCS & PRECEDENTS FOUND

| # | Finding | Source |
|---|---------|--------|
| 30 | HalocodeProtocol f3/f4 framing - Live Mode only | mbot_ruvector crate (protocol.rs) |
| 31 | Makeblock CyberOS: Switch Program, Reset, OTA Update | support.makeblock.com |
| 32 | ESP-IDF factory reset via otadata partition flag | docs.espressif.com |
| 33 | ESP-IDF NVS: 32-byte entries with CRC8 | docs.espressif.com |
| 34 | CyberPi File Manager over WiFi TCP (PerfecXX) | GitHub PerfecXX/mBot2 |
| 35 | Python API "upload mode broadcast message" | Makeblock Python API PDF |
| 36 | No open-source CyberPiOS code | All searches |
| 37 | No upload protocol docs | All searches |
| 38 | No reverse-engineering writeups | All searches |

## UNRESOLVED

| # | Question |
|---|----------|
| 39 | mBlock writes something BEYOND raw sector that persists after esptool overwrite |
| 40 | CyberPiOS may validate programs via a separate NVS flag not yet found |
| 41 | The exact upload protocol command mBlock uses (not Live Mode TYPE_SCRIPT 0x28) |
| 42 | Per-device signing or state flag that mBlock sets on first upload |

## THEORY

mBlock upload calls a CyberPiOS internal write function through the Halocode protocol. This function writes the program to sector 0x558000 AND sets a persistent validation flag (likely in NVS or a separate metadata sector). C1/C2 have this flag from prior mBlock uploads — esptool writes work because the flag was already set. C3 lacks the flag — esptool writes update the sector but CyberPiOS rejects it because the validation flag is absent.

## NEXT

- Find the NVS validation flag that only exists on C1/C2, not C3
- OR capture the serial protocol between mBlock and CyberPi during upload
- OR use CyberPiOS internal flash write API via BLE exec

/**
 * py2hex — MicroPython-to-Intel-HEX builder for micro:bit V1 + V2.
 *
 * Ported from uflash 2.0.0 (MIT license, (c) 2015-2020 Nicholas H.Tollervey).
 * Encodes a .py script into the MicroPython filesystem format and injects
 * it into a universal hex firmware template (both V1 and V2 sections).
 *
 * V1 constants (from uflash):
 *   FS_START = 0x38C00, FS_END = 0x3F800, Device ID = "9900"
 * V2 constants (from uflash):
 *   FS_START = 0x6D000, FS_END = 0x72000, Device ID = "9903"
 *
 * Chunk size = 128 bytes (126 data + 2 prev/next link bytes).
 * Zero dependencies. Runs in the Worker hot path (<10ms for typical scripts).
 */

// ── Constants (from uflash 2.0.0) ─────────────────────────────────────────

const MICROBIT_ID_V1 = "9900";
const MICROBIT_ID_V2 = "9903";
const FS_START_ADDR_V1 = 0x38c00;
const FS_END_ADDR_V1 = 0x3f800;
const FS_START_ADDR_V2 = 0x6d000;
const FS_END_ADDR_V2 = 0x72000;
const CHUNK_SIZE = 128;
const CHUNK_DATA_SIZE = 126;

interface FsConfig {
  startAddr: number;
  endAddr: number;
  universalDataRecord: boolean; // V1→false (0x00), V2→true (0x0D)
}

function fsConfigFor(deviceId: string): FsConfig {
  if (deviceId === MICROBIT_ID_V2) {
    return { startAddr: FS_START_ADDR_V2, endAddr: FS_END_ADDR_V2, universalDataRecord: true };
  }
  // V1 and unknown devices default to V1 config.
  return { startAddr: FS_START_ADDR_V1, endAddr: FS_END_ADDR_V1, universalDataRecord: false };
}

// ── Intel HEX record builder ──────────────────────────────────────────────

function checksum(data: Uint8Array): number {
  let sum = 0;
  for (const b of data) sum += b;
  return (~sum + 1) & 0xff;
}

function hexlify(data: Uint8Array): string {
  let s = "";
  for (const b of data) s += b.toString(16).padStart(2, "0").toUpperCase();
  return s;
}

function makeRecord(data: Uint8Array): string {
  return ":" + hexlify(data) + checksum(data).toString(16).padStart(2, "0").toUpperCase();
}

/** Extended Linear Address record: struct.pack('>BHBH', 0x02, 0x0000, 0x04, ela). */
function makeElaRecord(ela: number): string {
  const data = new Uint8Array([0x02, 0x00, 0x00, 0x04, (ela >> 8) & 0xff, ela & 0xff]);
  return makeRecord(data);
}

/** Data record: struct.pack('>BHB', byteCount, addr16, recordType) + payload. */
function makeDataRecord(byteCount: number, addr16: number, recordType: number, payload: Uint8Array): string {
  const data = new Uint8Array(4 + payload.length);
  data[0] = byteCount;
  data[1] = (addr16 >> 8) & 0xff;
  data[2] = addr16 & 0xff;
  data[3] = recordType;
  data.set(payload, 4);
  return makeRecord(data);
}

// ── Intel HEX encoder ─────────────────────────────────────────────────────

function bytesToIhex(addr: number, data: Uint8Array, universalDataRecord: boolean): string {
  const output: string[] = [];
  const rType = universalDataRecord ? 0x0d : 0x00;

  let currentEla = (addr >> 16) & 0xffff;
  output.push(makeElaRecord(currentEla));

  for (let i = 0; i < data.length; i += 16) {
    const newEla = (addr >> 16) & 0xffff;
    if (newEla !== currentEla) {
      currentEla = newEla;
      output.push(makeElaRecord(currentEla));
    }
    const chunk = data.slice(i, Math.min(i + 16, data.length));
    output.push(makeDataRecord(chunk.length, addr & 0xffff, rType, chunk));
    addr += 16;
  }
  return output.join("\n");
}

// ── MicroPython filesystem encoder ────────────────────────────────────────

/**
 * Encode a Python script into Intel HEX records as a micro:bit
 * MicroPython filesystem image. Uses device-specific addresses and
 * record types (V1: 0x38C00, type 0x00; V2: 0x6D000, type 0x0D).
 */
function scriptToFs(script: Uint8Array, cfg: FsConfig): string {
  if (script.length === 0) return "";

  const fsSize = cfg.endAddr - cfg.startAddr;
  const mainPyMaxSize = Math.floor((fsSize / CHUNK_SIZE) * CHUNK_DATA_SIZE) - 9;
  if (script.length >= mainPyMaxSize) {
    throw new Error(`Script too large: ${script.length} bytes (max ${mainPyMaxSize})`);
  }

  // Build first chunk: file header + initial data.
  const header = new Uint8Array([
    0xfe,                                                              // "file start"
    0xff,                                                              // offset-in-last-chunk (placeholder)
    0x07,                                                              // filename length
    0x6d, 0x61, 0x69, 0x6e, 0x2e, 0x70, 0x79,                        // "main.py"
  ]);
  const firstChunkDataSize = CHUNK_SIZE - header.length - 1;
  const firstData = script.slice(0, firstChunkDataSize);
  let remaining = script.slice(firstChunkDataSize);

  const chunks: Uint8Array[] = [];
  const ch0 = new Uint8Array(CHUNK_SIZE).fill(0xff);
  ch0.set(header, 0);
  ch0.set(firstData, header.length);
  chunks.push(ch0);

  while (remaining.length > 0) {
    const chunkIdx = chunks.length + 1;                    // 1-based
    chunks[chunks.length - 1][CHUNK_SIZE - 1] = chunkIdx;
    const slice = remaining.slice(0, CHUNK_DATA_SIZE);
    remaining = remaining.slice(CHUNK_DATA_SIZE);
    const ch = new Uint8Array(CHUNK_SIZE).fill(0xff);
    ch[0] = chunkIdx - 1;
    ch.set(slice, 1);
    chunks.push(ch);
  }

  const lastChunk = chunks[chunks.length - 1];
  let lastDataEnd = 0;
  for (let i = CHUNK_SIZE - 2; i >= 1; i--) {
    if (lastChunk[i] !== 0xff) { lastDataEnd = i; break; }
  }
  const lastOffset = lastDataEnd % CHUNK_DATA_SIZE;
  chunks[0][1] = lastOffset;

  if (lastOffset === 0) {
    const nextChunkNum = chunks.length + 1;
    chunks[chunks.length - 1][CHUNK_SIZE - 1] = nextChunkNum;
    const empty = new Uint8Array(CHUNK_SIZE).fill(0xff);
    empty[0] = chunks.length;
    chunks.push(empty);
  }

  const blob = new Uint8Array(chunks.length * CHUNK_SIZE);
  for (let i = 0; i < chunks.length; i++) {
    blob.set(chunks[i], i * CHUNK_SIZE);
  }

  const fsHex = bytesToIhex(cfg.startAddr, blob, cfg.universalDataRecord);
  const scratchHex = bytesToIhex(cfg.endAddr, new Uint8Array([0xfd]), cfg.universalDataRecord);

  const elaRecordLen = 16;
  if (fsHex.substring(0, elaRecordLen) === scratchHex.substring(0, elaRecordLen)) {
    return fsHex + "\n" + scratchHex.substring(elaRecordLen) + "\n";
  }
  return fsHex + "\n" + scratchHex + "\n";
}

// ── Padding ────────────────────────────────────────────────────────────────

function padHexString(hexStr: string, alignment: number = 512): string {
  const minPad = ":0000000CF4\n";
  const needed = alignment - ((hexStr.length + minPad.length) % alignment);
  if (needed === alignment) return hexStr;

  let result = hexStr;
  let remaining = needed;
  const maxDataChars = 32;
  const maxPad = `:${(maxDataChars / 2).toString(16).padStart(2, "0").toUpperCase()}00000C${"F".repeat(maxDataChars)}F4\n`;

  while (remaining >= maxPad.length) {
    result += maxPad;
    remaining -= maxPad.length;
  }
  if (remaining > maxDataChars) {
    const chars = remaining - minPad.length * 2;
    result += `:${(chars / 2).toString(16).padStart(2, "0").toUpperCase()}00000C${"F".repeat(chars)}F4\n`;
    remaining -= chars + minPad.length;
  }
  if (remaining > 0) {
    result += `:${(remaining / 2).toString(16).padStart(2, "0").toUpperCase()}00000C${"F".repeat(remaining)}F4\n`;
  }
  return result;
}

// ── Section injection ─────────────────────────────────────────────────────

/**
 * Inject filesystem hex into one universal-hex section.
 * Finds the UICR marker and inserts the padded filesystem records before it.
 */
function injectIntoSection(section: string, fsHexPadded: string): string {
  const uicrMarker = ":020000041000EA";
  const uicrIdx = section.lastIndexOf(uicrMarker);
  if (uicrIdx === -1) return section; // no UICR → unchanged

  let insertIdx = uicrIdx;
  if (section.substring(insertIdx - 18, insertIdx) === ":020000040000FA\n") {
    insertIdx -= 18;
  } else {
    const esaRecord = ":020000020000FC\n";
    if (insertIdx >= esaRecord.length && section.substring(insertIdx - esaRecord.length, insertIdx) === esaRecord) {
      insertIdx -= esaRecord.length;
    }
  }
  return section.substring(0, insertIdx) + fsHexPadded + section.substring(insertIdx);
}

// ── Main API ───────────────────────────────────────────────────────────────

/**
 * Embed a Python script into a micro:bit universal hex firmware template.
 *
 * Detects whether the template is V2-only (single section) or universal
 * (V1 + V2 sections) and injects the filesystem into every section.
 *
 * @param pythonScript - UTF-8 .py script content.
 * @param firmwareHex  - MicroPython firmware .hex template (V2-only or universal).
 * @returns Complete flashable .hex file.
 */
export function py2hex(pythonScript: string, firmwareHex: string): string {
  const normalized = pythonScript.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const scriptBytes = new TextEncoder().encode(normalized);

  if (scriptBytes.length === 0) {
    return firmwareHex;
  }

  // Detect universal hex: has two block-start sections (V1 + V2).
  const sectionStart = ":020000040000FA\n:0400000A";
  const firstSectionIdx = firmwareHex.indexOf(sectionStart);
  const secondSectionIdx = firmwareHex.indexOf(sectionStart, firstSectionIdx + sectionStart.length);

  if (secondSectionIdx === -1) {
    // ── Single section (V2-only or V1-only) ──────────────────────────
    const bsMarker = ":0400000A";
    const blockStartIdx = firmwareHex.indexOf(bsMarker);
    let deviceId = MICROBIT_ID_V2;
    if (blockStartIdx !== -1) {
      deviceId = firmwareHex.substring(blockStartIdx + bsMarker.length, blockStartIdx + bsMarker.length + 4);
    }
    const cfg = fsConfigFor(deviceId);
    const fsHex = scriptToFs(scriptBytes, cfg);
    const fsHexPadded = padHexString(fsHex);
    return injectIntoSection(firmwareHex, fsHexPadded);
  }

  // ── Universal hex (V1 + V2 sections) ───────────────────────────────
  const sections = [
    firmwareHex.substring(0, secondSectionIdx),
    firmwareHex.substring(secondSectionIdx),
  ];

  let result = "";
  const bsMarker = ":0400000A";
  for (const section of sections) {
    const blockStartIdx = section.indexOf(bsMarker);
    const deviceId = section.substring(blockStartIdx + bsMarker.length, blockStartIdx + bsMarker.length + 4);
    const cfg = fsConfigFor(deviceId);
    const fsHex = scriptToFs(scriptBytes, cfg);
    const fsHexPadded = padHexString(fsHex);
    result += injectIntoSection(section, fsHexPadded);
  }
  return result;
}

/**
 * Validate a script against the micro:bit filesystem size limit.
 * Uses the smaller of V1 and V2 limits (they're the same for practical purposes).
 */
export function validateScript(
  script: string
): { valid: true; size: number } | { valid: false; error: string; size: number } {
  const bytes = new TextEncoder().encode(script);
  const fsSize = FS_END_ADDR_V2 - FS_START_ADDR_V2;
  const maxSize = Math.floor((fsSize / CHUNK_SIZE) * CHUNK_DATA_SIZE) - 9;

  if (bytes.length === 0) return { valid: true, size: 0 };
  if (bytes.length >= maxSize) {
    return { valid: false, error: `Script too large: ${bytes.length} bytes (max ${maxSize})`, size: bytes.length };
  }
  return { valid: true, size: bytes.length };
}

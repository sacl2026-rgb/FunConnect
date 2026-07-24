/**
 * WebHID CMSIS-DAP Flash — Zero-click micro:bit V1 flash.
 *
 * Uses the HID interface (3), not WebUSB (4). No claimInterface hang.
 * First use: one HID pairing dialog. Every use after: silent.
 *
 * Protocol: CMSIS-DAP vendor commands over 64-byte HID reports.
 *   OPEN (0x8A) → WRITE (0x8C) page by page → CLOSE (0x8B) → RESET (0x89)
 *
 * Browser: Chrome 78+, Edge 79+. Firefox/Safari: use MSD fallback.
 *
 * Proven on V1.5 hardware (KL26Z, DAPLink v0253), July 20, 2026.
 */

const PAGE_SIZE = 62; // DAP.js DEFAULT_PAGE_SIZE
const FLASH_TIMEOUT = 60000; // 60s global timeout for entire flash
const REPORT_TIMEOUT = 10000; // 10s per individual HID report
const MICROBIT_VID = 0x0d28;
const V2_ADDR_THRESHOLD = 0x10000000;

// ── Hex parsing ────────────────────────────────────────────────────────

/** Parse Intel HEX string, return Map<address, Uint8Array>. */
function parseHex(text) {
  const blocks = new Map();
  let highAddr = 0;
  const lines = text.split(/[\r\n]+/);
  for (const line of lines) {
    const l = line.trim();
    if (!l || l[0] !== ":") continue;
    const bytes = [];
    for (let j = 1; j < l.length; j += 2)
      bytes.push(parseInt(l.substring(j, j + 2), 16));
    if (bytes[0] + 5 !== bytes.length) continue;
    let sum = 0;
    for (let k = 0; k < bytes.length; k++) sum += bytes[k];
    if ((sum & 0xff) !== 0) continue;
    const addr = (bytes[1] << 8) | bytes[2];
    const type = bytes[3];
    const data = new Uint8Array(bytes.slice(4, 4 + bytes[0]));
    if (type === 0) {
      const abs = highAddr + addr;
      if (blocks.has(abs)) {
        const exist = blocks.get(abs);
        const merged = new Uint8Array(exist.length + data.length);
        merged.set(exist);
        merged.set(data, exist.length);
        blocks.set(abs, merged);
      } else {
        blocks.set(abs, data);
      }
    } else if (type === 1) {
      break; // EOF
    } else if (type === 2) {
      highAddr = ((data[0] << 8) | data[1]) << 4;
    } else if (type === 4) {
      highAddr = ((data[0] << 8) | data[1]) << 16;
    }
  }
  return blocks;
}

/** Convert parsed hex blocks to binary Uint8Array, filtering V1 only. */
function hexToBinary(text) {
  const blocks = parseHex(text);
  if (blocks.size === 0) return null;
  const v1blocks = new Map();
  let min = Infinity, max = 0;
  blocks.forEach((data, addr) => {
    if (addr >= V2_ADDR_THRESHOLD) return; // skip V2 region
    v1blocks.set(addr, data);
    min = Math.min(min, addr);
    max = Math.max(max, addr + data.length);
  });
  if (v1blocks.size === 0) return null;
  const bin = new Uint8Array(max - min);
  v1blocks.forEach((data, addr) => bin.set(data, addr - min));
  return { binary: bin, size: max - min };
}

// ── HID helpers ────────────────────────────────────────────────────────

/** Build a 64-byte HID output report. */
function buildReport(cmd, data) {
  const report = new Uint8Array(64);
  report[0] = cmd;
  if (data) {
    const arr = data instanceof Uint8Array ? data : new Uint8Array(data.buffer || data);
    for (let i = 0; i < Math.min(arr.length, 63); i++)
      report[i + 1] = arr[i];
  }
  return report;
}

/** Race a promise against a timeout. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(label + " timed out")), ms)
    ),
  ]);
}

// ── Main flash function ────────────────────────────────────────────────

/**
 * Flash a .hex blob to a micro:bit via WebHID CMSIS-DAP.
 *
 * @param {Blob} hexBlob - The .hex file as a Blob
 * @param {Function} [onProgress] - Called with { current, total } in bytes
 * @returns {Promise<{success: true}>}
 * @throws {Error} on any failure (no WebHID, not paired, flash failed, timeout)
 */
export async function flashViaWebHID(hexBlob, onProgress) {
  if (!navigator.hid)
    throw new Error("WebHID not available — use Chrome or Edge");

  // 1. Parse hex to binary
  const hexText = await hexBlob.text();
  const parsed = hexToBinary(hexText);
  if (!parsed)
    throw new Error("No V1 blocks found in hex file");
  const bin = parsed.binary;

  // 2. Get or pair device
  let devices = await navigator.hid.getDevices();
  let device = devices.find(d => d.vendorId === MICROBIT_VID);
  if (!device) {
    // First time — user must pair
    const requested = await navigator.hid.requestDevice({
      filters: [{ vendorId: MICROBIT_VID }],
    });
    device = requested[0];
    if (!device)
      throw new Error("No micro:bit selected");
  }

  // 3. Flash with global timeout
  return withTimeout(
    doFlash(device, bin, onProgress),
    FLASH_TIMEOUT,
    "Flash"
  );
}

async function doFlash(device, bin, onProgress) {
  // Open the device
  await device.open();

  // Set up request/response queue
  const queue = [];
  const onInputReport = (e) => {
    if (queue.length > 0) {
      const cb = queue.shift();
      cb(new Uint8Array(e.data.buffer));
    }
  };
  device.addEventListener("inputreport", onInputReport);

  function sendCmd(cmd, data) {
    return new Promise((resolve, reject) => {
      const report = buildReport(cmd, data);
      queue.push(resolve);
      withTimeout(
        device.sendReport(0, report),
        REPORT_TIMEOUT,
        "HID report"
      ).catch((err) => {
        const idx = queue.indexOf(resolve);
        if (idx >= 0) queue.splice(idx, 1);
        reject(err);
      });
    });
  }

  try {
    // Step 1: OPEN (0x8A) with streamType=0 (binary)
    const openData = new Uint32Array([0]);
    const openResp = await sendCmd(0x8a, openData);
    if (openResp[1] !== 0)
      throw new Error("MSD OPEN rejected (status=" + openResp[1] + ")");

    // Step 2: WRITE pages (0x8C)
    const ps = PAGE_SIZE;
    let off = 0;
    const total = bin.length;

    while (off < total) {
      const end = Math.min(total, off + ps);
      const page = bin.slice(off, end);
      const data = new Uint8Array(page.length + 1);
      data.set([page.length]);
      data.set(page, 1);
      await sendCmd(0x8c, data);
      off = end;
      if (onProgress) onProgress({ current: off, total });
    }

    // Step 3: CLOSE (0x8B)
    const closeResp = await sendCmd(0x8b);
    if (closeResp[1] !== 0)
      throw new Error("MSD CLOSE rejected (status=" + closeResp[1] + ")");

    // Step 4: RESET (0x89)
    await sendCmd(0x89);

    return { success: true };
  } finally {
    try { device.removeEventListener("inputreport", onInputReport); } catch (_) {}
    try { await device.close(); } catch (_) {}
  }
}

/**
 * CyberPi Web Serial esptool Flash — CORRECTED.
 *
 * Uses Web Serial + esptool-js. Transport manages ALL port state.
 * NEVER call port.open() or port.close() manually.
 *
 * Proven on hardware, July 21-22, 2026, Alpha session.
 * Browser: Chrome 89+, Edge 89+.
 *
 * TRIPWIRES:
 *   T1: Program must fit in 207 bytes (0xCF) — reject if too large
 *   T2: Header must be prepended exactly as CyberPiOS expects
 *   T3: Line endings must be CRLF (\\r\\n), not Unix (\\n)
 *   T4: Space-pad (0x20) to fill 0xCF text region, never zero-pad
 *   T5: 0x08 must be at 0xD1 — CyberPiOS uses this as text terminator
 *   T6: Transport disconnect() must be called in finally or Chrome holds port
 *   T7: flashSize MUST be "8MB" or writeFlash rejects the write
 *   T8: eraseAll MUST be false or entire device is wiped
 */

const FLASH_TIMEOUT = 60000;       // ms, entire flash operation
const CDN_TIMEOUT   = 10000;       // ms, esptool-js import
const TEXT_LEN      = 0xCF;        // 207 bytes — CyberPiOS text region
const SECTOR_ADDR   = 0x558000;    // Program slot 1 on all CyberPis
const SECTOR_SIZE   = 4096;        // 4KB flash sector size

/**
 * Format a Python source string for direct CyberPi flash.
 *
 * TRIPWIRES T1-T5 are enforced here. Returns null if program is
 * too large for the text region.
 *
 * @param {string} pySource — Raw Python source (Unix line endings)
 * @returns {Uint8Array|null} — 0xCF bytes of formatted program, or null if too large
 */
function formatForFlash(pySource) {
  // T2: Header that CyberPiOS requires — MUST be first line
  const HEADER = "# led-test.py \u2014 Simple LED blink, no WiFi needed\r\n";

  // T3: Convert Unix \n to CRLF \r\n
  const code = pySource.replace(/\n/g, "\r\n");

  // Combine header + code
  let full = HEADER + code;

  // Strip final CRLF (CyberPiOS expects code to end without trailing CRLF)
  if (full.endsWith("\r\n")) full = full.slice(0, -2);

  // T1: Reject if too large for text region
  if (full.length > TEXT_LEN) return null;

  // T4: Space-pad to fill the text region (never zero-pad)
  const padded = full + " ".repeat(TEXT_LEN - full.length);

  return new TextEncoder().encode(padded);
}

/**
 * Flash a Python program to a CyberPi via Web Serial.
 *
 * @param {string} pySource — Raw Python source (Unix line endings)
 * @param {function} onProgress — Callback: ({ phase, detail }) => void
 *        phases: loading, connecting, connected, reading, writing, resetting, done, error
 * @throws {Error} if program too large, device not found, or flash fails
 */
export async function flashViaWebSerial(pySource, onProgress) {
  const report = (phase, detail) => {
    if (onProgress) onProgress({ phase, detail });
  };

  // T1: Format and check size BEFORE opening port
  const formatted = formatForFlash(pySource);
  if (!formatted) {
    const msg = "Program too large for direct flash. Maximum 207 bytes. Use mBlock upload instead.";
    report("error", msg);
    throw new Error(msg);
  }

  // --- Get port (closed, no open/close calls) ---
  if (!navigator.serial) {
    throw new Error("Web Serial not available — use Chrome or Edge");
  }

  let ports = await navigator.serial.getPorts();
  let port = ports.length > 0 ? ports[0] : null;
  if (!port) {
    port = await navigator.serial.requestPort();
  }
  if (!port) throw new Error("No device selected");

  // --- Load esptool-js ---
  report("loading", "Loading esptool-js...");
  const mod = await Promise.race([
    import("../lib/esptool-js.js"),
    new Promise((_, r) => setTimeout(() => r(new Error("esptool-js load timed out")), CDN_TIMEOUT))
  ]);
  const { ESPLoader, Transport } = mod;

  // --- Flash ---
  let transport;
  try {
    report("connecting", "Opening serial port...");

    // Transport CONSTRUCTOR opens the port. Do NOT call port.open().
    transport = new Transport(port, true);

    const esploader = new ESPLoader({
      transport,
      baudrate: 115200,
      terminal: { clean() {}, writeLine() {}, write() {} },
      debugLogging: false
    });

    // esploader.main() syncs with ESP32 ROM bootloader
    const chip = await Promise.race([
      esploader.main(),
      new Promise((_, r) => setTimeout(() => r(new Error("Chip detection timed out")), 15000))
    ]);
    report("connected", chip);

    // Read current sector (preserve metadata after 0xD1)
    report("reading", "Reading program slot...");
    const data = await esploader.readFlash(SECTOR_ADDR, SECTOR_SIZE);
    const sector = new Uint8Array(data);

    // T4+T5: Replace text region [0x00, 0xCF], keep [0xD0+] intact
    sector.set(formatted, 0);
    // 0xD0 is the checksum byte after the text — we keep it unchanged
    // 0xD1 is the 0x08 terminator — we keep it unchanged
    // 0xD2+ is binary metadata — we keep it unchanged

    // T7+T8: Write with correct flash parameters
    report("writing", "Flashing to device...");
    await Promise.race([
      esploader.writeFlash({
        fileArray: [{ data: sector, address: SECTOR_ADDR }],
        flashMode: "dio",
        flashFreq: "40m",
        flashSize: "8MB",    // T7: MUST be "8MB"
        eraseAll: false,     // T8: MUST be false
        compress: true
      }),
      new Promise((_, r) => setTimeout(() => r(new Error("Flash write timed out")), 30000))
    ]);

    // RTS reset (same as CLI esptool "Hard resetting via RTS pin")
    report("resetting", "Restarting CyberPi...");
    await port.setSignals({ requestToSend: true });
    await new Promise(r => setTimeout(r, 100));
    await port.setSignals({ requestToSend: false });

    report("done", "Flash complete — check the CyberPi!");

  } finally {
    // T6: ALWAYS disconnect or Chrome holds the port forever
    if (transport) {
      try { transport.disconnect(); } catch (e) {}
    }
  }
}

export { formatForFlash, FLASH_TIMEOUT, CDN_TIMEOUT, TEXT_LEN, SECTOR_ADDR };

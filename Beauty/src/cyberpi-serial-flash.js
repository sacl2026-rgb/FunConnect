/**
 * CyberPi Web Serial esptool Flash.
 *
 * Uses Web Serial + esptool-js. Transport manages ALL port state.
 * NEVER call port.open() or port.close() manually.
 *
 * Proven on hardware, July 21, 2026, Alpha session.
 * Browser: Chrome 89+, Edge 89+.
 */

const FLASH_TIMEOUT = 60000;
const CDN_TIMEOUT = 10000;

export async function flashViaWebSerial(pySource, onProgress) {
  // 1. Get port — NO open, NO close. Just get the object.
  let ports = await navigator.serial.getPorts();
  let port = ports.length > 0 ? ports[0] : null;
  if (port) {
    onProgress && onProgress({ phase: "reconnected", detail: "Reconnected to CyberPi — no pairing needed" });
  } else {
    port = await navigator.serial.requestPort();
  }
  if (!port) throw new Error("No device selected");

  // 2. Load esptool-js with timeout
  const mod = await Promise.race([
    import("../lib/esptool-js.js"),
    new Promise((_, r) => setTimeout(() => r(new Error("esptool-js load timed out")), CDN_TIMEOUT))
  ]);
  const { ESPLoader, Transport } = mod;

  // 3. Flash — Transport manages ALL port state
  let transport;
  try {
    // Transport CONSTRUCTOR opens the port. Do NOT call port.open().
    transport = new Transport(port, true);

    const esploader = new ESPLoader({
      transport,
      baudrate: 115200,
      terminal: {
        clean() {},
        writeLine() {},
        write() {}
      },
      debugLogging: false
    });

    // esploader.main() handles boot sync — no manual drain needed
    const chip = await esploader.main();
    onProgress && onProgress({ phase: "connected", detail: chip });

    // Read the program slot
    const data = await esploader.readFlash(0x558000, 4096);
    const sector = new Uint8Array(data);

    // Pad the source to exactly the text region (0xCF bytes), space-fill remaining
    const core = pySource.trimEnd();
    const padded = core + " ".repeat(Math.max(0, 0xCF - core.length));
    const encoded = new TextEncoder().encode(padded);

    // Replace code from offset 0, space-pad to 0xD1
    sector.set(encoded, 0);
    for (let i = encoded.length; i < 0xD1; i++) sector[i] = 0x20;

    // Write back
    await esploader.writeFlash({
      fileArray: [{ data: sector, address: 0x558000 }],
      flashMode: "dio",
      flashFreq: "40m",
      flashSize: "8MB",
      eraseAll: false,
      compress: true
    });

    onProgress && onProgress({ phase: "writing", detail: "Flash written" });

    // RTS reset
    await port.setSignals({ requestToSend: true });
    await new Promise(r => setTimeout(r, 100));
    await port.setSignals({ requestToSend: false });

    onProgress && onProgress({ phase: "done", detail: "Flash complete" });

  } finally {
    // Transport disconnect handles port.close() internally
    if (transport) {
      try { transport.disconnect(); } catch (e) {}
    }
  }
}

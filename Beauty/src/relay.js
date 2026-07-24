/**
 * WebSerial relay — bridges CyberPi USB serial ↔ WSS to DO.
 * No popup, no mBlock, no mLink2. Runs invisibly in-page.
 *
 * Lifecycle:
 *   connectSerial(deviceId)  → opens COM port + WSS, returns handles
 *   startRelay(port, ws, deviceId) → bidirectional relay loop, BroadcastChannel
 *   disconnectRelay()        → clean shutdown, closes port + ws
 *
 * Relay persists across tab switches (hash routing = re-renders, not navigations).
 * Disconnects only on page unload or manual disconnect.
 */

const WS_BASE = "wss://funconnect-v1.funconnect.workers.dev";

// Module-level state — survives React re-renders.
let active = null; // { port, ws, deviceId, channel, writer }

export function getActiveRelay() {
  return active;
}

/** Send a line to the serial device through the active relay. */
export function sendToDevice(text) {
  if (!active || !active.writer) return false;
  try {
    active.writer.write(new TextEncoder().encode(text + "\n"));
    return true;
  } catch {
    return false;
  }
}

/** Open serial port + WSS. User-gesture-gated (must be called from click handler). */
export async function connectSerial(deviceId) {
  if (active) await disconnectRelay();

  const port = await navigator.serial.requestPort();
  await port.open({ baudRate: 115200 });

  const ws = new WebSocket(`${WS_BASE}/device/${encodeURIComponent(deviceId)}`);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("WSS connection failed — is the Worker deployed?"));
  });

  active = { port, ws, deviceId, channel: null };
  return { port, ws, deviceId };
}

/** Start bidirectional relay loop. Non-blocking — returns immediately. */
export function startRelay(port, ws, deviceId) {
  const channel = new BroadcastChannel("relay");
  const reader = port.readable.getReader();
  const writer = port.writable.getWriter();
  // Store in module-level state so disconnectRelay() and beforeunload can clean up.
  active = { port, ws, deviceId, channel, writer };
  const textDecoder = new TextDecoder();
  let buffer = "";
  let firstByte = false;

  // Serial → WSS (line-delimited JSON)
  (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!firstByte && value && value.length > 0) {
          firstByte = true;
          channel.postMessage({ type: "first-byte", deviceId });
        }
        buffer += textDecoder.decode(value);
        const lines = buffer.split("\n");
        buffer = lines.pop(); // incomplete last line
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && ws.readyState === WebSocket.OPEN) {
            ws.send(trimmed);
          }
        }
      }
    } catch {
      // Port closed or errored — expected on disconnect.
    }
  })();

  // WSS → Serial (commands from DO: echo, exec, set_led, etc.)
  ws.addEventListener("message", (event) => {
    try {
      writer.write(new TextEncoder().encode(event.data + "\n"));
    } catch {
      // Writer closed.
    }
  });

  // Detect port disconnect.
  port.addEventListener("disconnect", () => {
    disconnectRelay();
  });

  channel.postMessage({ type: "connected", deviceId });
}

/** Clean shutdown — close WSS, close port, broadcast disconnect. */
export async function disconnectRelay() {
  if (!active) return;
  const { port, ws, deviceId, channel } = active;
  active = null;

  try { ws.close(); } catch {}
  try { await port.close(); } catch {}

  if (channel) {
    channel.postMessage({ type: "disconnected", deviceId });
    channel.close();
  }
}

// Auto-disconnect on page unload.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    if (active && active.port) {
      try { active.ws.close(); } catch {}
      try { active.port.close(); } catch {}
      active = null;
    }
  });
}

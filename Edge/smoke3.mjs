import WebSocket from "ws";

const DEVICE = `cyberpi-${Date.now()}`; // fresh ID to avoid stale DO
const URL = `wss://funconnect-v1.funconnect.workers.dev/device/${DEVICE}`;

const ws = new WebSocket(URL);
let received = [];

ws.on("open", () => {
  console.log(`CONNECTED (${DEVICE})`);
  ws.send(JSON.stringify({ type: "hello", device_id: DEVICE }));
});

ws.on("message", (data) => {
  const m = JSON.parse(data.toString());
  console.log(`${m.type} ${m.device_id || ""}`);
  received.push(m.type);
  // Exit on sync — the close handshake can be slow across Cloudflare edge.
  if (received.includes("welcome") && received.includes("sync")) {
    console.log("PASS: welcome + sync received");
    ws.close();
    process.exit(0);
  }
});

setTimeout(() => {
  console.log(`TIMEOUT — received: ${JSON.stringify(received)}`);
  process.exit(1);
}, 10000);

import WebSocket from "ws";

const DEVICE = `cyberpi-missing-${Date.now()}`;
const URL = `wss://funconnect-v1.funconnect.workers.dev/device/${DEVICE}`;

const ws = new WebSocket(URL);
let received = [];

ws.on("open", () => {
  console.log(`CONNECTED (${DEVICE})`);
  // Send state WITHOUT telemetry sub-object
  ws.send(JSON.stringify({
    type: "state",
    device_id: DEVICE,
    esp32_ms: 9999,
  }));
});

ws.on("message", (data) => {
  const m = JSON.parse(data.toString());
  console.log(`${m.type}${m.ref ? ` ref=${m.ref}` : ""}`);
  received.push(m.type);

  if (m.type === "ack" && m.ref === "state") {
    console.log("PASS: state ack received with missing telemetry");
    ws.close();
    process.exit(0);
  }
});

ws.on("close", () => process.exit(received.includes("ack") ? 0 : 1));

setTimeout(() => {
  console.log(`TIMEOUT — received: ${JSON.stringify(received)}`);
  process.exit(1);
}, 10000);

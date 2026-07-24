import WebSocket from "ws";

const DEVICE = `cyberpi-${Date.now()}`;
const URL = `wss://funconnect-v1.funconnect.workers.dev/device/${DEVICE}`;

const ws = new WebSocket(URL);
let received = [];
let ackReceived = false;

ws.on("open", () => {
  console.log(`CONNECTED (${DEVICE})`);

  // Send hello first to establish the session
  ws.send(JSON.stringify({
    type: "hello",
    device_id: DEVICE,
  }));
});

ws.on("message", (data) => {
  const m = JSON.parse(data.toString());
  console.log(`${m.type}${m.ref ? ` ref=${m.ref}` : ""}${m.doTs ? ` doTs=${m.doTs}` : ""}`);
  received.push(m.type);

  if (m.type === "welcome") {
    // After welcome, send state with full telemetry payload
    ws.send(JSON.stringify({
      type: "state",
      device_id: DEVICE,
      esp32_ms: 1234,
      telemetry: {
        tilt: 0.5,
        vibration: 0.1,
        acc_x: 0.01, acc_y: 0.02, acc_z: 0.98,
        gyro_x: 0.1, gyro_y: -0.2, gyro_z: 0.05,
      },
    }));
  }

  if (m.type === "ack" && m.ref === "state") {
    ackReceived = true;
  }

  // Both sync (hello response) and ack (state response) received
  if (m.type === "ack" && received.includes("sync")) {
    console.log("PASS: hello → welcome+sync, state → ack");
    ws.close();
    process.exit(0);
  }
});

ws.on("close", () => process.exit(ackReceived ? 0 : 1));

setTimeout(() => {
  console.log(`TIMEOUT — received: ${JSON.stringify(received)}`);
  process.exit(1);
}, 10000);

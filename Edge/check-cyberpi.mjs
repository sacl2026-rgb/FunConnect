// Check both DO-local buffer and D1 for device_id="cyberpi"
const DEVICE = "cyberpi";

// DO-local buffer
const doRes = await fetch(
  `https://funconnect-v1.funconnect.workers.dev/do-telemetry-count?device=${DEVICE}`
);
const doData = await doRes.json();
console.log(`DO-local telemetry_buffer: ${JSON.stringify(doData)}`);

// Also check hello_log
const helloRes = await fetch(
  `https://funconnect-v1.funconnect.workers.dev/do-hello-count?device=${DEVICE}`
);
const helloData = await helloRes.json();
console.log(`DO-local hello_log:        ${JSON.stringify(helloData)}`);

// D1 telemetry — filtered to cyberpi only (not cyberpi-*)
const TOKEN = "CF_TOKEN_PLACEHOLDER";
const ACCOUNT = "CF_ACCOUNT_ID_PLACEHOLDER";
const DB = "a3a8950d-c028-4ef4-b05c-982a10b9b2a6";

const d1Res = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/raw`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sql: `SELECT tilt, vibration, acc_x, acc_y, acc_z, gyro_x, gyro_y, gyro_z, uptime_ms, do_ms, created_at FROM telemetry WHERE device_id = '${DEVICE}' ORDER BY created_at DESC LIMIT 10`,
    }),
  }
);
const d1Data = await d1Res.json();
if (d1Data.success) {
  const rows = d1Data.result[0].results.rows;
  console.log(`\nD1 telemetry for '${DEVICE}': ${rows.length} rows`);
  for (const r of rows) {
    console.log(`  tilt=${r[0]} vib=${r[1]} acc=(${r[2]},${r[3]},${r[4]}) gyro=(${r[5]},${r[6]},${r[7]}) uptime=${r[8]} do_ms=${r[9]} created=${r[10]}`);
  }
}

// Also check D1 hello_log
const d1Hello = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/raw`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sql: `SELECT device_id, timestamp, id FROM hello_log WHERE device_id = '${DEVICE}' ORDER BY id DESC LIMIT 5`,
    }),
  }
);
const d1HelloData = await d1Hello.json();
if (d1HelloData.success) {
  const hrows = d1HelloData.result[0].results.rows;
  console.log(`\nD1 hello_log for '${DEVICE}': ${hrows.length} rows`);
  for (const r of hrows) {
    console.log(`  id=${r[2]} device_id=${r[0]} timestamp=${r[1]}`);
  }
}

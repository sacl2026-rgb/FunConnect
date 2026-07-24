const TOKEN = "CF_TOKEN_PLACEHOLDER";
const ACCOUNT = "CF_ACCOUNT_ID_PLACEHOLDER";
const DB = "a3a8950d-c028-4ef4-b05c-982a10b9b2a6";

const sql = `SELECT device_id, tilt, vibration, acc_x, acc_y, acc_z, gyro_x, gyro_y, gyro_z, uptime_ms, do_ms FROM telemetry ORDER BY created_at DESC LIMIT 5`;

const res = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/raw`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql }),
  }
);

const data = await res.json();
if (data.success) {
  const rows = data.result[0].results.rows;
  console.log(`${rows.length} rows:`);
  for (const r of rows) {
    console.log(`  ${r[0]} tilt=${r[1]} vib=${r[2]} acc=(${r[3]},${r[4]},${r[5]}) gyro=(${r[6]},${r[7]},${r[8]})`);
  }
} else {
  console.log("Error:", JSON.stringify(data.errors));
}

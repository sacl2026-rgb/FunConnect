// Live end-to-end: real chat() RAG pipeline → real Qwen (DashScope intl).
// Key comes from env (QWEN_KEY) so it never lives in this file.
//   QWEN_KEY='sk-...' node live-qwen.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = require(fileURLToPath(new URL("../Edge/node_modules/esbuild/", import.meta.url)));

const built = await esbuild.build({
  entryPoints: [fileURLToPath(new URL("./chat.ts", import.meta.url))],
  bundle: false, format: "esm", platform: "neutral", target: "es2022", write: false,
});
const mod = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
const { chat, dashScope } = mod;

const KEY = process.env.QWEN_KEY;
if (!KEY) { console.error("set QWEN_KEY"); process.exit(1); }

const NOW = Date.now();
const mj = (o) => JSON.stringify(o);
const ROWS = [
  { id: 101, device_id: "cyberpi", event: "disturbance", created_at: (NOW - 180000) / 1000 | 0, do_ms: NOW - 180000,
    madgwick_json: mj({ a_trans: { x: 1.8, y: 0.5, z: 0.9 }, roll: 178, pitch: 4, freefall: false, classification: "crash" }) },
  { id: 100, device_id: "cyberpi", event: "disturbance", created_at: (NOW - 600000) / 1000 | 0, do_ms: NOW - 600000,
    madgwick_json: mj({ a_trans: { x: 0.1, y: 0.1, z: 0.1 }, roll: 20, pitch: 10, freefall: true, classification: "freefall" }) },
  { id: 99, device_id: "cyberpi", event: "disturbance", created_at: (NOW - 1800000) / 1000 | 0, do_ms: NOW - 1800000,
    madgwick_json: mj({ a_trans: { x: 0.6, y: 0.2, z: 0.3 }, roll: 8, pitch: 3, freefall: false, classification: "bump" }) },
];
const db = { prepare: () => ({ bind() { return this; }, async all() { return { results: ROWS }; } }) };
const provider = dashScope(KEY); // defaults: dashscope-intl + qwen-plus

const questions = [
  "Why did my robot fall?",
  "Is my robot okay now?",
  "How many times did it get bumped or crashed today?",
];

for (const q of questions) {
  const { reply, context } = await chat(q, db, {}, { provider });
  console.log("\n──────────────────────────────────────────");
  console.log("Q:", q);
  console.log("A:", reply);
  console.log("   grounded in:", context.map((c) => `${c.classification}/${c.impact_g}g/${c.ago}`).join(" · "));
}
console.log();

// Smoke test for chat.ts — proves the RAG logic end-to-end with NO real AI and
// NO network. Transpiles chat.ts with Edge's esbuild, feeds a fake D1 and a stub
// LLM provider, and asserts intent → selection → prompt → contract.
//
//   node smoke-chat.mjs
//
// This is the "prove the logic before wiring the real binding" step: Workers AI
// is metered and the DO path is opaque, so we validate the puppet-theater
// wiring here where every input is controllable.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = require(fileURLToPath(new URL("../Edge/node_modules/esbuild/", import.meta.url)));

// ── Transpile chat.ts → in-memory ESM, import via data: URL (no temp files) ──
const chatTs = fileURLToPath(new URL("./chat.ts", import.meta.url));
const built = await esbuild.build({
  entryPoints: [chatTs],
  bundle: false,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  write: false,
});
const js = built.outputFiles[0].text;
const mod = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
const { chat, enrichAlert, describeOrientation, describeImpact, detectIntent, selectContext, humanAgo, fallbackReply, cleanReply, signatureInfo, baselineFor, impactDirection, madgwickGating, isCuriosityQuestion, isTechnicalQuery, searchCorpus, buildCorpusPrompt, buildFtsQuery } = mod;

// ── Test harness ─────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? "  — " + detail : ""}`); }
}

const NOW = Date.now();
const min = (n) => NOW - n * 60_000;
const hr = (n) => NOW - n * 3_600_000;
const day = (n) => NOW - n * 86_400_000;

function mj(o) { return JSON.stringify(o); }

// Seeded alert rows (as they come out of D1). Mix in a null and a malformed row
// to prove the enrichment drops them instead of crashing.
const ROWS = [
  { id: 101, device_id: "cyberpi", event: "disturbance", signature: 44, created_at: Math.floor(min(3) / 1000), do_ms: min(3),
    madgwick_json: mj({ a_trans: { x: 1.8, y: 0.5, z: 0.9 }, roll: 178, pitch: 4, freefall: false, classification: "crash" }) },
  { id: 100, device_id: "cyberpi", event: "disturbance", signature: 8, created_at: Math.floor(min(10) / 1000), do_ms: min(10),
    madgwick_json: mj({ a_trans: { x: 0.1, y: 0.1, z: 0.1 }, roll: 20, pitch: 10, freefall: true, classification: "freefall" }) },
  { id: 99, device_id: "cyberpi", event: "disturbance", signature: 16, created_at: Math.floor(min(30) / 1000), do_ms: min(30),
    madgwick_json: mj({ a_trans: { x: 0.6, y: 0.2, z: 0.3 }, roll: 8, pitch: 3, freefall: false, classification: "bump" }) },
  { id: 98, device_id: "cyberpi", event: "disturbance", signature: 1, created_at: Math.floor(hr(2) / 1000), do_ms: hr(2),
    madgwick_json: mj({ a_trans: { x: 0.2, y: 0.25, z: 0.2 }, roll: 5, pitch: 2, freefall: false, classification: "vibration" }) },
  { id: 97, device_id: "cyberpi", event: "disturbance", signature: null, created_at: Math.floor(day(1) / 1000), do_ms: day(1),
    madgwick_json: mj({ a_trans: { x: 0.1, y: 0.1, z: 0.05 }, roll: 40, pitch: 12, freefall: false, classification: "tilt" }) },
  { id: 96, device_id: "cyberpi", event: "disturbance", signature: 63, created_at: Math.floor(day(1) / 1000), do_ms: day(1), madgwick_json: null },
  { id: 95, device_id: "cyberpi", event: "disturbance", signature: 0, created_at: Math.floor(day(1) / 1000), do_ms: day(1), madgwick_json: "{bad json" },
];

// Fake D1: prepare().bind().all() returns our seeded rows verbatim.
// For corpus FTS5 queries, returns empty — curiosity questions fall through
// to the alert path when no FTS5 data is available.
function fakeDB(rows) {
  return {
    prepare(sql) {
      const stmt = { sql, args: [] };
      stmt.bind = (...a) => { stmt.args = a; return stmt; };
      stmt.all = async () => {
        if (/corpus_fts/i.test(sql)) return { results: [] };
        return { results: rows };
      };
      return stmt;
    },
  };
}

// Recording stub provider: captures the last prompt + opts, returns a canned reply.
function recorder(reply = "STUB-REPLY") {
  const rec = { system: null, user: null, opts: null, reply };
  rec.provider = { async generate(system, user, opts) { rec.system = system; rec.user = user; rec.opts = opts; return reply; } };
  return rec;
}

const db = fakeDB(ROWS);
const dummyAi = {}; // never used — every test passes an explicit provider

// Seeded corpus blocks for FTS5 smoke tests.
const CORPUS_BLOCKS = [
  { title: "Why Quaternions", content: "Quaternions avoid gimbal lock. Euler angles explode at ±90° pitch. Quaternions use 4 numbers, one normalize is trivial.", tier: "physics", family: null, signature: null, rank: -0.5 },
  { title: "Madgwick Filter Overview", content: "The Madgwick filter fuses gyroscope and accelerometer data using gradient descent. Beta controls trust between sensors. Adaptive beta changes this per sample.", tier: "physics", family: null, signature: null, rank: -0.3 },
  { title: "Sig 44: Side-angle hit", content: "Two accel axes (X+Z) plus gyro. Diagonal force at 45°. Corner impact. Physics: compound vector, centripetal coupling.", tier: "signature", family: "corner", signature: 44, rank: -0.8 },
  { title: "Freefall Physics", content: "During freefall, all accelerometer axes read near zero. The Madgwick filter detects this via the freefall flag. Drop signatures 8-15.", tier: "triage", family: "drop", signature: null, rank: -0.6 },
];

// Fake D1 that handles both alert queries AND FTS5 corpus queries.
function fakeD1WithFTS(alertRows, corpusBlocks = CORPUS_BLOCKS) {
  return {
    prepare(sql) {
      const stmt = { sql, args: [] };
      stmt.bind = (...a) => { stmt.args = a; return stmt; };
      stmt.all = async () => {
        if (/corpus_fts/i.test(sql)) {
          // FTS5 query — return matching corpus blocks.
          // The real searchCorpus now calls buildFtsQuery which joins content
          // words with OR. Strip the literal "OR" tokens and match any term.
          const raw = (stmt.args[0] || '').toLowerCase();
          const terms = raw.split(/\s+/).filter(w => w !== 'or' && w.length > 1);
          const limit = stmt.args[1] || 3;
          const matched = corpusBlocks
            .filter(b => {
              const hay = (b.title + ' ' + b.content).toLowerCase();
              return terms.some(word => hay.includes(word));
            })
            .slice(0, limit);
          return { results: matched };
        }
        // Default: alert query.
        return { results: alertRows };
      };
      return stmt;
    },
  };
}

// ── 1. Pure enrichment ───────────────────────────────────────────────────────
console.log("\n[1] Enrichment (pure)");
{
  const a = enrichAlert(ROWS[0], NOW);
  ok("impact_g = |a_trans| ≈ 2.07", Math.abs(a.impact_g - 2.07) < 0.02, `got ${a.impact_g}`);
  ok("classification = crash", a.classification === "crash");
  ok("orientation = flipped nearly upside down", a.orientation === "flipped nearly upside down", a.orientation);
  ok("ago = 3 minutes ago", a.ago === "3 minutes ago", a.ago);
  ok("null madgwick_json → dropped", enrichAlert(ROWS[5], NOW) === null);
  ok("malformed madgwick_json → dropped", enrichAlert(ROWS[6], NOW) === null);
  ok("context object has no raw samples/madgwick_json", !("samples" in a) && !("madgwick_json" in a));
  // New pre-resolved fields from keyed reference lookups.
  ok("signature 44 → 'Side-angle hit'", a.signature_name === "Side-angle hit", a.signature_name);
  ok("signature 44 → family 'corner'", a.signature_family === "corner", a.signature_family);
  ok("baseline_comparison present", a.baseline_comparison.length > 10, a.baseline_comparison);
  ok("impact_direction present", a.impact_direction.length > 5, a.impact_direction);
  ok("signature null → name null (row 97)", enrichAlert(ROWS[4], NOW)?.signature_name === null);
  ok("signature null → family null", enrichAlert(ROWS[4], NOW)?.signature_family === null);
}

// ── 2. Humanizers ────────────────────────────────────────────────────────────
console.log("\n[2] Humanizers (pure)");
ok("describeOrientation(178,4) flipped", describeOrientation(178, 4) === "flipped nearly upside down");
ok("describeOrientation(2,1) upright", describeOrientation(2, 1) === "stayed the right way up");
ok("describeImpact(2.07) firm bump analogy", /falling book/.test(describeImpact(2.07)));
ok("humanAgo(3s) = just now", humanAgo(3000) === "just now");
ok("humanAgo(180s) ≈ 3 minutes", humanAgo(180000) === "3 minutes ago");

// ── 2b. Keyed reference lookups (new — "resolve in code, not in the prompt") ──
console.log("\n[2b] Keyed reference lookups (pure)");
{
  // signatureInfo
  ok("signatureInfo(44) → Side-angle hit", signatureInfo(44)?.name === "Side-angle hit");
  ok("signatureInfo(44) → corner family", signatureInfo(44)?.family === "corner");
  ok("signatureInfo(0) → Silent trigger (noise)", signatureInfo(0)?.name === "Silent trigger" && signatureInfo(0)?.family === "noise");
  ok("signatureInfo(63) → Full crash", signatureInfo(63)?.name === "Full crash" && signatureInfo(63)?.family === "crash");
  ok("signatureInfo(null) → null", signatureInfo(null) === null);
  ok("signatureInfo(-1) → null (out of range)", signatureInfo(-1) === null);
  ok("signatureInfo(64) → null (out of range)", signatureInfo(64) === null);

  // baselineFor
  ok("baselineFor(0.1) → noise floor", baselineFor(0.1) === "below the sensor noise floor — probably benign");
  ok("baselineFor(0.3) → fingertip", /gentle tap/.test(baselineFor(0.3)));
  ok("baselineFor(0.7) → firm poke", /firm poke/.test(baselineFor(0.7)));
  ok("baselineFor(1.5) → solid shove", /solid shove/.test(baselineFor(1.5)));
  ok("baselineFor(2.5) → book falling flat", /book falling flat/.test(baselineFor(2.5)));
  ok("baselineFor(4.0) → hard fall", /hard fall/.test(baselineFor(4.0)));
  ok("baselineFor(6.0) → violent impact", /violent/.test(baselineFor(6.0)));

  // impactDirection
  ok("impactDirection(1.8, 0.5, 0.9) includes 'right side'", /right side/.test(impactDirection(1.8, 0.5, 0.9)));
  ok("impactDirection(-1.0, 0.1, 0.0) → left side", /left side/.test(impactDirection(-1.0, 0.1, 0.0)));
  ok("impactDirection(0.0, 1.0, 0.0) → front", /front/.test(impactDirection(0.0, 1.0, 0.0)));
  ok("impactDirection(0.0, -1.0, 0.0) → behind", /behind/.test(impactDirection(0.0, -1.0, 0.0)));
  ok("impactDirection(0.0, 0.0, -1.0) → straight down", /straight down/.test(impactDirection(0.0, 0.0, -1.0)));
  ok("impactDirection(0.7, 0.7, 0.7) → multi-directional", /multi-directional/.test(impactDirection(0.7, 0.7, 0.7)));
  ok("impactDirection(0.01, 0.01, 0.0) → too gentle", /too gentle/.test(impactDirection(0.01, 0.01, 0.0)));
  ok("impactDirection(1.8, 0.5, 1.0) has 'slightly' sub-direction", /slightly/.test(impactDirection(1.8, 0.5, 1.0)));

  // madgwickGating
  ok("madgwickGating('crash') → confirms_severity_only", madgwickGating("crash") === "confirms_severity_only");
  ok("madgwickGating('ghost') → required", madgwickGating("ghost") === "required");
  ok("madgwickGating('bump') → important_on_no_gyro", madgwickGating("bump") === "important_on_no_gyro");
  ok("madgwickGating(null) → null", madgwickGating(null) === null);
}

// ── 3. Intent detection ──────────────────────────────────────────────────────
console.log("\n[3] Intent detection (pure)");
{
  const i1 = detectIntent("why did my robot fall?");
  ok("'fall' → freefall+crash", i1.classes.has("freefall") && i1.classes.has("crash"));
  ok("'why' → wantsWhy", i1.wantsWhy === true);
  const i2 = detectIntent("how many times has it crashed?");
  ok("'how many' → wantsCount", i2.wantsCount === true);
  ok("'crashed' → crash", i2.classes.has("crash"));
  const i3 = detectIntent("did it flip over?");
  ok("'flip' → orientationFocus", i3.orientationFocus === true);
  const i4 = detectIntent("tell me the exact g-force numbers");
  ok("'numbers' → wantsNumbers", i4.wantsNumbers === true);
}

// ── 4. Context selection ─────────────────────────────────────────────────────
console.log("\n[4] Context selection (pure)");
{
  const enriched = ROWS.map((r) => enrichAlert(r, NOW)).filter(Boolean);
  ok("5 valid alerts survive enrichment", enriched.length === 5, `got ${enriched.length}`);
  const sel = selectContext(enriched, detectIntent("why did it fall?"), 3);
  ok("selection capped at 3", sel.length === 3);
  ok("crash ranks first for a 'fall/why' question", sel[0].classification === "crash", sel[0].classification);
  ok("freefall pulled into context", sel.some((a) => a.classification === "freefall"));
  ok("results are newest-first", sel[0].at_ms >= sel[1].at_ms && sel[1].at_ms >= sel[2].at_ms);
}

// ── 5. Full chat() with stub provider — the RAG contract ─────────────────────
console.log("\n[5] chat() end-to-end (stub provider)");
{
  const rec = recorder("Your robot had a hard bump and flipped over. It's okay now!");
  const out = await chat("Why did my robot fall?", db, dummyAi, { provider: rec.provider, contextLimit: 3 });
  ok("returns { reply, context }", typeof out.reply === "string" && Array.isArray(out.context));
  ok("reply is the provider's text", out.reply.startsWith("Your robot had a hard bump"));
  ok("context is the selected alerts", out.context.length === 3 && out.context[0].classification === "crash");
  ok("ago flows through map (regression: no index-as-clock)",
     out.context.some((c) => /minute[s]? ago/.test(c.ago)) && !out.context.every((c) => c.ago === "just now"));
  ok("system prompt names the audience", /primary-school/i.test(rec.system));
  ok("system prompt humanizes orientation", /flipped nearly upside down/.test(rec.system));
  ok("context lines carry no JSON braces", !/\{\s*"a_trans"/.test(rec.system) && !/"roll":/.test(rec.system));
  ok("user turn is the child's raw question", rec.user === "Why did my robot fall?");
  // New: pre-resolved signature names in the model context.
  ok("system prompt includes signature name", /Side-angle hit/.test(rec.system));
  ok("system prompt includes signature family", /corner/.test(rec.system));
  ok("system prompt includes baseline comparison", /book falling flat/.test(rec.system));
  ok("system prompt includes impact direction", /right side/.test(rec.system));
  ok("system prompt uses new context-line format (· separator)", / · /.test(rec.system));
}

// ── 6. Count intent injects a tally ──────────────────────────────────────────
console.log("\n[6] Count questions");
{
  const rec = recorder();
  await chat("How many times has it crashed today?", db, dummyAi, { provider: rec.provider });
  ok("TALLY block present for count questions", /TALLY/.test(rec.system));
  ok("tally mentions the crash count", /crash/.test(rec.system));
}

// ── 7. Numbers gate ──────────────────────────────────────────────────────────
console.log("\n[7] Numbers gate");
{
  const recNo = recorder();
  await chat("What happened?", db, dummyAi, { provider: recNo.provider });
  ok("default: model told NOT to use numbers", /Do NOT mention numbers/.test(recNo.system));
  const recYes = recorder();
  await chat("Give me the exact numbers", db, dummyAi, { provider: recYes.provider });
  ok("asked-for numbers: model allowed figures", /you may include simple numbers/.test(recYes.system));
}

// ── 8. Provider swap + failure fallback ──────────────────────────────────────
console.log("\n[8] Provider abstraction & resilience");
{
  const swap = { async generate() { return "SWAP-OK"; } };
  const out1 = await chat("hi", db, dummyAi, { provider: swap });
  ok("custom provider is used (swap works)", out1.reply === "SWAP-OK");

  const boom = { async generate() { throw new Error("provider down"); } };
  const out2 = await chat("why did it fall?", db, dummyAi, { provider: boom });
  ok("LLM failure → friendly fallback, no throw", /robot/i.test(out2.reply) && out2.reply.length > 0);
  ok("context still returned on LLM failure", out2.context.length > 0);

  const empty = await chat("anything?", fakeDB([]), dummyAi, { provider: boom });
  ok("no alerts → calm reassurance", /calm|hasn't|adventure/i.test(empty.reply) && empty.context.length === 0);
}

// ── 9. Auto-thinking (Qwen3 has no native auto; decided at the app layer) ────
console.log("\n[9] Auto-thinking decision");
{
  // Gated OFF by default — even analytical questions stay fast unless enabled.
  const r0 = recorder();
  await chat("Analyze the pattern of crashes over time", db, dummyAi, { provider: r0.provider });
  ok("auto-think gated off by default", r0.opts?.think === false);
  // With autoThink enabled: plain stays off, analytical turns on.
  const r1 = recorder();
  await chat("What happened to my robot?", db, dummyAi, { provider: r1.provider, autoThink: true });
  ok("plain recall → thinking OFF", r1.opts?.think === false);
  const r2 = recorder();
  await chat("Analyze the pattern — is my robot being mishandled repeatedly?", db, dummyAi, { provider: r2.provider, autoThink: true });
  ok("analytical + autoThink → thinking ON", r2.opts?.think === true);
  ok("detectIntent flags analysis words", detectIntent("what's the overall trend over time?").wantsAnalysis === true);
  ok("plain question is not flagged analysis", detectIntent("is my robot okay?").wantsAnalysis === false);
  // Defensive: leaked <think> reasoning is stripped from a reply.
  ok("cleanReply drops a <think> block", cleanReply("<think>secret reasoning</think>Your robot is fine!") === "Your robot is fine!");
  ok("cleanReply passes clean text through", cleanReply("Your robot is fine!") === "Your robot is fine!");
}

// ── 10. Live DO-buffer merge (freshness fix) ─────────────────────────────────
console.log("\n[10] Live DO-buffer merge");
{
  const fresh = { device_id: "mbot2-01", event: "disturbance", signature: 16, do_ms: NOW - 30000,
    madgwick_json: mj({ a_trans: { x: 0.6, y: 0.2, z: 0.1 }, roll: 5, pitch: 2, freefall: false, classification: "bump" }) };
  const rec = recorder();
  const out = await chat("what just happened?", db, dummyAi, { provider: rec.provider, liveAlerts: [fresh] });
  ok("live alert surfaces as newest", out.context[0]?.at_ms === NOW - 30000);
  ok("live alert enriched (bump)", out.context[0]?.classification === "bump");
  ok("live ranks ahead of 3-min-old D1 row", out.context[0].at_ms > out.context[1].at_ms);
  ok("live alert reads 'just now'", out.context[0].ago === "just now");
}

// ── 11. Curiosity vs event question detection ────────────────────────────────
console.log("\n[11] Curiosity question detection (pure)");
{
  ok("'what happened?' is NOT curiosity (has event keywords)",
     !isCuriosityQuestion("what happened to my robot?", detectIntent("what happened to my robot?")));
  ok("'why did it fall?' is NOT curiosity (has 'fall' → freefall class)",
     !isCuriosityQuestion("why did it fall?", detectIntent("why did it fall?")));
  ok("'hello' is NOT curiosity (greeting)",
     !isCuriosityQuestion("hello", detectIntent("hello")));
  ok("'hi' is NOT curiosity (greeting)",
     !isCuriosityQuestion("hi!", detectIntent("hi!")));
  ok("'explain the Madgwick filter' IS curiosity (≥5 words, no event keywords)",
     isCuriosityQuestion("explain the Madgwick filter in simple terms", detectIntent("explain the Madgwick filter in simple terms")));
  ok("'what is a quaternion?' IS curiosity (technical keyword)",
     isCuriosityQuestion("what is a quaternion?", detectIntent("what is a quaternion?")));
  ok("'why does spinning feel like a hit?' is NOT curiosity ('hit' → bump/crash class)",
     !isCuriosityQuestion("why does spinning feel like a hit?", detectIntent("why does spinning feel like a hit?")));
  ok("'how does the robot detect crashes?' IS curiosity (≥5 words, no event class)",
     isCuriosityQuestion("how does the robot detect crashes?", detectIntent("how does the robot detect crashes?")));
  ok("'ok' is NOT curiosity (too short, no technical keywords)",
     !isCuriosityQuestion("ok", detectIntent("ok")));
}

// ── 12. Technical vs casual query detection ──────────────────────────────────
console.log("\n[12] Technical query detection (pure)");
{
  ok("'explain the Madgwick filter' IS technical", isTechnicalQuery("explain the Madgwick filter"));
  ok("'what is a quaternion?' IS technical", isTechnicalQuery("what is a quaternion?"));
  ok("'why does spinning feel like a hit?' is NOT technical",
     !isTechnicalQuery("why does spinning feel like a hit?"));
  ok("'how does the robot know it crashed?' is NOT technical",
     !isTechnicalQuery("how does the robot know it crashed?"));
  ok("'explain gimbal lock' IS technical", isTechnicalQuery("explain gimbal lock"));
  ok("'what is adaptive beta?' IS technical", isTechnicalQuery("what is adaptive beta?"));
}

// ── 12b. FTS5 query builder (stop words + OR) ───────────────────────────────
console.log("\n[12b] FTS5 query builder (pure)");
{
  ok("'what is a quaternion' → 'quaternion'",
     buildFtsQuery("what is a quaternion") === "quaternion");
  ok("'explain the Madgwick filter' → 'Madgwick OR filter'",
     buildFtsQuery("explain the Madgwick filter") === "Madgwick OR filter");
  ok("'how does the robot detect freefall' → 'robot detect freefall'",
     buildFtsQuery("how does the robot detect freefall") === "robot OR detect OR freefall");
  ok("'why does spinning feel like a hit' → content words",
     buildFtsQuery("why does spinning feel like a hit").includes("spinning"));
  ok("'what is gimbal lock' → 'gimbal lock'",
     buildFtsQuery("what is gimbal lock") === "gimbal OR lock");
  ok("all stop words ('what is it') → falls back to OR of all words",
     buildFtsQuery("what is it") === "what OR is OR it");
  ok("single content word ('quaternion') → unchanged",
     buildFtsQuery("quaternion") === "quaternion");
}

// ── 13. Corpus search (fake FTS5 D1) ────────────────────────────────────────
console.log("\n[13] Corpus search (fake FTS5 D1)");
{
  const ftsDB = fakeD1WithFTS(ROWS);
  const r1 = await searchCorpus(ftsDB, "madgwick filter gradient descent");
  ok("'madgwick filter' search finds Madgwick block", r1.some(b => /Madgwick/i.test(b.title)));
  const r2 = await searchCorpus(ftsDB, "quaternion gimbal lock");
  ok("'quaternion gimbal lock' finds Why Quaternions", r2.some(b => /Quaternion/i.test(b.title)));
  const r3 = await searchCorpus(ftsDB, "freefall drop physics");
  ok("'freefall drop' finds Freefall Physics", r3.some(b => /Freefall/i.test(b.title)));
  const r4 = await searchCorpus(ftsDB, "xyznomatch");
  ok("nonsense query returns empty", r4.length === 0);
  const r5 = await searchCorpus(ftsDB, "x"); // too short (<2 chars after sanitize)
  ok("single-char query returns empty", r5.length === 0);
}

// ── 14. Corpus prompt construction ───────────────────────────────────────────
console.log("\n[14] Corpus prompt construction (pure)");
{
  const blocks = [
    { title: "Why Quaternions", content: "Quaternions avoid gimbal lock because they use 4D representation.", tier: "physics", family: null, signature: null },
    { title: "Madgwick Filter", content: "The filter fuses gyro and accel with gradient descent.", tier: "physics", family: null, signature: null },
  ];
  const techPrompt = buildCorpusPrompt("explain quaternions", blocks, true);
  ok("technical prompt includes detail instruction", /Explain in detail/.test(techPrompt));
  ok("technical prompt includes math note", /Light math is OK/.test(techPrompt));
  ok("prompt includes passage titles", /Why Quaternions/.test(techPrompt) && /Madgwick Filter/.test(techPrompt));
  ok("prompt includes passage content", /4D representation/.test(techPrompt));

  const casualPrompt = buildCorpusPrompt("why does spinning feel like a hit?", blocks, false);
  ok("casual prompt includes analogies instruction", /everyday analogies/.test(casualPrompt));
  ok("casual prompt says no jargon", /No jargon/.test(casualPrompt));
  ok("technical prompt has 3-5 sentences", /3-5 substantive/.test(techPrompt));
  ok("casual prompt has 2-4 sentences", /2-4 friendly/.test(casualPrompt));
}

// ── 15. chat() curiosity path end-to-end ─────────────────────────────────────
console.log("\n[15] chat() curiosity path (fake FTS5)");
{
  const ftsDB = fakeD1WithFTS(ROWS);
  const rec = recorder("The Madgwick filter uses gradient descent to fuse gyroscope and accelerometer data into a quaternion representing 3D orientation.");
  const out = await chat("explain the Madgwick filter", ftsDB, dummyAi, { provider: rec.provider });
  ok("curiosity chat returns reply", typeof out.reply === "string" && out.reply.length > 10);
  ok("curiosity chat returns empty context (no alerts)", out.context.length === 0);
  ok("curiosity prompt includes corpus passages", /Madgwick/i.test(rec.system));
  ok("curiosity prompt includes tone instruction", /TONE/.test(rec.system));
  ok("curiosity prompt does NOT include alert context", !/ROBOT REPORTS/.test(rec.system));
  ok("curiosity prompt does NOT include device rules", !/WHAT THE ROBOT'S WORDS MEAN/.test(rec.system));

  // Curiosity with no corpus hits falls through to alert path.
  const emptyFTS = fakeD1WithFTS(ROWS, []);
  const rec2 = recorder("STUB-REPLY");
  const out2 = await chat("explain the Madgwick filter", emptyFTS, dummyAi, { provider: rec2.provider });
  ok("no corpus hits → fallback to alert path", /ROBOT REPORTS/.test(rec2.system));
  ok("fallback path still returns context", out2.context.length > 0);

  // Event question (not curiosity) still hits alert path.
  const rec3 = recorder("STUB-REPLY");
  await chat("what happened to my robot?", ftsDB, dummyAi, { provider: rec3.provider });
  ok("event question skips corpus path", /ROBOT REPORTS/.test(rec3.system));
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

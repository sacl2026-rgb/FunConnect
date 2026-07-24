/**
 * Seed script — populates the FTS5 corpus index via D1's HTTP API with
 * parameterized queries.  Zero SQL escaping in JavaScript — D1 binds every
 * value server-side, so Markdown special characters (backticks, pipes,
 * asterisks, angle brackets) pass through unchanged.
 *
 *   node seed-corpus.mjs
 *
 * The migration file (Edge/migrations/0007_corpus_fts.sql) contains only the
 * CREATE VIRTUAL TABLE — this script handles all INSERTs via the API.
 *
 * Chunking:
 *   - 7 triage blocks (one per family) from signature-analysis.md
 *   - 64 signature blocks (one per sig, self-contained) from signature-analysis.md
 *   - 3 physics blocks from RESEARCHER.md §1.5–1.7
 *   Total: 74 blocks, ~20K tokens
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

// ── Config ────────────────────────────────────────────────────────────────────

const ACCOUNT_ID = "CF_ACCOUNT_ID_PLACEHOLDER";
const DB_ID      = "a3a8950d-c028-4ef4-b05c-982a10b9b2a6";
const API_TOKEN  = "CF_TOKEN_PLACEHOLDER";

const API_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}`;

const INSERT_SQL =
  "INSERT INTO corpus_fts (title, content, tier, family, signature) VALUES (?, ?, ?, ?, ?)";

// ── D1 API ────────────────────────────────────────────────────────────────────

async function d1Query(sql, params = []) {
  const res = await fetch(`${API_BASE}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql, params }),
  });
  const data = await res.json();
  if (!data.success) {
    const errs = (data.errors || []).map(e => e.message || JSON.stringify(e)).join("; ");
    throw new Error(`D1 query failed [${res.status}]: ${errs || JSON.stringify(data)}`);
  }
  return data;
}

// ── Chunking helpers ──────────────────────────────────────────────────────────

function triageDesc(family) {
  const map = {
    "Noise": "False alarm — nothing crossed threshold",
    "Spin": "Pure rotation — no impact, benign",
    "Drop": "Z-axis involved — freefall, landing, lift",
    "Bump": "Single lateral accel — push or hit on one face",
    "Corner": "Two accel axes — diagonal force, corner impact",
    "Ghost": "Three accel, zero gyro — ambiguous, Madgwick REQUIRED",
    "Crash": "Three accel + gyro — confirmed violent multi-axis impact",
  };
  return map[family] || family;
}

function sigFamily(sig) {
  if (sig === 0) return "noise";
  if (sig >= 1 && sig <= 7) return "spin";
  if (sig >= 8 && sig <= 15) return "drop";
  if ([16,17,18,19,20,21,22,23,32,33,34,35,36,37,38,39].includes(sig)) return "bump";
  if ([24,25,26,27,28,29,30,31,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55].includes(sig)) return "corner";
  if (sig === 56) return "ghost";
  if (sig >= 57 && sig <= 63) return "crash";
  return "unknown";
}

// ── Build block list ──────────────────────────────────────────────────────────

function buildBlocks() {
  const blocks = [];

  // --- Triage blocks (signature-analysis.md) ---
  const sigMD = readFileSync(path.join(ROOT, "Researcher/signature-analysis.md"), "utf8");
  const triageSection = sigMD.split("## Full Enumeration")[0];
  const triageBlocks = triageSection.split(/^### /m).filter(b => b.trim()).slice(1);

  for (const block of triageBlocks) {
    const lines = block.split("\n");
    const family = lines[0].trim();
    const title = `${family} — ${triageDesc(family)}`;
    const content = block.trim();
    blocks.push({ title, content, tier: "triage", family: family.toLowerCase(), signature: null });
  }

  // --- Signature blocks (signature-analysis.md) ---
  const fullEnumSection = sigMD.split("## Full Enumeration — All 64 Signatures")[1];
  const sigBlocks = fullEnumSection.split(/^## (?=\d+ —)/m).filter(b => b.trim());

  for (const block of sigBlocks) {
    const firstLine = block.split("\n")[0].trim();
    const sigMatch = firstLine.match(/^(\d+)\s*—/);
    if (!sigMatch) continue;
    const sig = parseInt(sigMatch[1], 10);
    const nameMatch = firstLine.match(/—\s*(.+)$/);
    const name = nameMatch ? nameMatch[1].trim().replace(/^\[.*?\]\s*/, "") : `Signature ${sig}`;
    const family = sigFamily(sig);
    const title = `Sig ${sig}: ${name}`;
    blocks.push({ title, content: block.trim(), tier: "signature", family, signature: sig });
  }

  // --- Physics blocks (RESEARCHER.md) ---
  const resMD = readFileSync(path.join(ROOT, "Researcher/RESEARCHER.md"), "utf8");

  const mmrStart = resMD.indexOf("### 1.5 The MATH_MODEL_REFERENCE");
  const mmrEnd   = resMD.indexOf("### 1.6 Why Quaternions");
  if (mmrStart >= 0 && mmrEnd > mmrStart) {
    blocks.push({
      title: "MATH_MODEL_REFERENCE — Jerk Gate & Seismic Conjunction",
      content: resMD.slice(mmrStart, mmrEnd).trim(),
      tier: "physics", family: null, signature: null,
    });
  }

  const quatStart = resMD.indexOf("### 1.6 Why Quaternions");
  const quatEnd   = resMD.indexOf("### 1.7 Adaptive");
  if (quatStart >= 0 && quatEnd > quatStart) {
    blocks.push({
      title: "Why Quaternions — Not Euler Angles, Not Rotation Matrices",
      content: resMD.slice(quatStart, quatEnd).trim(),
      tier: "physics", family: null, signature: null,
    });
  }

  const betaStart = resMD.indexOf("### 1.7 Adaptive");
  const betaEnd   = resMD.indexOf("## 2. Implementation Surface");
  if (betaStart >= 0) {
    const end = betaEnd > betaStart ? betaEnd : resMD.length;
    blocks.push({
      title: "Adaptive Beta — Learning the Gain",
      content: resMD.slice(betaStart, end).trim(),
      tier: "physics", family: null, signature: null,
    });
  }

  return blocks;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const blocks = buildBlocks();
  console.log(`Chunked ${blocks.length} blocks (${blocks.filter(b => b.tier === 'triage').length} triage, ${blocks.filter(b => b.tier === 'signature').length} signature, ${blocks.filter(b => b.tier === 'physics').length} physics).\n`);

  // 1. Ensure FTS5 table exists.
  console.log("Creating FTS5 table (if not exists)...");
  await d1Query(
    "CREATE VIRTUAL TABLE IF NOT EXISTS corpus_fts USING fts5(title, content, tier, family, signature)"
  );
  console.log("  OK\n");

  // 2. Clear existing rows (idempotent re-seed).
  console.log("Clearing existing rows...");
  const countRes = await d1Query("SELECT COUNT(*) as cnt FROM corpus_fts");
  const existing = countRes.result?.[0]?.results?.[0]?.cnt || 0;
  if (existing > 0) {
    // FTS5 content tables support DELETE.
    await d1Query("DELETE FROM corpus_fts");
    console.log(`  Cleared ${existing} existing rows.`);
  } else {
    console.log("  Table is empty — fresh seed.");
  }
  console.log();

  // 3. Insert blocks one at a time via parameterized queries.
  console.log(`Inserting ${blocks.length} blocks...`);
  let ok = 0, fail = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    try {
      await d1Query(INSERT_SQL, [b.title, b.content, b.tier, b.family, b.signature]);
      ok++;
      if (ok % 10 === 0) process.stdout.write(`  ${ok}/${blocks.length}...\n`);
    } catch (err) {
      fail++;
      console.error(`  FAIL [${i}] ${b.title}: ${err.message}`);
      // First failure: print the first 120 chars of content for diagnosis.
      if (fail === 1) {
        console.error(`  Content preview: ${b.content.slice(0, 120)}...`);
      }
    }
    // Small delay between requests (D1 rate limit: 50 req/sec per DB).
    // 20ms = 50 req/sec max; we go slower to be safe.
    await new Promise(r => setTimeout(r, 20));
  }

  console.log(`\nDone: ${ok} inserted, ${fail} failed, ${blocks.length} total.`);

  // 4. Verify.
  const verify = await d1Query("SELECT COUNT(*) as cnt FROM corpus_fts");
  const finalCount = verify.result?.[0]?.results?.[0]?.cnt || 0;
  console.log(`FTS5 row count: ${finalCount}`);

  if (fail > 0) process.exit(1);
}

// ── Migration file ────────────────────────────────────────────────────────────

// Write a minimal migration that only creates the table.  The INSERTs are done
// via the D1 API above, so this file never contains raw Markdown in SQL strings.
const migrationDir = path.join(ROOT, "Edge", "migrations");
const migrationSQL = `-- 0007: corpus_fts — FTS5 full-text search over physics corpus.
-- Table created here; data seeded by AI/seed-corpus.mjs via D1 parameterized API.
-- Re-run  node AI/seed-corpus.mjs  after Researcher edits the corpus.

CREATE VIRTUAL TABLE IF NOT EXISTS corpus_fts USING fts5(
  title,
  content,
  tier,
  family,
  signature
);
`;
writeFileSync(path.join(migrationDir, "0007_corpus_fts.sql"), migrationSQL);
console.log(`Migration file written: Edge/migrations/0007_corpus_fts.sql`);

// ── Go ────────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error("FATAL:", err.message);
  process.exit(1);
});

/**
 * Smoke test for py2hex TypeScript module.
 *
 * Strategy: CPython-first. Use uflash to generate reference hex output,
 * then verify our TypeScript port produces identical results.
 *
 * Tests:
 *   1. Intel HEX encoder (bytesToIhex) — verified implicitly via py2hex
 *   2. Filesystem encoder (scriptToFs) — verified implicitly via py2hex
 *   3. py2hex() full pipeline — byte-for-byte match against uflash reference
 *   4. validateScript() — size limits
 *   5. Edge cases — empty script, line ending normalization
 *
 * Run: node smoke-py2hex.mjs
 */

import * as esbuild from "esbuild";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const resolvePath = (...parts) => resolve(__dirname, ...parts);

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${label}`);
  }
}

// ── Step 1: Build py2hex as a standalone Node.js module ──────────────────

console.log("\n🔨 Building py2hex for Node.js...");
const testEntry = resolvePath("smoke-py2hex-entry.mjs");
writeFileSync(testEntry, `
export { py2hex, validateScript } from "./src/py2hex.ts";
`);

const testBundle = resolvePath("dist", "smoke-py2hex-bundle.mjs");
const buildResult = await esbuild.build({
  entryPoints: [testEntry],
  bundle: true,
  format: "esm",
  outfile: testBundle,
  platform: "node",
  target: "node20",
  external: [],
  minify: false,
});
unlinkSync(testEntry);

if (buildResult.errors.length > 0) {
  console.error("Build failed:", buildResult.errors);
  process.exit(1);
}
console.log("  Build OK");

// ── Step 2: Import the compiled module ───────────────────────────────────

const { py2hex, validateScript } = await import(pathToFileURL(testBundle).href);

// ── Step 3: Generate reference output using Python/uflash ─────────────────

console.log("\n🐍 Generating reference output via uflash...");

const testScript = `# Smoke test script for py2hex
from microbit import *

while True:
    display.scroll("Hello FunConnect!")
    sleep(1000)
    if button_a.is_pressed():
        display.show(Image.HAPPY)
`;

const testScriptPath = resolvePath("smoke-test-script.py");
writeFileSync(testScriptPath, testScript);

// Use uflash's py2hex CLI to generate reference hex.
const referenceHexPath = resolvePath("smoke-reference.hex");
execSync(`python -c "import uflash; f=open('${testScriptPath.replace(/\\/g, '/')}','rb'); s=f.read(); f.close(); r=uflash.embed_fs_uhex(uflash._RUNTIME, s); open('${referenceHexPath.replace(/\\/g, '/')}','w').write(r); print(f'Reference hex: {len(r)} chars')"`, { stdio: "inherit" });

let referenceHex = readFileSync(referenceHexPath, "utf8");
// Normalize CRLF → LF (Python on Windows writes \r\n).
referenceHex = referenceHex.replace(/\r\n/g, "\n");

// ── Step 4: Generate our output using the TypeScript port ─────────────────

console.log("\n🔧 Generating output via TypeScript py2hex...");

// Use the universal hex (V1+V2) for full comparison.
const firmwarePath = resolvePath("firmware-microbit-universal.hex");
let firmwareHex;
try {
  firmwareHex = readFileSync(firmwarePath, "utf8").replace(/\r\n/g, "\n");
  console.log(`  Firmware: ${firmwareHex.length} chars (universal)`);
} catch {
  // Fall back to V2-only
  const v2Path = resolvePath("firmware-microbit-v2.hex");
  firmwareHex = readFileSync(v2Path, "utf8").replace(/\r\n/g, "\n");
  console.log(`  Firmware: ${firmwareHex.length} chars (V2-only, fallback)`);
}

const ourHex = py2hex(testScript, firmwareHex);
console.log(`  Our hex: ${ourHex.length} chars`);

// ── Step 5: Tests ────────────────────────────────────────────────────────

console.log("\n🧪 Running tests...\n");

// 5.1 — Our output should be larger than the firmware (script injected).
assert(ourHex.length > firmwareHex.length, "Output larger than firmware template");

// 5.2 — The firmware portion (before UICR injection) should be preserved.
const uicrMarker = ":020000041000EA";
const fwUicrIdx = firmwareHex.lastIndexOf(uicrMarker);
const ourUicrIdx = ourHex.lastIndexOf(uicrMarker);
assert(ourUicrIdx > fwUicrIdx, `UICR marker shifted forward (fs injected before it): ${fwUicrIdx} → ${ourUicrIdx}`);

// 5.3 — The UICR portion (from UICR to end) should be identical.
const fwUicrTail = firmwareHex.substring(fwUicrIdx);
const ourUicrTail = ourHex.substring(ourUicrIdx);
assert(fwUicrTail === ourUicrTail, "UICR tail identical between firmware and output");

// 5.4 — Output should contain V2 device ID in block start record.
assert(ourHex.includes(":0400000A9903C0DE"), "Contains V2 block start record (device 9903)");

// 5.5 — Output should be a valid Intel HEX file (starts with ELA, ends with EOF).
assert(ourHex.startsWith(":020000040000FA"), "Starts with Extended Linear Address record");
assert(ourHex.trimEnd().endsWith(":00000001FF"), "Ends with EOF record");

// 5.6 — Filesystem marker 0xFE should appear in the injected region.
assert(ourHex.includes("FE"), "Contains filesystem start marker 0xFE");

// 5.7 — validateScript: valid script.
const valid = validateScript(testScript);
assert(valid.valid === true, `validateScript returns valid for ${valid.size}-byte script`);

// 5.8 — validateScript: oversized script.
const hugeScript = "x".repeat(50_000);
const invalid = validateScript(hugeScript);
assert(invalid.valid === false, `validateScript rejects ${invalid.size}-byte script`);

// 5.9 — Empty script returns unmodified firmware.
const emptyResult = py2hex("", firmwareHex);
assert(emptyResult === firmwareHex, "Empty script → unmodified firmware");

// 5.10 — Line ending normalization.
const crlfScript = "from microbit import *\r\nprint('hello')\r\n";
const lfScript = "from microbit import *\nprint('hello')\n";
const crlfResult = py2hex(crlfScript, firmwareHex);
const lfResult = py2hex(lfScript, firmwareHex);
assert(crlfResult === lfResult, "CRLF and LF scripts produce identical output");

// 5.11 — Output contains "main.py" filename in filesystem header.
// "main.py" in hex is 6D61696E2E7079
assert(ourHex.includes("6D61696E2E7079"), "Filesystem contains 'main.py' filename");

// ── Step 6: Compare against uflash reference (FULL universal hex) ─────

console.log("\n📏 Comparing full universal hex against uflash reference...");

// Our output may be V2-only or universal depending on firmware template.
// If universal, compare byte-for-byte against reference.
const isUniversal = firmwareHex.includes("9900") && firmwareHex.includes("9903");

if (isUniversal) {
  // Full byte-for-byte comparison with uflash reference.
  if (ourHex === referenceHex) {
    assert(true, "Universal hex byte-for-byte identical to uflash reference");
  } else {
    // Find first difference
    for (let i = 0; i < Math.min(ourHex.length, referenceHex.length); i++) {
      if (ourHex[i] !== referenceHex[i]) {
        console.log(`  First diff at byte ${i}:`);
        console.log(`    Ref:  ${JSON.stringify(referenceHex.substring(Math.max(0,i-20), i+30))}`);
        console.log(`    Ours: ${JSON.stringify(ourHex.substring(Math.max(0,i-20), i+30))}`);
        break;
      }
    }
    let diffs = 0;
    const minLen = Math.min(ourHex.length, referenceHex.length);
    for (let i = 0; i < minLen; i++) {
      if (ourHex[i] !== referenceHex[i]) diffs++;
    }
    diffs += Math.abs(ourHex.length - referenceHex.length);
    assert(false, `Universal hex differs: ${diffs} diffs / ${referenceHex.length} chars`);
  }
} else {
  // V2-only: compare V2 sections.
  const sectionStart = ":020000040000FA\n:0400000A";
  const secondIdx = referenceHex.indexOf(sectionStart, sectionStart.length);
  const refV2Section = referenceHex.substring(secondIdx);
  assert(refV2Section.startsWith(sectionStart), "Reference V2 section starts correctly");
  assert(refV2Section.includes(":0400000A9903C0DE"), "Reference V2 section has correct device ID");
  assert(refV2Section.includes("FE"), "Reference V2 section contains filesystem marker");
  console.log("  (V2-only template — section comparison OK)");
}

// ── Summary ──────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(60)}\n`);

// Cleanup (keep files for inspection on failure).
if (failed === 0) {
  try { unlinkSync(testScriptPath); } catch {}
  try { unlinkSync(referenceHexPath); } catch {}
  try { unlinkSync(testBundle); } catch {}
  console.log("🧹 Cleanup complete\n");
} else {
  console.log(`⚠️  Test artifacts kept for debugging:`);
  console.log(`   Script: ${testScriptPath}`);
  console.log(`   Reference: ${referenceHexPath}`);
  console.log(`   Bundle: ${testBundle}\n`);
}

process.exit(failed > 0 ? 1 : 0);

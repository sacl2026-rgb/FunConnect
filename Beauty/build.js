/**
 * Beauty build — compile the SPA to a single self-contained index.html.
 *
 *   src/app.jsx            → JSX source (edit this)
 *   index.template.html    → HTML shell with a /*__APP_BUNDLE__* / marker
 *   build/app.compiled.js  → esbuild output (generated)
 *   spa/index.html         → final single-file SPA (generated; Edge inlines this)
 *
 * No Babel, no runtime transform: JSX is compiled ahead of time so the page is
 * just React-from-CDN + one plain <script>. Reuses Edge's esbuild install.
 *
 * Run:  node build.js
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const ESBUILD = resolve(here, "../Edge/node_modules/esbuild/bin/esbuild");

// 1) Compile JSX → plain JS (global React/ReactDOM, IIFE, minified).
execFileSync("node", [
  ESBUILD,
  resolve(here, "src/app.jsx"),
  "--bundle",
  "--loader:.jsx=jsx",
  "--jsx=transform",
  "--format=iife",
  "--minify",
  "--outfile=" + resolve(here, "build/app.compiled.js"),
], { stdio: "inherit" });

// 2) Inject the compiled bundle into the HTML shell.
const compiled = readFileSync(resolve(here, "build/app.compiled.js"), "utf8");
const template = readFileSync(resolve(here, "index.template.html"), "utf8");
const out = template.replace("/*__APP_BUNDLE__*/", () => compiled);

// 3) Write the single-file SPA.
writeFileSync(resolve(here, "spa/index.html"), out);
console.log(`Build complete → spa/index.html (${out.length} bytes)`);

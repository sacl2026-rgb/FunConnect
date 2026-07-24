/**
 * Deploy — upload Worker to Cloudflare via multipart API.
 *
 * Avoids wrangler junction issues on Windows.
 * Steps: D1 create → schema migrate → Worker multipart PUT → subdomain enable.
 */

import { readFile, readdir } from "node:fs/promises";
import { Blob } from "node:buffer";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const resolvePath = (...parts) => resolve(__dirname, ...parts);

const ACCOUNT_ID = "758cece0f853404f97b17f0ff86b5190";
const SCRIPT_NAME = "funconnect-v1";
const API_TOKEN = "CF_TOKEN_PLACEHOLDER";
const DB_NAME = "funconnect-v1-db";

const API_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;
const WORKERS_API = `${API_BASE}/workers/scripts/${SCRIPT_NAME}`;

async function api(path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    ...opts,
  });
  return res.json();
}

function buildMetadata(dbId) {
  return {
    main_module: "worker.mjs",
    workers_dev: true,
    compatibility_date: "2026-07-09",
    bindings: [
      {
        type: "d1",
        name: "DB",
        id: dbId,
      },
      {
        type: "durable_object_namespace",
        name: "CYBERPI_HUB",
        class_name: "CyberpiHub",
      },
      {
        type: "durable_object_namespace",
        name: "TENANT_ROSTER",
        class_name: "TenantRoster",
      },
      {
        type: "ai",
        name: "AI",
      },
      {
        type: "plain_text",
        name: "CHAT_THINKING",
        text: "on",
      },
    ],
    // Preserve secrets (e.g. DASHSCOPE_KEY) set out-of-band via the secrets API.
    // A raw multipart PUT replaces the binding set, so without this the redeploy
    // would wipe the Qwen key. keep_bindings carries existing secrets forward.
    keep_bindings: ["secret_text"],
    // Migrations are one-time. v1 (CyberpiHub) and v2 (TenantRoster) already
    // applied. No new DO classes — bump tag with empty classes so Cloudflare
    // doesn't reject the deploy.
    migrations: {
      tag: "v3",
      new_sqlite_classes: [],
    },
  };
}

async function main() {
  console.log("=== FunConnect v1 Smoke Test Deploy ===\n");

  // 1. Create or find D1 database
  console.log("[1/5] D1 database...");
  let dbId;

  const existing = await api("/d1/database");
  if (existing.success) {
    const match = existing.result.find((d) => d.name === DB_NAME);
    if (match) {
      dbId = match.uuid;
      console.log(`  Found existing: ${dbId}`);
    }
  }

  if (!dbId) {
    console.log(`  Creating ${DB_NAME}...`);
    const created = await api("/d1/database", {
      method: "POST",
      body: JSON.stringify({ name: DB_NAME }),
    });
    if (!created.success) {
      console.error("  Failed to create D1:", JSON.stringify(created.errors, null, 2));
      process.exit(1);
    }
    dbId = created.result.uuid;
    console.log(`  Created: ${dbId}`);
  }

  // 2. Run D1 schema migrations (all .sql files in order)
  console.log("[2/5] Schema migration...");

  const migrationFiles = (await readdir(resolvePath("migrations")))
    .filter((f) => f.endsWith(".sql"))
    .sort(); // 0001 before 0002

  const allSql = [];
  for (const f of migrationFiles) {
    allSql.push(await readFile(resolvePath("migrations", f), "utf-8"));
  }
  const schemaSql = allSql.join("\n");

  // Strip comment lines before splitting (prevents first statement being
  // dropped because it shares a split-token with leading comments).
  const cleanSql = schemaSql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  const statements = cleanSql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const D1_API = `${API_BASE}/d1/database/${dbId}`;

  for (const stmt of statements) {
    try {
      const res = await fetch(`${D1_API}/raw`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sql: stmt + ";" }),
      });
      const json = await res.json();
      if (json.success) {
        console.log(`  OK: ${stmt.substring(0, 50)}...`);
      } else {
        const msg = JSON.stringify(json.errors);
        if (msg.includes("already exists")) {
          console.log(`  SKIP: ${stmt.substring(0, 50)}...`);
        } else {
          console.warn(`  WARN: ${stmt.substring(0, 50)}... → ${msg}`);
        }
      }
    } catch (e) {
      console.warn(`  WARN (stmt): ${e.message}`);
    }
  }
  console.log("  Schema migration complete.");

  // 3. Deploy Worker via multipart PUT
  console.log("[3/5] Deploying Worker...");
  const metadata = buildMetadata(dbId);
  const workerContent = await readFile(resolvePath("dist", "worker.mjs"));
  console.log(`  Script size: ${workerContent.length} bytes`);

  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  form.append(
    "worker.mjs",
    new Blob([workerContent], { type: "application/javascript+module" }),
    "worker.mjs"
  );

  const deployRes = await fetch(WORKERS_API, {
    method: "PUT",
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    body: form,
  });

  const deployResult = await deployRes.json();

  if (!deployResult.success) {
    console.error("  Deploy failed:", JSON.stringify(deployResult.errors, null, 2));
    process.exit(1);
  }

  console.log("  Deploy complete.");

  // 4. Enable on workers.dev
  console.log("[4/5] Enabling workers.dev...");
  const subdomainRes = await fetch(`${WORKERS_API}/subdomain`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ enabled: true, previews_enabled: true }),
  });
  const subdomainResult = await subdomainRes.json();
  if (subdomainResult.success) {
    console.log("  workers.dev enabled.");
  } else {
    console.warn("  workers.dev enable:", JSON.stringify(subdomainResult.errors));
  }

  console.log(`\n[5/5] Done.\n`);
  const baseUrl = `https://${SCRIPT_NAME}.funconnect.workers.dev`;
  console.log(`  Health:    ${baseUrl}/`);
  console.log(`  WSS:       wss://${SCRIPT_NAME}.funconnect.workers.dev/device/cyberpi`);
  console.log(`  Dashboard: wss://${SCRIPT_NAME}.funconnect.workers.dev/dashboard/cyberpi`);
  console.log(`  D1 DB ID:  ${dbId}`);
  console.log(`\n  Smoke tests:`);
  console.log(`    1. curl ${baseUrl}/`);
  console.log(`    2. curl -o /dev/null -w "%{http_code}" ${baseUrl}/device/cyberpi  → 426`);
  console.log(`    3. WSS hello → welcome + sync (see plan for node -e script)`);
  console.log(`    4. curl ${baseUrl}/do-hello-count?device=cyberpi`);
  console.log(`    5. Wait 70s, query D1 for hello_log rows`);
  console.log(`    6. Send another hello after 60s hibernation`);
}

main().catch((err) => {
  console.error("Deploy error:", err);
  process.exit(1);
});

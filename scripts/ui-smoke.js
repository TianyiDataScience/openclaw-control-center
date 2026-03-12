#!/usr/bin/env node
/**
 * Cross-platform UI smoke test.
 * Replaces scripts/ui-smoke.sh for Windows compatibility.
 */
"use strict";

const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

const PORT = process.env.UI_SMOKE_PORT || "4516";
const WAIT_SECONDS = Number(process.env.UI_SMOKE_WAIT_SECONDS || "10");
const ROOT = path.resolve(__dirname, "..");
const LOG_DIR = path.join(ROOT, "runtime");
const LOG_FILE = path.join(LOG_DIR, `ui-smoke-${PORT}.log`);

fs.mkdirSync(LOG_DIR, { recursive: true });

const logStream = fs.createWriteStream(LOG_FILE);
const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
  cwd: ROOT,
  env: { ...process.env, UI_MODE: "true", UI_PORT: PORT },
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.pipe(logStream);
child.stderr.pipe(logStream);

function cleanup(code) {
  try { child.kill(); } catch (_) { /* ignore */ }
  process.exit(code);
}

process.on("SIGINT", () => cleanup(1));
process.on("SIGTERM", () => cleanup(1));

function fetch(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${PORT}${urlPath}`, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function waitForUI() {
  const deadline = Date.now() + WAIT_SECONDS * 1000;
  while (Date.now() < deadline) {
    try {
      await fetch("/");
      return;
    } catch (_) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  console.error(`UI smoke failed: server did not become ready within ${WAIT_SECONDS}s.`);
  try { console.error(fs.readFileSync(LOG_FILE, "utf8")); } catch (_) { /* ignore */ }
  cleanup(1);
}

async function checkPage(urlPath, keywords, label) {
  const body = await fetch(urlPath);
  const found = keywords.some((kw) => body.includes(kw));
  if (!found) {
    console.error(`FAIL: ${label} — none of [${keywords.join(", ")}] found in response (${body.length} bytes).`);
    cleanup(1);
  }
}

async function main() {
  await waitForUI();
  await checkPage("/", ["OpenClaw", "Control Center", "usage", "lang="], "GET /");
  await checkPage("/docs?lang=en", ["Open document workbench", "Control Center", "Docs"], "GET /docs?lang=en");
  console.log(`UI smoke passed on http://127.0.0.1:${PORT}`);
  cleanup(0);
}

main().catch((err) => {
  console.error("UI smoke error:", err);
  cleanup(1);
});

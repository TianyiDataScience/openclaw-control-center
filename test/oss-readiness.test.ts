import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";

const ROOT = process.cwd();
const TSX_BIN = path.join(ROOT, "node_modules", ".bin", "tsx");
const MACOS_HOME_PATH_PATTERN = /\/Users\/[^/\s]+\//;
const EMBEDDED_LOCAL_TOKEN_PATTERN = /LOCAL_API_TOKEN\s*[:=]\s*["'][^"']{8,}["']/;
const PUBLIC_FILES = [
  "README.md",
  "docs/ARCHITECTURE.md",
  "docs/PROGRESS.md",
  "docs/mission-control-runbook-v2.md",
  "ecosystem.config.cjs",
  "scripts/run_verifier.sh",
  "scripts/mc_dod_evaluator.py",
  "scripts/mc_rollback_plan.py",
];

test("repo includes baseline open-source release metadata", () => {
  assert(existsSync(path.join(ROOT, ".gitignore")), "Expected .gitignore to exist.");
  assert(existsSync(path.join(ROOT, "LICENSE")), "Expected LICENSE to exist.");

  const ignore = readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  assert.match(ignore, /(^|\r?\n)node_modules\/(\r?\n|$)/);
  assert.match(ignore, /(^|\r?\n)dist\/(\r?\n|$)/);
  assert.match(ignore, /(^|\r?\n)\/?runtime\/(\r?\n|$)/);

  const license = readFileSync(path.join(ROOT, "LICENSE"), "utf8");
  assert.match(license, /MIT License/);

  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.notEqual(pkg.private, true);
  assert.equal(pkg.license, "MIT");
});

test("public-facing files do not embed machine-specific paths or local token values", () => {
  for (const relativePath of PUBLIC_FILES) {
    const content = readFileSync(path.join(ROOT, relativePath), "utf8");
    assert.equal(MACOS_HOME_PATH_PATTERN.test(content), false, `${relativePath} still contains a macOS home path.`);
    assert.equal(
      EMBEDDED_LOCAL_TOKEN_PATTERN.test(content),
      false,
      `${relativePath} still contains an embedded LOCAL_API_TOKEN value.`,
    );
  }
});

test("gateway URL can be overridden from env for non-local installations", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--eval",
      "process.env.GATEWAY_URL='ws://example.invalid:9999'; const mod = require('./src/config.ts'); process.stdout.write(String(mod.GATEWAY_URL));",
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  ).trim();

  assert.equal(output, "ws://example.invalid:9999");
});

test("config loads LOCAL_API_TOKEN from cwd .env when env is not preloaded", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-config-env-"));
  try {
    writeFileSync(path.join(tempDir, ".env"), "LOCAL_API_TOKEN=from-dotenv\n", "utf8");
    const output = execFileSync(
      TSX_BIN,
      [
        "--eval",
        `delete process.env.LOCAL_API_TOKEN; const mod = require(${JSON.stringify(path.join(ROOT, "src", "config.ts"))}); process.stdout.write(mod.LOCAL_API_TOKEN);`,
      ],
      {
        cwd: tempDir,
        encoding: "utf8",
      },
    ).trim();

    assert.equal(output, "from-dotenv");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("config keeps defaults when cwd .env is absent", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-config-no-env-"));
  try {
    const output = execFileSync(
      TSX_BIN,
      [
        "--eval",
        `delete process.env.LOCAL_API_TOKEN; delete process.env.GATEWAY_URL; const mod = require(${JSON.stringify(path.join(ROOT, "src", "config.ts"))}); process.stdout.write(JSON.stringify({ token: mod.LOCAL_API_TOKEN, gateway: mod.GATEWAY_URL }));`,
      ],
      {
        cwd: tempDir,
        encoding: "utf8",
      },
    ).trim();

    assert.deepEqual(JSON.parse(output), {
      token: "",
      gateway: "ws://127.0.0.1:18789",
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("core source directories are present and tracked in git", () => {
  assert(existsSync(path.join(ROOT, "src", "ui", "server.ts")), "Expected src/ui/server.ts to exist.");
  assert(existsSync(path.join(ROOT, "src", "runtime", "usage-cost.ts")), "Expected src/runtime/usage-cost.ts to exist.");

  const tracked = execFileSync("git", ["ls-files", "src/ui/server.ts", "src/runtime/usage-cost.ts"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);

  assert.deepEqual(tracked.sort(), ["src/runtime/usage-cost.ts", "src/ui/server.ts"]);
});

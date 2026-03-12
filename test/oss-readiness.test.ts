import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = process.cwd();
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

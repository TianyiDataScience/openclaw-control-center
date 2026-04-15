import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("config keeps UTC as the default UI timezone", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "openclaw-config-defaults-"));
  const configPath = resolve(process.cwd(), "src/config.ts");
  const tsxLoaderPath = resolve(process.cwd(), "node_modules/tsx/dist/loader.mjs");

  try {
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        tsxLoaderPath,
        "--eval",
        `const mod = await import(${JSON.stringify(configPath)}); console.log(mod.UI_TIMEZONE ?? mod.default?.UI_TIMEZONE);`,
      ],
      {
        cwd: tempDir,
        env: {
          ...process.env,
          UI_TIMEZONE: "",
        },
        encoding: "utf8",
      },
    );
    assert.equal(output.trim(), "UTC");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

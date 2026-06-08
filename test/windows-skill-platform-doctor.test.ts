import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { runDoctor, resolveDesktopDefaults, resolveWorkspaceRoot } = require("../desktop/doctor.cjs") as {
  runDoctor: (options?: Record<string, unknown>) => {
    appDataDir: string;
    workspaceRoot: string;
    summary: { pass: number; warn: number; fail: number; skip: number; ready: boolean };
    checks: Array<{ id: string; status: "pass" | "warn" | "fail" | "skip"; message: string }>;
  };
  resolveDesktopDefaults: (options: { env: Record<string, string>; homeDir: string; platform: string }) => {
    appDataDir: string;
    openclawHome: string;
    configPath: string;
  };
  resolveWorkspaceRoot: (options: {
    env: Record<string, string>;
    openclawHome: string;
    config?: unknown;
  }) => string;
};

test("desktop doctor resolves Windows app data and OpenClaw defaults", () => {
  const defaults = resolveDesktopDefaults({
    platform: "win32",
    homeDir: "C:\\Users\\doro",
    env: {
      LOCALAPPDATA: "C:\\Users\\doro\\AppData\\Local",
    },
  });

  assert.equal(defaults.appDataDir, "C:\\Users\\doro\\AppData\\Local/OpenClaw Workbench");
  assert.equal(defaults.openclawHome, "C:\\Users\\doro/.openclaw");
  assert.equal(defaults.configPath, "C:\\Users\\doro/.openclaw/openclaw.json");
});

test("desktop doctor counts local skills without executing them", async () => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-workbench-doctor-"));
  try {
    const home = join(root, "home");
    const localAppData = join(root, "AppData", "Local");
    const openclawHome = join(home, ".openclaw");
    const skillRoot = join(openclawHome, "skills");
    const workspace = join(root, "工作区 With Spaces");
    await mkdir(join(skillRoot, "xlsx"), { recursive: true });
    await mkdir(localAppData, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(skillRoot, "xlsx", "SKILL.md"), "---\nname: xlsx\n---\n", "utf8");
    await writeFile(
      join(openclawHome, "openclaw.json"),
      JSON.stringify({ agents: { list: [{ id: "main", workspace }] } }),
      "utf8",
    );

    const result = runDoctor({
      platform: "win32",
      homeDir: home,
      env: {
        LOCALAPPDATA: localAppData,
        SystemRoot: "C:\\Windows",
        OPENCLAW_HOME: openclawHome,
        OPENCLAW_ASSUME_LONG_PATHS_ENABLED: "true",
      },
      now: new Date("2026-06-08T00:00:00.000Z"),
    });

    assert.equal(result.summary.fail, 0);
    assert.equal(result.workspaceRoot, workspace);
    assert.equal(result.checks.find((check) => check.id === "skill-roots")?.status, "pass");
    assert.match(result.checks.find((check) => check.id === "skill-roots")?.message ?? "", /Found 1 skill/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop doctor flags invalid OpenClaw config as failed", async () => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-workbench-bad-config-"));
  try {
    const home = join(root, "home");
    const localAppData = join(root, "AppData", "Local");
    const openclawHome = join(home, ".openclaw");
    await mkdir(openclawHome, { recursive: true });
    await mkdir(localAppData, { recursive: true });
    await writeFile(join(openclawHome, "openclaw.json"), "{bad json", "utf8");

    const result = runDoctor({
      platform: "win32",
      homeDir: home,
      env: {
        LOCALAPPDATA: localAppData,
        SystemRoot: "C:\\Windows",
        OPENCLAW_HOME: openclawHome,
      },
    });

    assert.equal(result.summary.ready, false);
    assert.equal(result.checks.find((check) => check.id === "openclaw-config")?.status, "fail");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace root prefers explicit env override before config inference", () => {
  assert.equal(
    resolveWorkspaceRoot({
      env: { OPENCLAW_WORKSPACE_ROOT: "D:\\OpenClaw\\workspace" },
      openclawHome: "C:\\Users\\doro\\.openclaw",
      config: { agents: { list: [{ workspace: "D:\\Other" }] } },
    }),
    "D:\\OpenClaw\\workspace",
  );
});

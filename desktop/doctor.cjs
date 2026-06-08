const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function runDoctor(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? new Date();
  const defaults = resolveDesktopDefaults({ env, homeDir, platform });
  const configProbe = probeOpenClawConfig(defaults.configPath);
  const skillRoots = resolveSkillRoots({
    env,
    homeDir,
    openclawHome: defaults.openclawHome,
    platform,
  });
  const skillRootProbes = skillRoots.map(probeSkillRoot);
  const workspaceRoot = resolveWorkspaceRoot({
    env,
    openclawHome: defaults.openclawHome,
    config: configProbe.config,
  });

  const checks = [
    checkAppData(defaults.appDataDir, platform),
    checkNodeRuntime(),
    checkOpenClawConfig(configProbe),
    checkSkillRoots(skillRootProbes),
    checkWorkspaceRoot(workspaceRoot),
    checkPowerShell(platform, env),
    checkWindowsLongPaths(platform, env),
  ];

  return {
    generatedAt: now.toISOString(),
    platform,
    appDataDir: defaults.appDataDir,
    openclawHome: defaults.openclawHome,
    configPath: defaults.configPath,
    workspaceRoot,
    skillRoots: skillRootProbes,
    checks,
    summary: summarizeChecks(checks),
  };
}

function resolveDesktopDefaults({ env, homeDir, platform }) {
  const openclawHome = resolveHomePath(env.OPENCLAW_HOME, homeDir, platform) ?? path.join(homeDir, ".openclaw");
  const appDataBase =
    platform === "win32"
      ? env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local")
      : path.join(homeDir, ".local", "share");

  return {
    openclawHome,
    configPath: path.join(openclawHome, "openclaw.json"),
    appDataDir: path.join(appDataBase, "OpenClaw Workbench"),
  };
}

function resolveSkillRoots({ env, homeDir, openclawHome, platform }) {
  if (env.OPENCLAW_SKILL_ROOTS && env.OPENCLAW_SKILL_ROOTS.trim()) {
    return env.OPENCLAW_SKILL_ROOTS.split(path.delimiter)
      .map((root) => resolveHomePath(root.trim(), homeDir, platform))
      .filter(Boolean);
  }

  return [
    path.join(openclawHome, "skills"),
    path.join(homeDir, ".codex", "skills"),
    path.join(homeDir, ".agents", "skills"),
  ];
}

function resolveWorkspaceRoot({ env, openclawHome, config }) {
  if (env.OPENCLAW_WORKSPACE_ROOT && env.OPENCLAW_WORKSPACE_ROOT.trim()) {
    return env.OPENCLAW_WORKSPACE_ROOT;
  }

  const agents = config?.agents?.list;
  if (Array.isArray(agents)) {
    const configuredWorkspace = agents
      .map((agent) => (typeof agent?.workspace === "string" ? agent.workspace.trim() : ""))
      .find(Boolean);
    if (configuredWorkspace) {
      return configuredWorkspace;
    }
  }

  return path.join(openclawHome, "workspace");
}

function probeOpenClawConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return {
      path: configPath,
      exists: false,
      readable: false,
      validJson: false,
      config: undefined,
      error: "openclaw.json was not found",
    };
  }

  try {
    const text = fs.readFileSync(configPath, "utf8");
    return {
      path: configPath,
      exists: true,
      readable: true,
      validJson: true,
      config: JSON.parse(text),
    };
  } catch (error) {
    return {
      path: configPath,
      exists: true,
      readable: false,
      validJson: false,
      config: undefined,
      error: error instanceof Error ? error.message : "failed to read openclaw.json",
    };
  }
}

function probeSkillRoot(rootPath) {
  if (!rootPath || !fs.existsSync(rootPath)) {
    return {
      path: rootPath,
      exists: false,
      skillCount: 0,
      warning: "skill root does not exist",
    };
  }

  try {
    const entries = fs.readdirSync(rootPath, { withFileTypes: true });
    const skillCount = entries.filter((entry) => {
      if (!entry.isDirectory()) return false;
      return fs.existsSync(path.join(rootPath, entry.name, "SKILL.md"));
    }).length;
    return {
      path: rootPath,
      exists: true,
      skillCount,
    };
  } catch (error) {
    return {
      path: rootPath,
      exists: true,
      skillCount: 0,
      warning: error instanceof Error ? error.message : "failed to scan skill root",
    };
  }
}

function checkAppData(appDataDir, platform) {
  const parent = path.dirname(appDataDir);
  const parentExists = fs.existsSync(parent);
  return {
    id: "app-data",
    label: "Windows app data",
    status: parentExists ? "pass" : "fail",
    message: parentExists
      ? `App data can be created under ${appDataDir}`
      : `App data parent does not exist: ${parent}`,
    detail: platform === "win32" ? "%LOCALAPPDATA% is used for local state." : "Non-Windows development fallback is active.",
  };
}

function checkNodeRuntime() {
  return {
    id: "node-runtime",
    label: "Node runtime",
    status: "pass",
    message: `Node ${process.versions.node} is available.`,
    detail: "The desktop backend can run local JavaScript services.",
  };
}

function checkOpenClawConfig(probe) {
  if (probe.exists && probe.validJson) {
    return {
      id: "openclaw-config",
      label: "OpenClaw config",
      status: "pass",
      message: `${probe.path} is readable JSON.`,
      detail: "The runtime adapter can discover OpenClaw settings.",
    };
  }

  return {
    id: "openclaw-config",
    label: "OpenClaw config",
    status: probe.exists ? "fail" : "warn",
    message: probe.error,
    detail: probe.exists
      ? "Fix the JSON before starting task execution."
      : "First-run setup should offer to create or locate an OpenClaw home.",
  };
}

function checkSkillRoots(skillRoots) {
  const existingRoots = skillRoots.filter((root) => root.exists);
  const skillCount = skillRoots.reduce((total, root) => total + root.skillCount, 0);
  if (skillCount > 0) {
    return {
      id: "skill-roots",
      label: "Skill roots",
      status: "pass",
      message: `Found ${skillCount} skill(s) across ${existingRoots.length} root(s).`,
      detail: "Indexing is safe because SKILL.md metadata is read without executing skill code.",
    };
  }

  return {
    id: "skill-roots",
    label: "Skill roots",
    status: existingRoots.length > 0 ? "warn" : "fail",
    message: existingRoots.length > 0 ? "Skill roots exist but no SKILL.md files were found." : "No configured skill roots exist.",
    detail: "Add a local skill root or import a skill folder.",
  };
}

function checkWorkspaceRoot(workspaceRoot) {
  if (fs.existsSync(workspaceRoot)) {
    return {
      id: "workspace-root",
      label: "Authorized workspace",
      status: "pass",
      message: `${workspaceRoot} exists.`,
      detail: "Tasks can request folder authorization from this root.",
    };
  }

  return {
    id: "workspace-root",
    label: "Authorized workspace",
    status: "warn",
    message: `${workspaceRoot} does not exist yet.`,
    detail: "First-run setup should ask the user to choose or create a workspace folder.",
  };
}

function checkPowerShell(platform, env) {
  if (platform !== "win32") {
    return {
      id: "powershell",
      label: "PowerShell",
      status: "skip",
      message: "PowerShell policy check is Windows-only.",
      detail: "This check will run on Windows builds.",
    };
  }

  const hasSystemRoot = typeof env.SystemRoot === "string" && env.SystemRoot.trim() !== "";
  return {
    id: "powershell",
    label: "PowerShell",
    status: hasSystemRoot ? "pass" : "warn",
    message: hasSystemRoot ? "Windows shell environment is present." : "Windows shell environment was not detected.",
    detail: "Install and system-changing commands still require explicit approval.",
  };
}

function checkWindowsLongPaths(platform, env) {
  if (platform !== "win32") {
    return {
      id: "windows-long-paths",
      label: "Windows long paths",
      status: "skip",
      message: "Long path check is Windows-only.",
      detail: "The app still uses path APIs so spaces and non-ASCII paths remain supported.",
    };
  }

  const assumedEnabled = env.OPENCLAW_ASSUME_LONG_PATHS_ENABLED === "true";
  return {
    id: "windows-long-paths",
    label: "Windows long paths",
    status: assumedEnabled ? "pass" : "warn",
    message: assumedEnabled ? "Long path support is marked enabled." : "Long path support has not been confirmed.",
    detail: "Warn users before working with deeply nested task folders.",
  };
}

function summarizeChecks(checks) {
  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const check of checks) {
    summary[check.status] += 1;
  }
  return {
    ...summary,
    ready: summary.fail === 0,
  };
}

function resolveHomePath(value, homeDir, platform) {
  if (!value || !value.trim()) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === "~") {
    return homeDir;
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(homeDir, trimmed.slice(2));
  }

  if (platform === "win32") {
    return trimmed.replace(/%USERPROFILE%/gi, homeDir);
  }

  return trimmed;
}

if (require.main === module) {
  const result = runDoctor();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.summary.fail > 0 ? 1 : 0;
}

module.exports = {
  runDoctor,
  resolveDesktopDefaults,
  resolveSkillRoots,
  resolveWorkspaceRoot,
  summarizeChecks,
};

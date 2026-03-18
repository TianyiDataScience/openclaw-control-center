import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { arch, hostname, platform, release, type, cpus, totalmem, freemem } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PACKAGE_JSON_PATH = join(process.cwd(), "package.json");
const COMMAND_TIMEOUT_MS = 10_000;

export interface DiagnosticsBundle {
  generatedAt: string;
  app: {
    name: string;
    version: string;
    commitHash: string | null;
  };
  runtime: {
    node: string;
    platform: string;
    arch: string;
    os: string;
    osRelease: string;
    hostname: string;
    cpuCount: number;
    totalMemoryMb: number;
    freeMemoryMb: number;
    uptimeSeconds: number;
  };
  gateway: {
    reachable: boolean;
    endpoint: string | null;
    pid: number | null;
    status: string | null;
  };
  tokenScopes: string | null;
  recentErrors: string[];
  openclawVersion: string | null;
}

export async function collectDiagnosticsBundle(): Promise<DiagnosticsBundle> {
  const [appInfo, gatewayInfo, openclawVersion, commitHash] = await Promise.all([
    readAppInfo(),
    readGatewayInfo(),
    readOpenClawVersion(),
    readGitCommitHash(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    app: {
      name: appInfo.name,
      version: appInfo.version,
      commitHash,
    },
    runtime: {
      node: process.version,
      platform: platform(),
      arch: arch(),
      os: type(),
      osRelease: release(),
      hostname: hostname(),
      cpuCount: cpus().length,
      totalMemoryMb: Math.round(totalmem() / 1024 / 1024),
      freeMemoryMb: Math.round(freemem() / 1024 / 1024),
      uptimeSeconds: Math.round(process.uptime()),
    },
    gateway: gatewayInfo,
    tokenScopes: await readTokenScopes(),
    recentErrors: [],
    openclawVersion,
  };
}

async function readAppInfo(): Promise<{ name: string; version: string }> {
  try {
    const raw = await readFile(PACKAGE_JSON_PATH, "utf8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    return {
      name: typeof pkg.name === "string" ? pkg.name : "unknown",
      version: typeof pkg.version === "string" ? pkg.version : "0.0.0",
    };
  } catch {
    return { name: "unknown", version: "0.0.0" };
  }
}

async function readGitCommitHash(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], {
      timeout: COMMAND_TIMEOUT_MS,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function readGatewayInfo(): Promise<DiagnosticsBundle["gateway"]> {
  try {
    const { stdout } = await execFileAsync("openclaw", ["gateway", "status", "--json"], {
      timeout: COMMAND_TIMEOUT_MS,
    });
    const json = parseEmbeddedJson(stdout);
    if (!json || typeof json !== "object") {
      return { reachable: false, endpoint: null, pid: null, status: null };
    }
    const root = json as Record<string, unknown>;
    const rpc = root.rpc as Record<string, unknown> | undefined;
    const service = root.service as Record<string, unknown> | undefined;
    const runtime = service?.runtime as Record<string, unknown> | undefined;

    const reachable =
      rpc?.ok === true ||
      runtime?.status === "running" ||
      runtime?.state === "active";

    return {
      reachable,
      endpoint: typeof rpc?.url === "string" ? rpc.url : null,
      pid: typeof runtime?.pid === "number" ? runtime.pid : null,
      status: typeof runtime?.status === "string" ? runtime.status : null,
    };
  } catch {
    return { reachable: false, endpoint: null, pid: null, status: null };
  }
}

async function readOpenClawVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("openclaw", ["--version"], {
      timeout: COMMAND_TIMEOUT_MS,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function readTokenScopes(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("openclaw", ["status", "--json"], {
      timeout: COMMAND_TIMEOUT_MS,
    });
    const json = parseEmbeddedJson(stdout);
    if (!json || typeof json !== "object") return null;
    const root = json as Record<string, unknown>;
    const gateway = root.gateway as Record<string, unknown> | undefined;
    if (gateway?.token) return "[REDACTED — token present]";
    if (gateway?.authenticated === true) return "[authenticated]";
    return "[no token detected]";
  } catch {
    return null;
  }
}

function parseEmbeddedJson(input: string): unknown {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Try finding JSON in output
  }
  for (let i = 0; i < input.length; i++) {
    if (input[i] === "{" || input[i] === "[") {
      try {
        return JSON.parse(input.slice(i));
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

export function formatDiagnosticsText(bundle: DiagnosticsBundle): string {
  const lines: string[] = [
    `# Diagnostics Bundle`,
    `Generated: ${bundle.generatedAt}`,
    ``,
    `## Application`,
    `Name: ${bundle.app.name}`,
    `Version: ${bundle.app.version}`,
    `Commit: ${bundle.app.commitHash ?? "unknown"}`,
    `OpenClaw CLI: ${bundle.openclawVersion ?? "not found"}`,
    ``,
    `## Runtime`,
    `Node: ${bundle.runtime.node}`,
    `OS: ${bundle.runtime.os} ${bundle.runtime.osRelease} (${bundle.runtime.platform}/${bundle.runtime.arch})`,
    `Host: ${bundle.runtime.hostname}`,
    `CPUs: ${bundle.runtime.cpuCount}`,
    `Memory: ${bundle.runtime.freeMemoryMb}MB free / ${bundle.runtime.totalMemoryMb}MB total`,
    `Uptime: ${bundle.runtime.uptimeSeconds}s`,
    ``,
    `## Gateway`,
    `Reachable: ${bundle.gateway.reachable ? "Yes" : "No"}`,
    `Endpoint: ${bundle.gateway.endpoint ?? "unknown"}`,
    `PID: ${bundle.gateway.pid ?? "unknown"}`,
    `Status: ${bundle.gateway.status ?? "unknown"}`,
    ``,
    `## Token Scopes`,
    `${bundle.tokenScopes ?? "unknown"}`,
  ];
  return lines.join("\n");
}

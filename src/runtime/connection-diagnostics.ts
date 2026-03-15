import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface ConnectionDiagnostic {
  id: string;
  name: string;
  status: "ok" | "warn" | "error";
  message: string;
  suggestion?: string;
  path?: string;
}

export interface ConnectionDiagnosticsReport {
  generatedAt: string;
  overall: "healthy" | "degraded" | "critical";
  checks: ConnectionDiagnostic[];
  connectedCount: number;
  totalCount: number;
}

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const GATEWAY_URL = process.env.GATEWAY_URL || "ws://127.0.0.1:18789";

async function checkFileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function checkGatewayConnection(): Promise<ConnectionDiagnostic> {
  const gatewayHost = GATEWAY_URL.replace(/^wss?:\/\//, "").split(":")[0];
  const gatewayPort = GATEWAY_URL.split(":").pop() || "18789";
  
  try {
    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(exec);
    
    // Try to check if port is listening
    await execAsync(`timeout 2 bash -c "echo > /dev/tcp/${gatewayHost}/${gatewayPort}" 2>/dev/null || nc -z -w2 ${gatewayHost} ${gatewayPort} 2>/dev/null`);
    
    return {
      id: "gateway",
      name: "OpenClaw Gateway",
      status: "ok",
      message: `Connected to ${GATEWAY_URL}`,
    };
  } catch {
    return {
      id: "gateway",
      name: "OpenClaw Gateway",
      status: "error",
      message: `Cannot reach ${GATEWAY_URL}`,
      suggestion: "Check GATEWAY_URL in .env and ensure OpenClaw Gateway is running",
    };
  }
}

async function checkOpenclawConfig(): Promise<ConnectionDiagnostic> {
  const configPath = join(OPENCLAW_HOME, "openclaw.json");
  const exists = await checkFileExists(configPath);
  
  if (!exists) {
    return {
      id: "openclaw_config",
      name: "OpenClaw Config",
      status: "error",
      message: "openclaw.json not found",
      suggestion: `Set OPENCLAW_HOME or ensure ${configPath} exists`,
      path: configPath,
    };
  }
  
  try {
    const content = await readFile(configPath, "utf-8");
    const config = JSON.parse(content);
    const agentCount = config.agents?.length || 0;
    
    return {
      id: "openclaw_config",
      name: "OpenClaw Config",
      status: "ok",
      message: `Found ${agentCount} agents configured`,
      path: configPath,
    };
  } catch {
    return {
      id: "openclaw_config",
      name: "OpenClaw Config",
      status: "warn",
      message: "Config file exists but cannot parse",
      path: configPath,
    };
  }
}

async function checkCodexTelemetry(): Promise<ConnectionDiagnostic> {
  const telemetryPath = join(CODEX_HOME, "telemetry");
  const exists = await checkFileExists(telemetryPath);
  
  if (!exists) {
    return {
      id: "codex_telemetry",
      name: "Codex Telemetry",
      status: "warn",
      message: "Telemetry directory not found",
      suggestion: "Usage metrics will be limited. Set CODEX_HOME if using custom path",
      path: telemetryPath,
    };
  }
  
  return {
    id: "codex_telemetry",
    name: "Codex Telemetry",
    status: "ok",
    message: "Telemetry directory accessible",
    path: telemetryPath,
  };
}

async function checkSubscriptionSnapshot(): Promise<ConnectionDiagnostic> {
  const snapshotPath = process.env.OPENCLAW_SUBSCRIPTION_SNAPSHOT_PATH || 
    join(OPENCLAW_HOME, "subscription-snapshot.json");
  
  const exists = await checkFileExists(snapshotPath);
  
  if (!exists) {
    return {
      id: "subscription",
      name: "Subscription Data",
      status: "warn",
      message: "Subscription snapshot not found",
      suggestion: "Quota tracking will be unavailable. Set OPENCLAW_SUBSCRIPTION_SNAPSHOT_PATH if exists",
      path: snapshotPath,
    };
  }
  
  return {
    id: "subscription",
    name: "Subscription Data",
    status: "ok",
    message: "Subscription snapshot accessible",
    path: snapshotPath,
  };
}

async function checkRuntimeDirectory(): Promise<ConnectionDiagnostic> {
  const runtimePath = join(process.cwd(), "runtime");
  const exists = await checkFileExists(runtimePath);
  
  if (!exists) {
    return {
      id: "runtime_dir",
      name: "Runtime Directory",
      status: "warn",
      message: "Runtime directory not found",
      suggestion: "Will be created on first monitor run",
      path: runtimePath,
    };
  }
  
  const snapshotPath = join(runtimePath, "last-snapshot.json");
  const snapshotExists = await checkFileExists(snapshotPath);
  
  return {
    id: "runtime_dir",
    name: "Runtime Directory",
    status: snapshotExists ? "ok" : "warn",
    message: snapshotExists ? "Runtime data available" : "Runtime directory exists but no snapshot yet",
    path: runtimePath,
  };
}

async function checkModelContextCatalog(): Promise<ConnectionDiagnostic> {
  const catalogPath = join(process.cwd(), "runtime", "model-context-catalog.json");
  const exists = await checkFileExists(catalogPath);
  
  if (!exists) {
    return {
      id: "model_catalog",
      name: "Model Context Catalog",
      status: "warn",
      message: "Model catalog not configured",
      suggestion: "Context window percentages will be unavailable",
      path: catalogPath,
    };
  }
  
  return {
    id: "model_catalog",
    name: "Model Context Catalog",
    status: "ok",
    message: "Model catalog configured",
    path: catalogPath,
  };
}

export async function runConnectionDiagnostics(): Promise<ConnectionDiagnosticsReport> {
  const checks = await Promise.all([
    checkGatewayConnection(),
    checkOpenclawConfig(),
    checkCodexTelemetry(),
    checkSubscriptionSnapshot(),
    checkRuntimeDirectory(),
    checkModelContextCatalog(),
  ]);
  
  const connectedCount = checks.filter(c => c.status === "ok").length;
  const errorCount = checks.filter(c => c.status === "error").length;
  const warnCount = checks.filter(c => c.status === "warn").length;
  
  let overall: "healthy" | "degraded" | "critical";
  if (errorCount > 0 || connectedCount === 0) {
    overall = "critical";
  } else if (warnCount > 2) {
    overall = "degraded";
  } else {
    overall = "healthy";
  }
  
  return {
    generatedAt: new Date().toISOString(),
    overall,
    checks,
    connectedCount,
    totalCount: checks.length,
  };
}

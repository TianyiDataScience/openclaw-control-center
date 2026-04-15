import { existsSync } from "node:fs";
import { join } from "node:path";

const DOTENV_PATH = join(process.cwd(), ".env");

if (existsSync(DOTENV_PATH)) {
  process.loadEnvFile?.(DOTENV_PATH);
}

export const GATEWAY_URL = readStringEnv(process.env.GATEWAY_URL, "ws://127.0.0.1:18789");
export const OPENCLAW_CONTROL_UI_URL = readOptionalStringEnv(process.env.OPENCLAW_CONTROL_UI_URL);
export const UI_TIMEZONE = readTimeZoneEnv(process.env.UI_TIMEZONE, "UTC");
export const TASK_ROOM_BRIDGE_ENABLED = process.env.TASK_ROOM_BRIDGE_ENABLED === "true";
export const TASK_ROOM_BRIDGE_DISCORD_WEBHOOK_URL = readOptionalStringEnv(
  process.env.TASK_ROOM_BRIDGE_DISCORD_WEBHOOK_URL,
);
export const TASK_ROOM_BRIDGE_TELEGRAM_BOT_TOKEN = readOptionalStringEnv(
  process.env.TASK_ROOM_BRIDGE_TELEGRAM_BOT_TOKEN,
);
export const TASK_ROOM_BRIDGE_TELEGRAM_CHAT_ID = readOptionalStringEnv(
  process.env.TASK_ROOM_BRIDGE_TELEGRAM_CHAT_ID,
);

export const READONLY_MODE = process.env.READONLY_MODE !== "false";
export const APPROVAL_ACTIONS_ENABLED = process.env.APPROVAL_ACTIONS_ENABLED === "true";
export const APPROVAL_ACTIONS_DRY_RUN = process.env.APPROVAL_ACTIONS_DRY_RUN !== "false";
export const IMPORT_MUTATION_ENABLED = process.env.IMPORT_MUTATION_ENABLED === "true";
export const IMPORT_MUTATION_DRY_RUN = process.env.IMPORT_MUTATION_DRY_RUN === "true";
export const LOCAL_TOKEN_AUTH_REQUIRED = process.env.LOCAL_TOKEN_AUTH_REQUIRED !== "false";
export const LOCAL_API_TOKEN = (process.env.LOCAL_API_TOKEN ?? "").trim();
export const LOCAL_TOKEN_HEADER = "x-local-token" as const;
export const HALL_RUNTIME_DISPATCH_ENABLED = process.env.HALL_RUNTIME_DISPATCH_ENABLED !== "false";
export const HALL_RUNTIME_DIRECT_STREAM_ENABLED = process.env.HALL_RUNTIME_DIRECT_STREAM_ENABLED !== "false";
export const HALL_RUNTIME_THINKING_LEVEL = readThinkingLevelEnv(process.env.HALL_RUNTIME_THINKING_LEVEL, "minimal");
export const HALL_RUNTIME_TIMEOUT_SECONDS = parsePositiveInt(
  process.env.HALL_RUNTIME_TIMEOUT_SECONDS,
  600,
);
export const HALL_RUNTIME_POLL_INTERVAL_MS = parsePositiveInt(
  process.env.HALL_RUNTIME_POLL_INTERVAL_MS,
  350,
);
export const HALL_RUNTIME_HISTORY_LIMIT = parsePositiveInt(
  process.env.HALL_RUNTIME_HISTORY_LIMIT,
  120,
);
export const HALL_RUNTIME_EXECUTION_CHAIN_ENABLED = process.env.HALL_RUNTIME_EXECUTION_CHAIN_ENABLED !== "false";
export const HALL_RUNTIME_EXECUTION_MAX_TURNS = parsePositiveInt(
  process.env.HALL_RUNTIME_EXECUTION_MAX_TURNS,
  3,
);
export const TASK_HEARTBEAT_ENABLED = process.env.TASK_HEARTBEAT_ENABLED !== "false";
export const TASK_HEARTBEAT_DRY_RUN = process.env.TASK_HEARTBEAT_DRY_RUN !== "false";
export const TASK_HEARTBEAT_MAX_TASKS_PER_RUN = parsePositiveInt(
  process.env.TASK_HEARTBEAT_MAX_TASKS_PER_RUN,
  3,
);
export const MONITOR_CONTINUOUS_MAX_INTERVAL_MS = parsePositiveInt(
  process.env.MONITOR_CONTINUOUS_MAX_INTERVAL_MS,
  60_000,
);

export const POLLING_INTERVALS_MS = {
  sessionsList: 10000,
  sessionStatus: 2000,
  cron: 10000,
  approvals: 2000,
  canvas: 5000,
} as const;

export type PollingTarget = keyof typeof POLLING_INTERVALS_MS;

function parsePositiveInt(input: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(input ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function readStringEnv(input: string | undefined, fallback: string): string {
  const value = (input ?? "").trim();
  return value === "" ? fallback : value;
}

function readOptionalStringEnv(input: string | undefined): string | undefined {
  const value = (input ?? "").trim();
  return value === "" ? undefined : value;
}

function readTimeZoneEnv(input: string | undefined, fallback: string): string {
  const value = (input ?? "").trim();
  const candidate = value === "" ? fallback : value;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return fallback;
  }
}

function readThinkingLevelEnv(
  input: string | undefined,
  fallback: "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" {
  switch ((input ?? "").trim()) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return (input ?? "").trim() as "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    default:
      return fallback;
  }
}

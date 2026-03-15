import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const INSIGHT_CACHE_TTL_MS = 15_000;
const INSIGHT_COMMAND_TIMEOUT_MS = 4_000;
const STATUS_COMMAND_TIMEOUT_MS = 8_000;
const UPDATE_STATUS_COMMAND_TIMEOUT_MS = 8_000;
const INSIGHT_COMMAND_MAX_BUFFER = 4 * 1024 * 1024;

interface TimedSourceCache<T> {
  value: T;
  expiresAt: number;
}

export type OpenClawInsightStatus = "ok" | "warn" | "blocked" | "info" | "unknown";

export interface OpenClawConnectionItemSummary {
  key: "gateway" | "config" | "runtime";
  status: OpenClawInsightStatus;
  detail: string;
  value: string;
}

export interface OpenClawConnectionSummary {
  generatedAt: string;
  status: OpenClawInsightStatus;
  items: OpenClawConnectionItemSummary[];
}

export interface OpenClawUpdateSummary {
  generatedAt: string;
  status: OpenClawInsightStatus;
  currentVersion?: string;
  latestVersion?: string;
  channelLabel?: string;
  updateAvailable: boolean;
  installKind?: string;
  packageManager?: string;
}

export interface OpenClawSecurityFindingSummary {
  checkId: string;
  severity: "critical" | "warn" | "info";
  title: string;
  detail: string;
  remediation?: string;
}

export interface OpenClawSecuritySummary {
  generatedAt: string;
  status: OpenClawInsightStatus;
  counts: {
    critical: number;
    warn: number;
    info: number;
  };
  findings: OpenClawSecurityFindingSummary[];
}

export interface OpenClawMemoryAgentSummary {
  agentId: string;
  status: OpenClawInsightStatus;
  files: number;
  chunks: number;
  issuesCount: number;
  dirty: boolean;
  vectorAvailable: boolean;
  searchable: boolean;
  lastUpdateAt?: string;
}

export interface OpenClawMemorySummary {
  generatedAt: string;
  status: OpenClawInsightStatus;
  okCount: number;
  warnCount: number;
  blockedCount: number;
  agents: OpenClawMemoryAgentSummary[];
}

let statusCache: TimedSourceCache<unknown> | undefined;
let statusInFlight: Promise<unknown> | undefined;
let gatewayCache: TimedSourceCache<unknown> | undefined;
let gatewayInFlight: Promise<unknown> | undefined;
let securityCache: TimedSourceCache<unknown> | undefined;
let securityInFlight: Promise<unknown> | undefined;
let updateCache: TimedSourceCache<unknown> | undefined;
let updateInFlight: Promise<unknown> | undefined;
let memoryCache: TimedSourceCache<unknown> | undefined;
let memoryInFlight: Promise<unknown> | undefined;

export function primeOpenClawCliInsights(): void {
  void loadCachedOpenClawConnectionSummary();
  void loadCachedOpenClawUpdateSummary();
  void loadCachedOpenClawSecuritySummary();
  void loadCachedOpenClawMemorySummary();
}

export async function loadCachedOpenClawConnectionSummary(): Promise<OpenClawConnectionSummary> {
  const [statusJson, gatewayJson] = await Promise.all([
    loadCachedOpenClawStatusJson(),
    loadCachedOpenClawGatewayStatusJson(),
  ]);
  return summarizeOpenClawConnection(statusJson, gatewayJson);
}

export async function loadCachedOpenClawUpdateSummary(): Promise<OpenClawUpdateSummary> {
  const [statusJson, updateJson] = await Promise.all([
    loadCachedOpenClawStatusJson(),
    loadCachedOpenClawUpdateStatusJson(),
  ]);
  return summarizeOpenClawUpdate(statusJson, updateJson);
}

export async function loadCachedOpenClawSecuritySummary(): Promise<OpenClawSecuritySummary> {
  const securityJson = await loadCachedOpenClawSecurityAuditJson();
  return summarizeOpenClawSecurity(securityJson);
}

export async function loadCachedOpenClawMemorySummary(): Promise<OpenClawMemorySummary> {
  const memoryJson = await loadCachedOpenClawMemoryStatusJson();
  return summarizeOpenClawMemory(memoryJson);
}

export function summarizeOpenClawConnection(statusJson: unknown, gatewayJson: unknown): OpenClawConnectionSummary {
  const now = new Date().toISOString();
  const statusRoot = asObject(statusJson) ?? {};
  const gatewayRoot = asObject(gatewayJson) ?? {};
  const gatewayService = asObject(gatewayRoot.service);
  const gatewayRuntime = asObject(gatewayService?.runtime);
  const gatewayConfig = asObject(gatewayRoot.config);
  const gatewayMeta = asObject(gatewayRoot.gateway);
  const gatewayRpc = asObject(gatewayRoot.rpc);
  const cliConfig = asObject(gatewayConfig?.cli);
  const daemonConfig = asObject(gatewayConfig?.daemon);
  const sessions = asObject(statusRoot.sessions);
  const statusAgents = asObject(statusRoot.agents);
  const agentBuckets = asArray(statusAgents?.agents ?? statusRoot.agents);
  const sessionsCount = asNumber(sessions?.count) ?? 0;
  const activeAgentCount = agentBuckets.filter((item) => {
    const obj = asObject(item);
    return (asNumber(obj?.sessionsCount) ?? 0) > 0;
  }).length;
  const hasRuntimeSnapshot = sessions !== undefined || statusAgents !== undefined || asString(statusRoot.runtimeVersion) !== undefined;

  const gatewayRunning = asBoolean(gatewayRpc?.ok) === true || asString(gatewayRuntime?.status) === "running";
  const gatewayStatus: OpenClawInsightStatus = gatewayRunning ? "ok" : "blocked";
  const gatewayDetail = gatewayRunning
    ? `${asString(gatewayMeta?.probeUrl) ?? "Gateway"}`
    : "Gateway is not reachable";
  const gatewayValue = gatewayRunning ? "Connected" : "Unavailable";

  const cliValid = asBoolean(cliConfig?.exists) === true && asBoolean(cliConfig?.valid) === true;
  const daemonValid = asBoolean(daemonConfig?.exists) === true && asBoolean(daemonConfig?.valid) === true;
  const allowedOrigins = asArray(
    asObject(cliConfig?.controlUi)?.allowedOrigins ?? asObject(daemonConfig?.controlUi)?.allowedOrigins,
  ).length;
  const configStatus: OpenClawInsightStatus = cliValid && daemonValid ? "ok" : "blocked";
  const configDetail =
    cliValid && daemonValid
      ? allowedOrigins > 0
        ? `${allowedOrigins} allowed origin${allowedOrigins === 1 ? "" : "s"}`
        : "Local-only by default"
      : "openclaw.json is missing or invalid";
  const configValue = cliValid && daemonValid ? "Ready" : "Needs fix";

  const runtimeStatus: OpenClawInsightStatus = !hasRuntimeSnapshot
    ? "info"
    : sessionsCount > 0
      ? "ok"
      : activeAgentCount > 0
        ? "info"
        : "warn";
  const runtimeDetail = !hasRuntimeSnapshot
    ? "Runtime status is still loading"
    : sessionsCount > 0
      ? `${sessionsCount} session${sessionsCount === 1 ? "" : "s"} visible across ${Math.max(activeAgentCount, 1)} agent${Math.max(activeAgentCount, 1) === 1 ? "" : "s"}`
      : activeAgentCount > 0
        ? `${activeAgentCount} agent${activeAgentCount === 1 ? "" : "s"} configured, but no recent sessions yet`
        : "No runtime sessions are visible yet";
  const runtimeValue = !hasRuntimeSnapshot ? "loading" : sessionsCount > 0 ? String(sessionsCount) : activeAgentCount > 0 ? String(activeAgentCount) : "0";

  const items: OpenClawConnectionItemSummary[] = [
    {
      key: "gateway",
      status: gatewayStatus,
      detail: gatewayDetail,
      value: gatewayValue,
    },
    {
      key: "config",
      status: configStatus,
      detail: configDetail,
      value: configValue,
    },
    {
      key: "runtime",
      status: runtimeStatus,
      detail: runtimeDetail,
      value: runtimeValue,
    },
  ];

  return {
    generatedAt: now,
    status: foldInsightStatuses(items.map((item) => item.status)),
    items,
  };
}

export function summarizeOpenClawUpdate(statusJson: unknown, updateJson: unknown): OpenClawUpdateSummary {
  const statusRoot = asObject(statusJson) ?? {};
  const updateRoot = asObject(updateJson) ?? {};
  const updateStatus = asObject(updateRoot.update);
  const availability = asObject(updateRoot.availability);
  const channel = asObject(updateRoot.channel);
  const registry = asObject(updateStatus?.registry);
  const latestVersion =
    asString(availability?.latestVersion) ??
    asString(registry?.latestVersion);
  const currentVersion = asString(statusRoot.runtimeVersion);
  const updateAvailable = asBoolean(availability?.available) === true;
  return {
    generatedAt: new Date().toISOString(),
    status: updateAvailable ? "info" : currentVersion ? "ok" : latestVersion ? "info" : "unknown",
    currentVersion,
    latestVersion,
    channelLabel: asString(channel?.label),
    updateAvailable,
    installKind: asString(updateStatus?.installKind),
    packageManager: asString(updateStatus?.packageManager),
  };
}

export function summarizeOpenClawSecurity(securityJson: unknown): OpenClawSecuritySummary {
  const root = asObject(securityJson) ?? {};
  const summary = asObject(root.summary);
  const findings = asArray(root.findings).map((item) => {
    const obj = asObject(item) ?? {};
    const severity = normalizeSeverity(asString(obj.severity));
    return {
      checkId: asString(obj.checkId) ?? "unknown",
      severity,
      title: asString(obj.title) ?? "Untitled finding",
      detail: asString(obj.detail) ?? "",
      remediation: asString(obj.remediation),
    } satisfies OpenClawSecurityFindingSummary;
  });
  const counts = {
    critical: asNumber(summary?.critical) ?? findings.filter((item) => item.severity === "critical").length,
    warn: asNumber(summary?.warn) ?? findings.filter((item) => item.severity === "warn").length,
    info: asNumber(summary?.info) ?? findings.filter((item) => item.severity === "info").length,
  };
  return {
    generatedAt: new Date().toISOString(),
    status:
      counts.critical > 0
        ? "blocked"
        : counts.warn > 0
          ? "warn"
          : counts.info > 0
            ? "info"
            : "ok",
    counts,
    findings,
  };
}

export function summarizeOpenClawMemory(memoryJson: unknown): OpenClawMemorySummary {
  const items = asArray(memoryJson).map((item) => {
    const root = asObject(item) ?? {};
    const status = asObject(root.status);
    const vector = asObject(status?.vector);
    const custom = asObject(status?.custom);
    const qmd = asObject(custom?.qmd);
    const scan = asObject(root.scan);
    const issues = asArray(scan?.issues);
    const files = asNumber(status?.files) ?? 0;
    const chunks = asNumber(status?.chunks) ?? 0;
    const dirty = asBoolean(status?.dirty) === true;
    const vectorAvailable = asBoolean(vector?.available) === true;
    const searchable = files > 0 && vectorAvailable;
    let agentStatus: OpenClawInsightStatus = "ok";
    if (!vectorAvailable || issues.length > 0) {
      agentStatus = "warn";
    }
    if (files === 0 || chunks === 0) {
      agentStatus = "blocked";
    } else if (dirty) {
      agentStatus = "info";
    }
    return {
      agentId: asString(root.agentId) ?? "unknown",
      status: agentStatus,
      files,
      chunks,
      issuesCount: issues.length,
      dirty,
      vectorAvailable,
      searchable,
      lastUpdateAt: asString(qmd?.lastUpdateAt),
    } satisfies OpenClawMemoryAgentSummary;
  });

  const okCount = items.filter((item) => item.status === "ok").length;
  const warnCount = items.filter((item) => item.status === "warn" || item.status === "info").length;
  const blockedCount = items.filter((item) => item.status === "blocked").length;

  return {
    generatedAt: new Date().toISOString(),
    status: blockedCount > 0 ? "blocked" : warnCount > 0 ? "warn" : okCount > 0 ? "ok" : "unknown",
    okCount,
    warnCount,
    blockedCount,
    agents: items.sort((a, b) => insightStatusRank(a.status) - insightStatusRank(b.status) || a.agentId.localeCompare(b.agentId)),
  };
}

async function loadCachedOpenClawStatusJson(): Promise<unknown> {
  return loadSourceWithCache(
    statusCache,
    statusInFlight,
    () => runOpenClawJson(["status", "--json"], {}, { timeoutMs: STATUS_COMMAND_TIMEOUT_MS }),
    (value) => {
      statusCache = value;
    },
    (value) => {
      statusInFlight = value;
    },
  );
}

async function loadCachedOpenClawGatewayStatusJson(): Promise<unknown> {
  return loadSourceWithCache(
    gatewayCache,
    gatewayInFlight,
    () => runOpenClawJson(["gateway", "status", "--json"], {}),
    (value) => {
      gatewayCache = value;
    },
    (value) => {
      gatewayInFlight = value;
    },
  );
}

async function loadCachedOpenClawSecurityAuditJson(): Promise<unknown> {
  return loadSourceWithCache(
    securityCache,
    securityInFlight,
    () => runOpenClawJson(["security", "audit", "--json"], {}),
    (value) => {
      securityCache = value;
    },
    (value) => {
      securityInFlight = value;
    },
  );
}

async function loadCachedOpenClawUpdateStatusJson(): Promise<unknown> {
  return loadSourceWithCache(
    updateCache,
    updateInFlight,
    () => runOpenClawJson(["update", "status", "--json"], {}, { timeoutMs: UPDATE_STATUS_COMMAND_TIMEOUT_MS }),
    (value) => {
      updateCache = value;
    },
    (value) => {
      updateInFlight = value;
    },
  );
}

async function loadCachedOpenClawMemoryStatusJson(): Promise<unknown> {
  return loadSourceWithCache(
    memoryCache,
    memoryInFlight,
    () => runOpenClawJson(["memory", "status", "--json"], []),
    (value) => {
      memoryCache = value;
    },
    (value) => {
      memoryInFlight = value;
    },
  );
}

async function loadSourceWithCache<T>(
  cache: TimedSourceCache<T> | undefined,
  inFlight: Promise<T> | undefined,
  loader: () => Promise<T>,
  assignCache: (value: TimedSourceCache<T> | undefined) => void,
  assignInFlight: (value: Promise<T> | undefined) => void,
): Promise<T> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;
  if (cache) {
    if (!inFlight) {
      const nextValue = loader();
      assignInFlight(nextValue);
      void nextValue
        .then((value) => {
          assignCache({
            value,
            expiresAt: Date.now() + INSIGHT_CACHE_TTL_MS,
          });
        })
        .finally(() => {
          assignInFlight(undefined);
        });
    }
    return cache.value;
  }
  if (inFlight) return inFlight;

  const nextValue = loader();
  assignInFlight(nextValue);
  try {
    const value = await nextValue;
    assignCache({
      value,
      expiresAt: now + INSIGHT_CACHE_TTL_MS,
    });
    return value;
  } finally {
    assignInFlight(undefined);
  }
}

async function runOpenClawJson(
  args: string[],
  fallback: unknown,
  options?: { timeoutMs?: number },
): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync("openclaw", args, {
      timeout: options?.timeoutMs ?? INSIGHT_COMMAND_TIMEOUT_MS,
      maxBuffer: INSIGHT_COMMAND_MAX_BUFFER,
      shell: process.platform === "win32",
    });
    return parseEmbeddedJson(stdout) ?? fallback;
  } catch (error) {
    const recovered = recoverOpenClawCommandJson(error);
    return recovered ?? fallback;
  }
}

export function recoverOpenClawCommandJson(error: unknown): unknown {
  const root = asObject(error);
  const stdout = typeof root?.stdout === "string" ? root.stdout : "";
  if (!stdout.trim()) return undefined;
  return parseEmbeddedJson(stdout);
}

function asObject(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === "object" ? (input as Record<string, unknown>) : undefined;
}

function asArray(input: unknown): unknown[] {
  return Array.isArray(input) ? input : [];
}

function asString(input: unknown): string | undefined {
  return typeof input === "string" && input.trim() !== "" ? input : undefined;
}

function asBoolean(input: unknown): boolean | undefined {
  return typeof input === "boolean" ? input : undefined;
}

function asNumber(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined;
}

function parseEmbeddedJson(input: string): unknown {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Some OpenClaw commands print plugin logs before the JSON payload.
  }

  const candidateStarts: number[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const ch = input[index];
    if (ch === "{" || ch === "[") candidateStarts.push(index);
  }

  for (const start of candidateStarts) {
    const candidate = input.slice(start).trim();
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Keep scanning until we find the first valid JSON payload.
    }
  }

  return undefined;
}

function normalizeSeverity(input: string | undefined): "critical" | "warn" | "info" {
  const normalized = (input ?? "").trim().toLowerCase();
  if (normalized === "critical" || normalized === "error") return "critical";
  if (normalized === "warn" || normalized === "warning" || normalized === "recommended") return "warn";
  return "info";
}

function foldInsightStatuses(statuses: OpenClawInsightStatus[]): OpenClawInsightStatus {
  if (statuses.some((item) => item === "blocked")) return "blocked";
  if (statuses.some((item) => item === "warn")) return "warn";
  if (statuses.some((item) => item === "info")) return "info";
  if (statuses.some((item) => item === "ok")) return "ok";
  return "unknown";
}

function insightStatusRank(status: OpenClawInsightStatus): number {
  if (status === "blocked") return 0;
  if (status === "warn") return 1;
  if (status === "info") return 2;
  if (status === "ok") return 3;
  return 4;
}

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentRunState, ReadModelSnapshot } from "../types";

const RUNTIME_DIR = join(process.cwd(), "runtime");
const DIGEST_DIR = join(RUNTIME_DIR, "digests");
const MODEL_CONTEXT_CATALOG_PATH = join(RUNTIME_DIR, "model-context-catalog.json");
const DEFAULT_SUBSCRIPTION_SNAPSHOT_PATH = join(RUNTIME_DIR, "subscription-snapshot.json");
const OPENCLAW_HOME = process.env.OPENCLAW_HOME?.trim() || join(homedir(), ".openclaw");
const OPENCLAW_AGENTS_DIR = join(OPENCLAW_HOME, "agents");
const OPENCLAW_CRON_JOBS_PATH = join(OPENCLAW_HOME, "cron", "jobs.json");
const CODEX_HOME = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
const CODEX_AUTH_PATH = join(CODEX_HOME, "auth.json");
const CODEX_SESSIONS_DIR = join(CODEX_HOME, "sessions");
const CODEX_RATE_LIMIT_CONNECTOR_PATH = join(CODEX_SESSIONS_DIR, "**", "*.jsonl");
const CODEX_RATE_LIMIT_SESSION_SCAN_LIMIT = 48;
const CODEX_WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_WHAM_USAGE_TIMEOUT_MS = 3_000;
const SUBSCRIPTION_SNAPSHOT_PATHS = [
  process.env.OPENCLAW_SUBSCRIPTION_SNAPSHOT_PATH?.trim(),
  DEFAULT_SUBSCRIPTION_SNAPSHOT_PATH,
  join(OPENCLAW_HOME, "subscription.json"),
  join(OPENCLAW_HOME, "subscription-snapshot.json"),
  join(OPENCLAW_HOME, "billing", "subscription.json"),
  join(OPENCLAW_HOME, "billing", "subscription-snapshot.json"),
  join(OPENCLAW_HOME, "billing", "usage.json"),
  join(OPENCLAW_HOME, "usage", "subscription.json"),
  join(OPENCLAW_HOME, "usage", "subscription-snapshot.json"),
].filter((item): item is string => typeof item === "string" && item.trim().length > 0);
const RUNTIME_USAGE_EVENTS_CONNECTOR_PATH = join(OPENCLAW_AGENTS_DIR, "*", "sessions", "*.jsonl");
const RUNTIME_SESSION_INDEX_CONNECTOR_PATH = join(OPENCLAW_AGENTS_DIR, "*", "sessions", "sessions.json");
const SUBSCRIPTION_BUDGET_FALLBACK_SOURCE = "snapshot budgetSummary (30d cost limit)";

const DAY_MS = 24 * 60 * 60 * 1000;
const CONTEXT_WARN_RATIO = 0.7;
const CONTEXT_CRITICAL_RATIO = 0.9;
const BUDGET_WARN_RATIO = 0.8;
const RUNTIME_USAGE_LOOKBACK_DAYS = 62;
const USAGE_SOURCE_CACHE_TTL_MS = 10_000;
const RUNTIME_USAGE_SCAN_CONCURRENCY = 8;

type ConnectionStatus = "connected" | "partial" | "not_connected";
type SubscriptionReasonCode =
  | "provider_connected"
  | "provider_snapshot_partial"
  | "provider_snapshot_missing"
  | "provider_snapshot_unreadable"
  | "runtime_backfill_only"
  | "runtime_backfill_with_budget_limit"
  | "runtime_backfill_with_provider_partial";

interface TimedSourceCache<T> {
  value: T;
  expiresAt: number;
}

let usageDigestsCache: TimedSourceCache<UsageDigest[]> | undefined;
let usageDigestsInFlight: Promise<UsageDigest[]> | undefined;
let modelContextCatalogCache: TimedSourceCache<ModelContextCatalogEntry[]> | undefined;
let modelContextCatalogInFlight: Promise<ModelContextCatalogEntry[]> | undefined;
let runtimeUsageDataCache: TimedSourceCache<RuntimeUsageData> | undefined;
let runtimeUsageDataInFlight: Promise<RuntimeUsageData> | undefined;
let openclawCronJobNameMapCache: TimedSourceCache<Map<string, string>> | undefined;
let openclawCronJobNameMapInFlight: Promise<Map<string, string>> | undefined;
let subscriptionUsageWithCodexCache: TimedSourceCache<UsageSubscriptionStatus> | undefined;
let subscriptionUsageWithCodexInFlight: Promise<UsageSubscriptionStatus> | undefined;
let subscriptionUsageWithoutCodexCache: TimedSourceCache<UsageSubscriptionStatus> | undefined;
let subscriptionUsageWithoutCodexInFlight: Promise<UsageSubscriptionStatus> | undefined;

export interface UsagePeriodSummary {
  key: "today" | "7d" | "30d";
  label: string;
  tokens: number;
  estimatedCost: number;
  requestCount?: number;
  requestCountStatus: ConnectionStatus;
  statusSamples: number;
  daysCovered: number;
  pace: {
    label: string;
    state: "rising" | "steady" | "cooling" | "unknown";
  };
  sourceStatus: ConnectionStatus;
}

export interface SessionContextWindowSummary {
  sessionKey: string;
  sessionLabel: string;
  agentId: string;
  sessionState: AgentRunState;
  model: string;
  provider: string;
  usedTokens: number;
  contextLimitTokens?: number;
  usagePercent?: number;
  thresholdState: "ok" | "warn" | "critical" | "not_connected";
  paceLabel: string;
  warningThresholds: string;
  dataStatus: ConnectionStatus;
}

export interface UsageBreakdownRow {
  key: string;
  label: string;
  tokens: number;
  estimatedCost: number;
  requests: number;
  sessions: number;
  sourceStatus: ConnectionStatus;
}

export interface UsageBudgetStatus {
  status: "ok" | "warn" | "over" | "not_connected";
  usedCost30d: number;
  limitCost30d?: number;
  burnRatePerDay?: number;
  projectedDaysToLimit?: number;
  message: string;
}

export interface UsageConnectorTodo {
  id: string;
  title: string;
  detail: string;
}

export interface UsageConnectorStatus {
  modelContextCatalog: ConnectionStatus;
  digestHistory: ConnectionStatus;
  requestCounts: ConnectionStatus;
  budgetLimit: ConnectionStatus;
  providerAttribution: ConnectionStatus;
  subscriptionUsage: ConnectionStatus;
  todos: UsageConnectorTodo[];
}

export interface UsageSubscriptionStatus {
  status: ConnectionStatus;
  planLabel: string;
  consumed?: number;
  remaining?: number;
  limit?: number;
  usagePercent?: number;
  unit: string;
  cycleStart?: string;
  cycleEnd?: string;
  sourcePath?: string;
  detail: string;
  connectHint: string;
  reasonCode?: SubscriptionReasonCode;
  primaryWindowLabel?: string;
  primaryUsedPercent?: number;
  primaryRemainingPercent?: number;
  primaryResetAt?: string;
  secondaryWindowLabel?: string;
  secondaryUsedPercent?: number;
  secondaryRemainingPercent?: number;
  secondaryResetAt?: string;
}

export interface UsageCostSnapshot {
  generatedAt: string;
  periods: UsagePeriodSummary[];
  contextWindows: SessionContextWindowSummary[];
  breakdown: UsageBreakdownGroups;
  breakdownToday: UsageBreakdownGroups;
  budget: UsageBudgetStatus;
  subscription: UsageSubscriptionStatus;
  connectors: UsageConnectorStatus;
}

export type UsageCostMode = "full" | "summary";

interface UsageBreakdownGroups {
  byAgent: UsageBreakdownRow[];
  byProject: UsageBreakdownRow[];
  byTask: UsageBreakdownRow[];
  byModel: UsageBreakdownRow[];
  byProvider: UsageBreakdownRow[];
  bySessionType: UsageBreakdownRow[];
  byCronJob: UsageBreakdownRow[];
  byCronAgent: UsageBreakdownRow[];
}

interface UsageDigest {
  date: string;
  usage: {
    statuses: number;
    totalTokensIn: number;
    totalTokensOut: number;
    totalCost: number;
  };
}

interface ModelContextCatalogEntry {
  match: string;
  contextWindowTokens: number;
  provider?: string;
}

interface RuntimeSessionContext {
  sessionKey: string;
  sessionId?: string;
  agentId: string;
  model?: string;
  provider?: string;
  contextWindowTokens?: number;
  totalTokens?: number;
  channel?: string;
  surface?: string;
}

interface RuntimeUsageEvent {
  timestamp: string;
  day: string;
  sessionId: string;
  sessionKey?: string;
  agentId: string;
  projectId?: string;
  model?: string;
  provider?: string;
  tokens: number;
  cost: number;
}

interface RuntimeUsageData {
  sourceStatus: ConnectionStatus;
  sessionContexts: RuntimeSessionContext[];
  events: RuntimeUsageEvent[];
}

interface RuntimeUsageResolved {
  sourceStatus: ConnectionStatus;
  sessionByKey: Map<string, RuntimeSessionContext>;
  sessionById: Map<string, RuntimeSessionContext>;
  events: RuntimeUsageEvent[];
}

interface CodexRateLimitSnapshot {
  timestampMs: number;
  sourcePath: string;
  limitId?: string;
  limitName?: string;
  primaryUsedPercent: number;
  primaryWindowMinutes?: number;
  primaryResetAtMs?: number;
  secondaryUsedPercent?: number;
  secondaryWindowMinutes?: number;
  secondaryResetAtMs?: number;
  planType?: string;
}

interface CodexWhamUsageSnapshot {
  sourcePath: string;
  planType?: string;
  primaryUsedPercent: number;
  primaryWindowMinutes?: number;
  primaryResetAtMs?: number;
  secondaryUsedPercent?: number;
  secondaryWindowMinutes?: number;
  secondaryResetAtMs?: number;
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
            expiresAt: Date.now() + USAGE_SOURCE_CACHE_TTL_MS,
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
      expiresAt: Date.now() + USAGE_SOURCE_CACHE_TTL_MS,
    });
    return value;
  } finally {
    assignInFlight(undefined);
  }
}

async function loadCachedUsageDigests(): Promise<UsageDigest[]> {
  return loadSourceWithCache(
    usageDigestsCache,
    usageDigestsInFlight,
    loadUsageDigests,
    (value) => {
      usageDigestsCache = value;
    },
    (value) => {
      usageDigestsInFlight = value;
    },
  );
}

async function loadCachedModelContextCatalog(): Promise<ModelContextCatalogEntry[]> {
  return loadSourceWithCache(
    modelContextCatalogCache,
    modelContextCatalogInFlight,
    loadModelContextCatalog,
    (value) => {
      modelContextCatalogCache = value;
    },
    (value) => {
      modelContextCatalogInFlight = value;
    },
  );
}

async function loadCachedRuntimeUsageData(): Promise<RuntimeUsageData> {
  return loadSourceWithCache(
    runtimeUsageDataCache,
    runtimeUsageDataInFlight,
    loadRuntimeUsageData,
    (value) => {
      runtimeUsageDataCache = value;
    },
    (value) => {
      runtimeUsageDataInFlight = value;
    },
  );
}

async function loadCachedOpenclawCronJobNameMap(): Promise<Map<string, string>> {
  return loadSourceWithCache(
    openclawCronJobNameMapCache,
    openclawCronJobNameMapInFlight,
    loadOpenclawCronJobNameMap,
    (value) => {
      openclawCronJobNameMapCache = value;
    },
    (value) => {
      openclawCronJobNameMapInFlight = value;
    },
  );
}

async function loadCachedSubscriptionUsage(options: {
  includeCodexTelemetry?: boolean;
} = {}): Promise<UsageSubscriptionStatus> {
  const includeCodexTelemetry = options.includeCodexTelemetry !== false;
  return loadSourceWithCache(
    includeCodexTelemetry ? subscriptionUsageWithCodexCache : subscriptionUsageWithoutCodexCache,
    includeCodexTelemetry ? subscriptionUsageWithCodexInFlight : subscriptionUsageWithoutCodexInFlight,
    () => loadSubscriptionUsage({ includeCodexTelemetry }),
    (value) => {
      if (includeCodexTelemetry) {
        subscriptionUsageWithCodexCache = value;
      } else {
        subscriptionUsageWithoutCodexCache = value;
      }
    },
    (value) => {
      if (includeCodexTelemetry) {
        subscriptionUsageWithCodexInFlight = value;
      } else {
        subscriptionUsageWithoutCodexInFlight = value;
      }
    },
  );
}

export async function buildUsageCostSnapshot(
  snapshot: ReadModelSnapshot,
  mode: UsageCostMode = "full",
): Promise<UsageCostSnapshot> {
  if (mode === "summary") {
    const [digests, subscriptionUsage] = await Promise.all([
      loadCachedUsageDigests(),
      loadCachedSubscriptionUsage({ includeCodexTelemetry: false }),
    ]);
    return computeUsageCostSnapshot(snapshot, digests, [], undefined, subscriptionUsage, new Map());
  }

  const [digests, modelCatalog, runtimeUsage, subscriptionUsage, cronJobNameMap] = await Promise.all([
    loadCachedUsageDigests(),
    loadCachedModelContextCatalog(),
    loadCachedRuntimeUsageData(),
    loadCachedSubscriptionUsage(),
    loadCachedOpenclawCronJobNameMap(),
  ]);
  return computeUsageCostSnapshot(snapshot, digests, modelCatalog, runtimeUsage, subscriptionUsage, cronJobNameMap);
}

export function computeUsageCostSnapshot(
  snapshot: ReadModelSnapshot,
  digests: UsageDigest[],
  modelCatalog: ModelContextCatalogEntry[],
  runtimeUsage?: RuntimeUsageData,
  subscriptionUsage?: UsageSubscriptionStatus,
  cronJobNameMap: Map<string, string> = new Map(),
): UsageCostSnapshot {
  const generatedAt = new Date().toISOString();
  const now = Date.now();
  const todayIso = new Date(now).toISOString().slice(0, 10);

  const sessionByKey = new Map(snapshot.sessions.map((session) => [session.sessionKey, session]));
  const sessionProjectMap = buildSessionProjectMap(snapshot);
  const runtime = resolveRuntimeUsage(runtimeUsage, sessionProjectMap);

  const periods = buildUsagePeriods(snapshot, digests, todayIso, runtime);
  const period30 = periods.find((item) => item.key === "30d");

  let runtimeContextRows = 0;
  const contextWindows = snapshot.statuses
    .map((status) => {
      const session = sessionByKey.get(status.sessionKey);
      const runtimeSession = runtime.sessionByKey.get(status.sessionKey);
      const agentId = session?.agentId ?? runtimeSession?.agentId ?? "Unassigned";
      const model = status.model?.trim() || runtimeSession?.model?.trim() || "Model not reported";
      const usedTokens = (status.tokensIn ?? 0) + (status.tokensOut ?? 0);
      const contextEntry = resolveContextCatalogEntry(modelCatalog, model);
      const contextLimitTokens = runtimeSession?.contextWindowTokens ?? contextEntry?.contextWindowTokens;
      const usagePercent =
        contextLimitTokens && contextLimitTokens > 0 ? (usedTokens / contextLimitTokens) * 100 : undefined;
      const thresholdState = resolveContextThresholdState(usagePercent);
      const paceLabel = resolveContextPaceLabel(usagePercent, status.updatedAt);
      if (runtimeSession?.contextWindowTokens && runtimeSession.contextWindowTokens > 0) runtimeContextRows += 1;
      return {
        sessionKey: status.sessionKey,
        sessionLabel: session?.label ?? status.sessionKey,
        agentId,
        sessionState: session?.state ?? "idle",
        model,
        provider: runtimeSession?.provider ?? contextEntry?.provider ?? inferProvider(model),
        usedTokens,
        contextLimitTokens,
        usagePercent,
        thresholdState,
        paceLabel,
        warningThresholds: formatContextThresholds(contextLimitTokens),
        dataStatus: contextLimitTokens ? "connected" : "not_connected",
      } satisfies SessionContextWindowSummary;
    })
    .sort((a, b) => {
      const rank = contextThresholdRank(a.thresholdState) - contextThresholdRank(b.thresholdState);
      if (rank !== 0) return rank;
      return b.usedTokens - a.usedTokens;
    });

  const runtimeEvents30d =
    runtime.sourceStatus === "not_connected" ? [] : runtimeEventsWithinWindow(runtime.events, todayIso, 30);
  const runtimeEventsToday =
    runtime.sourceStatus === "not_connected" ? [] : runtimeEventsWithinWindow(runtime.events, todayIso, 1);

  const byAgent =
    runtime.sourceStatus === "not_connected"
      ? aggregateBreakdownFromStatuses(snapshot.statuses, (status) => {
          const session = sessionByKey.get(status.sessionKey);
          return session?.agentId ?? "Unassigned";
        })
      : aggregateBreakdownFromRuntime(runtimeEvents30d, runtime.sourceStatus, (event) => event.agentId || "Unassigned");

  const byProject =
    runtime.sourceStatus === "not_connected"
      ? aggregateBreakdownFromStatuses(snapshot.statuses, (status) => {
          return sessionProjectMap.get(status.sessionKey) ?? "Unmapped project";
        })
      : aggregateBreakdownFromRuntime(
          runtimeEvents30d,
          runtime.sourceStatus,
          (event) => event.projectId ?? "Unmapped project",
        );

  const byModel =
    runtime.sourceStatus === "not_connected"
      ? aggregateBreakdownFromStatuses(snapshot.statuses, (status) => status.model?.trim() || "Model not reported")
      : aggregateBreakdownFromRuntime(
          runtimeEvents30d,
          runtime.sourceStatus,
          (event) => event.model?.trim() || "Model not reported",
        );
  const byTask = buildTaskBreakdownFromRuntime(snapshot, runtimeEvents30d, runtime.sourceStatus);

  const byProvider =
    runtime.sourceStatus === "not_connected"
      ? aggregateBreakdownFromStatuses(snapshot.statuses, (status) => inferProvider(status.model))
      : aggregateBreakdownFromRuntime(
          runtimeEvents30d,
          runtime.sourceStatus,
          (event) => event.provider?.trim() || inferProvider(event.model),
        );
  const bySessionType = buildSessionTypeBreakdownFromSessionContexts(
    runtimeUsage?.sessionContexts ?? [],
    runtime.sourceStatus,
  );
  const byCronJob = buildCronJobBreakdownFromSessionContexts(
    runtimeUsage?.sessionContexts ?? [],
    runtime.sourceStatus,
    cronJobNameMap,
  );
  const byCronAgent = buildCronAgentBreakdownFromSessionContexts(
    runtimeUsage?.sessionContexts ?? [],
    runtime.sourceStatus,
  );
  const byAgentToday =
    runtime.sourceStatus === "not_connected"
      ? aggregateBreakdownFromStatuses(snapshot.statuses, (status) => {
          const session = sessionByKey.get(status.sessionKey);
          return session?.agentId ?? "Unassigned";
        })
      : aggregateBreakdownFromRuntime(runtimeEventsToday, runtime.sourceStatus, (event) => event.agentId || "Unassigned");
  const byProjectToday =
    runtime.sourceStatus === "not_connected"
      ? aggregateBreakdownFromStatuses(snapshot.statuses, (status) => sessionProjectMap.get(status.sessionKey) ?? "Unmapped project")
      : aggregateBreakdownFromRuntime(runtimeEventsToday, runtime.sourceStatus, (event) => event.projectId ?? "Unmapped project");
  const byModelToday =
    runtime.sourceStatus === "not_connected"
      ? aggregateBreakdownFromStatuses(snapshot.statuses, (status) => status.model?.trim() || "Model not reported")
      : aggregateBreakdownFromRuntime(runtimeEventsToday, runtime.sourceStatus, (event) => event.model?.trim() || "Model not reported");
  const byTaskToday = buildTaskBreakdownFromRuntime(snapshot, runtimeEventsToday, runtime.sourceStatus);
  const byProviderToday =
    runtime.sourceStatus === "not_connected"
      ? aggregateBreakdownFromStatuses(snapshot.statuses, (status) => inferProvider(status.model))
      : aggregateBreakdownFromRuntime(
          runtimeEventsToday,
          runtime.sourceStatus,
          (event) => event.provider?.trim() || inferProvider(event.model),
        );
  const bySessionTypeToday = buildSessionTypeBreakdownFromRuntimeEvents(runtimeEventsToday, runtime.sourceStatus);
  const byCronJobToday = buildCronJobBreakdownFromRuntimeEvents(runtimeEventsToday, runtime.sourceStatus, cronJobNameMap);
  const byCronAgentToday = buildCronAgentBreakdownFromRuntimeEvents(runtimeEventsToday, runtime.sourceStatus);

  const budget = buildUsageBudgetStatus(snapshot, period30);
  const subscription = finalizeSubscriptionUsage(subscriptionUsage, period30, budget);

  const providerUnknownCount = byProvider.filter((item) => item.label === "Unknown provider").length;
  const connectorStatus = buildConnectorStatus({
    hasDigestHistory: digests.length > 0,
    hasRequestCounts: runtime.sourceStatus !== "not_connected",
    hasContextCatalog: modelCatalog.length > 0,
    hasRuntimeContext: runtimeContextRows > 0,
    hasProviderUnknown: providerUnknownCount > 0,
    hasBudgetLimit: budget.status !== "not_connected",
    hasSubscriptionConnected: subscription.status === "connected",
    hasSubscriptionSignal: subscription.status !== "not_connected",
    subscriptionConnectHint: subscription.connectHint,
    subscriptionDetail: subscription.detail,
    subscriptionReasonCode: subscription.reasonCode,
  });

  return {
    generatedAt,
    periods,
    contextWindows,
    breakdown: {
      byAgent,
      byProject,
      byTask,
      byModel,
      byProvider,
      bySessionType,
      byCronJob,
      byCronAgent,
    },
    breakdownToday: {
      byAgent: byAgentToday,
      byProject: byProjectToday,
      byTask: byTaskToday,
      byModel: byModelToday,
      byProvider: byProviderToday,
      bySessionType: bySessionTypeToday,
      byCronJob: byCronJobToday,
      byCronAgent: byCronAgentToday,
    },
    budget,
    subscription,
    connectors: connectorStatus,
  };
}

async function loadUsageDigests(): Promise<UsageDigest[]> {
  let files: string[] = [];
  try {
    files = await readdir(DIGEST_DIR);
  } catch {
    return [];
  }

  const jsonFiles = files.filter((name) => name.endsWith(".json")).sort((a, b) => b.localeCompare(a));
  const digests: UsageDigest[] = [];
  for (const fileName of jsonFiles) {
    try {
      const raw = JSON.parse(await readFile(join(DIGEST_DIR, fileName), "utf8")) as Record<string, unknown>;
      const date = asString(raw.date) ?? fileName.slice(0, -5);
      const usage = asObject(raw.usage);
      if (!usage) continue;
      digests.push({
        date,
        usage: {
          statuses: asNumber(usage.statuses),
          totalTokensIn: asNumber(usage.totalTokensIn),
          totalTokensOut: asNumber(usage.totalTokensOut),
          totalCost: asNumber(usage.totalCost),
        },
      });
    } catch {
      continue;
    }
  }

  return digests;
}

async function loadModelContextCatalog(): Promise<ModelContextCatalogEntry[]> {
  try {
    const raw = JSON.parse(await readFile(MODEL_CONTEXT_CATALOG_PATH, "utf8")) as Record<string, unknown>;
    const models = asArray(raw.models);
    const entries: ModelContextCatalogEntry[] = [];
    for (const entry of models) {
      const obj = asObject(entry);
      if (!obj) continue;
      const match = asString(obj.match);
      const contextWindowTokens = asPositiveNumber(obj.contextWindowTokens);
      const provider = asString(obj.provider);
      if (!match || contextWindowTokens === undefined) continue;
      entries.push({
        match: match.toLowerCase(),
        contextWindowTokens,
        provider: provider || undefined,
      });
    }
    return entries;
  } catch {
    return [];
  }
}

async function loadOpenclawCronJobNameMap(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const raw = JSON.parse(await readFile(OPENCLAW_CRON_JOBS_PATH, "utf8")) as unknown;
    const root = asObject(raw);
    const jobs = root && Array.isArray(root.jobs) ? root.jobs : [];
    for (const job of jobs) {
      const item = asObject(job);
      if (!item) continue;
      const id = asString(item.id)?.trim();
      if (!id) continue;
      const name = asString(item.name)?.trim() || id;
      out.set(id, name);
    }
  } catch {
    return out;
  }
  return out;
}

async function loadRuntimeUsageData(): Promise<RuntimeUsageData> {
  const out: RuntimeUsageData = {
    sourceStatus: "not_connected",
    sessionContexts: [],
    events: [],
  };

  let agentDirs: Array<{ name: string; path: string }> = [];
  try {
    const entries = await readdir(OPENCLAW_AGENTS_DIR, { withFileTypes: true });
    agentDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        path: join(OPENCLAW_AGENTS_DIR, entry.name),
      }));
  } catch {
    return out;
  }

  const lookbackLowerBoundMs = Date.now() - (RUNTIME_USAGE_LOOKBACK_DAYS - 1) * DAY_MS;
  const sessionById = new Map<string, RuntimeSessionContext>();
  let hasSessionStore = false;
  let hadParseError = false;

  const perAgentContexts = await mapWithConcurrency(agentDirs, RUNTIME_USAGE_SCAN_CONCURRENCY, async (agent) => {
    const sessionsDir = join(agent.path, "sessions");
    const contextResult = await loadRuntimeSessionContextsForAgent(agent.name, sessionsDir);
    return { agent, sessionsDir, contextResult };
  });

  for (const item of perAgentContexts) {
    hasSessionStore = hasSessionStore || item.contextResult.foundStore;
    hadParseError = hadParseError || item.contextResult.hadError;
    for (const context of item.contextResult.contexts) {
      out.sessionContexts.push(context);
      if (context.sessionId) sessionById.set(context.sessionId, context);
    }
  }

  const perAgentEvents = await mapWithConcurrency(perAgentContexts, RUNTIME_USAGE_SCAN_CONCURRENCY, async (item) => {
    const eventResult = await loadRuntimeUsageEventsForAgent(
      item.agent.name,
      item.sessionsDir,
      lookbackLowerBoundMs,
      sessionById,
    );
    return eventResult;
  });

  for (const eventResult of perAgentEvents) {
    hasSessionStore = hasSessionStore || eventResult.foundStore;
    hadParseError = hadParseError || eventResult.hadError;
    out.events.push(...eventResult.events);
  }

  if (!hasSessionStore) {
    out.sourceStatus = "not_connected";
  } else if (hadParseError) {
    out.sourceStatus = "partial";
  } else {
    out.sourceStatus = "connected";
  }

  return out;
}

async function loadRuntimeSessionContextsForAgent(
  agentId: string,
  sessionsDir: string,
): Promise<{ contexts: RuntimeSessionContext[]; foundStore: boolean; hadError: boolean }> {
  const contexts: RuntimeSessionContext[] = [];
  const sessionsIndexPath = join(sessionsDir, "sessions.json");

  try {
    const raw = JSON.parse(await readFile(sessionsIndexPath, "utf8")) as Record<string, unknown>;
    for (const [sessionKey, value] of Object.entries(raw)) {
      const obj = asObject(value);
      if (!obj || !sessionKey.trim()) continue;
      const meta = asObject(obj.meta);
      contexts.push({
        sessionKey,
        sessionId: asString(obj.sessionId),
        agentId,
        model: asString(obj.model),
        provider: asString(obj.modelProvider),
        contextWindowTokens: asPositiveNumber(obj.contextTokens),
        totalTokens: asNonNegativeNumber(obj.totalTokens),
        channel: asString(obj.channel) ?? asString(obj.lastChannel) ?? asString(meta?.channel) ?? asString(meta?.provider),
        surface: asString(meta?.surface),
      });
    }
    return {
      contexts,
      foundStore: true,
      hadError: false,
    };
  } catch (error) {
    if (isFsNotFound(error)) {
      return {
        contexts,
        foundStore: false,
        hadError: false,
      };
    }
    return {
      contexts,
      foundStore: true,
      hadError: true,
    };
  }
}

async function loadRuntimeUsageEventsForAgent(
  agentId: string,
  sessionsDir: string,
  lookbackLowerBoundMs: number,
  sessionById: Map<string, RuntimeSessionContext>,
): Promise<{ events: RuntimeUsageEvent[]; foundStore: boolean; hadError: boolean }> {
  const events: RuntimeUsageEvent[] = [];

  let fileNames: string[] = [];
  try {
    fileNames = await readdir(sessionsDir);
  } catch (error) {
    if (isFsNotFound(error)) {
      return {
        events,
        foundStore: false,
        hadError: false,
      };
    }
    return {
      events,
      foundStore: true,
      hadError: true,
    };
  }

  const sessionFiles = fileNames.filter((name) => name.endsWith(".jsonl"));
  if (sessionFiles.length === 0) {
    return {
      events,
      foundStore: fileNames.includes("sessions.json"),
      hadError: false,
    };
  }

  let hadError = false;

  const parsedFiles = await mapWithConcurrency(sessionFiles, RUNTIME_USAGE_SCAN_CONCURRENCY, async (fileName) => {
    const filePath = join(sessionsDir, fileName);
    try {
      const fileStat = await stat(filePath);
      if (fileStat.mtimeMs < lookbackLowerBoundMs) return { events: [] as RuntimeUsageEvent[], hadError: false };

      const raw = await readFile(filePath, "utf8");
      const lines = raw.replace(/\r/g, "").split("\n");
      let sessionId = fileName.slice(0, -".jsonl".length);
      const fileEvents: RuntimeUsageEvent[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (asString(parsed.type) === "session") {
          const parsedId = asString(parsed.id);
          if (parsedId) sessionId = parsedId;
          continue;
        }

        if (asString(parsed.type) !== "message") continue;
        const message = asObject(parsed.message);
        if (!message) continue;
        if (asString(message.role) !== "assistant") continue;
        const usage = asObject(message.usage);
        if (!usage) continue;

        const timestampRaw = asString(parsed.timestamp) ?? asString(message.timestamp);
        const timestampMs = timestampRaw ? Date.parse(timestampRaw) : NaN;
        if (!Number.isFinite(timestampMs) || timestampMs < lookbackLowerBoundMs) continue;

        const usageCost = asObject(usage.cost);
        const context = sessionById.get(sessionId);
        const model = asString(message.model) ?? context?.model;
        const provider = asString(message.provider) ?? context?.provider ?? inferProvider(model);

        const timestamp = new Date(timestampMs).toISOString();
        fileEvents.push({
          timestamp,
          day: timestamp.slice(0, 10),
          sessionId,
          sessionKey: context?.sessionKey,
          agentId: context?.agentId ?? agentId,
          model: model?.trim() || undefined,
          provider,
          tokens: pickUsageTokens(usage),
          cost: asNumber(usageCost?.total),
        });
      }

      return { events: fileEvents, hadError: false };
    } catch (error) {
      if (isFsNotFound(error)) return { events: [] as RuntimeUsageEvent[], hadError: false };
      return { events: [] as RuntimeUsageEvent[], hadError: true };
    }
  });

  for (const item of parsedFiles) {
    hadError = hadError || item.hadError;
    events.push(...item.events);
  }

  return {
    events,
    foundStore: true,
    hadError,
  };
}

function resolveRuntimeUsage(
  runtime: RuntimeUsageData | undefined,
  sessionProjectMap: Map<string, string>,
): RuntimeUsageResolved {
  if (!runtime) {
    return {
      sourceStatus: "not_connected",
      sessionByKey: new Map(),
      sessionById: new Map(),
      events: [],
    };
  }

  const sessionByKey = new Map<string, RuntimeSessionContext>();
  const sessionById = new Map<string, RuntimeSessionContext>();

  for (const item of runtime.sessionContexts) {
    if (!item.sessionKey.trim()) continue;
    sessionByKey.set(item.sessionKey, item);
    if (item.sessionId) sessionById.set(item.sessionId, item);
  }

  const events = runtime.events
    .map((event) => {
      const context = event.sessionKey
        ? sessionByKey.get(event.sessionKey)
        : event.sessionId
          ? sessionById.get(event.sessionId)
          : undefined;
      const sessionKey = event.sessionKey ?? context?.sessionKey;
      const model = event.model ?? context?.model;
      const provider = event.provider ?? context?.provider ?? inferProvider(model);

      return {
        timestamp: event.timestamp,
        day: event.day,
        sessionId: event.sessionId,
        sessionKey,
        agentId: event.agentId || context?.agentId || "Unassigned",
        projectId: event.projectId ?? (sessionKey ? sessionProjectMap.get(sessionKey) : undefined),
        model,
        provider,
        tokens: Math.max(0, event.tokens),
        cost: Math.max(0, event.cost),
      } satisfies RuntimeUsageEvent;
    })
    .filter((event) => {
      const timestampMs = Date.parse(event.timestamp);
      return Number.isFinite(timestampMs);
    });

  return {
    sourceStatus: runtime.sourceStatus,
    sessionByKey,
    sessionById,
    events,
  };
}

function buildUsagePeriods(
  snapshot: ReadModelSnapshot,
  digests: UsageDigest[],
  todayIso: string,
  runtime: RuntimeUsageResolved,
): UsagePeriodSummary[] {
  const windows: Array<{ key: "today" | "7d" | "30d"; days: number; label: string }> = [
    { key: "today", days: 1, label: "Today" },
    { key: "7d", days: 7, label: "Last 7 days" },
    { key: "30d", days: 30, label: "Last 30 days" },
  ];

  if (runtime.sourceStatus !== "not_connected") {
    const runtimeDailyCost = buildRuntimeDailyCostMap(runtime.events);

    return windows.map((window) => {
      const within = runtimeEventsWithinWindow(runtime.events, todayIso, window.days);
      const aggregate = aggregateRuntimeUsageWindow(within);
      const baseline = previousWindowAverageCostFromDailyMap(runtimeDailyCost, todayIso, window.days);
      const currentDailyAverage = aggregate.cost / Math.max(1, window.days);

      return {
        key: window.key,
        label: window.label,
        tokens: aggregate.tokens,
        estimatedCost: aggregate.cost,
        requestCount: aggregate.requests,
        requestCountStatus: runtime.sourceStatus,
        statusSamples: aggregate.requests,
        daysCovered: aggregate.daysCovered,
        pace: classifyPace(currentDailyAverage, baseline, true),
        sourceStatus: runtime.sourceStatus,
      };
    });
  }

  return windows.map((window) => {
    const within = digestsWithinWindow(digests, todayIso, window.days);
    const aggregate = within.reduce(
      (acc, item) => {
        acc.tokens += item.usage.totalTokensIn + item.usage.totalTokensOut;
        acc.cost += item.usage.totalCost;
        acc.statuses += item.usage.statuses;
        return acc;
      },
      { tokens: 0, cost: 0, statuses: 0 },
    );

    if (window.key === "today" && within.length === 0) {
      aggregate.tokens = snapshot.statuses.reduce(
        (sum, status) => sum + (status.tokensIn ?? 0) + (status.tokensOut ?? 0),
        0,
      );
      aggregate.cost = snapshot.statuses.reduce((sum, status) => sum + (status.cost ?? 0), 0);
      aggregate.statuses = snapshot.statuses.length;
    }

    const baseline = previousWindowAverageCost(digests, todayIso, window.days);
    const currentDailyAverage = aggregate.cost / Math.max(1, window.days);
    const sourceStatus =
      within.length > 0
        ? "connected"
        : window.key === "today" && snapshot.statuses.length > 0
          ? "partial"
          : "not_connected";

    return {
      key: window.key,
      label: window.label,
      tokens: aggregate.tokens,
      estimatedCost: aggregate.cost,
      requestCount: undefined,
      requestCountStatus: "not_connected",
      statusSamples: aggregate.statuses,
      daysCovered: within.length > 0 ? Math.min(window.days, within.length) : window.key === "today" ? 1 : 0,
      pace: classifyPace(currentDailyAverage, baseline, within.length > 0),
      sourceStatus,
    };
  });
}

function runtimeEventsWithinWindow(
  events: RuntimeUsageEvent[],
  todayIso: string,
  days: number,
): RuntimeUsageEvent[] {
  const todayMs = toDayMs(todayIso);
  if (!Number.isFinite(todayMs)) return [];
  const lowerBound = todayMs - (days - 1) * DAY_MS;

  return events.filter((event) => {
    const dayMs = toDayMs(event.day);
    return Number.isFinite(dayMs) && dayMs >= lowerBound && dayMs <= todayMs;
  });
}

function aggregateRuntimeUsageWindow(events: RuntimeUsageEvent[]): {
  tokens: number;
  cost: number;
  requests: number;
  daysCovered: number;
} {
  const days = new Set<string>();
  let tokens = 0;
  let cost = 0;

  for (const event of events) {
    days.add(event.day);
    tokens += event.tokens;
    cost += event.cost;
  }

  return {
    tokens,
    cost,
    requests: events.length,
    daysCovered: days.size,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

function buildRuntimeDailyCostMap(events: RuntimeUsageEvent[]): Map<string, number> {
  const byDay = new Map<string, number>();
  for (const event of events) {
    byDay.set(event.day, (byDay.get(event.day) ?? 0) + event.cost);
  }
  return byDay;
}

function previousWindowAverageCostFromDailyMap(
  dailyCostByDay: Map<string, number>,
  todayIso: string,
  days: number,
): number | undefined {
  const todayMs = toDayMs(todayIso);
  if (!Number.isFinite(todayMs)) return undefined;

  const currentLower = todayMs - (days - 1) * DAY_MS;
  const previousUpper = currentLower - DAY_MS;
  const previousLower = previousUpper - (days - 1) * DAY_MS;

  let hasBaselineSignal = false;
  let total = 0;

  for (let dayMs = previousLower; dayMs <= previousUpper; dayMs += DAY_MS) {
    const day = new Date(dayMs).toISOString().slice(0, 10);
    const value = dailyCostByDay.get(day);
    if (value !== undefined) {
      hasBaselineSignal = true;
      total += value;
    }
  }

  if (!hasBaselineSignal) return undefined;
  return total / Math.max(1, days);
}

function digestsWithinWindow(digests: UsageDigest[], todayIso: string, days: number): UsageDigest[] {
  const todayMs = toDayMs(todayIso);
  if (!Number.isFinite(todayMs)) return [];
  const lowerBound = todayMs - (days - 1) * DAY_MS;
  return digests.filter((digest) => {
    const dayMs = toDayMs(digest.date);
    return Number.isFinite(dayMs) && dayMs >= lowerBound && dayMs <= todayMs;
  });
}

function previousWindowAverageCost(digests: UsageDigest[], todayIso: string, days: number): number | undefined {
  const todayMs = toDayMs(todayIso);
  if (!Number.isFinite(todayMs)) return undefined;
  const currentLower = todayMs - (days - 1) * DAY_MS;
  const previousUpper = currentLower - DAY_MS;
  const previousLower = previousUpper - (days - 1) * DAY_MS;
  const previous = digests.filter((digest) => {
    const dayMs = toDayMs(digest.date);
    return Number.isFinite(dayMs) && dayMs >= previousLower && dayMs <= previousUpper;
  });
  if (previous.length === 0) return undefined;
  const total = previous.reduce((sum, digest) => sum + digest.usage.totalCost, 0);
  return total / Math.max(1, days);
}

function classifyPace(
  currentDailyAverage: number,
  baselineDailyAverage: number | undefined,
  baselineSourceAvailable: boolean,
): UsagePeriodSummary["pace"] {
  if (baselineDailyAverage === undefined || baselineDailyAverage <= 0) {
    return {
      label: baselineSourceAvailable
        ? "Need previous window data for trend baseline"
        : "Data source not connected for trend baseline",
      state: "unknown",
    };
  }

  const ratio = currentDailyAverage / baselineDailyAverage;
  if (ratio >= 1.2) {
    return { label: "Rising faster than baseline", state: "rising" };
  }
  if (ratio <= 0.8) {
    return { label: "Cooling versus baseline", state: "cooling" };
  }
  return { label: "Steady pace", state: "steady" };
}

function buildSessionProjectMap(snapshot: ReadModelSnapshot): Map<string, string> {
  const out = new Map<string, string>();
  for (const task of snapshot.tasks.tasks) {
    for (const sessionKey of task.sessionKeys) {
      if (!out.has(sessionKey)) out.set(sessionKey, task.projectId);
    }
  }
  return out;
}

function aggregateBreakdownFromStatuses(
  statuses: ReadModelSnapshot["statuses"],
  keySelector: (status: ReadModelSnapshot["statuses"][number]) => string,
): UsageBreakdownRow[] {
  const byKey = new Map<string, UsageBreakdownRow>();
  for (const status of statuses) {
    const key = keySelector(status).trim() || "Unknown";
    const current = byKey.get(key) ?? {
      key,
      label: key,
      tokens: 0,
      estimatedCost: 0,
      requests: 0,
      sessions: 0,
      sourceStatus: "connected",
    };
    current.tokens += (status.tokensIn ?? 0) + (status.tokensOut ?? 0);
    current.estimatedCost += status.cost ?? 0;
    current.sessions += 1;
    byKey.set(key, current);
  }

  return [...byKey.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 12);
}

function aggregateBreakdownFromRuntime(
  events: RuntimeUsageEvent[],
  sourceStatus: ConnectionStatus,
  keySelector: (event: RuntimeUsageEvent) => string,
): UsageBreakdownRow[] {
  const buckets = new Map<
    string,
    {
      row: UsageBreakdownRow;
      sessions: Set<string>;
    }
  >();

  for (const event of events) {
    const key = keySelector(event).trim() || "Unknown";
    const bucket =
      buckets.get(key) ??
      {
        row: {
          key,
          label: key,
          tokens: 0,
          estimatedCost: 0,
          requests: 0,
          sessions: 0,
          sourceStatus,
        },
        sessions: new Set<string>(),
      };

    bucket.row.tokens += event.tokens;
    bucket.row.estimatedCost += event.cost;
    bucket.row.requests += 1;
    bucket.sessions.add(event.sessionKey ?? event.sessionId);
    bucket.row.sessions = bucket.sessions.size;

    buckets.set(key, bucket);
  }

  return [...buckets.values()]
    .map((item) => item.row)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 12);
}

function buildSessionTypeBreakdownFromSessionContexts(
  contexts: RuntimeSessionContext[],
  sourceStatus: ConnectionStatus,
): UsageBreakdownRow[] {
  if (sourceStatus === "not_connected" || contexts.length === 0) return [];
  const uniqueSessions = dedupeSessionContexts(contexts);
  if (uniqueSessions.length === 0) return [];

  const order = ["Cron", "Discord", "Telegram", "Main/内部会话"] as const;
  const buckets = new Map<string, UsageBreakdownRow>(
    order.map((label) => [
      label,
      {
        key: label.toLowerCase(),
        label,
        tokens: 0,
        estimatedCost: 0,
        requests: 0,
        sessions: 0,
        sourceStatus,
      },
    ]),
  );

  for (const session of uniqueSessions) {
    if (!Number.isFinite(session.totalTokens) || (session.totalTokens as number) <= 0) continue;
    const label = classifySessionTypeLabel(session);
    const bucket = buckets.get(label);
    if (!bucket) continue;
    bucket.tokens += session.totalTokens as number;
    bucket.sessions += 1;
  }

  return order
    .map((label) => buckets.get(label))
    .filter((row): row is UsageBreakdownRow => Boolean(row) && (row?.tokens ?? 0) > 0);
}

function buildSessionTypeBreakdownFromRuntimeEvents(
  events: RuntimeUsageEvent[],
  sourceStatus: ConnectionStatus,
): UsageBreakdownRow[] {
  if (sourceStatus === "not_connected" || events.length === 0) return [];
  const order = ["Cron", "Discord", "Telegram", "Main/内部会话"] as const;
  const buckets = new Map<string, UsageBreakdownRow>(
    order.map((label) => [
      label,
      {
        key: label.toLowerCase(),
        label,
        tokens: 0,
        estimatedCost: 0,
        requests: 0,
        sessions: 0,
        sourceStatus,
      },
    ]),
  );
  const seenSessionsByLabel = new Map<string, Set<string>>();

  for (const event of events) {
    const label = classifySessionTypeFromSessionKey(event.sessionKey);
    const bucket = buckets.get(label);
    if (!bucket) continue;
    bucket.tokens += event.tokens;
    bucket.estimatedCost += event.cost;
    bucket.requests += 1;
    const seen = seenSessionsByLabel.get(label) ?? new Set<string>();
    seen.add(event.sessionKey ?? event.sessionId);
    seenSessionsByLabel.set(label, seen);
    bucket.sessions = seen.size;
  }

  return order
    .map((label) => buckets.get(label))
    .filter((row): row is UsageBreakdownRow => Boolean(row) && (row?.tokens ?? 0) > 0);
}

function buildCronJobBreakdownFromSessionContexts(
  contexts: RuntimeSessionContext[],
  sourceStatus: ConnectionStatus,
  cronJobNameMap: Map<string, string>,
): UsageBreakdownRow[] {
  if (sourceStatus === "not_connected" || contexts.length === 0) return [];
  const uniqueSessions = dedupeSessionContexts(contexts);
  if (uniqueSessions.length === 0) return [];

  const buckets = new Map<string, UsageBreakdownRow>();
  for (const session of uniqueSessions) {
    if (!Number.isFinite(session.totalTokens) || (session.totalTokens as number) <= 0) continue;
    if (classifySessionTypeLabel(session) !== "Cron") continue;
    const jobId = parseCronJobIdFromSessionKey(session.sessionKey);
    const key = jobId ?? "unknown";
    const jobName = jobId ? cronJobNameMap.get(jobId) ?? jobId : "未识别 Cron 任务";
    const label = jobId ? `${jobName} (${jobId})` : "未识别 Cron 任务";
    const current =
      buckets.get(key) ??
      {
        key,
        label,
        tokens: 0,
        estimatedCost: 0,
        requests: 0,
        sessions: 0,
        sourceStatus,
      };
    current.tokens += session.totalTokens as number;
    current.sessions += 1;
    buckets.set(key, current);
  }

  return [...buckets.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 24);
}

function buildCronJobBreakdownFromRuntimeEvents(
  events: RuntimeUsageEvent[],
  sourceStatus: ConnectionStatus,
  cronJobNameMap: Map<string, string>,
): UsageBreakdownRow[] {
  if (sourceStatus === "not_connected" || events.length === 0) return [];
  const buckets = new Map<string, UsageBreakdownRow>();
  const seenSessionsByKey = new Map<string, Set<string>>();

  for (const event of events) {
    if (classifySessionTypeFromSessionKey(event.sessionKey) !== "Cron") continue;
    const jobId = parseCronJobIdFromSessionKey(event.sessionKey ?? "");
    const key = jobId ?? "unknown";
    const jobName = jobId ? cronJobNameMap.get(jobId) ?? jobId : "未识别 Cron 任务";
    const label = jobId ? `${jobName} (${jobId})` : "未识别 Cron 任务";
    const bucket =
      buckets.get(key) ??
      {
        key,
        label,
        tokens: 0,
        estimatedCost: 0,
        requests: 0,
        sessions: 0,
        sourceStatus,
      };
    bucket.tokens += event.tokens;
    bucket.estimatedCost += event.cost;
    bucket.requests += 1;
    const seen = seenSessionsByKey.get(key) ?? new Set<string>();
    seen.add(event.sessionKey ?? event.sessionId);
    seenSessionsByKey.set(key, seen);
    bucket.sessions = seen.size;
    buckets.set(key, bucket);
  }

  return [...buckets.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 24);
}

function buildCronAgentBreakdownFromSessionContexts(
  contexts: RuntimeSessionContext[],
  sourceStatus: ConnectionStatus,
): UsageBreakdownRow[] {
  if (sourceStatus === "not_connected" || contexts.length === 0) return [];
  const uniqueSessions = dedupeSessionContexts(contexts);
  if (uniqueSessions.length === 0) return [];

  const buckets = new Map<string, UsageBreakdownRow>();
  for (const session of uniqueSessions) {
    if (!Number.isFinite(session.totalTokens) || (session.totalTokens as number) <= 0) continue;
    if (classifySessionTypeLabel(session) !== "Cron") continue;
    const agentId = session.agentId?.trim() || "unknown";
    const current =
      buckets.get(agentId) ??
      {
        key: agentId,
        label: agentId,
        tokens: 0,
        estimatedCost: 0,
        requests: 0,
        sessions: 0,
        sourceStatus,
      };
    current.tokens += session.totalTokens as number;
    current.sessions += 1;
    buckets.set(agentId, current);
  }

  return [...buckets.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 24);
}

function buildCronAgentBreakdownFromRuntimeEvents(
  events: RuntimeUsageEvent[],
  sourceStatus: ConnectionStatus,
): UsageBreakdownRow[] {
  if (sourceStatus === "not_connected" || events.length === 0) return [];
  const buckets = new Map<string, UsageBreakdownRow>();
  const seenSessionsByAgent = new Map<string, Set<string>>();

  for (const event of events) {
    if (classifySessionTypeFromSessionKey(event.sessionKey) !== "Cron") continue;
    const agentId = event.agentId?.trim() || "unknown";
    const bucket =
      buckets.get(agentId) ??
      {
        key: agentId,
        label: agentId,
        tokens: 0,
        estimatedCost: 0,
        requests: 0,
        sessions: 0,
        sourceStatus,
      };
    bucket.tokens += event.tokens;
    bucket.estimatedCost += event.cost;
    bucket.requests += 1;
    const seen = seenSessionsByAgent.get(agentId) ?? new Set<string>();
    seen.add(event.sessionKey ?? event.sessionId);
    seenSessionsByAgent.set(agentId, seen);
    bucket.sessions = seen.size;
    buckets.set(agentId, bucket);
  }

  return [...buckets.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 24);
}

function dedupeSessionContexts(contexts: RuntimeSessionContext[]): RuntimeSessionContext[] {
  const byIdentity = new Map<string, RuntimeSessionContext>();
  for (const context of contexts) {
    const sessionKey = context.sessionKey.trim();
    if (!sessionKey) continue;
    const identity = context.sessionId?.trim() || sessionKey;
    const previous = byIdentity.get(identity);
    if (!previous) {
      byIdentity.set(identity, context);
      continue;
    }

    const previousTokens = previous.totalTokens ?? -1;
    const currentTokens = context.totalTokens ?? -1;
    if (currentTokens > previousTokens) {
      byIdentity.set(identity, context);
    }
  }
  return [...byIdentity.values()];
}

function classifySessionTypeLabel(context: RuntimeSessionContext): "Cron" | "Discord" | "Telegram" | "Main/内部会话" {
  const key = context.sessionKey.trim().toLowerCase();
  const channel = context.channel?.trim().toLowerCase() ?? "";
  const surface = context.surface?.trim().toLowerCase() ?? "";

  if (key.includes(":cron:") || key.startsWith("cron:") || channel === "cron" || surface === "cron") {
    return "Cron";
  }
  if (
    key.includes(":discord:") ||
    key.startsWith("discord:") ||
    channel.includes("discord") ||
    surface.includes("discord")
  ) {
    return "Discord";
  }
  if (
    key.includes(":telegram:") ||
    key.startsWith("telegram:") ||
    channel.includes("telegram") ||
    surface.includes("telegram")
  ) {
    return "Telegram";
  }
  return "Main/内部会话";
}

function classifySessionTypeFromSessionKey(sessionKey: string | undefined): "Cron" | "Discord" | "Telegram" | "Main/内部会话" {
  const key = sessionKey?.trim().toLowerCase() ?? "";
  if (!key) return "Main/内部会话";
  if (key.includes(":cron:") || key.startsWith("cron:")) return "Cron";
  if (key.includes(":discord:") || key.startsWith("discord:")) return "Discord";
  if (key.includes(":telegram:") || key.startsWith("telegram:")) return "Telegram";
  return "Main/内部会话";
}

function parseCronJobIdFromSessionKey(sessionKey: string): string | undefined {
  const parts = sessionKey.split(":").map((item) => item.trim()).filter((item) => item.length > 0);
  const cronIndex = parts.findIndex((item) => item.toLowerCase() === "cron");
  if (cronIndex < 0) return undefined;
  const jobId = parts[cronIndex + 1];
  return jobId && jobId.trim() ? jobId.trim() : undefined;
}

function buildTaskBreakdownFromRuntime(
  snapshot: ReadModelSnapshot,
  events: RuntimeUsageEvent[],
  sourceStatus: ConnectionStatus,
): UsageBreakdownRow[] {
  if (sourceStatus === "not_connected" || events.length === 0) return [];

  const tasks = snapshot.tasks.tasks;
  if (tasks.length === 0) return [];

  const taskKeyToMeta = new Map<
    string,
    {
      projectId: string;
      taskId: string;
      owner: string;
      status: string;
    }
  >();
  const sessionKeyToTaskKeys = new Map<string, string[]>();
  const ownerToActiveTaskKeys = new Map<string, string[]>();

  for (const task of tasks) {
    const taskKey = `${task.projectId}::${task.taskId}`;
    taskKeyToMeta.set(taskKey, {
      projectId: task.projectId,
      taskId: task.taskId,
      owner: task.owner,
      status: task.status,
    });
    for (const sessionKey of task.sessionKeys) {
      const current = sessionKeyToTaskKeys.get(sessionKey) ?? [];
      current.push(taskKey);
      sessionKeyToTaskKeys.set(sessionKey, current);
    }
    if (task.status !== "done") {
      const ownerKey = normalizeOwnerKey(task.owner);
      if (ownerKey) {
        const current = ownerToActiveTaskKeys.get(ownerKey) ?? [];
        current.push(taskKey);
        ownerToActiveTaskKeys.set(ownerKey, current);
      }
    }
  }
  const activeTaskKeys = tasks
    .filter((task) => task.status !== "done")
    .map((task) => `${task.projectId}::${task.taskId}`);

  const buckets = new Map<
    string,
    {
      row: UsageBreakdownRow;
      sessions: Set<string>;
    }
  >();

  const assignEventToTask = (
    taskKey: string,
    event: RuntimeUsageEvent,
    weight: number,
    methodLabel: "session" | "owner" | "estimate",
  ): void => {
    const meta = taskKeyToMeta.get(taskKey);
    if (!meta) return;
    const bucket =
      buckets.get(taskKey) ??
      {
        row: {
          key: taskKey,
          label: `${meta.projectId}/${meta.taskId} · ${meta.owner} · ${methodLabel}`,
          tokens: 0,
          estimatedCost: 0,
          requests: 0,
          sessions: 0,
          sourceStatus,
        },
        sessions: new Set<string>(),
      };
    bucket.row.tokens += event.tokens * weight;
    bucket.row.estimatedCost += event.cost * weight;
    bucket.row.requests += 1 * weight;
    bucket.sessions.add(event.sessionKey ?? event.sessionId);
    bucket.row.sessions = bucket.sessions.size;
    buckets.set(taskKey, bucket);
  };

  const unmappedKey = "__unmapped_task__";
  for (const event of events) {
    const fromSession = event.sessionKey ? sessionKeyToTaskKeys.get(event.sessionKey) : undefined;
    if (fromSession && fromSession.length > 0) {
      const weight = 1 / fromSession.length;
      for (const taskKey of fromSession) assignEventToTask(taskKey, event, weight, "session");
      continue;
    }

    const ownerKey = normalizeOwnerKey(event.agentId);
    const ownerTasks = ownerKey ? ownerToActiveTaskKeys.get(ownerKey) : undefined;
    if (ownerTasks && ownerTasks.length > 0) {
      const weight = 1 / ownerTasks.length;
      for (const taskKey of ownerTasks) assignEventToTask(taskKey, event, weight, "owner");
      continue;
    }

    if (activeTaskKeys.length > 0) {
      const weight = 1 / activeTaskKeys.length;
      for (const taskKey of activeTaskKeys) assignEventToTask(taskKey, event, weight, "estimate");
      continue;
    }

    const bucket =
      buckets.get(unmappedKey) ??
      {
        row: {
          key: unmappedKey,
          label: "未映射任务（需绑定 sessionKeys 或负责人）",
          tokens: 0,
          estimatedCost: 0,
          requests: 0,
          sessions: 0,
          sourceStatus,
        },
        sessions: new Set<string>(),
      };
    bucket.row.tokens += event.tokens;
    bucket.row.estimatedCost += event.cost;
    bucket.row.requests += 1;
    bucket.sessions.add(event.sessionKey ?? event.sessionId);
    bucket.row.sessions = bucket.sessions.size;
    buckets.set(unmappedKey, bucket);
  }

  return [...buckets.values()]
    .map((item) => ({
      ...item.row,
      tokens: Math.round(item.row.tokens),
      requests: Math.round(item.row.requests),
    }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 20);
}

function normalizeOwnerKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "unassigned" || normalized === "none") return undefined;
  return normalized;
}

function resolveContextCatalogEntry(
  catalog: ModelContextCatalogEntry[],
  model: string,
): ModelContextCatalogEntry | undefined {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return undefined;
  return catalog.find((entry) => normalized.includes(entry.match));
}

function resolveContextThresholdState(
  usagePercent: number | undefined,
): SessionContextWindowSummary["thresholdState"] {
  if (usagePercent === undefined) return "not_connected";
  if (usagePercent >= CONTEXT_CRITICAL_RATIO * 100) return "critical";
  if (usagePercent >= CONTEXT_WARN_RATIO * 100) return "warn";
  return "ok";
}

function resolveContextPaceLabel(usagePercent: number | undefined, updatedAt: string): string {
  if (usagePercent === undefined) return "Data source not connected";
  const ageMinutes = ageInMinutes(updatedAt);
  if (usagePercent >= CONTEXT_CRITICAL_RATIO * 100) return ageMinutes <= 20 ? "Fast burn" : "High load";
  if (usagePercent >= CONTEXT_WARN_RATIO * 100) return ageMinutes <= 20 ? "Rising" : "Watch closely";
  return ageMinutes <= 20 ? "Steady" : "Cooling";
}

function formatContextThresholds(contextLimitTokens: number | undefined): string {
  if (!contextLimitTokens || contextLimitTokens <= 0) {
    return "Warn at 70%, critical at 90%";
  }

  const warnTokens = Math.round(contextLimitTokens * CONTEXT_WARN_RATIO);
  const criticalTokens = Math.round(contextLimitTokens * CONTEXT_CRITICAL_RATIO);
  return `Warn ${formatNumber(warnTokens)} (${Math.round(CONTEXT_WARN_RATIO * 100)}%), critical ${formatNumber(
    criticalTokens,
  )} (${Math.round(CONTEXT_CRITICAL_RATIO * 100)}%)`;
}

function buildUsageBudgetStatus(
  snapshot: ReadModelSnapshot,
  period30: UsagePeriodSummary | undefined,
): UsageBudgetStatus {
  const usedCost30d = period30?.estimatedCost ?? 0;
  const agentCostLimits = snapshot.budgetSummary.evaluations
    .filter((item) => item.scope === "agent")
    .map((item) => pickCostLimit(item))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);

  if (agentCostLimits.length === 0) {
    return {
      status: "not_connected",
      usedCost30d,
      message: "Data source not connected: no cost budget limit configured.",
    };
  }

  const limitCost30d = agentCostLimits.reduce((sum, value) => sum + value, 0);
  const ratio = limitCost30d > 0 ? usedCost30d / limitCost30d : 0;
  const burnRatePerDay =
    period30 && period30.sourceStatus !== "not_connected"
      ? usedCost30d / Math.max(1, period30.daysCovered || 1)
      : undefined;
  const projectedDaysToLimit =
    burnRatePerDay && burnRatePerDay > 0 ? (limitCost30d - usedCost30d) / burnRatePerDay : undefined;

  if (ratio >= 1) {
    return {
      status: "over",
      usedCost30d,
      limitCost30d,
      burnRatePerDay,
      projectedDaysToLimit,
      message: "Burn rate exceeded monthly budget.",
    };
  }
  if (ratio >= BUDGET_WARN_RATIO) {
    return {
      status: "warn",
      usedCost30d,
      limitCost30d,
      burnRatePerDay,
      projectedDaysToLimit,
      message: "Burn rate is approaching the monthly budget.",
    };
  }
  return {
    status: "ok",
    usedCost30d,
    limitCost30d,
    burnRatePerDay,
    projectedDaysToLimit,
    message: "Burn rate is within monthly budget.",
  };
}

function pickCostLimit(item: ReadModelSnapshot["budgetSummary"]["evaluations"][number]): number | undefined {
  const fromMetric = item.metrics.find((metric) => metric.metric === "cost")?.limit;
  if (Number.isFinite(fromMetric)) return fromMetric;
  if (Number.isFinite(item.thresholds.cost)) return item.thresholds.cost;
  return undefined;
}

function buildConnectorStatus(input: {
  hasDigestHistory: boolean;
  hasRequestCounts: boolean;
  hasContextCatalog: boolean;
  hasRuntimeContext: boolean;
  hasProviderUnknown: boolean;
  hasBudgetLimit: boolean;
  hasSubscriptionConnected: boolean;
  hasSubscriptionSignal: boolean;
  subscriptionConnectHint: string;
  subscriptionDetail: string;
  subscriptionReasonCode?: SubscriptionReasonCode;
}): UsageConnectorStatus {
  const todos: UsageConnectorTodo[] = [];

  if (!input.hasContextCatalog && !input.hasRuntimeContext) {
    todos.push({
      id: "context_catalog",
      title: "Connect model context catalog",
      detail:
        "Create runtime/model-context-catalog.json with {match, contextWindowTokens, provider} entries to enable context percentages.",
    });
  }
  if (!input.hasDigestHistory && !input.hasRequestCounts) {
    todos.push({
      id: "digest_history",
      title: "Connect digest history",
      detail: "Run monitor continuously so runtime/digests/*.json can power 7d/30d trend and burn-rate analytics.",
    });
  }
  if (!input.hasRequestCounts) {
    todos.push({
      id: "request_counter",
      title: "Connect request counter source",
      detail:
        "Enable OpenClaw session runtime stores so Usage & Cost can read real request counts from assistant usage logs.",
    });
  }
  if (!input.hasBudgetLimit) {
    todos.push({
      id: "cost_budget_limit",
      title: "Connect subscription/API cost limit",
      detail: "Add cost thresholds to agent budgets so burn-rate alerts can compare against a real monthly limit.",
    });
  }
  if (input.hasProviderUnknown) {
    todos.push({
      id: "provider_mapping",
      title: "Refine provider attribution",
      detail: "Some models map to 'Unknown provider'; add provider hints to model context catalog for exact breakdown.",
    });
  }
  if (!input.hasSubscriptionSignal) {
    todos.push({
      id: "subscription_usage",
      title: "Connect subscription usage snapshot",
      detail: [input.subscriptionDetail, input.subscriptionConnectHint].filter((item) => item.trim()).join(" "),
    });
  } else if (!input.hasSubscriptionConnected) {
    todos.push({
      id: "subscription_usage",
      title: subscriptionTodoTitle(input.subscriptionReasonCode),
      detail: subscriptionTodoDetail(input.subscriptionReasonCode, input.subscriptionDetail, input.subscriptionConnectHint),
    });
  }

  return {
    modelContextCatalog: input.hasContextCatalog ? "connected" : input.hasRuntimeContext ? "partial" : "not_connected",
    digestHistory: input.hasDigestHistory ? "connected" : input.hasRequestCounts ? "partial" : "not_connected",
    requestCounts: input.hasRequestCounts ? "connected" : "not_connected",
    budgetLimit: input.hasBudgetLimit ? "connected" : "not_connected",
    providerAttribution: input.hasProviderUnknown ? "partial" : "connected",
    subscriptionUsage: input.hasSubscriptionConnected
      ? "connected"
      : input.hasSubscriptionSignal
        ? "partial"
        : "not_connected",
    todos,
  };
}

function subscriptionTodoTitle(reasonCode: SubscriptionReasonCode | undefined): string {
  if (reasonCode === "provider_snapshot_unreadable") return "Fix unreadable subscription snapshot";
  if (reasonCode === "runtime_backfill_only") return "Connect provider subscription snapshot";
  if (reasonCode === "provider_snapshot_missing") return "Connect subscription usage snapshot";
  return "Complete subscription usage fields";
}

function subscriptionTodoDetail(
  reasonCode: SubscriptionReasonCode | undefined,
  detail: string,
  connectHint: string,
): string {
  const normalizedDetail = detail.trim();
  if (normalizedDetail) return normalizedDetail;
  if (reasonCode === "provider_snapshot_missing") return connectHint;
  return "Subscription usage fields are incomplete.";
}

async function loadSubscriptionUsage(options: { includeCodexTelemetry?: boolean } = {}): Promise<UsageSubscriptionStatus> {
  const includeCodexTelemetry = options.includeCodexTelemetry !== false;
  const connectHint = subscriptionConnectHint();
  let partial: UsageSubscriptionStatus | undefined;
  const missingPaths: string[] = [];
  const unreadablePaths: string[] = [];

  for (const path of SUBSCRIPTION_SNAPSHOT_PATHS) {
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
      const parsed = parseSubscriptionUsage(raw, path, connectHint);
      if (parsed.status === "connected") return parsed;
      partial = partial ?? parsed;
    } catch (error) {
      if (isFsNotFound(error)) {
        missingPaths.push(path);
        continue;
      }
      unreadablePaths.push(`${path}${readErrorCode(error) ? ` (${readErrorCode(error)})` : ""}`);
    }
  }

  const codexWhamUsage = includeCodexTelemetry ? await loadCodexWhamUsage(connectHint) : undefined;
  if (codexWhamUsage?.status === "connected") return codexWhamUsage;

  const codexRateLimitUsage = includeCodexTelemetry ? await loadCodexRateLimitUsage(connectHint) : undefined;
  if (codexRateLimitUsage?.status === "connected") return codexRateLimitUsage;

  if (partial) return partial;
  if (codexWhamUsage) return codexWhamUsage;
  if (codexRateLimitUsage) return codexRateLimitUsage;
  if (unreadablePaths.length > 0) {
    const missingSegment =
      missingPaths.length > 0 ? ` Missing path(s): ${missingPaths.join(", ")}.` : "";
    return {
      status: "partial",
      planLabel: "Subscription data unreadable",
      unit: "USD",
      detail: `Subscription snapshot path(s) could not be parsed: ${unreadablePaths.join(", ")}.${missingSegment}`,
      sourcePath: unreadablePaths.join("; "),
      connectHint,
      reasonCode: "provider_snapshot_unreadable",
    };
  }
  return defaultSubscriptionUsage(missingPaths);
}

function finalizeSubscriptionUsage(
  subscriptionUsage: UsageSubscriptionStatus | undefined,
  period30: UsagePeriodSummary | undefined,
  budget: UsageBudgetStatus | undefined,
): UsageSubscriptionStatus {
  const runtimeConsumedAvailable =
    period30 !== undefined &&
    period30.sourceStatus !== "not_connected" &&
    Number.isFinite(period30.estimatedCost);
  const runtimeConsumed = runtimeConsumedAvailable ? Math.max(0, period30.estimatedCost) : undefined;
  const providerConnectHint = subscriptionConnectHint();
  const budgetLimit =
    budget && typeof budget.limitCost30d === "number" && Number.isFinite(budget.limitCost30d) && budget.limitCost30d > 0
      ? budget.limitCost30d
      : undefined;
  const todayIso = new Date().toISOString().slice(0, 10);
  const cycleStartIso = new Date(Date.now() - 29 * DAY_MS).toISOString().slice(0, 10);

  if (!subscriptionUsage || subscriptionUsage.status === "not_connected") {
    if (runtimeConsumed === undefined) return subscriptionUsage ?? defaultSubscriptionUsage();
    if (budgetLimit !== undefined) {
      const remaining = Math.max(0, budgetLimit - runtimeConsumed);
      return {
        status: "not_connected",
        planLabel: "Estimated budget envelope",
        consumed: runtimeConsumed,
        remaining,
        limit: budgetLimit,
        usagePercent: budgetLimit > 0 ? (runtimeConsumed / budgetLimit) * 100 : undefined,
        unit: subscriptionUsage?.unit ?? "USD",
        cycleStart: cycleStartIso,
        cycleEnd: todayIso,
        sourcePath:
          `${RUNTIME_USAGE_EVENTS_CONNECTOR_PATH} (usage events); ` +
          `${RUNTIME_SESSION_INDEX_CONNECTOR_PATH} (session index); ` +
          `${SUBSCRIPTION_BUDGET_FALLBACK_SOURCE}`,
        detail:
          `Consumed is derived from runtime usage (${period30?.label ?? "Last 30 days"}). ` +
          `Remaining/limit are derived from configured 30d cost budget in snapshot budgetSummary because provider snapshot is unavailable.`,
        connectHint: providerConnectHint,
        reasonCode: "runtime_backfill_with_budget_limit",
      };
    }
    return {
      status: "not_connected",
      planLabel: "Provider subscription not connected",
      consumed: runtimeConsumed,
      unit: subscriptionUsage?.unit ?? "USD",
      cycleStart: cycleStartIso,
      cycleEnd: todayIso,
      sourcePath: `${RUNTIME_USAGE_EVENTS_CONNECTOR_PATH} (usage events); ${RUNTIME_SESSION_INDEX_CONNECTOR_PATH} (session index)`,
      detail:
        `Consumed is derived from runtime usage (${period30?.label ?? "Last 30 days"}). ` +
        `Provider remaining/limit cannot be derived because no provider snapshot was found at: ` +
        `${SUBSCRIPTION_SNAPSHOT_PATHS.join(", ")}.`,
      connectHint: providerConnectHint,
      reasonCode: "runtime_backfill_only",
    };
  }

  const consumed = subscriptionUsage.consumed ?? runtimeConsumed;
  const limit = subscriptionUsage.limit;
  const remaining =
    subscriptionUsage.remaining ??
    (typeof consumed === "number" && typeof limit === "number" ? Math.max(0, limit - consumed) : undefined);
  const missingProviderFields = [
    typeof consumed === "number" ? "" : "consumed",
    typeof remaining === "number" ? "" : "remaining",
    typeof limit === "number" ? "" : "limit",
  ].filter((field) => field !== "");
  const providerConnected =
    subscriptionUsage.reasonCode === "provider_connected" &&
    subscriptionUsage.status === "connected" &&
    missingProviderFields.length === 0;

  if (providerConnected) return subscriptionUsage;

  const strictLimit = subscriptionUsage.limit ?? budgetLimit;
  const strictRemaining =
    subscriptionUsage.remaining ??
    (typeof consumed === "number" && typeof strictLimit === "number" ? Math.max(0, strictLimit - consumed) : undefined);
  const usagePercent =
    typeof consumed === "number" && typeof strictLimit === "number" && strictLimit > 0
      ? (consumed / strictLimit) * 100
      : undefined;
  const usedBudgetFallbackForLimit = subscriptionUsage.limit === undefined && budgetLimit !== undefined;
  const sourcePath = [
    subscriptionUsage.sourcePath,
    runtimeConsumed !== undefined
      ? `${RUNTIME_USAGE_EVENTS_CONNECTOR_PATH} (usage events); ${RUNTIME_SESSION_INDEX_CONNECTOR_PATH} (session index)`
      : "",
    usedBudgetFallbackForLimit ? SUBSCRIPTION_BUDGET_FALLBACK_SOURCE : "",
  ]
    .filter((item) => typeof item === "string" && item.trim().length > 0)
    .join("; ");
  const missingFields = [
    typeof consumed === "number" ? "" : "consumed",
    typeof strictRemaining === "number" ? "" : "remaining",
    typeof strictLimit === "number" ? "" : "limit",
  ].filter((field) => field !== "");
  const detail = [
    subscriptionUsage.detail,
    runtimeConsumed !== undefined && subscriptionUsage.consumed === undefined
      ? `Consumed is backfilled from runtime usage events at ${RUNTIME_USAGE_EVENTS_CONNECTOR_PATH}.`
      : "",
    usedBudgetFallbackForLimit
      ? `Limit/remaining are estimated from configured 30d cost budget in snapshot budgetSummary (${formatNumber(
          budgetLimit ?? 0,
        )} ${subscriptionUsage.unit}).`
      : "",
    missingFields.length > 0
      ? `Provider field(s) unavailable: ${missingFields.join(", ")}.`
      : "",
    "Strict mode keeps subscription status as not_connected until a real provider snapshot is complete.",
  ]
    .filter((item) => item.trim().length > 0)
    .join(" ");
  const reasonCode: SubscriptionReasonCode =
    subscriptionUsage.reasonCode === "provider_snapshot_unreadable"
      ? "provider_snapshot_unreadable"
      : subscriptionUsage.reasonCode === "provider_snapshot_missing"
        ? "provider_snapshot_missing"
        : usedBudgetFallbackForLimit
          ? "runtime_backfill_with_budget_limit"
          : runtimeConsumed !== undefined
            ? "runtime_backfill_with_provider_partial"
            : subscriptionUsage.reasonCode && subscriptionUsage.reasonCode !== "provider_connected"
              ? subscriptionUsage.reasonCode
              : "provider_snapshot_partial";

  return {
    ...subscriptionUsage,
    status: "not_connected",
    consumed,
    remaining: strictRemaining,
    limit: strictLimit,
    usagePercent,
    cycleStart: subscriptionUsage.cycleStart ?? (runtimeConsumed !== undefined ? cycleStartIso : undefined),
    cycleEnd: subscriptionUsage.cycleEnd ?? (runtimeConsumed !== undefined ? todayIso : undefined),
    sourcePath: sourcePath || undefined,
    detail,
    connectHint: providerConnectHint,
    reasonCode,
  };
}

async function loadCodexRateLimitUsage(connectHint: string): Promise<UsageSubscriptionStatus | undefined> {
  let fileEntries: Array<{ path: string; mtimeMs: number }> = [];
  try {
    fileEntries = await collectRecentJsonlFiles(CODEX_SESSIONS_DIR, CODEX_RATE_LIMIT_SESSION_SCAN_LIMIT);
  } catch {
    return undefined;
  }
  if (fileEntries.length === 0) return undefined;

  let latest: CodexRateLimitSnapshot | undefined;
  for (const entry of fileEntries) {
    let parsed: CodexRateLimitSnapshot | undefined;
    try {
      parsed = parseCodexRateLimitFromSessionLog(await readFile(entry.path, "utf8"), entry.path, entry.mtimeMs);
    } catch {
      continue;
    }
    if (!parsed) continue;
    if (!latest || compareCodexRateLimitSnapshots(parsed, latest) > 0) latest = parsed;
  }
  if (!latest) return undefined;

  const consumed = clampPercent(latest.primaryUsedPercent);
  const remaining = Math.max(0, 100 - consumed);
  const primaryWindowLabel = formatWindowMinutesLabel(latest.primaryWindowMinutes);
  const cycleEnd = toIsoFromEpoch(latest.primaryResetAtMs);
  const cycleStart =
    cycleEnd && latest.primaryWindowMinutes
      ? new Date(Date.parse(cycleEnd) - latest.primaryWindowMinutes * 60 * 1000).toISOString()
      : undefined;
  const secondaryUsageLabel =
    latest.secondaryUsedPercent !== undefined
      ? `周窗口已用 ${latest.secondaryUsedPercent.toFixed(1)}%${formatWindowMinutesLabel(latest.secondaryWindowMinutes) ? `（${formatWindowMinutesLabel(latest.secondaryWindowMinutes)}）` : ""}${toIsoFromEpoch(latest.secondaryResetAtMs) ? `，重置 ${toIsoFromEpoch(latest.secondaryResetAtMs)}` : ""}。`
      : "";
  const planType = latest.planType?.trim() ? latest.planType.trim() : "unknown";

  return {
    status: "connected",
    planLabel: `Codex 实时额度（${primaryWindowLabel || "主窗口"}）`,
    consumed,
    remaining,
    limit: 100,
    usagePercent: consumed,
    unit: "%",
    cycleStart,
    cycleEnd,
    sourcePath: `${latest.sourcePath} (Codex token_count rate_limits)`,
    detail:
      `来自 Codex CLI 实时额度信号（limit=${latest.limitId ?? "unknown"}，plan=${planType}，主窗口 ${primaryWindowLabel || "unknown"}）。` +
      ` 当前已用 ${consumed.toFixed(1)}%，剩余 ${remaining.toFixed(1)}%。` +
      `${cycleEnd ? ` 主窗口重置时间 ${cycleEnd}。` : ""}` +
      `${secondaryUsageLabel}`,
    primaryWindowLabel: primaryWindowLabel || "主窗口",
    primaryUsedPercent: consumed,
    primaryRemainingPercent: remaining,
    primaryResetAt: cycleEnd,
    secondaryWindowLabel: formatWindowMinutesLabel(latest.secondaryWindowMinutes) || (latest.secondaryUsedPercent !== undefined ? "Week" : undefined),
    secondaryUsedPercent: latest.secondaryUsedPercent,
    secondaryRemainingPercent:
      latest.secondaryUsedPercent !== undefined ? Math.max(0, 100 - latest.secondaryUsedPercent) : undefined,
    secondaryResetAt: toIsoFromEpoch(latest.secondaryResetAtMs),
    connectHint,
    reasonCode: "provider_connected",
  };
}

async function loadCodexWhamUsage(connectHint: string): Promise<UsageSubscriptionStatus | undefined> {
  let authRaw: string;
  try {
    authRaw = await readFile(CODEX_AUTH_PATH, "utf8");
  } catch {
    return undefined;
  }

  let auth: Record<string, unknown> | undefined;
  try {
    auth = asObject(JSON.parse(authRaw));
  } catch {
    return undefined;
  }
  const accessToken = asString(asObject(auth?.tokens)?.access_token)?.trim();
  if (!accessToken) return undefined;

  let response: Response;
  try {
    response = await fetch(CODEX_WHAM_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(CODEX_WHAM_USAGE_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;

  let raw: unknown;
  try {
    raw = (await response.json()) as unknown;
  } catch {
    return undefined;
  }

  const snapshot = parseCodexWhamUsageResponse(raw, `${CODEX_WHAM_USAGE_URL} (via ${CODEX_AUTH_PATH})`);
  if (!snapshot) return undefined;
  return usageSubscriptionFromCodexWhamSnapshot(snapshot, connectHint);
}

function parseCodexRateLimitFromSessionLog(
  raw: string,
  sourcePath: string,
  fallbackTimestampMs: number,
): CodexRateLimitSnapshot | undefined {
  const lines = raw.replace(/\r/g, "").split("\n");
  let latest: CodexRateLimitSnapshot | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (asString(parsed.type) !== "event_msg") continue;
    const payload = asObject(parsed.payload);
    if (!payload || asString(payload.type) !== "token_count") continue;
    const rateLimits = asObject(payload.rate_limits);
    if (!rateLimits) continue;
    const primary = asObject(rateLimits.primary);
    if (!primary) continue;
    const primaryUsedPercent = asFiniteNumber(primary.used_percent);
    if (primaryUsedPercent === undefined) continue;
    const timestampMs = parseTimestampMs(asString(parsed.timestamp)) ?? fallbackTimestampMs;

    const snapshot: CodexRateLimitSnapshot = {
      timestampMs,
      sourcePath,
      limitId: asString(rateLimits.limit_id),
      limitName: asString(rateLimits.limit_name),
      primaryUsedPercent,
      primaryWindowMinutes: asFiniteNumber(primary.window_minutes),
      primaryResetAtMs: parseEpochMaybeSeconds(primary.resets_at),
      secondaryUsedPercent: asFiniteNumber(asObject(rateLimits.secondary)?.used_percent),
      secondaryWindowMinutes: asFiniteNumber(asObject(rateLimits.secondary)?.window_minutes),
      secondaryResetAtMs: parseEpochMaybeSeconds(asObject(rateLimits.secondary)?.resets_at),
      planType: asString(rateLimits.plan_type),
    };
    if (!latest || compareCodexRateLimitSnapshots(snapshot, latest) > 0) latest = snapshot;
  }

  return latest;
}

function parseCodexWhamUsageResponse(
  input: unknown,
  sourcePath: string,
): CodexWhamUsageSnapshot | undefined {
  const root = asObject(input);
  const rateLimit = asObject(root?.rate_limit);
  const primary = asObject(rateLimit?.primary_window);
  const primaryUsedPercent = asFiniteNumber(primary?.used_percent);
  if (primaryUsedPercent === undefined) return undefined;
  const secondary = asObject(rateLimit?.secondary_window);

  return {
    sourcePath,
    planType: asString(root?.plan_type),
    primaryUsedPercent,
    primaryWindowMinutes: secondsToMinutes(asFiniteNumber(primary?.limit_window_seconds)),
    primaryResetAtMs: parseEpochMaybeSeconds(primary?.reset_at),
    secondaryUsedPercent: asFiniteNumber(secondary?.used_percent),
    secondaryWindowMinutes: secondsToMinutes(asFiniteNumber(secondary?.limit_window_seconds)),
    secondaryResetAtMs: parseEpochMaybeSeconds(secondary?.reset_at),
  };
}

function usageSubscriptionFromCodexWhamSnapshot(
  snapshot: CodexWhamUsageSnapshot,
  connectHint: string,
): UsageSubscriptionStatus {
  const consumed = clampPercent(snapshot.primaryUsedPercent);
  const remaining = Math.max(0, 100 - consumed);
  const primaryWindowLabel = formatWindowMinutesLabel(snapshot.primaryWindowMinutes);
  const cycleEnd = toIsoFromEpoch(snapshot.primaryResetAtMs);
  const cycleStart =
    cycleEnd && snapshot.primaryWindowMinutes
      ? new Date(Date.parse(cycleEnd) - snapshot.primaryWindowMinutes * 60 * 1000).toISOString()
      : undefined;
  const secondaryResetAt = toIsoFromEpoch(snapshot.secondaryResetAtMs);
  const secondaryUsageLabel =
    snapshot.secondaryUsedPercent !== undefined
      ? `周窗口已用 ${snapshot.secondaryUsedPercent.toFixed(1)}%${formatWindowMinutesLabel(snapshot.secondaryWindowMinutes) ? `（${formatWindowMinutesLabel(snapshot.secondaryWindowMinutes)}）` : ""}${secondaryResetAt ? `，重置 ${secondaryResetAt}` : ""}。`
      : "";
  const planType = snapshot.planType?.trim() ? snapshot.planType.trim() : "unknown";

  return {
    status: "connected",
    planLabel: `Codex 实时额度（${primaryWindowLabel || "主窗口"}）`,
    consumed,
    remaining,
    limit: 100,
    usagePercent: consumed,
    unit: "%",
    cycleStart,
    cycleEnd,
    sourcePath: snapshot.sourcePath,
    detail:
      `来自 Codex App 实时额度接口（plan=${planType}，主窗口 ${primaryWindowLabel || "unknown"}）。` +
      ` 当前已用 ${consumed.toFixed(1)}%，剩余 ${remaining.toFixed(1)}%。` +
      `${cycleEnd ? ` 主窗口重置时间 ${cycleEnd}。` : ""}` +
      `${secondaryUsageLabel}`,
    primaryWindowLabel: primaryWindowLabel || "主窗口",
    primaryUsedPercent: consumed,
    primaryRemainingPercent: remaining,
    primaryResetAt: cycleEnd,
    secondaryWindowLabel:
      formatWindowMinutesLabel(snapshot.secondaryWindowMinutes) ||
      (snapshot.secondaryUsedPercent !== undefined ? "Week" : undefined),
    secondaryUsedPercent: snapshot.secondaryUsedPercent,
    secondaryRemainingPercent:
      snapshot.secondaryUsedPercent !== undefined ? Math.max(0, 100 - snapshot.secondaryUsedPercent) : undefined,
    secondaryResetAt,
    connectHint,
    reasonCode: "provider_connected",
  };
}

function compareCodexRateLimitSnapshots(a: CodexRateLimitSnapshot, b: CodexRateLimitSnapshot): number {
  const priorityDiff = codexRateLimitPriority(a) - codexRateLimitPriority(b);
  if (priorityDiff !== 0) return priorityDiff;
  if (a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
  const primaryDiff = clampPercent(a.primaryUsedPercent) - clampPercent(b.primaryUsedPercent);
  if (primaryDiff !== 0) return primaryDiff;
  return clampPercent(a.secondaryUsedPercent ?? -1) - clampPercent(b.secondaryUsedPercent ?? -1);
}

function codexRateLimitPriority(snapshot: CodexRateLimitSnapshot): number {
  const limitId = snapshot.limitId?.trim().toLowerCase() ?? "";
  const limitName = snapshot.limitName?.trim().toLowerCase() ?? "";
  if (limitId === "codex") return 300;
  if (limitId.startsWith("codex_")) return 200;
  if (limitName.includes("codex")) return 150;
  return 100;
}

export function parseCodexRateLimitFromSessionLogForSmoke(
  raw: string,
  sourcePath = "/tmp/codex-session.jsonl",
  fallbackTimestampMs = 0,
): UsageSubscriptionStatus | undefined {
  const snapshot = parseCodexRateLimitFromSessionLog(raw, sourcePath, fallbackTimestampMs);
  if (!snapshot) return undefined;
  const consumed = clampPercent(snapshot.primaryUsedPercent);
  const remaining = Math.max(0, 100 - consumed);
  return {
    status: "connected",
    planLabel: `Codex 实时额度（${formatWindowMinutesLabel(snapshot.primaryWindowMinutes) || "主窗口"}）`,
    consumed,
    remaining,
    limit: 100,
    usagePercent: consumed,
    unit: "%",
    cycleEnd: toIsoFromEpoch(snapshot.primaryResetAtMs),
    sourcePath,
    detail: snapshot.limitId ?? "unknown",
    connectHint: "",
    reasonCode: "provider_connected",
    primaryWindowLabel: formatWindowMinutesLabel(snapshot.primaryWindowMinutes) || "主窗口",
    primaryUsedPercent: consumed,
    primaryRemainingPercent: remaining,
    primaryResetAt: toIsoFromEpoch(snapshot.primaryResetAtMs),
    secondaryWindowLabel:
      formatWindowMinutesLabel(snapshot.secondaryWindowMinutes) ||
      (snapshot.secondaryUsedPercent !== undefined ? "Week" : undefined),
    secondaryUsedPercent: snapshot.secondaryUsedPercent,
    secondaryRemainingPercent:
      snapshot.secondaryUsedPercent !== undefined ? Math.max(0, 100 - snapshot.secondaryUsedPercent) : undefined,
    secondaryResetAt: toIsoFromEpoch(snapshot.secondaryResetAtMs),
  };
}

export function parseCodexWhamUsageResponseForSmoke(
  input: unknown,
  sourcePath = "/tmp/wham-usage.json",
): UsageSubscriptionStatus | undefined {
  const snapshot = parseCodexWhamUsageResponse(input, sourcePath);
  if (!snapshot) return undefined;
  return usageSubscriptionFromCodexWhamSnapshot(snapshot, "");
}

async function collectRecentJsonlFiles(
  rootDir: string,
  limit: number,
): Promise<Array<{ path: string; mtimeMs: number }>> {
  const dirs = [rootDir];
  const files: Array<{ path: string; mtimeMs: number }> = [];
  while (dirs.length > 0) {
    const current = dirs.pop();
    if (!current) continue;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) {
        dirs.push(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        const entryStat = await stat(entryPath);
        files.push({
          path: entryPath,
          mtimeMs: entryStat.mtimeMs,
        });
      } catch {
        continue;
      }
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.slice(0, Math.max(1, limit));
}

function subscriptionConnectHint(): string {
  return `Provide one of: ${SUBSCRIPTION_SNAPSHOT_PATHS.join(", ")}. Or connect Codex session telemetry at ${CODEX_RATE_LIMIT_CONNECTOR_PATH}.`;
}

function snapCommonWindowMinutes(value: number): number | undefined {
  const rounded = Math.round(value);
  const commonWindows = [60, 300, 1440, 10080];
  for (const candidate of commonWindows) {
    if (Math.abs(rounded - candidate) <= 2) return candidate;
  }
  return undefined;
}

function formatWindowMinutesLabel(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  const rounded = snapCommonWindowMinutes(value) ?? Math.round(value);
  if (rounded % (24 * 60) === 0) return `${Math.round(rounded / (24 * 60))}d`;
  if (rounded % 60 === 0) return `${Math.round(rounded / 60)}h`;
  return `${rounded}m`;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function parseEpochMaybeSeconds(input: unknown): number | undefined {
  const numeric = asFiniteNumber(input);
  if (numeric === undefined) return undefined;
  if (numeric > 1_000_000_000_000) return Math.round(numeric);
  return Math.round(numeric * 1000);
}

function secondsToMinutes(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return value / 60;
}

function toIsoFromEpoch(input: number | undefined): string | undefined {
  if (input === undefined || !Number.isFinite(input) || input <= 0) return undefined;
  return new Date(input).toISOString();
}

function parseTimestampMs(input: string | undefined): number | undefined {
  if (!input?.trim()) return undefined;
  const parsed = Date.parse(input);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseSubscriptionUsage(
  input: unknown,
  sourcePath: string,
  connectHint: string,
): UsageSubscriptionStatus {
  const root = asObject(input) ?? {};
  const subscription = asObject(root.subscription) ?? {};
  const meta = asObject(root.meta) ?? {};
  const usage = asObject(root.usage) ?? asObject(subscription.usage) ?? {};
  const billing =
    asObject(root.billingCycle) ??
    asObject(root.cycle) ??
    asObject(root.currentPeriod) ??
    asObject(subscription.billingCycle) ??
    asObject(subscription.cycle) ??
    asObject(subscription.currentPeriod) ??
    {};
  const planObj = asObject(root.plan) ?? asObject(subscription.plan) ?? {};
  const sourceLabel = (
    asString(meta.source) ??
    asString(root.source) ??
    asString(root.sourceType) ??
    ""
  ).toLowerCase();
  const isSyntheticSnapshot =
    sourceLabel.includes("runtime_backfill") ||
    sourceLabel.includes("estimated") ||
    sourceLabel.includes("bootstrap");

  const planLabel =
    asString(planObj.name) ??
    asString(subscription.planLabel) ??
    asString(subscription.planName) ??
    asString(subscription.plan) ??
    asString(subscription.tier) ??
    asString(root.planLabel) ??
    asString(root.planName) ??
    asString(root.plan) ??
    asString(root.tier) ??
    "Subscription";

  const unit =
    asString(subscription.unit) ??
    asString(root.unit) ??
    asString(usage.unit) ??
    asString(subscription.currency) ??
    asString(root.currency) ??
    asString(usage.currency) ??
    "USD";

  const subscriptionCost = asObject(subscription.cost) ?? {};
  const rawConsumed = pickFirstPositive([
    subscription.consumed,
    subscription.used,
    subscription.spent,
    root.consumed,
    root.used,
    root.spent,
    usage.consumed,
    usage.used,
    usage.spent,
    asObject(subscription.usage)?.consumed,
    asObject(subscription.usage)?.used,
    asObject(subscription.usage)?.spent,
    subscriptionCost.used,
    subscriptionCost.spent,
    asObject(root.cost)?.used,
    asObject(root.cost)?.spent,
  ]);
  const rawLimit = pickFirstPositive([
    subscription.limit,
    subscription.total,
    subscription.quota,
    subscription.cap,
    root.limit,
    root.total,
    root.quota,
    root.cap,
    usage.limit,
    usage.total,
    usage.quota,
    asObject(subscription.usage)?.limit,
    asObject(subscription.usage)?.total,
    asObject(subscription.usage)?.quota,
    subscriptionCost.limit,
    asObject(root.cost)?.limit,
  ]);
  const rawRemaining = pickFirstPositive([
    subscription.remaining,
    subscription.left,
    root.remaining,
    root.left,
    usage.remaining,
    usage.left,
    asObject(subscription.usage)?.remaining,
    asObject(subscription.usage)?.left,
    rawLimit !== undefined && rawConsumed !== undefined ? Math.max(0, rawLimit - rawConsumed) : undefined,
  ]);
  const consumed = isSyntheticSnapshot ? undefined : rawConsumed;
  const limit = isSyntheticSnapshot ? undefined : rawLimit;
  const remaining = isSyntheticSnapshot ? undefined : rawRemaining;

  const cycleStart =
    asString(subscription.cycleStart) ??
    asString(subscription.currentPeriodStart) ??
    asString(root.cycleStart) ??
    asString(root.currentPeriodStart) ??
    asString(billing.start) ??
    asString(billing.from);
  const cycleEnd =
    asString(subscription.cycleEnd) ??
    asString(subscription.currentPeriodEnd) ??
    asString(subscription.resetAt) ??
    asString(root.cycleEnd) ??
    asString(root.currentPeriodEnd) ??
    asString(root.resetAt) ??
    asString(billing.end) ??
    asString(billing.to) ??
    asString(billing.resetAt);

  const hasSignal = consumed !== undefined || remaining !== undefined || limit !== undefined;
  if (!hasSignal) {
    if (isSyntheticSnapshot) {
      return {
        status: "partial",
        planLabel,
        unit,
        cycleStart,
        cycleEnd,
        sourcePath,
        detail: `Local estimated snapshot found at ${sourcePath}; strict mode ignores consumed/remaining/limit until provider billing fields are connected.`,
        connectHint,
        reasonCode: "runtime_backfill_with_budget_limit",
      };
    }
    return {
      status: "partial",
      planLabel,
      unit,
      cycleStart,
      cycleEnd,
      sourcePath,
      detail: `Subscription snapshot found at ${sourcePath}, but consumed/remaining/limit fields are unavailable.`,
      connectHint,
      reasonCode: "provider_snapshot_partial",
    };
  }

  const missingProviderFields = [
    typeof consumed === "number" ? "" : "consumed",
    typeof remaining === "number" ? "" : "remaining",
    typeof limit === "number" ? "" : "limit",
  ].filter((field) => field !== "");
  const usagePercent = consumed !== undefined && limit && limit > 0 ? (consumed / limit) * 100 : undefined;
  const cycleLabel = cycleEnd ? `Cycle ends ${cycleEnd}.` : cycleStart ? `Cycle started ${cycleStart}.` : "";
  const detail = [
    isSyntheticSnapshot ? "Local estimated snapshot (not provider billing source)." : "",
    consumed !== undefined ? `Used ${formatNumber(consumed)} ${unit}.` : "",
    remaining !== undefined ? `Remaining ${formatNumber(remaining)} ${unit}.` : "",
    limit !== undefined ? `Limit ${formatNumber(limit)} ${unit}.` : "",
    cycleLabel,
    missingProviderFields.length > 0
      ? `Provider field(s) unavailable: ${missingProviderFields.join(", ")}.`
      : "",
    `Source snapshot: ${sourcePath}.`,
  ]
    .filter((item) => item.length > 0)
    .join(" ");

  return {
    status: isSyntheticSnapshot ? "partial" : missingProviderFields.length === 0 ? "connected" : "partial",
    planLabel,
    consumed,
    remaining,
    limit,
    usagePercent,
    unit,
    cycleStart,
    cycleEnd,
    sourcePath,
    detail: detail || "Subscription usage is connected.",
    connectHint,
    reasonCode: isSyntheticSnapshot
      ? "runtime_backfill_with_budget_limit"
      : missingProviderFields.length === 0
        ? "provider_connected"
        : "provider_snapshot_partial",
  };
}

function defaultSubscriptionUsage(missingPaths: string[] = SUBSCRIPTION_SNAPSHOT_PATHS): UsageSubscriptionStatus {
  const missingDetail =
    missingPaths.length > 0
      ? `No subscription snapshot found at checked path(s): ${missingPaths.join(", ")}.`
      : "No subscription snapshot path configured.";
  return {
    status: "not_connected",
    planLabel: "Not connected",
    unit: "USD",
    detail: missingDetail,
    sourcePath: missingPaths.join("; "),
    connectHint: `Provide one of: ${SUBSCRIPTION_SNAPSHOT_PATHS.join(", ")}`,
    reasonCode: "provider_snapshot_missing",
  };
}

function pickFirstPositive(values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

function contextThresholdRank(state: SessionContextWindowSummary["thresholdState"]): number {
  if (state === "critical") return 0;
  if (state === "warn") return 1;
  if (state === "ok") return 2;
  return 3;
}

function inferProvider(model: string | undefined): string {
  if (!model) return "Unknown provider";
  const normalized = model.toLowerCase();
  if (normalized.includes("gpt") || normalized.includes("o1") || normalized.includes("o3")) return "OpenAI";
  if (normalized.includes("claude")) return "Anthropic";
  if (normalized.includes("gemini")) return "Google";
  if (normalized.includes("llama") || normalized.includes("mistral") || normalized.includes("qwen"))
    return "OSS/Other";
  return "Unknown provider";
}

function pickUsageTokens(usage: Record<string, unknown>): number {
  const totalTokens = asNumber(usage.totalTokens);
  if (totalTokens > 0) return totalTokens;
  return asNumber(usage.input) + asNumber(usage.output) + asNumber(usage.cacheRead) + asNumber(usage.cacheWrite);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value);
}

function toDayMs(value: string): number {
  const normalized = value.length === 10 ? `${value}T00:00:00.000Z` : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function ageInMinutes(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - parsed) / 60000);
}

function isFsNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string" &&
      (error as { code: string }).code === "ENOENT",
  );
}

function asObject(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}

function asArray(input: unknown): unknown[] {
  return Array.isArray(input) ? input : [];
}

function asString(input: unknown): string | undefined {
  return typeof input === "string" ? input : undefined;
}

function asNumber(input: unknown): number {
  return typeof input === "number" && Number.isFinite(input) ? input : 0;
}

function asFiniteNumber(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined;
}

function asPositiveNumber(input: unknown): number | undefined {
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) return undefined;
  return input;
}

function asNonNegativeNumber(input: unknown): number | undefined {
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) return undefined;
  return input;
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.trim() ? code : undefined;
}

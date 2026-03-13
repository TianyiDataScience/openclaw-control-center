import { execFile } from "node:child_process";
import { open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  ApprovalsActionResponse,
  ApprovalsApproveRequest,
  ApprovalsGetResponse,
  ApprovalsRejectRequest,
  CronListResponse,
  SessionStatusResponse,
  SessionsHistoryRequest,
  SessionsHistoryResponse,
  SessionsListResponse,
} from "../contracts/openclaw-tools";
import { APPROVAL_ACTIONS_ENABLED } from "../config";
import { loadCurrentAgentCatalog, resolveOpenClawHomePath } from "../runtime/current-agent-catalog";
import type { ToolClient } from "./tool-client";

const execFileAsync = promisify(execFile);

interface SessionCacheItem {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  sessionFile?: string;
}

const ACTIVE_SESSION_STATES = new Set([
  "running",
  "active",
  "busy",
  "blocked",
  "waiting_approval",
  "working",
  "in_progress",
  "processing",
  "thinking",
  "executing",
  "streaming",
]);
const INACTIVE_SESSION_STATES = new Set([
  "idle",
  "inactive",
  "error",
  "failed",
  "stopped",
  "stopping",
  "closed",
  "done",
  "completed",
  "complete",
  "paused",
  "aborted",
  "terminated",
  "cancelled",
  "canceled",
]);
const FALLBACK_ACTIVE_RECENCY_WINDOW_MS = 45 * 60 * 1000;
const SESSION_HISTORY_TAIL_MIN_LINES = 80;
const SESSION_HISTORY_TAIL_LINE_MULTIPLIER = 8;
const SESSION_HISTORY_TAIL_CHUNK_BYTES = 64 * 1024;

/**
 * Live read client using official OpenClaw CLI JSON outputs.
 * Read-only by design: only list/status commands are used.
 */
export class OpenClawLiveClient implements ToolClient {
  private sessionCache = new Map<string, SessionCacheItem>();
  private sessionFileCache = new Map<string, string>();

  async sessionsList(): Promise<SessionsListResponse> {
    const openclawHome = resolveOpenClawHomePath();
    const configuredAgentKeys = await this.loadConfiguredAgentKeys();
    let data: { sessions?: Array<Record<string, unknown>> };
    try {
      data = await runJson<{ sessions?: Array<Record<string, unknown>> }>([
        "sessions",
        "--json",
      ]);
    } catch {
      return this.loadSessionsFromStores();
    }

    const cliSessions: NonNullable<SessionsListResponse["sessions"]> = (data.sessions ?? []).map((item) => ({
      key: asString(item.key),
      sessionKey: asString(item.key),
      sessionId: asString(item.sessionId),
      agentId: asString(item.agentId),
      updatedAtMs: asNumber(item.updatedAt),
      sessionFile:
        asString(item.sessionFile) ??
        buildSessionFilePath(openclawHome, asString(item.agentId), asString(item.sessionId)),
      model: asString(item.model),
      inputTokens: asNumber(item.inputTokens),
      outputTokens: asNumber(item.outputTokens),
      totalTokens: asNumber(item.totalTokens),
      state: readSessionState(item),
      active: asBoolean(item.active) ?? false,
    })).filter((item) => matchesConfiguredAgents(item.agentId ?? extractAgentIdFromSessionKey(item.sessionKey), configuredAgentKeys));
    let sessions: NonNullable<SessionsListResponse["sessions"]> = cliSessions;
    try {
      const storeSessions = (await this.loadSessionsFromStores()).sessions ?? [];
      sessions = mergeSessionLists(cliSessions, storeSessions);
    } catch {
      sessions = cliSessions;
    }

    this.sessionCache.clear();
    for (const s of sessions) {
      if (!s.sessionKey) continue;
      this.sessionCache.set(s.sessionKey, {
        model: s.model,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        totalTokens: s.totalTokens,
        sessionFile: s.sessionFile,
      });
    }

    return { sessions };
  }

  async sessionStatus(sessionKey: string): Promise<SessionStatusResponse> {
    const cached = this.sessionCache.get(sessionKey);
    const rawText = cached
      ? `Model: ${cached.model ?? "unknown"}\nTokens: ${cached.inputTokens ?? 0} in / ${cached.outputTokens ?? 0} out\nTotal: ${cached.totalTokens ?? 0}`
      : "";

    return { rawText };
  }

  async sessionsHistory(request: SessionsHistoryRequest): Promise<SessionsHistoryResponse> {
    const sessionKey = request.sessionKey.trim();
    if (!sessionKey) {
      return { rawText: "" };
    }

    const limit = normalizeLimit(request.limit);
    let sessionFile = this.sessionCache.get(sessionKey)?.sessionFile;
    if (!sessionFile) {
      sessionFile = await this.lookupSessionFile(sessionKey);
    }
    if (sessionFile) {
      const fromFile = await readSessionHistoryFile(sessionFile, limit);
      if (fromFile) return fromFile;
    }
    const attempts: string[][] = [
      ["sessions", "history", sessionKey, "--json", "--limit", String(limit)],
      ["sessions", "history", sessionKey, "--limit", String(limit), "--json"],
      ["sessions", "history", sessionKey, "--json"],
    ];

    for (const args of attempts) {
      try {
        const json = await runJson<Record<string, unknown>>(args);
        return {
          json,
          rawText: JSON.stringify(json),
        };
      } catch {
        continue;
      }
    }

    try {
      const rawText = await runHistoryText(sessionKey, limit);
      return normalizeRawHistoryText(rawText, limit);
    } catch {
      return { rawText: "" };
    }
  }

  async cronList(): Promise<CronListResponse> {
    let data: { jobs?: Array<Record<string, unknown>> };
    try {
      data = await runJson<{ jobs?: Array<Record<string, unknown>> }>(
        ["cron", "list", "--json"],
        { timeoutMs: 2_500 },
      );
    } catch {
      return { jobs: [] };
    }

    const jobs = (data.jobs ?? []).map((job) => ({
      id: asString(job.id),
      name: asString(job.name),
      enabled: asBoolean(job.enabled),
      state: asObject(job.state)
        ? {
            nextRunAtMs: asNumber(asObject(job.state)?.nextRunAtMs),
          }
        : undefined,
    }));

    return { jobs };
  }

  async approvalsGet(): Promise<ApprovalsGetResponse> {
    try {
      const json = await runJson<Record<string, unknown>>(
        ["approvals", "get", "--json"],
        { timeoutMs: 2_500 },
      );
      return {
        json,
        rawText: JSON.stringify(json),
      };
    } catch {
      try {
        const rawText = await runText(["approvals", "get"], { timeoutMs: 1_500 });
        return { rawText };
      } catch {
        return { rawText: "" };
      }
    }
  }

  async approvalsApprove(request: ApprovalsApproveRequest): Promise<ApprovalsActionResponse> {
    assertApprovalActionsEnabled("approve");
    const args = ["approvals", "approve", request.approvalId];
    if (request.reason) args.push("--reason", request.reason);

    const rawText = await runText(args);
    return {
      ok: true,
      action: "approve",
      approvalId: request.approvalId,
      reason: request.reason,
      rawText,
    };
  }

  async approvalsReject(request: ApprovalsRejectRequest): Promise<ApprovalsActionResponse> {
    assertApprovalActionsEnabled("reject");
    const args = ["approvals", "reject", request.approvalId, "--reason", request.reason];
    const rawText = await runText(args);
    return {
      ok: true,
      action: "reject",
      approvalId: request.approvalId,
      reason: request.reason,
      rawText,
    };
  }

  private async loadSessionsFromStores(): Promise<SessionsListResponse> {
    const openclawHome = resolveOpenClawHomePath();
    const agentsPath = join(openclawHome, "agents");
    const configuredAgentKeys = await this.loadConfiguredAgentKeys();
    let agentDirs: string[] = [];
    try {
      const entries = await readdir(agentsPath, { withFileTypes: true });
      agentDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return { sessions: [] };
    }

    if (configuredAgentKeys.size > 0) {
      agentDirs = agentDirs.filter((agentId) => matchesConfiguredAgents(agentId, configuredAgentKeys));
    }

    const sessions: SessionsListResponse["sessions"] = [];
    for (const agentId of agentDirs) {
      const sessionsPath = join(agentsPath, agentId, "sessions", "sessions.json");
      try {
        const parsed = JSON.parse(await readFile(sessionsPath, "utf8")) as unknown;
        const records = extractSessionRecords(parsed);
        for (const record of records) {
          const sessionKey = asString(record.key) ?? asString(record.sessionKey);
          if (!sessionKey) continue;
          const updatedAtMs = readUpdatedAtMs(record);
          sessions.push({
            key: sessionKey,
            sessionKey,
            sessionId: asString(record.sessionId),
            agentId: asString(record.agentId) ?? agentId,
            updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : undefined,
            sessionFile:
              asString(record.sessionFile) ??
              buildSessionFilePath(openclawHome, asString(record.agentId) ?? agentId, asString(record.sessionId)),
            model: asString(record.model),
            inputTokens: asNumber(record.inputTokens),
            outputTokens: asNumber(record.outputTokens),
            totalTokens: asNumber(record.totalTokens),
            state: readSessionState(record),
            active: isSessionActive(record, updatedAtMs),
          });
        }
      } catch {
        continue;
      }
    }

    sessions.sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0));
    this.sessionCache.clear();
    for (const session of sessions) {
      if (!session.sessionKey) continue;
      this.sessionCache.set(session.sessionKey, {
        model: session.model,
        inputTokens: session.inputTokens,
        outputTokens: session.outputTokens,
        totalTokens: session.totalTokens,
        sessionFile: session.sessionFile,
      });
      if (session.sessionFile) {
        this.sessionFileCache.set(session.sessionKey, session.sessionFile);
      }
    }
    return { sessions };
  }

  private async lookupSessionFile(sessionKey: string): Promise<string | undefined> {
    const cached = this.sessionFileCache.get(sessionKey);
    if (cached) return cached;

    const openclawHome = resolveOpenClawHomePath();
    const agentsPath = join(openclawHome, "agents");
    const configuredAgentKeys = await this.loadConfiguredAgentKeys();
    if (!matchesConfiguredAgents(extractAgentIdFromSessionKey(sessionKey), configuredAgentKeys)) {
      return undefined;
    }
    let agentDirs: string[] = [];
    try {
      const entries = await readdir(agentsPath, { withFileTypes: true });
      agentDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return undefined;
    }

    if (configuredAgentKeys.size > 0) {
      agentDirs = agentDirs.filter((agentId) => matchesConfiguredAgents(agentId, configuredAgentKeys));
    }

    for (const agentId of agentDirs) {
      const sessionsPath = join(agentsPath, agentId, "sessions", "sessions.json");
      try {
        const parsed = JSON.parse(await readFile(sessionsPath, "utf8")) as unknown;
        for (const record of extractSessionRecords(parsed)) {
          const key = asString(record.key) ?? asString(record.sessionKey);
          const sessionFile =
            asString(record.sessionFile) ??
            buildSessionFilePath(openclawHome, asString(record.agentId) ?? agentId, asString(record.sessionId));
          if (!key || !sessionFile) continue;
          this.sessionFileCache.set(key, sessionFile);
        }
      } catch {
        continue;
      }
    }

    return this.sessionFileCache.get(sessionKey);
  }

  private async loadConfiguredAgentKeys(): Promise<Set<string>> {
    const catalog = await loadCurrentAgentCatalog();
    return new Set(catalog.entries.map((entry) => normalizeAgentKey(entry.agentId)));
  }
}

async function runJson<T>(args: string[], options?: { timeoutMs?: number; maxBuffer?: number }): Promise<T> {
  const stdout = await runText(args, options);
  return JSON.parse(stdout) as T;
}

async function runText(
  args: string[],
  options?: { timeoutMs?: number; maxBuffer?: number },
): Promise<string> {
  const { stdout } = await execFileAsync("openclaw", args, {
    timeout: options?.timeoutMs ?? 20_000,
    maxBuffer: options?.maxBuffer ?? 2 * 1024 * 1024,
  });
  return stdout;
}

async function runHistoryText(sessionKey: string, limit: number): Promise<string> {
  try {
    return await runText(["sessions", "history", sessionKey, "--limit", String(limit)]);
  } catch (error) {
    if (!isUnknownLimitOptionError(error)) throw error;
  }

  const rawText = await runText(["sessions", "history", sessionKey]);
  const trimmed = rawText.trim();
  if (trimmed === "") return rawText;
  const lines = trimmed.split(/\r?\n/);
  return lines.slice(-limit).join("\n");
}

function normalizeRawHistoryText(rawText: string, limit: number): SessionsHistoryResponse {
  const trimmed = rawText.trim();
  if (trimmed === "") return { rawText };

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  const jsonLike = lines.every((line) => line.startsWith("{") || line.startsWith("["));
  if (jsonLike) {
    return normalizeSessionHistoryChunk(lines.join("\n"), limit);
  }

  return { rawText };
}

function isUnknownLimitOptionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /unknown option '--limit'/.test(error.message);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function asBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

function normalizeLimit(input: number | undefined): number {
  if (typeof input !== "number" || !Number.isFinite(input)) return 12;
  return Math.max(1, Math.min(200, Math.trunc(input)));
}

async function readSessionHistoryFile(
  sessionFile: string,
  limit: number,
): Promise<SessionsHistoryResponse | undefined> {
  const targetLineCount = Math.max(limit * SESSION_HISTORY_TAIL_LINE_MULTIPLIER, SESSION_HISTORY_TAIL_MIN_LINES);
  try {
    const raw = await readRecentSessionHistoryChunk(sessionFile, targetLineCount);
    return normalizeSessionHistoryChunk(raw, limit);
  } catch {
    try {
      const raw = await readFile(sessionFile, "utf8");
      return normalizeSessionHistoryChunk(raw, limit);
    } catch {
      return undefined;
    }
  }
}

async function readRecentSessionHistoryChunk(sessionFile: string, targetLineCount: number): Promise<string> {
  const handle = await open(sessionFile, "r");
  try {
    const { size } = await handle.stat();
    if (size <= 0) return "";

    let position = size;
    let newlineCount = 0;
    const chunks: Buffer[] = [];

    while (position > 0 && newlineCount < targetLineCount) {
      const bytesToRead = Math.min(SESSION_HISTORY_TAIL_CHUNK_BYTES, position);
      position -= bytesToRead;

      const buffer = Buffer.allocUnsafe(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, position);
      if (bytesRead <= 0) break;

      const chunk = bytesRead === bytesToRead ? buffer : buffer.subarray(0, bytesRead);
      chunks.push(chunk);
      newlineCount += countLineFeeds(chunk);
    }

    if (chunks.length === 0) return "";

    const raw = Buffer.concat(chunks.reverse()).toString("utf8");
    if (position <= 0) return raw;

    const firstLineBreak = raw.indexOf("\n");
    return firstLineBreak >= 0 ? raw.slice(firstLineBreak + 1) : raw;
  } finally {
    await handle.close();
  }
}

function countLineFeeds(buffer: Uint8Array): number {
  let count = 0;
  for (const byte of buffer) {
    if (byte === 0x0a) count += 1;
  }
  return count;
}

function normalizeSessionHistoryChunk(raw: string, limit: number): SessionsHistoryResponse {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) return { rawText: "" };

  const recentLines = lines.slice(-limit);
  const history = recentLines.map((line) => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      return line;
    }
  });
  return {
    json: { history },
    rawText: recentLines.join("\n"),
  };
}

function extractSessionRecords(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) return parsed.flatMap((item) => (asObject(item) ? [item] : []));

  const root = asObject(parsed);
  if (!root) return [];

  const nestedCollections = [root.sessions, root.items, root.records];
  for (const collection of nestedCollections) {
    if (!Array.isArray(collection)) continue;
    const records = collection.flatMap((item) => (asObject(item) ? [item] : []));
    if (records.length > 0) return records;
  }

  return Object.entries(root).flatMap(([key, value]) => {
    const record = asObject(value);
    if (!record) return [];
    return [{ key, ...record }];
  });
}

function mergeSessionLists(
  primary: NonNullable<SessionsListResponse["sessions"]> = [],
  secondary: NonNullable<SessionsListResponse["sessions"]> = [],
): NonNullable<SessionsListResponse["sessions"]> {
  const merged = new Map<string, NonNullable<SessionsListResponse["sessions"]>[number]>();

  const mergeItem = (item: NonNullable<SessionsListResponse["sessions"]>[number]): void => {
    const sessionKey = item.sessionKey ?? item.key;
    if (!sessionKey) return;
    const current = merged.get(sessionKey);
    if (!current) {
      merged.set(sessionKey, item);
      return;
    }
    merged.set(sessionKey, {
      ...current,
      ...item,
      sessionKey,
      key: item.key ?? current.key ?? sessionKey,
      sessionFile: item.sessionFile ?? current.sessionFile,
      sessionId: item.sessionId ?? current.sessionId,
      agentId: item.agentId ?? current.agentId,
      updatedAtMs: Math.max(current.updatedAtMs ?? 0, item.updatedAtMs ?? 0) || undefined,
      active: item.active ?? current.active ?? false,
      state: item.state ?? current.state,
      model: item.model ?? current.model,
      inputTokens: item.inputTokens ?? current.inputTokens,
      outputTokens: item.outputTokens ?? current.outputTokens,
      totalTokens: item.totalTokens ?? current.totalTokens,
    });
  };

  for (const item of secondary) mergeItem(item);
  for (const item of primary) mergeItem(item);

  return [...merged.values()].sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0));
}

function isSessionActive(item: Record<string, unknown>, updatedAtMs: number): boolean {
  const explicitActive = asBoolean(item.active) ?? asBoolean(item.isActive);
  if (typeof explicitActive === "boolean") return explicitActive;

  const explicitState = readSessionState(item);
  if (explicitState) {
    if (ACTIVE_SESSION_STATES.has(explicitState)) return true;
    if (INACTIVE_SESSION_STATES.has(explicitState)) return false;
  }

  if (!Number.isFinite(updatedAtMs)) return false;
  return Date.now() - updatedAtMs <= FALLBACK_ACTIVE_RECENCY_WINDOW_MS;
}

function readSessionState(item: Record<string, unknown>): string | undefined {
  const direct =
    asString(item.state) ??
    asString(item.status) ??
    asString(item.runState) ??
    asString(item.lifecycleState);
  if (direct) return direct.trim().toLowerCase();

  const acp = asObject(item.acp);
  const acpState = asString(acp?.state);
  return acpState ? acpState.trim().toLowerCase() : undefined;
}

function readUpdatedAtMs(item: Record<string, unknown>): number {
  const candidates = [
    item.updatedAt,
    item.lastActivityAt,
    item.createdAt,
    asObject(item.acp)?.lastActivityAt,
    asObject(item.acp)?.updatedAt,
    asObject(item.acp)?.createdAt,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return normalizeEpochMs(candidate);
    if (typeof candidate === "string" && candidate.trim() !== "") {
      const trimmed = candidate.trim();
      if (/^\d+(\.\d+)?$/.test(trimmed)) {
        const numeric = Number(trimmed);
        if (Number.isFinite(numeric)) return normalizeEpochMs(numeric);
      }
      const parsed = Date.parse(trimmed);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }

  return Number.NaN;
}

function normalizeEpochMs(value: number): number {
  const abs = Math.abs(value);
  if (abs >= 1e14) return value / 1000;
  if (abs > 0 && abs < 1e12) return value * 1000;
  return value;
}

function buildSessionFilePath(
  openclawHome: string,
  agentId: string | undefined,
  sessionId: string | undefined,
): string | undefined {
  if (!agentId || !sessionId) return undefined;
  return join(openclawHome, "agents", agentId, "sessions", `${sessionId}.jsonl`);
}

function extractAgentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  const value = sessionKey?.trim();
  if (!value) return undefined;
  const match = /^agent:([^:]+):/i.exec(value);
  return match?.[1];
}

function matchesConfiguredAgents(agentId: string | undefined, configuredAgentKeys: ReadonlySet<string>): boolean {
  if (configuredAgentKeys.size === 0) return true;
  const normalized = normalizeAgentKey(agentId);
  return normalized.length > 0 && configuredAgentKeys.has(normalized);
}

function normalizeAgentKey(agentId: string | undefined): string {
  return agentId?.trim().toLowerCase() ?? "";
}

function assertApprovalActionsEnabled(action: "approve" | "reject"): void {
  if (APPROVAL_ACTIONS_ENABLED) return;
  throw new Error(
    `approvals ${action} is disabled by safety gate (APPROVAL_ACTIONS_ENABLED=${String(
      APPROVAL_ACTIONS_ENABLED,
    )}).`,
  );
}

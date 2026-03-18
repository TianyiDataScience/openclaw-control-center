import type { ToolClient } from "../clients/tool-client";
import type { SessionsHistoryResponse } from "../contracts/openclaw-tools";
import type {
  AgentRunState,
  ReadModelSnapshot,
  SessionStatusSnapshot,
  SessionSummary,
} from "../types";

export interface SessionConversationFilters {
  state?: AgentRunState;
  agentId?: string;
  q?: string;
}

export type SessionHistoryKind = "message" | "inter_session" | "tool_event" | "accepted" | "spawn";

export interface SessionExecutionChainSummary {
  accepted: boolean;
  spawned: boolean;
  acceptedAt?: string;
  spawnedAt?: string;
  parentSessionKey?: string;
  childSessionKey?: string;
  stage: "idle" | "accepted" | "spawned" | "running";
  source: "history" | "session_key";
  inferred: boolean;
  detail: string;
}

export interface SessionConversationListItem extends SessionSummary {
  taskSnippet?: string;
  latestSnippet?: string;
  latestRole?: string;
  latestKind?: SessionHistoryKind;
  latestToolName?: string;
  latestHistoryAt?: string;
  historyCount: number;
  toolEventCount: number;
  historyError?: string;
  executionChain?: SessionExecutionChainSummary;
  interSessionSignals?: SessionInterSessionSignal[];
}

export interface SessionConversationListResult {
  generatedAt: string;
  total: number;
  page: number;
  pageSize: number;
  filters: SessionConversationFilters;
  items: SessionConversationListItem[];
}

export interface SessionHistoryMessage {
  kind: SessionHistoryKind;
  role: string;
  author?: string;
  content: string;
  timestamp?: string;
  toolName?: string;
  toolStatus?: string;
  truncated?: boolean;
  parentSessionKey?: string;
  childSessionKey?: string;
  provenanceKind?: string;
  sourceSessionKey?: string;
  sourceTool?: string;
  inferred?: boolean;
}

export interface SessionInterSessionSignal {
  sourceSessionKey: string;
  sourceTool?: string;
  timestamp?: string;
  snippet: string;
}

export interface SessionConversationDetailResult {
  generatedAt: string;
  session: SessionSummary;
  status?: SessionStatusSnapshot;
  latestSnippet?: string;
  latestRole?: string;
  latestKind?: SessionHistoryKind;
  latestToolName?: string;
  latestHistoryAt?: string;
  historyCount: number;
  history: SessionHistoryMessage[];
  historyError?: string;
  executionChain?: SessionExecutionChainSummary;
}

export interface SessionConversationListInput {
  snapshot: ReadModelSnapshot;
  client: ToolClient;
  filters: SessionConversationFilters;
  page: number;
  pageSize: number;
  historyLimit: number;
}

export interface SessionConversationDetailInput {
  snapshot: ReadModelSnapshot;
  client: ToolClient;
  sessionKey: string;
  historyLimit: number;
}

interface SessionHistoryReadResult {
  messages: SessionHistoryMessage[];
  error?: string;
}

const HISTORY_ARRAY_KEYS = ["history", "messages", "items", "entries", "events", "conversation"];
const ROLE_KEYS = ["role", "speaker", "source"];
const ROLE_TYPE_KEYS = ["type"];
const AUTHOR_KEYS = ["author", "agent", "agentId", "name", "from"];
const TIME_KEYS = ["timestamp", "time", "createdAt", "updatedAt", "at", "ts"];
const TOOL_NAME_KEYS = [
  "toolName",
  "tool",
  "toolId",
  "tool_id",
  "function",
  "functionName",
  "toolCall",
  "tool_call",
  "action",
];
const TOOL_STATUS_KEYS = ["status", "state", "outcome", "resultStatus"];
const TOOL_INPUT_KEYS = ["arguments", "args", "input", "params", "command", "query", "payload"];
const TOOL_OUTPUT_KEYS = ["result", "output", "response", "return", "observation", "error"];
const TOOL_HINT_KEYS = [
  "tool",
  "toolName",
  "tool_call",
  "toolCall",
  "function",
  "arguments",
  "args",
  "result",
  "output",
];
const EXECUTION_EVENT_KEYS = [
  "event",
  "kind",
  "action",
  "type",
  "operation",
  "eventType",
  "name",
  "status",
] as const;
const PARENT_SESSION_KEYS = [
  "parentSessionKey",
  "parent_session_key",
  "parentSession",
  "parent_session",
  "sourceSessionKey",
  "source_session_key",
] as const;
const CHILD_SESSION_KEYS = [
  "childSessionKey",
  "child_session_key",
  "spawnedSessionKey",
  "spawned_session_key",
  "targetSessionKey",
  "target_session_key",
  "sessionKey",
  "session_key",
] as const;
const SESSION_KEY_REGEX = /agent:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)+/g;
const MAX_ENTRY_CONTENT_CHARS = 1200;
const MAX_SNIPPET_CHARS = 220;
const MAX_TOOL_SEGMENT_CHARS = 280;
const KNOWN_ROLE_TYPES = new Set(["user", "assistant", "system", "tool"]);
const SESSION_HISTORY_CACHE_TTL_MS = 15_000;

/** Maximum concurrent session history fetches to avoid overwhelming the gateway. */
const SESSION_HISTORY_CONCURRENCY = 4;

interface SessionHistoryCacheEntry {
  limit: number;
  expiresAt: number;
  value?: SessionHistoryReadResult;
  inflight?: Promise<SessionHistoryReadResult>;
}

const sessionHistoryCache = new Map<string, SessionHistoryCacheEntry>();

export async function listSessionConversations(
  input: SessionConversationListInput,
): Promise<SessionConversationListResult> {
  const page = normalizePage(input.page);
  const pageSize = normalizePageSize(input.pageSize);
  const historyLimit = normalizeHistoryLimit(input.historyLimit);
  const sessions = input.snapshot.sessions
    .filter((session) => matchesSession(session, input.filters))
    .sort(compareSessions);

  const total = sessions.length;
  const start = (page - 1) * pageSize;
  const paged = sessions.slice(start, start + pageSize);

  const items = await mapWithConcurrency(paged, SESSION_HISTORY_CONCURRENCY, async (session) => {
      const history = await readSessionHistory(input.client, session.sessionKey, historyLimit);
      const latest = pickLatestMessage(history.messages);
      return {
        ...session,
        latestSnippet: latest ? summarizeSnippet(latest.content) : undefined,
        latestRole: latest?.role,
        latestKind: latest?.kind,
        latestToolName: latest?.toolName,
        latestHistoryAt: latest?.timestamp,
        historyCount: history.messages.length,
        toolEventCount: history.messages.filter((message) => message.kind === "tool_event").length,
        historyError: history.error,
        executionChain: inferSessionExecutionChain(session, history.messages),
        interSessionSignals: extractInterSessionSignals(history.messages),
      };
    });

  return {
    generatedAt: new Date().toISOString(),
    total,
    page,
    pageSize,
    filters: input.filters,
    items,
  };
}

export async function getSessionConversationDetail(
  input: SessionConversationDetailInput,
): Promise<SessionConversationDetailResult | null> {
  const sessionKey = input.sessionKey.trim();
  if (!sessionKey) return null;

  const session = input.snapshot.sessions.find((item) => item.sessionKey === sessionKey);
  if (!session) return null;

  const historyLimit = normalizeHistoryLimit(input.historyLimit, 50);
  const history = await readSessionHistory(input.client, sessionKey, historyLimit);
  const latest = pickLatestMessage(history.messages);
  const status = input.snapshot.statuses.find((item) => item.sessionKey === sessionKey);

  return {
    generatedAt: new Date().toISOString(),
    session,
    status,
    latestSnippet: latest ? summarizeSnippet(latest.content) : undefined,
    latestRole: latest?.role,
    latestKind: latest?.kind,
    latestToolName: latest?.toolName,
    latestHistoryAt: latest?.timestamp,
    historyCount: history.messages.length,
    history: history.messages,
    historyError: history.error,
    executionChain: inferSessionExecutionChain(session, history.messages),
  };
}

export function inferSessionExecutionChainFromSessionKey(
  session: SessionSummary,
): SessionExecutionChainSummary | undefined {
  return inferSessionExecutionChain(session, []);
}

async function readSessionHistory(
  client: ToolClient,
  sessionKey: string,
  limit: number,
): Promise<SessionHistoryReadResult> {
  const cacheKey = sessionKey.trim();
  const now = Date.now();
  const cached = sessionHistoryCache.get(cacheKey);
  if (cached && cached.expiresAt > now && cached.value && cached.limit >= limit) {
    return sliceHistoryReadResult(cached.value, limit);
  }

  if (cached?.inflight) {
    const inflightResult = await cached.inflight;
    const refreshed = sessionHistoryCache.get(cacheKey);
    if (refreshed && refreshed.expiresAt > Date.now() && refreshed.value && refreshed.limit >= limit) {
      return sliceHistoryReadResult(refreshed.value, limit);
    }
    if (cached.limit >= limit) {
      return sliceHistoryReadResult(inflightResult, limit);
    }
  }

  const fetchLimit = Math.max(limit, cached?.limit ?? 0);
  const inflight = (async (): Promise<SessionHistoryReadResult> => {
    try {
      const response = await client.sessionsHistory({ sessionKey, limit: fetchLimit });
      return {
        messages: normalizeHistoryMessages(response, fetchLimit),
      };
    } catch (error) {
      return {
        messages: [],
        error: error instanceof Error ? error.message : "Failed to read session history.",
      };
    }
  })();

  sessionHistoryCache.set(cacheKey, {
    limit: fetchLimit,
    expiresAt: now + SESSION_HISTORY_CACHE_TTL_MS,
    inflight,
  });

  const value = await inflight;
  sessionHistoryCache.set(cacheKey, {
    limit: fetchLimit,
    expiresAt: Date.now() + SESSION_HISTORY_CACHE_TTL_MS,
    value,
  });
  return sliceHistoryReadResult(value, limit);
}

function sliceHistoryReadResult(result: SessionHistoryReadResult, limit: number): SessionHistoryReadResult {
  if (result.messages.length <= limit) return result;
  return {
    messages: result.messages.slice(-limit),
    error: result.error,
  };
}

function normalizeHistoryMessages(response: SessionsHistoryResponse, limit: number): SessionHistoryMessage[] {
  const fromJson = response.json ? normalizeHistoryFromJson(response.json) : [];
  const normalized = fromJson.length > 0 ? fromJson : normalizeHistoryFromText(response.rawText);
  if (normalized.length <= limit) return normalized;
  return normalized.slice(-limit);
}

function normalizeHistoryFromJson(input: unknown): SessionHistoryMessage[] {
  const entries = extractHistoryArray(input);
  if (entries.length === 0) return [];

  const messages: SessionHistoryMessage[] = [];
  for (const entry of entries) {
    const parsed = parseHistoryEntry(entry);
    if (!parsed) continue;
    messages.push(parsed);
  }

  return messages;
}

function extractHistoryArray(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  const obj = asObject(input);
  if (!obj) return [];

  for (const key of HISTORY_ARRAY_KEYS) {
    const value = obj[key];
    if (Array.isArray(value)) return value;
  }

  for (const key of ["data", "result", "payload"]) {
    const nested = obj[key];
    const nestedObj = asObject(nested);
    if (!nestedObj) continue;

    for (const historyKey of HISTORY_ARRAY_KEYS) {
      const value = nestedObj[historyKey];
      if (Array.isArray(value)) return value;
    }
  }

  return [];
}

function parseHistoryEntry(input: unknown): SessionHistoryMessage | null {
  if (typeof input === "string") {
    const content = normalizeSpace(input);
    if (!content) return null;
    const executionEvent = parseExecutionEventFromText(content);
    if (executionEvent) return executionEvent;
    return buildMessageEntry({
      kind: "message",
      role: "unknown",
      content,
    });
  }

  const obj = asObject(input);
  if (!obj) return null;
  const messageObj = asObject(obj.message);

  const executionEvent = parseExecutionEvent(obj);
  if (executionEvent) {
    return executionEvent;
  }

  if (looksLikeToolEvent(obj)) {
    return parseToolEvent(obj);
  }

  const role = extractRole(obj, messageObj) ?? "unknown";
  const author = extractAuthor(obj, messageObj);
  const timestamp = extractTimestamp(obj, messageObj);
  const content = extractEntryContent(obj, messageObj);
  const provenance = extractProvenance(obj, messageObj);

  if (!content) return null;
  return buildMessageEntry({
    kind: provenance.kind === "inter_session" ? "inter_session" : "message",
    role,
    author,
    content,
    timestamp,
    provenanceKind: provenance.kind,
    sourceSessionKey: provenance.sourceSessionKey,
    sourceTool: provenance.sourceTool,
  });
}

function parseToolEvent(obj: Record<string, unknown>): SessionHistoryMessage | null {
  const toolName = inferToolName(obj) ?? "tool";
  const toolStatus = firstString(obj, TOOL_STATUS_KEYS);
  const messageObj = asObject(obj.message);
  const role = extractRole(obj, messageObj) ?? "tool";
  const author = extractAuthor(obj, messageObj);
  const timestamp = extractTimestamp(obj, messageObj);

  const inputPreview = firstPreview(obj, TOOL_INPUT_KEYS, MAX_TOOL_SEGMENT_CHARS);
  const outputPreview = firstPreview(obj, TOOL_OUTPUT_KEYS, MAX_TOOL_SEGMENT_CHARS);
  const fallbackContent = extractEntryContent(obj, messageObj);

  const parts: string[] = [];
  if (inputPreview) parts.push(`in=${inputPreview}`);
  if (outputPreview) parts.push(`out=${outputPreview}`);

  const content = parts.length > 0 ? parts.join(" | ") : fallbackContent;
  if (!content) return null;

  return buildMessageEntry({
    kind: "tool_event",
    role,
    author,
    content,
    timestamp,
    toolName,
    toolStatus,
  });
}

function parseExecutionEvent(obj: Record<string, unknown>): SessionHistoryMessage | null {
  const eventKind = inferExecutionEventKind(obj);
  if (!eventKind) return null;

  const messageObj = asObject(obj.message);
  const role = extractRole(obj, messageObj) ?? "system";
  const author = extractAuthor(obj, messageObj);
  const timestamp = extractTimestamp(obj, messageObj);
  const toolName = inferToolName(obj);
  const toolStatus = firstString(obj, TOOL_STATUS_KEYS);
  const content = extractEntryContent(obj, messageObj) || `${eventKind} event`;
  const refs = extractExecutionSessionRefs(obj, content);

  return buildMessageEntry({
    kind: eventKind,
    role,
    author,
    content,
    timestamp,
    toolName,
    toolStatus,
    parentSessionKey: refs.parentSessionKey,
    childSessionKey: refs.childSessionKey,
  });
}

function parseExecutionEventFromText(content: string): SessionHistoryMessage | null {
  const kind = inferExecutionEventKindFromText(content);
  if (!kind) return null;
  const refs = extractExecutionSessionRefs({}, content);
  return buildMessageEntry({
    kind,
    role: "system",
    content,
    parentSessionKey: refs.parentSessionKey,
    childSessionKey: refs.childSessionKey,
    inferred: true,
  });
}

function buildMessageEntry(input: {
  kind: SessionHistoryKind;
  role: string;
  author?: string;
  content: string;
  timestamp?: string;
  toolName?: string;
  toolStatus?: string;
  parentSessionKey?: string;
  childSessionKey?: string;
  provenanceKind?: string;
  sourceSessionKey?: string;
  sourceTool?: string;
  inferred?: boolean;
}): SessionHistoryMessage {
  const truncatedContent = truncateText(input.content, MAX_ENTRY_CONTENT_CHARS);
  return {
    kind: input.kind,
    role: input.role,
    author: input.author,
    content: truncatedContent.text,
    timestamp: input.timestamp,
    toolName: input.toolName,
    toolStatus: input.toolStatus,
    truncated: truncatedContent.truncated || undefined,
    parentSessionKey: input.parentSessionKey,
    childSessionKey: input.childSessionKey,
    provenanceKind: input.provenanceKind,
    sourceSessionKey: input.sourceSessionKey,
    sourceTool: input.sourceTool,
    inferred: input.inferred || undefined,
  };
}

function extractProvenance(
  obj: Record<string, unknown>,
  messageObj?: Record<string, unknown>,
): { kind?: string; sourceSessionKey?: string; sourceTool?: string } {
  const provenanceObj = asObject(messageObj?.provenance) ?? asObject(obj.provenance);
  if (!provenanceObj) return {};
  return {
    kind: asString(provenanceObj.kind) ?? undefined,
    sourceSessionKey:
      firstString(provenanceObj, ["sourceSessionKey", "source_session_key", "sourceSession"]) ?? undefined,
    sourceTool: firstString(provenanceObj, ["sourceTool", "source_tool", "tool"]) ?? undefined,
  };
}

function extractInterSessionSignals(messages: SessionHistoryMessage[]): SessionInterSessionSignal[] {
  return messages
    .filter((message) => message.kind === "inter_session" && (message.sourceSessionKey ?? "").trim())
    .map((message) => ({
      sourceSessionKey: message.sourceSessionKey!.trim(),
      sourceTool: message.sourceTool,
      timestamp: message.timestamp,
      snippet: summarizeSnippet(message.content),
    }));
}

function looksLikeToolEvent(obj: Record<string, unknown>): boolean {
  const roleValue = (extractRole(obj, asObject(obj.message)) ?? "").toLowerCase();
  if (roleValue.includes("tool")) return true;

  const typeValue = (asString(obj.type) ?? "").toLowerCase();
  if (typeValue.includes("tool")) return true;

  const hasHint = TOOL_HINT_KEYS.some((key) => key in obj);
  if (!hasHint) return false;

  const hasName = Boolean(inferToolName(obj));
  if (hasName) return true;

  return TOOL_OUTPUT_KEYS.some((key) => key in obj) && TOOL_INPUT_KEYS.some((key) => key in obj);
}

function inferToolName(obj: Record<string, unknown>): string | undefined {
  const direct = firstString(obj, TOOL_NAME_KEYS);
  if (direct) return direct;

  const toolObj = asObject(obj.tool);
  if (toolObj) {
    const nested = firstString(toolObj, ["name", "toolName", "id", "key"]);
    if (nested) return nested;
  }

  const functionObj = asObject(obj.function);
  if (functionObj) {
    const nested = firstString(functionObj, ["name", "toolName"]);
    if (nested) return nested;
  }

  const callObj = asObject(obj.tool_call) ?? asObject(obj.toolCall);
  if (callObj) {
    const nested = firstString(callObj, ["name", "toolName", "id"]);
    if (nested) return nested;
  }

  return undefined;
}

function inferExecutionEventKind(obj: Record<string, unknown>): Extract<SessionHistoryKind, "accepted" | "spawn"> | undefined {
  const messageObj = asObject(obj.message);
  const signals = [
    ...EXECUTION_EVENT_KEYS.map((key) => firstString(obj, [key])),
    inferToolName(obj),
    extractEntryContent(obj, messageObj),
  ]
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.toLowerCase());

  for (const signal of signals) {
    const eventKind = inferExecutionEventKindFromText(signal);
    if (eventKind) return eventKind;
  }

  return undefined;
}

function inferExecutionEventKindFromText(input: string): Extract<SessionHistoryKind, "accepted" | "spawn"> | undefined {
  const lower = input.toLowerCase();
  if (/\bsessions?_spawn\b/.test(lower) || /\bspawn(?:ed|ing)?\b/.test(lower)) return "spawn";
  if (/\baccepted\b/.test(lower) || /\baccept(?:ed|ing)?\b/.test(lower)) return "accepted";
  return undefined;
}

function extractExecutionSessionRefs(
  obj: Record<string, unknown>,
  content: string,
): { parentSessionKey?: string; childSessionKey?: string } {
  const parentSessionKey = firstString(obj, [...PARENT_SESSION_KEYS]);
  const childSessionKey = firstString(obj, [...CHILD_SESSION_KEYS]);
  if (parentSessionKey && childSessionKey) {
    return { parentSessionKey, childSessionKey };
  }
  const contentKeys = extractSessionKeys(content);
  if (contentKeys.length >= 2) {
    return {
      parentSessionKey: parentSessionKey ?? contentKeys[0],
      childSessionKey: childSessionKey ?? contentKeys[1],
    };
  }
  return {
    parentSessionKey,
    childSessionKey,
  };
}

function extractSessionKeys(input: string): string[] {
  return [...new Set(input.match(SESSION_KEY_REGEX) ?? [])];
}

function firstPreview(
  obj: Record<string, unknown>,
  keys: string[],
  maxLength: number,
): string | undefined {
  for (const key of keys) {
    if (!(key in obj)) continue;
    const preview = previewValue(obj[key], maxLength);
    if (preview) return preview;
  }
  return undefined;
}

function previewValue(input: unknown, maxLength: number): string {
  if (input === undefined || input === null) return "";
  if (typeof input === "string") return truncateText(normalizeSpace(input), maxLength).text;
  if (typeof input === "number" || typeof input === "boolean") return String(input);

  try {
    return truncateText(normalizeSpace(JSON.stringify(input)), maxLength).text;
  } catch {
    return truncateText(normalizeSpace(String(input)), maxLength).text;
  }
}

function extractContent(obj: Record<string, unknown>): string {
  const directKeys = [
    "content",
    "text",
    "message",
    "body",
    "prompt",
    "output",
    "value",
    "summary",
    "response",
  ];

  for (const key of directKeys) {
    const text = extractText(obj[key], 0);
    if (text) return truncateText(normalizeSpace(text), MAX_ENTRY_CONTENT_CHARS).text;
  }

  return "";
}

function extractText(input: unknown, depth: number): string {
  if (depth > 4 || input === null || input === undefined) return "";
  if (typeof input === "string") return input;
  if (typeof input === "number" || typeof input === "boolean") return String(input);

  if (Array.isArray(input)) {
    const textBlocks = input
      .map((item) => extractStructuredTextBlock(item, depth + 1))
      .filter((item) => item.trim() !== "");
    if (textBlocks.length > 0) {
      return textBlocks.join(" ");
    }

    const thinkingBlocks = input
      .map((item) => extractStructuredThinkingBlock(item, depth + 1))
      .filter((item) => item.trim() !== "");
    if (thinkingBlocks.length > 0) {
      return thinkingBlocks.join(" ");
    }

    return input
      .map((item) => extractText(item, depth + 1))
      .filter((item) => item.trim() !== "")
      .join(" ");
  }

  const obj = asObject(input);
  if (!obj) return "";

  const structured = extractStructuredContentBlock(obj, depth);
  if (structured.trim() !== "") return structured;

  for (const key of ["text", "thinking", "content", "message", "body", "value", "summary", "output", "response"]) {
    const text = extractText(obj[key], depth + 1);
    if (text.trim() !== "") return text;
  }

  return "";
}

function extractStructuredContentBlock(input: unknown, depth: number): string {
  return (
    extractStructuredTextBlock(input, depth) ||
    extractStructuredThinkingBlock(input, depth)
  );
}

function extractStructuredTextBlock(input: unknown, depth: number): string {
  const obj = asObject(input);
  if (!obj || depth > 4) return "";

  const blockType = (firstString(obj, ROLE_TYPE_KEYS) ?? "").toLowerCase();
  if (blockType === "text" || blockType === "summary_text") {
    return extractText(obj.text ?? obj.content ?? obj.value, depth + 1);
  }

  return "";
}

function extractStructuredThinkingBlock(input: unknown, depth: number): string {
  const obj = asObject(input);
  if (!obj || depth > 4) return "";

  const blockType = (firstString(obj, ROLE_TYPE_KEYS) ?? "").toLowerCase();
  if (blockType === "thinking") {
    return extractText(obj.thinking ?? obj.text ?? obj.summary, depth + 1);
  }

  return "";
}

function extractRole(
  obj: Record<string, unknown>,
  messageObj?: Record<string, unknown>,
): string | undefined {
  for (const candidate of [messageObj, obj]) {
    if (!candidate) continue;
    const direct = firstString(candidate, ROLE_KEYS);
    if (direct) return direct;
    const roleLikeType = firstString(candidate, ROLE_TYPE_KEYS)?.toLowerCase();
    if (roleLikeType && KNOWN_ROLE_TYPES.has(roleLikeType)) {
      return roleLikeType;
    }
  }
  return undefined;
}

function extractAuthor(
  obj: Record<string, unknown>,
  messageObj?: Record<string, unknown>,
): string | undefined {
  return (messageObj ? firstString(messageObj, AUTHOR_KEYS) : undefined) ?? firstString(obj, AUTHOR_KEYS);
}

function extractTimestamp(
  obj: Record<string, unknown>,
  messageObj?: Record<string, unknown>,
): string | undefined {
  return normalizeTimestamp(firstValue(obj, TIME_KEYS) ?? firstValue(messageObj ?? {}, TIME_KEYS));
}

function extractEntryContent(
  obj: Record<string, unknown>,
  messageObj?: Record<string, unknown>,
): string {
  if (messageObj) {
    const nested = extractContent(messageObj);
    if (nested) return nested;
  }
  return extractContent(obj);
}

function normalizeHistoryFromText(raw: string): SessionHistoryMessage[] {
  if (!raw.trim()) return [];

  return raw
    .split(/\r?\n/)
    .map((line) => normalizeSpace(line))
    .filter((line) => line !== "")
    .map((line) => parseHistoryEntry(line))
    .filter((item): item is SessionHistoryMessage => Boolean(item));
}

function pickLatestMessage(messages: SessionHistoryMessage[]): SessionHistoryMessage | undefined {
  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    const candidate = messages[idx];
    if (candidate.content.trim() !== "") return candidate;
  }

  return undefined;
}

function inferSessionExecutionChain(
  session: SessionSummary,
  messages: SessionHistoryMessage[],
): SessionExecutionChainSummary | undefined {
  const fromHistory = inferSessionExecutionChainFromHistory(session, messages);
  if (fromHistory) return fromHistory;
  return inferSessionExecutionChainFromKey(session);
}

function inferSessionExecutionChainFromHistory(
  session: SessionSummary,
  messages: SessionHistoryMessage[],
): SessionExecutionChainSummary | undefined {
  const acceptedEntries = messages.filter((message) => message.kind === "accepted");
  const spawnEntries = messages.filter((message) => message.kind === "spawn");
  if (acceptedEntries.length === 0 && spawnEntries.length === 0) {
    return undefined;
  }

  const acceptedEntry = acceptedEntries.at(-1);
  const spawnEntry = spawnEntries.at(-1);
  const fallbackFromKey = inferSessionExecutionChainFromKey(session);

  const accepted = acceptedEntries.length > 0 || spawnEntries.length > 0 || Boolean(fallbackFromKey?.accepted);
  const spawned = spawnEntries.length > 0 || Boolean(fallbackFromKey?.spawned);
  const acceptedAt = acceptedEntry?.timestamp ?? spawnEntry?.timestamp ?? fallbackFromKey?.acceptedAt;
  const spawnedAt = spawnEntry?.timestamp ?? fallbackFromKey?.spawnedAt;
  const parentSessionKey =
    spawnEntry?.parentSessionKey ??
    acceptedEntry?.parentSessionKey ??
    fallbackFromKey?.parentSessionKey ??
    (spawnEntries.length > 0 ? session.sessionKey : undefined);
  const childSessionKey =
    spawnEntry?.childSessionKey ??
    acceptedEntry?.childSessionKey ??
    fallbackFromKey?.childSessionKey ??
    (isRunSessionKey(session.sessionKey) ? session.sessionKey : undefined);
  const stage = resolveExecutionChainStage(session.state, accepted, spawned);
  const inferred =
    Boolean(acceptedEntry?.inferred) ||
    Boolean(spawnEntry?.inferred) ||
    (spawnEntries.length === 0 && Boolean(fallbackFromKey?.spawned)) ||
    (acceptedEntries.length === 0 && Boolean(fallbackFromKey?.accepted));

  return {
    accepted,
    spawned,
    acceptedAt,
    spawnedAt,
    parentSessionKey,
    childSessionKey,
    stage,
    source: "history",
    inferred,
    detail: buildExecutionChainDetail({
      session,
      accepted,
      spawned,
      acceptedAt,
      spawnedAt,
      parentSessionKey,
      childSessionKey,
      source: "history",
      inferred,
    }),
  };
}

function inferSessionExecutionChainFromKey(
  session: SessionSummary,
): SessionExecutionChainSummary | undefined {
  const parentSessionKey = inferParentSessionKey(session.sessionKey);
  if (!parentSessionKey) return undefined;

  const accepted = true;
  const spawned = true;
  const stage = resolveExecutionChainStage(session.state, accepted, spawned);

  return {
    accepted,
    spawned,
    acceptedAt: session.lastMessageAt,
    spawnedAt: session.lastMessageAt,
    parentSessionKey,
    childSessionKey: session.sessionKey,
    stage,
    source: "session_key",
    inferred: true,
    detail: buildExecutionChainDetail({
      session,
      accepted,
      spawned,
      acceptedAt: session.lastMessageAt,
      spawnedAt: session.lastMessageAt,
      parentSessionKey,
      childSessionKey: session.sessionKey,
      source: "session_key",
      inferred: true,
    }),
  };
}

function resolveExecutionChainStage(
  sessionState: AgentRunState,
  accepted: boolean,
  spawned: boolean,
): SessionExecutionChainSummary["stage"] {
  if (sessionState === "running" || sessionState === "blocked" || sessionState === "waiting_approval" || sessionState === "error") {
    return "running";
  }
  if (spawned) return "spawned";
  if (accepted) return "accepted";
  return "idle";
}

function inferParentSessionKey(sessionKey: string): string | undefined {
  const marker = ":run:";
  const markerIndex = sessionKey.indexOf(marker);
  if (markerIndex <= 0) return undefined;
  return sessionKey.slice(0, markerIndex);
}

function isRunSessionKey(sessionKey: string): boolean {
  return inferParentSessionKey(sessionKey) !== undefined;
}

function buildExecutionChainDetail(input: {
  session: SessionSummary;
  accepted: boolean;
  spawned: boolean;
  acceptedAt?: string;
  spawnedAt?: string;
  parentSessionKey?: string;
  childSessionKey?: string;
  source: SessionExecutionChainSummary["source"];
  inferred: boolean;
}): string {
  const parts: string[] = [];
  parts.push(`accepted=${input.accepted ? "yes" : "no"}`);
  parts.push(`spawned=${input.spawned ? "yes" : "no"}`);
  if (input.parentSessionKey) parts.push(`parent=${input.parentSessionKey}`);
  if (input.childSessionKey) parts.push(`child=${input.childSessionKey}`);
  if (input.acceptedAt) parts.push(`acceptedAt=${input.acceptedAt}`);
  if (input.spawnedAt) parts.push(`spawnedAt=${input.spawnedAt}`);
  parts.push(`source=${input.source}`);
  if (input.inferred) parts.push("inferred=yes");
  return parts.join(" | ");
}

function compareSessions(a: SessionSummary, b: SessionSummary): number {
  const aTs = toMs(a.lastMessageAt);
  const bTs = toMs(b.lastMessageAt);

  if (aTs !== bTs) return bTs - aTs;
  return a.sessionKey.localeCompare(b.sessionKey);
}

function matchesSession(session: SessionSummary, filters: SessionConversationFilters): boolean {
  if (filters.state && session.state !== filters.state) return false;
  if (filters.agentId && (session.agentId ?? "").toLowerCase() !== filters.agentId.toLowerCase()) return false;

  const q = filters.q?.trim().toLowerCase();
  if (!q) return true;

  return (
    session.sessionKey.toLowerCase().includes(q) ||
    (session.label ?? "").toLowerCase().includes(q) ||
    (session.agentId ?? "").toLowerCase().includes(q)
  );
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
    return undefined;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }

  return undefined;
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  const value = firstValue(obj, keys);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function firstValue(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in obj) return obj[key];
  }

  return undefined;
}

function summarizeSnippet(input: string): string {
  const cleaned = normalizeSpace(input);
  if (cleaned.length <= MAX_SNIPPET_CHARS) return cleaned;
  return `${cleaned.slice(0, MAX_SNIPPET_CHARS - 3)}...`;
}

function normalizeSpace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function truncateText(input: string, maxLength: number): { text: string; truncated: boolean } {
  if (input.length <= maxLength) {
    return { text: input, truncated: false };
  }

  if (maxLength <= 3) {
    return { text: input.slice(0, Math.max(0, maxLength)), truncated: true };
  }

  return {
    text: `${input.slice(0, maxLength - 3)}...`,
    truncated: true,
  };
}

function toMs(value: string | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

function normalizePage(input: number): number {
  if (!Number.isFinite(input)) return 1;
  return Math.max(1, Math.trunc(input));
}

function normalizePageSize(input: number): number {
  if (!Number.isFinite(input)) return 20;
  return Math.max(1, Math.min(100, Math.trunc(input)));
}

function normalizeHistoryLimit(input: number, fallback = 8): number {
  if (!Number.isFinite(input)) return fallback;
  return Math.max(1, Math.min(200, Math.trunc(input)));
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Map an array with limited concurrency to avoid overwhelming the gateway
 * with too many parallel requests (prevents CPU spikes and timeouts).
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

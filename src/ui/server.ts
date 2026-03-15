import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import {
  APPROVAL_ACTIONS_DRY_RUN,
  APPROVAL_ACTIONS_ENABLED,
  IMPORT_MUTATION_DRY_RUN,
  IMPORT_MUTATION_ENABLED,
  LOCAL_API_TOKEN,
  LOCAL_TOKEN_AUTH_REQUIRED,
  LOCAL_TOKEN_HEADER,
  POLLING_INTERVALS_MS,
  READONLY_MODE,
} from "../config";
import type { ToolClient } from "../clients/tool-client";
import { mapSessionsListToSummaries } from "../mappers/openclaw-mappers";
import { buildApiDocs } from "../runtime/api-docs";
import { computeBudgetSummary } from "../runtime/budget-governance";
import { BUDGET_POLICY_PATH, loadBudgetPolicy } from "../runtime/budget-policy";
import { commanderExceptions, commanderExceptionsFeed } from "../runtime/commander";
import { buildCronOverview } from "../runtime/cron-overview";
import { buildDoneChecklist } from "../runtime/done-checklist";
import {
  filterAuditTimeline,
  loadAuditTimeline,
  type AuditSeverity,
  type AuditTimelineSnapshot,
} from "../runtime/audit-timeline";
import { loadLatestDigest, renderLatestDigestPage } from "../runtime/digest-renderer";
import { buildExportBundle, writeExportBundle } from "../runtime/export-bundle";
import { buildHealthzPayload } from "../runtime/healthz";
import { applyImportMutation, readImportMutationGuardState } from "../runtime/import-live";
import { validateExportBundleDryRun, validateExportFileDryRun } from "../runtime/import-dry-run";
import {
  evaluateLocalTokenGate,
  normalizeToken,
  readAuthorizationBearer,
} from "../runtime/local-token-auth";
import {
  loadCachedOpenClawConnectionSummary,
  loadCachedOpenClawMemorySummary,
  primeOpenClawCliInsights,
  loadCachedOpenClawSecuritySummary,
  loadCachedOpenClawUpdateSummary,
  type OpenClawConnectionSummary,
  type OpenClawInsightStatus,
  type OpenClawMemorySummary,
  type OpenClawSecuritySummary,
  type OpenClawUpdateSummary,
} from "../runtime/openclaw-cli-insights";
import { appendOperationAudit } from "../runtime/operation-audit";
import { ApprovalActionService } from "../runtime/approval-action-service";
import { buildActionQueueLinks } from "../runtime/action-queue-links";
import { loadReplayIndex, writeExportSnapshot } from "../runtime/replay-index";
import { buildNotificationPreview, loadNotificationPolicy } from "../runtime/notification-policy";
import {
  NotificationCenterValidationError,
  acknowledgeActionQueueItem,
  buildNotificationCenter,
  loadAcksStore,
  previewStaleAcksPrune,
} from "../runtime/notification-center";
import { buildPixelState } from "../runtime/pixel-state";
import { buildUsageCostSnapshot, type UsageCostMode, type UsageCostSnapshot } from "../runtime/usage-cost";
import { type StructuredChatDocEntry } from "../runtime/doc-hub";
import {
  PROJECT_STATES,
  PROJECTS_PATH,
  ProjectStoreValidationError,
  createProject,
  listProjects,
  loadProjectStore,
  updateProject,
} from "../runtime/project-store";
import { computeProjectSummaries } from "../runtime/project-summary";
import { computeTasksSummary } from "../runtime/task-summary";
import { readTaskHeartbeatRuns, runTaskHeartbeat, runtimeTaskHeartbeatGate } from "../runtime/task-heartbeat";
import {
  UI_QUICK_FILTERS,
  isUiLanguage,
  isUiQuickFilter,
  loadUiPreferences,
  saveUiPreferences,
  type UiLanguage,
  type UiPreferences,
  type UiQuickFilter,
} from "../runtime/ui-preferences";
import {
  TASKS_PATH,
  TaskStoreValidationError,
  createTask,
  listTasks,
  loadTaskStore,
  updateTaskStatus,
} from "../runtime/task-store";
import {
  getSessionConversationDetail,
  inferSessionExecutionChainFromSessionKey,
  listSessionConversations,
  type SessionConversationDetailResult,
  type SessionExecutionChainSummary,
  type SessionConversationListResult,
  type SessionConversationFilters,
  type SessionConversationListItem,
  type SessionHistoryMessage,
  type SessionInterSessionSignal,
} from "../runtime/session-conversations";
import { loadBestEffortAgentRoster, type AgentRosterEntry, type AgentRosterSnapshot } from "../runtime/agent-roster";
import {
  loadBestEffortOfficeSessionPresence,
  type OfficeSessionPresenceSnapshot,
} from "../runtime/office-session-presence";
import type {
  AgentRunState,
  BudgetEvaluation,
  BudgetMetricEvaluation,
  CommanderExceptionsFeed,
  DoneChecklistSnapshot,
  NotificationCenterSnapshot,
  ReadinessCategoryScore,
  ProjectState,
  ReadModelSnapshot,
  TaskListItem,
  TaskState,
} from "../types";

const SNAPSHOT_PATH = join(process.cwd(), "runtime", "last-snapshot.json");
const OPENCLAW_HOME_DIR = process.env.OPENCLAW_HOME?.trim() || join(homedir(), ".openclaw");
const OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH?.trim() || join(OPENCLAW_HOME_DIR, "openclaw.json");
const OPENCLAW_CONFIG_DIR = dirname(OPENCLAW_CONFIG_PATH);
const OPENCLAW_CRON_JOBS_CANDIDATES = [
  join(OPENCLAW_HOME_DIR, "cron", "jobs.json"),
  join(process.cwd(), "..", "..", "..", "..", "cron", "jobs.json"),
];
const DOCS_DIR = join(process.cwd(), "docs");
const README_PATH = join(process.cwd(), "README.md");
const AGENT_ROOT_DIR = process.env.OPENCLAW_AGENT_ROOT?.trim() || join(process.cwd(), "..");
const MEMORY_DIR_CANDIDATES = [
  join(AGENT_ROOT_DIR, "memory"),
  join(process.cwd(), "runtime", "digests"),
];
const LONG_TERM_MEMORY_FILE_CANDIDATES = [
  join(AGENT_ROOT_DIR, "MEMORY.md"),
  join(AGENT_ROOT_DIR, "USER.md"),
  join(AGENT_ROOT_DIR, "SOUL.md"),
  join(AGENT_ROOT_DIR, "IDENTITY.md"),
  join(OPENCLAW_HOME_DIR, "memory", "MEMORY.md"),
];
const DOC_HUB_DIR_CANDIDATES = [
  { dir: DOCS_DIR, category: "项目文档" },
  { dir: join(process.cwd(), "runtime", "digests"), category: "日报文档" },
  { dir: join(process.cwd(), "runtime", "evidence"), category: "证据报告" },
];
const DOC_HUB_CHAT_INDEX_PATH = join(process.cwd(), "runtime", "doc-hub-chat.json");
const HTML_HEAVY_CACHE_TTL_MS = 3_000;
const HTML_USAGE_CACHE_TTL_MS = 10_000;
const HTML_SNAPSHOT_CACHE_TTL_MS = 10_000;
const HTML_LIVE_SESSIONS_CACHE_TTL_MS = POLLING_INTERVALS_MS.sessionsList;
const HTML_REPLAY_CACHE_TTL_MS = 10_000;
const JSON_MAX_BYTES = 128 * 1024;
const FORM_MAX_BYTES = 16 * 1024;
const EDITABLE_TEXT_FILE_MAX_BYTES = 1024 * 1024;
const EDITABLE_TEXT_CONTENT_MAX_CHARS = 240_000;
const SEARCH_LIMIT_MAX = 200;
const TASK_RUNTIME_ACTIVITY_WINDOW_MS = 6 * 60 * 60 * 1000;
const STALLED_RUNNING_SESSION_WINDOW_MS = 2 * 60 * 60 * 1000;
const OPENCLAW_WORKSPACE_ROOT = resolveOpenClawWorkspaceRoot({
  explicitWorkspaceRoot: process.env.OPENCLAW_WORKSPACE_ROOT?.trim(),
  openclawHomeDir: OPENCLAW_HOME_DIR,
  configPath: OPENCLAW_CONFIG_PATH,
});
const WORKSPACE_EDITABLE_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);
const WORKSPACE_EDITABLE_EXTENSIONS = new Set([".md", ".markdown"]);
const MEMORY_EDITABLE_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
const SHARED_DOCUMENT_FILE_CANDIDATES = [
  "AGENTS.md",
  "IDENTITY.md",
  "SOUL.md",
  "USER.md",
  "TASKS.md",
  "BOOTSTRAP.md",
  "HEARTBEAT.md",
  "TOOLS.md",
  join(".learnings", "LEARNINGS.md"),
  join("control-center", "README.md"),
] as const;
const AGENT_DOCUMENT_FILE_CANDIDATES = [
  "AGENTS.md",
  "IDENTITY.md",
  "SOUL.md",
  "USER.md",
  "TASKS.md",
  "HEARTBEAT.md",
  "TOOLS.md",
  "README.md",
  "BOOTSTRAP.md",
  "NOTEBOOK.md",
  "focus.md",
  "inbox.md",
  "routines.md",
] as const;
const STAFF_ROLE_EVIDENCE_FILE_CANDIDATES = [
  "IDENTITY.md",
  "AGENTS.md",
  "README.md",
  "MEMORY.md",
  "focus.md",
  "routines.md",
  "inbox.md",
] as const;
const DASHBOARD_SEARCH_SCOPES = ["tasks", "projects", "sessions", "exceptions"] as const;
const DASHBOARD_SECTIONS = [
  "overview",
  "calendar",
  "team",
  "collaboration",
  "memory",
  "docs",
  "usage-cost",
  "office-space",
  "projects-tasks",
  "alerts",
  "replay-audit",
  "settings",
] as const;
const CONTROL_CENTER_MAPPING_TASK_IDS = new Set(["due-fast", "todo-second", "already-running", "unassigned"]);
const LEGACY_DASHBOARD_ROUTE_SECTION = {
  "/calendar": "projects-tasks",
  "/heartbeat": "overview",
  "/tools": "settings",
} as const;
const LEGACY_DASHBOARD_ROUTE_ANCHOR = {
  "/calendar": "calendar-board",
  "/heartbeat": "heartbeat-health",
  "/tools": "tool-connectors",
} as const;
function resolveOpenClawWorkspaceRoot(input: {
  explicitWorkspaceRoot?: string;
  openclawHomeDir: string;
  configPath: string;
}): string {
  const explicit = input.explicitWorkspaceRoot?.trim();
  if (explicit) return resolve(explicit);
  const configText = safeReadTextFileSync(input.configPath);
  const inferred = inferWorkspaceRootFromConfigText(configText, dirname(input.configPath));
  if (inferred) return inferred;
  return join(input.openclawHomeDir, "workspace");
}

function safeReadTextFileSync(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function inferWorkspaceRootFromConfigText(raw: string | undefined, configDir: string): string | undefined {
  if (!raw?.trim()) return undefined;
  try {
    return inferWorkspaceRootFromConfigObject(JSON.parse(raw) as unknown, configDir);
  } catch {
    return undefined;
  }
}

function inferWorkspaceRootFromConfigObject(input: unknown, configDir: string): string | undefined {
  const root = asObject(input);
  const agents = asObject(root?.agents);
  const list = asArray(agents?.list);
  const mainRow = list
    .map((item) => asObject(item))
    .find((row) => normalizeLookupKey(asString(row?.id)?.trim() ?? asString(row?.name)?.trim() ?? "") === "main");
  const explicitMainWorkspace = asString(mainRow?.workspace)?.trim();
  if (explicitMainWorkspace) return resolve(configDir, explicitMainWorkspace);

  const inferredRoots = new Set<string>();
  for (const item of list) {
    const row = asObject(item);
    const rawWorkspace = asString(row?.workspace)?.trim();
    if (!rawWorkspace) continue;
    const workspacePath = resolve(configDir, rawWorkspace);
    const parentDir = dirname(workspacePath);
    if (basename(parentDir).toLowerCase() !== "agents") continue;
    inferredRoots.add(dirname(parentDir));
  }
  if (inferredRoots.size === 1) return [...inferredRoots][0];
  return undefined;
}

export function resolveOpenClawWorkspaceRootForSmoke(input: {
  explicitWorkspaceRoot?: string;
  openclawHomeDir: string;
  configText?: string;
  configPath?: string;
}): string {
  const explicit = input.explicitWorkspaceRoot?.trim();
  if (explicit) return resolve(explicit);
  const configDir = dirname(input.configPath?.trim() || join(input.openclawHomeDir, "openclaw.json"));
  const inferred = inferWorkspaceRootFromConfigText(input.configText, configDir);
  if (inferred) return inferred;
  return join(input.openclawHomeDir, "workspace");
}

const TASK_STATES: TaskState[] = ["todo", "in_progress", "blocked", "done"];
const SESSION_STATES: AgentRunState[] = ["idle", "running", "blocked", "waiting_approval", "error"];
const DOC_LINKS = [
  { label: "README.md", href: "/docs/readme" },
  { label: "docs/RUNBOOK.md", href: "/docs/runbook" },
  { label: "docs/ARCHITECTURE.md", href: "/docs/architecture" },
  { label: "docs/PROGRESS.md", href: "/docs/progress" },
] as const;
const DASHBOARD_SECTION_LINKS_EN: DashboardSectionLink[] = [
  { key: "overview", label: "Overview", blurb: "Today at a glance" },
  { key: "usage-cost", label: "Usage", blurb: "Budget and quota" },
  { key: "team", label: "Staff", blurb: "Mission, staff and assignments" },
  { key: "collaboration", label: "Collaboration", blurb: "Agent handoffs and teamwork" },
  { key: "memory", label: "Memory", blurb: "Daily and long-term memories" },
  { key: "docs", label: "Documents", blurb: "Main and active agent core docs" },
  { key: "projects-tasks", label: "Tasks", blurb: "Board, schedule and activity" },
  { key: "settings", label: "Settings", blurb: "Safety and data links" },
] as const;
const ANIMAL_CATALOG = [
  {
    key: "robot",
    title: "Robot Operator",
    accent: "#8ad2ff",
    sprite: " [:::] \n |o o| \n | - | \n /|_|\\\\ ",
    keywords: ["robot", "android", "bot", "codex"],
  },
  {
    key: "lion",
    title: "Lion Captain",
    accent: "#ff9966",
    sprite: " /\\_/\\ \n( 0_0 )\n /|^|\\ \n  / \\  ",
    keywords: ["lion", "lead", "main", "chief", "alpha"],
  },
  {
    key: "panda",
    title: "Panda Strategist",
    accent: "#9df2ff",
    sprite: " /\\_/\\ \n( o.o )\n(  =  )\n /   \\ ",
    keywords: ["panda", "focus", "plan", "calm"],
  },
  {
    key: "monkey",
    title: "Monkey Builder",
    accent: "#f4c542",
    sprite: " /\\_/\\ \n( @.@ )\n /|_|\\ \n  / \\  ",
    keywords: ["monkey", "ape", "creative", "hack"],
  },
  {
    key: "dolphin",
    title: "Dolphin Navigator",
    accent: "#6ed8ff",
    sprite: "  __/\\ \n<( o )__\n /  .--'\n \\_/    ",
    keywords: ["dolphin", "wave", "flow", "sea"],
  },
  {
    key: "owl",
    title: "Owl Analyst",
    accent: "#f4ccff",
    sprite: " /\\_/\\ \n( O,O )\n(  V  )\n /   \\ ",
    keywords: ["owl", "watch", "audit", "night"],
  },
  {
    key: "fox",
    title: "Fox Courier",
    accent: "#ffb36e",
    sprite: " /\\_/\\ \n( ^.^ )\n /\\_/\\ \n  / \\  ",
    keywords: ["fox", "swift", "relay", "ops"],
  },
  {
    key: "bear",
    title: "Bear Guardian",
    accent: "#a4ffb0",
    sprite: " /\\_/\\ \n( -.- )\n(  U  )\n /   \\ ",
    keywords: ["bear", "guard", "shield", "safe"],
  },
  {
    key: "eagle",
    title: "Eagle Scout",
    accent: "#ffe07d",
    sprite: "  /\\_/\\\n==(o)==\n  /_\\  \n  / \\  ",
    keywords: ["eagle", "vision", "scan", "observer"],
  },
  {
    key: "tiger",
    title: "Tiger Sprinter",
    accent: "#ff8a7d",
    sprite: " /\\_/\\ \n( >.< )\n /|#|\\ \n  / \\  ",
    keywords: ["tiger", "stripe", "fast", "sprint"],
  },
  {
    key: "otter",
    title: "Otter Planner",
    accent: "#8ad1ff",
    sprite: " /\\_/\\ \n( o_o )\n /~~~\\ \n  / \\  ",
    keywords: ["otter", "water", "daily", "planner"],
  },
  {
    key: "rooster",
    title: "Rooster Herald",
    accent: "#ffb85e",
    sprite: "  __\n<(o )___\n ( ._> /\n  `---'  ",
    keywords: ["rooster", "cock", "coq", "chanticleer"],
  },
] as const;
const FALLBACK_ANIMAL_CATALOG = ANIMAL_CATALOG.filter((item) => item.key !== "robot");

type DashboardSearchScope = (typeof DASHBOARD_SEARCH_SCOPES)[number];
export type DashboardSection = (typeof DASHBOARD_SECTIONS)[number];

interface TaskQueryFilters {
  quick?: UiQuickFilter;
  status?: TaskState;
  owner?: string;
  project?: string;
}

interface ProjectQueryFilters {
  status?: ProjectState;
  owner?: string;
  projectId?: string;
}

interface SessionQuery {
  filters: SessionConversationFilters;
  page: number;
  pageSize: number;
  historyLimit: number;
}

interface SearchQuery {
  q: string;
  limit: number;
}

interface DashboardSearchQuery {
  scope: DashboardSearchScope;
  q: string;
  limit: number;
}

interface DashboardSearchResult {
  scope: DashboardSearchScope;
  q: string;
  limit: number;
  count: number;
  returned: number;
  rows: string;
}

type UsageView = "cumulative" | "today";

interface DashboardOptions {
  section: DashboardSection;
  language: UiLanguage;
  compactStatusStrip: boolean;
  usageView: UsageView;
  preferencesPath: string;
  search: DashboardSearchQuery;
}

interface DashboardSectionLink {
  key: DashboardSection;
  label: string;
  blurb: string;
}

interface MemoryEntry {
  day: string;
  title: string;
  excerpt: string;
  sourcePath: string;
}

interface TeamMemberSnapshot {
  agentId: string;
  displayName: string;
  model: string;
  workspace: string;
  toolsProfile: string;
}

interface TeamSnapshot {
  missionStatement: string;
  members: TeamMemberSnapshot[];
  sourcePath: string;
  detail: string;
}

interface DocEntry {
  title: string;
  excerpt: string;
  category: string;
  sourcePath: string;
  updatedAt: string;
  sourceType: "file" | "chat";
  sourceSessionKey?: string;
  sourceAgentId?: string;
}

type EditableFileScope = "memory" | "workspace";

interface EditableFileEntry {
  scope: EditableFileScope;
  title: string;
  excerpt: string;
  category: string;
  sourcePath: string;
  relativePath: string;
  updatedAt: string;
  size: number;
  facetKey?: string;
  facetLabel?: string;
}

interface EditableAgentScope {
  agentId: string;
  facetKey: string;
  facetLabel: string;
  workspaceRoot: string;
}

type EditableAgentScopeConfigStatus = "configured" | "config_missing" | "config_invalid";

let renderSessionPreviewCache:
  | { snapshotAt: string; value: SessionConversationListResult; expiresAt: number }
  | undefined;
let renderCollaborationPreviewCache:
  | { snapshotAt: string; value: SessionConversationListResult; expiresAt: number }
  | undefined;
let renderUsageCostSummaryCache:
  | { snapshotKey: string; value: UsageCostSnapshot; expiresAt: number }
  | undefined;
let renderUsageCostFullCache:
  | { snapshotKey: string; value: UsageCostSnapshot; expiresAt: number }
  | undefined;
let renderOfficePresenceCache:
  | { expiresAt: number; value: OfficeSessionPresenceSnapshot }
  | undefined;
let renderReplayPreviewCache:
  | {
      value: Awaited<ReturnType<typeof loadReplayIndex>>;
      expiresAt: number;
    }
  | undefined;
let renderStaffRecentActivityCache:
  | {
      snapshotAt: string;
      language: UiLanguage;
      agentKey: string;
      value: Map<string, StaffRecentActivity>;
      expiresAt: number;
    }
  | undefined;
let renderTaskEvidenceCache:
  | {
      snapshotAt: string;
      historyLimit: number;
      sessionKey: string;
      value: SessionConversationListItem[];
      expiresAt: number;
    }
  | undefined;
let renderSnapshotCache:
  | {
      sourceStamp: string;
      value: ReadModelSnapshot;
      expiresAt: number;
    }
  | undefined;
let renderSnapshotInFlight:
  | {
      sourceStamp: string;
      value: Promise<ReadModelSnapshot>;
    }
  | undefined;
let renderUsageCostSummaryInFlight:
  | {
      snapshotKey: string;
      value: Promise<UsageCostSnapshot>;
    }
  | undefined;
let renderUsageCostFullInFlight:
  | {
      snapshotKey: string;
      value: Promise<UsageCostSnapshot>;
    }
  | undefined;
let renderLiveSessionsCache:
  | {
      value: Awaited<ReturnType<ToolClient["sessionsList"]>>;
      expiresAt: number;
    }
  | undefined;
let renderLiveSessionsInFlight: Promise<Awaited<ReturnType<ToolClient["sessionsList"]>>> | undefined;
let renderReplayPreviewInFlight: Promise<Awaited<ReturnType<typeof loadReplayIndex>>> | undefined;

type GlobalVisibilityTaskStatus = "done" | "not_done";

interface GlobalVisibilityTaskRow {
  taskType: "cron" | "heartbeat" | "current_task" | "tool_call";
  taskTypeLabel: string;
  taskName: string;
  executor: string;
  currentAction: string;
  nextRun: string;
  latestResult: string;
  status: GlobalVisibilityTaskStatus;
  nextAction: string;
  detailsHref: string;
  detailsLabel: string;
}

interface GlobalVisibilityViewModel {
  tasks: GlobalVisibilityTaskRow[];
  doneCount: number;
  notDoneCount: number;
  noTaskMessage: string;
  signalCounts: {
    schedule: number;
    heartbeat: number;
    currentTasks: number;
    toolCalls: number;
  };
}

interface GlobalVisibilityCopy {
  title: string;
  summary: string;
  scheduleLabel: string;
  heartbeatLabel: string;
  currentTasksLabel: string;
  toolCallsLabel: string;
  scheduleLinkLabel: string;
  heartbeatLinkLabel: string;
  currentTasksLinkLabel: string;
  toolCallsLinkLabel: string;
  doneLabel: string;
  notDoneLabel: string;
  taskTypeLabel: string;
  taskNameLabel: string;
  executorLabel: string;
  currentActionLabel: string;
  nextRunLabel: string;
  latestResultLabel: string;
  statusLabel: string;
  nextActionLabel: string;
  detailsLabel: string;
  doneStatusText: string;
  notDoneStatusText: string;
}

interface OpenclawCronJobSummary {
  jobId: string;
  name: string;
  enabled: boolean;
  owner: string;
  ownerAgentId?: string;
  purpose: string;
  scheduleLabel: string;
  sourcePath: string;
}

interface AgentAnimalIdentity {
  animal: string;
  title: string;
  accent: string;
  sprite: string;
}

interface OfficeSpaceCard {
  agentId: string;
  identity: AgentAnimalIdentity;
  status: AgentRunState | "mixed" | "inactive";
  statusLabel: string;
  officeZone: "Builder Desks" | "Approval Desk" | "Support Bay" | "Standby Pods";
  activeSessions: number;
  activeTasks: number;
  focusItems: string[];
  summary: string;
}

interface ExecutionAgentSummary {
  agentId: string;
  displayName: string;
  activeSessions: number;
  activeTasks: number;
  enabledCronJobs: number;
  cronJobNames: string[];
  recentTokens30d: number;
}

interface StaffOverviewCard {
  agentId: string;
  displayName: string;
  identity: AgentAnimalIdentity;
  roleLabel: string;
  statusLabel: string;
  currentWorkLabel: string;
  currentWork: string;
  recentOutput: string;
  scheduledLabel: string;
}

interface StaffRecentActivity {
  recentOutput: string;
  recentOutputAt?: string;
  sessionKey?: string;
  statusOverride?: OfficeSpaceCard["status"];
}

type DataCoverageStatus = "connected" | "partial" | "not_connected";

interface InformationCertaintySignal {
  key: string;
  label: string;
  status: DataCoverageStatus;
  detail: string;
}

interface InformationCertaintyModel {
  score: number;
  badgeStatus: "ok" | "warn" | "blocked";
  badgeLabel: string;
  headline: string;
  summary: string;
  strengths: string[];
  gaps: string[];
  signals: InformationCertaintySignal[];
}

interface TaskExecutionChainCard {
  taskId?: string;
  taskTitle: string;
  projectTitle?: string;
  owner: string;
  sessionKey: string;
  agentId?: string;
  state: AgentRunState;
  latestAt?: string;
  latestSnippet?: string;
  executionChain: SessionExecutionChainSummary;
  sessionHref: string;
  taskHref?: string;
  unmapped?: boolean;
}

type CollaborationThreadStatus = "active" | "handoff" | "blocked" | "completed";
type CollaborationThreadKind = "parent_child" | "inter_session";

interface CollaborationParticipant {
  agentId: string;
  label: string;
  identity: AgentAnimalIdentity;
  current: boolean;
  roleLabel: string;
}

interface CollaborationThreadAggregateItem {
  sessionKey: string;
  sessionHref: string;
  latestAt?: string;
}

interface CollaborationTimelineStep {
  id: string;
  agentId: string;
  roleLabel?: string;
  title: string;
  detail: string;
  at?: string;
  tone: "ok" | "info" | "warn" | "blocked";
}

interface CollaborationThreadCard {
  id: string;
  kind: CollaborationThreadKind;
  sessionKey: string;
  taskTitle: string;
  routeTitle: string;
  summary: string;
  status: CollaborationThreadStatus;
  statusBadge: string;
  kindBadge: string;
  currentOwnerLabel: string;
  currentOwnerAgentId?: string;
  currentOwnerRole: "parent" | "child" | "source" | "target";
  latestAt?: string;
  latestAtLabel: string;
  participants: CollaborationParticipant[];
  routeJoiner: "→" | "⇄";
  multiAgent: boolean;
  mainDispatched: boolean;
  aggregateCount: number;
  aggregateItems: CollaborationThreadAggregateItem[];
  taskHref?: string;
  sessionHref: string;
  timeline: CollaborationTimelineStep[];
  latestSnippet: string;
  sourceLabel: string;
  parentSessionKey?: string;
  childSessionKey?: string;
}

interface TaskRoleSummary {
  owner: string;
  activeTasks: number;
  sampleTaskIds: string[];
}

interface TaskCertaintyCard {
  taskId: string;
  title: string;
  projectTitle: string;
  owner: string;
  score: number;
  tone: "ok" | "warn" | "blocked";
  toneLabel: string;
  summary: string;
  evidence: string[];
  gaps: string[];
  detailHref: string;
}

interface TaskDetailSessionSignal {
  sessionKey: string;
  agentId?: string;
  state: AgentRunState;
  latestAt?: string;
  latestSnippet?: string;
  sessionHref: string;
}

interface ParitySurfaceRow {
  id: string;
  name: string;
  route: string;
  status: "enabled" | "warn" | "disabled";
  detail: string;
}

interface BudgetBarModel {
  label: string;
  status: string;
  metric: string;
  used: number;
  limit: number;
  ratio: number;
}

interface GraphNode {
  id: string;
  type: "project" | "task" | "session" | "agent";
  label: string;
  status?: string;
}

interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: "project_task" | "task_session" | "agent_session" | "project_session";
}

interface LinkageGraph {
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  counts: {
    nodes: number;
    edges: number;
    projects: number;
    tasks: number;
    sessions: number;
    agents: number;
  };
}

export function startUiServer(port: number, toolClient: ToolClient): Server {
  const approvalActions = new ApprovalActionService(toolClient);

  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const requestId = resolveRequestId(req);
    res.setHeader("x-request-id", requestId);

    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;
      const legacySection = resolveLegacyDashboardSection(path);
      const legacyAnchor = resolveLegacyDashboardAnchor(path);

      if (method === "GET" && (path === "/" || legacySection)) {
        const prefs = await loadUiPreferences();
        if (prefs.issues.length > 0) {
          console.warn("[mission-control] ui preferences normalized", { requestId, issues: prefs.issues });
        }

        let filters = resolveDashboardTaskFilters(url.searchParams, prefs.preferences);
        const section = legacySection ?? resolveDashboardSection(url.searchParams);
        const resolvedLanguage = resolveUiLanguage(url.searchParams, prefs.preferences.language);
        const hasExplicitLanguage = hasAnyQueryKey(url.searchParams, ["lang"]);
        const language: UiLanguage = hasExplicitLanguage ? resolvedLanguage : "zh";
        const compactStatusStrip = resolveCompactStatusStrip(url.searchParams, prefs.preferences.compactStatusStrip);
        const usageView = resolveUsageView(url.searchParams);
        const search = resolveDashboardSearchQuery(url.searchParams);
        const hasTaskFilterQuery = hasAnyQueryKey(url.searchParams, ["quick", "status", "owner", "project"]);

        if (section === "projects-tasks" && !hasTaskFilterQuery) {
          filters = { quick: "all" };
        }

        if (path !== "/") {
          const target = `${buildHomeHref(filters, compactStatusStrip, section, language, usageView)}${legacyAnchor ? `#${legacyAnchor}` : ""}`;
          return redirect(res, 302, target);
        }

        if (hasAnyQueryKey(url.searchParams, ["quick", "status", "owner", "project", "compact", "lang", "usage_view"])) {
          await saveUiPreferences({
            language,
            compactStatusStrip,
            quickFilter: filters.quick ?? "all",
            taskFilters: {
              status: filters.status,
              owner: filters.owner,
              project: filters.project,
            },
            updatedAt: new Date().toISOString(),
          });
        }

        const html = await renderHtml(filters, toolClient, {
          section,
          language,
          compactStatusStrip,
          usageView,
          preferencesPath: prefs.path,
          search,
        });
        return writeText(res, 200, html, "text/html; charset=utf-8");
      }

      if (method === "GET" && path === "/docs") {
        assertAllowedQueryParams(url.searchParams, ["lang"], true);
        const language = resolveUiLanguage(url.searchParams, "zh");
        const t = (en: string, zh: string): string => pickUiText(language, en, zh);
        const links = DOC_LINKS.map(
          (item) => `<li><a href="${item.href}?lang=${encodeURIComponent(language)}">${escapeHtml(item.label)}</a></li>`,
        ).join("");
        const docsHref = buildHomeHref({ quick: "all" }, true, "docs", language);
        const homeHref = buildHomeHref({ quick: "all" }, true, "overview", language);
        const html = `<!doctype html><html><head><meta charset="utf-8" /><title>${escapeHtml(t("OpenClaw Control Center Docs", "OpenClaw Control Center 文档"))}</title></head><body><h1>${escapeHtml(t("OpenClaw Control Center Docs", "OpenClaw Control Center 文档"))}</h1><ul>${links}</ul><p><a href="${escapeHtml(docsHref)}">${escapeHtml(t("Open document workbench", "打开文档工作台"))}</a> · <a href="${escapeHtml(homeHref)}">${escapeHtml(t("Back to control center", "返回控制中心"))}</a></p></body></html>`;
        return writeText(res, 200, html, "text/html; charset=utf-8");
      }

      if (method === "GET" && path.startsWith("/docs/")) {
        assertAllowedQueryParams(url.searchParams, ["lang"], true);
        const docId = path.slice("/docs/".length);
        const docPath = resolveDocPath(docId);
        if (!docPath) {
          return writeApiError(res, 404, "NOT_FOUND", "Unknown docs route.");
        }
        let body = "";
        try {
          body = await readFile(docPath, "utf8");
        } catch {
          return writeApiError(res, 404, "NOT_FOUND", "Doc file not found.");
        }
        return writeText(res, 200, body, "text/markdown; charset=utf-8");
      }

      if (method === "GET" && path === "/snapshot") {
        assertAllowedQueryParams(url.searchParams, [], true);
        const body = await readSnapshotRaw();
        return writeText(res, 200, body, "application/json; charset=utf-8");
      }

      if (method === "GET" && (path === "/graph" || path === "/api/graph")) {
        assertAllowedQueryParams(url.searchParams, [], true);
        const snapshot = await readReadModelSnapshot();
        return writeJson(res, 200, {
          ok: true,
          graph: buildLinkageGraph(snapshot),
        });
      }

      if (method === "GET" && path === "/view/pixel-state.json") {
        assertAllowedQueryParams(url.searchParams, [], true);
        const snapshot = await readReadModelSnapshot();
        return writeJson(res, 200, {
          ok: true,
          state: buildPixelState(snapshot),
        });
      }

      if (
        method === "GET" &&
        (path === "/export/state.json" || path === "/api/export/state.json")
      ) {
        assertAllowedQueryParams(url.searchParams, [], true);
        assertMutationAuthorized(req, "/api/export/state.json");
        const snapshot = await readReadModelSnapshot();
        const exportPayload = await buildExportBundle(snapshot, "api", requestId);
        let exportSnapshot;
        let backupExport;
        try {
          [exportSnapshot, backupExport] = await Promise.all([
            writeExportSnapshot(exportPayload as unknown as Record<string, unknown>, requestId),
            writeExportBundle(exportPayload, "backup"),
          ]);
          await appendOperationAudit({
            action: "backup_export",
            source: "api",
            ok: true,
            requestId,
            detail: `wrote ${backupExport.fileName}`,
            metadata: {
              path: backupExport.path,
              sizeBytes: backupExport.sizeBytes,
            },
          });
        } catch (error) {
          await appendOperationAudit({
            action: "backup_export",
            source: "api",
            ok: false,
            requestId,
            detail: error instanceof Error ? error.message : "backup export failed",
          });
          throw error;
        }
        return writeJson(res, 200, {
          ...exportPayload,
          exportSnapshot,
          backupExport,
        });
      }

      if (method === "GET" && (path === "/done-checklist" || path === "/api/done-checklist")) {
        assertAllowedQueryParams(url.searchParams, [], true);
        const snapshot = await readReadModelSnapshot();
        const checklist = await buildDoneChecklist(snapshot);
        return writeJson(res, 200, {
          ok: true,
          checklist,
        });
      }

      if (method === "GET" && path === "/api/docs") {
        assertAllowedQueryParams(url.searchParams, [], true);
        return writeJson(res, 200, {
          ok: true,
          docs: buildApiDocs(),
        });
      }

      if (method === "GET" && path === "/api/files") {
        assertAllowedQueryParams(url.searchParams, ["scope"], true);
        const scopeParam = normalizeQueryString(url.searchParams.get("scope"), "scope", 24, true);
        const scope = normalizeEditableFileScope(scopeParam);
        if (!scope) {
          throw new RequestValidationError("scope must be one of: memory, workspace", 400);
        }
        const files = await listEditableFiles(scope);
        return writeJson(res, 200, {
          ok: true,
          scope,
          count: files.length,
          files,
        });
      }

      if (method === "GET" && path === "/api/files/content") {
        assertAllowedQueryParams(url.searchParams, ["scope", "path"], true);
        const scopeParam = normalizeQueryString(url.searchParams.get("scope"), "scope", 24, true);
        const filePath = normalizeQueryString(url.searchParams.get("path"), "path", 4096, true);
        const scope = normalizeEditableFileScope(scopeParam);
        if (!scope) {
          throw new RequestValidationError("scope must be one of: memory, workspace", 400);
        }
        if (!filePath) {
          throw new RequestValidationError("path is required.", 400);
        }
        const payload = await readEditableFile(scope, filePath);
        if (!payload) {
          return writeApiError(res, 404, "NOT_FOUND", "Editable file not found in allowed scope.");
        }
        return writeJson(res, 200, {
          ok: true,
          scope,
          entry: payload.entry,
          content: payload.content,
        });
      }

      if ((method === "PUT" || method === "PATCH") && path === "/api/files/content") {
        assertMutationAuthorized(req, "/api/files/content");
        assertJsonContentType(req);
        const payload = expectObject(await readJsonBody(req), "editable file payload");
        const scope = normalizeEditableFileScope(optionalBoundedString(payload.scope, "scope", 24));
        const filePath = optionalBoundedString(payload.path, "path", 4096);
        const content = boundedTextField(payload.content, "content", EDITABLE_TEXT_CONTENT_MAX_CHARS);
        if (!scope) {
          throw new RequestValidationError("scope must be one of: memory, workspace", 400);
        }
        if (!filePath) {
          throw new RequestValidationError("path is required.", 400);
        }
        const saved = await writeEditableFileContent(scope, filePath, content);
        if (!saved) {
          return writeApiError(res, 404, "NOT_FOUND", "Editable file not found in allowed scope.");
        }
        return writeJson(res, 200, {
          ok: true,
          scope,
          entry: saved.entry,
          content: saved.content,
        });
      }

      if (method === "GET" && path === "/api/ui/preferences") {
        assertAllowedQueryParams(url.searchParams, [], true);
        const prefs = await loadUiPreferences();
        return writeJson(res, 200, {
          ok: true,
          path: prefs.path,
          preferences: prefs.preferences,
          issues: prefs.issues,
        });
      }

      if (method === "PATCH" && path === "/api/ui/preferences") {
        assertMutationAuthorized(req, "/api/ui/preferences");
        assertJsonContentType(req);
        const payload = expectObject(await readJsonBody(req), "ui preferences payload");
        const current = await loadUiPreferences();
        const merged = mergeUiPreferencesPatch(current.preferences, payload);
        const saved = await saveUiPreferences(merged);
        return writeJson(res, 200, {
          ok: true,
          path: saved.path,
          preferences: saved.preferences,
          issues: saved.issues,
        });
      }

      if (method === "GET" && path === "/api/search/tasks") {
        const query = parseSearchQuery(url.searchParams);
        const snapshot = await readReadModelSnapshot();
        const matches = listTasks(snapshot.tasks, projectTitleMap(snapshot))
          .filter((task) =>
            safeSubstringMatch(
              query.q,
              task.taskId,
              task.title,
              task.owner,
              task.projectId,
              task.projectTitle,
              task.dueAt,
              task.status,
            ),
          );
        const tasks = matches.slice(0, query.limit);
        return writeJson(res, 200, {
          ok: true,
          scope: "tasks",
          query,
          count: matches.length,
          returned: tasks.length,
          items: tasks,
        });
      }

      if (method === "GET" && path === "/api/search/projects") {
        const query = parseSearchQuery(url.searchParams);
        const snapshot = await readReadModelSnapshot();
        const matches = snapshot.projects.projects
          .filter((project) =>
            safeSubstringMatch(
              query.q,
              project.projectId,
              project.title,
              project.owner,
              project.status,
            ),
          );
        const projects = matches.slice(0, query.limit);
        return writeJson(res, 200, {
          ok: true,
          scope: "projects",
          query,
          count: matches.length,
          returned: projects.length,
          items: projects,
        });
      }

      if (method === "GET" && path === "/api/search/sessions") {
        const query = parseSearchQuery(url.searchParams);
        const snapshot = await readReadModelSnapshotWithLiveSessions(toolClient);
        const matches = snapshot.sessions
          .filter((session) =>
            safeSubstringMatch(
              query.q,
              session.sessionKey,
              session.label,
              session.agentId,
              session.state,
              session.lastMessageAt,
            ),
          );
        const sessions = matches.slice(0, query.limit);
        return writeJson(res, 200, {
          ok: true,
          scope: "sessions",
          query,
          count: matches.length,
          returned: sessions.length,
          items: sessions,
        });
      }

      if (method === "GET" && path === "/api/search/exceptions") {
        const query = parseSearchQuery(url.searchParams);
        const snapshot = await readReadModelSnapshot();
        const feed = commanderExceptionsFeed(snapshot);
        const matches = feed.items
          .filter((item) =>
            safeSubstringMatch(
              query.q,
              item.level,
              item.code,
              item.source,
              item.sourceId,
              item.route,
              item.message,
            ),
          );
        const items = matches.slice(0, query.limit);
        return writeJson(res, 200, {
          ok: true,
          scope: "exceptions",
          query,
          count: matches.length,
          returned: items.length,
          items,
        });
      }

      if (method === "GET" && path === "/api/usage-cost") {
        assertAllowedQueryParams(url.searchParams, [], true);
        const snapshot = await readReadModelSnapshot();
        const usage = await buildUsageCostSnapshot(snapshot);
        return writeJson(res, 200, {
          ok: true,
          usage,
        });
      }

      if (method === "GET" && path === "/api/subscription/template") {
        assertAllowedQueryParams(url.searchParams, [], true);
        return writeJson(res, 200, {
          ok: true,
          template: {
            subscription: {
              planLabel: "OpenClaw Team Plan",
              unit: "USD",
              consumed: 120,
              remaining: 880,
              limit: 1000,
              cycleStart: "2026-03-01",
              cycleEnd: "2026-03-31",
            },
          },
          hint: `Save as ${join(process.cwd(), "runtime", "subscription-snapshot.json")}`,
        });
      }

      if (method === "GET" && path === "/api/tasks/heartbeat") {
        assertAllowedQueryParams(url.searchParams, ["limit"], true);
        const limit = readPositiveIntQuery(url.searchParams.get("limit"), "limit", 20, true, 200);
        const runs = await readTaskHeartbeatRuns(limit);
        return writeJson(res, 200, {
          ok: true,
          path: runs.path,
          count: runs.count,
          runs: runs.runs,
        });
      }

      if (method === "POST" && path === "/api/tasks/heartbeat") {
        assertMutationAuthorized(req, "/api/tasks/heartbeat");
        assertAllowedQueryParams(url.searchParams, [], true);
        assertJsonContentType(req);
        const payload = expectObject(await readJsonBody(req), "task heartbeat payload");
        const gate = runtimeTaskHeartbeatGate();
        if (payload.dryRun !== undefined) {
          if (typeof payload.dryRun !== "boolean") {
            throw new RequestValidationError("dryRun must be a boolean when provided.", 400);
          }
          gate.dryRun = payload.dryRun;
        }
        const maxTasksPerRun = optionalIntegerField(payload.maxTasksPerRun, "maxTasksPerRun", 1, 200);
        if (maxTasksPerRun !== undefined) gate.maxTasksPerRun = maxTasksPerRun;
        const result = await runTaskHeartbeat({ gate });
        return writeJson(res, result.mode === "blocked" ? 403 : 200, result);
      }

      if (method === "GET" && path === "/usage-cost") {
        assertAllowedQueryParams(url.searchParams, [], true);
        res.statusCode = 302;
        res.setHeader("location", "/?section=usage-cost");
        return writeText(res, 302, "redirecting", "text/plain; charset=utf-8");
      }

      if (method === "GET" && path === "/api/replay/index") {
        assertAllowedQueryParams(url.searchParams, ["timelineLimit", "digestLimit", "exportLimit", "from", "to"], true);
        const replayWindow = parseReplayWindowQuery(url.searchParams, true);
        const replay = await loadReplayIndex({
          timelineLimit: readPositiveIntQuery(
            url.searchParams.get("timelineLimit"),
            "timelineLimit",
            80,
            true,
            400,
          ),
          digestLimit: readPositiveIntQuery(url.searchParams.get("digestLimit"), "digestLimit", 30, true, 200),
          exportLimit: readPositiveIntQuery(url.searchParams.get("exportLimit"), "exportLimit", 30, true, 200),
          from: replayWindow.from,
          to: replayWindow.to,
        });
        return writeJson(res, 200, {
          ok: true,
          replay,
        });
      }

      if (method === "POST" && path === "/api/import/dry-run") {
        assertMutationAuthorized(req, "/api/import/dry-run");
        assertJsonContentType(req);
        const payload = expectObject(await readJsonBody(req), "import dry-run payload");
        let validation;

        if (typeof payload.fileName === "string" && payload.fileName.trim() !== "") {
          validation = await validateExportFileDryRun(payload.fileName);
        } else if (payload.bundle !== undefined) {
          validation = validateExportBundleDryRun(payload.bundle, "payload.bundle");
        } else {
          validation = validateExportBundleDryRun(payload, "payload");
        }

        await appendOperationAudit({
          action: "import_dry_run",
          source: "api",
          ok: validation.valid,
          requestId,
          detail: `validated ${validation.source}`,
          metadata: {
            valid: validation.valid,
            issues: validation.issues.length,
            warnings: validation.warnings.length,
          },
        });

        return writeJson(res, 200, {
          ok: validation.valid,
          validation,
        });
      }

      if (method === "POST" && path === "/api/import/live") {
        assertMutationAuthorized(req, "/api/import/live");
        assertJsonContentType(req);
        const payload = expectObject(await readJsonBody(req), "import live payload");
        const result = await applyImportMutation({
          fileName: typeof payload.fileName === "string" ? payload.fileName : undefined,
          bundle: payload.bundle !== undefined ? payload.bundle : payload,
          dryRun: typeof payload.dryRun === "boolean" ? payload.dryRun : undefined,
        });

        await appendOperationAudit({
          action: "import_apply",
          source: "api",
          ok: result.ok,
          requestId,
          detail: `${result.mode} ${result.source ?? "payload"}: ${result.message}`,
          metadata: {
            mode: result.mode,
            statusCode: result.statusCode,
            valid: result.validation?.valid ?? false,
            issues: result.validation?.issues.length ?? 0,
            warnings: result.validation?.warnings.length ?? 0,
          },
        });

        return writeJson(res, result.statusCode, result);
      }

      if (method === "GET" && (path === "/projects" || path === "/api/projects")) {
        const projectStore = await loadProjectStore();
        const filters = parseProjectFilters(url.searchParams, path === "/api/projects");
        const projects = applyProjectFilters(listProjects(projectStore), filters);
        return writeJson(res, 200, {
          ok: true,
          updatedAt: projectStore.updatedAt,
          count: projects.length,
          filters,
          projects,
        });
      }

      if (method === "POST" && path === "/api/projects") {
        assertMutationAuthorized(req, "/api/projects");
        assertJsonContentType(req);
        const payload = expectObject(await readJsonBody(req), "create project payload");
        const created = await createProject(payload);
        return writeJson(res, 201, { ok: true, ...created });
      }

      if (method === "PATCH" && path.startsWith("/api/projects/")) {
        assertMutationAuthorized(req, "/api/projects/:projectId");
        assertJsonContentType(req);
        const projectId = decodeRouteParam(path, /^\/api\/projects\/([^/]+)$/, "projectId");
        const payload = expectObject(await readJsonBody(req), "update project payload");
        const updated = await updateProject({
          ...payload,
          projectId,
        });
        return writeJson(res, 200, { ok: true, ...updated });
      }

      if (method === "GET" && (path === "/tasks" || path === "/api/tasks")) {
        const snapshot = await readReadModelSnapshot();
        const filters = parseTaskFilters(url.searchParams, path === "/api/tasks");
        const allTasks = listTasks(snapshot.tasks, projectTitleMap(snapshot));
        const filteredTasks = applyTaskFilters(allTasks, filters);
        return writeJson(res, 200, {
          ok: true,
          updatedAt: snapshot.tasks.updatedAt,
          count: filteredTasks.length,
          filters,
          tasks: filteredTasks,
        });
      }

      if (method === "POST" && path === "/api/tasks") {
        assertMutationAuthorized(req, "/api/tasks");
        assertJsonContentType(req);
        const payload = expectObject(await readJsonBody(req), "create task payload");
        const created = await createTask(payload);
        return writeJson(res, 201, { ok: true, ...created });
      }

      if (method === "PATCH" && path.startsWith("/api/tasks/") && path.endsWith("/status")) {
        assertMutationAuthorized(req, "/api/tasks/:taskId/status");
        assertJsonContentType(req);
        const taskId = decodeRouteParam(path, /^\/api\/tasks\/([^/]+)\/status$/, "taskId");
        const payload = expectObject(await readJsonBody(req), "update task status payload");
        const updated = await updateTaskStatus({
          taskId,
          status: payload.status,
          projectId: payload.projectId,
        });
        return writeJson(res, 200, { ok: true, ...updated });
      }

      if (method === "GET" && (path === "/sessions" || path === "/api/sessions")) {
        const snapshot = await readReadModelSnapshotWithLiveSessions(toolClient);
        const strict = path === "/api/sessions";
        const query = parseSessionQuery(url.searchParams, strict);
        const sessions = await listSessionConversations({
          snapshot,
          client: toolClient,
          filters: query.filters,
          page: query.page,
          pageSize: query.pageSize,
          historyLimit: query.historyLimit,
        });

        return writeJson(res, 200, {
          ok: true,
          ...sessions,
        });
      }

      if (method === "GET" && path.startsWith("/api/sessions/")) {
        const snapshot = await readReadModelSnapshotWithLiveSessions(toolClient);
        const sessionKey = decodeRouteParam(path, /^\/api\/sessions\/([^/]+)$/, "sessionKey");
        assertAllowedQueryParams(url.searchParams, ["historyLimit"], true);
        const historyLimit = readPositiveIntQuery(
          url.searchParams.get("historyLimit"),
          "historyLimit",
          50,
          true,
          200,
        );
        const detail = await getSessionConversationDetail({
          snapshot,
          client: toolClient,
          sessionKey,
          historyLimit,
        });

        if (!detail) {
          return writeApiError(res, 404, "NOT_FOUND", `Session '${sessionKey}' was not found.`);
        }

        return writeJson(res, 200, {
          ok: true,
          ...detail,
        });
      }

      if (method === "GET" && path.startsWith("/sessions/")) {
        const snapshot = await readReadModelSnapshotWithLiveSessions(toolClient);
        const sessionKey = decodeRouteParam(path, /^\/sessions\/([^/]+)$/, "sessionKey");
        const historyLimit = readPositiveIntQuery(url.searchParams.get("historyLimit"), "historyLimit", 50, false);
        const detail = await getSessionConversationDetail({
          snapshot,
          client: toolClient,
          sessionKey,
          historyLimit,
        });

        if (!detail) {
          return writeApiError(res, 404, "NOT_FOUND", `Session '${sessionKey}' was not found.`);
        }

        return writeJson(res, 200, {
          ok: true,
          ...detail,
        });
      }

      if (method === "GET" && path.startsWith("/session/")) {
        const snapshot = await readReadModelSnapshotWithLiveSessions(toolClient);
        const language = resolveUiLanguage(url.searchParams, "zh");
        const sessionKey = decodeRouteParam(path, /^\/session\/([^/]+)$/, "sessionKey");
        assertAllowedQueryParams(url.searchParams, ["historyLimit"], false);
        const historyLimit = readPositiveIntQuery(
          url.searchParams.get("historyLimit"),
          "historyLimit",
          50,
          false,
          200,
        );
        const detail = await getSessionConversationDetail({
          snapshot,
          client: toolClient,
          sessionKey,
          historyLimit,
        });

        if (!detail) {
          return writeText(res, 404, "Session not found", "text/plain; charset=utf-8");
        }

        const html = renderSessionDrilldownPage(detail, language);
        return writeText(res, 200, html, "text/html; charset=utf-8");
      }

      if (method === "GET" && path.startsWith("/details/task/")) {
        const snapshot = await readReadModelSnapshotWithLiveSessions(toolClient);
        const language = resolveUiLanguage(url.searchParams, "zh");
        const taskId = decodeRouteParam(path, /^\/details\/task\/([^/]+)$/, "taskId");
        const tasks = listTasks(snapshot.tasks, projectTitleMap(snapshot));
        const task = tasks.find((item) => item.taskId === taskId);
        if (!task) {
          return writeText(res, 404, "Task not found", "text/plain; charset=utf-8");
        }
        const linkedSessionItems = await loadSessionConversationItemsByKeys(snapshot, toolClient, task.sessionKeys, 24);
        const certaintyCard = buildTaskCertaintyCards({
          tasks: [task],
          sessions: snapshot.sessions,
          sessionItems: linkedSessionItems,
          approvals: snapshot.approvals,
          language,
        })[0];
        const linkedSessions: TaskDetailSessionSignal[] = linkedSessionItems.map((detail) => ({
          sessionKey: detail.sessionKey,
          agentId: detail.agentId,
          state: detail.state,
          latestAt: pickLatestSessionActivityTimestamp(detail.latestHistoryAt, detail.lastMessageAt),
          latestSnippet: detail.latestSnippet,
          sessionHref: buildSessionDetailHref(detail.sessionKey, language),
        }));
        const html = renderTaskDetailPage({
          task,
          generatedAt: snapshot.generatedAt ?? new Date().toISOString(),
          certaintyCard,
          linkedSessions,
          language,
        });
        return writeText(res, 200, html, "text/html; charset=utf-8");
      }

      if (method === "GET" && path.startsWith("/details/cron/")) {
        const snapshot = await readReadModelSnapshot();
        const language = resolveUiLanguage(url.searchParams, "zh");
        const jobId = decodeRouteParam(path, /^\/details\/cron\/([^/]+)$/, "jobId");
        const overview = await buildCronOverview(snapshot, POLLING_INTERVALS_MS.cron);
        const catalog = await loadOpenclawCronCatalog(language);
        const runtimeById = new Map(overview.jobs.map((job) => [job.jobId, job]));
        const catalogJob = catalog.find((item) => item.jobId === jobId);
        const runtimeJob = runtimeById.get(jobId);
        if (!catalogJob && !runtimeJob) {
          return writeText(res, 404, "Cron job not found", "text/plain; charset=utf-8");
        }
        const html = renderCronJobDetailPage(
          {
            jobId,
            name: catalogJob?.name ?? runtimeJob?.name ?? jobId,
            owner: catalogJob?.owner ?? formatExecutorAgentLabel("system-cron", language),
            purpose: catalogJob?.purpose ?? cronRuntimePurpose(jobId, language),
            schedule: catalogJob?.scheduleLabel ?? pickUiText(language, "system interval", "系统间隔"),
            status: runtimeJob ? runtimeJob.health : catalogJob?.enabled ? "enabled" : "disabled",
            nextRunAt: runtimeJob?.nextRunAt ?? "-",
            dueInSeconds: runtimeJob?.dueInSeconds,
          },
          snapshot.generatedAt ?? new Date().toISOString(),
          language,
        );
        return writeText(res, 200, html, "text/html; charset=utf-8");
      }

      if (method === "GET" && path === "/api/audit") {
        const snapshot = await readReadModelSnapshot();
        const severity = parseAuditSeverity(url.searchParams, true);
        const timeline = filterAuditTimeline(await loadAuditTimeline(snapshot), severity);
        return writeJson(res, 200, {
          ok: true,
          severity,
          timeline,
        });
      }

      if (method === "GET" && path === "/audit") {
        const snapshot = await readReadModelSnapshot();
        const severity = parseAuditSeverity(url.searchParams, false);
        const timeline = filterAuditTimeline(await loadAuditTimeline(snapshot), severity);
        const html = renderAuditPage(timeline, severity);
        return writeText(res, 200, html, "text/html; charset=utf-8");
      }

      if (method === "GET" && path === "/api/commander/exceptions") {
        assertAllowedQueryParams(url.searchParams, [], true);
        const snapshot = await readReadModelSnapshot();
        return writeJson(res, 200, {
          ok: true,
          exceptions: commanderExceptions(snapshot),
        });
      }

      if (method === "GET" && path === "/exceptions") {
        assertAllowedQueryParams(url.searchParams, [], true);
        const snapshot = await readReadModelSnapshot();
        return writeJson(res, 200, {
          ok: true,
          feed: commanderExceptionsFeed(snapshot),
        });
      }

      if (method === "GET" && path === "/notifications/preview") {
        assertAllowedQueryParams(url.searchParams, ["at"], true);
        const atParam = normalizeQueryString(url.searchParams.get("at"), "at", 64, true);
        let evaluatedAt = new Date();
        if (atParam) {
          const ms = Date.parse(atParam);
          if (Number.isNaN(ms)) {
            throw new RequestValidationError("at must be a valid ISO date-time string.", 400);
          }
          evaluatedAt = new Date(ms);
        }

        const snapshot = await readReadModelSnapshot();
        const feed = commanderExceptionsFeed(snapshot);
        const policy = await loadNotificationPolicy();
        const preview = buildNotificationPreview(feed, policy, evaluatedAt);
        return writeJson(res, 200, { ok: true, preview });
      }

      if (method === "GET" && path === "/cron") {
        assertAllowedQueryParams(url.searchParams, [], true);
        const snapshot = await readReadModelSnapshot();
        const overview = await buildCronOverview(snapshot, POLLING_INTERVALS_MS.cron);
        return writeJson(res, 200, { ok: true, overview });
      }

      if (method === "GET" && path === "/healthz") {
        assertAllowedQueryParams(url.searchParams, [], true);
        const snapshot = await readReadModelSnapshot();
        const health = await buildHealthzPayload(snapshot);
        const statusCode = health.status === "stale" ? 503 : 200;
        return writeJson(res, statusCode, {
          ok: health.status !== "stale",
          health,
        });
      }

      if (method === "GET" && path === "/digest/latest") {
        assertAllowedQueryParams(url.searchParams, [], false);
        const latest = await loadLatestDigest();
        return writeText(res, 200, renderLatestDigestPage(latest), "text/html; charset=utf-8");
      }

      if (method === "GET" && path === "/api/action-queue") {
        assertAllowedQueryParams(url.searchParams, [], true);
        const snapshot = await readReadModelSnapshot();
        const queue = await readNotificationCenter(snapshot);
        return writeJson(res, 200, { ok: true, queue });
      }

      if (method === "GET" && path === "/api/action-queue/acks/prune-preview") {
        assertMutationAuthorized(req, "/api/action-queue/acks/prune-preview");
        assertAllowedQueryParams(url.searchParams, [], true);
        const preview = await previewStaleAcksPrune();
        return writeJson(res, 200, { ok: true, preview });
      }

      if (method === "POST" && path.startsWith("/api/action-queue/") && path.endsWith("/ack")) {
        assertMutationAuthorized(req, "/api/action-queue/:itemId/ack");
        assertJsonContentType(req);
        const itemId = decodeRouteParam(path, /^\/api\/action-queue\/([^/]+)\/ack$/, "itemId");
        const payload = expectObject(await readJsonBody(req), "action queue acknowledge payload");
        const ttlMinutes = optionalIntegerField(payload.ttlMinutes, "ttlMinutes", 1, 7 * 24 * 60);
        const snoozeUntil = optionalIsoTimestampField(payload.snoozeUntil, "snoozeUntil");
        if (ttlMinutes !== undefined && snoozeUntil !== undefined) {
          throw new RequestValidationError("Provide either ttlMinutes or snoozeUntil, not both.", 400);
        }
        if (snoozeUntil !== undefined && Date.parse(snoozeUntil) <= Date.now()) {
          throw new RequestValidationError("snoozeUntil must be a future ISO date-time string.", 400);
        }
        const snapshot = await readReadModelSnapshot();
        const queue = await readNotificationCenter(snapshot);
        const acknowledged = await acknowledgeActionQueueItem({
          itemId,
          note: payload.note,
          ttlMinutes,
          snoozeUntil,
        }, queue);
        return writeJson(res, 200, { ok: true, ...acknowledged });
      }

      if (method === "POST" && path === "/action-queue/ack") {
        const form = await readFormBody(req);
        assertMutationAuthorized(req, "/action-queue/ack", form.get("localToken"));
        const itemId = readRequiredFormValue(form, "itemId");
        const snapshot = await readReadModelSnapshot();
        const queue = await readNotificationCenter(snapshot);
        await acknowledgeActionQueueItem({ itemId }, queue);
        return redirect(res, 303, "/");
      }

      if (method === "POST" && path.startsWith("/api/approvals/") && path.endsWith("/approve")) {
        assertMutationAuthorized(req, "/api/approvals/:approvalId/approve");
        assertJsonContentType(req);
        const approvalId = decodeRouteParam(path, /^\/api\/approvals\/([^/]+)\/approve$/, "approvalId");
        const payload = expectObject(await readJsonBody(req), "approval payload");
        const reason = optionalBoundedString(payload.reason, "reason", 220);
        const result = await approvalActions.execute({ action: "approve", approvalId, reason });
        return writeJson(res, result.mode === "blocked" ? 403 : result.ok ? 200 : 500, result);
      }

      if (method === "POST" && path.startsWith("/api/approvals/") && path.endsWith("/reject")) {
        assertMutationAuthorized(req, "/api/approvals/:approvalId/reject");
        assertJsonContentType(req);
        const approvalId = decodeRouteParam(path, /^\/api\/approvals\/([^/]+)\/reject$/, "approvalId");
        const payload = expectObject(await readJsonBody(req), "approval payload");
        const reason = requiredBoundedString(payload.reason, "reason", 220);
        const result = await approvalActions.execute({
          action: "reject",
          approvalId,
          reason,
        });
        return writeJson(res, result.mode === "blocked" ? 403 : result.ok ? 200 : 500, result);
      }

      if (path.startsWith("/api/")) {
        return writeApiError(res, 404, "NOT_FOUND", "API route not found.");
      }

      return writeText(res, 404, "Not Found", "text/plain; charset=utf-8");
    } catch (error) {
      if (
        error instanceof TaskStoreValidationError ||
        error instanceof ProjectStoreValidationError ||
        error instanceof NotificationCenterValidationError
      ) {
        console.warn("[mission-control] ui request validation", {
          requestId,
          message: error.message,
          issues: error.issues,
        });
        const code = error.statusCode === 404 ? "NOT_FOUND" : "VALIDATION_ERROR";
        return writeApiError(res, error.statusCode, code, error.message, error.issues);
      }

      if (error instanceof RequestValidationError) {
        console.warn("[mission-control] ui request validation", {
          requestId,
          message: error.message,
          issues: error.issues,
        });
        const code = error.statusCode === 415 ? "UNSUPPORTED_MEDIA_TYPE" : "VALIDATION_ERROR";
        return writeApiError(res, error.statusCode, code, error.message, error.issues);
      }

      console.error("[mission-control] ui error", { requestId, error });
      return writeApiError(res, 500, "INTERNAL_ERROR", "Internal server error.");
    }
  });

  const bindAddress = process.env.UI_BIND_ADDRESS ?? "127.0.0.1";
  server.listen(port, bindAddress, () => {
    const displayUrl = bindAddress === "0.0.0.0" ? `http://<your-ip>:${port}` : `http://${bindAddress}:${port}`;
    console.log(`[mission-control] ui listening at ${displayUrl}`);
    void Promise.resolve().then(() => primeOpenClawCliInsights());
    void primeUiRenderCaches(toolClient);
  });
  return server;
}

async function readSnapshotRaw(): Promise<string> {
  try {
    return await readFile(SNAPSHOT_PATH, "utf8");
  } catch {
    return JSON.stringify(defaultSnapshot(), null, 2);
  }
}

function isFsNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function readOptionalFileStamp(path: string): Promise<string> {
  try {
    const file = await stat(path);
    return `${path}:${file.mtimeMs}:${file.size}`;
  } catch (error) {
    if (isFsNotFound(error)) return `${path}:missing`;
    return `${path}:error`;
  }
}

async function readReadModelSourceStamp(): Promise<string> {
  const parts = await Promise.all([
    readOptionalFileStamp(SNAPSHOT_PATH),
    readOptionalFileStamp(PROJECTS_PATH),
    readOptionalFileStamp(TASKS_PATH),
    readOptionalFileStamp(BUDGET_POLICY_PATH),
  ]);
  return parts.join("|");
}

async function readReadModelSnapshot(): Promise<ReadModelSnapshot> {
  const sourceStamp = await readReadModelSourceStamp();
  const now = Date.now();
  if (
    renderSnapshotCache &&
    renderSnapshotCache.sourceStamp === sourceStamp &&
    renderSnapshotCache.expiresAt > now
  ) {
    return renderSnapshotCache.value;
  }
  if (renderSnapshotInFlight?.sourceStamp === sourceStamp) {
    return renderSnapshotInFlight.value;
  }

  const nextValue = (async () => {
    const snapshot = (await readSnapshotJsonWithRetry()) as Partial<ReadModelSnapshot>;
    const [projects, tasks, budgetPolicy] = await Promise.all([
      loadProjectStore(),
      loadTaskStore(),
      loadBudgetPolicy(),
    ]);

    if (budgetPolicy.issues.length > 0) {
      console.warn("[mission-control] budget policy issues", {
        path: budgetPolicy.path,
        issues: budgetPolicy.issues,
      });
    }

    const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
    const statuses = Array.isArray(snapshot.statuses) ? snapshot.statuses : [];

    const value = {
      sessions,
      statuses,
      cronJobs: Array.isArray(snapshot.cronJobs) ? snapshot.cronJobs : [],
      approvals: Array.isArray(snapshot.approvals) ? snapshot.approvals : [],
      projects,
      projectSummaries: computeProjectSummaries(projects, tasks),
      tasks,
      tasksSummary: computeTasksSummary(tasks, projects.projects.length),
      budgetSummary: computeBudgetSummary(sessions, statuses, tasks, projects, budgetPolicy.policy),
      generatedAt:
        typeof snapshot.generatedAt === "string" && !Number.isNaN(Date.parse(snapshot.generatedAt))
          ? snapshot.generatedAt
          : new Date().toISOString(),
    } satisfies ReadModelSnapshot;
    renderSnapshotCache = {
      sourceStamp,
      value,
      expiresAt: Date.now() + HTML_SNAPSHOT_CACHE_TTL_MS,
    };
    return value;
  })();

  renderSnapshotInFlight = { sourceStamp, value: nextValue };
  try {
    return await nextValue;
  } finally {
    if (renderSnapshotInFlight?.sourceStamp === sourceStamp) {
      renderSnapshotInFlight = undefined;
    }
  }
}

async function readSnapshotJsonWithRetry(): Promise<Partial<ReadModelSnapshot>> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return JSON.parse(await readSnapshotRaw()) as Partial<ReadModelSnapshot>;
    } catch (error) {
      if (attempt === 2) throw error;
      await delay(25 * (attempt + 1));
    }
  }
  return defaultSnapshot();
}

async function loadCachedLiveSessions(
  toolClient: ToolClient,
): Promise<Awaited<ReturnType<ToolClient["sessionsList"]>>> {
  const now = Date.now();
  if (renderLiveSessionsCache && renderLiveSessionsCache.expiresAt > now) {
    return renderLiveSessionsCache.value;
  }
  if (renderLiveSessionsCache) {
    if (!renderLiveSessionsInFlight) {
      const nextValue = toolClient.sessionsList();
      renderLiveSessionsInFlight = nextValue;
      void nextValue
        .then((value) => {
          renderLiveSessionsCache = {
            value,
            expiresAt: Date.now() + HTML_LIVE_SESSIONS_CACHE_TTL_MS,
          };
        })
        .finally(() => {
          renderLiveSessionsInFlight = undefined;
        });
    }
    return renderLiveSessionsCache.value;
  }
  if (renderLiveSessionsInFlight) {
    return renderLiveSessionsInFlight;
  }

  const nextValue = toolClient.sessionsList();
  renderLiveSessionsInFlight = nextValue;
  try {
    const value = await nextValue;
    renderLiveSessionsCache = {
      value,
      expiresAt: Date.now() + HTML_LIVE_SESSIONS_CACHE_TTL_MS,
    };
    return value;
  } finally {
    renderLiveSessionsInFlight = undefined;
  }
}

async function readReadModelSnapshotWithLiveSessions(toolClient: ToolClient): Promise<ReadModelSnapshot> {
  const snapshotPromise = readReadModelSnapshot();
  const livePromise = loadCachedLiveSessions(toolClient);

  try {
    const [snapshot, live] = await Promise.all([snapshotPromise, livePromise]);
    const sessions = mapSessionsListToSummaries(live);
    if (sessions.length === 0) return snapshot;

    const liveStatuses: ReadModelSnapshot["statuses"] = [];
    for (const item of live.sessions ?? []) {
      const sessionKey = item.sessionKey ?? item.key;
      if (!sessionKey) continue;
      const updatedAt =
        typeof item.updatedAt === "string" && !Number.isNaN(Date.parse(item.updatedAt))
          ? item.updatedAt
          : typeof item.updatedAtMs === "number" && Number.isFinite(item.updatedAtMs)
            ? new Date(item.updatedAtMs).toISOString()
            : new Date().toISOString();
      liveStatuses.push({
        sessionKey,
        model: item.model,
        tokensIn: item.inputTokens,
        tokensOut: item.outputTokens,
        cost: undefined,
        updatedAt,
      });
    }

    const sessionsByKey = new Map(snapshot.sessions.map((item) => [item.sessionKey, item]));
    for (const liveSession of sessions) {
      const existing = sessionsByKey.get(liveSession.sessionKey);
      sessionsByKey.set(liveSession.sessionKey, {
        ...existing,
        ...liveSession,
        label: liveSession.label ?? existing?.label,
        agentId: liveSession.agentId ?? existing?.agentId,
        lastMessageAt: liveSession.lastMessageAt ?? existing?.lastMessageAt,
      });
    }

    const statusesByKey = new Map(snapshot.statuses.map((item) => [item.sessionKey, item]));
    for (const liveStatus of liveStatuses) {
      const existing = statusesByKey.get(liveStatus.sessionKey);
      statusesByKey.set(liveStatus.sessionKey, {
        ...existing,
        ...liveStatus,
        model: liveStatus.model ?? existing?.model,
        tokensIn: liveStatus.tokensIn ?? existing?.tokensIn,
        tokensOut: liveStatus.tokensOut ?? existing?.tokensOut,
        cost: existing?.cost,
        updatedAt: liveStatus.updatedAt ?? existing?.updatedAt ?? new Date().toISOString(),
      });
    }

    return {
      ...snapshot,
      sessions: [...sessionsByKey.values()].sort(compareSessionSummariesByLatest),
      statuses: [...statusesByKey.values()],
    };
  } catch (error) {
    console.warn("[mission-control] live session backfill failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return snapshotPromise;
  }
}

async function primeUiRenderCaches(toolClient: ToolClient): Promise<void> {
  try {
    const snapshot = await readReadModelSnapshotWithLiveSessions(toolClient);
    await Promise.all([loadCachedUsageCost(snapshot, "full"), loadCachedOfficeSessionPresence(), loadCachedReplayPreview()]);
  } catch (error) {
    console.warn("[mission-control] ui cache warmup failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function readNotificationCenter(snapshot: ReadModelSnapshot): Promise<NotificationCenterSnapshot> {
  const exceptionsFeed = commanderExceptionsFeed(snapshot);
  const acks = await loadAcksStore();
  const linksByItemId = buildActionQueueLinks(exceptionsFeed, snapshot);
  return buildNotificationCenter(exceptionsFeed, acks, linksByItemId);
}

function pickUiText(language: UiLanguage, en: string, zh: string): string {
  return language === "zh" ? zh : en;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function globalVisibilityCopy(language: UiLanguage): GlobalVisibilityCopy {
  if (language === "zh") {
    return {
      title: "全局总览",
      summary: "一眼看四件事：定时任务、任务心跳、当前任务、工具调用。",
      scheduleLabel: "定时任务：",
      heartbeatLabel: "任务心跳：",
      currentTasksLabel: "当前任务：",
      toolCallsLabel: "工具调用：",
      scheduleLinkLabel: "查看定时任务",
      heartbeatLinkLabel: "查看任务心跳",
      currentTasksLinkLabel: "查看当前任务",
      toolCallsLinkLabel: "查看工具调用",
      doneLabel: "已完成",
      notDoneLabel: "未完成",
      taskTypeLabel: "类型",
      taskNameLabel: "事项",
      executorLabel: "智能体",
      currentActionLabel: "正在做什么",
      nextRunLabel: "下次检查",
      latestResultLabel: "最近结果",
      statusLabel: "状态",
      nextActionLabel: "下一步",
      detailsLabel: "详情",
      doneStatusText: "已完成",
      notDoneStatusText: "未完成",
    };
  }

  return {
    title: "Global Visibility",
    summary: "One place to see timed jobs, heartbeat, current tasks, and tool calls.",
    scheduleLabel: "Timed jobs:",
    heartbeatLabel: "Heartbeat checks:",
    currentTasksLabel: "Current tasks:",
    toolCallsLabel: "Tool calls:",
    scheduleLinkLabel: "See timed jobs",
    heartbeatLinkLabel: "See heartbeat checks",
    currentTasksLinkLabel: "See current tasks",
    toolCallsLinkLabel: "See tool calls",
    doneLabel: "Done",
    notDoneLabel: "Not done",
    taskTypeLabel: "Type",
    taskNameLabel: "Item",
    executorLabel: "Owner",
    currentActionLabel: "Now",
    nextRunLabel: "Next check",
    latestResultLabel: "Latest",
    statusLabel: "Status",
    nextActionLabel: "Next step",
    detailsLabel: "View",
    doneStatusText: "Done",
    notDoneStatusText: "Not done",
  };
}

function formatExecutorAgentLabel(agentId: string, language: UiLanguage): string {
  const normalized = agentId.trim().toLowerCase();
  if (!normalized || normalized === "system") return pickUiText(language, "System service", "系统服务");
  if (normalized === "system-cron") return pickUiText(language, "Scheduler", "调度器");
  if (normalized === "task-heartbeat-worker") return pickUiText(language, "Heartbeat service", "任务心跳服务");
  return humanizeOperatorLabel(agentId);
}

function buildGlobalVisibilityDetailHref(taskType: GlobalVisibilityTaskRow["taskType"], language: UiLanguage): string {
  if (taskType === "cron") {
    return `${buildHomeHref({ quick: "all" }, true, "overview", language)}#cron-health`;
  }
  if (taskType === "heartbeat") {
    return `${buildHomeHref({ quick: "all" }, true, "overview", language)}#heartbeat-health`;
  }
  if (taskType === "current_task") {
    return `${buildHomeHref({ quick: "all" }, true, "projects-tasks", language)}#tracked-task-view`;
  }
  return `${buildHomeHref({ quick: "all" }, true, "overview", language)}#tool-activity`;
}

function normalizeInlineText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function sanitizeCronPurposeText(input: string, language: UiLanguage, maxLength = 72): string {
  const normalized = normalizeInlineText(input);
  if (!normalized) return pickUiText(language, "No purpose description.", "未提供任务目的。");
  const lower = normalized.toLowerCase();
  if (
    lower.includes("run exactly one command via exec tool") ||
    lower.includes("cd /") ||
    lower.includes("&&") ||
    lower.includes("/opt/homebrew/") ||
    lower.includes("/users/")
  ) {
    return pickUiText(language, "Run one automation script and update status.", "执行一次自动化脚本并更新状态。");
  }
  return safeTruncate(normalized, maxLength);
}

function summarizeCronCommandPurpose(command: string, language: UiLanguage): string {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return pickUiText(language, "Run scheduled command.", "执行定时命令。");
  if (normalized.includes("node")) return pickUiText(language, "Run Node automation script.", "运行 Node 自动化脚本。");
  if (normalized.includes("python")) return pickUiText(language, "Run Python automation script.", "运行 Python 自动化脚本。");
  if (normalized.includes("curl")) return pickUiText(language, "Fetch external data and update status.", "拉取外部数据并更新状态。");
  return pickUiText(language, "Run scheduled command.", "执行定时命令。");
}

function parseSessionTargetOwner(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.startsWith("agent:")) {
    const parts = normalized.split(":");
    if (parts.length >= 2 && parts[1]?.trim()) return parts[1].trim();
  }
  return undefined;
}

function cronRuntimePurpose(jobId: string, language: UiLanguage): string {
  const id = jobId.toLowerCase();
  if (id.includes("task-heartbeat")) {
    return pickUiText(
      language,
      "Scan assigned backlog and trigger heartbeat pickup.",
      "扫描已分配待办任务，并按心跳规则推进。",
    );
  }
  if (id.includes("monitor")) {
    return pickUiText(
      language,
      "Refresh runtime snapshot and keep dashboard state updated.",
      "刷新运行时快照，保持控制中心数据更新。",
    );
  }
  return pickUiText(language, "Run scheduled system checks.", "执行系统定时检查。");
}

function cronPayloadPurpose(payload: Record<string, unknown> | undefined, language: UiLanguage): string {
  if (!payload) return pickUiText(language, "No purpose description.", "未提供任务目的。");
  const kind = typeof payload.kind === "string" ? payload.kind.trim() : "";
  if (kind === "agentTurn" && typeof payload.message === "string" && payload.message.trim()) {
    return sanitizeCronPurposeText(payload.message, language);
  }
  if (kind === "command") {
    const command = typeof payload.command === "string" ? payload.command.trim() : "";
    if (command) {
      return summarizeCronCommandPurpose(command, language);
    }
  }
  if (typeof payload.message === "string" && payload.message.trim()) {
    return sanitizeCronPurposeText(payload.message, language);
  }
  return pickUiText(language, "No purpose description.", "未提供任务目的。");
}

function cronPayloadOwner(payload: Record<string, unknown> | undefined, language: UiLanguage): string {
  if (!payload) return pickUiText(language, "Scheduler", "调度器");
  const ownerAgentId = cronPayloadOwnerAgentId(payload);
  if (ownerAgentId) return humanizeOperatorLabel(ownerAgentId);
  const sessionOwner = parseSessionTargetOwner(typeof payload.sessionTarget === "string" ? payload.sessionTarget : undefined);
  if (sessionOwner) return humanizeOperatorLabel(sessionOwner);
  return pickUiText(language, "Scheduler", "调度器");
}

function cronPayloadOwnerAgentId(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  if (typeof payload.agentId === "string" && payload.agentId.trim()) {
    return payload.agentId.trim();
  }
  return parseSessionTargetOwner(typeof payload.sessionTarget === "string" ? payload.sessionTarget : undefined);
}

function cronScheduleLabel(schedule: Record<string, unknown> | undefined, language: UiLanguage): string {
  if (!schedule) return pickUiText(language, "Not scheduled", "未配置");
  const kind = typeof schedule.kind === "string" ? schedule.kind.trim().toLowerCase() : "";
  if (kind === "cron") {
    const expr = typeof schedule.expr === "string" ? schedule.expr.trim() : "";
    return expr ? `cron ${expr}` : "cron";
  }
  if (kind === "interval") {
    const everyMs = typeof schedule.everyMs === "number" && Number.isFinite(schedule.everyMs)
      ? Math.max(0, Math.round(schedule.everyMs))
      : undefined;
    if (everyMs && everyMs > 0) {
      const seconds = Math.round(everyMs / 1000);
      return pickUiText(language, `every ${seconds}s`, `每 ${seconds} 秒`);
    }
    return pickUiText(language, "interval", "间隔");
  }
  if (kind === "every") {
    const everyMs = typeof schedule.everyMs === "number" && Number.isFinite(schedule.everyMs)
      ? Math.max(0, Math.round(schedule.everyMs))
      : undefined;
    if (everyMs && everyMs > 0) {
      const seconds = Math.round(everyMs / 1000);
      return pickUiText(language, `every ${seconds}s`, `每 ${seconds} 秒`);
    }
    return pickUiText(language, "every", "每次");
  }
  return kind ? kind : pickUiText(language, "Not scheduled", "未配置");
}

function displayCronScheduleLabel(scheduleLabel: string, language: UiLanguage): string {
  const normalized = scheduleLabel.trim().toLowerCase();
  if (!normalized || normalized === "-") return pickUiText(language, "Not scheduled", "未排程");
  if (normalized.startsWith("cron ")) return pickUiText(language, "Fixed schedule", "固定时间表");
  if (normalized.startsWith("every") || normalized.startsWith("每 ")) return scheduleLabel;
  if (normalized === "system interval") return pickUiText(language, "System interval", "系统间隔");
  return safeTruncate(scheduleLabel, 18);
}

function summarizeNames(items: string[], language: UiLanguage, emptyLabel: string): string {
  const uniq = [...new Set(items.map((item) => item.trim()).filter((item) => item.length > 0))];
  if (uniq.length === 0) return emptyLabel;
  return uniq.join("、");
}

function cronHealthLabel(health: string, language: UiLanguage): string {
  const normalized = health.trim().toLowerCase();
  if (normalized === "scheduled") return pickUiText(language, "Scheduled", "已排程");
  if (normalized === "due") return pickUiText(language, "Due", "到点待执行");
  if (normalized === "late") return pickUiText(language, "Late", "执行延迟");
  if (normalized === "disabled") return pickUiText(language, "Disabled", "未启用");
  if (normalized === "enabled") return pickUiText(language, "Enabled", "已启用");
  return pickUiText(language, "Unknown", "未知");
}

function heartbeatModeLabel(mode: string, language: UiLanguage): string {
  const normalized = mode.trim().toLowerCase();
  if (normalized === "dry_run" || normalized === "dry-run") return pickUiText(language, "Dry run", "演练");
  if (normalized === "live" || normalized === "execute") return pickUiText(language, "Live", "执行");
  return mode;
}

function sessionStateLabel(state: AgentRunState): string {
  if (state === "running") return "执行中";
  if (state === "waiting_approval") return "待审批";
  if (state === "blocked") return "阻塞";
  if (state === "error") return "异常";
  return "待命";
}

async function loadOpenclawCronCatalog(language: UiLanguage): Promise<OpenclawCronJobSummary[]> {
  for (const candidate of [...new Set(OPENCLAW_CRON_JOBS_CANDIDATES)]) {
    try {
      const raw = JSON.parse(await readFile(candidate, "utf8")) as unknown;
      const root = asObject(raw);
      const jobsRaw = root && Array.isArray(root.jobs) ? root.jobs : [];
      const jobs: OpenclawCronJobSummary[] = [];
      for (const item of jobsRaw) {
        const obj = asObject(item);
        if (!obj) continue;
        const jobId = typeof obj.id === "string" ? obj.id.trim() : "";
        if (!jobId) continue;
        const name = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : jobId;
        const payload = asObject(obj.payload);
        const schedule = asObject(obj.schedule);
        jobs.push({
          jobId,
          name,
          enabled: obj.enabled !== false,
          owner: cronPayloadOwner(payload, language),
          ownerAgentId: cronPayloadOwnerAgentId(payload),
          purpose: cronPayloadPurpose(payload, language),
          scheduleLabel: cronScheduleLabel(schedule, language),
          sourcePath: candidate,
        });
      }
      jobs.sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return jobs;
    } catch {
      continue;
    }
  }
  return [];
}

async function countRecentToolCalls(snapshot: ReadModelSnapshot, toolClient: ToolClient): Promise<number> {
  if (!Array.isArray(snapshot.sessions) || snapshot.sessions.length === 0) return 0;
  const recentSessions = await listSessionConversations({
    snapshot,
    client: toolClient,
    filters: {},
    page: 1,
    pageSize: 20,
    historyLimit: 6,
  });
  return recentSessions.items.reduce((sum, item) => {
    if (typeof item.toolEventCount === "number") return sum + item.toolEventCount;
    return sum + (item.latestKind === "tool_event" ? 1 : 0);
  }, 0);
}

async function buildGlobalVisibilityViewModel(
  snapshot: ReadModelSnapshot,
  toolClient: ToolClient,
  language: UiLanguage,
  input: {
    cronOverview?: Awaited<ReturnType<typeof buildCronOverview>>;
    openclawCronJobs?: OpenclawCronJobSummary[];
    currentTasksCount?: number;
    strongTaskEvidenceCount?: number;
    followupTaskEvidenceCount?: number;
    weakTaskEvidenceCount?: number;
    toolCallsCount?: number;
  } = {},
): Promise<GlobalVisibilityViewModel> {
  const cronOverview = input.cronOverview ?? (await buildCronOverview(snapshot, POLLING_INTERVALS_MS.cron));
  const openclawCronJobs = input.openclawCronJobs ?? (await loadOpenclawCronCatalog(language));
  const inProgressCount = snapshot.tasksSummary.inProgress ?? 0;
  const blockedCount = snapshot.tasksSummary.blocked ?? 0;
  const strongTaskEvidenceCount =
    typeof input.strongTaskEvidenceCount === "number" ? input.strongTaskEvidenceCount : Math.max(0, inProgressCount - blockedCount);
  const followupTaskEvidenceCount = typeof input.followupTaskEvidenceCount === "number" ? input.followupTaskEvidenceCount : 0;
  const weakTaskEvidenceCount = typeof input.weakTaskEvidenceCount === "number" ? input.weakTaskEvidenceCount : blockedCount;
  const currentTasksCount =
    input.currentTasksCount ?? Math.max(inProgressCount + blockedCount, strongTaskEvidenceCount + followupTaskEvidenceCount + weakTaskEvidenceCount);
  const hasWeakEvidence = weakTaskEvidenceCount > 0;
  const toolCallsCount = input.toolCallsCount ?? (await countRecentToolCalls(snapshot, toolClient));
  const nonHeartbeatRuntimeCronJobs = cronOverview.jobs.filter((job) => !job.jobId.toLowerCase().includes("heartbeat"));
  const heartbeatJobs = cronOverview.jobs.filter((job) => job.jobId.toLowerCase().includes("heartbeat"));
  const enabledRuntimeCronJobs = nonHeartbeatRuntimeCronJobs.filter((job) => job.enabled);
  const enabledOpenclawCronJobs = openclawCronJobs.filter((job) => job.enabled);
  const enabledCronCount = new Set([
    ...enabledRuntimeCronJobs.map((job) => job.jobId),
    ...enabledOpenclawCronJobs.map((job) => job.jobId),
  ]).size;
  const enabledHeartbeatCount = heartbeatJobs.filter((job) => job.enabled).length;
  const heartbeatEnabled = heartbeatJobs.some((job) => job.enabled);
  const latestHeartbeatRun = (await readTaskHeartbeatRuns(1)).runs[0];
  const cronTaskName =
    enabledCronCount > 0
      ? pickUiText(language, `${enabledCronCount} jobs enabled`, `已启用 ${enabledCronCount} 个任务`)
      : pickUiText(language, "No timed jobs", "暂无定时任务");
  const cronOwner =
    enabledOpenclawCronJobs.length > 0
      ? summarizeNames(
          enabledOpenclawCronJobs.map((job) => job.owner),
          language,
          pickUiText(language, "Scheduler", "调度器"),
        )
      : formatExecutorAgentLabel("system-cron", language);
  const cronPurpose =
    (enabledOpenclawCronJobs[0]?.purpose ? sanitizeCronPurposeText(enabledOpenclawCronJobs[0]?.purpose, language, 56) : "") ||
    (enabledRuntimeCronJobs[0] ? cronRuntimePurpose(enabledRuntimeCronJobs[0].jobId, language) : pickUiText(language, "No timed job is running.", "当前没有定时任务在运行。"));
  const cronNextRun =
    nonHeartbeatRuntimeCronJobs.find((job) => job.enabled)?.nextRunAt ??
    cronOverview.nextRunAt ??
    pickUiText(language, "Not scheduled", "未排程");
  const heartbeatNextRun =
    heartbeatJobs.find((job) => job.enabled)?.nextRunAt ??
    heartbeatJobs[0]?.nextRunAt ??
    pickUiText(language, "Not scheduled", "未排程");
  const heartbeatTaskName = pickUiText(language, "Task heartbeat service", "任务心跳服务");
  const heartbeatLatestResult = heartbeatEnabled
    ? latestHeartbeatRun
      ? pickUiText(
          language,
          `Last heartbeat: selected ${latestHeartbeatRun.selected} tasks, started ${latestHeartbeatRun.executed}.`,
          `最近心跳：挑出 ${latestHeartbeatRun.selected} 个任务，启动 ${latestHeartbeatRun.executed} 个。`,
        )
      : pickUiText(
          language,
          `Active heartbeat checks: ${enabledHeartbeatCount}.`,
          `已开启任务心跳：${enabledHeartbeatCount} 个。`,
        )
    : pickUiText(language, "No heartbeat check yet.", "还没有任务心跳记录。");
  const heartbeatPurpose = pickUiText(
    language,
    "Check assigned tasks and start the picked ones.",
    "检查已分配任务，并启动挑中的任务。",
  );
  const scheduleReady = enabledCronCount > 0;

  const rows: GlobalVisibilityTaskRow[] = [
    {
      taskType: "cron",
      taskTypeLabel: pickUiText(language, "Timed jobs", "定时任务"),
      taskName: cronTaskName,
      executor: cronOwner,
      currentAction: scheduleReady
        ? pickUiText(language, `Now running: ${cronPurpose}`, `正在执行：${cronPurpose}`)
        : pickUiText(language, "Timed jobs are off.", "还没有设置定时任务。"),
      nextRun: cronNextRun,
      latestResult: scheduleReady
        ? pickUiText(
          language,
          `Active timed jobs: ${enabledCronCount}.`,
          `已开启定时任务：${enabledCronCount} 个。`,
        )
        : pickUiText(language, "No timed job yet.", "还没有定时任务记录。"),
      status: scheduleReady ? "done" : "not_done",
      nextAction: scheduleReady
        ? pickUiText(language, "Keep timed jobs on and keep each job goal clear.", "保持定时任务开启，并确认每个任务目标清楚。")
        : pickUiText(language, "Turn on one timed job.", "先添加一个定时任务。"),
      detailsHref: buildGlobalVisibilityDetailHref("cron", language),
      detailsLabel: pickUiText(language, "See timed jobs", "查看定时任务"),
    },
    {
      taskType: "heartbeat",
      taskTypeLabel: pickUiText(language, "Heartbeat", "任务心跳"),
      taskName: heartbeatTaskName,
      executor: formatExecutorAgentLabel("task-heartbeat-worker", language),
      currentAction: heartbeatEnabled
        ? pickUiText(language, `Heartbeat is on: ${heartbeatPurpose}`, `任务心跳已开启：${heartbeatPurpose}`)
        : pickUiText(language, "Heartbeat is off.", "还没有设置任务心跳。"),
      nextRun: heartbeatNextRun,
      latestResult: heartbeatLatestResult,
      status: heartbeatEnabled ? "done" : "not_done",
      nextAction: heartbeatEnabled
        ? pickUiText(language, "Check picked tasks and confirm the choices look right.", "查看挑出的任务，确认挑选结果是否合理。")
        : pickUiText(language, "Turn on heartbeat.", "在定时任务里开启心跳。"),
      detailsHref: buildGlobalVisibilityDetailHref("heartbeat", language),
      detailsLabel: pickUiText(language, "See heartbeat checks", "查看任务心跳"),
    },
    {
      taskType: "current_task",
      taskTypeLabel: pickUiText(language, "Current tasks", "当前任务"),
      taskName: pickUiText(language, "Current tasks", "当前任务"),
      executor: pickUiText(language, "Task owners", "任务智能体"),
      currentAction:
        currentTasksCount > 0
          ? hasWeakEvidence
            ? pickUiText(language, "Some current tasks still need follow-up.", "有些当前任务还需要继续跟进。")
            : pickUiText(language, "Current tasks are visible in runtime.", "当前任务已经能在运行时里看见。")
          : pickUiText(language, "No current task signal is visible now.", "当前还没有看见任务执行信号。"),
      nextRun: pickUiText(language, "Live update", "实时更新"),
      latestResult:
        currentTasksCount > 0
          ? hasWeakEvidence
            ? pickUiText(
                language,
                `${strongTaskEvidenceCount} confirmed live, ${followupTaskEvidenceCount} need follow-up, ${weakTaskEvidenceCount} need inspection.`,
                `${strongTaskEvidenceCount} 个已确认在跑，${followupTaskEvidenceCount} 个需跟进，${weakTaskEvidenceCount} 个需排查。`,
              )
            : pickUiText(language, `${currentTasksCount} current tasks are backed by runtime signals.`, `${currentTasksCount} 个当前任务已有运行信号支撑。`)
          : pickUiText(language, "No current task signal yet.", "当前还没有任务执行信号。"),
      status: currentTasksCount > 0 && !hasWeakEvidence ? "done" : "not_done",
      nextAction:
        currentTasksCount > 0
          ? hasWeakEvidence
            ? pickUiText(language, "Open current tasks and inspect the follow-up items first.", "打开当前任务，先检查需要跟进的项。")
            : pickUiText(language, "Keep following the runtime signals.", "继续盯住运行时信号即可。")
          : pickUiText(language, "Start one task and let runtime evidence appear first.", "先启动一个任务，让运行证据出现。"),
      detailsHref: buildGlobalVisibilityDetailHref("current_task", language),
      detailsLabel: pickUiText(language, "See current tasks", "查看当前任务"),
    },
    {
      taskType: "tool_call",
      taskTypeLabel: pickUiText(language, "Tool calls", "工具调用"),
      taskName: pickUiText(language, "Tool calls", "工具调用"),
      executor: pickUiText(language, "Active sessions", "活跃会话"),
      currentAction:
        toolCallsCount > 0
          ? pickUiText(language, "Tools were used recently.", "最近有工具在使用。")
          : pickUiText(language, "No tool use yet.", "最近没有工具在使用。"),
      nextRun: pickUiText(language, "Live update", "实时更新"),
      latestResult:
        toolCallsCount > 0
          ? pickUiText(language, `Tool calls in recent activity: ${toolCallsCount}.`, `最近工具调用：${toolCallsCount} 次。`)
          : pickUiText(language, "No tool calls yet.", "尚无工具调用记录。"),
      status: toolCallsCount > 0 ? "done" : "not_done",
      nextAction:
        toolCallsCount > 0
          ? pickUiText(language, "Review results and keep going.", "看下结果后继续。")
          : pickUiText(language, "Run one small tool step.", "先跑一次小工具步骤。"),
      detailsHref: buildGlobalVisibilityDetailHref("tool_call", language),
      detailsLabel: pickUiText(language, "See tool calls", "查看工具调用"),
    },
  ];

  const doneCount = rows.filter((row) => row.status === "done").length;
  return {
    tasks: rows,
    doneCount,
    notDoneCount: rows.length - doneCount,
    noTaskMessage: pickUiText(
      language,
      "No timed jobs, heartbeat, current tasks, or tool calls yet.",
      "暂无定时任务、任务心跳、当前任务或工具调用。",
    ),
    signalCounts: {
      schedule: enabledCronCount,
      heartbeat: enabledHeartbeatCount,
      currentTasks: currentTasksCount,
      toolCalls: toolCallsCount,
    },
  };
}

function dashboardSectionLinks(language: UiLanguage): DashboardSectionLink[] {
  return DASHBOARD_SECTION_LINKS_EN.map((item) => {
    if (language !== "zh") return item;

    if (item.key === "overview") {
      return { ...item, label: "总览", blurb: "今天重点" };
    }
    if (item.key === "team") {
      return { ...item, label: "员工", blurb: "员工、分工与职责" };
    }
    if (item.key === "collaboration") {
      return { ...item, label: "协作", blurb: "智能体交接与协同" };
    }
    if (item.key === "memory") {
      return { ...item, label: "记忆", blurb: "每日与长期记忆" };
    }
    if (item.key === "docs") {
      return { ...item, label: "文档", blurb: "Main 与当前启用智能体核心文档" };
    }
    if (item.key === "usage-cost") {
      return { ...item, label: "用量", blurb: "预算与额度" };
    }
    if (item.key === "projects-tasks") {
      return { ...item, label: "任务", blurb: "任务、排程与活动" };
    }
    return { ...item, label: "设置", blurb: "安全与数据连接" };
  });
}

function resolveDashboardSectionTitle(section: DashboardSectionLink, language: UiLanguage): string {
  if (language === "en" && section.key === "overview") {
    return "Overview Control Center";
  }
  return section.label;
}

function resolveGlobalVisibilitySignalStatus(
  model: GlobalVisibilityViewModel,
  taskType: GlobalVisibilityTaskRow["taskType"],
): GlobalVisibilityTaskStatus {
  const rows = model.tasks.filter((row) => row.taskType === taskType);
  if (rows.length === 0) return "not_done";
  return rows.some((row) => row.status === "not_done") ? "not_done" : "done";
}

function renderGlobalVisibilityStrip(model: GlobalVisibilityViewModel, language: UiLanguage): string {
  const copy = globalVisibilityCopy(language);
  const scheduleRow = model.tasks.find((row) => row.taskType === "cron");
  const heartbeatRow = model.tasks.find((row) => row.taskType === "heartbeat");
  const currentTasksRow = model.tasks.find((row) => row.taskType === "current_task");
  const toolCallsRow = model.tasks.find((row) => row.taskType === "tool_call");
  const scheduleHref = scheduleRow?.detailsHref ?? buildGlobalVisibilityDetailHref("cron", language);
  const heartbeatHref = heartbeatRow?.detailsHref ?? buildGlobalVisibilityDetailHref("heartbeat", language);
  const currentTasksHref = currentTasksRow?.detailsHref ?? buildGlobalVisibilityDetailHref("current_task", language);
  const toolCallsHref = toolCallsRow?.detailsHref ?? buildGlobalVisibilityDetailHref("tool_call", language);
  const noSignalText = pickUiText(language, "No update yet.", "暂无更新。");
  const scheduleSignalText = scheduleRow?.currentAction ?? noSignalText;
  const heartbeatSignalText = heartbeatRow?.currentAction ?? noSignalText;
  const currentTasksSignalText = currentTasksRow?.currentAction ?? noSignalText;
  const toolCallsSignalText = toolCallsRow?.currentAction ?? noSignalText;
  const scheduleStatus = resolveGlobalVisibilitySignalStatus(model, "cron");
  const heartbeatStatus = resolveGlobalVisibilitySignalStatus(model, "heartbeat");
  const currentTasksStatus = resolveGlobalVisibilitySignalStatus(model, "current_task");
  const toolCallsStatus = resolveGlobalVisibilitySignalStatus(model, "tool_call");
  const doneStatusLabel = copy.doneStatusText;
  const notDoneStatusLabel = copy.notDoneStatusText;
  const signalTotal =
    model.signalCounts.schedule +
    model.signalCounts.heartbeat +
    model.signalCounts.currentTasks +
    model.signalCounts.toolCalls;
  const scheduleSignalSmall = `<small>${escapeHtml(scheduleSignalText)}</small>`;
  const gaugeTone = (status: GlobalVisibilityTaskStatus): string =>
    status === "done" ? "var(--ok)" : "var(--warn)";
  const gaugePct = (count: number, status: GlobalVisibilityTaskStatus): number => {
    if (signalTotal <= 0) return status === "done" ? 32 : 14;
    const raw = Math.round((count / signalTotal) * 100);
    return status === "done" ? Math.max(34, raw) : Math.max(14, raw);
  };
  const renderSignalCard = (input: {
    label: string;
    value: number;
    status: GlobalVisibilityTaskStatus;
    statusLabel: string;
    signalText: string;
    signalSmallHtml?: string;
    href: string;
    linkLabel: string;
  }): string => {
    const pct = gaugePct(input.value, input.status);
    return `<div class="status-chip signal-gauge-card" data-signal-key="${escapeHtml(input.label)}" data-signal-value="${input.value}">
      <div class="signal-gauge-head"><span>${input.label}</span>${badge(input.status, input.statusLabel)}</div>
      <div class="signal-gauge-main">
        <div class="signal-gauge" style="--gauge-pct:${pct}; --gauge-tone:${gaugeTone(input.status)};">
          <div class="signal-gauge-core"><strong>${input.value}</strong></div>
        </div>
        <div class="signal-gauge-meta">
          ${input.signalSmallHtml ?? `<small>${escapeHtml(input.signalText)}</small>`}
          <a href="${escapeHtml(input.href)}">${input.linkLabel}</a>
        </div>
      </div>
    </div>`;
  };
  return `<div class="status-strip compact dashboard-strip">
      ${renderSignalCard({
        label: copy.scheduleLabel,
        value: model.signalCounts.schedule,
        status: scheduleStatus,
        statusLabel: scheduleStatus === "done" ? doneStatusLabel : notDoneStatusLabel,
        signalText: scheduleSignalText,
        signalSmallHtml: scheduleSignalSmall,
        href: scheduleHref,
        linkLabel: copy.scheduleLinkLabel,
      })}
      ${renderSignalCard({
        label: copy.heartbeatLabel,
        value: model.signalCounts.heartbeat,
        status: heartbeatStatus,
        statusLabel: heartbeatStatus === "done" ? doneStatusLabel : notDoneStatusLabel,
        signalText: heartbeatSignalText,
        href: heartbeatHref,
        linkLabel: copy.heartbeatLinkLabel,
      })}
      ${renderSignalCard({
        label: copy.currentTasksLabel,
        value: model.signalCounts.currentTasks,
        status: currentTasksStatus,
        statusLabel: currentTasksStatus === "done" ? doneStatusLabel : notDoneStatusLabel,
        signalText: currentTasksSignalText,
        href: currentTasksHref,
        linkLabel: copy.currentTasksLinkLabel,
      })}
      ${renderSignalCard({
        label: copy.toolCallsLabel,
        value: model.signalCounts.toolCalls,
        status: toolCallsStatus,
        statusLabel: toolCallsStatus === "done" ? doneStatusLabel : notDoneStatusLabel,
        signalText: toolCallsSignalText,
        href: toolCallsHref,
        linkLabel: copy.toolCallsLinkLabel,
      })}
      <div class="status-chip summary-gauge-card">
        <span>${copy.doneLabel}</span>
        <strong>${model.doneCount}</strong>
        <div class="summary-track"><div class="summary-fill" style="width:${Math.round((model.doneCount / Math.max(1, model.tasks.length)) * 100)}%;"></div></div>
      </div>
      <div class="status-chip summary-gauge-card">
        <span>${copy.notDoneLabel}</span>
        <strong>${model.notDoneCount}</strong>
        <div class="summary-track"><div class="summary-fill warn" style="width:${Math.round((model.notDoneCount / Math.max(1, model.tasks.length)) * 100)}%;"></div></div>
      </div>
    </div>`;
}

function renderGlobalVisibilityCard(model: GlobalVisibilityViewModel, language: UiLanguage): string {
  const copy = globalVisibilityCopy(language);
  if (model.tasks.length === 0) {
    return `<details class="card compact-details stack-gap global-visibility-card" id="global-visibility-card">
      <summary>${copy.title}</summary>
      <div class="fold-body">
        <div class="meta">${copy.summary}</div>
        ${renderGlobalVisibilityStrip(model, language)}
        <div class="empty-state">${escapeHtml(model.noTaskMessage)}</div>
      </div>
    </details>`;
  }

  const rows = model.tasks
    .map((row) => {
      const statusLabel = row.status === "done" ? copy.doneStatusText : copy.notDoneStatusText;
      return `<tr>
        <td>${escapeHtml(row.taskTypeLabel)}</td>
        <td>${escapeHtml(row.taskName)}</td>
        <td>${escapeHtml(row.executor)}</td>
        <td>${escapeHtml(row.currentAction)}</td>
        <td>${escapeHtml(row.nextRun)}</td>
        <td>${escapeHtml(row.latestResult)}</td>
        <td>${badge(row.status, statusLabel)}</td>
        <td>${escapeHtml(row.nextAction)}</td>
        <td><a href="${escapeHtml(row.detailsHref)}">${escapeHtml(row.detailsLabel)}</a></td>
      </tr>`;
    })
    .join("");

  return `<details class="card compact-details stack-gap global-visibility-card" id="global-visibility-card">
        <summary>${copy.title}</summary>
        <div class="fold-body">
          <div class="meta">${copy.summary}</div>
          ${renderGlobalVisibilityStrip(model, language)}
          <details class="compact-table-details">
            <summary>${copy.detailsLabel}（${model.tasks.length}）</summary>
            <table class="ops-board">
              <thead>
                <tr>
                  <th>${copy.taskTypeLabel}</th>
                  <th>${copy.taskNameLabel}</th>
                  <th>${copy.executorLabel}</th>
                  <th>${copy.currentActionLabel}</th>
                  <th>${copy.nextRunLabel}</th>
                  <th>${copy.latestResultLabel}</th>
                  <th>${copy.statusLabel}</th>
                  <th>${copy.nextActionLabel}</th>
                  <th>${copy.detailsLabel}</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </details>
        </div>
      </details>`;
}

function renderGlobalVisibilityStripCard(model: GlobalVisibilityViewModel, language: UiLanguage): string {
  const copy = globalVisibilityCopy(language);
  return `<section class="card stack-gap global-visibility-strip-card" id="global-visibility-strip">
      <header class="card-head">
        <h2>${copy.title}</h2>
        <div class="meta">${copy.summary}</div>
      </header>
      ${renderGlobalVisibilityStrip(model, language)}
    </section>`;
}

function insightStatusLabel(status: OpenClawInsightStatus, language: UiLanguage): string {
  if (status === "ok") return pickUiText(language, "Healthy", "正常");
  if (status === "warn") return pickUiText(language, "Attention", "需关注");
  if (status === "blocked") return pickUiText(language, "Blocked", "阻塞");
  if (status === "info") return pickUiText(language, "Partial", "部分可用");
  return pickUiText(language, "Unknown", "未知");
}

function connectorInsightStatus(snapshot: UsageCostSnapshot, language: UiLanguage): {
  status: OpenClawInsightStatus;
  connectedCount: number;
  totalCount: number;
  missingCount: number;
  detail: string;
  value: string;
} {
  const statuses = [
    snapshot.connectors.modelContextCatalog,
    snapshot.connectors.digestHistory,
    snapshot.connectors.requestCounts,
    snapshot.connectors.budgetLimit,
    snapshot.connectors.providerAttribution,
    snapshot.connectors.subscriptionUsage,
  ];
  const totalCount = statuses.length;
  const connectedCount = statuses.filter((item) => item === "connected").length;
  const partialCount = statuses.filter((item) => item === "partial").length;
  const missingCount = totalCount - connectedCount;

  const connectorGapLabel = (id: string): string => {
    if (id === "subscription_usage") return pickUiText(language, "subscription / billing snapshot", "订阅 / 账单快照");
    if (id === "cost_budget_limit") return pickUiText(language, "budget limit", "预算限额");
    if (id === "request_counter") return pickUiText(language, "request counts", "请求计数");
    if (id === "digest_history") return pickUiText(language, "trend history", "趋势历史");
    if (id === "context_catalog") return pickUiText(language, "context capacity", "上下文容量");
    if (id === "provider_mapping") return pickUiText(language, "model provider attribution", "模型供应商归因");
    return pickUiText(language, "usage data", "用量数据");
  };

  const connectorGapImpact = (id: string): string => {
    if (id === "subscription_usage") {
      return pickUiText(language, "Quota windows will show estimated or disconnected states.", "额度窗口会显示估算或未连接。");
    }
    if (id === "cost_budget_limit") {
      return pickUiText(language, "Budget risk can only use spend so far, not a real limit.", "预算风险只能看已花金额，暂时还不能按上限预警。");
    }
    if (id === "request_counter") {
      return pickUiText(language, "Request counts and parts of trend history will stay incomplete.", "请求次数和部分趋势会不完整。");
    }
    if (id === "digest_history") {
      return pickUiText(language, "7d / 30d trends will stay incomplete.", "7 天 / 30 天趋势会不完整。");
    }
    if (id === "context_catalog") {
      return pickUiText(language, "Context pressure will miss full capacity data.", "上下文压力会缺少完整容量信息。");
    }
    if (id === "provider_mapping") {
      return pickUiText(language, "Some attribution will stay under “Unknown provider”.", "部分归因会落到“未知供应商”。");
    }
    return pickUiText(language, "Some usage panels will stay incomplete.", "部分用量面板会不完整。");
  };

  const connectorGapAction = (id: string): string => {
    if (id === "subscription_usage") {
      return pickUiText(language, "Open Settings and connect the subscription or billing snapshot.", "去设置页补上订阅或账单快照即可。");
    }
    if (id === "cost_budget_limit") {
      return pickUiText(language, "Open Settings and add a budget limit.", "去设置页补上预算限额即可。");
    }
    if (id === "request_counter") {
      return pickUiText(language, "Open Settings and connect the request-count source.", "去设置页按建议接通请求计数源即可。");
    }
    if (id === "digest_history") {
      return pickUiText(language, "Keep monitoring running, or use Settings to complete trend history.", "保持监控持续运行，或按设置页建议补齐趋势历史即可。");
    }
    if (id === "context_catalog") {
      return pickUiText(language, "Open Settings and connect model context capacity data.", "去设置页补上模型上下文容量数据即可。");
    }
    if (id === "provider_mapping") {
      return pickUiText(language, "Open Settings and complete the model-to-provider mapping.", "去设置页补上模型到供应商的映射即可。");
    }
    return pickUiText(language, "Open Settings and follow the remaining data-connection suggestions.", "去设置页按建议补齐即可。");
  };

  const firstGap = snapshot.connectors.todos[0];
  let detail = pickUiText(
    language,
    "All six key usage sources are connected, so usage, quota, and attribution can be trusted.",
    "6 项关键用量数据都已接通，用量、额度和归因都可以直接看。",
  );
  let value = pickUiText(language, "Complete", "完整");

  if (connectedCount === totalCount) {
    return { status: "ok", connectedCount, totalCount, missingCount: 0, detail, value };
  }

  if (connectedCount === 0 && partialCount === 0) {
    detail = pickUiText(
      language,
      "None of the six key usage sources are connected yet, so the Usage page will stay very limited until you connect them in Settings.",
      "6 项关键用量数据都还没接通，所以用量页只会显示很有限的信息。先去设置页按建议接入即可。",
    );
    value = pickUiText(language, "Needs setup", "待接入");
    return { status: "blocked", connectedCount, totalCount, missingCount, detail, value };
  }

  if (firstGap) {
    const gapLabel = connectorGapLabel(firstGap.id);
    const impact = connectorGapImpact(firstGap.id);
    const action = connectorGapAction(firstGap.id);
    if (missingCount === 1) {
      detail = pickUiText(
        language,
        `${connectedCount} of ${totalCount} key usage sources are connected; the remaining item is ${gapLabel}. ${impact} ${action}`,
        `6 项关键用量数据里，已经接上 ${connectedCount} 项，还差 1 项：${gapLabel}。${impact}${action}`,
      );
      value = pickUiText(language, "Missing 1", "差 1 项");
    } else {
      detail = pickUiText(
        language,
        `${connectedCount} of ${totalCount} key usage sources are connected, with ${missingCount} items still incomplete. The most important gap right now is ${gapLabel}. ${impact} ${action}`,
        `6 项关键用量数据里，已经接上 ${connectedCount} 项，还差 ${missingCount} 项；当前最影响判断的是「${gapLabel}」。${impact}${action}`,
      );
      value = pickUiText(language, `Missing ${missingCount}`, `差 ${missingCount} 项`);
    }
  } else {
    detail = pickUiText(
      language,
      `${connectedCount} of ${totalCount} key usage sources are connected, but ${missingCount} items are still incomplete. Open Settings and finish the remaining data connections.`,
      `6 项关键用量数据里，已经接上 ${connectedCount} 项，但还有 ${missingCount} 项没有完整接通。去设置页按建议补齐即可。`,
    );
    value = pickUiText(language, `Missing ${missingCount}`, `差 ${missingCount} 项`);
  }

  return {
    status: "warn",
    connectedCount,
    totalCount,
    missingCount,
    detail,
    value,
  };
}

function localizeConnectionInsightValue(
  item: OpenClawConnectionSummary["items"][number],
  language: UiLanguage,
): string {
  if (item.key === "gateway") {
    return item.status === "ok"
      ? pickUiText(language, "Connected", "已接通")
      : pickUiText(language, "Unavailable", "未接通");
  }
  if (item.key === "config") {
    return item.status === "ok"
      ? pickUiText(language, "Ready", "已就绪")
      : pickUiText(language, "Needs fix", "待修复");
  }
  if (item.value === "loading") {
    return pickUiText(language, "Loading", "读取中");
  }
  return item.value;
}

function localizeConnectionInsightDetail(
  item: OpenClawConnectionSummary["items"][number],
  language: UiLanguage,
): string {
  if (item.key === "gateway") {
    return item.status === "ok"
      ? item.detail
      : pickUiText(language, "Gateway is not reachable.", "当前还无法连到 Gateway。");
  }
  if (item.key === "config") {
    const allowedOriginsMatch = item.detail.match(/^(\d+) allowed origin/);
    if (allowedOriginsMatch) {
      const count = Number.parseInt(allowedOriginsMatch[1] ?? "0", 10);
      return pickUiText(
        language,
        `${count} allowed origin${count === 1 ? "" : "s"}`,
        `已配置 ${count} 个允许来源`,
      );
    }
    if (item.detail === "Local-only by default") {
      return pickUiText(language, "Local-only by default.", "默认仅允许本机访问。");
    }
    return pickUiText(language, "openclaw.json is missing or invalid.", "openclaw.json 缺失或配置无效。");
  }
  const runtimeVisibleMatch = item.detail.match(/^(\d+) session(?:s)? visible across (\d+) agent/);
  if (runtimeVisibleMatch) {
    const sessionCount = Number.parseInt(runtimeVisibleMatch[1] ?? "0", 10);
    const agentCount = Number.parseInt(runtimeVisibleMatch[2] ?? "0", 10);
    return pickUiText(
      language,
      `${sessionCount} session${sessionCount === 1 ? "" : "s"} visible across ${agentCount} agent${agentCount === 1 ? "" : "s"}`,
      `已看到 ${sessionCount} 个会话，覆盖 ${agentCount} 个智能体`,
    );
  }
  const configuredMatch = item.detail.match(/^(\d+) agent(?:s)? configured, but no recent sessions yet$/);
  if (configuredMatch) {
    const agentCount = Number.parseInt(configuredMatch[1] ?? "0", 10);
    return pickUiText(
      language,
      `${agentCount} agent${agentCount === 1 ? "" : "s"} configured, but no recent sessions yet`,
      `已配置 ${agentCount} 个智能体，但还没有最近会话`,
    );
  }
  if (item.detail === "Runtime status is still loading") {
    return pickUiText(language, "Runtime status is still loading.", "正在读取运行时状态。");
  }
  return pickUiText(language, "No runtime sessions are visible yet.", "当前还没有看到运行时会话。");
}

function localizeSecurityFinding(
  item: OpenClawSecuritySummary["findings"][number],
  language: UiLanguage,
): { title: string; detail: string; remediation?: string } {
  if (language === "en") {
    return {
      title: item.title,
      detail: item.detail,
      remediation: item.remediation,
    };
  }

  if (item.checkId === "summary.attack_surface") {
    return {
      title: "当前暴露面概览",
      detail: "当前环境更接近个人助理式单一信任边界，而不是多人共享隔离环境；高权限工具和内部钩子仍然可用。",
    };
  }
  if (item.checkId === "gateway.trusted_proxies_missing") {
    return {
      title: "反向代理信任尚未配置",
      detail: "如果你通过反向代理暴露控制中心，当前还没有声明可信代理来源，转发头信息可能被错误信任。",
      remediation: "如果继续通过反向代理访问，请把可信代理 IP 配进 gateway.trustedProxies；否则保持控制中心仅本机访问。",
    };
  }
  if (item.checkId === "gateway.tailscale_serve") {
    return {
      title: "已通过 Tailscale Serve 暴露 Gateway",
      detail: "当前 Gateway 已经通过 Tailscale 暴露到 tailnet，可访问范围不再只限这台机器本地。",
    };
  }
  if (item.checkId === "security.trust_model.multi_user_heuristic") {
    return {
      title: "检测到可能的多人共享使用场景",
      detail: "当前环境看起来不只是单人自用，但 OpenClaw 默认更适合单一可信操作者，不适合把同一 Gateway 当成多人隔离环境。",
      remediation: "如果确实给多人使用，最好拆分成独立 Gateway 或独立系统账号；至少先收紧沙箱、文件访问和高权限工具范围。",
    };
  }

  return {
    title: item.title,
    detail: item.detail,
    remediation: item.remediation,
  };
}

function localizeUpdateChannelLabel(label: string | undefined, language: UiLanguage): string {
  if (!label) return "-";
  if (language === "en") return label;
  if (label === "stable (default)") return "稳定版（默认）";
  if (label === "stable") return "稳定版";
  if (label === "beta") return "测试版";
  if (label === "dev") return "开发版";
  return label;
}

function localizeUpdateInstallKind(kind: string | undefined, language: UiLanguage): string {
  if (!kind) return "-";
  if (language === "en") return kind;
  if (kind === "package") return "软件包";
  if (kind === "git") return "Git";
  return kind;
}

function localizeCurrentVersionValue(summary: OpenClawUpdateSummary, language: UiLanguage): string {
  if (summary.currentVersion) return summary.currentVersion;
  if (summary.latestVersion) return pickUiText(language, "Loading", "读取中");
  return "-";
}

function renderOpenClawConnectionCard(
  summary: OpenClawConnectionSummary | undefined,
  usageCost: UsageCostSnapshot,
  language: UiLanguage,
): string {
  if (!summary) {
    return `<article class="card" id="overview-connection-health">
      <div class="overview-command-head">
        <h2>${escapeHtml(pickUiText(language, "Connection health", "接线状态"))}</h2>
        <div>${badge("info", pickUiText(language, "Loading", "读取中"))}</div>
      </div>
      <div class="empty-state">${escapeHtml(pickUiText(language, "Connection signals are loading.", "正在读取接线状态。"))}</div>
    </article>`;
  }

  const usageSourceSummary = connectorInsightStatus(usageCost, language);
  const rows = [
    ...summary.items.map((item) => ({
      label:
        item.key === "gateway"
          ? pickUiText(language, "Gateway", "网关")
          : item.key === "config"
            ? pickUiText(language, "Config", "配置")
            : pickUiText(language, "Runtime", "运行时"),
      status: item.status,
      detail: localizeConnectionInsightDetail(item, language),
      value: localizeConnectionInsightValue(item, language),
    })),
    {
      label: pickUiText(language, "Usage sources", "用量数据"),
      status: usageSourceSummary.status,
      detail: usageSourceSummary.detail,
      value: usageSourceSummary.value,
    },
  ];
  const connectedCount = rows.filter((item) => item.status === "ok").length;
  const overallStatus =
    summary.status === "blocked" || usageSourceSummary.status === "blocked"
      ? "blocked"
      : summary.status === "warn" || usageSourceSummary.status === "warn"
        ? "warn"
        : summary.status === "info"
          ? "info"
          : "ok";
  const headline =
    overallStatus === "ok"
      ? pickUiText(language, "Control Center is fully connected to this OpenClaw environment.", "控制中心已经完整接上这台 OpenClaw 环境。")
      : overallStatus === "blocked"
        ? pickUiText(language, "Some core links are still blocked.", "有核心接线还没有打通。")
        : pickUiText(language, "Control Center is usable, but some panels are still running in partial mode.", "控制中心已经可用，但有些面板仍处于部分接线状态。");

  return `<article class="card" id="overview-connection-health">
    <div class="overview-command-head">
      <div>
        <h2>${escapeHtml(pickUiText(language, "Connection health", "接线状态"))}</h2>
        <div class="meta">${escapeHtml(headline)}</div>
      </div>
      <a class="btn" href="${escapeHtml(buildHomeHref({ quick: "all" }, true, "settings", language))}">${escapeHtml(
        pickUiText(language, "Open settings", "查看设置"),
      )}</a>
    </div>
    <div class="status-strip">
      <div class="status-chip"><span>${escapeHtml(pickUiText(language, "Healthy links", "已接通"))}</span><strong>${connectedCount}/${rows.length}</strong></div>
      <div class="status-chip"><span>${escapeHtml(pickUiText(language, "Updated", "更新"))}</span><strong>${escapeHtml(formatTimeAgoFromNow(summary.generatedAt, language))}</strong></div>
    </div>
    <div class="decision-list">${rows
      .map(
        (item) => `<div class="decision-row">
          <div class="decision-row-copy">
            <strong>${escapeHtml(item.label)}</strong>
            <div class="meta">${badge(item.status, insightStatusLabel(item.status, language))} ${escapeHtml(item.detail)}</div>
          </div>
          <div class="decision-row-value">${escapeHtml(item.value)}</div>
        </div>`,
      )
      .join("")}</div>
  </article>`;
}

function renderOpenClawSecuritySection(
  summary: OpenClawSecuritySummary | undefined,
  language: UiLanguage,
): string {
  if (!summary) {
    return `<section class="card" id="security-risk-summary">
      <h2>${escapeHtml(pickUiText(language, "Security risk summary", "安全风险摘要"))}</h2>
      <div class="empty-state">${escapeHtml(pickUiText(language, "Security audit is loading.", "正在读取安全审计。"))}</div>
    </section>`;
  }

  const headline =
    summary.status === "blocked"
      ? pickUiText(language, "There are critical security issues to address.", "当前有需要立刻处理的安全风险。")
      : summary.status === "warn"
        ? pickUiText(language, "There are a few configuration risks worth reviewing.", "当前有几项配置风险值得检查。")
        : summary.status === "info"
          ? pickUiText(language, "Security looks stable, with informational notes only.", "当前整体安全稳定，只有信息提示。")
          : pickUiText(language, "No actionable security risk is visible right now.", "当前没有需要处理的安全风险。");
  const findingsHtml =
    summary.findings.length === 0
      ? `<div class="empty-state">${escapeHtml(pickUiText(language, "No audit findings yet.", "当前没有审计结果。"))}</div>`
      : `<ul class="story-list">${summary.findings
          .slice(0, 4)
          .map((item) => {
            const tone = item.severity === "critical" ? "blocked" : item.severity === "warn" ? "warn" : "info";
            const localized = localizeSecurityFinding(item, language);
            return `<li>${badge(tone, insightStatusLabel(tone, language))} <strong>${escapeHtml(localized.title)}</strong><div class="meta">${escapeHtml(
              safeTruncate(normalizeInlineText(localized.detail), 200),
            )}</div>${
              localized.remediation
                ? `<div class="meta">${escapeHtml(pickUiText(language, "Next step", "下一步"))}：${escapeHtml(
                    safeTruncate(normalizeInlineText(localized.remediation), 180),
                  )}</div>`
                : ""
            }</li>`;
          })
          .join("")}</ul>`;

  return `<section class="card" id="security-risk-summary">
    <div class="overview-command-head">
      <div>
        <h2>${escapeHtml(pickUiText(language, "Security risk summary", "安全风险摘要"))}</h2>
        <div class="meta">${escapeHtml(headline)}</div>
      </div>
      <div>${badge(summary.status, insightStatusLabel(summary.status, language))}</div>
    </div>
    <div class="status-strip">
      <div class="status-chip"><span>${escapeHtml(pickUiText(language, "Critical", "高风险"))}</span><strong>${summary.counts.critical}</strong></div>
      <div class="status-chip"><span>${escapeHtml(pickUiText(language, "Warnings", "需关注"))}</span><strong>${summary.counts.warn}</strong></div>
      <div class="status-chip"><span>${escapeHtml(pickUiText(language, "Info", "提示"))}</span><strong>${summary.counts.info}</strong></div>
    </div>
    ${findingsHtml}
  </section>`;
}

function renderOpenClawUpdateSection(
  summary: OpenClawUpdateSummary | undefined,
  language: UiLanguage,
): string {
  if (!summary) {
    return `<section class="card" id="update-status-card">
      <h2>${escapeHtml(pickUiText(language, "Update status", "更新状态"))}</h2>
      <div class="empty-state">${escapeHtml(pickUiText(language, "Update status is loading.", "正在读取更新状态。"))}</div>
    </section>`;
  }

  const headline = summary.updateAvailable
    ? pickUiText(language, "A newer OpenClaw version is available.", "发现了更新版本。")
    : pickUiText(language, "This OpenClaw runtime is already up to date.", "当前 OpenClaw 已是最新。");
  return `<section class="card" id="update-status-card">
    <div class="overview-command-head">
      <div>
        <h2>${escapeHtml(pickUiText(language, "Update status", "更新状态"))}</h2>
        <div class="meta">${escapeHtml(headline)}</div>
      </div>
      <div>${badge(summary.status, insightStatusLabel(summary.status, language))}</div>
    </div>
    <div class="status-strip">
      <div class="status-chip"><span>${escapeHtml(pickUiText(language, "Current", "当前版本"))}</span><strong>${escapeHtml(localizeCurrentVersionValue(summary, language))}</strong></div>
      <div class="status-chip"><span>${escapeHtml(pickUiText(language, "Latest", "最新版本"))}</span><strong>${escapeHtml(summary.latestVersion ?? "-")}</strong></div>
      <div class="status-chip"><span>${escapeHtml(pickUiText(language, "Channel", "更新通道"))}</span><strong>${escapeHtml(localizeUpdateChannelLabel(summary.channelLabel, language))}</strong></div>
    </div>
    <div class="meta">${escapeHtml(pickUiText(language, "Install method", "安装方式"))} ${escapeHtml(localizeUpdateInstallKind(summary.installKind, language))} · ${escapeHtml(
      pickUiText(language, "Package manager", "包管理器"),
    )} ${escapeHtml(summary.packageManager ?? "-")}</div>
  </section>`;
}

function renderContextPressureCard(snapshot: UsageCostSnapshot, language: UiLanguage): string {
  if (snapshot.contextWindows.length === 0) {
    return `<section class="card" id="session-context-pressure">
      <h2>${escapeHtml(pickUiText(language, "Context pressure", "上下文压力"))}</h2>
      <div class="empty-state">${escapeHtml(pickUiText(language, "No session context data yet.", "当前还没有会话上下文数据。"))}</div>
    </section>`;
  }

  const ranked = [...snapshot.contextWindows].sort((a, b) => {
    const rankA = a.thresholdState === "critical" ? 0 : a.thresholdState === "warn" ? 1 : a.thresholdState === "ok" ? 2 : 3;
    const rankB = b.thresholdState === "critical" ? 0 : b.thresholdState === "warn" ? 1 : b.thresholdState === "ok" ? 2 : 3;
    if (rankA !== rankB) return rankA - rankB;
    return (b.usagePercent ?? 0) - (a.usagePercent ?? 0);
  });
  const criticalCount = ranked.filter((item) => item.thresholdState === "critical").length;
  const warnCount = ranked.filter((item) => item.thresholdState === "warn").length;
  const topUsage = ranked[0];
  const headline =
    criticalCount > 0
      ? pickUiText(language, "Some sessions are close to their context ceiling.", "有会话已经接近上下文上限。")
      : warnCount > 0
        ? pickUiText(language, "A few sessions are worth watching.", "有几条会话值得继续盯住。")
        : pickUiText(language, "Context pressure looks healthy right now.", "当前上下文压力整体正常。");

  return `<section class="card" id="session-context-pressure">
    <div class="overview-command-head">
      <div>
        <h2>${escapeHtml(pickUiText(language, "Context pressure", "上下文压力"))}</h2>
        <div class="meta">${escapeHtml(headline)}</div>
      </div>
      <div>${badge(
        criticalCount > 0 ? "warn" : warnCount > 0 ? "info" : "ok",
        criticalCount > 0 ? pickUiText(language, "High", "较高") : warnCount > 0 ? pickUiText(language, "Watch", "观察中") : pickUiText(language, "Healthy", "正常"),
      )}</div>
    </div>
    <div class="status-strip">
      <div class="status-chip"><span>${escapeHtml(pickUiText(language, "Critical", "临界"))}</span><strong>${criticalCount}</strong></div>
      <div class="status-chip"><span>${escapeHtml(pickUiText(language, "Warning", "预警"))}</span><strong>${warnCount}</strong></div>
      <div class="status-chip"><span>${escapeHtml(pickUiText(language, "Highest usage", "最高占比"))}</span><strong>${escapeHtml(
        topUsage?.usagePercent !== undefined ? `${topUsage.usagePercent.toFixed(1)}%` : "-",
      )}</strong></div>
    </div>
    <div class="decision-list">${ranked
      .slice(0, 6)
      .map((item) => {
        const href = buildSessionDetailHref(item.sessionKey, language);
        const tone = item.thresholdState === "critical" ? "warn" : item.thresholdState === "warn" ? "info" : item.thresholdState === "ok" ? "ok" : "blocked";
        const usageText =
          item.usagePercent !== undefined ? `${item.usagePercent.toFixed(1)}%` : pickUiText(language, "Unavailable", "不可用");
        return `<a class="decision-row" href="${escapeHtml(href)}">
          <div class="decision-row-copy">
            <strong>${escapeHtml(simplifyUsageLabel(item.sessionLabel))}</strong>
            <div class="meta">${badge(
              tone,
              item.thresholdState === "critical"
                ? pickUiText(language, "Critical", "临界")
                : item.thresholdState === "warn"
                  ? pickUiText(language, "Warning", "预警")
                  : item.thresholdState === "ok"
                    ? pickUiText(language, "Healthy", "正常")
                    : pickUiText(language, "Unknown", "未知"),
            )} ${escapeHtml(humanizeOperatorLabel(item.agentId))} · ${escapeHtml(item.model)}</div>
            <div class="meta">${escapeHtml(pickUiText(language, "Used", "已使用"))} ${formatInt(item.usedTokens)} / ${item.contextLimitTokens ? formatInt(item.contextLimitTokens) : "-"} · ${escapeHtml(item.paceLabel)}</div>
          </div>
          <div class="decision-row-value">${escapeHtml(usageText)}</div>
        </a>`;
      })
      .join("")}</div>
  </section>`;
}

function renderMemoryStateSection(summary: OpenClawMemorySummary | undefined, language: UiLanguage): string {
  if (!summary) {
    return `<section class="card" id="memory-status-card">
      <h2>${escapeHtml(pickUiText(language, "Memory status", "记忆状态"))}</h2>
      <div class="empty-state">${escapeHtml(pickUiText(language, "Memory status is loading.", "正在读取记忆状态。"))}</div>
    </section>`;
  }

  const headline =
    summary.status === "blocked"
      ? pickUiText(language, "Some agents still do not have usable memory.", "有智能体的记忆还不可用。")
      : summary.status === "warn"
        ? pickUiText(language, "Memory works, but some agents still need attention.", "记忆整体可用，但有些智能体还需要检查。")
        : pickUiText(language, "Memory looks healthy for the visible agents.", "当前可见智能体的记忆状态正常。");

  return `<section class="card" id="memory-status-card">
    <div class="overview-command-head">
      <div>
        <h2>${escapeHtml(pickUiText(language, "Memory status", "记忆状态"))}</h2>
        <div class="meta">${escapeHtml(headline)}</div>
      </div>
      <div>${badge(summary.status, insightStatusLabel(summary.status, language))}</div>
    </div>
    <div class="status-strip">
      <div class="status-chip"><span>${escapeHtml(pickUiText(language, "Healthy", "正常"))}</span><strong>${summary.okCount}</strong></div>
      <div class="status-chip"><span>${escapeHtml(pickUiText(language, "Needs attention", "需关注"))}</span><strong>${summary.warnCount}</strong></div>
      <div class="status-chip"><span>${escapeHtml(pickUiText(language, "Unavailable", "不可用"))}</span><strong>${summary.blockedCount}</strong></div>
    </div>
    <div class="decision-list">${summary.agents
      .map((item) => {
        const detailParts = [
          `${formatInt(item.files)} ${pickUiText(language, "files", "份记忆")}`,
          `${formatInt(item.chunks)} ${pickUiText(language, "chunks", "个块")}`,
          item.searchable ? pickUiText(language, "searchable", "可搜索") : pickUiText(language, "search not ready", "搜索未就绪"),
        ];
        if (item.issuesCount > 0) {
          detailParts.push(pickUiText(language, `${item.issuesCount} issue(s)`, `${item.issuesCount} 个异常`));
        } else if (item.dirty) {
          detailParts.push(pickUiText(language, "refresh pending", "待刷新"));
        }
        if (item.lastUpdateAt) {
          detailParts.push(
            pickUiText(language, `updated ${formatTimeAgoFromNow(item.lastUpdateAt, language)}`, `${formatTimeAgoFromNow(item.lastUpdateAt, language)} 更新`),
          );
        }
        return `<div class="decision-row">
          <div class="decision-row-copy">
            <strong>${escapeHtml(humanizeOperatorLabel(item.agentId))}</strong>
            <div class="meta">${badge(item.status, insightStatusLabel(item.status, language))} ${escapeHtml(detailParts.join(" · "))}</div>
          </div>
          <div class="decision-row-value">${escapeHtml(item.searchable ? pickUiText(language, "Ready", "可用") : pickUiText(language, "Check", "检查"))}</div>
        </div>`;
      })
      .join("")}</div>
  </section>`;
}

function scoreCoverageStatus(status: DataCoverageStatus): number {
  if (status === "connected") return 100;
  if (status === "partial") return 55;
  return 0;
}

function snapshotFreshnessSignal(
  generatedAt: string,
  language: UiLanguage,
): InformationCertaintySignal {
  const ageMs = Math.max(0, Date.now() - toSortableMs(generatedAt));
  const ageLabel = formatTimeAgoFromNow(generatedAt, language);
  if (ageMs <= 10 * 60 * 1000) {
    return {
      key: "freshness",
      label: pickUiText(language, "Live picture", "实时画面"),
      status: "connected",
      detail: pickUiText(
        language,
        `Updated ${ageLabel}; suitable for deciding what is happening now.`,
        `更新于${ageLabel}，适合直接判断现在发生了什么。`,
      ),
    };
  }
  if (ageMs <= 30 * 60 * 1000) {
    return {
      key: "freshness",
      label: pickUiText(language, "Live picture", "实时画面"),
      status: "partial",
      detail: pickUiText(
        language,
        `Updated ${ageLabel}; still useful, but not precise enough for second-by-second judgement.`,
        `更新于${ageLabel}，仍然有参考价值，但不适合做秒级判断。`,
      ),
    };
  }
  return {
    key: "freshness",
    label: pickUiText(language, "Live picture", "实时画面"),
    status: "not_connected",
    detail: pickUiText(
      language,
      `Last refresh was ${ageLabel}; treat the current picture as delayed.`,
      `最近一次刷新是${ageLabel}，当前画面应视为有延迟。`,
    ),
  };
}

function usageCoverageStatus(usage: UsageCostSnapshot): DataCoverageStatus {
  if (
    usage.connectors.requestCounts === "connected" &&
    usage.connectors.providerAttribution !== "not_connected"
  ) {
    return "connected";
  }
  if (
    usage.connectors.requestCounts !== "not_connected" ||
    usage.connectors.digestHistory !== "not_connected" ||
    usage.connectors.providerAttribution !== "not_connected"
  ) {
    return "partial";
  }
  return "not_connected";
}

function historyCoverageStatus(
  replay: Awaited<ReturnType<typeof loadReplayIndex>>,
): DataCoverageStatus {
  if (replay.timeline.entries.length > 0 && replay.digests.length > 0) return "connected";
  if (
    replay.timeline.entries.length > 0 ||
    replay.digests.length > 0 ||
    replay.exportSnapshots.length > 0 ||
    replay.exportBundles.length > 0
  ) {
    return "partial";
  }
  return "not_connected";
}

function buildInformationCertaintyModel(input: {
  snapshot: ReadModelSnapshot;
  officeRoster: AgentRosterSnapshot;
  officePresence: OfficeSessionPresenceSnapshot;
  usageCost: UsageCostSnapshot;
  replayPreview: Awaited<ReturnType<typeof loadReplayIndex>>;
  language: UiLanguage;
}): InformationCertaintyModel {
  const { snapshot, officeRoster, officePresence, usageCost, replayPreview, language } = input;
  const freshness = snapshotFreshnessSignal(snapshot.generatedAt, language);
  const usageStatus = usageCoverageStatus(usageCost);
  const historyStatus = historyCoverageStatus(replayPreview);
  const signals: InformationCertaintySignal[] = [
    freshness,
    {
      key: "roster",
      label: pickUiText(language, "Staff and owners", "员工与负责人"),
      status: officeRoster.status,
      detail:
        officeRoster.status === "connected"
          ? pickUiText(language, "Staff roster and ownership signals are readable.", "员工名单和负责人信号可读。")
          : officeRoster.status === "partial"
            ? pickUiText(language, "Only part of the staff roster is visible.", "目前只能看到部分员工名单。")
            : pickUiText(language, "Staff roster is missing, so ownership may be incomplete.", "员工名单未连上，负责人视图可能不完整。"),
    },
    {
      key: "live_sessions",
      label: pickUiText(language, "Live execution", "实时执行"),
      status: officePresence.status,
      detail:
        officePresence.status === "connected"
          ? officePresence.totalActiveSessions > 0
            ? pickUiText(
                language,
                `${officePresence.totalActiveSessions} live sessions are visible right now.`,
                `当前可见 ${officePresence.totalActiveSessions} 个实时执行中的会话。`,
              )
            : pickUiText(language, "Live session signal is connected; nothing is actively running right now.", "实时会话信号已连上；当前没有执行中的会话。")
          : officePresence.status === "partial"
            ? pickUiText(language, "Only part of the live execution signal is visible.", "当前只能看到部分实时执行信号。")
            : pickUiText(language, "Only static snapshot data is visible, so current execution may be under-reported.", "当前只能看到静态快照，实时执行可能看不全。"),
    },
    {
      key: "usage",
      label: pickUiText(language, "AI usage and cost", "AI 用量与费用"),
      status: usageStatus,
      detail:
        usageStatus === "connected"
          ? pickUiText(language, "Usage and cost data are connected.", "用量和费用数据已连上。")
          : usageStatus === "partial"
            ? pickUiText(language, "Usage trend is visible, but some cost or provider detail is still incomplete.", "已经能看到用量趋势，但费用或供应商细节还不完整。")
            : pickUiText(language, "Usage and cost are still a blind spot.", "用量和费用目前仍是盲区。"),
    },
    {
      key: "subscription",
      label: pickUiText(language, "Subscription room", "订阅额度"),
      status: usageCost.subscription.status as DataCoverageStatus,
      detail:
        usageCost.subscription.status === "connected"
          ? pickUiText(language, "Subscription remaining and reset window are visible.", "订阅剩余额度和重置窗口可见。")
          : usageCost.subscription.status === "partial"
            ? pickUiText(language, "Subscription data exists, but part of the billing picture is missing.", "订阅数据已经有了，但账单画面还不完整。")
            : pickUiText(language, "Remaining subscription room is not confirmed yet.", "剩余额度目前还不能完全确认。"),
    },
    {
      key: "history",
      label: pickUiText(language, "Replay history", "回放历史"),
      status: historyStatus,
      detail:
        historyStatus === "connected"
          ? pickUiText(language, "Recent activity and trend history can both be replayed.", "最近活动和趋势历史都可以回看。")
          : historyStatus === "partial"
            ? pickUiText(language, "Only part of the replay history is visible.", "目前只能回看部分历史。")
            : pickUiText(language, "Replay history is still too thin to explain change over time.", "回放历史还不够厚，难以解释长期变化。"),
    },
  ];

  const weights = new Map<string, number>([
    ["freshness", 24],
    ["roster", 12],
    ["live_sessions", 18],
    ["usage", 20],
    ["subscription", 10],
    ["history", 16],
  ]);
  const totalWeight = [...weights.values()].reduce((sum, value) => sum + value, 0);
  const score = Math.round(
    signals.reduce((sum, signal) => sum + scoreCoverageStatus(signal.status) * (weights.get(signal.key) ?? 0), 0) /
      Math.max(1, totalWeight),
  );

  const strengths = signals
    .filter((signal) => signal.status === "connected")
    .slice(0, 3)
    .map((signal) => {
      if (signal.key === "freshness") {
        return pickUiText(language, "The home picture is fresh enough for current-state decisions.", "首页画面够新，可以直接拿来判断当前状态。");
      }
      if (signal.key === "live_sessions") {
        return pickUiText(language, "Current execution is visible, not just task records on a board.", "现在能看到真实执行中的会话，而不只是任务板上的记录。");
      }
      if (signal.key === "usage") {
        return pickUiText(language, "AI usage and spending can be watched before they become a surprise.", "AI 用量和花费可以提前观察，不容易突然失控。");
      }
      if (signal.key === "history") {
        return pickUiText(language, "You can look back at recent activity instead of relying on memory.", "可以回看最近发生了什么，不必只靠记忆。");
      }
      if (signal.key === "subscription") {
        return pickUiText(language, "Remaining subscription room is visible.", "订阅剩余额度是可见的。");
      }
      return pickUiText(language, "The people-and-ownership view is readable.", "人员和负责关系是可读的。");
    });

  const gaps = signals
    .filter((signal) => signal.status !== "connected")
    .slice(0, 3)
    .map((signal) => {
      if (signal.key === "freshness") {
        return pickUiText(language, "This picture is delayed, so fast changes may not be reflected yet.", "当前画面有延迟，快速变化可能还没有反映出来。");
      }
      if (signal.key === "live_sessions") {
        return pickUiText(language, "You may not be seeing every session that is still running.", "你可能还看不全所有正在执行的会话。");
      }
      if (signal.key === "usage") {
        return pickUiText(language, "AI spending is only partially visible, so cost judgement is conservative.", "AI 花费目前只能看见一部分，因此费用判断会偏保守。");
      }
      if (signal.key === "subscription") {
        return pickUiText(language, "Remaining package room is still unconfirmed.", "套餐剩余额度目前还没有被完全确认。");
      }
      if (signal.key === "history") {
        return pickUiText(language, "History is thin, so long-term explanations may be weak.", "历史记录偏薄，长期变化的解释力会比较弱。");
      }
      return pickUiText(language, "Some staff or ownership signals are still missing.", "部分人员或负责关系信号还缺失。");
    });

  if (strengths.length === 0) {
    strengths.push(
      pickUiText(language, "At least the current dashboard structure is readable even while signals are still sparse.", "即使信号还稀疏，当前看板结构本身仍然可读。"),
    );
  }
  if (gaps.length === 0) {
    gaps.push(
      pickUiText(language, "No obvious blind spot is standing out right now.", "当前没有明显突出的盲区。"),
    );
  }

  if (score >= 80) {
    return {
      score,
      badgeStatus: "ok",
      badgeLabel: pickUiText(language, "High certainty", "高确定性"),
      headline: pickUiText(language, "This picture is trustworthy enough for day-to-day decisions.", "这张画面已经足够支撑日常判断。"),
      summary: pickUiText(language, "Most key signals are connected, so you can judge OpenClaw from one screen with relatively high confidence.", "大部分关键信号都已连上，可以比较放心地用这一屏判断 OpenClaw 的当前状态。"),
      strengths,
      gaps,
      signals,
    };
  }
  if (score >= 55) {
    return {
      score,
      badgeStatus: "warn",
      badgeLabel: pickUiText(language, "Medium certainty", "中等确定性"),
      headline: pickUiText(language, "The main picture is visible, but there are still blind spots.", "主画面已经能看，但仍然有盲区。"),
      summary: pickUiText(language, "You can judge the main direction, but some parts still need more evidence before you fully trust them.", "大方向已经能判断，但其中有些区域还需要更多证据才能完全放心。"),
      strengths,
      gaps,
      signals,
    };
  }
  return {
    score,
    badgeStatus: "blocked",
    badgeLabel: pickUiText(language, "Low certainty", "低确定性"),
    headline: pickUiText(language, "Important parts of the picture are still missing.", "这张画面还有关键缺口。"),
    summary: pickUiText(language, "The dashboard is usable, but some information should still be treated as a clue rather than a confirmed fact.", "当前看板虽然可用，但其中一部分信息还更像线索，不适合当作已经确认的事实。"),
    strengths,
    gaps,
    signals,
  };
}

function renderInformationCertaintyCard(
  model: InformationCertaintyModel,
  language: UiLanguage = "zh",
): string {
  const connectedCount = model.signals.filter((signal) => signal.status === "connected").length;
  const partialCount = model.signals.filter((signal) => signal.status === "partial").length;
  const blindSpotCount = model.signals.filter((signal) => signal.status === "not_connected").length;
  return `<section class="card" id="information-certainty">
      <div class="overview-command-head">
        <div>
          <h2>${escapeHtml(pickUiText(language, "Information certainty", "信息确定性"))}</h2>
          <div class="meta">${escapeHtml(pickUiText(language, "This answers how much of OpenClaw you can confidently see right now.", "这块回答的是：你现在对 OpenClaw 的了解，有多少是可以放心相信的。"))}</div>
        </div>
        <div>${badge(model.badgeStatus, model.badgeLabel)}</div>
      </div>
      <div class="task-hub-stat-grid">
        <article class="task-hub-stat">
          <span>${escapeHtml(pickUiText(language, "Certainty score", "确定性分数"))}</span>
          <strong>${model.score}</strong>
          <small>${escapeHtml(model.headline)}</small>
        </article>
        <article class="task-hub-stat">
          <span>${escapeHtml(pickUiText(language, "Reliable areas", "可靠区域"))}</span>
          <strong>${connectedCount}</strong>
          <small>${escapeHtml(pickUiText(language, "Areas already backed by connected signals", "已经有完整信号支撑的区域"))}</small>
        </article>
        <article class="task-hub-stat">
          <span>${escapeHtml(pickUiText(language, "Blind spots", "盲区"))}</span>
          <strong>${blindSpotCount}</strong>
          <small>${escapeHtml(pickUiText(language, "Areas that still need more evidence", "仍然需要补证据的区域"))}</small>
        </article>
      </div>
      <div class="meta">${escapeHtml(model.summary)}</div>
      <div style="height:10px;"></div>
      <div class="task-hub-grid task-hub-board-grid">
        <section class="card">
          <h3 style="margin:0 0 6px 0;">${escapeHtml(pickUiText(language, "What you can trust now", "目前可以放心看的"))}</h3>
          <ul class="story-list">${model.strengths.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        </section>
        <section class="card">
          <h3 style="margin:0 0 6px 0;">${escapeHtml(pickUiText(language, "What may still be incomplete", "可能还不完整的地方"))}</h3>
          <ul class="story-list">${model.gaps.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        </section>
      </div>
      <details class="compact-table-details" style="margin-top:12px;" open>
        <summary>${escapeHtml(pickUiText(language, "Open certainty breakdown", "展开确定性拆解"))} · ${connectedCount}/${model.signals.length} ${escapeHtml(pickUiText(language, "connected", "已连上"))} · ${partialCount} ${escapeHtml(pickUiText(language, "partial", "部分"))} · ${blindSpotCount} ${escapeHtml(pickUiText(language, "blind spot", "盲区"))}</summary>
        <div class="fold-body">
          <table>
            <thead><tr><th>${escapeHtml(pickUiText(language, "Area", "区域"))}</th><th>${escapeHtml(pickUiText(language, "Status", "状态"))}</th><th>${escapeHtml(pickUiText(language, "What it means", "这意味着什么"))}</th></tr></thead>
            <tbody>${model.signals
              .map(
                (signal) =>
                  `<tr><td>${escapeHtml(signal.label)}</td><td>${badge(signal.status, dataConnectionLabel(signal.status, language))}</td><td>${escapeHtml(signal.detail)}</td></tr>`,
              )
              .join("")}</tbody>
          </table>
        </div>
      </details>
    </section>`;
}

function formatTimeAgoFromNow(value: string | undefined, language: UiLanguage = "zh"): string {
  const parsed = toSortableMs(value);
  if (!parsed) return pickUiText(language, "time unavailable", "时间未知");
  const diffSeconds = Math.max(0, Math.round((Date.now() - parsed) / 1000));
  if (diffSeconds < 60) return pickUiText(language, "just now", "刚刚");
  if (diffSeconds < 3600) {
    const minutes = Math.max(1, Math.round(diffSeconds / 60));
    return pickUiText(language, `${minutes}m ago`, `${minutes} 分钟前`);
  }
  if (diffSeconds < 86400) {
    const hours = Math.max(1, Math.round(diffSeconds / 3600));
    return pickUiText(language, `${hours}h ago`, `${hours} 小时前`);
  }
  const days = Math.max(1, Math.round(diffSeconds / 86400));
  return pickUiText(language, `${days}d ago`, `${days} 天前`);
}

function pickLatestTimestamp(values: Array<string | undefined>): string | undefined {
  let latestValue: string | undefined;
  let latestMs = 0;
  for (const value of values) {
    const parsed = toSortableMs(value);
    if (parsed > latestMs) {
      latestMs = parsed;
      latestValue = value;
    }
  }
  return latestValue;
}

function isSameLocalCalendarDay(value: string | undefined, nowMs: number): boolean {
  const parsed = toSortableMs(value);
  if (!parsed) return false;
  const a = new Date(parsed);
  const b = new Date(nowMs);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function hasFreshRuntimeTimestamp(value: string | undefined, nowMs: number, windowMs: number): boolean {
  const parsed = toSortableMs(value);
  return parsed > 0 && nowMs - parsed <= windowMs;
}

function isStaleRuntimeTimestamp(value: string | undefined, nowMs: number, windowMs: number): boolean {
  const parsed = toSortableMs(value);
  return parsed > 0 && nowMs - parsed > windowMs;
}

function pickLatestSessionActivityTimestamp(...values: Array<string | undefined>): string | undefined {
  let latest: string | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const parsed = toSortableMs(value);
    if (parsed <= 0 || parsed <= latestMs) continue;
    latest = value;
    latestMs = parsed;
  }
  return latest;
}

function countStalledRunningSessions(
  sessions: ReadModelSnapshot["sessions"],
  sessionItems: SessionConversationListItem[],
  nowMs: number,
  windowMs = STALLED_RUNNING_SESSION_WINDOW_MS,
): number {
  const latestBySessionKey = new Map(
    sessionItems.map((item) => [
      item.sessionKey,
      pickLatestSessionActivityTimestamp(item.latestHistoryAt, item.lastMessageAt),
    ]),
  );
  return sessions.filter((session) => {
    if (session.state !== "running") return false;
    const latestAt = pickLatestSessionActivityTimestamp(
      latestBySessionKey.get(session.sessionKey),
      session.lastMessageAt,
    );
    return isStaleRuntimeTimestamp(latestAt, nowMs, windowMs);
  }).length;
}

function buildTaskCertaintyCards(input: {
  tasks: TaskListItem[];
  sessions: ReadModelSnapshot["sessions"];
  sessionItems: SessionConversationListItem[];
  approvals: ReadModelSnapshot["approvals"];
  language: UiLanguage;
}): TaskCertaintyCard[] {
  const previewByKey = new Map(input.sessionItems.map((item) => [item.sessionKey, item]));
  const snapshotByKey = new Map(input.sessions.map((session) => [session.sessionKey, session]));
  const pendingApprovalSessionKeys = new Set(
    input.approvals
      .filter((item) => item.status === "pending" && typeof item.sessionKey === "string" && item.sessionKey.trim())
      .map((item) => item.sessionKey!.trim()),
  );
  const nowMs = Date.now();

  return input.tasks
    .filter((task) => task.status !== "done")
    .map((task) => {
      const linkedSessionKeys = [...new Set(task.sessionKeys.map((item) => item.trim()).filter(Boolean))];
      let visibleSessionCount = 0;
      let liveSessionCount = 0;
      let blockedSessionCount = 0;
      let errorSessionCount = 0;
      let waitingApprovalSessionCount = 0;
      let recentActivityCount = 0;
      let executionEvidenceCount = 0;
      let toolEvidenceCount = 0;
      const signalTimes: Array<string | undefined> = [];

      for (const sessionKey of linkedSessionKeys) {
        const preview = previewByKey.get(sessionKey);
        const snapshotSession = snapshotByKey.get(sessionKey);
        if (preview || snapshotSession) visibleSessionCount += 1;
        const state = preview?.state ?? snapshotSession?.state;
        if (state === "running") liveSessionCount += 1;
        if (state === "blocked") blockedSessionCount += 1;
        if (state === "error") errorSessionCount += 1;
        if (state === "waiting_approval") waitingApprovalSessionCount += 1;
        const latestAt = pickLatestSessionActivityTimestamp(
          preview?.latestHistoryAt,
          preview?.lastMessageAt,
          snapshotSession?.lastMessageAt,
        );
        signalTimes.push(latestAt);
        if (hasFreshRuntimeTimestamp(latestAt, nowMs, TASK_RUNTIME_ACTIVITY_WINDOW_MS)) {
          recentActivityCount += 1;
        }
        if (preview?.executionChain?.accepted || preview?.executionChain?.spawned) executionEvidenceCount += 1;
        if ((preview?.toolEventCount ?? 0) > 0 || preview?.latestKind === "tool_event") toolEvidenceCount += 1;
      }

      const latestSignalAt = pickLatestTimestamp(signalTimes);
      const pendingApprovals = linkedSessionKeys.filter((sessionKey) => pendingApprovalSessionKeys.has(sessionKey)).length;
      const staleLinkedSessions =
        linkedSessionKeys.length > 0 && visibleSessionCount > 0 && liveSessionCount === 0 && recentActivityCount === 0;

      let score = 24;
      if (linkedSessionKeys.length > 0) score += 24;
      if (visibleSessionCount > 0) score += 12;
      if (liveSessionCount > 0) score += 18;
      if (recentActivityCount > 0) score += 16;
      if (toolEvidenceCount > 0) score += 8;
      if (executionEvidenceCount > 0) score += 10;
      if (pendingApprovals > 0) score -= Math.min(18, pendingApprovals * 8);
      if (waitingApprovalSessionCount > 0) score -= 14;
      if (blockedSessionCount > 0) score -= 24;
      if (errorSessionCount > 0) score -= 30;
      if (staleLinkedSessions) score -= 12;
      score = Math.max(0, Math.min(100, score));

      const evidence: string[] = [];
      const gaps: string[] = [];

      if (linkedSessionKeys.length > 0) {
        evidence.push(
          pickUiText(
            input.language,
            `${linkedSessionKeys.length} linked session(s)`,
            `已关联 ${linkedSessionKeys.length} 个会话`,
          ),
        );
      } else {
        gaps.push(pickUiText(input.language, "No execution session is linked yet.", "还没有关联执行会话。"));
      }

      if (visibleSessionCount > 0) {
        evidence.push(
          pickUiText(
            input.language,
            `${visibleSessionCount} linked session(s) are visible in runtime.`,
            `运行时里可见 ${visibleSessionCount} 个关联会话。`,
          ),
        );
      } else if (linkedSessionKeys.length > 0) {
        gaps.push(
          pickUiText(
            input.language,
            "Session keys exist, but runtime details are still missing.",
            "已经写了会话键，但运行时详情还没出现。",
          ),
        );
      }

      if (liveSessionCount > 0) {
        evidence.push(
          pickUiText(
            input.language,
            `${liveSessionCount} live session(s) are still running.`,
            `当前仍有 ${liveSessionCount} 个执行中的会话。`,
          ),
        );
      }
      if (recentActivityCount > 0 && latestSignalAt) {
        evidence.push(
          pickUiText(
            input.language,
            `Recent activity was seen ${formatTimeAgoFromNow(latestSignalAt, input.language)}.`,
            `最近活动发生在${formatTimeAgoFromNow(latestSignalAt, input.language)}。`,
          ),
        );
      } else if (linkedSessionKeys.length > 0) {
        gaps.push(
          pickUiText(
            input.language,
            "No fresh runtime activity was seen in the last 6 hours.",
            "最近 6 小时还没有看到新的运行信号。",
          ),
        );
      }

      if (toolEvidenceCount > 0) {
        evidence.push(pickUiText(input.language, "Tool activity is visible.", "已经看到工具调用痕迹。"));
      }
      if (executionEvidenceCount > 0) {
        evidence.push(pickUiText(input.language, "Accepted/spawned execution evidence is visible.", "已看到接单/派发执行证据。"));
      }
      if (pendingApprovals > 0) {
        gaps.push(
          pickUiText(
            input.language,
            `${pendingApprovals} linked approval item(s) are still waiting.`,
            `还有 ${pendingApprovals} 个关联审批在等待处理。`,
          ),
        );
      }
      if (waitingApprovalSessionCount > 0) {
        gaps.push(pickUiText(input.language, "A linked session is waiting for approval.", "有会话卡在等待审批。"));
      }
      if (blockedSessionCount > 0) {
        gaps.push(pickUiText(input.language, "A linked session is blocked.", "有会话已经进入阻塞状态。"));
      }
      if (errorSessionCount > 0) {
        gaps.push(pickUiText(input.language, "A linked session is in error state.", "有会话已经进入异常状态。"));
      }

      const tone: TaskCertaintyCard["tone"] =
        errorSessionCount > 0
          ? "blocked"
          : score >= 78 && blockedSessionCount === 0 && waitingApprovalSessionCount === 0 && pendingApprovals === 0 && !staleLinkedSessions
            ? "ok"
            : score >= 50
              ? "warn"
              : "blocked";
      const toneLabel =
        tone === "ok"
          ? pickUiText(input.language, "Evidence is strong", "证据充分")
          : tone === "warn"
            ? pickUiText(input.language, "Needs follow-up", "还需跟进")
            : pickUiText(input.language, "Evidence is weak", "证据偏弱");
      const summary =
        tone === "ok"
          ? pickUiText(input.language, "Runtime shows this task is actively being carried.", "运行时已经证明这个任务正在被真正执行。")
          : errorSessionCount > 0
            ? pickUiText(input.language, "A linked session is failing, so this task needs intervention.", "关联会话已经报错，这个任务现在需要介入。")
            : blockedSessionCount > 0 || waitingApprovalSessionCount > 0 || pendingApprovals > 0
              ? pickUiText(input.language, "Runtime shows the task exists, but it is waiting on a blocker or approval.", "运行时已经看到这个任务，但它现在卡在阻塞或审批上。")
              : staleLinkedSessions
                ? pickUiText(input.language, "This task has historical traces, but no fresh runtime signal right now.", "这个任务有历史痕迹，但现在没有新的运行信号。")
                : pickUiText(input.language, "Right now there is not enough runtime evidence to say this task is truly moving.", "目前还没有足够的运行证据证明这个任务真的在推进。");

      return {
        taskId: task.taskId,
        title: task.title,
        projectTitle: task.projectTitle,
        owner: task.owner,
        score,
        tone,
        toneLabel,
        summary,
        evidence: evidence.slice(0, 4),
        gaps: gaps.slice(0, 4),
        detailHref: buildTaskDetailHref(task.taskId, input.language),
      };
    })
    .sort((a, b) => {
      const toneRank = taskCertaintyToneRank(a.tone) - taskCertaintyToneRank(b.tone);
      if (toneRank !== 0) return toneRank;
      if (a.score !== b.score) return a.score - b.score;
      return a.taskId.localeCompare(b.taskId);
    });
}

function taskCertaintyToneRank(tone: TaskCertaintyCard["tone"]): number {
  if (tone === "blocked") return 0;
  if (tone === "warn") return 1;
  return 2;
}

function renderTaskCertaintySection(
  cards: TaskCertaintyCard[],
  language: UiLanguage = "zh",
): string {
  if (cards.length === 0) {
    return `<section class="card" id="task-certainty-board">
        <h2>${escapeHtml(pickUiText(language, "Execution certainty", "执行确定性"))}</h2>
        <div class="meta">${escapeHtml(pickUiText(language, "This answers whether OpenClaw is really carrying a task, not just whether the task exists on the board.", "这块回答的不是任务有没有写在看板上，而是 OpenClaw 是否真的把它接住并推进了。"))}</div>
        <div class="empty-state">${escapeHtml(pickUiText(language, "There is no in-flight task under the current filter.", "当前筛选下没有需要判断执行确定性的进行中任务。"))}</div>
      </section>`;
  }

  const strongCount = cards.filter((item) => item.tone === "ok").length;
  const followupCount = cards.filter((item) => item.tone === "warn").length;
  const weakCount = cards.filter((item) => item.tone === "blocked").length;
  return `<section class="card" id="task-certainty-board">
      <div class="overview-command-head">
        <div>
          <h2>${escapeHtml(pickUiText(language, "Execution certainty", "执行确定性"))}</h2>
          <div class="meta">${escapeHtml(pickUiText(language, "This answers whether OpenClaw is really carrying a task, not just whether the task exists on the board.", "这块回答的不是任务有没有写在看板上，而是 OpenClaw 是否真的把它接住并推进了。"))}</div>
        </div>
        <div>${badge(weakCount > 0 ? "warn" : "ok", weakCount > 0 ? pickUiText(language, "Needs follow-up", "需要跟进") : pickUiText(language, "Clear enough", "比较清楚"))}</div>
      </div>
      <div class="task-hub-stat-grid">
        <article class="task-hub-stat">
          <span>${escapeHtml(pickUiText(language, "Evidence is strong", "证据充分"))}</span>
          <strong>${strongCount}</strong>
          <small>${escapeHtml(pickUiText(language, "Tasks already backed by live evidence", "已经有实时证据支撑的任务"))}</small>
        </article>
        <article class="task-hub-stat">
          <span>${escapeHtml(pickUiText(language, "Needs follow-up", "还需跟进"))}</span>
          <strong>${followupCount}</strong>
          <small>${escapeHtml(pickUiText(language, "Tasks that are visible but still need one more proof point", "已经能看见，但还缺一块证据的任务"))}</small>
        </article>
        <article class="task-hub-stat">
          <span>${escapeHtml(pickUiText(language, "Evidence is weak", "证据偏弱"))}</span>
          <strong>${weakCount}</strong>
          <small>${escapeHtml(pickUiText(language, "Tasks that still look uncertain", "目前仍然看起来不够确定的任务"))}</small>
        </article>
      </div>
      <div class="decision-list">${cards
        .slice(0, 8)
        .map(
          (card) => `<a class="decision-row" href="${escapeHtml(card.detailHref)}">
              <div class="decision-row-copy">
                <strong>${escapeHtml(card.title)}</strong>
                <div class="meta">${badge(card.tone, card.toneLabel)} · ${escapeHtml(card.projectTitle)} · ${escapeHtml(pickUiText(language, "Owner", "负责人"))} ${escapeHtml(card.owner)}</div>
                <div class="meta">${escapeHtml(card.summary)}</div>
                <div class="meta">${escapeHtml(pickUiText(language, "Confirmed", "已确认"))}：${escapeHtml(card.evidence.join(" · ") || pickUiText(language, "No direct evidence yet.", "暂时没有直接证据。"))}</div>
                <div class="meta">${escapeHtml(pickUiText(language, "Still missing", "仍待确认"))}：${escapeHtml(card.gaps.join(" · ") || pickUiText(language, "No obvious gap right now.", "当前没有明显缺口。"))}</div>
              </div>
              <div class="decision-row-value">${card.score}</div>
            </a>`,
        )
        .join("")}</div>
    </section>`;
}

function mergeSessionConversationItems(
  primary: SessionConversationListItem[],
  secondary: SessionConversationListItem[],
): SessionConversationListItem[] {
  const merged = new Map<string, SessionConversationListItem>();
  for (const item of [...primary, ...secondary]) {
    const sessionKey = item.sessionKey.trim();
    if (!sessionKey) continue;
    const existing = merged.get(sessionKey);
    merged.set(sessionKey, existing ? mergeSessionConversationItem(existing, item) : item);
  }
  return [...merged.values()];
}

function mergeSessionConversationItem(
  existing: SessionConversationListItem,
  incoming: SessionConversationListItem,
): SessionConversationListItem {
  return {
    ...existing,
    ...incoming,
    label: incoming.label ?? existing.label,
    agentId: incoming.agentId ?? existing.agentId,
    state: incoming.state ?? existing.state,
    lastMessageAt: pickLatestTimestamp([existing.lastMessageAt, incoming.lastMessageAt]) ?? incoming.lastMessageAt ?? existing.lastMessageAt,
    taskSnippet: pickRicherSessionText(existing.taskSnippet, incoming.taskSnippet),
    latestSnippet: pickRicherSessionText(existing.latestSnippet, incoming.latestSnippet),
    latestRole: incoming.latestRole ?? existing.latestRole,
    latestKind: incoming.latestKind ?? existing.latestKind,
    latestToolName: incoming.latestToolName ?? existing.latestToolName,
    latestHistoryAt: pickLatestTimestamp([existing.latestHistoryAt, incoming.latestHistoryAt]) ?? incoming.latestHistoryAt ?? existing.latestHistoryAt,
    historyCount: Math.max(existing.historyCount, incoming.historyCount),
    toolEventCount: Math.max(existing.toolEventCount, incoming.toolEventCount),
    historyError: existing.historyError || incoming.historyError,
    executionChain:
      existing.executionChain && incoming.executionChain
        ? mergeExecutionChainSummaries(existing.executionChain, incoming.executionChain)
        : incoming.executionChain ?? existing.executionChain,
    interSessionSignals: mergeInterSessionSignals(existing.interSessionSignals, incoming.interSessionSignals),
  };
}

function pickRicherSessionText(current: string | undefined, incoming: string | undefined): string | undefined {
  const currentText = normalizeInlineText(current ?? "");
  const incomingText = normalizeInlineText(incoming ?? "");
  if (!currentText) return incomingText || undefined;
  if (!incomingText) return currentText || undefined;
  if (incomingText.length > currentText.length) return incomingText;
  return currentText;
}

function mergeExecutionChainSummaries(
  current: SessionExecutionChainSummary,
  incoming: SessionExecutionChainSummary,
): SessionExecutionChainSummary {
  const chosenStage =
    executionChainStageRank(incoming.stage) >= executionChainStageRank(current.stage) ? incoming.stage : current.stage;
  return {
    accepted: current.accepted || incoming.accepted,
    acceptedAt: pickLatestTimestamp([current.acceptedAt, incoming.acceptedAt]) ?? incoming.acceptedAt ?? current.acceptedAt,
    spawned: current.spawned || incoming.spawned,
    spawnedAt: pickLatestTimestamp([current.spawnedAt, incoming.spawnedAt]) ?? incoming.spawnedAt ?? current.spawnedAt,
    parentSessionKey: incoming.parentSessionKey ?? current.parentSessionKey,
    childSessionKey: incoming.childSessionKey ?? current.childSessionKey,
    stage: chosenStage,
    source: incoming.source === "history" || current.source !== "history" ? incoming.source : current.source,
    inferred: current.inferred && incoming.inferred,
    detail: pickRicherSessionText(current.detail, incoming.detail) ?? incoming.detail,
  };
}

function mergeInterSessionSignals(
  current: SessionInterSessionSignal[] | undefined,
  incoming: SessionInterSessionSignal[] | undefined,
): SessionInterSessionSignal[] | undefined {
  const items = [...(current ?? []), ...(incoming ?? [])];
  if (items.length === 0) return undefined;
  const merged = new Map<string, SessionInterSessionSignal>();
  for (const item of items) {
    const key = [
      normalizeLookupKey(item.sourceSessionKey),
      normalizeLookupKey(item.sourceTool ?? ""),
      normalizeLookupKey(item.timestamp ?? ""),
      normalizeLookupKey(item.snippet),
    ].join("::");
    if (!merged.has(key)) merged.set(key, item);
  }
  return [...merged.values()].sort((a, b) => toSortableMs(a.timestamp) - toSortableMs(b.timestamp));
}

function pickSessionTaskSnippet(history: SessionHistoryMessage[]): string | undefined {
  const candidates = history.filter(
    (item) => (item.kind === "message" || item.kind === "inter_session") && item.content.trim(),
  );
  const preferred =
    candidates.find((item) => /user|system/i.test(item.role)) ??
    candidates.find((item) => !/assistant|tool/i.test(item.role)) ??
    candidates[0];
  const normalized = normalizeInlineText(preferred?.content ?? "");
  return normalized || undefined;
}

async function loadSessionConversationItemsByKeys(
  snapshot: ReadModelSnapshot,
  toolClient: ToolClient,
  sessionKeys: string[],
  historyLimit: number,
): Promise<SessionConversationListItem[]> {
  const normalizedKeys = [...new Set(sessionKeys.map((item) => item.trim()).filter(Boolean))];
  if (normalizedKeys.length === 0) return [];

  const details = await Promise.all(
    normalizedKeys.map(async (sessionKey) => {
      const detail = await getSessionConversationDetail({
        snapshot,
        client: toolClient,
        sessionKey,
        historyLimit,
      });
      return detail ?? undefined;
    }),
  );

  return details
    .filter((detail): detail is SessionConversationDetailResult => Boolean(detail))
    .map((detail) => ({
      sessionKey: detail.session.sessionKey,
      label: detail.session.label,
      agentId: detail.session.agentId,
      state: detail.session.state,
      lastMessageAt: detail.session.lastMessageAt,
      taskSnippet: pickSessionTaskSnippet(detail.history),
      latestSnippet: detail.latestSnippet,
      latestRole: detail.latestRole,
      latestKind: detail.latestKind,
      latestToolName: detail.latestToolName,
      latestHistoryAt: detail.latestHistoryAt,
      historyCount: detail.historyCount,
      toolEventCount: detail.history.filter((item) => item.kind === "tool_event").length,
      historyError: detail.historyError,
      executionChain: detail.executionChain,
      interSessionSignals: detail.history
        .filter((item) => item.kind === "inter_session" && (item.sourceSessionKey ?? "").trim())
        .map((item) => ({
          sourceSessionKey: item.sourceSessionKey!.trim(),
          sourceTool: item.sourceTool,
          timestamp: item.timestamp,
          snippet: safeTruncate(normalizeInlineText(item.content), 220),
        })),
    }));
}

async function loadCachedTaskEvidenceSessions(
  snapshot: ReadModelSnapshot,
  toolClient: ToolClient,
  sessionKeys: string[],
  historyLimit = 24,
): Promise<SessionConversationListItem[]> {
  const normalizedKeys = [...new Set(sessionKeys.map((item) => item.trim()).filter(Boolean))].sort();
  const cacheKey = normalizedKeys.join(",");
  const now = Date.now();
  if (
    renderTaskEvidenceCache &&
    renderTaskEvidenceCache.snapshotAt === snapshot.generatedAt &&
    renderTaskEvidenceCache.historyLimit === historyLimit &&
    renderTaskEvidenceCache.sessionKey === cacheKey &&
    renderTaskEvidenceCache.expiresAt > now
  ) {
    return renderTaskEvidenceCache.value;
  }

  const value = await loadSessionConversationItemsByKeys(snapshot, toolClient, normalizedKeys, historyLimit);
  renderTaskEvidenceCache = {
    snapshotAt: snapshot.generatedAt,
    historyLimit,
    sessionKey: cacheKey,
    value,
    expiresAt: now + HTML_HEAVY_CACHE_TTL_MS,
  };
  return value;
}

async function loadCachedSessionPreview(snapshot: ReadModelSnapshot, toolClient: ToolClient): Promise<SessionConversationListResult> {
  const now = Date.now();
  if (
    renderSessionPreviewCache &&
    renderSessionPreviewCache.snapshotAt === snapshot.generatedAt &&
    renderSessionPreviewCache.expiresAt > now
  ) {
    return renderSessionPreviewCache.value;
  }

  const value = await listSessionConversations({
    snapshot,
    client: toolClient,
    filters: {},
    page: 1,
    pageSize: 12,
    historyLimit: 5,
  });
  renderSessionPreviewCache = {
    snapshotAt: snapshot.generatedAt,
    value,
    expiresAt: now + HTML_HEAVY_CACHE_TTL_MS,
  };
  return value;
}

async function loadCachedCollaborationPreview(
  snapshot: ReadModelSnapshot,
  toolClient: ToolClient,
): Promise<SessionConversationListResult> {
  const now = Date.now();
  if (
    renderCollaborationPreviewCache &&
    renderCollaborationPreviewCache.snapshotAt === snapshot.generatedAt &&
    renderCollaborationPreviewCache.expiresAt > now
  ) {
    return renderCollaborationPreviewCache.value;
  }

  const value = await listSessionConversations({
    snapshot,
    client: toolClient,
    filters: {},
    page: 1,
    pageSize: 40,
    historyLimit: 8,
  });
  renderCollaborationPreviewCache = {
    snapshotAt: snapshot.generatedAt,
    value,
    expiresAt: now + HTML_HEAVY_CACHE_TTL_MS,
  };
  return value;
}

function buildUsageCostCacheKey(snapshot: ReadModelSnapshot, mode: UsageCostMode): string {
  // Content-based fingerprint – changes only when session/status data
  // actually changes, unlike generatedAt which changes every poll cycle.
  // Session state (running→idle etc.) affects the output (contextWindows
  // rows use session.state), so we include it alongside status timestamps.
  const sessionFingerprint = snapshot.sessions
    .map((s) => `${s.sessionKey}:${s.state}`)
    .sort()
    .join(";");
  const statusFingerprint = snapshot.statuses
    .map((s) => `${s.sessionKey}:${s.updatedAt}`)
    .sort()
    .join(";");
  return `${mode}|${sessionFingerprint}|${statusFingerprint}`;
}

async function loadCachedUsageCost(
  snapshot: ReadModelSnapshot,
  mode: UsageCostMode,
): Promise<UsageCostSnapshot> {
  const snapshotKey = buildUsageCostCacheKey(snapshot, mode);
  const now = Date.now();
  const targetCache = mode === "full" ? renderUsageCostFullCache : renderUsageCostSummaryCache;
  const targetInFlight = mode === "full" ? renderUsageCostFullInFlight : renderUsageCostSummaryInFlight;
  if (
    targetCache &&
    targetCache.snapshotKey === snapshotKey &&
    targetCache.expiresAt > now
  ) {
    return targetCache.value;
  }
  if (targetCache && targetCache.snapshotKey === snapshotKey) {
    if (!targetInFlight || targetInFlight.snapshotKey !== snapshotKey) {
      const nextValue = buildUsageCostSnapshot(snapshot, mode);
      if (mode === "full") {
        renderUsageCostFullInFlight = {
          snapshotKey,
          value: nextValue,
        };
      } else {
        renderUsageCostSummaryInFlight = {
          snapshotKey,
          value: nextValue,
        };
      }
      void nextValue
        .then((value) => {
          const nextCache = {
            snapshotKey,
            value,
            expiresAt: Date.now() + HTML_USAGE_CACHE_TTL_MS,
          };
          if (mode === "full") {
            renderUsageCostFullCache = nextCache;
          } else {
            renderUsageCostSummaryCache = nextCache;
          }
        })
        .finally(() => {
          if (mode === "full") {
            if (renderUsageCostFullInFlight?.snapshotKey === snapshotKey) {
              renderUsageCostFullInFlight = undefined;
            }
          } else if (renderUsageCostSummaryInFlight?.snapshotKey === snapshotKey) {
            renderUsageCostSummaryInFlight = undefined;
          }
        });
    }
    return targetCache.value;
  }
  if (targetInFlight?.snapshotKey === snapshotKey) {
    return targetInFlight.value;
  }

  const nextValue = buildUsageCostSnapshot(snapshot, mode);
  if (mode === "full") {
    renderUsageCostFullInFlight = {
      snapshotKey,
      value: nextValue,
    };
  } else {
    renderUsageCostSummaryInFlight = {
      snapshotKey,
      value: nextValue,
    };
  }
  try {
    const value = await nextValue;
    const nextCache = {
      snapshotKey,
      value,
      expiresAt: now + HTML_USAGE_CACHE_TTL_MS,
    };
    if (mode === "full") {
      renderUsageCostFullCache = nextCache;
    } else {
      renderUsageCostSummaryCache = nextCache;
    }
    return value;
  } finally {
    if (mode === "full") {
      if (renderUsageCostFullInFlight?.snapshotKey === snapshotKey) {
        renderUsageCostFullInFlight = undefined;
      }
    } else if (renderUsageCostSummaryInFlight?.snapshotKey === snapshotKey) {
      renderUsageCostSummaryInFlight = undefined;
    }
  }
}

async function loadCachedOfficeSessionPresence(): Promise<OfficeSessionPresenceSnapshot> {
  const now = Date.now();
  if (renderOfficePresenceCache && renderOfficePresenceCache.expiresAt > now) {
    return renderOfficePresenceCache.value;
  }
  if (renderOfficePresenceCache) {
    return renderOfficePresenceCache.value;
  }
  const value = await loadBestEffortOfficeSessionPresence();
  renderOfficePresenceCache = {
    value,
    expiresAt: now + HTML_HEAVY_CACHE_TTL_MS,
  };
  return value;
}

async function loadCachedReplayPreview(): Promise<Awaited<ReturnType<typeof loadReplayIndex>>> {
  const now = Date.now();
  if (renderReplayPreviewCache && renderReplayPreviewCache.expiresAt > now) {
    return renderReplayPreviewCache.value;
  }
  if (renderReplayPreviewCache) {
    if (!renderReplayPreviewInFlight) {
      const nextValue = loadReplayIndex({
        timelineLimit: 20,
        digestLimit: 10,
        exportLimit: 10,
      });
      renderReplayPreviewInFlight = nextValue;
      void nextValue
        .then((value) => {
          renderReplayPreviewCache = {
            value,
            expiresAt: Date.now() + HTML_REPLAY_CACHE_TTL_MS,
          };
        })
        .finally(() => {
          renderReplayPreviewInFlight = undefined;
        });
    }
    return renderReplayPreviewCache.value;
  }
  if (renderReplayPreviewInFlight) {
    return renderReplayPreviewInFlight;
  }

  const nextValue = loadReplayIndex({
    timelineLimit: 20,
    digestLimit: 10,
    exportLimit: 10,
  });
  renderReplayPreviewInFlight = nextValue;
  try {
    const value = await nextValue;
    renderReplayPreviewCache = {
      value,
      expiresAt: Date.now() + HTML_REPLAY_CACHE_TTL_MS,
    };
    return value;
  } finally {
    renderReplayPreviewInFlight = undefined;
  }
}

async function renderHtml(
  filters: TaskQueryFilters,
  toolClient: ToolClient,
  options: DashboardOptions,
): Promise<string> {
  const renderStartedAt = performance.now();
  let renderPhaseAt = renderStartedAt;
  const renderPhases: string[] = [];
  const markRenderPhase = (label: string): void => {
    const now = performance.now();
    renderPhases.push(`${label}=${Math.round(now - renderPhaseAt)}ms`);
    renderPhaseAt = now;
  };
  const snapshot = await readReadModelSnapshotWithLiveSessions(toolClient);
  const t = (en: string, zh: string): string => pickUiText(options.language, en, zh);
  const sectionLinks = dashboardSectionLinks(options.language);
  const activeSection =
    options.section === "office-space"
      ? "team"
      : options.section === "calendar"
        ? "projects-tasks"
        : options.section;
  const usageCostMode: UsageCostMode = "full";
  const sectionMeta = sectionLinks.find((item) => item.key === activeSection) ?? sectionLinks[0];
  const sectionTitle = resolveDashboardSectionTitle(sectionMeta, options.language);
  const sectionLeadText =
    activeSection === "overview"
      ? t(
          "Decide from one screen: system health, items needing your intervention, who is active, and AI burn.",
          "一个首页只回答四件事：系统是否正常、哪里需要你介入、谁在忙、AI 用量是否异常。",
        )
      : activeSection === "collaboration"
        ? t(
            "Follow how work moves between agents: who accepted it, who received the handoff, and where collaboration is currently waiting.",
            "直接看任务是怎么在智能体之间流转的：谁先接单、后来交给了谁、当前卡在哪一段协作里。",
          )
      : activeSection === "projects-tasks"
        ? t(
            "Start with schedule and cron execution. Staff can be active from cron or ad-hoc sessions even when there is no tracked task row yet.",
            "先看排程和 Cron 执行。员工显示在工作，可能只是 Cron 或临时会话在跑，不一定已经落成可跟踪的任务条目。",
          )
        : sectionMeta.blurb;
  const needsSessionPreview =
    activeSection === "projects-tasks" || activeSection === "overview" || activeSection === "collaboration";
  const needsTaskEvidence = activeSection === "projects-tasks" || activeSection === "collaboration";
  const needsTeamSnapshot = activeSection === "team";
  const needsMemoryFiles = activeSection === "memory";
  const needsWorkspaceFiles = activeSection === "docs";
  const needsConnectionHealth = activeSection === "settings";
  const needsSecuritySummary = activeSection === "settings";
  const needsUpdateSummary = activeSection === "settings";
  const needsMemoryState = activeSection === "memory";
  const needsCollaborationThreads = activeSection === "collaboration";
  markRenderPhase("snapshot");
  const exceptions = commanderExceptions(snapshot);
  const exceptionsFeed = commanderExceptionsFeed(snapshot);
  const actionQueue = await readNotificationCenter(snapshot);
  const allTasks = listTasks(snapshot.tasks, projectTitleMap(snapshot));
  const controlCenterMappingTasks = allTasks.filter(isControlCenterMappingTask);
  const realTasks = allTasks.filter((task) => !isControlCenterMappingTask(task));
  const tasks = applyTaskFilters(realTasks, filters);
  const allApprovals = [...(snapshot.approvals ?? [])].sort(compareApprovals);
  const topApprovals = allApprovals.slice(0, 5);
  const budgets = snapshot.budgetSummary ?? { total: 0, ok: 0, warn: 0, over: 0, evaluations: [] };
  const nonOkBudgets = (budgets.evaluations ?? [])
    .filter((item) => item.status === "warn" || item.status === "over")
    .slice(0, 8);
  const projectOptions = uniqueSorted(snapshot.projects.projects.map((project) => project.projectId));
  const ownerOptions = uniqueSorted(realTasks.map((task) => task.owner));
  const sessionPreview = needsSessionPreview
    ? await loadCachedSessionPreview(snapshot, toolClient)
    : {
        generatedAt: snapshot.generatedAt,
        total: 0,
        page: 1,
        pageSize: 0,
        filters: {},
        items: [],
      };
  const collaborationPreview =
    needsCollaborationThreads
      ? await loadCachedCollaborationPreview(snapshot, toolClient)
      : {
          generatedAt: snapshot.generatedAt,
          total: 0,
          page: 1,
          pageSize: 0,
          filters: {},
          items: [],
        };
  const sessionRows = renderSessionPreviewRows(sessionPreview.items, options.language);
  markRenderPhase("session-preview");
  const [cronOverview, openclawCronJobs, replayPreview, usageCost, officeRoster, officePresence] = await Promise.all([
    buildCronOverview(snapshot, POLLING_INTERVALS_MS.cron),
    loadOpenclawCronCatalog(options.language),
    loadCachedReplayPreview(),
    loadCachedUsageCost(snapshot, usageCostMode),
    loadBestEffortAgentRoster(),
    loadCachedOfficeSessionPresence(),
  ]);
  markRenderPhase("shared-data");
  const [teamSnapshot, memoryFiles, memoryFacetOptions, workspaceFiles, workspaceFacetOptions, taskEvidenceItems, connectionHealthSummary, securitySummary, updateSummary, memoryStateSummary] = await Promise.all([
    needsTeamSnapshot
      ? loadTeamSnapshot(officeRoster)
      : Promise.resolve<TeamSnapshot>({
          missionStatement: t("No shared mission loaded.", "尚未加载共同目标。"),
          members: [],
          sourcePath: OPENCLAW_CONFIG_PATH,
          detail: t("Loaded on the staff page only.", "仅在员工页加载。"),
        }),
    needsMemoryFiles ? listEditableFiles("memory") : Promise.resolve<EditableFileEntry[]>([]),
    needsMemoryFiles ? listMemoryFacetOptions() : Promise.resolve<Array<{ key: string; label: string }>>([]),
    needsWorkspaceFiles ? listEditableFiles("workspace") : Promise.resolve<EditableFileEntry[]>([]),
    needsWorkspaceFiles ? listWorkspaceFacetOptions() : Promise.resolve<Array<{ key: string; label: string }>>([]),
    needsTaskEvidence
      ? loadCachedTaskEvidenceSessions(
          snapshot,
          toolClient,
          tasks.flatMap((task) => task.sessionKeys),
          24,
        )
      : Promise.resolve<SessionConversationListItem[]>([]),
    needsConnectionHealth ? loadCachedOpenClawConnectionSummary() : Promise.resolve<OpenClawConnectionSummary | undefined>(undefined),
    needsSecuritySummary ? loadCachedOpenClawSecuritySummary() : Promise.resolve<OpenClawSecuritySummary | undefined>(undefined),
    needsUpdateSummary ? loadCachedOpenClawUpdateSummary() : Promise.resolve<OpenClawUpdateSummary | undefined>(undefined),
    needsMemoryState ? loadCachedOpenClawMemorySummary() : Promise.resolve<OpenClawMemorySummary | undefined>(undefined),
  ]);
  markRenderPhase("section-assets");
  const usageToday = usageCost.periods.find((item) => item.key === "today");
  const usage7d = usageCost.periods.find((item) => item.key === "7d");
  const usage30d = usageCost.periods.find((item) => item.key === "30d");
  const officeCards = buildOfficeSpaceCards(
    snapshot,
    realTasks,
    officeRoster.entries.map((entry) => entry.agentId),
    officePresence.activeSessionsByAgent,
    options.language,
  );
  const usageAgentTokensByKey = new Map(
    usageCost.breakdown.byAgent.map((item) => [normalizeLookupKey(item.key), item.tokens]),
  );
  const executionAgentSummaries = buildExecutionAgentSummaries(
    snapshot,
    realTasks,
    openclawCronJobs,
    officeRoster.entries,
    usageAgentTokensByKey,
  );
  const taskSignalItems = mergeSessionConversationItems(taskEvidenceItems, sessionPreview.items);
  const taskExecutionChainCards = buildTaskExecutionChainCards({
    tasks: realTasks,
    sessions: snapshot.sessions,
    sessionItems: taskSignalItems,
    language: options.language,
  });
  const collaborationSessionKeys = needsCollaborationThreads
    ? [...new Set(
        taskExecutionChainCards
          .flatMap((item) => [item.sessionKey, item.executionChain.parentSessionKey, item.executionChain.childSessionKey])
          .map((value) => value?.trim() ?? "")
          .filter(Boolean),
      )]
    : [];
  const collaborationEvidenceItems =
    needsCollaborationThreads && collaborationSessionKeys.length > 0
      ? await loadCachedTaskEvidenceSessions(snapshot, toolClient, collaborationSessionKeys, 40)
      : [];
  const collaborationSignalItems = mergeSessionConversationItems(
    collaborationEvidenceItems,
    mergeSessionConversationItems(taskSignalItems, collaborationPreview.items),
  );
  const collaborationThreadCards = needsCollaborationThreads
    ? mergeCollaborationThreadCards(
        buildCollaborationThreadCards({
          cards: taskExecutionChainCards,
          sessionItems: collaborationSignalItems,
          language: options.language,
        }),
        buildInterSessionCollaborationCards({
          sessionItems: collaborationSignalItems,
          language: options.language,
        }),
      )
    : [];
  const taskCertaintyCards = buildTaskCertaintyCards({
    tasks,
    sessions: snapshot.sessions,
    sessionItems: taskSignalItems,
    approvals: snapshot.approvals,
    language: options.language,
  });
  const taskCertaintyStrongCount = taskCertaintyCards.filter((item) => item.tone === "ok").length;
  const taskCertaintyFollowupCount = taskCertaintyCards.filter((item) => item.tone === "warn").length;
  const taskCertaintyWeakCount = taskCertaintyCards.filter((item) => item.tone === "blocked").length;
  const spawnedExecutionChainCount = taskExecutionChainCards.filter((item) => item.executionChain.spawned).length;
  const runningExecutionChainCount = taskExecutionChainCards.filter((item) => item.executionChain.stage === "running").length;
  const mappedExecutionChainCount = taskExecutionChainCards.filter((item) => !item.unmapped).length;
  const taskExecutionChainHtml = renderTaskExecutionChainCards(taskExecutionChainCards, options.language);
  const collaborationThreadHtml = renderCollaborationThreadCards(collaborationThreadCards, options.language);
  const collaborationThreadVisibleCount = collaborationThreadCards.length;
  const collaborationThreadTotalCount = collaborationThreadCards.reduce((sum, item) => sum + item.aggregateCount, 0);
  const collaborationActiveCount = collaborationThreadCards.reduce(
    (sum, item) => sum + (item.status === "active" ? item.aggregateCount : 0),
    0,
  );
  const collaborationHandoffCount = collaborationThreadCards.reduce(
    (sum, item) => sum + (item.status === "handoff" ? item.aggregateCount : 0),
    0,
  );
  const collaborationBlockedCount = collaborationThreadCards.reduce(
    (sum, item) => sum + (item.status === "blocked" ? item.aggregateCount : 0),
    0,
  );
  const collaborationCompletedTodayCount = collaborationThreadCards.reduce((sum, item) => {
    if (item.status !== "completed") return sum;
    return sum + item.aggregateItems.filter((entry) => isSameLocalCalendarDay(entry.latestAt, Date.now())).length;
  }, 0);
  const taskRoleSummaries = buildTaskRoleSummaries(controlCenterMappingTasks);
  const pendingApprovalsCount = allApprovals.filter((item) => item.status === "pending").length;
  const inProgressTasksCount = realTasks.filter((task) => task.status === "in_progress").length;
  const blockedTasksCount = realTasks.filter((task) => task.status === "blocked").length;
  const tasksInMotionCount = inProgressTasksCount + blockedTasksCount;
  const liveSessionCount = officePresence.totalActiveSessions;
  const nowMs = Date.now();
  const sessionErrorCount = exceptions.errors.length;
  const sessionBlockedCount = exceptions.blocked.filter((session) => session.state === "blocked").length;
  const sessionWaitingApprovalCount = exceptions.blocked.filter(
    (session) => session.state === "waiting_approval",
  ).length;
  const runtimeSessionIssueCount = sessionBlockedCount + sessionErrorCount + sessionWaitingApprovalCount;
  const stalledRunningSessionCount = countStalledRunningSessions(snapshot.sessions, taskSignalItems, nowMs);
  const runtimeIssueCount = runtimeSessionIssueCount + stalledRunningSessionCount;
  const globalVisibilityModel = await buildGlobalVisibilityViewModel(snapshot, toolClient, options.language, {
    cronOverview,
    openclawCronJobs,
    currentTasksCount: taskCertaintyCards.length,
    strongTaskEvidenceCount: taskCertaintyStrongCount,
    followupTaskEvidenceCount: taskCertaintyFollowupCount,
    weakTaskEvidenceCount: taskCertaintyWeakCount,
  });
  const attentionCount = actionQueue.counts.unacked + runtimeIssueCount + nonOkBudgets.length;
  const replayMoments = replayPreview.timeline.entries.slice(0, 8);
  const replaySignals = [
    { label: t("Timeline events", "时间线事件"), value: replayPreview.stats.timeline.total },
    { label: t("Daily digests", "日报快照"), value: replayPreview.stats.digests.total },
    { label: t("Export snapshots", "导出快照"), value: replayPreview.stats.exportSnapshots.total },
    { label: t("Backup bundles", "备份包"), value: replayPreview.stats.exportBundles.total },
  ].filter((item) => item.value > 0);
  const heartbeatJobs = cronOverview.jobs.filter((job) => job.jobId.toLowerCase().includes("heartbeat"));
  const heartbeatEnabledCount = heartbeatJobs.filter((job) => job.enabled).length;
  const heartbeatNextRun =
    heartbeatJobs.find((job) => job.enabled)?.nextRunAt ?? heartbeatJobs[0]?.nextRunAt ?? t("Not scheduled", "未排程");
  const heartbeatHealth = heartbeatEnabledCount > 0 ? "ok" : "warn";
  const heartbeatRuns = await readTaskHeartbeatRuns(1);
  const latestHeartbeatRun = heartbeatRuns.runs[0];
  const currentTaskHealth = taskCertaintyWeakCount === 0 ? "ok" : "warn";
  const mappingTaskHint =
    controlCenterMappingTasks.length > 0
      ? t(
          `${controlCenterMappingTasks.length} board-only mapping examples are hidden from execution metrics.`,
          `另有 ${controlCenterMappingTasks.length} 个看板样例（不执行任务）。`,
        )
      : "";
  const pendingDecisionCount = actionQueue.counts.unacked;
  const budgetRiskCount = nonOkBudgets.length;
  const focusSummary = [
    `${t("Review queue", "审阅队列")} ${pendingDecisionCount}`,
    `${t("Runtime issues", "运行异常")} ${runtimeIssueCount}`,
    `${t("Budget risks", "预算风险")} ${budgetRiskCount}`,
  ].join(" · ");
  const focusHref = `${buildHomeHref({ quick: "all" }, options.compactStatusStrip, "projects-tasks", options.language, options.usageView)}#tracked-task-view`;
  const currentTaskHealthHref = `${buildHomeHref({ quick: "all" }, true, "projects-tasks", options.language, options.usageView)}#tracked-task-view`;
  const runtimeCronById = new Map(cronOverview.jobs.map((job) => [job.jobId, job]));
  const catalogMatchedRuntimeIds = new Set<string>();
  const catalogCronRows = openclawCronJobs.map((job) => {
    const runtimeJob = runtimeCronById.get(job.jobId);
    if (runtimeJob) catalogMatchedRuntimeIds.add(job.jobId);
    const status = runtimeJob ? runtimeJob.health : job.enabled ? "enabled" : "disabled";
    const statusLabel = runtimeJob
      ? cronHealthLabel(runtimeJob.health, options.language)
      : job.enabled
        ? pickUiText(options.language, "Enabled (awaiting runtime sync)", "已启用（等待运行时同步）")
        : cronHealthLabel("disabled", options.language);
    const nextRun = runtimeJob?.nextRunAt ?? (job.enabled ? t("Waiting for runtime sync", "等待运行时同步") : "-");
    return {
      source: "openclaw",
      sourceLabel: t("Task config", "任务配置"),
      jobId: job.jobId,
      name: job.name,
      owner: job.owner,
      purpose: job.purpose,
      schedule: job.scheduleLabel,
      status,
      statusLabel,
      nextRun,
      dueInSeconds: runtimeJob?.dueInSeconds,
    };
  });
  const runtimeOnlyCronRows = cronOverview.jobs
    .filter((job) => !catalogMatchedRuntimeIds.has(job.jobId))
    .map((job) => ({
      source: "runtime",
      sourceLabel: t("Runtime monitor", "系统监控"),
      jobId: job.jobId,
      name: job.name ?? job.jobId,
      owner: formatExecutorAgentLabel("system-cron", options.language),
      purpose: cronRuntimePurpose(job.jobId, options.language),
      schedule: pickUiText(options.language, "system interval", "系统间隔"),
      status: job.enabled ? job.health : "disabled",
      statusLabel: cronHealthLabel(job.enabled ? job.health : "disabled", options.language),
      nextRun: job.nextRunAt ?? "-",
      dueInSeconds: job.dueInSeconds,
    }));
  const allCronRows = [...catalogCronRows, ...runtimeOnlyCronRows];
  const cronRows =
    allCronRows
      .slice(0, 20)
      .map((job) => {
        const dueIn = Number.isFinite(job.dueInSeconds) ? formatSeconds(job.dueInSeconds, options.language) : "-";
        const purpose = sanitizeCronPurposeText(job.purpose, options.language, 56);
        return `<tr><td><div>${escapeHtml(job.name)}</div><div class="meta">${escapeHtml(job.jobId)}</div></td><td>${escapeHtml(job.owner)}</td><td>${escapeHtml(purpose)}</td><td>${badge(job.status, job.statusLabel)}</td><td>${escapeHtml(job.nextRun)}</td><td>${escapeHtml(dueIn)}</td></tr>`;
      })
      .join("");
  const agentJobCatalogRows = allCronRows;
  const agentJobRowsHtml =
    agentJobCatalogRows.length === 0
      ? `<tr><td colspan="7">${escapeHtml(t("No visible jobs yet.", "暂无可见 job。"))}</td></tr>`
      : agentJobCatalogRows
          .slice(0, 40)
          .map(
            (item) =>
              `<tr><td>${escapeHtml(item.sourceLabel)}</td><td><div>${escapeHtml(item.name)}</div><div class="meta">${escapeHtml(item.jobId)}</div></td><td>${escapeHtml(item.owner)}</td><td>${escapeHtml(sanitizeCronPurposeText(item.purpose, options.language, 48))}</td><td>${escapeHtml(displayCronScheduleLabel(item.schedule, options.language))}</td><td>${escapeHtml(item.nextRun)}</td><td>${badge(item.status, item.statusLabel)}</td></tr>`,
          )
          .join("");
  const toolSessions = sessionPreview.items
    .filter((item) => (item.toolEventCount ?? 0) > 0 || item.latestKind === "tool_event")
    .slice(0, 12);
  const toolRows =
    toolSessions.length === 0
      ? `<tr><td colspan="5">${escapeHtml(t("No tool-call sessions yet.", "暂无工具调用会话。"))}</td></tr>`
      : toolSessions
          .map((item) => {
            const toolCount = item.toolEventCount ?? (item.latestKind === "tool_event" ? 1 : 0);
            return `<tr><td><a href="${escapeHtml(buildSessionDetailHref(item.sessionKey, options.language))}">${escapeHtml(item.label ?? item.sessionKey)}</a></td><td>${escapeHtml(item.agentId ?? t("Unassigned", "未分配"))}</td><td>${toolCount}</td><td>${badge(item.state, sessionStateLabel(item.state))}</td><td>${escapeHtml(item.lastMessageAt ?? "-")}</td></tr>`;
          })
          .join("");
  const importGuard = readImportMutationGuardState();
  const tokenGateStatus = LOCAL_TOKEN_AUTH_REQUIRED
    ? LOCAL_API_TOKEN !== ""
      ? "armed"
      : "blocked_no_token"
    : "disabled";
  const importGuardRows = [
    {
      label: "只读保护",
      value: String(READONLY_MODE),
      note: READONLY_MODE ? "当前只允许安全演练，不会写入真实变更。" : "允许真实写入，请确认后使用。",
      status: READONLY_MODE ? "enabled" : "warn",
    },
    {
      label: "关键操作身份验证",
      value: String(LOCAL_TOKEN_AUTH_REQUIRED),
      note: LOCAL_TOKEN_AUTH_REQUIRED ? "已开启，关键操作需要身份验证。" : "未开启，建议在生产环境开启。",
      status: LOCAL_TOKEN_AUTH_REQUIRED ? "enabled" : "warn",
    },
    {
      label: "身份验证配置",
      value: String(importGuard.localTokenConfigured),
      note: importGuard.localTokenConfigured ? "已配置完成。" : "尚未配置，关键操作将被拦截。",
      status: importGuard.localTokenConfigured ? "enabled" : "blocked",
    },
    {
      label: "身份验证状态",
      value: tokenGateStatus === "armed" ? "已就绪" : tokenGateStatus === "blocked_no_token" ? "未配置" : "未开启",
      note: "用于保护关键写入操作。",
      status: tokenGateStatus === "armed" ? "enabled" : tokenGateStatus === "blocked_no_token" ? "blocked" : "disabled",
    },
    {
      label: "变更写入开关",
      value: String(IMPORT_MUTATION_ENABLED),
      note: IMPORT_MUTATION_ENABLED ? "允许写入导入变更。" : "已关闭导入写入。",
      status: IMPORT_MUTATION_ENABLED ? "warn" : "disabled",
    },
    {
      label: "审批写入开关",
      value: String(APPROVAL_ACTIONS_ENABLED),
      note: APPROVAL_ACTIONS_ENABLED ? "允许执行审批写入。" : "已关闭审批写入。",
      status: APPROVAL_ACTIONS_ENABLED ? "warn" : "disabled",
    },
    {
      label: "默认保护模式",
      value: importGuard.defaultMode,
      note:
        importGuard.defaultMode === "blocked"
          ? "当前为保护状态，仅允许演练。"
          : importGuard.defaultMode === "dry_run"
            ? "默认先演练，再决定是否写入。"
            : "当前允许实时写入。",
      status: importGuard.defaultMode,
    },
  ]
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.label)}</td><td>${badge(item.status)}</td><td>${escapeHtml(item.value)}</td><td>${escapeHtml(item.note)}</td></tr>`,
    )
    .join("");
  const replayRowItems = [
    { label: t("Timeline scanned", "时间线扫描数"), value: replayPreview.stats.timeline.total },
    { label: t("Timeline shown", "时间线展示数"), value: replayPreview.stats.timeline.returned },
    { label: t("Timeline filtered", "时间线过滤数"), value: replayPreview.stats.timeline.filteredOut },
    { label: t("Digests shown", "日报快照展示数"), value: replayPreview.stats.digests.returned },
    { label: t("Export snapshots shown", "导出快照展示数"), value: replayPreview.stats.exportSnapshots.returned },
    { label: t("Backup bundles shown", "备份包展示数"), value: replayPreview.stats.exportBundles.returned },
    { label: t("Replay load p50 (ms)", "回放加载 p50 (ms)"), value: replayPreview.stats.total.latencyBucketsMs.p50 },
    { label: t("Replay load p95 (ms)", "回放加载 p95 (ms)"), value: replayPreview.stats.total.latencyBucketsMs.p95 },
  ].filter((item) => item.value > 0);
  const replayRows = replayRowItems
    .map((item) => `<tr><td><code>${escapeHtml(item.label)}</code></td><td>${item.value}</td></tr>`)
    .join("");
  const replayMetricsHtml =
    replayRowItems.length === 0
      ? `<div class="empty-state">${escapeHtml(t("No replay metrics yet. They will appear after the system runs for a while.", "暂无回放统计。运行一段时间后会显示。"))}</div>`
      : `<table style="margin-top:10px;"><thead><tr><th>${escapeHtml(t("Metric", "指标"))}</th><th>${escapeHtml(t("Value", "数值"))}</th></tr></thead><tbody>${replayRows}</tbody></table>`;
  const replayLatestSnapshot = replayPreview.exportSnapshots[0];
  const replayLatestBundle = replayPreview.exportBundles[0];
  const approvalsPreviewMeta =
    allApprovals.length > topApprovals.length
      ? t(`Showing the latest ${topApprovals.length} of ${allApprovals.length} approval items.`, `当前展示最近 ${topApprovals.length}/${allApprovals.length} 条审批记录。`)
      : t(`Showing ${topApprovals.length} approval items.`, `当前展示 ${topApprovals.length} 条审批记录。`);

  const approvalsItems =
    topApprovals.length === 0
      ? `<li>${escapeHtml(t("No approvals yet.", "暂无审批记录"))}</li>`
      : topApprovals
          .map((approval) => {
            const status = approval.status ?? "unknown";
            const target = approval.agentId ?? approval.sessionKey ?? t("Unknown target", "未知目标");
            const commandLabel = approval.command ? escapeHtml(approval.command) : t("Approval action", "审批动作");
            const when = approval.requestedAt ? ` · ${escapeHtml(t("Requested at", "提交于"))} ${escapeHtml(approval.requestedAt)}` : "";
            return `<li>${badge(status)} ${commandLabel} · <strong>${escapeHtml(target)}</strong>${when}</li>`;
          })
          .join("");

  const budgetItems =
    nonOkBudgets.length === 0
      ? `<tr><td colspan="4">${escapeHtml(t("All budgets are currently within the safe range.", "当前预算全部在安全范围内。"))}</td></tr>`
      : nonOkBudgets
          .map((item) => {
            return `<tr><td>${badge(item.status ?? "ok")}</td><td>${escapeHtml(item.scope ?? t("Unknown scope", "未知范围"))}</td><td>${escapeHtml(item.label ?? t("Untitled", "未命名"))}</td><td>${renderMetricSummary(item)}</td></tr>`;
          })
          .join("");

  const taskRows =
    tasks.length === 0
      ? `<tr><td colspan="7">${escapeHtml(t("No tasks match the current filter.", "当前筛选下暂无任务。"))}</td></tr>`
      : tasks
          .slice(0, 50)
          .map(
            (task) =>
              `<tr><td>${escapeHtml(task.projectTitle)}</td><td><code>${escapeHtml(task.taskId)}</code></td><td>${escapeHtml(task.title)}</td><td>${badge(task.status, taskStateLabel(task.status, options.language))}</td><td>${escapeHtml(task.owner)}</td><td>${escapeHtml(task.dueAt ?? "-")}</td><td>${escapeHtml(task.updatedAt)}</td></tr>`,
          )
          .join("");
  const taskGroupedListHtml =
    tasks.length === 0
      ? `<div class="empty-state">${escapeHtml(t("No tasks match the current filter.", "当前筛选下暂无任务。"))}</div>`
      : `<div class="group-list">${TASK_STATES.map((state) => {
          const bucket = tasks.filter((task) => task.status === state);
          if (bucket.length === 0) return "";
          const itemRows = bucket
            .slice(0, 16)
            .map((task) => {
              const detailHref = buildTaskDetailHref(task.taskId, options.language);
              return `<li class="group-item">
                <div class="group-item-head">
                  <strong>${escapeHtml(task.title)}</strong>
                  ${badge(task.status, taskStateLabel(task.status, options.language))}
                </div>
                <div class="meta"><code>${escapeHtml(task.taskId)}</code> · ${escapeHtml(task.projectTitle)} · ${escapeHtml(t("Owner", "负责人"))} ${escapeHtml(task.owner)}</div>
                <div class="meta">${escapeHtml(t("Due", "截止"))} ${escapeHtml(task.dueAt ?? t("Not set", "未设置"))} · ${escapeHtml(t("Updated", "更新"))} ${escapeHtml(task.updatedAt)}</div>
                <div class="meta"><a href="${escapeHtml(detailHref)}">${escapeHtml(t("Open task detail", "查看任务详情页"))}</a></div>
              </li>`;
            })
            .join("");
          const more = bucket.length > 16 ? `<div class="meta">${escapeHtml(t(`${bucket.length - 16} more tasks are collapsed.`, `其余 ${bucket.length - 16} 个任务已折叠。`))}</div>` : "";
          return `<details class="group-section" open><summary>${escapeHtml(taskStateLabel(state, options.language))} (${bucket.length})</summary><ul class="group-items">${itemRows}</ul>${more}</details>`;
        }).join("")}</div>`;
  const toolGroupedListHtml =
    toolSessions.length === 0
      ? `<div class="empty-state">${escapeHtml(t("No tool-call sessions yet.", "暂无工具调用会话。"))}</div>`
      : `<div class="group-list"><details class="group-section" open><summary>${escapeHtml(t("Active tool sessions", "活跃工具会话"))} (${toolSessions.length})</summary><ul class="group-items">${toolSessions
          .map((item) => {
            const toolCount = item.toolEventCount ?? (item.latestKind === "tool_event" ? 1 : 0);
            return `<li class="group-item">
              <div class="group-item-head"><strong>${escapeHtml(item.label ?? item.sessionKey)}</strong>${badge(item.state, sessionStateLabel(item.state))}</div>
              <div class="meta">${escapeHtml(t("Agent", "智能体"))} ${escapeHtml(item.agentId ?? t("Unassigned", "未分配"))} · ${escapeHtml(t("Calls", "调用"))} ${toolCount} ${escapeHtml(t("times", "次"))}</div>
              <div class="meta">${escapeHtml(t("Latest activity", "最近活动"))} ${escapeHtml(item.lastMessageAt ?? "-")}</div>
              <div class="meta"><a href="${escapeHtml(buildSessionDetailHref(item.sessionKey, options.language))}">${escapeHtml(t("Open session detail", "查看会话详情页"))}</a></div>
            </li>`;
          })
          .join("")}</ul></details></div>`;
  const heartbeatGroupedListHtml =
    heartbeatJobs.length === 0
      ? `<div class="empty-state">${escapeHtml(t("No heartbeat timed jobs found yet.", "尚未发现心跳定时任务。"))}</div>`
      : `<div class="group-list"><details class="group-section" open><summary>${escapeHtml(t("Heartbeat checks", "心跳检查项"))} (${heartbeatJobs.length})</summary><ul class="group-items">${heartbeatJobs
          .slice(0, 16)
          .map((job) => {
            const detailHref = buildCronDetailHref(job.jobId, options.language);
            const checkLabel = job.jobId.toLowerCase().includes("heartbeat")
              ? t("Task heartbeat service", "任务心跳服务")
              : job.name?.trim() || job.jobId;
            return `<li class="group-item">
              <div class="group-item-head"><strong>${escapeHtml(checkLabel)}</strong>${badge(job.health, cronHealthLabel(job.health, options.language))}</div>
              <div class="meta">${escapeHtml(t("Next run", "下次运行"))} ${escapeHtml(job.nextRunAt ?? "-")} · ${escapeHtml(formatSeconds(job.dueInSeconds, options.language))}</div>
              <div class="meta"><a href="${escapeHtml(detailHref)}">${escapeHtml(t("Open task detail", "查看任务详情页"))}</a></div>
            </li>`;
          })
          .join("")}</ul></details></div>`;
  const agentJobGroupedListHtml =
    agentJobCatalogRows.length === 0
      ? `<div class="empty-state">${escapeHtml(t("No visible jobs yet.", "暂无可见 job。"))}</div>`
      : `<div class="group-list">${[...new Set(agentJobCatalogRows.map((item) => item.owner))]
          .slice(0, 10)
          .map((owner) => {
            const jobs = agentJobCatalogRows.filter((item) => item.owner === owner);
            const rows = jobs
              .slice(0, 10)
              .map((item) => {
                const detailHref = buildCronDetailHref(item.jobId, options.language);
                return `<li class="group-item">
                  <div class="group-item-head"><strong>${escapeHtml(item.name)}</strong>${badge(item.status, item.statusLabel)}</div>
                  <div class="meta"><code>${escapeHtml(item.jobId)}</code> · ${escapeHtml(displayCronScheduleLabel(item.schedule, options.language))}</div>
                  <div class="meta">${escapeHtml(sanitizeCronPurposeText(item.purpose, options.language, 80))}</div>
                  <div class="meta"><a href="${escapeHtml(detailHref)}">${escapeHtml(t("Open task detail", "查看任务详情页"))}</a></div>
                </li>`;
              })
              .join("");
            return `<details class="group-section" open><summary>${escapeHtml(owner)} (${jobs.length})</summary><ul class="group-items">${rows}</ul></details>`;
          })
          .join("")}</div>`;

  const exceptionsItems = renderExceptionsList(exceptionsFeed);
  const taskBoard = renderTaskBoard(tasks, options.language);
  const projectBoard = renderProjectBoard(snapshot.projectSummaries, options.language);
  const actionQueueItems = renderActionQueue(actionQueue);
  const effectiveQuick = filters.quick ?? "all";
  const quickFilters = renderQuickFilters(filters, options.compactStatusStrip, options.section, options.language, options.usageView);
  const clearHref = buildHomeHref({ quick: "all" }, options.compactStatusStrip, options.section, options.language, options.usageView);
  const signalItems = [
    { label: t("Active sessions", "活跃会话"), value: liveSessionCount },
    { label: t("Tasks under watch", "正在观察中的任务"), value: taskCertaintyCards.length },
    { label: t("Risk signals", "风险信号"), value: attentionCount },
    { label: t("Active projects", "活跃项目"), value: snapshot.projectSummaries.filter((item) => item.status === "active").length },
  ].filter((item) => item.value > 0);
  const subscriptionWindowHint =
    usageCost.subscription.primaryWindowLabel || usageCost.subscription.secondaryUsedPercent !== undefined
      ? `${normalizeQuotaWindowLabel(usageCost.subscription.primaryWindowLabel, "5h")} / ${normalizeQuotaWindowLabel(
          usageCost.subscription.secondaryWindowLabel,
          "Week",
        )}`
      : usageCost.subscription.planLabel;
  const executiveCards = [
    {
      title: t("Projects", "项目"),
      metric: `${snapshot.projectSummaries.length}`,
      detail: `${t("Active", "活跃")} ${snapshot.projectSummaries.filter((item) => item.status === "active").length} · ${t("Blocked", "阻塞")} ${snapshot.projectSummaries.filter((item) => item.status === "blocked").length}`,
    },
    {
      title: t("Tasks", "任务"),
      metric: `${realTasks.length}`,
      detail: `${t("In motion", "进行中")} ${inProgressTasksCount} · ${t("Blocked", "阻塞")} ${blockedTasksCount}${controlCenterMappingTasks.length > 0 ? ` · ${t("Mapping examples", "映射样例")} ${controlCenterMappingTasks.length}` : ""}`,
    },
    {
      title: t("Agents", "智能体"),
      metric: `${officeCards.filter((card) => card.status !== "inactive").length}`,
      detail: `${t("Online agents", "在线智能体")} ${officeCards.filter((card) => card.activeSessions > 0).length}`,
    },
    {
      title: t("Budget", "预算"),
      metric: `${budgets.total}`,
      detail: `${t("Warnings", "预警")} ${budgets.warn ?? 0} · ${t("Over limit", "超限")} ${budgets.over ?? 0}`,
    },
    {
      title: t("Subscription", "订阅"),
      metric: usageCost.subscription.status === "connected" ? t("Connected", "已连接") : t("Needs connection", "待连接"),
      detail: subscriptionWindowHint,
    },
    {
      title: t("System health", "系统健康"),
      metric: cronOverview.health.status === "ok" ? t("Healthy", "正常") : t("Attention", "关注"),
      detail: `${t("Timed jobs", "定时任务")} ${cronOverview.jobs.length} ${t("items", "个")} · ${t("Heartbeats", "心跳")} ${heartbeatEnabledCount} ${t("items", "个")}`,
    },
  ];
  const executiveCardsHtml = `<section class="executive-grid">${executiveCards
    .map(
      (item) =>
        `<article class="exec-card"><div class="exec-title">${escapeHtml(item.title)}</div><div class="exec-metric">${escapeHtml(item.metric)}</div><div class="meta">${escapeHtml(item.detail)}</div></article>`,
    )
    .join("")}</section>`;
  const overviewTopMetrics = [
    {
      key: "review-queue",
      title: t("Review queue", "审阅队列"),
      numericValue: pendingDecisionCount,
      displayValue: formatInt(pendingDecisionCount),
      detail: pendingDecisionCount > 0 ? t("Waiting for your review", "等你处理") : t("No backlog", "无积压"),
      tone: pendingDecisionCount > 0 ? "warn" : "ok",
    },
    {
      key: "runtime-issues",
      title: t("Runtime issues", "运行异常"),
      numericValue: runtimeSessionIssueCount,
      displayValue: formatInt(runtimeSessionIssueCount),
      detail:
        runtimeSessionIssueCount > 0
          ? t("Blocked, waiting, or failing sessions", "阻塞、等待或报错中的会话")
          : t("Normal", "状态正常"),
      tone: runtimeSessionIssueCount > 0 ? "warn" : "ok",
    },
    {
      key: "stalled-runs",
      title: t("Stalled runs", "停滞执行"),
      numericValue: stalledRunningSessionCount,
      displayValue: formatInt(stalledRunningSessionCount),
      detail:
        stalledRunningSessionCount > 0
          ? t("Running sessions have gone quiet", "运行中的会话已经沉默")
          : t("Fresh", "信号新鲜"),
      tone: stalledRunningSessionCount > 0 ? "warn" : "ok",
    },
    {
      key: "budget-risk",
      title: t("Budget risk", "预算风险"),
      numericValue: budgetRiskCount,
      displayValue: formatInt(budgetRiskCount),
      detail: budgetRiskCount > 0 ? t("Budget warning", "预算告警") : t("Budget safe", "预算安全"),
      tone: budgetRiskCount > 0 ? "warn" : "ok",
    },
    {
      key: "today-usage",
      title: t("Today's usage", "今日用量"),
      numericValue: usageToday?.sourceStatus === "not_connected" ? undefined : usageToday?.tokens ?? 0,
      displayValue: usageToday?.sourceStatus === "not_connected" ? t("Not connected", "未连接") : formatInt(usageToday?.tokens ?? 0),
      detail:
        usageToday?.sourceStatus === "not_connected"
          ? t("Not connected", "未连接")
          : `${t("Cost", "费用")} ${formatCurrency(usageToday?.estimatedCost ?? 0)}`,
      tone: usageToday?.sourceStatus === "not_connected" ? "neutral" : "ok",
    },
  ];
  const overviewTopMetricHtml = `<section class="overview-kpi-grid">${overviewTopMetrics
    .map((item) => {
      const counterAttrs =
        typeof item.numericValue === "number"
          ? ` data-counter-key="overview:${escapeHtml(item.key)}" data-counter-target="${Math.max(0, Math.round(item.numericValue))}" data-counter-format="int"`
          : "";
      return `<article class="overview-kpi-card tone-${escapeHtml(item.tone)}" data-overview-kpi="${escapeHtml(item.key)}">
        <div class="overview-kpi-label">${escapeHtml(item.title)}</div>
        <div class="overview-kpi-value"${counterAttrs}>${escapeHtml(item.displayValue)}</div>
        <div class="overview-kpi-detail">${escapeHtml(item.detail)}</div>
      </article>`;
    })
    .join("")}</section>`;
  const signalStrip = signalItems
    .map((item) => `<div class="status-chip"><span>${escapeHtml(item.label)}</span><strong>${item.value}</strong></div>`)
    .join("");
  const showSignalsFallback = signalItems.length === 0;
  const officeFloorHtml = renderOfficeFloor(officeCards, options.language);
  const staffOverviewCards = needsTeamSnapshot
    ? await buildStaffOverviewCards({
        snapshot,
        client: toolClient,
        members: teamSnapshot.members,
        officeCards,
        executionAgentSummaries,
        language: options.language,
      })
    : [];
  const staffOverviewCardsHtml = renderStaffOverviewCards(staffOverviewCards, options.language);
  const subscriptionStatusHtml = renderSubscriptionStatusCard(usageCost.subscription, options.language);
  const sectionNav = sectionLinks.map((item) => {
    const href = buildHomeHref(filters, options.compactStatusStrip, item.key, options.language, options.usageView);
    const activeClass = item.key === activeSection ? " active" : "";
    const current = item.key === activeSection ? ' aria-current="page"' : "";
    return `<a class="nav-link${activeClass}" href="${escapeHtml(href)}"${current}><span>${escapeHtml(item.label)}</span><small>${escapeHtml(item.blurb)}</small></a>`;
  }).join("");
  const languageToggle = renderLanguageToggle(filters, options);
  const replayMomentsRows =
    replayMoments.length === 0
      ? `<li>${escapeHtml(t("No timeline events yet.", "暂无时间线事件。"))}</li>`
      : replayMoments
          .map((item) => `<li><code>${escapeHtml(item.timestamp)}</code> ${escapeHtml(item.summary)}</li>`)
          .join("");
  const isTodayUsageView = options.usageView === "today";
  const usagePeriodsForView = isTodayUsageView ? usageCost.periods.filter((item) => item.key === "today") : usageCost.periods;
  const usagePeriodCards = renderUsagePeriodCards(usagePeriodsForView, options.language);
  const usageViewTodayHref = buildHomeHref(filters, options.compactStatusStrip, "usage-cost", options.language, "today");
  const usageViewCumulativeHref = buildHomeHref(filters, options.compactStatusStrip, "usage-cost", options.language, "cumulative");
  const usageViewSwitchHtml = `<div class="segment-switch"><a class="segment-item${isTodayUsageView ? " active" : ""}" href="${escapeHtml(usageViewTodayHref)}">${escapeHtml(t("Today", "今天"))}</a><a class="segment-item${!isTodayUsageView ? " active" : ""}" href="${escapeHtml(usageViewCumulativeHref)}">${escapeHtml(t("Cumulative", "累计"))}</a></div>`;
  const usageViewRangeText = isTodayUsageView
    ? t("Range: today from 00:00 until now.", "统计范围：今日 00:00 至当前。")
    : t("Range: cumulative history until now.", "统计范围：历史累计到当前。");
  const usageViewRangeDetail = isTodayUsageView
    ? t("Today view focuses on same-day consumption and live budget pressure.", "今天视图聚焦当日消耗，适合看实时预算压力。")
    : t("Cumulative view shows overall composition and long-term trend.", "累计视图用于看整体结构占比和长期趋势。");
  const usageContextRows = renderUsageContextRows(usageCost.contextWindows, options.language);
  const selectedUsageBreakdown = isTodayUsageView ? usageCost.breakdownToday : usageCost.breakdown;
  const usageAgentRows = renderUsageBreakdownRows(selectedUsageBreakdown.byAgent, "agent", options.language);
  const usageProjectRows = renderUsageBreakdownRows(selectedUsageBreakdown.byProject, "project", options.language);
  const usageTaskBreakdownRows = selectedUsageBreakdown.byTask.filter(
    (item) => !isControlCenterMappingUsageTaskLabel(item.label) && !isControlCenterMappingUsageTaskLabel(item.key),
  );
  const usageTaskRows = renderUsageBreakdownRows(usageTaskBreakdownRows, "task", options.language);
  const usageModelRows = renderUsageBreakdownRows(selectedUsageBreakdown.byModel, "model", options.language);
  const usageProviderRows = renderUsageBreakdownRows(selectedUsageBreakdown.byProvider, "provider", options.language);
  const usageSessionTypeRows = selectedUsageBreakdown.bySessionType;
  const usageCronJobRows = selectedUsageBreakdown.byCronJob;
  const usageCronAgentRows = selectedUsageBreakdown.byCronAgent;
  const usageSessionTypeTotalTokens = usageSessionTypeRows.reduce((sum, item) => sum + item.tokens, 0);
  const usageCronTotalTokens = usageCronJobRows.reduce((sum, item) => sum + item.tokens, 0);
  const usageCronAgentTotalTokens = usageCronAgentRows.reduce((sum, item) => sum + item.tokens, 0);
  const usageSourceAgentTotalTokens = selectedUsageBreakdown.byAgent.reduce((sum, item) => sum + item.tokens, 0);
  const usageSourceProjectTotalTokens = selectedUsageBreakdown.byProject.reduce((sum, item) => sum + item.tokens, 0);
  const runtimeTokenRangeLabel =
    usageToday?.sourceStatus === "not_connected"
      ? t("Range: current snapshot (data source not connected).", "统计范围：当前快照（数据源未连接）。")
      : isTodayUsageView
        ? t("Range: today from 00:00 until now.", "统计范围：今日 00:00 至当前。")
        : t("Range: cumulative until now.", "统计范围：累计至当前。");
  const sessionTypeTokenRangeLabel = isTodayUsageView
    ? t("Range: all sessions today (00:00 until now).", "统计范围：今日全部会话（00:00 至当前）。")
    : t("Range: all sessions cumulative (through now).", "统计范围：全部会话累计（截至当前）。");
  const cronTokenRangeLabel = isTodayUsageView
    ? t("Range: timed-job sessions today (00:00 until now).", "统计范围：今日定时任务会话（00:00 至当前）。")
    : t("Range: timed-job sessions cumulative (through now).", "统计范围：定时任务会话累计（截至当前）。");
  const usageSourcePieHtml =
    selectedUsageBreakdown.byAgent.length === 0 && selectedUsageBreakdown.byProject.length === 0
      ? ""
      : `<div class="bars">
          <div>
            <div class="meta">${escapeHtml(t("Share by agent", "按智能体占比"))}</div>
            ${renderTokenPieChart(selectedUsageBreakdown.byAgent, usageSourceAgentTotalTokens, t("Agents", "智能体"), options.language)}
          </div>
          <div>
            <div class="meta">${escapeHtml(t("Share by project", "按项目占比"))}</div>
            ${renderTokenPieChart(selectedUsageBreakdown.byProject, usageSourceProjectTotalTokens, t("Projects", "项目"), options.language)}
          </div>
        </div>`;
  const usageSessionTypePieHtml = renderTokenPieChart(usageSessionTypeRows, usageSessionTypeTotalTokens, t("All sessions", "全部会话"), options.language);
  const usageCronJobPieHtml = renderTokenPieChart(usageCronJobRows, usageCronTotalTokens, t("Timed jobs", "定时任务"), options.language);
  const usageCronAgentPieHtml = renderTokenPieChart(usageCronAgentRows, usageCronAgentTotalTokens, t("Agents", "智能体"), options.language);
  const usageSessionTypeShareHtml =
    usageSessionTypeRows.length === 0
      ? `<div class="empty-state">${escapeHtml(t("No session-type usage data yet.", "暂无会话类型用量数据。"))}</div>`
      : `<div class="meta">${sessionTypeTokenRangeLabel}</div>
         <div class="meta">${escapeHtml(t("Total usage", "总用量"))}：${formatInt(usageSessionTypeTotalTokens)}</div>
         ${usageSessionTypePieHtml}
         <table>
           <thead><tr><th>${escapeHtml(t("Type", "类型"))}</th><th>${escapeHtml(t("Usage", "用量"))}</th><th>${escapeHtml(t("Share", "占比"))}</th><th>${escapeHtml(t("Sessions", "会话数"))}</th><th>${escapeHtml(t("Data status", "数据状态"))}</th></tr></thead>
           <tbody>${renderTokenShareRows(usageSessionTypeRows, usageSessionTypeTotalTokens, options.language)}</tbody>
         </table>`;
  const usageCronJobShareHtml =
    usageCronJobRows.length === 0
      ? `<div class="empty-state">${escapeHtml(t("No timed-job usage data yet.", "暂无定时任务用量数据。"))}</div>`
      : `<div class="meta">${cronTokenRangeLabel}</div>
         <div class="meta">${escapeHtml(t("Total timed-job usage", "定时任务总用量"))}：${formatInt(usageCronTotalTokens)}</div>
         ${usageCronJobPieHtml}
         <table>
           <thead><tr><th>${escapeHtml(t("Timed job", "定时任务"))}</th><th>${escapeHtml(t("Usage", "用量"))}</th><th>${escapeHtml(t("Share within timed jobs", "占比（定时任务内）"))}</th><th>${escapeHtml(t("Sessions", "会话数"))}</th><th>${escapeHtml(t("Data status", "数据状态"))}</th></tr></thead>
           <tbody>${renderTokenShareRows(usageCronJobRows, usageCronTotalTokens, options.language)}</tbody>
         </table>`;
  const usageCronAgentShareHtml =
    usageCronAgentRows.length === 0
      ? `<div class="empty-state">${escapeHtml(t("No timed-job agent usage data yet.", "暂无定时任务智能体用量数据。"))}</div>`
      : `<div class="meta">${cronTokenRangeLabel}</div>
         <div class="meta">${escapeHtml(t("Total timed-job agent usage", "定时任务智能体总用量"))}：${formatInt(usageCronAgentTotalTokens)}</div>
         ${usageCronAgentPieHtml}
         <table>
           <thead><tr><th>${escapeHtml(t("Agent", "智能体"))}</th><th>${escapeHtml(t("Usage", "用量"))}</th><th>${escapeHtml(t("Share within timed jobs", "占比（定时任务内）"))}</th><th>${escapeHtml(t("Sessions", "会话数"))}</th><th>${escapeHtml(t("Data status", "数据状态"))}</th></tr></thead>
           <tbody>${renderTokenShareRows(usageCronAgentRows, usageCronAgentTotalTokens, options.language)}</tbody>
         </table>`;
  const usageConnectorTodos = renderUsageConnectorTodos(usageCost.connectors.todos, options.language);
  const usageBudgetStatusLabel =
    usageCost.budget.status === "ok" ? t("Healthy", "正常") : usageCost.budget.status === "warn" ? t("Warning", "预警") : t("Over limit", "超限");
  const usageBudgetHeadline =
    usageCost.budget.status === "not_connected"
      ? t("Budget data source is not connected", "预算数据源未连接")
      : `${badge(usageCost.budget.status, usageBudgetStatusLabel)} ${escapeHtml(usageCost.budget.message)}`;
  const usageBudgetMeta =
    usage30d?.sourceStatus === "not_connected"
      ? t("Last 30 days cost: data source not connected", "近 30 天费用：数据源未连接")
      : usageCost.budget.limitCost30d
        ? `${t("Last 30 days cost", "近 30 天费用")} ${formatCurrency(usageCost.budget.usedCost30d)} / ${t("Limit", "限额")} ${formatCurrency(usageCost.budget.limitCost30d)}`
        : `${t("Last 30 days cost", "近 30 天费用")} ${formatCurrency(usageCost.budget.usedCost30d)}`;
  const hasUsageActivity =
    usageCost.contextWindows.length > 0 ||
    usageCost.periods.some((item) => item.tokens > 0 || item.estimatedCost > 0 || item.statusSamples > 0);
  const usageContextHtml =
    usageCost.contextWindows.length === 0
      ? `<div class="empty-state">${escapeHtml(t("No context-usage records yet. They will appear after sessions start.", "暂无上下文使用记录。开始会话后会显示。"))}</div>`
      : `<table>
        <thead><tr><th>${escapeHtml(t("Agent", "助手"))}</th><th>${escapeHtml(t("Session", "会话"))}</th><th>${escapeHtml(t("Model", "模型"))}</th><th>${escapeHtml(t("Context usage", "上下文使用"))}</th><th>${escapeHtml(t("Pace", "节奏"))}</th><th>${escapeHtml(t("Threshold", "阈值"))}</th></tr></thead>
        <tbody>${usageContextRows}</tbody>
      </table>`;
  const usageSourceHtml =
    selectedUsageBreakdown.byAgent.length === 0 && selectedUsageBreakdown.byProject.length === 0
      ? `<div class="empty-state">${escapeHtml(t("No source attribution yet. It will appear after activity is recorded.", "暂无来源拆分。产生调用后会显示。"))}</div>`
      : `<div class="meta">${runtimeTokenRangeLabel}</div>
        ${usageSourcePieHtml}
        ${selectedUsageBreakdown.byAgent.length === 0
          ? ""
          : `<table><thead><tr><th>${escapeHtml(t("Agent", "智能体"))}</th><th>${escapeHtml(t("Usage", "用量"))}</th><th>${escapeHtml(t("Estimated cost", "预估费用"))}</th><th>${escapeHtml(t("Requests", "请求数"))}</th><th>${escapeHtml(t("Sessions", "会话数"))}</th><th>${escapeHtml(t("Data status", "数据状态"))}</th></tr></thead><tbody>${usageAgentRows}</tbody></table>`}
        ${selectedUsageBreakdown.byProject.length === 0
          ? ""
          : `<table style="margin-top:12px;"><thead><tr><th>${escapeHtml(t("Project", "项目"))}</th><th>${escapeHtml(t("Usage", "用量"))}</th><th>${escapeHtml(t("Estimated cost", "预估费用"))}</th><th>${escapeHtml(t("Requests", "请求数"))}</th><th>${escapeHtml(t("Sessions", "会话数"))}</th><th>${escapeHtml(t("Data status", "数据状态"))}</th></tr></thead><tbody>${usageProjectRows}</tbody></table>`}`;
  const usageTaskHtml =
    usageTaskBreakdownRows.length === 0
      ? `<div class="empty-state">${escapeHtml(t("No real task-level usage data yet.", "暂无真实任务级用量数据。"))}</div>`
      : `<div class="meta">${runtimeTokenRangeLabel}</div><table><thead><tr><th>${escapeHtml(t("Task", "任务"))}</th><th>${escapeHtml(t("Usage", "用量"))}</th><th>${escapeHtml(t("Estimated cost", "预估费用"))}</th><th>${escapeHtml(t("Requests", "请求数"))}</th><th>${escapeHtml(t("Sessions", "会话数"))}</th><th>${escapeHtml(t("Data status", "数据状态"))}</th></tr></thead><tbody>${usageTaskRows}</tbody></table>`;
  const usageOverviewAgentRows = renderUsageBreakdownRows(selectedUsageBreakdown.byAgent.slice(0, 8), "agent", options.language);
  const usageOverviewTaskRows = renderUsageBreakdownRows(usageTaskBreakdownRows.slice(0, 8), "task", options.language);
  const usageAttributionHtml =
    selectedUsageBreakdown.byAgent.length === 0 && usageTaskBreakdownRows.length === 0
      ? `<div class="empty-state">${escapeHtml(t("No usage attribution by agent or task yet.", "暂无按智能体/任务归因的用量数据。"))}</div>`
      : `<div class="meta">${runtimeTokenRangeLabel}</div>
        ${selectedUsageBreakdown.byAgent.length === 0
          ? ""
          : `<table><thead><tr><th>${escapeHtml(t("Agent", "智能体"))}</th><th>${escapeHtml(t("Usage", "用量"))}</th><th>${escapeHtml(t("Estimated cost", "预估费用"))}</th><th>${escapeHtml(t("Requests", "请求数"))}</th><th>${escapeHtml(t("Sessions", "会话数"))}</th><th>${escapeHtml(t("Data status", "数据状态"))}</th></tr></thead><tbody>${usageOverviewAgentRows}</tbody></table>`}
        ${usageTaskBreakdownRows.length === 0
          ? ""
          : `<table style="margin-top:12px;"><thead><tr><th>${escapeHtml(t("Task", "任务"))}</th><th>${escapeHtml(t("Usage", "用量"))}</th><th>${escapeHtml(t("Estimated cost", "预估费用"))}</th><th>${escapeHtml(t("Requests", "请求数"))}</th><th>${escapeHtml(t("Sessions", "会话数"))}</th><th>${escapeHtml(t("Data status", "数据状态"))}</th></tr></thead><tbody>${usageOverviewTaskRows}</tbody></table>`}`;
  const usageModelMixHtml =
    selectedUsageBreakdown.byModel.length === 0 && selectedUsageBreakdown.byProvider.length === 0
      ? `<div class="empty-state">${escapeHtml(t("No model or provider split yet.", "暂无模型与供应商拆分数据。"))}</div>`
      : `<div class="meta">${runtimeTokenRangeLabel}</div>
        ${selectedUsageBreakdown.byModel.length === 0
          ? ""
          : `<table><thead><tr><th>${escapeHtml(t("Model", "模型"))}</th><th>${escapeHtml(t("Usage", "用量"))}</th><th>${escapeHtml(t("Estimated cost", "预估费用"))}</th><th>${escapeHtml(t("Requests", "请求数"))}</th><th>${escapeHtml(t("Sessions", "会话数"))}</th><th>${escapeHtml(t("Data status", "数据状态"))}</th></tr></thead><tbody>${usageModelRows}</tbody></table>`}
        ${selectedUsageBreakdown.byProvider.length === 0
          ? ""
          : `<table style="margin-top:12px;"><thead><tr><th>${escapeHtml(t("Provider", "供应商"))}</th><th>${escapeHtml(t("Usage", "用量"))}</th><th>${escapeHtml(t("Estimated cost", "预估费用"))}</th><th>${escapeHtml(t("Requests", "请求数"))}</th><th>${escapeHtml(t("Sessions", "会话数"))}</th><th>${escapeHtml(t("Data status", "数据状态"))}</th></tr></thead><tbody>${usageProviderRows}</tbody></table>`}`;
  const renderExecutionAgentItem = (item: ExecutionAgentSummary, mode: "active" | "usage"): string => {
    const modeHint = mode === "active"
      ? t("Live", "实时")
      : t("Recent", "近期");
    const detail = mode === "active"
      ? `${t("Sessions", "会话")} ${item.activeSessions} · ${t("Tasks", "任务")} ${item.activeTasks}`
      : `${t("Recent usage", "近期用量")} ${formatInt(item.recentTokens30d)}`;
    return `<li><strong>${escapeHtml(item.displayName)}</strong> <span class="meta-inline">${escapeHtml(modeHint)}</span><div class="meta">${detail}</div></li>`;
  };
  const activeExecutionAgentRows = executionAgentSummaries
    .filter((item) => item.activeSessions > 0 || item.activeTasks > 0 || item.enabledCronJobs > 0)
    .slice(0, 8)
    .map((item) => {
      return renderExecutionAgentItem(item, "active");
    })
    .join("");
  const usageFallbackExecutionRows = executionAgentSummaries
    .filter((item) => item.recentTokens30d > 0)
    .slice(0, 8)
    .map((item) => renderExecutionAgentItem(item, "usage"))
    .join("");
  const executionAgentRows = activeExecutionAgentRows || usageFallbackExecutionRows;
  const taskRoleRows = taskRoleSummaries
    .map(
      (item) =>
        `<li><strong>${escapeHtml(item.owner)}</strong><div class="meta">${escapeHtml(t("Board labels", "看板标签"))} ${item.activeTasks} ${escapeHtml(t("items", "个"))} · ${escapeHtml(t("Examples", "示例"))}：${escapeHtml(item.sampleTaskIds.join("、") || t("None", "暂无"))}</div></li>`,
    )
    .join("");
  const mappingTaskRows = controlCenterMappingTasks
    .map(
      (task) =>
        `<tr><td>${escapeHtml(task.taskId)}</td><td>${escapeHtml(task.owner)}</td><td>${badge(task.status, taskStateLabel(task.status, options.language))}</td></tr>`,
    )
    .join("");
  const cronTable =
    allCronRows.length === 0
      ? `<div class="empty-state">${escapeHtml(t("No timed jobs yet. They will appear here after you create them.", "暂无定时任务。创建后会显示在这里。"))}</div>`
      : `<table>
          <thead><tr><th>${escapeHtml(t("Job", "任务"))}</th><th>${escapeHtml(t("Agent", "智能体"))}</th><th>${escapeHtml(t("Purpose", "任务目的"))}</th><th>${escapeHtml(t("Status", "状态"))}</th><th>${escapeHtml(t("Next run", "下次运行"))}</th><th>${escapeHtml(t("Due in", "距离执行"))}</th></tr></thead>
          <tbody>${cronRows}</tbody>
        </table>`;
  const cronOwnerBuckets = new Map<string, typeof allCronRows>();
  for (const job of allCronRows) {
    const ownerKey = job.owner.trim() || t("Unassigned agent", "未分配智能体");
    const bucket = cronOwnerBuckets.get(ownerKey) ?? [];
    bucket.push(job);
    cronOwnerBuckets.set(ownerKey, bucket);
  }
  const cronBoardHtml =
    allCronRows.length === 0
      ? `<div class="empty-state">${escapeHtml(t("No timed jobs yet. They will be grouped by agent here once configured.", "暂无定时任务，配置后这里会自动按智能体分组展示。"))}</div>`
      : `<div class="cron-board">${[...cronOwnerBuckets.entries()]
          .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "zh-Hans-CN"))
          .map(([owner, jobs]) => {
            const healthyCount = jobs.filter((item) => item.status === "ok" || item.status === "enabled").length;
            const unhealthyCount = jobs.length - healthyCount;
            const jobRows = jobs
              .slice(0, 10)
              .map((item) => {
                const dueIn = Number.isFinite(item.dueInSeconds) ? formatSeconds(item.dueInSeconds, options.language) : "-";
                return `<li><div class="cron-job-head"><strong>${escapeHtml(item.name)}</strong>${badge(item.status, item.statusLabel)}</div><div class="meta">${escapeHtml(sanitizeCronPurposeText(item.purpose, options.language, 52))}</div><div class="meta">${escapeHtml(t("Next", "下次"))}：${escapeHtml(item.nextRun)} · ${escapeHtml(dueIn)}</div></li>`;
              })
              .join("");
            const moreLabel = jobs.length > 10 ? `<div class="meta">${escapeHtml(t(`${jobs.length - 10} more jobs are omitted.`, `其余 ${jobs.length - 10} 个任务已省略。`))}</div>` : "";
            return `<article class="cron-owner-card"><div class="cron-owner-head"><h3>${escapeHtml(owner)}</h3><span class="meta">${jobs.length} ${escapeHtml(t("jobs", "个任务"))}</span></div><div class="meta">${escapeHtml(t("Healthy", "健康"))} ${healthyCount} · ${escapeHtml(t("Attention", "关注"))} ${unhealthyCount}</div><ul class="cron-job-list">${jobRows}</ul>${moreLabel}</article>`;
          })
          .join("")}</div>`;
  const subscriptionSidebarRows = renderSubscriptionSidebarSummary(usageCost.subscription, options.language);
  const usageDetailHref = buildHomeHref({ quick: "all" }, options.compactStatusStrip, "usage-cost", options.language, options.usageView);
  const connectionHealthCard = renderOpenClawConnectionCard(connectionHealthSummary, usageCost, options.language);
  const securityRiskSection = renderOpenClawSecuritySection(securitySummary, options.language);
  const updateStatusSection = renderOpenClawUpdateSection(updateSummary, options.language);
  const contextPressureCard = renderContextPressureCard(usageCost, options.language);
  const memoryStateSection = renderMemoryStateSection(memoryStateSummary, options.language);
  const overviewUsagePeriods = isTodayUsageView
    ? usageCost.periods.filter((item) => item.key === "today")
    : usageCost.periods.filter((item) => item.key === "today" || item.key === "7d");
  const overviewUsageCards = hasUsageActivity
    ? renderUsagePeriodCards(overviewUsagePeriods, options.language)
    : `<div class="empty-state">${escapeHtml(t("No usage data yet. Usage and cost cards will appear after activity starts.", "暂无用量数据。开始会话后会显示用量和费用卡片。"))}</div>`;
  const overviewAttentionTotal = pendingDecisionCount + runtimeIssueCount + budgetRiskCount;
  const overviewCommandStatus = overviewAttentionTotal > 0 ? badge("warn", t("Needs attention", "需要关注")) : badge("ok", t("Stable", "平稳"));
  const overviewActionItems = [
    {
      label: t("Review queue", "审阅队列"),
      value: pendingDecisionCount,
      detail:
        pendingDecisionCount > 0
          ? t("Approvals or runtime actions are waiting for review", "还有审批或运行异常等待处理")
          : t("Nothing is waiting for review", "当前没有待审事项"),
    },
    {
      label: t("Runtime issues", "运行异常"),
      value: runtimeIssueCount,
      detail:
        runtimeIssueCount > 0
          ? t(
              `${runtimeSessionIssueCount} blocked/error/waiting sessions · ${stalledRunningSessionCount} stalled runs`,
              `${runtimeSessionIssueCount} 个阻塞/异常/等待会话 · ${stalledRunningSessionCount} 个停滞执行`,
            )
          : t("No blocked, failing, or stalled runtime signal", "当前没有阻塞、报错或停滞信号"),
    },
    {
      label: t("Budget risk", "预算风险"),
      value: budgetRiskCount,
      detail: budgetRiskCount > 0 ? t("Near or over the budget line", "接近或触发预算线") : t("Budget is in the safe zone", "预算处于安全区"),
    },
  ];
  const overviewActionRows = overviewActionItems
    .map((item) => {
      const toneClass = item.value > 0 ? " hot" : "";
      return `<div class="overview-action-item${toneClass}"><span>${escapeHtml(item.label)}</span><strong>${item.value}</strong><small>${escapeHtml(item.detail)}</small></div>`;
    })
    .join("");
  const overviewPrimaryStatus = overviewAttentionTotal > 0 ? badge("warn", t("Needs attention", "需要关注")) : badge("ok", t("Stable", "稳定运行"));
  const overviewPrimarySignalText = overviewAttentionTotal > 0 ? t("Runtime is surfacing signals that need intervention.", "运行现场正在冒出需要你处理的信号。") : t("The system is holding a stable rhythm.", "系统维持稳定节奏。");
  const overviewPrimaryDirective =
    pendingDecisionCount > 0
      ? t("Clear the review queue first", "先清掉审阅队列")
      : runtimeIssueCount > 0
        ? t("Inspect blocked, failing, or stalled runs next", "接着检查阻塞、报错和停滞执行")
        : budgetRiskCount > 0
          ? t("Prioritize budget risk", "优先处理预算风险")
          : t("Keep the current rhythm", "继续保持当前节奏");
  markRenderPhase("view-models");
  const overviewFocusScore = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        100 -
          pendingDecisionCount * 14 -
          runtimeSessionIssueCount * 18 -
          stalledRunningSessionCount * 16 -
          budgetRiskCount * 18,
      ),
    ),
  );
  const overviewFocusTone =
    overviewFocusScore >= 80 ? "#1f9a63" : overviewFocusScore >= 60 ? "#c28819" : "#d2473a";
  const overviewFocusHeadline =
    overviewFocusScore >= 80 ? t("Flowing well", "推进顺畅") : overviewFocusScore >= 60 ? t("Light pressure", "轻度压力") : t("Needs immediate action", "需要立刻处理");
  const overviewFocusShort = `${t("Review queue", "审阅队列")} ${pendingDecisionCount} · ${t("Runtime issues", "运行异常")} ${runtimeSessionIssueCount} · ${t("Stalled runs", "停滞执行")} ${stalledRunningSessionCount} · ${t("Budget risk", "预算风险")} ${budgetRiskCount}`;
  const enabledCronCount = allCronRows.filter((item) => item.status !== "disabled").length;
  const upcomingTaskDueCount = realTasks.filter((task) => task.dueAt && task.status !== "done").length;
  const taskHubHref = buildHomeHref({ quick: "all" }, options.compactStatusStrip, "projects-tasks", options.language, options.usageView);
  const cronHubHref = `${taskHubHref}#cron-execution-board`;
  const timelineHubHref = `${taskHubHref}#calendar-board`;
  const decisionHubHref = `${taskHubHref}#task-decision-center`;
  const executionChainHubHref = `${taskHubHref}#task-execution-chain`;
  const staffHubHref = buildHomeHref({ quick: "all" }, options.compactStatusStrip, "team", options.language, options.usageView);
  const overviewNextOpsSummary = `Cron ${cronOverview.nextRunAt ?? t("None", "暂无")} · ${t("Heartbeat", "心跳")} ${heartbeatNextRun}`;
  const calendarEvents = [
    ...allCronRows.map((row) => ({
      at: row.nextRun,
      day: extractDateFromName(row.nextRun) ?? row.nextRun.slice(0, 10),
      type: "Cron",
      title: row.name,
      status: row.status,
      detail: sanitizeCronPurposeText(row.purpose, options.language, 64),
      owner: row.owner,
    })),
    ...realTasks
      .filter((task) => task.status !== "done" && task.dueAt)
      .map((task) => ({
        at: task.dueAt ?? "-",
        day: task.dueAt ? task.dueAt.slice(0, 10) : "-",
        type: t("Task due", "任务截止"),
        title: task.title,
        status: task.status,
        detail: `${task.projectId} · ${task.owner}`,
        owner: task.owner,
      })),
  ]
    .filter((item) => item.day && item.day !== "-")
    .sort((a, b) => a.at.localeCompare(b.at));
  const overviewUpcomingRows = calendarEvents
    .slice(0, 4)
    .map(
      (item) => `<div class="decision-row">
        <div class="decision-row-copy">
          <strong>${escapeHtml(item.title)}</strong>
          <div class="meta">${escapeHtml(item.type)} · ${escapeHtml(item.owner)}</div>
        </div>
        <div class="decision-row-value">${escapeHtml(item.at)}</div>
      </div>`,
    )
    .join("");
  const overviewBusyAgents = executionAgentSummaries
    .filter((item) => item.activeSessions > 0 || item.activeTasks > 0 || item.enabledCronJobs > 0)
    .sort((a, b) => b.activeTasks - a.activeTasks || b.activeSessions - a.activeSessions || b.enabledCronJobs - a.enabledCronJobs)
    .slice(0, 3);
  const overviewBusyCardsHtml =
    overviewBusyAgents.length === 0
      ? `<div class="empty-state">${escapeHtml(t("No staff are carrying live work right now.", "当前没有员工在承担实时工作。"))}</div>`
      : `<div class="overview-busy-grid">${overviewBusyAgents
          .map((item) => {
            const leadAssignment = item.cronJobNames[0] ?? t("No live assignment", "暂无实时分派");
            return `<article class="overview-busy-card">
              <div class="overview-busy-head">
                <strong>${escapeHtml(item.displayName)}</strong>
                <span>${escapeHtml(t("Live", "实时"))}</span>
              </div>
              <div class="overview-busy-copy">${escapeHtml(leadAssignment)}</div>
              <div class="meta">${escapeHtml(t("Tasks", "任务"))} ${item.activeTasks} · ${escapeHtml(t("Sessions", "会话"))} ${item.activeSessions} · Cron ${item.enabledCronJobs}</div>
            </article>`;
          })
          .join("")}</div>`;
  const overviewDecisionRowsHtml = `<div class="overview-action-grid">${[
    { ...overviewActionItems[0], href: decisionHubHref },
    { ...overviewActionItems[1], href: focusHref },
    { ...overviewActionItems[2], href: usageDetailHref },
  ]
    .map((item) => {
      const toneClass = item.value > 0 ? " hot" : "";
      return `<a class="overview-action-item${toneClass}" href="${escapeHtml(item.href)}">
        <span>${escapeHtml(item.label)}</span>
        <strong>${item.value}</strong>
        <small>${escapeHtml(item.detail)}</small>
      </a>`;
    })
    .join("")}</div>`;
  const overviewRuntimeRowsHtml = `<div class="decision-list">
    <div class="decision-row">
      <div class="decision-row-copy">
        <strong>${escapeHtml(t("Timed jobs running", "正在运行的定时任务"))}</strong>
        <div class="meta">${escapeHtml(t("Next", "下次"))} ${escapeHtml(cronOverview.nextRunAt ?? t("None", "暂无"))}</div>
      </div>
      <div class="decision-row-value">${enabledCronCount}/${allCronRows.length}</div>
    </div>
    <div class="decision-row">
      <div class="decision-row-copy">
        <strong>${escapeHtml(t("Heartbeat checks", "任务心跳"))}</strong>
        <div class="meta">${escapeHtml(t("Next", "下次"))} ${escapeHtml(heartbeatNextRun)}</div>
      </div>
      <div class="decision-row-value">${heartbeatEnabledCount}</div>
    </div>
    <div class="decision-row">
      <div class="decision-row-copy">
        <strong>${escapeHtml(t("Stalled runs", "停滞执行"))}</strong>
        <div class="meta">${escapeHtml(t("Running sessions with no fresh signal in the last 2 hours", "最近 2 小时没有新信号的运行会话"))}</div>
      </div>
      <div class="decision-row-value">${stalledRunningSessionCount}</div>
    </div>
    <a class="decision-row" href="${escapeHtml(executionChainHubHref)}">
      <div class="decision-row-copy">
        <strong>${escapeHtml(t("Isolated execution", "隔离执行"))}</strong>
        <div class="meta">${escapeHtml(t("Accepted and spawned child sessions", "已接单并派发子会话"))}</div>
      </div>
      <div class="decision-row-value">${runningExecutionChainCount}/${spawnedExecutionChainCount}</div>
    </a>
  </div>`;
  const taskDecisionPreviewHtml =
    actionQueue.queue.length > 0
      ? `<div class="decision-list">${actionQueue.queue
          .slice(0, 4)
          .map((item) => {
            const link = item.links[0]?.href ?? decisionHubHref;
            return `<a class="decision-row" href="${escapeHtml(link)}">
              <div class="decision-row-copy">
                <strong>${escapeHtml(item.message)}</strong>
                <div class="meta">${badge(item.level)} <code>${escapeHtml(item.itemId)}</code></div>
              </div>
              <div class="decision-row-link">${escapeHtml(t("Open", "打开"))}</div>
            </a>`;
          })
          .join("")}</div>`
      : topApprovals.length > 0
        ? `<div class="decision-list">${topApprovals
            .slice(0, 4)
            .map((approval) => {
              const target = approval.agentId ?? approval.sessionKey ?? t("Unknown target", "未知目标");
              return `<a class="decision-row" href="${escapeHtml(decisionHubHref)}">
                <div class="decision-row-copy">
                  <strong>${escapeHtml(approval.command || t("Approval action", "审批动作"))}</strong>
                  <div class="meta">${badge(approval.status ?? "unknown")} ${escapeHtml(target)}</div>
                </div>
                <div class="decision-row-link">${escapeHtml(t("Review", "审阅"))}</div>
              </a>`;
            })
            .join("")}</div>`
        : `<div class="empty-state">${escapeHtml(t("Nothing is waiting for your review right now.", "当前没有等待你决策的事项。"))}</div>`;
  const taskHubStatCardsHtml = `<div class="task-hub-stat-grid">
    <article class="task-hub-stat">
      <span>${escapeHtml(t("Confirmed live", "已确认在跑"))}</span>
      <strong>${taskCertaintyStrongCount}</strong>
      <small>${escapeHtml(t("Tasks already backed by fresh runtime signals", "已经有新鲜运行信号支撑的任务"))}</small>
    </article>
    <article class="task-hub-stat">
      <span>${escapeHtml(t("Need review", "待确认"))}</span>
      <strong>${pendingDecisionCount}</strong>
      <small>${escapeHtml(t("Approvals and action items", "审批与待处理事项"))}</small>
    </article>
    <article class="task-hub-stat">
      <span>${escapeHtml(t("Timed jobs", "定时任务"))}</span>
      <strong>${enabledCronCount}</strong>
      <small>${escapeHtml(t("Enabled cron jobs", "已启用的 Cron"))}</small>
    </article>
    <article class="task-hub-stat">
      <span>${escapeHtml(t("Needs inspection", "需排查"))}</span>
      <strong>${taskCertaintyWeakCount}</strong>
      <small>${escapeHtml(t("Tasks whose runtime signals still look weak", "运行信号仍然偏弱的任务"))}</small>
    </article>
  </div>`;
  const overviewSection = `
    <section class="overview-v3-shell" id="overview-decision-home">
      <article class="card overview-primary-card" id="overview-primary-card">
        <div class="overview-primary-head">
          <div>
            <h2>${escapeHtml(t("Today's control posture", "今日总控态势"))}</h2>
            <div class="meta">${escapeHtml(overviewPrimarySignalText)}</div>
          </div>
          <div>${overviewPrimaryStatus}</div>
        </div>
        <div class="overview-focus-stage" style="--focus-score:${overviewFocusScore}; --focus-tone:${escapeHtml(overviewFocusTone)};">
          <div class="overview-focus-ring">
            <div class="overview-focus-core">
              <div class="overview-focus-score" data-counter-key="overview:focus-score" data-counter-target="${overviewFocusScore}" data-counter-format="int">${overviewFocusScore}</div>
              <div class="overview-focus-unit" aria-label="${escapeHtml(t("Health score", "健康分"))}">${escapeHtml(
                t("Health", "健康分"),
              )}</div>
            </div>
          </div>
          <div class="overview-focus-copy">
            <div class="overview-focus-headline">${escapeHtml(overviewFocusHeadline)}</div>
            <div class="overview-focus-sub">${escapeHtml(overviewFocusShort)}</div>
            <div class="overview-focus-meta">${escapeHtml(overviewNextOpsSummary)}</div>
          </div>
        </div>
        <div class="overview-primary-directive">${escapeHtml(overviewPrimaryDirective)}</div>
        <div class="overview-primary-core">
          <div class="overview-primary-value" data-counter-key="overview:attention-total" data-counter-target="${Math.max(
            0,
            overviewAttentionTotal,
          )}" data-counter-format="int">${formatInt(overviewAttentionTotal)}</div>
          <div class="overview-primary-label">${escapeHtml(t("Key action items", "待处理关键事项"))}</div>
        </div>
        <div class="overview-quick-links">
          <a class="btn" href="${escapeHtml(currentTaskHealthHref)}">${escapeHtml(t("Open current tasks", "查看当前任务"))}</a>
          <a class="btn" href="${escapeHtml(focusHref)}">${escapeHtml(t("Open follow-up items", "查看待处理"))}</a>
        </div>
      </article>
      ${overviewTopMetricHtml}
    </section>
    <section class="overview-decision-grid" id="overview-primary-section">
      <article class="card" id="overview-decision-center">
        <div class="overview-command-head">
          <h2>${escapeHtml(t("Needs your intervention", "需要你介入"))}</h2>
          <div>${overviewCommandStatus}</div>
        </div>
        ${overviewDecisionRowsHtml}
      </article>
      <article class="card" id="overview-busy-staff">
        <div class="overview-command-head">
          <h2>${escapeHtml(t("Who is active", "谁在忙"))}</h2>
          <a class="btn" href="${escapeHtml(staffHubHref)}">${escapeHtml(t("Open staff", "查看员工"))}</a>
        </div>
        ${overviewBusyCardsHtml}
      </article>
      <article class="card overview-usage-card" id="usage-pulse">
        <div class="overview-command-head">
          <h2>${escapeHtml(t("AI burn now", "当前 AI 用量"))}</h2>
          <a class="btn" href="${escapeHtml(usageDetailHref)}">${escapeHtml(t("Open usage", "查看用量"))}</a>
        </div>
        ${overviewUsageCards}
        <div class="meta">${usageBudgetMeta}</div>
      </article>
      <article class="card" id="overview-runtime-checkpoint">
        <div class="overview-command-head">
          <h2>${escapeHtml(t("Next scheduled work", "下一批排程"))}</h2>
          <a class="btn" href="${escapeHtml(timelineHubHref)}">${escapeHtml(t("Open task hub", "查看任务中枢"))}</a>
        </div>
        ${
          overviewUpcomingRows
            ? `<div class="decision-list">${overviewUpcomingRows}</div>`
            : `<div class="empty-state">${escapeHtml(t("No future schedule yet.", "暂无未来排程。"))}</div>`
        }
        <div style="height:10px;"></div>
        ${overviewRuntimeRowsHtml}
      </article>
    </section>
    <details class="card compact-details overview-secondary-shell" id="overview-secondary-shell">
      <summary>${escapeHtml(t("Expand runtime detail", "展开运行细节"))}</summary>
      <div class="fold-body">
        <details class="card compact-details" open>
          <summary>${escapeHtml(t("More key metrics", "更多关键指标"))}</summary>
          <div class="fold-body">${executiveCardsHtml}</div>
        </details>
        <article class="card overview-span overview-pulse-card" id="overview-pulse">
          <h2>${escapeHtml(t("Global pulse", "全局脉搏"))}</h2>
          ${
            showSignalsFallback
              ? `<div class="empty-state">${escapeHtml(t("No live signals yet. This will update automatically after tasks or sessions start.", "还没有实时信号。启动任务或会话后，这里会自动更新。"))}</div>`
              : `<div class="status-strip ${options.compactStatusStrip ? "compact" : "expanded"}">${signalStrip}</div>`
          }
        </article>
        <section class="card" id="cron-health">
          <div class="overview-command-head">
            <h2>${escapeHtml(t("Runtime checkpoint", "运行检查点"))}</h2>
            <a class="btn" href="${escapeHtml(cronHubHref)}">${escapeHtml(t("Open cron board", "查看 Cron 看板"))}</a>
          </div>
          <div class="meta">${escapeHtml(t("Use the task hub for the full cron board. This panel stays compact and only tells you whether runtime scheduling is healthy.", "完整 Cron 看板已下放到任务页，这里只保留紧凑的运行检查点。"))}</div>
          <div class="meta">${escapeHtml(t("Status", "状态"))} ${badge(cronOverview.health.status)} · ${escapeHtml(t("Next", "下次"))} ${escapeHtml(cronOverview.nextRunAt ?? t("None", "暂无"))} · ${escapeHtml(t("Enabled", "启用"))} ${enabledCronCount}</div>
          ${
            overviewUpcomingRows
              ? `<div class="decision-list" style="margin-top:10px;">${overviewUpcomingRows}</div>`
              : ""
          }
        </section>
        <details class="card compact-details" id="heartbeat-health">
          <summary>${escapeHtml(t("Heartbeat monitor", "任务心跳监控"))}</summary>
          <div class="fold-body">
            <div class="meta">${escapeHtml(t("Status", "状态"))} ${badge(heartbeatHealth)} · ${escapeHtml(t("Enabled", "已启用"))} ${heartbeatEnabledCount} ${escapeHtml(t("items", "个"))} · ${escapeHtml(t("Next", "下次"))} ${escapeHtml(heartbeatNextRun)}</div>
            ${heartbeatGroupedListHtml}
            <details class="compact-table-details" style="margin-top:12px;">
              <summary>${escapeHtml(t("Open raw table", "查看原始表格"))}</summary>
              <div class="fold-body">${
                heartbeatJobs.length === 0
                  ? `<div class="empty-state">${escapeHtml(t("No heartbeat timed jobs found yet.", "尚未发现心跳定时任务。"))}</div>`
                  : `<table><thead><tr><th>${escapeHtml(t("Check", "检查项"))}</th><th>${escapeHtml(t("Status", "状态"))}</th><th>${escapeHtml(t("Next run", "下次运行"))}</th><th>${escapeHtml(t("Due in", "距离执行"))}</th></tr></thead><tbody>${heartbeatJobs
                      .slice(0, 12)
                      .map((job) => {
                        const checkLabel = job.jobId.toLowerCase().includes("heartbeat")
                          ? t("Task heartbeat service", "任务心跳服务")
                          : job.name?.trim() || job.jobId;
                        return `<tr><td>${escapeHtml(checkLabel)}</td><td>${badge(job.health, cronHealthLabel(job.health, options.language))}</td><td>${escapeHtml(job.nextRunAt ?? "-")}</td><td>${escapeHtml(formatSeconds(job.dueInSeconds, options.language))}</td></tr>`;
                      })
                      .join("")}</tbody></table>`
              }</div>
            </details>
          </div>
        </details>
        <details class="card compact-details" id="tool-activity">
          <summary>${escapeHtml(t("Tool activity detail", "工具调用详情"))}</summary>
          <div class="fold-body">
            ${toolGroupedListHtml}
            <details class="compact-table-details" style="margin-top:12px;">
              <summary>${escapeHtml(t("Open raw table", "查看原始表格"))}</summary>
              <div class="fold-body">
                <table>
                  <thead><tr><th>${escapeHtml(t("Session", "会话"))}</th><th>${escapeHtml(t("Agent", "助手"))}</th><th>${escapeHtml(t("Call count", "调用次数"))}</th><th>${escapeHtml(t("Status", "状态"))}</th><th>${escapeHtml(t("Latest activity", "最近活动"))}</th></tr></thead>
                  <tbody>${toolRows}</tbody>
                </table>
              </div>
            </details>
          </div>
        </details>
        <details class="card compact-details" id="agent-job-catalog">
          <summary>${escapeHtml(t("Timed-job catalog (execution entry)", "定时任务名录（执行入口）"))}</summary>
          <div class="fold-body">
            <div class="meta">${escapeHtml(t("This shows the real timed jobs that can trigger execution.", "这里展示会触发执行的真实定时任务。"))}</div>
            ${agentJobGroupedListHtml}
            <details class="compact-table-details" style="margin-top:12px;">
              <summary>${escapeHtml(t("Open raw table", "查看原始表格"))}</summary>
              <div class="fold-body">
                <table>
                  <thead><tr><th>${escapeHtml(t("Source", "来源"))}</th><th>${escapeHtml(t("Job", "任务"))}</th><th>${escapeHtml(t("Agent", "智能体"))}</th><th>${escapeHtml(t("Purpose", "任务目的"))}</th><th>${escapeHtml(t("Schedule", "调度"))}</th><th>${escapeHtml(t("Next run", "下次运行"))}</th><th>${escapeHtml(t("Status", "状态"))}</th></tr></thead>
                  <tbody>${agentJobRowsHtml}</tbody>
                </table>
              </div>
            </details>
          </div>
        </details>
      </div>
    </details>
  `;
  const calendarBuckets = new Map<string, typeof calendarEvents>();
  for (const event of calendarEvents) {
    const bucket = calendarBuckets.get(event.day) ?? [];
    bucket.push(event);
    calendarBuckets.set(event.day, bucket);
  }
  const calendarBoardHtml =
    calendarBuckets.size === 0
      ? `<div class="empty-state">${escapeHtml(t("No future schedule yet. You can add timed jobs from tasks or automations.", "暂无未来排程。你可以在任务或自动化里添加定时任务。"))}</div>`
      : `<div class="calendar-grid">${[...calendarBuckets.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .slice(0, 12)
          .map(([day, events]) => {
            const rows = events
              .slice(0, 10)
              .map(
                (item) => `<li class="calendar-event">
                  <div class="calendar-event-head"><strong>${escapeHtml(item.title)}</strong>${badge(item.status)}</div>
                  <div class="meta">${escapeHtml(item.type)} · ${escapeHtml(item.at)}</div>
                  <div class="meta">${escapeHtml(item.detail)}</div>
                </li>`,
              )
              .join("");
            return `<article class="calendar-day"><h3>${escapeHtml(day)}</h3><div class="meta">${events.length} ${escapeHtml(t("scheduled items", "条排程"))}</div><ul class="calendar-event-list">${rows}</ul></article>`;
          })
          .join("")}</div>`;
  const calendarSection = `
    <section class="card" id="calendar-board">
      <div id="task-timeline">
        <h2>${escapeHtml(t("Today and next schedule", "今日与下一批排程"))}</h2>
        <div class="meta">${escapeHtml(t("See timed jobs and due dates together so you can confirm OpenClaw actually scheduled them, instead of only saying it did in chat.", "把定时任务和任务截止放在一起看，确认 OpenClaw 真的排上了，而不是只在对话里说“已安排”。"))}</div>
        <div class="timeline-summary-strip">
          <div class="timeline-stat"><span>${escapeHtml(t("Timed jobs", "定时任务"))}</span><strong>${allCronRows.length}</strong><small>${escapeHtml(t("Catalog total", "名录总数"))}</small></div>
          <div class="timeline-stat"><span>${escapeHtml(t("Enabled", "启用"))}</span><strong>${enabledCronCount}</strong><small>${escapeHtml(t("Ready to run", "已准备执行"))}</small></div>
          <div class="timeline-stat"><span>${escapeHtml(t("Upcoming due", "即将截止"))}</span><strong>${upcomingTaskDueCount}</strong><small>${escapeHtml(t("Tasks with due dates", "带截止时间的任务"))}</small></div>
        </div>
      </div>
      ${calendarBoardHtml}
      <details class="compact-table-details" style="margin-top:12px;">
        <summary>${escapeHtml(t("Open Cron table detail", "查看 Cron 表格明细"))}</summary>
        <div class="fold-body">${cronTable}</div>
      </details>
    </section>
  `;
  const cronExecutionSection = `
    <section class="card" id="cron-execution-board">
      <div class="overview-command-head">
        <h2>${escapeHtml(t("Cron execution board", "Cron 执行看板"))}</h2>
        <div>${badge(cronOverview.health.status, cronHealthLabel(cronOverview.health.status, options.language))}</div>
      </div>
      <div class="meta">${escapeHtml(t("Grouped by agent so you can see which timed jobs are active, what they do, and when they run next.", "按智能体分组展示当前定时任务、任务目的以及下次执行时间。"))}</div>
      <div class="meta">${escapeHtml(t("Next", "下次"))} ${escapeHtml(cronOverview.nextRunAt ?? t("None", "暂无"))} · ${escapeHtml(t("Heartbeat", "心跳"))} ${escapeHtml(heartbeatNextRun)} · ${escapeHtml(t("Enabled", "启用"))} ${enabledCronCount}</div>
      ${cronBoardHtml}
      <details class="compact-table-details" style="margin-top:12px;">
        <summary>${escapeHtml(t("Open Cron table detail", "查看 Cron 表格明细"))}</summary>
        <div class="fold-body">${cronTable}</div>
      </details>
    </section>
  `;
  const taskExecutionChainSection = `
    <section class="card" id="task-execution-chain">
      <div class="overview-command-head">
        <h2>${escapeHtml(t("Execution chain", "执行链"))}</h2>
        <div>${badge(spawnedExecutionChainCount > 0 ? "info" : "idle", spawnedExecutionChainCount > 0 ? t("Active", "活跃") : t("Waiting", "等待中"))}</div>
      </div>
      <div class="meta">${escapeHtml(t("See whether the parent session accepted the work, whether it spawned an isolated session, and which child session is now running.", "直接看父会话是否接单、是否派发隔离会话，以及当前到底是哪条子会话在执行。"))}</div>
      <div class="meta">${escapeHtml(t("Isolated runs", "隔离执行"))} ${spawnedExecutionChainCount} · ${escapeHtml(t("Running now", "当前执行中"))} ${runningExecutionChainCount} · ${escapeHtml(t("Mapped tasks", "已关联任务"))} ${mappedExecutionChainCount}</div>
      ${taskExecutionChainHtml}
    </section>
  `;
  const teamMembersTableRows =
    teamSnapshot.members.length === 0
      ? `<tr><td colspan="5">${escapeHtml(t("No staff found.", "暂无员工。"))}</td></tr>`
      : teamSnapshot.members
          .map(
            (member) =>
              `<tr><td>${escapeHtml(member.displayName)}</td><td><code>${escapeHtml(member.agentId)}</code></td><td>${escapeHtml(member.model)}</td><td>${escapeHtml(member.toolsProfile)}</td><td>${escapeHtml(member.workspace)}</td></tr>`,
          )
          .join("");
  const teamSection = `
    <section class="card">
      <h2>${escapeHtml(t("Staff overview", "员工总览"))}</h2>
      <div class="meta">${escapeHtml(t("The default view shows only name, role, current status, current work, recent output, and whether each person is on the schedule.", "默认视图只显示员工名字、角色定位、当前状态、正在处理什么、最近产出，以及是否在排班里。"))}</div>
      ${staffOverviewCardsHtml}
    </section>
    <details class="card compact-details">
      <summary>${escapeHtml(t("Shared staff mission", "员工共同目标"))}</summary>
      <div class="fold-body">
        <div class="mission-banner">${escapeHtml(teamSnapshot.missionStatement)}</div>
        <div class="meta">${escapeHtml(t("Source", "来源"))}：${escapeHtml(teamSnapshot.sourcePath)}</div>
        <div class="meta">${escapeHtml(teamSnapshot.detail)}</div>
      </div>
    </details>
    <details class="card compact-details">
      <summary>${escapeHtml(t("Staff system details", "员工配置明细"))}</summary>
      <div class="fold-body">
        <table>
          <thead><tr><th>${escapeHtml(t("Name", "名称"))}</th><th>agentId</th><th>${escapeHtml(t("Model", "模型"))}</th><th>${escapeHtml(t("Tool profile", "工具权限"))}</th><th>${escapeHtml(t("Workspace", "工作目录"))}</th></tr></thead>
          <tbody>${teamMembersTableRows}</tbody>
        </table>
      </div>
    </details>
  `;
  const collaborationSection = `
    <section class="card" id="collaboration-hub">
      <div class="overview-command-head">
        <div>
          <h2>${escapeHtml(t("Team collaboration", "团队协作"))}</h2>
          <div class="meta">${escapeHtml(t("See both collaboration patterns in one place: parent-child relays and cross-session messages between existing agent sessions.", "把两种协作都放在同一页看清楚：父子会话接力，以及不同智能体既有会话之间的消息往返。"))}</div>
        </div>
        <div>${badge(collaborationBlockedCount > 0 ? "warn" : collaborationActiveCount > 0 ? "info" : "ok", collaborationBlockedCount > 0 ? t("Needs follow-up", "需跟进") : collaborationActiveCount > 0 ? t("Active", "进行中") : t("Steady", "平稳"))}</div>
      </div>
      <div class="status-strip collaboration-summary-grid">
        <div class="status-chip">
          <span>${escapeHtml(t("Active", "活跃协作"))}</span>
          <strong>${collaborationActiveCount}</strong>
        </div>
        <div class="status-chip">
          <span>${escapeHtml(t("Waiting handoff", "等待交接"))}</span>
          <strong>${collaborationHandoffCount}</strong>
        </div>
        <div class="status-chip">
          <span>${escapeHtml(t("Blocked", "卡住"))}</span>
          <strong>${collaborationBlockedCount}</strong>
        </div>
        <div class="status-chip">
          <span>${escapeHtml(t("Completed today", "今日完成"))}</span>
          <strong>${collaborationCompletedTodayCount}</strong>
        </div>
      </div>
      <div class="meta collaboration-headline">${escapeHtml(
        collaborationThreadVisibleCount > 0
          ? collaborationThreadTotalCount > collaborationThreadVisibleCount
            ? t(
                `${collaborationThreadTotalCount} collaboration threads are visible in total. Similar completed threads are folded into ${collaborationThreadVisibleCount} cards so this page stays readable.`,
                `当前共整理出 ${collaborationThreadTotalCount} 条协作线程，并把相近的已完成线程折叠为 ${collaborationThreadVisibleCount} 张卡片，方便直接看重点。`,
              )
            : t(
                `${collaborationThreadVisibleCount} visible collaboration threads. Open a thread to inspect parent-child relays or cross-session messages without leaving this page.`,
                `当前可见 ${collaborationThreadVisibleCount} 条协作线程。直接展开线程，就能在当前页查看父子接力或跨会话消息时间线。`,
              )
          : t(
              "No visible collaboration threads yet. They will appear once parent-child relays or cross-session messages become visible.",
              "当前还没有可见的协作线程。父子接力或跨会话通信出现后，这里就会开始显示。",
            ),
      )}</div>
    </section>
    <section class="card" id="collaboration-board" data-collab-root>
      <div class="overview-command-head">
        <h2>${escapeHtml(t("Collaboration threads", "协作线程"))}</h2>
        <div class="meta" data-collab-filter-state>${escapeHtml(t("Showing all visible threads", "当前显示全部可见线程"))}</div>
      </div>
      <div class="segment-switch collaboration-filter-bar" role="tablist" aria-label="${escapeHtml(t("Collaboration filters", "协作筛选"))}">
        <button class="segment-item active" type="button" data-collab-filter="all">${escapeHtml(t("All", "全部"))}</button>
        <button class="segment-item" type="button" data-collab-filter="active">${escapeHtml(t("In progress", "进行中"))}</button>
        <button class="segment-item" type="button" data-collab-filter="blocked">${escapeHtml(t("Blocked", "卡住"))}</button>
        <button class="segment-item" type="button" data-collab-filter="completed">${escapeHtml(t("Completed", "已完成"))}</button>
        <button class="segment-item" type="button" data-collab-filter="multi-agent">${escapeHtml(t("Multi-agent only", "只看多智能体"))}</button>
        <button class="segment-item" type="button" data-collab-filter="main-dispatched">${escapeHtml(t("Main dispatched", "只看 Main 派发"))}</button>
      </div>
      ${collaborationThreadHtml}
    </section>
  `;
  const memoryMainCount = memoryFiles.filter((entry) => entry.facetKey === "main").length;
  const memoryWorkbench = needsMemoryFiles
    ? await renderEditableFileWorkbench({
        scope: "memory",
        language: options.language,
        title: t("Memory file workbench", "记忆文件工作台"),
        description: t("Browse and edit OpenClaw memory files directly. Saving writes back to the source files.", "直接浏览和修改 OpenClaw 的记忆文件。保存后会写回原文件。"),
        entries: memoryFiles,
        emptyMessage: t("There are no editable memory files right now.", "当前没有可编辑的记忆文件。"),
        defaultFacetKey: "main",
        includeAllFacet: false,
        facetOptions: memoryFacetOptions,
      })
    : "";
  const memoryViewsLabel = joinDisplayList(["Main", ...memoryFacetOptions.filter((item) => item.key !== "main").map((item) => item.label)], options.language);
  const memorySection = `
    <section class="card">
      <h2>${escapeHtml(t("Memory overview", "记忆概览"))}</h2>
      <div class="meta">Main ${escapeHtml(t("memories", "记忆"))} ${memoryMainCount} ${escapeHtml(t("files", "份"))} · ${escapeHtml(t("Agents found", "已发现智能体"))} ${Math.max(0, memoryFacetOptions.filter((item) => item.key !== "main").length)} ${escapeHtml(t("items", "个"))}</div>
      <div class="meta">${escapeHtml(t("Available views", "可切换查看"))}${escapeHtml(options.language === "en" ? ": " : "：")}${escapeHtml(memoryViewsLabel)}</div>
      <div class="meta">${escapeHtml(t("Only memory-related files are kept here: root MEMORY.md, memory/, and each agent's own MEMORY.md and memory/.", "这里只保留记忆相关文件：根目录 MEMORY.md、memory/，以及各智能体自己的 MEMORY.md 与 memory/。"))}</div>
      <div class="meta">${escapeHtml(t("Edits here sync directly back to the real memory files on the OpenClaw machine.", "这里的编辑会直接同步到 OpenClaw 机器上的真实记忆文件。"))}</div>
    </section>
    ${memoryWorkbench}
    ${memoryStateSection}
  `;
  const mainDocumentCount = workspaceFiles.filter((entry) => entry.facetKey === "main").length;
  const workspaceWorkbench = needsWorkspaceFiles
    ? await renderEditableFileWorkbench({
        scope: "workspace",
        language: options.language,
        title: t("Document workbench", "文档工作台"),
        description: t("Keep only Main documents and each active agent's most useful core Markdown files. Saving writes back to the source files.", "只保留 Main 文档，以及当前启用智能体最有用、最应该调整的核心 Markdown。保存后会直接写回源文件。"),
        entries: workspaceFiles,
        emptyMessage: t("No editable Main documents or core agent documents were found.", "当前没有发现可编辑的 Main 文档或智能体核心文档。"),
        defaultFacetKey: "main",
        includeAllFacet: false,
        facetOptions: workspaceFacetOptions,
      })
    : "";
  const documentViewsLabel = joinDisplayList(["Main", ...workspaceFacetOptions.filter((item) => item.key !== "main").map((item) => item.label)], options.language);
  const docsSection = `
    <section class="card">
      <h2>${escapeHtml(t("Document overview", "文档概览"))}</h2>
      <div class="meta">${escapeHtml(t("Main documents", "Main 文档"))} ${mainDocumentCount} ${escapeHtml(t("files", "份"))} · ${escapeHtml(t("Agents found", "已发现智能体"))} ${Math.max(0, workspaceFacetOptions.filter((item) => item.key !== "main").length)} ${escapeHtml(t("items", "个"))}</div>
      <div class="meta">${escapeHtml(t("Available views", "可切换查看"))}${escapeHtml(options.language === "en" ? ": " : "：")}${escapeHtml(documentViewsLabel)}</div>
      <div class="meta">${escapeHtml(t("This keeps only Main documents plus the small set of Markdown files that matter most for each active agent.", "这里只保留 Main 文档，以及当前启用智能体最常用、最值得调整的那几份 Markdown。"))}</div>
      <div class="meta">${escapeHtml(t("Documents are no longer shown by chat history. They are archived by Main or by active agent.", "不再按会话历史展示文档，统一按 Main / 当前启用智能体归档。"))}</div>
    </section>
    ${workspaceWorkbench}
  `;
  const usageSection = `
    <section class="card">
      <h2>${escapeHtml(t("Measurement scope", "统计口径"))}</h2>
      ${usageViewSwitchHtml}
      <div class="meta">${usageViewRangeText}</div>
      <div class="meta">${usageViewRangeDetail}</div>
      <div class="meta">${escapeHtml(t("Today: from 00:00 until now. Cumulative: full history until now.", "今日：当日 00:00 至当前。累计：历史全量到当前。"))}</div>
    </section>
    <section class="card">
      <h2>${escapeHtml(isTodayUsageView ? t("Today's usage snapshot", "今日用量快照") : t("Cost trend", "费用趋势"))}</h2>
      <div class="meta">${isTodayUsageView ? escapeHtml(t("Range: today.", "统计范围：今日。")) : runtimeTokenRangeLabel}</div>
      ${
        hasUsageActivity
          ? usagePeriodCards
          : `<div class="empty-state">${escapeHtml(t("No usage data yet. It will be generated automatically after sessions start.", "暂无用量数据。开始会话后会自动生成。"))}</div>`
      }
    </section>
    <section class="card">
      <h2>${escapeHtml(t("Subscription windows", "订阅窗口"))}</h2>
      ${subscriptionStatusHtml}
    </section>
    <section class="card">
      <h2>${escapeHtml(t("AI usage mix (all sessions)", "AI 用量构成（全部会话）"))}</h2>
      <div class="meta">${escapeHtml(t("Timed jobs, Discord, Telegram, internal sessions", "定时任务、Discord、Telegram、内部会话"))}</div>
      ${usageSessionTypeShareHtml}
    </section>
    <section class="card">
      <h2>${escapeHtml(t("Timed-job usage share", "定时任务用量占比"))}</h2>
      <div class="meta">${cronTokenRangeLabel}</div>
      ${usageCronJobShareHtml}
      <details class="compact-table-details" style="margin-top:12px;">
        <summary>${escapeHtml(t("Agent share within timed jobs", "定时任务内各智能体占比"))}</summary>
        <div class="fold-body">${usageCronAgentShareHtml}</div>
      </details>
    </section>
    ${contextPressureCard}
    <details class="card compact-details">
      <summary>${escapeHtml(t("Advanced detail (attribution / model / context / budget)", "高级明细（归因/模型/上下文/预算）"))}</summary>
      <div class="fold-body">
        <h3 style="margin:0 0 6px 0;">${escapeHtml(t("Split by agent and task", "按智能体与任务拆分"))}</h3>
        ${usageAttributionHtml}
        <div style="height:10px;"></div>
        <h3 style="margin:0 0 6px 0;">${escapeHtml(t("Usage sources", "用量来源"))}</h3>
        ${usageSourceHtml}
        <div style="height:10px;"></div>
        <h3 style="margin:0 0 6px 0;">${escapeHtml(t("Task consumption", "任务消耗"))}</h3>
        ${usageTaskHtml}
        <div style="height:10px;"></div>
        <h3 style="margin:0 0 6px 0;">${escapeHtml(t("Models and providers", "模型与供应商"))}</h3>
        ${usageModelMixHtml}
        <div style="height:10px;"></div>
        <h3 style="margin:0 0 6px 0;">${escapeHtml(t("Session context", "会话上下文"))}</h3>
        ${usageContextHtml}
        <div style="height:10px;"></div>
        <h3 style="margin:0 0 6px 0;">${escapeHtml(t("Budget forecast", "预算预测"))}</h3>
        <div class="meta">${usageBudgetMeta}</div>
        <div class="meta">${usageBudgetHeadline}</div>
        <div class="meta">${escapeHtml(t("Daily burn", "日均消耗"))} ${
          usageCost.budget.burnRatePerDay !== undefined
            ? formatCurrency(usageCost.budget.burnRatePerDay)
            : t("Data source not connected", "数据源未连接")
        }</div>
        <div class="meta">${escapeHtml(t("Estimated days remaining", "预计剩余天数"))} ${
          usageCost.budget.projectedDaysToLimit !== undefined
            ? usageCost.budget.projectedDaysToLimit.toFixed(1)
            : t("Data source not connected", "数据源未连接")
        }</div>
      </div>
    </details>
  `;
  const officeSection = `
    <section class="card">
      <h2>看板映射说明</h2>
      <div class="meta">Alex / Sam / Taylor / Unassigned 这类名称只是 control-center 的分组标签，不是智能体，不会单独消耗预算。</div>
      <details class="compact-table-details" style="margin-top:8px;" open>
        <summary>查看映射标签（不执行任务）</summary>
        <div class="fold-body">
          <ul class="story-list">${taskRoleRows || "<li>当前没有映射标签。</li>"}</ul>
        </div>
      </details>
    </section>
    <details class="card compact-details" open>
      <summary>执行分区（工位）</summary>
      <div class="fold-body">${officeFloorHtml}</div>
    </details>
    <details class="card compact-details" open>
      <summary>最近会话（${sessionPreview.items.length}/${sessionPreview.total}）</summary>
      <div class="fold-body">
        ${
          sessionPreview.items.length === 0
            ? '<div class="empty-state">暂无会话数据。</div>'
            : `<div class="group-list"><details class="group-section" open><summary>最近活跃会话（${sessionPreview.items.length}）</summary><ul class="group-items">${sessionPreview.items
                .slice(0, 14)
                .map((item) => `<li class="group-item"><div class="group-item-head"><strong>${escapeHtml(item.label ?? item.sessionKey)}</strong>${badge(item.state, sessionStateLabel(item.state))}</div><div class="meta">智能体 ${escapeHtml(item.agentId ?? "-")} · 最近 ${escapeHtml(item.lastMessageAt ?? "-")}</div><div class="meta">最新事件 ${escapeHtml(item.latestKind ?? "message")} · 历史 ${item.historyCount}</div><div class="meta"><a href="${escapeHtml(buildSessionDetailHref(item.sessionKey, options.language))}">查看会话详情页</a></div></li>`)
                .join("")}</ul></details></div>`
        }
        <details class="compact-table-details" style="margin-top:12px;">
          <summary>查看原始表格</summary>
          <div class="fold-body">
            <table>
              <thead><tr><th>会话</th><th>状态</th><th>助手</th><th>最近活动</th></tr></thead>
              <tbody>${sessionRows}</tbody>
            </table>
          </div>
        </details>
      </div>
    </details>
  `;
  const teamUnifiedSection = teamSection;
  const hasTrackedTaskPanels = tasks.length > 0 || pendingDecisionCount > 0 || taskCertaintyCards.length > 0;
  const trackedTaskDetailsOpen = pendingDecisionCount > 0 || taskCertaintyCards.length > 0;
  const trackedTaskSummaryText = hasTrackedTaskPanels
    ? t(
        `Tracked tasks ${taskCertaintyCards.length} · Follow-up ${pendingDecisionCount}`,
        `跟踪任务 ${taskCertaintyCards.length} · 待处理 ${pendingDecisionCount}`,
      )
    : t("No tracked task rows yet", "还没有跟踪任务条目");
  const trackedTaskExplanation = hasTrackedTaskPanels
    ? t(
        "This lower-priority area is only for tracked task rows, decisions, and runtime evidence.",
        "这块低优先级区域只看可跟踪任务条目、待处理事项和运行证据。",
      )
    : liveSessionCount > 0
      ? t(
          "Staff status comes from live sessions. Cron jobs, heartbeat, and ad-hoc sessions can keep agents busy before anything becomes a tracked task row.",
          "员工状态来自实时会话。Cron、心跳和临时会话可能已经让智能体在工作，但还没有形成可跟踪的任务条目。",
        )
      : t(
          "There is no tracked task row visible right now. Start here only when you actually use the task store.",
          "当前还没有可见的跟踪任务条目。只有真正使用任务库时，这里才会出现内容。",
        );
  const trackedTaskDetailsBody = hasTrackedTaskPanels
    ? `
      <section class="task-hub-shell" id="task-hub">
        <article class="card task-hub-primary" id="task-hub-primary">
          <div class="overview-command-head">
            <div>
              <h2>${escapeHtml(t("Task hub", "任务中枢"))}</h2>
              <div class="meta">${escapeHtml(t("One place for tracked tasks, follow-up items, and runtime evidence.", "把可跟踪任务、待处理事项和运行证据放在一起。"))}</div>
            </div>
            <div>${overviewPrimaryStatus}</div>
          </div>
          ${taskHubStatCardsHtml}
          <div class="overview-task-strip">
            <div>
              <div class="meta">${escapeHtml(t("Current focus", "当前关注"))}</div>
              <div class="overview-task-metric">${badge(currentTaskHealth)} ${escapeHtml(t("Confirmed live", "已确认在跑"))} ${taskCertaintyStrongCount} · ${escapeHtml(t("Need follow-up", "需跟进"))} ${taskCertaintyFollowupCount} · ${escapeHtml(t("Needs inspection", "需排查"))} ${taskCertaintyWeakCount}</div>
              ${mappingTaskHint ? `<div class="meta">${escapeHtml(mappingTaskHint)}</div>` : ""}
            </div>
            <div class="overview-quick-links">
              <a class="btn" href="${escapeHtml(currentTaskHealthHref)}">${escapeHtml(t("Open tracked tasks", "查看跟踪任务"))}</a>
              <a class="btn" href="${escapeHtml(focusHref)}">${escapeHtml(t("Open follow-up items", "查看待处理"))}</a>
            </div>
          </div>
        </article>
        <article class="card" id="task-decision-center">
          <div class="overview-command-head">
            <h2>${escapeHtml(t("Waiting for your decision", "等待你决策"))}</h2>
            <div>${badge(pendingDecisionCount > 0 ? "warn" : "ok", pendingDecisionCount > 0 ? t("Queue active", "队列活跃") : t("Clear", "已清空"))}</div>
          </div>
          <div class="meta">${escapeHtml(t("Pending decisions", "待处理事项"))} ${pendingDecisionCount} · ${escapeHtml(t("Approvals", "审批"))} ${pendingApprovalsCount} · ${escapeHtml(t("Unacked alerts", "未确认告警"))} ${actionQueue.counts.unacked}</div>
          ${taskDecisionPreviewHtml}
        </article>
      </section>
      ${taskExecutionChainSection}
      <section class="task-hub-grid task-hub-board-grid">
        <section class="card" id="task-lane">
          <h2>${escapeHtml(t("Task lanes", "任务泳道"))}</h2>
          <div class="meta">${escapeHtml(t("Current focus", "当前关注"))}：${escapeHtml(quickFilterLabel(effectiveQuick, options.language))}</div>
          ${
            controlCenterMappingTasks.length > 0
              ? `<div class="meta">${escapeHtml(t(`${controlCenterMappingTasks.length} board-only mapping examples are hidden because they are not real execution tasks.`, `已隐藏 ${controlCenterMappingTasks.length} 个看板映射样例（非真实执行任务）。`))}</div>`
              : ""
          }
          <div class="quick-filters">${quickFilters}</div>
          <form method="GET" action="/" class="filters">
            <input type="hidden" name="section" value="${escapeHtml(options.section)}" />
            <input type="hidden" name="lang" value="${escapeHtml(options.language)}" />
            <input type="hidden" name="quick" value="${escapeHtml(effectiveQuick)}" />
            <input type="hidden" name="compact" value="${options.compactStatusStrip ? "1" : "0"}" />
            <input type="hidden" name="usage_view" value="${options.usageView === "today" ? "today" : "cumulative"}" />
            <div>
              <label for="status">${escapeHtml(t("Status", "状态"))}</label>
              <select id="status" name="status">
                ${renderSelectOptions(
                  [{ value: "", label: t("All", "全部") }, ...TASK_STATES.map((state) => ({ value: state, label: taskStateLabel(state, options.language) }))],
                  filters.status ?? "",
                )}
              </select>
            </div>
            <div>
              <label for="owner">${escapeHtml(t("Agent", "智能体"))}</label>
              <select id="owner" name="owner">
                ${renderSelectOptions(
                  [{ value: "", label: t("All", "全部") }, ...ownerOptions.map((owner) => ({ value: owner, label: owner }))],
                  filters.owner ?? "",
                )}
              </select>
            </div>
            <div>
              <label for="project">${escapeHtml(t("Project", "项目"))}</label>
              <select id="project" name="project">
                ${renderSelectOptions(
                  [{ value: "", label: t("All", "全部") }, ...projectOptions.map((project) => ({ value: project, label: project }))],
                  filters.project ?? "",
                )}
              </select>
            </div>
            <div class="filter-actions">
              <button class="btn" type="submit">${escapeHtml(t("Apply", "应用"))}</button>
              <a href="${escapeHtml(clearHref)}">${escapeHtml(t("Clear filters", "清空筛选"))}</a>
            </div>
          </form>
          ${taskBoard}
          <div style="height:10px;"></div>
          <h3 style="margin:0 0 6px 0;">${escapeHtml(t("Task groups (native view)", "任务分组列表（原生视图）"))}</h3>
          ${taskGroupedListHtml}
          ${
            controlCenterMappingTasks.length === 0
              ? ""
              : `<details class="compact-table-details" style="margin-top:12px;" open>
                   <summary>${escapeHtml(t("Open board mapping examples (non-executing)", "查看看板映射样例（不执行任务）"))}</summary>
                   <div class="fold-body">
                     <table>
                       <thead><tr><th>${escapeHtml(t("Example task", "样例任务"))}</th><th>${escapeHtml(t("Label", "标签"))}</th><th>${escapeHtml(t("Status", "状态"))}</th></tr></thead>
                       <tbody>${mappingTaskRows}</tbody>
                     </table>
                   </div>
                 </details>`
          }
        </section>
        <div class="task-hub-sidebar">
          <section class="card" id="project-lane">
            <h2>${escapeHtml(t("Project lanes", "项目泳道"))}</h2>
            ${projectBoard}
          </section>
          <section class="card" id="task-live-feed">
            <h2>${escapeHtml(t("Live activity feed", "实时活动流"))}</h2>
            <div class="meta">${escapeHtml(t("Use this to confirm what OpenClaw and its sub-agents are doing right now.", "用于确认 OpenClaw 与子智能体当前正在执行什么。"))}</div>
            <ul class="story-list">${replayMomentsRows}</ul>
          </section>
        </div>
      </section>
      <details class="card compact-details" id="task-table">
        <summary>${escapeHtml(t(`Task table (raw detail, ${tasks.length}/${allTasks.length})`, `任务表格（原始明细，${tasks.length}/${allTasks.length}）`))}</summary>
        <div class="fold-body">
          <table>
            <thead><tr><th>${escapeHtml(t("Project", "项目"))}</th><th>${escapeHtml(t("Task", "任务"))}</th><th>${escapeHtml(t("Title", "标题"))}</th><th>${escapeHtml(t("Status", "状态"))}</th><th>${escapeHtml(t("Agent", "智能体"))}</th><th>${escapeHtml(t("Due", "截止"))}</th><th>${escapeHtml(t("Updated", "更新时间"))}</th></tr></thead>
            <tbody>${taskRows}</tbody>
          </table>
        </div>
      </details>
    `
    : `<div class="meta">${escapeHtml(trackedTaskExplanation)}</div>`;
  const projectsSection = `
    <section class="task-hub-grid">
      ${calendarSection}
      ${cronExecutionSection}
    </section>
    <details class="card compact-details" id="tracked-task-view"${trackedTaskDetailsOpen ? " open" : ""}>
      <summary>${escapeHtml(t("Tracked tasks and follow-up", "跟踪任务与跟进"))}</summary>
      <div class="fold-body">
        <div class="meta">${escapeHtml(trackedTaskSummaryText)}</div>
        <div class="meta">${escapeHtml(trackedTaskExplanation)}</div>
        ${trackedTaskDetailsBody}
      </div>
    </details>
  `;
  const alertsSection = `
    <section class="card">
      <h2>${escapeHtml(t("Attention items", "关注事项"))}</h2>
      <div class="meta">${escapeHtml(t("Blocked", "阻塞"))} ${exceptions.counts.blocked} · ${escapeHtml(t("Errors", "异常"))} ${exceptions.counts.errors} · ${escapeHtml(t("Pending approvals", "待审批"))} ${exceptions.counts.pendingApprovals} · ${escapeHtml(t("Stalled runs", "停滞执行"))} ${stalledRunningSessionCount}</div>
      <ul class="story-list">${exceptionsItems}</ul>
    </section>
    <section class="card">
      <h2>${escapeHtml(t("Needs your decision", "需要你决策"))}</h2>
      <div class="meta">${escapeHtml(t("Unacked", "待处理"))} ${actionQueue.counts.unacked} · ${escapeHtml(t("Acked", "已确认"))} ${actionQueue.counts.acked}</div>
      ${
        actionQueue.counts.total === 0
          ? `<div class="empty-state">${escapeHtml(t("There is nothing waiting for a decision right now.", "当前没有待决策事项。"))}</div>`
          : actionQueueItems
      }
    </section>
    <details class="card compact-details">
      <summary>${escapeHtml(t("Approval requests", "审批请求"))}</summary>
      <div class="fold-body">${
        topApprovals.length === 0
          ? `<div class="empty-state">${escapeHtml(t("No approval requests yet.", "暂无审批请求。"))}</div>`
          : `<div class="meta">${escapeHtml(approvalsPreviewMeta)}</div><ul class="story-list">${approvalsItems}</ul>`
      }</div>
    </details>
    <details class="card compact-details">
      <summary>${escapeHtml(t("Budget watch", "预算监控"))}</summary>
      <div class="fold-body">${
        nonOkBudgets.length === 0
          ? `<div class="empty-state">${escapeHtml(t("Budget status looks healthy right now.", "预算状态健康，当前无预警。"))}</div>`
          : `<table><thead><tr><th>${escapeHtml(t("Status", "状态"))}</th><th>${escapeHtml(t("Scope", "范围"))}</th><th>${escapeHtml(t("Target", "对象"))}</th><th>${escapeHtml(t("Usage", "使用情况"))}</th></tr></thead><tbody>${budgetItems}</tbody></table>`
      }</div>
    </details>
  `;
  const replaySection = `
    <section class="card">
      <h2>${escapeHtml(t("Replay activity", "活动回放"))}</h2>
      ${
        replaySignals.length === 0
          ? `<div class="empty-state">${escapeHtml(t("No replay data yet. It will appear after the monitor has been running.", "暂无回放数据。监控运行后会出现。"))}</div>`
          : `<div class="status-strip">${replaySignals
              .map((item) => `<div class="status-chip"><span>${escapeHtml(item.label)}</span><strong>${item.value}</strong></div>`)
              .join("")}</div>`
      }
      <div class="meta">${escapeHtml(t("Latest snapshot", "最新快照"))}：${escapeHtml(replayLatestSnapshot?.fileName ?? t("Not available", "暂无"))}</div>
      <div class="meta">${escapeHtml(t("Latest backup", "最新备份"))}：${escapeHtml(replayLatestBundle?.fileName ?? t("Not available", "暂无"))}</div>
      <div class="meta"><a href="/audit">${escapeHtml(t("Open audit timeline", "查看活动时间线"))}</a> · <a href="/export/state.json">${escapeHtml(t("Create backup snapshot", "创建备份快照"))}</a></div>
    </section>
    <details class="card compact-details">
      <summary>${escapeHtml(t("Replay metrics", "回放详细指标"))}</summary>
      <div class="fold-body">${replayMetricsHtml}</div>
    </details>
    <details class="card compact-details">
      <summary>${escapeHtml(t("Recent timeline", "最近时间线"))}</summary>
      <div class="fold-body"><ul class="story-list">${replayMomentsRows}</ul></div>
    </details>
  `;
  const settingsSection = `
    ${connectionHealthCard}
    ${securityRiskSection}
    ${updateStatusSection}
    <section class="card">
      <h2>安全开关</h2>
      <table>
        <thead><tr><th>项目</th><th>状态</th><th>当前值</th><th>说明</th></tr></thead>
        <tbody>${importGuardRows}</tbody>
      </table>
    </section>
    <section class="card" id="tool-connectors">
      <h2>${escapeHtml(t("Recommended data connections", "数据接入建议"))}</h2>
      <ul class="story-list">${usageConnectorTodos}</ul>
    </section>
    <section class="card">
      <h2>${escapeHtml(t("Panel preferences", "面板偏好"))}</h2>
      <div class="toolbar">
        <a class="btn" href="${escapeHtml(buildHomeHref(filters, !options.compactStatusStrip, options.section, options.language, options.usageView))}">${escapeHtml(t("Density", "信息密度"))}：${escapeHtml(options.compactStatusStrip ? t("Compact", "紧凑") : t("Expanded", "展开"))}</a>
        <a class="btn" href="${escapeHtml(clearHref)}">${escapeHtml(t("Reset filters", "重置筛选"))}</a>
      </div>
    </section>
  `;
  let sectionBody = overviewSection;
  if (options.section === "calendar") sectionBody = projectsSection;
  if (options.section === "team") sectionBody = teamUnifiedSection;
  if (options.section === "collaboration") sectionBody = collaborationSection;
  if (options.section === "memory") sectionBody = memorySection;
  if (options.section === "docs") sectionBody = docsSection;
  if (options.section === "usage-cost") sectionBody = usageSection;
  if (options.section === "office-space") sectionBody = teamUnifiedSection;
  if (options.section === "projects-tasks") sectionBody = projectsSection;
  if (options.section === "alerts") sectionBody = alertsSection;
  if (options.section === "replay-audit") sectionBody = replaySection;
  if (options.section === "settings") sectionBody = settingsSection;
  const globalVisibilityCard = renderGlobalVisibilityCard(globalVisibilityModel, options.language);
  const globalVisibilityBlock = options.section === "overview" ? globalVisibilityCard : "";
  const globalVisibilityQuickRows = [
    {
      label: pickUiText(options.language, "Timed jobs", "定时任务"),
      count: globalVisibilityModel.signalCounts.schedule,
      href: buildGlobalVisibilityDetailHref("cron", options.language),
    },
    {
      label: pickUiText(options.language, "Heartbeat", "任务心跳"),
      count: globalVisibilityModel.signalCounts.heartbeat,
      href: buildGlobalVisibilityDetailHref("heartbeat", options.language),
    },
    {
      label: pickUiText(options.language, "Current tasks", "当前任务"),
      count: globalVisibilityModel.signalCounts.currentTasks,
      href: buildGlobalVisibilityDetailHref("current_task", options.language),
    },
    {
      label: pickUiText(options.language, "Tool calls", "工具调用"),
      count: globalVisibilityModel.signalCounts.toolCalls,
      href: buildGlobalVisibilityDetailHref("tool_call", options.language),
    },
  ]
    .map((item) => `<div class="meta"><a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>：${item.count}</div>`)
    .join("");
  const sidebarSignalRows =
    options.section === "overview"
      ? globalVisibilityQuickRows
      : `<div class="meta"><a href="${escapeHtml(buildHomeHref({ quick: "all" }, true, "overview", options.language, options.usageView))}">${escapeHtml(t("See four signals in overview", "在总览查看四项信号"))}</a></div>`;
  const fileWorkbenchScript = renderFileWorkbenchScript();
  const agentVisualEnhancerScript = renderAgentVisualEnhancerScript();
  const nativeMotionScript = renderNativeMotionScript(options.language);
  const collaborationFilterScript = renderCollaborationFilterScript(options.language);
  const quotaResetScript = renderQuotaResetScript();
  const renderTotalMs = Math.round(performance.now() - renderStartedAt);
  if (renderTotalMs >= 1000) {
    console.warn("[mission-control] slow html render", {
      section: activeSection,
      totalMs: renderTotalMs,
      phases: renderPhases.join(" | "),
    });
  }

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>OpenClaw Control Center</title>
  <style>
    :root {
      --bg: #eef2f6;
      --panel: #ffffff;
      --panel-soft: #fbfbfd;
      --surface-1: rgba(255, 255, 255, 0.98);
      --surface-2: rgba(252, 253, 255, 0.94);
      --surface-3: rgba(246, 249, 253, 0.92);
      --glass-1: rgba(255, 255, 255, 0.78);
      --glass-2: rgba(248, 250, 255, 0.74);
      --border: rgba(17, 24, 39, 0.09);
      --border-soft: rgba(17, 24, 39, 0.06);
      --border-strong: rgba(17, 24, 39, 0.14);
      --text: #1d1d1f;
      --muted: #6e6e73;
      --ok: #248a3d;
      --warn: #b57f10;
      --over: #d23f31;
      --todo: #6e6e73;
      --progress: #0071e3;
      --blocked: #b05c12;
      --done: #248a3d;
      --focus: #0071e3;
      --apple-glass-blur: 22px;
      --shadow-soft: 0 8px 24px rgba(15, 23, 42, 0.06);
      --shadow-hard: 0 22px 56px rgba(15, 23, 42, 0.1);
      --shadow-float: 0 18px 44px rgba(15, 23, 42, 0.09);
      --shadow-press: 0 10px 24px rgba(15, 23, 42, 0.08);
      --card-fill:
        linear-gradient(180deg, rgba(255, 255, 255, 0.99), rgba(250, 251, 253, 0.975) 56%, rgba(244, 247, 251, 0.95)),
        radial-gradient(circle at 100% 0%, rgba(210, 223, 242, 0.18), transparent 54%);
      --card-fill-soft:
        linear-gradient(180deg, rgba(255, 255, 255, 0.975), rgba(248, 250, 253, 0.955) 58%, rgba(242, 246, 250, 0.93)),
        radial-gradient(circle at 100% 0%, rgba(219, 228, 242, 0.12), transparent 52%);
      --card-border: rgba(15, 23, 42, 0.07);
      --card-border-strong: rgba(15, 23, 42, 0.11);
      --card-shadow-soft: 0 14px 30px rgba(15, 23, 42, 0.05), 0 2px 8px rgba(15, 23, 42, 0.03);
      --card-shadow: 0 20px 42px rgba(15, 23, 42, 0.065), 0 3px 10px rgba(15, 23, 42, 0.035);
      --card-shadow-hover: 0 28px 52px rgba(15, 23, 42, 0.085), 0 4px 14px rgba(15, 23, 42, 0.04);
      --ring-soft: 0 0 0 4px rgba(0, 113, 227, 0.1);
      --radius-lg: 26px;
      --radius-md: 18px;
      --radius-sm: 12px;
      --font-large-title: 40px;
      --font-title-1: 28px;
      --font-title-2: 22px;
      --font-body: 15px;
      --font-caption: 12px;
      --space-1: 8px;
      --space-2: 16px;
      --space-3: 24px;
      --space-4: 32px;
    }
    * { box-sizing: border-box; }
    body {
      font-family: "SF Pro Display", "SF Pro Text", -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", "Helvetica Neue", sans-serif;
      color: var(--text);
      font-size: var(--font-body);
      line-height: 1.58;
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at 8% -10%, rgba(164, 192, 230, 0.22), transparent 34%),
        radial-gradient(circle at 96% 0%, rgba(218, 226, 240, 0.18), transparent 32%),
        linear-gradient(180deg, #f3f5f8 0%, #e9edf3 46%, #e5eaf0 100%);
      position: relative;
      text-rendering: optimizeLegibility;
      -webkit-font-smoothing: antialiased;
    }
    .ui-preload .app-shell { opacity: 1; transform: translateY(0); }
    body.ui-ready .app-shell { opacity: 1; transform: translateY(0); transition: opacity 260ms ease, transform 320ms ease; }
    body.page-leave .app-shell { opacity: 0; transform: translateY(10px) scale(0.996); transition: opacity 140ms ease, transform 150ms ease; }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.72), rgba(255, 255, 255, 0.16) 42%, transparent 60%),
        radial-gradient(circle at 50% -18%, rgba(255, 255, 255, 0.54), transparent 46%);
      pointer-events: none;
      z-index: -1;
    }
    button,
    input,
    select,
    textarea {
      font: inherit;
    }
    button {
      -webkit-appearance: none;
      appearance: none;
    }
    h1, h2, h3 { margin: 0; line-height: 1.24; letter-spacing: -0.012em; }
    a {
      color: #0071e3;
      text-decoration-thickness: 1.5px;
      text-underline-offset: 2px;
    }
    a:focus-visible {
      outline: none;
      border-radius: 10px;
      box-shadow: var(--ring-soft);
    }
    .app-shell {
      display: grid;
      grid-template-columns: 232px minmax(0, 1fr) 300px;
      gap: var(--space-2);
      padding: var(--space-3);
      max-width: 1880px;
      margin: 0 auto;
    }
    body.inspector-collapsed .app-shell {
      grid-template-columns: 232px minmax(0, 1fr);
    }
    body.inspector-collapsed .inspector-sidebar {
      display: none;
    }
    .sidebar {
      border: 1px solid rgba(255, 255, 255, 0.84);
      background:
        linear-gradient(180deg, var(--glass-1), var(--glass-2)),
        radial-gradient(circle at 100% 0%, rgba(214, 228, 255, 0.2), transparent 48%);
      border-radius: var(--radius-lg);
      padding: 18px;
      box-shadow: 0 24px 48px rgba(15, 23, 42, 0.1);
      backdrop-filter: blur(var(--apple-glass-blur));
      -webkit-backdrop-filter: blur(var(--apple-glass-blur));
      animation: panel-in 320ms ease both;
    }
    .brand {
      position: relative;
      overflow: hidden;
      border: 1px solid rgba(15, 23, 42, 0.05);
      border-radius: var(--radius-md);
      padding: 16px;
      background:
        linear-gradient(135deg, rgba(232, 239, 255, 0.66), rgba(255, 255, 255, 0.92)),
        radial-gradient(circle at 82% 14%, rgba(255, 255, 255, 0.8), transparent 56%);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.72);
    }
    .brand-kicker {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid rgba(0, 113, 227, 0.26);
      border-radius: 999px;
      padding: 3px 9px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      color: #0060c5;
      background: rgba(255, 255, 255, 0.84);
      text-transform: uppercase;
    }
    .brand h1 { font-size: 23px; font-weight: 760; margin-top: 9px; }
    .brand .meta { margin-top: 6px; }
    .meta { color: var(--muted); font-size: 13px; line-height: 1.62; }
    .meta-inline { color: var(--muted); font-size: 12px; margin-left: 6px; }
    .nav-links { margin-top: 14px; display: grid; gap: 9px; }
    .nav-link {
      display: block;
      border: 1px solid rgba(17, 24, 39, 0.06);
      border-radius: 16px;
      text-decoration: none;
      color: var(--text);
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.74), rgba(251, 253, 255, 0.78));
      padding: 12px 13px;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.76);
      transition: transform 180ms ease, box-shadow 180ms ease, border-color 180ms ease, background 180ms ease;
    }
    .nav-link:hover {
      transform: translateY(-1px);
      box-shadow: 0 14px 30px rgba(15, 23, 42, 0.08);
      border-color: rgba(17, 24, 39, 0.1);
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.94), rgba(251, 253, 255, 0.98));
    }
    .nav-link span { display: block; font-size: 15px; font-weight: 640; color: #1d1d1f; }
    .nav-link small { display: block; font-size: 12px; color: var(--muted); margin-top: 4px; line-height: 1.45; }
    .nav-link.active {
      border-color: rgba(0, 113, 227, 0.2);
      background:
        linear-gradient(180deg, rgba(234, 244, 255, 0.92), rgba(249, 252, 255, 0.98)),
        radial-gradient(circle at 0% 0%, rgba(0, 113, 227, 0.08), transparent 38%);
      box-shadow:
        inset 0 0 0 1px rgba(255, 255, 255, 0.82),
        0 10px 24px rgba(0, 113, 227, 0.08);
    }
    .panel {
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 24px;
      background:
        linear-gradient(180deg, rgba(251, 253, 255, 0.88), rgba(244, 247, 251, 0.8)),
        radial-gradient(circle at 100% 0%, rgba(214, 225, 243, 0.14), transparent 46%);
      box-shadow: 0 28px 60px rgba(15, 23, 42, 0.09);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      animation: panel-in 350ms ease both;
    }
    .section-title { font-size: var(--font-large-title); font-weight: 760; letter-spacing: -0.03em; line-height: 1.05; }
    .section-blurb { margin-top: 4px; font-size: var(--font-body); color: #6e6e73; }
    .section-hero-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: var(--space-2);
    }
    .section-head-copy { min-width: 0; }
    .section-head-actions { display: flex; align-items: center; gap: var(--space-1); }
    .panel-toggle {
      border: 1px solid rgba(17, 24, 39, 0.09);
      border-radius: 999px;
      padding: 7px 13px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(248, 251, 255, 0.92));
      color: #334155;
      font-size: var(--font-caption);
      font-weight: 620;
      cursor: pointer;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.86);
      transition: transform 180ms ease, border-color 180ms ease, box-shadow 180ms ease, color 180ms ease, background 180ms ease;
    }
    .panel-toggle:hover {
      transform: translateY(-1px);
      border-color: rgba(0, 113, 227, 0.24);
      color: #005bb8;
      background: linear-gradient(180deg, rgba(241, 248, 255, 0.98), rgba(250, 253, 255, 0.96));
      box-shadow: 0 10px 24px rgba(0, 113, 227, 0.08);
    }
    .content-stack { margin-top: var(--space-2); display: grid; gap: var(--space-2); }
    .content-stack > #overview-decision-home { order: 1; }
    .content-stack > #overview-primary-section { order: 2; }
    .content-stack > #overview-secondary-shell { order: 3; }
    .content-stack > #global-visibility-card { order: 4; }
    .executive-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(165px, 1fr)); gap: 12px; }
    .overview-v3-shell {
      display: grid;
      grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
      gap: var(--space-2);
      align-items: stretch;
    }
    .overview-primary-card {
      position: relative;
      overflow: hidden;
      background:
        linear-gradient(150deg, rgba(232, 242, 255, 0.94), rgba(255, 255, 255, 0.98)),
        radial-gradient(circle at 88% 18%, rgba(167, 196, 234, 0.22), transparent 52%);
      border-color: rgba(0, 113, 227, 0.24);
      box-shadow: 0 18px 34px rgba(30, 72, 118, 0.12);
    }
    .overview-primary-card::after {
      content: "";
      position: absolute;
      right: -28px;
      top: -34px;
      width: 180px;
      height: 180px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(0, 113, 227, 0.15), transparent 66%);
      pointer-events: none;
    }
    .overview-primary-head {
      display: flex;
      justify-content: space-between;
      gap: var(--space-2);
      align-items: flex-start;
    }
    .overview-primary-core { margin-top: 14px; }
    .overview-primary-value {
      font-size: 42px;
      letter-spacing: -0.04em;
      font-weight: 760;
      color: #102a43;
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }
    .overview-primary-label {
      margin-top: 4px;
      font-size: var(--font-caption);
      color: #516174;
      letter-spacing: 0.02em;
    }
    .overview-focus-stage {
      margin-top: var(--space-2);
      display: grid;
      grid-template-columns: 138px minmax(0, 1fr);
      align-items: center;
      gap: 12px;
      border: 1px solid rgba(16, 42, 67, 0.1);
      border-radius: 16px;
      padding: 12px;
      background: rgba(255, 255, 255, 0.88);
    }
    .overview-focus-ring {
      width: 118px;
      height: 118px;
      border-radius: 50%;
      background: conic-gradient(var(--focus-tone) calc(var(--focus-score) * 1%), rgba(191, 203, 219, 0.36) 0);
      display: grid;
      place-items: center;
      border: 1px solid rgba(16, 42, 67, 0.14);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.66);
    }
    .overview-focus-core {
      width: 82px;
      height: 82px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.97);
      border: 1px solid rgba(16, 42, 67, 0.12);
      display: grid;
      grid-template-rows: auto auto;
      justify-items: center;
      align-content: center;
      gap: 3px;
      padding: 8px 6px;
      box-sizing: border-box;
    }
    .overview-focus-score {
      font-size: 28px;
      font-weight: 760;
      letter-spacing: -0.03em;
      color: #1c2836;
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }
    .overview-focus-unit {
      font-size: 10px;
      color: #6f7985;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-weight: 620;
      line-height: 1.15;
      text-align: center;
      max-width: 56px;
      text-wrap: balance;
    }
    .overview-focus-copy {
      min-width: 0;
      display: grid;
      gap: 4px;
    }
    .overview-focus-headline {
      font-size: 22px;
      line-height: 1.12;
      letter-spacing: -0.02em;
      color: #0f2840;
      font-weight: 740;
    }
    .overview-focus-sub {
      font-size: 13px;
      color: #4f5f71;
      line-height: 1.45;
    }
    .overview-focus-meta {
      font-size: 12px;
      color: #6a7787;
      line-height: 1.45;
    }
    .overview-primary-directive {
      margin-top: 10px;
      border-radius: 999px;
      border: 1px solid rgba(0, 113, 227, 0.2);
      background: rgba(255, 255, 255, 0.88);
      color: #0e5ba6;
      padding: 5px 10px;
      width: fit-content;
      font-size: 12px;
      font-weight: 620;
      letter-spacing: 0.01em;
    }
    .overview-primary-card .overview-quick-links {
      margin-top: var(--space-2);
      justify-content: flex-start;
      min-width: 0;
    }
    .overview-kpi-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-2);
    }
    .overview-decision-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-2);
      align-items: start;
    }
    .overview-kpi-card {
      border: 1px solid var(--card-border);
      border-radius: 20px;
      padding: var(--space-2);
      background: var(--card-fill-soft);
      box-shadow: var(--card-shadow-soft);
      position: relative;
      overflow: hidden;
    }
    .overview-kpi-card::before {
      content: "";
      position: absolute;
      inset: 0 0 auto 0;
      height: 3px;
      background: linear-gradient(90deg, rgba(0, 113, 227, 0.74), rgba(91, 183, 255, 0.72));
    }
    .overview-kpi-card.tone-warn {
      border-color: rgba(181, 127, 16, 0.3);
      background: linear-gradient(180deg, rgba(255, 251, 243, 0.98), rgba(255, 255, 255, 0.96));
    }
    .overview-kpi-card.tone-warn::before {
      background: linear-gradient(90deg, rgba(194, 136, 25, 0.84), rgba(230, 179, 76, 0.7));
    }
    .overview-kpi-card.tone-neutral {
      border-color: rgba(107, 114, 128, 0.24);
      background: linear-gradient(180deg, rgba(248, 249, 252, 0.98), rgba(255, 255, 255, 0.96));
    }
    .overview-kpi-card.tone-neutral::before {
      background: linear-gradient(90deg, rgba(110, 117, 125, 0.66), rgba(177, 182, 189, 0.62));
    }
    .overview-kpi-label {
      font-size: var(--font-caption);
      color: #6b7280;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-weight: 620;
    }
    .overview-kpi-value {
      margin-top: 8px;
      font-size: 42px;
      line-height: 1;
      letter-spacing: -0.03em;
      color: #111827;
      font-weight: 740;
      font-variant-numeric: tabular-nums;
    }
    .overview-kpi-detail {
      margin-top: 8px;
      color: #6b7280;
      font-size: var(--font-caption);
      line-height: 1.45;
    }
    .overview-secondary-shell > .fold-body {
      margin-top: var(--space-2);
      display: grid;
      gap: var(--space-2);
    }
    .overview-hero-strip {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 10px;
    }
    .overview-hero-card {
      border: 1px solid var(--card-border);
      border-radius: 18px;
      padding: 13px 13px 11px;
      background: var(--card-fill-soft);
      box-shadow: var(--card-shadow-soft);
    }
    .overview-hero-card .label {
      font-size: 11px;
      color: #6f7379;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      font-weight: 620;
    }
    .overview-hero-card .value {
      margin-top: 6px;
      font-size: 29px;
      line-height: 1.02;
      letter-spacing: -0.024em;
      color: #1d1d1f;
      font-weight: 740;
    }
    .overview-hero-card .hint {
      margin-top: 4px;
      font-size: 12px;
      color: #6e6e73;
      line-height: 1.45;
    }
    .overview-main-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.7fr) minmax(320px, 1fr);
      gap: 14px;
      align-items: start;
    }
    .overview-main-grid > .card { align-self: start; }
    .overview-main-grid .overview-span { grid-column: 1 / -1; }
    .exec-card {
      border: 1px solid var(--card-border);
      border-radius: 16px;
      background: var(--card-fill-soft);
      padding: 15px 15px 13px;
      box-shadow: var(--card-shadow-soft);
    }
    .exec-title { font-size: 11px; color: #6a6d72; letter-spacing: 0.045em; text-transform: uppercase; font-weight: 620; }
    .exec-metric { margin-top: 7px; font-size: 30px; font-weight: 740; color: #1d1d1f; letter-spacing: -0.024em; line-height: 1.04; }
    #current-task-health {
      background:
        linear-gradient(155deg, rgba(234, 244, 255, 0.92), rgba(255, 255, 255, 0.98)),
        radial-gradient(circle at 88% 12%, rgba(197, 221, 250, 0.24), transparent 50%);
      border-color: rgba(0, 113, 227, 0.22);
      box-shadow: 0 14px 30px rgba(14, 63, 126, 0.1);
      overflow: hidden;
    }
    .overview-command-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
    }
    .overview-action-grid {
      margin-top: 2px;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .overview-action-item {
      display: block;
      border: 1px solid var(--card-border);
      border-radius: 14px;
      background: var(--card-fill-soft);
      padding: 11px;
      min-height: 92px;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.92);
      color: inherit;
      text-decoration: none;
    }
    .overview-action-item.hot {
      border-color: rgba(181, 120, 16, 0.38);
      background: linear-gradient(180deg, rgba(255, 248, 233, 0.98), rgba(255, 255, 255, 0.95));
    }
    .overview-action-item:hover {
      transform: translateY(-1px);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.92),
        0 14px 28px rgba(17, 24, 39, 0.08);
    }
    .overview-action-item span {
      display: block;
      font-size: 12px;
      color: #6b6f76;
      letter-spacing: 0.01em;
    }
    .overview-action-item strong {
      display: block;
      margin-top: 6px;
      font-size: 30px;
      line-height: 1;
      letter-spacing: -0.025em;
      color: #1d1d1f;
    }
    .overview-action-item small {
      display: block;
      margin-top: 6px;
      font-size: 12px;
      color: #6b6f76;
      line-height: 1.45;
    }
    .overview-task-strip {
      margin-top: 12px;
      border: 1px solid rgba(17, 24, 39, 0.09);
      border-radius: 14px;
      padding: 12px;
      background: rgba(255, 255, 255, 0.95);
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
    }
    .overview-task-metric {
      margin-top: 5px;
      font-size: 15px;
      color: #2a2a2d;
      line-height: 1.45;
    }
    .decision-list {
      display: grid;
      gap: 10px;
    }
    .decision-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 12px 13px;
      background: var(--card-fill-soft);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.86),
        0 10px 20px rgba(15, 23, 42, 0.035);
      color: inherit;
      text-decoration: none;
    }
    .decision-row:hover {
      transform: translateY(-1px);
      border-color: rgba(17, 24, 39, 0.1);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.88),
        0 12px 26px rgba(17, 24, 39, 0.06);
    }
    .decision-row-copy {
      min-width: 0;
      display: grid;
      gap: 3px;
    }
    .decision-row-copy strong {
      font-size: 14px;
      color: #1d1d1f;
      line-height: 1.4;
    }
    .decision-row-value,
    .decision-row-link {
      font-size: 12px;
      color: #0b6db3;
      font-weight: 650;
      white-space: nowrap;
      align-self: center;
    }
    .overview-busy-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .overview-busy-card {
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 12px;
      background: var(--card-fill-soft);
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.86),
        0 10px 20px rgba(15, 23, 42, 0.03);
      display: grid;
      gap: 6px;
    }
    .overview-busy-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: baseline;
    }
    .overview-busy-head strong {
      font-size: 14px;
      color: #1d1d1f;
    }
    .overview-busy-head span {
      font-size: 11px;
      color: #6e6e73;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-weight: 640;
    }
    .overview-busy-copy {
      font-size: 13px;
      color: #2b3946;
      line-height: 1.5;
    }
    .overview-quick-links {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
      min-width: 180px;
    }
    .overview-quick-links .btn {
      padding: 7px 11px;
      border-radius: 9px;
      white-space: nowrap;
      background: linear-gradient(180deg, rgba(238, 246, 255, 0.96), rgba(255, 255, 255, 0.98));
    }
    .overview-usage-card {
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(249, 251, 255, 0.97)),
        radial-gradient(circle at 85% 14%, rgba(217, 231, 255, 0.2), transparent 52%);
    }
    .overview-pulse-card {
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(250, 252, 255, 0.95)),
        radial-gradient(circle at 12% -5%, rgba(192, 218, 244, 0.18), transparent 45%);
    }
    .card {
      position: relative;
      border: 1px solid var(--card-border);
      background: var(--card-fill);
      padding: 18px 18px 17px;
      border-radius: 20px;
      box-shadow: var(--card-shadow);
      animation: card-in 360ms ease both;
      transition: transform 200ms ease, box-shadow 200ms ease, border-color 200ms ease, background 200ms ease;
      overflow-x: auto;
    }
    .card::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.9),
        inset 0 -1px 0 rgba(255, 255, 255, 0.24);
      pointer-events: none;
    }
    .card, .sidebar, .nav-link, .overview-hero-card { animation-delay: calc(var(--stagger-index, 0) * 36ms); }
    .panel.is-reflowing .card,
    .panel.is-reflowing .overview-kpi-card {
      transition: transform 230ms ease, opacity 230ms ease;
    }
    .card:hover {
      transform: translateY(-1px);
      border-color: var(--card-border-strong);
      box-shadow: var(--card-shadow-hover);
    }
    .card h2 { font-size: var(--font-title-2); color: #1d1d1f; margin-bottom: var(--space-1); letter-spacing: -0.022em; line-height: 1.14; }
    .badge {
      display: inline-block;
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 11px;
      border: 1px solid transparent;
      letter-spacing: 0.02em;
      background: rgba(255, 255, 255, 0.88);
      font-weight: 640;
    }
    .badge.ok, .badge.done { color: #1d7435; border-color: rgba(36, 138, 61, 0.3); background: rgba(238, 251, 242, 0.95); }
    .badge.warn { color: #94680e; border-color: rgba(181, 127, 16, 0.32); background: rgba(255, 248, 232, 0.95); }
    .badge.over, .badge.blocked, .badge.action-required, .badge.critical, .badge.fail, .badge.blocked_no_token { color: #b53125; border-color: rgba(210, 63, 49, 0.34); background: rgba(255, 240, 238, 0.95); }
    .badge.info, .badge.in_progress, .badge.active, .badge.armed, .badge.live, .badge.spawned, .badge.spawn { color: #0059b4; border-color: rgba(0, 113, 227, 0.32); background: rgba(236, 246, 255, 0.95); }
    .badge.todo, .badge.planned, .badge.message, .badge.tool_event, .badge.idle, .badge.disabled { color: #666a70; border-color: rgba(125, 129, 136, 0.3); background: rgba(248, 248, 249, 0.95); }
    .badge.accepted { color: #1d7435; border-color: rgba(36, 138, 61, 0.3); background: rgba(238, 251, 242, 0.95); }
    .badge.enabled, .badge.pass { color: #1d7435; border-color: rgba(36, 138, 61, 0.3); background: rgba(238, 251, 242, 0.95); }
    .badge.dry_run { color: #94680e; border-color: rgba(181, 127, 16, 0.32); background: rgba(255, 248, 232, 0.95); }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 15px;
      margin-top: 10px;
      min-width: 780px;
    }
    th,
    td {
      border-bottom: 1px solid rgba(17, 24, 39, 0.08);
      text-align: left;
      padding: 12px 9px;
      vertical-align: top;
      word-break: normal;
      overflow-wrap: break-word;
      line-height: 1.48;
    }
    th {
      color: #6e6e73;
      font-size: 13px;
      font-weight: 660;
      letter-spacing: 0.005em;
      white-space: nowrap;
    }
    tr:hover td { background: rgba(245, 247, 250, 0.84); }
    .global-visibility-card {
      overflow-x: auto;
    }
    .global-visibility-card .ops-board {
      min-width: 980px;
      table-layout: auto;
    }
    ul { margin: 7px 0 0 18px; padding: 0; }
    .story-list { margin-top: 8px; line-height: 1.45; }
    .group-list { display: grid; gap: 10px; margin-top: 8px; }
    .group-section {
      border: 1px solid var(--card-border);
      border-radius: 16px;
      background: var(--card-fill-soft);
      box-shadow: var(--card-shadow-soft);
      padding: 0;
      overflow: hidden;
    }
    .group-section summary {
      list-style: none;
      cursor: pointer;
      font-size: 14px;
      font-weight: 660;
      color: #1d1d1f;
      padding: 11px 13px;
      background: linear-gradient(180deg, rgba(245, 248, 252, 0.96), rgba(252, 253, 255, 0.92));
      border-bottom: 1px solid rgba(17, 24, 39, 0.08);
    }
    .group-items {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 0;
    }
    .group-item {
      border-top: 1px solid rgba(17, 24, 39, 0.08);
      padding: 11px 13px;
      background: rgba(255,255,255,0.98);
    }
    .group-item:first-child { border-top: none; }
    .group-item-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 4px;
    }
    .group-item-head strong {
      font-size: 14px;
      color: #1d1d1f;
      line-height: 1.45;
    }
    .filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin-top: 8px; }
    .filters label { font-size: 12px; color: var(--muted); display: block; margin-bottom: 5px; font-weight: 580; }
    .filters select,
    .filters input {
      width: 100%;
      -webkit-appearance: none;
      appearance: none;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(249, 251, 255, 0.96));
      color: var(--text);
      border: 1px solid rgba(17, 24, 39, 0.11);
      border-radius: 14px;
      padding: 10px 12px;
      font-family: inherit;
      font-size: 13px;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.76);
    }
    .filters select:focus,
    .filters input:focus {
      outline: none;
      border-color: rgba(0, 113, 227, 0.28);
      box-shadow: var(--ring-soft), inset 0 1px 0 rgba(255, 255, 255, 0.84);
    }
    .filter-actions { margin-top: 8px; display: flex; gap: 10px; align-items: center; }
    .btn {
      -webkit-appearance: none;
      appearance: none;
      border: 1px solid rgba(0, 113, 227, 0.18);
      border-radius: 999px;
      background:
        linear-gradient(180deg, rgba(244, 249, 255, 0.98), rgba(255, 255, 255, 0.98)),
        radial-gradient(circle at 50% 0%, rgba(0, 113, 227, 0.08), transparent 58%);
      color: #0058b1;
      padding: 8px 14px;
      font-size: 13px;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-weight: 630;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.88),
        0 8px 18px rgba(0, 113, 227, 0.08);
      transition: transform 180ms ease, box-shadow 180ms ease, border-color 180ms ease, color 180ms ease, background 180ms ease;
    }
    .btn:hover {
      transform: translateY(-1px);
      border-color: rgba(0, 113, 227, 0.24);
      color: #004f9f;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.9),
        0 14px 24px rgba(0, 113, 227, 0.12);
      background:
        linear-gradient(180deg, rgba(238, 247, 255, 0.99), rgba(255, 255, 255, 0.99)),
        radial-gradient(circle at 50% 0%, rgba(0, 113, 227, 0.1), transparent 58%);
    }
    .btn:focus-visible {
      outline: none;
      box-shadow: var(--ring-soft), inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 12px 24px rgba(0, 113, 227, 0.1);
    }
    .board { margin-top: 10px; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    .lane {
      border: 1px solid var(--card-border);
      border-radius: 18px;
      padding: 12px;
      background: var(--card-fill-soft);
      box-shadow: var(--card-shadow-soft);
      min-height: 128px;
    }
    .lane h3 { margin: 0; font-size: 14px; color: #1f2023; letter-spacing: -0.01em; }
    .lane-count { color: var(--muted); font-size: 12px; margin-top: 3px; }
    .task-chip,
    .project-chip {
      margin-top: 8px;
      border: 1px solid var(--card-border);
      border-radius: 14px;
      padding: 10px;
      background: var(--card-fill-soft);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.84),
        0 8px 18px rgba(15, 23, 42, 0.03);
      font-size: 13px;
      line-height: 1.56;
    }
    .task-chip.mapping {
      border-color: rgba(181, 111, 18, 0.34);
      background: rgba(255, 248, 236, 0.95);
    }
    .task-chip code,
    .project-chip code { color: #0065cc; }
    .bars { margin-top: 8px; display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; }
    .bar-row { margin-top: 8px; }
    .bar-meta { font-size: 12px; color: var(--muted); display: flex; justify-content: space-between; gap: 6px; }
    .bar-track { margin-top: 4px; border: 1px solid rgba(17, 24, 39, 0.1); border-radius: 999px; height: 8px; background: rgba(227, 230, 236, 0.62); overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 999px; }
    .bar-fill.ok { background: #18a97a; }
    .bar-fill.warn { background: #d69a1d; }
    .bar-fill.over { background: #cc4545; }
    .queue-list { list-style: none; margin: 8px 0 0 0; padding: 0; display: grid; gap: 9px; }
    .queue-item {
      margin-top: 0;
      border: 1px solid var(--card-border);
      border-radius: 15px;
      padding: 11px;
      background: var(--card-fill-soft);
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.86),
        0 10px 20px rgba(15, 23, 42, 0.03);
    }
    .queue-actions { margin-top: 7px; display: flex; align-items: center; gap: 8px; }
    .inline-form { display: inline; margin: 0; }
    .status-strip { margin-top: 10px; display: grid; gap: 9px; grid-template-columns: repeat(auto-fit, minmax(138px, 1fr)); }
    .status-strip.compact { grid-template-columns: repeat(auto-fit, minmax(116px, 1fr)); }
    .status-chip {
      border: 1px solid var(--card-border);
      border-radius: 16px;
      background: var(--card-fill-soft);
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.88),
        0 12px 24px rgba(15, 23, 42, 0.04);
    }
    .status-chip span { color: #6d6f75; font-size: 12px; letter-spacing: 0.01em; }
    .status-chip strong { font-size: 24px; line-height: 1.08; letter-spacing: -0.02em; color: #1d1d1f; }
    .usage-chip strong { font-size: 22px; }
    .status-chip small { display: none; }
    .dashboard-strip {
      grid-template-columns: repeat(4, minmax(0, 1fr)) 150px 150px;
      gap: 10px;
    }
    .task-hub-shell {
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(360px, 1fr);
      gap: var(--space-2);
      align-items: start;
    }
    .task-hub-primary {
      background:
        linear-gradient(155deg, rgba(234, 244, 255, 0.92), rgba(255, 255, 255, 0.98)),
        radial-gradient(circle at 88% 12%, rgba(197, 221, 250, 0.24), transparent 50%);
      border-color: rgba(0, 113, 227, 0.22);
      box-shadow: 0 14px 30px rgba(14, 63, 126, 0.1);
    }
    .task-hub-stat-grid {
      margin-top: 12px;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }
    .task-hub-stat {
      border: 1px solid var(--card-border);
      border-radius: 15px;
      background: var(--card-fill-soft);
      padding: 12px;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.88),
        0 10px 20px rgba(15, 23, 42, 0.035);
      display: grid;
      gap: 4px;
    }
    .task-hub-stat span {
      font-size: 12px;
      color: #6b6f76;
      letter-spacing: 0.01em;
    }
    .task-hub-stat strong {
      font-size: 28px;
      line-height: 1;
      color: #1d1d1f;
      letter-spacing: -0.03em;
      font-variant-numeric: tabular-nums;
    }
    .task-hub-stat small {
      font-size: 12px;
      color: #6b6f76;
      line-height: 1.45;
    }
    .task-hub-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-2);
      align-items: start;
    }
    .task-hub-board-grid {
      grid-template-columns: minmax(0, 1.6fr) minmax(340px, 1fr);
    }
    .task-hub-sidebar {
      display: grid;
      gap: var(--space-2);
      align-content: start;
    }
    .execution-chain-list {
      margin-top: 12px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 520px), 1fr));
      gap: 16px;
      align-items: stretch;
    }
    .execution-chain-card {
      border: 1px solid var(--card-border);
      border-radius: 24px;
      padding: 18px;
      background: var(--card-fill-soft);
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.9),
        0 18px 34px rgba(15, 23, 42, 0.05);
      display: grid;
      gap: 12px;
      min-width: 0;
      overflow: hidden;
      min-height: 100%;
    }
    .execution-chain-head {
      display: grid;
      gap: 10px;
    }
    .execution-chain-copy {
      min-width: 0;
      display: grid;
      gap: 6px;
    }
    .execution-chain-copy strong {
      font-size: clamp(24px, 0.85vw + 18px, 31px);
      line-height: 1.08;
      letter-spacing: -0.04em;
      color: #1d1d1f;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 3;
      overflow: hidden;
      overflow-wrap: anywhere;
      word-break: normal;
    }
    .execution-chain-context {
      color: #6d6f75;
      font-size: 14px;
      line-height: 1.55;
      letter-spacing: -0.01em;
    }
    .execution-chain-badges {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-start;
      gap: 6px;
      max-width: none;
      min-width: 0;
      align-content: flex-start;
    }
    .execution-chain-meta-stack {
      display: grid;
      gap: 10px;
    }
    .execution-chain-meta-line {
      color: #6d6f75;
      font-size: 14px;
      line-height: 1.55;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .execution-chain-flow {
      border: 1px solid rgba(0, 113, 227, 0.12);
      border-radius: 18px;
      padding: 12px 14px;
      background:
        linear-gradient(180deg, rgba(245, 249, 255, 0.98), rgba(255, 255, 255, 0.96)),
        radial-gradient(circle at 0% 0%, rgba(0, 113, 227, 0.06), transparent 58%);
      color: #29527a;
      font-size: 14px;
      line-height: 1.62;
    }
    .execution-chain-summary {
      color: #2f3237;
      font-size: 15px;
      line-height: 1.62;
      letter-spacing: -0.01em;
    }
    .execution-chain-arrow {
      color: #6b6f76;
      margin: 0 4px;
    }
    .execution-chain-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: auto;
      padding-top: 4px;
    }
    .execution-chain-card code,
    .execution-chain-flow code {
      white-space: normal;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .execution-chain-card .meta {
      min-width: 0;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .collaboration-summary-grid {
      margin-top: 12px;
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }
    .collaboration-headline {
      margin-top: 10px;
    }
    .collaboration-filter-bar {
      margin-top: 12px;
      width: 100%;
      justify-content: flex-start;
    }
    .collaboration-thread-list {
      margin-top: 14px;
      display: grid;
      gap: 14px;
    }
    .collaboration-thread-card {
      padding: 0;
      overflow: hidden;
    }
    .collaboration-thread-card > summary {
      list-style: none;
      cursor: pointer;
      padding: 18px;
      display: grid;
      gap: 14px;
    }
    .collaboration-thread-card > summary::-webkit-details-marker {
      display: none;
    }
    .collaboration-thread-card > summary::marker {
      display: none;
    }
    .collaboration-thread-head {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 14px;
      align-items: center;
    }
    .collaboration-route-avatars {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: nowrap;
    }
    .collaboration-participant {
      display: grid;
      justify-items: center;
      gap: 6px;
      min-width: 72px;
      flex: 0 0 auto;
    }
    .collaboration-participant-label {
      font-size: 11px;
      line-height: 1.35;
      color: #6e7680;
      font-weight: 620;
      letter-spacing: 0.01em;
      text-align: center;
    }
    .collaboration-route-arrow {
      color: #6e7680;
      font-size: 15px;
      font-weight: 700;
    }
    .collaboration-avatar {
      max-width: 72px;
      width: 72px;
      padding: 6px;
      border-radius: 16px;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.84),
        0 10px 22px rgba(17, 24, 39, 0.06);
    }
    .collaboration-avatar .agent-stage {
      aspect-ratio: 1 / 1;
      border-radius: 10px;
    }
    .collaboration-avatar .agent-animal-label {
      display: none;
    }
    .collaboration-avatar.is-current {
      border-color: rgba(0, 113, 227, 0.22);
      box-shadow:
        inset 0 0 0 1px rgba(0, 113, 227, 0.1),
        0 12px 26px rgba(0, 113, 227, 0.12);
      background:
        linear-gradient(180deg, rgba(240, 247, 255, 0.99), rgba(255, 255, 255, 0.98)),
        radial-gradient(circle at 50% 0%, rgba(0, 113, 227, 0.08), transparent 60%);
    }
    .collaboration-thread-copy {
      min-width: 0;
      display: grid;
      gap: 5px;
    }
    .collaboration-thread-copy strong {
      font-size: 24px;
      line-height: 1.08;
      letter-spacing: -0.035em;
      color: #1d1d1f;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      overflow: hidden;
      overflow-wrap: anywhere;
    }
    .collaboration-thread-badges {
      display: grid;
      justify-items: end;
      gap: 8px;
    }
    .collaboration-current-owner {
      font-size: 12px;
      line-height: 1.45;
      color: #5f6670;
      font-weight: 620;
      text-align: right;
    }
    .collaboration-thread-teaser {
      display: grid;
      gap: 8px;
    }
    .collaboration-latest-snippet {
      border: 1px solid rgba(0, 113, 227, 0.12);
      border-radius: 16px;
      padding: 12px 14px;
      background:
        linear-gradient(180deg, rgba(246, 250, 255, 0.98), rgba(255, 255, 255, 0.98)),
        radial-gradient(circle at 0% 0%, rgba(0, 113, 227, 0.06), transparent 52%);
      color: #294866;
      font-size: 14px;
      line-height: 1.6;
    }
    .collaboration-thread-body {
      border-top: 1px solid rgba(17, 24, 39, 0.07);
      padding: 0 18px 18px;
      display: grid;
      gap: 14px;
    }
    .collaboration-timeline {
      list-style: none;
      margin: 0;
      padding: 14px 0 0;
      display: grid;
      gap: 12px;
    }
    .collaboration-timeline-step {
      display: grid;
      grid-template-columns: 176px minmax(0, 1fr);
      gap: 12px;
      align-items: start;
      padding-top: 12px;
      border-top: 1px solid rgba(17, 24, 39, 0.06);
    }
    .collaboration-timeline-step:first-child {
      border-top: none;
      padding-top: 0;
    }
    .collaboration-agent-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 9px 12px;
      border-radius: 999px;
      border: 1px solid rgba(17, 24, 39, 0.09);
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.99), rgba(248, 251, 255, 0.96)),
        radial-gradient(circle at 0% 0%, color-mix(in srgb, var(--agent-accent) 14%, transparent), transparent 58%);
      color: #223546;
      font-size: 13px;
      font-weight: 650;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.86);
    }
    .collaboration-agent-pill-dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: var(--agent-accent);
      box-shadow: 0 0 0 2px rgba(255,255,255,0.72);
      flex: 0 0 auto;
    }
    .collaboration-step-copy {
      min-width: 0;
      display: grid;
      gap: 6px;
    }
    .collaboration-step-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 10px;
      flex-wrap: wrap;
    }
    .collaboration-step-head strong {
      font-size: 15px;
      color: #1d1d1f;
      letter-spacing: -0.01em;
    }
    .collaboration-step-head span {
      font-size: 12px;
      color: #6e7680;
    }
    .collaboration-thread-foot {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .collaboration-folded-note {
      margin-top: 2px;
    }
    .collaboration-folded-list {
      margin: 8px 0 0;
    }
    .collaboration-thread-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .collaboration-technical-details {
      margin-top: -4px;
    }
    .timeline-summary-strip {
      margin-top: 10px;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .timeline-stat {
      border: 1px solid var(--card-border);
      border-radius: 14px;
      padding: 11px;
      background: var(--card-fill-soft);
      display: grid;
      gap: 4px;
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.84),
        0 10px 20px rgba(15, 23, 42, 0.03);
    }
    .timeline-stat span {
      font-size: 12px;
      color: #6b6f76;
    }
    .timeline-stat strong {
      font-size: 26px;
      line-height: 1;
      color: #1d1d1f;
      letter-spacing: -0.03em;
    }
    .timeline-stat small {
      font-size: 12px;
      color: #6e6e73;
      line-height: 1.45;
    }
    .signal-gauge-card {
      padding: 11px 11px 12px;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.98), rgba(248,252,255,0.95)),
        radial-gradient(circle at 100% 0%, rgba(220, 233, 255, 0.12), transparent 52%);
    }
    .signal-gauge-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .signal-gauge-main { margin-top: 8px; display: grid; grid-template-columns: 68px minmax(0, 1fr); gap: 10px; align-items: center; }
    .signal-gauge {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      background: conic-gradient(var(--gauge-tone) calc(var(--gauge-pct) * 1%), rgba(199, 208, 220, 0.34) 0);
      border: 1px solid rgba(17, 24, 39, 0.12);
      display: grid;
      place-items: center;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.54);
    }
    .signal-gauge-core {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: rgba(255,255,255,0.96);
      border: 1px solid rgba(17, 24, 39, 0.11);
      display: grid;
      place-items: center;
    }
    .signal-gauge-core strong {
      font-size: 20px;
      letter-spacing: -0.02em;
    }
    .signal-gauge-meta {
      display: flex;
      flex-direction: column;
      gap: 5px;
      min-width: 0;
    }
    .signal-gauge-meta small {
      display: block;
      color: #6e6e73;
      font-size: 12px;
      line-height: 1.45;
    }
    .signal-gauge-meta a {
      color: #0068d3;
      font-size: 13px;
      text-decoration: none;
      font-weight: 620;
    }
    .summary-gauge-card {
      justify-content: center;
      background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(248,250,253,0.95));
      gap: 7px;
    }
    .summary-gauge-card strong { font-size: 30px; }
    .summary-track {
      width: 100%;
      height: 7px;
      border-radius: 999px;
      background: rgba(196, 208, 224, 0.42);
      overflow: hidden;
      border: 1px solid rgba(17, 24, 39, 0.08);
    }
    .summary-fill {
      height: 100%;
      background: linear-gradient(90deg, rgba(33, 154, 85, 0.9), rgba(78, 191, 121, 0.95));
      border-radius: 999px;
    }
    .summary-fill.warn {
      background: linear-gradient(90deg, rgba(196, 137, 25, 0.9), rgba(217, 165, 58, 0.95));
    }
    .signal-gauge-card.state-updated { animation: status-bump 760ms ease; }
    .overview-kpi-card.state-updated-soft,
    .overview-primary-card.state-updated-soft {
      animation: kpi-bump 860ms ease;
    }
    .overview-pulse-card .status-strip {
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }
    .overview-pulse-card .status-chip {
      border-radius: 14px;
      padding: 11px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.97), rgba(248, 252, 255, 0.95));
      border-color: rgba(17, 24, 39, 0.1);
    }
    .overview-pulse-card .status-chip span {
      text-transform: uppercase;
      font-size: 10px;
      letter-spacing: 0.06em;
      color: #7a7f86;
    }
    .overview-pulse-card .status-chip strong {
      font-size: 21px;
      color: #1d1d1f;
    }
    #usage-pulse .status-strip { grid-template-columns: 1fr; }
    #usage-pulse .usage-chip {
      border-radius: 16px;
      padding: 12px;
      border-color: rgba(17, 24, 39, 0.1);
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(247, 251, 255, 0.95));
    }
    #usage-pulse .usage-chip strong {
      font-size: 34px;
      letter-spacing: -0.03em;
      line-height: 1.04;
      margin-top: 1px;
    }
    .quick-filters { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 8px; }
    .quick-chip { border: 1px solid rgba(17, 24, 39, 0.16); border-radius: 999px; padding: 6px 11px; font-size: 12px; text-decoration: none; color: #4f545a; background: rgba(255, 255, 255, 0.95); }
    .quick-chip.active { border-color: rgba(0, 113, 227, 0.42); color: #005cb9; background: rgba(236, 246, 255, 0.96); }
    .segment-switch {
      margin-top: 8px;
      display: inline-flex;
      flex-wrap: wrap;
      align-items: center;
      border: 1px solid rgba(17, 24, 39, 0.08);
      border-radius: 999px;
      padding: 5px;
      background:
        linear-gradient(180deg, rgba(248, 250, 253, 0.98), rgba(255, 255, 255, 0.96)),
        radial-gradient(circle at 50% 0%, rgba(221, 232, 255, 0.18), transparent 58%);
      gap: 6px;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.88),
        0 8px 18px rgba(17, 24, 39, 0.05);
    }
    .segment-item {
      -webkit-appearance: none;
      appearance: none;
      border: none;
      background: transparent;
      box-shadow: none;
      border-radius: 999px;
      min-height: 40px;
      padding: 0 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      color: #4f545a;
      text-decoration: none;
      font-weight: 620;
      letter-spacing: -0.01em;
      cursor: pointer;
      transition: transform 160ms ease, color 160ms ease, background 160ms ease, box-shadow 160ms ease;
    }
    .segment-item:hover {
      transform: translateY(-1px);
      color: #2f3944;
      background: rgba(255, 255, 255, 0.72);
    }
    .segment-item.active {
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.99), rgba(247, 250, 255, 0.98)),
        radial-gradient(circle at 50% 0%, rgba(0, 113, 227, 0.12), transparent 60%);
      color: #0059b2;
      box-shadow:
        inset 0 0 0 1px rgba(0, 113, 227, 0.16),
        0 8px 18px rgba(0, 113, 227, 0.12);
    }
    .segment-item:focus-visible {
      outline: none;
      box-shadow: var(--ring-soft), inset 0 0 0 1px rgba(0, 113, 227, 0.18);
    }
    .cron-board { margin-top: 12px; display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; }
    .cron-owner-card {
      border: 1px solid rgba(17, 24, 39, 0.07);
      border-radius: 18px;
      background: linear-gradient(170deg, rgba(255, 255, 255, 0.97), rgba(250, 252, 255, 0.94));
      padding: 12px;
      box-shadow: 0 10px 22px rgba(17, 24, 39, 0.04);
    }
    .cron-owner-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
    .cron-owner-head h3 { font-size: 16px; color: #1d1d1f; letter-spacing: -0.012em; }
    .cron-job-list { list-style: none; margin: 8px 0 0 0; padding: 0; display: grid; gap: 8px; }
    .cron-job-list li {
      border: 1px solid rgba(17, 24, 39, 0.07);
      border-radius: 14px;
      padding: 10px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(250, 252, 255, 0.96));
    }
    .cron-job-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
    .cron-job-head strong { font-size: 13px; color: #1d1d1f; line-height: 1.45; }
    .toolbar { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .readiness-grid { margin-top: 8px; display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; }
    .readiness-chip {
      border: 1px solid rgba(17, 24, 39, 0.07);
      border-radius: 16px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(250, 252, 255, 0.96));
      padding: 11px;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.86);
    }
    .readiness-chip .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; }
    .readiness-chip .score { font-size: 22px; margin-top: 4px; letter-spacing: -0.02em; }
    .empty-state { margin-top: 10px; border: 1px dashed rgba(181, 127, 16, 0.32); padding: 13px; border-radius: 12px; background: rgba(255, 250, 240, 0.92); color: #7e5a1a; font-size: 13px; line-height: 1.68; }
    .office-grid { margin-top: 8px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .office-card {
      border: 1px solid rgba(17, 24, 39, 0.1);
      border-radius: 16px;
      padding: 13px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(251, 253, 255, 0.95));
      box-shadow: 0 8px 20px rgba(17, 24, 39, 0.06);
    }
    .office-head { display: grid; grid-template-columns: 146px minmax(0, 1fr); gap: 12px; align-items: start; }
    .office-info .topline { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .office-info .topline strong { font-size: 15px; letter-spacing: -0.01em; }
    .agent-avatar {
      border: 1px solid rgba(17, 24, 39, 0.12);
      border-top: 3px solid var(--agent-accent);
      border-radius: 12px;
      padding: 10px;
      background:
        linear-gradient(140deg, rgba(255, 255, 255, 0.98), rgba(250, 252, 255, 0.95)),
        radial-gradient(circle at 84% 14%, rgba(255, 255, 255, 0.74), transparent 48%);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.56);
      text-align: center;
      position: relative;
      overflow: hidden;
      width: 100%;
      max-width: 146px;
    }
    .agent-stage {
      position: relative;
      height: auto;
      aspect-ratio: 224 / 160;
      border-radius: 10px;
      border: 1px solid rgba(17, 24, 39, 0.1);
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.9), rgba(240, 247, 255, 0.8)),
        repeating-linear-gradient(
          0deg,
          rgba(31, 41, 55, 0.04) 0px,
          rgba(31, 41, 55, 0.04) 1px,
          transparent 1px,
          transparent 8px
        ),
        repeating-linear-gradient(
          90deg,
          rgba(31, 41, 55, 0.04) 0px,
          rgba(31, 41, 55, 0.04) 1px,
          transparent 1px,
          transparent 8px
        );
      overflow: hidden;
    }
    .agent-pixel-canvas {
      width: 100%;
      height: 100%;
      display: block;
      image-rendering: pixelated;
      image-rendering: crisp-edges;
      filter: saturate(1.06) contrast(1.04);
    }
    .agent-animal-label {
      margin-top: 8px;
      font-size: 12px;
      color: #4d5259;
      font-weight: 700;
      letter-spacing: 0.02em;
    }
    .staff-brief-grid {
      margin-top: 12px;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }
    .staff-brief-card {
      border: 1px solid rgba(17, 24, 39, 0.07);
      border-radius: 22px;
      padding: 15px;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.99), rgba(249, 251, 255, 0.97)),
        radial-gradient(circle at 100% 0%, rgba(221, 232, 255, 0.18), transparent 52%);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.82),
        0 16px 34px rgba(17, 24, 39, 0.06);
      display: grid;
      gap: 12px;
    }
    .staff-brief-head {
      display: grid;
      grid-template-columns: 122px minmax(0, 1fr);
      gap: 12px;
      align-items: center;
    }
    .staff-avatar {
      width: 122px;
      padding: 9px;
      border-radius: 18px;
      border: 1px solid rgba(17, 24, 39, 0.08);
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(250, 252, 255, 0.95)),
        radial-gradient(circle at 0% 0%, color-mix(in srgb, var(--agent-accent) 12%, transparent), transparent 62%);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.8),
        0 10px 20px rgba(17, 24, 39, 0.05);
    }
    .staff-avatar .agent-stage {
      aspect-ratio: 1 / 1;
      border-radius: 12px;
    }
    .staff-brief-identity h3 {
      margin: 0;
      font-size: 20px;
      line-height: 1.15;
      color: #1d1d1f;
    }
    .staff-role {
      margin-top: 4px;
      font-size: 12px;
      line-height: 1.45;
      color: #5c6570;
      font-weight: 620;
    }
    .staff-brief-list {
      margin: 0;
      display: grid;
      gap: 8px;
    }
    .staff-brief-row {
      display: grid;
      grid-template-columns: 92px minmax(0, 1fr);
      gap: 8px;
      align-items: start;
      padding-top: 8px;
      border-top: 1px solid rgba(17, 24, 39, 0.06);
    }
    .staff-brief-row:first-child {
      border-top: none;
      padding-top: 0;
    }
    .staff-brief-row dt {
      margin: 0;
      font-size: 12px;
      line-height: 1.45;
      color: #7b8490;
      font-weight: 700;
      letter-spacing: 0.02em;
    }
    .staff-brief-row dd {
      margin: 0;
      font-size: 14px;
      line-height: 1.55;
      color: #24313d;
      font-weight: 560;
    }
    .office-focus { margin: 6px 0 0 18px; padding: 0; }
    .office-focus li { margin-top: 4px; }
    .office-floor { margin-top: 10px; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
    .zone { border: 1px solid rgba(22, 86, 116, 0.2); border-radius: 12px; padding: 10px; background: rgba(247, 252, 255, 0.95); }
    .zone h3 { font-size: 13px; color: #1a4e66; margin-bottom: 4px; }
    .zone .meta { margin-bottom: 6px; }
    .desk-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
    .desk-chip {
      border: 1px solid rgba(22, 86, 116, 0.2);
      border-radius: 9px;
      padding: 7px;
      font-size: 12px;
      background: rgba(255, 255, 255, 0.95);
    }
    .desk-chip strong { color: #15485f; }
    .calendar-grid { margin-top: 10px; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
    .calendar-day {
      border: 1px solid rgba(17, 24, 39, 0.07);
      border-radius: 18px;
      padding: 12px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(249, 251, 255, 0.96));
      box-shadow: 0 10px 22px rgba(17, 24, 39, 0.04);
    }
    .calendar-day h3 { font-size: 14px; margin: 0; color: #1f2937; }
    .calendar-event-list { list-style: none; margin: 8px 0 0 0; padding: 0; display: grid; gap: 8px; }
    .calendar-event {
      border: 1px solid rgba(17, 24, 39, 0.07);
      border-radius: 14px;
      padding: 10px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.99), rgba(250, 252, 255, 0.97));
    }
    .calendar-event-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
    .mission-banner {
      margin-top: 8px;
      border: 1px solid rgba(0, 113, 227, 0.24);
      border-radius: 12px;
      padding: 10px;
      background: linear-gradient(180deg, rgba(236, 246, 255, 0.96), rgba(255, 255, 255, 0.98));
      color: #11385a;
      font-weight: 620;
      line-height: 1.5;
    }
    .memory-timeline { margin-top: 10px; display: grid; gap: 8px; }
    .memory-row {
      border: 1px solid rgba(17, 24, 39, 0.1);
      border-radius: 12px;
      padding: 10px;
      background: rgba(255, 255, 255, 0.95);
      display: grid;
      grid-template-columns: 110px minmax(0, 1fr);
      gap: 10px;
      align-items: start;
    }
    .memory-day {
      font-size: 12px;
      color: #6b7280;
      font-weight: 700;
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }
    .memory-title { font-size: 15px; color: #1f2937; font-weight: 650; line-height: 1.4; }
    .file-workbench {
      margin-top: 12px;
      display: grid;
      grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
      gap: 12px;
      align-items: stretch;
    }
    .file-sidebar,
    .file-editor-panel {
      border: 1px solid rgba(17, 24, 39, 0.07);
      border-radius: 22px;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(250, 252, 255, 0.96)),
        radial-gradient(circle at 100% 0%, rgba(221, 232, 255, 0.16), transparent 52%);
      padding: 14px;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.8),
        0 18px 36px rgba(17, 24, 39, 0.06);
    }
    .file-sidebar { display: grid; grid-template-rows: auto minmax(0, 1fr); gap: 10px; }
    .file-sidebar-tools { display: grid; gap: 8px; }
    .file-facet-switch {
      justify-self: start;
      width: 100%;
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      gap: 8px;
      border: none;
      background: transparent;
      box-shadow: none;
      padding: 0;
      border-radius: 0;
    }
    .file-facet-switch .segment-item {
      min-height: 38px;
      padding: 0 16px;
      border: 1px solid rgba(17, 24, 39, 0.08);
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(249, 251, 255, 0.94));
      color: #4d5560;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.84),
        0 8px 18px rgba(17, 24, 39, 0.04);
    }
    .file-facet-switch .segment-item:hover {
      border-color: rgba(17, 24, 39, 0.12);
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.99), rgba(250, 252, 255, 0.97));
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.88),
        0 10px 20px rgba(17, 24, 39, 0.06);
    }
    .file-facet-switch .segment-item.active {
      border-color: rgba(0, 113, 227, 0.16);
      background:
        linear-gradient(180deg, rgba(240, 247, 255, 0.99), rgba(255, 255, 255, 0.98)),
        radial-gradient(circle at 50% 0%, rgba(0, 113, 227, 0.08), transparent 60%);
      color: #0059b2;
      box-shadow:
        inset 0 0 0 1px rgba(0, 113, 227, 0.12),
        0 10px 22px rgba(0, 113, 227, 0.08);
    }
    .file-filter-input,
    .file-token-input {
      width: 100%;
      -webkit-appearance: none;
      appearance: none;
      border: 1px solid rgba(17, 24, 39, 0.1);
      border-radius: 15px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.99), rgba(249, 251, 255, 0.97));
      padding: 11px 13px;
      font-size: 13px;
      font-family: inherit;
      color: #1d1d1f;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.82);
    }
    .file-filter-input:focus,
    .file-token-input:focus {
      outline: none;
      border-color: rgba(0, 113, 227, 0.24);
      box-shadow: var(--ring-soft), inset 0 1px 0 rgba(255, 255, 255, 0.88);
    }
    .file-filter-input::placeholder,
    .file-token-input::placeholder,
    .docs-search input::placeholder,
    .file-editor-textarea::placeholder {
      color: #8c9198;
    }
    .file-nav {
      display: grid;
      gap: 8px;
      max-height: 660px;
      overflow: auto;
      padding-right: 4px;
      scrollbar-width: thin;
      scrollbar-color: rgba(126, 138, 154, 0.45) transparent;
    }
    .file-nav::-webkit-scrollbar,
    .panel::-webkit-scrollbar,
    .card::-webkit-scrollbar,
    textarea::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }
    .file-nav::-webkit-scrollbar-thumb,
    .panel::-webkit-scrollbar-thumb,
    .card::-webkit-scrollbar-thumb,
    textarea::-webkit-scrollbar-thumb {
      border-radius: 999px;
      background: rgba(126, 138, 154, 0.42);
      border: 2px solid transparent;
      background-clip: padding-box;
    }
    .file-nav::-webkit-scrollbar-track,
    .panel::-webkit-scrollbar-track,
    .card::-webkit-scrollbar-track,
    textarea::-webkit-scrollbar-track {
      background: transparent;
    }
    .file-nav-item {
      -webkit-appearance: none;
      appearance: none;
      border: 1px solid rgba(17, 24, 39, 0.07);
      border-radius: 16px;
      background: linear-gradient(180deg, rgba(250, 251, 253, 0.96), rgba(255, 255, 255, 0.95));
      padding: 12px 13px;
      text-align: left;
      display: grid;
      gap: 4px;
      cursor: pointer;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.8);
      transition: border-color 180ms ease, transform 180ms ease, background 180ms ease, box-shadow 180ms ease;
    }
    .file-nav-item[hidden] {
      display: none !important;
    }
    .file-nav-item:hover {
      border-color: rgba(17, 24, 39, 0.1);
      background: linear-gradient(180deg, rgba(247, 250, 255, 0.99), rgba(255, 255, 255, 0.98));
      transform: translateY(-1px);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.84),
        0 10px 24px rgba(17, 24, 39, 0.06);
    }
    .file-nav-item.active {
      border-color: rgba(0, 113, 227, 0.16);
      background:
        linear-gradient(180deg, rgba(240, 247, 255, 0.99), rgba(255, 255, 255, 0.99)),
        radial-gradient(circle at 0% 0%, rgba(0, 113, 227, 0.08), transparent 42%);
      box-shadow:
        inset 0 0 0 1px rgba(255, 255, 255, 0.84),
        0 14px 28px rgba(0, 113, 227, 0.09);
    }
    .file-nav-title { font-size: 14px; font-weight: 650; color: #1d1d1f; }
    .file-nav-meta { font-size: 12px; color: #6e6e73; line-height: 1.5; }
    .file-editor-panel {
      display: grid;
      grid-template-rows: auto minmax(360px, 1fr) auto;
      gap: 10px;
      min-height: 0;
    }
    .file-editor-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      flex-wrap: wrap;
    }
    .file-editor-title { font-size: 18px; font-weight: 680; color: #1d1d1f; line-height: 1.25; }
    .file-editor-textarea {
      width: 100%;
      min-height: 480px;
      border: 1px solid rgba(17, 24, 39, 0.1);
      border-radius: 18px;
      background:
        linear-gradient(180deg, rgba(251, 252, 254, 0.99), rgba(247, 249, 252, 0.98));
      padding: 16px 18px;
      font: 13px/1.65 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      color: #17202a;
      resize: vertical;
      outline: none;
      box-sizing: border-box;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.74);
    }
    .file-editor-textarea:focus {
      border-color: rgba(0, 113, 227, 0.24);
      box-shadow: var(--ring-soft), inset 0 1px 0 rgba(255, 255, 255, 0.78);
    }
    .docs-toolbar {
      margin-top: 10px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 150px;
      gap: 8px;
      align-items: center;
    }
    .docs-search { margin-top: 0; }
    .docs-search input {
      width: 100%;
      -webkit-appearance: none;
      appearance: none;
      border: 1px solid rgba(17, 24, 39, 0.1);
      border-radius: 15px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.99), rgba(249, 251, 255, 0.97));
      padding: 11px 13px;
      font-size: 14px;
      font-family: inherit;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.82);
    }
    .docs-source-filter-wrap select {
      width: 100%;
      -webkit-appearance: none;
      appearance: none;
      border: 1px solid rgba(17, 24, 39, 0.1);
      border-radius: 15px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.99), rgba(249, 251, 255, 0.97));
      padding: 11px 13px;
      font-size: 13px;
      color: #364152;
      font-family: inherit;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.82);
    }
    .docs-search input:focus,
    .docs-source-filter-wrap select:focus {
      outline: none;
      border-color: rgba(0, 113, 227, 0.24);
      box-shadow: var(--ring-soft), inset 0 1px 0 rgba(255, 255, 255, 0.88);
    }
    .docs-grid { margin-top: 10px; display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; }
    .doc-card {
      border: 1px solid rgba(17, 24, 39, 0.07);
      border-radius: 16px;
      padding: 11px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(250, 252, 255, 0.96));
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.84);
      display: grid;
      gap: 6px;
    }
    .doc-card.is-hidden { display: none; }
    .doc-card-head { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; }
    details summary { cursor: pointer; color: #1a4e66; font-size: 13px; font-weight: 620; }
    .card.compact-details summary {
      list-style: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 15px;
      color: #143e60;
      font-weight: 680;
    }
    .card.compact-details summary::after {
      content: var(--fold-open-label);
      font-size: 11px;
      color: #6a7380;
      border: 1px solid rgba(22, 86, 116, 0.14);
      border-radius: 999px;
      padding: 4px 9px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(248, 251, 255, 0.92));
    }
    .card.compact-details[open] summary::after { content: var(--fold-close-label); }
    .card.compact-details > .meta { margin-top: 8px; }
    .card.compact-details .fold-body { margin-top: 10px; }
    .compact-table-details summary {
      list-style: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      color: #1c5471;
      font-weight: 620;
      cursor: pointer;
    }
    .compact-table-details summary::after {
      content: var(--fold-open-label);
      font-size: 11px;
      color: #6a7380;
      border: 1px solid rgba(22, 86, 116, 0.14);
      border-radius: 999px;
      padding: 3px 8px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(248, 251, 255, 0.92));
    }
    .compact-table-details[open] summary::after { content: var(--fold-close-label); }
    code { color: #0b6db3; font-size: 12px; }
    .subscription-pill {
      margin-top: 8px;
      border: 1px solid rgba(22, 86, 116, 0.14);
      border-radius: 16px;
      padding: 12px;
      background: linear-gradient(180deg, rgba(247, 252, 255, 0.98), rgba(255, 255, 255, 0.97));
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.84);
    }
    .quota-compact { display: grid; gap: 10px; margin-top: 8px; }
    .quota-row {
      border: 1px solid rgba(22, 86, 116, 0.1);
      border-radius: 14px;
      padding: 10px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(249, 251, 255, 0.96));
    }
    .quota-head { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
    .quota-label { font-size: 13px; font-weight: 650; color: #14374d; }
    .quota-value { font-size: 12px; color: var(--muted); }
    .quota-track { margin-top: 6px; border: 1px solid rgba(20, 92, 124, 0.16); border-radius: 999px; height: 8px; background: rgba(210, 228, 238, 0.52); overflow: hidden; }
    .quota-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #0f7bb2, #1f9f80); }
    .quota-foot { margin-top: 4px; font-size: 11px; color: var(--muted); }
    .pie-wrap { margin-top: 10px; display: grid; grid-template-columns: minmax(180px, 220px) minmax(0, 1fr); gap: 12px; align-items: center; }
    .pie-chart {
      width: 180px;
      height: 180px;
      border-radius: 50%;
      border: 1px solid rgba(21, 82, 112, 0.18);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.52), 0 8px 18px rgba(16, 53, 76, 0.08);
      position: relative;
      margin: 0 auto;
    }
    .pie-hole {
      position: absolute;
      inset: 32px;
      border-radius: 50%;
      border: 1px solid rgba(21, 82, 112, 0.14);
      background: rgba(255, 255, 255, 0.95);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 10px;
    }
    .pie-hole strong { font-size: 17px; color: #11364e; letter-spacing: -0.01em; }
    .pie-hole span { margin-top: 2px; font-size: 11px; color: var(--muted); line-height: 1.35; }
    .pie-legend { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
    .pie-legend li {
      display: grid;
      grid-template-columns: 10px minmax(0, 1fr) auto;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: #1a4259;
      border-bottom: 1px dashed rgba(22, 86, 116, 0.1);
      padding-bottom: 4px;
    }
    .pie-swatch { width: 10px; height: 10px; border-radius: 999px; }
    .pie-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pie-val { color: var(--muted); font-variant-numeric: tabular-nums; }
    @keyframes card-in {
      from { opacity: 0; transform: translateY(7px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes panel-in {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes status-pulse {
      0% { transform: scale(1); }
      50% { transform: scale(1.015); }
      100% { transform: scale(1); }
    }
    @keyframes status-bump {
      0% { transform: translateY(0); box-shadow: 0 0 0 rgba(0, 113, 227, 0); }
      30% { transform: translateY(-2px); box-shadow: 0 10px 24px rgba(0, 113, 227, 0.2); }
      100% { transform: translateY(0); box-shadow: 0 0 0 rgba(0, 113, 227, 0); }
    }
    @keyframes kpi-bump {
      0% { transform: translateY(0); box-shadow: 0 0 0 rgba(0, 113, 227, 0); }
      24% { transform: translateY(-2px); box-shadow: 0 14px 28px rgba(0, 113, 227, 0.16); }
      100% { transform: translateY(0); box-shadow: 0 0 0 rgba(0, 113, 227, 0); }
    }
    @media (max-width: 1600px) {
      .app-shell { grid-template-columns: 214px minmax(0, 1fr) 272px; gap: 16px; padding: 18px; }
      .section-title { font-size: 34px; }
      .overview-v3-shell { grid-template-columns: 1fr; }
      .overview-decision-grid { grid-template-columns: 1fr 1fr; }
      .overview-kpi-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      .task-hub-shell { grid-template-columns: 1fr; }
      .task-hub-grid { grid-template-columns: 1fr; }
      .task-hub-board-grid { grid-template-columns: 1fr; }
      .overview-busy-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .office-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .staff-brief-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .collaboration-summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 1320px) {
      .app-shell { grid-template-columns: 1fr 284px; }
      .app-shell > .sidebar:first-of-type { grid-column: 1 / -1; }
      .panel { grid-column: 1; }
      .section-hero-head { flex-direction: column; align-items: stretch; }
      .section-head-actions { justify-content: flex-start; }
      .overview-kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .overview-decision-grid { grid-template-columns: 1fr; }
      .overview-main-grid { grid-template-columns: 1fr; }
      .overview-pulse-card .status-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .task-hub-stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .timeline-summary-strip { grid-template-columns: 1fr; }
      .overview-busy-grid { grid-template-columns: 1fr; }
      .dashboard-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .execution-chain-list { grid-template-columns: 1fr; }
      .collaboration-thread-head { grid-template-columns: 1fr; }
      .collaboration-thread-badges { justify-items: start; }
      .collaboration-current-owner { text-align: left; }
      .collaboration-timeline-step { grid-template-columns: 1fr; }
      .file-workbench { grid-template-columns: 1fr; }
      .staff-brief-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 1080px) {
      .app-shell { grid-template-columns: 1fr; }
      .sidebar, .panel { order: unset; }
      .section-title { font-size: 25px; }
      .overview-v3-shell { grid-template-columns: 1fr; }
      .overview-kpi-grid { grid-template-columns: 1fr; }
      .overview-decision-grid { grid-template-columns: 1fr; }
      .overview-primary-value { font-size: 46px; }
      .overview-focus-stage { grid-template-columns: 1fr; }
      .overview-focus-ring { width: 104px; height: 104px; }
      .overview-focus-core { width: 72px; height: 72px; }
      .overview-focus-score { font-size: 24px; }
      .overview-main-grid { grid-template-columns: 1fr; }
      .overview-action-grid { grid-template-columns: 1fr; }
      .overview-task-strip { flex-direction: column; }
      .overview-quick-links { justify-content: flex-start; min-width: 0; }
      .task-hub-stat-grid { grid-template-columns: 1fr; }
      .task-hub-shell { grid-template-columns: 1fr; }
      .task-hub-grid { grid-template-columns: 1fr; }
      .task-hub-board-grid { grid-template-columns: 1fr; }
      .overview-pulse-card .status-strip { grid-template-columns: 1fr; }
      .dashboard-strip { grid-template-columns: 1fr; }
      .collaboration-summary-grid { grid-template-columns: 1fr; }
      .collaboration-route-avatars { flex-wrap: wrap; }
      .collaboration-avatar { width: 54px; max-width: 54px; }
      .signal-gauge-main { grid-template-columns: 64px minmax(0, 1fr); }
      .office-grid { grid-template-columns: 1fr; }
      .staff-brief-head { grid-template-columns: 1fr; }
      .staff-avatar { width: min(156px, 100%); }
      .staff-brief-grid { grid-template-columns: 1fr; }
      table { min-width: 720px; }
      .global-visibility-card .ops-board { min-width: 900px; }
      .pie-wrap { grid-template-columns: 1fr; }
      .office-head { grid-template-columns: 1fr; }
      .agent-avatar { max-width: 180px; }
      .memory-row { grid-template-columns: 1fr; }
      .docs-toolbar { grid-template-columns: 1fr; }
      .file-editor-head { flex-direction: column; }
      .file-editor-panel { grid-template-rows: auto minmax(280px, 1fr) auto; }
      .file-editor-textarea { min-height: 360px; }
    }
    @media (prefers-reduced-motion: reduce) {
      * {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
      }
    }
  </style>
</head>
<body class="ui-preload" data-ui-polish="apple-native-v3" data-apple-window-controls="true" data-ui-language="${escapeHtml(options.language)}" style="--fold-open-label:${options.language === "en" ? "'Expand'" : "'展开'"}; --fold-close-label:${options.language === "en" ? "'Collapse'" : "'收起'"};">
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-kicker">OpenClaw</div>
        <h1>OpenClaw Control Center</h1>
        <div class="meta">${escapeHtml(t("Updated", "更新时间"))}${escapeHtml(options.language === "en" ? ": " : "：")}${escapeHtml(snapshot.generatedAt ?? t("Not available", "暂无"))}</div>
        ${languageToggle}
      </div>
      <nav class="nav-links">${sectionNav}</nav>
    </aside>
    <main class="panel">
      <header class="section-hero-head">
        <div class="section-head-copy">
          <h2 class="section-title">${escapeHtml(sectionTitle)}</h2>
          <div class="section-blurb">${escapeHtml(sectionLeadText)}</div>
        </div>
        <div class="section-head-actions">
          <button id="inspector-toggle" type="button" class="panel-toggle" aria-pressed="false">${escapeHtml(t("Collapse inspector", "收起检视栏"))}</button>
        </div>
      </header>
      <div class="content-stack">${globalVisibilityBlock}${sectionBody}</div>
    </main>
    <aside class="sidebar inspector-sidebar">
      <div class="card">
        <h2>${escapeHtml(t("Current status", "当前状态"))}</h2>
        <div class="meta">${escapeHtml(t("Active sessions", "活跃会话"))}：${liveSessionCount}</div>
        <div class="meta">${escapeHtml(t("Tasks under watch", "正在观察中的任务"))}：${taskCertaintyCards.length}</div>
        <div class="meta">${escapeHtml(t("Review queue", "审阅队列"))}：${pendingDecisionCount}</div>
        ${sidebarSignalRows}
      </div>
      <div class="card" style="margin-top:10px;">
        <h2>${escapeHtml(t("Usage and subscription summary", "用量与订阅摘要"))}</h2>
        <div class="meta">${escapeHtml(t("Today's AI usage", "今日 AI 用量"))}：${
          usageToday?.sourceStatus === "not_connected"
            ? t("Data source not connected", "数据源未连接")
            : formatInt(usageToday?.tokens ?? 0)
        }</div>
        <div class="meta">${escapeHtml(t("Today's cost", "今日费用"))}：${
          usageToday?.sourceStatus === "not_connected"
            ? t("Data source not connected", "数据源未连接")
            : formatCurrency(usageToday?.estimatedCost ?? 0)
        }</div>
        <div class="meta">${escapeHtml(t("Last 30 days", "近 30 天"))}：${
          usage30d?.sourceStatus === "not_connected"
            ? t("Data source not connected", "数据源未连接")
            : formatCurrency(usage30d?.estimatedCost ?? 0)
        }</div>
        ${subscriptionSidebarRows}
        <div class="meta"><a href="${escapeHtml(usageDetailHref)}">${escapeHtml(t("Open full usage and subscription view", "查看完整用量与订阅"))}</a></div>
      </div>
      <div class="card" style="margin-top:10px;">
        <h2>${escapeHtml(t("Currently active agents", "当前活跃智能体"))}</h2>
        <ul class="story-list">${executionAgentRows || `<li>${escapeHtml(t("No active agent signal yet.", "暂无活跃智能体信号。"))}</li>`}</ul>
      </div>
      <section class="card" style="margin-top:10px;">
        <h2>${escapeHtml(t("Timed jobs and heartbeat", "定时与心跳"))}</h2>
        <div class="meta">${escapeHtml(t("Timed jobs", "定时"))} ${badge(cronOverview.health.status)} · ${escapeHtml(t("Next", "下次"))} ${escapeHtml(cronOverview.nextRunAt ?? t("None", "暂无"))}</div>
        <div class="meta">${escapeHtml(t("Heartbeat", "心跳"))} ${badge(heartbeatHealth)} · ${escapeHtml(t("Next", "下次"))} ${escapeHtml(heartbeatNextRun)}</div>
        <div class="meta"><a href="/?section=overview#cron-health">${escapeHtml(t("Open timed jobs", "查看定时任务"))}</a> · <a href="/?section=overview#heartbeat-health">${escapeHtml(t("Open heartbeat checks", "查看任务心跳"))}</a></div>
      </section>
    </aside>
  </div>
  ${agentVisualEnhancerScript}
  ${fileWorkbenchScript}
  ${nativeMotionScript}
  ${collaborationFilterScript}
  ${quotaResetScript}
</body>
</html>`;
}

function parseTaskFilters(searchParams: URLSearchParams, strict: boolean): TaskQueryFilters {
  assertAllowedQueryParams(searchParams, ["quick", "status", "owner", "project"], strict);
  const filters: TaskQueryFilters = {};

  const quick = normalizeQueryString(searchParams.get("quick"), "quick", 20, strict);
  if (quick) {
    if (isUiQuickFilter(quick)) {
      filters.quick = quick;
    } else if (strict) {
      throw new RequestValidationError(
        "quick must be one of: all, attention, todo, in_progress, blocked, done",
        400,
      );
    }
  }

  const status = normalizeQueryString(searchParams.get("status"), "status", 30, strict);
  if (status) {
    if (TASK_STATES.includes(status as TaskState)) {
      filters.status = status as TaskState;
    } else if (strict) {
      throw new RequestValidationError("status must be one of: todo, in_progress, blocked, done", 400);
    }
  }

  const owner = normalizeQueryString(searchParams.get("owner"), "owner", 80, strict);
  if (owner) filters.owner = owner;

  const project = normalizeQueryString(searchParams.get("project"), "project", 120, strict);
  if (project) filters.project = project;

  return filters;
}

function parseProjectFilters(searchParams: URLSearchParams, strict: boolean): ProjectQueryFilters {
  assertAllowedQueryParams(searchParams, ["status", "owner", "projectId"], strict);
  const filters: ProjectQueryFilters = {};
  const status = normalizeQueryString(searchParams.get("status"), "status", 30, strict);
  if (status) {
    if (PROJECT_STATES.includes(status as ProjectState)) {
      filters.status = status as ProjectState;
    } else if (strict) {
      throw new RequestValidationError("status must be one of: planned, active, blocked, done", 400);
    }
  }

  const owner = normalizeQueryString(searchParams.get("owner"), "owner", 80, strict);
  if (owner) filters.owner = owner;
  const projectId = normalizeQueryString(searchParams.get("projectId"), "projectId", 120, strict);
  if (projectId) filters.projectId = projectId;

  return filters;
}

function parseSessionQuery(searchParams: URLSearchParams, strict: boolean): SessionQuery {
  assertAllowedQueryParams(searchParams, ["state", "agentId", "q", "page", "pageSize", "historyLimit"], strict);
  const filters: SessionConversationFilters = {};
  const state = normalizeQueryString(searchParams.get("state"), "state", 40, strict);
  if (state) {
    if (SESSION_STATES.includes(state as AgentRunState)) {
      filters.state = state as AgentRunState;
    } else if (strict) {
      throw new RequestValidationError(
        "state must be one of: idle, running, blocked, waiting_approval, error",
        400,
      );
    }
  }

  const agentId = normalizeQueryString(searchParams.get("agentId"), "agentId", 120, strict);
  if (agentId) filters.agentId = agentId;

  const q = normalizeQueryString(searchParams.get("q"), "q", 160, strict);
  if (q) filters.q = q;

  return {
    filters,
    page: readPositiveIntQuery(searchParams.get("page"), "page", 1, strict),
    pageSize: readPositiveIntQuery(searchParams.get("pageSize"), "pageSize", 12, strict, 100),
    historyLimit: readPositiveIntQuery(searchParams.get("historyLimit"), "historyLimit", 8, strict, 200),
  };
}

function parseAuditSeverity(searchParams: URLSearchParams, strict: boolean): AuditSeverity | "all" {
  assertAllowedQueryParams(searchParams, ["severity"], strict);
  const value = normalizeQueryString(searchParams.get("severity"), "severity", 30, strict);
  if (!value) return "all";
  if (value === "all" || value === "info" || value === "warn" || value === "action-required" || value === "error") {
    return value;
  }

  if (strict) {
    throw new RequestValidationError(
      "severity must be one of: all, info, warn, action-required, error",
      400,
    );
  }

  return "all";
}

function parseSearchQuery(searchParams: URLSearchParams): SearchQuery {
  assertAllowedQueryParams(searchParams, ["q", "limit"], true);
  const q = normalizeQueryString(searchParams.get("q"), "q", 180, true);
  if (!q) {
    throw new RequestValidationError("q is required and must be non-empty.", 400);
  }

  return {
    q,
    limit: readPositiveIntQuery(searchParams.get("limit"), "limit", 20, true, SEARCH_LIMIT_MAX),
  };
}

function parseReplayWindowQuery(
  searchParams: URLSearchParams,
  strict: boolean,
): { from?: string; to?: string } {
  const from = normalizeQueryString(searchParams.get("from"), "from", 64, strict);
  const to = normalizeQueryString(searchParams.get("to"), "to", 64, strict);

  const fromMs = from ? Date.parse(from) : NaN;
  const toMs = to ? Date.parse(to) : NaN;
  if (from && Number.isNaN(fromMs)) {
    throw new RequestValidationError("from must be a valid ISO date-time string.", 400);
  }
  if (to && Number.isNaN(toMs)) {
    throw new RequestValidationError("to must be a valid ISO date-time string.", 400);
  }
  if (from && to && fromMs > toMs) {
    throw new RequestValidationError("from must be less than or equal to to.", 400);
  }

  return {
    from: from ? new Date(fromMs).toISOString() : undefined,
    to: to ? new Date(toMs).toISOString() : undefined,
  };
}

function safeSubstringMatch(query: string, ...fields: Array<string | undefined>): boolean {
  const needle = query.toLowerCase();
  if (!needle) return false;
  return fields.some((field) => typeof field === "string" && field.toLowerCase().includes(needle));
}

function buildBoundedSearchResult<T>(items: T[], limit: number): {
  count: number;
  returned: number;
  items: T[];
} {
  const sliced = items.slice(0, limit);
  return {
    count: items.length,
    returned: sliced.length,
    items: sliced,
  };
}

function resolveDashboardSearchQuery(searchParams: URLSearchParams): DashboardSearchQuery {
  const q = normalizeQueryString(searchParams.get("search_q"), "search_q", 180, false) ?? "";
  const rawScope = normalizeQueryString(searchParams.get("search_scope"), "search_scope", 20, false);
  const scope = DASHBOARD_SEARCH_SCOPES.includes(rawScope as DashboardSearchScope)
    ? (rawScope as DashboardSearchScope)
    : "tasks";
  const limit = readPositiveIntQuery(searchParams.get("search_limit"), "search_limit", 20, false, SEARCH_LIMIT_MAX);
  return {
    scope,
    q,
    limit,
  };
}

export function resolveDashboardSection(searchParams: URLSearchParams): DashboardSection {
  const value = normalizeQueryString(searchParams.get("section"), "section", 40, false);
  if (!value) return "overview";
  if (value === "calendar") return "projects-tasks";
  if (value === "alerts" || value === "replay-audit") return "overview";
  return DASHBOARD_SECTIONS.includes(value as DashboardSection) ? (value as DashboardSection) : "overview";
}

function resolveLegacyDashboardSection(path: string): DashboardSection | undefined {
  const section = LEGACY_DASHBOARD_ROUTE_SECTION[path as keyof typeof LEGACY_DASHBOARD_ROUTE_SECTION];
  return section;
}

function resolveLegacyDashboardAnchor(path: string): string | undefined {
  return LEGACY_DASHBOARD_ROUTE_ANCHOR[path as keyof typeof LEGACY_DASHBOARD_ROUTE_ANCHOR];
}

export function resolveLegacyDashboardSectionForSmoke(path: string): DashboardSection | undefined {
  return resolveLegacyDashboardSection(path);
}

function buildDashboardSearchResult(
  snapshot: ReadModelSnapshot,
  query: DashboardSearchQuery,
): DashboardSearchResult | undefined {
  if (!query.q) return undefined;

  if (query.scope === "tasks") {
    const result = buildBoundedSearchResult(
      listTasks(snapshot.tasks, projectTitleMap(snapshot))
      .filter((task) =>
        safeSubstringMatch(
          query.q,
          task.taskId,
          task.title,
          task.owner,
          task.projectId,
          task.projectTitle,
          task.status,
          task.dueAt,
        ),
      ),
      query.limit,
    );
    const items = result.items;
    const rows =
      items.length === 0
        ? "<tr><td colspan=\"6\">未找到匹配任务。</td></tr>"
        : items
            .map(
              (item) =>
                `<tr><td><code>${escapeHtml(item.taskId)}</code></td><td>${escapeHtml(item.title)}</td><td>${badge(item.status)}</td><td>${escapeHtml(item.owner)}</td><td>${escapeHtml(item.projectTitle)}</td><td>${escapeHtml(item.updatedAt)}</td></tr>`,
            )
            .join("");
    return {
      scope: query.scope,
      q: query.q,
      limit: query.limit,
      count: result.count,
      returned: result.returned,
      rows: `<table style="margin-top:8px;"><thead><tr><th>任务 ID</th><th>标题</th><th>状态</th><th>智能体</th><th>项目</th><th>更新时间</th></tr></thead><tbody>${rows}</tbody></table>`,
    };
  }

  if (query.scope === "projects") {
    const result = buildBoundedSearchResult(
      snapshot.projects.projects
      .filter((project) =>
        safeSubstringMatch(query.q, project.projectId, project.title, project.owner, project.status),
      ),
      query.limit,
    );
    const items = result.items;
    const rows =
      items.length === 0
        ? "<tr><td colspan=\"5\">未找到匹配项目。</td></tr>"
        : items
            .map(
              (item) =>
                `<tr><td><code>${escapeHtml(item.projectId)}</code></td><td>${escapeHtml(item.title)}</td><td>${badge(item.status)}</td><td>${escapeHtml(item.owner)}</td><td>${escapeHtml(item.updatedAt)}</td></tr>`,
            )
            .join("");
    return {
      scope: query.scope,
      q: query.q,
      limit: query.limit,
      count: result.count,
      returned: result.returned,
      rows: `<table style="margin-top:8px;"><thead><tr><th>项目 ID</th><th>标题</th><th>状态</th><th>智能体</th><th>更新时间</th></tr></thead><tbody>${rows}</tbody></table>`,
    };
  }

  if (query.scope === "sessions") {
    const result = buildBoundedSearchResult(
      snapshot.sessions
      .filter((session) =>
        safeSubstringMatch(
          query.q,
          session.sessionKey,
          session.label,
          session.agentId,
          session.state,
          session.lastMessageAt,
        ),
      ),
      query.limit,
    );
    const items = result.items;
    const rows =
      items.length === 0
        ? "<tr><td colspan=\"5\">未找到匹配会话。</td></tr>"
        : items
            .map(
              (item) =>
                `<tr><td><code>${escapeHtml(item.sessionKey)}</code></td><td>${badge(item.state)}</td><td>${escapeHtml(item.agentId ?? "-")}</td><td>${escapeHtml(item.label ?? "-")}</td><td>${escapeHtml(item.lastMessageAt ?? "-")}</td></tr>`,
            )
            .join("");
    return {
      scope: query.scope,
      q: query.q,
      limit: query.limit,
      count: result.count,
      returned: result.returned,
      rows: `<table style="margin-top:8px;"><thead><tr><th>会话</th><th>状态</th><th>助手</th><th>标签</th><th>最后活动</th></tr></thead><tbody>${rows}</tbody></table>`,
    };
  }

  const result = buildBoundedSearchResult(
    commanderExceptionsFeed(snapshot).items.filter((item) =>
      safeSubstringMatch(query.q, item.level, item.code, item.source, item.sourceId, item.route, item.message),
    ),
    query.limit,
  );
  const items = result.items;
  const rows =
    items.length === 0
      ? "<tr><td colspan=\"5\">未找到匹配告警。</td></tr>"
      : items
          .map(
            (item) =>
              `<tr><td>${badge(item.level)}</td><td>${escapeHtml(item.code)}</td><td><code>${escapeHtml(item.sourceId)}</code></td><td>${escapeHtml(item.route)}</td><td>${escapeHtml(item.message)}</td></tr>`,
          )
          .join("");
  return {
    scope: query.scope,
    q: query.q,
    limit: query.limit,
    count: result.count,
    returned: result.returned,
    rows: `<table style="margin-top:8px;"><thead><tr><th>级别</th><th>代码</th><th>来源</th><th>路由</th><th>信息</th></tr></thead><tbody>${rows}</tbody></table>`,
  };
}

function renderDashboardSearchResult(
  result: DashboardSearchResult | undefined,
  language: UiLanguage = "zh",
): string {
  if (!result) {
    return `<div class="meta" style="margin-top:8px;">${escapeHtml(
      pickUiText(language, "Enter a keyword to search by scope.", "输入关键词后可按范围搜索。"),
    )}</div>`;
  }
  const summary =
    result.count > result.returned
      ? pickUiText(
          language,
          `Scope: ${searchScopeLabel(result.scope, language)} · Keyword: ${result.q} · Showing ${result.returned} of ${result.count} matches`,
          `范围：${searchScopeLabel(result.scope, language)} · 关键词：${result.q} · 当前显示 ${result.returned}/${result.count} 条命中`,
        )
      : pickUiText(
          language,
          `Scope: ${searchScopeLabel(result.scope, language)} · Keyword: ${result.q} · Matches: ${result.count}`,
          `范围：${searchScopeLabel(result.scope, language)} · 关键词：${result.q} · 命中：${result.count}`,
        );
  return `<div class="meta" style="margin-top:8px;">${escapeHtml(summary)}</div>${result.rows}`;
}

export function buildDashboardSearchResultForSmoke(
  snapshot: ReadModelSnapshot,
  query: DashboardSearchQuery,
): DashboardSearchResult | undefined {
  return buildDashboardSearchResult(snapshot, query);
}

function resolveDashboardTaskFilters(
  searchParams: URLSearchParams,
  preferences: UiPreferences,
): TaskQueryFilters {
  const incoming = parseTaskFilters(searchParams, false);
  if (hasAnyQueryKey(searchParams, ["quick", "status", "owner", "project"])) {
    return {
      quick: incoming.quick ?? "all",
      status: incoming.status,
      owner: incoming.owner,
      project: incoming.project,
    };
  }

  return {
    quick: preferences.quickFilter,
    status: preferences.taskFilters.status,
    owner: preferences.taskFilters.owner,
    project: preferences.taskFilters.project,
  };
}

function resolveCompactStatusStrip(searchParams: URLSearchParams, fallback: boolean): boolean {
  const compact = normalizeQueryString(searchParams.get("compact"), "compact", 8, false);
  if (!compact) return fallback;
  if (compact === "1" || compact.toLowerCase() === "true" || compact.toLowerCase() === "on") return true;
  if (compact === "0" || compact.toLowerCase() === "false" || compact.toLowerCase() === "off") return false;
  return fallback;
}

function resolveUsageView(searchParams: URLSearchParams): UsageView {
  const usageView = normalizeQueryString(searchParams.get("usage_view"), "usage_view", 16, false);
  return usageView === "today" ? "today" : "cumulative";
}

function resolveUiLanguage(searchParams: URLSearchParams, fallback: UiLanguage): UiLanguage {
  const raw = normalizeQueryString(searchParams.get("lang"), "lang", 8, false);
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  return isUiLanguage(normalized) ? normalized : fallback;
}

function mergeUiPreferencesPatch(current: UiPreferences, payload: Record<string, unknown>): UiPreferences {
  const next: UiPreferences = {
    language: current.language,
    compactStatusStrip: current.compactStatusStrip,
    quickFilter: current.quickFilter,
    taskFilters: { ...current.taskFilters },
    updatedAt: new Date().toISOString(),
  };

  if (payload.language !== undefined) {
    if (typeof payload.language !== "string") {
      throw new RequestValidationError("language must be a string.", 400);
    }
    const normalizedLanguage = payload.language.trim().toLowerCase();
    if (!isUiLanguage(normalizedLanguage)) {
      throw new RequestValidationError("language must be one of: en, zh", 400);
    }
    next.language = normalizedLanguage;
  }

  if (payload.compactStatusStrip !== undefined) {
    if (typeof payload.compactStatusStrip !== "boolean") {
      throw new RequestValidationError("compactStatusStrip must be a boolean.", 400);
    }
    next.compactStatusStrip = payload.compactStatusStrip;
  }

  if (payload.quickFilter !== undefined) {
    if (typeof payload.quickFilter !== "string") {
      throw new RequestValidationError("quickFilter must be a string.", 400);
    }
    const quick = payload.quickFilter.trim();
    if (!isUiQuickFilter(quick)) {
      throw new RequestValidationError(
        "quickFilter must be one of: all, attention, todo, in_progress, blocked, done",
        400,
      );
    }
    next.quickFilter = quick;
  }

  if (payload.taskFilters !== undefined) {
    const filtersObj = asObject(payload.taskFilters);
    if (!filtersObj) {
      throw new RequestValidationError("taskFilters must be an object.", 400);
    }

    if (filtersObj.status !== undefined) {
      if (filtersObj.status === null || filtersObj.status === "") {
        next.taskFilters.status = undefined;
      } else if (typeof filtersObj.status === "string" && TASK_STATES.includes(filtersObj.status as TaskState)) {
        next.taskFilters.status = filtersObj.status as TaskState;
      } else {
        throw new RequestValidationError("taskFilters.status must be one of: todo, in_progress, blocked, done", 400);
      }
    }

    if (filtersObj.owner !== undefined) {
      next.taskFilters.owner = normalizeOptionalPatchString(filtersObj.owner, "taskFilters.owner", 80);
    }

    if (filtersObj.project !== undefined) {
      next.taskFilters.project = normalizeOptionalPatchString(filtersObj.project, "taskFilters.project", 120);
    }
  }

  return next;
}

function applyTaskFilters(tasks: TaskListItem[], filters: TaskQueryFilters): TaskListItem[] {
  const now = Date.now();
  return tasks.filter((task) => {
    if (filters.quick && !matchesQuickFilter(task, filters.quick, now)) return false;
    if (filters.status && task.status !== filters.status) return false;
    if (filters.owner && task.owner.toLowerCase() !== filters.owner.toLowerCase()) return false;
    if (filters.project && task.projectId.toLowerCase() !== filters.project.toLowerCase()) return false;
    return true;
  });
}

function applyProjectFilters(
  projects: ReadModelSnapshot["projects"]["projects"],
  filters: ProjectQueryFilters,
): ReadModelSnapshot["projects"]["projects"] {
  return projects.filter((project) => {
    if (filters.status && project.status !== filters.status) return false;
    if (filters.owner && project.owner.toLowerCase() !== filters.owner.toLowerCase()) return false;
    if (filters.projectId && project.projectId.toLowerCase() !== filters.projectId.toLowerCase()) return false;
    return true;
  });
}

function buildLinkageGraph(snapshot: ReadModelSnapshot): LinkageGraph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const sessionByKey = new Map(snapshot.sessions.map((session) => [session.sessionKey, session]));

  for (const project of snapshot.projects.projects) {
    addGraphNode(nodes, {
      id: `project:${project.projectId}`,
      type: "project",
      label: project.title,
      status: project.status,
    });
  }

  for (const task of snapshot.tasks.tasks) {
    const taskNodeId = `task:${task.projectId}:${task.taskId}`;
    addGraphNode(nodes, {
      id: taskNodeId,
      type: "task",
      label: task.title,
      status: task.status,
    });

    addGraphEdge(edges, {
      id: `project_task:${task.projectId}:${task.taskId}`,
      from: `project:${task.projectId}`,
      to: taskNodeId,
      type: "project_task",
    });

    for (const sessionKey of task.sessionKeys) {
      const session = sessionByKey.get(sessionKey);
      addGraphNode(nodes, {
        id: `session:${sessionKey}`,
        type: "session",
        label: session?.label ?? sessionKey,
        status: session?.state ?? "unknown",
      });

      addGraphEdge(edges, {
        id: `task_session:${task.projectId}:${task.taskId}:${sessionKey}`,
        from: taskNodeId,
        to: `session:${sessionKey}`,
        type: "task_session",
      });

      addGraphEdge(edges, {
        id: `project_session:${task.projectId}:${sessionKey}`,
        from: `project:${task.projectId}`,
        to: `session:${sessionKey}`,
        type: "project_session",
      });
    }
  }

  for (const session of snapshot.sessions) {
    addGraphNode(nodes, {
      id: `session:${session.sessionKey}`,
      type: "session",
      label: session.label ?? session.sessionKey,
      status: session.state,
    });

    if (session.agentId) {
      addGraphNode(nodes, {
        id: `agent:${session.agentId}`,
        type: "agent",
        label: session.agentId,
      });
      addGraphEdge(edges, {
        id: `agent_session:${session.agentId}:${session.sessionKey}`,
        from: `agent:${session.agentId}`,
        to: `session:${session.sessionKey}`,
        type: "agent_session",
      });
    }
  }

  const nodeValues = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  const edgeValues = [...edges.values()].sort((a, b) => a.id.localeCompare(b.id));

  return {
    generatedAt: new Date().toISOString(),
    nodes: nodeValues,
    edges: edgeValues,
    counts: {
      nodes: nodeValues.length,
      edges: edgeValues.length,
      projects: nodeValues.filter((node) => node.type === "project").length,
      tasks: nodeValues.filter((node) => node.type === "task").length,
      sessions: nodeValues.filter((node) => node.type === "session").length,
      agents: nodeValues.filter((node) => node.type === "agent").length,
    },
  };
}

function addGraphNode(target: Map<string, GraphNode>, node: GraphNode): void {
  if (target.has(node.id)) return;
  target.set(node.id, node);
}

function addGraphEdge(target: Map<string, GraphEdge>, edge: GraphEdge): void {
  if (target.has(edge.id)) return;
  target.set(edge.id, edge);
}

function normalizeDocCategoryKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

function extractDateFromName(value: string): string | undefined {
  const match = value.match(/(20\d{2}-\d{2}-\d{2})/);
  return match ? match[1] : undefined;
}

function toPlainSummary(input: string, maxLength: number): string {
  const compact = input
    .replace(/`{1,3}[^`]*`{1,3}/g, " ")
    .replace(/[#>*_\-\[\]\(\)!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return "暂无摘要。";
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1)}…`;
}

function extractMarkdownHeading(input: string): string | undefined {
  const line = input
    .split(/\r?\n/)
    .map((row) => row.trim())
    .find((row) => row.startsWith("#"));
  if (!line) return undefined;
  return line.replace(/^#+\s*/, "").trim() || undefined;
}

async function safeReadTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function normalizeEvidenceText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[`*_#>\[\]\(\)!|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLabeledField(input: string, labels: string[]): string | undefined {
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.replace(/\*\*/g, "").replace(/`/g, "").trim().replace(/^[-*]\s*/, "");
    if (!line) continue;
    const lower = line.toLowerCase();
    for (const label of labels) {
      const prefix = `${label.toLowerCase()}:`;
      if (!lower.startsWith(prefix)) continue;
      const value = line.slice(prefix.length).trim();
      if (value) return value;
    }
  }
  return undefined;
}

function resolveStaffWorkspaceRoot(member: TeamMemberSnapshot): string {
  const key = normalizeLookupKey(member.agentId);
  if (key === "main") return OPENCLAW_WORKSPACE_ROOT;
  const workspace = member.workspace.trim();
  if (workspace && workspace !== "未标注" && workspace !== "unlisted") {
    return resolve(OPENCLAW_CONFIG_DIR, workspace);
  }
  return join(OPENCLAW_WORKSPACE_ROOT, "agents", member.agentId);
}

async function loadStaffRoleEvidence(member: TeamMemberSnapshot): Promise<string[]> {
  const output: string[] = [];
  const workspaceRoot = resolveStaffWorkspaceRoot(member);
  for (const fileName of STAFF_ROLE_EVIDENCE_FILE_CANDIDATES) {
    const raw = await safeReadTextFile(join(workspaceRoot, fileName));
    if (raw?.trim()) output.push(raw);
  }
  const openclawConfig = await safeReadTextFile(OPENCLAW_CONFIG_PATH);
  if (openclawConfig?.trim()) output.push(openclawConfig);
  for (const candidate of OPENCLAW_CRON_JOBS_CANDIDATES) {
    const cronJobs = await safeReadTextFile(candidate);
    if (cronJobs?.trim()) {
      output.push(cronJobs);
      break;
    }
  }
  return output;
}

async function resolveStaffRoleLabel(member: TeamMemberSnapshot, language: UiLanguage = "zh"): Promise<string> {
  const roleEvidence = await loadStaffRoleEvidence(member);
  const combined = roleEvidence.join("\n");
  const normalized = normalizeEvidenceText(combined);
  const explicitRole =
    roleEvidence
      .map((entry) => extractLabeledField(entry, ["Role", "职责", "角色"]))
      .find((value) => value && value.trim().length > 0) ?? "";
  const explicitMission =
    roleEvidence
      .map((entry) => extractLabeledField(entry, ["Mission", "任务", "目标"]))
      .find((value) => value && value.trim().length > 0) ?? "";
  const key = normalizeLookupKey(member.agentId);

  if (
    key === "monkey" &&
    (normalized.includes("youtube-to-article") ||
      combined.includes("把 YouTube 视频转成增值长文章") ||
      combined.includes("YouTube 视频转成增值长文章"))
  ) {
    return pickUiText(language, "YouTube to article writing", "YouTube 视频转长文");
  }

  if (
    key === "dolphin" &&
    (normalized.includes("value_add_creator") ||
      combined.includes("高价值、可直接发布的最终内容") ||
      combined.includes("增值型创作者"))
  ) {
    return pickUiText(language, "High-value content creation", "高价值内容创作");
  }

  if (
    key === "pandas" &&
    (normalized.includes("control-center project end-to-end") ||
      normalized.includes("control center project end to end") ||
      combined.includes("控制中心") ||
      combined.includes("唯一主任务"))
  ) {
    return pickUiText(language, "Control Center delivery", "控制中心开发与交付");
  }

  if (
    key === "coq" &&
    (combined.includes("Coq-每日新闻") ||
      normalized.includes("morning research") ||
      normalized.includes("trend report") ||
      combined.includes("每日报告"))
  ) {
    return pickUiText(language, "Daily news and trend briefings", "每日情报与趋势简报");
  }

  if (
    key === "otter" &&
    (combined.includes("晨报") ||
      combined.includes("邮箱提醒") ||
      normalized.includes("calendar") ||
      normalized.includes("weather") ||
      normalized.includes("assistant"))
  ) {
    return pickUiText(language, "Personal assistance and reminders", "私人助理与提醒");
  }

  if (
    key === "tiger" &&
    (normalized.includes("tiger-security") ||
      normalized.includes("security-audit") ||
      normalized.includes("update-status") ||
      (normalized.includes("security") && normalized.includes("update")) ||
      (combined.includes("安全") && combined.includes("更新")))
  ) {
    return pickUiText(language, "Security and updates", "安全和更新");
  }

  if (
    key === "main" &&
    (combined.includes("Lion") ||
      normalized.includes("lion bot account") ||
      normalized.includes("assistant name: lion") ||
      combined.includes("指挥官"))
  ) {
    return pickUiText(language, "Main control and coordination", "主控与协调");
  }

  if (key === "codex" || normalized.includes("codex")) {
    return pickUiText(language, "Coding automation", "自动化编码执行");
  }

  const explicit = `${explicitRole} ${explicitMission}`.trim();
  if (
    explicit &&
    (normalizeEvidenceText(explicit).includes("youtube") || normalizeEvidenceText(explicit).includes("article"))
  ) {
    return pickUiText(language, "YouTube to article writing", "YouTube 视频转长文");
  }
  if (explicit && (normalizeEvidenceText(explicit).includes("control-center") || explicit.includes("控制中心"))) {
    return pickUiText(language, "Control Center delivery", "控制中心开发与交付");
  }
  if (explicit && (normalizeEvidenceText(explicit).includes("creator") || explicit.includes("创作"))) {
    return pickUiText(language, "High-value content creation", "高价值内容创作");
  }

  return pickUiText(language, "Role not defined in workspace", "工作区未写明职责");
}

async function listFileEntries(dir: string): Promise<Array<{ name: string; path: string; updatedAt: string; size: number }>> {
  try {
    const rows = await readdir(dir, { withFileTypes: true });
    const files = rows.filter((row) => row.isFile());
    const result: Array<{ name: string; path: string; updatedAt: string; size: number }> = [];
    for (const file of files) {
      const fullPath = join(dir, file.name);
      try {
        const meta = await stat(fullPath);
        result.push({
          name: file.name,
          path: fullPath,
          updatedAt: meta.mtime.toISOString(),
          size: meta.size,
        });
      } catch {
        continue;
      }
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

function normalizeEditableFileScope(value: string | undefined): EditableFileScope | undefined {
  if (value === "memory" || value === "workspace") return value;
  return undefined;
}

async function buildEditableFileEntry(input: {
  scope: EditableFileScope;
  category: string;
  sourcePath: string;
  relativeBase?: string;
  facetKey?: string;
  facetLabel?: string;
}): Promise<EditableFileEntry | undefined> {
  try {
    const meta = await stat(input.sourcePath);
    if (!meta.isFile() || meta.size > EDITABLE_TEXT_FILE_MAX_BYTES) return undefined;
    const raw = await safeReadTextFile(input.sourcePath);
    if (raw === undefined) return undefined;
    const relativePath = input.relativeBase
      ? relative(input.relativeBase, input.sourcePath) || basename(input.sourcePath)
      : basename(input.sourcePath);
    return {
      scope: input.scope,
      title: basename(input.sourcePath) || relativePath,
      excerpt: toPlainSummary(raw, 160),
      category: input.category,
      sourcePath: input.sourcePath,
      relativePath,
      updatedAt: meta.mtime.toISOString(),
      size: meta.size,
      facetKey: input.facetKey,
      facetLabel: input.facetLabel,
    };
  } catch {
    return undefined;
  }
}

async function walkWorkspaceMarkdownFiles(root: string, currentDir = root): Promise<string[]> {
  try {
    const rows = await readdir(currentDir, { withFileTypes: true });
    const output: string[] = [];
    for (const row of rows) {
      const fullPath = join(currentDir, row.name);
      if (row.isDirectory()) {
        if (WORKSPACE_EDITABLE_SKIP_DIRS.has(row.name)) continue;
        output.push(...(await walkWorkspaceMarkdownFiles(root, fullPath)));
        continue;
      }
      if (!row.isFile()) continue;
      const ext = extname(row.name).toLowerCase();
      if (!WORKSPACE_EDITABLE_EXTENSIONS.has(ext)) continue;
      output.push(fullPath);
    }
    return output;
  } catch {
    return [];
  }
}

async function listEditableMemoryFiles(): Promise<EditableFileEntry[]> {
  const output: EditableFileEntry[] = [];
  const seen = new Set<string>();
  const mainFacetKey = "main";
  const mainFacetLabel = "Main";
  const agentScopes = await loadEditableAgentScopes();

  const append = async (entry: EditableFileEntry | undefined): Promise<void> => {
    if (!entry) return;
    const key = `${entry.facetKey ?? ""}::${resolve(entry.sourcePath)}`;
    if (seen.has(key)) return;
    seen.add(key);
    output.push(entry);
  };

  const mainRootFiles = [
    join(OPENCLAW_WORKSPACE_ROOT, "MEMORY.md"),
  ];
  for (const candidateFile of mainRootFiles) {
    await append(
      await buildEditableFileEntry({
        scope: "memory",
        category: "Main 长期记忆",
        sourcePath: candidateFile,
        relativeBase: OPENCLAW_WORKSPACE_ROOT,
        facetKey: mainFacetKey,
        facetLabel: mainFacetLabel,
      }),
    );
  }

  const mainMemoryDir = join(OPENCLAW_WORKSPACE_ROOT, "memory");
  const mainMemoryFiles = await listFileEntries(mainMemoryDir);
  for (const file of mainMemoryFiles) {
    const ext = extname(file.name).toLowerCase();
    if (!MEMORY_EDITABLE_EXTENSIONS.has(ext)) continue;
    await append(
      await buildEditableFileEntry({
        scope: "memory",
        category: "Main 记忆记录",
        sourcePath: file.path,
        relativeBase: OPENCLAW_WORKSPACE_ROOT,
        facetKey: mainFacetKey,
        facetLabel: mainFacetLabel,
      }),
    );
  }

  for (const scope of agentScopes) {
    if (scope.facetKey === "main") continue;
    const agentProfileFiles = ["MEMORY.md"];
    for (const fileName of agentProfileFiles) {
      await append(
        await buildEditableFileEntry({
          scope: "memory",
          category: `${scope.facetLabel} 长期记忆`,
          sourcePath: join(scope.workspaceRoot, fileName),
          relativeBase: OPENCLAW_WORKSPACE_ROOT,
          facetKey: scope.facetKey,
          facetLabel: scope.facetLabel,
        }),
      );
    }
    const agentMemoryDir = join(scope.workspaceRoot, "memory");
    const agentMemoryFiles = await listFileEntries(agentMemoryDir);
    for (const file of agentMemoryFiles) {
      const ext = extname(file.name).toLowerCase();
      if (!MEMORY_EDITABLE_EXTENSIONS.has(ext)) continue;
      await append(
        await buildEditableFileEntry({
          scope: "memory",
          category: `${scope.facetLabel} 记忆记录`,
          sourcePath: file.path,
          relativeBase: OPENCLAW_WORKSPACE_ROOT,
          facetKey: scope.facetKey,
          facetLabel: scope.facetLabel,
        }),
      );
    }
  }

  return output.sort(
    (a, b) =>
      (a.facetKey === "main" ? -1 : b.facetKey === "main" ? 1 : (a.facetLabel ?? "").localeCompare(b.facetLabel ?? "", "zh-Hans-CN")) ||
      b.updatedAt.localeCompare(a.updatedAt) ||
      a.relativePath.localeCompare(b.relativePath, "zh-Hans-CN"),
  );
}

async function listMemoryFacetOptions(): Promise<Array<{ key: string; label: string }>> {
  const scopes = await loadEditableAgentScopes();
  return scopes.map((scope) => ({ key: scope.facetKey, label: scope.facetLabel }));
}

async function listWorkspaceFacetOptions(): Promise<Array<{ key: string; label: string }>> {
  const scopes = await loadEditableAgentScopes();
  return scopes.map((scope) => ({ key: scope.facetKey, label: scope.facetLabel }));
}

async function listEditableWorkspaceFiles(): Promise<EditableFileEntry[]> {
  const output: EditableFileEntry[] = [];
  const seen = new Set<string>();
  const agentScopes = await loadEditableAgentScopes();

  const append = async (entry: EditableFileEntry | undefined): Promise<void> => {
    if (!entry) return;
    const key = `${entry.facetKey ?? ""}::${resolve(entry.sourcePath)}`;
    if (seen.has(key)) return;
    seen.add(key);
    output.push(entry);
  };

  for (const relativePath of SHARED_DOCUMENT_FILE_CANDIDATES) {
    await append(
      await buildEditableFileEntry({
        scope: "workspace",
        category: "Main 核心文档",
        sourcePath: join(OPENCLAW_WORKSPACE_ROOT, relativePath),
        relativeBase: OPENCLAW_WORKSPACE_ROOT,
        facetKey: "main",
        facetLabel: "Main",
      }),
    );
  }

  for (const scope of agentScopes) {
    if (scope.facetKey === "main") continue;
    for (const fileName of AGENT_DOCUMENT_FILE_CANDIDATES) {
      await append(
        await buildEditableFileEntry({
          scope: "workspace",
          category: `${scope.facetLabel} 核心文档`,
          sourcePath: join(scope.workspaceRoot, fileName),
          relativeBase: OPENCLAW_WORKSPACE_ROOT,
          facetKey: scope.facetKey,
          facetLabel: scope.facetLabel,
        }),
      );
    }
  }

  return output.sort((a, b) => {
    const facetA = a.facetLabel ?? "";
    const facetB = b.facetLabel ?? "";
    if (facetA !== facetB) {
      if (facetA === "Main") return -1;
      if (facetB === "Main") return 1;
      return facetA.localeCompare(facetB, "zh-Hans-CN");
    }
    const priority = documentFilePriority(a.relativePath) - documentFilePriority(b.relativePath);
    if (priority !== 0) return priority;
    return a.relativePath.localeCompare(b.relativePath, "zh-Hans-CN");
  });
}

function documentFilePriority(relativePath: string): number {
  const fileName = basename(relativePath).toLowerCase();
  const order = [
    "agents.md",
    "identity.md",
    "soul.md",
    "user.md",
    "tasks.md",
    "bootstrap.md",
    "heartbeat.md",
    "tools.md",
    "readme.md",
    "notebook.md",
    "focus.md",
    "inbox.md",
    "routines.md",
    "learnings.md",
  ];
  const index = order.indexOf(fileName);
  return index === -1 ? order.length + 1 : index;
}

async function listEditableFiles(scope: EditableFileScope): Promise<EditableFileEntry[]> {
  if (scope === "memory") return listEditableMemoryFiles();
  return listEditableWorkspaceFiles();
}

async function loadEditableAgentScopes(): Promise<EditableAgentScope[]> {
  const configured = await loadEditableAgentScopesFromConfig();
  if (configured.status === "configured" && configured.scopes.length > 0) {
    return configured.scopes;
  }
  if (configured.status === "config_invalid") {
    return [buildMainEditableAgentScope()];
  }
  return loadEditableAgentScopesFromWorkspaceDirs();
}

async function loadEditableAgentScopesFromConfig(): Promise<{
  status: EditableAgentScopeConfigStatus;
  scopes: EditableAgentScope[];
}> {
  const raw = await safeReadTextFile(OPENCLAW_CONFIG_PATH);
  if (!raw?.trim()) return { status: "config_missing", scopes: [] };
  try {
    const scopes = resolveEditableAgentScopesFromConfig(JSON.parse(raw) as unknown);
    return {
      status: scopes.length > 0 ? "configured" : "config_invalid",
      scopes: scopes.length > 0 ? scopes : [buildMainEditableAgentScope()],
    };
  } catch {
    return { status: "config_invalid", scopes: [buildMainEditableAgentScope()] };
  }
}

async function loadEditableAgentScopesFromWorkspaceDirs(): Promise<EditableAgentScope[]> {
  const output: EditableAgentScope[] = [buildMainEditableAgentScope()];
  const seen = new Set<string>(["main"]);
  const agentsRoot = join(OPENCLAW_WORKSPACE_ROOT, "agents");
  try {
    const agentDirs = await readdir(agentsRoot, { withFileTypes: true });
    for (const row of agentDirs) {
      if (!row.isDirectory()) continue;
      const agentId = row.name.trim();
      const facetKey = normalizeLookupKey(agentId);
      if (!agentId || !facetKey || seen.has(facetKey)) continue;
      seen.add(facetKey);
      output.push({
        agentId,
        facetKey,
        facetLabel: humanizeOperatorLabel(agentId),
        workspaceRoot: join(agentsRoot, agentId),
      });
    }
  } catch {
    // ignore
  }
  return output.sort(compareEditableAgentScopes);
}

function resolveEditableAgentScopesFromConfig(input: unknown): EditableAgentScope[] {
  const root = asObject(input);
  const agents = asObject(root?.agents);
  const list = asArray(agents?.list);
  const output: EditableAgentScope[] = [];
  const seen = new Set<string>();

  for (const item of list) {
    const row = asObject(item);
    if (!row) continue;
    const rawId = asString(row.id)?.trim() ?? asString(row.name)?.trim() ?? "";
    const facetKey = normalizeLookupKey(rawId);
    if (!rawId || !facetKey || seen.has(facetKey)) continue;
    seen.add(facetKey);
    const workspaceRoot =
      facetKey === "main"
        ? OPENCLAW_WORKSPACE_ROOT
        : resolveConfiguredWorkspaceRoot(asString(row.workspace)?.trim(), rawId);
    output.push({
      agentId: rawId,
      facetKey,
      facetLabel: facetKey === "main" ? "Main" : humanizeOperatorLabel(rawId),
      workspaceRoot,
    });
  }

  return ensureMainEditableAgentScope(output).sort(compareEditableAgentScopes);
}

export function resolveEditableAgentScopesFromConfigForSmoke(input: unknown): EditableAgentScope[] {
  return resolveEditableAgentScopesFromConfig(input);
}

export function resolveEditableAgentScopesWithFallbackForSmoke(input: {
  configText?: string;
  workspaceAgentIds?: string[];
}): EditableAgentScope[] {
  const configured = resolveEditableAgentScopesFromConfigText(input.configText);
  if (configured.status === "configured" && configured.scopes.length > 0) {
    return configured.scopes;
  }
  if (configured.status === "config_invalid") {
    return [buildMainEditableAgentScope()];
  }
  return resolveEditableAgentScopesFromWorkspaceAgentIds(input.workspaceAgentIds ?? []);
}

function compareEditableAgentScopes(a: EditableAgentScope, b: EditableAgentScope): number {
  if (a.facetKey === "main") return -1;
  if (b.facetKey === "main") return 1;
  return a.facetLabel.localeCompare(b.facetLabel, "zh-Hans-CN");
}

function buildMainEditableAgentScope(): EditableAgentScope {
  return {
    agentId: "main",
    facetKey: "main",
    facetLabel: "Main",
    workspaceRoot: OPENCLAW_WORKSPACE_ROOT,
  };
}

function ensureMainEditableAgentScope(scopes: EditableAgentScope[]): EditableAgentScope[] {
  if (scopes.some((scope) => scope.facetKey === "main")) return scopes;
  return [buildMainEditableAgentScope(), ...scopes];
}

function resolveEditableAgentScopesFromConfigText(raw: string | undefined): {
  status: EditableAgentScopeConfigStatus;
  scopes: EditableAgentScope[];
} {
  if (!raw?.trim()) return { status: "config_missing", scopes: [] };
  try {
    const scopes = resolveEditableAgentScopesFromConfig(JSON.parse(raw) as unknown);
    return {
      status: scopes.length > 0 ? "configured" : "config_invalid",
      scopes: scopes.length > 0 ? scopes : [buildMainEditableAgentScope()],
    };
  } catch {
    return { status: "config_invalid", scopes: [buildMainEditableAgentScope()] };
  }
}

function resolveEditableAgentScopesFromWorkspaceAgentIds(agentIds: string[]): EditableAgentScope[] {
  const seen = new Set<string>(["main"]);
  const scopes: EditableAgentScope[] = [buildMainEditableAgentScope()];
  for (const rawId of agentIds) {
    const agentId = rawId.trim();
    const facetKey = normalizeLookupKey(agentId);
    if (!agentId || !facetKey || seen.has(facetKey)) continue;
    seen.add(facetKey);
    scopes.push({
      agentId,
      facetKey,
      facetLabel: humanizeOperatorLabel(agentId),
      workspaceRoot: join(OPENCLAW_WORKSPACE_ROOT, "agents", agentId),
    });
  }
  return scopes.sort(compareEditableAgentScopes);
}

function resolveConfiguredWorkspaceRoot(rawWorkspace: string | undefined, agentId: string): string {
  const workspace = rawWorkspace?.trim();
  if (workspace) return resolve(OPENCLAW_CONFIG_DIR, workspace);
  return join(OPENCLAW_WORKSPACE_ROOT, "agents", agentId);
}

async function resolveEditableFileEntry(
  scope: EditableFileScope,
  sourcePath: string,
): Promise<EditableFileEntry | undefined> {
  const target = resolve(sourcePath);
  const entries = await listEditableFiles(scope);
  return entries.find((entry) => resolve(entry.sourcePath) === target);
}

async function readEditableFile(scope: EditableFileScope, sourcePath: string): Promise<{
  entry: EditableFileEntry;
  content: string;
} | undefined> {
  const entry = await resolveEditableFileEntry(scope, sourcePath);
  if (!entry) return undefined;
  const content = await safeReadTextFile(entry.sourcePath);
  if (content === undefined) return undefined;
  return { entry, content };
}

async function writeEditableFileContent(
  scope: EditableFileScope,
  sourcePath: string,
  content: string,
): Promise<{ entry: EditableFileEntry; content: string } | undefined> {
  const entry = await resolveEditableFileEntry(scope, sourcePath);
  if (!entry) return undefined;
  await writeFile(entry.sourcePath, content, "utf8");
  return readEditableFile(scope, entry.sourcePath);
}

async function loadMemoryEntries(): Promise<{ daily: MemoryEntry[]; longTerm: MemoryEntry[] }> {
  const daily: MemoryEntry[] = [];
  for (const candidateDir of MEMORY_DIR_CANDIDATES) {
    const files = await listFileEntries(candidateDir);
    for (const file of files.slice(0, 36)) {
      const ext = extname(file.name).toLowerCase();
      if (ext !== ".md" && ext !== ".markdown" && ext !== ".txt") continue;
      if (file.size > 420 * 1024) continue;
      const raw = await safeReadTextFile(file.path);
      if (!raw) continue;
      const title = extractMarkdownHeading(raw) || basename(file.name, ext) || file.name;
      const day = extractDateFromName(file.name) ?? file.updatedAt.slice(0, 10);
      daily.push({
        day,
        title,
        excerpt: toPlainSummary(raw, 180),
        sourcePath: file.path,
      });
    }
  }
  const longTerm: MemoryEntry[] = [];
  for (const candidateFile of LONG_TERM_MEMORY_FILE_CANDIDATES) {
    const raw = await safeReadTextFile(candidateFile);
    if (!raw) continue;
    const ext = extname(candidateFile).toLowerCase();
    const title = extractMarkdownHeading(raw) || basename(candidateFile, ext) || basename(candidateFile);
    longTerm.push({
      day: "长期",
      title,
      excerpt: toPlainSummary(raw, 220),
      sourcePath: candidateFile,
    });
  }
  return {
    daily: daily
      .sort((a, b) => b.day.localeCompare(a.day) || a.title.localeCompare(b.title, "zh-Hans-CN"))
      .slice(0, 40),
    longTerm,
  };
}

async function loadDocHubEntries(chatEntries: StructuredChatDocEntry[] = []): Promise<DocEntry[]> {
  const output: DocEntry[] = [];
  for (const candidate of DOC_HUB_DIR_CANDIDATES) {
    const files = await listFileEntries(candidate.dir);
    for (const file of files.slice(0, 40)) {
      const ext = extname(file.name).toLowerCase();
      if (![".md", ".markdown", ".txt", ".json"].includes(ext)) continue;
      if (file.size > 600 * 1024) continue;
      const raw = await safeReadTextFile(file.path);
      if (!raw) continue;
      const title =
        extractMarkdownHeading(raw) ||
        basename(file.name, ext) ||
        file.name;
      output.push({
        title,
        excerpt: toPlainSummary(raw, 180),
        category: candidate.category,
        sourcePath: file.path,
        updatedAt: file.updatedAt,
        sourceType: "file",
      });
    }
  }
  for (const entry of chatEntries) {
    output.push({
      title: entry.title,
      excerpt: entry.excerpt,
      category: `聊天输出 · ${entry.category}`,
      sourcePath: `/sessions/${encodeURIComponent(entry.sourceSessionKey)}`,
      updatedAt: entry.updatedAt,
      sourceType: "chat",
      sourceSessionKey: entry.sourceSessionKey,
      sourceAgentId: entry.sourceAgentId,
    });
  }
  return output
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 120);
}

async function renderEditableFileWorkbench(input: {
  scope: EditableFileScope;
  language: UiLanguage;
  title: string;
  description: string;
  entries: EditableFileEntry[];
  emptyMessage: string;
  defaultFacetKey?: string;
  includeAllFacet?: boolean;
  facetOptions?: Array<{ key: string; label: string }>;
}): Promise<string> {
  const t = (en: string, zh: string): string => pickUiText(input.language, en, zh);
  const localizeFacetLabel = (label: string | undefined): string => {
    const value = label?.trim() ?? "";
    if (!value) return "";
    if (value === "共享") return t("Shared", "共享");
    return value;
  };
  const localizeCategoryLabel = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed) return value;
    if (trimmed === "共享文档") return t("Shared docs", "共享文档");
    if (trimmed === "Main 长期记忆") return t("Main long-term memory", "Main 长期记忆");
    if (trimmed === "Main 记忆记录") return t("Main memory log", "Main 记忆记录");
    if (trimmed.endsWith(" 长期记忆")) return `${trimmed.slice(0, -5)} ${t("long-term memory", "长期记忆")}`;
    if (trimmed.endsWith(" 记忆记录")) return `${trimmed.slice(0, -5)} ${t("memory log", "记忆记录")}`;
    if (trimmed.endsWith(" 核心文档")) return `${trimmed.slice(0, -5)} ${t("core docs", "核心文档")}`;
    return trimmed;
  };
  if (input.entries.length === 0) {
    return `<section class="card">
      <h2>${escapeHtml(input.title)}</h2>
      <div class="meta">${escapeHtml(input.description)}</div>
      <div class="empty-state">${escapeHtml(input.emptyMessage)}</div>
    </section>`;
  }

  const normalizeFacetKey = (value: string | undefined): string =>
    (value ?? "all").trim().toLowerCase();

  const discoveredFacetOptions = input.entries
    .filter((entry) => entry.facetKey && entry.facetLabel)
    .reduce<Array<{ key: string; label: string }>>((acc, entry) => {
      if (!entry.facetKey || !entry.facetLabel) return acc;
      const key = normalizeFacetKey(entry.facetKey);
      if (!key) return acc;
      if (acc.some((item) => item.key === key)) return acc;
      acc.push({ key, label: entry.facetLabel });
      return acc;
    }, []);
  const facetOptions = [...(input.facetOptions ?? []), ...discoveredFacetOptions]
    .reduce<Array<{ key: string; label: string }>>((acc, item) => {
      const key = normalizeFacetKey(item.key);
      const label = item.label?.trim();
      if (!key || !label) return acc;
      if (acc.some((entry) => entry.key === key)) return acc;
      acc.push({ key, label });
      return acc;
    }, [])
    .sort((a, b) => {
      if (a.key === "main") return -1;
      if (b.key === "main") return 1;
      if (a.key === "shared") return -1;
      if (b.key === "shared") return 1;
      return a.label.localeCompare(b.label, "zh-Hans-CN");
    });
  const requestedDefaultFacet = normalizeFacetKey(input.defaultFacetKey);
  const defaultFacetKey =
    requestedDefaultFacet && facetOptions.some((item) => item.key === requestedDefaultFacet)
      ? requestedDefaultFacet
      : input.includeAllFacet === false
        ? facetOptions[0]?.key ?? "all"
        : "all";
  const firstEntry =
    input.entries.find((entry) => normalizeFacetKey(entry.facetKey) === defaultFacetKey) ?? input.entries[0];
  const initialContent = (await safeReadTextFile(firstEntry.sourcePath)) ?? "";
  const facetSwitcherHtml =
    facetOptions.length <= 1
      ? ""
      : `<div class="segment-switch file-facet-switch" data-file-facet-switch>
          ${input.includeAllFacet === false
            ? ""
            : `<button class="segment-item${defaultFacetKey === "all" ? " active" : ""}" type="button" data-file-facet="all">${escapeHtml(t("All", "全部"))}</button>`}
          ${facetOptions
            .map(
              (item) =>
                `<button class="segment-item${defaultFacetKey === item.key ? " active" : ""}" type="button" data-file-facet="${escapeHtml(item.key)}">${escapeHtml(localizeFacetLabel(item.label))}</button>`,
            )
            .join("")}
        </div>`;
  const tokenHint = !LOCAL_TOKEN_AUTH_REQUIRED
    ? t("This environment allows direct save.", "当前环境允许直接保存。")
    : LOCAL_API_TOKEN
      ? t("Enter the local token when saving.", "保存时输入本地令牌。")
      : t("LOCAL_API_TOKEN is not configured in this environment. Save will be blocked.", "当前环境未配置 LOCAL_API_TOKEN，保存会被拦截。");
  const tokenField =
    LOCAL_TOKEN_AUTH_REQUIRED && LOCAL_API_TOKEN
      ? `<input class="file-token-input" type="password" data-file-token placeholder="${escapeHtml(t("Local token", "本地令牌"))}" />`
      : "";

  return `<section class="card">
    <h2>${escapeHtml(input.title)}</h2>
    <div class="meta">${escapeHtml(input.description)}</div>
    <div class="meta">${escapeHtml(t("Files", "文件数"))}${escapeHtml(input.language === "en" ? ": " : "：")}${input.entries.length} · ${escapeHtml(t("Saving writes directly back to the source file.", "保存后直接写回源文件。"))}</div>
    <div class="file-workbench" data-file-editor-root data-scope="${escapeHtml(input.scope)}" data-language="${escapeHtml(input.language)}" data-default-facet="${escapeHtml(defaultFacetKey)}" data-token-required="${LOCAL_TOKEN_AUTH_REQUIRED ? "1" : "0"}" data-local-token-header="${escapeHtml(LOCAL_TOKEN_HEADER)}">
      <aside class="file-sidebar">
        <div class="file-sidebar-tools">
          ${facetSwitcherHtml}
          <input class="file-filter-input" type="search" data-file-filter placeholder="${escapeHtml(t("Filter by file name or path...", "筛选文件名或路径..."))}" />
          <div class="meta" data-file-filter-state></div>
        </div>
        <div class="file-nav" data-file-nav>
          ${input.entries
            .map(
              (entry) => `<button class="file-nav-item${entry.sourcePath === firstEntry.sourcePath ? " active" : ""}" type="button" data-file-item data-source-path="${escapeHtml(entry.sourcePath)}" data-file-facet-key="${escapeHtml(normalizeFacetKey(entry.facetKey))}" data-file-search="${escapeHtml(`${entry.title} ${entry.relativePath} ${entry.category} ${entry.facetLabel ?? ""}`.toLowerCase())}">
                <span class="file-nav-title">${escapeHtml(entry.title)}</span>
                <span class="file-nav-meta">${escapeHtml(entry.facetLabel ? `${localizeFacetLabel(entry.facetLabel)} · ` : "")}${escapeHtml(localizeCategoryLabel(entry.category))} · ${escapeHtml(entry.relativePath)}</span>
              </button>`,
            )
            .join("")}
        </div>
      </aside>
      <div class="file-editor-panel">
        <div class="file-editor-head">
          <div>
            <div class="file-editor-title" data-file-title>${escapeHtml(firstEntry.title)}</div>
            <div class="meta" data-file-path>${escapeHtml(firstEntry.sourcePath)}</div>
            <div class="meta" data-file-meta>${escapeHtml(t("Updated", "更新于"))} ${escapeHtml(firstEntry.updatedAt)} · ${formatInt(firstEntry.size)} bytes</div>
          </div>
          <div class="toolbar">
            ${tokenField}
            <button class="btn" type="button" data-file-reload>${escapeHtml(t("Reload", "重新读取"))}</button>
            <button class="btn" type="button" data-file-save>${escapeHtml(t("Save changes", "保存改动"))}</button>
          </div>
        </div>
        <textarea class="file-editor-textarea" data-file-text spellcheck="false">${escapeHtml(initialContent)}</textarea>
        <div class="meta" data-file-status>${escapeHtml(tokenHint)}</div>
      </div>
    </div>
  </section>`;
}

function renderStructuredChatDocSummary(entries: StructuredChatDocEntry[]): string {
  if (entries.length === 0) {
    return '<div class="empty-state">尚无聊天输出结构化入库记录。</div>';
  }
  return `<ul class="story-list">${entries
    .slice(0, 16)
    .map(
      (entry) => `<li><strong>${escapeHtml(entry.title)}</strong><div class="meta">${escapeHtml(entry.excerpt)}</div><div class="meta">会话 ${escapeHtml(entry.sourceSessionKey)} · 更新 ${escapeHtml(entry.updatedAt)}</div></li>`,
    )
    .join("")}</ul>`;
}

async function loadTeamSnapshot(officeRoster: AgentRosterSnapshot): Promise<TeamSnapshot> {
  const sourcePath = OPENCLAW_CONFIG_PATH;
  const fallbackMission = "构建可持续自治的 AI 员工体系，持续完成高价值任务。";
  const missionFromAgentDoc = await safeReadTextFile(join(AGENT_ROOT_DIR, "AGENTS.md"));
  const missionLine = missionFromAgentDoc
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("- ") && line.toLowerCase().includes("objective"))
    ?.replace(/^-+\s*/, "")
    .trim();
  const missionStatement = missionLine && missionLine.length > 8 ? missionLine : fallbackMission;

  const raw = await safeReadTextFile(sourcePath);
  if (!raw) {
    return {
      missionStatement,
      members: officeRoster.entries.map((entry) => ({
        agentId: entry.agentId,
        displayName: entry.displayName,
        model: "未标注",
        workspace: "未标注",
        toolsProfile: "default",
      })),
      sourcePath,
      detail: "openclaw.json 未找到，已回退为运行时员工名录。",
    };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const agentsRoot = parsed.agents as Record<string, unknown> | undefined;
    const defaults = (agentsRoot?.defaults ?? {}) as Record<string, unknown>;
    const defaultModel =
      (defaults.model as Record<string, unknown> | undefined)?.primary;
    const list = Array.isArray(agentsRoot?.list) ? agentsRoot?.list : [];
    const members: TeamMemberSnapshot[] = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const id = typeof obj.id === "string" ? obj.id.trim() : "";
      if (!id) continue;
      const tools = (obj.tools ?? {}) as Record<string, unknown>;
      members.push({
        agentId: id,
        displayName:
          (typeof obj.name === "string" && obj.name.trim()) || id,
        model:
          (typeof obj.model === "string" && obj.model.trim()) ||
          (typeof defaultModel === "string" ? defaultModel : "未标注"),
        workspace:
          (typeof obj.workspace === "string" && obj.workspace.trim()) || "未标注",
        toolsProfile:
          (typeof tools.profile === "string" && tools.profile.trim()) || "default",
      });
    }
    return {
      missionStatement,
      members: members.sort((a, b) => a.agentId.localeCompare(b.agentId, "zh-Hans-CN")),
      sourcePath,
      detail: `已从 openclaw.json 读取 ${members.length} 名员工。`,
    };
  } catch {
    return {
      missionStatement,
      members: officeRoster.entries.map((entry) => ({
        agentId: entry.agentId,
        displayName: entry.displayName,
        model: "未标注",
        workspace: "未标注",
        toolsProfile: "default",
      })),
      sourcePath,
      detail: "openclaw.json 解析失败，已回退为运行时员工名录。",
    };
  }
}

function summarizeFilters(filters: TaskQueryFilters): string {
  const labels: string[] = [];
  if (filters.quick) labels.push(`quick=${filters.quick}`);
  if (filters.status) labels.push(`status=${filters.status}`);
  if (filters.owner) labels.push(`owner=${filters.owner}`);
  if (filters.project) labels.push(`project=${filters.project}`);
  return labels.length > 0 ? `filters(${labels.join(", ")})` : "filters(none)";
}

function matchesQuickFilter(task: TaskListItem, quick: UiQuickFilter, now: number): boolean {
  if (quick === "all") return true;
  if (quick === "attention") {
    return task.status === "blocked" || isTaskDueNow(task, now);
  }
  return task.status === quick;
}

function isTaskDueNow(task: TaskListItem, now: number): boolean {
  if (task.status === "done") return false;
  if (!task.dueAt) return false;
  const dueMs = Date.parse(task.dueAt);
  if (Number.isNaN(dueMs)) return false;
  return dueMs <= now;
}

function hasAnyQueryKey(searchParams: URLSearchParams, keys: string[]): boolean {
  return keys.some((key) => searchParams.has(key));
}

function renderLanguageToggle(filters: TaskQueryFilters, options: DashboardOptions): string {
  const enHref = buildHomeHref(filters, options.compactStatusStrip, options.section, "en", options.usageView);
  const zhHref = buildHomeHref(filters, options.compactStatusStrip, options.section, "zh", options.usageView);
  const enClass = options.language === "en" ? " class=\"active\"" : "";
  const zhClass = options.language === "zh" ? " class=\"active\"" : "";
  const label = pickUiText(options.language, "Language:", "语言：");
  const zhLabel = pickUiText(options.language, "中文", "中文");
  return `<div class="meta lang-toggle">${label} <a${enClass} href="${escapeHtml(enHref)}">EN</a> / <a${zhClass} href="${escapeHtml(zhHref)}">${zhLabel}</a></div>`;
}

function buildHomeHref(
  filters: TaskQueryFilters,
  compactStatusStrip: boolean,
  section: DashboardSection = "overview",
  language: UiLanguage = "en",
  usageView: UsageView = "cumulative",
): string {
  const query = buildHomeQuery(filters, compactStatusStrip, section, language, usageView);
  return query ? `/?${query}` : "/";
}

function buildHomeQuery(
  filters: TaskQueryFilters,
  compactStatusStrip: boolean,
  section: DashboardSection = "overview",
  language: UiLanguage = "en",
  usageView: UsageView = "cumulative",
): string {
  const params = new URLSearchParams();
  params.set("compact", compactStatusStrip ? "1" : "0");
  params.set("section", section);
  params.set("lang", language);
  if (usageView === "today") params.set("usage_view", "today");
  params.set("quick", filters.quick ?? "all");
  if (filters.status) params.set("status", filters.status);
  if (filters.owner) params.set("owner", filters.owner);
  if (filters.project) params.set("project", filters.project);
  return params.toString();
}

function buildTaskDetailHref(taskId: string, language: UiLanguage): string {
  return `/details/task/${encodeURIComponent(taskId)}?lang=${encodeURIComponent(language)}`;
}

function buildCronDetailHref(jobId: string, language: UiLanguage): string {
  return `/details/cron/${encodeURIComponent(jobId)}?lang=${encodeURIComponent(language)}`;
}

function buildSessionDetailHref(sessionKey: string, language: UiLanguage): string {
  return `/session/${encodeURIComponent(sessionKey)}?lang=${encodeURIComponent(language)}`;
}

function joinDisplayList(items: string[], language: UiLanguage): string {
  const output = items.map((item) => item.trim()).filter((item) => item.length > 0);
  return output.join(language === "en" ? ", " : "、");
}

function renderQuickFilters(
  filters: TaskQueryFilters,
  compactStatusStrip: boolean,
  section: DashboardSection,
  language: UiLanguage,
  usageView: UsageView,
): string {
  const options: Array<{ value: UiQuickFilter; label: string }> = UI_QUICK_FILTERS.map((value) => ({
    value,
    label: quickFilterLabel(value, language),
  }));
  const active = filters.quick ?? "all";
  const base: TaskQueryFilters = {
    owner: filters.owner,
    project: filters.project,
  };

  return options
    .map((option) => {
      const href = buildHomeHref({ ...base, quick: option.value }, compactStatusStrip, section, language, usageView);
      const activeClass = option.value === active ? " active" : "";
      return `<a class="quick-chip${activeClass}" href="${escapeHtml(href)}">${escapeHtml(option.label)}</a>`;
    })
    .join("");
}

function quickFilterLabel(value: UiQuickFilter, language: UiLanguage = "en"): string {
  if (value === "all") return pickUiText(language, "Everything", "全部");
  if (value === "attention") return pickUiText(language, "Needs Attention", "需关注");
  if (value === "todo") return pickUiText(language, "Ready To Start", "可开始");
  if (value === "in_progress") return pickUiText(language, "In Motion", "进行中");
  if (value === "blocked") return pickUiText(language, "Blocked", "已阻塞");
  return pickUiText(language, "Completed", "已完成");
}

function taskStateLabel(state: TaskState, language: UiLanguage = "zh"): string {
  if (state === "todo") return pickUiText(language, "Ready To Start", "待开始");
  if (state === "in_progress") return pickUiText(language, "In Motion", "进行中");
  if (state === "blocked") return pickUiText(language, "Blocked", "已阻塞");
  return pickUiText(language, "Completed", "已完成");
}

function projectStateLabel(state: ProjectState, language: UiLanguage = "zh"): string {
  if (state === "planned") return pickUiText(language, "Planned", "规划中");
  if (state === "active") return pickUiText(language, "Active", "执行中");
  if (state === "blocked") return pickUiText(language, "Blocked", "已阻塞");
  return pickUiText(language, "Completed", "已完成");
}

function searchScopeLabel(scope: DashboardSearchScope, language: UiLanguage = "zh"): string {
  if (scope === "tasks") return pickUiText(language, "Tasks", "任务");
  if (scope === "projects") return pickUiText(language, "Projects", "项目");
  if (scope === "sessions") return pickUiText(language, "Sessions", "会话");
  return pickUiText(language, "Alerts", "告警");
}

function humanizeOperatorLabel(value: string): string {
  const normalized = value.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (!normalized) return "未知助手";
  return normalized.replace(/\b\w/g, (match) => match.toUpperCase());
}

export function deriveAgentAnimalIdentity(agentId: string): AgentAnimalIdentity {
  const normalized = agentId.trim().toLowerCase();
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  if (!compact) {
    const fallback = FALLBACK_ANIMAL_CATALOG[0];
    return {
      animal: fallback.key,
      title: fallback.title,
      accent: fallback.accent,
      sprite: fallback.sprite,
    };
  }

  const matched = ANIMAL_CATALOG.find((item) =>
    item.keywords.some((keyword) => compact.includes(keyword)),
  );
  if (matched) {
    return {
      animal: matched.key,
      title: matched.title,
      accent: matched.accent,
      sprite: matched.sprite,
    };
  }

  const index = stableHashIndex(compact) % FALLBACK_ANIMAL_CATALOG.length;
  const fallback = FALLBACK_ANIMAL_CATALOG[index];
  return {
    animal: fallback.key,
    title: fallback.title,
    accent: fallback.accent,
    sprite: fallback.sprite,
  };
}

export function buildOfficeAgentRosterIds(
  snapshot: ReadModelSnapshot,
  _tasks: TaskListItem[],
  knownAgentIds: string[] = [],
): string[] {
  const configuredAgentIds = knownAgentIds.map((agentId) => agentId.trim()).filter(Boolean);
  if (configuredAgentIds.length > 0) {
    return [...new Set(configuredAgentIds)].sort((a, b) => a.localeCompare(b));
  }

  const agentIds = new Set<string>();
  for (const session of snapshot.sessions) {
    if (session.agentId?.trim()) {
      agentIds.add(session.agentId.trim());
    }
  }
  for (const budget of snapshot.tasks.agentBudgets) {
    if (budget.agentId.trim()) {
      agentIds.add(budget.agentId.trim());
    }
  }

  return [...agentIds];
}

export function buildOfficeSpaceCards(
  snapshot: ReadModelSnapshot,
  tasks: TaskListItem[],
  knownAgentIds: string[] = [],
  runtimeActiveSessionsByAgent: Map<string, number> = new Map(),
  language: UiLanguage = "zh",
): OfficeSpaceCard[] {
  const configuredAgentKeys = new Set(
    knownAgentIds.map((agentId) => normalizeLookupKey(agentId)).filter((agentId) => agentId.length > 0),
  );
  const allowUnknownAgents = configuredAgentKeys.size === 0;
  const agentIds = new Set(buildOfficeAgentRosterIds(snapshot, tasks, knownAgentIds));
  for (const [agentId, activeCount] of runtimeActiveSessionsByAgent.entries()) {
    if (!agentId.trim() || activeCount <= 0) continue;
    if (!allowUnknownAgents && !configuredAgentKeys.has(normalizeLookupKey(agentId))) continue;
    agentIds.add(agentId.trim());
  }

  const tasksBySession = new Map<string, TaskListItem[]>();
  for (const task of tasks) {
    for (const sessionKey of task.sessionKeys) {
      const current = tasksBySession.get(sessionKey) ?? [];
      current.push(task);
      tasksBySession.set(sessionKey, current);
    }
  }

  const cards = [...agentIds].map((agentId) => {
    const sessions = snapshot.sessions.filter((session) => session.agentId === agentId);
    const runtimeActiveSessions = Math.max(0, runtimeActiveSessionsByAgent.get(agentId) ?? 0);
    const snapshotActiveSessions = sessions.filter((session) => session.state !== "idle").length;
    const activeSessions = Math.max(snapshotActiveSessions, runtimeActiveSessions);
    const ownedActiveTasks = tasks.filter(
      (task) => task.owner.toLowerCase() === agentId.toLowerCase() && task.status !== "done",
    );
    const sessionTaskSet = new Map<string, TaskListItem>();
    for (const session of sessions) {
      const linked = tasksBySession.get(session.sessionKey) ?? [];
      for (const task of linked) {
        if (task.status === "done") continue;
        sessionTaskSet.set(`${task.projectId}:${task.taskId}`, task);
      }
    }
    const sessionActiveTasks = [...sessionTaskSet.values()];
    const focusItems = [
      ...sessionActiveTasks.map((task) => task.title),
      ...ownedActiveTasks.map((task) => task.title),
    ].filter((value, idx, arr) => arr.indexOf(value) === idx);
    const status = resolveOfficeCardStatus(
      sessions.map((item) => item.state),
      activeSessions,
      focusItems.length,
    );
    const statusLabel = officeStatusLabel(status, language);
    const officeZone = officeZoneFromStatus(status);
    const summary = buildOfficeSummary(status, focusItems, activeSessions, language);
    return {
      agentId,
      identity: deriveAgentAnimalIdentity(agentId),
      status,
      statusLabel,
      officeZone,
      activeSessions,
      activeTasks: focusItems.length,
      focusItems: focusItems.slice(0, 3),
      summary,
    };
  });

  return cards.sort((a, b) => {
    const rank = officeStatusRank(a.status) - officeStatusRank(b.status);
    if (rank !== 0) return rank;
    return a.agentId.localeCompare(b.agentId);
  });
}

function normalizeLookupKey(input: string): string {
  return input.trim().toLowerCase();
}

export function buildExecutionAgentSummaries(
  snapshot: ReadModelSnapshot,
  tasks: TaskListItem[],
  cronJobs: OpenclawCronJobSummary[],
  rosterEntries: AgentRosterEntry[],
  usageAgentTokensByKey: Map<string, number>,
): ExecutionAgentSummary[] {
  const configuredRosterKeys = new Set(
    rosterEntries.map((entry) => normalizeLookupKey(entry.agentId)).filter((key) => key.length > 0),
  );
  const allowUnknownAgents = configuredRosterKeys.size === 0;
  const canonicalIdByKey = new Map<string, string>();
  const displayNameByKey = new Map<string, string>();
  const cronOwnerByJobId = inferCronOwnerAgentIdsFromSessions(snapshot.sessions);

  const registerAgent = (agentId: string, displayName?: string): void => {
    const normalized = agentId.trim();
    if (!normalized) return;
    const key = normalizeLookupKey(normalized);
    if (!allowUnknownAgents && !configuredRosterKeys.has(key)) return;
    if (!canonicalIdByKey.has(key)) canonicalIdByKey.set(key, normalized);
    if (!displayNameByKey.has(key)) {
      displayNameByKey.set(key, displayName?.trim() || humanizeOperatorLabel(normalized));
    }
  };

  for (const entry of rosterEntries) {
    registerAgent(entry.agentId, entry.displayName);
  }
  for (const session of snapshot.sessions) {
    if (session.agentId?.trim()) registerAgent(session.agentId);
  }
  for (const job of cronJobs) {
    const ownerAgentId = job.ownerAgentId?.trim() || cronOwnerByJobId.get(job.jobId.trim().toLowerCase());
    if (ownerAgentId) registerAgent(ownerAgentId);
  }
  for (const key of usageAgentTokensByKey.keys()) {
    registerAgent(key);
  }

  const activeSessionCountByKey = new Map<string, number>();
  for (const session of snapshot.sessions) {
    if (!session.agentId?.trim() || session.state === "idle") continue;
    const key = normalizeLookupKey(session.agentId);
    if (!allowUnknownAgents && !configuredRosterKeys.has(key)) continue;
    activeSessionCountByKey.set(key, (activeSessionCountByKey.get(key) ?? 0) + 1);
  }

  const activeTaskCountByKey = new Map<string, number>();
  for (const task of tasks) {
    if (task.status === "done") continue;
    const owner = task.owner.trim();
    if (!owner) continue;
    const key = normalizeLookupKey(owner);
    if (!allowUnknownAgents && !configuredRosterKeys.has(key)) continue;
    activeTaskCountByKey.set(key, (activeTaskCountByKey.get(key) ?? 0) + 1);
  }

  const enabledCronNamesByKey = new Map<string, string[]>();
  for (const job of cronJobs) {
    if (!job.enabled) continue;
    const ownerAgentId = job.ownerAgentId?.trim() || cronOwnerByJobId.get(job.jobId.trim().toLowerCase());
    if (!ownerAgentId) continue;
    const key = normalizeLookupKey(ownerAgentId);
    if (!allowUnknownAgents && !configuredRosterKeys.has(key)) continue;
    const bucket = enabledCronNamesByKey.get(key) ?? [];
    bucket.push(job.name);
    enabledCronNamesByKey.set(key, bucket);
  }

  const rows: ExecutionAgentSummary[] = [];
  for (const [key, agentId] of canonicalIdByKey.entries()) {
    const cronNames = [...new Set((enabledCronNamesByKey.get(key) ?? []).map((item) => item.trim()).filter(Boolean))];
    rows.push({
      agentId,
      displayName: displayNameByKey.get(key) ?? humanizeOperatorLabel(agentId),
      activeSessions: activeSessionCountByKey.get(key) ?? 0,
      activeTasks: activeTaskCountByKey.get(key) ?? 0,
      enabledCronJobs: cronNames.length,
      cronJobNames: cronNames,
      recentTokens30d: usageAgentTokensByKey.get(key) ?? 0,
    });
  }

  return rows.sort((a, b) => {
    const loadA = a.activeSessions + a.activeTasks + a.enabledCronJobs;
    const loadB = b.activeSessions + b.activeTasks + b.enabledCronJobs;
    if (loadB !== loadA) return loadB - loadA;
    if (b.recentTokens30d !== a.recentTokens30d) return b.recentTokens30d - a.recentTokens30d;
    return a.agentId.localeCompare(b.agentId);
  });
}

function inferCronOwnerAgentIdsFromSessions(sessions: ReadModelSnapshot["sessions"]): Map<string, string> {
  const owners = new Map<string, string>();
  for (const session of sessions) {
    const sessionKey = session.sessionKey?.trim();
    const agentId = session.agentId?.trim();
    if (!sessionKey || !agentId) continue;
    const jobId = extractCronJobIdFromSessionKey(sessionKey);
    if (!jobId) continue;
    const key = jobId.trim().toLowerCase();
    if (!owners.has(key)) owners.set(key, agentId);
  }
  return owners;
}

function buildTaskRoleSummaries(tasks: TaskListItem[]): TaskRoleSummary[] {
  const buckets = new Map<string, TaskRoleSummary>();
  for (const task of tasks) {
    if (task.status === "done") continue;
    const owner = task.owner.trim() || "Unassigned";
    const key = normalizeLookupKey(owner);
    const current = buckets.get(key) ?? {
      owner,
      activeTasks: 0,
      sampleTaskIds: [],
    };
    current.activeTasks += 1;
    if (current.sampleTaskIds.length < 3 && !current.sampleTaskIds.includes(task.taskId)) {
      current.sampleTaskIds.push(task.taskId);
    }
    buckets.set(key, current);
  }
  return [...buckets.values()].sort((a, b) => {
    if (b.activeTasks !== a.activeTasks) return b.activeTasks - a.activeTasks;
    return a.owner.localeCompare(b.owner);
  });
}

function resolveOfficeCardStatus(
  states: AgentRunState[],
  activeSessionCount: number,
  activeTaskCount: number,
): OfficeSpaceCard["status"] {
  if (states.includes("error")) return "error";
  if (states.includes("blocked")) return "blocked";
  if (states.includes("waiting_approval")) return "waiting_approval";
  if (states.includes("running")) return "running";
  if (activeSessionCount > 0) return "running";
  if (activeTaskCount > 0) return "idle";
  if (states.includes("idle")) return "idle";
  return "inactive";
}

function officeStatusRank(status: OfficeSpaceCard["status"]): number {
  if (status === "error") return 0;
  if (status === "blocked") return 1;
  if (status === "waiting_approval") return 2;
  if (status === "running") return 3;
  if (status === "mixed") return 4;
  if (status === "idle") return 5;
  return 6;
}

function officeStatusLabel(status: OfficeSpaceCard["status"], language: UiLanguage = "zh"): string {
  if (status === "running") return pickUiText(language, "Running", "执行中");
  if (status === "waiting_approval") return pickUiText(language, "Waiting for approval", "等待审批");
  if (status === "blocked") return pickUiText(language, "Needs support", "需要支援");
  if (status === "error") return pickUiText(language, "Issue detected", "发现异常");
  if (status === "idle") return pickUiText(language, "Standing by", "待命");
  if (status === "mixed") return pickUiText(language, "Mixed state", "混合状态");
  return pickUiText(language, "No active load", "无活跃负载");
}

function officeZoneFromStatus(status: OfficeSpaceCard["status"]): OfficeSpaceCard["officeZone"] {
  if (status === "running") return "Builder Desks";
  if (status === "waiting_approval") return "Approval Desk";
  if (status === "blocked" || status === "error" || status === "mixed") return "Support Bay";
  return "Standby Pods";
}

function officeZoneLabel(zone: OfficeSpaceCard["officeZone"], language: UiLanguage = "zh"): string {
  if (zone === "Builder Desks") return pickUiText(language, "Builder Desks", "执行工位");
  if (zone === "Approval Desk") return pickUiText(language, "Approval Desk", "审批工位");
  if (zone === "Support Bay") return pickUiText(language, "Support Bay", "支援工位");
  return pickUiText(language, "Standby Pods", "待命工位");
}

function animalLabel(animal: string, language: UiLanguage = "zh"): string {
  if (animal === "robot") return pickUiText(language, "Robot", "机器人");
  if (animal === "lion") return pickUiText(language, "Lion", "狮子");
  if (animal === "panda") return pickUiText(language, "Panda", "熊猫");
  if (animal === "monkey") return pickUiText(language, "Monkey", "猴子");
  if (animal === "dolphin") return pickUiText(language, "Dolphin", "海豚");
  if (animal === "owl") return pickUiText(language, "Owl", "猫头鹰");
  if (animal === "fox") return pickUiText(language, "Fox", "狐狸");
  if (animal === "bear") return pickUiText(language, "Bear", "棕熊");
  if (animal === "eagle") return pickUiText(language, "Eagle", "鹰");
  if (animal === "tiger") return pickUiText(language, "Tiger", "老虎");
  if (animal === "otter") return pickUiText(language, "Otter", "水獭");
  if (animal === "rooster") return pickUiText(language, "Rooster", "公鸡");
  return pickUiText(language, "Animal", "动物");
}

function buildOfficeSummary(
  status: OfficeSpaceCard["status"],
  focusItems: string[],
  sessionCount: number,
  language: UiLanguage = "zh",
): string {
  if (focusItems.length === 0 && sessionCount === 0) {
    return pickUiText(language, "No live task right now.", "当前没有实时任务。");
  }
  if (status === "running" && focusItems.length > 0) {
    return pickUiText(language, `Working on: ${focusItems[0]}`, `正在处理：${focusItems[0]}`);
  }
  if (status === "waiting_approval") {
    return pickUiText(language, "Waiting for approval before continuing.", "等待审批，暂时暂停。");
  }
  if (status === "blocked" || status === "error") {
    return pickUiText(language, "Clear blockers before continuing.", "继续前需要先解决阻塞。");
  }
  if (focusItems.length > 0) {
    return pickUiText(language, `Currently tracking: ${focusItems[0]}`, `当前跟进：${focusItems[0]}`);
  }
  if (sessionCount > 0) {
    return pickUiText(language, "Session is open and waiting for the next instruction.", "会话已开启，等待下一步指令。");
  }
  return pickUiText(language, "Standing by.", "待命中。");
}

function staffStatusLabel(status: OfficeSpaceCard["status"] | undefined, language: UiLanguage = "zh"): string {
  switch (status) {
    case "running":
      return pickUiText(language, "Working", "工作中");
    case "waiting_approval":
      return pickUiText(language, "Awaiting review", "等待审核");
    case "blocked":
      return pickUiText(language, "Needs support", "需要支援");
    case "error":
      return pickUiText(language, "Needs attention", "需要关注");
    case "mixed":
      return pickUiText(language, "Handling mixed work", "处理中");
    case "idle":
    case "inactive":
    default:
      return pickUiText(language, "Standing by", "待命");
  }
}

function staffCurrentWorkLabel(input: {
  office?: OfficeSpaceCard;
  execution?: ExecutionAgentSummary;
  language: UiLanguage;
}): { label: string; value: string } {
  const { office, execution, language } = input;
  const currentLabel = pickUiText(language, "Working on", "正在处理什么");
  const nextLabel = pickUiText(language, "Next up", "下一项");
  const focus = office?.focusItems[0]?.trim();
  if (office?.status === "waiting_approval") {
    return { label: currentLabel, value: pickUiText(language, "Waiting for approval", "等待审批") };
  }
  if (office?.status === "blocked" || office?.status === "error") {
    return { label: currentLabel, value: pickUiText(language, "Blocked and waiting for support", "阻塞中，等待支援") };
  }
  const cronName = execution?.cronJobNames.find((name) => name.trim())?.trim();
  if (office?.status === "running") {
    if (focus) return { label: currentLabel, value: focus };
    if (cronName) {
      return { label: currentLabel, value: safeTruncate(cronName, 72) };
    }
    if ((office?.activeSessions ?? 0) > 0) {
      return { label: currentLabel, value: pickUiText(language, "Handling a live session", "正在处理实时会话") };
    }
    return { label: currentLabel, value: pickUiText(language, "Handling active work", "正在处理当前工作") };
  }
  if (focus) return { label: nextLabel, value: focus };
  if (cronName) {
    return { label: nextLabel, value: safeTruncate(cronName, 72) };
  }
  return { label: currentLabel, value: pickUiText(language, "No live work right now", "当前无实时任务") };
}

async function loadCachedStaffRecentActivity(
  snapshot: ReadModelSnapshot,
  client: ToolClient,
  agentIds: string[],
  language: UiLanguage,
): Promise<Map<string, StaffRecentActivity>> {
  const now = Date.now();
  const agentKey = [...new Set(agentIds.map((value) => normalizeLookupKey(value)).filter(Boolean))].sort().join(",");
  if (
    renderStaffRecentActivityCache &&
    renderStaffRecentActivityCache.snapshotAt === snapshot.generatedAt &&
    renderStaffRecentActivityCache.language === language &&
    renderStaffRecentActivityCache.agentKey === agentKey &&
    renderStaffRecentActivityCache.expiresAt > now
  ) {
    return renderStaffRecentActivityCache.value;
  }

  const value = await loadStaffRecentActivity(snapshot, client, agentIds, language);
  renderStaffRecentActivityCache = {
    snapshotAt: snapshot.generatedAt,
    language,
    agentKey,
    value,
    expiresAt: now + HTML_HEAVY_CACHE_TTL_MS,
  };
  return value;
}

async function loadStaffRecentActivity(
  snapshot: ReadModelSnapshot,
  client: ToolClient,
  agentIds: string[],
  language: UiLanguage,
): Promise<Map<string, StaffRecentActivity>> {
  const targetKeys = [...new Set(agentIds.map((value) => normalizeLookupKey(value)).filter(Boolean))];
  const targetKeySet = new Set(targetKeys);
  const sessionsByAgent = new Map<string, ReadModelSnapshot["sessions"]>();
  for (const session of [...snapshot.sessions].sort(compareSessionSummariesByLatest)) {
    const agentId = session.agentId?.trim();
    if (!agentId) continue;
    const key = normalizeLookupKey(agentId);
    if (!targetKeySet.has(key)) continue;
    const bucket = sessionsByAgent.get(key) ?? [];
    if (bucket.length >= 3) continue;
    bucket.push(session);
    sessionsByAgent.set(key, bucket);
  }

  const entries = await Promise.all(
    targetKeys.map(async (key): Promise<[string, StaffRecentActivity | undefined]> => {
      const sessions = sessionsByAgent.get(key) ?? [];
      let residualRunningDetected = false;
      let liveRunningDetected = false;
      for (const session of sessions) {
        const detail = await getSessionConversationDetail({
          snapshot,
          client,
          sessionKey: session.sessionKey,
          historyLimit: 20,
        });
        if (!detail) continue;
        if (detail.session.state === "running") {
          if (historyImpliesStaffStopped(detail.history)) {
            residualRunningDetected = true;
          } else {
            liveRunningDetected = true;
          }
        }
        const recent = pickRecentStaffActivity(detail.history, language);
        if (recent) {
          return [
            key,
            {
              ...recent,
              sessionKey: session.sessionKey,
              statusOverride: !liveRunningDetected && residualRunningDetected ? "idle" : undefined,
            },
          ];
        }
      }
      if (!liveRunningDetected && residualRunningDetected) {
        return [key, {
          recentOutput: pickUiText(language, "Recently stopped and returned to standby.", "最近已停止当前任务并回到待命。"),
          statusOverride: "idle",
        }];
      }
      return [key, undefined];
    }),
  );

  return new Map(entries.filter((entry): entry is [string, StaffRecentActivity] => Boolean(entry[1])));
}

function pickRecentStaffActivity(
  history: SessionHistoryMessage[],
  language: UiLanguage,
): StaffRecentActivity | undefined {
  for (let idx = history.length - 1; idx >= 0; idx -= 1) {
    const message = history[idx];
    if (!isStaffVisibleOutputMessage(message)) continue;
    return {
      recentOutput: formatStaffRecentOutput(message, language),
      recentOutputAt: message.timestamp,
    };
  }
  return undefined;
}

function historyImpliesStaffStopped(history: SessionHistoryMessage[]): boolean {
  for (let idx = history.length - 1; idx >= 0; idx -= 1) {
    const message = history[idx];
    if (isResidualPostStopMessage(message)) continue;
    if (isExplicitStopSignalMessage(message)) return true;
    return false;
  }
  return false;
}

function isExplicitStopSignalMessage(message: SessionHistoryMessage): boolean {
  const content = sanitizeStaffOutputContent(message.content);
  if (!content) return false;
  const lower = content.toLowerCase();
  return (
    lower.includes("停止当前任务并进入待命状态") ||
    lower.includes("立即停止你当前的所有活动") ||
    lower.includes("stop current task and enter standby") ||
    lower.includes("不再继续当前") ||
    lower.includes("不再处理任何当前任务") ||
    lower.includes("从现在起进入待命状态") ||
    lower.includes("enter standby state")
  );
}

function isResidualPostStopMessage(message: SessionHistoryMessage): boolean {
  if (message.kind === "tool_event") return false;
  const content = sanitizeStaffOutputContent(message.content);
  if (!content) return true;
  const lower = content.toLowerCase();
  return (
    lower === "reply_skip" ||
    lower === "announce_skip" ||
    lower.startsWith("thinking ") ||
    lower.startsWith("reasoning ") ||
    lower.includes("agent-to-agent announce step")
  );
}

function isStaffVisibleOutputMessage(message: SessionHistoryMessage): boolean {
  if (message.kind === "accepted" || message.kind === "spawn") return false;
  if (message.kind === "tool_event") return true;
  const role = message.role.trim().toLowerCase();
  if (role === "user" || role === "system") return false;
  if (isExplicitStopSignalMessage(message)) return false;
  const content = sanitizeStaffOutputContent(message.content);
  if (!content) return false;
  const lower = content.toLowerCase();
  if (lower === "no_reply" || lower === "noop") return false;
  if (lower === "reply_skip" || lower === "announce_skip") return false;
  if (lower.startsWith("thinking ")) return false;
  if (lower.startsWith("reasoning ")) return false;
  if (lower.startsWith("text msg_")) return false;
  if (lower.startsWith("toolcall ")) return false;
  if (lower.includes("agent-to-agent announce step")) return false;
  if (lower.includes("\"encrypted_content\"")) return false;
  if (lower.includes("openclaw runtime context (internal)")) return false;
  if (lower.includes("conversation info (untrusted metadata)")) return false;
  if (lower.includes("internal_write_only")) return false;
  if (lower.includes("read heartbeat.md if it exists")) return false;
  if (content.includes("继续推进当前目标")) return false;
  if (content.includes("Alex Finn 流程最终验收")) return false;
  return true;
}

function formatStaffRecentOutput(message: SessionHistoryMessage, language: UiLanguage): string {
  if (message.kind === "tool_event") {
    return message.toolName?.trim()
      ? pickUiText(language, `Completed tool step: ${message.toolName}.`, `最近完成工具步骤：${message.toolName}。`)
      : pickUiText(language, "Completed a recent tool step.", "最近完成一次工具步骤。");
  }

  const content = sanitizeStaffOutputContent(message.content);
  if (!content) {
    return pickUiText(language, "No recent output yet.", "最近暂无产出。");
  }

  if (content === "NOOP") {
    return pickUiText(language, "Recent check completed with no action needed.", "最近完成一次检查，无需动作。");
  }
  if (content === "NO_REPLY") {
    return pickUiText(language, "Recent task completed without a user reply.", "最近完成一次任务，无需额外回复。");
  }
  if (content.toLowerCase().startsWith("successfully wrote ")) {
    return pickUiText(language, "Updated a memory or workspace file.", "最近更新了一份记忆或工作文件。");
  }
  if (
    content.startsWith("{") ||
    content.startsWith("[") ||
    content.startsWith("```json") ||
    content.includes('{"ok":') ||
    content.includes('"message_id"')
  ) {
    return pickUiText(language, "Recent task completed and returned a structured result.", "最近完成一次任务，并返回结构化结果。");
  }
  return safeTruncate(content, 88);
}

function sanitizeStaffOutputContent(content: string): string {
  let normalized = normalizeInlineText(content);
  if (!normalized) return normalized;
  normalized = normalized.replace(/^\[\[reply_to_current\]\]\s*/i, "");
  normalized = normalized.replace(/^\[[^\]]+\]\s*/, "");
  normalized = normalized.replace(/^warning:\s*background execution is disabled; running synchronously\.\s*/i, "");
  return normalized.trim();
}

function compareSessionSummariesByLatest(a: ReadModelSnapshot["sessions"][number], b: ReadModelSnapshot["sessions"][number]): number {
  const left = Date.parse(a.lastMessageAt ?? "");
  const right = Date.parse(b.lastMessageAt ?? "");
  const leftMs = Number.isNaN(left) ? 0 : left;
  const rightMs = Number.isNaN(right) ? 0 : right;
  if (leftMs !== rightMs) return rightMs - leftMs;
  return a.sessionKey.localeCompare(b.sessionKey);
}

export async function buildStaffOverviewCards(input: {
  snapshot: ReadModelSnapshot;
  client: ToolClient;
  members: TeamMemberSnapshot[];
  officeCards: OfficeSpaceCard[];
  executionAgentSummaries: ExecutionAgentSummary[];
  language: UiLanguage;
}): Promise<StaffOverviewCard[]> {
  const officeCardByKey = new Map(input.officeCards.map((item) => [normalizeLookupKey(item.agentId), item]));
  const executionByKey = new Map(input.executionAgentSummaries.map((item) => [normalizeLookupKey(item.agentId), item]));

  const memberList = input.members.length > 0
    ? input.members
    : input.executionAgentSummaries.map((item) => ({
        agentId: item.agentId,
        displayName: item.displayName,
        model: "unlisted",
        workspace: "unlisted",
        toolsProfile: "default",
      }));
  const recentActivityByKey = await loadCachedStaffRecentActivity(
    input.snapshot,
    input.client,
    memberList.map((member) => member.agentId),
    input.language,
  );

  return await Promise.all(memberList.map(async (member) => {
    const key = normalizeLookupKey(member.agentId);
    const office = officeCardByKey.get(key);
    const execution = executionByKey.get(key);
    const recentActivity = recentActivityByKey.get(key);
    const identity = office?.identity ?? deriveAgentAnimalIdentity(member.agentId);
    const roleLabel = await resolveStaffRoleLabel(member, input.language);
    const effectiveOfficeStatus = recentActivity?.statusOverride ?? office?.status;
    const currentWork = staffCurrentWorkLabel({
      office: office ? { ...office, status: effectiveOfficeStatus ?? office.status } : office,
      execution,
      language: input.language,
    });
    const recentOutput = recentActivity?.recentOutput
      ? recentActivity.recentOutput
      : pickUiText(input.language, "No recent output yet.", "最近暂无产出。");
    const scheduledLabel = (execution?.enabledCronJobs ?? 0) > 0
      ? pickUiText(input.language, "Scheduled", "已排班")
      : pickUiText(input.language, "Not scheduled", "未排班");
    return {
      agentId: member.agentId,
      displayName: member.displayName,
      identity,
      roleLabel,
      statusLabel: staffStatusLabel(effectiveOfficeStatus, input.language),
      currentWorkLabel: currentWork.label,
      currentWork: currentWork.value,
      recentOutput,
      scheduledLabel,
    };
  }));
}

function renderStaffOverviewCards(cards: StaffOverviewCard[], language: UiLanguage = "zh"): string {
  if (cards.length === 0) {
    return `<div class="empty-state">${escapeHtml(
      pickUiText(language, "No staff summary is available yet.", "当前没有可显示的员工摘要。"),
    )}</div>`;
  }

  return `<div class="staff-brief-grid">${cards
    .map((card) => {
      const avatar = `<div class="staff-avatar" style="--agent-accent:${escapeHtml(card.identity.accent)};" data-agent-id="${escapeHtml(card.agentId)}" data-animal="${escapeHtml(card.identity.animal)}">
        <div class="agent-stage" aria-hidden="true">
          <canvas class="agent-pixel-canvas" width="256" height="256"></canvas>
        </div>
      </div>`;
      return `<article class="staff-brief-card">
        <div class="staff-brief-head">
          ${avatar}
          <div class="staff-brief-identity">
            <h3>${escapeHtml(card.displayName)}</h3>
            <div class="staff-role">${escapeHtml(card.roleLabel)}</div>
          </div>
        </div>
        <dl class="staff-brief-list">
          <div class="staff-brief-row"><dt>${escapeHtml(pickUiText(language, "Status", "当前状态"))}</dt><dd>${escapeHtml(card.statusLabel)}</dd></div>
          <div class="staff-brief-row"><dt>${escapeHtml(card.currentWorkLabel)}</dt><dd>${escapeHtml(card.currentWork)}</dd></div>
          <div class="staff-brief-row"><dt>${escapeHtml(pickUiText(language, "Recent output", "最近产出"))}</dt><dd>${escapeHtml(card.recentOutput)}</dd></div>
          <div class="staff-brief-row"><dt>${escapeHtml(pickUiText(language, "In schedule", "是否在排班里"))}</dt><dd>${escapeHtml(card.scheduledLabel)}</dd></div>
        </dl>
      </article>`;
    })
    .join("")}</div>`;
}

function buildTaskExecutionChainCards(input: {
  tasks: TaskListItem[];
  sessions: ReadModelSnapshot["sessions"];
  sessionItems: SessionConversationListItem[];
  language: UiLanguage;
}): TaskExecutionChainCard[] {
  type SessionLike = {
    sessionKey: string;
    agentId?: string;
    state: AgentRunState;
    lastMessageAt?: string;
  };

  const previewByKey = new Map(input.sessionItems.map((item) => [item.sessionKey, item]));
  const snapshotByKey = new Map(input.sessions.map((session) => [session.sessionKey, session]));
  const usedSessionKeys = new Set<string>();

  const resolveCandidate = (sessionKey: string): TaskExecutionChainCard | undefined => {
    const preview = previewByKey.get(sessionKey);
    const snapshotSession = snapshotByKey.get(sessionKey);
    const sessionLike: SessionLike | undefined =
      preview ??
      snapshotSession ??
      (sessionKey.includes(":run:")
        ? {
            sessionKey,
            agentId: extractAgentIdFromSessionKey(sessionKey),
            state: "idle",
            lastMessageAt: undefined,
          }
        : undefined);
    if (!sessionLike) return undefined;

    const executionChain =
      preview?.executionChain ??
      inferSessionExecutionChainFromSessionKey({
        sessionKey: sessionLike.sessionKey,
        agentId: sessionLike.agentId,
        state: sessionLike.state,
        lastMessageAt: sessionLike.lastMessageAt,
      });
    if (!executionChain) return undefined;

    return {
      taskTitle: preview?.label ?? sessionLike.sessionKey,
      owner: preview?.agentId ?? sessionLike.agentId ?? pickUiText(input.language, "Unassigned", "未分配"),
      sessionKey: sessionLike.sessionKey,
      agentId: sessionLike.agentId,
      state: sessionLike.state,
      latestAt: pickLatestSessionActivityTimestamp(preview?.latestHistoryAt, sessionLike.lastMessageAt),
      latestSnippet: preview?.latestSnippet,
      executionChain,
      sessionHref: buildSessionDetailHref(sessionLike.sessionKey, input.language),
    };
  };

  const cards: TaskExecutionChainCard[] = [];
  for (const task of input.tasks) {
    const candidates = [...new Set(task.sessionKeys)]
      .map((sessionKey) => resolveCandidate(sessionKey))
      .filter((item): item is TaskExecutionChainCard => Boolean(item))
      .sort(compareTaskExecutionChainCards);
    if (candidates.length === 0) continue;

    const chosen = candidates[0];
    usedSessionKeys.add(chosen.sessionKey);
    if (chosen.executionChain.parentSessionKey) usedSessionKeys.add(chosen.executionChain.parentSessionKey);
    if (chosen.executionChain.childSessionKey) usedSessionKeys.add(chosen.executionChain.childSessionKey);
    cards.push({
      ...chosen,
      taskId: task.taskId,
      taskTitle: task.title,
      projectTitle: task.projectTitle,
      owner: task.owner,
      taskHref: buildTaskDetailHref(task.taskId, input.language),
    });
  }

  const unmappedSessions = [
    ...input.sessionItems
      .map((item) => resolveCandidate(item.sessionKey))
      .filter((item): item is TaskExecutionChainCard => Boolean(item)),
    ...input.sessions
      .map((session) => resolveCandidate(session.sessionKey))
      .filter((item): item is TaskExecutionChainCard => Boolean(item)),
  ];
  const dedupedUnmapped = new Map<string, TaskExecutionChainCard>();
  for (const item of unmappedSessions) {
    if (dedupedUnmapped.has(item.sessionKey)) continue;
    dedupedUnmapped.set(item.sessionKey, item);
  }

  for (const item of dedupedUnmapped.values()) {
    if (!item.executionChain.spawned) continue;
    if (usedSessionKeys.has(item.sessionKey)) continue;
    cards.push({
      ...item,
      taskTitle: item.latestSnippet?.trim()
        ? safeTruncate(item.latestSnippet.trim(), 64)
        : pickUiText(input.language, "Isolated execution session", "隔离执行会话"),
      owner: item.agentId ?? pickUiText(input.language, "Unassigned", "未分配"),
      unmapped: true,
    });
  }

  return cards.sort(compareTaskExecutionChainCards);
}

function compareTaskExecutionChainCards(a: TaskExecutionChainCard, b: TaskExecutionChainCard): number {
  if (a.unmapped !== b.unmapped) return a.unmapped ? 1 : -1;
  const stageRank = executionChainStageRank(b.executionChain.stage) - executionChainStageRank(a.executionChain.stage);
  if (stageRank !== 0) return stageRank;
  const timeRank = toSortableMs(b.latestAt) - toSortableMs(a.latestAt);
  if (timeRank !== 0) return timeRank;
  return a.sessionKey.localeCompare(b.sessionKey);
}

function summarizeVisibleSessionSnippet(
  rawSnippet: string | undefined,
  language: UiLanguage = "zh",
  maxLength = 96,
): string {
  const normalized = normalizeInlineText(rawSnippet ?? "");
  if (!normalized) {
    return pickUiText(language, "No recent summary yet.", "暂无最近摘要。");
  }
  const structured = summarizeStructuredSessionPayload(normalized, language);
  return safeTruncate(structured ?? normalized, maxLength);
}

function summarizeStructuredSessionPayload(input: string, language: UiLanguage): string | undefined {
  const trimmed = input.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return summarizeStructuredKeyValueText(trimmed, language);
  }
  try {
    const parsed = summarizeStructuredSessionValue(JSON.parse(trimmed) as unknown, language);
    if (parsed) return parsed;
  } catch {
    // fall through to best-effort parsing of truncated JSON-like text
  }
  return summarizeStructuredSessionTextFallback(trimmed, language);
}

function summarizeStructuredKeyValueText(input: string, language: UiLanguage): string | undefined {
  const parts = input
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2 || !parts.some((part) => part.includes("="))) return undefined;

  const values = new Map<string, string>();
  for (const part of parts) {
    const [rawKey, ...rest] = part.split("=");
    const key = rawKey?.trim().toLowerCase();
    const value = rest.join("=").trim();
    if (!key || !value) continue;
    values.set(key, value);
  }
  if (values.size === 0) return undefined;

  const segments: string[] = [];
  const accepted = values.get("accepted");
  if (accepted) {
    segments.push(
      isTruthyFlag(accepted)
        ? pickUiText(language, "Accepted", "已接单")
        : pickUiText(language, "Not accepted", "未接单"),
    );
  }
  const spawned = values.get("spawned");
  if (spawned) {
    segments.push(
      isTruthyFlag(spawned)
        ? pickUiText(language, "Spawned", "已派发")
        : pickUiText(language, "Pending spawn", "待派发"),
    );
  }
  const scanned = numericSummarySegment(values.get("scanned"), language, "Scanned", "扫描");
  if (scanned) segments.push(scanned);
  const sent = numericSummarySegment(values.get("sent"), language, "Sent", "发送");
  if (sent) segments.push(sent);
  const attempted = numericSummarySegment(values.get("attemptedqueries"), language, "Queries", "查询");
  if (attempted) segments.push(attempted);
  const successful = numericSummarySegment(values.get("successfulqueries"), language, "Successful", "成功");
  if (successful) segments.push(successful);
  const source = values.get("source");
  if (source?.trim()) {
    const normalized = normalizeLookupKey(source);
    const sourceLabel =
      normalized === "session_key"
        ? pickUiText(language, "Session-key inferred", "会话键推断")
        : normalized === "history"
          ? pickUiText(language, "History derived", "历史推导")
          : safeTruncate(normalizeInlineText(source), 32);
    segments.push(sourceLabel);
  }
  const inferred = values.get("inferred");
  if (inferred && isTruthyFlag(inferred)) {
    segments.push(pickUiText(language, "Best-effort", "推断值"));
  }

  return segments.length > 0 ? segments.slice(0, 5).join(" · ") : undefined;
}

function numericSummarySegment(
  rawValue: string | undefined,
  language: UiLanguage,
  enLabel: string,
  zhLabel: string,
): string | undefined {
  if (!rawValue) return undefined;
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return undefined;
  return `${pickUiText(language, enLabel, zhLabel)} ${formatInt(value)}`;
}

function isTruthyFlag(input: string): boolean {
  return /^(?:1|true|yes|y)$/i.test(input.trim());
}

function summarizeStructuredSessionValue(input: unknown, language: UiLanguage): string | undefined {
  if (input === null || input === undefined) return undefined;
  if (typeof input === "string") {
    const normalized = normalizeInlineText(input);
    if (!normalized) return undefined;
    return normalized;
  }
  if (typeof input === "number" || typeof input === "boolean") {
    return String(input);
  }
  if (Array.isArray(input)) {
    if (input.length === 0) return pickUiText(language, "Empty result", "空结果");
    const first = summarizeStructuredSessionValue(input[0], language);
    if (first?.trim()) {
      const suffix =
        input.length > 1
          ? ` · ${formatInt(input.length)} ${pickUiText(language, "items", "项")}`
          : "";
      return `${first}${suffix}`;
    }
    return `${formatInt(input.length)} ${pickUiText(language, "items", "项")}`;
  }
  if (typeof input !== "object") return undefined;

  const obj = input as Record<string, unknown>;
  const explicitText = firstStructuredSessionText(obj);
  if (explicitText) return explicitText;

  const segments: string[] = [];
  if (typeof obj.ok === "boolean") {
    segments.push(pickUiText(language, obj.ok ? "Succeeded" : "Failed", obj.ok ? "成功" : "失败"));
  }
  const errorText = boundedStructuredSessionText(obj.error, 48);
  if (errorText) {
    segments.push(`${pickUiText(language, "Error", "错误")} ${errorText}`);
  }

  const counters: Array<[string, string, string]> = [
    ["attemptedQueries", "Queries", "查询"],
    ["successfulQueries", "Successful", "成功"],
    ["scanned", "Scanned", "扫描"],
    ["qualified", "Qualified", "入选"],
    ["sent", "Sent", "发送"],
    ["candidatesLoaded", "Loaded", "载入"],
    ["matches", "Matches", "匹配"],
    ["created", "Created", "新建"],
    ["updated", "Updated", "更新"],
    ["written", "Written", "写入"],
    ["deleted", "Deleted", "删除"],
  ];
  for (const [key, enLabel, zhLabel] of counters) {
    const value = obj[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    segments.push(`${pickUiText(language, enLabel, zhLabel)} ${formatInt(value)}`);
    if (segments.length >= 5) break;
  }

  if (segments.length > 0) return segments.join(" · ");
  return undefined;
}

function firstStructuredSessionText(obj: Record<string, unknown>): string | undefined {
  const keys = ["summary", "message", "detail", "reason", "statusText", "status", "result", "output", "response"];
  for (const key of keys) {
    const text = boundedStructuredSessionText(obj[key], 88);
    if (text) return text;
  }
  return undefined;
}

function boundedStructuredSessionText(input: unknown, maxLength: number): string | undefined {
  if (typeof input !== "string") return undefined;
  const normalized = normalizeInlineText(input);
  if (!normalized || normalized.startsWith("{") || normalized.startsWith("[")) return undefined;
  return safeTruncate(normalized, maxLength);
}

function summarizeStructuredSessionTextFallback(input: string, language: UiLanguage): string | undefined {
  const segments: string[] = [];
  const okMatch = /"ok"\s*:\s*(true|false)/i.exec(input);
  if (okMatch) {
    segments.push(pickUiText(language, okMatch[1] === "true" ? "Succeeded" : "Failed", okMatch[1] === "true" ? "成功" : "失败"));
  }
  const errorMatch = /"error"\s*:\s*"([^"]+)"/i.exec(input);
  if (errorMatch?.[1]?.trim()) {
    segments.push(`${pickUiText(language, "Error", "错误")} ${safeTruncate(normalizeInlineText(errorMatch[1]), 48)}`);
  }

  const counters: Array<[RegExp, string, string]> = [
    [/"attemptedQueries"\s*:\s*(-?\d+(?:\.\d+)?)/i, "Queries", "查询"],
    [/"successfulQueries"\s*:\s*(-?\d+(?:\.\d+)?)/i, "Successful", "成功"],
    [/"scanned"\s*:\s*(-?\d+(?:\.\d+)?)/i, "Scanned", "扫描"],
    [/"qualified"\s*:\s*(-?\d+(?:\.\d+)?)/i, "Qualified", "入选"],
    [/"sent"\s*:\s*(-?\d+(?:\.\d+)?)/i, "Sent", "发送"],
    [/"candidatesLoaded"\s*:\s*(-?\d+(?:\.\d+)?)/i, "Loaded", "载入"],
    [/"matches"\s*:\s*(-?\d+(?:\.\d+)?)/i, "Matches", "匹配"],
    [/"created"\s*:\s*(-?\d+(?:\.\d+)?)/i, "Created", "新建"],
    [/"updated"\s*:\s*(-?\d+(?:\.\d+)?)/i, "Updated", "更新"],
    [/"written"\s*:\s*(-?\d+(?:\.\d+)?)/i, "Written", "写入"],
    [/"deleted"\s*:\s*(-?\d+(?:\.\d+)?)/i, "Deleted", "删除"],
  ];
  for (const [pattern, enLabel, zhLabel] of counters) {
    const match = pattern.exec(input);
    if (!match?.[1]) continue;
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    segments.push(`${pickUiText(language, enLabel, zhLabel)} ${formatInt(value)}`);
    if (segments.length >= 5) break;
  }

  if (segments.length > 0) return segments.join(" · ");
  return undefined;
}

function looksLikeStructuredExecutionTitle(input: string): boolean {
  const normalized = normalizeInlineText(input);
  if (!normalized) return true;
  if (normalized.startsWith("{") || normalized.startsWith("[")) return true;
  if (normalized.startsWith("agent:")) return true;
  if (/[{"\[]/.test(normalized) && /"[^"]+"\s*:/.test(normalized)) return true;
  return false;
}

function executionChainFallbackTitle(item: TaskExecutionChainCard, language: UiLanguage): string {
  const agentLabel = humanizeOperatorLabel(item.agentId ?? item.owner ?? "main");
  if (item.unmapped) {
    const sessionKind = extractCronJobIdFromSessionKey(item.sessionKey)
      ? pickUiText(language, "Cron isolated run", "Cron 隔离执行")
      : pickUiText(language, "Isolated execution session", "隔离执行会话");
    return `${agentLabel} · ${sessionKind}`;
  }
  const projectLabel = normalizeInlineText(item.projectTitle ?? "");
  if (projectLabel) {
    return `${safeTruncate(projectLabel, 36)} · ${pickUiText(language, "Linked task", "关联任务")}`;
  }
  if (item.taskId?.trim()) {
    return `${pickUiText(language, "Task", "任务")} ${safeTruncate(item.taskId.trim(), 32)}`;
  }
  return `${agentLabel} · ${pickUiText(language, "Linked task", "关联任务")}`;
}

function executionChainCardTitle(item: TaskExecutionChainCard, language: UiLanguage): string {
  if (item.unmapped) return executionChainFallbackTitle(item, language);

  const normalizedTitle = normalizeInlineText(item.taskTitle ?? "");
  if (!normalizedTitle) return executionChainFallbackTitle(item, language);
  if (!looksLikeStructuredExecutionTitle(normalizedTitle)) return safeTruncate(normalizedTitle, 88);

  const structuredTitle = summarizeStructuredSessionPayload(normalizedTitle, language);
  if (structuredTitle?.trim()) return safeTruncate(structuredTitle, 88);
  return executionChainFallbackTitle(item, language);
}

function executionChainStageRank(stage: SessionExecutionChainSummary["stage"]): number {
  switch (stage) {
    case "running":
      return 4;
    case "spawned":
      return 3;
    case "accepted":
      return 2;
    case "idle":
    default:
      return 1;
  }
}

function executionChainStageLabel(
  stage: SessionExecutionChainSummary["stage"],
  language: UiLanguage = "zh",
): string {
  switch (stage) {
    case "running":
      return pickUiText(language, "Running", "执行中");
    case "spawned":
      return pickUiText(language, "Spawned", "已派发");
    case "accepted":
      return pickUiText(language, "Accepted", "已接单");
    case "idle":
    default:
      return pickUiText(language, "Idle", "待命");
  }
}

function executionChainSourceLabel(
  chain: SessionExecutionChainSummary,
  language: UiLanguage = "zh",
): string {
  if (chain.source === "history") {
    return chain.inferred
      ? pickUiText(language, "History signal (best effort)", "历史信号（最佳努力）")
      : pickUiText(language, "History evidence", "历史证据");
  }
  return pickUiText(language, "Session-key inference", "会话键推断");
}

function extractAgentIdFromSessionKey(sessionKey: string): string | undefined {
  const match = /^agent:([^:]+)/.exec(sessionKey.trim());
  return match?.[1];
}

function extractCronJobIdFromSessionKey(sessionKey: string): string | undefined {
  const match = /^agent:[^:]+:cron:([^:]+)/.exec(sessionKey.trim());
  return match?.[1];
}

function renderTaskExecutionChainCards(
  cards: TaskExecutionChainCard[],
  language: UiLanguage = "zh",
): string {
  if (cards.length === 0) {
    return `<div class="empty-state">${escapeHtml(
      pickUiText(
        language,
        "No accepted/spawn execution chains are visible yet. They will appear once isolated sessions are dispatched.",
        "当前还没有可见的接单/派发执行链。隔离会话开始派发后会显示。",
      ),
    )}</div>`;
  }

  return `<div class="execution-chain-list">${cards
    .slice(0, 10)
    .map((item) => {
      const chain = item.executionChain;
      const acceptedBadge = badge(chain.accepted ? "ok" : "idle", pickUiText(language, "Accepted", "已接单"));
      const spawnedBadge = badge(chain.spawned ? "info" : "idle", pickUiText(language, "Spawned", "已派发"));
      const stageBadge = badge(chain.stage, executionChainStageLabel(chain.stage, language));
      const runStateBadge = badge(item.state, sessionStateLabel(item.state));
      const ownerLabel = humanizeOperatorLabel(item.owner);
      const title = executionChainCardTitle(item, language);
      const taskMeta = item.unmapped
        ? pickUiText(language, "No linked task", "未关联任务")
        : item.projectTitle ?? pickUiText(language, "Linked task", "已关联任务");
      const contextLine = [taskMeta, `${pickUiText(language, "Agent", "智能体")} ${ownerLabel}`]
        .filter(Boolean)
        .join(" · ");
      const sessionFlow = [chain.parentSessionKey, chain.childSessionKey]
        .filter((value, idx, arr): value is string => Boolean(value) && arr.indexOf(value) === idx)
        .map((value) => `<code>${escapeHtml(value)}</code>`)
        .join(' <span class="execution-chain-arrow">→</span> ');
      const latestLine = item.latestAt
        ? `${pickUiText(language, "Latest", "最近")} ${escapeHtml(item.latestAt)}`
        : escapeHtml(pickUiText(language, "No history yet", "暂无历史"));
      const sourceLine = executionChainSourceLabel(chain, language);
      const summarySource = item.latestSnippet?.trim() ? item.latestSnippet : chain.detail;
      const summaryLine = escapeHtml(summarizeVisibleSessionSnippet(summarySource, language, 96));
      return `<article class="execution-chain-card">
        <div class="execution-chain-head">
          <div class="execution-chain-copy">
            <strong>${escapeHtml(title)}</strong>
            <div class="execution-chain-context">${escapeHtml(contextLine)}</div>
          </div>
          <div class="execution-chain-badges">${stageBadge}${runStateBadge}${acceptedBadge}${spawnedBadge}</div>
        </div>
        <div class="execution-chain-meta-stack">
          <div class="execution-chain-meta-line">${escapeHtml(sourceLine)} · ${latestLine}</div>
          <div class="execution-chain-flow">${sessionFlow || `<code>${escapeHtml(item.sessionKey)}</code>`}</div>
          <div class="execution-chain-summary">${summaryLine}</div>
        </div>
        <div class="execution-chain-actions">
          <a class="btn" href="${escapeHtml(item.sessionHref)}">${escapeHtml(pickUiText(language, "Open session", "查看会话"))}</a>
          ${
            item.taskHref
              ? `<a class="btn" href="${escapeHtml(item.taskHref)}">${escapeHtml(pickUiText(language, "Open task", "查看任务"))}</a>`
              : ""
          }
        </div>
      </article>`;
    })
    .join("")}</div>`;
}

function buildCollaborationThreadCards(input: {
  cards: TaskExecutionChainCard[];
  sessionItems: SessionConversationListItem[];
  language: UiLanguage;
}): CollaborationThreadCard[] {
  const sessionByKey = new Map(input.sessionItems.map((item) => [item.sessionKey, item]));

  const resolved: CollaborationThreadCard[] = input.cards.map((card): CollaborationThreadCard => {
    const chain = card.executionChain;
    const parentSessionKey = chain.parentSessionKey ?? card.sessionKey;
    const childSessionKey = chain.childSessionKey;
    const hasChildSession = Boolean(childSessionKey);
    const parentSession = sessionByKey.get(parentSessionKey);
    const childSession = childSessionKey ? sessionByKey.get(childSessionKey) : undefined;
    const ownerAgentId = normalizeAgentIdCandidate(card.agentId ?? card.owner);
    const parentAgentId =
      normalizeAgentIdCandidate(parentSession?.agentId) ??
      normalizeAgentIdCandidate(extractAgentIdFromSessionKey(parentSessionKey ?? "")) ??
      ownerAgentId ??
      "main";
    const childAgentId =
      normalizeAgentIdCandidate(childSession?.agentId) ??
      normalizeAgentIdCandidate(extractAgentIdFromSessionKey(childSessionKey ?? "")) ??
      normalizeAgentIdCandidate(card.agentId) ??
      parentAgentId;
    const routeAgentIds = childSessionKey ? [parentAgentId, childAgentId] : [parentAgentId];
    const status = resolveCollaborationThreadStatus(card);
    const currentOwnerAgentId = resolveCollaborationCurrentOwner(card, parentAgentId, childAgentId);
    const currentOwnerRole: "parent" | "child" = hasChildSession || chain.spawned ? "child" : "parent";
    const latestAt = pickLatestTimestamp([
      childSession?.latestHistoryAt,
      childSession?.lastMessageAt,
      parentSession?.latestHistoryAt,
      parentSession?.lastMessageAt,
      card.latestAt,
      chain.spawnedAt,
      chain.acceptedAt,
    ]);
    const participants = routeAgentIds.map((agentId, index) => ({
      agentId,
      label: humanizeOperatorLabel(agentId),
      identity: deriveAgentAnimalIdentity(agentId),
      current: normalizeLookupKey(agentId) === normalizeLookupKey(currentOwnerAgentId ?? ""),
      roleLabel: collaborationParticipantRoleLabel(index === 0 ? "parent" : "child", input.language),
    }));
    const uniqueParticipantCount = new Set(routeAgentIds.map((agentId) => normalizeLookupKey(agentId))).size;
    const multiAgent = uniqueParticipantCount > 1;
    const mainDispatched =
      routeAgentIds.length > 1 && normalizeLookupKey(routeAgentIds[0] ?? "") === "main";
    const routeTitle = collaborationRouteLabel(parentAgentId, childAgentId, hasChildSession, input.language);
    const taskTitle = deriveCollaborationTaskTitle({
      card,
      parentSession,
      childSession,
      language: input.language,
    });
    const latestSnippetSource =
      childSession?.latestSnippet ?? parentSession?.latestSnippet ?? card.latestSnippet ?? chain.detail;
    const latestSnippet = summarizeVisibleSessionSnippet(latestSnippetSource, input.language, 120);
    const timeline = buildCollaborationTimelineSteps({
      card,
      parentAgentId,
      childAgentId,
      parentSession,
      childSession,
      language: input.language,
    });

    return {
      id: `${card.sessionKey}:${routeAgentIds.join("->")}`,
      kind: "parent_child",
      sessionKey: card.sessionKey,
      taskTitle,
      routeTitle,
      summary: collaborationThreadSummary({
        card,
        status,
        parentAgentId,
        childAgentId,
        language: input.language,
      }),
      status,
      statusBadge: collaborationThreadStatusLabel(status, input.language),
      kindBadge: collaborationThreadKindLabel("parent_child", input.language),
      currentOwnerLabel: collaborationRoleAgentLabel(
        currentOwnerRole,
        currentOwnerAgentId ?? routeAgentIds.at(-1) ?? parentAgentId,
        input.language,
      ),
      currentOwnerAgentId,
      currentOwnerRole,
      latestAt,
      latestAtLabel: latestAt
        ? pickUiText(input.language, `Updated ${formatTimeAgoFromNow(latestAt, input.language)}`, `最近更新 ${formatTimeAgoFromNow(latestAt, input.language)}`)
        : pickUiText(input.language, "No visible update yet", "还没有可见更新"),
      participants,
      routeJoiner: "→",
      multiAgent,
      mainDispatched,
      aggregateCount: 1,
      aggregateItems: [{ sessionKey: card.sessionKey, sessionHref: card.sessionHref, latestAt }],
      taskHref: card.taskHref,
      sessionHref: card.sessionHref,
      timeline,
      latestSnippet,
      sourceLabel: executionChainSourceLabel(chain, input.language),
      parentSessionKey,
      childSessionKey,
    };
  });

  const grouped = foldCollaborationThreadCards(resolved, input.language);

  return grouped.sort((a, b) => {
    const statusRank = collaborationStatusRank(b.status) - collaborationStatusRank(a.status);
    if (statusRank !== 0) return statusRank;
    const timeRank = toSortableMs(b.latestAt) - toSortableMs(a.latestAt);
    if (timeRank !== 0) return timeRank;
    return a.routeTitle.localeCompare(b.routeTitle);
  });
}

function foldCollaborationThreadCards(
  cards: CollaborationThreadCard[],
  language: UiLanguage,
): CollaborationThreadCard[] {
  const passthrough: CollaborationThreadCard[] = [];
  const groups = new Map<string, CollaborationThreadCard[]>();

  for (const card of cards) {
    const shouldFold = card.status === "completed" && !card.multiAgent;
    if (!shouldFold) {
      passthrough.push(card);
      continue;
    }
    const groupKey = [
      normalizeLookupKey(card.routeTitle),
      normalizeLookupKey(card.taskTitle),
      normalizeLookupKey(card.currentOwnerAgentId ?? ""),
    ].join("::");
    const existing = groups.get(groupKey) ?? [];
    existing.push(card);
    groups.set(groupKey, existing);
  }

  const folded: CollaborationThreadCard[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      folded.push(group[0]);
      continue;
    }
    const ordered = [...group].sort((a, b) => toSortableMs(b.latestAt) - toSortableMs(a.latestAt));
    const latest = ordered[0];
    const aggregateItems = ordered.map((item) => ({
      sessionKey: item.sessionKey,
      sessionHref: item.sessionHref,
      latestAt: item.latestAt,
    }));
    const ownerLabel = latest.currentOwnerLabel;
    const countLabel = pickUiText(language, `${group.length} similar runs`, `${group.length} 条相近协作`);
    folded.push({
      ...latest,
      summary: pickUiText(
        language,
        `${ownerLabel} finished ${group.length} similar collaboration runs recently. The latest timeline stays expanded here, and the rest are folded into this card.`,
        `${ownerLabel} 最近完成了 ${group.length} 条相近协作。这里保留最新一条时间线，其余同类线程已折叠到这张卡里。`,
      ),
      latestAtLabel: latest.latestAt
        ? pickUiText(
            language,
            `Updated ${formatTimeAgoFromNow(latest.latestAt, language)} · ${countLabel}`,
            `最近更新 ${formatTimeAgoFromNow(latest.latestAt, language)} · ${countLabel}`,
          )
        : pickUiText(language, `No visible update yet · ${countLabel}`, `还没有可见更新 · ${countLabel}`),
      aggregateCount: group.length,
      aggregateItems,
      sourceLabel: pickUiText(
        language,
        `Showing the latest representative thread. ${group.length} similar completed runs are folded together.`,
        `当前展示最新一条代表线程；另有 ${group.length} 条相近的已完成协作已折叠显示。`,
      ),
    });
  }

  return [...passthrough, ...folded];
}

function buildInterSessionCollaborationCards(input: {
  sessionItems: SessionConversationListItem[];
  language: UiLanguage;
}): CollaborationThreadCard[] {
  const sessionByKey = new Map(input.sessionItems.map((item) => [item.sessionKey, item]));
  const grouped = new Map<
    string,
    Array<{
      sourceSessionKey: string;
      targetSessionKey: string;
      sourceTool?: string;
      snippet: string;
      at?: string;
    }>
  >();

  for (const targetSession of input.sessionItems) {
    for (const signal of targetSession.interSessionSignals ?? []) {
      const sourceKey = signal.sourceSessionKey.trim();
      const targetKey = targetSession.sessionKey.trim();
      if (!sourceKey || !targetKey || normalizeLookupKey(sourceKey) === normalizeLookupKey(targetKey)) continue;
      const sourceSession = sessionByKey.get(sourceKey);
      const taskSeed = normalizeLookupKey(
        deriveInterSessionTaskTitle({
          signalSnippet: signal.snippet,
          sourceSession,
          targetSession,
          language: input.language,
        }),
      );
      const pairKey = [sourceKey, targetKey].sort().join("::");
      const groupKey = `${pairKey}::${taskSeed || "shared"}`;
      const existing = grouped.get(groupKey) ?? [];
      existing.push({
        sourceSessionKey: sourceKey,
        targetSessionKey: targetKey,
        sourceTool: signal.sourceTool,
        snippet: signal.snippet,
        at: signal.timestamp,
      });
      grouped.set(groupKey, existing);
    }
  }

  const cards: CollaborationThreadCard[] = [];
  for (const signals of grouped.values()) {
    const orderedSignals = [...signals].sort((a, b) => toSortableMs(a.at) - toSortableMs(b.at));
    const latest = orderedSignals.at(-1);
    if (!latest) continue;

    const sourceSession = sessionByKey.get(latest.sourceSessionKey);
    const targetSession = sessionByKey.get(latest.targetSessionKey);
    const sourceAgentId =
      normalizeAgentIdCandidate(sourceSession?.agentId) ??
      normalizeAgentIdCandidate(extractAgentIdFromSessionKey(latest.sourceSessionKey)) ??
      "main";
    const targetAgentId =
      normalizeAgentIdCandidate(targetSession?.agentId) ??
      normalizeAgentIdCandidate(extractAgentIdFromSessionKey(latest.targetSessionKey)) ??
      "main";
    const bidirectional =
      orderedSignals.some(
        (signal) =>
          normalizeLookupKey(signal.sourceSessionKey) === normalizeLookupKey(latest.targetSessionKey) &&
          normalizeLookupKey(signal.targetSessionKey) === normalizeLookupKey(latest.sourceSessionKey),
      );
    const latestAt = pickLatestTimestamp([
      latest.at,
      targetSession?.latestHistoryAt,
      targetSession?.lastMessageAt,
      sourceSession?.latestHistoryAt,
      sourceSession?.lastMessageAt,
    ]);
    const status = resolveInterSessionCollaborationStatus({
      sourceSession,
      targetSession,
      bidirectional,
    });
    const currentOwnerAgentId = targetAgentId;
    const taskTitle = deriveInterSessionTaskTitle({
      signalSnippet: latest.snippet,
      sourceSession,
      targetSession,
      language: input.language,
    });
    const participants: CollaborationParticipant[] = [
      {
        agentId: sourceAgentId,
        label: humanizeOperatorLabel(sourceAgentId),
        identity: deriveAgentAnimalIdentity(sourceAgentId),
        current: normalizeLookupKey(sourceAgentId) === normalizeLookupKey(currentOwnerAgentId),
        roleLabel: pickUiText(input.language, "Sending session", "发送会话"),
      },
      {
        agentId: targetAgentId,
        label: humanizeOperatorLabel(targetAgentId),
        identity: deriveAgentAnimalIdentity(targetAgentId),
        current: normalizeLookupKey(targetAgentId) === normalizeLookupKey(currentOwnerAgentId),
        roleLabel: pickUiText(input.language, "Receiving session", "接收会话"),
      },
    ];
    cards.push({
      id: `inter-session:${latest.sourceSessionKey}->${latest.targetSessionKey}:${normalizeLookupKey(taskTitle)}`,
      kind: "inter_session",
      sessionKey: latest.targetSessionKey,
      taskTitle,
      routeTitle: collaborationInterSessionRouteLabel(sourceAgentId, targetAgentId, input.language),
      summary: collaborationInterSessionSummary({
        status,
        sourceAgentId,
        targetAgentId,
        bidirectional,
        language: input.language,
      }),
      status,
      statusBadge: collaborationThreadStatusLabel(status, input.language),
      kindBadge: collaborationThreadKindLabel("inter_session", input.language),
      currentOwnerLabel: collaborationInterSessionCurrentOwnerLabel(targetAgentId, input.language),
      currentOwnerAgentId,
      currentOwnerRole: "target",
      latestAt,
      latestAtLabel: latestAt
        ? pickUiText(input.language, `Updated ${formatTimeAgoFromNow(latestAt, input.language)}`, `最近更新 ${formatTimeAgoFromNow(latestAt, input.language)}`)
        : pickUiText(input.language, "No visible update yet", "还没有可见更新"),
      participants,
      routeJoiner: "⇄",
      multiAgent: normalizeLookupKey(sourceAgentId) !== normalizeLookupKey(targetAgentId),
      mainDispatched: normalizeLookupKey(sourceAgentId) === "main",
      aggregateCount: 1,
      aggregateItems: [
        {
          sessionKey: latest.targetSessionKey,
          sessionHref: buildSessionDetailHref(latest.targetSessionKey, input.language),
          latestAt,
        },
      ],
      taskHref: undefined,
      sessionHref: buildSessionDetailHref(latest.targetSessionKey, input.language),
      timeline: buildInterSessionCollaborationTimelineSteps({
        sourceAgentId,
        targetAgentId,
        sourceSession,
        targetSession,
        signals: orderedSignals,
        language: input.language,
      }),
      latestSnippet: summarizeVisibleSessionSnippet(latest.snippet, input.language, 140),
      sourceLabel: pickUiText(
        input.language,
        `Verified via inter-session message (${latest.sourceTool ?? "inter-session"}).`,
        `已通过跨会话消息验证（${latest.sourceTool ?? "inter-session"}）。`,
      ),
      parentSessionKey: latest.sourceSessionKey,
      childSessionKey: latest.targetSessionKey,
    });
  }

  return cards;
}

function mergeCollaborationThreadCards(
  primary: CollaborationThreadCard[],
  secondary: CollaborationThreadCard[],
): CollaborationThreadCard[] {
  const combined = [...primary, ...secondary];
  return combined.sort((a, b) => {
    const statusRank = collaborationStatusRank(b.status) - collaborationStatusRank(a.status);
    if (statusRank !== 0) return statusRank;
    const timeRank = toSortableMs(b.latestAt) - toSortableMs(a.latestAt);
    if (timeRank !== 0) return timeRank;
    if (a.kind !== b.kind) return a.kind === "inter_session" ? -1 : 1;
    return a.routeTitle.localeCompare(b.routeTitle);
  });
}

function collaborationThreadKindLabel(
  kind: CollaborationThreadKind,
  language: UiLanguage = "zh",
): string {
  if (kind === "inter_session") {
    return pickUiText(language, "Cross-session communication", "跨会话通信");
  }
  return pickUiText(language, "Parent-child relay", "父子协作");
}

function deriveInterSessionTaskTitle(input: {
  signalSnippet: string;
  sourceSession?: SessionConversationListItem;
  targetSession?: SessionConversationListItem;
  language: UiLanguage;
}): string {
  const candidates = [
    input.sourceSession?.taskSnippet,
    input.targetSession?.taskSnippet,
    input.sourceSession?.label,
    input.targetSession?.label,
    input.signalSnippet,
    input.sourceSession?.latestSnippet,
    input.targetSession?.latestSnippet,
  ];
  for (const candidate of candidates) {
    const derived = extractCollaborationTaskLabel(candidate ?? "", input.language);
    if (derived?.trim()) return derived;
  }
  return pickUiText(input.language, "Cross-session communication", "跨会话沟通");
}

function resolveInterSessionCollaborationStatus(input: {
  sourceSession?: SessionConversationListItem;
  targetSession?: SessionConversationListItem;
  bidirectional: boolean;
}): CollaborationThreadStatus {
  const states = [input.sourceSession?.state, input.targetSession?.state];
  if (states.some((state) => state === "blocked" || state === "error" || state === "waiting_approval")) {
    return "blocked";
  }
  if (states.some((state) => state === "running")) {
    return "active";
  }
  if (!input.bidirectional) {
    return "handoff";
  }
  const latestAt = pickLatestTimestamp([
    input.sourceSession?.latestHistoryAt,
    input.sourceSession?.lastMessageAt,
    input.targetSession?.latestHistoryAt,
    input.targetSession?.lastMessageAt,
  ]);
  const latestMs = toSortableMs(latestAt);
  if (latestMs && Date.now() - latestMs <= 15 * 60 * 1000) {
    return "active";
  }
  return "completed";
}

function collaborationInterSessionRouteLabel(
  sourceAgentId: string,
  targetAgentId: string,
  language: UiLanguage = "zh",
): string {
  return `${pickUiText(language, "Sending session", "发送会话")} ${humanizeOperatorLabel(sourceAgentId)} ⇄ ${pickUiText(language, "Receiving session", "接收会话")} ${humanizeOperatorLabel(targetAgentId)}`;
}

function collaborationInterSessionSummary(input: {
  status: CollaborationThreadStatus;
  sourceAgentId: string;
  targetAgentId: string;
  bidirectional: boolean;
  language: UiLanguage;
}): string {
  const sourceLabel = humanizeOperatorLabel(input.sourceAgentId);
  const targetLabel = humanizeOperatorLabel(input.targetAgentId);
  if (input.status === "blocked") {
    return pickUiText(
      input.language,
      `${targetLabel} did not finish the latest cross-session reply and needs follow-up.`,
      `${targetLabel} 没有顺利完成最近一轮跨会话回复，当前需要跟进。`,
    );
  }
  if (input.status === "active") {
    return input.bidirectional
      ? pickUiText(
          input.language,
          `${sourceLabel} and ${targetLabel} are actively exchanging messages between existing sessions.`,
          `${sourceLabel} 和 ${targetLabel} 正在已有会话之间来回通信。`,
        )
      : pickUiText(
          input.language,
          `${sourceLabel} has sent a message into ${targetLabel}'s existing session, and the visible reply is still in progress.`,
          `${sourceLabel} 已向 ${targetLabel} 的既有会话发出消息，当前还在等待这轮可见回复继续回来。`,
        );
  }
  if (input.status === "handoff") {
    return pickUiText(
      input.language,
      `${sourceLabel} has sent a message into ${targetLabel}'s existing session. The next visible reply has not returned yet.`,
      `${sourceLabel} 已把消息投递到 ${targetLabel} 的既有会话，下一条可见回复还没有回来。`,
    );
  }
  return input.bidirectional
    ? pickUiText(
        input.language,
        `${targetLabel} has already replied through its existing session. The latest visible exchange is complete.`,
        `${targetLabel} 已经通过自己的既有会话回了信，最近一轮可见通信已经完成。`,
      )
    : pickUiText(
        input.language,
        `${sourceLabel} finished the latest visible cross-session exchange with ${targetLabel}.`,
        `${sourceLabel} 和 ${targetLabel} 最近一轮可见跨会话通信已经结束。`,
      );
}

function collaborationInterSessionCurrentOwnerLabel(
  currentOwnerAgentId: string,
  language: UiLanguage = "zh",
): string {
  return pickUiText(
    language,
    `Now with ${humanizeOperatorLabel(currentOwnerAgentId)}`,
    `当前在 ${humanizeOperatorLabel(currentOwnerAgentId)}`,
  );
}

function buildInterSessionCollaborationTimelineSteps(input: {
  sourceAgentId: string;
  targetAgentId: string;
  sourceSession?: SessionConversationListItem;
  targetSession?: SessionConversationListItem;
  signals: Array<{
    sourceSessionKey: string;
    targetSessionKey: string;
    sourceTool?: string;
    snippet: string;
    at?: string;
  }>;
  language: UiLanguage;
}): CollaborationTimelineStep[] {
  const steps: CollaborationTimelineStep[] = [];
  const firstSignal = input.signals[0];
  if (firstSignal) {
    steps.push({
      id: `${firstSignal.sourceSessionKey}:${firstSignal.targetSessionKey}:send`,
      agentId: input.sourceAgentId,
      roleLabel: pickUiText(input.language, "Sending session", "发送会话"),
      title: pickUiText(input.language, "Sent a cross-session message", "发起跨会话消息"),
      detail: summarizeVisibleSessionSnippet(firstSignal.snippet, input.language, 120),
      at: firstSignal.at ?? input.sourceSession?.latestHistoryAt ?? input.sourceSession?.lastMessageAt,
      tone: "info",
    });
  }

  for (const [index, signal] of input.signals.slice(1, 3).entries()) {
    const sourceAgentId =
      normalizeAgentIdCandidate(extractAgentIdFromSessionKey(signal.sourceSessionKey)) ?? input.sourceAgentId;
    const isReply = normalizeLookupKey(sourceAgentId) === normalizeLookupKey(input.targetAgentId);
    steps.push({
      id: `${signal.sourceSessionKey}:${signal.targetSessionKey}:${index}`,
      agentId: sourceAgentId,
      roleLabel: pickUiText(
        input.language,
        isReply ? "Replying session" : "Sending session",
        isReply ? "回复会话" : "发送会话",
      ),
      title: pickUiText(
        input.language,
        isReply ? "Replied through its existing session" : "Sent another cross-session message",
        isReply ? "通过既有会话回信" : "继续发送跨会话消息",
      ),
      detail: summarizeVisibleSessionSnippet(signal.snippet, input.language, 120),
      at: signal.at,
      tone: index === input.signals.slice(1, 3).length - 1 ? "ok" : "info",
    });
  }

  const latestSignal = input.signals.at(-1);
  if (latestSignal && (!firstSignal || normalizeInlineText(latestSignal.snippet) !== normalizeInlineText(firstSignal.snippet))) {
    const latestAgentId =
      normalizeAgentIdCandidate(extractAgentIdFromSessionKey(latestSignal.sourceSessionKey)) ?? input.targetAgentId;
    steps.push({
      id: `${latestSignal.sourceSessionKey}:${latestSignal.targetSessionKey}:latest`,
      agentId: latestAgentId,
      roleLabel: pickUiText(input.language, "Latest visible reply", "最近可见回复"),
      title: pickUiText(input.language, "Latest visible message", "最近可见消息"),
      detail: summarizeVisibleSessionSnippet(latestSignal.snippet, input.language, 120),
      at: latestSignal.at ?? input.targetSession?.latestHistoryAt ?? input.targetSession?.lastMessageAt,
      tone: "ok",
    });
  }

  if (steps.length === 0) {
    steps.push({
      id: `${input.sourceAgentId}:${input.targetAgentId}:fallback`,
      agentId: input.targetAgentId,
      roleLabel: pickUiText(input.language, "Receiving session", "接收会话"),
      title: pickUiText(input.language, "Visible communication only", "仅有跨会话通信信号"),
      detail: pickUiText(
        input.language,
        "The cross-session route is visible, but there is not enough recent text to summarize it yet.",
        "当前能看到跨会话通信关系，但最近的文本还不够生成摘要。",
      ),
      at: pickLatestTimestamp([
        input.sourceSession?.latestHistoryAt,
        input.sourceSession?.lastMessageAt,
        input.targetSession?.latestHistoryAt,
        input.targetSession?.lastMessageAt,
      ]),
      tone: "warn",
    });
  }

  return steps
    .slice(0, 4)
    .sort((a, b) => toSortableMs(a.at) - toSortableMs(b.at));
}

function normalizeAgentIdCandidate(value: string | undefined): string | undefined {
  const normalized = normalizeLookupKey(value ?? "");
  if (!normalized || normalized === "unassigned" || normalized === "未分配") return undefined;
  return normalized;
}

function resolveCollaborationThreadStatus(card: TaskExecutionChainCard): CollaborationThreadStatus {
  if (card.state === "blocked" || card.state === "waiting_approval" || card.state === "error") return "blocked";
  if (card.state === "running" || card.executionChain.stage === "running") return "active";
  if (card.executionChain.stage === "accepted") return "handoff";
  return "completed";
}

function resolveCollaborationCurrentOwner(
  card: TaskExecutionChainCard,
  parentAgentId: string,
  childAgentId: string,
): string {
  const status = resolveCollaborationThreadStatus(card);
  if (status === "handoff") return childAgentId ?? parentAgentId;
  if (status === "completed") return childAgentId ?? parentAgentId;
  return childAgentId ?? parentAgentId;
}

function collaborationParticipantRoleLabel(
  position: "parent" | "child",
  language: UiLanguage = "zh",
): string {
  return position === "parent"
    ? pickUiText(language, "Parent session", "父会话")
    : pickUiText(language, "Child session", "子会话");
}

function collaborationRoleAgentLabel(
  position: "parent" | "child",
  agentId: string,
  language: UiLanguage = "zh",
): string {
  const agentLabel = humanizeOperatorLabel(agentId);
  return position === "parent"
    ? pickUiText(language, `Parent ${agentLabel}`, `父会话 ${agentLabel}`)
    : pickUiText(language, `Child ${agentLabel}`, `子会话 ${agentLabel}`);
}

function collaborationRouteLabel(
  parentAgentId: string,
  childAgentId: string,
  hasChild: boolean,
  language: UiLanguage = "zh",
): string {
  if (!hasChild) return collaborationRoleAgentLabel("parent", parentAgentId, language);
  return `${collaborationRoleAgentLabel("parent", parentAgentId, language)} → ${collaborationRoleAgentLabel("child", childAgentId, language)}`;
}

function extractCollaborationTaskLabel(input: string, language: UiLanguage): string | undefined {
  const normalized = normalizeInlineText(input);
  if (!normalized) return undefined;

  const explicitTaskMatch = /(?:任务|目标|task|objective)\s*[:：]\s*([^。；\n]+)/i.exec(normalized);
  if (explicitTaskMatch?.[1]?.trim()) return safeTruncate(explicitTaskMatch[1].trim(), 88);

  const cronTaskMatch = /^\[[^\]]+\s+([^\]\s][^\]]*?)\]\s/.exec(normalized);
  if (cronTaskMatch?.[1]?.trim()) return safeTruncate(cronTaskMatch[1].trim(), 88);

  const chineseBracketMatch = /^【([^】]+)】/.exec(normalized);
  if (chineseBracketMatch?.[1]?.trim()) return safeTruncate(chineseBracketMatch[1].trim(), 88);

  const firstClause = normalized
    .split(/\s+[—-]\s+/)
    .map((segment) => normalizeInlineText(segment))
    .find((segment) => segment.length >= 4);
  if (firstClause && !looksLikeStructuredExecutionTitle(firstClause)) return safeTruncate(firstClause, 88);

  if (!looksLikeStructuredExecutionTitle(normalized)) return safeTruncate(normalized, 88);

  const structuredSummary = summarizeStructuredSessionPayload(normalized, language);
  if (structuredSummary?.trim()) return safeTruncate(structuredSummary, 88);

  return undefined;
}

function deriveCollaborationTaskTitle(input: {
  card: TaskExecutionChainCard;
  parentSession?: SessionConversationListItem;
  childSession?: SessionConversationListItem;
  language: UiLanguage;
}): string {
  const mappedTitle = executionChainCardTitle(input.card, input.language);
  const mappedLooksGeneric =
    /隔离执行|关联任务|linked task|isolated execution|cron isolated run/i.test(mappedTitle) ||
    /^(成功|失败|Succeeded|Failed)\b/.test(mappedTitle) ||
    /(查询|成功|扫描|入选|发送|Queries|Successful|Scanned|Qualified|Sent)\s+\d+/i.test(mappedTitle);
  if (!mappedLooksGeneric) return mappedTitle;

  const candidates = [
    input.childSession?.label,
    input.parentSession?.label,
    input.childSession?.taskSnippet,
    input.parentSession?.taskSnippet,
    input.childSession?.latestSnippet,
    input.parentSession?.latestSnippet,
    input.card.latestSnippet,
    input.card.executionChain.detail,
    input.card.taskTitle,
  ];
  for (const candidate of candidates) {
    const derived = extractCollaborationTaskLabel(candidate ?? "", input.language);
    if (derived?.trim()) return derived;
  }

  return mappedTitle;
}

function collaborationThreadStatusLabel(
  status: CollaborationThreadStatus,
  language: UiLanguage = "zh",
): string {
  if (status === "active") return pickUiText(language, "In progress", "进行中");
  if (status === "handoff") return pickUiText(language, "Waiting handoff", "等待交接");
  if (status === "blocked") return pickUiText(language, "Blocked", "卡住");
  return pickUiText(language, "Completed", "已完成");
}

function collaborationStatusRank(status: CollaborationThreadStatus): number {
  if (status === "active") return 4;
  if (status === "blocked") return 3;
  if (status === "handoff") return 2;
  return 1;
}

function collaborationThreadSummary(input: {
  card: TaskExecutionChainCard;
  status: CollaborationThreadStatus;
  parentAgentId: string;
  childAgentId: string;
  language: UiLanguage;
}): string {
  const parentLabel = collaborationRoleAgentLabel("parent", input.parentAgentId, input.language);
  const childLabel = collaborationRoleAgentLabel("child", input.childAgentId, input.language);
  if (input.status === "blocked") {
    if (input.card.state === "waiting_approval") {
      return pickUiText(
        input.language,
        `${childLabel} is waiting for approval before the handoff can continue.`,
        `${childLabel} 正在等待审批，这条交接要等这一段通过后才能继续。`,
      );
    }
    if (input.card.state === "error") {
      return pickUiText(
        input.language,
        `${childLabel} hit an error after the latest handoff.`,
        `${childLabel} 在最近一次交接后出现了错误。`,
      );
    }
    return pickUiText(
      input.language,
      `${childLabel} is blocked and needs follow-up before the thread can move again.`,
      `${childLabel} 当前卡住了，需要先跟进处理，这条协作线程才能继续。`,
    );
  }
  if (input.status === "active") {
    if (normalizeLookupKey(input.parentAgentId) !== normalizeLookupKey(input.childAgentId)) {
      return pickUiText(
        input.language,
        `${childLabel} is working after ${parentLabel} handed the task over.`,
        `${childLabel} 正在继续执行，前一步由 ${parentLabel} 完成交接。`,
      );
    }
    return pickUiText(
      input.language,
      `${childLabel} is continuing the isolated run after ${parentLabel} opened it.`,
      `${childLabel} 正在继续执行，前一步由 ${parentLabel} 在同一智能体里发起。`,
    );
  }
  if (input.status === "handoff") {
    if (normalizeLookupKey(input.parentAgentId) !== normalizeLookupKey(input.childAgentId)) {
      return pickUiText(
        input.language,
        `${parentLabel} handed the task to ${childLabel}. The next visible reply has not arrived yet.`,
        `${parentLabel} 已把任务交给 ${childLabel}，下一条可见回复还没有回来。`,
      );
    }
    return pickUiText(
      input.language,
      `${parentLabel} opened a child run in the same agent. The next visible reply is still pending.`,
      `${parentLabel} 已在同一智能体里发起子会话，但下一条可见回复还没出现。`,
    );
  }
  if (normalizeLookupKey(input.parentAgentId) !== normalizeLookupKey(input.childAgentId)) {
    return pickUiText(
      input.language,
      `${childLabel} finished the latest visible handoff from ${parentLabel}.`,
      `${childLabel} 已完成最近一轮由 ${parentLabel} 交接过来的工作。`,
    );
  }
  return pickUiText(
    input.language,
    `${childLabel} finished the latest visible isolated run after ${parentLabel} handed it off.`,
    `${childLabel} 已完成最近一轮由 ${parentLabel} 发起的隔离执行。`,
  );
}

function buildCollaborationTimelineSteps(input: {
  card: TaskExecutionChainCard;
  parentAgentId: string;
  childAgentId: string;
  parentSession?: SessionConversationListItem;
  childSession?: SessionConversationListItem;
  language: UiLanguage;
}): CollaborationTimelineStep[] {
  const steps: CollaborationTimelineStep[] = [];
  const parentLabel = collaborationRoleAgentLabel("parent", input.parentAgentId, input.language);
  const childLabel = collaborationRoleAgentLabel("child", input.childAgentId, input.language);
  const chain = input.card.executionChain;

  if (chain.accepted) {
    steps.push({
      id: `${input.card.sessionKey}:accepted`,
      agentId: input.parentAgentId,
      roleLabel: collaborationParticipantRoleLabel("parent", input.language),
      title: pickUiText(input.language, "Parent accepted work", "父会话接到任务"),
      detail: pickUiText(
        input.language,
        `${parentLabel} accepted the work in the parent session.`,
        `${parentLabel} 在父会话里接下了这件事。`,
      ),
      at: chain.acceptedAt ?? input.parentSession?.latestHistoryAt ?? input.parentSession?.lastMessageAt,
      tone: "info",
    });
  }

  if (chain.spawned) {
    steps.push({
      id: `${input.card.sessionKey}:spawned`,
      agentId: input.parentAgentId,
      roleLabel: collaborationParticipantRoleLabel("parent", input.language),
      title: pickUiText(input.language, "Parent opened child session", "父会话发起子会话"),
      detail: normalizeLookupKey(input.parentAgentId) === normalizeLookupKey(input.childAgentId)
        ? pickUiText(
            input.language,
            `${parentLabel} opened a child run in the same agent.`,
            `${parentLabel} 在同一智能体里开了一条子会话来继续执行。`,
          )
        : pickUiText(
            input.language,
            `${parentLabel} handed the work to ${childLabel}.`,
            `${parentLabel} 把这件事交给了 ${childLabel}。`,
          ),
      at: chain.spawnedAt ?? input.childSession?.latestHistoryAt ?? input.childSession?.lastMessageAt,
      tone: "info",
    });
  }

  if ((input.parentSession?.taskSnippet ?? input.parentSession?.latestSnippet)?.trim()) {
    steps.push({
      id: `${input.card.sessionKey}:parent-note`,
      agentId: input.parentAgentId,
      roleLabel: collaborationParticipantRoleLabel("parent", input.language),
      title: pickUiText(input.language, "Parent session note", "父会话说明"),
      detail: summarizeVisibleSessionSnippet(
        input.parentSession?.taskSnippet ?? input.parentSession?.latestSnippet ?? "",
        input.language,
        120,
      ),
      at: input.parentSession.latestHistoryAt ?? input.parentSession.lastMessageAt,
      tone: "ok",
    });
  }

  if (input.childSession?.latestSnippet?.trim()) {
    steps.push({
      id: `${input.card.sessionKey}:child-note`,
      agentId: input.childAgentId,
      roleLabel: collaborationParticipantRoleLabel("child", input.language),
      title: pickUiText(input.language, "Child session reply", "子会话最近回复"),
      detail: summarizeVisibleSessionSnippet(input.childSession.latestSnippet, input.language, 120),
      at: input.childSession.latestHistoryAt ?? input.childSession.lastMessageAt,
      tone: input.card.state === "blocked" || input.card.state === "error" || input.card.state === "waiting_approval" ? "blocked" : "ok",
    });
  }

  if (steps.length === 0) {
    steps.push({
      id: `${input.card.sessionKey}:fallback`,
      agentId: input.childAgentId,
      roleLabel: collaborationParticipantRoleLabel(
        normalizeLookupKey(input.parentAgentId) === normalizeLookupKey(input.childAgentId) ? "parent" : "child",
        input.language,
      ),
      title: pickUiText(input.language, "Visible chain only", "仅有执行链信号"),
      detail: pickUiText(
        input.language,
        "The handoff relationship is visible, but there is not enough recent session text to summarize it yet.",
        "当前能看到交接关系，但最近的会话文本还不够生成摘要。",
      ),
      at: input.card.latestAt,
      tone: "warn",
    });
  }

  return steps
    .slice(0, 4)
    .sort((a, b) => toSortableMs(a.at) - toSortableMs(b.at));
}

function renderCollaborationThreadCards(
  cards: CollaborationThreadCard[],
  language: UiLanguage = "zh",
): string {
  if (cards.length === 0) {
    return `<div class="empty-state">${escapeHtml(
      pickUiText(
        language,
        "No collaboration threads are visible yet. They will appear once parent-child relays or cross-session messages show up.",
        "当前还没有可见的协作线程。父子接力或跨会话消息出现后，这里就会开始显示。",
      ),
    )}</div>`;
  }

  return `<div class="collaboration-thread-list">${cards
    .map((card) => {
      const participantAvatars = card.participants
        .map((participant, index) => {
          const avatar = `<div class="collaboration-participant">
            <div class="agent-avatar collaboration-avatar${participant.current ? " is-current" : ""}" style="--agent-accent:${escapeHtml(participant.identity.accent)};" data-agent-id="${escapeHtml(participant.agentId)}" data-animal="${escapeHtml(participant.identity.animal)}" aria-label="${escapeHtml(participant.label)}">
              <div class="agent-stage" aria-hidden="true">
                <canvas class="agent-pixel-canvas" width="224" height="224"></canvas>
              </div>
            </div>
            <div class="collaboration-participant-label">${escapeHtml(participant.roleLabel)}</div>
          </div>`;
          const arrow =
            index < card.participants.length - 1
              ? `<span class="collaboration-route-arrow" aria-hidden="true">${escapeHtml(card.routeJoiner)}</span>`
              : "";
          return `${avatar}${arrow}`;
        })
        .join("");
      const timelineHtml = card.timeline
        .map((step) => {
          const identity = deriveAgentAnimalIdentity(step.agentId);
          return `<li class="collaboration-timeline-step">
            <div class="collaboration-agent-pill" style="--agent-accent:${escapeHtml(identity.accent)};">
              <span class="collaboration-agent-pill-dot"></span>
              <strong>${escapeHtml(step.roleLabel ? `${step.roleLabel} · ${humanizeOperatorLabel(step.agentId)}` : humanizeOperatorLabel(step.agentId))}</strong>
            </div>
            <div class="collaboration-step-copy">
              <div class="collaboration-step-head">
                <strong>${escapeHtml(step.title)}</strong>
                <span>${escapeHtml(step.at ? formatTimeAgoFromNow(step.at, language) : pickUiText(language, "time unavailable", "时间未知"))}</span>
              </div>
              <div class="meta">${escapeHtml(step.detail)}</div>
            </div>
          </li>`;
        })
        .join("");
      const technicalDetails = [
        card.parentSessionKey
          ? {
              label:
                card.kind === "inter_session"
                  ? pickUiText(language, "Sending session", "发送会话")
                  : pickUiText(language, "Parent session", "父会话"),
              value: card.parentSessionKey,
            }
          : undefined,
        card.childSessionKey
          ? {
              label:
                card.kind === "inter_session"
                  ? pickUiText(language, "Receiving session", "接收会话")
                  : pickUiText(language, "Child session", "子会话"),
              value: card.childSessionKey,
            }
          : undefined,
      ]
        .filter((item): item is { label: string; value: string } => Boolean(item?.value))
        .filter((item, index, values) => values.findIndex((entry) => entry.value === item.value) === index)
        .map((item) => `<li>${escapeHtml(item.label)}：<code>${escapeHtml(item.value)}</code></li>`)
        .join("");
      const foldedRunsList =
        card.aggregateCount > 1
          ? `<ul class="story-list collaboration-folded-list">${card.aggregateItems
              .slice(0, 6)
              .map(
                (item) =>
                  `<li><a href="${escapeHtml(item.sessionHref)}"><code>${escapeHtml(item.sessionKey)}</code></a> · ${escapeHtml(
                    item.latestAt
                      ? formatTimeAgoFromNow(item.latestAt, language)
                      : pickUiText(language, "time unavailable", "时间未知"),
                  )}</li>`,
              )
              .join("")}${
                card.aggregateItems.length > 6
                  ? `<li>${escapeHtml(
                      pickUiText(
                        language,
                        `${card.aggregateItems.length - 6} more runs are folded here.`,
                        `其余 ${card.aggregateItems.length - 6} 条相近协作也已经折叠在这里。`,
                      ),
                    )}</li>`
                  : ""
              }</ul>`
          : "";
      return `<details class="card collaboration-thread-card" data-collab-card data-collab-state="${escapeHtml(
        card.status,
      )}" data-collab-multi-agent="${card.multiAgent ? "1" : "0"}" data-collab-main-dispatched="${card.mainDispatched ? "1" : "0"}">
        <summary class="collaboration-thread-summary">
          <div class="collaboration-thread-head">
            <div class="collaboration-route-avatars">${participantAvatars}</div>
            <div class="collaboration-thread-copy">
              <strong>${escapeHtml(card.taskTitle)}</strong>
              <div class="meta">${escapeHtml(card.routeTitle)} · ${escapeHtml(card.latestAtLabel)}</div>
            </div>
            <div class="collaboration-thread-badges">
              ${badge("idle", card.kindBadge)}
              ${badge(card.status === "completed" ? "ok" : card.status === "blocked" ? "warn" : "info", card.statusBadge)}
              ${
                card.aggregateCount > 1
                  ? badge("idle", pickUiText(language, `${card.aggregateCount} runs`, `${card.aggregateCount} 条`))
                  : ""
              }
              <span class="collaboration-current-owner">${escapeHtml(card.currentOwnerLabel)}</span>
            </div>
          </div>
          <div class="collaboration-thread-teaser">
            <div class="meta">${escapeHtml(card.summary)}</div>
            <div class="collaboration-latest-snippet">${escapeHtml(card.latestSnippet)}</div>
          </div>
        </summary>
        <div class="collaboration-thread-body">
          <ol class="collaboration-timeline">${timelineHtml}</ol>
          ${
            card.aggregateCount > 1
              ? `<div class="meta collaboration-folded-note">${escapeHtml(
                  card.kind === "inter_session"
                    ? pickUiText(
                        language,
                        `${card.aggregateCount} similar cross-session exchanges are folded into this card. The newest timeline stays visible here.`,
                        `这张卡里折叠了 ${card.aggregateCount} 条相近的跨会话通信，当前保留的是最新一条时间线。`,
                      )
                    : pickUiText(
                        language,
                        `${card.aggregateCount} similar parent-child relays are folded into this card. The newest timeline stays visible here.`,
                        `这张卡里折叠了 ${card.aggregateCount} 条相近的父子会话接力，当前保留的是最新一条时间线。`,
                      ),
                )}</div>`
              : ""
          }
          <div class="collaboration-thread-foot">
            <div class="meta">${escapeHtml(card.sourceLabel)}</div>
            <div class="collaboration-thread-actions">
              <a class="btn" href="${escapeHtml(card.sessionHref)}">${escapeHtml(
                pickUiText(language, "Open session", "查看会话"),
              )}</a>
              ${
                card.taskHref
                  ? `<a class="btn" href="${escapeHtml(card.taskHref)}">${escapeHtml(
                      pickUiText(language, "Open task", "查看任务"),
                    )}</a>`
                  : ""
              }
            </div>
          </div>
          <details class="compact-table-details collaboration-technical-details">
            <summary>${escapeHtml(pickUiText(language, "Technical details", "技术细节"))}</summary>
            <div class="fold-body">
              <ul class="story-list">${technicalDetails}</ul>
              ${foldedRunsList}
            </div>
          </details>
        </div>
      </details>`;
    })
    .join("")}</div>`;
}

function renderOfficeCards(cards: OfficeSpaceCard[], language: UiLanguage = "zh"): string {
  if (cards.length === 0) {
    return `<div class="empty-state">${escapeHtml(
      pickUiText(language, "No staff roster signal yet. It will appear after config or runtime data is connected.", "暂无助手名录信号。连接配置或运行态后会显示。"),
    )}</div>`;
  }

  return `<div class="office-grid">${cards
    .map((card) => {
      const focus =
        card.focusItems.length === 0
          ? "<div class=\"meta\">当前重点：暂无</div>"
          : `<div class="meta">当前重点：</div><ul class="office-focus">${card.focusItems
              .map((item) => `<li>${escapeHtml(item)}</li>`)
              .join("")}</ul>`;
      const avatar = `<div class="agent-avatar" style="--agent-accent:${escapeHtml(card.identity.accent)};" data-agent-id="${escapeHtml(card.agentId)}" data-animal="${escapeHtml(card.identity.animal)}">
        <div class="agent-stage" aria-hidden="true">
          <canvas class="agent-pixel-canvas" width="224" height="160"></canvas>
        </div>
        <div class="agent-animal-label">${escapeHtml(animalLabel(card.identity.animal, language))}</div>
      </div>`;
      return `<article class="office-card">
        <div class="office-head">
          ${avatar}
          <div class="office-info">
            <div class="topline"><strong>${escapeHtml(humanizeOperatorLabel(card.agentId))}</strong>${badge(card.status)}</div>
            <div class="meta"><strong>${escapeHtml(card.statusLabel)}</strong> · ${escapeHtml(card.summary)}</div>
            <div class="meta">${escapeHtml(pickUiText(language, "Active sessions", "活跃会话"))}：${card.activeSessions} · ${escapeHtml(
              pickUiText(language, "Active tasks", "活跃任务"),
            )}：${card.activeTasks}</div>
          </div>
        </div>
        ${focus.replace("当前重点：", `${pickUiText(language, "Current focus", "当前重点")}：`).replace("当前重点：暂无", `${pickUiText(language, "Current focus", "当前重点")}：${pickUiText(language, "None", "暂无")}`)}
      </article>`;
    })
    .join("")}</div>`;
}

function renderOfficeFloor(cards: OfficeSpaceCard[], language: UiLanguage = "zh"): string {
  const zones: OfficeSpaceCard["officeZone"][] = [
    "Builder Desks",
    "Approval Desk",
    "Support Bay",
    "Standby Pods",
  ];
  return `<div class="office-floor">${zones
    .map((zone) => {
      const items = cards.filter((card) => card.officeZone === zone);
      const rows =
        items.length === 0
          ? '<li class="desk-chip">当前没有分配。</li>'
          : items
              .map(
                (card) =>
                  `<li class="desk-chip"><strong>${escapeHtml(humanizeOperatorLabel(card.agentId))}</strong><div class="meta">${escapeHtml(card.summary)}</div></li>`,
              )
              .join("");
      return `<section class="zone"><h3>${escapeHtml(officeZoneLabel(zone, language))}</h3><div class="meta">${escapeHtml(
        pickUiText(language, "Occupied", "占用数"),
      )}：${items.length}</div><ul class="desk-list">${rows}</ul></section>`;
    })
    .join("")}</div>`;
}

function renderNativeMotionScript(language: UiLanguage = "zh"): string {
  return `<script>
(() => {
  const body = document.body;
  if (!body) return;
  const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const revealNodes = Array.from(document.querySelectorAll('.panel .card, .sidebar .card, .nav-link, .overview-kpi-card, .overview-primary-card'));
  revealNodes.forEach((node, index) => {
    node.style.setProperty('--stagger-index', String(Math.min(index, 20)));
  });
  requestAnimationFrame(() => body.classList.add('ui-ready'));

  const inspectorToggle = document.getElementById('inspector-toggle');
  const inspectorStorageKey = 'openclaw:inspector-collapsed:v1';
  const applyInspectorLabel = () => {
    if (!(inspectorToggle instanceof HTMLButtonElement)) return;
    const collapsed = body.classList.contains('inspector-collapsed');
    inspectorToggle.textContent = collapsed ? '${escapeHtml(pickUiText(language, "Expand inspector", "展开检视栏"))}' : '${escapeHtml(pickUiText(language, "Collapse inspector", "收起检视栏"))}';
    inspectorToggle.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
  };
  if (inspectorToggle instanceof HTMLButtonElement) {
    try {
      if (window.localStorage.getItem(inspectorStorageKey) === '1' && window.innerWidth > 1320) {
        body.classList.add('inspector-collapsed');
      }
    } catch {}
    applyInspectorLabel();
    inspectorToggle.addEventListener('click', () => {
      body.classList.toggle('inspector-collapsed');
      applyInspectorLabel();
      try {
        window.localStorage.setItem(inspectorStorageKey, body.classList.contains('inspector-collapsed') ? '1' : '0');
      } catch {}
    });
    window.addEventListener('resize', () => {
      if (window.innerWidth <= 1320 && body.classList.contains('inspector-collapsed')) {
        body.classList.remove('inspector-collapsed');
      }
      applyInspectorLabel();
    });
  }

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a[href]');
    if (!anchor) return;
    if (anchor.getAttribute('target') === '_blank') return;
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('#')) return;
    if (href.startsWith('/api/')) return;
    event.preventDefault();
    window.location.href = href;
  });

  const panel = document.querySelector('.panel');
  const compactDetails = Array.from(document.querySelectorAll('details.card.compact-details'));
  compactDetails.forEach((details) => {
    const foldBody = details.querySelector('.fold-body');
    details.addEventListener('toggle', () => {
      if (panel) {
        panel.classList.add('is-reflowing');
        window.setTimeout(() => panel.classList.remove('is-reflowing'), 240);
      }
      if (prefersReducedMotion || !foldBody || !details.open) return;
      foldBody.style.overflow = 'hidden';
      foldBody.style.opacity = '0';
      foldBody.style.height = '0px';
      const targetHeight = foldBody.scrollHeight;
      foldBody.getBoundingClientRect();
      foldBody.style.transition = 'height 220ms ease, opacity 220ms ease';
      foldBody.style.height = targetHeight + 'px';
      foldBody.style.opacity = '1';
      window.setTimeout(() => {
        foldBody.style.removeProperty('overflow');
        foldBody.style.removeProperty('opacity');
        foldBody.style.removeProperty('height');
        foldBody.style.removeProperty('transition');
      }, 240);
    });
  });

  const docsSearchInput = document.getElementById('docs-search-input');
  const docsSourceFilter = document.getElementById('docs-source-filter');
  if (docsSearchInput instanceof HTMLInputElement) {
    const docCards = Array.from(document.querySelectorAll('.doc-card[data-doc-search]'));
    const applyDocFilter = () => {
      const needle = docsSearchInput.value.trim().toLowerCase();
      const sourceNeedle = docsSourceFilter instanceof HTMLSelectElement ? docsSourceFilter.value.trim().toLowerCase() : 'all';
      docCards.forEach((card) => {
        const haystack = (card.getAttribute('data-doc-search') || '').toLowerCase();
        const source = (card.getAttribute('data-doc-source') || 'file').toLowerCase();
        const textMatch = !needle || haystack.includes(needle);
        const sourceMatch = sourceNeedle === 'all' || sourceNeedle === source;
        card.classList.toggle('is-hidden', !(textMatch && sourceMatch));
      });
    };
    docsSearchInput.addEventListener('input', applyDocFilter);
    if (docsSourceFilter instanceof HTMLSelectElement) {
      docsSourceFilter.addEventListener('change', applyDocFilter);
    }
    applyDocFilter();
  }

  const counterStorageKey = 'openclaw:overview-counters:v2';
  const counterNodes = Array.from(document.querySelectorAll('[data-counter-key][data-counter-target]'));
  let previousCounters = {};
  try {
    previousCounters = JSON.parse(window.localStorage.getItem(counterStorageKey) || '{}');
  } catch {
    previousCounters = {};
  }
  const nextCounters = {};
  const formatCounter = (value, format) => {
    if (format === 'int') return Math.round(value).toLocaleString('en-US');
    return String(Math.round(value));
  };
  const animateCounter = (node, start, target, format) => {
    if (prefersReducedMotion) {
      node.textContent = formatCounter(target, format);
      return;
    }
    const duration = 560;
    const startAt = performance.now();
    const step = (now) => {
      const progress = Math.min(1, (now - startAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const value = start + (target - start) * eased;
      node.textContent = formatCounter(value, format);
      if (progress < 1) window.requestAnimationFrame(step);
    };
    window.requestAnimationFrame(step);
  };
  counterNodes.forEach((node) => {
    const key = node.getAttribute('data-counter-key');
    const target = Number(node.getAttribute('data-counter-target'));
    if (!key || !Number.isFinite(target)) return;
    const format = (node.getAttribute('data-counter-format') || 'int').toLowerCase();
    const previousRaw = Number(previousCounters[key]);
    const start = Number.isFinite(previousRaw) ? previousRaw : Math.max(0, Math.round(target * 0.82));
    animateCounter(node, start, target, format);
    if (Number.isFinite(previousRaw) && previousRaw !== target) {
      const card = node.closest('.overview-kpi-card, .overview-primary-card');
      if (card) {
        card.classList.add('state-updated-soft');
        window.setTimeout(() => card.classList.remove('state-updated-soft'), 900);
      }
    }
    nextCounters[key] = target;
  });
  try {
    window.localStorage.setItem(counterStorageKey, JSON.stringify(nextCounters));
  } catch {}

  const signalCards = Array.from(document.querySelectorAll('.signal-gauge-card[data-signal-key][data-signal-value]'));
  if (signalCards.length) {
    const storageKey = 'openclaw:signal-dashboard:v1';
    let previous = {};
    try {
      previous = JSON.parse(window.localStorage.getItem(storageKey) || '{}');
    } catch {
      previous = {};
    }
    const current = {};
    signalCards.forEach((card) => {
      const key = card.getAttribute('data-signal-key');
      const value = Number(card.getAttribute('data-signal-value') || '0');
      if (!key) return;
      current[key] = value;
      const oldValue = Number(previous[key]);
      if (Number.isFinite(oldValue) && oldValue !== value) {
        card.classList.add('state-updated');
      }
    });
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(current));
    } catch {}
  }
})();
</script>`;
}

function renderCollaborationFilterScript(language: UiLanguage = "zh"): string {
  return `<script>
(() => {
  const roots = Array.from(document.querySelectorAll('[data-collab-root]'));
  if (roots.length === 0) return;

  const copy = {
    all: '${escapeHtml(pickUiText(language, "Showing all visible threads", "当前显示全部可见线程"))}',
    active: '${escapeHtml(pickUiText(language, "Showing in-progress collaboration", "当前显示进行中的协作"))}',
    blocked: '${escapeHtml(pickUiText(language, "Showing blocked collaboration", "当前显示卡住的协作"))}',
    completed: '${escapeHtml(pickUiText(language, "Showing completed collaboration", "当前显示已完成的协作"))}',
    multiAgent: '${escapeHtml(pickUiText(language, "Showing multi-agent collaboration only", "当前只看多智能体协作"))}',
    mainDispatched: '${escapeHtml(pickUiText(language, "Showing collaboration dispatched by Main", "当前只看 Main 派发的协作"))}',
  };

  roots.forEach((root) => {
    const buttons = Array.from(root.querySelectorAll('[data-collab-filter]'));
    const cards = Array.from(root.querySelectorAll('[data-collab-card]'));
    const stateNode = root.querySelector('[data-collab-filter-state]');
    const apply = (mode) => {
      buttons.forEach((button) => button.classList.toggle('active', (button.dataset.collabFilter || 'all') === mode));
      cards.forEach((card) => {
        const state = card.dataset.collabState || 'completed';
        const multiAgent = card.dataset.collabMultiAgent === '1';
        const mainDispatched = card.dataset.collabMainDispatched === '1';
        const matches =
          mode === 'all' ||
          (mode === 'active' && (state === 'active' || state === 'handoff')) ||
          (mode === 'blocked' && state === 'blocked') ||
          (mode === 'completed' && state === 'completed') ||
          (mode === 'multi-agent' && multiAgent) ||
          (mode === 'main-dispatched' && mainDispatched);
        card.hidden = !matches;
      });
      if (stateNode) {
        stateNode.textContent =
          mode === 'all'
            ? copy.all
            : mode === 'active'
              ? copy.active
              : mode === 'blocked'
                ? copy.blocked
                : mode === 'completed'
                  ? copy.completed
                  : mode === 'multi-agent'
                    ? copy.multiAgent
                    : copy.mainDispatched;
      }
    };

    buttons.forEach((button) => {
      button.addEventListener('click', () => apply(button.dataset.collabFilter || 'all'));
    });

    apply('all');
  });
})();
</script>`;
}

function renderQuotaResetScript(): string {
  return `<script>
(() => {
  const nodes = Array.from(document.querySelectorAll('[data-quota-reset-at]'));
  if (nodes.length === 0) return;

  const timeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  const monthDayFormatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  });
  const monthDayYearFormatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  const formatReset = (raw, windowLabel) => {
    if (!raw) return '未提供';
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) return raw;
    const date = new Date(ms);
    const normalized = String(windowLabel || '').trim().toLowerCase();
    if (normalized === '5h' || normalized.includes('5h')) {
      return timeFormatter.format(date);
    }
    const now = new Date();
    if (date.getFullYear() === now.getFullYear()) {
      return monthDayFormatter.format(date);
    }
    return monthDayYearFormatter.format(date);
  };

  nodes.forEach((node) => {
    const raw = node.getAttribute('data-quota-reset-at') || '';
    const windowLabel = node.getAttribute('data-quota-window') || '';
    node.textContent = formatReset(raw, windowLabel);
  });
})();
</script>`;
}

function renderFileWorkbenchScript(): string {
  return `<script>
(() => {
  const roots = Array.from(document.querySelectorAll('[data-file-editor-root]'));
  if (roots.length === 0) return;

  roots.forEach((root) => {
    const scope = (root.dataset.scope || '').trim();
    const language = (root.dataset.language || 'zh').trim().toLowerCase() === 'en' ? 'en' : 'zh';
    const normalizeFacetKey = (value) => String(value || 'all').trim().toLowerCase() || 'all';
    const defaultFacet = normalizeFacetKey(root.dataset.defaultFacet || 'all');
    if (!scope) return;

    const navItems = Array.from(root.querySelectorAll('[data-file-item]'));
    const filterInput = root.querySelector('[data-file-filter]');
    const facetButtons = Array.from(root.querySelectorAll('[data-file-facet]'));
    const filterStateNode = root.querySelector('[data-file-filter-state]');
    const titleNode = root.querySelector('[data-file-title]');
    const pathNode = root.querySelector('[data-file-path]');
    const metaNode = root.querySelector('[data-file-meta]');
    const statusNode = root.querySelector('[data-file-status]');
    const textNode = root.querySelector('[data-file-text]');
    const reloadButton = root.querySelector('[data-file-reload]');
    const saveButton = root.querySelector('[data-file-save]');
    const tokenInput = root.querySelector('[data-file-token]');
    const tokenHeader = (root.dataset.localTokenHeader || 'x-local-token').trim();

    if (!textNode || !(textNode instanceof HTMLTextAreaElement)) return;

    let activePath = '';
    let lastLoadedValue = textNode.value;
    let saving = false;
    let activeFacet = defaultFacet;
    const l = {
      all: language === 'en' ? 'All' : '全部',
      currentGroup: language === 'en' ? 'Current group' : '当前分组',
      files: language === 'en' ? 'files' : '文件',
      fileUnit: language === 'en' ? 'files' : '份',
      noMatches: language === 'en' ? 'No matching files' : '没有匹配文件',
      unsavedBeforeSwitch: language === 'en' ? 'This file has unsaved changes. Save or restore it before switching.' : '当前文件有未保存改动，请先保存或恢复后再切换。',
      switchedTo: language === 'en' ? 'Switched to' : '已切换到',
      availableFiles: language === 'en' ? 'available files' : '可选文件',
      noFilesForFilter: language === 'en' ? 'No files match the current filter.' : '当前筛选下没有文件。',
      showing: language === 'en' ? 'Showing' : '当前显示',
      chooseLeft: language === 'en' ? 'Pick a file from the left.' : '可在左侧选择具体文件。',
      untitled: language === 'en' ? 'Untitled file' : '未命名文件',
      updatedAt: language === 'en' ? 'Updated' : '更新于',
      reading: language === 'en' ? 'Reading source file...' : '正在读取源文件...',
      readFailed: language === 'en' ? 'Read failed' : '读取失败',
      unsavedSwitchConfirm: language === 'en' ? 'This file has unsaved changes. Continue switching?' : '当前文件有未保存改动，仍要切换吗？',
      loaded: language === 'en' ? 'File loaded.' : '已载入文件。',
      unsavedFacetConfirm: language === 'en' ? 'This file has unsaved changes. Continue switching groups?' : '当前文件有未保存改动，仍要切换分组吗？',
      sameAsSource: language === 'en' ? 'Content matches the source file.' : '内容与源文件一致。',
      unsaved: language === 'en' ? 'You have unsaved changes.' : '有未保存改动。',
      reloadConfirm: language === 'en' ? 'This will discard current unsaved changes. Continue reloading?' : '将放弃当前未保存改动，继续重新读取吗？',
      reloaded: language === 'en' ? 'Source file reloaded.' : '已重新读取源文件。',
      saving: language === 'en' ? 'Saving to the source file...' : '正在保存到源文件...',
      saveFailed: language === 'en' ? 'Save failed' : '保存失败',
      saved: language === 'en' ? 'Saved to the source file.' : '已保存到源文件。',
    };

    const facetLabel = (key) => {
      const normalized = normalizeFacetKey(key);
      if (!normalized || normalized === 'all') return l.all;
      const target = facetButtons.find((button) => normalizeFacetKey(button.dataset.fileFacet || '') === normalized);
      return target ? (target.textContent || key).trim() : key;
    };

    const setStatus = (message) => {
      if (statusNode) statusNode.textContent = message;
    };

    const setFilterState = (message) => {
      if (filterStateNode) filterStateNode.textContent = message;
    };

    const setActiveItem = (path) => {
      navItems.forEach((item) => {
        const matches = (item.dataset.sourcePath || '') === path;
        item.classList.toggle('active', matches);
      });
    };

    const setActiveFacetButton = () => {
      facetButtons.forEach((button) => {
        const matches = normalizeFacetKey(button.dataset.fileFacet || '') === activeFacet;
        button.classList.toggle('active', matches);
      });
    };

    const applyNavFilter = () => {
      const query = filterInput instanceof HTMLInputElement ? filterInput.value.trim().toLowerCase() : '';
      let firstVisiblePath = '';
      let visibleCount = 0;
      navItems.forEach((item) => {
        const haystack = (item.dataset.fileSearch || '').toLowerCase();
        const itemFacet = normalizeFacetKey(item.dataset.fileFacetKey || 'all');
        const facetMatch = activeFacet === 'all' || itemFacet === activeFacet;
        const queryMatch = query.length === 0 || haystack.includes(query);
        const visible = facetMatch && queryMatch;
        item.hidden = !visible;
        item.style.display = visible ? "" : "none";
        if (visible && !firstVisiblePath) {
          firstVisiblePath = (item.dataset.sourcePath || '').trim();
        }
        if (visible) visibleCount += 1;
      });
      setFilterState(language === 'en'
        ? l.currentGroup + ': ' + facetLabel(activeFacet) + ' · ' + String(visibleCount) + ' ' + l.fileUnit
        : l.currentGroup + '：' + facetLabel(activeFacet) + ' · ' + l.files + ' ' + String(visibleCount) + ' ' + l.fileUnit);
      const activeItemVisible = navItems.some((item) => !item.hidden && (item.dataset.sourcePath || '').trim() === activePath);
      if (!activeItemVisible && firstVisiblePath) {
        if (textNode.value !== lastLoadedValue && activePath) {
          setStatus(l.unsavedBeforeSwitch);
          return;
        }
        void loadFile(firstVisiblePath, language === 'en'
          ? l.switchedTo + ' ' + facetLabel(activeFacet) + ' · ' + String(visibleCount) + ' ' + l.availableFiles + '.'
          : l.switchedTo + ' ' + facetLabel(activeFacet) + '，' + l.availableFiles + ' ' + String(visibleCount) + ' 份。');
        return;
      }
      if (!firstVisiblePath) {
        setStatus(l.noFilesForFilter);
        setFilterState(language === 'en'
          ? l.currentGroup + ': ' + facetLabel(activeFacet) + ' · ' + l.noMatches
          : l.currentGroup + '：' + facetLabel(activeFacet) + ' · ' + l.noMatches);
        return;
      }
      setStatus(language === 'en'
        ? l.showing + ' ' + facetLabel(activeFacet) + ' files. ' + l.chooseLeft
        : l.showing + ' ' + facetLabel(activeFacet) + ' 的文件。' + l.chooseLeft);
    };

    const applyPayload = (payload, message) => {
      if (!payload || !payload.entry) return;
      activePath = payload.entry.sourcePath || '';
      lastLoadedValue = typeof payload.content === 'string' ? payload.content : '';
      textNode.value = lastLoadedValue;
      if (titleNode) titleNode.textContent = payload.entry.title || l.untitled;
      if (pathNode) pathNode.textContent = payload.entry.sourcePath || '';
      if (metaNode) metaNode.textContent = l.updatedAt + ' ' + (payload.entry.updatedAt || '-') + ' · ' + String(payload.entry.size || 0) + ' bytes';
      setActiveItem(activePath);
      setStatus(message);
    };

    const loadFile = async (path, message) => {
      if (!path) return;
      setStatus(l.reading);
      try {
        const response = await fetch('/api/files/content?scope=' + encodeURIComponent(scope) + '&path=' + encodeURIComponent(path));
        const payload = await response.json();
        if (!response.ok || !payload.ok) {
          throw new Error(payload?.error?.message || l.readFailed);
        }
        applyPayload(payload, message);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : l.readFailed);
      }
    };

    navItems.forEach((item) => {
      item.addEventListener('click', () => {
        const nextPath = (item.dataset.sourcePath || '').trim();
        if (!nextPath || nextPath === activePath) return;
        if (textNode.value !== lastLoadedValue && !window.confirm(l.unsavedSwitchConfirm)) {
          return;
        }
        void loadFile(nextPath, l.loaded);
      });
    });

    if (filterInput instanceof HTMLInputElement) {
      filterInput.addEventListener('input', () => {
        applyNavFilter();
      });
    }

    facetButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const nextFacet = normalizeFacetKey(button.dataset.fileFacet || 'all');
        if (nextFacet === activeFacet) return;
        if (textNode.value !== lastLoadedValue && activePath && !window.confirm(l.unsavedFacetConfirm)) {
          return;
        }
        activeFacet = nextFacet;
        setActiveFacetButton();
        applyNavFilter();
      });
    });

    textNode.addEventListener('input', () => {
      setStatus(textNode.value === lastLoadedValue ? l.sameAsSource : l.unsaved);
    });

    if (reloadButton) {
      reloadButton.addEventListener('click', () => {
        if (!activePath) return;
        if (textNode.value !== lastLoadedValue && !window.confirm(l.reloadConfirm)) {
          return;
        }
        void loadFile(activePath, l.reloaded);
      });
    }

    if (saveButton) {
      saveButton.addEventListener('click', async () => {
        if (!activePath || saving) return;
        saving = true;
        saveButton.setAttribute('disabled', 'disabled');
        setStatus(l.saving);
        try {
          const headers = { 'content-type': 'application/json' };
          if (tokenInput instanceof HTMLInputElement && tokenInput.value.trim()) {
            headers[tokenHeader] = tokenInput.value.trim();
          }
          const response = await fetch('/api/files/content', {
            method: 'PUT',
            headers,
            body: JSON.stringify({
              scope,
              path: activePath,
              content: textNode.value,
            }),
          });
          const payload = await response.json();
          if (!response.ok || !payload.ok) {
            throw new Error(payload?.error?.message || l.saveFailed);
          }
          applyPayload(payload, l.saved);
        } catch (error) {
          setStatus(error instanceof Error ? error.message : l.saveFailed);
        } finally {
          saving = false;
          saveButton.removeAttribute('disabled');
        }
      });
    }

    const firstActive = navItems.find((item) => item.classList.contains('active'));
    activePath = (firstActive?.dataset.sourcePath || '').trim();
    setActiveFacetButton();
    setActiveItem(activePath);
    applyNavFilter();
  });
})();
</script>`;
}

function renderAgentVisualEnhancerScript(): string {
  return `<script>
(() => {
  const avatars = Array.from(document.querySelectorAll('.agent-avatar, .staff-avatar'));
  if (!avatars.length) return;
  const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Pixel motion runs fully on client; no network polling and no extra token usage.

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const hexToRgb = (hex) => {
    const safe = (hex || '#4e79a7').replace('#', '').trim();
    if (safe.length !== 6) return { r: 78, g: 121, b: 167 };
    const n = Number.parseInt(safe, 16);
    if (!Number.isFinite(n)) return { r: 78, g: 121, b: 167 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  };
  const rgbToHex = (rgb) => '#' + [rgb.r, rgb.g, rgb.b].map((v) => clamp(v, 0, 255).toString(16).padStart(2, '0')).join('');
  const mix = (a, b, ratio) => {
    const p = clamp(ratio, 0, 1);
    return {
      r: Math.round(a.r + (b.r - a.r) * p),
      g: Math.round(a.g + (b.g - a.g) * p),
      b: Math.round(a.b + (b.b - a.b) * p),
    };
  };
  const lighten = (hex, ratio) => rgbToHex(mix(hexToRgb(hex), { r: 255, g: 255, b: 255 }, ratio));
  const darken = (hex, ratio) => rgbToHex(mix(hexToRgb(hex), { r: 0, g: 0, b: 0 }, ratio));
  const paintHex = (hex, shade) => {
    const rgb = hexToRgb(hex);
    return 'rgb('
      + Math.round(rgb.r * shade) + ','
      + Math.round(rgb.g * shade) + ','
      + Math.round(rgb.b * shade) + ')';
  };
  const spriteSize = 44;
  const createSprite = () => Array.from({ length: spriteSize }, () => Array(spriteSize).fill(''));
  const inBounds = (x, y) => y >= 0 && y < spriteSize && x >= 0 && x < spriteSize;
  const put = (sprite, x, y, color) => {
    if (inBounds(x, y)) sprite[y][x] = color;
  };
  const fillRect = (sprite, x, y, w, h, color) => {
    for (let yy = y; yy < y + h; yy += 1) {
      for (let xx = x; xx < x + w; xx += 1) put(sprite, xx, yy, color);
    }
  };
  const fillEllipse = (sprite, cx, cy, rx, ry, color) => {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y += 1) {
      const ny = (y - cy) / ry;
      if (Math.abs(ny) > 1) continue;
      const span = Math.sqrt(1 - ny * ny) * rx;
      for (let x = Math.floor(cx - span); x <= Math.ceil(cx + span); x += 1) put(sprite, x, y, color);
    }
  };
  const strokeEdge = (sprite, color) => {
    const copy = sprite.map((row) => row.slice());
    const has = (x, y) => inBounds(x, y) && copy[y][x];
    for (let y = 0; y < spriteSize; y += 1) {
      for (let x = 0; x < spriteSize; x += 1) {
        if (!copy[y][x]) continue;
        if (!has(x - 1, y) || !has(x + 1, y) || !has(x, y - 1) || !has(x, y + 1)) {
          sprite[y][x] = color;
        }
      }
    }
  };
  const dots = (sprite, rows, color) => {
    rows.forEach((row) => {
      row.forEach((point) => put(sprite, point[0], point[1], color));
    });
  };

  const PAL = {
    robot: { outline: '#20394f', shell: '#a7c3d8', shellDark: '#6e8ca4', panel: '#dcecf7', visor: '#58b7ff', visorDark: '#2c7ec0', eye: '#163249', mouth: '#456175', antenna: '#ffd36e' },
    lion: { outline: '#213f57', mane: '#7a4a29', maneHi: '#ad713f', fur: '#d8a56b', face: '#f3d4aa', muzzle: '#f7e3c4', eye: '#1e2d3e', nose: '#7d4f34' },
    tiger: { outline: '#223f59', fur: '#f39b43', furDark: '#d27127', face: '#f9dcba', muzzle: '#fbe8cf', stripe: '#22384d', eye: '#1d2c3c', nose: '#7c4323' },
    panda: { outline: '#223a51', fur: '#f9fcff', furDark: '#24313e', face: '#ffffff', muzzle: '#eef4f8', eyePatch: '#1f2c38', eye: '#101a24', nose: '#5e6b78' },
    monkey: { outline: '#203f57', fur: '#c89235', furDark: '#966521', face: '#f2cf9c', muzzle: '#f8e2bf', eye: '#1d2c3c', nose: '#7a522a' },
    dolphin: { outline: '#20445f', skin: '#59b9e4', skinDark: '#3e93bc', skinHi: '#79ceef', belly: '#def5ff', eye: '#173041' },
    owl: { outline: '#213d55', fur: '#8c6e4f', furDark: '#654c35', face: '#e1caa8', beak: '#e2ab39', eye: '#192734' },
    fox: { outline: '#203d53', fur: '#f28b3a', furDark: '#c66223', face: '#f7d9b8', muzzle: '#fbe8d2', ear: '#f8ad72', eye: '#1b2b38', nose: '#68361f' },
    bear: { outline: '#213b50', fur: '#845d42', furDark: '#61402c', face: '#deb895', muzzle: '#efd4bb', eye: '#172835', nose: '#5f3e2b' },
    eagle: { outline: '#223a53', head: '#f8f9fb', headDark: '#c7ccd2', body: '#7c5d41', wing: '#5f4633', beak: '#e3b744', eye: '#1a2a3a' },
    otter: { outline: '#213d54', fur: '#876047', furDark: '#65452f', face: '#eac6a1', muzzle: '#f3ddc6', eye: '#172736', nose: '#6c4831' },
    rooster: { outline: '#213c54', body: '#fbfcff', wing: '#edf2f8', comb: '#d94c44', wattle: '#c63e38', beak: '#f3bd4e', eye: '#13283a', tail: '#355776', tailHi: '#4d7396' },
    default: { outline: '#223f59', fur: '#8aa7c2', furDark: '#627f9a', face: '#d7e8f7', muzzle: '#e4f0fb', eye: '#172d3f', nose: '#48637a' },
  };

  const drawWhiskers = (sprite, y, color) => {
    fillRect(sprite, 14, y, 6, 1, color);
    fillRect(sprite, 33, y, 6, 1, color);
    fillRect(sprite, 15, y + 2, 5, 1, color);
    fillRect(sprite, 33, y + 2, 5, 1, color);
  };

  const drawCommonMammal = (sprite, p) => {
    const earTone = p.ear || p.furDark || p.fur;
    const muzzleTone = p.muzzle || p.face;
    fillEllipse(sprite, 21, 15, 5, 5, earTone);
    fillEllipse(sprite, 31, 15, 5, 5, earTone);
    fillEllipse(sprite, 26, 21, 14, 12, p.fur);
    fillEllipse(sprite, 26, 18, 9, 5, p.face);
    fillEllipse(sprite, 26, 25, 10, 7, p.face);
    fillEllipse(sprite, 26, 27, 8, 5, muzzleTone);
    fillEllipse(sprite, 26, 36, 9, 7, p.furDark || p.fur);
    fillRect(sprite, 23, 31, 6, 3, p.face);
    fillRect(sprite, 20, 19, 4, 4, '#ffffff');
    fillRect(sprite, 28, 19, 4, 4, '#ffffff');
    fillRect(sprite, 21, 20, 2, 3, p.eye);
    fillRect(sprite, 30, 20, 2, 3, p.eye);
    fillRect(sprite, 22, 20, 1, 1, '#dff0ff');
    fillRect(sprite, 31, 20, 1, 1, '#dff0ff');
    fillRect(sprite, 25, 25, 3, 2, p.nose);
    fillRect(sprite, 24, 27, 5, 1, p.nose);
    fillRect(sprite, 25, 28, 1, 1, p.nose);
    fillRect(sprite, 27, 28, 1, 1, p.nose);
    fillRect(sprite, 25, 30, 1, 1, p.nose);
    fillRect(sprite, 27, 30, 1, 1, p.nose);
    if (p.cheek) {
      fillRect(sprite, 18, 25, 2, 2, p.cheek);
      fillRect(sprite, 33, 25, 2, 2, p.cheek);
    }
  };

  const drawLion = () => {
    const p = PAL.lion;
    const sprite = createSprite();
    const badgeGold = '#f0c562';
    const sashBlue = '#4c7396';
    fillEllipse(sprite, 26, 18, 15, 14, p.mane);
    fillEllipse(sprite, 26, 18, 11, 10, p.maneHi);
    fillEllipse(sprite, 17, 12, 4, 4, p.mane);
    fillEllipse(sprite, 35, 12, 4, 4, p.mane);
    fillEllipse(sprite, 17, 12, 2, 2, p.face);
    fillEllipse(sprite, 35, 12, 2, 2, p.face);
    fillEllipse(sprite, 26, 20, 10, 8, p.fur);
    fillEllipse(sprite, 26, 26, 8, 6, p.muzzle);
    fillEllipse(sprite, 26, 37, 8, 7, p.maneHi);
    fillEllipse(sprite, 20, 33, 5, 5, p.fur);
    fillEllipse(sprite, 32, 31, 5, 5, p.fur);
    fillRect(sprite, 18, 31, 6, 3, p.fur);
    fillRect(sprite, 30, 29, 5, 3, p.fur);
    fillRect(sprite, 21, 18, 3, 3, '#ffffff');
    fillRect(sprite, 29, 18, 3, 3, '#ffffff');
    fillRect(sprite, 22, 19, 1, 2, p.eye);
    fillRect(sprite, 30, 19, 1, 2, p.eye);
    fillRect(sprite, 16, 22, 2, 2, '#f3bc91');
    fillRect(sprite, 34, 22, 2, 2, '#f3bc91');
    fillRect(sprite, 24, 23, 4, 2, p.nose);
    fillRect(sprite, 25, 25, 2, 1, p.nose);
    fillRect(sprite, 24, 26, 1, 1, p.nose);
    fillRect(sprite, 27, 26, 1, 1, p.nose);
    fillRect(sprite, 21, 7, 10, 2, p.maneHi);
    fillRect(sprite, 18, 9, 4, 2, p.maneHi);
    fillRect(sprite, 30, 9, 4, 2, p.maneHi);
    fillRect(sprite, 22, 31, 11, 2, sashBlue);
    fillRect(sprite, 28, 28, 2, 9, sashBlue);
    fillRect(sprite, 24, 35, 4, 4, badgeGold);
    fillRect(sprite, 25, 36, 2, 2, '#fff2c4');
    fillRect(sprite, 32, 24, 3, 6, p.fur);
    fillRect(sprite, 34, 22, 2, 3, p.fur);
    drawWhiskers(sprite, 27, '#f3dfc4');
    strokeEdge(sprite, p.outline);
    return sprite;
  };

  const drawRobot = () => {
    const p = PAL.robot;
    const sprite = createSprite();
    fillRect(sprite, 24, 5, 4, 3, p.antenna);
    fillRect(sprite, 25, 8, 2, 3, p.shellDark);
    fillEllipse(sprite, 26, 18, 13, 11, p.shell);
    fillRect(sprite, 15, 12, 22, 14, p.shell);
    fillRect(sprite, 18, 15, 16, 10, p.panel);
    fillRect(sprite, 20, 17, 12, 5, p.visor);
    fillRect(sprite, 22, 18, 2, 2, '#e3f7ff');
    fillRect(sprite, 28, 18, 2, 2, '#e3f7ff');
    fillRect(sprite, 22, 19, 2, 2, p.eye);
    fillRect(sprite, 28, 19, 2, 2, p.eye);
    fillRect(sprite, 24, 24, 4, 1, p.mouth);
    fillRect(sprite, 18, 28, 16, 10, p.shellDark);
    fillRect(sprite, 21, 30, 10, 5, p.panel);
    fillRect(sprite, 23, 31, 2, 2, p.visorDark);
    fillRect(sprite, 27, 31, 2, 2, p.visorDark);
    fillRect(sprite, 25, 34, 2, 2, p.antenna);
    fillRect(sprite, 13, 29, 4, 8, p.shellDark);
    fillRect(sprite, 8, 28, 6, 10, p.visorDark);
    fillRect(sprite, 9, 29, 4, 7, p.panel);
    fillRect(sprite, 35, 20, 3, 9, p.shellDark);
    fillRect(sprite, 37, 15, 3, 6, p.shellDark);
    fillRect(sprite, 38, 12, 3, 3, p.panel);
    fillRect(sprite, 20, 38, 3, 5, p.shellDark);
    fillRect(sprite, 29, 38, 3, 5, p.shellDark);
    fillRect(sprite, 20, 43, 4, 1, p.panel);
    fillRect(sprite, 28, 43, 4, 1, p.panel);
    fillRect(sprite, 20, 12, 12, 1, '#eef8ff');
    strokeEdge(sprite, p.outline);
    return sprite;
  };

  const drawTiger = () => {
    const p = PAL.tiger;
    const sprite = createSprite();
    const shieldOuter = '#6f92b3';
    const shieldInner = '#dfeaf5';
    const shieldMark = '#3f6f97';
    fillEllipse(sprite, 21, 18, 13, 12, p.fur);
    fillEllipse(sprite, 13, 11, 3, 4, p.stripe);
    fillEllipse(sprite, 29, 11, 3, 4, p.stripe);
    fillRect(sprite, 13, 10, 2, 3, '#ffd8ba');
    fillRect(sprite, 29, 10, 2, 3, '#ffd8ba');
    fillEllipse(sprite, 21, 21, 10, 8, p.face);
    fillEllipse(sprite, 21, 26, 8, 6, p.muzzle);
    fillEllipse(sprite, 20, 37, 8, 7, p.furDark);
    fillRect(sprite, 16, 30, 9, 5, p.fur);
    fillRect(sprite, 27, 27, 4, 10, p.furDark);
    fillEllipse(sprite, 34, 33, 7, 9, shieldOuter);
    fillEllipse(sprite, 34, 33, 5, 7, shieldInner);
    fillRect(sprite, 32, 31, 5, 1, shieldMark);
    fillRect(sprite, 35, 31, 1, 6, shieldMark);
    fillRect(sprite, 18, 18, 3, 3, '#ffffff');
    fillRect(sprite, 25, 18, 3, 3, '#ffffff');
    fillRect(sprite, 19, 19, 1, 2, p.eye);
    fillRect(sprite, 26, 19, 1, 2, p.eye);
    fillRect(sprite, 12, 22, 2, 2, '#f4af98');
    fillRect(sprite, 28, 22, 2, 2, '#f4af98');
    fillRect(sprite, 19, 23, 4, 2, p.nose);
    fillRect(sprite, 20, 25, 2, 1, p.nose);
    fillRect(sprite, 19, 26, 1, 1, p.nose);
    fillRect(sprite, 22, 26, 1, 1, p.nose);
    dots(
      sprite,
      [
        [[18, 9], [21, 8], [24, 9]],
        [[15, 13], [13, 17], [12, 21], [27, 13], [29, 17], [30, 21]],
        [[16, 16], [25, 16], [15, 25], [26, 25], [18, 36], [23, 36]],
        [[28, 28], [30, 30], [31, 32]],
      ],
      p.stripe,
    );
    dots(
      sprite,
      [
        [[10, 35], [8, 36], [7, 38], [8, 40], [10, 41]],
      ],
      p.furDark,
    );
    drawWhiskers(sprite, 25, '#f4e3d1');
    strokeEdge(sprite, p.outline);
    return sprite;
  };

  const drawPanda = () => {
    const p = PAL.panda;
    const sprite = createSprite();
    const laptopShell = '#7d95ab';
    const laptopScreen = '#dceaf5';
    const laptopShadow = '#597286';
    fillEllipse(sprite, 26, 18, 13, 12, p.face);
    fillEllipse(sprite, 18, 12, 4, 4, p.furDark);
    fillEllipse(sprite, 34, 12, 4, 4, p.furDark);
    fillEllipse(sprite, 20, 20, 5, 6, p.eyePatch);
    fillEllipse(sprite, 32, 20, 5, 6, p.eyePatch);
    fillEllipse(sprite, 26, 26, 8, 6, p.muzzle);
    fillEllipse(sprite, 26, 37, 8, 7, p.furDark);
    fillRect(sprite, 17, 30, 18, 9, laptopShell);
    fillRect(sprite, 19, 31, 14, 5, laptopScreen);
    fillRect(sprite, 18, 37, 16, 2, laptopShadow);
    fillRect(sprite, 18, 29, 5, 4, p.furDark);
    fillRect(sprite, 29, 29, 5, 4, p.furDark);
    fillRect(sprite, 21, 18, 3, 3, '#ffffff');
    fillRect(sprite, 29, 18, 3, 3, '#ffffff');
    fillRect(sprite, 22, 19, 1, 2, p.eye);
    fillRect(sprite, 30, 19, 1, 2, p.eye);
    fillRect(sprite, 24, 23, 4, 2, p.nose);
    fillRect(sprite, 25, 25, 2, 1, p.nose);
    fillRect(sprite, 24, 26, 1, 1, p.nose);
    fillRect(sprite, 27, 26, 1, 1, p.nose);
    fillRect(sprite, 21, 33, 10, 1, '#94abc0');
    fillRect(sprite, 23, 35, 6, 1, '#94abc0');
    strokeEdge(sprite, p.outline);
    return sprite;
  };

  const drawMonkey = () => {
    const p = PAL.monkey;
    const sprite = createSprite();
    const eyeTone = '#40110f';
    const eyeGlow = '#7e1d18';
    const furHi = '#c58a59';
    const furMid = '#9d603b';
    const blush = '#efb39b';
    fillEllipse(sprite, 14, 20, 5, 6, p.fur);
    fillEllipse(sprite, 38, 20, 5, 6, p.fur);
    fillEllipse(sprite, 14, 20, 3, 4, p.face);
    fillEllipse(sprite, 38, 20, 3, 4, p.face);
    fillEllipse(sprite, 26, 18, 13, 12, p.fur);
    fillEllipse(sprite, 20, 22, 8, 7, p.face);
    fillEllipse(sprite, 32, 22, 8, 7, p.face);
    fillEllipse(sprite, 26, 25, 11, 8, p.face);
    fillEllipse(sprite, 26, 28, 6, 4, p.muzzle);
    fillEllipse(sprite, 26, 38, 7, 7, p.fur);
    fillEllipse(sprite, 26, 39, 4, 5, p.face);
    fillRect(sprite, 19, 34, 3, 7, p.fur);
    fillRect(sprite, 31, 34, 3, 7, p.fur);
    fillRect(sprite, 18, 40, 4, 2, p.face);
    fillRect(sprite, 31, 40, 4, 2, p.face);
    fillRect(sprite, 22, 42, 3, 5, p.fur);
    fillRect(sprite, 27, 42, 3, 5, p.fur);
    fillRect(sprite, 20, 46, 5, 2, p.face);
    fillRect(sprite, 28, 46, 5, 2, p.face);
    fillEllipse(sprite, 20, 22, 3, 4, eyeTone);
    fillEllipse(sprite, 32, 22, 3, 4, eyeTone);
    fillRect(sprite, 18, 19, 2, 2, '#ffffff');
    fillRect(sprite, 30, 19, 2, 2, '#ffffff');
    fillRect(sprite, 21, 23, 1, 1, eyeGlow);
    fillRect(sprite, 33, 23, 1, 1, eyeGlow);
    fillRect(sprite, 16, 25, 2, 2, blush);
    fillRect(sprite, 34, 25, 2, 2, blush);
    fillRect(sprite, 24, 25, 4, 2, p.nose);
    fillRect(sprite, 23, 27, 1, 1, p.nose);
    fillRect(sprite, 28, 27, 1, 1, p.nose);
    dots(sprite, [[[23, 29], [24, 30], [25, 31], [26, 31], [27, 31], [28, 30], [29, 29]]], p.nose);
    dots(sprite, [[[19, 18], [21, 17], [33, 18], [31, 17], [22, 39], [30, 39], [25, 40], [27, 40]]], furHi);
    dots(sprite, [[[13, 20], [39, 20], [14, 23], [38, 23], [20, 45], [24, 45], [29, 45], [32, 45]]], furMid);
    dots(sprite, [[[18, 40], [19, 41], [32, 40], [33, 41]]], '#f5dcc0');
    dots(sprite, [[[21, 47], [23, 47], [29, 47], [31, 47]]], p.nose);
    dots(
      sprite,
      [
        [[22, 12], [23, 10], [24, 8], [26, 7], [28, 8], [30, 9], [31, 11], [30, 14], [32, 13], [34, 10], [35, 9], [36, 10], [35, 13], [33, 15]],
      ],
      p.furDark,
    );
    dots(sprite, [[[25, 10], [27, 9], [29, 11], [31, 13], [20, 13], [18, 15], [23, 14]]], furHi);
    dots(
      sprite,
      [
        [[35, 36], [38, 35], [41, 35], [43, 36], [44, 38], [44, 40], [43, 42], [41, 43], [39, 43], [38, 42], [38, 40], [39, 39], [40, 39], [41, 40], [41, 41], [40, 41]],
      ],
      p.fur,
    );
    dots(sprite, [[[39, 36], [41, 37], [42, 39], [41, 41], [39, 42], [38, 41]]], furHi);
    strokeEdge(sprite, p.outline);
    return sprite;
  };

  const drawFox = () => {
    const p = PAL.fox;
    const sprite = createSprite();
    fillEllipse(sprite, 26, 22, 13, 12, p.fur);
    fillRect(sprite, 15, 8, 5, 9, p.furDark);
    fillRect(sprite, 32, 8, 5, 9, p.furDark);
    fillRect(sprite, 17, 10, 2, 5, p.ear);
    fillRect(sprite, 34, 10, 2, 5, p.ear);
    fillEllipse(sprite, 26, 25, 8, 7, p.face);
    fillEllipse(sprite, 26, 28, 7, 4, p.muzzle);
    fillEllipse(sprite, 26, 36, 9, 7, p.furDark);
    fillRect(sprite, 20, 19, 3, 3, '#ffffff');
    fillRect(sprite, 29, 19, 3, 3, '#ffffff');
    fillRect(sprite, 21, 20, 1, 2, p.eye);
    fillRect(sprite, 30, 20, 1, 2, p.eye);
    fillRect(sprite, 25, 25, 3, 2, p.nose);
    fillRect(sprite, 24, 28, 5, 1, p.nose);
    fillRect(sprite, 21, 31, 10, 2, p.muzzle);
    drawWhiskers(sprite, 27, '#f2dfc8');
    strokeEdge(sprite, p.outline);
    return sprite;
  };

  const drawBear = () => {
    const p = PAL.bear;
    const sprite = createSprite();
    drawCommonMammal(sprite, { fur: p.fur, furDark: p.furDark, face: p.face, muzzle: p.muzzle, eye: p.eye, nose: p.nose, cheek: '#c8926e' });
    fillEllipse(sprite, 22, 15, 2, 2, p.face);
    fillEllipse(sprite, 30, 15, 2, 2, p.face);
    fillRect(sprite, 23, 34, 6, 2, p.furDark);
    strokeEdge(sprite, p.outline);
    return sprite;
  };

  const drawOtter = () => {
    const p = PAL.otter;
    const sprite = createSprite();
    fillEllipse(sprite, 26, 20, 13, 12, p.fur);
    fillEllipse(sprite, 18, 13, 3, 3, p.furDark);
    fillEllipse(sprite, 34, 13, 3, 3, p.furDark);
    fillEllipse(sprite, 18, 13, 2, 2, p.face);
    fillEllipse(sprite, 34, 13, 2, 2, p.face);
    fillEllipse(sprite, 26, 23, 10, 8, p.face);
    fillEllipse(sprite, 26, 28, 8, 6, p.muzzle);
    fillEllipse(sprite, 26, 36, 8, 6, p.furDark);
    fillRect(sprite, 20, 32, 12, 5, p.face);
    fillEllipse(sprite, 19, 31, 5, 5, p.fur);
    fillEllipse(sprite, 33, 31, 5, 5, p.fur);
    fillRect(sprite, 17, 29, 5, 3, p.fur);
    fillRect(sprite, 31, 29, 5, 3, p.fur);
    fillRect(sprite, 21, 20, 3, 3, '#ffffff');
    fillRect(sprite, 29, 20, 3, 3, '#ffffff');
    fillRect(sprite, 22, 21, 1, 2, p.eye);
    fillRect(sprite, 30, 21, 1, 2, p.eye);
    fillRect(sprite, 16, 23, 2, 2, '#f3a2a1');
    fillRect(sprite, 34, 23, 2, 2, '#f3a2a1');
    fillRect(sprite, 24, 25, 4, 2, p.nose);
    fillRect(sprite, 25, 27, 2, 1, p.nose);
    fillRect(sprite, 24, 28, 1, 1, p.nose);
    fillRect(sprite, 27, 28, 1, 1, p.nose);
    fillRect(sprite, 20, 30, 4, 3, p.face);
    fillRect(sprite, 28, 30, 4, 3, p.face);
    fillRect(sprite, 21, 31, 2, 1, p.muzzle);
    fillRect(sprite, 29, 31, 2, 1, p.muzzle);
    fillRect(sprite, 20, 41, 12, 1, '#a9d7ee');
    fillRect(sprite, 23, 40, 6, 1, '#b8e2f5');
    drawWhiskers(sprite, 27, '#f4e7da');
    strokeEdge(sprite, p.outline);
    return sprite;
  };

  const drawOwl = () => {
    const p = PAL.owl;
    const sprite = createSprite();
    fillEllipse(sprite, 26, 22, 12, 13, p.fur);
    fillEllipse(sprite, 20, 11, 3, 3, p.furDark);
    fillEllipse(sprite, 32, 11, 3, 3, p.furDark);
    fillEllipse(sprite, 26, 36, 9, 7, p.furDark);
    fillEllipse(sprite, 20, 22, 5, 5, p.face);
    fillEllipse(sprite, 32, 22, 5, 5, p.face);
    fillRect(sprite, 18, 20, 4, 4, '#ffffff');
    fillRect(sprite, 30, 20, 4, 4, '#ffffff');
    fillRect(sprite, 19, 21, 2, 2, p.eye);
    fillRect(sprite, 31, 21, 2, 2, p.eye);
    fillRect(sprite, 25, 25, 2, 2, p.beak);
    fillRect(sprite, 24, 28, 5, 1, p.furDark);
    dots(sprite, [[[17, 27], [35, 27], [19, 30], [33, 30], [22, 33], [30, 33]]], p.face);
    strokeEdge(sprite, p.outline);
    return sprite;
  };

  const drawDolphin = () => {
    const p = PAL.dolphin;
    const sprite = createSprite();
    const splash = '#8dd9ff';
    const splashHi = '#def6ff';
    fillEllipse(sprite, 24, 20, 12, 8, p.skin);
    fillEllipse(sprite, 22, 18, 7, 4, p.skinHi);
    fillEllipse(sprite, 22, 23, 7, 4, p.belly);
    fillRect(sprite, 31, 17, 8, 5, p.skin);
    fillRect(sprite, 35, 16, 5, 2, p.skinDark);
    fillRect(sprite, 35, 21, 5, 2, p.skinDark);
    fillRect(sprite, 23, 9, 5, 6, p.skinDark);
    fillRect(sprite, 17, 27, 6, 4, p.skinDark);
    fillRect(sprite, 14, 18, 5, 3, p.skinDark);
    fillRect(sprite, 9, 14, 5, 4, p.skinDark);
    fillRect(sprite, 9, 22, 5, 4, p.skinDark);
    fillRect(sprite, 28, 18, 3, 3, '#ffffff');
    fillRect(sprite, 29, 19, 1, 2, p.eye);
    fillRect(sprite, 29, 23, 2, 2, '#f4a4b0');
    fillRect(sprite, 21, 25, 12, 1, p.skinDark);
    fillRect(sprite, 31, 12, 2, 3, splashHi);
    fillRect(sprite, 33, 10, 2, 2, splashHi);
    fillEllipse(sprite, 24, 37, 10, 4, splash);
    fillRect(sprite, 16, 38, 3, 2, splashHi);
    fillRect(sprite, 22, 39, 3, 2, splashHi);
    fillRect(sprite, 29, 38, 3, 2, splashHi);
    fillRect(sprite, 34, 36, 2, 3, splash);
    strokeEdge(sprite, p.outline);
    return sprite;
  };

  const drawEagle = () => {
    const p = PAL.eagle;
    const sprite = createSprite();
    fillEllipse(sprite, 26, 21, 12, 11, p.head);
    fillEllipse(sprite, 26, 16, 10, 6, p.headDark);
    fillEllipse(sprite, 26, 36, 10, 7, p.body);
    fillRect(sprite, 19, 33, 14, 3, p.wing);
    fillRect(sprite, 33, 23, 7, 3, p.beak);
    fillRect(sprite, 38, 22, 2, 2, p.beak);
    fillRect(sprite, 24, 20, 3, 3, '#ffffff');
    fillRect(sprite, 25, 21, 1, 1, p.eye);
    fillRect(sprite, 23, 28, 6, 2, p.headDark);
    strokeEdge(sprite, p.outline);
    return sprite;
  };

  const drawRooster = () => {
    const p = PAL.rooster;
    const sprite = createSprite();
    fillEllipse(sprite, 26, 22, 12, 11, p.body);
    fillEllipse(sprite, 26, 36, 9, 7, p.wing);
    fillRect(sprite, 22, 8, 3, 6, p.comb);
    fillRect(sprite, 25, 6, 3, 8, p.comb);
    fillRect(sprite, 28, 9, 3, 6, p.comb);
    fillRect(sprite, 32, 25, 3, 3, p.wattle);
    fillRect(sprite, 33, 23, 6, 3, p.beak);
    fillRect(sprite, 15, 14, 3, 10, p.tail);
    fillRect(sprite, 13, 16, 2, 8, p.tailHi);
    fillRect(sprite, 16, 12, 2, 4, p.tailHi);
    fillRect(sprite, 23, 20, 3, 3, '#ffffff');
    fillRect(sprite, 24, 21, 1, 1, p.eye);
    fillRect(sprite, 21, 33, 10, 2, p.wing);
    strokeEdge(sprite, p.outline);
    return sprite;
  };

  const spriteFactory = {
    robot: drawRobot,
    lion: drawLion,
    tiger: drawTiger,
    panda: drawPanda,
    monkey: drawMonkey,
    fox: drawFox,
    bear: drawBear,
    otter: drawOtter,
    owl: drawOwl,
    dolphin: drawDolphin,
    eagle: drawEagle,
    rooster: drawRooster,
    default: drawBear,
  };

  const spriteCache = new Map();
  const getSprite = (animal) => {
    const key = (animal || 'default').trim().toLowerCase();
    if (!spriteCache.has(key)) {
      const renderer = spriteFactory[key] || spriteFactory.default;
      spriteCache.set(key, renderer());
    }
    return spriteCache.get(key);
  };
  const spriteBoundsCache = new Map();
  const computeSpriteBounds = (sprite) => {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let y = 0; y < sprite.length; y += 1) {
      for (let x = 0; x < sprite[y].length; x += 1) {
        if (!sprite[y][x]) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return { minX: 0, minY: 0, maxX: sprite.length - 1, maxY: sprite.length - 1, width: sprite.length, height: sprite.length, span: sprite.length };
    }
    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    return { minX, minY, maxX, maxY, width, height, span: Math.max(width, height) };
  };
  const getSpriteBounds = (animal, sprite) => {
    const key = (animal || 'default').trim().toLowerCase();
    if (!spriteBoundsCache.has(key)) {
      spriteBoundsCache.set(key, computeSpriteBounds(sprite));
    }
    return spriteBoundsCache.get(key);
  };
  const spriteVisualSpanCompensation = {
    lion: 0.92,
    otter: 0.9,
  };

  const render = (canvas, animal, accent, motion) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const bob = motion && Number.isFinite(motion.bob) ? motion.bob : 0;
    const sway = motion && Number.isFinite(motion.sway) ? motion.sway : 0;
    const blink = motion && Number.isFinite(motion.blink) ? motion.blink : 0;
    const auraA = lighten(accent, 0.6);
    const auraB = lighten(accent, 0.9);
    const panelLine = darken(accent, 0.33);
    const shadowTone = darken(accent, 0.52);
    const g = ctx.createRadialGradient(
      canvas.width * 0.5,
      canvas.height * 0.38,
      8,
      canvas.width * 0.5,
      canvas.height * 0.44,
      canvas.width * 0.5,
    );
    g.addColorStop(0, auraA);
    g.addColorStop(1, auraB);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const sprite = getSprite(animal);
    const gridSize = sprite.length;
    const bounds = getSpriteBounds(animal, sprite);
    const squareSpan = bounds.span;
    const spanCompensation = spriteVisualSpanCompensation[animal] || 1;
    const effectiveSpan = Math.max(1, squareSpan * spanCompensation);
    const scale = Math.max(2, Math.floor(Math.min((canvas.width - 26) / effectiveSpan, (canvas.height - 24) / effectiveSpan)));
    const panelSize = squareSpan * scale;
    const visibleW = bounds.width * scale;
    const visibleH = bounds.height * scale;
    const panelX = Math.floor((canvas.width - panelSize) / 2) + sway;
    const panelY = Math.floor((canvas.height - panelSize) / 2) - 1 + bob;
    const visibleX = panelX + Math.floor((panelSize - visibleW) / 2);
    const visibleY = panelY + Math.floor((panelSize - visibleH) / 2);
    const ox = visibleX - bounds.minX * scale;
    const oy = visibleY - bounds.minY * scale;

    const panelGrad = ctx.createLinearGradient(panelX, panelY, panelX, panelY + panelSize);
    panelGrad.addColorStop(0, 'rgba(255,255,255,0.7)');
    panelGrad.addColorStop(1, 'rgba(255,255,255,0.42)');
    ctx.fillStyle = panelGrad;
    ctx.fillRect(panelX - 4, panelY - 4, panelSize + 8, panelSize + 8);
    ctx.strokeStyle = panelLine;
    ctx.globalAlpha = 0.14;
    ctx.strokeRect(panelX - 4.5, panelY - 4.5, panelSize + 9, panelSize + 9);
    ctx.globalAlpha = 1;

    const hasPixel = (x, y) => y >= 0 && y < gridSize && x >= 0 && x < gridSize && sprite[y][x];
    const outlineColor = (PAL[animal] && PAL[animal].outline) || PAL.default.outline;
    for (let gy = 0; gy < gridSize; gy += 1) {
      for (let gx = 0; gx < gridSize; gx += 1) {
        if (!sprite[gy][gx]) continue;
        const edge =
          !hasPixel(gx - 1, gy) ||
          !hasPixel(gx + 1, gy) ||
          !hasPixel(gx, gy - 1) ||
          !hasPixel(gx, gy + 1);
        if (edge) {
          ctx.fillStyle = shadowTone;
          ctx.globalAlpha = 0.32;
          ctx.fillRect(ox + gx * scale + 1, oy + gy * scale + 1, scale - 0.16, scale - 0.16);
          ctx.globalAlpha = 1;
          ctx.fillStyle = outlineColor;
          ctx.fillRect(ox + gx * scale, oy + gy * scale, scale - 0.08, scale - 0.08);
          ctx.globalAlpha = 1;
        }
      }
    }

    for (let gy = 0; gy < gridSize; gy += 1) {
      for (let gx = 0; gx < gridSize; gx += 1) {
        const color = sprite[gy][gx];
        if (!color) continue;
        const verticalShade = 1 - (gy / gridSize) * 0.09;
        const centerBias = 1 - Math.abs(gx - gridSize * 0.5) / (gridSize * 9.5);
        const shade = clamp(verticalShade * centerBias, 0.82, 1.06);
        ctx.fillStyle = paintHex(color, shade);
        ctx.fillRect(ox + gx * scale, oy + gy * scale, scale - 0.08, scale - 0.08);
        if ((gx + gy) % 6 === 2 && gy < gridSize * 0.72) {
          ctx.globalAlpha = 1;
          ctx.fillStyle = 'rgba(255,255,255,0.17)';
          ctx.fillRect(ox + gx * scale, oy + gy * scale, Math.max(1, scale - 1.2), Math.max(1, scale - 1.2));
        }
      }
    }

    if (blink > 0.5) {
      const blinkY = visibleY + Math.floor(visibleH * 0.42);
      const blinkX = visibleX + Math.floor(visibleW * 0.24);
      const blinkW = Math.max(2, Math.floor(visibleW * 0.45));
      const blinkH = Math.max(1, Math.floor(scale * 0.85));
      ctx.fillStyle = 'rgba(23, 47, 66, 0.6)';
      ctx.fillRect(blinkX, blinkY, blinkW, blinkH);
    }

    ctx.fillStyle = 'rgba(20, 64, 90, 0.12)';
    ctx.fillRect(
      visibleX + Math.floor(visibleW * 0.28),
      visibleY + visibleH - scale * 2 + Math.max(0, bob),
      Math.max(2, Math.floor(visibleW * 0.44)),
      Math.max(2, scale * 1.3),
    );
  };

  const hashSeed = (input) => {
    let hash = 0;
    for (let i = 0; i < input.length; i += 1) {
      hash = (hash * 33 + input.charCodeAt(i)) >>> 0;
    }
    return hash / 0xffffffff;
  };

  const motionActors = [];
  const motionProfiles = {
    robot: { bobAmp: 1.2, swayAmp: 0.9, bobFreq: 1.0, swayFreq: 0.82, blinkThreshold: 0.988 },
    lion: { bobAmp: 1.0, swayAmp: 0.8, bobFreq: 0.88, swayFreq: 0.76, blinkThreshold: 0.992 },
    tiger: { bobAmp: 1.15, swayAmp: 1.0, bobFreq: 0.96, swayFreq: 0.86, blinkThreshold: 0.989 },
    panda: { bobAmp: 0.8, swayAmp: 0.55, bobFreq: 0.8, swayFreq: 0.72, blinkThreshold: 0.994 },
    monkey: { bobAmp: 1.45, swayAmp: 1.35, bobFreq: 1.12, swayFreq: 0.94, blinkThreshold: 0.986 },
    dolphin: { bobAmp: 1.7, swayAmp: 1.55, bobFreq: 1.18, swayFreq: 1.02, blinkThreshold: 0.993 },
    otter: { bobAmp: 1.15, swayAmp: 0.95, bobFreq: 0.98, swayFreq: 0.84, blinkThreshold: 0.989 },
    rooster: { bobAmp: 1.3, swayAmp: 0.7, bobFreq: 1.06, swayFreq: 0.72, blinkThreshold: 0.991 },
    default: { bobAmp: 1.1, swayAmp: 0.9, bobFreq: 0.95, swayFreq: 0.82, blinkThreshold: 0.99 },
  };
  avatars.forEach((avatar, index) => {
    const canvas = avatar.querySelector('.agent-pixel-canvas');
    if (!canvas) return;
    const accent = getComputedStyle(avatar).getPropertyValue('--agent-accent').trim() || '#4e79a7';
    const animal = (avatar.dataset.animal || 'default').trim().toLowerCase();
    motionActors.push({
      canvas,
      accent,
      animal,
      seed: hashSeed(animal + ':' + accent + ':' + String(index + 1)),
    });
  });

  if (motionActors.length === 0) return;

  if (prefersReducedMotion) {
    motionActors.forEach((actor) => {
      render(actor.canvas, actor.animal, actor.accent, { bob: 0, sway: 0, blink: 0 });
    });
    return;
  }

  const step = (now) => {
    motionActors.forEach((actor) => {
      const profile = motionProfiles[actor.animal] || motionProfiles.default;
      const phase = now * 0.0032 * profile.bobFreq + actor.seed * 9.7;
      const bob = Math.round(Math.sin(phase) * profile.bobAmp);
      const sway = Math.round(Math.cos(phase * profile.swayFreq) * profile.swayAmp);
      const blinkSignal = Math.sin(now * 0.012 + actor.seed * 27);
      const blink = blinkSignal > profile.blinkThreshold ? 1 : 0;
      render(actor.canvas, actor.animal, actor.accent, { bob, sway, blink });
    });
    window.requestAnimationFrame(step);
  };
  window.requestAnimationFrame(step);
})();
</script>`;
}

function buildParitySurfaceRows(input: {
  sessionCount: number;
  pendingApprovals: number;
  cronCount: number;
  projectCount: number;
  taskCount: number;
  usageConnected: boolean;
  replayCount: number;
  digestConnected: boolean;
  importGuard: ReturnType<typeof readImportMutationGuardState>;
  budgetConnected: boolean;
  subscriptionConnected: boolean;
}): ParitySurfaceRow[] {
  return [
    {
      id: "sessions",
      name: "会话可见性",
      route: "/sessions",
      status: input.sessionCount > 0 ? "enabled" : "warn",
      detail:
        input.sessionCount > 0
          ? `可见会话 ${input.sessionCount} 条。`
          : "页面可用，等待实时会话数据。",
    },
    {
      id: "approvals",
      name: "审批与决策队列",
      route: "/?section=projects-tasks&quick=attention#tracked-task-view",
      status: "enabled",
      detail: `待审批 ${input.pendingApprovals} 条，决策队列可用。`,
    },
    {
      id: "cron",
      name: "定时调度",
      route: "/cron",
      status: input.cronCount > 0 ? "enabled" : "warn",
      detail: input.cronCount > 0 ? `已追踪 ${input.cronCount} 个定时任务。` : "调度页面可用，但尚未上报任务。",
    },
    {
      id: "projects_tasks",
      name: "项目与任务",
      route: "/?section=projects-tasks",
      status: input.projectCount + input.taskCount > 0 ? "enabled" : "warn",
      detail: `${input.projectCount} 个项目，${input.taskCount} 个任务。`,
    },
    {
      id: "usage",
      name: "用量与费用",
      route: "/?section=usage-cost",
      status: input.usageConnected ? "enabled" : "warn",
      detail: input.usageConnected ? "运行时用量信号已连接。" : "页面可用，但数据源未连接。",
    },
    {
      id: "replay",
      name: "回放与审计",
      route: "/audit",
      status: input.replayCount > 0 ? "enabled" : "warn",
      detail: input.replayCount > 0 ? `可用时间线事件 ${input.replayCount} 条。` : "页面可用，但暂无时间线事件。",
    },
    {
      id: "health_digest",
      name: "健康与日报",
      route: "/digest/latest",
      status: input.digestConnected ? "enabled" : "warn",
      detail: input.digestConnected
        ? "健康与日报入口均可用。"
        : "健康入口可用，日报将在监控周期后生成。",
    },
    {
      id: "export_import",
      name: "导出 / 导入演练",
      route: "/?section=settings",
      status: input.importGuard.defaultMode === "blocked" ? "warn" : "enabled",
      detail: `导入默认模式：${input.importGuard.defaultMode}，导出入口可用。`,
    },
    {
      id: "pixel",
      name: "像素画布适配",
      route: "/view/pixel-state.json",
      status: "enabled",
      detail: "像素场景接口可用。",
    },
    {
      id: "subscription",
      name: "订阅用量与余量",
      route: "/?section=usage-cost",
      status: input.subscriptionConnected ? "enabled" : "warn",
      detail: input.subscriptionConnected
        ? `订阅数据已连接${input.budgetConnected ? "，预算预测已启用。" : "。"}`
        : "订阅页面可用，本地账单快照尚未连接。",
    },
  ];
}

function renderParitySurfaceRows(rows: ParitySurfaceRow[]): string {
  return rows
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.name)}</td><td>${badge(row.status)}</td><td><a href="${escapeHtml(row.route)}">${escapeHtml(row.route)}</a></td><td>${escapeHtml(row.detail)}</td></tr>`,
    )
    .join("");
}

function parseSubscriptionConnectPaths(connectHint: string | undefined): string[] {
  if (!connectHint) return [];
  const normalized = connectHint.trim();
  if (!normalized) return [];
  const marker = "Provide one of:";
  const body = normalized.startsWith(marker) ? normalized.slice(marker.length).trim() : normalized;
  if (!body) return [];
  return body.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

function normalizeQuotaWindowLabel(label: string | undefined, fallback: string): string {
  const raw = (label ?? "").trim();
  if (!raw) return fallback;
  const normalized = raw.toLowerCase();
  if (normalized === "7d" || normalized.includes("week") || normalized.includes("周")) return "Week";
  if (normalized === "5h" || normalized.includes("5h")) return "5h";
  const minuteMatch = /^(\d+(?:\.\d+)?)\s*m$/i.exec(normalized);
  if (minuteMatch?.[1]) {
    const minutes = Number(minuteMatch[1]);
    if (Number.isFinite(minutes)) {
      if (Math.abs(minutes - 10080) <= 2) return "Week";
      if (Math.abs(minutes - 300) <= 2) return "5h";
      if (Math.abs(minutes - 1440) <= 2) return "1d";
    }
  }
  return raw;
}

function asPercent(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function renderQuotaWindowRow(
  input: {
  label: string;
  usedPercent?: number;
  remainingPercent?: number;
  resetAt?: string;
  },
  language: UiLanguage = "zh",
): string {
  const usedPercent = asPercent(input.usedPercent);
  const remainingPercent = asPercent(input.remainingPercent);
  const usedText = typeof usedPercent === "number" ? `${usedPercent.toFixed(1)}%` : "—";
  const remainingText = typeof remainingPercent === "number" ? `${remainingPercent.toFixed(1)}%` : "—";
  const fillWidth = typeof usedPercent === "number" ? usedPercent : 0;
  const resetAt = input.resetAt?.trim();
  const resetText =
    !resetAt
      ? pickUiText(language, "Reset not provided", "重置时间未提供")
      : `${escapeHtml(pickUiText(language, "Reset", "重置"))} <span data-quota-reset-at="${escapeHtml(resetAt)}" data-quota-window="${escapeHtml(input.label)}">${escapeHtml(pickUiText(language, "Loading...", "加载中..."))}</span>`;
  return `<div class="quota-row">
    <div class="quota-head">
      <span class="quota-label">${escapeHtml(input.label)}</span>
      <span class="quota-value">${escapeHtml(pickUiText(language, "Used", "已用"))} ${escapeHtml(usedText)} · ${escapeHtml(
        pickUiText(language, "Remaining", "剩余"),
      )} ${escapeHtml(remainingText)}</span>
    </div>
    <div class="quota-track"><div class="quota-fill" style="width:${fillWidth.toFixed(1)}%;"></div></div>
    <div class="quota-foot">${resetText}</div>
  </div>`;
}

function renderSubscriptionSidebarSummary(
  subscription: UsageCostSnapshot["subscription"],
  language: UiLanguage = "zh",
): string {
  if (subscription.status === "connected" && (subscription.primaryWindowLabel || subscription.secondaryUsedPercent !== undefined)) {
    const primaryUsed = asPercent(subscription.primaryUsedPercent ?? subscription.usagePercent);
    const primaryRemaining = asPercent(
      subscription.primaryRemainingPercent ??
        (typeof primaryUsed === "number" ? 100 - primaryUsed : undefined),
    );
    const secondaryUsed = asPercent(subscription.secondaryUsedPercent);
    const secondaryRemaining = asPercent(
      subscription.secondaryRemainingPercent ??
        (typeof secondaryUsed === "number" ? 100 - secondaryUsed : undefined),
    );
    return `<div class="quota-compact">
      ${renderQuotaWindowRow({
        label: normalizeQuotaWindowLabel(subscription.primaryWindowLabel, "5h"),
        usedPercent: primaryUsed,
        remainingPercent: primaryRemaining,
        resetAt: subscription.primaryResetAt ?? subscription.cycleEnd,
      }, language)}
      ${renderQuotaWindowRow({
        label: normalizeQuotaWindowLabel(subscription.secondaryWindowLabel, "Week"),
        usedPercent: secondaryUsed,
        remainingPercent: secondaryRemaining,
        resetAt: subscription.secondaryResetAt,
      }, language)}
    </div>`;
  }
  return [
    typeof subscription.consumed === "number"
      ? `<div class="meta">${subscription.status === "connected" ? pickUiText(language, "Used", "已用") : pickUiText(language, "Estimated used", "估算已用")}：${escapeHtml(formatSubscriptionNumericField(subscription.consumed, subscription.unit, subscription.status === "connected" ? "used" : "estimated_used", language))}</div>`
      : "",
    typeof subscription.remaining === "number"
      ? `<div class="meta">${subscription.status === "connected" ? pickUiText(language, "Remaining", "剩余") : pickUiText(language, "Estimated remaining", "估算剩余")}：${escapeHtml(formatSubscriptionNumericField(subscription.remaining, subscription.unit, subscription.status === "connected" ? "remaining" : "estimated_remaining", language))}</div>`
      : "",
  ]
    .filter((item) => item.length > 0)
    .join("");
}

function renderSubscriptionStatusCard(
  subscription: UsageCostSnapshot["subscription"],
  language: UiLanguage = "zh",
): string {
  const statusLabel =
    subscription.status === "connected"
      ? pickUiText(language, "Connected", "已连接")
      : subscription.status === "partial"
        ? pickUiText(language, "Partially connected", "部分连接")
        : pickUiText(language, "Not connected", "未连接");
  if (subscription.status === "not_connected") {
    const hasEstimatedWindow =
      typeof subscription.consumed === "number" ||
      typeof subscription.remaining === "number" ||
      typeof subscription.limit === "number";
    const estimateRows = hasEstimatedWindow
      ? [
          typeof subscription.consumed === "number"
            ? `<div class="meta">${escapeHtml(pickUiText(language, "Estimated used", "估算已用"))}：${escapeHtml(formatSubscriptionNumericField(subscription.consumed, subscription.unit, "consumed", language))}</div>`
            : "",
          typeof subscription.remaining === "number"
            ? `<div class="meta">${escapeHtml(pickUiText(language, "Estimated remaining", "估算剩余"))}：${escapeHtml(formatSubscriptionNumericField(subscription.remaining, subscription.unit, "remaining", language))}</div>`
            : "",
          typeof subscription.limit === "number"
            ? `<div class="meta">${escapeHtml(pickUiText(language, "Estimated total", "估算总额"))}：${escapeHtml(formatSubscriptionNumericField(subscription.limit, subscription.unit, "limit", language))}</div>`
            : "",
        ]
          .filter((item) => item.length > 0)
          .join("")
      : "";
    return `<div class="empty-state">
      <div><strong>${escapeHtml(pickUiText(language, "Subscription data is not connected.", "订阅数据未接通。"))}</strong> ${escapeHtml(
        pickUiText(language, "Current balance is estimated.", "当前余额为估算值。"),
      )}</div>
      ${estimateRows}
      <div class="toolbar">
        <a class="btn" href="/?section=settings#tool-connectors">${escapeHtml(
          pickUiText(language, "Open data connection settings", "前往数据连接设置"),
        )}</a>
      </div>
    </div>`;
  }

  if (subscription.primaryWindowLabel || subscription.secondaryUsedPercent !== undefined) {
    const primaryUsed = asPercent(subscription.primaryUsedPercent ?? subscription.usagePercent);
    const primaryRemaining = asPercent(
      subscription.primaryRemainingPercent ??
        (typeof primaryUsed === "number" ? 100 - primaryUsed : undefined),
    );
    const secondaryUsed = asPercent(subscription.secondaryUsedPercent);
    const secondaryRemaining = asPercent(
      subscription.secondaryRemainingPercent ??
        (typeof secondaryUsed === "number" ? 100 - secondaryUsed : undefined),
    );
    const primarySummary = `${pickUiText(language, "Primary window", "主窗口")} ${normalizeQuotaWindowLabel(subscription.primaryWindowLabel, "5h")} · ${pickUiText(language, "Used", "已用")} ${typeof primaryUsed === "number" ? `${primaryUsed.toFixed(1)}%` : "—"} · ${pickUiText(language, "Remaining", "剩余")} ${typeof primaryRemaining === "number" ? `${primaryRemaining.toFixed(1)}%` : "—"}`;
    const primaryReset =
      subscription.primaryResetAt?.trim()
        ? `<span>${escapeHtml(pickUiText(language, "Reset", "重置"))} <span data-quota-reset-at="${escapeHtml(subscription.primaryResetAt)}" data-quota-window="${escapeHtml(normalizeQuotaWindowLabel(subscription.primaryWindowLabel, "5h"))}">${escapeHtml(pickUiText(language, "Loading...", "加载中..."))}</span></span>`
        : "";
    return `<div class="subscription-pill">
      <div><strong>${escapeHtml(pickUiText(language, "Quota windows", "额度窗口"))}</strong> ${badge(subscription.status, statusLabel)}</div>
      <div class="meta">${escapeHtml(primarySummary)}${primaryReset ? ` · ${primaryReset}` : ""}</div>
      <div class="meta">${escapeHtml(pickUiText(language, "Only the key windows are shown: 5h and Week.", "仅显示关键额度：5h 与 Week。"))}</div>
      <div class="quota-compact">
        ${renderQuotaWindowRow({
          label: normalizeQuotaWindowLabel(subscription.primaryWindowLabel, "5h"),
          usedPercent: primaryUsed,
          remainingPercent: primaryRemaining,
          resetAt: subscription.primaryResetAt ?? subscription.cycleEnd,
        }, language)}
        ${renderQuotaWindowRow({
          label: normalizeQuotaWindowLabel(subscription.secondaryWindowLabel, "Week"),
          usedPercent: secondaryUsed,
          remainingPercent: secondaryRemaining,
          resetAt: subscription.secondaryResetAt,
        }, language)}
      </div>
    </div>`;
  }

  const used = formatSubscriptionNumericField(subscription.consumed, subscription.unit, "consumed", language);
  const remaining = formatSubscriptionNumericField(subscription.remaining, subscription.unit, "remaining", language);
  const limit = formatSubscriptionNumericField(subscription.limit, subscription.unit, "limit", language);
  const cycleStart = subscription.cycleStart?.trim() ? subscription.cycleStart.trim() : pickUiText(language, "Not provided", "未提供");
  const cycleEnd = subscription.cycleEnd?.trim() ? subscription.cycleEnd.trim() : pickUiText(language, "Not provided", "未提供");
  const usagePercent = typeof subscription.usagePercent === "number" ? `${subscription.usagePercent.toFixed(1)}%` : pickUiText(language, "Not provided", "未提供");

  return `<div class="subscription-pill">
    <div><strong>${escapeHtml(subscription.planLabel)}</strong> ${badge(subscription.status, statusLabel)}</div>
    <div class="meta">${escapeHtml(pickUiText(language, "Used", "已用"))} ${escapeHtml(used)} · ${escapeHtml(
      pickUiText(language, "Remaining", "剩余"),
    )} ${escapeHtml(remaining)}</div>
    <div class="meta">${escapeHtml(pickUiText(language, "Limit", "总额"))}：${escapeHtml(limit)} · ${escapeHtml(
      pickUiText(language, "Usage", "使用率"),
    )}：${escapeHtml(usagePercent)}</div>
    <div class="meta">${escapeHtml(pickUiText(language, "Cycle", "周期"))}：${escapeHtml(cycleStart)} → ${escapeHtml(cycleEnd)}</div>
  </div>`;
}

export function renderSubscriptionStatusCardForSmoke(subscription: UsageCostSnapshot["subscription"]): string {
  return renderSubscriptionStatusCard(subscription, "en");
}

export function pickLatestSessionActivityTimestampForSmoke(...values: Array<string | undefined>): string | undefined {
  return pickLatestSessionActivityTimestamp(...values);
}

export function renderDashboardSectionNavForSmoke(
  section: DashboardSection,
  language: UiLanguage = "en",
): string {
  const activeSection =
    section === "office-space"
      ? "team"
      : section === "calendar"
        ? "projects-tasks"
        : section;
  return dashboardSectionLinks(language).map((item) => {
    const activeClass = item.key === activeSection ? " active" : "";
    const current = item.key === activeSection ? ' aria-current="page"' : "";
    return `<a class="nav-link${activeClass}" href="/?section=${encodeURIComponent(item.key)}"${current}>${escapeHtml(item.label)}</a>`;
  }).join("");
}

export function renderGlobalVisibilityCardForSmoke(language: UiLanguage): string {
  const model: GlobalVisibilityViewModel = {
    tasks: [
      {
        taskType: "cron",
        taskTypeLabel: pickUiText(language, "Timed jobs", "定时任务"),
        taskName: pickUiText(language, "Timed jobs", "定时任务"),
        executor: pickUiText(language, "System service", "系统服务"),
        currentAction: pickUiText(language, "Timed jobs are on.", "定时任务正在运行。"),
        nextRun: "2026-03-05T13:30:00.000Z",
        latestResult: pickUiText(language, "Active timed jobs: 1.", "已开启定时任务：1 个。"),
        status: "done",
        nextAction: pickUiText(language, "Keep timed jobs on and keep each job goal clear.", "保持定时任务开启，并确认每个任务目标清楚。"),
        detailsHref: buildGlobalVisibilityDetailHref("cron", language),
        detailsLabel: pickUiText(language, "See timed jobs", "查看定时任务"),
      },
      {
        taskType: "heartbeat",
        taskTypeLabel: pickUiText(language, "Heartbeat", "任务心跳"),
        taskName: pickUiText(language, "Heartbeat", "任务心跳"),
        executor: pickUiText(language, "System service", "系统服务"),
        currentAction: pickUiText(language, "Heartbeat is on.", "任务心跳已开启。"),
        nextRun: "2026-03-05T13:35:00.000Z",
        latestResult: pickUiText(language, "Active heartbeat checks: 1.", "已开启任务心跳：1 个。"),
        status: "done",
        nextAction: pickUiText(language, "Check picked tasks and confirm the choices look right.", "查看挑出的任务，确认挑选结果是否合理。"),
        detailsHref: buildGlobalVisibilityDetailHref("heartbeat", language),
        detailsLabel: pickUiText(language, "See heartbeat checks", "查看任务心跳"),
      },
      {
        taskType: "current_task",
        taskTypeLabel: pickUiText(language, "Current tasks", "当前任务"),
        taskName: pickUiText(language, "Current tasks", "当前任务"),
        executor: pickUiText(language, "Task owners", "任务智能体"),
        currentAction: pickUiText(language, "Tasks are moving.", "任务正在推进。"),
        nextRun: pickUiText(language, "Live update", "实时更新"),
        latestResult: pickUiText(language, "2 tasks moving.", "2 个任务在进行中。"),
        status: "done",
        nextAction: pickUiText(language, "Keep progress updated.", "持续更新任务进度。"),
        detailsHref: buildGlobalVisibilityDetailHref("current_task", language),
        detailsLabel: pickUiText(language, "See current tasks", "查看当前任务"),
      },
      {
        taskType: "tool_call",
        taskTypeLabel: pickUiText(language, "Tool calls", "工具调用"),
        taskName: pickUiText(language, "Tool calls", "工具调用"),
        executor: pickUiText(language, "Active sessions", "活跃会话"),
        currentAction: pickUiText(language, "Tools were used recently.", "最近有工具在使用。"),
        nextRun: pickUiText(language, "Live update", "实时更新"),
        latestResult: pickUiText(language, "Tool calls in recent activity: 3.", "最近工具调用：3 次。"),
        status: "done",
        nextAction: pickUiText(language, "Review results and keep going.", "看下结果后继续。"),
        detailsHref: buildGlobalVisibilityDetailHref("tool_call", language),
        detailsLabel: pickUiText(language, "See tool calls", "查看工具调用"),
      },
    ],
    doneCount: 4,
    notDoneCount: 0,
    noTaskMessage: pickUiText(
      language,
      "No timed jobs, heartbeat, current tasks, or tool calls yet.",
      "暂无定时任务、任务心跳、当前任务或工具调用。",
    ),
    signalCounts: {
      schedule: 1,
      heartbeat: 1,
      currentTasks: 2,
      toolCalls: 3,
    },
  };

  return renderGlobalVisibilityCard(model, language);
}

export function renderInformationCertaintyCardForSmoke(language: UiLanguage): string {
  return renderInformationCertaintyCard(
    {
      score: 82,
      badgeStatus: "ok",
      badgeLabel: pickUiText(language, "High certainty", "高确定性"),
      headline: pickUiText(language, "This picture is trustworthy enough for day-to-day decisions.", "这张画面已经足够支撑日常判断。"),
      summary: pickUiText(language, "Most key signals are connected, so you can judge OpenClaw from one screen with relatively high confidence.", "大部分关键信号都已连上，可以比较放心地用这一屏判断 OpenClaw 的当前状态。"),
      strengths: [
        pickUiText(language, "The home picture is fresh enough for current-state decisions.", "首页画面够新，可以直接拿来判断当前状态。"),
        pickUiText(language, "Current execution is visible, not just task records on a board.", "现在能看到真实执行中的会话，而不只是任务板上的记录。"),
      ],
      gaps: [pickUiText(language, "Remaining package room is still unconfirmed.", "套餐剩余额度目前还没有被完全确认。")],
      signals: [
        {
          key: "freshness",
          label: pickUiText(language, "Live picture", "实时画面"),
          status: "connected",
          detail: pickUiText(language, "Updated just now; suitable for deciding what is happening now.", "刚刚更新，适合直接判断现在发生了什么。"),
        },
        {
          key: "live_sessions",
          label: pickUiText(language, "Live execution", "实时执行"),
          status: "connected",
          detail: pickUiText(language, "3 live sessions are visible right now.", "当前可见 3 个实时执行中的会话。"),
        },
        {
          key: "subscription",
          label: pickUiText(language, "Subscription room", "订阅额度"),
          status: "partial",
          detail: pickUiText(language, "Subscription data exists, but part of the billing picture is missing.", "订阅数据已经有了，但账单画面还不完整。"),
        },
      ],
    },
    language,
  );
}

export function renderTaskCertaintySectionForSmoke(language: UiLanguage): string {
  return renderTaskCertaintySection(
    [
      {
        taskId: "task-1",
        title: pickUiText(language, "Stabilize Mission Control dashboard", "稳定 Mission Control 看板"),
        projectTitle: "control-center",
        owner: "Panda",
        score: 84,
        tone: "ok",
        toneLabel: pickUiText(language, "Evidence is strong", "证据充分"),
        summary: pickUiText(language, "This task already has enough execution evidence for normal follow-up.", "这个任务已经有足够的执行证据，正常跟进即可。"),
        evidence: [
          pickUiText(language, "Owner: Panda", "负责人：Panda"),
          pickUiText(language, "2 linked sessions", "已关联 2 个会话"),
        ],
        gaps: [],
        detailHref: buildTaskDetailHref("task-1", language),
      },
      {
        taskId: "task-2",
        title: pickUiText(language, "Reconnect billing visibility", "补齐账单可见性"),
        projectTitle: "control-center",
        owner: "Otter",
        score: 41,
        tone: "blocked",
        toneLabel: pickUiText(language, "Evidence is weak", "证据偏弱"),
        summary: pickUiText(language, "Right now there is not enough evidence to say this task is truly moving.", "目前还没有足够证据证明这个任务真的在推进。"),
        evidence: [pickUiText(language, "Owner: Otter", "负责人：Otter")],
        gaps: [pickUiText(language, "No execution session is linked yet.", "还没有关联执行会话。")],
        detailHref: buildTaskDetailHref("task-2", language),
      },
    ],
    language,
  );
}

export function renderTaskExecutionChainCardsForSmoke(language: UiLanguage = "zh"): string {
  return renderTaskExecutionChainCards(
    [
      {
        taskTitle: "{\"ok\":true,\"attemptedQueries\":30}",
        owner: "main",
        sessionKey: "agent:main:cron:worker-1:run:child-1",
        agentId: "main",
        state: "running",
        latestAt: "2026-03-10T19:22:57.330Z",
        latestSnippet: "{\"ok\":true,\"attemptedQueries\":30,\"successfulQueries\":2,\"qualified\":2,\"sent\":2,\"failedQueries\":0...",
        executionChain: {
          accepted: true,
          spawned: true,
          parentSessionKey: "agent:main:cron:worker-1",
          childSessionKey: "agent:main:cron:worker-1:run:child-1",
          stage: "running",
          source: "history",
          inferred: false,
          detail: "Parent accepted the work and spawned a child session.",
        },
        unmapped: true,
        sessionHref: buildSessionDetailHref("agent:main:cron:worker-1:run:child-1", language),
      },
      {
        taskId: "task-json",
        taskTitle: "{\"ok\":false,\"error\":\"locked\"}",
        projectTitle: "control-center",
        owner: "main",
        sessionKey: "agent:main:main",
        agentId: "main",
        state: "idle",
        latestAt: "2026-03-10T19:00:06.442Z",
        latestSnippet: "{\"ok\":false,\"error\":\"locked\"}",
        executionChain: {
          accepted: true,
          spawned: false,
          stage: "accepted",
          source: "history",
          inferred: false,
          detail: "Parent accepted the work but child execution is still pending.",
        },
        unmapped: false,
        taskHref: buildTaskDetailHref("task-json", language),
        sessionHref: buildSessionDetailHref("agent:main:main", language),
      },
      {
        taskTitle: "agent:main:cron:worker-2",
        owner: "main",
        sessionKey: "agent:main:cron:worker-2:run:child-2",
        agentId: "main",
        state: "idle",
        latestAt: "2026-03-11T07:26:38.268Z",
        executionChain: {
          accepted: true,
          spawned: true,
          parentSessionKey: "agent:main:cron:worker-2",
          childSessionKey: "agent:main:cron:worker-2:run:child-2",
          stage: "spawned",
          source: "session_key",
          inferred: true,
          detail: "accepted=yes | spawned=yes | source=session_key | inferred=yes",
        },
        unmapped: true,
        sessionHref: buildSessionDetailHref("agent:main:cron:worker-2:run:child-2", language),
      },
    ],
    language,
  );
}

function stableHashIndex(input: string): number {
  let hash = 0;
  for (const ch of input) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return hash;
}

function renderUsagePeriodCards(periods: UsageCostSnapshot["periods"], language: UiLanguage = "zh"): string {
  if (periods.length === 0) {
    return `<div class="empty-state">${escapeHtml(
      pickUiText(language, "No period snapshot yet because the data source is not connected.", "数据源未连接，暂无周期用量快照。"),
    )}</div>`;
  }

  const cards = periods
    .map((period) => {
      const periodLabel = usagePeriodLabel(period.key, period.label, language);
      const tokenLabel =
        period.sourceStatus === "not_connected"
          ? pickUiText(language, "Not connected", "数据源未连接")
          : formatInt(period.tokens);
      const costLabel =
        period.sourceStatus === "not_connected"
          ? pickUiText(language, "Not connected", "数据源未连接")
          : formatCurrency(period.estimatedCost);
      const requestLabel =
        period.requestCountStatus !== "not_connected" && typeof period.requestCount === "number"
          ? String(period.requestCount)
          : pickUiText(language, "Not connected", "数据源未连接");
      return `<div class="status-chip usage-chip"><span>${escapeHtml(periodLabel)}</span><strong>${escapeHtml(
        pickUiText(language, "AI usage", "AI 用量"),
      )}：${escapeHtml(tokenLabel)}</strong><span>${escapeHtml(pickUiText(language, "Estimated cost", "预估费用"))}：${escapeHtml(
        costLabel,
      )}</span><span>${escapeHtml(pickUiText(language, "Requests", "请求数"))}：${escapeHtml(requestLabel)}</span><span>${escapeHtml(
        pickUiText(language, "Pace", "节奏"),
      )}：${escapeHtml(period.pace.label)}</span></div>`;
    })
    .join("");
  return `<div class="status-strip">${cards}</div>`;
}

function usagePeriodLabel(key: "today" | "7d" | "30d", fallback: string, language: UiLanguage = "zh"): string {
  if (key === "today") return pickUiText(language, "Today", "今天");
  if (key === "7d") return pickUiText(language, "Last 7 days", "近 7 天");
  if (key === "30d") return pickUiText(language, "Last 30 days", "近 30 天");
  return fallback;
}

function renderUsageContextRows(rows: UsageCostSnapshot["contextWindows"], language: UiLanguage): string {
  if (rows.length === 0) return "";

  return rows
    .slice(0, 24)
    .map((item) => {
      const usage =
        typeof item.usagePercent === "number"
          ? `${formatInt(item.usedTokens)} / ${formatInt(item.contextLimitTokens ?? 0)} (${item.usagePercent.toFixed(1)}%)`
          : `${formatInt(item.usedTokens)} / ${pickUiText(language, "Data source not connected", "数据源未连接")}`;
      return `<tr><td>${escapeHtml(item.agentId)}</td><td><code>${escapeHtml(item.sessionKey)}</code></td><td>${escapeHtml(item.model)}<div class="meta">${escapeHtml(item.provider)}</div></td><td>${usage}</td><td>${escapeHtml(item.paceLabel)} ${badge(item.thresholdState)}</td><td>${escapeHtml(item.warningThresholds)}</td></tr>`;
    })
    .join("");
}

function renderUsageBreakdownRows(
  rows: UsageCostSnapshot["breakdown"]["byAgent"],
  label: string,
  language: UiLanguage = "zh",
): string {
  if (rows.length === 0) return "";

  return rows
    .map(
      (item) =>
        `<tr><td>${escapeHtml(simplifyUsageLabel(item.label))}</td><td>${formatInt(item.tokens)}</td><td>${formatCurrency(item.estimatedCost)}</td><td>${item.requests}</td><td>${item.sessions}</td><td>${badge(item.sourceStatus, dataConnectionLabel(item.sourceStatus, language))}</td></tr>`,
    )
    .join("");
}

function renderTokenShareRows(
  rows: UsageCostSnapshot["breakdown"]["byAgent"],
  totalTokens: number,
  language: UiLanguage = "zh",
): string {
  if (rows.length === 0) return "";
  const safeTotal = totalTokens > 0 ? totalTokens : rows.reduce((sum, item) => sum + item.tokens, 0);
  return rows
    .map((item) => {
      const share = safeTotal > 0 ? (item.tokens / safeTotal) * 100 : 0;
      return `<tr><td>${escapeHtml(simplifyUsageLabel(item.label))}</td><td>${formatInt(item.tokens)}</td><td>${formatPercent(share)}</td><td>${item.sessions}</td><td>${badge(item.sourceStatus, dataConnectionLabel(item.sourceStatus, language))}</td></tr>`;
    })
    .join("");
}

const TOKEN_PIE_COLORS = [
  "#4e79a7",
  "#f28e2b",
  "#e15759",
  "#76b7b2",
  "#59a14f",
  "#edc948",
  "#b07aa1",
  "#ff9da7",
  "#9c755f",
  "#bab0ab",
];

function renderTokenPieChart(
  rows: UsageCostSnapshot["breakdown"]["byAgent"],
  totalTokens: number,
  centerLabel: string,
  language: UiLanguage = "zh",
): string {
  const sourceRows = rows.filter((item) => item.tokens > 0);
  if (sourceRows.length === 0 || totalTokens <= 0) return "";

  const segments = [...sourceRows].sort((a, b) => b.tokens - a.tokens);

  let cursor = 0;
  const gradientStops: string[] = [];
  const legend = segments
    .map((item, index) => {
      const color = TOKEN_PIE_COLORS[index % TOKEN_PIE_COLORS.length];
      const share = (item.tokens / totalTokens) * 100;
      const next = cursor + share;
      gradientStops.push(`${color} ${cursor.toFixed(2)}% ${next.toFixed(2)}%`);
      cursor = next;
      return `<li><span class="pie-swatch" style="background:${color};"></span><span class="pie-name">${escapeHtml(simplifyUsageLabel(item.label))}</span><span class="pie-val">${formatPercent(share)}</span></li>`;
    })
    .join("");

  const gradient = `conic-gradient(${gradientStops.join(", ")})`;
  return `<div class="pie-wrap">
    <div class="pie-chart" style="background:${gradient};">
      <div class="pie-hole"><strong>${escapeHtml(centerLabel)}</strong><span>${formatInt(totalTokens)} ${escapeHtml(
        pickUiText(language, "tokens", "用量"),
      )}</span></div>
    </div>
    <ul class="pie-legend">${legend}</ul>
  </div>`;
}

function renderUsageConnectorTodos(todos: UsageCostSnapshot["connectors"]["todos"], language: UiLanguage = "zh"): string {
  if (todos.length === 0) {
    return `<li>${escapeHtml(pickUiText(language, "All usage connectors are enabled.", "所有用量连接器均已启用。"))}</li>`;
  }
  const simplifyTitle = (raw: string): string => {
    const text = normalizeInlineText(raw);
    const lower = text.toLowerCase();
    if (lower.includes("context")) return pickUiText(language, "Model context data", "模型上下文数据");
    if (lower.includes("digest")) return pickUiText(language, "Trend history data", "趋势历史数据");
    if (lower.includes("request")) return pickUiText(language, "Request count data", "请求计数数据");
    if (lower.includes("budget")) return pickUiText(language, "Budget limit data", "预算限额数据");
    if (lower.includes("provider")) return pickUiText(language, "Provider mapping data", "供应商映射数据");
    if (lower.includes("subscription")) return pickUiText(language, "Subscription billing data", "订阅账单数据");
    return pickUiText(language, "Data connector item", "数据连接项");
  };
  const simplifyDetail = (raw: string): string => {
    const text = normalizeInlineText(raw);
    const lower = text.toLowerCase();
    if (lower.includes("subscription")) return pickUiText(language, "Connect the subscription billing data.", "请连接订阅账单数据。");
    if (lower.includes("digest") || lower.includes("history")) return pickUiText(language, "Keep monitoring running so trend history stays complete.", "请保持监控持续运行，确保趋势数据完整。");
    if (lower.includes("request")) return pickUiText(language, "Connect the request count source.", "请连接请求计数数据源。");
    if (lower.includes("provider")) return pickUiText(language, "Complete the model-to-provider mapping.", "请补全模型到供应商的映射。");
    if (lower.includes("context")) return pickUiText(language, "Connect model context capacity data.", "请连接模型上下文容量信息。");
    if (lower.includes("budget")) return pickUiText(language, "Configure budget limits so the system can warn early.", "请配置预算限额，便于风险预警。");
    return pickUiText(language, "Finish the data connection in Settings.", "请在设置页完成数据连接。");
  };
  return todos
    .map((item) => `<li><strong>${escapeHtml(simplifyTitle(item.title))}：</strong>${escapeHtml(simplifyDetail(item.detail))}</li>`)
    .join("");
}

function formatInt(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "0.00%";
  return `${value.toFixed(2)}%`;
}

function dataConnectionLabel(status: string, language: UiLanguage = "zh"): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === "connected") return pickUiText(language, "Connected", "已连接");
  if (normalized === "partial") return pickUiText(language, "Partially connected", "部分连接");
  if (normalized === "not_connected") return pickUiText(language, "Not connected", "未连接");
  return status;
}

function simplifyUsageLabel(label: string): string {
  const normalized = normalizeInlineText(label);
  if (!normalized) return "未命名";
  const withoutUuid = normalized.replace(/\s*\([0-9a-f]{8}-[0-9a-f-]{27,}\)\s*/gi, "");
  return safeTruncate(withoutUuid, 72);
}

function formatSubscriptionNumericField(value: number | undefined, unit: string, field: string, language: UiLanguage = "zh"): string {
  if (typeof value === "number") {
    if (unit.trim() === "%") return `${value.toFixed(1)}%`;
    return `${formatInt(value)} ${unit}`;
  }
  return pickUiText(language, `Unavailable: subscription data is missing "${field}"`, `不可用：订阅数据缺少「${field}」`);
}

function formatSubscriptionTextField(value: string | undefined, field: string, language: UiLanguage = "zh"): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  return pickUiText(language, `Unavailable: subscription data is missing "${field}"`, `不可用：订阅数据缺少「${field}」`);
}

function formatSubscriptionPercentField(value: number | undefined, language: UiLanguage = "zh"): string {
  if (typeof value === "number") return `${value.toFixed(1)}%`;
  return pickUiText(language, "Unavailable: subscription data is missing usage percent", "不可用：订阅数据缺少使用率");
}

function normalizeOptionalPatchString(
  input: unknown,
  label: string,
  maxLength: number,
): string | undefined {
  if (input === null) return undefined;
  if (input === "") return undefined;
  if (typeof input !== "string") {
    throw new RequestValidationError(`${label} must be a string`, 400);
  }

  const trimmed = input.trim();
  if (!trimmed) return undefined;
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) {
    throw new RequestValidationError(`${label} contains invalid control characters`, 400);
  }
  if (trimmed.length > maxLength) {
    throw new RequestValidationError(`${label} must be <= ${maxLength} characters`, 400);
  }
  return trimmed;
}

function isControlCenterMappingTask(task: TaskListItem): boolean {
  return (
    task.projectId === "p-live" &&
    CONTROL_CENTER_MAPPING_TASK_IDS.has(task.taskId) &&
    task.title.trim().toLowerCase() === task.taskId.trim().toLowerCase() &&
    task.sessionKeys.length === 0
  );
}

function isControlCenterMappingUsageTaskLabel(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  for (const taskId of CONTROL_CENTER_MAPPING_TASK_IDS) {
    if (normalized.includes(`/${taskId}`) || normalized.includes(` ${taskId}`) || normalized.includes(`${taskId} ·`)) {
      return true;
    }
  }
  return false;
}

function renderTaskBoard(tasks: TaskListItem[], language: UiLanguage = "zh"): string {
  if (tasks.length === 0) {
    return `<div class="empty-state">${escapeHtml(pickUiText(language, "No tasks yet. New tasks will enter the board automatically.", "暂无任务。创建任务后会自动进入泳道。"))}</div>`;
  }
  const lanes = TASK_STATES.map((state) => {
    const laneTasks = tasks.filter((task) => task.status === state);
    const cards =
      laneTasks.length === 0
        ? `<div class="meta" style="margin-top:8px;">${escapeHtml(pickUiText(language, "None", "暂无"))}</div>`
        : laneTasks
            .map(
              (task) =>
                `<div class="task-chip"><div><code>${escapeHtml(task.taskId)}</code></div><div>${escapeHtml(task.title)}</div><div class="meta">${escapeHtml(task.projectId)} · ${escapeHtml(task.owner)}</div></div>`,
            )
            .join("");

    return `<div class="lane"><h3>${escapeHtml(taskStateLabel(state, language))}</h3><div class="lane-count">${laneTasks.length} ${escapeHtml(pickUiText(language, "tasks", "个任务"))}</div>${cards}</div>`;
  });

  return `<div class="board">${lanes.join("")}</div>`;
}

function renderProjectBoard(projects: ReadModelSnapshot["projectSummaries"], language: UiLanguage = "zh"): string {
  if (projects.length === 0) {
    return `<div class="empty-state">${escapeHtml(pickUiText(language, "No projects yet. They will appear after project data is connected.", "暂无项目。连接项目数据后会显示。"))}</div>`;
  }
  const lanes = PROJECT_STATES.map((state) => {
    const laneProjects = projects.filter((project) => project.status === state);
    const cards =
      laneProjects.length === 0
        ? `<div class="meta" style="margin-top:8px;">${escapeHtml(pickUiText(language, "None", "暂无"))}</div>`
        : laneProjects
            .map(
              (project) =>
                `<div class="project-chip"><div><code>${escapeHtml(project.projectId)}</code> ${badge(project.status, projectStateLabel(project.status, language))}</div><div>${escapeHtml(project.title)}</div><div class="meta">${escapeHtml(pickUiText(language, "Agent", "智能体"))}：${escapeHtml(project.owner)} | ${escapeHtml(pickUiText(language, "Done", "完成"))}：${project.done}/${project.totalTasks} | ${escapeHtml(pickUiText(language, "Due soon", "即将到期"))}：${project.due}</div></div>`,
            )
            .join("");

    return `<div class="lane"><h3>${escapeHtml(projectStateLabel(state, language))}</h3><div class="lane-count">${laneProjects.length} ${escapeHtml(pickUiText(language, "projects", "个项目"))}</div>${cards}</div>`;
  });

  return `<div class="board">${lanes.join("")}</div>`;
}

function renderActionQueue(center: NotificationCenterSnapshot): string {
  if (center.queue.length === 0) {
    return "<div class=\"empty-state\">暂无决策队列。出现需处理告警后会显示。</div>";
  }

  const items = center.queue
    .slice(0, 20)
    .map((item) => {
      const ackMeta = item.acknowledged
        ? `<span class="meta">已确认于 ${escapeHtml(item.ackedAt ?? "暂无")}${item.ackExpiresAt ? ` · 到期 ${escapeHtml(item.ackExpiresAt)}` : ""}</span>`
        : `<form method="POST" action="/action-queue/ack" class="inline-form"><input type="hidden" name="itemId" value="${escapeHtml(item.itemId)}" /><input type="password" name="localToken" placeholder="本地令牌" style="max-width:150px;" /><button class="btn" type="submit">确认</button></form>`;
      const links =
        item.links.length === 0
          ? ""
          : `<div class="meta">相关链接：${item.links
              .map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`)
              .join(" | ")}</div>`;
      return `<li class="queue-item"><div>${badge(item.level)} <code>${escapeHtml(item.itemId)}</code></div><div class="meta">${escapeHtml(item.message)}</div>${links}<div class="queue-actions">${ackMeta}</div></li>`;
    })
    .join("");

  return `<ul class="queue-list">${items}</ul>`;
}

function renderSessionPreviewRows(items: SessionConversationListItem[], language: UiLanguage = "zh"): string {
  if (items.length === 0) {
    return `<tr><td colspan="6">${escapeHtml(pickUiText(language, "No session data yet.", "暂无会话数据"))}</td></tr>`;
  }

  return items
    .map((item) => {
      const latestKind = item.latestKind ?? "message";
      const latestLabel = item.latestToolName ? `${latestKind}:${item.latestToolName}` : latestKind;
      const latestTime = item.latestHistoryAt ? ` @ ${item.latestHistoryAt}` : "";
      const historyState = item.historyError
        ? pickUiText(language, `Error: ${item.historyError}`, `错误: ${item.historyError}`)
        : `${item.historyCount}`;
      const agent = item.agentId ?? "-";

      return `<tr><td><a href="${escapeHtml(buildSessionDetailHref(item.sessionKey, language))}"><code>${escapeHtml(item.sessionKey)}</code></a></td><td>${badge(item.state, sessionStateLabel(item.state))}</td><td>${escapeHtml(agent)}</td><td>${badge(latestKind)} ${escapeHtml(latestLabel)}${escapeHtml(latestTime)}</td><td>${escapeHtml(summarizeVisibleSessionSnippet(item.latestSnippet, language, 220))}</td><td>${escapeHtml(historyState)}</td></tr>`;
    })
    .join("");
}

function renderSessionDrilldownPage(
  detail: SessionConversationDetailResult,
  language: UiLanguage = "en",
): string {
  const t = (en: string, zh: string): string => pickUiText(language, en, zh);
  const rows = renderSessionHistoryRows(detail.history, language);
  const status = detail.status;
  const executionChain = detail.executionChain;
  const homeHref = buildHomeHref({ quick: "all" }, true, "overview", language);
  const executionChainCard = executionChain
    ? `<div class="card" id="session-execution-chain">
    <h2 style="font-size:15px;">${escapeHtml(t("Execution Chain", "执行链"))}</h2>
    <div class="meta">${badge(executionChain.stage, executionChainStageLabel(executionChain.stage, language))} ${badge(executionChain.accepted ? "accepted" : "idle", t("Accepted", "已接单"))} ${badge(executionChain.spawned ? "spawn" : "idle", t("Spawned", "已派发"))}</div>
    <div class="meta">source=${escapeHtml(executionChain.source)} inferred=${executionChain.inferred ? "yes" : "no"}</div>
    <div class="meta">parent=${escapeHtml(executionChain.parentSessionKey ?? "-")} child=${escapeHtml(executionChain.childSessionKey ?? "-")}</div>
    <div class="meta">acceptedAt=${escapeHtml(executionChain.acceptedAt ?? "-")} spawnedAt=${escapeHtml(executionChain.spawnedAt ?? "-")}</div>
    <div class="meta">${escapeHtml(executionChain.detail)}</div>
  </div>`
    : `<div class="card" id="session-execution-chain">
    <h2 style="font-size:15px;">${escapeHtml(t("Execution Chain", "执行链"))}</h2>
    <div class="meta">${escapeHtml(t("No accepted/spawn evidence found yet. If this is a child run session, it will still appear once the session key or history provides a chain signal.", "当前还没有接单/派发证据。如果这是子执行会话，待会话 key 或历史记录补齐链路信号后会显示。"))}</div>
  </div>`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(t("OpenClaw Control Center Session Drilldown", "OpenClaw 控制中心会话详情"))}</title>
  <style>
    body { font-family: "SF Mono", Menlo, monospace; background: #0b1016; color: #d6e7f9; padding: 16px; margin: 0; }
    a { color: #7dd3fc; }
    .card { border: 1px solid #27405a; background: #111923; padding: 12px; border-radius: 8px; margin-top: 10px; }
    .meta { color: #93aac2; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
    th, td { border-bottom: 1px solid rgba(39,64,90,0.45); text-align: left; padding: 6px; vertical-align: top; }
    th { color: #93aac2; }
    .badge { display:inline-block; border-radius:999px; padding:2px 8px; font-size:11px; border:1px solid transparent; text-transform:uppercase; letter-spacing:0.06em; }
    .badge.info, .badge.running, .badge.in_progress, .badge.spawn, .badge.spawned { color: #3b82f6; border-color: #3b82f6; }
    .badge.warn { color: #f59e0b; border-color: #f59e0b; }
    .badge.action-required, .badge.blocked, .badge.error, .badge.over { color: #ef4444; border-color: #ef4444; }
    .badge.idle, .badge.todo, .badge.message, .badge.tool_event { color: #9ca3af; border-color: #9ca3af; }
    .badge.accepted { color: #22c55e; border-color: #22c55e; }
    .cell-content { white-space: pre-wrap; word-break: break-word; max-width: 760px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(t("Session Drilldown", "会话详情"))}</h1>
  <div class="meta"><code>${escapeHtml(detail.session.sessionKey)}</code> | state=${escapeHtml(detail.session.state)} | generatedAt=${escapeHtml(detail.generatedAt)}</div>

  <div class="card">
    <div>session=${escapeHtml(detail.session.sessionKey)} label=${escapeHtml(detail.session.label ?? "-")} agent=${escapeHtml(detail.session.agentId ?? "-")}</div>
    <div class="meta">lastMessageAt=${escapeHtml(detail.session.lastMessageAt ?? "-")} latestEvent=${escapeHtml(detail.latestKind ?? "-")} role=${escapeHtml(detail.latestRole ?? "-")} tool=${escapeHtml(detail.latestToolName ?? "-")} latestHistoryAt=${escapeHtml(detail.latestHistoryAt ?? "-")}</div>
    <div class="meta">historyCount=${detail.historyCount} historyLimit=readonly-safe</div>
    <div class="meta">historyError=${escapeHtml(detail.historyError ?? "none")}</div>
    <div class="meta">status model=${escapeHtml(status?.model ?? "-")} tokensIn=${status?.tokensIn ?? 0} tokensOut=${status?.tokensOut ?? 0} cost=${status?.cost ?? 0} updatedAt=${escapeHtml(status?.updatedAt ?? "-")}</div>
  </div>

  ${executionChainCard}

  <div class="card">
    <h2 style="font-size:15px;">${escapeHtml(t("Latest Messages / Tool Events", "最近消息 / 工具事件"))}</h2>
    <table>
      <thead><tr><th>${escapeHtml(t("timestamp", "时间"))}</th><th>${escapeHtml(t("kind", "类型"))}</th><th>${escapeHtml(t("role", "角色"))}</th><th>${escapeHtml(t("tool", "工具"))}</th><th>${escapeHtml(t("status", "状态"))}</th><th>${escapeHtml(t("content", "内容"))}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>

  <p class="meta"><a href="${escapeHtml(homeHref)}">${escapeHtml(t("Back to overview", "返回总览"))}</a> | <a href="/api/sessions/${encodeURIComponent(detail.session.sessionKey)}?historyLimit=120">${escapeHtml(t("Session JSON API", "会话 JSON 接口"))}</a></p>
</body>
</html>`;
}

export function renderSessionDrilldownPageForSmoke(
  detail: SessionConversationDetailResult,
  language: UiLanguage = "en",
): string {
  return renderSessionDrilldownPage(detail, language);
}

function renderSessionHistoryRows(items: SessionHistoryMessage[], language: UiLanguage = "en"): string {
  if (items.length === 0) {
    return `<tr><td colspan="6">${escapeHtml(pickUiText(language, "Not activated yet", "尚未激活"))}</td></tr>`;
  }

  const newestFirst = [...items].reverse().slice(0, 160);
  return newestFirst
    .map((item) => {
      const tool = item.toolName ?? "-";
      const status = item.toolStatus ?? "-";
      const refs = [
        item.parentSessionKey ? `parent=${item.parentSessionKey}` : "",
        item.childSessionKey ? `child=${item.childSessionKey}` : "",
      ]
        .filter(Boolean)
        .join(" | ");
      const content = refs ? `${safeTruncate(item.content, 620)}\n${refs}` : safeTruncate(item.content, 700);
      const suffix = item.truncated ? " [truncated]" : "";
      return `<tr><td>${escapeHtml(item.timestamp ?? "-")}</td><td>${badge(item.kind)}</td><td>${escapeHtml(item.role)}</td><td>${escapeHtml(tool)}</td><td>${escapeHtml(status)}</td><td class="cell-content">${escapeHtml(content + suffix)}</td></tr>`;
    })
    .join("");
}

function renderAuditPage(timeline: AuditTimelineSnapshot, severity: AuditSeverity | "all"): string {
  const rows =
    timeline.events.length === 0
      ? "<tr><td colspan=\"4\">Not activated yet</td></tr>"
      : timeline.events
          .slice(0, 300)
          .map(
            (event) =>
              `<tr><td>${escapeHtml(event.timestamp)}</td><td>${badge(event.severity)}</td><td>${escapeHtml(event.source)}</td><td>${escapeHtml(event.message)}</td></tr>`,
          )
          .join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>OpenClaw Control Center Audit Timeline</title>
  <style>
    body { font-family: "SF Mono", Menlo, monospace; background: #0b1016; color: #d6e7f9; padding: 16px; margin: 0; }
    a { color: #7dd3fc; }
    .card { border: 1px solid #27405a; background: #111923; padding: 12px; border-radius: 8px; margin-top: 10px; }
    .meta { color: #93aac2; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
    th, td { border-bottom: 1px solid rgba(39,64,90,0.45); text-align: left; padding: 6px; vertical-align: top; }
    th { color: #93aac2; }
    .badge { display:inline-block; border-radius:999px; padding:2px 8px; font-size:11px; border:1px solid transparent; text-transform:uppercase; letter-spacing:0.06em; }
    .badge.info { color: #3b82f6; border-color: #3b82f6; }
    .badge.warn { color: #f59e0b; border-color: #f59e0b; }
    .badge.action-required { color: #ef4444; border-color: #ef4444; }
    .badge.error { color: #f43f5e; border-color: #f43f5e; }
    label { color: #93aac2; font-size: 12px; margin-right: 8px; }
    select, button { background: #09141f; color: #d6e7f9; border: 1px solid #27405a; border-radius: 6px; padding: 6px; font-size: 12px; }
  </style>
</head>
<body>
  <h1>Audit Timeline</h1>
  <div class="meta">newest-first runtime events from snapshot, monitor timeline log, and approval action audit log</div>
  <div class="card">
    <form method="GET" action="/audit">
      <label for="severity">severity</label>
      <select id="severity" name="severity">
        ${renderSelectOptions(
          [
            { value: "all", label: "all" },
            { value: "info", label: "info" },
            { value: "warn", label: "warn" },
            { value: "action-required", label: "action-required" },
            { value: "error", label: "error" },
          ],
          severity,
        )}
      </select>
      <button type="submit">apply</button>
    </form>
    <div class="meta" style="margin-top:8px;">
      generatedAt=${escapeHtml(timeline.generatedAt)} | info=${timeline.counts.info} warn=${timeline.counts.warn} action_required=${timeline.counts["action-required"]} error=${timeline.counts.error}
    </div>
    <table>
      <thead><tr><th>timestamp</th><th>severity</th><th>source</th><th>message</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <p class="meta"><a href=\"/\">home</a> | <a href=\"/api/audit?severity=${encodeURIComponent(severity)}\">audit api</a></p>
</body>
</html>`;
}

export function renderAuditPageForSmoke(
  timeline: AuditTimelineSnapshot,
  severity: AuditSeverity | "all",
): string {
  return renderAuditPage(timeline, severity);
}

function renderTaskDetailPage(input: {
  task: TaskListItem;
  generatedAt: string;
  certaintyCard?: TaskCertaintyCard;
  linkedSessions?: TaskDetailSessionSignal[];
  language?: UiLanguage;
}): string {
  const language = input.language ?? "zh";
  const task = input.task;
  const certaintyCard = input.certaintyCard;
  const linkedSessions = input.linkedSessions ?? [];
  const t = (en: string, zh: string): string => pickUiText(language, en, zh);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(t("Task detail", "任务详情"))} · ${escapeHtml(task.taskId)}</title>
  <style>
    body { font-family: "SF Pro Text", -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; margin:0; padding:20px; background:#f5f5f7; color:#1d1d1f; }
    .page { max-width: 860px; margin: 0 auto; display:grid; gap:12px; }
    .card { border:1px solid rgba(17,24,39,0.1); border-radius:16px; background:#fff; padding:14px; box-shadow:0 8px 20px rgba(17,24,39,0.06); }
    .meta { color:#6e6e73; font-size:13px; line-height:1.6; }
    h1 { margin:0; font-size:30px; letter-spacing:-0.02em; }
    h2 { margin:0; font-size:18px; }
    .badge { display:inline-block; border-radius:999px; padding:3px 10px; font-size:12px; border:1px solid rgba(17,24,39,0.14); background:#f7f8fb; }
    a { color:#0068d3; }
    code { font-size:12px; color:#005ab6; }
    .story-list { margin:0; padding-left:18px; display:grid; gap:8px; }
  </style>
</head>
<body>
  <div class="page">
    <div class="card">
      <h1>${escapeHtml(task.title)}</h1>
      <div class="meta">${escapeHtml(t("Task detail page", "任务详情页"))} · ${escapeHtml(t("Generated at", "生成于"))} ${escapeHtml(input.generatedAt)}</div>
    </div>
    <div class="card">
      <h2>${escapeHtml(t("Key facts", "关键信息"))}</h2>
      <div class="meta"><code>${escapeHtml(task.taskId)}</code> ${badge(task.status, taskStateLabel(task.status, language))}</div>
      <div class="meta">${escapeHtml(t("Project", "项目"))}：${escapeHtml(task.projectTitle)}（${escapeHtml(task.projectId)}）</div>
      <div class="meta">${escapeHtml(t("Owner", "负责人"))}：${escapeHtml(task.owner)}</div>
      <div class="meta">${escapeHtml(t("Due time", "截止时间"))}：${escapeHtml(task.dueAt ?? t("Not set", "未设置"))}</div>
      <div class="meta">${escapeHtml(t("Updated at", "更新时间"))}：${escapeHtml(task.updatedAt)}</div>
      <div class="meta">${escapeHtml(t("Sessions", "会话"))}：${task.sessionKeys.length > 0 ? task.sessionKeys.map((id) => `<a href="${escapeHtml(buildSessionDetailHref(id, language))}"><code>${escapeHtml(id)}</code></a>`).join(" · ") : escapeHtml(t("None yet", "暂无"))}</div>
    </div>
    <div class="card">
      <h2>${escapeHtml(t("Execution certainty", "确定性判断"))}</h2>
      ${
        certaintyCard
          ? `<div class="meta">${badge(certaintyCard.tone, certaintyCard.toneLabel)} · ${certaintyCard.score} ${escapeHtml(t("points", "分"))}</div>
             <div class="meta">${escapeHtml(certaintyCard.summary)}</div>
             <div class="meta">${escapeHtml(t("Confirmed", "已确认"))}：${escapeHtml(certaintyCard.evidence.join(" · ") || t("No direct evidence yet.", "暂时没有直接证据。"))}</div>
             <div class="meta">${escapeHtml(t("Still missing", "仍待确认"))}：${escapeHtml(certaintyCard.gaps.join(" · ") || t("No obvious gap right now.", "当前没有明显缺口。"))}</div>`
          : `<div class="meta">${escapeHtml(t("There is not enough data to judge execution certainty yet.", "当前没有足够数据生成确定性判断。"))}</div>`
      }
    </div>
    <div class="card">
      <h2>${escapeHtml(t("Session evidence", "会话证据"))}</h2>
      ${
        linkedSessions.length > 0
          ? `<ul class="story-list">${linkedSessions
              .map(
                (session) =>
                  `<li><a href="${escapeHtml(session.sessionHref)}"><code>${escapeHtml(session.sessionKey)}</code></a> ${badge(session.state, sessionStateLabel(session.state))}<div class="meta">${escapeHtml(pickUiText(language, "Agent", "智能体"))}：${escapeHtml(session.agentId ?? pickUiText(language, "Unassigned", "未分配"))} · ${escapeHtml(pickUiText(language, "Latest activity", "最近活动"))}：${escapeHtml(session.latestAt ? formatTimeAgoFromNow(session.latestAt, language) : pickUiText(language, "unknown", "未知"))}</div><div class="meta">${escapeHtml(summarizeVisibleSessionSnippet(session.latestSnippet, language, 120))}</div></li>`,
              )
              .join("")}</ul>`
          : `<div class="meta">${escapeHtml(pickUiText(language, "No session evidence is visible yet.", "当前还没有可显示的会话证据。"))}</div>`
      }
    </div>
    <div class="meta"><a href="${escapeHtml(buildHomeHref({ quick: "all" }, true, "projects-tasks", language))}#tracked-task-view">${escapeHtml(pickUiText(language, "Back to tracked tasks", "返回跟踪任务"))}</a></div>
  </div>
</body>
</html>`;
}

function renderCronJobDetailPage(
  job: {
    jobId: string;
    name: string;
    owner: string;
    purpose: string;
    schedule: string;
    status: string;
    nextRunAt: string;
    dueInSeconds?: number;
  },
  generatedAt: string,
  language: UiLanguage = "zh",
): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(pickUiText(language, "Cron detail", "Cron 详情"))} · ${escapeHtml(job.jobId)}</title>
  <style>
    body { font-family: "SF Pro Text", -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; margin:0; padding:20px; background:#f5f5f7; color:#1d1d1f; }
    .page { max-width: 860px; margin: 0 auto; display:grid; gap:12px; }
    .card { border:1px solid rgba(17,24,39,0.1); border-radius:16px; background:#fff; padding:14px; box-shadow:0 8px 20px rgba(17,24,39,0.06); }
    .meta { color:#6e6e73; font-size:13px; line-height:1.6; }
    h1 { margin:0; font-size:30px; letter-spacing:-0.02em; }
    h2 { margin:0; font-size:18px; }
    .badge { display:inline-block; border-radius:999px; padding:3px 10px; font-size:12px; border:1px solid rgba(17,24,39,0.14); background:#f7f8fb; }
    a { color:#0068d3; }
    code { font-size:12px; color:#005ab6; }
  </style>
</head>
<body>
  <div class="page">
    <div class="card">
      <h1>${escapeHtml(job.name)}</h1>
      <div class="meta">${escapeHtml(pickUiText(language, "Cron detail page", "Cron 任务详情页"))} · ${escapeHtml(pickUiText(language, "Generated at", "生成于"))} ${escapeHtml(generatedAt)}</div>
    </div>
    <div class="card">
      <h2>${escapeHtml(pickUiText(language, "Key facts", "关键信息"))}</h2>
      <div class="meta"><code>${escapeHtml(job.jobId)}</code> ${badge(job.status, cronHealthLabel(job.status, language))}</div>
      <div class="meta">${escapeHtml(pickUiText(language, "Agent", "执行智能体"))}：${escapeHtml(job.owner)}</div>
      <div class="meta">${escapeHtml(pickUiText(language, "Purpose", "任务目的"))}：${escapeHtml(job.purpose)}</div>
      <div class="meta">${escapeHtml(pickUiText(language, "Schedule", "调度"))}：${escapeHtml(job.schedule)}</div>
      <div class="meta">${escapeHtml(pickUiText(language, "Next run", "下次运行"))}：${escapeHtml(job.nextRunAt)} · ${escapeHtml(formatSeconds(job.dueInSeconds, language))}</div>
    </div>
    <div class="meta"><a href="${escapeHtml(buildHomeHref({ quick: "all" }, true, "overview", language))}#cron-health">${escapeHtml(pickUiText(language, "Back to cron board", "返回 Cron 看板"))}</a></div>
  </div>
</body>
</html>`;
}

function buildBudgetBars(
  evaluations: BudgetEvaluation[],
  scope: "agent" | "project",
): BudgetBarModel[] {
  return evaluations
    .filter((item) => item.scope === scope)
    .map((item) => {
      const metric = pickPrimaryMetric(item.metrics);
      if (!metric) {
        return {
          label: item.label,
          status: item.status,
          metric: "n/a",
          used: 0,
          limit: 0,
          ratio: 0,
        };
      }

      return {
        label: item.label,
        status: item.status,
        metric: metric.metric,
        used: metric.used,
        limit: metric.limit,
        ratio: metric.limit > 0 ? metric.used / metric.limit : 0,
      };
    });
}

function pickPrimaryMetric(metrics: BudgetMetricEvaluation[]): BudgetMetricEvaluation | undefined {
  return metrics.find((metric) => metric.metric === "totalTokens") ?? metrics[0];
}

function renderBudgetBars(items: BudgetBarModel[]): string {
  if (items.length === 0) return "<div class=\"meta\">暂无数据</div>";

  return items
    .map((item) => {
      const width = Math.max(0, Math.min(100, Math.round(item.ratio * 100)));
      return `<div class="bar-row"><div class="bar-meta"><span>${escapeHtml(item.label)}</span><span>${escapeHtml(item.metric)} ${item.used.toFixed(2)}/${item.limit.toFixed(2)}</span></div><div class="bar-track"><div class="bar-fill ${escapeHtml(item.status)}" style="width:${width}%"></div></div></div>`;
    })
    .join("");
}

function renderSelectOptions(
  options: Array<{ value: string; label: string }>,
  selectedValue: string,
): string {
  return options
    .map((option) => {
      const selected = option.value === selectedValue ? " selected" : "";
      return `<option value="${escapeHtml(option.value)}"${selected}>${escapeHtml(option.label)}</option>`;
    })
    .join("");
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))].sort((a, b) => a.localeCompare(b));
}

function renderExceptionsList(feed: CommanderExceptionsFeed): string {
  const top = feed.items.slice(0, 12);
  if (top.length === 0) return "<li>暂无异常</li>";

  return top
    .map(
      (item) =>
        `<li>${badge(item.level)} <strong>${escapeHtml(item.message)}</strong> <span class="meta-inline">${escapeHtml(item.sourceId)} · ${escapeHtml(item.occurredAt ?? "-")}</span></li>`,
    )
    .join("");
}

function renderReadinessRows(checklist: DoneChecklistSnapshot): string {
  return checklist.readiness.categories
    .map((item) => {
      return `<div class="readiness-chip"><div class="label">${escapeHtml(item.category)}</div><div class="score">${item.score}</div><div class="meta">通过=${item.passed} 关注=${item.warn} 失败=${item.failed}</div></div>`;
    })
    .join("");
}

function renderChecklistRows(checklist: DoneChecklistSnapshot): string {
  const top = checklist.items.slice(0, 16);
  if (top.length === 0) {
    return "<tr><td colspan=\"5\">暂无检查项</td></tr>";
  }
  return top
    .map((item) => {
      return `<tr><td>${escapeHtml(item.category)}</td><td>${escapeHtml(item.title)}</td><td>${badge(item.status)}</td><td>${escapeHtml(item.detail)}</td><td>${linkifyDocRef(item.docRef)}</td></tr>`;
    })
    .join("");
}

function resolveDocPath(docId: string): string | undefined {
  const normalized = docId.trim().toLowerCase();
  if (normalized === "readme") return README_PATH;
  if (normalized === "runbook") return join(DOCS_DIR, "RUNBOOK.md");
  if (normalized === "architecture") return join(DOCS_DIR, "ARCHITECTURE.md");
  if (normalized === "progress") return join(DOCS_DIR, "PROGRESS.md");
  return undefined;
}

function linkifyDocRef(docRef: string): string {
  let linked = escapeHtml(docRef);
  for (const link of DOC_LINKS) {
    const escapedLabel = escapeHtml(link.label);
    linked = linked.replaceAll(escapedLabel, `<a href="${link.href}">${escapedLabel}</a>`);
  }
  return linked;
}

function compareApprovals(
  a: ReadModelSnapshot["approvals"][number],
  b: ReadModelSnapshot["approvals"][number],
): number {
  const statusDiff = approvalStatusRank(a.status) - approvalStatusRank(b.status);
  if (statusDiff !== 0) return statusDiff;
  const timeDiff = toSortableMs(b.updatedAt ?? b.requestedAt) - toSortableMs(a.updatedAt ?? a.requestedAt);
  if (timeDiff !== 0) return timeDiff;
  return a.approvalId.localeCompare(b.approvalId);
}

function approvalStatusRank(status: string | undefined): number {
  if (status === "pending") return 0;
  if (status === "unknown") return 1;
  if (status === "denied") return 2;
  if (status === "approved") return 3;
  return 4;
}

function toSortableMs(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function renderMetricSummary(item: BudgetEvaluation): string {
  if (!Array.isArray(item.metrics) || item.metrics.length === 0) return "-";
  return item.metrics
    .map((metric) => `${escapeHtml(metric.metric)} ${metric.used.toFixed(2)}/${metric.limit.toFixed(2)}`)
    .join(", ");
}

function formatSeconds(value: number | undefined, language: UiLanguage = "en"): string {
  if (!Number.isFinite(value)) return "-";
  const seconds = Math.round(value as number);
  if (seconds === 0) return language === "zh" ? "现在" : "now";
  const abs = Math.abs(seconds);
  const sign = seconds < 0 ? "-" : "";
  if (language === "zh") {
    if (abs < 60) return `${sign}${abs}秒`;
    const minutes = Math.floor(abs / 60);
    const rem = abs % 60;
    if (minutes < 60) return rem === 0 ? `${sign}${minutes}分` : `${sign}${minutes}分${rem}秒`;
    const hours = Math.floor(minutes / 60);
    const remMinutes = minutes % 60;
    return remMinutes === 0 ? `${sign}${hours}小时` : `${sign}${hours}小时${remMinutes}分`;
  }
  if (abs < 60) return `${sign}${abs}s`;
  const minutes = Math.floor(abs / 60);
  const rem = abs % 60;
  if (minutes < 60) return `${sign}${minutes}m ${rem}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${sign}${hours}h ${remMinutes}m`;
}

function formatMs(value: number | undefined, language: UiLanguage = "en"): string {
  if (!Number.isFinite(value)) return "-";
  return formatSeconds(Math.round((value as number) / 1000), language);
}

function badge(status: string, label?: string): string {
  const safeStatus = escapeHtml(status);
  const safeLabel = escapeHtml(label ?? status);
  return `<span class="badge ${safeStatus}">${safeLabel}</span>`;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const text = await readRawBody(req, JSON_MAX_BYTES);
  if (!text) return {};

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RequestValidationError("Invalid JSON body.", 400);
  }
}

async function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  const text = await readRawBody(req, FORM_MAX_BYTES);
  return new URLSearchParams(text);
}

async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new RequestValidationError("Request payload too large.", 413);
    chunks.push(buffer);
  }

  if (chunks.length === 0) return "";
  return Buffer.concat(chunks).toString("utf8").trim();
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  writeText(
    res,
    statusCode,
    JSON.stringify(attachRequestIdToBody(body, responseRequestId(res)), null, 2),
    "application/json; charset=utf-8",
  );
}

function writeApiError(
  res: ServerResponse,
  statusCode: number,
  code: "VALIDATION_ERROR" | "NOT_FOUND" | "UNSUPPORTED_MEDIA_TYPE" | "INTERNAL_ERROR",
  message: string,
  issues?: string[],
): void {
  const requestId = responseRequestId(res);
  writeJson(res, statusCode, {
    ok: false,
    requestId,
    error: {
      code,
      status: statusCode,
      message,
      issues,
      requestId,
    },
  });
}

function writeText(
  res: ServerResponse,
  statusCode: number,
  body: string,
  contentType: string,
): void {
  const headers: Record<string, string> = { "content-type": contentType };
  const normalizedContentType = contentType.toLowerCase();
  if (normalizedContentType.includes("text/html")) {
    headers["cache-control"] = "no-store, no-cache, must-revalidate, max-age=0";
    headers.pragma = "no-cache";
    headers.expires = "0";
  }
  const requestId = responseRequestId(res);
  if (requestId) {
    headers["x-request-id"] = requestId;
  }
  res.writeHead(statusCode, headers);
  res.end(body);
}

function redirect(res: ServerResponse, statusCode: number, location: string): void {
  const headers: Record<string, string> = { location };
  const requestId = responseRequestId(res);
  if (requestId) headers["x-request-id"] = requestId;
  res.writeHead(statusCode, headers);
  res.end();
}

function resolveRequestId(req: IncomingMessage): string {
  const headerValue = req.headers["x-request-id"];
  if (typeof headerValue === "string") {
    const normalized = sanitizeRequestId(headerValue);
    if (normalized) return normalized;
  }
  if (Array.isArray(headerValue)) {
    for (const candidate of headerValue) {
      const normalized = sanitizeRequestId(candidate);
      if (normalized) return normalized;
    }
  }
  return randomUUID();
}

function sanitizeRequestId(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 80) return undefined;
  if (!/^[a-zA-Z0-9._:-]+$/.test(trimmed)) return undefined;
  return trimmed;
}

function responseRequestId(res: ServerResponse): string | undefined {
  const value = res.getHeader("x-request-id");
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function attachRequestIdToBody(body: unknown, requestId: string | undefined): unknown {
  if (!requestId) return body;
  const obj = asObject(body);
  if (!obj) return body;
  if (typeof obj.requestId === "string" && obj.requestId.trim() !== "") return body;
  return {
    requestId,
    ...obj,
  };
}

function assertMutationAuthorized(
  req: IncomingMessage,
  routeLabel: string,
  explicitToken?: string | null,
): void {
  const token =
    normalizeToken(explicitToken) ??
    normalizeToken(readHeaderValue(req, LOCAL_TOKEN_HEADER)) ??
    normalizeToken(readAuthorizationBearer(readHeaderValue(req, "authorization")));
  const decision = evaluateLocalTokenGate({
    gateRequired: LOCAL_TOKEN_AUTH_REQUIRED,
    configuredToken: LOCAL_API_TOKEN,
    providedToken: token,
    routeLabel,
  });
  if (!decision.ok) {
    throw new RequestValidationError(decision.message, decision.statusCode);
  }
}

function readHeaderValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function assertJsonContentType(req: IncomingMessage): void {
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().includes("application/json")) {
    throw new RequestValidationError(
      "JSON request body must use 'Content-Type: application/json'.",
      415,
    );
  }
}

function assertAllowedQueryParams(
  searchParams: URLSearchParams,
  allowed: string[],
  strict: boolean,
): void {
  if (!strict) return;
  const allowedSet = new Set(allowed);
  const unknown = [...new Set([...searchParams.keys()].filter((key) => !allowedSet.has(key)))];
  if (unknown.length === 0) return;
  throw new RequestValidationError(
    `Unknown query parameter(s): ${unknown.join(", ")}`,
    400,
    unknown.map((key) => `query '${key}' is not supported`),
  );
}

function expectObject(input: unknown, label: string): Record<string, unknown> {
  const obj = asObject(input);
  if (!obj) throw new RequestValidationError(`${label} must be a JSON object.`, 400);
  return obj;
}

function decodeRouteParam(path: string, pattern: RegExp, label: string): string {
  const match = path.match(pattern);
  if (!match) throw new RequestValidationError(`${label} route parameter is required.`, 400);

  try {
    const decoded = decodeURIComponent(match[1]).trim();
    if (!decoded) throw new Error("empty");
    if (decoded.length > 240) {
      throw new RequestValidationError(`${label} route parameter must be <= 240 characters.`, 400);
    }
    if (/[\u0000-\u001F\u007F]/.test(decoded)) {
      throw new RequestValidationError(`${label} route parameter contains invalid control characters.`, 400);
    }
    return decoded;
  } catch (error) {
    if (error instanceof RequestValidationError) throw error;
    throw new RequestValidationError(`${label} route parameter is invalid.`, 400);
  }
}

function normalizeQueryString(
  value: string | null,
  label: string,
  maxLength: number,
  strict: boolean,
): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (/[\u0000-\u001F\u007F]/.test(trimmed)) {
    if (strict) throw new RequestValidationError(`${label} contains invalid control characters`, 400);
    return undefined;
  }

  if (trimmed.length > maxLength) {
    if (strict) throw new RequestValidationError(`${label} must be <= ${maxLength} characters`, 400);
    return undefined;
  }

  return trimmed;
}

function readPositiveIntQuery(
  value: string | null,
  label: string,
  fallback: number,
  strict: boolean,
  maxValue = 1000,
): number {
  if (!value) return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > maxValue) {
    if (strict) throw new RequestValidationError(`${label} must be an integer in range 1..${maxValue}`, 400);
    return fallback;
  }
  return parsed;
}

function readRequiredFormValue(form: URLSearchParams, key: string): string {
  const raw = form.get(key)?.trim();
  if (!raw) throw new RequestValidationError(`${key} is required.`, 400);
  if (raw.length > 260) throw new RequestValidationError(`${key} must be <= 260 characters.`, 400);
  return raw;
}

function requiredBoundedString(input: unknown, label: string, maxLength: number): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new RequestValidationError(`${label} is required.`, 400);
  }
  const trimmed = input.trim();
  if (trimmed.length > maxLength) {
    throw new RequestValidationError(`${label} must be <= ${maxLength} characters`, 400);
  }
  return trimmed;
}

function optionalBoundedString(
  input: unknown,
  label: string,
  maxLength: number,
): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "string") {
    throw new RequestValidationError(`${label} must be a string`, 400);
  }
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) {
    throw new RequestValidationError(`${label} must be <= ${maxLength} characters`, 400);
  }
  return trimmed;
}

function boundedTextField(input: unknown, label: string, maxLength: number): string {
  if (typeof input !== "string") {
    throw new RequestValidationError(`${label} must be a string`, 400);
  }
  if (input.length > maxLength) {
    throw new RequestValidationError(`${label} must be <= ${maxLength} characters`, 400);
  }
  return input;
}

function optionalIntegerField(
  input: unknown,
  label: string,
  min: number,
  max: number,
): number | undefined {
  if (input === undefined || input === null || input === "") return undefined;
  if (typeof input !== "number" || !Number.isInteger(input)) {
    throw new RequestValidationError(`${label} must be an integer.`, 400);
  }
  if (input < min || input > max) {
    throw new RequestValidationError(`${label} must be in range ${min}..${max}.`, 400);
  }
  return input;
}

function optionalIsoTimestampField(input: unknown, label: string): string | undefined {
  if (input === undefined || input === null || input === "") return undefined;
  if (typeof input !== "string") {
    throw new RequestValidationError(`${label} must be an ISO date-time string.`, 400);
  }
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 80) {
    throw new RequestValidationError(`${label} must be <= 80 characters.`, 400);
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new RequestValidationError(`${label} must be a valid ISO date-time string.`, 400);
  }
  return new Date(parsed).toISOString();
}

function safeTruncate(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input;
  if (maxLength <= 3) return input.slice(0, Math.max(0, maxLength));
  return `${input.slice(0, maxLength - 3)}...`;
}

function projectTitleMap(snapshot: ReadModelSnapshot): Map<string, string> {
  return new Map(snapshot.projects.projects.map((project) => [project.projectId, project.title]));
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function defaultSnapshot(): ReadModelSnapshot {
  const now = new Date().toISOString();
  return {
    sessions: [],
    statuses: [],
    cronJobs: [],
    approvals: [],
    projects: { projects: [], updatedAt: now },
    projectSummaries: [],
    tasks: { tasks: [], agentBudgets: [], updatedAt: now },
    tasksSummary: {
      projects: 0,
      tasks: 0,
      todo: 0,
      inProgress: 0,
      blocked: 0,
      done: 0,
      owners: 0,
      artifacts: 0,
    },
    budgetSummary: { total: 0, ok: 0, warn: 0, over: 0, evaluations: [] },
    generatedAt: now,
  };
}

class RequestValidationError extends Error {
  readonly issues?: string[];

  constructor(
    message: string,
    readonly statusCode: number,
    issues?: string[],
  ) {
    super(message);
    this.name = "RequestValidationError";
    this.issues = issues;
  }
}

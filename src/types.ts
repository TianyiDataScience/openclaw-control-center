export type AgentRunState = "idle" | "running" | "blocked" | "waiting_approval" | "error";

export interface SessionSummary {
  sessionKey: string;
  label?: string;
  agentId?: string;
  state: AgentRunState;
  lastMessageAt?: string;
}

export interface SessionStatusSnapshot {
  sessionKey: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  updatedAt: string;
}

export interface CronJobSummary {
  jobId: string;
  name?: string;
  enabled: boolean;
  nextRunAt?: string;
}

export type ApprovalState = "pending" | "approved" | "denied" | "unknown";

export interface ApprovalSummary {
  approvalId: string;
  sessionKey?: string;
  agentId?: string;
  status: ApprovalState;
  decision?: string;
  command?: string;
  reason?: string;
  requestedAt?: string;
  updatedAt?: string;
}

export type TaskState = "todo" | "in_progress" | "blocked" | "done";
export type ProjectState = "planned" | "active" | "blocked" | "done";

export type TaskArtifactType = "code" | "doc" | "link" | "other";

export interface TaskArtifact {
  artifactId: string;
  type: TaskArtifactType;
  label: string;
  location: string;
}

export interface RollbackPlan {
  strategy: string;
  steps: string[];
  verification?: string;
}

export interface BudgetThresholds {
  tokensIn?: number;
  tokensOut?: number;
  totalTokens?: number;
  cost?: number;
  warnRatio?: number;
}

export interface ProjectTask {
  projectId: string;
  taskId: string;
  title: string;
  status: TaskState;
  owner: string;
  dueAt?: string;
  definitionOfDone: string[];
  artifacts: TaskArtifact[];
  rollback: RollbackPlan;
  sessionKeys: string[];
  budget: BudgetThresholds;
  updatedAt: string;
}

export interface ProjectRecord {
  projectId: string;
  title: string;
  status: ProjectState;
  owner: string;
  budget: BudgetThresholds;
  updatedAt: string;
}

export interface ProjectStoreSnapshot {
  projects: ProjectRecord[];
  updatedAt: string;
}

export interface AgentBudgetPlan {
  agentId: string;
  label?: string;
  thresholds: BudgetThresholds;
}

export interface TaskStoreSnapshot {
  tasks: ProjectTask[];
  agentBudgets: AgentBudgetPlan[];
  updatedAt: string;
}

export interface TasksSummary {
  projects: number;
  tasks: number;
  todo: number;
  inProgress: number;
  blocked: number;
  done: number;
  owners: number;
  artifacts: number;
}

export interface ProjectSummary {
  projectId: string;
  title: string;
  status: ProjectState;
  owner: string;
  totalTasks: number;
  todo: number;
  inProgress: number;
  blocked: number;
  done: number;
  due: number;
  updatedAt: string;
}

export type BudgetStatus = "ok" | "warn" | "over";
export type BudgetScope = "agent" | "project" | "task";

export interface BudgetUsageSnapshot {
  tokensIn: number;
  tokensOut: number;
  totalTokens: number;
  cost: number;
}

export interface BudgetMetricEvaluation {
  metric: "tokensIn" | "tokensOut" | "totalTokens" | "cost";
  used: number;
  limit: number;
  warnAt: number;
  status: BudgetStatus;
}

export interface BudgetEvaluation {
  scope: BudgetScope;
  scopeId: string;
  label: string;
  thresholds: BudgetThresholds;
  usage: BudgetUsageSnapshot;
  metrics: BudgetMetricEvaluation[];
  status: BudgetStatus;
}

export interface BudgetSummary {
  total: number;
  ok: number;
  warn: number;
  over: number;
  evaluations: BudgetEvaluation[];
}

export interface BudgetPolicyConfig {
  defaults: BudgetThresholds;
  agent: Record<string, BudgetThresholds>;
  project: Record<string, BudgetThresholds>;
  task: Record<string, BudgetThresholds>;
}

export interface SubagentTreeStats {
  totalNodes: number;
  activeNodes: number;
  idleNodes: number;
  errorNodes: number;
  blockedNodes: number;
  totalCost: number;
  totalTokens: number;
  maxDepth: number;
}

export interface ReadModelSnapshot {
  sessions: SessionSummary[];
  statuses: SessionStatusSnapshot[];
  cronJobs: CronJobSummary[];
  approvals: ApprovalSummary[];
  projects: ProjectStoreSnapshot;
  projectSummaries: ProjectSummary[];
  tasks: TaskStoreSnapshot;
  tasksSummary: TasksSummary;
  budgetSummary: BudgetSummary;
  subagentStats?: SubagentTreeStats;
  generatedAt: string;
}

export interface TaskListItem {
  projectId: string;
  projectTitle: string;
  taskId: string;
  title: string;
  status: TaskState;
  owner: string;
  dueAt?: string;
  sessionKeys: string[];
  updatedAt: string;
}

export interface CommanderExceptionsSummary {
  generatedAt: string;
  blocked: SessionSummary[];
  errors: SessionSummary[];
  pendingApprovals: ApprovalSummary[];
  overBudget: BudgetEvaluation[];
  tasksDue: TaskListItem[];
  counts: {
    blocked: number;
    errors: number;
    pendingApprovals: number;
    overBudget: number;
    tasksDue: number;
  };
}

export type AlertLevel = "info" | "warn" | "action-required";

export interface ExceptionFeedItem {
  level: AlertLevel;
  code:
    | "NO_SESSIONS"
    | "SESSION_BLOCKED"
    | "SESSION_ERROR"
    | "PENDING_APPROVAL"
    | "OVER_BUDGET"
    | "TASK_DUE"
    | "SUBAGENT_ERROR"
    | "SUBAGENT_DEEP_CHAIN";
  source: "system" | "session" | "approval" | "budget" | "task" | "subagent";
  sourceId: string;
  message: string;
  route: "timeline" | "operator-watch" | "action-queue";
  occurredAt?: string;
}

export interface CommanderExceptionsFeed {
  generatedAt: string;
  items: ExceptionFeedItem[];
  counts: {
    info: number;
    warn: number;
    actionRequired: number;
  };
}

export interface NotificationAck {
  itemId: string;
  ackedAt: string;
  note?: string;
  expiresAt?: string;
}

export interface AcksStoreSnapshot {
  acks: NotificationAck[];
  updatedAt: string;
}

export interface ActionQueueItem extends ExceptionFeedItem {
  itemId: string;
  acknowledged: boolean;
  ackedAt?: string;
  note?: string;
  ackExpiresAt?: string;
  links: ActionQueueLink[];
}

export interface ActionQueueLink {
  type: "session" | "task" | "project";
  id: string;
  href: string;
  label: string;
}

export interface NotificationCenterSnapshot {
  generatedAt: string;
  queue: ActionQueueItem[];
  counts: {
    total: number;
    acked: number;
    unacked: number;
  };
}

export type ChecklistStatus = "pass" | "warn" | "fail";
export type ReadinessCategory = "observability" | "governance" | "collaboration" | "security";

export interface ReadinessCategoryScore {
  category: ReadinessCategory;
  score: number;
  passed: number;
  warn: number;
  failed: number;
  total: number;
}

export interface ReadinessScoreSnapshot {
  overall: number;
  categories: ReadinessCategoryScore[];
}

export interface DoneChecklistItem {
  id: string;
  category: ReadinessCategory;
  title: string;
  docRef: string;
  status: ChecklistStatus;
  detail: string;
}

export interface DoneChecklistSnapshot {
  generatedAt: string;
  basedOn: string[];
  items: DoneChecklistItem[];
  counts: {
    pass: number;
    warn: number;
    fail: number;
  };
  readiness: ReadinessScoreSnapshot;
}

export interface ExportBundle {
  ok: true;
  schemaVersion: "phase-9";
  source: "api" | "command";
  requestId?: string;
  exportedAt: string;
  snapshotGeneratedAt: string;
  sessions: SessionSummary[];
  projects: ProjectStoreSnapshot;
  tasks: TaskStoreSnapshot;
  budgets: {
    policy: BudgetPolicyConfig;
    issues: string[];
    summary: BudgetSummary;
  };
  exceptions: CommanderExceptionsSummary;
  exceptionsFeed: CommanderExceptionsFeed;
}

export interface ImportDryRunSummary {
  sessions: number;
  projects: number;
  tasks: number;
  exceptions: number;
}

export interface ImportDryRunResult {
  validatedAt: string;
  source: string;
  valid: boolean;
  issues: string[];
  warnings: string[];
  summary: ImportDryRunSummary;
}

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
export type RoomStage = "intake" | "discussion" | "assigned" | "executing" | "review" | "completed";
export type MessageKind = "chat" | "proposal" | "decision" | "handoff" | "status" | "result";
export type RoomParticipantRole = "human" | "planner" | "coder" | "reviewer" | "manager";
export type HallSemanticRole = "planner" | "coder" | "reviewer" | "manager" | "generalist";
export type HallTaskStage = "discussion" | "execution" | "review" | "blocked" | "completed";
export type HallMessageKind =
  | "chat"
  | "task"
  | "proposal"
  | "decision"
  | "handoff"
  | "status"
  | "review"
  | "result"
  | "system";

export type TaskArtifactType = "code" | "doc" | "link" | "file" | "other";

export interface TaskArtifact {
  artifactId: string;
  type: TaskArtifactType;
  label: string;
  location: string;
}

export interface HallFileAttachment {
  fileId: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  storedFileName: string;
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
  roomId?: string;
  dueAt?: string;
  definitionOfDone: string[];
  artifacts: TaskArtifact[];
  rollback: RollbackPlan;
  sessionKeys: string[];
  budget: BudgetThresholds;
  updatedAt: string;
}

export interface RoomParticipant {
  participantId: string;
  role: RoomParticipantRole;
  label: string;
  agentId?: string;
  sessionKey?: string;
  active: boolean;
}

export interface HandoffRecord {
  handoffId: string;
  roomId: string;
  taskId: string;
  fromRole: RoomParticipantRole;
  toRole: RoomParticipantRole;
  note?: string;
  createdAt: string;
}

export interface ChatMessagePayload {
  proposal?: string;
  decision?: string;
  executor?: RoomParticipantRole;
  doneWhen?: string;
  fromRole?: RoomParticipantRole;
  targetRole?: RoomParticipantRole;
  handoffId?: string;
  status?: string;
  taskStatus?: TaskState;
  reviewOutcome?: "approved" | "rejected";
  sessionKey?: string;
  sourceSessionKey?: string;
  sourceTool?: string;
}

export interface ChatMessage {
  roomId: string;
  messageId: string;
  kind: MessageKind;
  authorRole: RoomParticipantRole;
  authorLabel: string;
  participantId?: string;
  content: string;
  mentions: RoomParticipantRole[];
  sessionKey?: string;
  payload?: ChatMessagePayload;
  createdAt: string;
}

export interface ChatRoomSummary {
  roomId: string;
  headline: string;
  latestDecision?: string;
  currentOwner?: RoomParticipantRole;
  nextAction: string;
  openQuestions: string[];
  messageCount: number;
  updatedAt: string;
}

export interface ChatRoom {
  roomId: string;
  projectId: string;
  taskId: string;
  title: string;
  stage: RoomStage;
  ownerRole: RoomParticipantRole;
  assignedExecutor?: RoomParticipantRole;
  proposal?: string;
  decision?: string;
  doneWhen?: string;
  participants: RoomParticipant[];
  handoffs: HandoffRecord[];
  sessionKeys: string[];
  summaryId?: string;
  lastMessageAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatRoomStoreSnapshot {
  rooms: ChatRoom[];
  updatedAt: string;
}

export interface ChatMessageStoreSnapshot {
  messages: ChatMessage[];
  updatedAt: string;
}

export interface ChatSummaryStoreSnapshot {
  summaries: ChatRoomSummary[];
  updatedAt: string;
}

export interface MentionTarget {
  raw: string;
  participantId: string;
  displayName: string;
  semanticRole: HallSemanticRole;
}

export interface ExecutionLock {
  taskId: string;
  projectId: string;
  ownerParticipantId: string;
  ownerLabel: string;
  acquiredAt: string;
  releasedAt?: string;
  releasedReason?: string;
}

export interface StructuredHandoffPacket {
  goal: string;
  currentResult: string;
  doneWhen: string;
  blockers: string[];
  nextOwner: string;
  requiresInputFrom: string[];
  artifactRefs?: TaskArtifact[];
}

export interface HallParticipant {
  participantId: string;
  agentId?: string;
  displayName: string;
  semanticRole: HallSemanticRole;
  active: boolean;
  aliases: string[];
  isHuman?: boolean;
}

export interface TaskDiscussionCycle {
  cycleId: string;
  openedAt: string;
  openedByParticipantId: string;
  expectedParticipantIds: string[];
  completedParticipantIds: string[];
  closedAt?: string;
}

export interface HallMessagePayload {
  projectId?: string;
  taskId?: string;
  taskCardId?: string;
  roomId?: string;
  proposal?: string;
  decision?: string;
  doneWhen?: string;
  executionOrder?: string[];
  executionItems?: HallExecutionItem[];
  nextOwnerParticipantId?: string;
  reviewOutcome?: "approved" | "rejected";
  taskStatus?: TaskState;
  taskStage?: HallTaskStage;
  status?: string;
  handoff?: StructuredHandoffPacket;
  artifactRefs?: TaskArtifact[];
  fileAttachments?: HallFileAttachment[];
  toolCalls?: Array<{ toolName: string; toolStatus: string; detail?: string }>;
  sessionKey?: string;
  sourceSessionKey?: string;
  sourceTool?: string;
}

export interface HallMessage {
  hallId: string;
  messageId: string;
  kind: HallMessageKind;
  authorParticipantId: string;
  authorLabel: string;
  authorSemanticRole?: HallSemanticRole;
  content: string;
  targetParticipantIds: string[];
  mentionTargets: MentionTarget[];
  projectId?: string;
  taskId?: string;
  taskCardId?: string;
  roomId?: string;
  payload?: HallMessagePayload;
  createdAt: string;
}

export interface HallTaskCard {
  hallId: string;
  taskCardId: string;
  projectId: string;
  taskId: string;
  roomId?: string;
  title: string;
  description: string;
  stage: HallTaskStage;
  status: TaskState;
  createdByParticipantId: string;
  currentOwnerParticipantId?: string;
  currentOwnerLabel?: string;
  proposal?: string;
  decision?: string;
  doneWhen?: string;
  latestSummary?: string;
  blockers: string[];
  requiresInputFrom: string[];
  mentionedParticipantIds: string[];
  plannedExecutionOrder: string[];
  plannedExecutionItems: HallExecutionItem[];
  currentExecutionItem?: HallExecutionItem;
  sessionKeys: string[];
  discussionCycle?: TaskDiscussionCycle;
  executionLock?: ExecutionLock;
  parallelGroups?: HallParallelGroup[];
  archivedAt?: string;
  archivedByParticipantId?: string;
  archivedByLabel?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HallExecutionItem {
  itemId: string;
  participantId: string;
  task: string;
  handoffToParticipantId?: string;
  handoffWhen?: string;
}

export type HallParallelSlotStatus = "pending" | "running" | "completed" | "failed";

export interface HallParallelSlot {
  slotId: string;
  participantId: string;
  task: string;
  status: HallParallelSlotStatus;
  result?: string;
  sessionKey?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface HallParallelGroup {
  groupId: string;
  initiatorParticipantId: string;
  slots: HallParallelSlot[];
  status: "active" | "settled";
  createdAt: string;
  settledAt?: string;
}

export interface CollaborationHall {
  hallId: string;
  title: string;
  description?: string;
  participants: HallParticipant[];
  taskCardIds: string[];
  messageIds: string[];
  lastMessageId?: string | null;
  latestMessageAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CollaborationHallSummary {
  hallId: string;
  headline: string;
  activeTaskCount: number;
  waitingReviewCount: number;
  blockedTaskCount: number;
  currentSpeakerLabel?: string;
  updatedAt: string;
}

export interface HallTaskSummary {
  taskCardId: string;
  projectId: string;
  taskId: string;
  headline: string;
  currentOwnerLabel?: string;
  nextAction: string;
  stage: HallTaskStage;
  blockerCount: number;
  updatedAt: string;
}

export interface CollaborationHallStoreSnapshot {
  halls: CollaborationHall[];
  executionLocks: ExecutionLock[];
  updatedAt: string;
}

export interface CollaborationHallMessageStoreSnapshot {
  messages: HallMessage[];
  updatedAt: string;
}

export interface CollaborationTaskCardStoreSnapshot {
  taskCards: HallTaskCard[];
  updatedAt: string;
}

export interface CollaborationHallSummaryStoreSnapshot {
  hallSummaries: CollaborationHallSummary[];
  taskSummaries: HallTaskSummary[];
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
  generatedAt: string;
}

export interface TaskListItem {
  projectId: string;
  projectTitle: string;
  taskId: string;
  title: string;
  status: TaskState;
  owner: string;
  roomId?: string;
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
    | "TASK_DUE";
  source: "system" | "session" | "approval" | "budget" | "task";
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

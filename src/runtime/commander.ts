import { listTasks } from "./task-store";
import { SUBAGENT_MAX_DEPTH_WARN } from "../config";
import type {
  AlertLevel,
  BudgetEvaluation,
  CommanderExceptionsFeed,
  CommanderExceptionsSummary,
  ExceptionFeedItem,
  ReadModelSnapshot,
} from "../types";

const CURRENT_RUNTIME_ISSUE_WINDOW_MS = 6 * 60 * 60 * 1000;

export interface CommanderAlert {
  level: AlertLevel;
  code:
    | "NO_SESSIONS"
    | "HAS_ERRORS"
    | "HAS_BLOCKED"
    | "HAS_PENDING_APPROVALS"
    | "HAS_OVER_BUDGET"
    | "HAS_TASKS_DUE"
    | "HAS_SUBAGENT_ERRORS"
    | "HAS_DEEP_CHAIN";
  message: string;
  route: "timeline" | "operator-watch" | "action-queue";
}

export function commanderAlerts(snapshot: ReadModelSnapshot): CommanderAlert[] {
  const alerts: CommanderAlert[] = [];
  const exceptions = commanderExceptions(snapshot);

  if (snapshot.sessions.length === 0) {
    alerts.push({
      level: "info",
      code: "NO_SESSIONS",
      message: "No active sessions detected.",
      route: routeForLevel("info"),
    });
  }

  if (exceptions.counts.blocked > 0) {
    alerts.push({
      level: "warn",
      code: "HAS_BLOCKED",
      message: `${exceptions.counts.blocked} session(s) are blocked or waiting approval.`,
      route: routeForLevel("warn"),
    });
  }

  if (exceptions.counts.errors > 0) {
    alerts.push({
      level: "action-required",
      code: "HAS_ERRORS",
      message: `${exceptions.counts.errors} session(s) are in error state.`,
      route: routeForLevel("action-required"),
    });
  }

  if (exceptions.counts.pendingApprovals > 0) {
    alerts.push({
      level: "action-required",
      code: "HAS_PENDING_APPROVALS",
      message: `${exceptions.counts.pendingApprovals} approval request(s) are pending.`,
      route: routeForLevel("action-required"),
    });
  }

  if (exceptions.counts.overBudget > 0) {
    alerts.push({
      level: "action-required",
      code: "HAS_OVER_BUDGET",
      message: `${exceptions.counts.overBudget} budget scope(s) are over limit.`,
      route: routeForLevel("action-required"),
    });
  }

  if (exceptions.counts.tasksDue > 0) {
    alerts.push({
      level: "warn",
      code: "HAS_TASKS_DUE",
      message: `${exceptions.counts.tasksDue} task(s) are due.`,
      route: routeForLevel("warn"),
    });
  }

  if (snapshot.subagentStats) {
    const stats = snapshot.subagentStats;
    if (stats.errorNodes > 0) {
      alerts.push({
        level: "action-required",
        code: "HAS_SUBAGENT_ERRORS",
        message: `${stats.errorNodes} subagent session(s) are in error state.`,
        route: routeForLevel("action-required"),
      });
    }
    if (stats.maxDepth >= SUBAGENT_MAX_DEPTH_WARN) {
      alerts.push({
        level: "warn",
        code: "HAS_DEEP_CHAIN",
        message: `Subagent chain depth ${stats.maxDepth} exceeds threshold ${SUBAGENT_MAX_DEPTH_WARN}.`,
        route: routeForLevel("warn"),
      });
    }
  }

  return alerts;
}

export function commanderExceptions(snapshot: ReadModelSnapshot): CommanderExceptionsSummary {
  const nowMs = toMs(snapshot.generatedAt) || Date.now();
  const blocked = snapshot.sessions.filter(
    (s) =>
      (s.state === "blocked" || s.state === "waiting_approval") &&
      isFreshRuntimeIssueSession(s.lastMessageAt, nowMs),
  );
  const errors = snapshot.sessions.filter(
    (s) => s.state === "error" && isFreshRuntimeIssueSession(s.lastMessageAt, nowMs),
  );
  const pendingApprovals = snapshot.approvals.filter((approval) => approval.status === "pending");
  const overBudget = snapshot.budgetSummary.evaluations.filter((evaluation) => evaluation.status === "over");
  const projectTitleById = new Map(snapshot.projects.projects.map((project) => [project.projectId, project.title]));
  const tasksDue = listTasks(snapshot.tasks, projectTitleById).filter((task) => {
    if (!task.dueAt) return false;
    if (task.status === "done") return false;
    return Date.parse(task.dueAt) <= nowMs;
  });

  return {
    generatedAt: new Date().toISOString(),
    blocked,
    errors,
    pendingApprovals,
    overBudget,
    tasksDue,
    counts: {
      blocked: blocked.length,
      errors: errors.length,
      pendingApprovals: pendingApprovals.length,
      overBudget: overBudget.length,
      tasksDue: tasksDue.length,
    },
  };
}

export function commanderExceptionsFeed(snapshot: ReadModelSnapshot): CommanderExceptionsFeed {
  const items: ExceptionFeedItem[] = [];
  const exceptions = commanderExceptions(snapshot);
  const fallbackOccurredAt = snapshot.generatedAt;

  if (snapshot.sessions.length === 0) {
    items.push({
      level: "info",
      code: "NO_SESSIONS",
      source: "system",
      sourceId: "sessions",
      message: "No active sessions detected.",
      route: routeForLevel("info"),
      occurredAt: fallbackOccurredAt,
    });
  }

  for (const session of exceptions.blocked) {
    items.push({
      level: "warn",
      code: "SESSION_BLOCKED",
      source: "session",
      sourceId: session.sessionKey,
      message: `Session ${session.sessionKey} is ${session.state}.`,
      route: routeForLevel("warn"),
      occurredAt: session.lastMessageAt ?? fallbackOccurredAt,
    });
  }

  for (const session of exceptions.errors) {
    items.push({
      level: "action-required",
      code: "SESSION_ERROR",
      source: "session",
      sourceId: session.sessionKey,
      message: `Session ${session.sessionKey} is in error state.`,
      route: routeForLevel("action-required"),
      occurredAt: session.lastMessageAt ?? fallbackOccurredAt,
    });
  }

  for (const approval of exceptions.pendingApprovals) {
    items.push({
      level: "action-required",
      code: "PENDING_APPROVAL",
      source: "approval",
      sourceId: approval.approvalId,
      message: `Approval ${approval.approvalId} is pending.`,
      route: routeForLevel("action-required"),
      occurredAt: approval.updatedAt ?? approval.requestedAt ?? fallbackOccurredAt,
    });
  }

  for (const budget of exceptions.overBudget) {
    items.push({
      level: "action-required",
      code: "OVER_BUDGET",
      source: "budget",
      sourceId: `${budget.scope}:${budget.scopeId}`,
      message: `${budget.scope} ${budget.label} is over budget.`,
      route: routeForLevel("action-required"),
      occurredAt: deriveBudgetOccurredAt(snapshot, budget) ?? fallbackOccurredAt,
    });
  }

  for (const task of exceptions.tasksDue) {
    items.push({
      level: "warn",
      code: "TASK_DUE",
      source: "task",
      sourceId: task.taskId,
      message: `Task ${task.taskId} (${task.projectTitle}) is due at ${task.dueAt ?? "n/a"}.`,
      route: routeForLevel("warn"),
      occurredAt: task.dueAt ?? task.updatedAt ?? fallbackOccurredAt,
    });
  }

  if (snapshot.subagentStats) {
    const stats = snapshot.subagentStats;
    if (stats.errorNodes > 0) {
      items.push({
        level: "action-required",
        code: "SUBAGENT_ERROR",
        source: "subagent",
        sourceId: "subagent-tree",
        message: `${stats.errorNodes} subagent session(s) are in error state.`,
        route: routeForLevel("action-required"),
        occurredAt: fallbackOccurredAt,
      });
    }
    if (stats.maxDepth >= SUBAGENT_MAX_DEPTH_WARN) {
      items.push({
        level: "warn",
        code: "SUBAGENT_DEEP_CHAIN",
        source: "subagent",
        sourceId: "subagent-tree",
        message: `Subagent chain depth ${stats.maxDepth} exceeds threshold ${SUBAGENT_MAX_DEPTH_WARN}.`,
        route: routeForLevel("warn"),
        occurredAt: fallbackOccurredAt,
      });
    }
  }

  const sortedItems = [...items].sort(compareFeedItems);

  return {
    generatedAt: new Date().toISOString(),
    items: sortedItems,
    counts: {
      info: sortedItems.filter((item) => item.level === "info").length,
      warn: sortedItems.filter((item) => item.level === "warn").length,
      actionRequired: sortedItems.filter((item) => item.level === "action-required").length,
    },
  };
}

function routeForLevel(level: AlertLevel): "timeline" | "operator-watch" | "action-queue" {
  if (level === "action-required") return "action-queue";
  if (level === "warn") return "operator-watch";
  return "timeline";
}

function compareFeedItems(a: ExceptionFeedItem, b: ExceptionFeedItem): number {
  const severityDiff = severityRank(a.level) - severityRank(b.level);
  if (severityDiff !== 0) return severityDiff;

  const aTime = toMs(a.occurredAt);
  const bTime = toMs(b.occurredAt);
  if (aTime !== bTime) return bTime - aTime;

  const codeDiff = a.code.localeCompare(b.code);
  if (codeDiff !== 0) return codeDiff;
  const sourceDiff = a.source.localeCompare(b.source);
  if (sourceDiff !== 0) return sourceDiff;
  const sourceIdDiff = a.sourceId.localeCompare(b.sourceId);
  if (sourceIdDiff !== 0) return sourceIdDiff;
  const routeDiff = a.route.localeCompare(b.route);
  if (routeDiff !== 0) return routeDiff;
  return a.message.localeCompare(b.message);
}

function severityRank(level: AlertLevel): number {
  if (level === "action-required") return 0;
  if (level === "warn") return 1;
  return 2;
}

function toMs(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function isFreshRuntimeIssueSession(lastMessageAt: string | undefined, nowMs: number): boolean {
  const latestAt = toMs(lastMessageAt);
  if (latestAt <= 0) return true;
  return nowMs - latestAt <= CURRENT_RUNTIME_ISSUE_WINDOW_MS;
}

function deriveBudgetOccurredAt(
  snapshot: ReadModelSnapshot,
  budget: BudgetEvaluation,
): string | undefined {
  if (budget.scope === "task") {
    const task = snapshot.tasks.tasks.find((item) => item.taskId === budget.scopeId);
    return task?.updatedAt;
  }
  if (budget.scope === "project") {
    const project = snapshot.projects.projects.find((item) => item.projectId === budget.scopeId);
    return project?.updatedAt;
  }
  if (budget.scope === "agent") {
    const sessionKeys = snapshot.sessions
      .filter((session) => session.agentId === budget.scopeId)
      .map((session) => session.sessionKey);
    const statusTimes = snapshot.statuses
      .filter((status) => sessionKeys.includes(status.sessionKey))
      .map((status) => status.updatedAt)
      .filter((value): value is string => typeof value === "string");
    return statusTimes.sort((a, b) => toMs(b) - toMs(a))[0];
  }
  return undefined;
}

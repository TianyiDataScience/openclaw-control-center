import {
  mapApprovalsGetToSummaries,
  mapCronListToSummaries,
  mapSessionsListToSummaries,
} from "../mappers/openclaw-mappers";
import { parseSessionStatusText } from "../mappers/session-status-parser";
import type {
  ApprovalSummary,
  CronJobSummary,
  ReadModelSnapshot,
  SessionStatusSnapshot,
  SessionSummary,
} from "../types";
import type { ToolClient } from "../clients/tool-client";
import { computeBudgetSummary } from "../runtime/budget-governance";
import { loadBudgetPolicy } from "../runtime/budget-policy";
import { loadProjectStore } from "../runtime/project-store";
import { computeProjectSummaries } from "../runtime/project-summary";
import { loadTaskStore } from "../runtime/task-store";
import { computeTasksSummary } from "../runtime/task-summary";
import { inferSubagentStatsFromKeys } from "../runtime/subagent-tree";

/**
 * Official-first adapter (read path only).
 *
 * In readonly mode it uses a no-op client.
 * In live mode it uses a client that is currently guarded and not enabled yet.
 */
export class OpenClawReadonlyAdapter {
  constructor(private readonly client: ToolClient) {}

  async listSessions(): Promise<SessionSummary[]> {
    const raw = await this.client.sessionsList();
    return mapSessionsListToSummaries(raw);
  }

  async listSessionStatuses(sessionKeys: string[]): Promise<SessionStatusSnapshot[]> {
    const statuses = await Promise.all(
      sessionKeys.map(async (sessionKey) => {
        const raw = await this.client.sessionStatus(sessionKey);
        return parseSessionStatusText(sessionKey, raw.rawText);
      }),
    );

    return statuses;
  }

  async listCronJobs(): Promise<CronJobSummary[]> {
    const raw = await this.client.cronList();
    return mapCronListToSummaries(raw);
  }

  async listApprovals(): Promise<ApprovalSummary[]> {
    const raw = await this.client.approvalsGet();
    return mapApprovalsGetToSummaries(raw);
  }

  async snapshot(): Promise<ReadModelSnapshot> {
    const sessions = await this.listSessions();
    const statuses = await this.listSessionStatuses(sessions.map((s) => s.sessionKey));
    const cronJobs = await this.listCronJobs();
    const approvals = await this.listApprovals();
    const [projects, tasks] = await Promise.all([loadProjectStore(), loadTaskStore()]);
    const budgetPolicy = await loadBudgetPolicy();
    const tasksSummary = computeTasksSummary(tasks, projects.projects.length);
    const projectSummaries = computeProjectSummaries(projects, tasks);
    const budgetSummary = computeBudgetSummary(sessions, statuses, tasks, projects, budgetPolicy.policy);

    if (budgetPolicy.issues.length > 0) {
      console.warn("[mission-control] budget policy issues", {
        path: budgetPolicy.path,
        issues: budgetPolicy.issues,
      });
    }

    const subagentStats = inferSubagentStatsFromKeys(sessions, statuses);

    return {
      sessions,
      statuses,
      cronJobs,
      approvals,
      projects,
      projectSummaries,
      tasks,
      tasksSummary,
      budgetSummary,
      subagentStats,
      generatedAt: new Date().toISOString(),
    };
  }
}

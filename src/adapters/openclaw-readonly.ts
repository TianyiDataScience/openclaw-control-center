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

/**
 * Official-first adapter (read path only).
 *
 * In readonly mode it uses a no-op client.
 * In live mode it uses a client that is currently guarded and not enabled yet.
 */
/** Active session states that may change between polling cycles. */
const ACTIVE_SESSION_STATES = new Set(["running", "blocked", "waiting_approval"]);

export class OpenClawReadonlyAdapter {
  /** Cached status snapshots from the previous polling cycle, keyed by sessionKey. */
  private cachedStatuses = new Map<string, SessionStatusSnapshot>();
  /** Session keys seen in the previous snapshot – used to detect new sessions. */
  private previousSessionKeys = new Set<string>();
  /** Session keys that were in an active state during the previous snapshot. */
  private previousActiveKeys = new Set<string>();

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
    const currentKeys = new Set(sessions.map((s) => s.sessionKey));

    // Determine which sessions need a fresh status query:
    //  1. Sessions not seen in the previous snapshot (new)
    //  2. Sessions in an active state (running / blocked / waiting_approval)
    //  3. Sessions that were active last cycle but no longer are (final refresh)
    const keysToQuery = sessions
      .filter(
        (s) =>
          !this.previousSessionKeys.has(s.sessionKey) ||
          ACTIVE_SESSION_STATES.has(s.state) ||
          this.previousActiveKeys.has(s.sessionKey),
      )
      .map((s) => s.sessionKey);

    // Fetch only the subset that needs refreshing
    if (keysToQuery.length > 0) {
      const freshStatuses = await this.listSessionStatuses(keysToQuery);
      for (const status of freshStatuses) {
        this.cachedStatuses.set(status.sessionKey, status);
      }
    }

    // Prune sessions that no longer exist
    for (const key of this.cachedStatuses.keys()) {
      if (!currentKeys.has(key)) {
        this.cachedStatuses.delete(key);
      }
    }

    this.previousSessionKeys = currentKeys;
    this.previousActiveKeys = new Set(
      sessions.filter((s) => ACTIVE_SESSION_STATES.has(s.state)).map((s) => s.sessionKey),
    );

    const statuses = Array.from(this.cachedStatuses.values());
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
      generatedAt: new Date().toISOString(),
    };
  }
}

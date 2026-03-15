export interface ApiRouteDoc {
  method: "GET" | "POST" | "PATCH" | "PUT";
  path: string;
  summary: string;
  query?: Record<string, string>;
  body?: Record<string, string>;
  response: Record<string, string>;
}

export interface ApiDocsPayload {
  generatedAt: string;
  version: string;
  safetyDefaults: Record<string, string | boolean | number>;
  routes: ApiRouteDoc[];
}

export function buildApiDocs(): ApiDocsPayload {
  return {
    generatedAt: new Date().toISOString(),
    version: "phase-23",
    safetyDefaults: {
      READONLY_MODE: true,
      APPROVAL_ACTIONS_ENABLED: false,
      APPROVAL_ACTIONS_DRY_RUN: true,
      IMPORT_MUTATION_ENABLED: false,
      IMPORT_MUTATION_DRY_RUN: false,
      LOCAL_TOKEN_AUTH_REQUIRED: true,
      TASK_HEARTBEAT_ENABLED: true,
      TASK_HEARTBEAT_DRY_RUN: true,
      TASK_HEARTBEAT_MAX_TASKS_PER_RUN: 3,
      LOCAL_API_TOKEN:
        "Set explicitly to allow import/export and state-changing routes; present token via x-local-token or Authorization Bearer",
      approvalExecutionGuard:
        "Live approve/reject requires READONLY_MODE=false + APPROVAL_ACTIONS_ENABLED=true + APPROVAL_ACTIONS_DRY_RUN=false",
      importMutationExecutionGuard:
        "Live import apply requires LOCAL_API_TOKEN auth + IMPORT_MUTATION_ENABLED=true + READONLY_MODE=false; optional per-request dryRun=true keeps it non-mutating",
      taskHeartbeatExecutionGuard:
        "Live task heartbeat execution requires LOCAL_API_TOKEN when LOCAL_TOKEN_AUTH_REQUIRED=true; default mode is dry-run",
    },
    routes: [
      {
        method: "GET",
        path: "/api/docs",
        summary: "API reference summary for Mission Control",
        response: {
          ok: "boolean",
          docs: "ApiDocsPayload",
        },
      },
      {
        method: "GET",
        path: "/api/done-checklist",
        summary: "Final integration checklist + readiness scoring snapshot",
        response: {
          ok: "boolean",
          checklist: "{ basedOn, items[], counts, readiness{overall,categories[]} }",
        },
      },
      {
        method: "GET",
        path: "/api/ui/preferences",
        summary: "Read persisted dashboard UI preferences",
        response: {
          ok: "boolean",
          preferences: "{ compactStatusStrip, quickFilter, taskFilters, updatedAt }",
          path: "string",
          issues: "string[]",
        },
      },
      {
        method: "PATCH",
        path: "/api/ui/preferences",
        summary:
          "Update dashboard UI preferences persisted to runtime/ui-preferences.json (requires local token gate)",
        body: {
          compactStatusStrip: "boolean (optional)",
          quickFilter: "all|attention|todo|in_progress|blocked|done (optional)",
          taskFilters: "{ status?, owner?, project? } (optional)",
        },
        response: {
          ok: "boolean",
          preferences: "{ compactStatusStrip, quickFilter, taskFilters, updatedAt }",
        },
      },
      {
        method: "GET",
        path: "/api/files",
        summary: "List editable files for memory or workspace scope",
        query: {
          scope: "required: memory|workspace",
        },
        response: {
          ok: "boolean",
          scope: "memory|workspace",
          count: "number",
          files: "EditableFileEntry[]",
        },
      },
      {
        method: "GET",
        path: "/api/files/content",
        summary: "Read one editable file from the allowed memory/workspace scope",
        query: {
          scope: "required: memory|workspace",
          path: "required absolute source path from /api/files list",
        },
        response: {
          ok: "boolean",
          scope: "memory|workspace",
          entry: "EditableFileEntry",
          content: "string",
        },
      },
      {
        method: "PUT",
        path: "/api/files/content",
        summary: "Write one editable file back to disk (requires local token gate if enabled)",
        body: {
          scope: "required: memory|workspace",
          path: "required absolute source path from /api/files list",
          content: "full file text",
        },
        response: {
          ok: "boolean",
          scope: "memory|workspace",
          entry: "EditableFileEntry",
          content: "string",
        },
      },
      {
        method: "GET",
        path: "/api/search/tasks",
        summary: "Substring search over tasks",
        query: {
          q: "required search term",
          limit: "optional 1..200 (default 20)",
        },
        response: {
          ok: "boolean",
          scope: "tasks",
          query: "{ q, limit }",
          count: "number (total matches before limit)",
          returned: "number (items returned in this response)",
          items: "TaskListItem[]",
        },
      },
      {
        method: "GET",
        path: "/api/search/projects",
        summary: "Substring search over projects",
        query: {
          q: "required search term",
          limit: "optional 1..200 (default 20)",
        },
        response: {
          ok: "boolean",
          scope: "projects",
          query: "{ q, limit }",
          count: "number (total matches before limit)",
          returned: "number (items returned in this response)",
          items: "ProjectRecord[]",
        },
      },
      {
        method: "GET",
        path: "/api/search/sessions",
        summary: "Substring search over session summaries",
        query: {
          q: "required search term",
          limit: "optional 1..200 (default 20)",
        },
        response: {
          ok: "boolean",
          scope: "sessions",
          query: "{ q, limit }",
          count: "number (total matches before limit, including live-merged sessions)",
          returned: "number (items returned in this response)",
          items: "SessionSummary[]",
        },
      },
      {
        method: "GET",
        path: "/api/search/exceptions",
        summary: "Substring search over routed exception feed items",
        query: {
          q: "required search term",
          limit: "optional 1..200 (default 20)",
        },
        response: {
          ok: "boolean",
          scope: "exceptions",
          query: "{ q, limit }",
          count: "number (total matches before limit)",
          returned: "number (items returned in this response)",
          items: "ExceptionFeedItem[]",
        },
      },
      {
        method: "GET",
        path: "/api/usage-cost",
        summary:
          "Usage/cost observability snapshot with context-window, period totals, burn-rate status, and connector TODOs",
        response: {
          ok: "boolean",
          usage:
            "{ periods(today/7d/30d), contextWindows[], breakdown(byAgent/byProject/byModel/byProvider), subscription, subscriptionSources[], budget, connectors }",
        },
      },
      {
        method: "GET",
        path: "/api/replay/index",
        summary: "Debug replay index from timeline, digests, export snapshots, and export bundles",
        query: {
          timelineLimit: "optional 1..400 (default 80)",
          digestLimit: "optional 1..200 (default 30)",
          exportLimit: "optional 1..200 (default 30)",
          from: "optional ISO date-time lower bound",
          to: "optional ISO date-time upper bound",
        },
        response: {
          ok: "boolean",
          replay:
            "{ timeline, digests, exportSnapshots, exportBundles, stats:{timeline,digests,exportSnapshots,exportBundles,total} with per-source latencyMs/latencyBucketsMs(p50,p95)/totalSizeBytes/returnedSizeBytes }",
        },
      },
      {
        method: "GET",
        path: "/api/commander/exceptions",
        summary: "Exceptions-only summary for blocked/error/pending approval/over-budget/tasks due",
        response: {
          ok: "boolean",
          exceptions: "CommanderExceptionsSummary",
        },
      },
      {
        method: "GET",
        path: "/api/action-queue",
        summary: "Action-required queue derived from exception feed with ack state",
        response: {
          ok: "boolean",
          center: "{ generatedAt, queue[], total, acknowledged }",
        },
      },
      {
        method: "POST",
        path: "/api/action-queue/:itemId/ack",
        summary: "Acknowledge action queue item with optional snooze window (requires local token gate)",
        body: {
          note: "optional string <= 300",
          ttlMinutes: "optional integer 1..10080 (ack expires after N minutes)",
          snoozeUntil: "optional ISO date-time (future); mutually exclusive with ttlMinutes",
        },
        response: {
          ok: "boolean",
          path: "runtime/acks.json",
          ack: "{ itemId, ackedAt, note?, expiresAt? }",
        },
      },
      {
        method: "GET",
        path: "/api/action-queue/acks/prune-preview",
        summary:
          "Preview stale acknowledgement prune counts (no write, requires local token gate)",
        response: {
          ok: "boolean",
          preview: "{ path, dryRun:true, before, removed, after, updatedAt }",
        },
      },
      {
        method: "GET",
        path: "/api/tasks/heartbeat",
        summary: "Read recent heartbeat runs for assigned backlog automation",
        query: {
          limit: "optional 1..200 (default 20)",
        },
        response: {
          ok: "boolean",
          path: "runtime/task-heartbeat.log",
          count: "number",
          runs: "TaskHeartbeatResult[] newest-first",
        },
      },
      {
        method: "POST",
        path: "/api/tasks/heartbeat",
        summary:
          "Execute heartbeat task pickup (requires local token gate; defaults to dry-run unless explicitly set live)",
        body: {
          dryRun: "optional boolean",
          maxTasksPerRun: "optional integer 1..200",
        },
        response: {
          ok: "boolean",
          mode: "blocked|dry_run|live",
          message: "string",
          checked: "number",
          eligible: "number",
          selected: "number",
          executed: "number",
          selections: "TaskHeartbeatSelection[]",
        },
      },
      {
        method: "GET",
        path: "/api/export/state.json",
        summary:
          "Export state bundle and persist timestamped debug + backup snapshots (requires local token gate)",
        response: {
          ok: "boolean",
          schemaVersion: "phase-9",
          source: "api|command",
          requestId: "string",
          exportedAt: "ISO timestamp",
          snapshotGeneratedAt: "ISO timestamp",
          projects: "ProjectStoreSnapshot",
          tasks: "TaskStoreSnapshot",
          sessions: "SessionSummary[]",
          budgets: "{ policy, issues, summary }",
          exceptions: "CommanderExceptionsSummary",
          exceptionsFeed: "CommanderExceptionsFeed",
          exportSnapshot: "{ fileName, path, sizeBytes }",
          backupExport: "{ fileName, path, sizeBytes }",
        },
      },
      {
        method: "POST",
        path: "/api/import/dry-run",
        summary:
          "Validate exported bundle shape in dry-run mode (no state mutation, requires local token gate)",
        body: {
          fileName: "optional runtime/exports/*.json name or path",
          bundle: "optional export bundle object; if omitted payload is validated directly",
        },
        response: {
          ok: "boolean",
          validation: "{ valid, issues[], warnings[], summary }",
        },
      },
      {
        method: "POST",
        path: "/api/import/live",
        summary:
          "Optional local import mutation endpoint (HIGH RISK): requires local token + IMPORT_MUTATION_ENABLED=true; blocked in readonly unless dryRun=true",
        body: {
          fileName: "optional runtime/exports/*.json name or path",
          bundle: "optional export bundle object; if omitted payload is treated as the bundle",
          dryRun: "optional boolean; if true validates only and skips mutation",
        },
        response: {
          ok: "boolean",
          mode: "blocked|dry_run|live",
          message: "string",
          guard: "{ readonlyMode, localTokenAuthRequired, localTokenConfigured, mutationEnabled, mutationDryRunDefault, defaultMode, defaultMessage }",
          validation: "{ valid, issues[], warnings[], summary }",
          applied: "{ projectsPath, tasksPath, budgetsPath, projects, tasks, sessions, exceptions }",
        },
      },
      {
        method: "POST",
        path: "/api/approvals/:approvalId/approve",
        summary: "Approval action route (requires local token + existing approval env gates)",
        body: {
          reason: "string <= 220 (optional)",
        },
        response: {
          ok: "boolean",
          mode: "blocked|dry_run|live",
          message: "string",
        },
      },
      {
        method: "POST",
        path: "/api/approvals/:approvalId/reject",
        summary: "Rejection action route (requires local token + existing approval env gates)",
        body: {
          reason: "string <= 220 (required)",
        },
        response: {
          ok: "boolean",
          mode: "blocked|dry_run|live",
          message: "string",
        },
      },
    ],
  };
}

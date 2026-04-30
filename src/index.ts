import { OpenClawReadonlyAdapter } from "./adapters/openclaw-readonly";
import { createToolClient } from "./clients/factory";
import {
  APPROVAL_ACTIONS_DRY_RUN,
  APPROVAL_ACTIONS_ENABLED,
  GATEWAY_URL,
  IMPORT_MUTATION_DRY_RUN,
  IMPORT_MUTATION_ENABLED,
  LOCAL_API_TOKEN,
  LOCAL_TOKEN_AUTH_REQUIRED,
  MONITOR_CONTINUOUS_MAX_INTERVAL_MS,
  POLLING_INTERVALS_MS,
  READONLY_MODE,
  TASK_HEARTBEAT_DRY_RUN,
  TASK_HEARTBEAT_ENABLED,
  TASK_HEARTBEAT_MAX_TASKS_PER_RUN,
  UI_TIMEZONE,
} from "./config";
import { buildHallRecoveryDispatcher } from "./runtime/collaboration-hall-orchestrator";
import { buildExportBundle, writeExportBundle } from "./runtime/export-bundle";
import { recoverPendingHallInboxes } from "./runtime/hall-supervisor";
import { validateExportFileDryRun } from "./runtime/import-dry-run";
import { monitorIntervalMs, nextContinuousMonitorDelayMs, runMonitorOnce } from "./runtime/monitor";
import { pruneStaleAcks } from "./runtime/notification-center";
import { appendOperationAudit } from "./runtime/operation-audit";
import { runTaskHeartbeat, runtimeTaskHeartbeatGate } from "./runtime/task-heartbeat";
import { startUiServer } from "./ui/server";

const CONTINUOUS_MODE = process.env.MONITOR_CONTINUOUS === "true";
const UI_MODE = process.env.UI_MODE === "true";
const UI_PORT = Number.parseInt(process.env.UI_PORT ?? "4310", 10);
const COMMAND = normalizeCommand(process.env.APP_COMMAND ?? process.argv[2]);
const COMMAND_ARG =
  process.env.COMMAND_ARG ??
  (process.env.APP_COMMAND ? process.argv[2] : process.argv[3]);

async function start(): Promise<void> {
  const client = createToolClient();
  const adapter = new OpenClawReadonlyAdapter(client);

  console.log("[mission-control] startup", {
    gateway: GATEWAY_URL,
    readonlyMode: READONLY_MODE,
    approvalActionsEnabled: APPROVAL_ACTIONS_ENABLED,
    approvalActionsDryRun: APPROVAL_ACTIONS_DRY_RUN,
    importMutationEnabled: IMPORT_MUTATION_ENABLED,
    importMutationDryRun: IMPORT_MUTATION_DRY_RUN,
    localTokenAuthRequired: LOCAL_TOKEN_AUTH_REQUIRED,
    localTokenConfigured: LOCAL_API_TOKEN !== "",
    uiTimezone: UI_TIMEZONE,
    taskHeartbeat: {
      enabled: TASK_HEARTBEAT_ENABLED,
      dryRun: TASK_HEARTBEAT_DRY_RUN,
      maxTasksPerRun: TASK_HEARTBEAT_MAX_TASKS_PER_RUN,
    },
    pollingIntervalsMs: POLLING_INTERVALS_MS,
    networkCalls: !READONLY_MODE,
    continuousMode: CONTINUOUS_MODE,
    command: COMMAND ?? "monitor",
  });

  if (COMMAND) {
    await runCommand(COMMAND, adapter, COMMAND_ARG);
    return;
  }

  if (UI_MODE) {
    startUiServer(UI_PORT, client);
    // P3-C-3b: recover any inbox records left pending by a previous process.
    // Fire-and-forget so a slow recovery scan can't block the HTTP server, and
    // best-effort so a transient store error doesn't crash the dashboard.
    void recoverPendingHallInboxes({ dispatcher: buildHallRecoveryDispatcher(client) })
      .then((report) => {
        if (report.scheduledCount > 0 || report.canceledCount > 0) {
          console.log("[mission-control] hall inbox recovery", {
            scheduled: report.scheduledCount,
            canceled: report.canceledCount,
            skipped: report.skippedCount,
            cards: report.perCard.length,
          });
        }
      })
      .catch((error) => {
        console.error("[mission-control] hall inbox recovery failed", error);
      });
  }

  const runMonitorSafely = async () => {
    try {
      return await runMonitorOnce(adapter);
    } catch (error) {
      console.error("[mission-control] monitor failed", error);
      return undefined;
    }
  };

  if (UI_MODE && !CONTINUOUS_MODE) {
    void runMonitorSafely();
  } else {
    await runMonitorSafely();
  }

  if (CONTINUOUS_MODE) {
    const baseIntervalMs = monitorIntervalMs();
    let idleStreak = 0;

    const scheduleNext = (delayMs: number): void => {
      setTimeout(() => {
        void runContinuousMonitorTick();
      }, delayMs);
    };

    const runContinuousMonitorTick = async (): Promise<void> => {
      const summary = await runMonitorSafely();
      const next = nextContinuousMonitorDelayMs(
        baseIntervalMs,
        idleStreak,
        summary,
        MONITOR_CONTINUOUS_MAX_INTERVAL_MS,
      );
      idleStreak = next.idleStreak;
      scheduleNext(next.delayMs);
    };

    scheduleNext(baseIntervalMs);
  }
}

void start();

async function runCommand(
  command: "backup-export" | "import-validate" | "acks-prune" | "task-heartbeat",
  adapter: OpenClawReadonlyAdapter,
  arg?: string,
): Promise<void> {
  assertCommandOperationGate(command);

  if (command === "backup-export") {
    try {
      const snapshot = await adapter.snapshot();
      const bundle = await buildExportBundle(snapshot, "command", "cmd-backup-export");
      const written = await writeExportBundle(bundle, "backup");
      await appendOperationAudit({
        action: "backup_export",
        source: "command",
        ok: true,
        requestId: "cmd-backup-export",
        detail: `wrote ${written.fileName}`,
        metadata: {
          path: written.path,
          sizeBytes: written.sizeBytes,
        },
      });
      console.log("[mission-control] backup export", {
        exportedAt: bundle.exportedAt,
        snapshotGeneratedAt: bundle.snapshotGeneratedAt,
        fileName: written.fileName,
        path: written.path,
        sizeBytes: written.sizeBytes,
      });
    } catch (error) {
      await appendOperationAudit({
        action: "backup_export",
        source: "command",
        ok: false,
        requestId: "cmd-backup-export",
        detail: error instanceof Error ? error.message : "backup export failed",
      });
      throw error;
    }
    return;
  }

  if (command === "acks-prune") {
    const dryRun = resolveAcksPruneDryRun(arg);
    try {
      const result = await pruneStaleAcks({ dryRun });
      await appendOperationAudit({
        action: "ack_prune",
        source: "command",
        ok: true,
        requestId: "cmd-acks-prune",
        detail: `removed ${result.removed} stale ack(s)`,
        metadata: {
          dryRun,
          before: result.before,
          removed: result.removed,
          after: result.after,
        },
      });
      console.log("[mission-control] acks prune", result);
    } catch (error) {
      await appendOperationAudit({
        action: "ack_prune",
        source: "command",
        ok: false,
        requestId: "cmd-acks-prune",
        detail: error instanceof Error ? error.message : "acks prune failed",
      });
      throw error;
    }
    return;
  }

  if (command === "task-heartbeat") {
    const gate = runtimeTaskHeartbeatGate();
    const runDryRun = resolveTaskHeartbeatDryRun(arg, gate.dryRun);
    const result = await runTaskHeartbeat({
      gate: {
        ...gate,
        dryRun: runDryRun,
      },
    });
    await appendOperationAudit({
      action: "task_heartbeat",
      source: "command",
      ok: result.ok,
      requestId: "cmd-task-heartbeat",
      detail: `${result.mode} ${result.message}`,
      metadata: {
        checked: result.checked,
        eligible: result.eligible,
        selected: result.selected,
        executed: result.executed,
        dryRun: result.gate.dryRun,
      },
    });
    console.log("[mission-control] task heartbeat", result);
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (!arg) {
    throw new Error(
      "import-validate requires a file path argument. Example: APP_COMMAND=import-validate COMMAND_ARG=<file.json> npm run dev",
    );
  }

  const validation = await validateExportFileDryRun(arg);
  await appendOperationAudit({
    action: "import_dry_run",
    source: "command",
    ok: validation.valid,
    requestId: "cmd-import-validate",
    detail: `validated ${validation.source}`,
    metadata: {
      valid: validation.valid,
      issues: validation.issues.length,
      warnings: validation.warnings.length,
    },
  });
  console.log("[mission-control] import dry-run", validation);
  if (!validation.valid) {
    process.exitCode = 1;
  }
}

function assertCommandOperationGate(
  command: "backup-export" | "import-validate" | "acks-prune" | "task-heartbeat",
): void {
  if (!LOCAL_TOKEN_AUTH_REQUIRED) return;
  if (LOCAL_API_TOKEN !== "") return;
  throw new Error(
    `${command} is blocked by local token gate. Set LOCAL_API_TOKEN to explicitly allow protected command execution.`,
  );
}

function normalizeCommand(
  input: string | undefined,
): "backup-export" | "import-validate" | "acks-prune" | "task-heartbeat" | undefined {
  if (!input) return undefined;
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "") return undefined;
  if (trimmed === "backup-export") return "backup-export";
  if (trimmed === "import-validate") return "import-validate";
  if (trimmed === "acks-prune") return "acks-prune";
  if (trimmed === "task-heartbeat") return "task-heartbeat";
  throw new Error(
    `Unknown command '${input}'. Supported: backup-export, import-validate, acks-prune, task-heartbeat.`,
  );
}

function resolveAcksPruneDryRun(arg: string | undefined): boolean {
  const envDryRun = process.env.ACK_PRUNE_DRY_RUN === "true";
  if (!arg) return envDryRun;

  const normalized = arg.trim().toLowerCase();
  if (normalized === "" || normalized === "--live" || normalized === "live") return false;
  if (normalized === "--dry-run" || normalized === "dry-run") return true;
  throw new Error("acks-prune optional arg must be one of: --dry-run, dry-run, --live, live.");
}

function resolveTaskHeartbeatDryRun(arg: string | undefined, fallback: boolean): boolean {
  if (!arg) return fallback;

  const normalized = arg.trim().toLowerCase();
  if (normalized === "") return fallback;
  if (normalized === "--dry-run" || normalized === "dry-run") return true;
  if (normalized === "--live" || normalized === "live") return false;
  throw new Error("task-heartbeat optional arg must be one of: --dry-run, dry-run, --live, live.");
}

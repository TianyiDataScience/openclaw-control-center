import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const PROJECT_ROOT = process.cwd();
const RUNTIME_DIR = join(PROJECT_ROOT, "runtime");
const OPERATION_AUDIT_LOG = join(RUNTIME_DIR, "operation-audit.log");
const ACKS_PATH = join(RUNTIME_DIR, "acks.json");
const TEST_LOCAL_TOKEN = "phase10-test-token";

test("done-checklist route logic builds readiness payload", async () => {
  const [
    { buildDoneChecklist },
    { validateExportBundleDryRun },
    { evaluateLocalTokenGate },
    { evaluateImportMutationGuard },
    { buildApiDocs },
    { LOCAL_TOKEN_AUTH_REQUIRED },
  ] =
    await Promise.all([
      import("../src/runtime/done-checklist"),
      import("../src/runtime/import-dry-run"),
      import("../src/runtime/local-token-auth"),
      import("../src/runtime/import-live"),
      import("../src/runtime/api-docs"),
      import("../src/config"),
    ]);

  const snapshot = await loadSnapshotFixture();
  const checklist = await buildDoneChecklist(snapshot);
  assert.equal(typeof checklist.readiness.overall, "number");
  assert(Array.isArray(checklist.items));
  assert(checklist.items.length > 0);
  const routeCoverageItem = checklist.items.find((item) => item.id === "obs_route_coverage");
  assert(routeCoverageItem, "Expected obs_route_coverage checklist item.");
  assert(routeCoverageItem.detail.includes("/api/action-queue/acks/prune-preview"));
  const uiBindEnvItem = checklist.items.find((item) => item.id === "obs_ui_bind_env_only");
  assert(uiBindEnvItem, "Expected obs_ui_bind_env_only checklist item.");
  assert.equal(uiBindEnvItem.status, "pass");
  assert(uiBindEnvItem.detail.includes("environment-only"));
  const actionQueueSignalItem = checklist.items.find((item) => item.id === "collab_action_queue_signal");
  assert(actionQueueSignalItem, "Expected collab_action_queue_signal checklist item.");
  assert.equal(actionQueueSignalItem.status, "pass");
  const localTokenGateItem = checklist.items.find((item) => item.id === "sec_local_token_gate");
  assert(localTokenGateItem, "Expected sec_local_token_gate checklist item.");
  assert.equal(localTokenGateItem.status, LOCAL_TOKEN_AUTH_REQUIRED ? "pass" : "warn");

  const docs = buildApiDocs();
  assert(docs.routes.some((route) => route.path === "/api/commander/exceptions"));
  assert(docs.routes.some((route) => route.path === "/api/action-queue"));
  assert(docs.routes.some((route) => route.path === "/api/action-queue/acks/prune-preview"));
  assert(docs.routes.some((route) => route.path === "/api/tasks/heartbeat"));
  assert(docs.routes.some((route) => route.path === "/api/usage-cost"));

  // Route-level guard behavior used by /api/import/dry-run
  const blocked = evaluateLocalTokenGate({
    gateRequired: true,
    configuredToken: TEST_LOCAL_TOKEN,
    routeLabel: "/api/import/live",
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.statusCode, 401);

  const allowed = evaluateLocalTokenGate({
    gateRequired: true,
    configuredToken: TEST_LOCAL_TOKEN,
    providedToken: TEST_LOCAL_TOKEN,
    routeLabel: "/api/import/live",
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.statusCode, 200);

  const importGateBlocked = evaluateImportMutationGuard({
    mutationEnabled: false,
    mutationDryRunDefault: false,
    readonlyMode: false,
    routeLabel: "/api/import/live",
  });
  assert.equal(importGateBlocked.ok, false);
  assert.equal(importGateBlocked.statusCode, 403);

  const importGateDryRun = evaluateImportMutationGuard({
    mutationEnabled: true,
    mutationDryRunDefault: false,
    readonlyMode: true,
    routeLabel: "/api/import/live",
    requestedDryRun: true,
  });
  assert.equal(importGateDryRun.ok, true);
  assert.equal(importGateDryRun.mode, "dry_run");

  const validBundle = {
    ok: true,
    schemaVersion: "phase-9",
    source: "api",
    exportedAt: "2026-03-01T12:00:00.000Z",
    snapshotGeneratedAt: "2026-03-01T12:00:00.000Z",
    sessions: [{ sessionKey: "s-1", state: "running" }],
    projects: {
      updatedAt: "2026-03-01T12:00:00.000Z",
      projects: [{ projectId: "p-1", title: "P1", status: "active", owner: "owner", updatedAt: "2026-03-01T12:00:00.000Z" }],
    },
    tasks: {
      updatedAt: "2026-03-01T12:00:00.000Z",
      agentBudgets: [],
      tasks: [{ projectId: "p-1", taskId: "t-1", status: "todo", title: "T1", owner: "owner", definitionOfDone: [], artifacts: [], rollback: { strategy: "none", steps: [] }, sessionKeys: [], budget: {}, updatedAt: "2026-03-01T12:00:00.000Z" }],
    },
    budgets: {
      policy: {},
      summary: {},
      issues: [],
    },
    exceptions: { counts: {} },
    exceptionsFeed: { items: [], counts: {} },
  };
  const validation = validateExportBundleDryRun(validBundle, "payload.bundle");
  assert.equal(validation.valid, true);
  assert.equal(validation.issues.length, 0);
});

test("backup export command path writes bundle and operation audit entry", async () => {
  const run = await runCommand(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      APP_COMMAND: "backup-export",
      READONLY_MODE: "true",
      APPROVAL_ACTIONS_ENABLED: "false",
      APPROVAL_ACTIONS_DRY_RUN: "true",
      LOCAL_TOKEN_AUTH_REQUIRED: "true",
      LOCAL_API_TOKEN: TEST_LOCAL_TOKEN,
    },
  });

  assert.equal(
    run.code,
    0,
    `backup-export command failed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
  );

  const auditEntries = await readOperationAuditEntries();
  const commandEntry = [...auditEntries]
    .reverse()
    .find((entry) => entry.action === "backup_export" && entry.source === "command");
  assert(commandEntry, "Expected backup_export command audit entry");
  assert.equal(commandEntry.ok, true);
  const metadata = asRecord(commandEntry.metadata);
  assert.equal(typeof metadata?.path, "string");
  const writtenPath = metadata?.path as string;
  assert(writtenPath.replace(/\\/g, "/").includes("/runtime/exports/"));
  assert(await fileExists(writtenPath), "Expected backup export file path from audit metadata to exist.");
});

test("acks-prune command removes expired records and writes audit entry", async () => {
  let acksExisted = true;
  let acksBefore = "";
  try {
    acksBefore = await readFile(ACKS_PATH, "utf8");
  } catch {
    acksExisted = false;
  }

  const now = Date.now();
  const expiredItemId = `phase14-expired-${now}`;
  const activeItemId = `phase14-active-${now}`;
  const fixture = {
    acks: [
      {
        itemId: expiredItemId,
        ackedAt: new Date(now - 2 * 60_000).toISOString(),
        expiresAt: new Date(now - 60_000).toISOString(),
      },
      {
        itemId: activeItemId,
        ackedAt: new Date(now - 2 * 60_000).toISOString(),
        expiresAt: new Date(now + 5 * 60_000).toISOString(),
      },
    ],
    updatedAt: new Date(now).toISOString(),
  };
  await writeFile(ACKS_PATH, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");

  try {
    const run = await runCommand(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        APP_COMMAND: "acks-prune",
        READONLY_MODE: "true",
        APPROVAL_ACTIONS_ENABLED: "false",
        APPROVAL_ACTIONS_DRY_RUN: "true",
        LOCAL_TOKEN_AUTH_REQUIRED: "true",
        LOCAL_API_TOKEN: TEST_LOCAL_TOKEN,
      },
    });

    assert.equal(
      run.code,
      0,
      `acks-prune command failed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
    );

    const raw = await readFile(ACKS_PATH, "utf8");
    const parsed = JSON.parse(raw) as { acks?: Array<{ itemId?: string }> };
    const itemIds = (parsed.acks ?? []).map((item) => item.itemId).filter(Boolean);
    assert(!itemIds.includes(expiredItemId), "Expected expired ack to be pruned.");
    assert(itemIds.includes(activeItemId), "Expected active ack to remain.");

    const auditEntries = await readOperationAuditEntries();
    const pruneEntry = [...auditEntries]
      .reverse()
      .find((entry) => entry.action === "ack_prune" && entry.source === "command");
    assert(pruneEntry, "Expected ack_prune command audit entry");
    assert.equal(pruneEntry.ok, true);
    const metadata = asRecord(pruneEntry.metadata);
    assert.equal(typeof metadata?.removed, "number");
    assert((metadata?.removed as number) >= 1);
  } finally {
    if (acksExisted) {
      await writeFile(ACKS_PATH, acksBefore, "utf8");
    } else {
      await rm(ACKS_PATH, { force: true });
    }
  }
});

async function loadSnapshotFixture(): Promise<Record<string, unknown>> {
  const snapshotPath = join(RUNTIME_DIR, "last-snapshot.json");
  try {
    const raw = await readFile(snapshotPath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
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
}

async function readOperationAuditEntries(): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(OPERATION_AUDIT_LOG, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function runCommand(
  cmd: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
  },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

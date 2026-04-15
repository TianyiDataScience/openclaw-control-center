import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  APPROVAL_ACTIONS_DRY_RUN,
  APPROVAL_ACTIONS_ENABLED,
  POLLING_INTERVALS_MS,
  READONLY_MODE,
} from "../config";
import type { ReadModelSnapshot } from "../types";
import { readMonitorLagSummary, type MonitorLagSummary } from "./monitor-health";

const PACKAGE_JSON_PATH = join(process.cwd(), "package.json");
const DIST_INDEX_PATH = join(process.cwd(), "dist", "index.js");
const HEALTHZ_STARTUP_GRACE_MS = 60_000;

type HealthStatus = "ok" | "warn" | "stale";

interface BuildInfo {
  name: string;
  version: string;
  node: string;
  readonlyMode: boolean;
  approvalActionsEnabled: boolean;
  approvalActionsDryRun: boolean;
  distIndexPath: string;
  distBuiltAt?: string;
}

interface SnapshotFreshness {
  generatedAt: string;
  ageMs: number;
  status: HealthStatus;
  thresholdsMs: {
    ok: number;
    warn: number;
  };
}

export interface HealthzPayload {
  generatedAt: string;
  status: HealthStatus;
  build: BuildInfo;
  snapshot: SnapshotFreshness;
  monitor: MonitorLagSummary;
}

export async function buildHealthzPayload(
  snapshot: ReadModelSnapshot,
  now: Date = new Date(),
): Promise<HealthzPayload> {
  const monitor = await readMonitorLagSummary(POLLING_INTERVALS_MS.sessionsList, now);
  const [build, snapshotFreshness] = await Promise.all([
    readBuildInfo(),
    computeSnapshotFreshness(snapshot, POLLING_INTERVALS_MS.sessionsList, now),
  ]);

  const inStartupGrace = process.uptime() * 1000 < HEALTHZ_STARTUP_GRACE_MS;
  const effectiveSnapshotStatus = inStartupGrace && snapshotFreshness.status === "stale" ? "warn" : snapshotFreshness.status;
  const effectiveMonitorStatus = inStartupGrace && monitor.status === "stale" ? "warn" : monitor.status;
  const status = resolveOverallStatus(effectiveSnapshotStatus, effectiveMonitorStatus);

  return {
    generatedAt: now.toISOString(),
    status,
    build,
    snapshot: snapshotFreshness,
    monitor,
  };
}

async function readBuildInfo(): Promise<BuildInfo> {
  let name = "unknown";
  let version = "0.0.0";

  try {
    const raw = await readFile(PACKAGE_JSON_PATH, "utf8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    if (typeof pkg.name === "string" && pkg.name.trim()) name = pkg.name;
    if (typeof pkg.version === "string" && pkg.version.trim()) version = pkg.version;
  } catch {
    // keep defaults
  }

  let distBuiltAt: string | undefined;
  try {
    const stats = await stat(DIST_INDEX_PATH);
    distBuiltAt = stats.mtime.toISOString();
  } catch {
    distBuiltAt = undefined;
  }

  return {
    name,
    version,
    node: process.version,
    readonlyMode: READONLY_MODE,
    approvalActionsEnabled: APPROVAL_ACTIONS_ENABLED,
    approvalActionsDryRun: APPROVAL_ACTIONS_DRY_RUN,
    distIndexPath: DIST_INDEX_PATH,
    distBuiltAt,
  };
}

function computeSnapshotFreshness(
  snapshot: ReadModelSnapshot,
  monitorIntervalMs: number,
  now: Date,
): SnapshotFreshness {
  const snapshotTime = Date.parse(snapshot.generatedAt);
  const ageMs = Number.isNaN(snapshotTime) ? Number.MAX_SAFE_INTEGER : Math.max(0, now.getTime() - snapshotTime);

  const okThreshold = Math.max(60_000, monitorIntervalMs * 12);
  const warnThreshold = Math.max(5 * 60_000, monitorIntervalMs * 48);

  let status: HealthStatus = "ok";
  if (ageMs > warnThreshold) {
    status = "stale";
  } else if (ageMs > okThreshold) {
    status = "warn";
  }

  return {
    generatedAt: snapshot.generatedAt,
    ageMs,
    status,
    thresholdsMs: {
      ok: okThreshold,
      warn: warnThreshold,
    },
  };
}

function resolveOverallStatus(
  snapshotStatus: HealthStatus,
  monitorStatus: MonitorLagSummary["status"],
): HealthStatus {
  if (snapshotStatus === "stale" || monitorStatus === "stale") {
    return "stale";
  }

  if (snapshotStatus === "warn" || monitorStatus === "warn" || monitorStatus === "missing") {
    return "warn";
  }

  return "ok";
}

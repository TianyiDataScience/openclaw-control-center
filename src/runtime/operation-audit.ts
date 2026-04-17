import { appendFile, mkdir } from "node:fs/promises";
import { getRuntimeDir, resolveRuntimePath } from "./runtime-path";

const RUNTIME_DIR = getRuntimeDir();
export const OPERATION_AUDIT_LOG_PATH = resolveRuntimePath("operation-audit.log");

export type OperationAuditAction =
  | "import_dry_run"
  | "backup_export"
  | "import_apply"
  | "ack_prune"
  | "task_heartbeat"
  | "task_room_create"
  | "task_room_message"
  | "task_room_handoff"
  | "task_room_assign"
  | "task_room_review"
  | "task_room_stage"
  | "hall_task_create"
  | "hall_task_message"
  | "hall_task_assign"
  | "hall_task_execution_order"
  | "hall_task_review"
  | "hall_task_handoff"
  | "hall_task_stop"
  | "hall_task_archive"
  | "hall_task_delete"
  | "hall_task_mark_human_reviewed"
  | "hall_parallel_dispatch";
export type OperationAuditSource = "api" | "command" | "runtime";

export interface OperationAuditInput {
  action: OperationAuditAction;
  source: OperationAuditSource;
  ok: boolean;
  requestId?: string;
  detail: string;
  metadata?: Record<string, unknown>;
}

export interface OperationAuditEntry extends OperationAuditInput {
  timestamp: string;
}

export async function appendOperationAudit(input: OperationAuditInput): Promise<OperationAuditEntry> {
  const entry: OperationAuditEntry = {
    ...input,
    timestamp: new Date().toISOString(),
  };
  await mkdir(RUNTIME_DIR, { recursive: true });
  await appendFile(OPERATION_AUDIT_LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

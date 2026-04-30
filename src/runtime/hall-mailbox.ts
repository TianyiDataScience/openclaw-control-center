import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { resolveHallTaskWorkspacePath } from "./hall-workspace";

// Per-task-card serialization for inbox writes. Multiple agents finishing
// concurrently may all enqueue to the same card; we share one chain per card so
// inbox / deliveries appends never interleave. (The actual single-flight per
// (card, agent) for *dispatch* is provided by `dispatchChains` in
// hall-runtime-dispatch.ts; this chain is purely about disk-write ordering.)
const writeChains = new Map<string, Promise<void>>();

// In-memory index per (cardId, agentId). First access for a key lazily loads
// the inbox file from disk and reduces over the log to compute pending. Later
// accesses keep the index in sync with new enqueue / consume writes.
interface MailboxIndexEntry {
  hydrated: boolean;
  pending: Map<string, HallInboxEnqueueRecord>; // recordId -> record (only pending entries kept)
  recentMessageIds: Set<string>; // for in-process dedupe of repeated enqueues for the same trigger
}

const indexes = new Map<string, MailboxIndexEntry>();
const HALL_MAILBOX_DEDUPE_CAP = 256;

const INBOX_DIR = ".hall/inbox";
const DELIVERIES_FILE = ".hall/deliveries.jsonl";

export type HallInboxEnqueueReason =
  | "operator-route"
  | "auto-chain"
  | "observer-chain"
  | "parallel-dispatch"
  | "wake-mention-initiator"
  | "main-observer";

export type HallInboxConsumeOutcome =
  | "dispatched"
  | "skipped"
  | "failed"
  | "canceled";

export interface HallInboxEnqueueRecord {
  /** Stable id for this inbox slot; opaque to callers. */
  recordId: string;
  /** Trigger HallMessage.messageId — the message that caused this enqueue. */
  triggerMessageId: string;
  /** Owning task card. */
  taskCardId: string;
  /** Target agent participantId (NOT agentId — we key on participant). */
  targetParticipantId: string;
  /** Author of the trigger message (used by anti-loop policies). */
  triggerAuthorParticipantId: string;
  /** Why this dispatch was scheduled. */
  enqueueReason: HallInboxEnqueueReason;
  /** Auto-chain depth at enqueue time (0 for operator-route, ≥1 for chain). */
  chainDepth: number;
  /** ISO timestamp of enqueue. */
  enqueuedAt: string;
}

export interface HallInboxConsumeRecord {
  recordId: string;
  taskCardId: string;
  targetParticipantId: string;
  consumedAt: string;
  outcome: HallInboxConsumeOutcome;
  reason?: string;
}

export interface HallInboxDeliveryRecord {
  recordId: string;
  taskCardId: string;
  targetParticipantId: string;
  triggerMessageId: string;
  triggerAuthorParticipantId: string;
  enqueueReason: HallInboxEnqueueReason;
  chainDepth: number;
  enqueuedAt: string;
  finishedAt: string;
  outcome: HallInboxConsumeOutcome;
  reason?: string;
  durationMs: number;
  /** P3-B-2: shared id for all records consumed in the same merged batch.
   * `batchSize > 1` means the worker merged multiple triggers (e.g. 750ms
   * debounce window combining concurrent @s) into one dispatch. */
  batchId?: string;
  batchSize?: number;
}

interface InboxLogLine {
  op: "enqueue" | "consume";
  record: HallInboxEnqueueRecord | HallInboxConsumeRecord;
}

export interface HallInboxEnqueueArgs {
  taskCardId: string;
  targetParticipantId: string;
  triggerMessageId: string;
  triggerAuthorParticipantId: string;
  enqueueReason: HallInboxEnqueueReason;
  chainDepth: number;
}

export async function enqueueHallInbox(args: HallInboxEnqueueArgs): Promise<HallInboxEnqueueRecord> {
  const record: HallInboxEnqueueRecord = {
    recordId: randomUUID(),
    triggerMessageId: args.triggerMessageId,
    taskCardId: args.taskCardId,
    targetParticipantId: args.targetParticipantId,
    triggerAuthorParticipantId: args.triggerAuthorParticipantId,
    enqueueReason: args.enqueueReason,
    chainDepth: args.chainDepth,
    enqueuedAt: new Date().toISOString(),
  };

  const index = await ensureIndex(args.taskCardId, args.targetParticipantId);
  index.pending.set(record.recordId, record);
  rememberMessageId(index, args.triggerMessageId);

  await runSerial(args.taskCardId, async () => {
    try {
      const path = inboxFilePath(args.taskCardId, args.targetParticipantId);
      await ensureInboxDir(args.taskCardId);
      const line: InboxLogLine = { op: "enqueue", record };
      await appendFile(path, JSON.stringify(line) + "\n", "utf8");
    } catch {
      // Best-effort: inbox file is an audit / future-recovery artifact; the
      // dispatch path keeps running even if disk write fails. The in-memory
      // index already has the record so consume/read still works this process.
    }
  });

  return record;
}

export async function markHallInboxConsumed(args: {
  taskCardId: string;
  targetParticipantId: string;
  recordId: string;
  outcome: HallInboxConsumeOutcome;
  reason?: string;
}): Promise<void> {
  const index = await ensureIndex(args.taskCardId, args.targetParticipantId);
  index.pending.delete(args.recordId);

  const consume: HallInboxConsumeRecord = {
    recordId: args.recordId,
    taskCardId: args.taskCardId,
    targetParticipantId: args.targetParticipantId,
    consumedAt: new Date().toISOString(),
    outcome: args.outcome,
    reason: args.reason,
  };

  await runSerial(args.taskCardId, async () => {
    try {
      const path = inboxFilePath(args.taskCardId, args.targetParticipantId);
      await ensureInboxDir(args.taskCardId);
      const line: InboxLogLine = { op: "consume", record: consume };
      await appendFile(path, JSON.stringify(line) + "\n", "utf8");
    } catch {
      // best-effort
    }
  });
}

export async function readHallInboxPending(
  taskCardId: string,
  targetParticipantId: string,
): Promise<HallInboxEnqueueRecord[]> {
  const index = await ensureIndex(taskCardId, targetParticipantId);
  return [...index.pending.values()].sort((a, b) =>
    a.enqueuedAt < b.enqueuedAt ? -1 : a.enqueuedAt > b.enqueuedAt ? 1 : 0,
  );
}

export async function appendHallDeliveryRecord(record: HallInboxDeliveryRecord): Promise<void> {
  await runSerial(record.taskCardId, async () => {
    try {
      const root = resolveHallTaskWorkspacePath(record.taskCardId);
      await mkdir(join(root, ".hall"), { recursive: true });
      await appendFile(join(root, DELIVERIES_FILE), JSON.stringify(record) + "\n", "utf8");
    } catch {
      // best-effort
    }
  });
}

export function buildHallInboxFilename(targetParticipantId: string): string {
  return `${sanitizeParticipantId(targetParticipantId)}.jsonl`;
}

// Test-only: drop in-memory state so a fresh test can hydrate from disk.
export function __resetHallMailboxIndexForTests(): void {
  indexes.clear();
  writeChains.clear();
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function inboxFilePath(taskCardId: string, targetParticipantId: string): string {
  const root = resolveHallTaskWorkspacePath(taskCardId);
  return join(root, INBOX_DIR, buildHallInboxFilename(targetParticipantId));
}

async function ensureInboxDir(taskCardId: string): Promise<void> {
  const root = resolveHallTaskWorkspacePath(taskCardId);
  await mkdir(join(root, INBOX_DIR), { recursive: true });
}

function indexKey(taskCardId: string, targetParticipantId: string): string {
  return `${taskCardId}::${sanitizeParticipantId(targetParticipantId)}`;
}

async function ensureIndex(
  taskCardId: string,
  targetParticipantId: string,
): Promise<MailboxIndexEntry> {
  const key = indexKey(taskCardId, targetParticipantId);
  let entry = indexes.get(key);
  if (entry?.hydrated) return entry;
  if (!entry) {
    entry = { hydrated: false, pending: new Map(), recentMessageIds: new Set() };
    indexes.set(key, entry);
  }
  await hydrateIndex(taskCardId, targetParticipantId, entry);
  return entry;
}

async function hydrateIndex(
  taskCardId: string,
  targetParticipantId: string,
  entry: MailboxIndexEntry,
): Promise<void> {
  if (entry.hydrated) return;
  let raw = "";
  try {
    raw = await readFile(inboxFilePath(taskCardId, targetParticipantId), "utf8");
  } catch {
    // file doesn't exist yet → treat as empty log
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: InboxLogLine | undefined;
    try {
      parsed = JSON.parse(line) as InboxLogLine;
    } catch {
      continue;
    }
    if (!parsed?.op || !parsed.record?.recordId) continue;
    if (parsed.op === "enqueue") {
      entry.pending.set(parsed.record.recordId, parsed.record as HallInboxEnqueueRecord);
      const triggerId = (parsed.record as HallInboxEnqueueRecord).triggerMessageId;
      if (triggerId) rememberMessageId(entry, triggerId);
    } else if (parsed.op === "consume") {
      entry.pending.delete(parsed.record.recordId);
    }
  }
  entry.hydrated = true;
}

function rememberMessageId(entry: MailboxIndexEntry, messageId: string): void {
  entry.recentMessageIds.add(messageId);
  if (entry.recentMessageIds.size > HALL_MAILBOX_DEDUPE_CAP) {
    const first = entry.recentMessageIds.values().next().value;
    if (first) entry.recentMessageIds.delete(first);
  }
}

function sanitizeParticipantId(input: string): string {
  // Match hall participant id rules: alphanumeric, hyphen, underscore. Anything
  // else gets replaced with `_` so we never escape the inbox directory.
  return String(input || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 120) || "unknown";
}

function runSerial(taskCardId: string, op: () => Promise<void>): Promise<void> {
  const prev = writeChains.get(taskCardId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(op);
  writeChains.set(
    taskCardId,
    next.finally(() => {
      if (writeChains.get(taskCardId) === next) writeChains.delete(taskCardId);
    }),
  );
  return next;
}

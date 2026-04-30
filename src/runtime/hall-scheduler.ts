import { randomUUID } from "node:crypto";

import {
  appendHallDeliveryRecord,
  enqueueHallInbox as persistHallInboxEnqueue,
  markHallInboxConsumed,
  type HallInboxConsumeOutcome,
  type HallInboxEnqueueArgs,
  type HallInboxEnqueueRecord,
} from "./hall-mailbox";

// ---------------------------------------------------------------------------
// Phase 3-B-2 — async inbox worker pump with debounce-and-merge
// ---------------------------------------------------------------------------
// Each (cardId, targetParticipantId) gets a single in-process worker. Public
// API:
//
//     await enqueueAndDispatch(args, dispatch);
//
// where `dispatch` is a closure the caller hands in. The closure has access
// to its caller's lexical scope (`hall`, `taskCard`, `toolClient`, etc.), and
// the worker invokes it with the full batch of merged records when the 750ms
// debounce window closes. The orchestrator's closure is responsible for
// running the actual dispatchHallRuntimeTurn / dispatchHallAgentReply call
// with `triggerMessages` filled from the batch.
//
// Workflow:
//   1. enqueueAndDispatch persists the enqueue line, pushes a pending item
//      (record + closure + deferred Promise), and resets the debounce timer.
//      Concurrent enqueues to the same key keep resetting the window so they
//      land in the same batch.
//   2. When the timer fires, the worker drains all pending items into one
//      batch, picks the first item's closure (all items for the same key
//      share the same caller context, so any closure works), invokes it with
//      the batch context, and waits for it to return.
//   3. After the closure returns: persist consume + delivery for every record
//      (sharing a batchId), resolve every Promise, then if pending grew
//      during dispatch, schedule a fresh debounce window.
//
// Deadlock safety: enqueue is fire-and-forget at the worker level — the
// caller awaits a Promise, but the worker itself never awaits the caller, so
// re-entrant enqueues during dispatch (auto-chain back to a busy worker) just
// land in pending and get processed in the *next* batch.

function readDebounceMs(): number {
  const raw = process.env.HALL_INBOX_DEBOUNCE_MS;
  if (!raw) return 750;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 750;
}

export interface InboxBatchContext {
  batchId: string;
  taskCardId: string;
  targetParticipantId: string;
  records: HallInboxEnqueueRecord[];
}

export interface InboxBatchOutcome {
  outcome: HallInboxConsumeOutcome;
  reason?: string;
}

export type BatchDispatcher = (batch: InboxBatchContext) => Promise<InboxBatchOutcome | void>;

export interface EnqueueAndDispatchInput extends HallInboxEnqueueArgs {
  /** Optional reason override for the delivery record (e.g. when the dispatcher
   * decides to skip without throwing). */
  reason?: string;
}

interface PendingItem {
  record: HallInboxEnqueueRecord;
  dispatcher: BatchDispatcher;
  resolve: () => void;
  reject: (err: unknown) => void;
}

interface WorkerState {
  pending: PendingItem[];
  timer: NodeJS.Timeout | null;
  isDispatching: boolean;
}

const workers = new Map<string, WorkerState>();

function workerKey(cardId: string, agentId: string): string {
  return `${cardId}::${agentId}`;
}

/**
 * Persist the enqueue and schedule the per-(card, agent) worker. The returned
 * promise resolves when the *batch containing this record* has finished
 * dispatching.
 *
 * The worker does NOT await this promise — re-entrant enqueues from inside
 * `dispatch` (auto-chain etc.) are safe and never deadlock.
 *
 * `dispatch` is the closure that knows how to dispatch the agent with the
 * caller's toolClient / hall / taskCard. The worker batches concurrent
 * enqueues to the same target into one call to this closure with the full
 * batch context — all triggerMessageIds in `batch.records`. Because every
 * enqueue for the same key comes from the same caller context (orchestrator),
 * the worker just uses the FIRST item's closure.
 */
export async function enqueueAndDispatch(
  input: EnqueueAndDispatchInput,
  dispatch: BatchDispatcher,
): Promise<void> {
  const record = await persistHallInboxEnqueue({
    taskCardId: input.taskCardId,
    targetParticipantId: input.targetParticipantId,
    triggerMessageId: input.triggerMessageId,
    triggerAuthorParticipantId: input.triggerAuthorParticipantId,
    enqueueReason: input.enqueueReason,
    chainDepth: input.chainDepth,
  });
  return new Promise<void>((resolve, reject) => {
    enqueueIntoWorker(record, dispatch, resolve, reject);
  });
}

function enqueueIntoWorker(
  record: HallInboxEnqueueRecord,
  dispatcher: BatchDispatcher,
  resolve: () => void,
  reject: (err: unknown) => void,
): void {
  const key = workerKey(record.taskCardId, record.targetParticipantId);
  let state = workers.get(key);
  if (!state) {
    state = { pending: [], timer: null, isDispatching: false };
    workers.set(key, state);
  }
  state.pending.push({ record, dispatcher, resolve, reject });
  scheduleDebounce(key, state);
}

function scheduleDebounce(key: string, state: WorkerState): void {
  if (state.isDispatching) {
    // Worker mid-flight. Don't restart timer — drainAndDispatch's tail will
    // start a fresh window when it sees new pending items.
    return;
  }
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    void drainAndDispatch(key, state).catch(() => undefined);
  }, readDebounceMs());
  if (typeof state.timer.unref === "function") state.timer.unref();
}

async function drainAndDispatch(key: string, state: WorkerState): Promise<void> {
  if (state.isDispatching || state.pending.length === 0) return;
  state.isDispatching = true;

  const batch = state.pending;
  state.pending = [];
  const records = batch.map((item) => item.record);
  const batchId = randomUUID();
  const startedAt = Date.now();

  let outcome: HallInboxConsumeOutcome = "dispatched";
  let reason: string | undefined;
  try {
    // Use the first item's closure — all closures for the same key share
    // the same caller context, so any of them is equivalent. The closure
    // sees the full batch via the InboxBatchContext.
    const ret = await batch[0].dispatcher({
      batchId,
      taskCardId: records[0].taskCardId,
      targetParticipantId: records[0].targetParticipantId,
      records,
    });
    if (ret && typeof ret === "object" && "outcome" in ret) {
      outcome = ret.outcome;
      if (ret.reason) reason = ret.reason;
    }
  } catch (err) {
    outcome = "failed";
    reason = err instanceof Error ? err.message : String(err);
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Math.max(0, Date.now() - startedAt);
  for (const record of records) {
    await markHallInboxConsumed({
      taskCardId: record.taskCardId,
      targetParticipantId: record.targetParticipantId,
      recordId: record.recordId,
      outcome,
      reason,
    }).catch(() => undefined);
    await appendHallDeliveryRecord({
      recordId: record.recordId,
      taskCardId: record.taskCardId,
      targetParticipantId: record.targetParticipantId,
      triggerMessageId: record.triggerMessageId,
      triggerAuthorParticipantId: record.triggerAuthorParticipantId,
      enqueueReason: record.enqueueReason,
      chainDepth: record.chainDepth,
      enqueuedAt: record.enqueuedAt,
      finishedAt,
      outcome,
      reason,
      durationMs,
      batchId,
      batchSize: records.length,
    }).catch(() => undefined);
  }

  for (const item of batch) {
    item.resolve();
  }

  state.isDispatching = false;

  if (state.pending.length > 0) {
    scheduleDebounce(key, state);
  } else {
    workers.delete(key);
  }
}

// Test helper — drop in-memory worker state between tests.
export function __resetHallSchedulerForTests(): void {
  for (const state of workers.values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  workers.clear();
}

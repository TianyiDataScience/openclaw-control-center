import {
  appendHallDeliveryRecord,
  enqueueHallInbox,
  markHallInboxConsumed,
  type HallInboxConsumeOutcome,
  type HallInboxEnqueueArgs,
  type HallInboxEnqueueRecord,
} from "./hall-mailbox";

// ---------------------------------------------------------------------------
// Phase 3-B-1 — transparent inbox scheduler
// ---------------------------------------------------------------------------
// This is the entry point every hall dispatch goes through. P3-B-1 is the
// "transparent layer" milestone: behavior is unchanged versus the pre-mailbox
// codepath (the dispatch closure is invoked synchronously from this function),
// but every dispatch now has a durable enqueue / consume / delivery record on
// disk under `{card}/.hall/`. P3-B-2 will introduce a real per-(card, agent)
// queue + 750ms defounce window on top of this scaffolding.
//
// We do NOT introduce a per-(card, agent) worker queue here. With cyclic
// auto-chain (A→B→C→…→A bounded by MAX_AUTO_CHAIN_DEPTH=5) plus an awaited
// queue, a re-entrant enqueue back to a busy worker would deadlock. Solving
// that requires defounce/buffer semantics (the worker stops awaiting individual
// dispatches and instead batches), which is the explicit P3-B-2 scope.
//
// Single-flight per dispatch is still provided by the existing per-sessionKey
// `dispatchChains` map in hall-runtime-dispatch.ts.

export interface EnqueueAndDispatchInput extends HallInboxEnqueueArgs {
  /** Human-readable reason logged on the delivery record when the outcome is
   * non-default (e.g. "skipped because chainDepth > MAX"). Optional. */
  reason?: string;
}

export interface EnqueueAndDispatchOutcomeOverride {
  outcome: HallInboxConsumeOutcome;
  reason?: string;
}

/**
 * Persist an enqueue record, run the dispatch closure, then persist the
 * consume + delivery records. Returns whatever the closure returns (or void).
 *
 * The closure may return an outcome override to record a non-default result
 * (e.g. `{ outcome: "skipped", reason: "auto-round threshold" }`). If the
 * closure returns undefined the outcome is recorded as "dispatched". Throws
 * are caught and logged as `"failed"`; the original error is rethrown so
 * the caller's `Promise.allSettled` etc. still observes it.
 */
export async function enqueueAndDispatch(
  input: EnqueueAndDispatchInput,
  dispatch: () => Promise<EnqueueAndDispatchOutcomeOverride | void>,
): Promise<void> {
  const record = await enqueueHallInbox({
    taskCardId: input.taskCardId,
    targetParticipantId: input.targetParticipantId,
    triggerMessageId: input.triggerMessageId,
    triggerAuthorParticipantId: input.triggerAuthorParticipantId,
    enqueueReason: input.enqueueReason,
    chainDepth: input.chainDepth,
  });
  const startedAt = Date.now();
  let outcome: HallInboxConsumeOutcome = "dispatched";
  let reason: string | undefined = input.reason;
  try {
    const ret = await dispatch();
    if (ret && typeof ret === "object" && "outcome" in ret) {
      outcome = ret.outcome;
      if (ret.reason) reason = ret.reason;
    }
  } catch (error) {
    outcome = "failed";
    reason = error instanceof Error ? error.message : String(error);
    await finalize(record, startedAt, outcome, reason);
    throw error;
  }
  await finalize(record, startedAt, outcome, reason);
}

async function finalize(
  record: HallInboxEnqueueRecord,
  startedAt: number,
  outcome: HallInboxConsumeOutcome,
  reason: string | undefined,
): Promise<void> {
  await markHallInboxConsumed({
    taskCardId: record.taskCardId,
    targetParticipantId: record.targetParticipantId,
    recordId: record.recordId,
    outcome,
    reason,
  });
  await appendHallDeliveryRecord({
    recordId: record.recordId,
    taskCardId: record.taskCardId,
    targetParticipantId: record.targetParticipantId,
    triggerMessageId: record.triggerMessageId,
    triggerAuthorParticipantId: record.triggerAuthorParticipantId,
    enqueueReason: record.enqueueReason,
    chainDepth: record.chainDepth,
    enqueuedAt: record.enqueuedAt,
    finishedAt: new Date().toISOString(),
    outcome,
    reason,
    durationMs: Math.max(0, Date.now() - startedAt),
  });
}

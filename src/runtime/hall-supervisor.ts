// Phase 3-C-3b — crash-recovery supervisor
// ---------------------------------------------------------------------------
// On process startup, walk every active task card's `.hall/inbox/{agent}.jsonl`
// log, hydrate any records that were enqueued but never consumed, look up the
// hall + participant + trigger message from the durable stores, and schedule a
// fresh dispatch for each one via `scheduleRecoveredHallInbox` (which routes
// through the same in-memory inbox worker as live enqueues, but does NOT write
// a duplicate enqueue line).
//
// Closures are not persistable, so the orchestrator wires the production
// dispatcher via `buildHallRecoveryDispatcher(toolClient)` and hands it to
// `recoverPendingHallInboxes`. Tests provide their own dispatcher to verify
// hydration logic without spinning up a real OpenClaw client.
//
// Pragmatic limits:
//   • Done / archived task cards are skipped — operators have no expectation
//     of recovery for completed work.
//   • Records pointing at a trigger message that no longer exists in the hall
//     message store are marked `canceled` rather than re-dispatched.
//   • Records pointing at participants no longer present on the hall (rename,
//     removal) are also marked `canceled`.
//   • `main-observer` and `wake-mention-initiator` records are not replayed —
//     their trigger semantics depend on transient context (a chain completion,
//     an observer pass) that doesn't survive a restart. Marked `canceled` with
//     a recovery reason so audit trails make the decision visible.

import {
  listHallInboxParticipantsForCard,
  markHallInboxConsumed,
  readHallInboxPending,
  sanitizeHallInboxParticipantId,
  type HallInboxEnqueueRecord,
} from "./hall-mailbox";
import { scheduleRecoveredHallInbox } from "./hall-scheduler";
import {
  getCollaborationHall,
  listHallMessages,
  listHallTaskCards,
  loadCollaborationHallMessageStore,
  loadCollaborationHallStore,
  loadCollaborationTaskCardStore,
} from "./collaboration-hall-store";
import type { InboxBatchOutcome } from "./hall-scheduler";
import type {
  CollaborationHall,
  HallMessage,
  HallParticipant,
  HallTaskCard,
} from "../types";

export interface HallRecoveryDispatchInput {
  hall: CollaborationHall;
  taskCard: HallTaskCard;
  participant: HallParticipant;
  triggerMessage: HallMessage;
  record: HallInboxEnqueueRecord;
}

export type HallRecoveryDispatcher = (
  input: HallRecoveryDispatchInput,
) => Promise<InboxBatchOutcome | void>;

export interface HallRecoveryReport {
  scheduledCount: number;
  canceledCount: number;
  skippedCount: number;
  perCard: Array<{
    taskCardId: string;
    scheduled: number;
    canceled: number;
    skipped: number;
  }>;
}

interface RecoveryDeps {
  loadTaskCards: () => Promise<HallTaskCard[]>;
  loadHallById: (hallId: string) => Promise<CollaborationHall | undefined>;
  loadHallMessagesByHallId: (hallId: string) => Promise<HallMessage[]>;
  listInboxParticipants: (taskCardId: string) => Promise<string[]>;
  readPending: (
    taskCardId: string,
    participantId: string,
  ) => Promise<HallInboxEnqueueRecord[]>;
  scheduleRecovered: (
    record: HallInboxEnqueueRecord,
    dispatcher: (batch: { records: HallInboxEnqueueRecord[] }) => Promise<InboxBatchOutcome | void>,
  ) => Promise<void>;
  markCanceled: (args: {
    taskCardId: string;
    targetParticipantId: string;
    recordId: string;
    reason: string;
  }) => Promise<void>;
}

export async function recoverPendingHallInboxes(args: {
  dispatcher: HallRecoveryDispatcher;
  deps?: Partial<RecoveryDeps>;
}): Promise<HallRecoveryReport> {
  const deps: RecoveryDeps = {
    loadTaskCards: defaultLoadTaskCards,
    loadHallById: defaultLoadHallById,
    loadHallMessagesByHallId: defaultLoadHallMessagesByHallId,
    listInboxParticipants: listHallInboxParticipantsForCard,
    readPending: readHallInboxPending,
    scheduleRecovered: (record, dispatcher) =>
      // hall-scheduler uses a richer batch context; for recovery we only need
      // `records`, so adapt with a thin wrapper.
      scheduleRecoveredHallInbox(record, async (batch) =>
        dispatcher({ records: batch.records }),
      ),
    markCanceled: ({ taskCardId, targetParticipantId, recordId, reason }) =>
      markHallInboxConsumed({
        taskCardId,
        targetParticipantId,
        recordId,
        outcome: "canceled",
        reason,
      }),
    ...args.deps,
  };

  const report: HallRecoveryReport = {
    scheduledCount: 0,
    canceledCount: 0,
    skippedCount: 0,
    perCard: [],
  };

  const taskCards = await deps.loadTaskCards();
  for (const taskCard of taskCards) {
    if (taskCard.archivedAt) continue;
    if (taskCard.status === "done") continue;

    const cardEntry = {
      taskCardId: taskCard.taskCardId,
      scheduled: 0,
      canceled: 0,
      skipped: 0,
    };
    const hall = await deps.loadHallById(taskCard.hallId);
    if (!hall) {
      // Hall was deleted; we can't reconstruct dispatch context.
      cardEntry.skipped += 1;
      report.skippedCount += 1;
      report.perCard.push(cardEntry);
      continue;
    }

    const sanitizedToParticipant = new Map<string, HallParticipant>();
    for (const participant of hall.participants) {
      sanitizedToParticipant.set(
        sanitizeHallInboxParticipantId(participant.participantId),
        participant,
      );
    }

    const sanitizedIds = await deps.listInboxParticipants(taskCard.taskCardId);
    if (sanitizedIds.length === 0) {
      continue;
    }

    let messages: HallMessage[] | undefined;
    const ensureMessages = async (): Promise<HallMessage[]> => {
      if (!messages) messages = await deps.loadHallMessagesByHallId(hall.hallId);
      return messages;
    };

    for (const sanitizedId of sanitizedIds) {
      const participant = sanitizedToParticipant.get(sanitizedId);
      const pending = await deps.readPending(
        taskCard.taskCardId,
        // readPending sanitizes internally — pass the sanitized id back; it
        // ends up the same after re-sanitization, which is fine.
        participant?.participantId ?? sanitizedId,
      );
      if (pending.length === 0) continue;

      if (!participant || !participant.active) {
        for (const record of pending) {
          await deps.markCanceled({
            taskCardId: taskCard.taskCardId,
            targetParticipantId: record.targetParticipantId,
            recordId: record.recordId,
            reason: "recovery: participant no longer active on hall",
          });
          cardEntry.canceled += 1;
          report.canceledCount += 1;
        }
        continue;
      }

      const allMessages = await ensureMessages();
      const messageById = new Map<string, HallMessage>(
        allMessages.map((m) => [m.messageId, m]),
      );

      for (const record of pending) {
        if (
          record.enqueueReason === "main-observer"
          || record.enqueueReason === "wake-mention-initiator"
        ) {
          await deps.markCanceled({
            taskCardId: taskCard.taskCardId,
            targetParticipantId: record.targetParticipantId,
            recordId: record.recordId,
            reason: `recovery: ${record.enqueueReason} not replayed`,
          });
          cardEntry.canceled += 1;
          report.canceledCount += 1;
          continue;
        }

        const triggerMessage = messageById.get(record.triggerMessageId);
        if (!triggerMessage) {
          await deps.markCanceled({
            taskCardId: taskCard.taskCardId,
            targetParticipantId: record.targetParticipantId,
            recordId: record.recordId,
            reason: "recovery: trigger message no longer present",
          });
          cardEntry.canceled += 1;
          report.canceledCount += 1;
          continue;
        }

        // Capture per-record context in the closure. The scheduler may merge
        // several recovered records into one batch; for recovery each closure
        // dispatches its own record's trigger message — the dispatcher itself
        // is responsible for handling merges if needed (production builder
        // hands the latest record's trigger to dispatchHallAgentReply, which
        // already supports `triggerMessages?` for merged batches).
        await deps.scheduleRecovered(record, async () => {
          return args.dispatcher({
            hall,
            taskCard,
            participant,
            triggerMessage,
            record,
          });
        });
        cardEntry.scheduled += 1;
        report.scheduledCount += 1;
      }
    }

    if (cardEntry.scheduled || cardEntry.canceled || cardEntry.skipped) {
      report.perCard.push(cardEntry);
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// default deps (production)
// ---------------------------------------------------------------------------

async function defaultLoadTaskCards(): Promise<HallTaskCard[]> {
  const store = await loadCollaborationTaskCardStore();
  return listHallTaskCards(store, { includeArchived: false });
}

async function defaultLoadHallById(hallId: string): Promise<CollaborationHall | undefined> {
  const store = await loadCollaborationHallStore();
  return getCollaborationHall(store, hallId);
}

async function defaultLoadHallMessagesByHallId(hallId: string): Promise<HallMessage[]> {
  const store = await loadCollaborationHallMessageStore();
  return listHallMessages(store, { hallId });
}

import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  __resetHallMailboxIndexForTests,
  buildHallInboxFilename,
  enqueueHallInbox,
  listHallInboxParticipantsForCard,
  markHallInboxConsumed,
  readHallInboxPending,
} from "../src/runtime/hall-mailbox";
import {
  __resetHallSchedulerForTests,
  scheduleRecoveredHallInbox,
} from "../src/runtime/hall-scheduler";
import {
  recoverPendingHallInboxes,
  type HallRecoveryDispatcher,
} from "../src/runtime/hall-supervisor";
import { resolveHallTaskWorkspacePath } from "../src/runtime/hall-workspace";
import type {
  CollaborationHall,
  HallMessage,
  HallParticipant,
  HallTaskCard,
} from "../src/types";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function freshCardId(prefix: string): string {
  return `supvtest-${prefix}-${randomUUID().slice(0, 8)}`;
}

async function cleanup(...taskCardIds: string[]): Promise<void> {
  for (const id of taskCardIds) {
    try {
      await rm(resolveHallTaskWorkspacePath(id), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  __resetHallMailboxIndexForTests();
  __resetHallSchedulerForTests();
}

function makeParticipant(overrides: Partial<HallParticipant> = {}): HallParticipant {
  return {
    participantId: "linus-dev",
    agentId: "linus-dev",
    displayName: "Linus",
    semanticRole: "coder",
    active: true,
    aliases: [],
    ...overrides,
  };
}

function makeHall(participants: HallParticipant[]): CollaborationHall {
  return {
    hallId: "main",
    title: "Main",
    participants,
    taskCardIds: [],
    messageIds: [],
    createdAt: "2026-04-30T00:00:00.000Z",
    updatedAt: "2026-04-30T00:00:00.000Z",
  };
}

function makeTaskCard(taskCardId: string, overrides: Partial<HallTaskCard> = {}): HallTaskCard {
  return {
    taskCardId,
    hallId: "main",
    projectId: "p1",
    taskId: "t1",
    title: "x",
    description: "y",
    status: "in_progress",
    mentionedParticipantIds: [],
    plannedExecutionOrder: [],
    plannedExecutionItems: [],
    sessionKeys: [],
    blockers: [],
    requiresInputFrom: [],
    createdByParticipantId: "operator",
    createdAt: "2026-04-30T00:00:00.000Z",
    updatedAt: "2026-04-30T00:00:00.000Z",
    ...overrides,
  };
}

function makeMessage(messageId: string, overrides: Partial<HallMessage> = {}): HallMessage {
  return {
    hallId: "main",
    messageId,
    kind: "task",
    authorParticipantId: "operator",
    authorLabel: "Operator",
    content: "hi",
    targetParticipantIds: [],
    mentionTargets: [],
    createdAt: "2026-04-30T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// listHallInboxParticipantsForCard
// ---------------------------------------------------------------------------

test("listHallInboxParticipantsForCard returns sanitized participant ids for inbox files", async () => {
  const id = freshCardId("list");
  __resetHallMailboxIndexForTests();
  try {
    await enqueueHallInbox({
      taskCardId: id,
      targetParticipantId: "linus-dev",
      triggerMessageId: "m-1",
      triggerAuthorParticipantId: "operator",
      enqueueReason: "operator-route",
      chainDepth: 0,
    });
    await enqueueHallInbox({
      taskCardId: id,
      targetParticipantId: "ada-ds",
      triggerMessageId: "m-2",
      triggerAuthorParticipantId: "operator",
      enqueueReason: "operator-route",
      chainDepth: 0,
    });

    const ids = (await listHallInboxParticipantsForCard(id)).sort();
    assert.deepEqual(ids, ["ada-ds", "linus-dev"]);
  } finally {
    await cleanup(id);
  }
});

test("listHallInboxParticipantsForCard returns empty when card has no inbox dir", async () => {
  const id = freshCardId("empty");
  const ids = await listHallInboxParticipantsForCard(id);
  assert.deepEqual(ids, []);
});

// ---------------------------------------------------------------------------
// scheduleRecoveredHallInbox
// ---------------------------------------------------------------------------

test("scheduleRecoveredHallInbox does NOT write a fresh enqueue line, but writes consume+delivery", async () => {
  const id = freshCardId("recovered");
  __resetHallMailboxIndexForTests();
  __resetHallSchedulerForTests();
  process.env.HALL_INBOX_DEBOUNCE_MS = "10";
  try {
    // Persist an enqueue line as if a previous process did it
    const record = await enqueueHallInbox({
      taskCardId: id,
      targetParticipantId: "linus-dev",
      triggerMessageId: "trig-1",
      triggerAuthorParticipantId: "operator",
      enqueueReason: "operator-route",
      chainDepth: 0,
    });
    // Simulate process restart: drop in-memory index
    __resetHallMailboxIndexForTests();
    __resetHallSchedulerForTests();

    let dispatcherCalls = 0;
    await scheduleRecoveredHallInbox(record, async (batch) => {
      dispatcherCalls += 1;
      assert.equal(batch.records.length, 1);
      assert.equal(batch.records[0].triggerMessageId, "trig-1");
      return { outcome: "dispatched" };
    });

    assert.equal(dispatcherCalls, 1);

    const path = join(
      resolveHallTaskWorkspacePath(id),
      ".hall",
      "inbox",
      buildHallInboxFilename("linus-dev"),
    );
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    // Exactly 2 lines: the original enqueue + a consume from recovery.
    // Recovery must NOT add a second enqueue.
    assert.equal(lines.length, 2);
    const ops = lines.map((l) => JSON.parse(l).op);
    assert.deepEqual(ops, ["enqueue", "consume"]);

    const deliveriesPath = join(resolveHallTaskWorkspacePath(id), ".hall", "deliveries.jsonl");
    const deliveries = (await readFile(deliveriesPath, "utf8")).trim().split("\n");
    assert.equal(deliveries.length, 1);
    assert.equal(JSON.parse(deliveries[0]).recordId, record.recordId);
  } finally {
    delete process.env.HALL_INBOX_DEBOUNCE_MS;
    await cleanup(id);
  }
});

// ---------------------------------------------------------------------------
// recoverPendingHallInboxes — happy path & filtering
// ---------------------------------------------------------------------------

test("recoverPendingHallInboxes schedules pending records and skips done/archived cards", async () => {
  const activeId = freshCardId("active");
  const doneId = freshCardId("done");
  const archivedId = freshCardId("archived");

  __resetHallMailboxIndexForTests();
  __resetHallSchedulerForTests();
  process.env.HALL_INBOX_DEBOUNCE_MS = "10";

  try {
    // Pre-populate inbox files for all three cards
    await enqueueHallInbox({
      taskCardId: activeId,
      targetParticipantId: "linus-dev",
      triggerMessageId: "msg-active",
      triggerAuthorParticipantId: "operator",
      enqueueReason: "operator-route",
      chainDepth: 0,
    });
    await enqueueHallInbox({
      taskCardId: doneId,
      targetParticipantId: "linus-dev",
      triggerMessageId: "msg-done",
      triggerAuthorParticipantId: "operator",
      enqueueReason: "operator-route",
      chainDepth: 0,
    });
    await enqueueHallInbox({
      taskCardId: archivedId,
      targetParticipantId: "linus-dev",
      triggerMessageId: "msg-archived",
      triggerAuthorParticipantId: "operator",
      enqueueReason: "operator-route",
      chainDepth: 0,
    });

    // Drop in-memory state — simulate restart
    __resetHallMailboxIndexForTests();
    __resetHallSchedulerForTests();

    const hall = makeHall([makeParticipant()]);
    const cards = [
      makeTaskCard(activeId),
      makeTaskCard(doneId, { status: "done" }),
      makeTaskCard(archivedId, { archivedAt: "2026-04-30T11:00:00.000Z" }),
    ];

    const dispatched: string[] = [];
    const dispatcher: HallRecoveryDispatcher = async ({ triggerMessage }) => {
      dispatched.push(triggerMessage.messageId);
      return { outcome: "dispatched" };
    };

    const report = await recoverPendingHallInboxes({
      dispatcher,
      deps: {
        loadTaskCards: async () => cards,
        loadHallById: async (hallId) => (hallId === "main" ? hall : undefined),
        loadHallMessagesByHallId: async () => [
          makeMessage("msg-active"),
          makeMessage("msg-done"),
          makeMessage("msg-archived"),
        ],
      },
    });

    assert.equal(report.scheduledCount, 1);
    assert.equal(report.canceledCount, 0);
    assert.deepEqual(dispatched, ["msg-active"]);

    // Done + archived cards' inbox files were not touched
    const doneInbox = join(
      resolveHallTaskWorkspacePath(doneId),
      ".hall",
      "inbox",
      buildHallInboxFilename("linus-dev"),
    );
    const doneLines = (await readFile(doneInbox, "utf8")).trim().split("\n");
    assert.equal(doneLines.length, 1);
    assert.equal(JSON.parse(doneLines[0]).op, "enqueue");
  } finally {
    delete process.env.HALL_INBOX_DEBOUNCE_MS;
    await cleanup(activeId, doneId, archivedId);
  }
});

test("recoverPendingHallInboxes cancels records whose trigger message no longer exists", async () => {
  const id = freshCardId("missingtrig");
  __resetHallMailboxIndexForTests();
  __resetHallSchedulerForTests();
  process.env.HALL_INBOX_DEBOUNCE_MS = "10";

  try {
    await enqueueHallInbox({
      taskCardId: id,
      targetParticipantId: "linus-dev",
      triggerMessageId: "ghost-msg",
      triggerAuthorParticipantId: "operator",
      enqueueReason: "operator-route",
      chainDepth: 0,
    });
    __resetHallMailboxIndexForTests();
    __resetHallSchedulerForTests();

    let dispatcherCalls = 0;
    const report = await recoverPendingHallInboxes({
      dispatcher: async () => {
        dispatcherCalls += 1;
        return { outcome: "dispatched" };
      },
      deps: {
        loadTaskCards: async () => [makeTaskCard(id)],
        loadHallById: async () => makeHall([makeParticipant()]),
        loadHallMessagesByHallId: async () => [], // no messages → trigger missing
      },
    });

    assert.equal(dispatcherCalls, 0);
    assert.equal(report.scheduledCount, 0);
    assert.equal(report.canceledCount, 1);

    // Inbox should be drained from pending after cancel-mark
    const pending = await readHallInboxPending(id, "linus-dev");
    assert.equal(pending.length, 0);

    const path = join(
      resolveHallTaskWorkspacePath(id),
      ".hall",
      "inbox",
      buildHallInboxFilename("linus-dev"),
    );
    const lines = (await readFile(path, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[1].op, "consume");
    assert.equal(lines[1].record.outcome, "canceled");
    assert.match(String(lines[1].record.reason ?? ""), /trigger message no longer present/);
  } finally {
    delete process.env.HALL_INBOX_DEBOUNCE_MS;
    await cleanup(id);
  }
});

test("recoverPendingHallInboxes cancels records for participants no longer on hall", async () => {
  const id = freshCardId("ghost-participant");
  __resetHallMailboxIndexForTests();
  __resetHallSchedulerForTests();
  process.env.HALL_INBOX_DEBOUNCE_MS = "10";

  try {
    await enqueueHallInbox({
      taskCardId: id,
      targetParticipantId: "removed-agent",
      triggerMessageId: "msg-1",
      triggerAuthorParticipantId: "operator",
      enqueueReason: "operator-route",
      chainDepth: 0,
    });
    __resetHallMailboxIndexForTests();
    __resetHallSchedulerForTests();

    const report = await recoverPendingHallInboxes({
      dispatcher: async () => ({ outcome: "dispatched" }),
      deps: {
        loadTaskCards: async () => [makeTaskCard(id)],
        loadHallById: async () => makeHall([makeParticipant()]), // removed-agent gone
        loadHallMessagesByHallId: async () => [makeMessage("msg-1")],
      },
    });

    assert.equal(report.scheduledCount, 0);
    assert.equal(report.canceledCount, 1);
    const pending = await readHallInboxPending(id, "removed-agent");
    assert.equal(pending.length, 0);
  } finally {
    delete process.env.HALL_INBOX_DEBOUNCE_MS;
    await cleanup(id);
  }
});

test("recoverPendingHallInboxes cancels main-observer + wake-mention-initiator records (transient, not replayed)", async () => {
  const id = freshCardId("transient");
  __resetHallMailboxIndexForTests();
  __resetHallSchedulerForTests();
  process.env.HALL_INBOX_DEBOUNCE_MS = "10";

  try {
    await enqueueHallInbox({
      taskCardId: id,
      targetParticipantId: "main",
      triggerMessageId: "m-obs",
      triggerAuthorParticipantId: "operator",
      enqueueReason: "main-observer",
      chainDepth: 0,
    });
    await enqueueHallInbox({
      taskCardId: id,
      targetParticipantId: "linus-dev",
      triggerMessageId: "m-wake",
      triggerAuthorParticipantId: "ada-ds",
      enqueueReason: "wake-mention-initiator",
      chainDepth: 1,
    });
    __resetHallMailboxIndexForTests();
    __resetHallSchedulerForTests();

    let dispatcherCalls = 0;
    const report = await recoverPendingHallInboxes({
      dispatcher: async () => {
        dispatcherCalls += 1;
        return { outcome: "dispatched" };
      },
      deps: {
        loadTaskCards: async () => [makeTaskCard(id)],
        loadHallById: async () =>
          makeHall([
            makeParticipant({ participantId: "main", agentId: "main", displayName: "Main" }),
            makeParticipant(),
          ]),
        loadHallMessagesByHallId: async () => [makeMessage("m-obs"), makeMessage("m-wake")],
      },
    });

    assert.equal(dispatcherCalls, 0);
    assert.equal(report.scheduledCount, 0);
    assert.equal(report.canceledCount, 2);
  } finally {
    delete process.env.HALL_INBOX_DEBOUNCE_MS;
    await cleanup(id);
  }
});

test("recoverPendingHallInboxes skips card whose hall is no longer present", async () => {
  const id = freshCardId("no-hall");
  __resetHallMailboxIndexForTests();
  __resetHallSchedulerForTests();
  process.env.HALL_INBOX_DEBOUNCE_MS = "10";

  try {
    await enqueueHallInbox({
      taskCardId: id,
      targetParticipantId: "linus-dev",
      triggerMessageId: "m",
      triggerAuthorParticipantId: "operator",
      enqueueReason: "operator-route",
      chainDepth: 0,
    });
    __resetHallMailboxIndexForTests();
    __resetHallSchedulerForTests();

    const report = await recoverPendingHallInboxes({
      dispatcher: async () => ({ outcome: "dispatched" }),
      deps: {
        loadTaskCards: async () => [makeTaskCard(id)],
        loadHallById: async () => undefined, // hall vanished
        loadHallMessagesByHallId: async () => [],
      },
    });

    assert.equal(report.scheduledCount, 0);
    assert.equal(report.canceledCount, 0);
    assert.equal(report.skippedCount, 1);
  } finally {
    delete process.env.HALL_INBOX_DEBOUNCE_MS;
    await cleanup(id);
  }
});

test("recoverPendingHallInboxes recovers multiple records for the same (card, agent) into one batch", async () => {
  const id = freshCardId("multi");
  __resetHallMailboxIndexForTests();
  __resetHallSchedulerForTests();
  process.env.HALL_INBOX_DEBOUNCE_MS = "30";

  try {
    for (const tag of ["a", "b", "c"]) {
      await enqueueHallInbox({
        taskCardId: id,
        targetParticipantId: "linus-dev",
        triggerMessageId: `m-${tag}`,
        triggerAuthorParticipantId: "operator",
        enqueueReason: "operator-route",
        chainDepth: 0,
      });
    }
    __resetHallMailboxIndexForTests();
    __resetHallSchedulerForTests();

    const batchSizes: number[] = [];
    const report = await recoverPendingHallInboxes({
      dispatcher: async ({ record }) => {
        batchSizes.push(1); // one closure call per record (closures are individual)
        return { outcome: "dispatched", reason: `replayed ${record.triggerMessageId}` };
      },
      deps: {
        loadTaskCards: async () => [makeTaskCard(id)],
        loadHallById: async () => makeHall([makeParticipant()]),
        loadHallMessagesByHallId: async () => ["m-a", "m-b", "m-c"].map((mid) => makeMessage(mid)),
      },
    });

    // 3 scheduled
    assert.equal(report.scheduledCount, 3);
    // The scheduler may merge them all into 1 batch (debounce window) — only
    // one of the closures actually runs, but recovery counts them as 3
    // scheduled because that's how many records were dispatched / consumed.
    assert.ok(batchSizes.length >= 1 && batchSizes.length <= 3);

    // After replay: pending drained, file has 3 enqueue + 3 consume lines
    const path = join(
      resolveHallTaskWorkspacePath(id),
      ".hall",
      "inbox",
      buildHallInboxFilename("linus-dev"),
    );
    const lines = (await readFile(path, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.filter((l) => l.op === "enqueue").length, 3);
    assert.equal(lines.filter((l) => l.op === "consume").length, 3);
  } finally {
    delete process.env.HALL_INBOX_DEBOUNCE_MS;
    await cleanup(id);
  }
});

// ---------------------------------------------------------------------------
// Empty / no-op input
// ---------------------------------------------------------------------------

test("recoverPendingHallInboxes returns zero report when no cards have inbox files", async () => {
  const id = freshCardId("nothing");
  const report = await recoverPendingHallInboxes({
    dispatcher: async () => ({ outcome: "dispatched" }),
    deps: {
      loadTaskCards: async () => [makeTaskCard(id)],
      loadHallById: async () => makeHall([makeParticipant()]),
      loadHallMessagesByHallId: async () => [],
    },
  });
  assert.equal(report.scheduledCount, 0);
  assert.equal(report.canceledCount, 0);
  assert.equal(report.skippedCount, 0);
  assert.deepEqual(report.perCard, []);
});

test("recoverPendingHallInboxes ignores already-consumed records", async () => {
  const id = freshCardId("consumed");
  __resetHallMailboxIndexForTests();
  __resetHallSchedulerForTests();
  process.env.HALL_INBOX_DEBOUNCE_MS = "10";

  try {
    const record = await enqueueHallInbox({
      taskCardId: id,
      targetParticipantId: "linus-dev",
      triggerMessageId: "m",
      triggerAuthorParticipantId: "operator",
      enqueueReason: "operator-route",
      chainDepth: 0,
    });
    await markHallInboxConsumed({
      taskCardId: id,
      targetParticipantId: "linus-dev",
      recordId: record.recordId,
      outcome: "dispatched",
    });
    __resetHallMailboxIndexForTests();
    __resetHallSchedulerForTests();

    let calls = 0;
    const report = await recoverPendingHallInboxes({
      dispatcher: async () => {
        calls += 1;
        return { outcome: "dispatched" };
      },
      deps: {
        loadTaskCards: async () => [makeTaskCard(id)],
        loadHallById: async () => makeHall([makeParticipant()]),
        loadHallMessagesByHallId: async () => [makeMessage("m")],
      },
    });

    assert.equal(calls, 0);
    assert.equal(report.scheduledCount, 0);
  } finally {
    delete process.env.HALL_INBOX_DEBOUNCE_MS;
    await cleanup(id);
  }
});

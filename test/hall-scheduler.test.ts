import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  __resetHallSchedulerForTests,
  enqueueAndDispatch,
  type InboxBatchContext,
  type InboxBatchOutcome,
} from "../src/runtime/hall-scheduler";
import {
  __resetHallMailboxIndexForTests,
  buildHallInboxFilename,
  readHallInboxPending,
} from "../src/runtime/hall-mailbox";
import { resolveHallTaskWorkspacePath } from "../src/runtime/hall-workspace";

function freshCardId(prefix: string): string {
  return `schedtest-${prefix}-${randomUUID().slice(0, 8)}`;
}

async function cleanup(taskCardId: string): Promise<void> {
  try {
    await rm(resolveHallTaskWorkspacePath(taskCardId), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  __resetHallMailboxIndexForTests();
  __resetHallSchedulerForTests();
}

async function readDeliveries(taskCardId: string): Promise<Record<string, unknown>[]> {
  try {
    const text = await readFile(join(resolveHallTaskWorkspacePath(taskCardId), ".hall", "deliveries.jsonl"), "utf8");
    return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const QUICK_DEBOUNCE_MS = 50;

test("worker batches concurrent enqueues into one dispatch (multi-trigger merge)", async () => {
  process.env.HALL_INBOX_DEBOUNCE_MS = String(QUICK_DEBOUNCE_MS);
  const id = freshCardId("merge");
  __resetHallSchedulerForTests();
  __resetHallMailboxIndexForTests();
  try {
    const observedBatches: InboxBatchContext[] = [];
    const dispatcher = async (batch: InboxBatchContext): Promise<InboxBatchOutcome> => {
      observedBatches.push(batch);
      return { outcome: "dispatched" };
    };

    const promises = ["a", "b", "c"].map((tag) =>
      enqueueAndDispatch(
        {
          taskCardId: id,
          targetParticipantId: "linus-dev",
          triggerMessageId: `m-${tag}`,
          triggerAuthorParticipantId: "operator",
          enqueueReason: "operator-route",
          chainDepth: 0,
        },
        dispatcher,
      ),
    );
    await Promise.all(promises);

    assert.equal(observedBatches.length, 1, `expected 1 batch, got ${observedBatches.length}`);
    assert.equal(observedBatches[0].records.length, 3);
    assert.deepEqual(
      observedBatches[0].records.map((r) => r.triggerMessageId).sort(),
      ["m-a", "m-b", "m-c"],
    );

    const deliveries = await readDeliveries(id);
    assert.equal(deliveries.length, 3);
    const batchIds = new Set(deliveries.map((d) => (d as { batchId?: string }).batchId));
    assert.equal(batchIds.size, 1, "all 3 records should share a single batchId");
    for (const d of deliveries) {
      assert.equal((d as { batchSize: number }).batchSize, 3);
      assert.equal((d as { outcome: string }).outcome, "dispatched");
    }
  } finally {
    delete process.env.HALL_INBOX_DEBOUNCE_MS;
    await cleanup(id);
  }
});

test("late-arriving enqueue past debounce window goes into its own batch", async () => {
  process.env.HALL_INBOX_DEBOUNCE_MS = String(QUICK_DEBOUNCE_MS);
  const id = freshCardId("late");
  __resetHallSchedulerForTests();
  __resetHallMailboxIndexForTests();
  try {
    const observedBatches: InboxBatchContext[] = [];
    const dispatcher = async (batch: InboxBatchContext): Promise<InboxBatchOutcome> => {
      observedBatches.push(batch);
      return { outcome: "dispatched" };
    };

    await enqueueAndDispatch(
      {
        taskCardId: id,
        targetParticipantId: "ada-ds",
        triggerMessageId: "m-1",
        triggerAuthorParticipantId: "operator",
        enqueueReason: "operator-route",
        chainDepth: 0,
      },
      dispatcher,
    );
    await new Promise((r) => setTimeout(r, QUICK_DEBOUNCE_MS * 4));
    await enqueueAndDispatch(
      {
        taskCardId: id,
        targetParticipantId: "ada-ds",
        triggerMessageId: "m-2",
        triggerAuthorParticipantId: "operator",
        enqueueReason: "operator-route",
        chainDepth: 0,
      },
      dispatcher,
    );

    assert.equal(observedBatches.length, 2);
    assert.equal(observedBatches[0].records.length, 1);
    assert.equal(observedBatches[1].records.length, 1);
    assert.notEqual(observedBatches[0].batchId, observedBatches[1].batchId);
  } finally {
    delete process.env.HALL_INBOX_DEBOUNCE_MS;
    await cleanup(id);
  }
});

test("enqueues to different (card, agent) pairs run in parallel workers", async () => {
  process.env.HALL_INBOX_DEBOUNCE_MS = String(QUICK_DEBOUNCE_MS);
  const id = freshCardId("parallel");
  __resetHallSchedulerForTests();
  __resetHallMailboxIndexForTests();
  try {
    const observedBatches: InboxBatchContext[] = [];
    const dispatcher = async (batch: InboxBatchContext): Promise<InboxBatchOutcome> => {
      observedBatches.push(batch);
      return { outcome: "dispatched" };
    };

    await Promise.all([
      enqueueAndDispatch(
        {
          taskCardId: id,
          targetParticipantId: "linus-dev",
          triggerMessageId: "m-l",
          triggerAuthorParticipantId: "operator",
          enqueueReason: "operator-route",
          chainDepth: 0,
        },
        dispatcher,
      ),
      enqueueAndDispatch(
        {
          taskCardId: id,
          targetParticipantId: "ada-ds",
          triggerMessageId: "m-a",
          triggerAuthorParticipantId: "operator",
          enqueueReason: "operator-route",
          chainDepth: 0,
        },
        dispatcher,
      ),
    ]);

    assert.equal(observedBatches.length, 2);
    const targets = new Set(observedBatches.map((b) => b.targetParticipantId));
    assert.equal(targets.size, 2);
    assert.ok(targets.has("linus-dev"));
    assert.ok(targets.has("ada-ds"));
  } finally {
    delete process.env.HALL_INBOX_DEBOUNCE_MS;
    await cleanup(id);
  }
});

test("re-entrant enqueue from inside dispatcher does not deadlock and lands in next batch", async () => {
  process.env.HALL_INBOX_DEBOUNCE_MS = String(QUICK_DEBOUNCE_MS);
  const id = freshCardId("reentrant");
  __resetHallSchedulerForTests();
  __resetHallMailboxIndexForTests();
  try {
    const observedBatches: InboxBatchContext[] = [];
    let reEnqueued = false;
    const dispatcher = async (batch: InboxBatchContext): Promise<InboxBatchOutcome> => {
      observedBatches.push(batch);
      if (!reEnqueued && batch.records.some((r) => r.triggerMessageId === "m-outer")) {
        reEnqueued = true;
        // Re-enqueue back to same (card, agent) FROM INSIDE the dispatcher.
        // Critical: this is fire-and-forget — must NOT deadlock the worker.
        void enqueueAndDispatch(
          {
            taskCardId: id,
            targetParticipantId: "linus-dev",
            triggerMessageId: "m-inner",
            triggerAuthorParticipantId: "linus-dev",
            enqueueReason: "auto-chain",
            chainDepth: 1,
          },
          dispatcher,
        ).catch(() => undefined);
      }
      return { outcome: "dispatched" };
    };

    await enqueueAndDispatch(
      {
        taskCardId: id,
        targetParticipantId: "linus-dev",
        triggerMessageId: "m-outer",
        triggerAuthorParticipantId: "operator",
        enqueueReason: "operator-route",
        chainDepth: 0,
      },
      dispatcher,
    );
    // wait for the re-enqueued batch to drain
    await new Promise((r) => setTimeout(r, QUICK_DEBOUNCE_MS * 4));

    assert.equal(observedBatches.length, 2, "outer + re-enqueued = 2 batches");
    assert.equal(observedBatches[0].records[0].triggerMessageId, "m-outer");
    assert.equal(observedBatches[1].records[0].triggerMessageId, "m-inner");
  } finally {
    delete process.env.HALL_INBOX_DEBOUNCE_MS;
    await cleanup(id);
  }
});

test("dispatcher 'failed' outcome is recorded but enqueue promise still resolves", async () => {
  process.env.HALL_INBOX_DEBOUNCE_MS = String(QUICK_DEBOUNCE_MS);
  const id = freshCardId("fail");
  __resetHallSchedulerForTests();
  __resetHallMailboxIndexForTests();
  try {
    const dispatcher = async (): Promise<InboxBatchOutcome> => {
      throw new Error("dispatch boom");
    };

    // Promise resolves — worker swallows dispatch errors so callers using
    // Promise.allSettled still get fulfilled results.
    await enqueueAndDispatch(
      {
        taskCardId: id,
        targetParticipantId: "ada-ds",
        triggerMessageId: "m-fail",
        triggerAuthorParticipantId: "operator",
        enqueueReason: "operator-route",
        chainDepth: 0,
      },
      dispatcher,
    );

    const pending = await readHallInboxPending(id, "ada-ds");
    assert.equal(pending.length, 0);

    const deliveries = await readDeliveries(id);
    assert.equal(deliveries.length, 1);
    assert.equal((deliveries[0] as { outcome: string }).outcome, "failed");
    assert.match((deliveries[0] as { reason: string }).reason, /dispatch boom/);
  } finally {
    delete process.env.HALL_INBOX_DEBOUNCE_MS;
    await cleanup(id);
  }
});

test("dispatcher outcome override is honored and persisted to delivery", async () => {
  process.env.HALL_INBOX_DEBOUNCE_MS = String(QUICK_DEBOUNCE_MS);
  const id = freshCardId("override");
  __resetHallSchedulerForTests();
  __resetHallMailboxIndexForTests();
  try {
    await enqueueAndDispatch(
      {
        taskCardId: id,
        targetParticipantId: "coq",
        triggerMessageId: "m-skip",
        triggerAuthorParticipantId: "operator",
        enqueueReason: "auto-chain",
        chainDepth: 3,
      },
      async (): Promise<InboxBatchOutcome> => ({
        outcome: "skipped",
        reason: "custom skip reason",
      }),
    );

    const deliveries = await readDeliveries(id);
    assert.equal(deliveries.length, 1);
    assert.equal((deliveries[0] as { outcome: string }).outcome, "skipped");
    assert.equal((deliveries[0] as { reason: string }).reason, "custom skip reason");
    assert.equal((deliveries[0] as { chainDepth: number }).chainDepth, 3);
  } finally {
    delete process.env.HALL_INBOX_DEBOUNCE_MS;
    await cleanup(id);
  }
});

test("inbox file records both enqueue and consume lines per record (even when batched)", async () => {
  process.env.HALL_INBOX_DEBOUNCE_MS = String(QUICK_DEBOUNCE_MS);
  const id = freshCardId("inboxfile");
  __resetHallSchedulerForTests();
  __resetHallMailboxIndexForTests();
  try {
    const dispatcher = async (): Promise<InboxBatchOutcome> => ({ outcome: "dispatched" });

    await Promise.all([
      enqueueAndDispatch(
        {
          taskCardId: id,
          targetParticipantId: "turing",
          triggerMessageId: "m-1",
          triggerAuthorParticipantId: "operator",
          enqueueReason: "operator-route",
          chainDepth: 0,
        },
        dispatcher,
      ),
      enqueueAndDispatch(
        {
          taskCardId: id,
          targetParticipantId: "turing",
          triggerMessageId: "m-2",
          triggerAuthorParticipantId: "operator",
          enqueueReason: "operator-route",
          chainDepth: 0,
        },
        dispatcher,
      ),
    ]);

    const text = await readFile(
      join(resolveHallTaskWorkspacePath(id), ".hall", "inbox", buildHallInboxFilename("turing")),
      "utf8",
    );
    const lines = text.trim().split("\n");
    // 2 enqueue + 2 consume = 4 lines (every record gets its own consume even when batched)
    assert.equal(lines.length, 4);
    const ops = lines.map((l) => JSON.parse(l).op);
    assert.equal(ops.filter((o: string) => o === "enqueue").length, 2);
    assert.equal(ops.filter((o: string) => o === "consume").length, 2);
  } finally {
    delete process.env.HALL_INBOX_DEBOUNCE_MS;
    await cleanup(id);
  }
});

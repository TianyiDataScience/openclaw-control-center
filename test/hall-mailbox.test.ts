import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  __resetHallMailboxIndexForTests,
  appendHallDeliveryRecord,
  buildHallInboxFilename,
  enqueueHallInbox,
  markHallInboxConsumed,
  readHallInboxPending,
  type HallInboxEnqueueRecord,
} from "../src/runtime/hall-mailbox";
import { resolveHallTaskWorkspacePath } from "../src/runtime/hall-workspace";

function freshCardId(prefix: string): string {
  return `mboxtest-${prefix}-${randomUUID().slice(0, 8)}`;
}

async function cleanup(taskCardId: string): Promise<void> {
  try {
    await rm(resolveHallTaskWorkspacePath(taskCardId), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  __resetHallMailboxIndexForTests();
}

test("enqueueHallInbox writes JSONL log line and surfaces record in pending", async () => {
  const id = freshCardId("enq");
  __resetHallMailboxIndexForTests();
  try {
    const record = await enqueueHallInbox({
      taskCardId: id,
      targetParticipantId: "linus-dev",
      triggerMessageId: "msg-1",
      triggerAuthorParticipantId: "operator",
      enqueueReason: "operator-route",
      chainDepth: 0,
    });
    assert.ok(record.recordId);
    assert.equal(record.targetParticipantId, "linus-dev");

    const root = resolveHallTaskWorkspacePath(id);
    const path = join(root, ".hall", "inbox", buildHallInboxFilename("linus-dev"));
    const text = await readFile(path, "utf8");
    const lines = text.trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.op, "enqueue");
    assert.equal(parsed.record.recordId, record.recordId);
    assert.equal(parsed.record.triggerMessageId, "msg-1");

    const pending = await readHallInboxPending(id, "linus-dev");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].recordId, record.recordId);
  } finally {
    await cleanup(id);
  }
});

test("markHallInboxConsumed appends consume line and removes from pending", async () => {
  const id = freshCardId("consume");
  __resetHallMailboxIndexForTests();
  try {
    const record = await enqueueHallInbox({
      taskCardId: id,
      targetParticipantId: "ada-ds",
      triggerMessageId: "msg-2",
      triggerAuthorParticipantId: "operator",
      enqueueReason: "operator-route",
      chainDepth: 0,
    });
    await markHallInboxConsumed({
      taskCardId: id,
      targetParticipantId: "ada-ds",
      recordId: record.recordId,
      outcome: "dispatched",
    });

    const pending = await readHallInboxPending(id, "ada-ds");
    assert.equal(pending.length, 0);

    const path = join(resolveHallTaskWorkspacePath(id), ".hall", "inbox", buildHallInboxFilename("ada-ds"));
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    const consumeLine = JSON.parse(lines[1]);
    assert.equal(consumeLine.op, "consume");
    assert.equal(consumeLine.record.recordId, record.recordId);
    assert.equal(consumeLine.record.outcome, "dispatched");
  } finally {
    await cleanup(id);
  }
});

test("readHallInboxPending hydrates from disk after process restart", async () => {
  const id = freshCardId("hydrate");
  __resetHallMailboxIndexForTests();
  try {
    const a = await enqueueHallInbox({
      taskCardId: id,
      targetParticipantId: "coq",
      triggerMessageId: "m-a",
      triggerAuthorParticipantId: "operator",
      enqueueReason: "operator-route",
      chainDepth: 0,
    });
    const b = await enqueueHallInbox({
      taskCardId: id,
      targetParticipantId: "coq",
      triggerMessageId: "m-b",
      triggerAuthorParticipantId: "operator",
      enqueueReason: "operator-route",
      chainDepth: 0,
    });
    await markHallInboxConsumed({
      taskCardId: id,
      targetParticipantId: "coq",
      recordId: a.recordId,
      outcome: "dispatched",
    });

    // Simulate process restart: drop in-memory index, re-read from disk.
    __resetHallMailboxIndexForTests();

    const pending = await readHallInboxPending(id, "coq");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].recordId, b.recordId);
  } finally {
    await cleanup(id);
  }
});

test("readHallInboxPending returns records sorted by enqueuedAt", async () => {
  const id = freshCardId("order");
  __resetHallMailboxIndexForTests();
  try {
    const records: HallInboxEnqueueRecord[] = [];
    for (let i = 0; i < 3; i += 1) {
      // small delay so ISO timestamps differ
      await new Promise((r) => setTimeout(r, 5));
      records.push(
        await enqueueHallInbox({
          taskCardId: id,
          targetParticipantId: "turing",
          triggerMessageId: `m-${i}`,
          triggerAuthorParticipantId: "operator",
          enqueueReason: "operator-route",
          chainDepth: 0,
        }),
      );
    }

    const pending = await readHallInboxPending(id, "turing");
    assert.deepEqual(
      pending.map((p) => p.triggerMessageId),
      ["m-0", "m-1", "m-2"],
    );
  } finally {
    await cleanup(id);
  }
});

test("appendHallDeliveryRecord appends to deliveries.jsonl", async () => {
  const id = freshCardId("delivery");
  __resetHallMailboxIndexForTests();
  try {
    await appendHallDeliveryRecord({
      recordId: "r-1",
      taskCardId: id,
      targetParticipantId: "linus-dev",
      triggerMessageId: "m-1",
      triggerAuthorParticipantId: "operator",
      enqueueReason: "operator-route",
      chainDepth: 0,
      enqueuedAt: "2026-04-29T00:00:00.000Z",
      finishedAt: "2026-04-29T00:00:01.000Z",
      outcome: "dispatched",
      durationMs: 1000,
    });
    await appendHallDeliveryRecord({
      recordId: "r-2",
      taskCardId: id,
      targetParticipantId: "linus-dev",
      triggerMessageId: "m-2",
      triggerAuthorParticipantId: "operator",
      enqueueReason: "auto-chain",
      chainDepth: 1,
      enqueuedAt: "2026-04-29T00:00:02.000Z",
      finishedAt: "2026-04-29T00:00:03.000Z",
      outcome: "failed",
      reason: "bang",
      durationMs: 1000,
    });

    const deliveries = (await readFile(join(resolveHallTaskWorkspacePath(id), ".hall", "deliveries.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[0].outcome, "dispatched");
    assert.equal(deliveries[1].outcome, "failed");
    assert.equal(deliveries[1].reason, "bang");
    assert.equal(deliveries[1].enqueueReason, "auto-chain");
  } finally {
    await cleanup(id);
  }
});

test("inbox file is namespaced by participant id", async () => {
  const id = freshCardId("ns");
  __resetHallMailboxIndexForTests();
  try {
    await enqueueHallInbox({
      taskCardId: id,
      targetParticipantId: "ada-ds",
      triggerMessageId: "m-a",
      triggerAuthorParticipantId: "operator",
      enqueueReason: "operator-route",
      chainDepth: 0,
    });
    await enqueueHallInbox({
      taskCardId: id,
      targetParticipantId: "linus-dev",
      triggerMessageId: "m-b",
      triggerAuthorParticipantId: "operator",
      enqueueReason: "operator-route",
      chainDepth: 0,
    });

    const adaPending = await readHallInboxPending(id, "ada-ds");
    const linusPending = await readHallInboxPending(id, "linus-dev");
    assert.equal(adaPending.length, 1);
    assert.equal(linusPending.length, 1);
    assert.equal(adaPending[0].triggerMessageId, "m-a");
    assert.equal(linusPending[0].triggerMessageId, "m-b");

    // Each inbox file is its own
    const adaFile = join(resolveHallTaskWorkspacePath(id), ".hall", "inbox", buildHallInboxFilename("ada-ds"));
    const linusFile = join(resolveHallTaskWorkspacePath(id), ".hall", "inbox", buildHallInboxFilename("linus-dev"));
    const adaText = await readFile(adaFile, "utf8");
    const linusText = await readFile(linusFile, "utf8");
    assert.match(adaText, /m-a/);
    assert.match(linusText, /m-b/);
    assert.ok(!adaText.includes("m-b"));
    assert.ok(!linusText.includes("m-a"));
  } finally {
    await cleanup(id);
  }
});

test("buildHallInboxFilename sanitizes participant ids", () => {
  assert.equal(buildHallInboxFilename("ada-ds"), "ada-ds.jsonl");
  assert.equal(buildHallInboxFilename("ada/.../escape"), "ada_____escape.jsonl");
  assert.equal(buildHallInboxFilename(""), "unknown.jsonl");
});

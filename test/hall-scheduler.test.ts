import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { enqueueAndDispatch } from "../src/runtime/hall-scheduler";
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
}

async function readDeliveries(taskCardId: string): Promise<Record<string, unknown>[]> {
  try {
    const text = await readFile(join(resolveHallTaskWorkspacePath(taskCardId), ".hall", "deliveries.jsonl"), "utf8");
    return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

test("enqueueAndDispatch invokes dispatch closure and records 'dispatched' outcome", async () => {
  const id = freshCardId("dispatch");
  __resetHallMailboxIndexForTests();
  try {
    let dispatched = false;
    await enqueueAndDispatch(
      {
        taskCardId: id,
        targetParticipantId: "linus-dev",
        triggerMessageId: "m-1",
        triggerAuthorParticipantId: "operator",
        enqueueReason: "operator-route",
        chainDepth: 0,
      },
      async () => {
        dispatched = true;
      },
    );
    assert.equal(dispatched, true);

    // After completion, pending must be empty
    const pending = await readHallInboxPending(id, "linus-dev");
    assert.equal(pending.length, 0);

    // Inbox file has both enqueue + consume lines
    const text = await readFile(
      join(resolveHallTaskWorkspacePath(id), ".hall", "inbox", buildHallInboxFilename("linus-dev")),
      "utf8",
    );
    const lines = text.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).op, "enqueue");
    assert.equal(JSON.parse(lines[1]).op, "consume");
    assert.equal(JSON.parse(lines[1]).record.outcome, "dispatched");

    // Delivery record persisted
    const deliveries = await readDeliveries(id);
    assert.equal(deliveries.length, 1);
    assert.equal((deliveries[0] as { outcome: string }).outcome, "dispatched");
    assert.equal((deliveries[0] as { triggerMessageId: string }).triggerMessageId, "m-1");
    assert.ok(typeof (deliveries[0] as { durationMs: number }).durationMs === "number");
  } finally {
    await cleanup(id);
  }
});

test("enqueueAndDispatch records 'failed' outcome when dispatch throws and rethrows", async () => {
  const id = freshCardId("fail");
  __resetHallMailboxIndexForTests();
  try {
    await assert.rejects(
      enqueueAndDispatch(
        {
          taskCardId: id,
          targetParticipantId: "ada-ds",
          triggerMessageId: "m-fail",
          triggerAuthorParticipantId: "operator",
          enqueueReason: "operator-route",
          chainDepth: 0,
        },
        async () => {
          throw new Error("dispatch boom");
        },
      ),
      /dispatch boom/,
    );

    const pending = await readHallInboxPending(id, "ada-ds");
    assert.equal(pending.length, 0);

    const deliveries = await readDeliveries(id);
    assert.equal(deliveries.length, 1);
    assert.equal((deliveries[0] as { outcome: string }).outcome, "failed");
    assert.match((deliveries[0] as { reason: string }).reason, /dispatch boom/);
  } finally {
    await cleanup(id);
  }
});

test("enqueueAndDispatch supports outcome override", async () => {
  const id = freshCardId("override");
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
      async () => ({ outcome: "skipped" as const, reason: "auto-round threshold" }),
    );

    const deliveries = await readDeliveries(id);
    assert.equal(deliveries.length, 1);
    assert.equal((deliveries[0] as { outcome: string }).outcome, "skipped");
    assert.equal((deliveries[0] as { reason: string }).reason, "auto-round threshold");
  } finally {
    await cleanup(id);
  }
});

test("multiple dispatches to same target serialize via per-card write chain (no interleaved log lines)", async () => {
  const id = freshCardId("serial");
  __resetHallMailboxIndexForTests();
  try {
    const tasks = ["a", "b", "c", "d", "e"].map((tag) =>
      enqueueAndDispatch(
        {
          taskCardId: id,
          targetParticipantId: "turing",
          triggerMessageId: `m-${tag}`,
          triggerAuthorParticipantId: "operator",
          enqueueReason: "operator-route",
          chainDepth: 0,
        },
        async () => {
          await new Promise((r) => setTimeout(r, 5));
        },
      ),
    );
    await Promise.all(tasks);

    const text = await readFile(
      join(resolveHallTaskWorkspacePath(id), ".hall", "inbox", buildHallInboxFilename("turing")),
      "utf8",
    );
    const lines = text.trim().split("\n");
    // 5 enqueue + 5 consume = 10 well-formed JSONL lines
    assert.equal(lines.length, 10);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.ok(parsed.op === "enqueue" || parsed.op === "consume");
    }
    const deliveries = await readDeliveries(id);
    assert.equal(deliveries.length, 5);
  } finally {
    await cleanup(id);
  }
});

test("enqueueAndDispatch persists chainDepth and enqueueReason in delivery", async () => {
  const id = freshCardId("meta");
  __resetHallMailboxIndexForTests();
  try {
    await enqueueAndDispatch(
      {
        taskCardId: id,
        targetParticipantId: "linus-dev",
        triggerMessageId: "m-meta",
        triggerAuthorParticipantId: "ada-ds",
        enqueueReason: "auto-chain",
        chainDepth: 2,
      },
      async () => undefined,
    );
    const deliveries = await readDeliveries(id);
    assert.equal(deliveries.length, 1);
    const d = deliveries[0] as Record<string, unknown>;
    assert.equal(d.chainDepth, 2);
    assert.equal(d.enqueueReason, "auto-chain");
    assert.equal(d.triggerAuthorParticipantId, "ada-ds");
  } finally {
    await cleanup(id);
  }
});

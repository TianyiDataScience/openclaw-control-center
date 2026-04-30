import assert from "node:assert/strict";
import test from "node:test";
import {
  HallExecutionLockError,
  acquireHallExecutionLock,
  assertHallExecutionAllowed,
  releaseHallExecutionLock,
} from "../src/runtime/hall-execution-lock";
import type { HallTaskCard } from "../src/types";

const baseTaskCard: HallTaskCard = {
  hallId: "main",
  taskCardId: "card-1",
  projectId: "collaboration-hall",
  taskId: "lock-test",
  title: "Execution lock",
  description: "Lock one owner at a time.",
  status: "todo",
  createdByParticipantId: "operator",
  blockers: [],
  requiresInputFrom: [],
  mentionedParticipantIds: [],
  plannedExecutionOrder: [],
  plannedExecutionItems: [],
  sessionKeys: [],
  createdAt: "2026-03-19T10:00:00.000Z",
  updatedAt: "2026-03-19T10:00:00.000Z",
};

test("hall execution lock allows one owner and blocks another", () => {
  const locked = acquireHallExecutionLock(baseTaskCard, {
    ownerParticipantId: "pandas",
    ownerLabel: "Pandas",
    at: "2026-03-19T10:01:00.000Z",
  });
  assert.equal(locked.executionLock?.ownerParticipantId, "pandas");
  assert.throws(
    () =>
      acquireHallExecutionLock(locked, {
        ownerParticipantId: "main",
        ownerLabel: "Main",
      }),
    HallExecutionLockError,
  );
  assert.doesNotThrow(() => assertHallExecutionAllowed(locked, "pandas"));
  assert.throws(() => assertHallExecutionAllowed(locked, "main"), HallExecutionLockError);
  const released = releaseHallExecutionLock(locked, "done", "2026-03-19T10:05:00.000Z");
  assert.equal(released.executionLock?.releasedReason, "done");
});

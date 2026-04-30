import type { ExecutionLock, HallTaskCard } from "../types";

export class HallExecutionLockError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 409) {
    super(message);
    this.name = "HallExecutionLockError";
    this.statusCode = statusCode;
  }
}

export function acquireHallExecutionLock(
  taskCard: HallTaskCard,
  input: { ownerParticipantId: string; ownerLabel: string; at?: string },
): HallTaskCard {
  const at = input.at ?? new Date().toISOString();
  const activeLock = taskCard.executionLock && !taskCard.executionLock.releasedAt ? taskCard.executionLock : undefined;
  if (activeLock && activeLock.ownerParticipantId !== input.ownerParticipantId) {
    throw new HallExecutionLockError(
      `${activeLock.ownerLabel} already holds execution for ${taskCard.projectId}:${taskCard.taskId}.`,
    );
  }
  const executionLock: ExecutionLock = {
    taskId: taskCard.taskId,
    projectId: taskCard.projectId,
    ownerParticipantId: input.ownerParticipantId,
    ownerLabel: input.ownerLabel,
    acquiredAt: activeLock?.acquiredAt ?? at,
  };
  return {
    ...taskCard,
    currentOwnerParticipantId: input.ownerParticipantId,
    currentOwnerLabel: input.ownerLabel,
    executionLock,
    updatedAt: at,
  };
}

export function releaseHallExecutionLock(
  taskCard: HallTaskCard,
  reason: string,
  at = new Date().toISOString(),
): HallTaskCard {
  const activeLock = taskCard.executionLock && !taskCard.executionLock.releasedAt ? taskCard.executionLock : undefined;
  if (!activeLock) return taskCard;
  return {
    ...taskCard,
    executionLock: {
      ...activeLock,
      releasedAt: at,
      releasedReason: reason,
    },
    updatedAt: at,
  };
}

// Execution-lock semantics are independent of any "stage" concept: as long as
// an execution lock exists and is unreleased, only its owner may mutate the task card.
// This guards against two operators pressing a mutation button at the same time.
export function assertHallExecutionAllowed(taskCard: HallTaskCard, participantId: string): void {
  const activeLock = taskCard.executionLock && !taskCard.executionLock.releasedAt ? taskCard.executionLock : undefined;
  if (!activeLock) return;
  if (activeLock.ownerParticipantId !== participantId) {
    throw new HallExecutionLockError(
      `${activeLock.ownerLabel} currently owns execution for ${taskCard.projectId}:${taskCard.taskId}.`,
      403,
    );
  }
}

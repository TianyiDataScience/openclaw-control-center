import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { getRuntimeDir, resolveRuntimePath } from "./runtime-path";
import { needsHumanReview } from "./hall-human-review";
import type {
  CollaborationHall,
  CollaborationHallSummary,
  CollaborationHallSummaryStoreSnapshot,
  HallMessage,
  HallTaskCard,
  HallTaskSummary,
} from "../types";

const RUNTIME_DIR = getRuntimeDir();
export const COLLABORATION_HALL_SUMMARIES_PATH = resolveRuntimePath("collaboration-hall-summaries.json");

const EMPTY_SUMMARY_STORE: CollaborationHallSummaryStoreSnapshot = {
  hallSummaries: [],
  taskSummaries: [],
  updatedAt: "1970-01-01T00:00:00.000Z",
};

export async function loadCollaborationHallSummaryStore(): Promise<CollaborationHallSummaryStoreSnapshot> {
  try {
    const raw = await readFile(COLLABORATION_HALL_SUMMARIES_PATH, "utf8");
    return normalizeSummaryStore(JSON.parse(raw));
  } catch {
    return cloneEmptySummaryStore();
  }
}

export async function saveCollaborationHallSummaryStore(
  next: CollaborationHallSummaryStoreSnapshot,
): Promise<string> {
  const normalized = normalizeSummaryStore({
    ...next,
    updatedAt: new Date().toISOString(),
  });
  await mkdir(RUNTIME_DIR, { recursive: true });
  const tempPath = `${COLLABORATION_HALL_SUMMARIES_PATH}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tempPath, JSON.stringify(normalized, null, 2), "utf8");
  await rename(tempPath, COLLABORATION_HALL_SUMMARIES_PATH);
  return COLLABORATION_HALL_SUMMARIES_PATH;
}

export function getCollaborationHallSummary(
  store: CollaborationHallSummaryStoreSnapshot,
  hallId: string,
): CollaborationHallSummary | undefined {
  return store.hallSummaries.find((summary) => summary.hallId === hallId.trim());
}

export function getHallTaskSummary(
  store: CollaborationHallSummaryStoreSnapshot,
  taskCardId: string,
): HallTaskSummary | undefined {
  return store.taskSummaries.find((summary) => summary.taskCardId === taskCardId.trim());
}

export async function upsertCollaborationHallSummary(
  hall: CollaborationHall,
  messages: HallMessage[],
  taskCards: HallTaskCard[],
): Promise<{ path: string; summary: CollaborationHallSummary }> {
  const store = await loadCollaborationHallSummaryStore();
  const summary = buildCollaborationHallSummary(hall, messages, taskCards);
  const index = store.hallSummaries.findIndex((item) => item.hallId === summary.hallId);
  if (index >= 0) store.hallSummaries[index] = summary;
  else store.hallSummaries.push(summary);
  store.updatedAt = summary.updatedAt;
  const path = await saveCollaborationHallSummaryStore(store);
  return { path, summary };
}

export async function upsertHallTaskSummary(
  taskCard: HallTaskCard,
  messages: HallMessage[],
): Promise<{ path: string; summary: HallTaskSummary }> {
  const store = await loadCollaborationHallSummaryStore();
  const summary = buildHallTaskSummary(taskCard, messages);
  const index = store.taskSummaries.findIndex((item) => item.taskCardId === summary.taskCardId);
  if (index >= 0) store.taskSummaries[index] = summary;
  else store.taskSummaries.push(summary);
  store.updatedAt = summary.updatedAt;
  const path = await saveCollaborationHallSummaryStore(store);
  return { path, summary };
}

export function buildCollaborationHallSummary(
  hall: CollaborationHall,
  messages: HallMessage[],
  taskCards: HallTaskCard[],
): CollaborationHallSummary {
  const orderedMessages = [...messages].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const lastMessage = orderedMessages.at(-1);
  const now = Date.now();
  const activeTaskCount = taskCards.filter((card) => card.status !== "done").length;
  const waitingReviewCount = messages.filter((message) => message.kind === "review").length;
  const needsHumanReviewCount = taskCards.filter((card) => needsHumanReview(card, now)).length;
  const headline =
    lastMessage?.content ??
    (activeTaskCount > 0
      ? `Hall is tracking ${activeTaskCount} active task${activeTaskCount === 1 ? "" : "s"}.`
      : "The hall is ready for the next request.");

  return {
    hallId: hall.hallId,
    headline: headline.length > 220 ? `${headline.slice(0, 217)}...` : headline,
    activeTaskCount,
    waitingReviewCount,
    needsHumanReviewCount,
    currentSpeakerLabel: lastMessage?.authorLabel,
    updatedAt: hall.updatedAt,
  };
}

export function buildHallTaskSummary(taskCard: HallTaskCard, messages: HallMessage[]): HallTaskSummary {
  const scopedMessages = messages
    .filter((message) => message.taskCardId === taskCard.taskCardId || message.taskId === taskCard.taskId)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const lastSignal = scopedMessages.at(-1);
  const headline =
    taskCard.decision ??
    taskCard.proposal ??
    taskCard.latestSummary ??
    lastSignal?.content ??
    taskCard.title;

  const nextAction = taskCard.currentOwnerParticipantId
    ? taskCard.plannedExecutionOrder.length > 0
      ? `${taskCard.currentOwnerLabel ?? "Current owner"} is driving this thread; next in queue: ${taskCard.plannedExecutionOrder[0]}.`
      : `${taskCard.currentOwnerLabel ?? "Current owner"} is driving this thread.`
    : taskCard.plannedExecutionOrder.length > 0
      ? `Confirm whether the execution order should start with ${taskCard.plannedExecutionOrder[0]}.`
      : needsHumanReview(taskCard, Date.now())
        ? "No agent activity for a while — consider marking this thread as human-reviewed or nudging it forward."
        : "Let the group chat drive this thread.";

  return {
    taskCardId: taskCard.taskCardId,
    projectId: taskCard.projectId,
    taskId: taskCard.taskId,
    headline: headline.length > 220 ? `${headline.slice(0, 217)}...` : headline,
    currentOwnerLabel: taskCard.currentOwnerLabel,
    nextAction,
    blockerCount: taskCard.blockers.length,
    updatedAt: taskCard.updatedAt,
  };
}

function normalizeSummaryStore(input: unknown): CollaborationHallSummaryStoreSnapshot {
  const root = asObject(input);
  if (!root) return cloneEmptySummaryStore();
  return {
    hallSummaries: asArray(root.hallSummaries)
      .map((item) => normalizeHallSummary(item))
      .filter((item): item is CollaborationHallSummary => Boolean(item)),
    taskSummaries: asArray(root.taskSummaries)
      .map((item) => normalizeTaskSummary(item))
      .filter((item): item is HallTaskSummary => Boolean(item)),
    updatedAt: normalizeIsoString(root.updatedAt) ?? EMPTY_SUMMARY_STORE.updatedAt,
  };
}

function normalizeHallSummary(input: unknown): CollaborationHallSummary | undefined {
  const root = asObject(input);
  if (!root) return undefined;
  const hallId = asNonEmptyString(root.hallId);
  const headline = asNonEmptyString(root.headline);
  const updatedAt = normalizeIsoString(root.updatedAt);
  if (!hallId || !headline || !updatedAt) return undefined;
  // Legacy persistence files may have `blockedTaskCount`; tolerate by reading it
  // as a fallback for `needsHumanReviewCount`.
  const needsHumanReviewCount =
    asFiniteNumber(root.needsHumanReviewCount)
    ?? asFiniteNumber(root.blockedTaskCount)
    ?? 0;
  return {
    hallId,
    headline,
    activeTaskCount: asFiniteNumber(root.activeTaskCount) ?? 0,
    waitingReviewCount: asFiniteNumber(root.waitingReviewCount) ?? 0,
    needsHumanReviewCount,
    currentSpeakerLabel: asNonEmptyString(root.currentSpeakerLabel),
    updatedAt,
  };
}

function normalizeTaskSummary(input: unknown): HallTaskSummary | undefined {
  const root = asObject(input);
  if (!root) return undefined;
  const taskCardId = asNonEmptyString(root.taskCardId);
  const projectId = asNonEmptyString(root.projectId);
  const taskId = asNonEmptyString(root.taskId);
  const headline = asNonEmptyString(root.headline);
  const updatedAt = normalizeIsoString(root.updatedAt);
  if (!taskCardId || !projectId || !taskId || !headline || !updatedAt) {
    return undefined;
  }
  return {
    taskCardId,
    projectId,
    taskId,
    headline,
    currentOwnerLabel: asNonEmptyString(root.currentOwnerLabel),
    nextAction: asNonEmptyString(root.nextAction) ?? "Open the task card and inspect the latest state.",
    blockerCount: asFiniteNumber(root.blockerCount) ?? 0,
    updatedAt,
  };
}

function cloneEmptySummaryStore(): CollaborationHallSummaryStoreSnapshot {
  return {
    hallSummaries: [],
    taskSummaries: [],
    updatedAt: EMPTY_SUMMARY_STORE.updatedAt,
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeIsoString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

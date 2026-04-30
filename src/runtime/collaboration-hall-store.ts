import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { getRuntimeDir, resolveRuntimePath } from "./runtime-path";
import { publishHallStreamEvent } from "./collaboration-stream";
import type {
  CollaborationHall,
  CollaborationHallMessageStoreSnapshot,
  CollaborationHallStoreSnapshot,
  CollaborationTaskCardStoreSnapshot,
  HallMessage,
  HallMessageKind,
  HallParticipant,
  HallTaskCard,
  MentionTarget,
} from "../types";

const RUNTIME_DIR = getRuntimeDir();
export const COLLABORATION_HALLS_PATH = resolveRuntimePath("collaboration-halls.json");
export const COLLABORATION_HALL_MESSAGES_PATH = resolveRuntimePath("collaboration-hall-messages.json");
export const COLLABORATION_TASK_CARDS_PATH = resolveRuntimePath("collaboration-task-cards.json");
export const DEFAULT_COLLABORATION_HALL_ID = "main";

const EMPTY_HALL_STORE: CollaborationHallStoreSnapshot = {
  halls: [],
  executionLocks: [],
  updatedAt: "1970-01-01T00:00:00.000Z",
};

const EMPTY_MESSAGE_STORE: CollaborationHallMessageStoreSnapshot = {
  messages: [],
  updatedAt: "1970-01-01T00:00:00.000Z",
};

const EMPTY_TASK_CARD_STORE: CollaborationTaskCardStoreSnapshot = {
  taskCards: [],
  updatedAt: "1970-01-01T00:00:00.000Z",
};

const HALL_MESSAGE_KINDS: HallMessageKind[] = [
  "chat",
  "task",
  "proposal",
  "decision",
  "handoff",
  "status",
  "review",
  "result",
  "system",
];
const HALL_MESSAGE_CONTENT_MAX_CHARS = Number.POSITIVE_INFINITY;

export class CollaborationHallStoreValidationError extends Error {
  readonly issues: string[];
  readonly statusCode: number;

  constructor(message: string, issues: string[] = [], statusCode = 400) {
    super(message);
    this.name = "CollaborationHallStoreValidationError";
    this.issues = issues;
    this.statusCode = statusCode;
  }
}

export interface CreateHallTaskCardInput {
  hallId?: string;
  taskCardId?: string;
  projectId: string;
  taskId: string;
  roomId?: string;
  title: string;
  description: string;
  status?: HallTaskCard["status"];
  createdByParticipantId: string;
  currentOwnerParticipantId?: string;
  currentOwnerLabel?: string;
  mentionedParticipantIds?: string[];
  plannedExecutionOrder?: string[];
  plannedExecutionItems?: HallTaskCard["plannedExecutionItems"];
  currentExecutionItem?: HallTaskCard["currentExecutionItem"];
  requiresInputFrom?: string[];
  blockers?: string[];
  proposal?: string;
  decision?: string;
  doneWhen?: string;
  sessionKeys?: string[];
}

export interface UpdateHallTaskCardInput {
  hallId?: string;
  taskCardId: string;
  roomId?: string | null;
  title?: string;
  description?: string;
  status?: HallTaskCard["status"];
  currentOwnerParticipantId?: string | null;
  currentOwnerLabel?: string | null;
  mentionedParticipantIds?: string[];
  plannedExecutionOrder?: string[];
  plannedExecutionItems?: HallTaskCard["plannedExecutionItems"];
  currentExecutionItem?: HallTaskCard["currentExecutionItem"] | null;
  requiresInputFrom?: string[];
  blockers?: string[];
  proposal?: string | null;
  decision?: string | null;
  doneWhen?: string | null;
  latestSummary?: string | null;
  executionLock?: HallTaskCard["executionLock"] | null;
  sessionKeys?: string[];
  parallelGroups?: HallTaskCard["parallelGroups"] | null;
  originalAssignerParticipantId?: string | null;
  autoRoundsByAgent?: Record<string, number> | null;
  humanReviewedAt?: string | null;
  lastAgentActivityAt?: string | null;
  archivedAt?: string | null;
  archivedByParticipantId?: string | null;
  archivedByLabel?: string | null;
}

export interface ArchiveHallTaskCardInput {
  taskCardId: string;
  archivedByParticipantId?: string;
  archivedByLabel?: string;
}

export interface DeleteHallTaskCardInput {
  taskCardId: string;
}

export interface DeleteHallMessagesForTaskCardInput {
  hallId?: string;
  taskCardId: string;
  taskId?: string;
  roomId?: string;
}

export interface AppendHallMessageInput {
  hallId?: string;
  messageId?: string;
  kind?: HallMessageKind;
  authorParticipantId: string;
  authorLabel: string;
  authorSemanticRole?: HallMessage["authorSemanticRole"];
  content: string;
  targetParticipantIds?: string[];
  mentionTargets?: MentionTarget[];
  projectId?: string;
  taskId?: string;
  taskCardId?: string;
  roomId?: string;
  payload?: HallMessage["payload"];
  createdAt?: string;
}

export async function loadCollaborationHallStore(): Promise<CollaborationHallStoreSnapshot> {
  try {
    const raw = await readFile(COLLABORATION_HALLS_PATH, "utf8");
    return normalizeHallStore(JSON.parse(raw));
  } catch {
    return cloneEmptyHallStore();
  }
}

export async function loadCollaborationHallMessageStore(): Promise<CollaborationHallMessageStoreSnapshot> {
  try {
    const raw = await readFile(COLLABORATION_HALL_MESSAGES_PATH, "utf8");
    return normalizeHallMessageStore(JSON.parse(raw));
  } catch {
    return cloneEmptyMessageStore();
  }
}

export async function loadCollaborationTaskCardStore(): Promise<CollaborationTaskCardStoreSnapshot> {
  try {
    const raw = await readFile(COLLABORATION_TASK_CARDS_PATH, "utf8");
    return normalizeTaskCardStore(JSON.parse(raw));
  } catch {
    return cloneEmptyTaskCardStore();
  }
}

export async function saveCollaborationHallStore(next: CollaborationHallStoreSnapshot): Promise<string> {
  const normalized = normalizeHallStore({
    ...next,
    updatedAt: new Date().toISOString(),
  });
  await writeRuntimeJsonAtomically(COLLABORATION_HALLS_PATH, normalized);
  return COLLABORATION_HALLS_PATH;
}

export async function saveCollaborationHallMessageStore(
  next: CollaborationHallMessageStoreSnapshot,
): Promise<string> {
  const normalized = normalizeHallMessageStore({
    ...next,
    updatedAt: new Date().toISOString(),
  });
  await writeRuntimeJsonAtomically(COLLABORATION_HALL_MESSAGES_PATH, normalized);
  return COLLABORATION_HALL_MESSAGES_PATH;
}

export async function saveCollaborationTaskCardStore(next: CollaborationTaskCardStoreSnapshot): Promise<string> {
  const normalized = normalizeTaskCardStore({
    ...next,
    updatedAt: new Date().toISOString(),
  });
  await writeRuntimeJsonAtomically(COLLABORATION_TASK_CARDS_PATH, normalized);
  return COLLABORATION_TASK_CARDS_PATH;
}

async function writeRuntimeJsonAtomically(targetPath: string, payload: unknown): Promise<void> {
  await mkdir(RUNTIME_DIR, { recursive: true });
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
  await rename(tempPath, targetPath);
}

export async function ensureDefaultCollaborationHall(participants: HallParticipant[]): Promise<CollaborationHall> {
  const store = await loadCollaborationHallStore();
  const existing = store.halls.find((hall) => hall.hallId === DEFAULT_COLLABORATION_HALL_ID);
  const now = new Date().toISOString();
  if (existing) {
    existing.participants = normalizeParticipants(participants);
    existing.updatedAt = now;
    store.updatedAt = now;
    await saveCollaborationHallStore(store);
    return existing;
  }

  const hall: CollaborationHall = {
    hallId: DEFAULT_COLLABORATION_HALL_ID,
    title: "Collaboration Hall",
    description: "The shared control-center group chat for task discussion, assignment, execution, and review.",
    participants: normalizeParticipants(participants),
    taskCardIds: [],
    messageIds: [],
    lastMessageId: null,
    createdAt: now,
    updatedAt: now,
  };
  store.halls.push(hall);
  store.updatedAt = now;
  await saveCollaborationHallStore(store);
  return hall;
}

export function getCollaborationHall(
  store: CollaborationHallStoreSnapshot,
  hallId = DEFAULT_COLLABORATION_HALL_ID,
): CollaborationHall | undefined {
  return store.halls.find((hall) => hall.hallId === hallId);
}

export function listCollaborationHalls(store: CollaborationHallStoreSnapshot): CollaborationHall[] {
  return [...store.halls].sort((a, b) => a.hallId.localeCompare(b.hallId));
}

export function listHallMessages(
  store: CollaborationHallMessageStoreSnapshot,
  options?: { hallId?: string; taskCardId?: string; taskId?: string; limit?: number },
): HallMessage[] {
  const filtered = store.messages
    .filter((message) => !options?.hallId || message.hallId === options.hallId)
    .filter((message) => !options?.taskCardId || message.taskCardId === options.taskCardId)
    .filter((message) => !options?.taskId || message.taskId === options.taskId)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return options?.limit ? filtered.slice(-options.limit) : filtered;
}

export function listHallTaskCards(
  store: CollaborationTaskCardStoreSnapshot,
  options?: { hallId?: string; includeArchived?: boolean },
): HallTaskCard[] {
  return store.taskCards
    .filter((card) => !options?.hallId || card.hallId === options.hallId)
    .filter((card) => options?.includeArchived === true || !card.archivedAt)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function getHallTaskCard(
  store: CollaborationTaskCardStoreSnapshot,
  taskCardId: string,
): HallTaskCard | undefined {
  return store.taskCards.find((card) => card.taskCardId === taskCardId.trim());
}

export function getHallTaskCardByTask(
  store: CollaborationTaskCardStoreSnapshot,
  projectId: string,
  taskId: string,
): HallTaskCard | undefined {
  const normalizedProjectId = projectId.trim();
  const normalizedTaskId = taskId.trim();
  return store.taskCards.find((card) => card.projectId === normalizedProjectId && card.taskId === normalizedTaskId);
}

export async function createHallTaskCard(input: CreateHallTaskCardInput): Promise<{ path: string; hallPath: string; taskCard: HallTaskCard }> {
  const payload = validateCreateHallTaskCardInput(input);
  const [hallStore, taskCardStore] = await Promise.all([
    loadCollaborationHallStore(),
    loadCollaborationTaskCardStore(),
  ]);
  const hall = getCollaborationHall(hallStore, payload.hallId);
  if (!hall) {
    throw new CollaborationHallStoreValidationError(`hall '${payload.hallId}' was not found.`, ["hallId"], 404);
  }
  if (getHallTaskCardByTask(taskCardStore, payload.projectId, payload.taskId)) {
    throw new CollaborationHallStoreValidationError(
      `task '${payload.projectId}:${payload.taskId}' already has a hall task card.`,
      ["taskId"],
      409,
    );
  }

  const now = new Date().toISOString();
  const taskCard: HallTaskCard = {
    hallId: hall.hallId,
    taskCardId: payload.taskCardId ?? `${payload.projectId}:${payload.taskId}`,
    projectId: payload.projectId,
    taskId: payload.taskId,
    roomId: payload.roomId,
    title: payload.title,
    description: payload.description,
    status: payload.status ?? "todo",
    createdByParticipantId: payload.createdByParticipantId,
    currentOwnerParticipantId: payload.currentOwnerParticipantId,
    currentOwnerLabel: payload.currentOwnerLabel,
    blockers: payload.blockers ?? [],
    requiresInputFrom: payload.requiresInputFrom ?? [],
    mentionedParticipantIds: payload.mentionedParticipantIds ?? [],
    plannedExecutionOrder: payload.plannedExecutionOrder ?? [],
    plannedExecutionItems: payload.plannedExecutionItems ?? [],
    currentExecutionItem: payload.currentExecutionItem,
    sessionKeys: payload.sessionKeys ?? [],
    proposal: payload.proposal,
    decision: payload.decision,
    doneWhen: payload.doneWhen,
    archivedAt: undefined,
    archivedByParticipantId: undefined,
    archivedByLabel: undefined,
    createdAt: now,
    updatedAt: now,
  };

  taskCardStore.taskCards.push(taskCard);
  taskCardStore.updatedAt = now;
  hall.taskCardIds = [...new Set([...hall.taskCardIds, taskCard.taskCardId])];
  hall.updatedAt = now;
  hallStore.updatedAt = now;

  const [hallPath, path] = await Promise.all([
    saveCollaborationHallStore(hallStore),
    saveCollaborationTaskCardStore(taskCardStore),
  ]);
  publishHallStreamEvent({
    type: "invalidate",
    hallId: hall.hallId,
    taskCardId: taskCard.taskCardId,
    projectId: taskCard.projectId,
    taskId: taskCard.taskId,
    roomId: taskCard.roomId,
    reason: "task_created",
  });
  return { hallPath, path, taskCard };
}

/**
 * Serialization chain for task card writes.
 * Prevents lost updates when multiple parallel agents complete simultaneously
 * and try to update the same task card (load-modify-save race).
 * Single Node.js process — a promise chain is sufficient.
 */
let taskCardWriteChain: Promise<unknown> = Promise.resolve();

export function updateHallTaskCard(input: UpdateHallTaskCardInput): Promise<{ path: string; taskCard: HallTaskCard }> {
  const result = taskCardWriteChain.then(() => updateHallTaskCardUnsafe(input));
  taskCardWriteChain = result.catch(() => undefined);
  return result;
}

async function updateHallTaskCardUnsafe(input: UpdateHallTaskCardInput): Promise<{ path: string; taskCard: HallTaskCard }> {
  const payload = validateUpdateHallTaskCardInput(input);
  const taskCardStore = await loadCollaborationTaskCardStore();
  const taskCard = getHallTaskCard(taskCardStore, payload.taskCardId);
  if (!taskCard) {
    throw new CollaborationHallStoreValidationError(`task card '${payload.taskCardId}' was not found.`, ["taskCardId"], 404);
  }

  const now = new Date().toISOString();
  if (payload.roomId !== undefined) taskCard.roomId = payload.roomId ?? undefined;
  if (payload.title !== undefined) taskCard.title = payload.title;
  if (payload.description !== undefined) taskCard.description = payload.description;
  if (payload.status !== undefined) taskCard.status = payload.status;
  if (payload.currentOwnerParticipantId !== undefined) {
    taskCard.currentOwnerParticipantId = payload.currentOwnerParticipantId ?? undefined;
  }
  if (payload.currentOwnerLabel !== undefined) {
    taskCard.currentOwnerLabel = payload.currentOwnerLabel ?? undefined;
  }
  if (payload.mentionedParticipantIds !== undefined) taskCard.mentionedParticipantIds = payload.mentionedParticipantIds;
  if (payload.plannedExecutionOrder !== undefined) taskCard.plannedExecutionOrder = payload.plannedExecutionOrder;
  if (payload.plannedExecutionItems !== undefined) taskCard.plannedExecutionItems = payload.plannedExecutionItems;
  if (payload.currentExecutionItem !== undefined) taskCard.currentExecutionItem = payload.currentExecutionItem ?? undefined;
  if (payload.requiresInputFrom !== undefined) taskCard.requiresInputFrom = payload.requiresInputFrom;
  if (payload.blockers !== undefined) taskCard.blockers = payload.blockers;
  if (payload.proposal !== undefined) taskCard.proposal = payload.proposal ?? undefined;
  if (payload.decision !== undefined) taskCard.decision = payload.decision ?? undefined;
  if (payload.doneWhen !== undefined) taskCard.doneWhen = payload.doneWhen ?? undefined;
  if (payload.latestSummary !== undefined) taskCard.latestSummary = payload.latestSummary ?? undefined;
  if (payload.executionLock !== undefined) taskCard.executionLock = payload.executionLock ?? undefined;
  if (payload.parallelGroups !== undefined) taskCard.parallelGroups = payload.parallelGroups ?? undefined;
  if (payload.humanReviewedAt !== undefined) taskCard.humanReviewedAt = payload.humanReviewedAt ?? undefined;
  if (payload.lastAgentActivityAt !== undefined) taskCard.lastAgentActivityAt = payload.lastAgentActivityAt ?? undefined;
  if (payload.sessionKeys !== undefined) taskCard.sessionKeys = payload.sessionKeys;
  if (payload.originalAssignerParticipantId !== undefined) {
    taskCard.originalAssignerParticipantId = payload.originalAssignerParticipantId ?? undefined;
  }
  if (payload.autoRoundsByAgent !== undefined) {
    taskCard.autoRoundsByAgent = payload.autoRoundsByAgent ?? undefined;
  }
  if (payload.archivedAt !== undefined) taskCard.archivedAt = payload.archivedAt ?? undefined;
  if (payload.archivedByParticipantId !== undefined) {
    taskCard.archivedByParticipantId = payload.archivedByParticipantId ?? undefined;
  }
  if (payload.archivedByLabel !== undefined) taskCard.archivedByLabel = payload.archivedByLabel ?? undefined;
  taskCard.updatedAt = now;
  taskCardStore.updatedAt = now;

  const path = await saveCollaborationTaskCardStore(taskCardStore);
  publishHallStreamEvent({
    type: "invalidate",
    hallId: taskCard.hallId,
    taskCardId: taskCard.taskCardId,
    projectId: taskCard.projectId,
    taskId: taskCard.taskId,
    roomId: taskCard.roomId,
    reason: "task_updated",
  });
  return { path, taskCard };
}

export async function archiveHallTaskCard(
  input: ArchiveHallTaskCardInput,
): Promise<{ path: string; taskCard: HallTaskCard }> {
  const payload = validateArchiveHallTaskCardInput(input);
  return updateHallTaskCard({
    taskCardId: payload.taskCardId,
    archivedAt: new Date().toISOString(),
    archivedByParticipantId: payload.archivedByParticipantId,
    archivedByLabel: payload.archivedByLabel,
  });
}

export async function deleteHallTaskCard(
  input: DeleteHallTaskCardInput,
): Promise<{ path: string; hallPath: string; taskCard: HallTaskCard }> {
  const payload = validateDeleteHallTaskCardInput(input);
  const [hallStore, taskCardStore] = await Promise.all([
    loadCollaborationHallStore(),
    loadCollaborationTaskCardStore(),
  ]);
  const taskCard = getHallTaskCard(taskCardStore, payload.taskCardId);
  if (!taskCard) {
    throw new CollaborationHallStoreValidationError(`task card '${payload.taskCardId}' was not found.`, ["taskCardId"], 404);
  }

  taskCardStore.taskCards = taskCardStore.taskCards.filter((card) => card.taskCardId !== payload.taskCardId);
  const now = new Date().toISOString();
  taskCardStore.updatedAt = now;
  const hall = getCollaborationHall(hallStore, taskCard.hallId);
  if (hall) {
    hall.taskCardIds = hall.taskCardIds.filter((taskCardId) => taskCardId !== payload.taskCardId);
    hall.updatedAt = now;
    hallStore.updatedAt = now;
  }

  const [hallPath, path] = await Promise.all([
    saveCollaborationHallStore(hallStore),
    saveCollaborationTaskCardStore(taskCardStore),
  ]);
  publishHallStreamEvent({
    type: "invalidate",
    hallId: taskCard.hallId,
    taskCardId: taskCard.taskCardId,
    projectId: taskCard.projectId,
    taskId: taskCard.taskId,
    roomId: taskCard.roomId,
    reason: "task_deleted",
  });
  return { hallPath, path, taskCard };
}

export async function deleteHallMessagesForTaskCard(
  input: DeleteHallMessagesForTaskCardInput,
): Promise<{ path: string; hallPath: string; removedCount: number }> {
  const payload = validateDeleteHallMessagesForTaskCardInput(input);
  const [hallStore, messageStore] = await Promise.all([
    loadCollaborationHallStore(),
    loadCollaborationHallMessageStore(),
  ]);
  const hall = getCollaborationHall(hallStore, payload.hallId);
  if (!hall) {
    throw new CollaborationHallStoreValidationError(`hall '${payload.hallId}' was not found.`, ["hallId"], 404);
  }

  const nextMessages = messageStore.messages.filter((message) => {
    if (message.hallId !== payload.hallId) return true;
    if (message.taskCardId === payload.taskCardId) return false;
    if (!message.taskCardId && payload.taskId && message.taskId === payload.taskId) {
      if (!payload.roomId || message.roomId === payload.roomId) return false;
    }
    return true;
  });
  const removedCount = messageStore.messages.length - nextMessages.length;
  if (removedCount === 0) {
    return {
      path: COLLABORATION_HALL_MESSAGES_PATH,
      hallPath: COLLABORATION_HALLS_PATH,
      removedCount: 0,
    };
  }

  const remainingHallMessages = nextMessages
    .filter((message) => message.hallId === payload.hallId)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const lastMessage = remainingHallMessages.at(-1);
  const now = new Date().toISOString();
  messageStore.messages = nextMessages;
  messageStore.updatedAt = now;
  hall.messageIds = remainingHallMessages.map((message) => message.messageId);
  hall.lastMessageId = lastMessage?.messageId ?? null;
  hall.latestMessageAt = lastMessage?.createdAt;
  hall.updatedAt = now;
  hallStore.updatedAt = now;

  const [hallPath, path] = await Promise.all([
    saveCollaborationHallStore(hallStore),
    saveCollaborationHallMessageStore(messageStore),
  ]);
  publishHallStreamEvent({
    type: "invalidate",
    hallId: payload.hallId,
    taskCardId: payload.taskCardId,
    taskId: payload.taskId,
    roomId: payload.roomId,
    reason: "task_messages_deleted",
  });
  return { hallPath, path, removedCount };
}

/**
 * Serialization chain for hall message writes.
 * Same rationale as taskCardWriteChain — prevents lost updates
 * when parallel agents append messages concurrently.
 */
let hallMessageWriteChain: Promise<unknown> = Promise.resolve();

export function appendHallMessage(input: AppendHallMessageInput): Promise<{ path: string; hallPath: string; message: HallMessage }> {
  const result = hallMessageWriteChain.then(() => appendHallMessageUnsafe(input));
  hallMessageWriteChain = result.catch(() => undefined);
  return result;
}

async function appendHallMessageUnsafe(input: AppendHallMessageInput): Promise<{ path: string; hallPath: string; message: HallMessage }> {
  const payload = validateAppendHallMessageInput(input);
  const [hallStore, messageStore] = await Promise.all([
    loadCollaborationHallStore(),
    loadCollaborationHallMessageStore(),
  ]);
  const hall = getCollaborationHall(hallStore, payload.hallId);
  if (!hall) {
    throw new CollaborationHallStoreValidationError(`hall '${payload.hallId}' was not found.`, ["hallId"], 404);
  }

  const message: HallMessage = {
    hallId: hall.hallId,
    messageId: payload.messageId ?? randomUUID(),
    kind: payload.kind ?? "chat",
    authorParticipantId: payload.authorParticipantId,
    authorLabel: payload.authorLabel,
    authorSemanticRole: payload.authorSemanticRole,
    content: payload.content,
    targetParticipantIds: payload.targetParticipantIds ?? [],
    mentionTargets: payload.mentionTargets ?? [],
    projectId: payload.projectId,
    taskId: payload.taskId,
    taskCardId: payload.taskCardId,
    roomId: payload.roomId,
    payload: payload.payload,
    createdAt: payload.createdAt ?? new Date().toISOString(),
  };

  messageStore.messages.push(message);
  messageStore.updatedAt = message.createdAt;
  hall.messageIds = [...new Set([...hall.messageIds, message.messageId])];
  hall.lastMessageId = message.messageId;
  hall.latestMessageAt = message.createdAt;
  hall.updatedAt = message.createdAt;
  hallStore.updatedAt = message.createdAt;

  const [hallPath, path] = await Promise.all([
    saveCollaborationHallStore(hallStore),
    saveCollaborationHallMessageStore(messageStore),
  ]);
  publishHallStreamEvent({
    type: "invalidate",
    hallId: hall.hallId,
    taskCardId: message.taskCardId,
    projectId: message.projectId,
    taskId: message.taskId,
    roomId: message.roomId,
    reason: "message_created",
    messageId: message.messageId,
    messageKind: message.kind,
    authorParticipantId: message.authorParticipantId,
    authorLabel: message.authorLabel,
    authorSemanticRole: message.authorSemanticRole,
  });
  return { hallPath, path, message };
}

function validateCreateHallTaskCardInput(input: CreateHallTaskCardInput): CreateHallTaskCardInput & { hallId: string } {
  const issues: string[] = [];
  const hallId = optionalString(input.hallId, "hallId", 120, issues) ?? DEFAULT_COLLABORATION_HALL_ID;
  const projectId = requiredString(input.projectId, "projectId", 120, issues);
  const taskId = requiredString(input.taskId, "taskId", 120, issues);
  const roomId = optionalString(input.roomId, "roomId", 180, issues);
  const title = requiredString(input.title, "title", 180, issues);
  const description = requiredString(input.description, "description", 4000, issues);
  const createdByParticipantId = requiredString(input.createdByParticipantId, "createdByParticipantId", 160, issues);
  const taskCardId = optionalString(input.taskCardId, "taskCardId", 180, issues);
  const currentOwnerParticipantId = optionalString(input.currentOwnerParticipantId, "currentOwnerParticipantId", 160, issues);
  const currentOwnerLabel = optionalString(input.currentOwnerLabel, "currentOwnerLabel", 120, issues);
  const status = optionalTaskStatus(input.status, "status", issues);
  const blockers = optionalStringArray(input.blockers, "blockers", 240, issues);
  const requiresInputFrom = optionalStringArray(input.requiresInputFrom, "requiresInputFrom", 120, issues);
  const mentionedParticipantIds = optionalStringArray(input.mentionedParticipantIds, "mentionedParticipantIds", 120, issues);
  const proposal = optionalString(input.proposal, "proposal", 1200, issues);
  const decision = optionalString(input.decision, "decision", 1200, issues);
  const doneWhen = optionalString(input.doneWhen, "doneWhen", 240, issues);
  const plannedExecutionOrder = optionalStringArray(input.plannedExecutionOrder, "plannedExecutionOrder", 160, issues);
  const plannedExecutionItems = optionalExecutionItems(input.plannedExecutionItems, "plannedExecutionItems", issues);
  const currentExecutionItem = optionalExecutionItem(input.currentExecutionItem, "currentExecutionItem", issues);
  const sessionKeys = optionalStringArray(input.sessionKeys, "sessionKeys", 240, issues);

  if (issues.length > 0) {
    throw new CollaborationHallStoreValidationError("Invalid hall task card payload.", issues);
  }

  return {
    hallId,
    taskCardId,
    projectId,
    taskId,
    roomId,
    title,
    description,
    status,
    createdByParticipantId,
    currentOwnerParticipantId,
    currentOwnerLabel,
    blockers,
    requiresInputFrom,
    mentionedParticipantIds,
    plannedExecutionOrder,
    plannedExecutionItems,
    currentExecutionItem,
    proposal,
    decision,
    doneWhen,
    sessionKeys,
  };
}

function validateUpdateHallTaskCardInput(input: UpdateHallTaskCardInput): UpdateHallTaskCardInput {
  const issues: string[] = [];
  const taskCardId = requiredString(input.taskCardId, "taskCardId", 180, issues);
  const title = input.title === undefined ? undefined : requiredString(input.title, "title", 180, issues);
  const description =
    input.description === undefined ? undefined : requiredString(input.description, "description", 4000, issues);
  const roomId = input.roomId === undefined
    ? undefined
    : input.roomId === null
      ? null
      : optionalString(input.roomId, "roomId", 180, issues);
  const currentOwnerParticipantId =
    input.currentOwnerParticipantId === undefined
      ? undefined
      : input.currentOwnerParticipantId === null
        ? null
        : optionalString(input.currentOwnerParticipantId, "currentOwnerParticipantId", 160, issues);
  const currentOwnerLabel =
    input.currentOwnerLabel === undefined
      ? undefined
      : input.currentOwnerLabel === null
        ? null
        : optionalString(input.currentOwnerLabel, "currentOwnerLabel", 120, issues);
  const status = input.status === undefined ? undefined : optionalTaskStatus(input.status, "status", issues);
  const blockers = input.blockers === undefined ? undefined : optionalStringArray(input.blockers, "blockers", 240, issues);
  const requiresInputFrom =
    input.requiresInputFrom === undefined
      ? undefined
      : optionalStringArray(input.requiresInputFrom, "requiresInputFrom", 120, issues);
  const mentionedParticipantIds =
    input.mentionedParticipantIds === undefined
      ? undefined
      : optionalStringArray(input.mentionedParticipantIds, "mentionedParticipantIds", 120, issues);
  const plannedExecutionOrder =
    input.plannedExecutionOrder === undefined
      ? undefined
      : optionalStringArray(input.plannedExecutionOrder, "plannedExecutionOrder", 160, issues);
  const plannedExecutionItems =
    input.plannedExecutionItems === undefined
      ? undefined
      : optionalExecutionItems(input.plannedExecutionItems, "plannedExecutionItems", issues);
  const currentExecutionItem =
    input.currentExecutionItem === undefined
      ? undefined
      : input.currentExecutionItem === null
        ? null
        : optionalExecutionItem(input.currentExecutionItem, "currentExecutionItem", issues);
  const proposal = input.proposal === undefined
    ? undefined
    : input.proposal === null
      ? null
      : optionalString(input.proposal, "proposal", 1200, issues);
  const decision = input.decision === undefined
    ? undefined
    : input.decision === null
      ? null
      : optionalString(input.decision, "decision", 1200, issues);
  const doneWhen = input.doneWhen === undefined
    ? undefined
    : input.doneWhen === null
      ? null
      : optionalString(input.doneWhen, "doneWhen", 240, issues);
  const latestSummary =
    input.latestSummary === undefined
      ? undefined
      : input.latestSummary === null
        ? null
        : optionalString(input.latestSummary, "latestSummary", 600, issues);
  const archivedAt =
    input.archivedAt === undefined
      ? undefined
      : input.archivedAt === null
        ? null
        : optionalIsoString(input.archivedAt, "archivedAt", issues);
  const archivedByParticipantId =
    input.archivedByParticipantId === undefined
      ? undefined
      : input.archivedByParticipantId === null
        ? null
        : optionalString(input.archivedByParticipantId, "archivedByParticipantId", 160, issues);
  const archivedByLabel =
    input.archivedByLabel === undefined
      ? undefined
      : input.archivedByLabel === null
        ? null
        : optionalString(input.archivedByLabel, "archivedByLabel", 120, issues);
  const sessionKeys =
    input.sessionKeys === undefined ? undefined : optionalStringArray(input.sessionKeys, "sessionKeys", 240, issues);
  const originalAssignerParticipantId =
    input.originalAssignerParticipantId === undefined
      ? undefined
      : input.originalAssignerParticipantId === null
        ? null
        : optionalString(input.originalAssignerParticipantId, "originalAssignerParticipantId", 160, issues);
  const autoRoundsByAgent =
    input.autoRoundsByAgent === undefined
      ? undefined
      : input.autoRoundsByAgent === null
        ? null
        : validateAutoRoundsByAgent(input.autoRoundsByAgent, issues);

  if (issues.length > 0) {
    throw new CollaborationHallStoreValidationError("Invalid hall task card patch payload.", issues);
  }

  return {
    ...input,
    taskCardId,
    title,
    description,
    roomId,
    currentOwnerParticipantId,
    currentOwnerLabel,
    status,
    blockers,
    requiresInputFrom,
    mentionedParticipantIds,
    plannedExecutionOrder,
    plannedExecutionItems,
    currentExecutionItem,
    proposal,
    decision,
    doneWhen,
    latestSummary,
    archivedAt,
    archivedByParticipantId,
    archivedByLabel,
    sessionKeys,
    originalAssignerParticipantId,
    autoRoundsByAgent,
  };
}

function validateAutoRoundsByAgent(
  input: unknown,
  issues: string[],
): Record<string, number> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    issues.push("autoRoundsByAgent");
    return undefined;
  }
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const trimmedKey = String(key || "").trim();
    if (!trimmedKey || trimmedKey.length > 160) {
      issues.push("autoRoundsByAgent");
      return undefined;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
      issues.push("autoRoundsByAgent");
      return undefined;
    }
    result[trimmedKey] = Math.floor(value);
  }
  return result;
}

function validateArchiveHallTaskCardInput(input: ArchiveHallTaskCardInput): ArchiveHallTaskCardInput {
  const issues: string[] = [];
  const taskCardId = requiredString(input.taskCardId, "taskCardId", 180, issues);
  const archivedByParticipantId = optionalString(input.archivedByParticipantId, "archivedByParticipantId", 160, issues);
  const archivedByLabel = optionalString(input.archivedByLabel, "archivedByLabel", 120, issues);
  if (issues.length > 0) {
    throw new CollaborationHallStoreValidationError("Invalid hall task archive payload.", issues);
  }
  return {
    taskCardId,
    archivedByParticipantId,
    archivedByLabel,
  };
}

function validateDeleteHallTaskCardInput(input: DeleteHallTaskCardInput): DeleteHallTaskCardInput {
  const issues: string[] = [];
  const taskCardId = requiredString(input.taskCardId, "taskCardId", 180, issues);
  if (issues.length > 0) {
    throw new CollaborationHallStoreValidationError("Invalid hall task delete payload.", issues);
  }
  return { taskCardId };
}

function validateDeleteHallMessagesForTaskCardInput(
  input: DeleteHallMessagesForTaskCardInput,
): DeleteHallMessagesForTaskCardInput & { hallId: string } {
  const issues: string[] = [];
  const hallId = optionalString(input.hallId, "hallId", 120, issues) ?? DEFAULT_COLLABORATION_HALL_ID;
  const taskCardId = requiredString(input.taskCardId, "taskCardId", 180, issues);
  const taskId = optionalString(input.taskId, "taskId", 120, issues);
  const roomId = optionalString(input.roomId, "roomId", 180, issues);
  if (issues.length > 0) {
    throw new CollaborationHallStoreValidationError("Invalid hall task message delete payload.", issues);
  }
  return { hallId, taskCardId, taskId, roomId };
}

function validateAppendHallMessageInput(input: AppendHallMessageInput): AppendHallMessageInput & { hallId: string } {
  const issues: string[] = [];
  const hallId = optionalString(input.hallId, "hallId", 120, issues) ?? DEFAULT_COLLABORATION_HALL_ID;
  const messageId = optionalString(input.messageId, "messageId", 180, issues);
  const kind = input.kind === undefined ? undefined : optionalHallMessageKind(input.kind, "kind", issues);
  const authorParticipantId = requiredString(input.authorParticipantId, "authorParticipantId", 160, issues);
  const authorLabel = requiredString(input.authorLabel, "authorLabel", 120, issues);
  const content = requiredString(input.content, "content", HALL_MESSAGE_CONTENT_MAX_CHARS, issues);
  const targetParticipantIds =
    input.targetParticipantIds === undefined
      ? undefined
      : optionalStringArray(input.targetParticipantIds, "targetParticipantIds", 160, issues);
  const mentionTargets = input.mentionTargets;
  const projectId = optionalString(input.projectId, "projectId", 120, issues);
  const taskId = optionalString(input.taskId, "taskId", 120, issues);
  const taskCardId = optionalString(input.taskCardId, "taskCardId", 180, issues);
  const roomId = optionalString(input.roomId, "roomId", 180, issues);

  if (issues.length > 0) {
    throw new CollaborationHallStoreValidationError("Invalid hall message payload.", issues);
  }

  return {
    ...input,
    hallId,
    messageId,
    kind,
    authorParticipantId,
    authorLabel,
    content,
    targetParticipantIds,
    mentionTargets,
    projectId,
    taskId,
    taskCardId,
    roomId,
  };
}

function normalizeHallStore(input: unknown): CollaborationHallStoreSnapshot {
  const root = asObject(input);
  if (!root) return cloneEmptyHallStore();
  return {
    halls: asArray(root.halls)
      .map((item) => normalizeHall(item))
      .filter((item): item is CollaborationHall => Boolean(item))
      .sort((a, b) => a.hallId.localeCompare(b.hallId)),
    executionLocks: asArray(root.executionLocks)
      .map((item) => normalizeExecutionLock(item))
      .filter((item): item is CollaborationHallStoreSnapshot["executionLocks"][number] => Boolean(item)),
    updatedAt: normalizeIsoString(root.updatedAt) ?? EMPTY_HALL_STORE.updatedAt,
  };
}

function normalizeHallMessageStore(input: unknown): CollaborationHallMessageStoreSnapshot {
  const root = asObject(input);
  if (!root) return cloneEmptyMessageStore();
  return {
    messages: asArray(root.messages)
      .map((item) => normalizeHallMessage(item))
      .filter((item): item is HallMessage => Boolean(item))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
    updatedAt: normalizeIsoString(root.updatedAt) ?? EMPTY_MESSAGE_STORE.updatedAt,
  };
}

function normalizeTaskCardStore(input: unknown): CollaborationTaskCardStoreSnapshot {
  const root = asObject(input);
  if (!root) return cloneEmptyTaskCardStore();
  return {
    taskCards: asArray(root.taskCards)
      .map((item) => normalizeTaskCard(item))
      .filter((item): item is HallTaskCard => Boolean(item))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    updatedAt: normalizeIsoString(root.updatedAt) ?? EMPTY_TASK_CARD_STORE.updatedAt,
  };
}

function normalizeHall(input: unknown): CollaborationHall | undefined {
  const root = asObject(input);
  if (!root) return undefined;
  const hallId = asNonEmptyString(root.hallId);
  const title = asNonEmptyString(root.title);
  const createdAt = normalizeIsoString(root.createdAt);
  const updatedAt = normalizeIsoString(root.updatedAt);
  if (!hallId || !title || !createdAt || !updatedAt) return undefined;
  return {
    hallId,
    title,
    description: asNonEmptyString(root.description),
    participants: normalizeParticipants(asArray(root.participants).map((item) => normalizeParticipant(item)).filter(Boolean) as HallParticipant[]),
    taskCardIds: toStringArray(root.taskCardIds, 180),
    messageIds: toStringArray(root.messageIds, 180),
    lastMessageId: asNonEmptyString(root.lastMessageId) ?? undefined,
    latestMessageAt: normalizeIsoString(root.latestMessageAt),
    createdAt,
    updatedAt,
  };
}

function normalizeTaskCard(input: unknown): HallTaskCard | undefined {
  const root = asObject(input);
  if (!root) return undefined;
  const hallId = asNonEmptyString(root.hallId);
  const taskCardId = asNonEmptyString(root.taskCardId);
  const projectId = asNonEmptyString(root.projectId);
  const taskId = asNonEmptyString(root.taskId);
  const title = asNonEmptyString(root.title);
  const description = asNonEmptyString(root.description);
  const status = asTaskStatus(root.status);
  const createdByParticipantId = asNonEmptyString(root.createdByParticipantId);
  const createdAt = normalizeIsoString(root.createdAt);
  const updatedAt = normalizeIsoString(root.updatedAt);
  if (!hallId || !taskCardId || !projectId || !taskId || !title || !description || !status || !createdByParticipantId || !createdAt || !updatedAt) {
    return undefined;
  }
  // Legacy fields `stage` and `discussionCycle` are intentionally ignored here;
  // old runtime/collaboration-task-cards.json files retain them but the runtime
  // no longer persists or reads them.
  return {
    hallId,
    taskCardId,
    projectId,
    taskId,
    roomId: asNonEmptyString(root.roomId),
    title,
    description,
    status,
    createdByParticipantId,
    currentOwnerParticipantId: asNonEmptyString(root.currentOwnerParticipantId),
    currentOwnerLabel: asNonEmptyString(root.currentOwnerLabel),
    proposal: asNonEmptyString(root.proposal),
    decision: asNonEmptyString(root.decision),
    doneWhen: asNonEmptyString(root.doneWhen),
    latestSummary: asNonEmptyString(root.latestSummary),
    blockers: toStringArray(root.blockers, 240),
    requiresInputFrom: toStringArray(root.requiresInputFrom, 160),
    mentionedParticipantIds: toStringArray(root.mentionedParticipantIds, 160),
    plannedExecutionOrder: toStringArray(root.plannedExecutionOrder, 160),
    plannedExecutionItems: normalizeExecutionItems(root.plannedExecutionItems),
    currentExecutionItem: normalizeExecutionItem(root.currentExecutionItem),
    sessionKeys: toStringArray(root.sessionKeys, 240),
    executionLock: normalizeExecutionLock(root.executionLock),
    originalAssignerParticipantId: asNonEmptyString(root.originalAssignerParticipantId),
    autoRoundsByAgent: normalizeAutoRoundsByAgent(root.autoRoundsByAgent),
    lastAgentActivityAt: normalizeIsoString(root.lastAgentActivityAt),
    humanReviewedAt: normalizeIsoString(root.humanReviewedAt),
    archivedAt: normalizeIsoString(root.archivedAt),
    archivedByParticipantId: asNonEmptyString(root.archivedByParticipantId),
    archivedByLabel: asNonEmptyString(root.archivedByLabel),
    createdAt,
    updatedAt,
  };
}

function normalizeHallMessage(input: unknown): HallMessage | undefined {
  const root = asObject(input);
  if (!root) return undefined;
  const hallId = asNonEmptyString(root.hallId);
  const messageId = asNonEmptyString(root.messageId);
  const kind = asHallMessageKind(root.kind);
  const authorParticipantId = asNonEmptyString(root.authorParticipantId);
  const authorLabel = asNonEmptyString(root.authorLabel);
  const content = asNonEmptyString(root.content);
  const createdAt = normalizeIsoString(root.createdAt);
  if (!hallId || !messageId || !kind || !authorParticipantId || !authorLabel || !content || !createdAt) return undefined;
  return {
    hallId,
    messageId,
    kind,
    authorParticipantId,
    authorLabel,
    authorSemanticRole: asHallSemanticRole(root.authorSemanticRole),
    content,
    targetParticipantIds: toStringArray(root.targetParticipantIds, 160),
    mentionTargets: normalizeMentionTargets(root.mentionTargets),
    projectId: asNonEmptyString(root.projectId),
    taskId: asNonEmptyString(root.taskId),
    taskCardId: asNonEmptyString(root.taskCardId),
    roomId: asNonEmptyString(root.roomId),
    payload: asObject(root.payload) as HallMessage["payload"] | undefined,
    createdAt,
  };
}

function normalizeAutoRoundsByAgent(input: unknown): Record<string, number> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const trimmedKey = String(key || "").trim();
    if (!trimmedKey || trimmedKey.length > 160) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    result[trimmedKey] = Math.floor(value);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeExecutionItems(input: unknown): HallTaskCard["plannedExecutionItems"] {
  if (!Array.isArray(input)) return [];
  const items: HallTaskCard["plannedExecutionItems"] = [];
  for (const item of input) {
    const normalized = normalizeExecutionItem(item);
    if (normalized) items.push(normalized);
  }
  return items;
}

function normalizeExecutionItem(input: unknown): HallTaskCard["currentExecutionItem"] | undefined {
  const root = asObject(input);
  if (!root) return undefined;
  const itemId = asNonEmptyString(root.itemId);
  const participantId = asNonEmptyString(root.participantId);
  const task = asNonEmptyString(root.task);
  if (!itemId || !participantId || !task) return undefined;
  return {
    itemId,
    participantId,
    task,
    handoffToParticipantId: asNonEmptyString(root.handoffToParticipantId),
    handoffWhen: asNonEmptyString(root.handoffWhen),
  };
}

function optionalExecutionItems(
  input: unknown,
  label: string,
  issues: string[],
): HallTaskCard["plannedExecutionItems"] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) {
    issues.push(`${label} must be an array.`);
    return undefined;
  }
  return input.map((item, index) => {
    const root = asObject(item);
    if (!root) {
      issues.push(`${label}[${index}] must be an object.`);
      return {
        itemId: randomUUID(),
        participantId: "",
        task: "",
      };
    }
    return {
      itemId: optionalString(typeof root.itemId === "string" ? root.itemId : undefined, `${label}[${index}].itemId`, 180, issues) ?? randomUUID(),
      participantId: requiredString(typeof root.participantId === "string" ? root.participantId : undefined, `${label}[${index}].participantId`, 160, issues),
      task: requiredString(typeof root.task === "string" ? root.task : undefined, `${label}[${index}].task`, 400, issues),
      handoffToParticipantId: optionalString(typeof root.handoffToParticipantId === "string" ? root.handoffToParticipantId : undefined, `${label}[${index}].handoffToParticipantId`, 160, issues),
      handoffWhen: optionalString(typeof root.handoffWhen === "string" ? root.handoffWhen : undefined, `${label}[${index}].handoffWhen`, 240, issues),
    };
  }).filter((item) => item.participantId && item.task);
}

function optionalExecutionItem(
  input: unknown,
  label: string,
  issues: string[],
): HallTaskCard["currentExecutionItem"] | undefined {
  if (input === undefined) return undefined;
  const root = asObject(input);
  if (!root) {
    issues.push(`${label} must be an object.`);
    return undefined;
  }
  const participantId = requiredString(typeof root.participantId === "string" ? root.participantId : undefined, `${label}.participantId`, 160, issues);
  const task = requiredString(typeof root.task === "string" ? root.task : undefined, `${label}.task`, 400, issues);
  if (!participantId || !task) return undefined;
  return {
    itemId: optionalString(typeof root.itemId === "string" ? root.itemId : undefined, `${label}.itemId`, 180, issues) ?? randomUUID(),
    participantId,
    task,
    handoffToParticipantId: optionalString(typeof root.handoffToParticipantId === "string" ? root.handoffToParticipantId : undefined, `${label}.handoffToParticipantId`, 160, issues),
    handoffWhen: optionalString(typeof root.handoffWhen === "string" ? root.handoffWhen : undefined, `${label}.handoffWhen`, 240, issues),
  };
}

function normalizeExecutionLock(input: unknown): CollaborationHallStoreSnapshot["executionLocks"][number] | undefined {
  const root = asObject(input);
  if (!root) return undefined;
  const taskId = asNonEmptyString(root.taskId);
  const projectId = asNonEmptyString(root.projectId);
  const ownerParticipantId = asNonEmptyString(root.ownerParticipantId);
  const ownerLabel = asNonEmptyString(root.ownerLabel);
  const acquiredAt = normalizeIsoString(root.acquiredAt);
  if (!taskId || !projectId || !ownerParticipantId || !ownerLabel || !acquiredAt) return undefined;
  return {
    taskId,
    projectId,
    ownerParticipantId,
    ownerLabel,
    acquiredAt,
    releasedAt: normalizeIsoString(root.releasedAt),
    releasedReason: asNonEmptyString(root.releasedReason),
  };
}

function normalizeParticipant(input: unknown): HallParticipant | undefined {
  const root = asObject(input);
  if (!root) return undefined;
  const participantId = asNonEmptyString(root.participantId);
  const displayName = asNonEmptyString(root.displayName);
  const semanticRole = asHallSemanticRole(root.semanticRole);
  if (!participantId || !displayName || !semanticRole) return undefined;
  return {
    participantId,
    agentId: asNonEmptyString(root.agentId),
    displayName,
    semanticRole,
    active: root.active !== false,
    aliases: toStringArray(root.aliases, 160),
    isHuman: root.isHuman === true,
  };
}

function normalizeMentionTargets(input: unknown): MentionTarget[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      const root = asObject(item);
      if (!root) return undefined;
      const participantId = asNonEmptyString(root.participantId);
      const displayName = asNonEmptyString(root.displayName);
      const semanticRole = asHallSemanticRole(root.semanticRole);
      const raw = asNonEmptyString(root.raw);
      if (!participantId || !displayName || !semanticRole || !raw) return undefined;
      return { raw, participantId, displayName, semanticRole };
    })
    .filter((item): item is MentionTarget => Boolean(item));
}

function cloneEmptyHallStore(): CollaborationHallStoreSnapshot {
  return {
    halls: [],
    executionLocks: [],
    updatedAt: EMPTY_HALL_STORE.updatedAt,
  };
}

function cloneEmptyMessageStore(): CollaborationHallMessageStoreSnapshot {
  return {
    messages: [],
    updatedAt: EMPTY_MESSAGE_STORE.updatedAt,
  };
}

function cloneEmptyTaskCardStore(): CollaborationTaskCardStoreSnapshot {
  return {
    taskCards: [],
    updatedAt: EMPTY_TASK_CARD_STORE.updatedAt,
  };
}

function normalizeParticipants(participants: HallParticipant[]): HallParticipant[] {
  const seen = new Set<string>();
  const normalized: HallParticipant[] = [];
  for (const participant of participants) {
    if (!participant.participantId.trim()) continue;
    if (seen.has(participant.participantId)) continue;
    seen.add(participant.participantId);
    normalized.push({
      ...participant,
      displayName: participant.displayName.trim() || participant.participantId,
      aliases: [...new Set(
        participant.aliases
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
          .concat([participant.displayName.trim() || participant.participantId, participant.participantId]),
      )],
    });
  }
  return normalized.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function requiredString(value: string | undefined, field: string, maxLength: number, issues: string[]): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    issues.push(field);
    return "";
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function optionalString(value: string | undefined, field: string, maxLength: number, issues: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    issues.push(field);
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function optionalIsoString(value: string | undefined, field: string, issues: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    issues.push(field);
    return undefined;
  }
  const normalized = normalizeIsoString(value);
  if (!normalized) {
    issues.push(field);
    return undefined;
  }
  return normalized;
}

function optionalStringArray(value: string[] | undefined, field: string, maxLength: number, issues: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.push(field);
    return undefined;
  }
  return [...new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .map((item) => (item.length > maxLength ? `${item.slice(0, maxLength - 3)}...` : item)),
  )];
}

function optionalTaskStatus(value: HallTaskCard["status"] | undefined, field: string, issues: string[]): HallTaskCard["status"] | undefined {
  if (value === undefined) return undefined;
  if (value === "todo" || value === "in_progress" || value === "blocked" || value === "done") return value;
  issues.push(field);
  return undefined;
}

function optionalHallMessageKind(value: HallMessageKind | undefined, field: string, issues: string[]): HallMessageKind | undefined {
  if (value === undefined) return undefined;
  if (HALL_MESSAGE_KINDS.includes(value)) return value;
  issues.push(field);
  return undefined;
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

function asHallMessageKind(value: unknown): HallMessageKind | undefined {
  return typeof value === "string" && HALL_MESSAGE_KINDS.includes(value as HallMessageKind)
    ? (value as HallMessageKind)
    : undefined;
}

function asHallSemanticRole(value: unknown): HallParticipant["semanticRole"] | undefined {
  return value === "planner" || value === "coder" || value === "reviewer" || value === "manager" || value === "observer" || value === "generalist"
    ? value
    : undefined;
}

function asTaskStatus(value: unknown): HallTaskCard["status"] | undefined {
  return value === "todo" || value === "in_progress" || value === "blocked" || value === "done"
    ? value
    : undefined;
}

function toStringArray(value: unknown, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .map((item) => (item.length > maxLength ? `${item.slice(0, maxLength - 3)}...` : item)),
  )];
}

function normalizeIsoString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

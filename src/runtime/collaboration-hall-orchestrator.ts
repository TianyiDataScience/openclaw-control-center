import { randomUUID } from "node:crypto";
import type { ToolClient } from "../clients/tool-client";
import { createToolClient } from "../clients/factory";
import {
  HALL_RUNTIME_EXECUTION_CHAIN_ENABLED,
  HALL_RUNTIME_EXECUTION_MAX_TURNS,
} from "../config";
import {
  appendChatMessage,
  createChatRoom,
  deleteChatRoom,
  getChatRoom,
  getChatRoomByTask,
  loadChatRoomStore,
} from "./chat-store";
import {
  acquireHallExecutionLock,
  releaseHallExecutionLock,
} from "./hall-execution-lock";
import { buildStructuredHandoffPacket, summarizeStructuredHandoff, type CreateStructuredHandoffInput } from "./hall-handoff";
import { resolveHallMentionTargets } from "./hall-mention-router";
import { pickPrimaryParticipantByRole, resolveHallParticipantsFromRoster } from "./hall-role-resolver";
import {
  abortHallDraftReply,
  abortHallDraftRepliesForTask,
  beginHallDraftReply,
  completeHallDraftReply,
  isHallDraftCanceled,
  streamHallDraftReply,
} from "./collaboration-stream";
import { inferHallDiscussionDomainFromText, type HallDiscussionDomain } from "./hall-discussion-domain";
import {
  DEFAULT_COLLABORATION_HALL_ID,
  CollaborationHallStoreValidationError,
  archiveHallTaskCard,
  appendHallMessage,
  createHallTaskCard,
  deleteHallMessagesForTaskCard,
  deleteHallTaskCard,
  ensureDefaultCollaborationHall,
  getHallTaskCard,
  getHallTaskCardByTask,
  listHallMessages,
  listHallTaskCards,
  loadCollaborationHallMessageStore,
  loadCollaborationHallStore,
  loadCollaborationTaskCardStore,
  saveCollaborationHallMessageStore,
  saveCollaborationHallStore,
  updateHallTaskCard,
} from "./collaboration-hall-store";
import {
  buildCollaborationHallSummary,
  buildHallTaskSummary,
  upsertCollaborationHallSummary,
  upsertHallTaskSummary,
} from "./collaboration-hall-summary-store";
import { loadBestEffortAgentRoster } from "./agent-roster";
import { copyHallFilesToWorkspace } from "./hall-file-store";
import { ensureHallTaskWorkspace } from "./hall-workspace";
import {
  canDispatchHallToRuntime,
  dispatchHallRuntimeTurn,
  type HallParallelTaskTarget,
  type HallRuntimeChainDirective,
  type HallRuntimeDispatchResult,
} from "./hall-runtime-dispatch";
import { appendOperationAudit } from "./operation-audit";
import { loadProjectStore, saveProjectStore } from "./project-store";
import { readRoomDetail, recordRoomHandoff, submitRoomReview } from "./room-orchestrator";
import { createTask, deleteTask, loadTaskStore, patchTask } from "./task-store";
import { publishTaskRoomBridgeEvent } from "./task-room-bridge";
import type {
  ChatMessage,
  CollaborationHall,
  CollaborationHallSummary,
  HallExecutionItem,
  HallFileAttachment,
  HallMessage,
  HallParallelGroup,
  HallParallelSlot,
  HallParticipant,
  HallSemanticRole,
  HallTaskCard,
  HallTaskSummary,
  MessageKind,
  ProjectTask,
  RoomParticipantRole,
  StructuredHandoffPacket,
  TaskArtifact,
  TaskState,
} from "../types";

export const DEFAULT_COLLABORATION_HALL_PROJECT_ID = "collaboration-hall";

function isManagerLike(role: HallSemanticRole): boolean {
  return role === "manager" || role === "observer";
}

type HallOperatorIntent = "greeting" | "light_chat" | "discussion_request" | "task_request";
type HallResponseLanguage = "zh" | "en";

export interface HallReadResult {
  hall: CollaborationHall;
  hallSummary: CollaborationHallSummary;
  participants: HallParticipant[];
  messages: HallMessage[];
  taskCards: HallTaskCard[];
  taskSummaries: HallTaskSummary[];
}

export interface HallTaskDetailResult {
  hall: CollaborationHall;
  hallSummary: CollaborationHallSummary;
  taskCard: HallTaskCard;
  taskSummary: HallTaskSummary;
  task?: ProjectTask;
  messages: HallMessage[];
}

export interface CreateHallTaskInput {
  hallId?: string;
  projectId?: string;
  taskId?: string;
  title?: string;
  content: string;
  authorParticipantId?: string;
  authorLabel?: string;
}

export interface HallMessageInput {
  hallId?: string;
  taskCardId?: string;
  projectId?: string;
  taskId?: string;
  content: string;
  authorParticipantId?: string;
  authorLabel?: string;
  fileAttachments?: HallFileAttachment[];
}

export interface HallMutationResult {
  hall: CollaborationHall;
  hallSummary: CollaborationHallSummary;
  taskCard?: HallTaskCard;
  taskSummary?: HallTaskSummary;
  task?: ProjectTask;
  roomId?: string;
  message?: HallMessage;
  generatedMessages: HallMessage[];
}

export interface AssignHallTaskInput {
  taskCardId: string;
  ownerParticipantId?: string;
  note?: string;
}

export interface SetHallExecutionOrderInput {
  taskCardId: string;
  participantIds: string[];
  executionItems?: HallExecutionItem[];
  note?: string;
}

export interface ReviewHallTaskInput {
  taskCardId: string;
  outcome: "approved" | "rejected";
  note?: string;
  blockTask?: boolean;
}

export interface StopHallTaskInput {
  taskCardId: string;
  note?: string;
}

export interface HallHandoffInput {
  taskCardId: string;
  fromParticipantId: string;
  toParticipantId: string;
  handoff: CreateStructuredHandoffInput;
}

export interface ArchiveHallTaskInput {
  taskCardId: string;
  archivedByParticipantId?: string;
  archivedByLabel?: string;
}

export interface DeleteHallTaskInput {
  taskCardId: string;
}

export interface MarkHallTaskHumanReviewedInput {
  taskCardId: string;
  reviewedByParticipantId?: string;
  reviewedByLabel?: string;
}

export interface HallOrchestratorRuntimeOptions {
  toolClient?: ToolClient;
  skipDiscussion?: boolean;
}

const pendingHallBackgroundWork = new Set<Promise<void>>();

export async function waitForHallBackgroundWork(): Promise<void> {
  const pending = [...pendingHallBackgroundWork];
  if (pending.length === 0) return;
  await Promise.allSettled(pending);
}

export async function readCollaborationHall(hallId = DEFAULT_COLLABORATION_HALL_ID): Promise<HallReadResult> {
  const hall = await requireHall(hallId);
  const [messageStore, taskCardStore] = await Promise.all([
    loadCollaborationHallMessageStore(),
    loadCollaborationTaskCardStore(),
  ]);
  const allTaskCards = listHallTaskCards(taskCardStore, { hallId, includeArchived: true });
  const taskCards = allTaskCards.filter((card) => !card.archivedAt);
  const visibleTaskCardIds = new Set(taskCards.map((card) => card.taskCardId));
  const messages = await reconcileHallMessages(hallId, messageStore, allTaskCards);
  const visibleMessages = messages.filter((message) => !message.taskCardId || visibleTaskCardIds.has(message.taskCardId));
  const reconciledHall = await reconcileHallState(hall, messages, taskCards);
  const hallSummary = buildCollaborationHallSummary(reconciledHall, visibleMessages, taskCards);
  const taskSummaries = taskCards.map((card) => buildHallTaskSummary(card, messages));
  return {
    hall: reconciledHall,
    hallSummary,
    participants: reconciledHall.participants,
    messages,
    taskCards,
    taskSummaries,
  };
}

async function reconcileHallMessages(
  hallId: string,
  messageStore: Awaited<ReturnType<typeof loadCollaborationHallMessageStore>>,
  taskCards: HallTaskCard[],
): Promise<HallMessage[]> {
  const liveTaskCardIds = new Set(taskCards.map((taskCard) => taskCard.taskCardId));
  const orphanedMessageIds = new Set(
    messageStore.messages
      .filter((message) => message.hallId === hallId)
      .filter((message) => Boolean(message.taskCardId) && !liveTaskCardIds.has(message.taskCardId as string))
      .map((message) => message.messageId),
  );
  if (orphanedMessageIds.size > 0) {
    messageStore.messages = messageStore.messages.filter((message) => !orphanedMessageIds.has(message.messageId));
    messageStore.updatedAt = new Date().toISOString();
    await saveCollaborationHallMessageStore(messageStore);
  }
  return listHallMessages(messageStore, { hallId });
}

async function reconcileHallState(
  hall: CollaborationHall,
  messages: HallMessage[],
  taskCards: HallTaskCard[],
): Promise<CollaborationHall> {
  const nextMessageIds = messages.map((message) => message.messageId);
  const nextTaskCardIds = taskCards.map((taskCard) => taskCard.taskCardId);
  const nextLastMessageId = nextMessageIds.at(-1) ?? null;
  const nextLatestMessageAt = messages.at(-1)?.createdAt ?? hall.latestMessageAt;
  const sameMessageIds =
    hall.messageIds.length === nextMessageIds.length
    && hall.messageIds.every((messageId, index) => messageId === nextMessageIds[index]);
  const sameTaskCardIds =
    hall.taskCardIds.length === nextTaskCardIds.length
    && hall.taskCardIds.every((taskCardId, index) => taskCardId === nextTaskCardIds[index]);
  const unchanged =
    sameMessageIds
    && sameTaskCardIds
    && hall.lastMessageId === nextLastMessageId
    && hall.latestMessageAt === nextLatestMessageAt;
  if (unchanged) return hall;

  const nextHall: CollaborationHall = {
    ...hall,
    messageIds: nextMessageIds,
    taskCardIds: nextTaskCardIds,
    lastMessageId: nextLastMessageId,
    latestMessageAt: nextLatestMessageAt,
    updatedAt: new Date().toISOString(),
  };
  const hallStore = await loadCollaborationHallStore();
  const hallIndex = hallStore.halls.findIndex((item) => item.hallId === hall.hallId);
  if (hallIndex >= 0) {
    hallStore.halls[hallIndex] = nextHall;
    hallStore.updatedAt = nextHall.updatedAt;
    await saveCollaborationHallStore(hallStore);
  }
  return nextHall;
}

export async function readCollaborationHallTaskDetail(
  taskCardId: string,
  options: HallOrchestratorRuntimeOptions = {},
): Promise<HallTaskDetailResult> {
  const { hall, hallSummary, messages } = await readCollaborationHall();
  const taskCardStore = await loadCollaborationTaskCardStore();
  const taskCard = getHallTaskCard(taskCardStore, taskCardId);
  if (!taskCard) {
    throw new CollaborationHallStoreValidationError(`task card '${taskCardId}' was not found.`, ["taskCardId"], 404);
  }
  const taskStore = await loadTaskStore();
  const task = taskStore.tasks.find((item) => item.projectId === taskCard.projectId && item.taskId === taskCard.taskId);
  const detailMessages = await buildHallTaskDetailMessages(taskCard, messages, hall.participants);
  const taskSummary = buildHallTaskSummary(taskCard, detailMessages);
  return {
    hall,
    hallSummary,
    taskCard,
    taskSummary,
    task,
    messages: detailMessages,
  };
}

async function buildHallTaskDetailMessages(
  taskCard: HallTaskCard,
  hallMessages: HallMessage[],
  participants: HallParticipant[],
): Promise<HallMessage[]> {
  const scopedHallMessages = hallMessages.filter(
    (message) =>
      (message.taskCardId === taskCard.taskCardId || message.taskId === taskCard.taskId)
      && shouldDisplayHallTimelineMessage(message),
  );
  if (!taskCard.roomId) return scopedHallMessages;
  try {
    const linkedRoomDetail = await readRoomDetail(taskCard.roomId);
    const roomMessages = linkedRoomDetail.messages
      .filter((message) => shouldMergeLinkedRoomMessage(message))
      .map((message) => mapRoomMessageToHallMessage(taskCard, participants, message));
    return mergeHallTaskMessages(scopedHallMessages, roomMessages);
  } catch {
    return scopedHallMessages;
  }
}

function shouldDisplayHallTimelineMessage(message: Pick<HallMessage, "kind" | "content">): boolean {
  if (message.kind !== "handoff") return true;
  return !isLegacyLinkedRoomHandoffMessage(message.content);
}

function shouldMergeLinkedRoomMessage(message: ChatMessage): boolean {
  if (message.kind !== "handoff") return true;
  return !isLegacyLinkedRoomHandoffMessage(message.content);
}

function isLegacyLinkedRoomHandoffMessage(content: string): boolean {
  const normalized = content.trim();
  return /^(Operator|Planner|Coder|Reviewer|Manager) handed the room to (Operator|Planner|Coder|Reviewer|Manager)\.$/.test(normalized);
}

function mapRoomMessageToHallMessage(
  taskCard: HallTaskCard,
  participants: HallParticipant[],
  message: ChatMessage,
): HallMessage {
  const participant = resolveHallParticipantForRoomMessage(participants, message);
  const mentionTargets = mapRoomMentionsToHallMentionTargets(participants, message.mentions);
  return {
    hallId: taskCard.hallId,
    messageId: `linked-room:${message.messageId}`,
    kind: mapRoomKindToHallKind(message.kind),
    authorParticipantId: participant?.participantId ?? fallbackHallParticipantIdForRoomMessage(message),
    authorLabel: participant?.displayName ?? message.authorLabel,
    authorSemanticRole: participant?.semanticRole ?? mapRoomRoleToHallSemanticRole(message.authorRole),
    content: message.content,
    targetParticipantIds: mentionTargets.map((item) => item.participantId),
    mentionTargets,
    projectId: taskCard.projectId,
    taskId: taskCard.taskId,
    taskCardId: taskCard.taskCardId,
    roomId: taskCard.roomId,
    payload: {
      projectId: taskCard.projectId,
      taskId: taskCard.taskId,
      taskCardId: taskCard.taskCardId,
      roomId: taskCard.roomId,
      proposal: message.payload?.proposal,
      decision: message.payload?.decision,
      doneWhen: message.payload?.doneWhen,
      reviewOutcome: message.payload?.reviewOutcome,
      taskStatus: message.payload?.taskStatus,
      status: message.payload?.status,
      sessionKey: message.payload?.sessionKey,
      sourceSessionKey: message.payload?.sourceSessionKey,
      sourceTool: message.payload?.sourceTool,
    },
    createdAt: message.createdAt,
  };
}

function mapRoomKindToHallKind(kind: MessageKind): HallMessage["kind"] {
  switch (kind) {
    case "proposal":
    case "decision":
    case "handoff":
    case "status":
    case "result":
      return kind;
    default:
      return "chat";
  }
}

function mapRoomRoleToHallSemanticRole(role: RoomParticipantRole): HallSemanticRole {
  switch (role) {
    case "planner":
      return "planner";
    case "reviewer":
      return "reviewer";
    case "manager":
      return "manager";
    case "human":
      return "generalist";
    default:
      return "coder";
  }
}

function resolveHallParticipantForRoomMessage(
  participants: HallParticipant[],
  message: ChatMessage,
): HallParticipant | undefined {
  const normalizedAuthor = message.authorLabel.trim().toLowerCase();
  if (normalizedAuthor.length > 0) {
    const byName = participants.find((participant) => {
      if (participant.displayName.trim().toLowerCase() === normalizedAuthor) return true;
      return participant.aliases.some((alias) => alias.trim().toLowerCase() === normalizedAuthor);
    });
    if (byName) return byName;
  }
  if (message.authorRole === "human") {
    return participants.find((participant) => participant.isHuman);
  }
  const semanticRole = mapRoomRoleToHallSemanticRole(message.authorRole);
  return participants.find((participant) => participant.active !== false && participant.semanticRole === semanticRole);
}

function fallbackHallParticipantIdForRoomMessage(message: ChatMessage): string {
  if (message.authorRole === "human") return "operator";
  const author = message.authorLabel.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "");
  return author ? `linked-room:${author}` : `linked-room:${message.authorRole}`;
}

function mapRoomMentionsToHallMentionTargets(
  participants: HallParticipant[],
  mentions: RoomParticipantRole[],
) {
  return mentions
    .map((role) => {
      if (role === "human") {
        const human = participants.find((participant) => participant.isHuman);
        return human
          ? {
              raw: "@operator",
              participantId: human.participantId,
              displayName: human.displayName,
              semanticRole: human.semanticRole,
            }
          : undefined;
      }
      const semanticRole = mapRoomRoleToHallSemanticRole(role);
      const participant = participants.find((item) => item.active !== false && item.semanticRole === semanticRole);
      return participant
        ? {
            raw: `@${participant.displayName}`,
            participantId: participant.participantId,
            displayName: participant.displayName,
            semanticRole: participant.semanticRole,
          }
        : undefined;
    })
    .filter((item): item is HallMessage["mentionTargets"][number] => Boolean(item));
}

function mergeHallTaskMessages(primary: HallMessage[], secondary: HallMessage[]): HallMessage[] {
  const merged = [...primary];
  for (const message of secondary) {
    if (merged.some((existing) => areEquivalentHallMessages(existing, message))) continue;
    merged.push(message);
  }
  return merged.sort(compareHallTimelineMessages);
}

function areEquivalentHallMessages(a: HallMessage, b: HallMessage): boolean {
  if (a.kind !== b.kind) return false;
  if ((a.taskCardId ?? "") !== (b.taskCardId ?? "")) return false;
  if (normalizeHallAuthorLabel(a.authorLabel) !== normalizeHallAuthorLabel(b.authorLabel)) return false;
  if (normalizeHallMessageContent(a.content) !== normalizeHallMessageContent(b.content)) return false;
  const delta = Math.abs(Date.parse(a.createdAt || "") - Date.parse(b.createdAt || ""));
  return delta <= 5_000;
}

function normalizeHallAuthorLabel(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeHallMessageContent(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function compareHallTimelineMessages(left: HallMessage, right: HallMessage): number {
  const leftTime = Date.parse(left.createdAt || "");
  const rightTime = Date.parse(right.createdAt || "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return left.messageId.localeCompare(right.messageId);
}

function matchesExplicitHallMentionForParticipant(
  content: string,
  participant: HallParticipant | undefined,
): boolean {
  if (!participant) return false;
  const candidates = [
    participant.participantId,
    participant.displayName,
    ...(Array.isArray(participant.aliases) ? participant.aliases : []),
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (candidates.length === 0) return false;
  return candidates.some((candidate) => {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[\\s(])@${escaped}(?=$|[\\s),.!?;:])`, "i").test(content);
  });
}

export async function createHallTaskFromOperatorRequest(
  input: CreateHallTaskInput,
  options: HallOrchestratorRuntimeOptions = {},
): Promise<HallMutationResult> {
  const context = await ensureHallContext(input.hallId);
  const authorParticipantId = input.authorParticipantId?.trim() || "operator";
  const authorLabel = input.authorLabel?.trim() || "Operator";
  const projectId = normalizeTaskKey(input.projectId) || DEFAULT_COLLABORATION_HALL_PROJECT_ID;
  const taskId = normalizeTaskKey(input.taskId) || buildTaskId(input.title ?? input.content);
  const title = deriveTaskTitle(input.title ?? input.content);
  const description = input.content.trim();
  const mentionRouting = resolveHallMentionTargets(input.content, context.hall.participants);
  const directedMentionParticipantIds = mentionRouting.broadcastAll
    ? []
    : mentionRouting.targets.map((target) => target.participantId).filter(Boolean);

  await ensureHallProject(projectId);

  const createdTask = await createTask({
    projectId,
    taskId,
    title,
    status: "todo",
    owner: authorLabel,
    definitionOfDone: [],
    sessionKeys: [],
  });

  const roomStore = await loadChatRoomStore();
  const existingRoom = getChatRoomByTask(roomStore, projectId, taskId);
  const room = existingRoom ?? (
    await createChatRoom({
      projectId,
      taskId,
      title,
    })
  ).room;
  const patchedTask = await patchTask({
    taskId,
    projectId,
    roomId: room.roomId,
  });

  let taskCard = (
    await createHallTaskCard({
      hallId: context.hall.hallId,
      projectId,
      taskId,
      roomId: room.roomId,
      title,
      description,
      createdByParticipantId: authorParticipantId,
      currentOwnerParticipantId: undefined,
      currentOwnerLabel: undefined,
      mentionedParticipantIds: directedMentionParticipantIds,
      blockers: [],
      requiresInputFrom: [],
      sessionKeys: [],
    })
  ).taskCard;
  const initialMessage = (
    await appendHallMessage({
      hallId: context.hall.hallId,
      kind: "task",
      authorParticipantId,
      authorLabel,
      content: description,
      targetParticipantIds: directedMentionParticipantIds,
      mentionTargets: mentionRouting.targets,
      projectId,
      taskId,
      taskCardId: taskCard.taskCardId,
      roomId: room.roomId,
    })
  ).message;

  await appendOperationAudit({
    action: "hall_task_create",
    source: "api",
    ok: true,
    detail: `created hall task ${projectId}:${taskId}`,
    metadata: {
      taskCardId: taskCard.taskCardId,
      roomId: room.roomId,
    },
  });

  const hallRead = await readCollaborationHall(context.hall.hallId);
  const taskDetail = await readCollaborationHallTaskDetail(taskCard.taskCardId);

  // Route to agent(s) using the new group chat model
  if (options.toolClient) {
    scheduleRouteAndDispatch({
      hall: context.hall,
      taskCard,
      triggerMessage: initialMessage,
      mentionRouting,
      toolClient: options.toolClient,
    });
  }

  return {
    hall: hallRead.hall,
    hallSummary: hallRead.hallSummary,
    taskCard: taskDetail.taskCard,
    taskSummary: taskDetail.taskSummary,
    task: patchedTask.task,
    roomId: room.roomId,
    message: initialMessage,
    generatedMessages: [],
  };
}

export async function postHallMessage(
  input: HallMessageInput,
  options: HallOrchestratorRuntimeOptions = {},
): Promise<HallMutationResult> {
  const context = await ensureHallContext(input.hallId);
  const authorParticipantId = input.authorParticipantId?.trim() || "operator";
  const authorLabel = input.authorLabel?.trim() || "Operator";
  const normalizedContent = input.content.trim();

  // Resolve task card (thread container)
  const taskCard = input.taskCardId
    ? await requireTaskCard(input.taskCardId)
    : input.projectId && input.taskId
      ? await requireTaskCardByProjectTask(input.projectId, input.taskId)
      : undefined;

  // Greeting without a thread: reply in the lobby, don't auto-create a task.
  if (!taskCard && authorParticipantId === "operator" && normalizedContent
      && classifyHallOperatorIntent(normalizedContent) === "greeting") {
    const triggerMessage = (
      await appendHallMessage({
        hallId: context.hall.hallId,
        kind: "chat",
        authorParticipantId,
        authorLabel,
        content: normalizedContent,
        targetParticipantIds: [],
      })
    ).message;
    const lobbyParticipants = resolveLobbyParticipants(context.hall.participants, []);
    const greeter = lobbyParticipants[0];
    const generatedMessages: HallMessage[] = [];
    if (greeter) {
      generatedMessages.push(
        await appendLobbyHallReply({ hall: context.hall, participant: greeter, triggerMessage }),
      );
    }
    const hallRead = await readCollaborationHall(context.hall.hallId);
    return {
      hall: hallRead.hall,
      hallSummary: hallRead.hallSummary,
      taskCard: undefined,
      taskSummary: undefined,
      task: undefined,
      roomId: undefined,
      message: triggerMessage,
      generatedMessages,
    };
  }

  // If no thread exists and operator is sending, auto-create a thread
  if (!taskCard && authorParticipantId === "operator" && normalizedContent) {
    return createHallTaskFromOperatorRequest({
      hallId: context.hall.hallId,
      content: normalizedContent,
      authorParticipantId,
      authorLabel,
    }, options);
  }

  // Duplicate detection (operator, same content within 30s)
  if (taskCard && authorParticipantId === "operator" && normalizedContent) {
    const recentMessages = await loadRecentHallThreadMessages(taskCard, 6);
    const duplicateMessage = [...recentMessages]
      .reverse()
      .find((message) => {
        if (message.authorParticipantId !== "operator") return false;
        if (message.content.trim() !== normalizedContent) return false;
        const ageMs = Date.now() - Date.parse(message.createdAt || "");
        return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 30_000;
      });
    if (duplicateMessage) {
      const refreshed = await refreshHallAndTaskSummary(context.hall.hallId, taskCard);
      const taskStore = await loadTaskStore();
      const task = taskStore.tasks.find((item) => item.projectId === taskCard.projectId && item.taskId === taskCard.taskId);
      return {
        hall: refreshed.hall,
        hallSummary: refreshed.hallSummary,
        taskCard: refreshed.taskCard,
        taskSummary: refreshed.taskSummary,
        task,
        roomId: taskCard.roomId,
        message: duplicateMessage,
        generatedMessages: [],
      };
    }
  }

  // Persist the message
  const mentionRouting = resolveHallMentionTargets(input.content, context.hall.participants);
  const targetParticipantIds = mentionRouting.broadcastAll
    ? context.hall.participants.filter((p) => p.active && p.participantId !== authorParticipantId).map((p) => p.participantId)
    : mentionRouting.targets.map((target) => target.participantId);

  const fileAttachments = input.fileAttachments;
  const fileArtifactRefs: TaskArtifact[] | undefined = fileAttachments?.map((f) => ({
    artifactId: f.fileId,
    type: "file" as const,
    label: f.originalName,
    location: `/hall-files/${f.storedFileName}`,
  }));
  const messagePayload = (fileAttachments || fileArtifactRefs)
    ? { fileAttachments, artifactRefs: fileArtifactRefs }
    : undefined;

  const message = (
    await appendHallMessage({
      hallId: context.hall.hallId,
      kind: "chat",
      authorParticipantId,
      authorLabel,
      content: normalizedContent,
      targetParticipantIds,
      mentionTargets: mentionRouting.targets,
      projectId: taskCard?.projectId,
      taskId: taskCard?.taskId,
      taskCardId: taskCard?.taskCardId,
      roomId: taskCard?.roomId,
      payload: messagePayload,
    })
  ).message;

  // Copy uploaded files into the task workspace so agents can access them
  if (fileAttachments && fileAttachments.length > 0 && taskCard) {
    const workspaceDir = await ensureHallTaskWorkspace(taskCard.taskCardId);
    await copyHallFilesToWorkspace(fileAttachments, workspaceDir).catch(() => {});
  }

  // Route and dispatch — the core of the new group chat model
  if (authorParticipantId === "operator" && taskCard && options.toolClient) {
    scheduleRouteAndDispatch({
      hall: context.hall,
      taskCard,
      triggerMessage: message,
      mentionRouting,
      toolClient: options.toolClient,
    });
  }

  const hallRead = await readCollaborationHall(context.hall.hallId);
  const taskDetail = taskCard ? await readCollaborationHallTaskDetail(taskCard.taskCardId) : undefined;
  const taskStore = await loadTaskStore();
  const task = taskCard
    ? taskStore.tasks.find((item) => item.projectId === taskCard.projectId && item.taskId === taskCard.taskId)
    : undefined;

  return {
    hall: hallRead.hall,
    hallSummary: hallRead.hallSummary,
    taskCard: taskDetail?.taskCard,
    taskSummary: taskDetail?.taskSummary,
    task,
    roomId: taskCard?.roomId,
    message,
    generatedMessages: [],
  };
}

// ---------------------------------------------------------------------------
// Group Chat Routing — replaces the old workflow-driven discussion/execution
// ---------------------------------------------------------------------------

const MAX_AUTO_CHAIN_DEPTH = 5;
// When a single (taskCardId, agentId) pair gets dispatched this many times
// within one human-initiated round (no operator message in between), the card
// is auto-paused and marked blocked for human review. 6 = 1 initial assignment
// + 5 rounds of back-and-forth before we force a human into the loop.
const AUTO_ROUND_BLOCK_THRESHOLD = 6;

interface RouteAndDispatchInput {
  hall: CollaborationHall;
  taskCard: HallTaskCard;
  triggerMessage: HallMessage;
  mentionRouting: ReturnType<typeof resolveHallMentionTargets>;
  toolClient: ToolClient;
}

function scheduleRouteAndDispatch(input: RouteAndDispatchInput): void {
  let pending: Promise<void> | undefined;
  pending = (async () => {
    try {
      await routeAndDispatchHallMessage(input);
    } catch (error) {
      await appendOperationAudit({
        action: "hall_task_message",
        source: "runtime",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        metadata: { taskCardId: input.taskCard.taskCardId },
      });
    } finally {
      if (pending) pendingHallBackgroundWork.delete(pending);
    }
  })();
  pendingHallBackgroundWork.add(pending);
}

async function routeAndDispatchHallMessage(input: RouteAndDispatchInput): Promise<void> {
  const { hall, triggerMessage, mentionRouting, toolClient } = input;
  let taskCard = input.taskCard;

  // A1 + A2: on every human-initiated dispatch, seed originalAssigner (once) and
  // reset per-agent auto-round counters so a fresh human turn starts clean.
  // scheduleRouteAndDispatch is only called for operator posts, so we can treat
  // triggerMessage.authorParticipantId as the human here.
  const assignerPatch: Parameters<typeof updateHallTaskCard>[0] = { taskCardId: taskCard.taskCardId };
  let needsAssignerWrite = false;
  if (!taskCard.originalAssignerParticipantId && triggerMessage.authorParticipantId) {
    assignerPatch.originalAssignerParticipantId = triggerMessage.authorParticipantId;
    needsAssignerWrite = true;
  }
  if (taskCard.autoRoundsByAgent && Object.keys(taskCard.autoRoundsByAgent).length > 0) {
    assignerPatch.autoRoundsByAgent = {};
    needsAssignerWrite = true;
  }
  if (needsAssignerWrite) {
    try {
      const result = await updateHallTaskCard(assignerPatch);
      taskCard = result.taskCard;
    } catch {
      // Non-fatal: even if this patch fails we still want to route the message.
    }
  }

  // Determine target agents
  let targetParticipants: HallParticipant[];

  if (mentionRouting.broadcastAll) {
    // @all → dispatch all active agents
    targetParticipants = hall.participants.filter((p) => p.active && p.participantId !== "operator");
  } else if (mentionRouting.targets.length > 0) {
    // @specific agent(s) → dispatch those
    targetParticipants = mentionRouting.targets
      .map((t) => findParticipant(hall.participants, t.participantId))
      .filter((p): p is HallParticipant => p != null && p.active);
  } else {
    // No @mention → dispatch main agent (default responder)
    const mainAgent = hall.participants.find((p) => p.active && /\bmain\b/i.test(p.agentId ?? p.participantId));
    if (mainAgent) {
      targetParticipants = [mainAgent];
    } else {
      // Fallback: first active agent
      const fallback = hall.participants.find((p) => p.active);
      targetParticipants = fallback ? [fallback] : [];
    }
  }

  if (targetParticipants.length === 0) return;

  // Load thread messages for context
  const recentThreadMessages = await loadRecentHallThreadMessages(taskCard);

  // Dispatch all targets concurrently
  await Promise.allSettled(
    targetParticipants.map((participant) =>
      dispatchHallAgentReply({
        hall,
        taskCard,
        participant,
        triggerMessage,
        recentThreadMessages,
        toolClient,
        chainDepth: 0,
      }),
    ),
  );

  // Observer dispatch: if main was NOT the primary target, let it observe after the round settles
  const mainAgentId = resolveMainAgentParticipantId(hall.participants);
  const mainWasPrimaryTarget = mainAgentId != null && targetParticipants.some((p) => p.participantId === mainAgentId);
  if (!mainWasPrimaryTarget && mainAgentId) {
    const mainParticipant = hall.participants.find((p) => p.participantId === mainAgentId);
    if (mainParticipant && canDispatchHallToRuntime(toolClient, mainParticipant)) {
      await dispatchMainObserver({
        hall,
        taskCard,
        mainParticipant,
        toolClient,
      });
    }
  }
}

function resolveMainAgentParticipantId(participants: HallParticipant[]): string | undefined {
  return participants.find((p) => p.active && /\bmain\b/i.test(p.agentId ?? p.participantId))?.participantId;
}

const OBSERVE_SILENT_MARKER = "OBSERVE_SILENT";

async function dispatchMainObserver(input: {
  hall: CollaborationHall;
  taskCard: HallTaskCard;
  mainParticipant: HallParticipant;
  toolClient: ToolClient;
}): Promise<void> {
  const { hall, taskCard, mainParticipant, toolClient } = input;

  // Reload thread messages to include the latest agent responses
  const recentThreadMessages = await loadRecentHallThreadMessages(taskCard);

  let result: HallRuntimeDispatchResult;
  try {
    result = await dispatchHallRuntimeTurn({
      client: toolClient,
      hall,
      taskCard,
      participant: mainParticipant,
      recentThreadMessages,
      mode: "execution",
      note: [
        "You are observing this thread as a background reviewer.",
        "Review the recent agent exchanges above.",
        "Only speak if you have a genuinely useful observation, suggestion, or correction.",
        "If nothing to add, respond with exactly: " + OBSERVE_SILENT_MARKER,
        "Do NOT speak just to agree, summarize, or acknowledge. Silence is preferred over noise.",
      ].join(" "),
    });
  } catch {
    return; // Observer failures are silent
  }

  if (result.canceled) return;

  // Suppress silent responses
  const trimmed = result.content.trim();
  if (!trimmed || trimmed === OBSERVE_SILENT_MARKER || trimmed.startsWith(OBSERVE_SILENT_MARKER)) return;

  // Persist the observer's message
  await appendPersistedHallMessage({
    hallId: hall.hallId,
    kind: result.kind,
    participant: mainParticipant,
    content: result.content,
    targetParticipantIds: [],
    projectId: taskCard.projectId,
    taskId: taskCard.taskId,
    taskCardId: taskCard.taskCardId,
    roomId: taskCard.roomId,
    payload: result.payload,
  });

  // If observer @mentioned someone, auto-chain.
  // A3: also exclude the author of the latest agent message — the message the
  // observer is reacting to — so the observer can't immediately re-dispatch
  // whoever just wrote and turn observation into ping-pong.
  const updatedMessages = await loadRecentHallThreadMessages(taskCard);
  const lastMessage = updatedMessages[updatedMessages.length - 1];
  const triggerAuthorId = lastMessage?.authorParticipantId;
  const observerMentions = resolveHallMentionTargets(result.content, hall.participants);
  const chainTargets = observerMentions.targets
    .map((t) => findParticipant(hall.participants, t.participantId))
    .filter((p): p is HallParticipant =>
      p != null
      && p.active
      && p.participantId !== mainParticipant.participantId
      && p.participantId !== triggerAuthorId,
    );
  if (chainTargets.length > 0) {
    await Promise.allSettled(
      chainTargets.map((target) =>
        dispatchHallAgentReply({
          hall,
          taskCard,
          participant: target,
          triggerMessage: lastMessage ?? { content: result.content } as HallMessage,
          recentThreadMessages: updatedMessages,
          toolClient,
          chainDepth: 1,
        }),
      ),
    );
  }
}

async function dispatchHallAgentReply(input: {
  hall: CollaborationHall;
  taskCard: HallTaskCard;
  participant: HallParticipant;
  triggerMessage: HallMessage;
  recentThreadMessages: HallMessage[];
  toolClient: ToolClient;
  chainDepth: number;
}): Promise<void> {
  const { hall, participant, triggerMessage, recentThreadMessages, toolClient, chainDepth } = input;
  let taskCard = input.taskCard;

  const canDispatch = canDispatchHallToRuntime(toolClient, participant);
  if (!canDispatch) return;

  // A2: increment per-(card, agent) auto-round counter and stop if we hit the
  // block threshold. Counters reset whenever an operator posts (see
  // routeAndDispatchHallMessage above).
  const agentKey = (participant.agentId ?? participant.participantId).trim();
  if (agentKey) {
    const rounds = { ...(taskCard.autoRoundsByAgent ?? {}) };
    rounds[agentKey] = (rounds[agentKey] ?? 0) + 1;
    try {
      const patched = await updateHallTaskCard({
        taskCardId: taskCard.taskCardId,
        autoRoundsByAgent: rounds,
      });
      taskCard = patched.taskCard;
    } catch {
      // Non-fatal: counter state is best-effort.
    }
    if ((rounds[agentKey] ?? 0) >= AUTO_ROUND_BLOCK_THRESHOLD) {
      await handleAutoRoundBlockedThreshold({ hall, taskCard, participant, rounds });
      return;
    }
  }

  // Dispatch the agent
  let result: HallRuntimeDispatchResult;
  try {
    result = await dispatchHallRuntimeTurn({
      client: toolClient,
      hall,
      taskCard,
      participant,
      triggerMessage,
      recentThreadMessages,
      mode: "execution",
      note: input.triggerMessage.content,
    });
  } catch (error) {
    await appendRuntimeFailureHallMessage(hall, taskCard, participant, error);
    return;
  }

  if (result.canceled) return;

  // A4: treat OBSERVE_SILENT from any agent (not just the observer path) as
  // "nothing to add" — do not persist, do not trigger downstream wake / chain.
  const trimmedReply = result.content.trim();
  if (
    !trimmedReply
    || trimmedReply === OBSERVE_SILENT_MARKER
    || trimmedReply.startsWith(OBSERVE_SILENT_MARKER)
  ) {
    return;
  }

  // Persist the agent's reply
  const replyMessage = await appendPersistedHallMessage({
    hallId: hall.hallId,
    kind: result.kind,
    participant,
    content: result.content,
    targetParticipantIds: [],
    projectId: taskCard.projectId,
    taskId: taskCard.taskId,
    taskCardId: taskCard.taskCardId,
    roomId: taskCard.roomId,
    payload: result.payload,
  });

  // Handle parallel_dispatch directive
  const directive = result.chainDirective;
  if (directive?.nextAction === "parallel_dispatch" && directive.parallelTasks?.length) {
    scheduleParallelDispatch({
      hall,
      taskCard: await requireTaskCard(taskCard.taskCardId),
      initiator: participant,
      parallelTasks: directive.parallelTasks,
      toolClient,
    });
  }

  // Auto-chain: if agent @mentioned other agents, dispatch them (up to depth limit)
  if (chainDepth < MAX_AUTO_CHAIN_DEPTH) {
    const replyMentions = resolveHallMentionTargets(result.content, hall.participants);
    const triggerAuthorId = triggerMessage.authorParticipantId;
    const chainTargets = replyMentions.targets
      .map((t) => findParticipant(hall.participants, t.participantId))
      // A3: also exclude the participant who triggered us (triggerMessage author)
      // to break A→B→A ping-pong. The trigger author is presumed to already know
      // what's happening in the thread; if they genuinely need more info they
      // can post a new message as a human or via the dispatcher/PM path.
      .filter((p): p is HallParticipant =>
        p != null
        && p.active
        && p.participantId !== participant.participantId
        && p.participantId !== triggerAuthorId,
      );

    if (chainTargets.length > 0) {
      const updatedThreadMessages = await loadRecentHallThreadMessages(taskCard);
      const mentionResults = await Promise.allSettled(
        chainTargets.map((target) =>
          dispatchHallAgentReply({
            hall,
            taskCard,
            participant: target,
            triggerMessage: replyMessage,
            recentThreadMessages: updatedThreadMessages,
            toolClient,
            chainDepth: chainDepth + 1,
          }),
        ),
      );

      // Notify originating agent that @mentioned agents have completed
      if (canDispatchHallToRuntime(toolClient, participant)) {
        await wakeMentionInitiator({
          hall,
          taskCard,
          initiator: participant,
          mentionedTargets: chainTargets,
          mentionResults,
          toolClient,
        });
      }
    }
  }
}

async function handleAutoRoundBlockedThreshold(input: {
  hall: CollaborationHall;
  taskCard: HallTaskCard;
  participant: HallParticipant;
  rounds: Record<string, number>;
}): Promise<void> {
  const { hall, taskCard, participant, rounds } = input;
  const agentKey = (participant.agentId ?? participant.participantId).trim();
  const count = rounds[agentKey] ?? AUTO_ROUND_BLOCK_THRESHOLD;

  // Mark the card blocked + add a blockers reason so the UI surfaces the
  // "needs human review" state we already support (commit 21f9403). Tolerate
  // the update failing: the system message below is the user-visible signal.
  const blockerReason =
    `auto-paused: 与 @${participant.displayName} 的对话轮次达 ${count}，请人工审核后继续`;
  const mergedBlockers = Array.from(
    new Set([...(taskCard.blockers ?? []), blockerReason]),
  );
  try {
    await updateHallTaskCard({
      taskCardId: taskCard.taskCardId,
      status: "blocked",
      blockers: mergedBlockers,
    });
  } catch {
    // Non-fatal: surface the block via the system message even if update fails.
  }

  try {
    await appendHallSystemMessage({
      hallId: hall.hallId,
      content: `[系统] 与 @${participant.displayName} 的对话轮次已达 ${count}，已暂停并标记为需要人类审核，请人工点击审批后继续。`,
      projectId: taskCard.projectId,
      taskId: taskCard.taskId,
      taskCardId: taskCard.taskCardId,
      roomId: taskCard.roomId,
    });
  } catch {
    // Best-effort.
  }
}

async function wakeMentionInitiator(input: {
  hall: CollaborationHall;
  taskCard: HallTaskCard;
  initiator: HallParticipant;
  mentionedTargets: HallParticipant[];
  mentionResults: PromiseSettledResult<void>[];
  toolClient: ToolClient;
}): Promise<void> {
  const { hall, taskCard, initiator, mentionedTargets, toolClient } = input;

  // Reload thread messages to capture what the mentioned agents wrote
  const latestMessages = await loadRecentHallThreadMessages(taskCard);
  const language = inferHallResponseLanguage(`${taskCard.title}\n${taskCard.description}`);

  // Summarize each mentioned agent's latest response
  const agentSummaries: string[] = [];
  for (const target of mentionedTargets) {
    const targetMessage = [...latestMessages]
      .reverse()
      .find((m) => m.authorParticipantId === target.participantId);
    const summary = targetMessage?.content?.trim()?.slice(0, 400)
      || (language === "zh" ? "(无回复)" : "(no reply)");
    agentSummaries.push(`- ${target.displayName}: ${summary}`);
  }

  const wakeNote = language === "zh"
    ? [
        `[提及回复完成通知]`,
        `你 @提及的 Agent 已完成回复:`,
        ...agentSummaries,
        ``,
        `请审查以上回复，决定是否需要进一步操作。`,
      ].join("\n")
    : [
        `[Mention reply completion notice]`,
        `The agents you @mentioned have finished replying:`,
        ...agentSummaries,
        ``,
        `Review the replies above and decide if further action is needed.`,
      ].join("\n");

  let result: HallRuntimeDispatchResult;
  try {
    result = await dispatchHallRuntimeTurn({
      client: toolClient,
      hall,
      taskCard,
      participant: initiator,
      mode: "execution",
      note: wakeNote,
    });
  } catch {
    return; // Callback failures are non-fatal
  }

  if (result.canceled) return;

  // Suppress silent / empty responses
  const trimmed = result.content.trim();
  if (!trimmed || trimmed === OBSERVE_SILENT_MARKER || trimmed.startsWith(OBSERVE_SILENT_MARKER)) return;

  // Persist the initiator's follow-up message
  await appendPersistedHallMessage({
    hallId: hall.hallId,
    kind: result.kind,
    participant: initiator,
    content: result.content,
    targetParticipantIds: [],
    projectId: taskCard.projectId,
    taskId: taskCard.taskId,
    taskCardId: taskCard.taskCardId,
    roomId: taskCard.roomId,
    payload: result.payload,
  });

  // Process the initiator's response directive
  const directive = result.chainDirective;
  if (directive?.nextAction === "parallel_dispatch" && directive.parallelTasks?.length) {
    scheduleParallelDispatch({
      hall,
      taskCard: await requireTaskCard(taskCard.taskCardId),
      initiator,
      parallelTasks: directive.parallelTasks,
      toolClient,
    });
  } else if (directive?.nextAction && directive.nextAction !== "continue") {
    await applyHallExecutionDirective({
      hall,
      taskCard: await requireTaskCard(taskCard.taskCardId),
      participant: initiator,
      directive,
      toolClient,
    });
  }
}

function shouldPromoteHallMessageToTask(content: string, hasExplicitMention: boolean): boolean {
  if (hasExplicitMention) return false;
  const intent = classifyHallOperatorIntent(content);
  return intent === "discussion_request" || intent === "task_request";
}

function classifyHallOperatorIntent(content: string): HallOperatorIntent {
  const trimmed = content.trim();
  if (!trimmed) return "light_chat";
  if (isHallGreetingOnly(trimmed)) return "greeting";

  const normalized = trimmed.toLowerCase();
  const strongTaskSignal = [
    /\b(build|fix|implement|create|design|plan|make|ship|debug|investigate|review|prototype|brainstorm|research|analyze|animate|visuali[sz]e)\b/i,
    /(帮我|请帮|请你|麻烦|需要|我想|我想要|我想做|希望|制作|做一个|设计|策划|规划|分析|研究|实现|修|新增|创建|检查|排查|审核|产出|整理|写一个|准备|生成|可视化|动画|方案|创意|策略|发布|故事板|脚本)/,
  ].some((pattern) => pattern.test(trimmed));
  if (strongTaskSignal) return "task_request";

  const discussionSignal = [
    /[?？]/,
    /\b(how|what|why|which|should|could|can|ideas?|advice|approach|direction|options?)\b/i,
    /(如何|怎么|为什么|是否|要不要|应该|可以怎么|思路|建议|方向|想法|比较|评估|怎么做|做什么)/,
  ].some((pattern) => pattern.test(trimmed));
  if (discussionSignal) return "discussion_request";

  if (normalized.length >= 18) return "discussion_request";
  if (/[，。！？,.!?]/.test(trimmed) && trimmed.length >= 12) return "discussion_request";
  return "light_chat";
}

function isHallGreetingOnly(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  return [
    "hi",
    "hello",
    "hey",
    "yo",
    "hola",
    "你好",
    "您好",
    "嗨",
    "在吗",
    "有人吗",
  ].includes(normalized);
}

function resolveLobbyParticipants(
  participants: HallParticipant[],
  targetParticipantIds: string[],
): HallParticipant[] {
  const uniqueTargets = [...new Set(targetParticipantIds.filter(Boolean))];
  if (uniqueTargets.length > 0) {
    return uniqueTargets
      .map((participantId) => findParticipant(participants, participantId))
      .filter((participant): participant is HallParticipant => Boolean(participant));
  }
  const defaultParticipant = pickPrimaryParticipantByRole(participants, "planner")
    ?? pickPrimaryParticipantByRole(participants, "manager")
    ?? participants[0];
  return defaultParticipant ? [defaultParticipant] : [];
}

async function appendLobbyHallReply(input: {
  hall: CollaborationHall;
  participant: HallParticipant;
  triggerMessage: HallMessage;
}): Promise<HallMessage> {
  const content = buildLobbyHallReply(input.participant, input.triggerMessage.content);
  const draftId = await streamHallDraftReply({
    hallId: input.hall.hallId,
    authorParticipantId: input.participant.participantId,
    authorLabel: input.participant.displayName,
    authorSemanticRole: input.participant.semanticRole,
    messageKind: "chat",
    content,
  });
  const message = (
    await appendHallMessage({
      hallId: input.hall.hallId,
      kind: "chat",
      authorParticipantId: input.participant.participantId,
      authorLabel: input.participant.displayName,
      authorSemanticRole: input.participant.semanticRole,
      content,
      targetParticipantIds: [],
      payload: {
        status: "hall_lobby_reply",
      },
    })
  ).message;
  completeHallDraftReply({
    hallId: input.hall.hallId,
    draftId,
    messageId: message.messageId,
    content,
  });
  return message;
}

function buildLobbyHallReply(participant: HallParticipant, rawContent: string): string {
  const language = inferHallResponseLanguage(rawContent);
  const intent = classifyHallOperatorIntent(rawContent);
  if (isHallGreetingOnly(rawContent)) {
    if (participant.semanticRole === "planner") {
      return language === "zh"
        ? `${participant.displayName} 在。你可以直接描述想完成的任务、限制和 done_when；如果只是想点名某个人，也可以直接 @ 他。`
        : `${participant.displayName} is here. You can describe the task, constraints, and done_when directly, or @ a specific agent if you want to address someone.`;
    }
    return language === "zh"
      ? `${participant.displayName} 在。你可以先说清楚任务目标，或者直接 @ 某个 agent 开始对话。`
      : `${participant.displayName} is here. You can clarify the goal first, or start by @mentioning a specific agent.`;
  }
  if (intent === "discussion_request" || intent === "task_request") {
    if (participant.semanticRole === "planner") {
      return language === "zh"
        ? `${participant.displayName} 收到。我会先把这件事收敛成一条可讨论的任务线程，然后拉相关 agent 一起讨论目标、限制、风险和执行顺序。`
        : `${participant.displayName} got it. I will first turn this into a discussable task thread, then bring the relevant agents in to discuss goals, constraints, risks, and execution order.`;
    }
    if (isManagerLike(participant.semanticRole)) {
      return language === "zh"
        ? `${participant.displayName} 收到。我们会先在大厅里展开讨论，再由你来决定谁先执行、谁后执行。`
        : `${participant.displayName} got it. We will discuss it in the hall first, then you can decide who should execute first and who should follow.`;
    }
  }
  if (participant.semanticRole === "planner") {
    return language === "zh"
      ? `${participant.displayName} 收到。你这条消息还没有绑定任务线程；如果这是一个新任务，我可以先帮你把目标、限制和完成标准收敛成第一张线程卡。`
      : `${participant.displayName} got it. This message is not attached to a task thread yet; if this is a new task, I can first help turn the goal, constraints, and definition of done into the first thread card.`;
  }
  if (isManagerLike(participant.semanticRole)) {
    return language === "zh"
      ? `${participant.displayName} 收到。先在大厅里把任务目标说清楚，我们再决定由谁执行。`
      : `${participant.displayName} got it. Let us clarify the task goal in the hall first, then decide who should execute it.`;
  }
  return language === "zh"
    ? `${participant.displayName} 收到了你的大厅消息。如果这是一个新任务，请先说明目标和完成标准；如果是定向问题，也可以继续直接 @ 我。`
    : `${participant.displayName} received your hall message. If this is a new task, please explain the goal and definition of done first; if it is a targeted question, you can keep @mentioning me directly.`;
}

function sanitizeExecutionOrder(
  participants: HallParticipant[],
  participantIds: string[],
  options: { excludeParticipantId?: string } = {},
): string[] {
  const exclude = options.excludeParticipantId?.trim();
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const rawId of participantIds) {
    const participantId = rawId.trim();
    if (!participantId) continue;
    if (exclude && participantId === exclude) continue;
    if (seen.has(participantId)) continue;
    if (participants.length > 0 && !findParticipant(participants, participantId)) continue;
    seen.add(participantId);
    ordered.push(participantId);
  }
  return ordered;
}

function sanitizeExecutionItems(
  participants: HallParticipant[],
  items: HallExecutionItem[] | undefined,
  options: { excludeParticipantId?: string } = {},
): HallExecutionItem[] {
  if (!Array.isArray(items)) return [];
  const exclude = options.excludeParticipantId?.trim();
  const seen = new Set<string>();
  const ordered: HallExecutionItem[] = [];
  for (const candidate of items) {
    const participantId = candidate?.participantId?.trim();
    const task = candidate?.task?.trim();
    if (!participantId || !task) continue;
    if (exclude && participantId === exclude) continue;
    if (seen.has(participantId)) continue;
    if (participants.length > 0 && !findParticipant(participants, participantId)) continue;
    seen.add(participantId);
    ordered.push({
      itemId: candidate.itemId?.trim() || randomUUID(),
      participantId,
      task,
      handoffToParticipantId: candidate.handoffToParticipantId?.trim() || undefined,
      handoffWhen: candidate.handoffWhen?.trim() || undefined,
    });
  }
  return ordered;
}

function deriveExecutionItemsFromOrder(
  participants: HallParticipant[],
  participantIds: string[],
  taskCard: HallTaskCard,
  options: { existingItems?: HallExecutionItem[]; primaryDoneWhen?: string } = {},
): HallExecutionItem[] {
  const existing = new Map(
    (options.existingItems || []).map((item) => [item.participantId, item] as const),
  );
  const doneWhen = options.primaryDoneWhen?.trim() || taskCard.doneWhen?.trim() || undefined;
  return participantIds.map((participantId, index) => {
    const participant = findParticipant(participants, participantId);
    const cached = existing.get(participantId);
    const nextParticipantId = cached?.handoffToParticipantId && participantIds.includes(cached.handoffToParticipantId)
      ? cached.handoffToParticipantId
      : participantIds[index + 1];
    const nextParticipant = nextParticipantId ? findParticipant(participants, nextParticipantId) : undefined;
    return {
      itemId: cached?.itemId || randomUUID(),
      participantId,
      task: cached?.task || buildExecutionItemTask(taskCard, participant, index),
      handoffToParticipantId: nextParticipant?.participantId,
      handoffWhen: cached?.handoffWhen || buildExecutionItemHandoff(taskCard, participant, nextParticipant, index, doneWhen),
    };
  });
}


function shiftExecutionItemsForOwner(taskCard: HallTaskCard, ownerParticipantId: string | undefined): HallExecutionItem[] {
  if (!ownerParticipantId) return taskCard.plannedExecutionItems || [];
  const seen = new Set<string>();
  return (taskCard.plannedExecutionItems || []).filter((item) => {
    if (item.participantId === ownerParticipantId) return false;
    if (seen.has(item.participantId)) return false;
    seen.add(item.participantId);
    return true;
  });
}


function followupRoleOrderForDomain(
  domain: HallDiscussionDomain,
  ownerParticipantId: string,
  participants: HallParticipant[],
): HallSemanticRole[] {
  const ownerRole = findParticipant(participants, ownerParticipantId)?.semanticRole;
  if (domain === "creative") {
    return ownerRole === "planner" ? ["coder", "reviewer", "generalist"] : ["planner", "reviewer", "generalist"];
  }
  if (domain === "engineering") {
    return ownerRole === "coder" ? ["reviewer", "planner", "generalist"] : ["coder", "reviewer", "generalist"];
  }
  if (domain === "research" || domain === "analysis" || domain === "operations" || domain === "product") {
    return ownerRole === "reviewer" ? ["planner", "generalist", "coder"] : ["reviewer", "planner", "generalist"];
  }
  return ["reviewer", "planner", "coder", "generalist"];
}

function pickPreferredExecutionFollowup(
  hall: CollaborationHall,
  taskCard: HallTaskCard,
  candidateIds: string[],
  ownerParticipantId: string,
  options: { preferredRoles: HallSemanticRole[]; excludeParticipantIds?: string[] } ,
): string | undefined {
  const excluded = new Set([ownerParticipantId, ...(options.excludeParticipantIds || [])]);
  for (const role of options.preferredRoles) {
    const match = candidateIds
      .map((participantId) => findParticipant(hall.participants, participantId))
      .find((participant) => participant && !excluded.has(participant.participantId) && participant.semanticRole === role);
    if (match) return match.participantId;
  }

  for (const participantId of candidateIds) {
    if (excluded.has(participantId)) continue;
    return participantId;
  }

  for (const role of options.preferredRoles) {
    if (role === "generalist" || role === "observer") {
      const participant = hall.participants.find(
        (p) => p.active && p.semanticRole === role && !excluded.has(p.participantId),
      );
      if (participant) return participant.participantId;
      continue;
    }
    const participant = pickPrimaryParticipantByRole(hall.participants, role);
    if (participant && !excluded.has(participant.participantId)) return participant.participantId;
  }

  return undefined;
}

function buildExecutionItemTask(
  taskCard: HallTaskCard,
  participant: HallParticipant | undefined,
  index: number,
): string {
  const title = taskCard.title.trim();
  const lower = `${title} ${taskCard.description || ""}`.toLowerCase();
  const language = inferHallResponseLanguage(`${taskCard.title}\n${taskCard.description}`);
  const focus = summarizeExecutionFocus(taskCard, language);
  if (!participant) {
    return language === "zh"
      ? (index === 0
        ? `先把“${title}”的第一步做成可评审结果${focus ? `，重点是：${focus}` : "。"}`
        : `承接“${title}”的下一步并把结果贴回大厅${focus ? `，重点延续：${focus}` : "。"}`
      )
      : (index === 0
        ? `Take the first concrete pass on "${title}"${focus ? `, focusing on ${focus}` : ""}.`
        : `Support the next step for "${title}"${focus ? `, continuing the work on ${focus}` : ""}.`
      );
  }
  if (participant.semanticRole === "planner") {
    if (language === "zh") {
      return `先把“${title}”收成一版明确方向：目标、范围、约束和成功标准${focus ? `，重点围绕：${focus}` : "。"}`
      ;
    }
    return `Turn "${title}" into a clear first-pass direction with scope, constraints, and success criteria${focus ? `, centered on ${focus}` : ""}.`;
  }
  if (participant.semanticRole === "coder") {
    if (language === "zh") {
      return `完成“${title}”的第一版执行结果，并把产物贴回群里${focus ? `，重点落实：${focus}` : "。"}`
      ;
    }
    return `Deliver the first concrete pass for "${title}" and leave a reviewable artifact in the thread${focus ? `, focusing on ${focus}` : ""}.`;
  }
  if (participant.semanticRole === "reviewer") {
    if (language === "zh") return `只看上一位交付的结果，指出必须改的一点；没硬 blocker 就直接交给下一位${focus ? `，重点盯：${focus}` : "。"}`
    ;
    return `Review the previous pass for "${title}", call out only the must-fix point, and if there is no real blocker, send it straight to the next owner${focus ? `, especially around ${focus}` : ""}.`;
  }
  if (isManagerLike(participant.semanticRole)) {
    if (language === "zh") return `收住这轮结果，锁一句结论和下一步；后面还有 owner 就直接交棒${focus ? `，重点别漏：${focus}` : "。"}`
    ;
    return `Close the loop on "${title}", confirm the action items and next decision, and decide whether the chain should continue${focus ? `, making sure ${focus} is covered` : ""}.`;
  }
  if (language === "zh") {
    return index === 0
      ? `先把“${title}”做成第一版可评审结果${focus ? `，重点是：${focus}` : "。"}`
      : `承接“${title}”的下一步并继续推进${focus ? `，重点延续：${focus}` : "。"}`
      ;
  }
  return index === 0
    ? `Take the first practical pass on "${title}" and share a reviewable result${focus ? `, focusing on ${focus}` : ""}.`
    : `Pick up the next step for "${title}" and move the chain forward${focus ? `, continuing the work on ${focus}` : ""}.`;
}

function summarizeExecutionFocus(taskCard: HallTaskCard, language: HallResponseLanguage): string | undefined {
  const raw = [taskCard.decision, taskCard.proposal, taskCard.latestSummary, taskCard.description]
    .map((value) => value?.trim())
    .find(Boolean);
  if (!raw) return undefined;
  const singleLine = raw.replace(/\s+/g, " ").trim();
  const sentence = singleLine.split(/[。！？.!?]/)[0]?.trim();
  if (!sentence) return undefined;
  const stripped = sentence
    .replace(new RegExp(`^${escapeRegExp(taskCard.title)}[:：,，\\s-]*`, "i"), "")
    .replace(/^(关于|针对|For|About)\s*/i, "")
    .trim();
  if (!stripped) return undefined;
  const max = language === "zh" ? 34 : 64;
  return stripped.length > max ? `${stripped.slice(0, max).trim()}…` : stripped;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildExecutionItemHandoff(
  taskCard: HallTaskCard,
  participant: HallParticipant | undefined,
  nextParticipant: HallParticipant | undefined,
  index: number,
  doneWhen: string | undefined,
): string | undefined {
  const language = inferHallResponseLanguage(`${taskCard.title}\n${taskCard.description}`);
  if (index === 0 && doneWhen) {
    return nextParticipant
      ? (language === "zh"
        ? `做到“${doneWhen}”就把结果贴回大厅，@${nextParticipant.displayName} 接着做。`
        : `When this pass reaches "${doneWhen}" or is at least reviewable, post the result in the hall and @${nextParticipant.displayName} to continue.`)
      : doneWhen;
  }
  if (nextParticipant) {
    return language === "zh"
      ? `把结果贴回大厅，@${nextParticipant.displayName} 接着做。`
      : `Post the result in the hall and @${nextParticipant.displayName} with what changed, where the artifact lives, what remains, and what the next step should be.`;
  }
  if (participant?.semanticRole === "reviewer") {
    return language === "zh"
      ? "当审核结论和必须修改项已经在大厅里说清楚时收尾。"
      : "Close once the review verdict and required changes are explicit in the hall.";
  }
  return doneWhen;
}

function findExecutionItemForParticipant(
  taskCard: HallTaskCard,
  participantId: string | undefined,
): HallExecutionItem | undefined {
  if (!participantId) return undefined;
  const currentItem = taskCard.currentExecutionItem;
  if (currentItem?.participantId === participantId) return currentItem;
  return taskCard.plannedExecutionItems.find((item) => item.participantId === participantId);
}

function getCurrentExecutionItem(taskCard: HallTaskCard): HallExecutionItem | undefined {
  return findExecutionItemForParticipant(taskCard, taskCard.currentOwnerParticipantId);
}

function getExpectedNextExecutionOwner(taskCard: HallTaskCard): string | undefined {
  const currentExecutionItem = getCurrentExecutionItem(taskCard);
  return currentExecutionItem?.handoffToParticipantId?.trim()
    || taskCard.plannedExecutionOrder[0]?.trim()
    || undefined;
}

function summarizeExecutionItemTask(
  taskCard: HallTaskCard,
  participantId: string | undefined,
  language: HallResponseLanguage,
): string | undefined {
  const item = findExecutionItemForParticipant(taskCard, participantId);
  const task = item?.task?.trim();
  if (!task) return undefined;
  const max = language === "zh" ? 72 : 120;
  return task.length > max ? `${task.slice(0, max).trim()}…` : task;
}


function buildReadyForReviewSummary(taskCard: HallTaskCard, participant: HallParticipant): string {
  const language = inferHallResponseLanguage(`${taskCard.title}\n${taskCard.description}\n${taskCard.latestSummary ?? ""}`);
  const taskSummary = summarizeExecutionItemTask(taskCard, participant.participantId, language);
  if (language === "zh") {
    return taskSummary
      ? `${participant.displayName} 把“${taskSummary}”做到可评审了，现在请老板评审。`
      : `${participant.displayName} 这一步已经可评审了，现在请老板评审。`;
  }
  return taskSummary
    ? `${participant.displayName} moved "${taskSummary}" to a reviewable state and handed this step into review.`
    : `${participant.displayName} moved the current execution step into review.`;
}

function buildReviewSummary(
  hall: CollaborationHall,
  taskCard: HallTaskCard,
  reviewer: HallParticipant,
  outcome: "approved" | "changes_requested",
  note?: string,
): string {
  const language = inferHallResponseLanguage(`${taskCard.title}\n${taskCard.description}\n${note ?? ""}`);
  const owner = findParticipant(hall.participants, taskCard.currentOwnerParticipantId);
  const taskSummary = summarizeExecutionItemTask(taskCard, taskCard.currentOwnerParticipantId, language);
  const trimmedNote = note?.trim();
  if (language === "zh") {
    if (outcome === "approved") {
      return taskSummary
        ? `${reviewer.displayName} 看过了，“${taskSummary}”可以过。${trimmedNote ? ` ${trimmedNote}` : ""}`.trim()
        : `${reviewer.displayName} 看过了，这一轮可以过。${trimmedNote ? ` ${trimmedNote}` : ""}`.trim();
    }
    const ownerMention = owner ? `@${owner.displayName}` : "当前 owner";
    return taskSummary
      ? `${reviewer.displayName} 看过了，这一步还不能过。${ownerMention} 先把“${taskSummary}”改掉。${trimmedNote ? ` ${trimmedNote}` : ""}`.trim()
      : `${reviewer.displayName} 看过了，这一轮还不能过。${ownerMention} 先按 review 改一轮。${trimmedNote ? ` ${trimmedNote}` : ""}`.trim();
  }
  if (outcome === "approved") {
    return taskSummary
      ? `${reviewer.displayName} reviewed it and this pass on "${taskSummary}" is good to ship.${trimmedNote ? ` ${trimmedNote}` : ""}`.trim()
      : `${reviewer.displayName} reviewed it and this pass is good to ship.${trimmedNote ? ` ${trimmedNote}` : ""}`.trim();
  }
  const ownerMention = owner ? `@${owner.displayName}` : "the current owner";
  return taskSummary
    ? `${reviewer.displayName} reviewed it and this pass on "${taskSummary}" still needs work. ${ownerMention}, please revise this step and bring it back.${trimmedNote ? ` ${trimmedNote}` : ""}`.trim()
    : `${reviewer.displayName} reviewed it and this pass still needs work. ${ownerMention}, please revise it and bring it back.${trimmedNote ? ` ${trimmedNote}` : ""}`.trim();
}

function shiftExecutionQueueForOwner(taskCard: HallTaskCard, ownerParticipantId: string | undefined): string[] {
  if (!ownerParticipantId) return taskCard.plannedExecutionOrder;
  const seen = new Set<string>();
  return taskCard.plannedExecutionOrder.filter((participantId) => {
    if (participantId === ownerParticipantId) return false;
    if (seen.has(participantId)) return false;
    seen.add(participantId);
    return true;
  });
}

export async function setHallTaskExecutionOrder(input: SetHallExecutionOrderInput): Promise<HallMutationResult> {
  const context = await ensureHallContext();
  let taskCard = await requireTaskCard(input.taskCardId);
  // A task card has an "active execution" lane iff an execution lock is held.
  // The stage machine is gone; the lock is the single source of truth.
  const hasLockedActiveExecution = Boolean(taskCard.executionLock && !taskCard.executionLock.releasedAt);
  const activeExecutionParticipantId = hasLockedActiveExecution
    ? (taskCard.currentExecutionItem?.participantId?.trim() || taskCard.currentOwnerParticipantId?.trim() || undefined)
    : undefined;
  const executionItems = sanitizeExecutionItems(context.hall.participants, input.executionItems);
  const executionOrder = executionItems.length > 0
    ? executionItems.map((item) => item.participantId)
    : sanitizeExecutionOrder(context.hall.participants, input.participantIds);
  const explicitCurrentExecutionItem = activeExecutionParticipantId
    ? executionItems.find((item) => item.participantId === activeExecutionParticipantId)
    : undefined;
  const normalizedExecutionItems = executionItems.length > 0
    ? deriveExecutionItemsFromOrder(
        context.hall.participants,
        executionOrder,
        taskCard,
        { existingItems: executionItems, primaryDoneWhen: taskCard.doneWhen },
      )
    : deriveExecutionItemsFromOrder(
        context.hall.participants,
        executionOrder,
        taskCard,
        { existingItems: taskCard.plannedExecutionItems, primaryDoneWhen: taskCard.doneWhen },
      );
  const currentExecutionItem = activeExecutionParticipantId
    ? explicitCurrentExecutionItem
      ?? normalizedExecutionItems.find((item) => item.participantId === activeExecutionParticipantId)
      ?? taskCard.currentExecutionItem
      ?? findExecutionItemForParticipant(taskCard, activeExecutionParticipantId)
    : null;
  const plannedExecutionItems = activeExecutionParticipantId
    ? normalizedExecutionItems.filter((item) => item.participantId !== activeExecutionParticipantId)
    : normalizedExecutionItems;
  const plannedExecutionOrder = activeExecutionParticipantId
    ? plannedExecutionItems.map((item) => item.participantId)
    : executionOrder;
  const activeExecutionParticipant = activeExecutionParticipantId
    ? findParticipant(context.hall.participants, activeExecutionParticipantId)
    : undefined;
  taskCard = (
    await updateHallTaskCard({
      taskCardId: taskCard.taskCardId,
      plannedExecutionOrder,
      plannedExecutionItems,
      currentExecutionItem: hasLockedActiveExecution
        ? currentExecutionItem
        : null,
      currentOwnerParticipantId: hasLockedActiveExecution
        ? (activeExecutionParticipantId ?? taskCard.currentOwnerParticipantId)
        : null,
      currentOwnerLabel: hasLockedActiveExecution
        ? (activeExecutionParticipant?.displayName ?? taskCard.currentOwnerLabel)
        : null,
      latestSummary: input.note?.trim() || taskCard.latestSummary,
    })
  ).taskCard;

  const generatedMessages: HallMessage[] = [];

  const refreshed = await refreshHallAndTaskSummary(context.hall.hallId, taskCard);
  await appendOperationAudit({
    action: "hall_task_execution_order",
    source: "api",
    ok: true,
    detail: `updated execution order for hall task ${taskCard.projectId}:${taskCard.taskId}`,
    metadata: {
      taskCardId: taskCard.taskCardId,
      executionOrder,
    },
  });

  return {
    hall: refreshed.hall,
    hallSummary: refreshed.hallSummary,
    taskCard: refreshed.taskCard,
    taskSummary: refreshed.taskSummary,
    generatedMessages,
    task: (await loadTaskStore()).tasks.find((item) => item.projectId === taskCard.projectId && item.taskId === taskCard.taskId),
    roomId: taskCard.roomId,
  };
}

export async function assignHallTaskExecution(
  input: AssignHallTaskInput,
  options: HallOrchestratorRuntimeOptions = {},
): Promise<HallMutationResult> {
  const context = await ensureHallContext();
  let taskCard = await requireTaskCard(input.taskCardId);
  abortHallDraftRepliesForTask({
    hallId: context.hall.hallId,
    taskCardId: taskCard.taskCardId,
    projectId: taskCard.projectId,
    taskId: taskCard.taskId,
    roomId: taskCard.roomId,
    reason: "execution_started",
  });
  const ownerParticipant =
    findParticipant(
      context.hall.participants,
      input.ownerParticipantId
      ?? taskCard.plannedExecutionOrder[0]
      ?? taskCard.currentOwnerParticipantId,
    )
    ?? pickPrimaryParticipantByRole(context.hall.participants, "coder")
    ?? context.hall.participants[0];
  if (!ownerParticipant) {
    throw new CollaborationHallStoreValidationError("No hall participants are available for assignment.", [], 409);
  }

  const reorderedExecutionOrder = [
    ownerParticipant.participantId,
    ...taskCard.plannedExecutionOrder.filter((participantId) => participantId !== ownerParticipant.participantId),
  ];
  const reorderedExecutionItems = deriveExecutionItemsFromOrder(
    context.hall.participants,
    reorderedExecutionOrder,
    taskCard,
    {
      existingItems: taskCard.plannedExecutionItems,
      primaryDoneWhen: taskCard.doneWhen,
    },
  );
  const fallbackNextParticipant = reorderedExecutionOrder[1]
    ? findParticipant(context.hall.participants, reorderedExecutionOrder[1])
    : undefined;
  const ownerExecutionItem =
    (taskCard.currentExecutionItem?.participantId === ownerParticipant.participantId ? taskCard.currentExecutionItem : undefined)
    ?? reorderedExecutionItems.find((item) => item.participantId === ownerParticipant.participantId);
  const stableOwnerExecutionItem = ownerExecutionItem
    ?? findExecutionItemForParticipant(taskCard, ownerParticipant.participantId)
    ?? {
      itemId: randomUUID(),
      participantId: ownerParticipant.participantId,
      task: buildExecutionItemTask(taskCard, ownerParticipant, 0),
      handoffToParticipantId: fallbackNextParticipant?.participantId,
      handoffWhen: buildExecutionItemHandoff(taskCard, ownerParticipant, fallbackNextParticipant, 0, taskCard.doneWhen),
    };

  taskCard = acquireHallExecutionLock(taskCard, {
    ownerParticipantId: ownerParticipant.participantId,
    ownerLabel: ownerParticipant.displayName,
  });
  taskCard = (
    await updateHallTaskCard({
      taskCardId: taskCard.taskCardId,
      status: "in_progress",
      currentOwnerParticipantId: ownerParticipant.participantId,
      currentOwnerLabel: ownerParticipant.displayName,
      executionLock: taskCard.executionLock,
      plannedExecutionOrder: reorderedExecutionOrder.slice(1),
      plannedExecutionItems: reorderedExecutionItems.filter((item) => item.participantId !== ownerParticipant.participantId),
      currentExecutionItem: stableOwnerExecutionItem,
      latestSummary: input.note ?? taskCard.latestSummary,
    })
  ).taskCard;

  let patchedTask = await patchTask({
    taskId: taskCard.taskId,
    projectId: taskCard.projectId,
    status: "in_progress",
    owner: ownerParticipant.displayName,
    roomId: taskCard.roomId,
  });

  const language = inferHallResponseLanguage(`${taskCard.title}\n${taskCard.description}\n${taskCard.decision ?? ""}\n${taskCard.latestSummary ?? ""}`);
  const ownerTask = stableOwnerExecutionItem?.task?.trim();
  const ownerHandoff = stableOwnerExecutionItem?.handoffWhen?.trim();
  const handoffContent = (() => {
    if (language === "zh") {
      if (input.note?.trim()) {
        return `${ownerParticipant.displayName} 接棒。先做：${ownerTask || "推进第一步执行"}。${input.note.trim()}`;
      }
      return `${ownerParticipant.displayName} 接棒。先做：${ownerTask || "推进第一步执行"}。${ownerHandoff ? ownerHandoff : "做完就把结果贴回大厅。"}`
    }
    if (input.note?.trim()) {
      return `${ownerParticipant.displayName} took this on. First step: ${ownerTask || "move the next execution slice forward"}. ${input.note.trim()}`;
    }
    return `${ownerParticipant.displayName} took this on. First step: ${ownerTask || "move the next execution slice forward"}. ${ownerHandoff ? `Then hand off like this: ${ownerHandoff}` : "Then post the result back to the hall and decide the next handoff."}`;
  })();
  const generatedMessages: HallMessage[] = [];
  const usedRuntimeChain = canDispatchHallToRuntime(options.toolClient, ownerParticipant);
  if (usedRuntimeChain) {
    const chain = await runHallRuntimeExecutionChain({
      hall: context.hall,
      taskCard,
      participant: ownerParticipant,
      task: patchedTask.task,
      toolClient: options.toolClient!,
      mode: "execution",
      note: input.note,
      targetParticipantIds: [ownerParticipant.participantId],
    });
    taskCard = chain.taskCard;
    if (chain.task) patchedTask = { ...patchedTask, task: chain.task };
    generatedMessages.push(...chain.generatedMessages);
  } else {
    const ownerMessage = await appendStreamedGeneratedHallMessage({
      hallId: context.hall.hallId,
      kind: "status",
      participant: ownerParticipant,
      content: handoffContent,
      targetParticipantIds: [ownerParticipant.participantId],
      projectId: taskCard.projectId,
      taskId: taskCard.taskId,
      taskCardId: taskCard.taskCardId,
      roomId: taskCard.roomId,
      payload: {
        projectId: taskCard.projectId,
        taskId: taskCard.taskId,
        taskCardId: taskCard.taskCardId,
        roomId: taskCard.roomId,
        taskStatus: patchedTask.task.status,
        nextOwnerParticipantId: ownerParticipant.participantId,
        status: "execution_started",
      },
    });
    if (ownerMessage) generatedMessages.push(ownerMessage);
  }

  if (taskCard.roomId) {
    if (!usedRuntimeChain) {
      await appendChatMessage({
        roomId: taskCard.roomId,
        kind: "status",
        authorRole: toRoomParticipantRole(ownerParticipant),
        authorLabel: ownerParticipant.displayName,
        content: handoffContent,
        payload: {
          executor: toRoomParticipantRole(ownerParticipant),
          status: "execution_started",
          taskStatus: "in_progress",
        },
      });
    }
    const linkedRoom = await requireLinkedRoom(taskCard.roomId);
    await publishTaskRoomBridgeEvent({
      type: "executor_assigned",
      room: linkedRoom,
      task: patchedTask.task,
      note: handoffContent,
    });
  }

  let refreshed = await refreshHallAndTaskSummary(context.hall.hallId, taskCard);
  if (
    refreshed.taskCard.executionLock
    && !refreshed.taskCard.executionLock.releasedAt
    && !refreshed.taskCard.currentExecutionItem
    && stableOwnerExecutionItem
  ) {
    taskCard = (
      await updateHallTaskCard({
        taskCardId: taskCard.taskCardId,
        currentExecutionItem: stableOwnerExecutionItem,
      })
    ).taskCard;
    refreshed = await refreshHallAndTaskSummary(context.hall.hallId, taskCard);
  }
  await appendOperationAudit({
    action: "hall_task_assign",
    source: "api",
    ok: true,
    detail: `assigned hall task ${taskCard.projectId}:${taskCard.taskId} to ${ownerParticipant.displayName}`,
    metadata: {
      taskCardId: taskCard.taskCardId,
      ownerParticipantId: ownerParticipant.participantId,
    },
  });

  return {
    hall: refreshed.hall,
    hallSummary: refreshed.hallSummary,
    taskCard: refreshed.taskCard,
    taskSummary: refreshed.taskSummary,
    task: patchedTask.task,
    roomId: taskCard.roomId,
    generatedMessages,
  };
}

export async function submitHallTaskReview(input: ReviewHallTaskInput): Promise<HallMutationResult> {
  const context = await ensureHallContext();
  let taskCard = await requireTaskCard(input.taskCardId);
  const reviewer = pickPrimaryParticipantByRole(context.hall.participants, "reviewer")
    ?? pickPrimaryParticipantByRole(context.hall.participants, "manager")
    ?? context.hall.participants[0];
  if (!reviewer) {
    throw new CollaborationHallStoreValidationError("No hall participants are available for review.", [], 409);
  }

  const nextTaskStatus: TaskState = input.outcome === "approved" ? "done" : input.blockTask ? "blocked" : "in_progress";
  const previousOwnerLabel = taskCard.currentOwnerLabel;
  taskCard = releaseHallExecutionLock(taskCard, input.outcome === "approved" ? "review-approved" : "review-requested-changes");
  taskCard = (
    await updateHallTaskCard({
      taskCardId: taskCard.taskCardId,
      status: nextTaskStatus,
      currentOwnerParticipantId:
        input.outcome === "approved" ? null : taskCard.currentOwnerParticipantId,
      currentOwnerLabel:
        input.outcome === "approved" ? null : taskCard.currentOwnerLabel,
      currentExecutionItem: input.outcome === "approved" ? null : taskCard.currentExecutionItem,
      executionLock: taskCard.executionLock,
      latestSummary: input.note ?? taskCard.latestSummary,
      blockers: input.outcome === "approved" ? [] : taskCard.blockers,
    })
  ).taskCard;

  const patchedTask = await patchTask({
    taskId: taskCard.taskId,
    projectId: taskCard.projectId,
    status: nextTaskStatus,
    owner: input.outcome === "approved" ? previousOwnerLabel ?? reviewer.displayName : previousOwnerLabel ?? reviewer.displayName,
    roomId: taskCard.roomId,
  });

  const reviewText = buildReviewSummary(
    context.hall,
    taskCard,
    reviewer,
    input.outcome === "approved" ? "approved" : "changes_requested",
    input.note,
  );
  const generatedMessages: HallMessage[] = [];
  const reviewMessage = await appendStreamedGeneratedHallMessage({
    hallId: context.hall.hallId,
    kind: "review",
    participant: reviewer,
    content: reviewText,
    targetParticipantIds: input.outcome === "approved" ? [] : [taskCard.currentOwnerParticipantId ?? reviewer.participantId],
    projectId: taskCard.projectId,
    taskId: taskCard.taskId,
    taskCardId: taskCard.taskCardId,
    roomId: taskCard.roomId,
    payload: {
      projectId: taskCard.projectId,
      taskId: taskCard.taskId,
      taskCardId: taskCard.taskCardId,
      roomId: taskCard.roomId,
      artifactRefs: patchedTask.task.artifacts,
      reviewOutcome: input.outcome,
      taskStatus: nextTaskStatus,
      status: input.outcome === "approved" ? "review_passed" : "review_rejected",
    },
  });
  if (reviewMessage) generatedMessages.push(reviewMessage);

  if (taskCard.roomId) {
    await submitRoomReview({
      roomId: taskCard.roomId,
      outcome: input.outcome,
      note: input.note,
      blockTask: input.blockTask,
    });
    const linkedRoom = await requireLinkedRoom(taskCard.roomId);
    await publishTaskRoomBridgeEvent({
      type: "review_submitted",
      room: linkedRoom,
      task: patchedTask.task,
      note: reviewText,
    });
  }

  const refreshed = await refreshHallAndTaskSummary(context.hall.hallId, taskCard);
  await appendOperationAudit({
    action: "hall_task_review",
    source: "api",
    ok: true,
    detail: `reviewed hall task ${taskCard.projectId}:${taskCard.taskId} with outcome ${input.outcome}`,
    metadata: {
      taskCardId: taskCard.taskCardId,
      outcome: input.outcome,
      taskStatus: nextTaskStatus,
    },
  });

  return {
    hall: refreshed.hall,
    hallSummary: refreshed.hallSummary,
    taskCard: refreshed.taskCard,
    taskSummary: refreshed.taskSummary,
    task: patchedTask.task,
    roomId: taskCard.roomId,
    generatedMessages,
  };
}

export async function stopHallTaskExecution(input: StopHallTaskInput): Promise<HallMutationResult> {
  const context = await ensureHallContext();
  let taskCard = await requireTaskCard(input.taskCardId);
  const previousOwnerLabel = taskCard.currentOwnerLabel;
  abortHallDraftRepliesForTask({
    hallId: context.hall.hallId,
    taskCardId: taskCard.taskCardId,
    projectId: taskCard.projectId,
    taskId: taskCard.taskId,
    roomId: taskCard.roomId,
    reason: "stopped_by_operator",
  });
  taskCard = releaseHallExecutionLock(taskCard, "stopped_by_operator");
  taskCard = (
    await updateHallTaskCard({
      taskCardId: taskCard.taskCardId,
      status: "todo",
      currentOwnerParticipantId: null,
      currentOwnerLabel: null,
      currentExecutionItem: null,
      executionLock: taskCard.executionLock,
      latestSummary: input.note?.trim() || taskCard.latestSummary,
    })
  ).taskCard;

  const patchedTask = await patchTask({
    taskId: taskCard.taskId,
    projectId: taskCard.projectId,
    status: "todo",
    owner: "Operator",
    roomId: taskCard.roomId,
  });

  const stopText = input.note?.trim()
    ? `Stopped. ${input.note.trim()}`
    : `${previousOwnerLabel ? `${previousOwnerLabel} stopped the current task.` : "Current task stopped."}`;
  const generatedMessages = [
    await appendHallSystemMessage({
      hallId: context.hall.hallId,
      projectId: taskCard.projectId,
      taskId: taskCard.taskId,
      taskCardId: taskCard.taskCardId,
      roomId: taskCard.roomId,
      content: stopText,
      payload: {
        taskStatus: "todo",
        status: "execution_stopped",
      },
    }),
  ];

  const refreshed = await refreshHallAndTaskSummary(context.hall.hallId, taskCard);
  await appendOperationAudit({
    action: "hall_task_stop",
    source: "api",
    ok: true,
    detail: `stopped hall task ${taskCard.projectId}:${taskCard.taskId}`,
    metadata: {
      taskCardId: taskCard.taskCardId,
    },
  });

  return {
    hall: refreshed.hall,
    hallSummary: refreshed.hallSummary,
    taskCard: refreshed.taskCard,
    taskSummary: refreshed.taskSummary,
    task: patchedTask.task,
    roomId: taskCard.roomId,
    generatedMessages,
  };
}

export async function archiveHallTaskThread(input: ArchiveHallTaskInput): Promise<HallMutationResult> {
  const context = await ensureHallContext();
  const taskCard = await requireTaskCard(input.taskCardId);
  await archiveHallTaskCard({
    taskCardId: taskCard.taskCardId,
    archivedByParticipantId: input.archivedByParticipantId ?? "operator",
    archivedByLabel: input.archivedByLabel ?? "Operator",
  });

  const hallRead = await readCollaborationHall(context.hall.hallId);
  await appendOperationAudit({
    action: "hall_task_archive",
    source: "api",
    ok: true,
    detail: `archived hall task ${taskCard.projectId}:${taskCard.taskId}`,
    metadata: {
      taskCardId: taskCard.taskCardId,
      archivedByParticipantId: input.archivedByParticipantId ?? "operator",
    },
  });

  return {
    hall: hallRead.hall,
    hallSummary: hallRead.hallSummary,
    task: (await loadTaskStore()).tasks.find((item) => item.projectId === taskCard.projectId && item.taskId === taskCard.taskId),
    roomId: taskCard.roomId,
    generatedMessages: [],
  };
}

export async function markHallTaskHumanReviewed(input: MarkHallTaskHumanReviewedInput): Promise<HallMutationResult> {
  const context = await ensureHallContext();
  const taskCard = await requireTaskCard(input.taskCardId);
  const reviewedAt = new Date().toISOString();
  await updateHallTaskCard({
    taskCardId: taskCard.taskCardId,
    humanReviewedAt: reviewedAt,
  });
  const hallRead = await readCollaborationHall(context.hall.hallId);
  await appendOperationAudit({
    action: "hall_task_mark_human_reviewed",
    source: "api",
    ok: true,
    detail: `marked hall task ${taskCard.projectId}:${taskCard.taskId} as human-reviewed`,
    metadata: {
      taskCardId: taskCard.taskCardId,
      reviewedByParticipantId: input.reviewedByParticipantId ?? "operator",
      reviewedAt,
    },
  });
  return {
    hall: hallRead.hall,
    hallSummary: hallRead.hallSummary,
    task: (await loadTaskStore()).tasks.find((item) => item.projectId === taskCard.projectId && item.taskId === taskCard.taskId),
    roomId: taskCard.roomId,
    generatedMessages: [],
  };
}

export async function deleteHallTaskThread(input: DeleteHallTaskInput): Promise<HallMutationResult> {
  const context = await ensureHallContext();
  const taskCard = await requireTaskCard(input.taskCardId);

  abortHallDraftRepliesForTask({
    hallId: context.hall.hallId,
    taskCardId: taskCard.taskCardId,
    projectId: taskCard.projectId,
    taskId: taskCard.taskId,
    roomId: taskCard.roomId,
    reason: "thread_deleted",
  });

  if (taskCard.roomId) {
    const roomStore = await loadChatRoomStore();
    if (getChatRoom(roomStore, taskCard.roomId)) {
      await deleteChatRoom({
        roomId: taskCard.roomId,
        deleteMessages: true,
      });
    }
  }

  const taskStore = await loadTaskStore();
  if (taskStore.tasks.some((item) => item.projectId === taskCard.projectId && item.taskId === taskCard.taskId)) {
    await deleteTask({
      taskId: taskCard.taskId,
      projectId: taskCard.projectId,
    });
  }

  await deleteHallMessagesForTaskCard({
    hallId: taskCard.hallId,
    taskCardId: taskCard.taskCardId,
    taskId: taskCard.taskId,
    roomId: taskCard.roomId,
  });
  await deleteHallTaskCard({
    taskCardId: taskCard.taskCardId,
  });

  const hallRead = await readCollaborationHall(context.hall.hallId);
  await appendOperationAudit({
    action: "hall_task_delete",
    source: "api",
    ok: true,
    detail: `deleted hall task ${taskCard.projectId}:${taskCard.taskId}`,
    metadata: {
      taskCardId: taskCard.taskCardId,
      roomId: taskCard.roomId,
    },
  });

  return {
    hall: hallRead.hall,
    hallSummary: hallRead.hallSummary,
    roomId: taskCard.roomId,
    generatedMessages: [],
  };
}

export async function recordHallTaskHandoff(
  input: HallHandoffInput,
  options: HallOrchestratorRuntimeOptions = {},
): Promise<HallMutationResult> {
  const context = await ensureHallContext();
  let taskCard = await requireTaskCard(input.taskCardId);
  const fromParticipant = requireHallParticipant(context.hall.participants, input.fromParticipantId, "fromParticipantId");
  const toParticipant = requireHallParticipant(context.hall.participants, input.toParticipantId, "toParticipantId");
  const handoff = buildStructuredHandoffPacket(input.handoff);
  const handoffSummary = summarizeStructuredHandoff(handoff, {
    language: inferHallResponseLanguage(`${taskCard.title}\n${taskCard.description}\n${taskCard.latestSummary ?? ""}`),
  });
  const expectedNextOwnerParticipantId = getExpectedNextExecutionOwner(taskCard);
  const handoffMatchesQueue = !expectedNextOwnerParticipantId || expectedNextOwnerParticipantId === toParticipant.participantId;

  taskCard = releaseHallExecutionLock(taskCard, `handoff:${toParticipant.participantId}`);
  taskCard = (
    await updateHallTaskCard({
      taskCardId: taskCard.taskCardId,
      status: "in_progress",
      currentOwnerParticipantId: toParticipant.participantId,
      currentOwnerLabel: toParticipant.displayName,
      executionLock: taskCard.executionLock,
      blockers: handoff.blockers,
      requiresInputFrom: handoff.requiresInputFrom,
      doneWhen: handoff.doneWhen,
      plannedExecutionOrder: handoffMatchesQueue
        ? shiftExecutionQueueForOwner(taskCard, toParticipant.participantId)
        : taskCard.plannedExecutionOrder,
      plannedExecutionItems: handoffMatchesQueue
        ? shiftExecutionItemsForOwner(taskCard, toParticipant.participantId)
        : taskCard.plannedExecutionItems,
      currentExecutionItem: findExecutionItemForParticipant(taskCard, toParticipant.participantId),
      latestSummary: handoff.currentResult,
    })
  ).taskCard;
  taskCard = acquireHallExecutionLock(taskCard, {
    ownerParticipantId: toParticipant.participantId,
    ownerLabel: toParticipant.displayName,
  });
  taskCard = (await updateHallTaskCard({
    taskCardId: taskCard.taskCardId,
    executionLock: taskCard.executionLock,
  })).taskCard;

  let patchedTask = await patchTask({
    taskId: taskCard.taskId,
    projectId: taskCard.projectId,
    status: "in_progress",
    owner: toParticipant.displayName,
    roomId: taskCard.roomId,
  });

  const generatedMessages: HallMessage[] = [];
  if (!handoffMatchesQueue && expectedNextOwnerParticipantId) {
    const expected = findParticipant(context.hall.participants, expectedNextOwnerParticipantId)?.displayName ?? expectedNextOwnerParticipantId;
    generatedMessages.push(await appendHallSystemMessage({
      hallId: context.hall.hallId,
      projectId: taskCard.projectId,
      taskId: taskCard.taskId,
      taskCardId: taskCard.taskCardId,
      roomId: taskCard.roomId,
      content: `Handoff moved to ${toParticipant.displayName}, but the planned next owner was ${expected}. Review or update the execution order if needed.`,
      payload: {
        taskStatus: taskCard.status,
        status: "handoff_order_mismatch",
        nextOwnerParticipantId: toParticipant.participantId,
        executionOrder: taskCard.plannedExecutionOrder,
      },
    }));
  }
  const shouldAutoDispatchToNextOwner = handoffMatchesQueue || !expectedNextOwnerParticipantId;
  if (shouldAutoDispatchToNextOwner && canDispatchHallToRuntime(options.toolClient, toParticipant)) {
    const placeholderDraftId = beginHallDraftReply({
      hallId: context.hall.hallId,
      taskCardId: taskCard.taskCardId,
      projectId: taskCard.projectId,
      taskId: taskCard.taskId,
      roomId: taskCard.roomId,
      authorParticipantId: toParticipant.participantId,
      authorLabel: toParticipant.displayName,
      authorSemanticRole: toParticipant.semanticRole,
      messageKind: "handoff",
      content: "",
    });
    try {
      const chain = await runHallRuntimeExecutionChain({
        hall: context.hall,
        taskCard,
        participant: toParticipant,
        task: patchedTask.task,
        toolClient: options.toolClient!,
        mode: "handoff",
        handoff,
        targetParticipantIds: [toParticipant.participantId],
      });
      taskCard = chain.taskCard;
      if (chain.task) patchedTask = { ...patchedTask, task: chain.task };
      generatedMessages.push(...chain.generatedMessages);

      // Notify the originating agent that the handoff target has completed
      const handoffCallbackMessages = await wakeHandoffInitiator({
        hall: context.hall,
        taskCard,
        fromParticipant,
        toParticipant,
        task: patchedTask.task,
        chainResult: chain,
        toolClient: options.toolClient!,
      });
      generatedMessages.push(...handoffCallbackMessages);
    } finally {
      abortHallDraftReply({
        hallId: context.hall.hallId,
        taskCardId: taskCard.taskCardId,
        projectId: taskCard.projectId,
        taskId: taskCard.taskId,
        roomId: taskCard.roomId,
        draftId: placeholderDraftId,
        reason: "handoff_runtime_started",
      });
    }
  } else {
    const handoffMessage = await appendStreamedGeneratedHallMessage({
      hallId: context.hall.hallId,
      kind: "handoff",
      participant: fromParticipant,
      content: handoffSummary,
      targetParticipantIds: [toParticipant.participantId],
      projectId: taskCard.projectId,
      taskId: taskCard.taskId,
      taskCardId: taskCard.taskCardId,
      roomId: taskCard.roomId,
      payload: {
        projectId: taskCard.projectId,
        taskId: taskCard.taskId,
        taskCardId: taskCard.taskCardId,
        roomId: taskCard.roomId,
        handoff,
        nextOwnerParticipantId: toParticipant.participantId,
        doneWhen: handoff.doneWhen,
        taskStatus: patchedTask.task.status,
        status: "handoff_recorded",
      },
    });
    if (handoffMessage) generatedMessages.push(handoffMessage);
  }

  if ((handoff.artifactRefs ?? []).length > 0) {
    const mergedArtifacts = mergeTaskArtifacts(patchedTask.task.artifacts, handoff.artifactRefs);
    if (!sameTaskArtifacts(patchedTask.task.artifacts, mergedArtifacts)) {
      patchedTask = await patchTask({
        taskId: taskCard.taskId,
        projectId: taskCard.projectId,
        artifacts: mergedArtifacts,
      });
    }
  }

  if (taskCard.roomId) {
    await recordRoomHandoff({
      roomId: taskCard.roomId,
      fromRole: toRoomParticipantRole(fromParticipant),
      toRole: toRoomParticipantRole(toParticipant),
      note: truncateLinkedRoomHandoffNote(handoffSummary),
    });
    const linkedRoom = await requireLinkedRoom(taskCard.roomId);
    await publishTaskRoomBridgeEvent({
      type: "handoff_recorded",
      room: linkedRoom,
      task: patchedTask.task,
      note: handoffSummary,
    });
  }

  const refreshed = await refreshHallAndTaskSummary(context.hall.hallId, taskCard);
  await appendOperationAudit({
    action: "hall_task_handoff",
    source: "api",
    ok: true,
    detail: `handed off hall task ${taskCard.projectId}:${taskCard.taskId} from ${fromParticipant.displayName} to ${toParticipant.displayName}`,
    metadata: {
      taskCardId: taskCard.taskCardId,
      fromParticipantId: fromParticipant.participantId,
      toParticipantId: toParticipant.participantId,
    },
  });

  return {
    hall: refreshed.hall,
    hallSummary: refreshed.hallSummary,
    taskCard: refreshed.taskCard,
    taskSummary: refreshed.taskSummary,
    task: patchedTask.task,
    roomId: taskCard.roomId,
    generatedMessages,
  };
}


async function loadRecentHallThreadMessages(taskCard: HallTaskCard, limit = 30): Promise<HallMessage[]> {
  const messageStore = await loadCollaborationHallMessageStore();
  return listHallMessages(messageStore, { hallId: taskCard.hallId })
    .filter((message) => message.taskCardId === taskCard.taskCardId || message.taskId === taskCard.taskId)
    .slice(-limit);
}


async function runHallRuntimeExecutionChain(input: {
  hall: CollaborationHall;
  taskCard: HallTaskCard;
  participant: HallParticipant;
  task?: ProjectTask;
  toolClient: ToolClient;
  mode: "execution" | "handoff";
  note?: string;
  handoff?: StructuredHandoffPacket;
  triggerMessage?: HallMessage;
  targetParticipantIds: string[];
}): Promise<{ taskCard: HallTaskCard; task?: ProjectTask; generatedMessages: HallMessage[] }> {
  let taskCard = input.taskCard;
  let task = input.task;
  let mode = input.mode;
  let note = input.note;
  let handoff = input.handoff;
  let triggerMessage = input.triggerMessage;
  const generatedMessages: HallMessage[] = [];
  const visibleTurnBudget = HALL_RUNTIME_EXECUTION_CHAIN_ENABLED
    ? Math.max(1, HALL_RUNTIME_EXECUTION_MAX_TURNS)
    : 1;
  const hiddenRetryBudget = Math.max(2, visibleTurnBudget * 2);
  let visibleTurns = 0;
  let hiddenRetries = 0;

  for (;;) {
    let runtimeResult: HallRuntimeDispatchResult;
    try {
      runtimeResult = await dispatchHallRuntimeTurn({
        client: input.toolClient,
        hall: input.hall,
        taskCard,
        participant: input.participant,
        task,
        triggerMessage,
        mode,
        handoff,
        note,
      });
    } catch (error) {
      generatedMessages.push(await appendRuntimeFailureHallMessage(input.hall, taskCard, input.participant, error));
      return { taskCard, task, generatedMessages };
    }

    if (runtimeResult.canceled) {
      return { taskCard, task, generatedMessages };
    }

    let persistedRuntimeMessage: HallMessage | undefined;
    if (!runtimeResult.suppressVisibleMessage) {
      persistedRuntimeMessage = await appendPersistedHallMessage({
        hallId: input.hall.hallId,
        kind: runtimeResult.kind,
        participant: input.participant,
        content: runtimeResult.content,
        targetParticipantIds: input.targetParticipantIds,
        projectId: taskCard.projectId,
        taskId: taskCard.taskId,
        taskCardId: taskCard.taskCardId,
        roomId: taskCard.roomId,
        payload: runtimeResult.payload,
      });
      generatedMessages.push(persistedRuntimeMessage);
      visibleTurns += 1;

      taskCard = await linkHallRuntimeArtifacts({
        taskCard,
        task,
        participant: input.participant,
        message: persistedRuntimeMessage,
        runtimeResult,
      });
      if (task) {
        const refreshedTaskStore = await loadTaskStore();
        task = refreshedTaskStore.tasks.find((item) => item.projectId === taskCard.projectId && item.taskId === taskCard.taskId) ?? task;
      }
    }

    const directive = runtimeResult.chainDirective;
    if (runtimeResult.suppressVisibleMessage && directive?.nextAction === "continue") {
      hiddenRetries += 1;
      if (hiddenRetries < hiddenRetryBudget) {
        note = buildHallExecutionContinuationNote(taskCard, directive, visibleTurns, visibleTurnBudget);
        mode = "execution";
        handoff = undefined;
        triggerMessage = undefined;
        continue;
      }
      generatedMessages.push(await appendHallSystemMessage({
        hallId: input.hall.hallId,
        projectId: taskCard.projectId,
        taskId: taskCard.taskId,
        taskCardId: taskCard.taskCardId,
        roomId: taskCard.roomId,
        content: buildMissingConcreteDeliverableSummary(taskCard, input.participant),
        payload: {
          taskStatus: taskCard.status,
          status: "execution_missing_deliverable",
        },
      }));
      return { taskCard, task, generatedMessages };
    }

    if (!shouldContinueHallExecutionChain(directive, visibleTurns, visibleTurnBudget)) {
      const transition = await applyHallExecutionDirective({
        hall: input.hall,
        taskCard,
        task,
        participant: input.participant,
        directive,
        toolClient: input.toolClient,
      });
      taskCard = transition.taskCard;
      task = transition.task;
      generatedMessages.push(...transition.generatedMessages);
      return { taskCard, task, generatedMessages };
    }

    note = buildHallExecutionContinuationNote(taskCard, directive, visibleTurns, visibleTurnBudget);
    mode = "execution";
    handoff = undefined;
    triggerMessage = undefined;
  }
}

function shouldContinueHallExecutionChain(
  directive: HallRuntimeChainDirective | undefined,
  completedTurns: number,
  automaticTurnBudget: number,
): boolean {
  return directive?.nextAction === "continue" && completedTurns + 1 < automaticTurnBudget;
}

function buildHallExecutionContinuationNote(
  taskCard: HallTaskCard,
  directive: HallRuntimeChainDirective | undefined,
  completedTurns: number,
  automaticTurnBudget: number,
): string {
  const focus = directive?.nextStep?.trim();
  return [
    `Continue the same execution chain in the current session.`,
    `Automatic execution turn ${completedTurns + 1} of ${automaticTurnBudget}.`,
    focus ? `Focus next on: ${focus}` : "",
    taskCard.latestSummary ? `Most recent summary: ${taskCard.latestSummary}` : "",
  ].filter(Boolean).join(" ");
}

function buildMissingConcreteDeliverableSummary(taskCard: HallTaskCard, participant: HallParticipant): string {
  const language = inferHallResponseLanguage(`${taskCard.title}\n${taskCard.description}\n${taskCard.latestSummary ?? ""}`);
  const currentExecutionItem = getCurrentExecutionItem(taskCard);
  const currentTask = currentExecutionItem?.task?.trim() || taskCard.doneWhen?.trim() || "";
  if (language === "zh") {
    return `${participant.displayName} 这一棒还没把具体交付物贴出来，继续当前步骤：${currentTask || "把结果直接贴回群里。"}`
      .trim();
  }
  return `${participant.displayName} has not posted the concrete deliverable for this step yet. Continue the current step: ${currentTask || "post the actual result back into the hall."}`;
}

async function applyHallExecutionDirective(input: {
  hall: CollaborationHall;
  taskCard: HallTaskCard;
  task?: ProjectTask;
  participant: HallParticipant;
  directive?: HallRuntimeChainDirective;
  toolClient?: ToolClient;
}): Promise<{ taskCard: HallTaskCard; task?: ProjectTask; generatedMessages: HallMessage[] }> {
  const nextAction = input.directive?.nextAction;
  const latestHall = await requireHall(input.hall.hallId);
  const latestTaskCard = await requireTaskCard(input.taskCard.taskCardId);
  const currentExecutionItem = getCurrentExecutionItem(latestTaskCard);
  const queuedNextParticipantId = getExpectedNextExecutionOwner(latestTaskCard) || "";
  if (!nextAction || nextAction === "continue") {
    return { taskCard: latestTaskCard, task: input.task, generatedMessages: [] };
  }

  // The "blocked" directive branch was removed along with the 5-state machine.
  // If an agent would have reported blocked, the thread now simply becomes
  // idle; the "needs human review" detector (hall-human-review.ts) surfaces
  // it to the operator after the inactivity window.

  if (nextAction === "review" || nextAction === "done") {
    const explicitNextParticipant = input.directive?.executor
      ? findParticipant(latestHall.participants, input.directive.executor)
      : undefined;
    const nextParticipant = explicitNextParticipant
      ?? (queuedNextParticipantId
      ? findParticipant(latestHall.participants, queuedNextParticipantId)
      : undefined);
    if (nextParticipant && nextParticipant.participantId !== input.participant.participantId) {
      const handoff = buildAutomaticRuntimeHandoffInput(
        latestTaskCard,
        input.task,
        input.participant,
        nextParticipant,
        input.directive,
      );
      const handedOff = await recordHallTaskHandoff({
        taskCardId: latestTaskCard.taskCardId,
        fromParticipantId: input.participant.participantId,
        toParticipantId: nextParticipant.participantId,
        handoff,
      }, {
        toolClient: input.toolClient,
      });
      return {
        taskCard: handedOff.taskCard ?? latestTaskCard,
        task: handedOff.task ?? input.task,
        generatedMessages: handedOff.generatedMessages,
      };
    }
    const taskCard = (
      await updateHallTaskCard({
        taskCardId: latestTaskCard.taskCardId,
        status: "in_progress",
        currentExecutionItem: getCurrentExecutionItem(latestTaskCard),
      })
    ).taskCard;
    const task = input.task
      ? (await patchTask({
          taskId: input.task.taskId,
          projectId: input.task.projectId,
          status: "in_progress",
          owner: input.participant.displayName,
          roomId: input.taskCard.roomId,
        })).task
      : undefined;
    return {
      taskCard,
      task,
      generatedMessages: [
        await appendHallSystemMessage({
          hallId: input.hall.hallId,
          projectId: input.taskCard.projectId,
          taskId: input.taskCard.taskId,
          taskCardId: input.taskCard.taskCardId,
          roomId: input.taskCard.roomId,
          content: buildReadyForReviewSummary(taskCard, input.participant),
          payload: {
            artifactRefs: task?.artifacts,
            taskStatus: "in_progress",
            status: "execution_ready_for_review",
          },
        }),
      ],
    };
  }

  if (nextAction === "handoff") {
    const plannedNextParticipantId = getExpectedNextExecutionOwner(latestTaskCard) || "";
    const explicitNextParticipant = input.directive?.executor
      ? findParticipant(latestHall.participants, input.directive.executor)
      : undefined;
    const nextParticipantId =
      explicitNextParticipant && plannedNextParticipantId && explicitNextParticipant.participantId !== plannedNextParticipantId
        ? plannedNextParticipantId
        : (
          explicitNextParticipant?.participantId
          || plannedNextParticipantId
        );
    const nextParticipant = nextParticipantId
      ? findParticipant(latestHall.participants, nextParticipantId)
      : undefined;
    if (!nextParticipant || nextParticipant.participantId === input.participant.participantId) {
      return applyHallExecutionDirective({
        ...input,
        hall: latestHall,
        taskCard: latestTaskCard,
        directive: {
          ...input.directive,
          nextAction: "review",
        },
      });
    }
    const handoff = buildAutomaticRuntimeHandoffInput(
      latestTaskCard,
      input.task,
      input.participant,
      nextParticipant,
      input.directive,
    );
    const handedOff = await recordHallTaskHandoff({
      taskCardId: latestTaskCard.taskCardId,
      fromParticipantId: input.participant.participantId,
      toParticipantId: nextParticipant.participantId,
      handoff,
    }, {
      toolClient: input.toolClient,
    });
    return {
      taskCard: handedOff.taskCard ?? latestTaskCard,
      task: handedOff.task ?? input.task,
      generatedMessages: handedOff.generatedMessages,
    };
  }

  if (nextAction === "parallel_dispatch") {
    const parallelTasks = input.directive?.parallelTasks;
    if (!parallelTasks || parallelTasks.length === 0) {
      return { taskCard: latestTaskCard, task: input.task, generatedMessages: [] };
    }
    scheduleParallelDispatch({
      hall: latestHall,
      taskCard: latestTaskCard,
      task: input.task,
      initiator: input.participant,
      parallelTasks,
      toolClient: input.toolClient!,
    });
    return { taskCard: latestTaskCard, task: input.task, generatedMessages: [] };
  }

  return { taskCard: latestTaskCard, task: input.task, generatedMessages: [] };
}

// ---------------------------------------------------------------------------
// Parallel Dispatch — Hall-level Agent-to-Agent async collaboration
// ---------------------------------------------------------------------------

interface ParallelDispatchInput {
  hall: CollaborationHall;
  taskCard: HallTaskCard;
  task?: ProjectTask;
  initiator: HallParticipant;
  parallelTasks: HallParallelTaskTarget[];
  toolClient: ToolClient;
}

function scheduleParallelDispatch(input: ParallelDispatchInput): void {
  let pending: Promise<void> | undefined;
  pending = (async () => {
    try {
      await executeParallelDispatch(input);
    } catch (error) {
      await appendOperationAudit({
        action: "hall_parallel_dispatch",
        source: "runtime",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        metadata: { taskCardId: input.taskCard.taskCardId },
      });
    } finally {
      if (pending) pendingHallBackgroundWork.delete(pending);
    }
  })();
  pendingHallBackgroundWork.add(pending);
}

async function executeParallelDispatch(input: ParallelDispatchInput): Promise<void> {
  const { hall, taskCard, task, initiator, parallelTasks, toolClient } = input;
  const groupId = randomUUID();
  const now = new Date().toISOString();

  // 1. Resolve targets and build slots
  const slots: HallParallelSlot[] = [];
  for (const target of parallelTasks) {
    const participant = findParticipant(hall.participants, target.executor);
    if (!participant) continue;
    slots.push({
      slotId: randomUUID(),
      participantId: participant.participantId,
      task: target.task,
      status: "pending",
      startedAt: now,
    });
  }
  if (slots.length === 0) return;

  // 2. Create the parallel group and persist
  const group: HallParallelGroup = {
    groupId,
    initiatorParticipantId: initiator.participantId,
    slots,
    status: "active",
    createdAt: now,
  };
  const existingGroups = taskCard.parallelGroups ?? [];
  await updateHallTaskCard({
    taskCardId: taskCard.taskCardId,
    parallelGroups: [...existingGroups, group],
  });

  // 3. System message announcing the parallel dispatch
  const language = inferHallResponseLanguage(`${taskCard.title}\n${taskCard.description}`);
  const slotSummary = slots
    .map((slot) => {
      const participant = findParticipant(hall.participants, slot.participantId);
      return `${participant?.displayName ?? slot.participantId}: ${slot.task}`;
    })
    .join(language === "zh" ? "；" : "; ");
  await appendHallSystemMessage({
    hallId: hall.hallId,
    projectId: taskCard.projectId,
    taskId: taskCard.taskId,
    taskCardId: taskCard.taskCardId,
    roomId: taskCard.roomId,
    content: language === "zh"
      ? `${initiator.displayName} 发起并行调度：${slotSummary}`
      : `${initiator.displayName} initiated parallel dispatch: ${slotSummary}`,
    payload: {
      taskStatus: taskCard.status,
      status: "parallel_dispatch_started",
    },
  });

  // 4. Serialize initiator wake-ups to prevent concurrent Manager re-invocations
  let initiatorWakeChain: Promise<unknown> = Promise.resolve();

  // 5. Dispatch all slots concurrently
  const slotPromises = slots.map((slot) => {
    return (async () => {
      const participant = findParticipant(hall.participants, slot.participantId);
      if (!participant || !canDispatchHallToRuntime(toolClient, participant)) {
        await updateParallelSlot(taskCard.taskCardId, groupId, slot.slotId, {
          status: "failed",
          error: "Agent unavailable for runtime dispatch",
          completedAt: new Date().toISOString(),
        });
        return;
      }

      // Mark running
      await updateParallelSlot(taskCard.taskCardId, groupId, slot.slotId, { status: "running" });

      try {
        const result = await dispatchHallRuntimeTurn({
          client: toolClient,
          hall,
          taskCard: await requireTaskCard(taskCard.taskCardId),
          participant,
          task,
          mode: "execution",
          note: language === "zh"
            ? `[并行任务 — 来自 ${initiator.displayName}] ${slot.task}`
            : `[Parallel task from ${initiator.displayName}] ${slot.task}`,
        });

        // Persist the agent's visible message
        await appendPersistedHallMessage({
          hallId: hall.hallId,
          kind: result.kind,
          participant,
          content: result.content,
          targetParticipantIds: [initiator.participantId],
          projectId: taskCard.projectId,
          taskId: taskCard.taskId,
          taskCardId: taskCard.taskCardId,
          roomId: taskCard.roomId,
          payload: result.payload,
        });

        // Update slot as completed
        const resultSummary = result.content.length > 800
          ? `${result.content.slice(0, 800)}…`
          : result.content;
        await updateParallelSlot(taskCard.taskCardId, groupId, slot.slotId, {
          status: "completed",
          result: resultSummary,
          sessionKey: result.sessionKey,
          completedAt: new Date().toISOString(),
        });
      } catch (error) {
        await updateParallelSlot(taskCard.taskCardId, groupId, slot.slotId, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          completedAt: new Date().toISOString(),
        });
      }

      // Wake initiator (serialized)
      initiatorWakeChain = initiatorWakeChain.then(() =>
        wakeParallelInitiator({
          hall,
          taskCardId: taskCard.taskCardId,
          groupId,
          completedSlotId: slot.slotId,
          initiator,
          task,
          toolClient,
        }).catch(() => undefined),
      );
      await initiatorWakeChain;
    })();
  });

  await Promise.allSettled(slotPromises);

  // 6. Mark group as settled
  const latestCard = await requireTaskCard(taskCard.taskCardId);
  const settledGroups = (latestCard.parallelGroups ?? []).map((g) =>
    g.groupId === groupId ? { ...g, status: "settled" as const, settledAt: new Date().toISOString() } : g,
  );
  await updateHallTaskCard({
    taskCardId: taskCard.taskCardId,
    parallelGroups: settledGroups,
  });

  await appendOperationAudit({
    action: "hall_parallel_dispatch",
    source: "runtime",
    ok: true,
    detail: `parallel dispatch group ${groupId} settled (${slots.length} slots)`,
    metadata: { taskCardId: taskCard.taskCardId, groupId },
  });
}

async function updateParallelSlot(
  taskCardId: string,
  groupId: string,
  slotId: string,
  patch: Partial<Pick<HallParallelSlot, "status" | "result" | "sessionKey" | "completedAt" | "error">>,
): Promise<void> {
  const card = await requireTaskCard(taskCardId);
  const groups = (card.parallelGroups ?? []).map((g) => {
    if (g.groupId !== groupId) return g;
    return {
      ...g,
      slots: g.slots.map((s) =>
        s.slotId === slotId ? { ...s, ...patch } : s,
      ),
    };
  });
  await updateHallTaskCard({ taskCardId, parallelGroups: groups });
}

async function wakeParallelInitiator(input: {
  hall: CollaborationHall;
  taskCardId: string;
  groupId: string;
  completedSlotId: string;
  initiator: HallParticipant;
  task?: ProjectTask;
  toolClient: ToolClient;
}): Promise<void> {
  const latestCard = await requireTaskCard(input.taskCardId);
  const group = latestCard.parallelGroups?.find((g) => g.groupId === input.groupId);
  if (!group) return;

  const completedSlot = group.slots.find((s) => s.slotId === input.completedSlotId);
  if (!completedSlot) return;

  const completed = group.slots.filter((s) => s.status === "completed" || s.status === "failed");
  const pending = group.slots.filter((s) => s.status === "pending" || s.status === "running");
  const language = inferHallResponseLanguage(`${latestCard.title}\n${latestCard.description}`);

  const completedName = findParticipant(input.hall.participants, completedSlot.participantId)?.displayName
    ?? completedSlot.participantId;
  const pendingNames = pending
    .map((s) => findParticipant(input.hall.participants, s.participantId)?.displayName ?? s.participantId)
    .join(", ");

  const wakeNote = language === "zh"
    ? [
        `[并行执行更新]`,
        `${completedName} 已完成其任务。`,
        completedSlot.status === "completed" ? `结果: ${completedSlot.result ?? "(无结果)"}` : `失败: ${completedSlot.error ?? "未知错误"}`,
        ``,
        `进度: ${completed.length}/${group.slots.length}`,
        pending.length > 0 ? `仍在执行: ${pendingNames}` : `所有并行任务已完成。`,
        ``,
        `你可以:`,
        `- 处理已完成的结果并继续等待其他 Agent`,
        `- 发起新的 parallel_dispatch`,
        `- 如果所有任务已完成，综合结果并决定下一步`,
      ].filter(Boolean).join("\n")
    : [
        `[Parallel execution update]`,
        `${completedName} finished its task.`,
        completedSlot.status === "completed" ? `Result: ${completedSlot.result ?? "(no result)"}` : `Failed: ${completedSlot.error ?? "unknown error"}`,
        ``,
        `Progress: ${completed.length}/${group.slots.length} settled.`,
        pending.length > 0 ? `Still running: ${pendingNames}` : `All parallel tasks have completed.`,
        ``,
        `You may:`,
        `- Process this result and continue waiting for others`,
        `- Issue new parallel_dispatch targets`,
        `- If all tasks are done, synthesize and decide next action`,
      ].filter(Boolean).join("\n");

  if (!canDispatchHallToRuntime(input.toolClient, input.initiator)) return;

  const result = await dispatchHallRuntimeTurn({
    client: input.toolClient,
    hall: input.hall,
    taskCard: latestCard,
    participant: input.initiator,
    task: input.task,
    mode: "execution",
    note: wakeNote,
  });

  // Persist the initiator's response
  if (!result.canceled && !result.suppressVisibleMessage) {
    await appendPersistedHallMessage({
      hallId: input.hall.hallId,
      kind: result.kind,
      participant: input.initiator,
      content: result.content,
      targetParticipantIds: [],
      projectId: latestCard.projectId,
      taskId: latestCard.taskId,
      taskCardId: latestCard.taskCardId,
      roomId: latestCard.roomId,
      payload: result.payload,
    });
  }

  // Handle the initiator's response directive (may trigger another parallel dispatch)
  const directive = result.chainDirective;
  if (directive?.nextAction === "parallel_dispatch" && directive.parallelTasks?.length) {
    scheduleParallelDispatch({
      hall: input.hall,
      taskCard: await requireTaskCard(input.taskCardId),
      task: input.task,
      initiator: input.initiator,
      parallelTasks: directive.parallelTasks,
      toolClient: input.toolClient,
    });
  } else if (directive?.nextAction && directive.nextAction !== "continue") {
    await applyHallExecutionDirective({
      hall: input.hall,
      taskCard: await requireTaskCard(input.taskCardId),
      task: input.task,
      participant: input.initiator,
      directive,
      toolClient: input.toolClient,
    });
  }
}

// ---------------------------------------------------------------------------
// Handoff Completion Callback — notify the originating agent after handoff target finishes
// ---------------------------------------------------------------------------

async function wakeHandoffInitiator(input: {
  hall: CollaborationHall;
  taskCard: HallTaskCard;
  fromParticipant: HallParticipant;
  toParticipant: HallParticipant;
  task?: ProjectTask;
  chainResult: { taskCard: HallTaskCard; task?: ProjectTask; generatedMessages: HallMessage[] };
  toolClient: ToolClient;
}): Promise<HallMessage[]> {
  const { hall, fromParticipant, toParticipant, chainResult, toolClient } = input;

  // Don't notify if initiator cannot be dispatched
  if (!canDispatchHallToRuntime(toolClient, fromParticipant)) return [];

  const latestCard = chainResult.taskCard;
  const language = inferHallResponseLanguage(`${latestCard.title}\n${latestCard.description}`);

  // Summarize what the handoff target produced
  const targetMessages = chainResult.generatedMessages
    .filter((m) => m.authorParticipantId === toParticipant.participantId)
    .map((m) => m.content?.trim())
    .filter(Boolean);
  const resultSummary = targetMessages.length > 0
    ? targetMessages[targetMessages.length - 1]!.slice(0, 600)
    : (language === "zh" ? "(无可见输出)" : "(no visible output)");

  const wakeNote = language === "zh"
    ? [
        `[交接完成通知]`,
        `${toParticipant.displayName} 已完成你交接给它的任务。`,
        `结果摘要: ${resultSummary}`,
        ``,
        `当前任务状态: ${latestCard.status}`,
        `你可以:`,
        `- 审查结果并继续推进`,
        `- 如有需要，发起新的交接或并行调度`,
        `- 综合结果并决定下一步`,
      ].join("\n")
    : [
        `[Handoff completion notice]`,
        `${toParticipant.displayName} has completed the task you handed off.`,
        `Result summary: ${resultSummary}`,
        ``,
        `Current task state: ${latestCard.status}`,
        `You may:`,
        `- Review the result and continue`,
        `- Issue new handoffs or parallel dispatches if needed`,
        `- Synthesize results and decide next action`,
      ].join("\n");

  let result: HallRuntimeDispatchResult;
  try {
    result = await dispatchHallRuntimeTurn({
      client: toolClient,
      hall,
      taskCard: latestCard,
      participant: fromParticipant,
      task: chainResult.task,
      mode: "execution",
      note: wakeNote,
    });
  } catch {
    return []; // Callback failures are non-fatal
  }

  const messages: HallMessage[] = [];

  if (!result.canceled && !result.suppressVisibleMessage) {
    messages.push(await appendPersistedHallMessage({
      hallId: hall.hallId,
      kind: result.kind,
      participant: fromParticipant,
      content: result.content,
      targetParticipantIds: [],
      projectId: latestCard.projectId,
      taskId: latestCard.taskId,
      taskCardId: latestCard.taskCardId,
      roomId: latestCard.roomId,
      payload: result.payload,
    }));
  }

  // Process the initiator's response directive
  const directive = result.chainDirective;
  if (directive?.nextAction === "parallel_dispatch" && directive.parallelTasks?.length) {
    scheduleParallelDispatch({
      hall,
      taskCard: await requireTaskCard(latestCard.taskCardId),
      task: chainResult.task,
      initiator: fromParticipant,
      parallelTasks: directive.parallelTasks,
      toolClient,
    });
  } else if (directive?.nextAction && directive.nextAction !== "continue") {
    const transition = await applyHallExecutionDirective({
      hall,
      taskCard: await requireTaskCard(latestCard.taskCardId),
      task: chainResult.task,
      participant: fromParticipant,
      directive,
      toolClient,
    });
    messages.push(...transition.generatedMessages);
  }

  return messages;
}

// ---------------------------------------------------------------------------

function buildAutomaticRuntimeHandoffInput(
  taskCard: HallTaskCard,
  task: ProjectTask | undefined,
  fromParticipant: HallParticipant,
  toParticipant: HallParticipant,
  directive: HallRuntimeChainDirective | undefined,
): CreateStructuredHandoffInput {
  const language = inferHallResponseLanguage(`${taskCard.title}\n${taskCard.description}\n${taskCard.latestSummary ?? ""}`);
  const currentExecutionItem = getCurrentExecutionItem(taskCard);
  const nextExecutionItem = findExecutionItemForParticipant(taskCard, toParticipant.participantId);
  const currentResult = taskCard.latestSummary?.trim()
    || directive?.nextStep?.trim()
    || (language === "zh"
      ? `${fromParticipant.displayName} 已完成当前这一步。`
      : `${fromParticipant.displayName} completed the current execution item.`);
  const goal = nextExecutionItem?.task?.trim()
    || directive?.nextStep?.trim()
    || currentExecutionItem?.handoffWhen?.trim()
    || taskCard.doneWhen?.trim()
    || (language === "zh" ? "继续推进下一步执行。" : "Continue the next execution step.");
  const doneWhen = nextExecutionItem?.handoffWhen?.trim()
    || taskCard.doneWhen?.trim()
    || nextExecutionItem?.task?.trim()
    || (language === "zh" ? "这一轮产出已可评审。" : "This pass is reviewable.");
  return {
    goal,
    currentResult,
    doneWhen,
    blockers: taskCard.blockers,
    nextOwner: toParticipant.displayName,
    requiresInputFrom: taskCard.requiresInputFrom,
    artifactRefs: task?.artifacts,
  };
}


async function appendStreamedGeneratedHallMessage(input: {
  hallId: string;
  kind: HallMessage["kind"];
  participant: HallParticipant;
  content: string;
  targetParticipantIds: string[];
  projectId: string;
  taskId: string;
  taskCardId: string;
  roomId?: string;
  payload?: HallMessage["payload"];
}): Promise<HallMessage | undefined> {
  const draftId = await streamHallDraftReply({
    hallId: input.hallId,
    taskCardId: input.taskCardId,
    projectId: input.projectId,
    taskId: input.taskId,
    roomId: input.roomId,
    authorParticipantId: input.participant.participantId,
    authorLabel: input.participant.displayName,
    authorSemanticRole: input.participant.semanticRole,
    messageKind: input.kind,
    content: input.content,
  });
  if (isHallDraftCanceled(draftId)) {
    return undefined;
  }
  const message = (
    await appendHallMessage({
      hallId: input.hallId,
      kind: input.kind,
      authorParticipantId: input.participant.participantId,
      authorLabel: input.participant.displayName,
      authorSemanticRole: input.participant.semanticRole,
      content: input.content,
      targetParticipantIds: input.targetParticipantIds,
      projectId: input.projectId,
      taskId: input.taskId,
      taskCardId: input.taskCardId,
      roomId: input.roomId,
      payload: input.payload,
    })
  ).message;
  completeHallDraftReply({
    hallId: input.hallId,
    taskCardId: input.taskCardId,
    projectId: input.projectId,
    taskId: input.taskId,
    roomId: input.roomId,
    draftId,
    messageId: message.messageId,
    content: input.content,
  });
  await touchHallTaskAgentActivity(input.taskCardId);
  return message;
}

async function appendPersistedHallMessage(input: {
  hallId: string;
  kind: HallMessage["kind"];
  participant: HallParticipant;
  content: string;
  targetParticipantIds: string[];
  projectId: string;
  taskId: string;
  taskCardId: string;
  roomId?: string;
  payload?: HallMessage["payload"];
}): Promise<HallMessage> {
  const message = (
    await appendHallMessage({
      hallId: input.hallId,
      kind: input.kind,
      authorParticipantId: input.participant.participantId,
      authorLabel: input.participant.displayName,
      authorSemanticRole: input.participant.semanticRole,
      content: input.content,
      targetParticipantIds: input.targetParticipantIds,
      projectId: input.projectId,
      taskId: input.taskId,
      taskCardId: input.taskCardId,
      roomId: input.roomId,
      payload: input.payload,
    })
  ).message;
  await touchHallTaskAgentActivity(input.taskCardId);
  return message;
}

// Records that an agent just posted to this task card: bumps lastAgentActivityAt
// and clears humanReviewedAt so the "needs human review" signal can re-fire if
// the thread idles again.
async function touchHallTaskAgentActivity(taskCardId: string): Promise<void> {
  if (!taskCardId) return;
  try {
    await updateHallTaskCard({
      taskCardId,
      lastAgentActivityAt: new Date().toISOString(),
      humanReviewedAt: null,
    });
  } catch {
    // Best-effort: a missing task card should not break message persistence.
  }
}

async function appendHallSystemMessage(input: {
  hallId: string;
  content: string;
  projectId: string;
  taskId: string;
  taskCardId: string;
  roomId?: string;
  payload?: HallMessage["payload"];
}): Promise<HallMessage> {
  return (
    await appendHallMessage({
      hallId: input.hallId,
      kind: "system",
      authorParticipantId: "system",
      authorLabel: "System",
      content: input.content,
      targetParticipantIds: [],
      projectId: input.projectId,
      taskId: input.taskId,
      taskCardId: input.taskCardId,
      roomId: input.roomId,
      payload: input.payload,
    })
  ).message;
}

async function appendRuntimeFailureHallMessage(
  hall: CollaborationHall,
  taskCard: HallTaskCard,
  participant: HallParticipant,
  error: unknown,
): Promise<HallMessage> {
  const detail = error instanceof Error ? error.message : "unknown runtime error";
  return (
    await appendHallMessage({
      hallId: hall.hallId,
      kind: "system",
      authorParticipantId: "system",
      authorLabel: "System",
      content: `Runtime dispatch to ${participant.displayName} failed: ${detail}`,
      projectId: taskCard.projectId,
      taskId: taskCard.taskId,
      taskCardId: taskCard.taskCardId,
      roomId: taskCard.roomId,
      payload: {
        projectId: taskCard.projectId,
        taskId: taskCard.taskId,
        taskCardId: taskCard.taskCardId,
        roomId: taskCard.roomId,
        taskStatus: taskCard.status,
        status: "runtime_error",
      },
    })
  ).message;
}

async function linkHallRuntimeArtifacts(input: {
  taskCard: HallTaskCard;
  task?: ProjectTask;
  participant: HallParticipant;
  message: HallMessage;
  runtimeResult: HallRuntimeDispatchResult;
}): Promise<HallTaskCard> {
  const nextSessionKeys = input.runtimeResult.sessionKey
    ? [...new Set([...input.taskCard.sessionKeys, input.runtimeResult.sessionKey])]
    : input.taskCard.sessionKeys;
  let taskCard = input.taskCard;
  const patch = input.runtimeResult.taskCardPatch ?? {};
  const shouldPatchTaskCard =
    nextSessionKeys.join("|") !== input.taskCard.sessionKeys.join("|")
    || patch.proposal !== undefined
    || patch.decision !== undefined
    || patch.doneWhen !== undefined
    || patch.currentOwnerParticipantId !== undefined
    || patch.currentOwnerLabel !== undefined
    || patch.blockers !== undefined
    || patch.requiresInputFrom !== undefined
    || patch.latestSummary !== undefined;

  if (shouldPatchTaskCard) {
    taskCard = (
      await updateHallTaskCard({
        taskCardId: input.taskCard.taskCardId,
        proposal: patch.proposal ?? input.taskCard.proposal,
        decision: patch.decision ?? input.taskCard.decision,
        doneWhen: patch.doneWhen ?? input.taskCard.doneWhen,
        currentOwnerParticipantId: patch.currentOwnerParticipantId ?? input.taskCard.currentOwnerParticipantId,
        currentOwnerLabel: patch.currentOwnerLabel ?? input.taskCard.currentOwnerLabel,
        blockers: patch.blockers ?? input.taskCard.blockers,
        requiresInputFrom: patch.requiresInputFrom ?? input.taskCard.requiresInputFrom,
        latestSummary: patch.latestSummary ?? input.taskCard.latestSummary,
        sessionKeys: nextSessionKeys,
      })
    ).taskCard;
  }

  if (input.task) {
    const taskSessionKeys = input.runtimeResult.sessionKey
      ? [...new Set([...(input.task.sessionKeys ?? []), input.runtimeResult.sessionKey])]
      : input.task.sessionKeys;
    const mergedArtifacts = mergeTaskArtifacts(input.task.artifacts, input.runtimeResult.payload?.artifactRefs);
    if (
      taskSessionKeys.join("|") !== (input.task.sessionKeys ?? []).join("|")
      || !sameTaskArtifacts(input.task.artifacts, mergedArtifacts)
    ) {
      await patchTask({
        taskId: input.task.taskId,
        projectId: input.task.projectId,
        sessionKeys: taskSessionKeys,
        artifacts: mergedArtifacts,
      });
    }
  }

  if (taskCard.roomId) {
    await appendChatMessage({
      roomId: taskCard.roomId,
      kind: mapHallKindToRoomKind(input.message.kind),
      authorRole: toRoomParticipantRole(input.participant),
      authorLabel: input.participant.displayName,
      content: input.message.content,
      sessionKey: input.runtimeResult.sessionKey,
      payload: {
        proposal: input.message.payload?.proposal,
        decision: input.message.payload?.decision,
        doneWhen: input.message.payload?.doneWhen,
        status: input.message.payload?.status,
        taskStatus: input.message.payload?.taskStatus ?? taskCard.status,
        reviewOutcome: input.message.payload?.reviewOutcome,
        sessionKey: input.runtimeResult.sessionKey,
        sourceSessionKey: input.runtimeResult.sessionKey,
      },
    });
  }

  return taskCard;
}

function mergeTaskArtifacts(existing: TaskArtifact[] | undefined, incoming: TaskArtifact[] | undefined): TaskArtifact[] {
  const merged = new Map<string, TaskArtifact>();
  for (const artifact of [...(existing ?? []), ...(incoming ?? [])]) {
    if (!artifact || !artifact.location) continue;
    const normalized: TaskArtifact = {
      artifactId: artifact.artifactId?.trim() || artifact.location.trim(),
      type: artifact.type,
      label: artifact.label?.trim() || artifact.location.trim(),
      location: artifact.location.trim(),
    };
    merged.set(normalized.artifactId, normalized);
  }
  return Array.from(merged.values());
}

function sameTaskArtifacts(left: TaskArtifact[] | undefined, right: TaskArtifact[] | undefined): boolean {
  return JSON.stringify(mergeTaskArtifacts(left, [])) === JSON.stringify(mergeTaskArtifacts(right, []));
}

function mapHallKindToRoomKind(kind: HallMessage["kind"]): MessageKind {
  switch (kind) {
    case "proposal":
    case "decision":
    case "handoff":
    case "status":
    case "result":
      return kind;
    default:
      return "chat";
  }
}







function inferHallResponseLanguage(source: string | undefined): HallResponseLanguage {
  const value = String(source ?? "").trim();
  if (!value) return "en";
  const cjkMatches = value.match(/[\u4e00-\u9fff]/g) ?? [];
  const latinMatches = value.match(/[A-Za-z]/g) ?? [];
  if (cjkMatches.length > 0) return "zh";
  if (latinMatches.length > 0) return "en";
  return "en";
}






async function ensureHallContext(hallId = DEFAULT_COLLABORATION_HALL_ID): Promise<{ hall: CollaborationHall }> {
  const roster = await loadBestEffortAgentRoster();
  const participants = resolveHallParticipantsFromRoster(roster.entries);
  await ensureDefaultCollaborationHall(participants);
  const store = await loadCollaborationHallStore();
  const hall = store.halls.find((item) => item.hallId === hallId) ?? store.halls.find((item) => item.hallId === DEFAULT_COLLABORATION_HALL_ID);
  if (!hall) {
    throw new CollaborationHallStoreValidationError(`hall '${hallId}' was not found.`, ["hallId"], 404);
  }
  return { hall };
}

async function requireHall(hallId: string): Promise<CollaborationHall> {
  return (await ensureHallContext(hallId)).hall;
}

async function requireTaskCard(taskCardId: string): Promise<HallTaskCard> {
  const store = await loadCollaborationTaskCardStore();
  const taskCard = getHallTaskCard(store, taskCardId);
  if (!taskCard) {
    throw new CollaborationHallStoreValidationError(`task card '${taskCardId}' was not found.`, ["taskCardId"], 404);
  }
  return taskCard;
}

async function requireTaskCardByProjectTask(projectId: string, taskId: string): Promise<HallTaskCard> {
  const store = await loadCollaborationTaskCardStore();
  const taskCard = getHallTaskCardByTask(store, projectId, taskId);
  if (!taskCard) {
    throw new CollaborationHallStoreValidationError(`task '${projectId}:${taskId}' does not have a hall task card yet.`, ["taskId"], 404);
  }
  return taskCard;
}

async function refreshHallAndTaskSummary(
  hallId: string,
  taskCard: HallTaskCard,
): Promise<{ hall: CollaborationHall; hallSummary: CollaborationHallSummary; taskCard: HallTaskCard; taskSummary: HallTaskSummary }> {
  const hall = await requireHall(hallId);
  const [messageStore, taskCardStore] = await Promise.all([
    loadCollaborationHallMessageStore(),
    loadCollaborationTaskCardStore(),
  ]);
  const taskCards = listHallTaskCards(taskCardStore, { hallId });
  const updatedTaskCard = taskCards.find((item) => item.taskCardId === taskCard.taskCardId) ?? taskCard;
  const messages = listHallMessages(messageStore, { hallId });
  const hallSummary = (await upsertCollaborationHallSummary(hall, messages, taskCards)).summary;
  const taskSummary = (await upsertHallTaskSummary(updatedTaskCard, messages)).summary;
  return {
    hall,
    hallSummary,
    taskCard: updatedTaskCard,
    taskSummary,
  };
}

async function ensureHallProject(projectId: string): Promise<void> {
  const store = await loadProjectStore();
  if (store.projects.some((project) => project.projectId === projectId)) return;
  const now = new Date().toISOString();
  store.projects.push({
    projectId,
    title: projectId === DEFAULT_COLLABORATION_HALL_PROJECT_ID ? "Collaboration Hall" : projectId,
    status: "active",
    owner: "operator",
    budget: {},
    updatedAt: now,
  });
  store.updatedAt = now;
  await saveProjectStore(store);
}

function findParticipant(participants: HallParticipant[], participantId: string | undefined): HallParticipant | undefined {
  if (!participantId) return undefined;
  const normalized = String(participantId).trim().toLowerCase();
  return participants.find((participant) => {
    if (participant.participantId === participantId) return true;
    if (participant.displayName.trim().toLowerCase() === normalized) return true;
    return participant.aliases.some((alias) => alias.trim().toLowerCase() === normalized);
  });
}

function requireHallParticipant(
  participants: HallParticipant[],
  participantId: string,
  field: string,
): HallParticipant {
  const participant = findParticipant(participants, participantId);
  if (!participant) {
    throw new CollaborationHallStoreValidationError(`participant '${participantId}' was not found.`, [field], 404);
  }
  return participant;
}


function deriveTaskTitle(content: string): string {
  const cleaned = content.trim().replace(/\s+/g, " ");
  if (!cleaned) return "Untitled hall task";
  const firstSentence = cleaned.split(/[\n。！？!?]/u).find((part) => part.trim().length > 0)?.trim() ?? cleaned;
  return firstSentence.length > 90 ? `${firstSentence.slice(0, 87)}...` : firstSentence;
}

function buildTaskId(content: string): string {
  const slug = content
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const base = slug || "hall-task";
  return `${base}-${randomUUID().slice(0, 8)}`;
}

function normalizeTaskKey(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toRoomParticipantRole(participant: HallParticipant): RoomParticipantRole {
  if (participant.semanticRole === "planner") return "planner";
  if (participant.semanticRole === "reviewer") return "reviewer";
  if (isManagerLike(participant.semanticRole)) return "manager";
  return "coder";
}

function truncateLinkedRoomHandoffNote(note: string): string {
  const trimmed = note.trim();
  if (!trimmed) return trimmed;
  return trimmed.length > 320 ? `${trimmed.slice(0, 317).trimEnd()}...` : trimmed;
}

async function requireLinkedRoom(roomId: string) {
  const store = await loadChatRoomStore();
  const room = getChatRoom(store, roomId);
  if (!room) {
    throw new CollaborationHallStoreValidationError(`linked room '${roomId}' was not found.`, ["roomId"], 404);
  }
  return room;
}

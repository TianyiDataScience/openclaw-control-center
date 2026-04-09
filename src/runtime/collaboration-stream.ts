import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HallMessageKind, RoomParticipantRole } from "../types";

export type CollaborationStreamScope = "hall" | "room";
export type CollaborationStreamEventType =
  | "connected"
  | "invalidate"
  | "draft_start"
  | "draft_delta"
  | "draft_complete"
  | "draft_abort"
  | "draft_tool_update";

export interface CollaborationStreamEvent {
  eventId: string;
  scope: CollaborationStreamScope;
  type: CollaborationStreamEventType;
  createdAt: string;
  hallId?: string;
  roomId?: string;
  taskCardId?: string;
  projectId?: string;
  taskId?: string;
  reason?: string;
  draftId?: string;
  messageId?: string;
  authorParticipantId?: string;
  authorLabel?: string;
  authorSemanticRole?: string;
  authorRole?: RoomParticipantRole;
  messageKind?: HallMessageKind | "chat" | "proposal" | "decision" | "handoff" | "status" | "result";
  delta?: string;
  content?: string;
  toolName?: string;
  toolCallId?: string;
  toolStatus?: string;
}

interface StreamSubscriber {
  subscriberId: string;
  res: ServerResponse;
  heartbeat: NodeJS.Timeout;
}

interface HallDraftStreamInput {
  hallId: string;
  taskCardId?: string;
  projectId?: string;
  taskId?: string;
  roomId?: string;
  authorParticipantId: string;
  authorLabel: string;
  authorSemanticRole?: string;
  messageKind: CollaborationStreamEvent["messageKind"];
  content: string;
}

interface RoomDraftStreamInput {
  roomId: string;
  projectId?: string;
  taskId?: string;
  authorRole: RoomParticipantRole;
  authorLabel: string;
  messageKind: CollaborationStreamEvent["messageKind"];
  content: string;
}

interface ActiveHallDraft {
  hallId: string;
  taskCardId?: string;
  projectId?: string;
  taskId?: string;
  roomId?: string;
}

const HEARTBEAT_MS = 15_000;
const hallSubscribers = new Map<string, Map<string, StreamSubscriber>>();
const roomSubscribers = new Map<string, Map<string, StreamSubscriber>>();
const activeHallDrafts = new Map<string, ActiveHallDraft>();
const canceledHallDrafts = new Set<string>();

export function openHallEventStream(
  req: IncomingMessage,
  res: ServerResponse,
  hallId: string,
): void {
  openEventStream(req, res, hallSubscribers, hallId, {
    eventId: randomUUID(),
    scope: "hall",
    type: "connected",
    createdAt: new Date().toISOString(),
    hallId,
  });
}

export function openRoomEventStream(
  req: IncomingMessage,
  res: ServerResponse,
  roomId: string,
): void {
  openEventStream(req, res, roomSubscribers, roomId, {
    eventId: randomUUID(),
    scope: "room",
    type: "connected",
    createdAt: new Date().toISOString(),
    roomId,
  });
}

export function publishHallStreamEvent(
  event: Omit<CollaborationStreamEvent, "eventId" | "scope" | "createdAt"> & { hallId: string },
): void {
  publishScopedEvent(hallSubscribers, event.hallId, {
    eventId: randomUUID(),
    scope: "hall",
    createdAt: new Date().toISOString(),
    ...event,
  });
}

export function publishRoomStreamEvent(
  event: Omit<CollaborationStreamEvent, "eventId" | "scope" | "createdAt"> & { roomId: string },
): void {
  publishScopedEvent(roomSubscribers, event.roomId, {
    eventId: randomUUID(),
    scope: "room",
    createdAt: new Date().toISOString(),
    ...event,
  });
}

export async function streamHallDraftReply(input: HallDraftStreamInput): Promise<string> {
  const draftId = beginHallDraftReply(input);
  for (const delta of chunkDraftContent(input.content)) {
    if (isHallDraftCanceled(draftId)) break;
    pushHallDraftDelta({
      hallId: input.hallId,
      taskCardId: input.taskCardId,
      projectId: input.projectId,
      taskId: input.taskId,
      roomId: input.roomId,
      draftId,
      authorParticipantId: input.authorParticipantId,
      authorLabel: input.authorLabel,
      authorSemanticRole: input.authorSemanticRole,
      messageKind: input.messageKind,
      delta,
    });
    await yieldStreamTurn();
  }
  return draftId;
}

export function completeHallDraftReply(input: {
  hallId: string;
  taskCardId?: string;
  projectId?: string;
  taskId?: string;
  roomId?: string;
  draftId: string;
  messageId?: string;
  content: string;
}): void {
  if (isHallDraftCanceled(input.draftId)) {
    activeHallDrafts.delete(input.draftId);
    canceledHallDrafts.delete(input.draftId);
    return;
  }
  activeHallDrafts.delete(input.draftId);
  publishHallStreamEvent({
    type: "draft_complete",
    hallId: input.hallId,
    taskCardId: input.taskCardId,
    projectId: input.projectId,
    taskId: input.taskId,
    roomId: input.roomId,
    draftId: input.draftId,
    messageId: input.messageId,
    content: input.content,
  });
}

export function abortHallDraftReply(input: {
  hallId: string;
  taskCardId?: string;
  projectId?: string;
  taskId?: string;
  roomId?: string;
  draftId: string;
  reason?: string;
}): void {
  activeHallDrafts.delete(input.draftId);
  canceledHallDrafts.add(input.draftId);
  publishHallStreamEvent({
    type: "draft_abort",
    hallId: input.hallId,
    taskCardId: input.taskCardId,
    projectId: input.projectId,
    taskId: input.taskId,
    roomId: input.roomId,
    draftId: input.draftId,
    reason: input.reason ?? "aborted",
  });
}

export async function streamRoomDraftReply(input: RoomDraftStreamInput): Promise<string> {
  const draftId = beginRoomDraftReply(input);
  for (const delta of chunkDraftContent(input.content)) {
    pushRoomDraftDelta({
      roomId: input.roomId,
      projectId: input.projectId,
      taskId: input.taskId,
      draftId,
      authorRole: input.authorRole,
      authorLabel: input.authorLabel,
      messageKind: input.messageKind,
      delta,
    });
    await yieldStreamTurn();
  }
  return draftId;
}

export function completeRoomDraftReply(input: {
  roomId: string;
  projectId?: string;
  taskId?: string;
  draftId: string;
  messageId?: string;
  content: string;
}): void {
  publishRoomStreamEvent({
    type: "draft_complete",
    roomId: input.roomId,
    projectId: input.projectId,
    taskId: input.taskId,
    draftId: input.draftId,
    messageId: input.messageId,
    content: input.content,
  });
}

export function beginHallDraftReply(input: HallDraftStreamInput): string {
  const draftId = randomUUID();
  canceledHallDrafts.delete(draftId);
  activeHallDrafts.set(draftId, {
    hallId: input.hallId,
    taskCardId: input.taskCardId,
    projectId: input.projectId,
    taskId: input.taskId,
    roomId: input.roomId,
  });
  publishHallStreamEvent({
    type: "draft_start",
    hallId: input.hallId,
    taskCardId: input.taskCardId,
    projectId: input.projectId,
    taskId: input.taskId,
    roomId: input.roomId,
    draftId,
    authorParticipantId: input.authorParticipantId,
    authorLabel: input.authorLabel,
    authorSemanticRole: input.authorSemanticRole,
    messageKind: input.messageKind,
    content: "",
  });
  return draftId;
}

export function isHallDraftCanceled(draftId: string): boolean {
  return canceledHallDrafts.has(draftId);
}

export function abortHallDraftRepliesForTask(input: {
  hallId: string;
  taskCardId?: string;
  projectId?: string;
  taskId?: string;
  roomId?: string;
  reason?: string;
}): string[] {
  const abortedDraftIds: string[] = [];
  for (const [draftId, draft] of activeHallDrafts.entries()) {
    if (draft.hallId !== input.hallId) continue;
    const matchesTaskCard = input.taskCardId && draft.taskCardId === input.taskCardId;
    const matchesProjectTask = input.projectId && input.taskId && draft.projectId === input.projectId && draft.taskId === input.taskId;
    const matchesRoom = input.roomId && draft.roomId === input.roomId;
    if (!matchesTaskCard && !matchesProjectTask && !matchesRoom) continue;
    abortHallDraftReply({
      hallId: draft.hallId,
      taskCardId: draft.taskCardId,
      projectId: draft.projectId,
      taskId: draft.taskId,
      roomId: draft.roomId,
      draftId,
      reason: input.reason ?? "aborted_by_operator",
    });
    abortedDraftIds.push(draftId);
  }
  return abortedDraftIds;
}

export function pushHallDraftDelta(input: {
  hallId: string;
  taskCardId?: string;
  projectId?: string;
  taskId?: string;
  roomId?: string;
  draftId: string;
  authorParticipantId: string;
  authorLabel: string;
  authorSemanticRole?: string;
  messageKind: CollaborationStreamEvent["messageKind"];
  delta: string;
}): void {
  if (!input.delta) return;
  publishHallStreamEvent({
    type: "draft_delta",
    hallId: input.hallId,
    taskCardId: input.taskCardId,
    projectId: input.projectId,
    taskId: input.taskId,
    roomId: input.roomId,
    draftId: input.draftId,
    authorParticipantId: input.authorParticipantId,
    authorLabel: input.authorLabel,
    authorSemanticRole: input.authorSemanticRole,
    messageKind: input.messageKind,
    delta: input.delta,
  });
}

export function pushHallDraftToolUpdate(input: {
  hallId: string;
  taskCardId?: string;
  projectId?: string;
  taskId?: string;
  roomId?: string;
  draftId: string;
  toolName: string;
  toolCallId?: string;
  toolStatus: string;
}): void {
  if (!input.toolName) return;
  publishHallStreamEvent({
    type: "draft_tool_update",
    hallId: input.hallId,
    taskCardId: input.taskCardId,
    projectId: input.projectId,
    taskId: input.taskId,
    roomId: input.roomId,
    draftId: input.draftId,
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    toolStatus: input.toolStatus,
  });
}

export function beginRoomDraftReply(input: RoomDraftStreamInput): string {
  const draftId = randomUUID();
  publishRoomStreamEvent({
    type: "draft_start",
    roomId: input.roomId,
    projectId: input.projectId,
    taskId: input.taskId,
    draftId,
    authorRole: input.authorRole,
    authorLabel: input.authorLabel,
    messageKind: input.messageKind,
    content: "",
  });
  return draftId;
}

export function pushRoomDraftDelta(input: {
  roomId: string;
  projectId?: string;
  taskId?: string;
  draftId: string;
  authorRole: RoomParticipantRole;
  authorLabel: string;
  messageKind: CollaborationStreamEvent["messageKind"];
  delta: string;
}): void {
  if (!input.delta) return;
  publishRoomStreamEvent({
    type: "draft_delta",
    roomId: input.roomId,
    projectId: input.projectId,
    taskId: input.taskId,
    draftId: input.draftId,
    authorRole: input.authorRole,
    authorLabel: input.authorLabel,
    messageKind: input.messageKind,
    delta: input.delta,
  });
}

function openEventStream(
  req: IncomingMessage,
  res: ServerResponse,
  registry: Map<string, Map<string, StreamSubscriber>>,
  targetId: string,
  connectedEvent: CollaborationStreamEvent,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders?.();
  res.write(`retry: 1000\n\n`);

  const subscriberId = randomUUID();
  const scoped = registry.get(targetId) ?? new Map<string, StreamSubscriber>();
  const heartbeat = setInterval(() => {
    try {
      res.write(`: keep-alive ${Date.now()}\n\n`);
    } catch {
      cleanup();
    }
  }, HEARTBEAT_MS);
  const subscriber: StreamSubscriber = { subscriberId, res, heartbeat };
  scoped.set(subscriberId, subscriber);
  registry.set(targetId, scoped);
  writeStreamEvent(res, connectedEvent);

  const cleanup = () => {
    clearInterval(heartbeat);
    const current = registry.get(targetId);
    if (!current) return;
    current.delete(subscriberId);
    if (current.size === 0) registry.delete(targetId);
  };

  req.on("close", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
}

function publishScopedEvent(
  registry: Map<string, Map<string, StreamSubscriber>>,
  targetId: string,
  event: CollaborationStreamEvent,
): void {
  const scoped = registry.get(targetId);
  if (!scoped || scoped.size === 0) return;
  for (const subscriber of scoped.values()) {
    try {
      writeStreamEvent(subscriber.res, event);
    } catch {
      clearInterval(subscriber.heartbeat);
      scoped.delete(subscriber.subscriberId);
    }
  }
  if (scoped.size === 0) registry.delete(targetId);
}

function writeStreamEvent(res: ServerResponse, event: CollaborationStreamEvent): void {
  res.write(`event: collaboration\nid: ${event.eventId}\ndata: ${JSON.stringify(event)}\n\n`);
}

function chunkDraftContent(content: string): string[] {
  const trimmed = content.trim();
  if (!trimmed) return [""];
  const chunks: string[] = [];
  let current = "";
  for (const token of trimmed.split(/(\s+)/).filter(Boolean)) {
    if (token.length > 48) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let index = 0; index < token.length; index += 32) {
        chunks.push(token.slice(index, index + 32));
      }
      continue;
    }
    if ((current + token).length > 48 && current) {
      chunks.push(current);
      current = token;
      continue;
    }
    current += token;
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [trimmed];
}

function yieldStreamTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

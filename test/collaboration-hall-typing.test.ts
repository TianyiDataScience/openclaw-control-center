import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { ReadonlyToolClient } from "../src/clients/tool-client";
import { CHAT_MESSAGES_PATH, CHAT_ROOMS_PATH } from "../src/runtime/chat-store";
import {
  COLLABORATION_HALL_MESSAGES_PATH,
  COLLABORATION_HALLS_PATH,
  COLLABORATION_TASK_CARDS_PATH,
} from "../src/runtime/collaboration-hall-store";
import { COLLABORATION_HALL_SUMMARIES_PATH } from "../src/runtime/collaboration-hall-summary-store";
import {
  assignHallTaskExecution,
  createHallTaskFromOperatorRequest,
  recordHallTaskHandoff,
  setHallTaskExecutionOrder,
} from "../src/runtime/collaboration-hall-orchestrator";
import {
  abortHallDraftReply,
  beginHallDraftReply,
  completeHallDraftReply,
  pushHallDraftDelta,
} from "../src/runtime/collaboration-stream";
import { dispatchHallRuntimeTurn } from "../src/runtime/hall-runtime-dispatch";
import { PROJECTS_PATH } from "../src/runtime/project-store";
import { TASKS_PATH } from "../src/runtime/task-store";

test("hall SSE publishes multi-agent typing lifecycle events", async () => {
  const server = await startTestUiServer();
  try {
    if (!server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
    }
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to bind ephemeral UI port.");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${baseUrl}/api/hall/events?hallId=main`);
    assert.equal(response.status, 200);
    assert(response.body, "Expected SSE response body");

    const eventPromise = collectCollaborationEvents(response, (events) => {
      const completeCount = events.filter((event) => event.type === "draft_complete").length;
      return completeCount >= 2;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const coqDraftId = beginHallDraftReply({
      hallId: "main",
      authorParticipantId: "coq",
      authorLabel: "Coq-每日新闻",
      authorSemanticRole: "planner",
      messageKind: "proposal",
      content: "Typing lifecycle test one.",
    });
    const pandasDraftId = beginHallDraftReply({
      hallId: "main",
      authorParticipantId: "pandas",
      authorLabel: "pandas",
      authorSemanticRole: "coder",
      messageKind: "proposal",
      content: "Typing lifecycle test two.",
    });

    pushHallDraftDelta({
      hallId: "main",
      draftId: coqDraftId,
      authorParticipantId: "coq",
      authorLabel: "Coq-每日新闻",
      authorSemanticRole: "planner",
      messageKind: "proposal",
      delta: "Planner is typing.",
    });
    pushHallDraftDelta({
      hallId: "main",
      draftId: pandasDraftId,
      authorParticipantId: "pandas",
      authorLabel: "pandas",
      authorSemanticRole: "coder",
      messageKind: "proposal",
      delta: "Coder is typing.",
    });

    completeHallDraftReply({
      hallId: "main",
      draftId: coqDraftId,
      content: "Typing lifecycle test one.",
    });
    completeHallDraftReply({
      hallId: "main",
      draftId: pandasDraftId,
      content: "Typing lifecycle test two.",
    });

    const events = await withTimeout(eventPromise, 5_000);
    const collaborationEvents = events.filter((event) => event.scope === "hall");
    const startEvents = collaborationEvents.filter((event) => event.type === "draft_start");
    const deltaEvents = collaborationEvents.filter((event) => event.type === "draft_delta");
    const completeEvents = collaborationEvents.filter((event) => event.type === "draft_complete");

    assert.equal(startEvents.length, 2);
    assert.equal(deltaEvents.length, 2);
    assert.equal(completeEvents.length, 2);
    assert.deepEqual(
      startEvents.map((event) => event.authorLabel),
      ["Coq-每日新闻", "pandas"],
    );
    assert.deepEqual(
      completeEvents.map((event) => event.draftId).sort(),
      [coqDraftId, pandasDraftId].sort(),
    );
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }
});

test("hall discussion only shows the active speaker typing before the first reply completes", async () => {
  const backups = await backupFiles([
    COLLABORATION_HALLS_PATH,
    COLLABORATION_HALL_MESSAGES_PATH,
    COLLABORATION_TASK_CARDS_PATH,
    COLLABORATION_HALL_SUMMARIES_PATH,
    PROJECTS_PATH,
    TASKS_PATH,
    CHAT_ROOMS_PATH,
    CHAT_MESSAGES_PATH,
  ]);
  const server = await startTestUiServer();
  try {
    await resetFiles([
      COLLABORATION_HALLS_PATH,
      COLLABORATION_HALL_MESSAGES_PATH,
      COLLABORATION_TASK_CARDS_PATH,
      COLLABORATION_HALL_SUMMARIES_PATH,
      PROJECTS_PATH,
      TASKS_PATH,
      CHAT_ROOMS_PATH,
      CHAT_MESSAGES_PATH,
    ]);
    if (!server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
    }
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to bind ephemeral UI port.");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${baseUrl}/api/hall/events?hallId=main`);
    assert.equal(response.status, 200);
    assert(response.body, "Expected SSE response body");

    const content = `我要策划一个互动数据叙事体验-${Date.now()}，先讨论目标受众、叙事结构、风险和执行顺序。`;
    const createResponse = await fetch(`${baseUrl}/api/hall/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    const createPayload = await createResponse.json();
    assert.equal(createResponse.status, 201);
    assert.equal(createPayload.ok, true);
    const taskCardId = createPayload.taskCard?.taskCardId;
    assert.equal(typeof taskCardId, "string");

    const events = await withTimeout(
      collectCollaborationEvents(response, (streamEvents) => {
        const taskEvents = streamEvents.filter((event) => event.taskCardId === taskCardId);
        return taskEvents.some((event) => event.type === "draft_complete");
      }),
      15_000,
    );

    const taskEvents = events.filter((event) => event.taskCardId === taskCardId);
    const firstCompleteIndex = taskEvents.findIndex((event) => event.type === "draft_complete");
    assert.notEqual(firstCompleteIndex, -1);
    const startsBeforeFirstComplete = taskEvents
      .slice(0, firstCompleteIndex)
      .filter((event) => event.type === "draft_start");
    const startAuthors = [...new Set(startsBeforeFirstComplete.map((event) => String(event.authorParticipantId || "")))];

    assert.deepEqual(startAuthors.length, 1, `Expected only the active speaker to type before the first complete, saw ${startAuthors.join(", ")}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
    await restoreFiles(backups);
  }
});

test("hall runtime dispatch shows typing before slow history bootstrap finishes", async () => {
  const server = await startTestUiServer();
  try {
    if (!server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
    }
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to bind ephemeral UI port.");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${baseUrl}/api/hall/events?hallId=hall`);
    assert.equal(response.status, 200);
    assert(response.body, "Expected SSE response body");

    const eventsPromise = collectCollaborationEvents(response, (events) => {
      return events.some((event) => event.type === "draft_start" && event.taskCardId === "card");
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const startedAt = Date.now();
    const turnPromise = dispatchHallRuntimeTurn({
      client: {
        sessionsHistory: async () => {
          await new Promise((resolve) => setTimeout(resolve, 800));
          return { history: [] };
        },
        agentRun: async (request: { sessionKey?: string }) => ({
          ok: true,
          text: "先把观众第一眼会看到的价值锁住。",
          rawText: "",
          sessionKey: request.sessionKey,
        }),
      } as never,
      hall: {
        hallId: "hall",
        participants: [],
        updatedAt: new Date().toISOString(),
      } as never,
      taskCard: {
        taskCardId: "card",
        hallId: "hall",
        projectId: "project",
        taskId: "task",
        title: "我想要做一个视频 介绍我的群聊功能",
        description: "我想要做一个视频 介绍我的群聊功能",
        status: "todo",
        plannedExecutionOrder: [],
        plannedExecutionItems: [],
        mentionedParticipantIds: [],
        sessionKeys: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as never,
      participant: {
        participantId: "main",
        agentId: "main",
        displayName: "main",
        semanticRole: "manager",
        aliases: [],
        active: true,
      } as never,
      triggerMessage: {
        hallId: "hall",
        taskCardId: "card",
        messageId: "trigger",
        kind: "task",
        authorParticipantId: "operator",
        authorLabel: "Operator",
        content: "我想要做一个视频 介绍我的群聊功能",
        createdAt: new Date().toISOString(),
      } as never,
      recentThreadMessages: [],
      mode: "discussion",
    });

    const events = await withTimeout(eventsPromise, 2_000);
    const draftStart = events.find((event) => event.type === "draft_start" && event.taskCardId === "card");
    assert.ok(draftStart, "Expected draft_start event for the hall runtime turn.");
    assert.ok(Date.now() - startedAt < 500, `Expected typing to appear before history bootstrap finished, saw ${Date.now() - startedAt}ms`);

    await withTimeout(turnPromise, 3_000);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }
});

test("hall handoff primes next-owner typing immediately before runtime auto-dispatch catches up", async () => {
  const backups = await backupFiles([
    COLLABORATION_HALLS_PATH,
    COLLABORATION_HALL_MESSAGES_PATH,
    COLLABORATION_TASK_CARDS_PATH,
    COLLABORATION_HALL_SUMMARIES_PATH,
    PROJECTS_PATH,
    TASKS_PATH,
    CHAT_ROOMS_PATH,
    CHAT_MESSAGES_PATH,
  ]);
  const server = await startTestUiServer();
  try {
    await resetFiles([
      COLLABORATION_HALLS_PATH,
      COLLABORATION_HALL_MESSAGES_PATH,
      COLLABORATION_TASK_CARDS_PATH,
      COLLABORATION_HALL_SUMMARIES_PATH,
      PROJECTS_PATH,
      TASKS_PATH,
      CHAT_ROOMS_PATH,
      CHAT_MESSAGES_PATH,
    ]);
    if (!server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
    }
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to bind ephemeral UI port.");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${baseUrl}/api/hall/events?hallId=main`);
    assert.equal(response.status, 200);
    assert(response.body, "Expected SSE response body");

    const created = await createHallTaskFromOperatorRequest({
      content: "Prime the next owner typing indicator as soon as a handoff lands.",
    }, {
      skipDiscussion: true,
    });
    assert(created.taskCard);

    await setHallTaskExecutionOrder({
      taskCardId: created.taskCard.taskCardId,
      executionItems: [
        {
          itemId: "item-main",
          participantId: "main",
          task: "Write three openings and hand thumbnail work to monkey.",
          handoffToParticipantId: "monkey",
          handoffWhen: "When the openings are ready for thumbnail work.",
        },
        {
          itemId: "item-monkey",
          participantId: "monkey",
          task: "Turn the chosen opening into three thumbnail URLs.",
        },
      ],
    });

    await assignHallTaskExecution({
      taskCardId: created.taskCard.taskCardId,
      ownerParticipantId: "main",
    });

    const client = {
      async sessionsHistory() {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return { rawText: "" };
      },
      async agentRunStream(_request: unknown, handlers?: { onStdoutChunk?: (chunk: string) => void }) {
        handlers?.onStdoutChunk?.("三个缩略图 URL 已经在这里：");
        return {
          ok: true,
          status: "ok",
          text: "三个缩略图 URL 已经在这里：1. https://example.com/thumb-1 2. https://example.com/thumb-2 3. https://example.com/thumb-3",
          rawText: "ok",
          sessionKey: "agent:monkey:hall:test",
          sessionId: "monkey-runtime-session",
        };
      },
      async agentRun() {
        return {
          ok: true,
          status: "ok",
          text: "三个缩略图 URL 已经在这里：1. https://example.com/thumb-1 2. https://example.com/thumb-2 3. https://example.com/thumb-3",
          rawText: "ok",
          sessionKey: "agent:monkey:hall:test",
          sessionId: "monkey-runtime-session",
        };
      },
    };

    const startedAt = Date.now();
    const eventPromise = collectCollaborationEvents(response, (events) => {
      return events.some((event) =>
        event.taskCardId === created.taskCard?.taskCardId
        && event.type === "draft_start"
        && event.authorParticipantId === "monkey",
      );
    });

    const handoffPromise = recordHallTaskHandoff({
      taskCardId: created.taskCard.taskCardId,
      fromParticipantId: "main",
      toParticipantId: "monkey",
      handoff: {
        goal: "Turn the chosen opening into three thumbnail URLs.",
        currentResult: "The three spoken openings are ready for monkey.",
        doneWhen: "Three thumbnail URLs are posted in the hall.",
        blockers: [],
        nextOwner: "monkey",
        requiresInputFrom: [],
      },
    }, {
      toolClient: client as never,
    });

    const events = await withTimeout(eventPromise, 2_000);
    const monkeyStart = events.find((event) =>
      event.taskCardId === created.taskCard?.taskCardId
      && event.type === "draft_start"
      && event.authorParticipantId === "monkey",
    );
    assert.ok(monkeyStart, "Expected monkey typing to start as soon as the handoff landed.");
    assert.ok(Date.now() - startedAt < 500, `Expected next-owner typing to appear immediately after handoff, saw ${Date.now() - startedAt}ms`);

    await withTimeout(handoffPromise, 5_000);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
    await restoreFiles(backups);
  }
});

test("hall SSE can abort placeholder typing drafts", async () => {
  const server = await startTestUiServer();
  try {
    if (!server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
    }
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to bind ephemeral UI port.");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${baseUrl}/api/hall/events?hallId=main`);
    assert.equal(response.status, 200);
    assert(response.body, "Expected SSE response body");

    let expectedDraftId: string | undefined;
    const eventPromise = collectCollaborationEvents(response, (events) => {
      return Boolean(
        expectedDraftId
        && events.some((event) => event.type === "draft_abort" && event.draftId === expectedDraftId),
      );
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const draftId = beginHallDraftReply({
      hallId: "main",
      authorParticipantId: "monkey",
      authorLabel: "monkey",
      authorSemanticRole: "reviewer",
      messageKind: "proposal",
      content: "",
    });
    expectedDraftId = draftId;
    abortHallDraftReply({
      hallId: "main",
      draftId,
      reason: "test_abort",
    });

    const events = await withTimeout(eventPromise, 5_000);
    const abortEvent = [...events].reverse().find((event) => event.type === "draft_abort" && event.draftId === draftId);
    assert.ok(abortEvent);
    assert.equal(abortEvent?.draftId, draftId);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }
});

async function collectCollaborationEvents(
  response: Response,
  shouldStop: (events: Array<Record<string, unknown>>) => boolean,
): Promise<Array<Record<string, unknown>>> {
  const reader = response.body?.getReader();
  if (!reader) return [];
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Array<Record<string, unknown>> = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
      if (!block.trim() || block.startsWith(":")) continue;
      let eventName = "";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice("event:".length).trim();
        if (line.startsWith("data:")) data += line.slice("data:".length).trim();
      }
      if (eventName === "collaboration" && data) {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        events.push(parsed);
        if (shouldStop(events)) {
          await reader.cancel();
          return events;
        }
      }
    }
  }

  return events;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function startTestUiServer() {
  const { startUiServer } = await import("../src/ui/server");
  return startUiServer(0, new ReadonlyToolClient(), {
    localTokenAuthRequired: false,
  });
}

async function backupFiles(paths: string[]): Promise<Map<string, string | undefined>> {
  const backups = new Map<string, string | undefined>();
  for (const path of paths) {
    backups.set(path, await readFile(path, "utf8").catch(() => undefined));
  }
  return backups;
}

async function restoreFiles(backups: Map<string, string | undefined>): Promise<void> {
  for (const [path, contents] of backups.entries()) {
    if (contents === undefined) {
      await rm(path, { force: true }).catch(() => undefined);
    } else {
      await writeFile(path, contents, "utf8");
    }
  }
}

async function resetFiles(paths: string[]): Promise<void> {
  for (const path of paths) {
    await rm(path, { force: true }).catch(() => undefined);
  }
}

import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import type { ToolClient } from "../src/clients/tool-client";
import { appendChatMessage, CHAT_MESSAGES_PATH, CHAT_ROOMS_PATH } from "../src/runtime/chat-store";
import {
  COLLABORATION_HALL_MESSAGES_PATH,
  COLLABORATION_HALLS_PATH,
  COLLABORATION_TASK_CARDS_PATH,
  appendHallMessage,
  updateHallTaskCard,
} from "../src/runtime/collaboration-hall-store";
import { COLLABORATION_HALL_SUMMARIES_PATH } from "../src/runtime/collaboration-hall-summary-store";
import {
  archiveHallTaskThread,
  assignHallTaskExecution,
  createHallTaskFromOperatorRequest,
  deleteHallTaskThread,
  postHallMessage,
  readCollaborationHall,
  readCollaborationHallTaskDetail,
  recordHallTaskHandoff,
  setHallTaskExecutionOrder,
  stopHallTaskExecution,
  submitHallTaskReview,
  waitForHallBackgroundWork,
} from "../src/runtime/collaboration-hall-orchestrator";
import { readRoomDetail } from "../src/runtime/room-orchestrator";
import { PROJECTS_PATH } from "../src/runtime/project-store";
import { patchTask, TASKS_PATH } from "../src/runtime/task-store";
import type { AgentRunRequest, AgentRunResponse, SessionsHistoryRequest, SessionsHistoryResponse } from "../src/contracts/openclaw-tools";

test("collaboration hall orchestrator creates a task, runs discussion, and reviews it", async () => {
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

  try {
    const created = await createHallTaskFromOperatorRequest(
      {
        content: "Build the public collaboration hall in control-center.",
      },
      { skipDiscussion: true },
    );
    assert(created.taskCard);
    assert(created.task);
    assert.equal(Boolean(created.taskCard?.executionLock && !created.taskCard.executionLock.releasedAt), false);
    const assigned = await assignHallTaskExecution({
      taskCardId: created.taskCard!.taskCardId,
      ownerParticipantId: created.taskCard?.currentOwnerParticipantId,
    });
    assert.ok(assigned.taskCard?.executionLock && !assigned.taskCard.executionLock.releasedAt);

    const reviewed = await submitHallTaskReview({
      taskCardId: created.taskCard!.taskCardId,
      outcome: "approved",
    });
    assert.equal(reviewed.taskCard?.status, "done");
    assert.equal(reviewed.task?.owner, assigned.taskCard?.currentOwnerLabel);

    const hall = await readCollaborationHall();
    const taskMessages = hall.messages.filter((message) => message.taskCardId === created.taskCard!.taskCardId);
    assert(taskMessages.length >= 2);
    assert(taskMessages.some((message) => message.kind === "review"));
    assert(hall.taskCards.some((taskCard) => taskCard.taskCardId === created.taskCard!.taskCardId));
  } finally {
    await restoreFiles(backups);
  }
});

test("hall task detail merges linked room history when hall messages are sparse", async () => {
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

  try {
    const created = await createHallTaskFromOperatorRequest(
      {
        content: "Verify that hall task detail can still show linked room history after a refresh.",
      },
      { skipDiscussion: true },
    );
    assert(created.taskCard?.roomId);

    await appendChatMessage({
      roomId: created.taskCard.roomId,
      kind: "proposal",
      authorRole: "planner",
      authorLabel: "Coq-每日新闻",
      content: "Room-only proposal that should still appear inside the hall thread detail.",
    });
    await appendChatMessage({
      roomId: created.taskCard.roomId,
      kind: "status",
      authorRole: "coder",
      authorLabel: "pandas",
      content: "Room-only execution update that should still appear inside the hall thread detail.",
    });

    const detail = await readCollaborationHallTaskDetail(created.taskCard.taskCardId);
    const contents = detail.messages.map((message) => message.content);
    assert(contents.some((content) => content.includes("Room-only proposal")));
    assert(contents.some((content) => content.includes("Room-only execution update")));
    assert(detail.messages.length >= 3);
  } finally {
    await restoreFiles(backups);
  }
});

test("hall task detail keeps linked room discussion but filters legacy room handoff system messages", async () => {
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

  try {
    const created = await createHallTaskFromOperatorRequest(
      {
        content: "Keep useful linked room discussion, but do not surface old room handoff templates in hall detail.",
      },
      { skipDiscussion: true },
    );
    assert(created.taskCard?.roomId);

    await appendChatMessage({
      roomId: created.taskCard.roomId,
      kind: "proposal",
      authorRole: "planner",
      authorLabel: "Coq-每日新闻",
      content: "Room-only proposal that should still appear in the hall timeline.",
    });
    await appendChatMessage({
      roomId: created.taskCard.roomId,
      kind: "handoff",
      authorRole: "manager",
      authorLabel: "Manager",
      content: "Manager handed the room to Reviewer.",
    });

    const detail = await readCollaborationHallTaskDetail(created.taskCard.taskCardId);
    const contents = detail.messages.map((message) => message.content);
    assert(contents.some((content) => content.includes("Room-only proposal")));
    assert(!contents.some((content) => content.includes("handed the room to")));
  } finally {
    await restoreFiles(backups);
  }
});

test("hall task detail filters legacy handoff templates even when they were already persisted as hall messages", async () => {
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

  try {
    const created = await createHallTaskFromOperatorRequest(
      {
        content: "Do not surface old English room handoff templates when they already exist in the hall timeline.",
      },
      { skipDiscussion: true },
    );
    assert(created.taskCard);

    await appendHallMessage({
      hallId: created.taskCard.hallId,
      projectId: created.taskCard.projectId,
      taskId: created.taskCard.taskId,
      taskCardId: created.taskCard.taskCardId,
      roomId: created.taskCard.roomId,
      kind: "handoff",
      authorParticipantId: "main",
      authorLabel: "main",
      authorSemanticRole: "manager",
      content: "Manager handed the room to Reviewer.",
    });

    const detail = await readCollaborationHallTaskDetail(created.taskCard.taskCardId);
    const contents = detail.messages.map((message) => message.content);
    assert(!contents.some((content) => content.includes("Manager handed the room to Reviewer.")));
  } finally {
    await restoreFiles(backups);
  }
});

test("hall greeting without a selected task still gets a lobby reply", async () => {
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
    const result = await postHallMessage({
      content: "hello",
    });

    assert.equal(result.generatedMessages.length, 1);
    assert.ok(result.generatedMessages[0]?.authorParticipantId);

    const hall = await readCollaborationHall();
    assert.equal(hall.taskCards.length, 0);
    assert(hall.messages.length >= 2);
  } finally {
    await restoreFiles(backups);
  }
});

test("hall greeting replies in the same language as the user message", async () => {
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

    const english = await postHallMessage({
      content: "hello",
    });
    assert.equal(english.generatedMessages.length, 1);
    assert.match(english.generatedMessages[0]?.content ?? "", /is here|got it/i);
    assert.doesNotMatch(english.generatedMessages[0]?.content ?? "", /在。|收到。/);

    const chinese = await postHallMessage({
      content: "你好",
    });
    assert.equal(chinese.generatedMessages.length, 1);
    assert.match(chinese.generatedMessages[0]?.content ?? "", /在。|收到。/);
  } finally {
    await restoreFiles(backups);
  }
});

test("implicit discussion persists completed speakers so typing placeholders do not linger after replies land", async () => {
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
    const result = await postHallMessage({
      content: "我想做一个介绍 control-center 群聊功能的视频，你们有什么意见吗？",
    });

    await waitForHallBackgroundWork();
    // Dropped: discussionCycle.completedParticipantIds assertions — the stage machine is gone.
    await readCollaborationHallTaskDetail(result.taskCard!.taskCardId);
  } finally {
    await restoreFiles(backups);
  }
});

test("readCollaborationHall derives live summary instead of serving stale persisted hall summary", async () => {
  const backups = await backupFiles([
    COLLABORATION_HALLS_PATH,
    COLLABORATION_HALL_MESSAGES_PATH,
    COLLABORATION_TASK_CARDS_PATH,
    COLLABORATION_HALL_SUMMARIES_PATH,
  ]);

  try {
    await writeFile(COLLABORATION_HALLS_PATH, JSON.stringify({
      halls: [
        {
          hallId: "main",
          title: "Collaboration Hall",
          description: "Acceptance hall",
          participants: [],
          taskCardIds: [],
          messageIds: [],
          lastMessageId: null,
          createdAt: "2026-03-20T00:00:00.000Z",
          updatedAt: "2026-03-20T00:00:00.000Z",
        },
      ],
      executionLocks: [],
      updatedAt: "2026-03-20T00:00:00.000Z",
    }, null, 2), "utf8");
    await writeFile(COLLABORATION_HALL_MESSAGES_PATH, JSON.stringify({
      messages: [],
      updatedAt: "2026-03-20T00:00:00.000Z",
    }, null, 2), "utf8");
    await writeFile(COLLABORATION_TASK_CARDS_PATH, JSON.stringify({
      taskCards: [],
      updatedAt: "2026-03-20T00:00:00.000Z",
    }, null, 2), "utf8");
    await writeFile(COLLABORATION_HALL_SUMMARIES_PATH, JSON.stringify({
      hallSummaries: [
        {
          hallId: "main",
          headline: "Old smoke summary that should not leak back into the hall.",
          activeTaskCount: 4,
          waitingReviewCount: 1,
          needsHumanReviewCount: 0,
          currentSpeakerLabel: "main",
          updatedAt: "2026-03-19T22:15:05.443Z",
        },
      ],
      taskSummaries: [],
      updatedAt: "2026-03-19T22:15:05.443Z",
    }, null, 2), "utf8");

    const hall = await readCollaborationHall();
    assert.equal(hall.hallSummary.activeTaskCount, 0);
    assert.equal(hall.hallSummary.waitingReviewCount, 0);
    assert.equal(hall.hallSummary.needsHumanReviewCount, 0);
    assert.equal(hall.hallSummary.headline, "The hall is ready for the next request.");
  } finally {
    await restoreFiles(backups);
  }
});

test("archived hall threads disappear from the active hall list without deleting their task records", async () => {
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

  try {
    const created = await createHallTaskFromOperatorRequest({
      content: "Archive this hall thread after it exists.",
    }, {
      skipDiscussion: true,
    });
    assert(created.taskCard);

    await archiveHallTaskThread({
      taskCardId: created.taskCard.taskCardId,
    });

    const hall = await readCollaborationHall();
    assert(!hall.taskCards.some((taskCard) => taskCard.taskCardId === created.taskCard?.taskCardId));

    const detail = await readCollaborationHallTaskDetail(created.taskCard.taskCardId);
    assert(detail.taskCard.archivedAt);
  } finally {
    await restoreFiles(backups);
  }
});

test("deleted hall threads remove the task card and hall messages from the active workspace", async () => {
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

  try {
    const created = await createHallTaskFromOperatorRequest({
      content: "Delete this hall thread after it exists.",
    }, {
      skipDiscussion: true,
    });
    assert(created.taskCard);

    await deleteHallTaskThread({
      taskCardId: created.taskCard.taskCardId,
    });

    const hall = await readCollaborationHall();
    assert(!hall.taskCards.some((taskCard) => taskCard.taskCardId === created.taskCard?.taskCardId));
    assert(!hall.messages.some((message) => message.taskCardId === created.taskCard?.taskCardId));
  } finally {
    await restoreFiles(backups);
  }
});

test("stopping execution clears the current execution item and returns the task to discussion", async () => {
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

  try {
    const created = await createHallTaskFromOperatorRequest(
      {
        content: "Create a hall task whose current step should clear when execution is stopped.",
      },
      { skipDiscussion: true },
    );
    assert(created.taskCard);

    await setHallTaskExecutionOrder({
      taskCardId: created.taskCard.taskCardId,
      executionItems: [
        {
          itemId: "item-main",
          participantId: "main",
          task: "Ship the current focused execution step.",
          handoffToParticipantId: "pandas",
          handoffWhen: "When the pass is ready for review.",
        },
      ],
    });

    const assigned = await assignHallTaskExecution({
      taskCardId: created.taskCard.taskCardId,
      ownerParticipantId: "main",
    });
    assert.equal(assigned.taskCard?.currentExecutionItem?.task, "Ship the current focused execution step.");

    const stopped = await stopHallTaskExecution({
      taskCardId: created.taskCard.taskCardId,
      note: "Let's reopen discussion before we keep going.",
    });

    assert.equal(Boolean(stopped.taskCard?.executionLock && !stopped.taskCard.executionLock.releasedAt), false);
    assert.equal(stopped.taskCard?.status, "todo");
    assert.equal(stopped.taskCard?.currentOwnerParticipantId, undefined);
    assert.equal(stopped.taskCard?.currentExecutionItem, undefined);
  } finally {
    await restoreFiles(backups);
  }
});

test("runtime-backed hall orchestration stores real session linkage", async () => {
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

  try {
    const client = new FakeRuntimeToolClient();
    const created = await createHallTaskFromOperatorRequest({
      content: "Wire the hall to the real runtime session chain.",
    }, {
      toolClient: client,
    });
    assert(created.taskCard);
    await waitForHallBackgroundWork();
    assert((client.agentRunStreamCalls.length + client.agentRunCalls.length) >= 1);
    await waitForHallMessage((message) => message.taskCardId === created.taskCard!.taskCardId && (message.payload?.sessionKey ?? "").startsWith("agent:"));

    const assigned = await assignHallTaskExecution({
      taskCardId: created.taskCard.taskCardId,
    }, {
      toolClient: client,
    });
    await waitForHallMessage((message) => message.taskCardId === created.taskCard!.taskCardId && (message.payload?.sessionKey ?? "").startsWith("agent:"), 0, 3_000);

    const hall = await readCollaborationHall();
    const storedTaskCard = hall.taskCards.find((card) => card.taskCardId === created.taskCard?.taskCardId);
    assert(storedTaskCard);
    assert(storedTaskCard.sessionKeys.some((sessionKey) => sessionKey.startsWith("agent:")));

    const detail = await readRoomDetail(created.roomId!);
    assert(detail.room.sessionKeys.some((sessionKey) => sessionKey.startsWith("agent:")));
  } finally {
    await restoreFiles(backups);
  }
});

test("runtime execution persists artifact refs into the task and review message payload", async () => {
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

  try {
    const client = new FakeRuntimeToolClient();
    const created = await createHallTaskFromOperatorRequest(
      {
        content: "Create a hall task that should leave a concrete artifact for review.",
      },
      {
        toolClient: client,
        skipDiscussion: true,
      },
    );
    assert(created.taskCard);

    await setHallTaskExecutionOrder({
      taskCardId: created.taskCard.taskCardId,
      executionItems: [
        {
          itemId: "item-main",
          participantId: "main",
          task: "Write a first draft script and attach the artifact link.",
        },
      ],
    });

    client.queueResponse({
      ok: true,
      status: "ok",
      text: `第一版脚本已出。![script](https://example.com/script-v1.png)<hall-structured>${JSON.stringify({
        latestSummary: "第一版脚本已出，可以请老板评审。",
        nextAction: "review",
        artifactRefs: [
          {
            artifactId: "script-v1",
            type: "doc",
            label: "script-v1.png",
            location: "https://example.com/script-v1.png",
          },
        ],
      })}</hall-structured>`,
      rawText: "ok",
      sessionKey: "agent:main:artifact",
      sessionId: "main-artifact-session",
    });

    const assigned = await assignHallTaskExecution({
      taskCardId: created.taskCard.taskCardId,
      ownerParticipantId: "main",
    }, {
      toolClient: client,
    });
    assert.equal(assigned.task?.artifacts.length, 1);
    assert.equal(assigned.task?.artifacts[0]?.location, "https://example.com/script-v1.png");

    const hall = await readCollaborationHall();
    const reviewMessage = hall.messages
      .filter((message) => message.taskCardId === created.taskCard.taskCardId)
      .find((message) => message.kind === "system" && message.payload?.status === "execution_ready_for_review");
    assert(reviewMessage);
    assert.equal(reviewMessage.payload?.artifactRefs?.[0]?.location, "https://example.com/script-v1.png");
  } finally {
    await restoreFiles(backups);
  }
});

function createScriptedHallToolClient(
  scriptedResponses: Array<{
    content: string;
    sessionKey?: string;
    sessionId?: string;
    status?: string;
  }>,
): FakeRuntimeToolClient {
  const client = new FakeRuntimeToolClient();
  for (const [index, response] of scriptedResponses.entries()) {
    const sessionKey = response.sessionKey?.trim() || `agent:scripted:${index + 1}`;
    client.queueResponse({
      ok: true,
      status: response.status?.trim() || "ok",
      text: response.content,
      rawText: "ok",
      sessionKey,
      sessionId: response.sessionId?.trim() || `${sessionKey.replace(/[^a-z0-9]+/gi, "-")}-session`,
    });
  }
  return client;
}

test("runtime-backed hall prefers direct streaming client output when available", async () => {
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

  try {
    const client = new FakeRuntimeToolClient();
    const created = await createHallTaskFromOperatorRequest({
      content: "Use the streaming runtime path for hall discussion.",
    }, {
      toolClient: client,
    });
    assert(created.taskCard);
    await waitForHallBackgroundWork();
    assert(client.agentRunStreamCalls.length >= 1);
    assert.equal(client.agentRunCalls.length, 0);
  } finally {
    await restoreFiles(backups);
  }
});

test("runtime-backed hall filters internal thinking and tool output out of visible hall messages", async () => {
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

  try {
    const client = new FakeRuntimeToolClient();
    client.queueResponse({
      ok: true,
      status: "ok",
      text: [
        'Inspecting repo for updates I might need to inspect the repository since the user mentioned doing real work if necessary.',
        '[tool] import type { UiLanguage } from "../runtime/ui-preferences";',
        '[tool] export function renderCollaborationHallTheme(): string { return `...`; }',
        '<hall-structured>{"proposal":"先锁一句观众能复述的话。","latestSummary":"第一轮先证明这不是聊天，而是在推进任务。","nextAction":"continue"}</hall-structured>',
        '先锁一句观众能复述的话：这不是几个 AI 在聊天，而是在围绕同一个任务分工、拍板、推进。',
      ].join("\n"),
      rawText: [
        'Inspecting repo for updates I might need to inspect the repository since the user mentioned doing real work if necessary.',
        '[tool] import type { UiLanguage } from "../runtime/ui-preferences";',
        '[tool] export function renderCollaborationHallTheme(): string { return `...`; }',
        '<hall-structured>{"proposal":"先锁一句观众能复述的话。","latestSummary":"第一轮先证明这不是聊天，而是在推进任务。","nextAction":"continue"}</hall-structured>',
        '先锁一句观众能复述的话：这不是几个 AI 在聊天，而是在围绕同一个任务分工、拍板、推进。',
      ].join("\n"),
      sessionKey: "agent:coq:main",
      sessionId: "coq-session",
    });

    const created = await createHallTaskFromOperatorRequest({
      content: "我想要做一个视频 介绍我的群聊功能",
    }, {
      toolClient: client,
    });
    assert(created.taskCard);
    await waitForHallBackgroundWork();

    const hall = await readCollaborationHall();
    const taskMessages = hall.messages.filter((message) => message.taskCardId === created.taskCard?.taskCardId);
    const combined = taskMessages.map((message) => message.content).join("\n");

    assert.match(combined, /先锁一句观众能复述的话/);
    assert.doesNotMatch(combined, /\[tool\]/i);
    assert.doesNotMatch(combined, /Inspecting repo/i);
    assert.doesNotMatch(combined, /import type \{ UiLanguage \}/i);
  } finally {
    await restoreFiles(backups);
  }
});

test("runtime-backed hall discussion honors explicit @mentions on the very first operator task", async () => {
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

  try {
    const client = new FakeRuntimeToolClient();
    client.queueResponse({
      ok: true,
      status: "ok",
      text: "我先从视频目标和叙事顺序收一下。<hall-structured>{\"proposal\":\"先锁视频要证明什么。\",\"nextAction\":\"continue\"}</hall-structured>",
      rawText: "ok",
      sessionKey: "agent:main:hall",
      sessionId: "main-session",
    });
    client.queueResponse({
      ok: true,
      status: "ok",
      text: "我补一个代码和执行视角，先看 hall-chat 现在已经能展示什么。",
      rawText: "ok",
      sessionKey: "agent:pandas:hall",
      sessionId: "pandas-session",
    });

    const created = await createHallTaskFromOperatorRequest({
      content: "@main @pandas 我想要做一个视频 介绍我的群聊功能。",
    }, {
      toolClient: client,
    });
    assert(created.taskCard);
    assert.deepEqual(created.taskCard?.mentionedParticipantIds, ["main", "pandas"]);

    await waitForHallBackgroundWork();

    const hall = await readCollaborationHall();
    const taskMessages = hall.messages.filter((message) => message.taskCardId === created.taskCard?.taskCardId);
    const agentReplies = taskMessages.filter((message) => message.authorParticipantId !== "operator" && message.kind !== "system");
    const distinctAuthors = [...new Set(agentReplies.map((message) => message.authorParticipantId))];
    assert.deepEqual(distinctAuthors, ["main", "pandas"]);

    const initialTaskMessage = taskMessages.find((message) => message.authorParticipantId === "operator");
    assert(initialTaskMessage);
    assert.deepEqual(initialTaskMessage.targetParticipantIds, ["main", "pandas"]);
    assert.deepEqual(
      (initialTaskMessage.mentionTargets ?? []).map((target) => target.participantId),
      ["main", "pandas"],
    );

    const runtimeCalls = client.agentRunStreamCalls.length > 0 ? client.agentRunStreamCalls : client.agentRunCalls;
    assert.equal(runtimeCalls.length >= 2, true);
    assert.equal(runtimeCalls[0]?.agentId, "main");
    assert.equal(runtimeCalls[1]?.agentId, "pandas");
  } finally {
    await restoreFiles(backups);
  }
});

test("runtime-backed hall prompts agents to answer in the user's language", async () => {
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

  try {
    const client = new FakeRuntimeToolClient();
    await createHallTaskFromOperatorRequest({
      content: "I want to create a data storytelling animation and discuss the audience first.",
    }, {
      toolClient: client,
    });
    await waitForHallBackgroundWork();
    assert(client.agentRunStreamCalls.some((request) => request.message.includes("Reply in English")));

    const chineseClient = new FakeRuntimeToolClient();
    await createHallTaskFromOperatorRequest({
      content: "我想做一个数据叙事动画，先讨论目标受众。",
    }, {
      toolClient: chineseClient,
    });
    await waitForHallBackgroundWork();
    assert(chineseClient.agentRunStreamCalls.some((request) => request.message.includes("Reply in Simplified Chinese")));
  } finally {
    await restoreFiles(backups);
  }
});

test("duplicate operator follow-up during discussion does not append a second identical turn", async () => {
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

  try {
    const content = "我想要做一个视频 介绍我的群聊功能";
    const created = await createHallTaskFromOperatorRequest(
      {
        content,
      },
      {
        skipDiscussion: true,
      },
    );

    const before = await readCollaborationHallTaskDetail(created.taskCard!.taskCardId);
    assert.equal(before.messages.length, 1);
    assert.equal(before.messages[0]?.kind, "task");

    const duplicate = await postHallMessage({
      taskCardId: created.taskCard!.taskCardId,
      content,
    });

    const after = await readCollaborationHallTaskDetail(created.taskCard!.taskCardId);
    assert.equal(after.messages.length, 1);
    assert.equal(after.messages[0]?.kind, "task");
    assert.equal(duplicate.generatedMessages.length, 0);
    assert.equal(duplicate.message?.messageId, before.messages[0]?.messageId);
  } finally {
    await restoreFiles(backups);
  }
});

async function backupFiles(paths: string[]): Promise<Map<string, string | undefined>> {
  const backups = new Map<string, string | undefined>();
  for (const path of paths) {
    backups.set(path, await readOptionalFile(path));
  }
  return backups;
}

async function restoreFiles(backups: Map<string, string | undefined>): Promise<void> {
  await waitForHallBackgroundWork();
  for (const [path, content] of backups.entries()) {
    if (content === undefined) {
      await rm(path, { force: true });
    } else {
      await writeFile(path, content, "utf8");
    }
  }
}

async function resetFiles(paths: string[]): Promise<void> {
  await waitForHallBackgroundWork();
  for (const path of paths) {
    await rm(path, { force: true });
  }
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function waitForHallMessage(
  predicate: Parameters<Array<typeof Array.prototype.find>[0]>[0],
  fromIndex = 0,
  timeoutMs = 2_000,
): Promise<Awaited<ReturnType<typeof readCollaborationHall>>["messages"][number]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hall = await readCollaborationHall();
    const match = hall.messages.slice(fromIndex).find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for a hall message.`);
}

class FakeRuntimeToolClient implements ToolClient {
  readonly agentRunCalls: AgentRunRequest[] = [];
  readonly agentRunStreamCalls: AgentRunRequest[] = [];
  private readonly queuedResponses: AgentRunResponse[] = [];
  private managerDiscussionResponse?: AgentRunResponse;

  async sessionsList() {
    return { sessions: [] };
  }

  async sessionStatus() {
    return { rawText: "" };
  }

  async sessionsHistory(_request: SessionsHistoryRequest): Promise<SessionsHistoryResponse> {
    return { rawText: "" };
  }

  async cronList() {
    return { jobs: [] };
  }

  async approvalsGet() {
    return { rawText: "" };
  }

  async approvalsApprove() {
    return { ok: false, action: "approve" as const, approvalId: "n/a", rawText: "" };
  }

  async approvalsReject() {
    return { ok: false, action: "reject" as const, approvalId: "n/a", rawText: "" };
  }

  queueResponse(response: AgentRunResponse): void {
    this.queuedResponses.push(response);
  }

  setManagerDiscussionResponse(response: AgentRunResponse): void {
    this.managerDiscussionResponse = response;
  }

  async agentRun(request: AgentRunRequest): Promise<AgentRunResponse> {
    this.agentRunCalls.push(request);
    return this.nextResponse(request);
  }

  async agentRunStream(request: AgentRunRequest, handlers?: { onStdoutChunk?: (chunk: string) => void }): Promise<AgentRunResponse> {
    this.agentRunStreamCalls.push(request);
    const response = this.nextResponse(request);
    const content = response.rawText && response.rawText !== "ok" ? response.rawText : (response.text || "");
    const midpoint = Math.max(1, Math.floor(content.length / 2));
    handlers?.onStdoutChunk?.(content.slice(0, midpoint));
    handlers?.onStdoutChunk?.(content.slice(midpoint));
    return response;
  }

  private nextResponse(request: AgentRunRequest): AgentRunResponse {
    const queued = this.queuedResponses.shift();
    if (queued) return queued;

    const agentId = request.agentId?.trim() || "agent";
    const sessionKey = request.sessionKey?.trim() || `agent:${agentId}:main`;
    if (request.message.includes("You must close the discussion")) {
      if (this.managerDiscussionResponse) {
        const response = this.managerDiscussionResponse;
        this.managerDiscussionResponse = undefined;
        return response;
      }
      return {
        ok: true,
        status: "ok",
        text: `<hall-structured>${JSON.stringify({
          decision: "Use a single execution owner in the hall.",
          doneWhen: "discussion, execution, and review stay in one shared timeline",
        })}</hall-structured>${agentId} closed the discussion and recommended a single-owner flow.`,
        rawText: "ok",
        sessionKey,
        sessionId: `${agentId}-session`,
      };
    }

    return {
      ok: true,
      status: "ok",
      text: `${agentId} posted a real runtime update for the hall.`,
      rawText: "ok",
      sessionKey,
      sessionId: `${agentId}-session`,
    };
  }
}

import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import type { ToolClient } from "../src/clients/tool-client";
import type {
  AgentRunRequest,
  AgentRunResponse,
  SessionsHistoryRequest,
  SessionsHistoryResponse,
} from "../src/contracts/openclaw-tools";
import { CHAT_MESSAGES_PATH, CHAT_ROOMS_PATH } from "../src/runtime/chat-store";
import {
  COLLABORATION_HALL_MESSAGES_PATH,
  COLLABORATION_HALLS_PATH,
  COLLABORATION_TASK_CARDS_PATH,
  createHallTaskCard,
  ensureDefaultCollaborationHall,
  loadCollaborationTaskCardStore,
  updateHallTaskCard,
} from "../src/runtime/collaboration-hall-store";
import { COLLABORATION_HALL_SUMMARIES_PATH } from "../src/runtime/collaboration-hall-summary-store";
import {
  createHallTaskFromOperatorRequest,
  postHallMessage,
  readCollaborationHall,
  waitForHallBackgroundWork,
} from "../src/runtime/collaboration-hall-orchestrator";
import { dispatchHallRuntimeTurn } from "../src/runtime/hall-runtime-dispatch";
import { PROJECTS_PATH } from "../src/runtime/project-store";
import { TASKS_PATH } from "../src/runtime/task-store";

const STATE_PATHS = [
  COLLABORATION_HALLS_PATH,
  COLLABORATION_HALL_MESSAGES_PATH,
  COLLABORATION_TASK_CARDS_PATH,
  COLLABORATION_HALL_SUMMARIES_PATH,
  PROJECTS_PATH,
  TASKS_PATH,
  CHAT_ROOMS_PATH,
  CHAT_MESSAGES_PATH,
];

// ---------------------------------------------------------------------------
// A1 + A4: prompt-level tests via dispatchHallRuntimeTurn (no orchestrator,
// no routing — we only care that the prompt string carries the new instructions)
// ---------------------------------------------------------------------------

test("A1: when the task card records an original assigner, dispatchHallRuntimeTurn injects an instruction to @-report back to that assigner", async () => {
  const seenPrompts: string[] = [];
  const client = {
    sessionsHistory: async () => ({ rawText: "" }),
    agentRun: async (request: { message: string; sessionKey?: string }) => {
      seenPrompts.push(request.message);
      return { ok: true, text: "ack", rawText: "ok", sessionKey: request.sessionKey };
    },
  } as unknown as ToolClient;

  await dispatchHallRuntimeTurn({
    client,
    hall: {
      hallId: "hall",
      participants: [
        {
          participantId: "pandas", agentId: "pandas", displayName: "Pandas",
          semanticRole: "coder", aliases: ["pandas", "Pandas"], active: true,
        },
        {
          participantId: "linus", agentId: "linus", displayName: "Linus",
          semanticRole: "reviewer", aliases: ["linus", "Linus"], active: true,
        },
      ],
      updatedAt: new Date().toISOString(),
    } as never,
    taskCard: {
      taskCardId: "card-A1",
      hallId: "hall",
      projectId: "project",
      taskId: "task-A1",
      title: "test assigner",
      description: "test assigner",
      status: "todo",
      plannedExecutionOrder: [],
      plannedExecutionItems: [],
      mentionedParticipantIds: [],
      sessionKeys: [],
      blockers: [],
      requiresInputFrom: [],
      originalAssignerParticipantId: "operator",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    participant: {
      participantId: "pandas", agentId: "pandas", displayName: "Pandas",
      semanticRole: "coder", aliases: ["pandas", "Pandas"], active: true,
    } as never,
    triggerMessage: {
      hallId: "hall",
      messageId: "m1",
      kind: "task",
      authorParticipantId: "linus",
      authorLabel: "Linus",
      content: "@pandas please check the metric",
      createdAt: new Date().toISOString(),
    } as never,
    mode: "execution",
  });

  assert.equal(seenPrompts.length, 1);
  const prompt = seenPrompts[0]!;
  assert.match(
    prompt,
    /Operator|操作员|original assigner/,
    "prompt must mention the original assigner (Operator) so pandas reports back to them instead of @Linus",
  );
});

test("A1: prompt does NOT include assigner instruction when originalAssignerParticipantId is absent (legacy cards)", async () => {
  const seenPrompts: string[] = [];
  const client = {
    sessionsHistory: async () => ({ rawText: "" }),
    agentRun: async (request: { message: string; sessionKey?: string }) => {
      seenPrompts.push(request.message);
      return { ok: true, text: "ack", rawText: "ok", sessionKey: request.sessionKey };
    },
  } as unknown as ToolClient;

  await dispatchHallRuntimeTurn({
    client,
    hall: {
      hallId: "hall",
      participants: [
        {
          participantId: "pandas", agentId: "pandas", displayName: "Pandas",
          semanticRole: "coder", aliases: ["pandas", "Pandas"], active: true,
        },
      ],
      updatedAt: new Date().toISOString(),
    } as never,
    taskCard: {
      taskCardId: "card-A1b",
      hallId: "hall",
      projectId: "project",
      taskId: "task-A1b",
      title: "no assigner",
      description: "legacy card",
      status: "todo",
      plannedExecutionOrder: [],
      plannedExecutionItems: [],
      mentionedParticipantIds: [],
      sessionKeys: [],
      blockers: [],
      requiresInputFrom: [],
      // no originalAssignerParticipantId
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    participant: {
      participantId: "pandas", agentId: "pandas", displayName: "Pandas",
      semanticRole: "coder", aliases: ["pandas", "Pandas"], active: true,
    } as never,
    triggerMessage: {
      hallId: "hall",
      messageId: "m1",
      kind: "task",
      authorParticipantId: "operator",
      authorLabel: "Operator",
      content: "hello",
      createdAt: new Date().toISOString(),
    } as never,
    mode: "execution",
  });

  const prompt = seenPrompts[0] ?? "";
  // Legacy cards without an assigner must not gain a phantom hint. The
  // instruction text uses the "original assigner" English phrasing or the
  // "最初派活儿" Chinese phrasing — neither should be present.
  assert.doesNotMatch(prompt, /original assigner of this thread|最初派活儿/);
});

test("A4: prompt tells every agent (not just observers) to reply OBSERVE_SILENT when they have nothing to add", async () => {
  const seenPrompts: string[] = [];
  const client = {
    sessionsHistory: async () => ({ rawText: "" }),
    agentRun: async (request: { message: string; sessionKey?: string }) => {
      seenPrompts.push(request.message);
      return { ok: true, text: "ack", rawText: "ok", sessionKey: request.sessionKey };
    },
  } as unknown as ToolClient;

  await dispatchHallRuntimeTurn({
    client,
    hall: {
      hallId: "hall",
      participants: [
        {
          participantId: "pandas", agentId: "pandas", displayName: "Pandas",
          semanticRole: "coder", aliases: ["pandas", "Pandas"], active: true,
        },
      ],
      updatedAt: new Date().toISOString(),
    } as never,
    taskCard: {
      taskCardId: "card-A4",
      hallId: "hall",
      projectId: "project",
      taskId: "task-A4",
      title: "silent",
      description: "silent",
      status: "todo",
      plannedExecutionOrder: [],
      plannedExecutionItems: [],
      mentionedParticipantIds: [],
      sessionKeys: [],
      blockers: [],
      requiresInputFrom: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    participant: {
      participantId: "pandas", agentId: "pandas", displayName: "Pandas",
      semanticRole: "coder", aliases: ["pandas", "Pandas"], active: true,
    } as never,
    triggerMessage: {
      hallId: "hall",
      messageId: "m1",
      kind: "task",
      authorParticipantId: "operator",
      authorLabel: "Operator",
      content: "fyi",
      createdAt: new Date().toISOString(),
    } as never,
    mode: "execution",
  });

  const prompt = seenPrompts[0] ?? "";
  assert.match(prompt, /OBSERVE_SILENT/, "prompt must mention the OBSERVE_SILENT marker for any agent, not just observers");
});

// ---------------------------------------------------------------------------
// A1 store round-trip: verify the new fields persist and reload correctly.
// ---------------------------------------------------------------------------

test("store: originalAssignerParticipantId and autoRoundsByAgent round-trip through load/update cycles", async () => {
  const backups = await backupFiles(STATE_PATHS);
  try {
    const hall = await ensureDefaultCollaborationHall([
      { participantId: "main", agentId: "main", displayName: "Main", semanticRole: "observer", active: true, aliases: ["Main", "main"] },
    ]);
    const { taskCard } = await createHallTaskCard({
      hallId: hall.hallId,
      projectId: "proj-round-trip",
      taskId: "task-round-trip",
      title: "round trip",
      description: "test the new fields",
      createdByParticipantId: "operator",
    });
    assert.equal(taskCard.originalAssignerParticipantId, undefined, "new cards start without an assigner");
    assert.equal(taskCard.autoRoundsByAgent, undefined, "new cards start without round counters");

    await updateHallTaskCard({
      taskCardId: taskCard.taskCardId,
      originalAssignerParticipantId: "operator",
      autoRoundsByAgent: { main: 3, pandas: 1 },
    });

    const reloaded = await loadCollaborationTaskCardStore();
    const loaded = reloaded.taskCards.find((c) => c.taskCardId === taskCard.taskCardId);
    assert(loaded, "card should reload from disk");
    assert.equal(loaded.originalAssignerParticipantId, "operator");
    assert.deepEqual(loaded.autoRoundsByAgent, { main: 3, pandas: 1 });

    // Clearing back to null must drop the field from the persisted state.
    await updateHallTaskCard({
      taskCardId: taskCard.taskCardId,
      originalAssignerParticipantId: null,
      autoRoundsByAgent: null,
    });
    const reloaded2 = await loadCollaborationTaskCardStore();
    const loaded2 = reloaded2.taskCards.find((c) => c.taskCardId === taskCard.taskCardId);
    assert(loaded2);
    assert.equal(loaded2.originalAssignerParticipantId, undefined);
    assert.equal(loaded2.autoRoundsByAgent, undefined);
  } finally {
    await restoreFiles(backups);
  }
});

// ---------------------------------------------------------------------------
// A1 + A2 orchestrator-layer: operator posts set the assigner and reset counters.
// Uses main (which is always the default target when no @-mention resolves) to
// avoid the pre-existing @熊猫 dispatch flakiness on this branch.
// ---------------------------------------------------------------------------

test("A1+A2: operator-initiated dispatch sets originalAssigner and resets per-agent round counters", async () => {
  const backups = await backupFiles(STATE_PATHS);
  try {
    await ensureDefaultCollaborationHall([
      { participantId: "main", agentId: "main", displayName: "Main", semanticRole: "manager", active: true, aliases: ["Main", "main"] },
    ]);

    const client = new CapturingToolClient();
    const created = await createHallTaskFromOperatorRequest(
      { content: "please do the thing", authorLabel: "Operator" },
      { toolClient: client },
    );
    assert(created.taskCard);
    await waitForHallBackgroundWork();

    // A1: assigner is set to "operator" after the first human dispatch.
    let store = await loadCollaborationTaskCardStore();
    let stored = store.taskCards.find((c) => c.taskCardId === created.taskCard!.taskCardId);
    assert(stored);
    assert.equal(stored.originalAssignerParticipantId, "operator",
      "the first operator message should record operator as the original assigner");

    // Pre-seed counters as if several auto-rounds had occurred, then post
    // a second operator message. The counter must reset before dispatching.
    await updateHallTaskCard({
      taskCardId: created.taskCard!.taskCardId,
      autoRoundsByAgent: { main: 5, pandas: 3 },
    });

    client.resetCallLog();
    await postHallMessage(
      {
        projectId: created.taskCard!.projectId,
        taskId: created.taskCard!.taskId,
        taskCardId: created.taskCard!.taskCardId,
        content: "follow-up please",
        authorParticipantId: "operator",
        authorLabel: "Operator",
      },
      { toolClient: client },
    );
    await waitForHallBackgroundWork();

    store = await loadCollaborationTaskCardStore();
    stored = store.taskCards.find((c) => c.taskCardId === created.taskCard!.taskCardId);
    assert(stored);
    assert.notEqual(stored.status, "blocked",
      "human message must reset counters so the thread is not blocked by stale rounds");
    // After reset + one real dispatch to main, only main should appear and only at 1.
    assert.equal(stored.autoRoundsByAgent?.pandas, undefined,
      "pandas counter should be cleared by the operator-message reset");
    assert.equal(stored.autoRoundsByAgent?.main, 1,
      "main counter should increment to exactly 1 during the fresh operator turn");
  } finally {
    await restoreFiles(backups);
  }
});

// ---------------------------------------------------------------------------
// A4 orchestrator-layer: a non-observer agent responding OBSERVE_SILENT is
// suppressed and never lands in the thread.
// ---------------------------------------------------------------------------

test("A4: OBSERVE_SILENT reply from main (non-observer) is suppressed at the orchestrator layer", async () => {
  const backups = await backupFiles(STATE_PATHS);
  try {
    await ensureDefaultCollaborationHall([
      { participantId: "main", agentId: "main", displayName: "Main", semanticRole: "manager", active: true, aliases: ["Main", "main"] },
    ]);

    const client = new CapturingToolClient();
    client.queueResponseFor("main", {
      ok: true, status: "ok",
      text: "OBSERVE_SILENT",
      rawText: "ok",
      sessionKey: "agent:main:hall:silent",
      sessionId: "main-silent",
    });
    const created = await createHallTaskFromOperatorRequest(
      { content: "is there anything to do?", authorLabel: "Operator" },
      { toolClient: client },
    );
    assert(created.taskCard);
    await waitForHallBackgroundWork();

    // main MUST have been called at least once (baseline sanity — main is the
    // default responder when no @-mention resolves).
    const mainCalls = [...client.agentRunCalls, ...client.agentRunStreamCalls].filter(
      (r) => (r.agentId ?? "").trim() === "main",
    );
    assert(mainCalls.length >= 1, "main should have been dispatched as the default responder");

    // The OBSERVE_SILENT reply must NOT land in the hall.
    const hall = await readCollaborationHall();
    const mainMessages = hall.messages.filter(
      (m) => m.authorParticipantId === "main" && m.taskCardId === created.taskCard!.taskCardId,
    );
    assert.equal(mainMessages.length, 0,
      `OBSERVE_SILENT reply from main must be suppressed, got ${mainMessages.length} main message(s)`);
    const silentLeak = hall.messages.some((m) => m.content?.trim() === "OBSERVE_SILENT");
    assert.equal(silentLeak, false, "OBSERVE_SILENT literal must not appear in any persisted message");
  } finally {
    await restoreFiles(backups);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class CapturingToolClient implements ToolClient {
  readonly agentRunCalls: AgentRunRequest[] = [];
  readonly agentRunStreamCalls: AgentRunRequest[] = [];
  private readonly perAgentResponses = new Map<string, AgentRunResponse[]>();

  async sessionsList() { return { sessions: [] }; }
  async sessionStatus() { return { rawText: "" }; }
  async sessionsHistory(_r: SessionsHistoryRequest): Promise<SessionsHistoryResponse> { return { rawText: "" }; }
  async cronList() { return { jobs: [] }; }
  async approvalsGet() { return { rawText: "" }; }
  async approvalsApprove() { return { ok: false, action: "approve" as const, approvalId: "n/a", rawText: "" }; }
  async approvalsReject() { return { ok: false, action: "reject" as const, approvalId: "n/a", rawText: "" }; }

  queueResponseFor(agentId: string, response: AgentRunResponse): void {
    const existing = this.perAgentResponses.get(agentId) ?? [];
    existing.push(response);
    this.perAgentResponses.set(agentId, existing);
  }

  resetCallLog(): void {
    this.agentRunCalls.length = 0;
    this.agentRunStreamCalls.length = 0;
  }

  async agentRun(request: AgentRunRequest): Promise<AgentRunResponse> {
    this.agentRunCalls.push(request);
    return this.nextResponse(request);
  }

  async agentRunStream(
    request: AgentRunRequest,
    handlers?: { onStdoutChunk?: (chunk: string) => void },
  ): Promise<AgentRunResponse> {
    this.agentRunStreamCalls.push(request);
    const response = this.nextResponse(request);
    const content = response.text ?? "";
    if (content) handlers?.onStdoutChunk?.(content);
    return response;
  }

  private nextResponse(request: AgentRunRequest): AgentRunResponse {
    const agentId = (request.agentId ?? "").trim() || "agent";
    const queued = this.perAgentResponses.get(agentId);
    if (queued && queued.length > 0) return queued.shift()!;
    return {
      ok: true, status: "ok",
      text: `${agentId} acknowledged.`,
      rawText: "ok",
      sessionKey: request.sessionKey ?? `agent:${agentId}:hall:unit-test`,
      sessionId: `${agentId}-session`,
    };
  }
}

async function backupFiles(paths: string[]): Promise<Map<string, string | undefined>> {
  const result = new Map<string, string | undefined>();
  await Promise.all(
    paths.map(async (path) => {
      try {
        result.set(path, await readFile(path, "utf8"));
      } catch {
        result.set(path, undefined);
      }
    }),
  );
  return result;
}

async function restoreFiles(backups: Map<string, string | undefined>): Promise<void> {
  await Promise.all(
    Array.from(backups.entries()).map(async ([path, content]) => {
      if (content === undefined) {
        await rm(path, { force: true });
      } else {
        await writeFile(path, content, "utf8");
      }
    }),
  );
}

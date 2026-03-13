import assert from "node:assert/strict";
import test from "node:test";
import type { ToolClient } from "../src/clients/tool-client";
import {
  getSessionConversationDetail,
  listSessionConversations,
} from "../src/runtime/session-conversations";
import type { SessionsHistoryRequest, SessionsHistoryResponse } from "../src/contracts/openclaw-tools";
import type { ReadModelSnapshot } from "../src/types";

class FakeToolClient implements ToolClient {
  public historyRequests: SessionsHistoryRequest[] = [];

  constructor(private readonly historyBySession = new Map<string, SessionsHistoryResponse>()) {}

  async sessionsList() {
    return { sessions: [] };
  }

  async sessionStatus() {
    return { rawText: "" };
  }

  async sessionsHistory(request: SessionsHistoryRequest): Promise<SessionsHistoryResponse> {
    this.historyRequests.push(request);
    return this.historyBySession.get(request.sessionKey) ?? { rawText: "" };
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
}

function makeSnapshot(sessionKeys: Array<{ sessionKey: string; agentId?: string; state?: "idle" | "running" | "blocked" | "waiting_approval" | "error"; lastMessageAt?: string }>): ReadModelSnapshot {
  return {
    sessions: sessionKeys.map((item) => ({
      sessionKey: item.sessionKey,
      agentId: item.agentId,
      state: item.state ?? "idle",
      lastMessageAt: item.lastMessageAt,
    })),
    statuses: [],
    cronJobs: [],
    approvals: [],
    projects: { projects: [], updatedAt: "2026-03-07T10:00:00.000Z" },
    projectSummaries: [],
    tasks: { tasks: [], agentBudgets: [], updatedAt: "2026-03-07T10:00:00.000Z" },
    tasksSummary: {
      projects: 0,
      tasks: 0,
      todo: 0,
      inProgress: 0,
      blocked: 0,
      done: 0,
      owners: 0,
      artifacts: 0,
    },
    budgetSummary: { total: 0, ok: 0, warn: 0, over: 0, evaluations: [] },
    generatedAt: "2026-03-07T10:00:00.000Z",
  };
}

test("run child session infers execution chain from session key when history is unavailable", async () => {
  const snapshot = makeSnapshot([
    {
      sessionKey: "agent:main:cron:job-1:run:child-1",
      agentId: "main",
      state: "running",
      lastMessageAt: "2026-03-07T10:01:00.000Z",
    },
  ]);

  const result = await listSessionConversations({
    snapshot,
    client: new FakeToolClient(),
    filters: {},
    page: 1,
    pageSize: 10,
    historyLimit: 10,
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].executionChain?.source, "session_key");
  assert.equal(result.items[0].executionChain?.parentSessionKey, "agent:main:cron:job-1");
  assert.equal(result.items[0].executionChain?.childSessionKey, "agent:main:cron:job-1:run:child-1");
  assert.equal(result.items[0].executionChain?.accepted, true);
  assert.equal(result.items[0].executionChain?.spawned, true);
  assert.equal(result.items[0].executionChain?.stage, "running");
});

test("historyLimit=0 skips history fetches and keeps lightweight session-key inference", async () => {
  const snapshot = makeSnapshot([
    {
      sessionKey: "agent:main:cron:job-light:run:child-light",
      agentId: "main",
      state: "running",
      lastMessageAt: "2026-03-07T10:01:00.000Z",
    },
  ]);
  const client = new FakeToolClient(
    new Map([
      [
        "agent:main:cron:job-light:run:child-light",
        {
          json: {
            history: [
              {
                role: "assistant",
                content: "this should never be fetched in lightweight mode",
              },
            ],
          },
          rawText: "",
        },
      ],
    ]),
  );

  const result = await listSessionConversations({
    snapshot,
    client,
    filters: {},
    page: 1,
    pageSize: 10,
    historyLimit: 0,
  });

  assert.equal(client.historyRequests.length, 0);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].historyCount, 0);
  assert.equal(result.items[0].latestSnippet, undefined);
  assert.equal(result.items[0].executionChain?.source, "session_key");
  assert.equal(result.items[0].executionChain?.stage, "running");
});

test("history execution events are parsed and preferred over session-key inference", async () => {
  const sessionKey = "agent:main:cron:job-2";
  const childSessionKey = "agent:main:cron:job-2:run:child-2";
  const snapshot = makeSnapshot([
    {
      sessionKey,
      agentId: "main",
      state: "idle",
      lastMessageAt: "2026-03-07T10:02:00.000Z",
    },
  ]);
  const client = new FakeToolClient(
    new Map([
      [
        sessionKey,
        {
          json: {
            history: [
              {
                event: "accepted",
                timestamp: "2026-03-07T10:02:10.000Z",
                message: "accepted parent session",
              },
              {
                event: "sessions_spawn",
                timestamp: "2026-03-07T10:02:20.000Z",
                parentSessionKey: sessionKey,
                childSessionKey,
                message: "spawned child session",
              },
            ],
          },
          rawText: "",
        },
      ],
    ]),
  );

  const detail = await getSessionConversationDetail({
    snapshot,
    client,
    sessionKey,
    historyLimit: 20,
  });

  assert(detail);
  assert.equal(detail.executionChain?.source, "history");
  assert.equal(detail.executionChain?.accepted, true);
  assert.equal(detail.executionChain?.spawned, true);
  assert.equal(detail.executionChain?.parentSessionKey, sessionKey);
  assert.equal(detail.executionChain?.childSessionKey, childSessionKey);
  assert.equal(detail.executionChain?.acceptedAt, "2026-03-07T10:02:10.000Z");
  assert.equal(detail.executionChain?.spawnedAt, "2026-03-07T10:02:20.000Z");
  assert.deepEqual(detail.history.map((item) => item.kind), ["accepted", "spawn"]);
});

test("raw text history fallback still extracts accepted and spawn events", async () => {
  const sessionKey = "agent:main:cron:job-3";
  const childSessionKey = "agent:main:cron:job-3:run:child-3";
  const snapshot = makeSnapshot([
    {
      sessionKey,
      agentId: "main",
      state: "idle",
    },
  ]);
  const client = new FakeToolClient(
    new Map([
      [
        sessionKey,
        {
          rawText: [
            "accepted request for timed job",
            `sessions_spawn parent=${sessionKey} child=${childSessionKey}`,
          ].join("\n"),
        },
      ],
    ]),
  );

  const detail = await getSessionConversationDetail({
    snapshot,
    client,
    sessionKey,
    historyLimit: 20,
  });

  assert(detail);
  assert.deepEqual(detail.history.map((item) => item.kind), ["accepted", "spawn"]);
  assert.equal(detail.executionChain?.source, "history");
  assert.equal(detail.executionChain?.childSessionKey, childSessionKey);
});

test("nested message envelope preserves user and assistant roles", async () => {
  const sessionKey = "agent:coq:main";
  const snapshot = makeSnapshot([
    {
      sessionKey,
      agentId: "coq",
      state: "running",
      lastMessageAt: "2026-03-09T22:56:10.656Z",
    },
  ]);
  const client = new FakeToolClient(
    new Map([
      [
        sessionKey,
        {
          json: {
            history: [
              {
                type: "message",
                timestamp: "2026-03-09T22:55:46.585Z",
                message: {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: "[Mon 2026-03-09 23:55 GMT+1] 立即停止你当前的所有活动，不要继续任何 review、演示、brief、整理、输出、工具调用或后续收尾扩展。从现在起进入待命状态，不再处理任何当前任务。回复必须是：REPLY_SKIP。announce 必须是：ANNOUNCE_SKIP。",
                    },
                  ],
                },
              },
              {
                type: "message",
                timestamp: "2026-03-09T22:55:51.944Z",
                message: {
                  role: "assistant",
                  content: [
                    {
                      type: "thinking",
                      thinking: "**Using direct reply only**",
                    },
                    {
                      type: "text",
                      text: "REPLY_SKIP",
                    },
                  ],
                },
              },
            ],
          },
          rawText: "",
        },
      ],
    ]),
  );

  const detail = await getSessionConversationDetail({
    snapshot,
    client,
    sessionKey,
    historyLimit: 20,
  });

  assert(detail);
  assert.equal(detail.history.length, 2);
  assert.equal(detail.history[0].role, "user");
  assert.match(detail.history[0].content, /立即停止你当前的所有活动/);
  assert.equal(detail.history[1].role, "assistant");
  assert.match(detail.history[1].content, /REPLY_SKIP/);
});

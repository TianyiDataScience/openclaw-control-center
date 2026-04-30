import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  appendHallBlackboardMessage,
  initializeHallBlackboard,
  readHallProgressLatestEntry,
  renderHallBlackboardPromptGuidance,
} from "../src/runtime/hall-blackboard";
import { resolveHallTaskWorkspacePath } from "../src/runtime/hall-workspace";
import type { HallMessage, HallTaskCard } from "../src/types";

function freshCardId(prefix: string): string {
  return `bbtest-${prefix}-${randomUUID().slice(0, 8)}`;
}

async function cleanup(taskCardId: string): Promise<void> {
  try {
    await rm(resolveHallTaskWorkspacePath(taskCardId), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function makeCard(overrides: Partial<HallTaskCard> & { taskCardId: string }): HallTaskCard {
  return {
    hallId: "main",
    taskCardId: overrides.taskCardId,
    projectId: "p",
    taskId: "t",
    title: "测试任务",
    description: "blackboard test card",
    status: "todo",
    createdByParticipantId: "operator",
    blockers: [],
    requiresInputFrom: [],
    mentionedParticipantIds: [],
    plannedExecutionOrder: [],
    plannedExecutionItems: [],
    sessionKeys: [],
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
    ...overrides,
  };
}

function makeMessage(overrides: Partial<HallMessage> & { taskCardId: string; messageId: string }): HallMessage {
  return {
    hallId: "main",
    messageId: overrides.messageId,
    kind: "text",
    authorParticipantId: "operator",
    authorLabel: "操作员",
    content: "@林纳斯 你好",
    targetParticipantIds: ["coq"],
    mentionTargets: [{ participantId: "coq", token: "@林纳斯", display: "林纳斯" }],
    projectId: "p",
    taskId: "t",
    taskCardId: overrides.taskCardId,
    createdAt: "2026-04-27T00:01:00.000Z",
    ...overrides,
  };
}

test("initializeHallBlackboard creates .hall + three stub markdowns", async () => {
  const id = freshCardId("init");
  try {
    const card = makeCard({ taskCardId: id });
    await initializeHallBlackboard(card);
    const root = resolveHallTaskWorkspacePath(id);

    const chat = await readFile(join(root, ".hall", "chat.jsonl"), "utf8");
    assert.equal(chat, "");

    const index = await readFile(join(root, ".hall", "chat-index.md"), "utf8");
    assert.match(index, new RegExp(`Chat index for ${id}`));
    assert.match(index, /By kind/);

    const taskPlan = await readFile(join(root, "task_plan.md"), "utf8");
    assert.match(taskPlan, /# Task plan/);
    assert.match(taskPlan, /测试任务/);
    assert.match(taskPlan, /<!-- agent: system, ts:/);

    const findings = await readFile(join(root, "findings.md"), "utf8");
    assert.match(findings, /# Findings/);
    assert.match(findings, /<!-- agent: system, ts:/);

    const progress = await readFile(join(root, "progress.md"), "utf8");
    assert.match(progress, /# Progress/);
    assert.match(progress, /Task created: 测试任务/);
  } finally {
    await cleanup(id);
  }
});

test("initializeHallBlackboard is idempotent and does not overwrite agent edits", async () => {
  const id = freshCardId("idem");
  try {
    const card = makeCard({ taskCardId: id });
    await initializeHallBlackboard(card);
    const planPath = join(resolveHallTaskWorkspacePath(id), "task_plan.md");

    const original = await readFile(planPath, "utf8");
    const tampered = original + "\n<!-- agent: coq, ts: 2026-04-27T00:05:00.000Z -->\nadded by coq\n<!-- /agent -->\n";
    await writeFile(planPath, tampered, "utf8");

    await initializeHallBlackboard(card); // second call must not clobber

    const after = await readFile(planPath, "utf8");
    assert.match(after, /added by coq/);
  } finally {
    await cleanup(id);
  }
});

test("appendHallBlackboardMessage writes JSONL and refreshes the index", async () => {
  const id = freshCardId("append");
  try {
    const card = makeCard({ taskCardId: id });
    await initializeHallBlackboard(card);
    const root = resolveHallTaskWorkspacePath(id);

    await appendHallBlackboardMessage(id, makeMessage({ taskCardId: id, messageId: "m1", content: "hello" }));
    await appendHallBlackboardMessage(id, makeMessage({
      taskCardId: id,
      messageId: "m2",
      authorParticipantId: "coq",
      authorLabel: "林纳斯",
      content: "回复 hello",
      targetParticipantIds: ["operator"],
      createdAt: "2026-04-27T00:02:00.000Z",
    }));

    const jsonl = await readFile(join(root, ".hall", "chat.jsonl"), "utf8");
    const lines = jsonl.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).messageId, "m1");
    assert.equal(JSON.parse(lines[1]).messageId, "m2");

    const index = await readFile(join(root, ".hall", "chat-index.md"), "utf8");
    assert.match(index, /text: 2/);
    assert.match(index, /操作员/);
    assert.match(index, /林纳斯/);
    assert.match(index, /回复 hello/);
  } finally {
    await cleanup(id);
  }
});

test("appendHallBlackboardMessage dedupes by messageId", async () => {
  const id = freshCardId("dedupe");
  try {
    const card = makeCard({ taskCardId: id });
    await initializeHallBlackboard(card);
    const root = resolveHallTaskWorkspacePath(id);

    const msg = makeMessage({ taskCardId: id, messageId: "dup-1" });
    await appendHallBlackboardMessage(id, msg);
    await appendHallBlackboardMessage(id, msg);
    await appendHallBlackboardMessage(id, msg);

    const jsonl = await readFile(join(root, ".hall", "chat.jsonl"), "utf8");
    assert.equal(jsonl.trim().split("\n").length, 1);
  } finally {
    await cleanup(id);
  }
});

test("readHallProgressLatestEntry returns the last agent block body", async () => {
  const id = freshCardId("progress");
  try {
    const card = makeCard({ taskCardId: id });
    await initializeHallBlackboard(card);
    const progressPath = join(resolveHallTaskWorkspacePath(id), "progress.md");

    const original = await readFile(progressPath, "utf8");
    const updated = original
      + "\n<!-- agent: coq, ts: 2026-04-27T00:10:00.000Z -->\nshipped step 1\n<!-- /agent -->\n"
      + "<!-- agent: coq, ts: 2026-04-27T00:20:00.000Z -->\nstep 2 ready for review\n<!-- /agent -->\n";
    await writeFile(progressPath, updated, "utf8");

    const last = await readHallProgressLatestEntry(id);
    assert.equal(last, "step 2 ready for review");
  } finally {
    await cleanup(id);
  }
});

test("appendHallBlackboardMessage strips base64 tool I/O payload from status content", async () => {
  const id = freshCardId("toolpayload");
  try {
    const card = makeCard({ taskCardId: id });
    await initializeHallBlackboard(card);
    const root = resolveHallTaskWorkspacePath(id);

    const fatBase64 = "x".repeat(4000);
    const messySummary = `def fizzbuzz(n: int) -> list[str]:\n    return [\n        "FizzBuzz" if i % 15 == 0 else\n        "Buzz" if i % 5 == 0 else`;
    const status = makeMessage({
      taskCardId: id,
      messageId: "stat-1",
      kind: "status",
      authorParticipantId: "main",
      authorLabel: "Main",
      content:
        `[[tool:web_search|Codex OpenAI 2026, 10|~${fatBase64}]] some trailing text [[tool:read_file|src/foo.ts|~${fatBase64}]] [[tool:write|${messySummary}|~${fatBase64}]]`,
    });

    await appendHallBlackboardMessage(id, status);

    const jsonl = await readFile(join(root, ".hall", "chat.jsonl"), "utf8");
    const lines = jsonl.trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    // tool name + summary preserved, base64 stripped
    assert.match(parsed.content, /\[\[tool:web_search\|Codex OpenAI 2026, 10\]\]/);
    assert.match(parsed.content, /\[\[tool:read_file\|src\/foo\.ts\]\]/);
    assert.match(parsed.content, /some trailing text/);
    // summary that contains `]` and newlines (e.g. code snippets) must still be
    // preserved — the regex anchors on `|~`, not on bracket balance.
    assert.match(parsed.content, /list\[str\]/);
    assert.match(parsed.content, /FizzBuzz/);
    // dropped from kilobytes back to a sane size
    assert.ok(parsed.content.length < 600, `content still large: ${parsed.content.length} chars`);
    // base64 must be gone
    assert.ok(!/\|~x{50,}/.test(parsed.content), "base64 payload still present");
    // original message object must not be mutated in place
    assert.match(status.content, /~xxxx/);
  } finally {
    await cleanup(id);
  }
});

test("renderHallBlackboardPromptGuidance mentions chat.jsonl + the three shared markdowns", () => {
  const guidance = renderHallBlackboardPromptGuidance("card-bb-5", "zh");
  assert.match(guidance, /\.hall\/chat\.jsonl/);
  assert.match(guidance, /task_plan\.md/);
  assert.match(guidance, /findings\.md/);
  assert.match(guidance, /progress\.md/);
  assert.match(guidance, /<!-- agent:/);

  const guidanceEn = renderHallBlackboardPromptGuidance("card-bb-5", "en");
  assert.match(guidanceEn, /\.hall\/chat\.jsonl/);
  assert.match(guidanceEn, /Append only/);
});

import assert from "node:assert/strict";
import test from "node:test";

import { dispatchHallRuntimeTurn } from "../src/runtime/hall-runtime-dispatch";
import { renderHallBlackboardPromptGuidance } from "../src/runtime/hall-blackboard";
import type { HallMessage, HallParticipant, HallTaskCard, CollaborationHall } from "../src/types";

// Captures the `message` prompt sent into agentRun so tests can inspect what
// the agent actually receives.
function makeCapturingClient(): { observedPrompts: string[]; client: unknown } {
  const observedPrompts: string[] = [];
  const client = {
    sessionsHistory: async () => ({ history: [] }),
    agentRun: async (request: { message?: string; sessionKey?: string }) => {
      observedPrompts.push(request.message ?? "");
      return {
        ok: true,
        text: "ack",
        rawText: "",
        sessionKey: request.sessionKey,
      };
    },
  };
  return { observedPrompts, client };
}

const NOW = "2026-04-30T00:00:00.000Z";

function makeCard(overrides: Partial<HallTaskCard> & { taskCardId: string }): HallTaskCard {
  return {
    hallId: "hall",
    taskCardId: overrides.taskCardId,
    projectId: "p3a2-test",
    taskId: "p3a2-task",
    title: "P3-A-2 prompt context test",
    description: "Validate first-vs-subsequent turn prompt shapes.",
    status: "todo",
    createdByParticipantId: "operator",
    blockers: [],
    requiresInputFrom: [],
    mentionedParticipantIds: [],
    plannedExecutionOrder: [],
    plannedExecutionItems: [],
    sessionKeys: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeHall(): CollaborationHall {
  return {
    hallId: "hall",
    participants: [
      { participantId: "linus-dev", agentId: "linus-dev", displayName: "Linus", semanticRole: "coder", aliases: [], active: true } as HallParticipant,
      { participantId: "ada-data-scientist", agentId: "ada-data-scientist", displayName: "Ada", semanticRole: "planner", aliases: [], active: true } as HallParticipant,
      { participantId: "main", agentId: "main", displayName: "Main", semanticRole: "manager", aliases: [], active: true } as HallParticipant,
    ],
    updatedAt: NOW,
  } as CollaborationHall;
}

function makeTrigger(overrides: Partial<HallMessage> & { content: string }): HallMessage {
  return {
    hallId: "hall",
    messageId: "trig-1",
    kind: "task",
    authorParticipantId: "operator",
    authorLabel: "Operator",
    content: overrides.content,
    targetParticipantIds: ["linus-dev"],
    mentionTargets: [],
    projectId: "p3a2-test",
    taskId: "p3a2-task",
    taskCardId: "card-fresh",
    createdAt: NOW,
    ...overrides,
  } as HallMessage;
}

test("first turn prompt includes setup sections (identity, group-chat awareness, blackboard, roster, hall rules)", async () => {
  const { observedPrompts, client } = makeCapturingClient();
  const hall = makeHall();
  const card = makeCard({ taskCardId: "card-first" });
  const trigger = makeTrigger({ content: "@林纳斯 用一句话讲 idempotent。" });

  await dispatchHallRuntimeTurn({
    client: client as never,
    hall,
    taskCard: card,
    participant: hall.participants[0],
    triggerMessage: trigger,
    mode: "execution",
    note: trigger.content,
  });

  assert.equal(observedPrompts.length, 1);
  const prompt = observedPrompts[0];

  // Identity / group-chat awareness — must explicitly tell agent that other
  // people speak silently in the same thread.
  assert.match(prompt, /You are Linus/);
  assert.match(prompt, /Other agents speak in this same thread without @-ing you/);
  assert.match(prompt, /\.hall\/chat\.jsonl/);

  // Thread topic + description preserved
  assert.match(prompt, /Thread topic:/);
  assert.match(prompt, /Validate first-vs-subsequent turn prompt shapes/);

  // Blackboard guidance / 群聊意识 block
  assert.match(prompt, /\[群聊意识|Group-chat awareness/);
  assert.match(prompt, /tail -n 20 \.hall\/chat\.jsonl/);

  // Trigger renders with author attribution
  assert.match(prompt, /\[from: Operator\]|\[来自 Operator\]/);
  assert.match(prompt, /idempotent/);

  // First-turn guard line still present
  assert.match(prompt, /first reply in this thread/);
});

test("first turn prompt does NOT inline a 'recent N messages' transcript", async () => {
  const { observedPrompts, client } = makeCapturingClient();
  const hall = makeHall();
  const card = makeCard({ taskCardId: "card-no-transcript" });
  const trigger = makeTrigger({ content: "@林纳斯 hi" });

  await dispatchHallRuntimeTurn({
    client: client as never,
    hall,
    taskCard: card,
    participant: hall.participants[0],
    triggerMessage: trigger,
    recentThreadMessages: [
      { ...trigger, messageId: "m-old-1", content: "Old message 1 from operator" } as HallMessage,
      { ...trigger, messageId: "m-old-2", content: "Old message 2 from operator", authorLabel: "Linus" } as HallMessage,
      { ...trigger, messageId: "m-old-3", content: "Old message 3 from operator", authorLabel: "Ada" } as HallMessage,
    ],
    mode: "execution",
    note: trigger.content,
  });

  const prompt = observedPrompts[0];
  // No "Recent N messages from this thread" header — that section is gone.
  assert.ok(!/Recent \d+ messages from this thread/.test(prompt), "should not render recent-N transcript");
  assert.ok(!/最近 \d+ 条对话/.test(prompt), "should not render 中文版 transcript");
  // Stale messages should NOT appear in prompt; agent must grep blackboard.
  assert.ok(!prompt.includes("Old message 1"), "stale recent thread messages must not be inlined");
  assert.ok(!prompt.includes("Old message 2"), "stale recent thread messages must not be inlined");
  assert.ok(!prompt.includes("Old message 3"), "stale recent thread messages must not be inlined");
});

test("subsequent turn prompt is minimal: trigger with author attribution only, no setup re-sent", async () => {
  const { observedPrompts, client } = makeCapturingClient();
  const hall = makeHall();
  // card.sessionKeys carries the agent's session key → not first turn anymore
  const card = makeCard({
    taskCardId: "card-subsequent",
    sessionKeys: ["agent:linus-dev:hall:p3a2-task"],
  });
  const trigger = makeTrigger({
    content: "follow-up: 现在举个软件开发的例子",
    messageId: "trig-2",
    authorParticipantId: "turing-pm",
    authorLabel: "图灵 Turing (PM)",
  });

  await dispatchHallRuntimeTurn({
    client: client as never,
    hall,
    taskCard: card,
    participant: hall.participants[0],
    triggerMessage: trigger,
    mode: "execution",
    note: trigger.content,
  });

  const prompt = observedPrompts[0];

  // Setup sections must NOT appear (agent already has them in session memory)
  assert.ok(!/You are Linus/.test(prompt), "subsequent turn must not re-send identity");
  assert.ok(!/group chat called the Collaboration Hall/.test(prompt), "no hall framing");
  assert.ok(!/\[群聊意识|Group-chat awareness/.test(prompt), "no blackboard guidance re-sent");
  assert.ok(!/Reply like a real coworker/.test(prompt), "no behavioral instructions re-sent");
  assert.ok(!/Thread topic:/.test(prompt), "no thread topic re-sent");

  // Must include trigger with author attribution + content
  assert.match(prompt, /\[from: 图灵 Turing \(PM\)\]|\[来自 图灵 Turing \(PM\)\]/);
  assert.match(prompt, /现在举个软件开发的例子/);

  // Subsequent turn prompts should be small — sanity check, well under 2KB
  assert.ok(prompt.length < 2000, `subsequent turn prompt too large: ${prompt.length} chars`);
});

test("subsequent turn includes A1 originalAssigner hint when applicable", async () => {
  const { observedPrompts, client } = makeCapturingClient();
  const hall = makeHall();
  const card = makeCard({
    taskCardId: "card-a1",
    sessionKeys: ["agent:linus-dev:hall:p3a2-task"],
    originalAssignerParticipantId: "operator",
  });
  const trigger = makeTrigger({
    content: "@林纳斯 keep going",
    authorParticipantId: "ada-data-scientist",
    authorLabel: "Ada",
  });

  await dispatchHallRuntimeTurn({
    client: client as never,
    hall,
    taskCard: card,
    participant: hall.participants[0],
    triggerMessage: trigger,
    mode: "execution",
    note: trigger.content,
  });

  const prompt = observedPrompts[0];
  // A1 hint should appear as a one-liner prefixed before the trigger
  assert.match(prompt, /\[note\]/);
  assert.match(prompt, /Operator|@Operator|Operator（操作员）/);
});

test("subsequent turn omits A1 hint when assigner == self (no self-ping)", async () => {
  const { observedPrompts, client } = makeCapturingClient();
  const hall = makeHall();
  const card = makeCard({
    taskCardId: "card-a1-self",
    sessionKeys: ["agent:linus-dev:hall:p3a2-task"],
    originalAssignerParticipantId: "linus-dev",
  });

  await dispatchHallRuntimeTurn({
    client: client as never,
    hall,
    taskCard: card,
    participant: hall.participants[0],
    triggerMessage: makeTrigger({ content: "ping" }),
    mode: "execution",
    note: "ping",
  });

  const prompt = observedPrompts[0];
  // No A1 [note] line because assigner is self
  assert.ok(!prompt.includes("[note]"), "should not include A1 hint when assigner is self");
});

test("trigger without triggerMessage (observer / wake) still renders cleanly", async () => {
  const { observedPrompts, client } = makeCapturingClient();
  const hall = makeHall();
  const card = makeCard({
    taskCardId: "card-no-trigger-msg",
    sessionKeys: ["agent:main:hall:p3a2-task"],
  });

  await dispatchHallRuntimeTurn({
    client: client as never,
    hall,
    taskCard: card,
    participant: hall.participants[2], // main
    // no triggerMessage — observer style
    mode: "execution",
    note: "[mode: observer]\nTail .hall/chat.jsonl, decide if useful.",
  });

  const prompt = observedPrompts[0];
  assert.match(prompt, /\[mode: observer\]/);
  assert.match(prompt, /Tail \.hall\/chat\.jsonl/);
});

test("renderHallBlackboardPromptGuidance has strong group-chat awareness", () => {
  const zh = renderHallBlackboardPromptGuidance("card-guidance", "zh");
  // Must explicitly tell agent that they don't see what others say
  assert.match(zh, /唤醒之间.*其他人.*说话.*不会出现在你的 prompt 里/s);
  // Must show concrete bash invocations
  assert.match(zh, /tail -n 20 \.hall\/chat\.jsonl/);
  assert.match(zh, /grep.*authorLabel/);

  const en = renderHallBlackboardPromptGuidance("card-guidance", "en");
  assert.match(en, /Between dispatches.*other agents keep talking.*do NOT appear in your prompts/si);
  assert.match(en, /tail -n 20 \.hall\/chat\.jsonl/);
});

test("token footprint: subsequent turn ≪ first turn (validates main P3-A-2 win)", async () => {
  const { observedPrompts, client } = makeCapturingClient();
  const hall = makeHall();

  // First turn
  const cardFirst = makeCard({ taskCardId: "card-tok-first" });
  await dispatchHallRuntimeTurn({
    client: client as never,
    hall,
    taskCard: cardFirst,
    participant: hall.participants[0],
    triggerMessage: makeTrigger({ content: "first-turn message" }),
    mode: "execution",
    note: "first-turn message",
  });

  // Subsequent turn
  const cardSubs = makeCard({
    taskCardId: "card-tok-subs",
    sessionKeys: ["agent:linus-dev:hall:p3a2-task"],
  });
  await dispatchHallRuntimeTurn({
    client: client as never,
    hall,
    taskCard: cardSubs,
    participant: hall.participants[0],
    triggerMessage: makeTrigger({ content: "subsequent-turn message" }),
    mode: "execution",
    note: "subsequent-turn message",
  });

  const [firstTurn, subsTurn] = observedPrompts;
  // Subsequent turn must be at least an order of magnitude smaller
  assert.ok(
    subsTurn.length * 8 < firstTurn.length,
    `subsequent (${subsTurn.length} chars) should be ≪ first (${firstTurn.length}); ratio ${(firstTurn.length / Math.max(1, subsTurn.length)).toFixed(1)}x`,
  );
});

test("subsequent turn renders multi-trigger batch with attribution per trigger (P3-B-2 merge)", async () => {
  const { observedPrompts, client } = makeCapturingClient();
  const hall = makeHall();
  const card = makeCard({
    taskCardId: "card-multi-trigger",
    sessionKeys: ["agent:linus-dev:hall:p3a2-task"],
  });
  const trigger1 = makeTrigger({
    messageId: "t-1",
    content: "@林纳斯 用一句话讲 idempotent",
    authorParticipantId: "operator",
    authorLabel: "Operator",
  });
  const trigger2 = makeTrigger({
    messageId: "t-2",
    content: "@林纳斯 顺便举个软件开发的例子",
    authorParticipantId: "turing-pm",
    authorLabel: "图灵 Turing (PM)",
  });

  await dispatchHallRuntimeTurn({
    client: client as never,
    hall,
    taskCard: card,
    participant: hall.participants[0],
    triggerMessage: trigger2, // primary = latest
    triggerMessages: [trigger1, trigger2],
    mode: "execution",
  });

  const prompt = observedPrompts[0];
  // Multi-trigger header
  assert.match(prompt, /在短时间内你被多次 @|@-mentioned \d+ times in quick succession/);
  // Both authors attributed
  assert.match(prompt, /\[来自 Operator\]|\[from: Operator\]/);
  assert.match(prompt, /\[来自 图灵 Turing \(PM\)\]|\[from: 图灵 Turing \(PM\)\]/);
  // Both bodies present
  assert.match(prompt, /用一句话讲 idempotent/);
  assert.match(prompt, /举个软件开发的例子/);
  // Setup sections still NOT re-sent (subsequent turn)
  assert.ok(!/You are Linus/.test(prompt));
  assert.ok(!/Group-chat awareness|群聊意识/.test(prompt));
});

test("single-trigger rendering unchanged when triggerMessages has length 1", async () => {
  const { observedPrompts, client } = makeCapturingClient();
  const hall = makeHall();
  const card = makeCard({
    taskCardId: "card-single-trigger",
    sessionKeys: ["agent:linus-dev:hall:p3a2-task"],
  });
  const trigger = makeTrigger({ content: "hi linus", authorLabel: "Operator" });

  await dispatchHallRuntimeTurn({
    client: client as never,
    hall,
    taskCard: card,
    participant: hall.participants[0],
    triggerMessage: trigger,
    triggerMessages: [trigger],
    mode: "execution",
  });

  const prompt = observedPrompts[0];
  // No "multi-trigger header" when there's only one
  assert.ok(!/在短时间内你被多次 @|@-mentioned \d+ times in quick succession/.test(prompt));
  // Standard single attribution still works
  assert.match(prompt, /\[来自 Operator\]|\[from: Operator\]/);
  assert.match(prompt, /hi linus/);
});

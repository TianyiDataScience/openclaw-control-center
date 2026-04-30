import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_ROUND_BLOCK_THRESHOLD,
  DROP_RESOLVED_OVERLAP_THRESHOLD,
  HALL_BACK_PING_BUDGET,
  HALL_CHAIN_FILTER_POLICIES,
  HALL_DEFAULT_POST_DISPATCH_POLICIES,
  HALL_PER_TARGET_GATE_POLICIES,
  MAX_AUTO_CHAIN_DEPTH,
  OBSERVE_SILENT_MARKER,
  POLICY_DETECT_CLARIFYING_QUESTION,
  POLICY_DROP_RESOLVED_TRIGGERS,
  POLICY_ENFORCE_AUTO_ROUND_LIMIT,
  POLICY_ENFORCE_BACK_PING_BUDGET,
  POLICY_ENFORCE_MAX_AUTO_CHAIN_DEPTH,
  POLICY_EXCLUDE_TRIGGER_AUTHOR,
  POLICY_OBSERVE_SILENT_MARKER,
  buildOperatorTurnStatePatch,
  detectClarifyingQuestion,
  dropResolvedTriggers,
  enforceAutoRoundLimit,
  enforceBackPingBudget,
  enforceMaxAutoChainDepth,
  excludeTriggerAuthor,
  incrementAutoRoundCounter,
  observeSilentMarker,
  runPostDispatchPolicies,
  runPreDispatchPolicies,
  type PostDispatchPolicy,
  type PreDispatchPolicy,
  type PreDispatchPolicyInput,
} from "../src/runtime/hall-policies";
import type {
  CollaborationHall,
  HallMessage,
  HallParticipant,
  HallTaskCard,
} from "../src/types";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeHall(): CollaborationHall {
  return {
    hallId: "hall-1",
    name: "Test Hall",
    participants: [],
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
  };
}

function makeParticipant(overrides: Partial<HallParticipant> = {}): HallParticipant {
  return {
    participantId: "p-linus",
    displayName: "林纳斯",
    agentId: "linus",
    active: true,
    ...overrides,
  };
}

function makeTaskCard(overrides: Partial<HallTaskCard> = {}): HallTaskCard {
  return {
    taskCardId: "card-1",
    hallId: "hall-1",
    projectId: "p1",
    taskId: "t1",
    title: "x",
    description: "y",
    status: "open",
    mentionedParticipantIds: [],
    plannedExecutionOrder: [],
    createdByParticipantId: "operator",
    createdAt: "2026-04-30T00:00:00Z",
    updatedAt: "2026-04-30T00:00:00Z",
    ...overrides,
  };
}

function makeInput(overrides: Partial<PreDispatchPolicyInput> = {}): PreDispatchPolicyInput {
  return {
    hall: makeHall(),
    taskCard: makeTaskCard(),
    participant: makeParticipant(),
    chainDepth: 0,
    enqueueReason: "operator-route",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test("constants match pre-refactor values", () => {
  assert.equal(OBSERVE_SILENT_MARKER, "OBSERVE_SILENT");
  assert.equal(MAX_AUTO_CHAIN_DEPTH, 5);
  assert.equal(AUTO_ROUND_BLOCK_THRESHOLD, 6);
});

// ---------------------------------------------------------------------------
// enforceAutoRoundLimit (A2)
// ---------------------------------------------------------------------------

test("enforceAutoRoundLimit allows when counter is below threshold", () => {
  const verdict = enforceAutoRoundLimit(makeInput({
    taskCard: makeTaskCard({ autoRoundsByAgent: { linus: AUTO_ROUND_BLOCK_THRESHOLD - 1 } }),
  }));
  assert.equal(verdict.kind, "allow");
});

test("enforceAutoRoundLimit denies when counter has reached threshold", () => {
  const verdict = enforceAutoRoundLimit(makeInput({
    taskCard: makeTaskCard({ autoRoundsByAgent: { linus: AUTO_ROUND_BLOCK_THRESHOLD } }),
  }));
  assert.equal(verdict.kind, "deny");
  if (verdict.kind === "deny") {
    assert.equal(verdict.policyId, POLICY_ENFORCE_AUTO_ROUND_LIMIT);
    assert.match(verdict.reason, /6 >= 6/);
  }
});

test("enforceAutoRoundLimit denies when counter exceeds threshold", () => {
  const verdict = enforceAutoRoundLimit(makeInput({
    taskCard: makeTaskCard({ autoRoundsByAgent: { linus: AUTO_ROUND_BLOCK_THRESHOLD + 4 } }),
  }));
  assert.equal(verdict.kind, "deny");
});

test("enforceAutoRoundLimit allows when no counter exists for the agent", () => {
  const verdict = enforceAutoRoundLimit(makeInput({
    taskCard: makeTaskCard({ autoRoundsByAgent: { ada: 99 } }),
  }));
  assert.equal(verdict.kind, "allow");
});

test("enforceAutoRoundLimit allows when participant has no agentId or participantId", () => {
  const verdict = enforceAutoRoundLimit(makeInput({
    participant: makeParticipant({ agentId: "", participantId: "" }),
    taskCard: makeTaskCard({ autoRoundsByAgent: { linus: 99 } }),
  }));
  assert.equal(verdict.kind, "allow");
});

test("enforceAutoRoundLimit prefers agentId over participantId for the counter key", () => {
  const verdict = enforceAutoRoundLimit(makeInput({
    participant: makeParticipant({ participantId: "p-linus", agentId: "linus" }),
    taskCard: makeTaskCard({
      autoRoundsByAgent: {
        linus: AUTO_ROUND_BLOCK_THRESHOLD,
        "p-linus": 0,
      },
    }),
  }));
  assert.equal(verdict.kind, "deny");
});

// ---------------------------------------------------------------------------
// enforceMaxAutoChainDepth
// ---------------------------------------------------------------------------

test("enforceMaxAutoChainDepth allows depth 0 (operator-route primary)", () => {
  const verdict = enforceMaxAutoChainDepth(makeInput({ chainDepth: 0 }));
  assert.equal(verdict.kind, "allow");
});

test("enforceMaxAutoChainDepth allows depth equal to MAX (last allowed)", () => {
  const verdict = enforceMaxAutoChainDepth(makeInput({ chainDepth: MAX_AUTO_CHAIN_DEPTH }));
  assert.equal(verdict.kind, "allow");
});

test("enforceMaxAutoChainDepth denies depth above MAX", () => {
  const verdict = enforceMaxAutoChainDepth(makeInput({ chainDepth: MAX_AUTO_CHAIN_DEPTH + 1 }));
  assert.equal(verdict.kind, "deny");
  if (verdict.kind === "deny") {
    assert.equal(verdict.policyId, POLICY_ENFORCE_MAX_AUTO_CHAIN_DEPTH);
  }
});

// ---------------------------------------------------------------------------
// excludeTriggerAuthor (A3)
// ---------------------------------------------------------------------------

test("excludeTriggerAuthor denies when candidate equals trigger author", () => {
  const verdict = excludeTriggerAuthor(makeInput({
    participant: makeParticipant({ participantId: "p-turing" }),
    triggerAuthorParticipantId: "p-turing",
  }));
  assert.equal(verdict.kind, "deny");
  if (verdict.kind === "deny") {
    assert.equal(verdict.policyId, POLICY_EXCLUDE_TRIGGER_AUTHOR);
  }
});

test("excludeTriggerAuthor allows when candidate differs from trigger author", () => {
  const verdict = excludeTriggerAuthor(makeInput({
    participant: makeParticipant({ participantId: "p-linus" }),
    triggerAuthorParticipantId: "p-turing",
  }));
  assert.equal(verdict.kind, "allow");
});

test("excludeTriggerAuthor allows when no trigger author is given", () => {
  const verdict = excludeTriggerAuthor(makeInput({
    participant: makeParticipant({ participantId: "p-linus" }),
    triggerAuthorParticipantId: undefined,
  }));
  assert.equal(verdict.kind, "allow");
});

// ---------------------------------------------------------------------------
// observeSilentMarker (A4)
// ---------------------------------------------------------------------------

test("observeSilentMarker keeps a real reply", () => {
  const verdict = observeSilentMarker({
    hall: makeHall(),
    taskCard: makeTaskCard(),
    participant: makeParticipant(),
    replyContent: "Sure, here's how to do it...",
    enqueueReason: "auto-chain",
  });
  assert.equal(verdict.kind, "keep");
});

test("observeSilentMarker drops an empty reply", () => {
  const verdict = observeSilentMarker({
    hall: makeHall(),
    taskCard: makeTaskCard(),
    participant: makeParticipant(),
    replyContent: "   \n\t  ",
    enqueueReason: "auto-chain",
  });
  assert.equal(verdict.kind, "drop");
  if (verdict.kind === "drop") {
    assert.equal(verdict.policyId, POLICY_OBSERVE_SILENT_MARKER);
    assert.match(verdict.reason, /empty/);
  }
});

test("observeSilentMarker drops a reply that exactly matches the marker", () => {
  const verdict = observeSilentMarker({
    hall: makeHall(),
    taskCard: makeTaskCard(),
    participant: makeParticipant(),
    replyContent: OBSERVE_SILENT_MARKER,
    enqueueReason: "main-observer",
  });
  assert.equal(verdict.kind, "drop");
});

test("observeSilentMarker drops a reply that starts with the marker (extra commentary trailing)", () => {
  const verdict = observeSilentMarker({
    hall: makeHall(),
    taskCard: makeTaskCard(),
    participant: makeParticipant(),
    replyContent: `${OBSERVE_SILENT_MARKER}\n(observer had nothing to add)`,
    enqueueReason: "main-observer",
  });
  assert.equal(verdict.kind, "drop");
});

// ---------------------------------------------------------------------------
// Chain runners
// ---------------------------------------------------------------------------

test("runPreDispatchPolicies returns allow for an empty chain", () => {
  const verdict = runPreDispatchPolicies([], makeInput());
  assert.equal(verdict.kind, "allow");
});

test("runPreDispatchPolicies short-circuits at the first deny", () => {
  const calls: string[] = [];
  const policyA: PreDispatchPolicy = () => { calls.push("a"); return { kind: "allow" }; };
  const policyB: PreDispatchPolicy = () => { calls.push("b"); return { kind: "deny", policyId: "b", reason: "stop" }; };
  const policyC: PreDispatchPolicy = () => { calls.push("c"); return { kind: "allow" }; };

  const verdict = runPreDispatchPolicies([policyA, policyB, policyC], makeInput());
  assert.equal(verdict.kind, "deny");
  if (verdict.kind === "deny") assert.equal(verdict.policyId, "b");
  // C must not have run
  assert.deepEqual(calls, ["a", "b"]);
});

test("runPostDispatchPolicies returns keep for an empty chain", () => {
  const verdict = runPostDispatchPolicies([], {
    hall: makeHall(),
    taskCard: makeTaskCard(),
    participant: makeParticipant(),
    replyContent: "hi",
    enqueueReason: "auto-chain",
  });
  assert.equal(verdict.kind, "keep");
});

test("runPostDispatchPolicies short-circuits at the first drop", () => {
  const calls: string[] = [];
  const policyA: PostDispatchPolicy = () => { calls.push("a"); return { kind: "keep" }; };
  const policyB: PostDispatchPolicy = () => { calls.push("b"); return { kind: "drop", policyId: "b", reason: "drop" }; };
  const policyC: PostDispatchPolicy = () => { calls.push("c"); return { kind: "keep" }; };

  const verdict = runPostDispatchPolicies([policyA, policyB, policyC], {
    hall: makeHall(),
    taskCard: makeTaskCard(),
    participant: makeParticipant(),
    replyContent: "anything",
    enqueueReason: "auto-chain",
  });
  assert.equal(verdict.kind, "drop");
  assert.deepEqual(calls, ["a", "b"]);
});

// ---------------------------------------------------------------------------
// Default chain compositions
// ---------------------------------------------------------------------------

test("HALL_PER_TARGET_GATE_POLICIES enforces A2 first (so the auto-round-blocked side-effect fires)", () => {
  // Counter at threshold + candidate would also be excluded by A3 — A2 must fire first.
  const verdict = runPreDispatchPolicies(HALL_PER_TARGET_GATE_POLICIES, {
    hall: makeHall(),
    taskCard: makeTaskCard({ autoRoundsByAgent: { linus: AUTO_ROUND_BLOCK_THRESHOLD } }),
    participant: makeParticipant({ participantId: "p-linus" }),
    triggerMessage: undefined,
    triggerAuthorParticipantId: "p-linus", // would also trigger A3
    chainDepth: 99,                         // would also trigger max-depth
    enqueueReason: "auto-chain",
  });
  assert.equal(verdict.kind, "deny");
  if (verdict.kind === "deny") {
    assert.equal(verdict.policyId, POLICY_ENFORCE_AUTO_ROUND_LIMIT);
  }
});

test("HALL_CHAIN_FILTER_POLICIES denies a chain candidate at depth above MAX", () => {
  const verdict = runPreDispatchPolicies(HALL_CHAIN_FILTER_POLICIES, makeInput({
    chainDepth: MAX_AUTO_CHAIN_DEPTH + 1,
  }));
  assert.equal(verdict.kind, "deny");
});

test("HALL_CHAIN_FILTER_POLICIES denies a chain candidate equal to the trigger author", () => {
  const verdict = runPreDispatchPolicies(HALL_CHAIN_FILTER_POLICIES, makeInput({
    participant: makeParticipant({ participantId: "p-turing" }),
    triggerAuthorParticipantId: "p-turing",
    chainDepth: 1,
  }));
  assert.equal(verdict.kind, "deny");
  if (verdict.kind === "deny") assert.equal(verdict.policyId, POLICY_EXCLUDE_TRIGGER_AUTHOR);
});

test("HALL_CHAIN_FILTER_POLICIES allows a normal candidate at moderate depth", () => {
  const verdict = runPreDispatchPolicies(HALL_CHAIN_FILTER_POLICIES, makeInput({
    participant: makeParticipant({ participantId: "p-ada" }),
    triggerAuthorParticipantId: "p-turing",
    chainDepth: 2,
  }));
  assert.equal(verdict.kind, "allow");
});

test("HALL_DEFAULT_POST_DISPATCH_POLICIES drops OBSERVE_SILENT replies", () => {
  const verdict = runPostDispatchPolicies(HALL_DEFAULT_POST_DISPATCH_POLICIES, {
    hall: makeHall(),
    taskCard: makeTaskCard(),
    participant: makeParticipant(),
    replyContent: OBSERVE_SILENT_MARKER,
    enqueueReason: "main-observer",
  });
  assert.equal(verdict.kind, "drop");
});

test("HALL_DEFAULT_POST_DISPATCH_POLICIES keeps a substantive reply", () => {
  const verdict = runPostDispatchPolicies(HALL_DEFAULT_POST_DISPATCH_POLICIES, {
    hall: makeHall(),
    taskCard: makeTaskCard(),
    participant: makeParticipant(),
    replyContent: "Here's what I found in the logs.",
    enqueueReason: "main-observer",
  });
  assert.equal(verdict.kind, "keep");
});

// ---------------------------------------------------------------------------
// State helpers: buildOperatorTurnStatePatch (A1 + A2-reset)
// ---------------------------------------------------------------------------

test("buildOperatorTurnStatePatch seeds originalAssigner when missing", () => {
  const patch = buildOperatorTurnStatePatch(
    makeTaskCard({ originalAssignerParticipantId: undefined }),
    "operator",
  );
  assert.notEqual(patch, null);
  assert.equal(patch?.originalAssignerParticipantId, "operator");
});

test("buildOperatorTurnStatePatch resets non-empty autoRoundsByAgent", () => {
  const patch = buildOperatorTurnStatePatch(
    makeTaskCard({
      originalAssignerParticipantId: "operator",
      autoRoundsByAgent: { linus: 2 },
    }),
    "operator",
  );
  assert.notEqual(patch, null);
  assert.deepEqual(patch?.autoRoundsByAgent, {});
});

test("buildOperatorTurnStatePatch returns null when nothing to change", () => {
  const patch = buildOperatorTurnStatePatch(
    makeTaskCard({
      originalAssignerParticipantId: "operator",
      autoRoundsByAgent: {},
    }),
    "operator",
  );
  assert.equal(patch, null);
});

test("buildOperatorTurnStatePatch does not seed originalAssigner when triggerAuthor is undefined", () => {
  const patch = buildOperatorTurnStatePatch(
    makeTaskCard({ originalAssignerParticipantId: undefined }),
    undefined,
  );
  assert.equal(patch, null);
});

test("buildOperatorTurnStatePatch does not overwrite existing originalAssigner", () => {
  const patch = buildOperatorTurnStatePatch(
    makeTaskCard({ originalAssignerParticipantId: "p-original-human" }),
    "p-other-human",
  );
  assert.equal(patch, null);
});

// ---------------------------------------------------------------------------
// State helpers: incrementAutoRoundCounter
// ---------------------------------------------------------------------------

test("incrementAutoRoundCounter bumps the agent counter and preserves others", () => {
  const { agentKey, rounds } = incrementAutoRoundCounter(
    makeTaskCard({ autoRoundsByAgent: { linus: 2, ada: 1 } }),
    makeParticipant({ agentId: "linus" }),
  );
  assert.equal(agentKey, "linus");
  assert.deepEqual(rounds, { linus: 3, ada: 1 });
});

test("incrementAutoRoundCounter starts the counter at 1 when absent", () => {
  const { agentKey, rounds } = incrementAutoRoundCounter(
    makeTaskCard({ autoRoundsByAgent: {} }),
    makeParticipant({ agentId: "linus" }),
  );
  assert.equal(agentKey, "linus");
  assert.deepEqual(rounds, { linus: 1 });
});

test("incrementAutoRoundCounter falls back to participantId when agentId is undefined (?? fallback)", () => {
  // Pre-refactor used `participant.agentId ?? participant.participantId`, which
  // is nullish coalescing — empty-string agentId is kept (not treated as a
  // miss), but undefined agentId falls back to participantId. Preserve that.
  const { agentKey } = incrementAutoRoundCounter(
    makeTaskCard(),
    makeParticipant({ agentId: undefined, participantId: "p-linus" }),
  );
  assert.equal(agentKey, "p-linus");
});

test("incrementAutoRoundCounter returns null when agentId is explicit empty string (??-fallback NOT triggered)", () => {
  const { agentKey, rounds } = incrementAutoRoundCounter(
    makeTaskCard({ autoRoundsByAgent: {} }),
    makeParticipant({ agentId: "", participantId: "p-linus" }),
  );
  assert.equal(agentKey, null);
  assert.deepEqual(rounds, {});
});

test("incrementAutoRoundCounter returns agentKey=null when both ids are empty", () => {
  const { agentKey, rounds } = incrementAutoRoundCounter(
    makeTaskCard({ autoRoundsByAgent: { existing: 5 } }),
    makeParticipant({ agentId: "", participantId: "" }),
  );
  assert.equal(agentKey, null);
  // Existing counters preserved, no increment for the empty key.
  assert.deepEqual(rounds, { existing: 5 });
});

test("incrementAutoRoundCounter does not mutate the original taskCard", () => {
  const original = makeTaskCard({ autoRoundsByAgent: { linus: 2 } });
  const snapshot = JSON.stringify(original.autoRoundsByAgent);
  incrementAutoRoundCounter(original, makeParticipant({ agentId: "linus" }));
  assert.equal(JSON.stringify(original.autoRoundsByAgent), snapshot);
});

// ===========================================================================
// P3-C-2 — chain runner force-allow short-circuit
// ===========================================================================

test("runPreDispatchPolicies short-circuits on force-allow (overrides downstream deny)", () => {
  const calls: string[] = [];
  const policyA: PreDispatchPolicy = () => { calls.push("a"); return { kind: "allow" }; };
  const policyB: PreDispatchPolicy = () => { calls.push("b"); return { kind: "force-allow", policyId: "b", reason: "force" }; };
  const policyC: PreDispatchPolicy = () => { calls.push("c"); return { kind: "deny", policyId: "c", reason: "would deny" }; };

  const verdict = runPreDispatchPolicies([policyA, policyB, policyC], makeInput());
  assert.equal(verdict.kind, "force-allow");
  if (verdict.kind === "force-allow") assert.equal(verdict.policyId, "b");
  // C must not have run — force-allow short-circuits like deny
  assert.deepEqual(calls, ["a", "b"]);
});

test("runPreDispatchPolicies returns allow when chain ends without any short-circuit", () => {
  const policies: PreDispatchPolicy[] = [
    () => ({ kind: "allow" }),
    () => ({ kind: "allow" }),
  ];
  const verdict = runPreDispatchPolicies(policies, makeInput());
  assert.equal(verdict.kind, "allow");
});

// ===========================================================================
// P3-C-2 — detectClarifyingQuestion
// ===========================================================================

function makeMessage(overrides: Partial<HallMessage> = {}): HallMessage {
  return {
    hallId: "hall-1",
    messageId: `m-${Math.random().toString(36).slice(2, 8)}`,
    kind: "agent",
    authorParticipantId: "p-turing",
    authorLabel: "图灵 Turing",
    content: "",
    targetParticipantIds: [],
    mentionTargets: [],
    createdAt: "2026-04-30T00:00:00Z",
    ...overrides,
  };
}

test("detectClarifyingQuestion force-allows on ASCII question mark", () => {
  const verdict = detectClarifyingQuestion(makeInput({
    triggerMessage: makeMessage({ content: "@林纳斯 do you mean INNER JOIN?" }),
  }));
  assert.equal(verdict.kind, "force-allow");
  if (verdict.kind === "force-allow") assert.equal(verdict.policyId, POLICY_DETECT_CLARIFYING_QUESTION);
});

test("detectClarifyingQuestion force-allows on CJK question mark", () => {
  const verdict = detectClarifyingQuestion(makeInput({
    triggerMessage: makeMessage({ content: "@林纳斯 这里要不要做缓存？" }),
  }));
  assert.equal(verdict.kind, "force-allow");
});

test("detectClarifyingQuestion force-allows on CJK 吗 ending", () => {
  const verdict = detectClarifyingQuestion(makeInput({
    triggerMessage: makeMessage({ content: "@林纳斯 你确认要这样改吗" }),
  }));
  assert.equal(verdict.kind, "force-allow");
});

test("detectClarifyingQuestion force-allows on CJK A-还是-B pattern", () => {
  const verdict = detectClarifyingQuestion(makeInput({
    triggerMessage: makeMessage({ content: "@林纳斯 INNER JOIN 还是 LEFT JOIN" }),
  }));
  assert.equal(verdict.kind, "force-allow");
});

test("detectClarifyingQuestion force-allows on English interrogative lead", () => {
  const verdict = detectClarifyingQuestion(makeInput({
    triggerMessage: makeMessage({ content: "How would you handle the migration window" }),
  }));
  assert.equal(verdict.kind, "force-allow");
});

test("detectClarifyingQuestion force-allows on clarification phrase", () => {
  const verdict = detectClarifyingQuestion(makeInput({
    triggerMessage: makeMessage({ content: "Just to be sure, the timeout is 30s right" }),
  }));
  assert.equal(verdict.kind, "force-allow");
});

test("detectClarifyingQuestion force-allows on CJK clarification verb", () => {
  const verdict = detectClarifyingQuestion(makeInput({
    triggerMessage: makeMessage({ content: "想澄清一下你的方案" }),
  }));
  assert.equal(verdict.kind, "force-allow");
});

test("detectClarifyingQuestion allows (no force) on a plain assertion", () => {
  const verdict = detectClarifyingQuestion(makeInput({
    triggerMessage: makeMessage({ content: "我已经把 idempotent 的例子写好了。" }),
  }));
  assert.equal(verdict.kind, "allow");
});

test("detectClarifyingQuestion allows when triggerMessage is missing", () => {
  const verdict = detectClarifyingQuestion(makeInput({ triggerMessage: undefined }));
  assert.equal(verdict.kind, "allow");
});

test("detectClarifyingQuestion allows on empty trigger content", () => {
  const verdict = detectClarifyingQuestion(makeInput({
    triggerMessage: makeMessage({ content: "   \n  " }),
  }));
  assert.equal(verdict.kind, "allow");
});

// ===========================================================================
// P3-C-2 — dropResolvedTriggers
// ===========================================================================

test("dropResolvedTriggers always allows on operator-route enqueue (operator intent is authoritative)", () => {
  // Even if the candidate's recent reply heavily overlaps the trigger, an
  // operator-route trigger is allowed through — operators issue authoritative
  // follow-ups that should always dispatch.
  const verdict = dropResolvedTriggers(makeInput({
    enqueueReason: "operator-route",
    triggerMessage: makeMessage({ content: "@林纳斯 idempotent 例子 软件开发" }),
    recentThreadMessages: [
      makeMessage({
        authorParticipantId: "p-linus",
        content: "idempotent 是说软件开发里同样输入产生同样输出的例子",
      }),
    ],
  }));
  assert.equal(verdict.kind, "allow");
});

test("dropResolvedTriggers denies an auto-chain trigger redundantly covered by candidate's last reply", () => {
  const verdict = dropResolvedTriggers(makeInput({
    enqueueReason: "auto-chain",
    participant: makeParticipant({ participantId: "p-linus", displayName: "林纳斯", agentId: "linus" }),
    triggerMessage: makeMessage({
      authorParticipantId: "p-turing",
      content: "@林纳斯 举一个软件开发里的 idempotent 例子",
    }),
    recentThreadMessages: [
      makeMessage({
        authorParticipantId: "p-linus",
        content: "idempotent 在软件开发里很常见，比如 PUT request——同样的请求重复发送也是一样的结果，就是一个 idempotent 例子。",
      }),
    ],
  }));
  assert.equal(verdict.kind, "deny");
  if (verdict.kind === "deny") {
    assert.equal(verdict.policyId, POLICY_DROP_RESOLVED_TRIGGERS);
    assert.match(verdict.reason, /overlaps/);
  }
});

test("dropResolvedTriggers allows when trigger is on a different topic from candidate's last reply", () => {
  const verdict = dropResolvedTriggers(makeInput({
    enqueueReason: "auto-chain",
    participant: makeParticipant({ participantId: "p-linus" }),
    triggerMessage: makeMessage({
      content: "@林纳斯 endpoint 延迟 多少 毫秒",
    }),
    recentThreadMessages: [
      makeMessage({
        authorParticipantId: "p-linus",
        content: "INNER JOIN 是这样写的：SELECT a.*, b.id FROM ...",
      }),
    ],
  }));
  assert.equal(verdict.kind, "allow");
});

test("dropResolvedTriggers allows when candidate has no prior reply in the thread", () => {
  const verdict = dropResolvedTriggers(makeInput({
    enqueueReason: "auto-chain",
    participant: makeParticipant({ participantId: "p-linus" }),
    triggerMessage: makeMessage({
      content: "@林纳斯 请用 idempotent 的例子说明一下软件开发场景",
    }),
    recentThreadMessages: [
      makeMessage({
        authorParticipantId: "p-turing",
        content: "@林纳斯 请用 idempotent 的例子说明软件开发场景",
      }),
    ],
  }));
  assert.equal(verdict.kind, "allow");
});

test("dropResolvedTriggers allows when trigger is too short to have meaningful overlap", () => {
  const verdict = dropResolvedTriggers(makeInput({
    enqueueReason: "auto-chain",
    triggerMessage: makeMessage({ content: "ok" }),
    recentThreadMessages: [
      makeMessage({ authorParticipantId: "p-linus", content: "ok" }),
    ],
  }));
  assert.equal(verdict.kind, "allow");
});

test("dropResolvedTriggers allows when recentThreadMessages is empty/undefined", () => {
  const v1 = dropResolvedTriggers(makeInput({
    enqueueReason: "auto-chain",
    triggerMessage: makeMessage({ content: "@林纳斯 一些 软件开发 idempotent 例子" }),
  }));
  assert.equal(v1.kind, "allow");
  const v2 = dropResolvedTriggers(makeInput({
    enqueueReason: "auto-chain",
    triggerMessage: makeMessage({ content: "@林纳斯 一些 软件开发 idempotent 例子" }),
    recentThreadMessages: [],
  }));
  assert.equal(v2.kind, "allow");
});

test("dropResolvedTriggers picks the candidate's MOST RECENT reply, not earlier ones", () => {
  // Earlier reply about idempotent; latest reply about something else.
  // Trigger about idempotent should NOT be denied — only the latest reply counts.
  const verdict = dropResolvedTriggers(makeInput({
    enqueueReason: "auto-chain",
    participant: makeParticipant({ participantId: "p-linus" }),
    triggerMessage: makeMessage({
      content: "@林纳斯 再举一个 idempotent 软件开发 例子",
    }),
    recentThreadMessages: [
      makeMessage({
        messageId: "old-1",
        authorParticipantId: "p-linus",
        content: "idempotent 例子：PUT 请求 软件开发 场景",
      }),
      makeMessage({
        messageId: "newer-1",
        authorParticipantId: "p-turing",
        content: "好的谢谢",
      }),
      makeMessage({
        messageId: "newest-from-linus",
        authorParticipantId: "p-linus",
        content: "好的我去看看",
      }),
    ],
  }));
  assert.equal(verdict.kind, "allow");
});

// ===========================================================================
// P3-C-2 — enforceBackPingBudget
// ===========================================================================

function makeHallWithHumans(): CollaborationHall {
  return {
    ...makeHall(),
    participants: [
      { participantId: "operator", displayName: "Operator", semanticRole: "manager", active: true, aliases: [], isHuman: true } as HallParticipant,
      { participantId: "p-turing", displayName: "图灵", semanticRole: "manager", active: true, aliases: [], agentId: "turing" } as HallParticipant,
      { participantId: "p-linus", displayName: "林纳斯", semanticRole: "implementer", active: true, aliases: [], agentId: "linus" } as HallParticipant,
      { participantId: "p-ada", displayName: "阿达", semanticRole: "reviewer", active: true, aliases: [], agentId: "ada" } as HallParticipant,
    ],
  };
}

test("enforceBackPingBudget allows when triggerAuthor has no prior @-mentions of candidate this round", () => {
  const verdict = enforceBackPingBudget(makeInput({
    hall: makeHallWithHumans(),
    participant: makeParticipant({ participantId: "p-linus", displayName: "林纳斯", agentId: "linus" }),
    triggerAuthorParticipantId: "p-turing",
    triggerMessage: makeMessage({ messageId: "trigger", authorParticipantId: "p-turing", content: "@林纳斯 一个新问题" }),
    recentThreadMessages: [
      makeMessage({ authorParticipantId: "operator", content: "@图灵 帮忙看看" }),
      makeMessage({ authorParticipantId: "p-turing", content: "好的我去做" }),
      makeMessage({ messageId: "trigger", authorParticipantId: "p-turing", content: "@林纳斯 一个新问题" }),
    ],
  }));
  assert.equal(verdict.kind, "allow");
});

test("enforceBackPingBudget denies when triggerAuthor has already @-mentioned candidate once this round (budget=1)", () => {
  const verdict = enforceBackPingBudget(makeInput({
    hall: makeHallWithHumans(),
    participant: makeParticipant({ participantId: "p-linus", displayName: "林纳斯", agentId: "linus" }),
    triggerAuthorParticipantId: "p-turing",
    triggerMessage: makeMessage({ messageId: "current-trigger", authorParticipantId: "p-turing", content: "@林纳斯 第二次问" }),
    recentThreadMessages: [
      makeMessage({ authorParticipantId: "operator", content: "@图灵 看看" }),
      makeMessage({ messageId: "first-ping", authorParticipantId: "p-turing", content: "@林纳斯 第一次问的内容" }),
      makeMessage({ authorParticipantId: "p-linus", content: "回答..." }),
      makeMessage({ messageId: "current-trigger", authorParticipantId: "p-turing", content: "@林纳斯 第二次问" }),
    ],
  }));
  assert.equal(verdict.kind, "deny");
  if (verdict.kind === "deny") {
    assert.equal(verdict.policyId, POLICY_ENFORCE_BACK_PING_BUDGET);
    assert.match(verdict.reason, new RegExp(`>= ${HALL_BACK_PING_BUDGET}`));
  }
});

test("enforceBackPingBudget resets count at human-authored round boundary", () => {
  // Old round had 2 prior pings, but new operator post resets the round.
  const verdict = enforceBackPingBudget(makeInput({
    hall: makeHallWithHumans(),
    participant: makeParticipant({ participantId: "p-linus", agentId: "linus" }),
    triggerAuthorParticipantId: "p-turing",
    triggerMessage: makeMessage({ messageId: "trigger", authorParticipantId: "p-turing", content: "@林纳斯 一个新问题" }),
    recentThreadMessages: [
      // OLD ROUND
      makeMessage({ authorParticipantId: "p-turing", content: "@林纳斯 旧问题1" }),
      makeMessage({ authorParticipantId: "p-turing", content: "@林纳斯 旧问题2" }),
      // ROUND BOUNDARY
      makeMessage({ authorParticipantId: "operator", content: "新一轮开始" }),
      // NEW ROUND
      makeMessage({ messageId: "trigger", authorParticipantId: "p-turing", content: "@林纳斯 一个新问题" }),
    ],
  }));
  // No prior pings in NEW round (only the current trigger, which is excluded) → allow
  assert.equal(verdict.kind, "allow");
});

test("enforceBackPingBudget excludes the current triggerMessage from the count", () => {
  // Only message in the round is the current trigger — count should be 0, not 1.
  const verdict = enforceBackPingBudget(makeInput({
    hall: makeHallWithHumans(),
    participant: makeParticipant({ participantId: "p-linus", agentId: "linus" }),
    triggerAuthorParticipantId: "p-turing",
    triggerMessage: makeMessage({ messageId: "current", authorParticipantId: "p-turing", content: "@林纳斯 第一次问" }),
    recentThreadMessages: [
      makeMessage({ authorParticipantId: "operator", content: "开始" }),
      makeMessage({ messageId: "current", authorParticipantId: "p-turing", content: "@林纳斯 第一次问" }),
    ],
  }));
  assert.equal(verdict.kind, "allow");
});

test("enforceBackPingBudget treats isHuman=true participants as round boundaries (multi-human safe)", () => {
  // Use a non-"operator" id with isHuman=true; the round boundary should still
  // be detected so prior pings before the boundary aren't counted.
  const hall = {
    ...makeHall(),
    participants: [
      { participantId: "human-2", displayName: "Bob", semanticRole: "manager", active: true, aliases: [], isHuman: true } as HallParticipant,
      { participantId: "p-turing", displayName: "图灵", semanticRole: "manager", active: true, aliases: [], agentId: "turing" } as HallParticipant,
      { participantId: "p-linus", displayName: "林纳斯", semanticRole: "implementer", active: true, aliases: [], agentId: "linus" } as HallParticipant,
    ],
  };
  const verdict = enforceBackPingBudget(makeInput({
    hall,
    participant: makeParticipant({ participantId: "p-linus", agentId: "linus" }),
    triggerAuthorParticipantId: "p-turing",
    triggerMessage: makeMessage({ messageId: "trigger", authorParticipantId: "p-turing", content: "@林纳斯 新问题" }),
    recentThreadMessages: [
      makeMessage({ authorParticipantId: "p-turing", content: "@林纳斯 旧的问题" }),
      makeMessage({ authorParticipantId: "human-2", content: "新一轮" }),
      makeMessage({ messageId: "trigger", authorParticipantId: "p-turing", content: "@林纳斯 新问题" }),
    ],
  }));
  assert.equal(verdict.kind, "allow");
});

test("enforceBackPingBudget counts mentions case-insensitively across displayName / agentId / participantId", () => {
  const hall = makeHallWithHumans();
  // Trigger author's prior message mentioned candidate by lowercased agentId.
  const verdict = enforceBackPingBudget(makeInput({
    hall,
    participant: makeParticipant({ participantId: "p-linus", displayName: "林纳斯", agentId: "linus" }),
    triggerAuthorParticipantId: "p-turing",
    triggerMessage: makeMessage({ messageId: "current", authorParticipantId: "p-turing", content: "@linus 第二次" }),
    recentThreadMessages: [
      makeMessage({ authorParticipantId: "operator", content: "go" }),
      makeMessage({ authorParticipantId: "p-turing", content: "@LINUS 第一次问 (uppercase mention)" }),
      makeMessage({ messageId: "current", authorParticipantId: "p-turing", content: "@linus 第二次" }),
    ],
  }));
  assert.equal(verdict.kind, "deny");
});

test("enforceBackPingBudget allows when triggerAuthorParticipantId is missing", () => {
  const verdict = enforceBackPingBudget(makeInput({
    hall: makeHallWithHumans(),
    triggerAuthorParticipantId: undefined,
    recentThreadMessages: [
      makeMessage({ authorParticipantId: "p-turing", content: "@林纳斯 1" }),
      makeMessage({ authorParticipantId: "p-turing", content: "@林纳斯 2" }),
    ],
  }));
  assert.equal(verdict.kind, "allow");
});

// ===========================================================================
// P3-C-2 — chain composition + interaction tests
// ===========================================================================

test("HALL_PER_TARGET_GATE_POLICIES order: A2 before detectClarifyingQuestion (A2 is a hard cap; CQ cannot bypass)", () => {
  // Counter at threshold + trigger looks like a question. A2 still wins.
  const verdict = runPreDispatchPolicies(HALL_PER_TARGET_GATE_POLICIES, {
    hall: makeHallWithHumans(),
    taskCard: makeTaskCard({ autoRoundsByAgent: { linus: AUTO_ROUND_BLOCK_THRESHOLD } }),
    participant: makeParticipant({ agentId: "linus" }),
    triggerMessage: makeMessage({ content: "你确定要这样做吗？" }), // would force-allow
    triggerAuthorParticipantId: "p-turing",
    chainDepth: 1,
    enqueueReason: "auto-chain",
    recentThreadMessages: [],
  });
  assert.equal(verdict.kind, "deny");
  if (verdict.kind === "deny") {
    assert.equal(verdict.policyId, POLICY_ENFORCE_AUTO_ROUND_LIMIT);
  }
});

test("HALL_CHAIN_FILTER_POLICIES: detectClarifyingQuestion overrides excludeTriggerAuthor (A3) for real questions", () => {
  // Reverse Q&A: B's reply mentions @A asking a clarifying question. A3 would
  // normally deny (candidate == trigger author of A's earlier turn), but the
  // question pattern force-allows.
  const verdict = runPreDispatchPolicies(HALL_CHAIN_FILTER_POLICIES, {
    hall: makeHallWithHumans(),
    taskCard: makeTaskCard(),
    participant: makeParticipant({ participantId: "p-turing", displayName: "图灵" }),
    triggerMessage: makeMessage({
      authorParticipantId: "p-linus",
      content: "@图灵 你的意思是用 LEFT JOIN 吗？",
    }),
    triggerAuthorParticipantId: "p-turing",  // Same as candidate → A3 would deny
    chainDepth: 1,
    enqueueReason: "auto-chain",
    recentThreadMessages: [],
  });
  assert.equal(verdict.kind, "force-allow");
  if (verdict.kind === "force-allow") {
    assert.equal(verdict.policyId, POLICY_DETECT_CLARIFYING_QUESTION);
  }
});

test("HALL_CHAIN_FILTER_POLICIES: dropResolvedTriggers fires even when trigger is non-questioning auto-chain ping", () => {
  // Non-question trigger from B to A; A's last reply already covered the topic.
  // detectClarifyingQuestion does NOT fire → dropResolvedTriggers can deny.
  const verdict = runPreDispatchPolicies(HALL_CHAIN_FILTER_POLICIES, {
    hall: makeHallWithHumans(),
    taskCard: makeTaskCard(),
    participant: makeParticipant({ participantId: "p-linus", displayName: "林纳斯", agentId: "linus" }),
    triggerMessage: makeMessage({
      authorParticipantId: "p-turing",
      content: "@林纳斯 idempotent 例子 软件开发 帮忙",
    }),
    triggerAuthorParticipantId: "p-turing",
    chainDepth: 1,
    enqueueReason: "auto-chain",
    recentThreadMessages: [
      makeMessage({
        authorParticipantId: "p-linus",
        content: "idempotent 在软件开发里很常见，举例 PUT 请求 重复发 也是同样结果，就是 idempotent 例子。",
      }),
    ],
  });
  assert.equal(verdict.kind, "deny");
  if (verdict.kind === "deny") {
    assert.equal(verdict.policyId, POLICY_DROP_RESOLVED_TRIGGERS);
  }
});

test("HALL_CHAIN_FILTER_POLICIES: enforceBackPingBudget fires when (B → A) already pinged once this round", () => {
  // B pinged A once already this round; current ping is the 2nd → deny.
  const verdict = runPreDispatchPolicies(HALL_CHAIN_FILTER_POLICIES, {
    hall: makeHallWithHumans(),
    taskCard: makeTaskCard(),
    participant: makeParticipant({ participantId: "p-linus", displayName: "林纳斯", agentId: "linus" }),
    triggerMessage: makeMessage({
      messageId: "current",
      authorParticipantId: "p-turing",
      content: "@林纳斯 完全无关的新话题这里没什么关键词",
    }),
    triggerAuthorParticipantId: "p-turing",
    chainDepth: 1,
    enqueueReason: "auto-chain",
    recentThreadMessages: [
      makeMessage({ authorParticipantId: "operator", content: "go" }),
      makeMessage({ authorParticipantId: "p-turing", content: "@林纳斯 第一次 ping" }),
      makeMessage({ messageId: "current", authorParticipantId: "p-turing", content: "@林纳斯 完全无关的新话题这里没什么关键词" }),
    ],
  });
  assert.equal(verdict.kind, "deny");
  if (verdict.kind === "deny") {
    assert.equal(verdict.policyId, POLICY_ENFORCE_BACK_PING_BUDGET);
  }
});

test("HALL_CHAIN_FILTER_POLICIES: clarifying-question force-allow beats both back-ping-budget AND A3", () => {
  // (B → A) already pinged once this round AND candidate IS the trigger author
  // (A3 would also deny). Both downstream denies are skipped because the
  // trigger looks like a clarifying question.
  const verdict = runPreDispatchPolicies(HALL_CHAIN_FILTER_POLICIES, {
    hall: makeHallWithHumans(),
    taskCard: makeTaskCard(),
    participant: makeParticipant({ participantId: "p-turing", displayName: "图灵" }),
    triggerMessage: makeMessage({
      messageId: "current",
      authorParticipantId: "p-linus",
      content: "@图灵 我应该用 INNER JOIN 还是 LEFT JOIN",
    }),
    triggerAuthorParticipantId: "p-turing",
    chainDepth: 1,
    enqueueReason: "auto-chain",
    recentThreadMessages: [
      makeMessage({ authorParticipantId: "operator", content: "go" }),
      makeMessage({ authorParticipantId: "p-linus", content: "@图灵 第一次 ping" }),
      makeMessage({ messageId: "current", authorParticipantId: "p-linus", content: "@图灵 我应该用 INNER JOIN 还是 LEFT JOIN" }),
    ],
  });
  assert.equal(verdict.kind, "force-allow");
});

test("HALL_PER_TARGET_GATE_POLICIES: max-depth deny precedes detectClarifyingQuestion (also a hard cap)", () => {
  const verdict = runPreDispatchPolicies(HALL_PER_TARGET_GATE_POLICIES, {
    hall: makeHallWithHumans(),
    taskCard: makeTaskCard(),
    participant: makeParticipant({ agentId: "linus" }),
    triggerMessage: makeMessage({ content: "你说什么？" }), // would force-allow if reached
    triggerAuthorParticipantId: "p-turing",
    chainDepth: MAX_AUTO_CHAIN_DEPTH + 1, // over the cap
    enqueueReason: "auto-chain",
    recentThreadMessages: [],
  });
  assert.equal(verdict.kind, "deny");
  if (verdict.kind === "deny") assert.equal(verdict.policyId, POLICY_ENFORCE_MAX_AUTO_CHAIN_DEPTH);
});

// ===========================================================================
// P3-C-2 — overlap threshold sanity check
// ===========================================================================

test("DROP_RESOLVED_OVERLAP_THRESHOLD is a sane value in [0.4, 0.8]", () => {
  // Sanity: very low (< 0.4) → many false positives; very high (> 0.8) → ineffective.
  assert.ok(DROP_RESOLVED_OVERLAP_THRESHOLD >= 0.4);
  assert.ok(DROP_RESOLVED_OVERLAP_THRESHOLD <= 0.8);
});

test("HALL_BACK_PING_BUDGET equals 1 (per issue #13 — first ping allowed, second denied)", () => {
  assert.equal(HALL_BACK_PING_BUDGET, 1);
});


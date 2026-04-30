import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_ROUND_BLOCK_THRESHOLD,
  HALL_CHAIN_FILTER_POLICIES,
  HALL_DEFAULT_POST_DISPATCH_POLICIES,
  HALL_PER_TARGET_GATE_POLICIES,
  MAX_AUTO_CHAIN_DEPTH,
  OBSERVE_SILENT_MARKER,
  POLICY_ENFORCE_AUTO_ROUND_LIMIT,
  POLICY_ENFORCE_MAX_AUTO_CHAIN_DEPTH,
  POLICY_EXCLUDE_TRIGGER_AUTHOR,
  POLICY_OBSERVE_SILENT_MARKER,
  buildOperatorTurnStatePatch,
  enforceAutoRoundLimit,
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

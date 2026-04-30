import assert from "node:assert/strict";
import test from "node:test";

import {
  HUMAN_REVIEW_IDLE_WINDOW_MS,
  needsHumanReview,
} from "../src/runtime/hall-human-review";
import type { HallTaskCard } from "../src/types";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeTaskCard(overrides: Partial<HallTaskCard> = {}): HallTaskCard {
  return {
    taskCardId: "card-1",
    hallId: "hall-1",
    projectId: "p1",
    taskId: "t1",
    title: "x",
    description: "y",
    status: "in_progress",
    mentionedParticipantIds: [],
    plannedExecutionOrder: [],
    plannedExecutionItems: [],
    sessionKeys: [],
    blockers: [],
    requiresInputFrom: [],
    createdByParticipantId: "operator",
    createdAt: "2026-04-30T00:00:00.000Z",
    updatedAt: "2026-04-30T00:00:00.000Z",
    ...overrides,
  };
}

const T0 = Date.parse("2026-04-30T12:00:00.000Z");

// ---------------------------------------------------------------------------
// Idle window (pre-P3-C-3 behavior, still expected when no escalation)
// ---------------------------------------------------------------------------

test("needsHumanReview returns false when no agent activity has been recorded", () => {
  const card = makeTaskCard({ lastAgentActivityAt: undefined });
  assert.equal(needsHumanReview(card, T0), false);
});

test("needsHumanReview returns false within the idle window", () => {
  const card = makeTaskCard({
    lastAgentActivityAt: new Date(T0 - 5 * 60 * 1000).toISOString(),
  });
  assert.equal(needsHumanReview(card, T0), false);
});

test("needsHumanReview returns true after the idle window elapses", () => {
  const card = makeTaskCard({
    lastAgentActivityAt: new Date(T0 - HUMAN_REVIEW_IDLE_WINDOW_MS - 1).toISOString(),
  });
  assert.equal(needsHumanReview(card, T0), true);
});

test("needsHumanReview returns false on done cards", () => {
  const card = makeTaskCard({
    status: "done",
    lastAgentActivityAt: new Date(T0 - HUMAN_REVIEW_IDLE_WINDOW_MS - 1).toISOString(),
  });
  assert.equal(needsHumanReview(card, T0), false);
});

test("needsHumanReview returns false on archived cards", () => {
  const card = makeTaskCard({
    archivedAt: new Date(T0 - 1000).toISOString(),
    lastAgentActivityAt: new Date(T0 - HUMAN_REVIEW_IDLE_WINDOW_MS - 1).toISOString(),
  });
  assert.equal(needsHumanReview(card, T0), false);
});

test("needsHumanReview returns false when humanReviewedAt is set (idle path)", () => {
  const card = makeTaskCard({
    lastAgentActivityAt: new Date(T0 - HUMAN_REVIEW_IDLE_WINDOW_MS - 1).toISOString(),
    humanReviewedAt: new Date(T0 - 1000).toISOString(),
  });
  assert.equal(needsHumanReview(card, T0), false);
});

// ---------------------------------------------------------------------------
// P3-C-3 explicit escalation path
// ---------------------------------------------------------------------------

test("needsHumanReview returns true on a fresh escalation even within idle window", () => {
  const card = makeTaskCard({
    // Recent agent activity → idle path would say false.
    lastAgentActivityAt: new Date(T0 - 30 * 1000).toISOString(),
    // But policy escalation just fired.
    escalatedAt: new Date(T0 - 5 * 1000).toISOString(),
  });
  assert.equal(needsHumanReview(card, T0), true);
});

test("needsHumanReview returns true on escalation with no idle activity at all", () => {
  const card = makeTaskCard({
    lastAgentActivityAt: undefined,
    escalatedAt: new Date(T0 - 5 * 1000).toISOString(),
  });
  assert.equal(needsHumanReview(card, T0), true);
});

test("needsHumanReview returns false when operator marked reviewed AFTER escalation", () => {
  const escalatedAt = new Date(T0 - 60 * 1000).toISOString();
  const reviewedAt = new Date(T0 - 30 * 1000).toISOString();
  const card = makeTaskCard({
    escalatedAt,
    humanReviewedAt: reviewedAt,
    lastAgentActivityAt: new Date(T0 - 30 * 1000).toISOString(),
  });
  assert.equal(needsHumanReview(card, T0), false);
});

test("needsHumanReview returns true when escalation fires AGAIN after a previous review", () => {
  // Operator already reviewed once at T0-60s, but a new escalation fired at
  // T0-10s — the operator hasn't acknowledged this one yet.
  const card = makeTaskCard({
    humanReviewedAt: new Date(T0 - 60 * 1000).toISOString(),
    escalatedAt: new Date(T0 - 10 * 1000).toISOString(),
    lastAgentActivityAt: new Date(T0 - 5 * 1000).toISOString(),
  });
  assert.equal(needsHumanReview(card, T0), true);
});

test("needsHumanReview escalation is overridden by archived state", () => {
  const card = makeTaskCard({
    archivedAt: new Date(T0 - 1000).toISOString(),
    escalatedAt: new Date(T0 - 100).toISOString(),
  });
  assert.equal(needsHumanReview(card, T0), false);
});

test("needsHumanReview escalation is overridden by done status", () => {
  const card = makeTaskCard({
    status: "done",
    escalatedAt: new Date(T0 - 100).toISOString(),
  });
  assert.equal(needsHumanReview(card, T0), false);
});

test("needsHumanReview tolerates malformed ISO strings on escalatedAt", () => {
  const card = makeTaskCard({
    escalatedAt: "not-a-date",
    lastAgentActivityAt: new Date(T0 - 30 * 1000).toISOString(),
  });
  // Bad escalatedAt parses to 0; falls back to idle path; recent activity → false.
  assert.equal(needsHumanReview(card, T0), false);
});

test("needsHumanReview tolerates malformed humanReviewedAt (treats as not reviewed)", () => {
  const card = makeTaskCard({
    humanReviewedAt: "broken",
    escalatedAt: new Date(T0 - 100).toISOString(),
  });
  assert.equal(needsHumanReview(card, T0), true);
});

// ---------------------------------------------------------------------------
// Boundary: escalatedAt === humanReviewedAt
// ---------------------------------------------------------------------------

test("needsHumanReview returns false when escalatedAt and humanReviewedAt are exactly equal (operator wins ties)", () => {
  const t = new Date(T0 - 60 * 1000).toISOString();
  const card = makeTaskCard({
    escalatedAt: t,
    humanReviewedAt: t,
    lastAgentActivityAt: new Date(T0 - 30 * 1000).toISOString(),
  });
  // Strict greater-than means exact equality drops to fallback; reviewedAt > 0
  // returns false. (Practically: an operator clicking "reviewed" right after
  // an escalation should clear it.)
  assert.equal(needsHumanReview(card, T0), false);
});

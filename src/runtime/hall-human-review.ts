import type { HallTaskCard } from "../types";

// A thread needs human review in either of two cases:
//   1. Idle window: no agent has posted for HUMAN_REVIEW_IDLE_WINDOW_MS and
//      no operator has marked it as reviewed.
//   2. Explicit escalation (P3-C-3): an anti-loop policy fired
//      `escalatedAt` (e.g. A2 auto-round limit hit). This bypasses the idle
//      window so the operator sees the card immediately.
//
// In both cases, an operator can clear the signal by marking the thread
// human-reviewed (sets `humanReviewedAt`); the policy then waits for new
// agent activity or a new escalation before flagging again.
export const HUMAN_REVIEW_IDLE_WINDOW_MS = 10 * 60 * 1000;

export function needsHumanReview(card: HallTaskCard, nowMs: number = Date.now()): boolean {
  if (card.archivedAt) return false;
  if (card.status === "done") return false;

  const reviewedAt = Date.parse(card.humanReviewedAt ?? "") || 0;
  const escalatedAt = Date.parse(card.escalatedAt ?? "") || 0;

  // Explicit escalation wins as long as the operator hasn't acknowledged it
  // *after* the escalation fired.
  if (escalatedAt && escalatedAt > reviewedAt) return true;

  // Otherwise fall back to the idle-window heuristic. A `humanReviewedAt`
  // marker without a fresher escalation means the operator already cleared
  // the signal — wait for new agent activity to flip it again.
  if (reviewedAt) return false;
  const lastAgentAt = Date.parse(card.lastAgentActivityAt ?? "") || 0;
  if (!lastAgentAt) return false;
  return (nowMs - lastAgentAt) > HUMAN_REVIEW_IDLE_WINDOW_MS;
}

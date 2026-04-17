import type { HallTaskCard } from "../types";

// A thread needs human review when it has been idle for longer than this
// window, no operator has marked it as reviewed, and it is not already done
// or archived. Replaces the old regex-driven "blocked" detection.
export const HUMAN_REVIEW_IDLE_WINDOW_MS = 10 * 60 * 1000;

export function needsHumanReview(card: HallTaskCard, nowMs: number = Date.now()): boolean {
  if (card.archivedAt) return false;
  if (card.status === "done") return false;
  if (card.humanReviewedAt) return false;
  const lastAgentAt = Date.parse(card.lastAgentActivityAt ?? "") || 0;
  if (!lastAgentAt) return false;
  return (nowMs - lastAgentAt) > HUMAN_REVIEW_IDLE_WINDOW_MS;
}

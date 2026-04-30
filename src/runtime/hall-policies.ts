// ---------------------------------------------------------------------------
// Phase 3-C-1 — anti-loop policies as pluggable pure functions.
// ---------------------------------------------------------------------------
// A1-A4 used to live as inline checks scattered through
// collaboration-hall-orchestrator.ts. This module pulls them out behind two
// small composable interfaces:
//
//   PreDispatchPolicy   — runs before an agent dispatch (target gate / chain
//                         candidate filter). Verdict: allow | deny.
//   PostDispatchPolicy  — runs after an agent reply. Verdict: keep | drop.
//
// Behavior is identical to the pre-refactor inline implementation; the goal
// of P3-C-1 is purely the extraction so P3-C-2 can plug in
// detectClarifyingQuestion / dropResolvedTriggers / enforceBackPingBudget at
// the same enforcement points.

import type {
  CollaborationHall,
  HallMessage,
  HallParticipant,
  HallTaskCard,
} from "../types";
import type { UpdateHallTaskCardInput } from "./collaboration-hall-store";
import type { HallInboxEnqueueReason } from "./hall-mailbox";

// --- Constants ---------------------------------------------------------------

export const OBSERVE_SILENT_MARKER = "OBSERVE_SILENT";
export const MAX_AUTO_CHAIN_DEPTH = 5;
export const AUTO_ROUND_BLOCK_THRESHOLD = 6;

// --- Verdict types -----------------------------------------------------------

export type PreDispatchVerdict =
  | { kind: "allow" }
  | { kind: "deny"; policyId: string; reason: string };

export type PostDispatchVerdict =
  | { kind: "keep" }
  | { kind: "drop"; policyId: string; reason: string };

// --- Policy inputs -----------------------------------------------------------

export interface PreDispatchPolicyInput {
  hall: CollaborationHall;
  taskCard: HallTaskCard;
  participant: HallParticipant;
  /** The trigger message that prompted considering this candidate. */
  triggerMessage?: HallMessage;
  /** Author of the trigger (for A3 / future back-ping policies). May be the
   * operator participant id for operator-route, or the previous agent's
   * participantId for chain candidates. */
  triggerAuthorParticipantId?: string;
  /** Depth at which this candidate would dispatch (parent + 1 for chain
   * candidates; 0 for operator-route primaries). */
  chainDepth: number;
  enqueueReason: HallInboxEnqueueReason;
}

export interface PostDispatchPolicyInput {
  hall: CollaborationHall;
  taskCard: HallTaskCard;
  participant: HallParticipant;
  replyContent: string;
  enqueueReason: HallInboxEnqueueReason;
}

// --- Policy types ------------------------------------------------------------

export type PreDispatchPolicy = (input: PreDispatchPolicyInput) => PreDispatchVerdict;
export type PostDispatchPolicy = (input: PostDispatchPolicyInput) => PostDispatchVerdict;

// --- Policy ids --------------------------------------------------------------

export const POLICY_ENFORCE_AUTO_ROUND_LIMIT = "enforce-auto-round-limit";
export const POLICY_ENFORCE_MAX_AUTO_CHAIN_DEPTH = "enforce-max-auto-chain-depth";
export const POLICY_EXCLUDE_TRIGGER_AUTHOR = "exclude-trigger-author";
export const POLICY_OBSERVE_SILENT_MARKER = "observe-silent-marker";

// --- Policy implementations --------------------------------------------------

/** A2 — auto-round limit. After the per-(card, agent) counter has been
 * incremented (see `incrementAutoRoundCounter`), deny if the counter has
 * reached the block threshold. The orchestrator runs the
 * "auto-round-blocked" notification side-effect when this policy denies. */
export const enforceAutoRoundLimit: PreDispatchPolicy = (input) => {
  const { taskCard, participant } = input;
  const agentKey = (participant.agentId ?? participant.participantId).trim();
  if (!agentKey) return { kind: "allow" };
  const rounds = taskCard.autoRoundsByAgent ?? {};
  const current = rounds[agentKey] ?? 0;
  if (current >= AUTO_ROUND_BLOCK_THRESHOLD) {
    return {
      kind: "deny",
      policyId: POLICY_ENFORCE_AUTO_ROUND_LIMIT,
      reason: `auto-round counter ${current} >= ${AUTO_ROUND_BLOCK_THRESHOLD}`,
    };
  }
  return { kind: "allow" };
};

/** Chain depth limit — deny if the candidate's would-be depth exceeds
 * MAX_AUTO_CHAIN_DEPTH. The orchestrator passes `chainDepth = parent + 1`
 * for chain candidates; 0 for operator-route primaries (always allowed). */
export const enforceMaxAutoChainDepth: PreDispatchPolicy = (input) => {
  if (input.chainDepth > MAX_AUTO_CHAIN_DEPTH) {
    return {
      kind: "deny",
      policyId: POLICY_ENFORCE_MAX_AUTO_CHAIN_DEPTH,
      reason: `chain depth ${input.chainDepth} > ${MAX_AUTO_CHAIN_DEPTH}`,
    };
  }
  return { kind: "allow" };
};

/** A3 — exclude trigger author. Deny if the candidate is the same participant
 * as the message that triggered the chain consideration. Breaks A→B→A
 * ping-pong. */
export const excludeTriggerAuthor: PreDispatchPolicy = (input) => {
  const { participant, triggerAuthorParticipantId } = input;
  if (
    triggerAuthorParticipantId
    && participant.participantId === triggerAuthorParticipantId
  ) {
    return {
      kind: "deny",
      policyId: POLICY_EXCLUDE_TRIGGER_AUTHOR,
      reason: "candidate is the trigger author",
    };
  }
  return { kind: "allow" };
};

/** A4 — drop the agent reply if it is empty or starts with the
 * OBSERVE_SILENT marker. Suppresses "agree only / acknowledge only" noise
 * from the observer path and from any agent that decides it has nothing to
 * add. */
export const observeSilentMarker: PostDispatchPolicy = (input) => {
  const trimmed = input.replyContent.trim();
  if (
    !trimmed
    || trimmed === OBSERVE_SILENT_MARKER
    || trimmed.startsWith(OBSERVE_SILENT_MARKER)
  ) {
    return {
      kind: "drop",
      policyId: POLICY_OBSERVE_SILENT_MARKER,
      reason: trimmed ? "starts with OBSERVE_SILENT" : "empty reply",
    };
  }
  return { kind: "keep" };
};

// --- Default chain compositions ----------------------------------------------

/** Policies enforced at the per-(card, agent) gate inside `dispatchHallAgentReply`
 * (after the auto-round counter has been incremented). A2-limit is the only
 * one currently active here — the others are no-ops at this site because the
 * candidate filter already excluded them — but they are included so future
 * policies can land at a single point.
 *
 * IMPORTANT: order matters for `verdict.policyId` dispatch downstream. The
 * caller branches on `policyId === POLICY_ENFORCE_AUTO_ROUND_LIMIT` to fire
 * the auto-round-blocked notification, so A2 must come first. */
export const HALL_PER_TARGET_GATE_POLICIES: PreDispatchPolicy[] = [
  enforceAutoRoundLimit,
  enforceMaxAutoChainDepth,
  excludeTriggerAuthor,
];

/** Policies enforced at the chain-candidate filter inside
 * `dispatchHallAgentReply` (auto-chain branch) and `dispatchMainObserver`
 * (observer chain branch). `enforceMaxAutoChainDepth` and
 * `excludeTriggerAuthor` are the active gates; A2-limit is intentionally
 * omitted at this site to preserve pre-refactor behavior (counter has not
 * been incremented yet, and the per-target gate handles it after dispatch). */
export const HALL_CHAIN_FILTER_POLICIES: PreDispatchPolicy[] = [
  enforceMaxAutoChainDepth,
  excludeTriggerAuthor,
];

/** Policies enforced after every agent reply (observer / per-target /
 * wake-mention initiator). A4 is the only post-dispatch gate today. */
export const HALL_DEFAULT_POST_DISPATCH_POLICIES: PostDispatchPolicy[] = [
  observeSilentMarker,
];

// --- Chain runners -----------------------------------------------------------

export function runPreDispatchPolicies(
  policies: PreDispatchPolicy[],
  input: PreDispatchPolicyInput,
): PreDispatchVerdict {
  for (const policy of policies) {
    const v = policy(input);
    if (v.kind === "deny") return v;
  }
  return { kind: "allow" };
}

export function runPostDispatchPolicies(
  policies: PostDispatchPolicy[],
  input: PostDispatchPolicyInput,
): PostDispatchVerdict {
  for (const policy of policies) {
    const v = policy(input);
    if (v.kind === "drop") return v;
  }
  return { kind: "keep" };
}

// --- State-mutation helpers --------------------------------------------------

/** A1 + A2-reset: build the task-card patch for an operator-initiated turn.
 * Returns null when no patch is needed (originalAssigner already set AND no
 * autoRoundsByAgent counters to clear). The caller persists via
 * `updateHallTaskCard`. */
export function buildOperatorTurnStatePatch(
  taskCard: HallTaskCard,
  triggerAuthorParticipantId: string | undefined,
): UpdateHallTaskCardInput | null {
  const patch: UpdateHallTaskCardInput = { taskCardId: taskCard.taskCardId };
  let hasChanges = false;

  if (!taskCard.originalAssignerParticipantId && triggerAuthorParticipantId) {
    patch.originalAssignerParticipantId = triggerAuthorParticipantId;
    hasChanges = true;
  }
  if (taskCard.autoRoundsByAgent && Object.keys(taskCard.autoRoundsByAgent).length > 0) {
    patch.autoRoundsByAgent = {};
    hasChanges = true;
  }
  return hasChanges ? patch : null;
}

/** A2-increment: produce the next autoRoundsByAgent map for the given (card,
 * agent). Returns `agentKey: null` when the participant has no usable id (no
 * counter to increment); otherwise the rounds map with the counter bumped by
 * 1. The caller persists the map via `updateHallTaskCard` and then runs the
 * pre-dispatch policy chain on the patched task card. */
export function incrementAutoRoundCounter(
  taskCard: HallTaskCard,
  participant: HallParticipant,
): { agentKey: string | null; rounds: Record<string, number> } {
  const trimmed = (participant.agentId ?? participant.participantId).trim();
  const agentKey = trimmed.length > 0 ? trimmed : null;
  const rounds = { ...(taskCard.autoRoundsByAgent ?? {}) };
  if (agentKey) {
    rounds[agentKey] = (rounds[agentKey] ?? 0) + 1;
  }
  return { agentKey, rounds };
}

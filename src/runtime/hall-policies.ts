// ---------------------------------------------------------------------------
// Anti-loop policies as pluggable pure functions.
// ---------------------------------------------------------------------------
// A1-A4 used to live as inline checks scattered through
// collaboration-hall-orchestrator.ts. P3-C-1 pulled them out behind two
// small composable interfaces:
//
//   PreDispatchPolicy   — runs before an agent dispatch (target gate / chain
//                         candidate filter). Verdict: allow | force-allow | deny.
//   PostDispatchPolicy  — runs after an agent reply. Verdict: keep | drop.
//
// P3-C-2 added three new policies on top of the chain:
//   * detectClarifyingQuestion — force-allow real reverse Q&A
//   * dropResolvedTriggers     — silence triggers the candidate already covered
//   * enforceBackPingBudget    — limit per-pair back-pings inside one operator round

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
  /** P3-C-2: a policy can short-circuit the chain with an explicit allow that
   * overrides any downstream deny. Used by `detectClarifyingQuestion` to let
   * legitimate reverse Q&A through the A3 / back-ping-budget filters that
   * would otherwise drop it. The caller treats `force-allow` and `allow` the
   * same way (proceed with dispatch); the distinction matters only inside
   * the chain. */
  | { kind: "force-allow"; policyId: string; reason: string }
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
  /** P3-C-2: thread messages used by content-aware policies
   * (`dropResolvedTriggers`, `enforceBackPingBudget`). Optional because some
   * orchestrator entry points haven't loaded thread messages yet — those
   * policies treat absence as "no recent activity → allow". */
  recentThreadMessages?: HallMessage[];
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
export const POLICY_DETECT_CLARIFYING_QUESTION = "detect-clarifying-question";
export const POLICY_DROP_RESOLVED_TRIGGERS = "drop-resolved-triggers";
export const POLICY_ENFORCE_BACK_PING_BUDGET = "enforce-back-ping-budget";

// --- P3-C-2 tunables ---------------------------------------------------------

/** Token-overlap ratio (between trigger and candidate's most recent reply)
 * above which `dropResolvedTriggers` denies the dispatch. 0.6 chosen
 * empirically: high enough to avoid false positives on tangentially-related
 * follow-up triggers, low enough to catch the issue #13 example (operator
 * @-mentions Linus and Turing in one message; Turing then @-mentions Linus
 * for the same idempotent example — the second dispatch is redundant). */
export const DROP_RESOLVED_OVERLAP_THRESHOLD = 0.6;
/** Below this many content tokens in the trigger, dropResolvedTriggers
 * abstains — overlap on a sub-token trigger is too noisy to trust. */
export const DROP_RESOLVED_MIN_TRIGGER_TOKENS = 3;
/** Maximum back-pings (B's @-mentions of A) per (A, B) pair within one
 * operator round. 1 = "B can ping A back once per round; further pings get
 * silenced". 0 would silence all back-pings and break legitimate one-shot
 * follow-ups; 2+ defeats the purpose. */
export const HALL_BACK_PING_BUDGET = 1;

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

// --- P3-C-2 policies ---------------------------------------------------------

/** Patterns that flag a message as a clarifying question. Tier 1 heuristic —
 * cheap, lossy. Order is by selectivity (most specific first). */
const CLARIFYING_QUESTION_PATTERNS: RegExp[] = [
  // Question marks (CJK + ASCII) anywhere
  /[?？]/,
  // CJK question particle 吗 at end of sentence
  /[一-龥]+吗\s*$/m,
  // CJK choice particle 还是 (A or B?) — common question signal even when the
  // alternatives are ASCII (e.g. "INNER JOIN 还是 LEFT JOIN"). We intentionally
  // accept that 还是 also has an adverbial meaning ("still") which produces a
  // small force-allow false-positive — acceptable for a permissive verdict.
  /\s还是\s|^还是\s|\s还是$/,
  // CJK leading interrogative phrases
  /^(请问|麻烦|能否|可否|是否|是不是|你的意思是|你是说|想确认|想问一下|可以.*?吗|能.*?吗)/m,
  // CJK clarification verbs
  /(澄清|明确一下|不太理解|不明白|没听懂)/,
  // English leading interrogatives
  /^(could|can|would|should|how|what|why|when|where|which|who|do|does|did|is|are|am|was|were)\b/im,
  // English clarification phrases
  /\b(do you mean|what do you mean|could you clarify|can you (?:explain|elaborate)|let me confirm|just to be sure)\b/i,
];

/** P3-C-2 — detect clarifying question. When the trigger looks like a real
 * question being asked back (most often "B → @A: did you mean...?"), this
 * policy returns `force-allow` so the dispatch isn't dropped by the A3
 * exclude-trigger-author filter or the back-ping budget. Tier 1 heuristic
 * only; tier 2 (structured marker) and tier 3 (mini LLM judge) are reserved
 * for later if false negatives prove material in production. */
export const detectClarifyingQuestion: PreDispatchPolicy = (input) => {
  const trigger = input.triggerMessage;
  const content = trigger?.content?.trim();
  if (!content) return { kind: "allow" };
  for (const pattern of CLARIFYING_QUESTION_PATTERNS) {
    if (pattern.test(content)) {
      return {
        kind: "force-allow",
        policyId: POLICY_DETECT_CLARIFYING_QUESTION,
        reason: "trigger looks like a clarifying question",
      };
    }
  }
  return { kind: "allow" };
};

// --- Token extraction (used by dropResolvedTriggers) -------------------------

const STOPWORDS_EN = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "of", "to", "in", "on", "at", "for", "with", "by", "and", "or", "not",
  "but", "if", "then", "do", "does", "did", "has", "have", "had",
  "will", "would", "could", "should", "can", "may", "might",
  "i", "you", "he", "she", "it", "we", "they", "this", "that", "these", "those",
  "what", "how", "why", "when", "where", "which", "who",
  "as", "so", "from", "up", "down", "out", "over", "under", "into",
  "your", "yours", "my", "mine", "his", "her", "hers", "its", "our", "ours",
  "their", "theirs", "me", "him", "us", "them", "about", "than", "more", "most",
  "some", "any", "all", "no", "yes",
]);

/** Common Chinese 2-character function words / particles. Single-char Chinese
 * tokens are inherently noisy so we only emit bigrams (and skip these). */
const STOPWORDS_ZH_BIGRAM = new Set([
  "我们", "你们", "他们", "她们", "它们", "这个", "那个", "这些", "那些",
  "什么", "怎么", "为什么", "如何", "可以", "可能", "应该", "需要", "能否",
  "是否", "是不", "不是", "没有", "已经", "还有", "或者", "并且", "但是",
  "不过", "因为", "所以", "如果", "那么", "这样", "那样", "现在", "目前",
  "请问", "麻烦", "谢谢", "明白", "理解", "确认", "意思", "时候", "地方",
  "一个", "一下", "一些", "一直", "一定", "一起",
]);

/** Tokenize a message body into content tokens (lowercase ASCII words >= 3
 * chars OR Chinese bigrams), stripping URLs, fenced code, inline code, and
 * `@mention` handles so they don't dominate the overlap score. */
function extractContentTokens(text: string | undefined): Set<string> {
  const tokens = new Set<string>();
  if (!text) return tokens;
  const stripped = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/@[\w一-龥]+/g, " ");

  for (const w of stripped.match(/[a-zA-Z][a-zA-Z0-9_]{2,}/g) ?? []) {
    const lower = w.toLowerCase();
    if (!STOPWORDS_EN.has(lower)) tokens.add(lower);
  }
  for (const phrase of stripped.match(/[一-龥]+/g) ?? []) {
    if (phrase.length < 2) continue;
    for (let i = 0; i < phrase.length - 1; i++) {
      const bigram = phrase.slice(i, i + 2);
      if (!STOPWORDS_ZH_BIGRAM.has(bigram)) tokens.add(bigram);
    }
  }
  return tokens;
}

/** P3-C-2 — drop the dispatch if the candidate's most recent reply already
 * substantively addresses the trigger. Tier 1 heuristic: token-overlap ratio
 * between the trigger and the candidate's last message in the thread. The
 * issue #13 example: operator @-mentions Linus AND Turing in one message;
 * Turing's reply also @-mentions Linus for the same idempotent example.
 * Linus's first dispatch produces a reply; the second dispatch's trigger
 * (Turing's @-mention) is now redundant — the heuristic catches the overlap
 * and silences it.
 *
 * Skipped for `operator-route` enqueues — the operator's intent is
 * authoritative; a follow-up question from the operator should always
 * dispatch even if it overlaps lexically with what was just discussed. */
export const dropResolvedTriggers: PreDispatchPolicy = (input) => {
  if (input.enqueueReason === "operator-route") return { kind: "allow" };
  const trigger = input.triggerMessage;
  const content = trigger?.content?.trim();
  if (!content) return { kind: "allow" };

  const triggerTokens = extractContentTokens(content);
  if (triggerTokens.size < DROP_RESOLVED_MIN_TRIGGER_TOKENS) return { kind: "allow" };

  const recent = input.recentThreadMessages;
  if (!recent || recent.length === 0) return { kind: "allow" };

  // Most recent message authored by the candidate (their last reply in the thread).
  let latestSelfReply: HallMessage | undefined;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].authorParticipantId === input.participant.participantId) {
      latestSelfReply = recent[i];
      break;
    }
  }
  if (!latestSelfReply || !latestSelfReply.content) return { kind: "allow" };

  const replyTokens = extractContentTokens(latestSelfReply.content);
  if (replyTokens.size === 0) return { kind: "allow" };

  let overlap = 0;
  for (const t of triggerTokens) {
    if (replyTokens.has(t)) overlap++;
  }
  const ratio = overlap / triggerTokens.size;
  if (ratio >= DROP_RESOLVED_OVERLAP_THRESHOLD) {
    return {
      kind: "deny",
      policyId: POLICY_DROP_RESOLVED_TRIGGERS,
      reason: `trigger overlaps candidate's most recent reply at ${(ratio * 100).toFixed(0)}% (>= ${(DROP_RESOLVED_OVERLAP_THRESHOLD * 100).toFixed(0)}%)`,
    };
  }
  return { kind: "allow" };
};

/** Returns true if `content` contains an `@mention` of `participant`
 * (matching displayName, agentId, or participantId — case-insensitive,
 * leading `@` required). */
function contentMentionsParticipant(content: string, participant: HallParticipant): boolean {
  const candidates = [participant.displayName, participant.agentId, participant.participantId]
    .filter((s): s is string => !!s && s.length > 0)
    .map((s) => s.toLowerCase());
  if (candidates.length === 0) return false;
  const lower = content.toLowerCase();
  return candidates.some((c) => lower.includes(`@${c}`));
}

/** Returns true if the message was authored by a human participant — the
 * round boundary marker. We accept either the literal "operator" id (the
 * single-human convention used through most of the codebase) or any
 * participant flagged `isHuman: true` on the hall (multi-human-friendly). */
function isHumanAuthored(message: HallMessage, hall: CollaborationHall): boolean {
  if (message.authorParticipantId === "operator") return true;
  return hall.participants.find((p) => p.participantId === message.authorParticipantId)?.isHuman === true;
}

/** P3-C-2 — limit (triggerAuthor → candidate) reverse-pings within a single
 * operator round. Walks back through `recentThreadMessages` from the end
 * until it hits a human-authored message (the round boundary), counting how
 * many of the trigger author's prior messages already `@`-mentioned the
 * candidate. The current trigger is excluded from the count (one back-ping
 * per round is the budget; the *first* such ping is allowed, the second is
 * denied). */
export const enforceBackPingBudget: PreDispatchPolicy = (input) => {
  const { hall, participant, triggerAuthorParticipantId, triggerMessage, recentThreadMessages } = input;
  if (!triggerAuthorParticipantId) return { kind: "allow" };
  if (!recentThreadMessages || recentThreadMessages.length === 0) return { kind: "allow" };

  let priorBackPings = 0;
  for (let i = recentThreadMessages.length - 1; i >= 0; i--) {
    const msg = recentThreadMessages[i];
    if (isHumanAuthored(msg, hall)) break;
    if (triggerMessage && msg.messageId === triggerMessage.messageId) continue;
    if (msg.authorParticipantId !== triggerAuthorParticipantId) continue;
    if (contentMentionsParticipant(msg.content ?? "", participant)) {
      priorBackPings++;
    }
  }

  if (priorBackPings >= HALL_BACK_PING_BUDGET) {
    return {
      kind: "deny",
      policyId: POLICY_ENFORCE_BACK_PING_BUDGET,
      reason: `back-ping budget exhausted for (${triggerAuthorParticipantId} → ${participant.participantId}): ${priorBackPings} prior @-mention(s) >= ${HALL_BACK_PING_BUDGET}`,
    };
  }
  return { kind: "allow" };
};

// --- Default chain compositions ----------------------------------------------

/** Policies enforced at the per-(card, agent) gate inside `dispatchHallAgentReply`
 * (after the auto-round counter has been incremented).
 *
 * Order (per issue #13 design):
 *   1. enforceAutoRoundLimit       — A2 hard cap; must be first so the deny
 *                                    `policyId` triggers `handleAutoRoundBlockedThreshold`
 *                                    in the orchestrator.
 *   2. enforceMaxAutoChainDepth    — depth hard cap.
 *   3. detectClarifyingQuestion    — force-allow real reverse Q&A (overrides
 *                                    A3 / back-ping below).
 *   4. dropResolvedTriggers        — silence redundant re-asks the candidate
 *                                    has already answered.
 *   5. enforceBackPingBudget       — cap (B → A) ping count per round.
 *   6. excludeTriggerAuthor        — A3 final ping-pong guard. */
export const HALL_PER_TARGET_GATE_POLICIES: PreDispatchPolicy[] = [
  enforceAutoRoundLimit,
  enforceMaxAutoChainDepth,
  detectClarifyingQuestion,
  dropResolvedTriggers,
  enforceBackPingBudget,
  excludeTriggerAuthor,
];

/** Policies enforced at the chain-candidate filter inside
 * `dispatchHallAgentReply` (auto-chain branch) and `dispatchMainObserver`
 * (observer chain branch).
 *
 * Same order and policies as HALL_PER_TARGET_GATE_POLICIES *minus* A2-limit
 * — at this site the auto-round counter has not been incremented yet, so
 * including A2 here would silently drop candidates that should fire the
 * auto-round-blocked notification at the per-target gate instead. */
export const HALL_CHAIN_FILTER_POLICIES: PreDispatchPolicy[] = [
  enforceMaxAutoChainDepth,
  detectClarifyingQuestion,
  dropResolvedTriggers,
  enforceBackPingBudget,
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
    if (v.kind === "deny" || v.kind === "force-allow") return v;
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

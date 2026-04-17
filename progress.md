# Progress log

## Session 2026-04-17 — Phase A implementation

Phase A goal: remove the 5-state `HallTaskStage` machine, centralize
execution control on `executionLock`, add `humanReviewedAt` / `lastAgentActivityAt`,
rename `blockedTaskCount` → `needsHumanReviewCount`, and get `tsc -p` clean.

### What landed

- **`src/runtime/hall-execution-lock.ts`** — rewrote `assertHallExecutionAllowed`
  to be lock-based (no more stage check); dropped `stage: "execution"` from
  `acquireHallExecutionLock`.
- **`src/runtime/hall-speaker-policy.ts`** — DELETED. All discussion-cycle
  speaker-rotation functions (`openDiscussionCycle`, `closeDiscussionCycle`,
  `buildDiscussionParticipantQueue`, `resolveDefaultSpeakerForStage`, etc.)
  are gone.
- **`src/runtime/hall-runtime-dispatch.ts`**:
  - `HallRuntimeNextAction` no longer includes `"blocked"`.
  - `looksLikeBlockedExecutionUpdate` regex + all its guards deleted.
  - `asOptionalNextAction` no longer accepts `"blocked"`.
  - `taskStage` dropped from the message payload scaffold at `:1238`.
- **`src/runtime/collaboration-hall-orchestrator.ts`**:
  - Imports of speaker-policy functions removed; `assertHallExecutionAllowed`
    import also removed (was unused now).
  - Dead functions deleted: `shouldRouteOperatorMessageBackToDiscussion`,
    `reopenHallTaskToDiscussion`, `runHallDiscussion`,
    `determineDiscussionTurnParticipants`, `scheduleHallDiscussion`, the family
    of `requests*`/`classifyHallDiscussionFollowupIntent` helpers,
    `pickComplementaryDiscussionParticipant`, `complementaryDiscussionRoles`,
    `countDistinctAgentContributors`, `normalizeHallIntentSourceText`,
    `looksLikeRepoInspectionRequest`, `requestsConcreteDeliverable`,
    `appendGeneratedHallReply`, `buildGeneratedHallReply`,
    `buildPlannerDiscussionProposal`, `buildImplementerDiscussionProposal`,
    `buildReviewerDiscussionProposal`, `buildManagerDiscussionDecision`,
    `buildSuggestedDoneWhen`, `buildSuggestedExecutionOrder`,
    `buildDynamicDiscussionParticipantQueue`, `discussionRoleOrder`,
    `recommendedExecutorRoleOrder`, `pickParticipantForRole`,
    `pickRecommendedExecutor`, `buildSuggestedExecutionPlan`,
    `listRecentDiscussionParticipants`, `requiresMultiStepExecution`,
    `requiresReviewFollowup`, `buildBlockedExecutionSummary`,
    `inferHallDiscussionDomain` wrapper.
  - `applyHallExecutionDirective` blocked branch deleted (replaced with comment
    pointing at the new needs-human-review detector).
  - All `stage: "..."` writes in `updateHallTaskCard` calls removed
    (assignHallTaskExecution, stopHallTaskExecution, submitHallTaskReview,
    recordHallTaskHandoff, applyHallExecutionDirective review branch).
  - All `taskStage: ...` fields in `HallMessagePayload` literals removed.
  - `hasLockedActiveExecution` in `setHallTaskExecutionOrder` now derives from
    `executionLock` not stage.
  - `wakeHandoffInitiator` wake-note no longer mentions stage.
- **`src/runtime/collaboration-hall-store.ts`**:
  - `HallTaskStage` import removed.
  - `HALL_TASK_STAGES`, `optionalHallTaskStage`, `asHallTaskStage`,
    `normalizeDiscussionCycle` all deleted.
  - `CreateHallTaskCardInput.stage` and `UpdateHallTaskCardInput.stage`/
    `discussionCycle` removed; new fields `humanReviewedAt` /
    `lastAgentActivityAt` added.
  - `createHallTaskCard` no longer writes `stage`.
  - `updateHallTaskCard` no longer reads `stage`/`discussionCycle`; now applies
    `humanReviewedAt` / `lastAgentActivityAt` if passed.
  - `listHallTaskCards` no longer accepts a `stage` filter option.
  - `normalizeTaskCard` tolerates legacy `stage` and `discussionCycle` fields
    by ignoring them.
- **`src/runtime/collaboration-hall-summary-store.ts`**:
  - `blockedTaskCount` → `needsHumanReviewCount` (driven by the new
    `needsHumanReview()` helper, i.e. idle > 10 min and not marked reviewed).
  - `waitingReviewCount` now derived from `HallMessage.kind === "review"`,
    not from the missing stage.
  - `buildHallTaskSummary.nextAction` rewritten to not reference stages.
  - `normalizeHallSummary` reads legacy `blockedTaskCount` as fallback for
    `needsHumanReviewCount` (backwards-compat).
  - `HallTaskSummary.stage` dropped.
- **`src/runtime/hall-human-review.ts`** — NEW. `needsHumanReview(card, nowMs)`
  with 10-minute idle window constant `HUMAN_REVIEW_IDLE_WINDOW_MS`.
- **`src/types.ts`**:
  - `HallTaskStage` type deleted.
  - `TaskDiscussionCycle` interface deleted.
  - `HallTaskCard.stage` and `.discussionCycle` removed; added `humanReviewedAt`
    and `lastAgentActivityAt`.
  - `HallMessagePayload.taskStage` removed.
  - `CollaborationHallSummary.blockedTaskCount` → `needsHumanReviewCount`.
  - `HallTaskSummary.stage` removed.
- **`src/ui/collaboration-hall.ts`** (SSR side only):
  - Top-level `stageLabel(stage, language)` function deleted — replaced with a
    comment pointing at the new `resolveHallActivityLabel(card, language)`.
  - New `resolveHallActivityLabel()` + `hallTaskNeedsHumanReview()` helpers
    added inline to avoid a runtime→UI dep cycle.
  - `describeHallDecisionCardState` now uses activity label (still within SSR
    path; embedded client JS still uses its own `stageLabel` helper, to be
    cleaned in Phase B).
  - `hasLockedHallExecution` now derives from `executionLock` not stage.
  - Bootstrap `taskCards[].stage` field dropped.
  - Demo payload no longer sets `stage`/`blockedTaskCount`; uses new counter.
- **`src/ui/server.ts`**:
  - `GET /api/hall/tasks` no longer accepts/consumes `?stage=`; returns all
    visible task cards.
  - `normalizeHallTaskStageQuery` helper deleted.
  - (Pending: "卡住" / "Blocked" chip and filter text updates — tracked in Phase B.)

### Build status

`npm run build` (= `tsc -p tsconfig.json`) runs clean — **Phase A exit criterion
met**. Tests not yet run.

### Phases status

| Phase | Status | Notes |
|-------|--------|-------|
| A — Foundation + stop writing blocked | **complete (build green)** | See diff above. |
| B — UI + API + tests | **complete** | See Session 2026-04-17 — Phase B below. |

## Session 2026-04-17 — Phase B implementation

Phase B goal: strip remaining UI stage strings, add mark-human-reviewed endpoint
and wiring, align tests with the group-chat model.

### What landed

- **`src/ui/server.ts`**: `Blocked/卡住` → `Needs human review/需要人类审核` on
  collaboration-board chip (`:7515`), filter button (`:7548`),
  `collaborationThreadStatusLabel` (`:15269`), summary text (`:15307`),
  filter-state label (`:15900`). Added `POST /api/hall/tasks/:taskId/mark-human-reviewed`
  route and extended the GET-fallback exclusion list accordingly.
- **`src/ui/collaboration-hall.ts`** (embedded client JS):
  - Deleted `textStage`, `textContinueDiscussion`, `textAdjustExecutionOrder`,
    `textPlanExecutionOrder`, `textContinueDiscussionSeed`,
    `textContinueDiscussionHint`, `textReviewingNow`.
  - Replaced client-side `stageLabel()` with `activityLabel(taskCard)` (derives
    from status + executionLock + needs-human-review) and added inline
    `needsHumanReview(taskCard)` helper (10-min idle window).
  - Replaced all `taskCard.stage === "execution"/"blocked"/"discussion"`
    reads with lock-based checks: `taskCard.executionLock && !...releasedAt`.
  - Deleted `decisionCardStageText`, the `阶段：...` row, the "继续讨论"
    button + `__openclawHallContinueDiscussion` handler + `focusComposer`
    flash noise, and the obsolete `stage ∈ {discussion,execution,blocked,review}`
    polling guard (now polls while task is not done/archived).
  - Kept `decisionSecondaryOrderLabel` returning a single `textSetExecutionOrder`
    label instead of discussion-vs-execution branching.
  - Added `textMarkHumanReviewed`/`textMarkedHumanReviewed`, a conditional
    mark-human-reviewed button rendered when `needsHumanReview(taskCard)` is
    true, and the `markHumanReviewed` handler exposed as
    `window.__openclawHallMarkHumanReviewed`.
  - Updated `textStopped` wording to drop the "returned the thread to discussion"
    tail.
- **`src/runtime/collaboration-hall-orchestrator.ts`**:
  - New exported `markHallTaskHumanReviewed(input)` writes `humanReviewedAt`,
    emits `hall_task_mark_human_reviewed` audit, returns `HallMutationResult`.
  - New `touchHallTaskAgentActivity(taskCardId)` helper called from
    `appendPersistedHallMessage` and `appendStreamedGeneratedHallMessage`;
    bumps `lastAgentActivityAt` and clears `humanReviewedAt` on every
    agent-authored message so the needs-human-review signal auto-re-fires.
  - Restored the greeting lobby-reply path in `postHallMessage` — a greeting
    without a taskCard now persists the user message, calls
    `appendLobbyHallReply` with the first lobby participant, and returns the
    reply in `generatedMessages` (instead of silently auto-creating a task).
- **`src/runtime/operation-audit.ts`**: added
  `"hall_task_mark_human_reviewed"` to `OperationAuditAction`.
- **`scripts/live-hall-full-check.js:179`**: regex updated from
  `/阶段：\s*(执行中|卡住)|\bstage:\s*(execution|blocked)\b/` to
  `/需要人类审核|needs human review|执行中|in progress/`.

### Test alignment

Many pre-existing test failures (since group-chat refactor commit `1a0198c`,
2026-04-08) asserted workflow-engine behaviors that no longer exist. Deleted
as obsolete:
- `test/collaboration-hall-orchestrator.test.ts`: 31 tests removed (20 discussion
  cycle/manager-close/review/blocked stage tests + 11 planned-queue auto-handoff
  tests). Greeting test updated to assert any participant id, not specifically
  `coq`. Final: 16 pass / 2 fail out of 18. The 2 remaining failures are real
  feature bugs (session-key propagation into taskCard; multi-@mention routing
  only dispatching the first target) — flagged for separate triage.
- `test/collaboration-hall-ui-smoke.test.ts`: 3 tests removed (review-stage
  render, discussion-stage render, current-console render). "Three-pane shell"
  test updated to drop 5 assertions for UI attributes removed in upstream commit
  `71dfaa6` (`data-hall-create-task`, `data-hall-handoff`, `draftTtlMs=30_000`,
  `__openclawHallContinueDiscussion`, `data-hall-start-execution`,
  `data-hall-plan-order`). Final: 18/18 pass.
- `test/hall-runtime-dispatch.test.ts`: 9 tests removed (assertions against the
  pre-group-chat prompt like `/This is your first reply/`, `/Direct ask you
  must satisfy now/`, etc.). Final: 31/31 pass.
- `test/hall-execution-lock.test.ts`: 1/1 pass.
- `test/collaboration-hall-typing.test.ts`: 1/1 pass (has a pre-existing SSE
  cleanup hang that blocks process exit; test result is correct).

### Final status

- `npm run build` — clean.
- `npm run smoke:ui` — passes on 127.0.0.1:4516.
- Hall test pass rate across all 5 hall test files: 67/69 (two outstanding
  real-feature regressions to triage separately, both in orchestrator).

### Open follow-ups (not Phase B)

- Triage: `sessionKeys` from agent dispatch are not propagating to
  `HallTaskCard.sessionKeys` (test "runtime-backed hall orchestration stores
  real session linkage").
- Triage: multi-@mention routing dispatches only the first target
  (test "runtime-backed hall discussion honors explicit @mentions on the very
  first operator task").

### Open items for Phase B

- Update UI visible strings: "Blocked / 卡住" → "Needs human review / 需要人类审核"
  on `collaboration-board` chip, filter buttons, and the SSE card badges in
  `src/ui/server.ts` (lines 7513, 7546, 7889, 15267, 15898).
- Remove the embedded client-side JS stage UI in `src/ui/collaboration-hall.ts`:
  `textStage`, `textContinueDiscussion`, `textAdjustExecutionOrder`,
  `textPlanExecutionOrder`, `textContinueDiscussionSeed`,
  `textContinueDiscussionHint`, `textStopped`, the in-template
  `stageLabel(stage)` helper, the "continue discussion" button rendering, etc.
- Add `POST /api/hall/task-cards/:id/mark-human-reviewed` endpoint + wire it to
  update `humanReviewedAt`; auto-clear `humanReviewedAt` when agents post.
- Have `postHallMessage` / `dispatchHallAgentReply` write `lastAgentActivityAt`
  on the target task card when an agent posts.
- Fix tests (~50 assertions across 5 files): drop `stage:`/`discussionCycle:`/
  `blockedTaskCount:` references, rename counter, rewrite logic-level
  assertions to check `currentOwnerParticipantId` / `executionLock` / `status`.
- `scripts/live-hall-full-check.js:179` — regex still expects "阶段：...".
  Update or remove.

### Errors encountered

- sed-based block deletion left a dangling `);\n}` fragment that had to be
  patched out — fixed.
- `pickPrimaryParticipantByRole` accepts a narrower role union than
  `HallSemanticRole`; added an early-return for `generalist` / `observer` so
  the call compiles.
- The first delete attempt of `hall-speaker-policy.ts` succeeded but left the
  file on disk (tool returned a prompt-style message). Re-issued `rm -f`.

## Session 2026-04-14 — planning

(unchanged — planning notes from initial investigation)

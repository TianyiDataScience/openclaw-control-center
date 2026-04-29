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

## Session 2026-04-27 — Phase 3 调度引擎启动

Phase 1（反循环兜底，#8）和 Phase 2（hall 派发走 Gateway WebSocket，#9 第 6 项）已合入。
本会话启动 Phase 3，针对 Issue #9 第 1/2/3/4 项做架构层重构而非继续打补丁。

### 设计文档

- `task_plan.md` 已建：Phase 3 三件套（Blackboard + Mailbox + Policy），决定先做 P3-A
- `findings.md` 已建：当前 hall 架构摸底 + 业界做法蒸馏（Anthropic 多智能体研究系统、Cognition 反方观点、MetaGPT 共享消息池、AutoGen GroupChat、LangGraph 监督/swarm、Hearsay-II 黑板、Claude Code subagents、Actor model、A2A/ACP）
- 设计提案已通过后台 agent 评论到 issue：https://github.com/xiaolinfrank/openclaw-control-center/issues/9#issuecomment-4323964598

### 已定决策

1. 黑板写一致性 → **追加协议 + agent 写自己块**（`<!-- agent: X, ts: Y --> ... <!-- /agent -->`），引擎工具兜底
2. inbox 存储 → **文件 append-only + 内存索引**

### P3-A 实施落地

#### 新增 / 修改

- **`src/runtime/hall-blackboard.ts`**（新增 ~250 行）
  - `initializeHallBlackboard(taskCard)` 创建 `.hall/{chat.jsonl, chat-index.md, locks/}` + 三份 stub markdown（`task_plan.md` / `findings.md` / `progress.md`）；幂等，已有文件不覆盖
  - `appendHallBlackboardMessage(taskCardId, message)` append 到 `chat.jsonl` + 重新生成 `chat-index.md`；按 messageId 去重（in-memory cap 256）
  - `readHallProgressLatestEntry(taskCardId)` 读 progress.md 最后一个 `<!-- agent: X, ts: Y -->` 块的内容，供 orchestrator 回填 `latestSummary`（本期未接入，留 P3-A 跟进）
  - `renderHallBlackboardPromptGuidance(taskCardId, lang)` 中英双版本的黑板使用引导文案
  - per-card promise chain (`runSerial`) 序列化所有写
- **`src/runtime/hall-runtime-dispatch.ts`**
  - 引入 `HALL_INLINE_CONTEXT_DEFAULT = 5` / `HALL_INLINE_CONTEXT_FIRST_TURN = 15`，把 prompt 的 recentMessages 从 `slice(-30)` 改成动态 cap
  - dispatch 路径：`void initializeHallBlackboard(taskCard).catch(() => undefined)` fire-and-forget，避免 `await` 影响测试时序（详见 task_plan 的 Lessons learned）
  - 在 prompt 中插入 `blackboardGuidance` 段
- **`src/runtime/collaboration-hall-orchestrator.ts`**
  - `postHallMessage` 写消息后 `await initializeHallBlackboard(taskCard)` + `void appendHallBlackboardMessage(taskCardId, message)`
  - `appendStreamedGeneratedHallMessage` / `appendPersistedHallMessage` 各 append 一份到黑板
- **`test/hall-blackboard.test.ts`**（新增）
  - 6 个测试：init 创建文件 / init 幂等不覆盖 / append 写 JSONL + 索引 / append 去重 / readLatestEntry / guidance 渲染
  - 测试用真实 path + 测后 cleanup（`HALL_WORKSPACES_DIR` 模块级常量，无法用 `process.chdir`）

#### 测试结果

- `npm run build` 干净
- `node --import tsx scripts/run-tests-isolated.ts test/hall-*.test.ts test/collaboration-hall-*.test.ts test/hall-blackboard.test.ts` ＝ 102 个测试，99 过，3 失败（全部是 P3-A 之前就有的旧 bug：execution-order persists / runtime-backed session linkage / multi-@mention routing），与本次改动无关
- `test/hall-blackboard.test.ts` 6/6 全过

#### 排查记录（值得一记）

最初版本在 `dispatchHallRuntimeTurn` 里 `await initializeHallBlackboard(...)`，导致 `runtime execution persists artifact refs` 测试**单跑通过、批量跑挂掉**。bisect 证实：是 await 增加的 microtask 让 `FakeRuntimeToolClient` 的 enqueue/dequeue 时序与 `assignHallTaskExecution` 的返回点出现毫秒级竞争。改成 `void initializeHallBlackboard(...).catch(() => undefined)` 后回归消失。**生产路径上的 best-effort 副作用应当 fire-and-forget，不要 await**。

#### 接下来 / 跟进

- progress.md 末块 → `latestSummary` 回填（P3-A 跟进 PR，不阻塞）
- P3-B：Mailbox 改造（独立 PR）
- P3-C：Policy + Supervisor（独立 PR）

### 手测 + 现场修两个 bug（2026-04-29）

用户在 hall 群聊里发了一条"搜索 codex 最近几次的产品更新"作为黑板手测。结果发现 `.hall/` 目录正确建出来了、三份 stub 也对，但 `chat.jsonl` 里**只有 1 条 main 的 status 消息**——operator 的原始消息丢了，且 status 消息里塞着 5KB 的 base64 tool I/O。

#### Bug 1：operator task 消息没进黑板

根因：UI 创建任务走 `createHallTaskFromOperatorRequest`（line 599 以 `kind: "task"` 写入），但 P3-A 只接了 `postHallMessage`。task 创建路径完全没通到黑板 append。

修复：在 `createHallTaskFromOperatorRequest` 里 `appendHallMessage` 之后加了：
```typescript
await initializeHallBlackboard(taskCard).catch(() => undefined);
void appendHallBlackboardMessage(taskCard.taskCardId, initialMessage);
```

#### Bug 2：status 消息塞满 base64 tool I/O 让 chat.jsonl 不可读

现象：单条 status 消息 5108 字符，全是 `[[tool:web_search|Codex OpenAI...|~eyJpIjoie1wic...]]` 这种格式——tool name + summary + base64 全量 I/O，UI 用来渲染工具药丸 detail。基本变成压缩包噪声。

修复：在 `hall-blackboard.ts` 加 `sanitizeMessageForBlackboard(message)`，写入 `chat.jsonl` 之前用正则 `\[\[tool:([^|\]]+)\|([^|\]]*)\|~[^\]]+\]\]` 把 `|~base64...` 段去掉，保留 `[[tool:<name>|<summary>]]` 形式。grep 友好，base64 噪声消失。

JSON store 里的原始消息**不动**——黑板是物化视图，UI 仍然能从权威源读完整 tool I/O 渲染药丸。

新增测试：`appendHallBlackboardMessage strips base64 tool I/O payload from status content`。

#### 验证

- `npm run build` 干净
- `node ... test/hall-blackboard.test.ts` → 7/7 过
- 全量 hall 测试 103 个，100 过，3 失败（仍然是基线，零回归）

待用户再发一条 hall 消息真机复测两个 fix。

### Playwright 真机 e2e 复测（2026-04-29）

用 Playwright MCP 起 dev server 上 hall UI，发了一条三 agent 接力任务："@图灵 列 fizzbuzz 需求 → @林纳斯 写 Python → @阿达 点评代码风格"。

**结果**：
- ✅ 新 task workspace `collaboration-hall:turing-3-fizzbuzz-...-771a8f80/` 自动建出 `.hall/{chat.jsonl, chat-index.md, locks/}` + 三份 stub
- ✅ Bug 1 fix 生效：operator 的 task 消息（170B、3 个 mention target 全部解析）落到 chat.jsonl 第 1 条
- ✅ 多 agent 接力：图灵 → 林纳斯 → 阿达 全部回复，链路 4 条消息（task + 3 status）
- ✅ 林纳斯按追加协议自己写了 progress.md：
  ```
  <!-- agent: linus-dev, ts: 2026-04-29T06:21:00.000Z -->
  ### Linus 产出 — Python FizzBuzz 实现
  文件：`fizzbuzz.py`（10 行内，含断言验证）
  状态：代码已跑通，单元测试通过。
  <!-- /agent -->
  ```
- ✅ 实际产出 `fizzbuzz.py` 落到 workspace 根目录（10 行内、含 type hint、list comprehension、断言自测）
- ✅ chat-index.md 正确分组（By kind / By author / Recent timeline）

**发现并修了一个 sanitizer 边角 case**：

林纳斯写代码时给 `[[tool:write|...]]` 的 summary 是真实代码片段，含 `list[str]` 这种带 `]` 的字符。原正则 `\[\[tool:([^|\]]+)\|([^|\]]*)\|~[^\]]+\]\]` 的 summary 字符类排除了 `]`，遇到 `list[str]` 直接 bail，base64 段就漏出来了。

修复：把 summary 字符类改成非贪婪的 `[\s\S]*?`，base64 段用 `[A-Za-z0-9+/=]*` 限定（base64 字母表不含 `]`，所以 `]]` 自然成为终止符）。新正则：

```ts
/\[\[tool:([^|\]]+)\|([\s\S]*?)\|~[A-Za-z0-9+/=]*\]\]/g
```

测试加了一个 case 覆盖：summary 含 `list[str]` + 多行 + `FizzBuzz` 代码块。

#### 最终验证

- `npm run build` 干净
- `node ... test/hall-blackboard.test.ts` → 7/7 过
- 全量 hall 测试 103，100 过，3 失败（基线，零回归）
- Dev server 重启后已加载修复版正则

### P3-A 提交 + P3-B/C 设计 issue（2026-04-29）

- **PR #12**：feat(hall): Phase 3-A 黑板落地——共享 chat.jsonl + task_plan/findings/progress 三件套（针对 #9 第 1-3 项）
  - URL: https://github.com/xiaolinfrank/openclaw-control-center/pull/12
  - Branch: `feat/hall-blackboard-p3a`，commit `ea00bc9`
  - 含 5 个文件：`hall-blackboard.ts` 新增、`test/hall-blackboard.test.ts` 新增、`collaboration-hall-orchestrator.ts` 改、`hall-runtime-dispatch.ts` 改、`progress.md` 改
- **Issue #13**：Phase 3-B/C 设计——Mailbox + Speaker Policy chain（针对 #9 第 4 项 + A3 反循环兜底过于刚性）
  - URL: https://github.com/xiaolinfrank/openclaw-control-center/issues/13
  - 含 Mailbox 设计、Policy chain 设计（含 `detectClarifyingQuestion` 解决 A3 误伤反向 Q&A）、Supervisor 设计、拆 PR 计划
- **Issue #9 进度更新评论**：在主 issue 下面加了一条简短指引，让 #9 的读者能直接跳到 PR #12 + issue #13
  - URL: https://github.com/xiaolinfrank/openclaw-control-center/issues/9#issuecomment-4341549577

### 当前架构层进度

| Issue 9 子问题 | 状态 | 落点 |
|---|---|---|
| 1. 上下文构建（共享 vs 独立） | ✅ P3-A | PR #12 黑板 chat.jsonl + 5 条 inline cap |
| 2. 共享 task_plan | ✅ P3-A | PR #12 task_plan.md + 追加协议 |
| 3. 共享 findings / progress | ✅ P3-A | PR #12 同上 |
| 4. 多对一/一对多/高并发 | 📋 设计完成 | issue #13 Mailbox + Policy + Supervisor |
| 6. session 一致性 | ✅ Phase 2 | 已合 commit `36b4ca2`（Gateway WS） |

任务计划文件 `task_plan.md` 和 `findings.md` 仍为本地工作脚本（未入 git，作为后续 phase 的 working memory）。

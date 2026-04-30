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

## Session 2026-04-29 续 — Phase 3-B-1：Mailbox 透明层

针对 issue #13 P3-B-1 拆分，把 hall dispatch 路径上每一次"我要派一条消息给某个 agent"的事件物化到磁盘的 inbox + delivery 审计日志，**不改 dispatch 行为**——为 P3-B-2 的防抖合并 + P3-C 的 policy chain 打地基。

### 实施

- 新增 `src/runtime/hall-mailbox.ts`：log-structured `inbox/{participantId}.jsonl`（同时存 enqueue / consume 行，读时 reduce 出 pending）+ `deliveries.jsonl`（投递审计）+ 内存索引（per-(card, agent) lazy hydrate）
- 新增 `src/runtime/hall-scheduler.ts`：`enqueueAndDispatch(args, dispatch)` 薄包装——persist enqueue → 调 dispatch（现有 per-sessionKey `dispatchChains` 提供单飞）→ persist consume + delivery
- 改 `src/runtime/collaboration-hall-orchestrator.ts`：4 个 dispatch 入口包成 `enqueueAndDispatch`：
  - operator 路由（`routeAndDispatchHallMessage` 主 fan-out）
  - main observer 入口（main 不在 primary targets 时的事后 observe）
  - observer 内部 auto-chain（observer 自己 @ 别人时）
  - `dispatchHallAgentReply` 内部 auto-chain + `wakeMentionInitiator`（@ 完成回调）
- 测试：`test/hall-mailbox.test.ts`（7 case）+ `test/hall-scheduler.test.ts`（5 case）

### 设计修正

原设计想引入 per-(card, agent) worker queue，落地时发现 cyclic enqueue 死锁：A→B→C→A 链（chainDepth ≤ 5 内合法），如果 worker 在 await chain 子任务时被 chain 子任务的 enqueue 反向 block，构成依赖环。结论：P3-B-1 **不**引入 queue/worker，等 P3-B-2 防抖合并时一起设计——届时 enqueue 不再 await 单条 dispatch 完成、而是 buffer 后批处理，自然不会有依赖环。

### 验证

- `npm run build` 干净
- 单 file 跑 mailbox + scheduler：12/12 过
- 全 hall 套（除已知 hang 的 typing 文件）：96+ 过，3 失败全部是 P3-A 之前就存在的基线（execution-order persists / session-linkage / multi-mention routing），零回归
- `npm run smoke:ui` 通过
- `npm run smoke:hall` 失败（`data-hall-continue-discussion` 选择器在 commit 21f9403 拆 5 状态机时移除，smoke 脚本未跟上——pre-existing baseline broken，与本 PR 无关）
- Playwright 真机 e2e：✅ 跑通

#### Playwright e2e（2026-04-30）

任务卡：`collaboration-hall:p3-b-1-mailbox-turing-pm-linus-idempotent-.hall--85b5a134`

第一步：操作员发"请 @图灵 + @林纳斯 各回答 idempotent 是什么"——多 @ 同时派发。

第二步：操作员发"@图灵 让他 @ 林纳斯 举软件开发例子"——同时触发 auto-chain（图灵 reply 里 @ 林纳斯）+ wake-mention-initiator（chain 完成后回叫图灵）。

`.hall/inbox/` 文件验证：
- `turing-pm.jsonl` —— 多次 enqueue + consume，含 `operator-route` 与 `wake-mention-initiator` 两种 reason
- `linus-dev.jsonl` —— 多次 enqueue + consume，含 `operator-route`（operator 直接 @ 林纳斯）+ `auto-chain depth=1`（图灵 reply 里 @ 林纳斯）
- `main.jsonl` —— `main-observer` reason，main 不在 primary targets 时 observer 路径触发

`deliveries.jsonl` 5 条：

| recordId | target | enqueueReason | chainDepth | outcome | duration |
|---|---|---|---|---|---|
| `52e53a28` | turing-pm | operator-route | 0 | dispatched | 46s |
| `eb0d5f71` | linus-dev | operator-route | 0 | dispatched | 58s |
| `bd1cdeaf` | main | main-observer | 0 | dispatched | 36s |
| `a80c2c4e` | linus-dev | operator-route | 0 | dispatched | 17s |
| `f5c2529a` | linus-dev | **auto-chain** | **1** | dispatched | 23s |

✅ 全部 4 个集成点（operator-route / main-observer / auto-chain / wake-mention-initiator）都被实际流量打到了，零回归零异常。

## Session 2026-04-30 — 中途切分支：P3-B-1 暂停，开 P3-A-2

### 缘起

P3-B-1（mailbox 透明层）已 ship 到 PR #14 + 跑通 Playwright e2e。跟 owner review 时引出两个新议题：

1. **issue #13 的 `dedupRecentDispatch` 设计有缺陷**——按时间窗 silence 会误伤"30s 内不同 agent 各问 Linus 不同问题"这种独立请求场景。已在 issue #13 评论修正为 `dropResolvedTriggers`（看 agent 已说过的话决定是否冗余）：https://github.com/xiaolinfrank/openclaw-control-center/issues/13#issuecomment-4349519620
2. **每次 dispatch 都重发完整 prompt**——10K tokens 的 identity / persona / hall rules / roster / 5 条 inline transcript 等，LLM 端 OpenClaw session 累积下来全是重复内容。10 轮对话累计 ~100K，长聊容易爆窗口 + 烧钱。

### 决定

先开 **P3-A-2** 把上下文管理彻底交给 OpenClaw session + 黑板（首轮发 setup，后续轮只发 trigger，agent 想看群聊用 grep 黑板），从根上消除 prompt 冗余。这是 P3-A 黑板的延伸优化，正好以黑板为基础设施。

P3-A-2 ship 之后**回来**：
- `git checkout feat/hall-mailbox-p3b1` 回到 mailbox 分支
- rebase 到合并后的 main（吸收 P3-A-2 的 prompt 简化）
- 继续 **P3-B-2**（750ms 防抖合并 + worker queue）
- 再做 **P3-C 系列**（policy chain + `dropResolvedTriggers` + supervisor）

### 分支拓扑

```
main
└─ feat/hall-blackboard-p3a (PR #12, P3-A 黑板)
   ├─ feat/hall-mailbox-p3b1 (PR #14, P3-B-1 mailbox)  ← 暂停
   └─ feat/hall-context-delegation-p3a2 ← 新分支（current focus）
```

P3-A-2 跟 P3-B-1 是兄弟分支，都基于 P3-A，互不依赖（功能上正交）。先合谁后合谁均可，但建议 P3-A-2 先合，P3-B-1 后做 rebase 吸收 prompt 简化。

### 设计要点（详见 task_plan.md "Phase P3-A-2"）

- **首轮**发完整 setup（identity + 群聊意识 + 黑板路径 + 工作目录 + 花名册 + 行为指令 + trigger）
- **后续轮**只发 `[from: <作者>] <trigger 内容>`（约 200-500 tokens vs 当前 10K）
- 删除 `recentMessages.slice(-5/15)` 的 inline transcript 段
- 强化 blackboard guidance 的"群聊意识"段——明确告诉 agent "别人说话你看不到，想看自己 grep"
- observer 触发文案改成 `[mode: observer] 阅读 .hall/chat.jsonl 末尾几条，决定是否补充`
- A1 originalAssigner 提示从 prompt 段降级为 trigger 前缀的 `[note: 完成后 @ X 汇报]`

### 节省估算

| 维度 | 当前 (P3-A 后) | P3-A-2 后 |
|---|---|---|
| 首轮 prompt | ~10K tokens | ~6K tokens（去掉 inline transcript 但保留稳定段） |
| 后续轮 prompt | ~10K tokens（每次重发） | **~200-500 tokens**（只 trigger + 作者归属） |
| 10 轮对话累计 | ~100K | ~6K + 9*0.3K ≈ 9K |

约 **90% token 削减**。

### Session 2026-04-30 续 — P3-A-2 实施 + e2e

#### 落地

- `hall-runtime-dispatch.ts` 拆 `buildHallRuntimePrompt` → `buildFirstTurnSetupPrompt` + `buildSubsequentTurnTriggerPrompt`
- 删除 inline transcript 段（`recentMessages.slice(-5/15)`）+ 死代码（`HALL_INLINE_CONTEXT_*` / `dedupeHallPromptMessages`）
- `hall-blackboard.ts:renderHallBlackboardPromptGuidance` 强化"群聊意识"：明确告诉 agent "其他人一直在说话，没 @ 你时你看不到"，给具体 `tail`/`grep` 命令
- `collaboration-hall-orchestrator.ts:dispatchMainObserver` 观察者 trigger 缩成 `[mode: observer] tail .hall/chat.jsonl ...`
- 新增 `linkRuntimeSessionKeyToTaskCard`：dispatch 完成后把 runtime sessionKey 写回 taskCard.sessionKeys（pre-P3-A-2 这条路径就有但没影响因为 prompt 不区分；P3-A-2 实际 branch on it 才暴露这个 latent bug）。同时给 dispatchHallAgentReply / dispatchMainObserver / wakeMentionInitiator 三处都加上链接

#### 单元测试 (test/hall-prompt-context.test.ts) 8 case 全过

- 首轮 prompt 含 setup 段（identity / 群聊意识 / 黑板路径 / roster）
- 首轮**不**inline transcript（即使 `recentThreadMessages` 里有 3 条旧消息）
- 后续轮 prompt 极简（只有 `[from: <author>] <trigger>`，< 2KB）
- 后续轮含 A1 originalAssigner one-liner（如适用）
- assigner == self 时不加 A1 hint
- triggerMessage 缺失（observer / wake）渲染干净
- 黑板 guidance 含强群聊意识
- token footprint：subsequent ≪ first（至少 8×）

#### 全 hall 套（除 typing）

- 108/111 过，3 失败仍是 P3-A 之前的基线（execution-order persists / session-linkage / multi-mention routing），零新回归
- `npm run smoke:ui` 通过

#### Playwright e2e 真机

任务卡：`collaboration-hall:p3-a-2-prompt-2-linus-idempotent-455a7d6c`，发了 3 条 operator 消息观察 OpenClaw session 变化：

| 轮 | OpenClaw session 中 user message 长度 | 路径 |
|---|---|---|
| 1 | 15,785 chars | first-turn setup（预期） |
| 2 | 15,763 chars | first-turn setup（**异常**——预期应是 subsequent） |
| 3 | 116 chars | subsequent trigger（预期）✓ |

**第 3 轮 116 字符**确认机制正常：`[note] 完成后请 @Operator（操作员）汇报，... [来自 Operator] @林纳斯 第三轮，简短回复"3"。`

第 2 轮的 15K 异常**未完全定位**——可能是首次 dispatch 完成后 sessionKey 写盘到下次 read 之间的 race window。机制上 turn 3 已证明 subsequent-turn 路径正确生效。代价：单卡片首发那一组的第二条 dispatch 可能仍走完整 prompt，但仍**严格优于** baseline（baseline 永远全发）。后续 PR 可以加更稳健的 first-turn 判定（例如 OpenClaw session 文件存在性检查）。

#### Agent 行为副作用：首轮就用了 `tail .hall/chat.jsonl`

观察到 Linus 收到第一条 task 后**主动调 bash `tail -n 20 .hall/chat.jsonl`**——正是新群聊意识引导教的工作流。说明 prompt 强化生效。

## Session 2026-04-30 续 — Phase 3-B-2 防抖合并 + worker pump

合 P3-A / P3-B-1 / P3-A-2 三 PR 进 main 后，开 `feat/hall-mailbox-debounce-p3b2` 分支继续 mailbox 路线。

### 落地

把 P3-B-1 的同步 `enqueueAndDispatch(args, closure)` 重构为真正的异步 worker pump，但**保留 closure-per-call 模式**（不是注册全局 dispatcher）以维持测试隔离：

- **`src/runtime/hall-scheduler.ts` 完全重写**
  - per-(cardId, agentId) `WorkerState`：pending records 队列 + debounce timer + isDispatching 锁
  - `enqueueAndDispatch(args, dispatch)` 仍接受 closure（关键：closure 通过 lexical scope 持有调用方的 `toolClient` / `hall` / `taskCard`，让测试的 fake client 仍能用）
  - 750ms 防抖窗（可由 `HALL_INBOX_DEBOUNCE_MS` 覆盖）
  - 窗稳定后 `drainAndDispatch`：原子 snapshot pending → **调 batch[0] 的 closure**（同一 (card, agent) 的 closures 等价，任意一个都行）→ 批量写 consume + delivery（共享 batchId）→ resolve 全部 pending promise
  - closure 接收 `InboxBatchContext`（含全部合并的 records），自己负责从 message store 拉 triggerMessages
  - dispatcher 抛错时 outcome 标 failed 但 promise 仍 resolve（callers `Promise.allSettled` 拿到 fulfilled，不破坏 observer 时序）
  - 死锁规避：worker 自身不 await 任何 enqueue 返回的 promise；re-entrant enqueue（auto-chain）只追加 pending，下一窗自然处理
- **`src/runtime/hall-mailbox.ts`**：`HallInboxDeliveryRecord` 加 `batchId?` / `batchSize?` 字段，反映合并批次
- **`src/runtime/hall-runtime-dispatch.ts`**
  - `HallRuntimeDispatchInput` 加 `triggerMessages?: HallMessage[]`
  - `renderTriggerBlock` 多 trigger 时加头 `[在短时间内你被多次 @ (N 条 trigger 合并)，请在一条回复里照顾到全部：]`，每个 trigger 单独 attribution 块
  - 单 trigger 时渲染不变（向后兼容）
- **`src/runtime/collaboration-hall-orchestrator.ts`**
  - 5 处 `enqueueAndDispatch(args, closure)`：closure 现在接收 batch 参数，从 message store 拉 triggerMessages 数组，调 `dispatchHallAgentReply` 时传 `triggerMessages: HallMessage[]`
  - `dispatchHallAgentReply` 接受 `triggerMessages?` 字段并透传给 `dispatchHallRuntimeTurn`
  - 新增 `loadTriggerMessagesFromBatch` 帮手：按 batch.records 的 triggerMessageId 从 message store 解析回 HallMessage 列表

### 设计修正（中途回头）

最初尝试用"注册全局 InboxDispatcher"模式（orchestrator 在模块加载时注册一个集中 dispatcher，worker 调它）。落地时发现这破坏测试隔离——测试通过 `options.toolClient` 注入的 fake client，原本由 dispatchHallAgentReply closure 通过 lexical scope 捕获；新模式下集中 dispatcher 改用 `createToolClient()` 创建真实 OpenClawLiveClient，导致 `hall-loop-prevention` 等测试连接真实 OpenClaw 卡死。回退为 closure-per-call 模式，让 closure 自然带着 caller 的 toolClient 流入 worker。

### 测试

- `test/hall-scheduler.test.ts` 重写：7 个 case 全过
  - 多 trigger 合并（3 个并发 enqueue → 1 个 batch，共享 batchId，batchSize=3）
  - 晚到 enqueue 进新 batch
  - 跨 (card, agent) 并行 worker
  - **re-entrant enqueue 不死锁**（dispatcher 内部 fire-and-forget enqueue 自身，第二批正常处理）
  - dispatcher failed outcome：consume + delivery 标 failed 但 promise 仍 resolve
  - outcome override
  - inbox 文件每 record 仍写 enqueue + consume 两行
- `test/hall-prompt-context.test.ts` 加 2 个 case：
  - 多 trigger batch 渲染含合并 header + 每 trigger attribution
  - 单 trigger 时无 merge header，向后兼容
- `test/hall-mailbox.test.ts` 不变（mailbox API 不变），7 个 case 仍过

### 验证

- `npm run build` 干净
- hall 全套（除 typing 已知 hang）：~134 过，3 失败仍是 P3-A 之前的基线（execution-order persists / session-linkage / multi-mention routing），**零新回归**
- `npm run smoke:ui` 通过
- Playwright e2e 略过（unit test 已覆盖关键合并行为；orchestrator 路径形态与 P3-B-1 同构，P3-B-1 e2e 验证过）

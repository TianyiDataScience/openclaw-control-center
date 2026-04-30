# Task Plan: Phase 3 Hall Scheduling Engine

## Goal
从根本上解决 Issue #9（origin: xiaolinfrank/openclaw-control-center）第 1/2/3/4 项——上下文构建、共享 task_plan/findings/progress、多智能体通信。引擎三件套：Blackboard + Mailbox + Policy。

## Confirmed Decisions
- 黑板写一致性 → **追加协议 + agent 写自己块，工具兜底**
- inbox 存储 → **文件 append-only + 内存索引**

## Phases

### Phase 0 — Issue 评论 + 文档落地 (complete)
- [x] 后台 agent 把设计方案评论到 issue #9（comment 4323964598）
- [x] 创建 task_plan.md / findings.md
- [x] 追加 progress.md 一节，记录 Phase 3 启动

### Phase P3-A — Blackboard 落地 (complete, PR #12)

**PR**: https://github.com/xiaolinfrank/openclaw-control-center/pull/12
**Branch**: `feat/hall-blackboard-p3a` (commit `ea00bc9`)

工作项进度：
- [x] 1-2. 新增 `src/runtime/hall-blackboard.ts`：`initializeHallBlackboard` / `appendHallBlackboardMessage` / `readHallProgressLatestEntry` / `renderHallBlackboardPromptGuidance`
- [x] 3. 写路径接入 orchestrator：`appendPersistedHallMessage` / `appendStreamedGeneratedHallMessage` / `postHallMessage` 都 fire-and-forget 调 `appendHallBlackboardMessage`
- [x] 4. 三份 stub（task_plan / findings / progress）：在 orchestrator postHallMessage 处 `await initializeHallBlackboard`；dispatch 路径 fire-and-forget（避免 await 影响 fake-client 测试时序）
- [x] 5. 追加协议引导文本：`renderHallBlackboardPromptGuidance` 中文/英文双版本，告知 agent 用 `<!-- agent: X, ts: Y -->` 包裹自己的块，只追加不覆盖
- [x] 6. 砍 inline context：`HALL_INLINE_CONTEXT_DEFAULT=5` / `HALL_INLINE_CONTEXT_FIRST_TURN=15`，30→5/15
- [x] 7. prompt 里加引导文本：blackboardGuidance 插入到 workspace 段后
- [ ] 8. orchestrator 回填 latestSummary（推迟到 P3-A 跟进 PR；不阻塞主功能）
- [x] 9. 黑板单元测试 6 个：init / 幂等 / append / 去重 / readLatest / guidance 渲染——全过

退出标准：
- [x] `npm run build` 干净
- [x] hall 相关 13 个测试文件，102 测试，99 过 3 fail（3 fail 全是 P3-A 之前就存在的：execution-order persists, session-linkage, multi-mention routing；与 P3-A 无关，已记录在 follow-ups）
- [x] `npm run smoke:ui` 通过
- [x] 手测：在 hall 真机发一条消息验证。**发现两个 bug 并修复**（详见 progress.md "手测 + 现场修两个 bug"）：
  - Bug 1：operator task 消息没进黑板（task 创建路径走 `createHallTaskFromOperatorRequest` 不是 `postHallMessage`，P3-A 漏接）
  - Bug 2：status 消息里塞着 base64 tool I/O 让 chat.jsonl 不可读（写黑板前用 `sanitizeMessageForBlackboard` 剥离 `|~base64...` 段）
- [x] Playwright 真机 e2e：三 agent 接力任务（图灵 → 林纳斯 → 阿达）跑通；又抓了一个 sanitizer 边角 case（summary 含 `]`）并修复（详见 progress.md）

### Lessons learned during P3-A

1. `await initializeHallBlackboard` 在 `dispatchHallRuntimeTurn` 里会把 artifact-refs 测试搞挂——单跑通过、批量跑失败。猜测：额外的 `await` 改变了 microtask 排程，让 `assignHallTaskExecution` 的返回时序与 `FakeRuntimeToolClient` queue 出现微小竞争。改成 `void initializeHallBlackboard(...).catch(() => undefined)` 后零回归。教训：**dispatch 主路径上的"best-effort 副作用"应该 fire-and-forget**，不要 `await`，避免影响测试时序与生产延迟。
2. `HALL_WORKSPACES_DIR` 在模块导入时就 capture 了 `process.cwd()`，所以测试里 `process.chdir(tmpdir)` 不生效。最终改成用真实路径 + 测后 `rm -rf` 清理。如果将来要支持运行时配置，这是个独立 refactor 项（不在 P3-A scope）。

### Phase P3-B — Mailbox 改造（**paused on parallel branch**）

**Design issue**: https://github.com/xiaolinfrank/openclaw-control-center/issues/13
**Branch**: `feat/hall-mailbox-p3b1`（PR #14 — depends on #12）

> ⚠️ **2026-04-30 暂停**：P3-B-1 inbox 透明层已经 ship 到 PR #14，跟 owner review 时引出两个新议题——
> 1. issue #13 P3-C-2 的 `dedupRecentDispatch` 设计有缺陷（按时间窗 silence 会误伤独立请求），已在 issue #13 评论修正为 `dropResolvedTriggers`（看 agent 已说过的话决定是否冗余）
> 2. 当前每次 dispatch 都重发完整 prompt（10K tokens 的 identity / persona / hall rules / roster / 5 条 inline transcript 等），LLM 端 session 累积重复 → 大量 token 浪费
>
> 决定先开 **P3-A-2** 把上下文管理彻底交给 OpenClaw session + 黑板（首轮发 setup，后续轮只发 trigger，agent 想看群聊用 grep 黑板），从根上消除 prompt 冗余。这是 P3-A 黑板的延伸优化，正好以黑板为基础设施。
>
> **🔁 P3-A-2 ship 之后回来**：
> - `git checkout feat/hall-mailbox-p3b1`
> - rebase 到合并后的 main（吸收 P3-A-2 的 prompt 简化）
> - 继续 **P3-B-2**（750ms 防抖合并 + worker queue）
> - 再做 **P3-C 系列**（policy chain + dropResolvedTriggers + supervisor）

P3-A 落地后，Phase 3 的剩余架构层工作（解决 issue #9 第 4 项 + 把 A1-A4 反循环兜底降级为可插拔 policy）已在 origin issue #13 完整设计：
- Mailbox：每个 (card, agent) 一个 inbox（文件 append-only + 内存索引），InboxWorker 750ms 防抖窗合并多对一通信
- Policy chain：A1-A4 抽成纯函数，新增 `detectClarifyingQuestion`（识别合法反向 Q&A 主动放行）+ `enforceBackPingBudget`（限制每对每轮反 ping 次数）+ `dropResolvedTriggers`（看 agent 已说过的话决定是否冗余）
- Supervisor：崩溃重启从 inbox 未消费位点继续，escalate → 标 needs_human_review 等人

拆 PR 计划：~~P3-B-1 inbox 层~~（PR #14 已开） → **P3-A-2 prompt 简化** → P3-B-2 防抖合并 → P3-C-1 policy 抽取（不变行为）→ P3-C-2 新 policy 上线（含 `dropResolvedTriggers`）→ P3-C-3 Supervisor。每步独立可发版。

### Phase P3-A-2 — 上下文交给 OpenClaw + 黑板（**current focus**）

**Design issue**: https://github.com/xiaolinfrank/openclaw-control-center/issues/15
**Branch**: `feat/hall-context-delegation-p3a2`（基于 `feat/hall-blackboard-p3a`，PR 标 depends on #12）

#### 动机

review PR #14 时发现：当前每次 dispatch 都重发完整 ~10K prompt（identity / persona / hall rules / roster / 5 条 inline transcript 等），LLM 端的 OpenClaw session 累积下来全是重复内容。10 轮对话累计 ~100K，长聊容易爆窗口 + 烧钱。

P3-A 黑板（chat.jsonl + task_plan/findings/progress 共享 markdown）已经为这个简化做好了基础设施。**直接把上下文管理交给 OpenClaw + 黑板**：
- OpenClaw session 自己负责持久化 agent 历史（system + 之前 turn 的 messages）
- 黑板自己负责持久化群聊全貌（`.hall/chat.jsonl`）
- orchestrator 不再"curate" 上下文塞进 prompt

#### 简化后的 prompt 形状

**首轮**（`(card, agent)` 第一次进 session）：

```
你是 X，参与一个叫"协作大厅"的群聊。

[群聊意识]
- 这个线程里有人类 operator 和多个 AI agent 同时活动
- 你的消息只会在被 @ 时（或 main 作为 observer 时）触发——但群里其他人**一直在说话，没 @ 你时你也看不到**
- 想看群聊全貌：bash `cat .hall/chat.jsonl | jq -c .`，或 `grep "@林纳斯" .hall/chat.jsonl`
- 想看共享决策：cat task_plan.md / findings.md / progress.md
- 写共享 markdown 时用 `<!-- agent: <id>, ts: <iso> -->` 包裹自己的块，只追加，别覆盖别人

[工作目录] runtime/hall-workspaces/{cardId}/
[花名册] @图灵(PM) / @林纳斯(系统开发) / @阿达(数据科学家) / ...
[行为指令] 不 fake data / OBSERVE_SILENT 沉默 / @ 真名调起同事 / role-instruction
[A1] 完成后 @<originalAssigner> 汇报（如有）

[这次的触发]
[from: operator] @林纳斯 用一句话讲 idempotent。
```

**后续轮**（同 `(card, agent)` session 已存在），只发：

```
[from: 图灵 Turing (PM)] @林纳斯 你举一个软件开发里的 idempotent 例子。
```

——没 inline transcript / 没重塞 hall rules / 没重塞 roster。OpenClaw session 自己持久化历史；agent 想看其他人说什么——`grep` 黑板。

#### 工作项

- [ ] 1. `hall-runtime-dispatch.ts:706 buildHallRuntimePrompt` 拆成 `buildFirstTurnSetupPrompt` + `buildSubsequentTurnTriggerPrompt`
- [ ] 2. 删除 inline transcript 段（`recentMessages.slice(-inlineCap)` 这块）
- [ ] 3. `loadRecentHallThreadMessages` 在 dispatch 路径上不再调用（可能 observer 的 OBSERVE_SILENT 决策仍用，但不进 prompt）
- [ ] 4. `renderHallBlackboardPromptGuidance` 强化"群聊意识"段——明确告诉 agent "别人说话你看不到，想看自己 grep"
- [ ] 5. observer 的 trigger 改成 `[mode: observer] 阅读 .hall/chat.jsonl 末尾几条，决定是否补充。没补的回 OBSERVE_SILENT。`
- [ ] 6. trigger 渲染加作者归属：`[from: <author label / role>] <content>`
- [ ] 7. A1 originalAssigner 提示从 prompt 段降级为 trigger 前缀的 `[note: 完成后 @ X 汇报]` 一行
- [ ] 8. 新增/改动测试：首轮 prompt 含 setup 段、后续轮只含 trigger、trigger 含作者归属、observer 触发文案、blackboard guidance 含群聊意识

#### 退出标准

- [ ] `npm run build` 干净
- [ ] hall 全套测试零回归（基线 3 失败仍 3 失败）
- [ ] `npm run smoke:ui` 通过
- [ ] Playwright 真机：跑一条 5+ 轮对话，对比 OpenClaw session 文件大小（应明显小于 P3-A 时期）；对比单次 dispatch 的 prompt token 数（首轮 ~6K，后续 ~500）
- [ ] 观察 agent 行为：是否仍能正确感知群聊（被 @ 时回复正常 + 未被 @ 但需要历史时主动 grep 黑板）

#### 风险

1. **OpenClaw session 真的能保留首轮内容吗**——如果 OpenClaw 内部对 session 做激进压缩，首轮的 hall rules / 身份段可能消失。**对策**：观察 e2e 行为，若 agent 出现"忘记是群聊"或"开始 hallucinate roster"的迹象，再补救（要么加 sticky reminder 段、要么重发部分稳定段）
2. **agent 不会 grep 黑板**——LLM 可能不主动用 bash 查历史。**对策**：群聊意识段的引导要明确（已有黑板 guidance 模板，强化即可），并通过 e2e 真机观察行为
3. **session 失效或被重置**——OpenClaw session 端可能 expire / be evicted。**对策**：dispatch 路径检测 session 是否存在；不存在时退化为 first-turn setup（已有 `firstParticipantTurnInThread` 判定逻辑可复用）

## Files to Modify (P3-A Working Set)
- `src/runtime/hall-workspace.ts`（扩展 ensureHallTaskWorkspace）
- `src/runtime/hall-blackboard.ts`（新增）
- `src/runtime/collaboration-hall-orchestrator.ts`（写路径调用 + latestSummary 回填）
- `src/runtime/hall-runtime-dispatch.ts`（buildHallRuntimePrompt context cap，prompt 引导文本）
- `src/types.ts`（如需新增类型）
- `test/hall-blackboard.test.ts`（新增）

## Hard Constraints to Preserve
1. `taskCardWriteChain` / `hallMessageWriteChain` 序列化（collaboration-hall-store.ts:372/555）
2. `dispatchChains` per-sessionKey gate（hall-runtime-dispatch.ts:201）
3. Audit log append-only（operation-audit.ts）
4. SSE event stream contract（collaboration-stream.ts）
5. A1–A4 行为不变（P3-A 不动 policy）
6. 30s 重复消息 dedup（hall-orchestrator:719）

## Risks
- 写黑板和写 JSON store 双写：必须 best-effort 异步、不阻塞主路径，且写失败不能让消息丢失（JSON 是权威源）
- prompt 砍 30→5 可能让 agent 上下文不足：保留首轮 15 条 + 给 grep 工具兜底
- workspace 目录已经被 agent 当 workdir 用：`.hall/` 加点防误删（README 标注 + 把 agent prompt 引导排除 .hall/ 写）

## Errors Encountered
（开工后填）

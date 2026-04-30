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

### Phase P3-C-1 — A1-A4 抽成可插拔 policy 函数（**current focus**, 2026-04-30）

**Design issue**: https://github.com/xiaolinfrank/openclaw-control-center/issues/13
**Branch**: `feat/hall-policy-chain-p3c1`（基于已合并的 main，含 P3-A / P3-A-2 / P3-B-1 / P3-B-2）

#### 动机

A1-A4 反循环兜底当前散落在 `collaboration-hall-orchestrator.ts` 的 inline 检查里：A1+A2-reset 在 `routeAndDispatchHallMessage` 顶部、A2-increment+limit 在 `dispatchHallAgentReply` per-target gate、A3 在两处 chain candidate filter（observer + auto-chain）、A4 在三处 silence check（observer + per-target + wake-mention initiator）。要再加新 policy（`dropResolvedTriggers` / `detectClarifyingQuestion` / `enforceBackPingBudget`）就得继续往这些位置塞 if 块，无组合性、难单测。

P3-C-1 把这层抽成两条 policy 链：
- `PreDispatchPolicy[]`（per-target gate / chain filter 用）—— 顺序执行，第一个 deny 短路；带 `policyId` 让 caller 区分该不该跑对应侧效
- `PostDispatchPolicy[]`（agent reply 后用）—— 顺序执行，第一个 drop 短路

行为完全不变；P3-C-2 直接往链里加新 policy。

#### 工作项

- [x] 1. 新建 `src/runtime/hall-policies.ts`：types + 4 个 policy 纯函数 + 默认链组合 + 链 runner + 状态帮手
- [x] 2. `collaboration-hall-orchestrator.ts` 全部 A1-A4 inline 检查替换成链调用，常量从 `hall-policies` 导入
- [x] 3. `test/hall-policies.test.ts` 38 个 case
- [x] 4. `npm run build` 干净
- [x] 5. 全套测试零回归（基线 3 失败仍是 P3-A 之前的）

#### 退出标准

- [x] tsc 干净
- [x] policy 单测全过
- [x] hall 全套零回归
- [ ] PR 入 main

#### 设计 trade-offs

- **policyId 字符串 vs symbol vs class**：选字符串常量（`POLICY_ENFORCE_AUTO_ROUND_LIMIT` 等）。简单、可测试、跨模块边界稳定（symbol 不能跨进程）
- **侧效绑在 caller 还是 policy**：选 caller。policy 是纯函数（更易测、更易组合），caller 通过 `policyId` 分发侧效。代价是新增有侧效 policy 时 caller 要加 case；但 P3-C 的预期 policy 大多是 silent deny（filter 候选），只有 A2 是有侧效的特殊情况
- **per-target gate vs chain filter 用同一条链 vs 不同链**：选不同链。per-target gate 跑 A2-limit（已 increment，主战场）；chain filter 跑 max-depth + A3（未 increment）。共用同一条链会让 A2 在 chain filter 处误删候选而错过 auto-round-blocked 通知
- **保留 `if (chainDepth < MAX_AUTO_CHAIN_DEPTH)` 外层早出**：保留。chain filter 内部也会因 max-depth 把所有候选 deny 掉，但外层早出避免白白 `loadRecentHallThreadMessages` + 构建候选

### Phase P3-B-2 — 防抖合并 + worker queue（completed, PR #17 merged 2026-04-30）

**Design issue**: https://github.com/xiaolinfrank/openclaw-control-center/issues/13
**Branch**: `feat/hall-mailbox-debounce-p3b2`（基于合并后的 `main`，已包含 P3-A / P3-B-1 / P3-A-2）

#### 动机

P3-B-1 的 `enqueueAndDispatch(args, dispatch)` 是**透明加层**——只做 audit log，dispatch 仍同步 await。这无法解决 issue #9 第 4 项的核心场景：多个 agent 在短时间内 @ 同一目标 → 应该一次合并 dispatch，而不是 N 次。

P3-B-2 把 inbox 真正变成异步 worker pump：enqueue 持久化 + signal worker，立即返回（fire-and-forget）；worker 750ms 防抖后批量 dispatch。

#### 架构

```
enqueueHallInbox(record)
  ├─ append enqueue 行到 inbox/{agent}.jsonl
  ├─ signal worker (cardId, agentId)
  └─ 返回 Promise<void>  ← resolve 时机 = 包含该 record 的批次 dispatch 完成

InboxWorker(cardId, agentId) tick:
  1. 等 750ms 防抖窗（每来新 enqueue 就 reset）
  2. 窗稳定 → 原子读所有 pending records
  3. 合并成单次 dispatch input（多个 triggerMessages）
  4. 调注册的 dispatcher 回调
  5. 全部 records 标 consumed + 写 deliveries（按 batch 共享 batchId）
  6. resolve 这批 records 的 enqueue Promise
```

**关键 invariant**：enqueue 的 promise resolve 时机 = 它所在 batch dispatch 完成。这样 `Promise.allSettled([...enqueues])` 语义保留——observer 仍能"等 primary 全完后再 run"。

#### 死锁规避

之前 P3-B-1 设计放弃 worker 是因为 cyclic enqueue 死锁。P3-B-2 通过两点解决：
1. **fire-and-forget enqueue**：enqueue 返回的 promise 不阻塞 worker 自身的循环；worker 永远不会 `await someEnqueue()`
2. **buffer 而非 await 单条**：worker 不会"等下一个 dispatch 完成再继续"——它收 batch，dispatch，标 consumed，进入下一个防抖窗。即使 dispatch 内部触发 chain enqueue 到本 worker，也只是排进 pending；worker 在当前 batch 完成后自然处理

A→B→C→A 链：A 的 worker dispatch 到 A 的 reply 含 @B → B 的 worker enqueue → B dispatch reply 含 @C → C enqueue → C dispatch reply 含 @A → A 的 worker pending 多一条 → 在当前 batch 结束后 worker 自然处理（不形成 await 环）。

#### Prompt 渲染改动

`buildSubsequentTurnTriggerPrompt` 支持 trigger batch。单条时跟现在一样：
```
[来自 Operator]
@林纳斯 用一句话讲 idempotent
```

多条时（同 batch 合并）：
```
[在短时间内你被多次 @：]

[来自 Operator]
@林纳斯 用一句话讲 idempotent

[来自 图灵 Turing (PM)]
@林纳斯 你举一个例子
```

让 agent 自己读 prompt 决定是分别回还是合并回。

#### 工作项

- [ ] 1. 重构 `hall-mailbox.ts`：补 `markHallInboxConsumedBatch(records)` + `appendHallDeliveryRecord(batchId)` 字段
- [ ] 2. 重写 `hall-scheduler.ts`：
  - `enqueueHallInbox(args): Promise<void>`：persist + signal worker，promise 在 batch 完成时 resolve
  - `registerInboxDispatcher(fn)`：orchestrator 启动时注册回调
  - `InboxWorker` 内部状态：per-(cardId, agentId) 防抖窗 timer + pending records 队列 + active promise resolvers
  - debounce 窗 750ms（可配 env: `HALL_INBOX_DEBOUNCE_MS`）
- [ ] 3. 改 `dispatchHallAgentReply`：接受 `triggerMessages: HallMessage[]` 数组（保留 `triggerMessage` 单字段向后兼容；新路径走数组）
- [ ] 4. 改 `buildSubsequentTurnTriggerPrompt`：支持多 trigger 渲染
- [ ] 5. 改 orchestrator 路由：原 `enqueueAndDispatch(args, () => dispatchHallAgentReply(...))` → `enqueueHallInbox(args)` + 在 dispatcher 回调里跑 dispatchHallAgentReply
- [ ] 6. 改 P3-B-1 测试：`hall-mailbox.test.ts` / `hall-scheduler.test.ts` 适配新 API
- [ ] 7. 新增测试：批合并 / 防抖窗 reset / cyclic enqueue 不死锁 / observer 时机保留
- [ ] 8. e2e：playwright 多 agent 同时 @ 同目标 → 看 inbox 一次合并 dispatch + prompt 渲染多 trigger

#### 退出标准

- [ ] `npm run build` 干净
- [ ] hall 全套零回归
- [ ] `npm run smoke:ui` 通过
- [ ] Playwright 真机：触发多 @ 场景，黑板里看到一次 dispatch 包含 N 个 triggers 的 prompt

#### 风险

- **observer 时机依赖**：必须保留 enqueue 的"完成 promise"语义；否则 `Promise.allSettled([primary])` 立即返回，observer 在 primary 还没派之前就跑了。**对策**：`enqueueHallInbox` 返回的 promise 严格等到本 batch dispatch 完才 resolve
- **debounce 窗大小**：750ms 太短可能错过合并机会，太长拖慢响应。issue #13 推荐 750ms，先跑这个值，e2e 看效果再调
- **重启恢复**：worker 内部状态（pending、timer）是内存的；进程重启时丢失 timer 但 inbox 文件里的 enqueue 行仍在。**对策**：worker 启动时（或首次 enqueue 时）从 inbox 文件 hydrate pending；timer 立即触发（视作"窗已超时"）

### Phase P3-A-2 — 上下文交给 OpenClaw + 黑板（completed, PR #16 merged 2026-04-30）

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

#### Phase P3-B-1 — Inbox transparent layer (current)

**Branch**: `feat/hall-mailbox-p3b1`（基于 `feat/hall-blackboard-p3a`，PR 标 depends on #12）

范围：**透明加一层 inbox，不改 dispatch 行为，不做合并**——为 P3-B-2/3-C 打地基。

工作项：
- [ ] 1. 新增 `src/runtime/hall-mailbox.ts`：
  - 文件：`{card}/.hall/inbox/{agentId}.jsonl`（log-structured：enqueue 行 + consume 行混存，读时 reduce）
  - 文件：`{card}/.hall/deliveries.jsonl`（投递审计日志）
  - 内存索引：`Map<"${cardId}:${agentId}", MailboxIndex>`，首次访问 lazy hydrate
  - API：`enqueueHallInbox` / `readHallInboxPending` / `markHallInboxConsumed` / `appendHallDeliveryRecord`
  - 模块级 mutex：per-(card, agent) 写串行化
- [ ] 2. 新增 `src/runtime/hall-scheduler.ts`（**简化版** — 见下方"设计修正"）：
  - 暴露 `enqueueAndDispatch(args, dispatch: () => Promise<void>)`
  - 流程：persist enqueue → 调 `dispatch()`（现有 `dispatchChains` 已提供 per-sessionKey 序列化）→ persist consume + delivery
  - **不引入 per-(card, agent) queue / worker scaffold**——避免 cyclic enqueue 死锁（A→B→C→A 链，A 的 worker await PB await PC await PA enqueue waiting for A worker 形成环）。queue/worker 留给 P3-B-2，与 defounce/merge 一起设计
- [ ] 3. 接入 `collaboration-hall-orchestrator.ts`：
  - `routeAndDispatchHallMessage` 解析 targets 后改成对每个 target enqueue + scheduleInboxTick
  - `dispatchHallAgentReply` 内部仍直接调 `dispatchHallRuntimeTurn`（被 worker 调用）
  - auto-chain 路径同样改成 enqueue 而非直接 dispatch
  - **A1-A4 行为不变**：filter / autoRounds / OBSERVE_SILENT 仍在调 enqueue 之前生效（policy 抽函数留给 P3-C-1）
- [ ] 4. 单元测试：
  - `test/hall-mailbox.test.ts`：enqueue / read pending / markConsumed / 重启恢复 / 去重 / log-structured reduce
  - `test/hall-scheduler.test.ts`：enqueueAndDispatch 调用顺序、consume + delivery 写入、dispatch 失败时的 outcome 标记
- [ ] 5. build / 全测试 / smoke / Playwright e2e（多 agent 接力，验证 inbox 文件确实生成）
- [ ] 6. commit + push + 开 PR（描述里标 depends on #12）+ 更新 progress.md

退出标准：
- [ ] `npm run build` 干净
- [ ] hall 13 个测试文件不 regress（P3-A 之前已存在的 3 fail 仍是 fail，不变）
- [ ] `npm run smoke:hall` 通过
- [ ] Playwright 真机：发一条多 @ 消息，确认 `inbox/{agentId}.jsonl` 文件生成 + 每条 dispatch 落 `deliveries.jsonl`
- [ ] 黑板路径不 regress（chat.jsonl / task_plan.md / findings.md / progress.md 仍然写）

## Files to Modify (P3-B-1 Working Set)
- `src/runtime/hall-mailbox.ts`（新增）
- `src/runtime/hall-scheduler.ts`（新增）
- `src/runtime/collaboration-hall-orchestrator.ts`（路由路径改 enqueue + scheduleInboxTick）
- `test/hall-mailbox.test.ts`（新增）
- `test/hall-scheduler.test.ts`（新增）
- `progress.md`（追加 session 记录）

## Hard Constraints to Preserve
1. `taskCardWriteChain` / `hallMessageWriteChain` 序列化（collaboration-hall-store.ts:372/555）
2. `dispatchChains` per-sessionKey gate（hall-runtime-dispatch.ts:201）—— **P3-B-1 保留**作为兜底
3. Audit log append-only（operation-audit.ts）
4. SSE event stream contract（collaboration-stream.ts）
5. **A1–A4 行为不变**（P3-B-1 不动 policy）
6. 30s 重复消息 dedup（hall-orchestrator:719）
7. P3-A 黑板路径不 regress（chat.jsonl / 三 markdown 仍写）

## Risks (P3-B-1)
- **路由路径改写**：`routeAndDispatchHallMessage` / `dispatchHallAgentReply` 内 auto-chain / `dispatchMainObserver` 三处接入点。**对策**：保留所有现有 policy 调用顺序、保留 `dispatchHallAgentReply` 内部结构，只把"调用 dispatch 那一行"包成 `enqueueAndDispatch`
- **fire-and-forget 副作用顺序敏感**（P3-A 教训）：mailbox 写入应 fire-and-forget 不阻塞 dispatch 主路径；本 PR 把 enqueue 写做 await 但 catch 错误（写失败不能让 dispatch 中断），下个 PR 视性能再调
- **重启恢复**：P3-B-1 inbox 文件持久化但**不**做重启 replay——pending 记录留在文件里供 audit / 后续 P3-C-3 Supervisor 拉起；本 PR 不丢消息（chat.jsonl 仍是权威源）
- **设计修正**：原本设计 per-(card, agent) worker queue，发现 cyclic enqueue（A↔B↔C 链 + MAX_AUTO_CHAIN_DEPTH=5）会让 worker 在 await chain 子任务时被 chain 子任务的 enqueue 反向 block，形成依赖环死锁。决定 P3-B-1 不引入 queue/worker，等 P3-B-2 引入 defounce 时一起处理（届时 enqueue 不再 await 单条 dispatch 完成，而是 buffer 后批处理，自然不会有依赖环）

## Errors Encountered
（开工后填）

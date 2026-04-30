# 协作大厅架构（Hall Architecture）

本文是协作大厅（Collaboration Hall）当前实现的整体说明。读完之后你应该能回答：

- 一条 operator 消息进入大厅之后会经历什么
- 黑板 / 信箱 / 策略链 各自负责什么
- 哪些是硬不变量，哪些是 tunable
- 后续开发的方向

> 历史包袱：旧实现是「workflow 机器」，任务卡有 `discussion / execution / review / blocked / completed` 五态阶段机器，speaker 由调度器决定。这套已在 Phase A（2026-04-17）整体下线。当前实现是「自治群聊」——agent 像 Claude Code 一样，被 @ 才说话。

## 三件套

整体架构是三层基础设施叠加：

```
       operator post
            │
            ▼
   ┌──────────────────┐    ① 写黑板（chat.jsonl + 三件套 markdown）
   │   黑板 Blackboard │    每条消息都 append；agent 想看群聊就 grep
   └──────────────────┘
            │
            ▼
   ┌──────────────────┐    ② 入队信箱
   │  信箱 Mailbox     │    per-(card, agent) 一个 inbox 文件
   │  + Scheduler     │    750ms 防抖窗合并多个 trigger，一次 dispatch
   └──────────────────┘
            │
            ▼
   ┌──────────────────┐    ③ 策略链评估
   │  策略 Policy chain │    pre-dispatch（allow / force-allow / deny）
   │                  │    post-dispatch（keep / drop）
   └──────────────────┘
            │
            ▼
       OpenClaw runtime
            │
            ▼
       agent reply
            │
            ▼
   持久化 + auto-chain（解析 reply 里的 @）
```

### 1. 黑板（Blackboard, P3-A + P3-A-2）

每张任务卡有自己的工作目录 `runtime/hall-workspaces/{cardId}/`，里面常驻：

- **`.hall/chat.jsonl`** —— 群聊全貌的事实唯一来源。每条消息（agent / operator / observer）都 append 一行 JSON
- **`task_plan.md` / `findings.md` / `progress.md`** —— 共享决策、研究、进度。每个 agent 写自己的块，约定用 `<!-- agent: X, ts: Y -->` 包裹，**只追加不覆盖**别人的内容
- **`.hall/inbox/{agent}.jsonl` + `.hall/deliveries.jsonl`** —— 信箱层用（见下）

**关键架构变化（P3-A-2）**：orchestrator **不再 curate 上下文塞进 prompt**。

- 首轮 dispatch（一对 (card, agent) 第一次进 OpenClaw session）：发完整的 setup prompt——身份 + 群聊意识段 + 花名册 + 工作目录指针 + 触发内容
- 后续轮 dispatch（同 (card, agent) session 已存在）：**只发触发内容本身**

agent 想看群聊就 `cat .hall/chat.jsonl | jq -c .` 或 `grep "@林纳斯" .hall/chat.jsonl`；想看共享决策就 `cat task_plan.md`。OpenClaw session 自己持久化 agent 自己的对话历史，不需要 orchestrator 重塞。

效果：单次 dispatch 的 prompt 从 ~10K tokens 降到首轮 ~6K、后续 ~500，session 端不再累积重复，长聊不爆窗口。

### 2. 信箱（Mailbox + Scheduler, P3-B-1 + P3-B-2）

每个 (任务卡, 目标 agent) 对应一个独立的 inbox，干两件事：

#### 审计透明（P3-B-1）

- 每次 enqueue 写一行入队记录到 `inbox/{agent}.jsonl`
- 每次 dispatch 完成写一行 delivery 记录到 `.hall/deliveries.jsonl`（含 outcome / reason / batchId / batchSize）
- 文件 append-only + 内存索引，重启可重建

出问题能从 inbox/deliveries 复盘整个调度过程。

#### 防抖合并（P3-B-2）

每个 (任务卡, 目标 agent) 在内存里有一个独立的 worker，按以下流程工作：

1. 调用方 `enqueueAndDispatch(args, dispatch_closure)`：立即写入队行 → 触发 worker → 返回一个 Promise
2. Worker 等 750ms 防抖窗。期间所有新 enqueue 都进同一个 batch（每来一个新 enqueue 都重置窗）
3. 窗稳定后，worker 原子读所有 pending records，调 batch 第一个的 `dispatch_closure`，把整个合并的 trigger 列表传给它
4. closure 调 `dispatchHallAgentReply` 完成实际 dispatch；prompt 渲染时给 agent 看到「你被多次 @（N 条 trigger 合并），请在一条回复里照顾全部」
5. dispatch 完成后，worker 把整个 batch 的 records 标 consumed，写 deliveries（共享 `batchId`），resolve 所有 enqueue Promise

**关键 invariant**：enqueue 返回的 Promise resolve 时机 = **它所在 batch 的 dispatch 完成**。这样 `Promise.allSettled([...primary enqueues])` 语义保留——observer 仍能等所有 primary 全完后再跑。

**死锁规避**：worker 自身从不 `await` 任何 enqueue 的 Promise；A→B→C→A 链里 A 的 worker 在当前 batch 完成后才看下一窗，cyclic enqueue 只是排进 pending，不形成依赖环。

效果：「operator 一条消息里 @图灵 + @林纳斯，图灵在回复里又 @林纳斯」这类多 trigger 几乎同时落到林纳斯的场景，林纳斯只被 dispatch **一次**，回一条复合答复。

### 3. 策略链（Policy Chain, P3-C-1 + P3-C-2）

A1-A4 反循环兜底原本散落在 orchestrator 的 inline `if` 里。P3-C-1 抽成两条策略链——**纯函数 + 短路 verdict**——P3-C-2 加三条新 policy。

#### Verdict 三态 + 短路

**Pre-dispatch 链**（agent 被 dispatch *之前*）：

| Verdict | 含义 |
|---------|------|
| `allow` | 这条 policy 没意见，继续看下一条 |
| `force-allow` | 显式放行，**短路**链，跳过下游所有 policy |
| `deny` | 拒绝 dispatch，**短路**链，附带 `policyId` 和 `reason` |

**Post-dispatch 链**（agent reply 落盘 *之前*）：`keep` / `drop`，第一个 `drop` 短路。

`force-allow` 和 `deny` 一样会终止链，区别只在 caller 怎么看：caller 把 `allow` 和 `force-allow` 都视作「继续 dispatch」，看 `policyId` 知道是哪条 policy 在主张。

#### 默认链组合

策略**顺序**精心设计成「硬上限 → 软放行 → 软拦截 → 兜底」。Per-target gate 链（agent 即将进入 dispatch 时）：

| 顺序 | 策略 | 类型 | 含义 |
|------|------|------|------|
| 1 | `enforceAutoRoundLimit` | A2 硬上限 | (任务卡, agent) 一轮内被 dispatch 次数 ≥ 6 → deny + 触发 `handleAutoRoundBlockedThreshold` 通知 |
| 2 | `enforceMaxAutoChainDepth` | 硬上限 | auto-chain 深度 > 5 → deny |
| 3 | `detectClarifyingQuestion` | force-allow | trigger 看起来像真问题（？/吗/还是/英文 interrogative）→ override 下游 |
| 4 | `dropResolvedTriggers` | 软拦截 | 候选 agent 最近一条 reply 已经回答过 trigger（token-overlap ≥ 60%）→ silence |
| 5 | `enforceBackPingBudget` | 软拦截 | 同一 (B→A) 一轮内已反 ping 过 1 次 → silence 第 2 次 |
| 6 | `excludeTriggerAuthor` | A3 兜底 | 候选 == trigger author → silence（防 ping-pong） |

Chain-filter 链（auto-chain 的候选过滤时）同序去掉 A2（A2 在这里计数器还没 increment，会误删）。

Post-dispatch 链：

| 策略 | 含义 |
|------|------|
| `observeSilentMarker` | A4 —— agent 回 `OBSERVE_SILENT` 或空内容 → drop（不持久化、不触发下游） |

#### 状态帮手

链的输入是只读的 task card / participant / hall / triggerMessage / recentThreadMessages。状态变更（A1 seed originalAssigner、A2 reset 计数器、A2 increment 计数器）由 caller 调专门的 helper 完成，policy 本身保持纯函数：

- `buildOperatorTurnStatePatch(taskCard, triggerAuthor)` —— operator 触发新一轮时，构造 task card 的更新 patch（A1 seed + A2 reset 合并）
- `incrementAutoRoundCounter(taskCard, participant)` —— per-(card, agent) 计数器 +1，返回新的 rounds 对象（不可变）

## 一条消息的完整生命周期

举例：operator 发 `@图灵 用一句话讲 idempotent。@林纳斯 你举一个软件开发的例子。`

```
1. routeAndDispatchHallMessage（operator 入口）
   ├─ A1 + A2-reset：buildOperatorTurnStatePatch → 写 originalAssigner，清 autoRoundsByAgent
   ├─ 解析 @mention → 目标 = [图灵, 林纳斯]
   └─ Promise.allSettled(targets.map(enqueueAndDispatch))

2. enqueueAndDispatch (一个 target)
   ├─ 写 inbox 入队行
   ├─ 触发 (card, agent) 的 worker
   └─ 返回 Promise（在 batch 完成时 resolve）

3. Worker batch fire（750ms 窗稳定后）
   ├─ 读 batch 里所有 pending records
   ├─ 调 batch[0] 的 dispatch closure
   │  └─ closure：从 message store 拉 triggerMessages → 调 dispatchHallAgentReply
   ├─ batch 全部 records 标 consumed
   ├─ 写 deliveries (共享 batchId / batchSize)
   └─ resolve 所有 batch records 的 enqueue Promise

4. dispatchHallAgentReply（一次实际 dispatch）
   ├─ canDispatchHallToRuntime 检查
   ├─ incrementAutoRoundCounter → updateHallTaskCard（best-effort）
   ├─ runPreDispatchPolicies(HALL_PER_TARGET_GATE_POLICIES)
   │  ├─ deny（policyId === A2-LIMIT）→ handleAutoRoundBlockedThreshold（system 消息）+ return
   │  ├─ deny（其他）→ silent return
   │  └─ allow / force-allow → 继续
   ├─ dispatchHallRuntimeTurn（调 OpenClaw）
   │  ├─ 首轮：发 setup prompt
   │  ├─ 后续轮：只发 trigger 内容
   │  └─ 多 trigger batch：渲染 "[在短时间内你被多次 @ (N 条 trigger 合并)，请在一条回复里照顾到全部：]"
   ├─ linkRuntimeSessionKeyToTaskCard（让下次走"后续轮"路径）
   ├─ runPostDispatchPolicies(HALL_DEFAULT_POST_DISPATCH_POLICIES)
   │  └─ drop（A4 OBSERVE_SILENT）→ 整条 reply 丢弃，不持久化
   ├─ appendPersistedHallMessage → chat.jsonl + 黑板 + UI SSE
   └─ auto-chain（下面 #5）

5. auto-chain（如果 reply 里有 @）
   ├─ if (chainDepth < MAX_AUTO_CHAIN_DEPTH) 早出
   ├─ resolveHallMentionTargets → 候选列表
   ├─ loadRecentHallThreadMessages（hoist 在 filter 之前）
   ├─ 候选 filter：runPreDispatchPolicies(HALL_CHAIN_FILTER_POLICIES, recentThreadMessages)
   │  └─ kind !== "deny" 的留下（force-allow 也算放行）
   ├─ 每个允许的 target 走 enqueueAndDispatch（chainDepth + 1）
   └─ wakeMentionInitiator（被 @ 的几个人都回完后，叫 agent 自己回来 review）

6. observer（如果 main 不是 primary 目标）
   ├─ 在所有 primary 的 enqueueAndDispatch promise 都 resolve 后
   ├─ enqueueAndDispatch（目标 = main, reason = "main-observer"）
   └─ 跑 dispatchMainObserver
      ├─ 拉最新 thread messages
      ├─ dispatchHallRuntimeTurn（mode: observer prompt）
      ├─ runPostDispatchPolicies → A4 drop 或持久化
      └─ 如果 observer 又 @了人 → chain（chainDepth = 1）
```

整个过程黑板写、信箱写、deliveries 写都是 fire-and-forget 的副作用，不阻塞主路径。

## 关键不变量

这些是不能轻易破坏的硬约束：

1. **`chat.jsonl` 是事实唯一来源** —— 任何状态都能从它复盘，不依赖内存索引
2. **A2 是硬上限** —— 任何 `force-allow` 都不能 override 它（policy 链顺序保证）
3. **operator 的意图权威** —— `operator-route` 的 trigger 不被 `dropResolvedTriggers` 启发式拦截
4. **OpenClaw session 自己管历史** —— orchestrator 不再 curate 上下文（除非 session 被驱逐时回退到 first-turn setup）
5. **enqueue Promise 在 batch 完成时才 resolve** —— observer 的「等 primary 全完才跑」时序靠这个保证
6. **dispatch 主路径上的"best-effort 副作用"必须 fire-and-forget** —— 写黑板、写信箱、写 deliveries 都不 await，避免影响测试时序与生产延迟（P3-A 教训）

## 关键 tunables

可调参数都在 `src/runtime/hall-policies.ts`：

| 名字 | 默认 | 含义 |
|------|------|------|
| `MAX_AUTO_CHAIN_DEPTH` | 5 | auto-chain 深度上限 |
| `AUTO_ROUND_BLOCK_THRESHOLD` | 6 | A2：(task, agent) 一轮内 dispatch 次数上限 |
| `DROP_RESOLVED_OVERLAP_THRESHOLD` | 0.6 | dropResolvedTriggers token-overlap 比例阈值 |
| `DROP_RESOLVED_MIN_TRIGGER_TOKENS` | 3 | dropResolvedTriggers 触发的最少 trigger token 数（太少不可信） |
| `HALL_BACK_PING_BUDGET` | 1 | 一轮内每个 (B→A) 对的反 ping 上限 |
| `HALL_INBOX_DEBOUNCE_MS`（环境变量） | 750 | 信箱 worker 防抖窗 |
| `HUMAN_REVIEW_IDLE_WINDOW_MS` | 10 min | 任务卡空闲超过这个窗口标 needs_human_review |

## 后续开发方向

### 即将做的：P3-C-3 Supervisor + 崩溃恢复

issue #13 三件套的最后一块。两半：

1. **escalate 到 `needs_human_review`** —— 目前 A2 命中只发一条 system 消息，但 `humanReviewedAt` / `lastAgentActivityAt` 那套人审基础设施（Phase A 留下的）还没和策略链显式挂上钩。让策略反复 deny 时显式标记任务卡 `needs_human_review`，UI 上凸显，直到人介入清掉这个标记
2. **崩溃恢复** —— 进程重启时扫 `inbox/{agent}.jsonl`，把入队但没消费的记录 hydrate 回 worker 队列继续 dispatch。这里有个真问题：closure 在重启后丢失了，所以 supervisor 需要从 inbox 元数据里重建 dispatch 参数（要么入队行写得足够全，要么走一条「通用 dispatch」路径）

### 中期可见的扩展

- **`dropResolvedTriggers` tier 2/3** —— 目前 tier 1 用 token-overlap 启发式，碰到一些 follow-up 问题会假阳性。tier 2 让 agent 在 reply 里写 `<hall-structured>{"resolves": [...]}` 显式标注解决了哪些 trigger ids；tier 3 跑一次 mini LLM judge
- **多 human 支持** —— 目前大量代码用 `participantId === "operator"` 字面识别 human。`enforceBackPingBudget` 已经走了 `isHuman: true`，可以推广到其它路径
- **observer 时机调优** —— observer 现在每轮都跑一次 main 当 silent observer，可以考虑只在「主对话有重大决策 / 多 agent 接力」时才唤醒
- **session 失效兜底** —— 目前 P3-A-2 假设 OpenClaw session 始终保留首轮 setup。如果未来发现 session 被驱逐 / 压缩，需要检测并退回 first-turn setup（基础设施已就绪）

### 暂未规划但黑板路径打开的方向

- **共享 markdown 的合并冲突仲裁** —— 目前约定「写自己的块」；多 agent 高并发可能撞车，需要锁 / CRDT
- **黑板的可视化** —— `chat.jsonl` 是 jsonl 文件，operator 仪表盘可以做时间线视图
- **跨任务卡的群聊 memory** —— 目前每张卡独立黑板，未来可以让 agent 跨卡 grep（适合长期项目）

## 相关文档

- [`HALL_REPLY_LIFECYCLE.md`](./HALL_REPLY_LIFECYCLE.md) —— hall reply / typing / SSE 时序的硬约束
- [`COLLABORATION_HALL_MVP.md`](./COLLABORATION_HALL_MVP.md) —— hall 的产品形态、SSE 事件契约
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) —— Control Center 整体架构（hall 是其中一部分）
- 项目根 [`HALL.md`](../HALL.md) —— hall 的协作风格指南（agent persona / 默认风格）
- 项目根 [`task_plan.md`](../task_plan.md) / [`progress.md`](../progress.md) —— 当前 Phase 3 工作的实施记录

## 相关源码

| 文件 | 角色 |
|------|------|
| `src/runtime/collaboration-hall-orchestrator.ts` | 中心协调：消息路由、dispatch、auto-chain、observer、wake-mention initiator |
| `src/runtime/collaboration-hall-store.ts` | 持久化：3 个 JSON 文件（halls / messages / task-cards），写串行化 |
| `src/runtime/hall-runtime-dispatch.ts` | 调真实 `openclaw agent` CLI，流式 stdout，构建 prompt（首轮 setup / 后续轮 trigger） |
| `src/runtime/hall-blackboard.ts` | 黑板写入：chat.jsonl + task_plan / findings / progress 三件套 |
| `src/runtime/hall-mailbox.ts` | inbox 文件 + 内存索引 + delivery 审计 |
| `src/runtime/hall-scheduler.ts` | per-(card, agent) worker pump，750ms 防抖 + 多 trigger 合并 |
| `src/runtime/hall-policies.ts` | 反循环策略链：types / 6 个 policy / 默认链组合 / 链 runner / 状态帮手 |
| `src/runtime/hall-mention-router.ts` | 解析 @mention（精确 + 前缀匹配） |
| `src/runtime/hall-role-resolver.ts` | agent name → 语义角色（manager / coder / reviewer / planner） |
| `src/runtime/collaboration-stream.ts` | SSE 事件：draft_start / draft_delta / draft_complete |
| `src/runtime/hall-human-review.ts` | needs_human_review 检测器（10 分钟空闲窗） |

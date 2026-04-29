# Findings: Phase 3 Hall Scheduling Engine

## Current Hall Architecture (来自 Explore agent 摸底)

### Dispatch Lifecycle
- 入口：`postHallMessage()` @ collaboration-hall-orchestrator.ts:650
- 路由：`routeAndDispatchHallMessage()` @ orchestrator.ts:847
- 派发：`dispatchHallAgentReply()` @ orchestrator.ts:1024 → `dispatchHallRuntimeTurn()`
- Auto-chain：扫 reply 里的 @mention，排除 trigger 作者，cap 5 层
- Observer：main 没在初始 target 里时，事后以 observer 身份再跑一次；`OBSERVE_SILENT` 抑制

### Concurrency Primitives
| 原语 | 文件:符号 | 粒度 | 作用 |
|---|---|---|---|
| `taskCardWriteChain` | collaboration-hall-store.ts:372 | 全局 | 防止并发 patch 同 card 丢失更新 |
| `hallMessageWriteChain` | collaboration-hall-store.ts:555 | 全局 | 防止并发 append 消息丢失 |
| `dispatchChains` Map | hall-runtime-dispatch.ts:201 | per-sessionKey | 同 (taskCardId, agentId) 不能并发派发 |
| `executionLock` | HallTaskCard 字段 | per-card | 守护 card 写并发；手动审核才释放 |
| `pendingHallBackgroundWork` Set | orchestrator.ts:206 | 全局 | 后台 dispatch promise 跟踪 |

所有并发是**进程内**的——重启即丢；扩到多进程会全数失效。

### Context Building (`buildHallRuntimePrompt`)
- 文件：hall-runtime-dispatch.ts:695
- inline 消息 cap：30 条（line 707，硬编码 slice）
- 输入：recentThreadMessages, triggerMessage, taskCard.{title, description}, participant persona, 全 roster, HALL.md 规则块（cap 6000 chars）, repo context（cap 7200 chars）, 工件块
- 结构化输出：`<hall-structured>{...}</hall-structured>` JSON

### Persistence
- `runtime/collaboration-halls.json`
- `runtime/collaboration-hall-messages.json`
- `runtime/collaboration-task-cards.json`
- `runtime/hall-workspaces/{taskCardId}/` ← agent workdir
- `runtime/operation-audit.log`
- 没有 `.hall/` 或 per-task-card metadata 子目录

### Cross-Cutting State on TaskCard
| 字段 | 语义 |
|---|---|
| currentOwnerParticipantId | 当前执行者 |
| originalAssignerParticipantId | 当前 dispatch 轮次的人类发起者 (A1) |
| executionLock | {ownerParticipantId, acquiredAt, releasedAt?, releasedReason?} |
| autoRoundsByAgent | per-agent 轮次计数 (A2，达 6 转 blocked) |
| plannedExecutionOrder | agentId 顺序列表 |
| currentExecutionItem | {itemId, participantId, task, handoffToParticipantId, handoffWhen} |
| sessionKeys | 历史 dispatch 用过的 session keys |

### Session Key（Phase 2 后）
- 格式：`agent:{agentId}:{scope}:{id}`
- Hall 范围：`agent:{agentId}:hall:{projectId}:{taskId}` via `buildHallThreadScopedSessionKey`
- 选择：`pickExpectedSessionKey()` 优先用已链接的 key，fallback 到 thread-scoped
- WS 路由：sessionKey 匹配 `/^agent:[^:]+:hall:/` 走 Gateway WS（openclaw-live-client.ts:344）

### Hard Constraints (Load-Bearing)
1. write chain 序列化（store.ts:372/555）
2. dispatchChains per-sessionKey gate（dispatch.ts:201）
3. Audit log append-only
4. SSE invalidate event contract
5. A1 originalAssigner seeding（orchestrator.ts:857）
6. A2 autoRounds reset on human message（orchestrator.ts:861）
7. A3 trigger author exclusion in chain（orchestrator.ts:1132）
8. 30s message dedup（orchestrator.ts:719）

## Industry Patterns Distilled (来自 Tavily 调研)

### Anthropic Multi-Agent Research System
- Orchestrator-worker 模式，lead agent 制定策略 + spawn parallel subagents
- Lead agent 把 plan 存进 memory（持久化）
- 内部 eval +90.2% vs single-agent
- **场景注意**：研究式分而治之，不是协作编码——并行更安全

### Cognition AI "Don't Build Multi-Agents"
- 核心警告：并行 agent 做隐式决策→集成时冲突
- 推荐：线性 sub-agent 链 + 传递完整上下文
- 我们的对策：**所有决策落黑板**，agent 行动前 grep 黑板而非脑补

### MetaGPT
- Global shared message pool
- Agents publish 结构化消息，按 sent_from / cause_by 订阅
- SOP 强制角色 + 结构化产出
- **取**：shared pool；**不取**：SOP 固化（5 状态机的回头路）

### AutoGen GroupChatManager
- Manager 选下一发言人：round_robin / random / manual / auto (LLM)
- 消息广播给所有 agent
- **取**：可插拔 speaker policy；**不取**：必须有 manager

### LangGraph
- Supervisor 模式：每次 routing 都过中心 (2× LLM call/domain)
- Swarm 模式：peer-to-peer handoff (1× LLM call/domain after first)
- Persistent shared state via checkpointer
- ACP-style structured message bus
- **取**：persistent shared state；**不选边**：人类→agent 用 supervisor，agent→agent 用 swarm

### Hearsay-II Blackboard (LLM 时代复活，OpenReview 2024)
- 三件套：Blackboard（共享数据）+ Knowledge Sources（agent）+ Control Unit（调度）
- 适合"increment + opportunistic" 推理
- **取**：三件套都取；**不取**：复杂事件触发规则

### Claude Code Subagents
- 文件化定义（markdown），项目目录 + 用户目录
- 每个 subagent 隔离 context window
- 主 agent 编排
- **取**：文件化 + 隔离；**不取**：完全套主-从模型（hall 是对等群聊）

### Actor Model
- Mailbox + 单线程 per actor + 反压 + 监督树 + 重启策略
- 反压：worker pool 限制并发（LLM rate limit / cost budget）
- **取**：Mailbox + 监督；**不取**：分布式集群、event sourcing

### A2A / ACP（IBM ACP + Google A2A 已合并到 LF AI）
- 标准化 inter-agent 通信
- 结构化消息：intent, task params, context markers, response expectations
- **暂不取**：等社区收敛；先跑自己的

## Key References
- Anthropic 多智能体研究系统：https://www.anthropic.com/engineering/built-multi-agent-research-system
- Cognition 反对多 agent：https://cognition.ai/blog/dont-build-multi-agents
- Cognition 后续："多 agent 实际可行的部分"：https://cognition.ai/blog/multi-agents-working
- LangGraph 监督 vs swarm：https://focused.io/lab/multi-agent-orchestration-in-langgraph-supervisor-vs-swarm-tradeoffs-and-architecture
- AutoGen 论文：https://arxiv.org/pdf/2308.08155
- MetaGPT 论文：https://proceedings.iclr.cc/paper_files/paper/2024/file/6507b115562bb0a305f1958ccc87355a-Paper-Conference.pdf
- LLM 黑板架构：https://openreview.net/pdf?id=egTQgf89Lm
- Claude Code subagents 介绍：https://www.infoq.com/news/2025/08/claude-code-subagents/
- Actor model for agents：https://agentic-design.ai/patterns/workflow-orchestration/actor-model-coordination

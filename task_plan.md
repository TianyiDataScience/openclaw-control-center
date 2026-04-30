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

### Phase P3-B — Mailbox 改造 + P3-C Policy chain + Supervisor (designed, deferred)

**Design issue**: https://github.com/xiaolinfrank/openclaw-control-center/issues/13

P3-A 落地后，Phase 3 的剩余架构层工作（解决 issue #9 第 4 项 + 把 A1-A4 反循环兜底降级为可插拔 policy）已在 origin issue #13 完整设计：
- Mailbox：每个 (card, agent) 一个 inbox（文件 append-only + 内存索引），InboxWorker 750ms 防抖窗合并多对一通信
- Policy chain：A1-A4 抽成纯函数，新增 `detectClarifyingQuestion`（识别合法反向 Q&A 主动放行）+ `enforceBackPingBudget`（限制每对每轮反 ping 次数）
- Supervisor：崩溃重启从 inbox 未消费位点继续，escalate → 标 needs_human_review 等人

拆 PR 计划：P3-B-1 inbox 层 → P3-B-2 防抖合并 → P3-C-1 policy 抽取（不变行为）→ P3-C-2 新 policy 上线 → P3-C-3 Supervisor。每步独立可发版。

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

# 常见问题指南 / FAQ Guide

> Looking for English? See [FAQ Guide (English)](#english-version) below.

## 中文版

### 1. 多 Agent 工作区 — 为什么成员列表看不到职责？

**问题：** 已经在 `SOUL.md` 和 `AGENTS.md` 中写好了角色和职责，但控制中心的员工页面看不到具体分工。

**原因：** 控制中心从 OpenClaw 的 workspace 目录读取文件。显示的信息取决于：
- OpenClaw Gateway 返回的 session 数据中是否包含 agent 元信息
- `OPENCLAW_AGENT_ROOT` 环境变量是否指向了正确的 workspace 目录

**解决方法：**

1. **确认 workspace 目录结构正确：**
   ```
   workspace-你的agent名/
   ├── SOUL.md          # 性格和角色定义
   ├── IDENTITY.md      # 名字、emoji 等身份信息
   ├── AGENTS.md        # 多 agent 协作规则
   └── MEMORY.md        # 长期记忆
   ```

2. **检查环境变量：**
   ```bash
   # 确保 OPENCLAW_AGENT_ROOT 指向包含所有 workspace 的父目录
   export OPENCLAW_AGENT_ROOT=/path/to/.openclaw
   ```

3. **确认 Gateway 正在运行：**
   ```bash
   openclaw gateway status
   ```
   控制中心通过 Gateway API 获取 agent 列表和状态。如果 Gateway 没运行，员工页会显示空白或错误。

4. **员工页显示的信息来源：**
   - **名字/emoji** → 从 `IDENTITY.md` 读取
   - **状态（执行中/空闲）** → 从 Gateway 的 session 数据实时获取
   - **workspace** → 从 agent 配置中的 `workspace` 字段获取
   - **具体职责描述** → 目前不会自动从 `SOUL.md` 提取摘要显示在列表中

> **提示：** 如果想在员工列表中看到职责说明，建议在 `IDENTITY.md` 中添加一行简短描述。控制中心会优先读取此文件的关键信息。

---

### 2. 订阅/账单 — 数据怎么接？限额在哪设置？

**问题：** 用量页面有费用数据，但不知道这些数据从哪来、限额怎么设置。

**数据来源：**

控制中心的用量数据**全部来自 OpenClaw Gateway**，不需要额外接入第三方账单系统。

```
OpenClaw Gateway → 记录每次 API 调用的 token 用量
                 → 根据模型定价计算费用
                 → 控制中心通过 API 拉取显示
```

**限额设置方式：**

限额（Budget）通过 OpenClaw 的配置文件设置，不在控制中心 UI 中设置：

```yaml
# 在 OpenClaw 配置中设置 budget
# ~/.openclaw/config.yaml 或对应配置文件

budget:
  # Token 限额
  tokensIn: 1000000        # 输入 token 上限
  tokensOut: 500000         # 输出 token 上限
  totalTokens: 1500000      # 总 token 上限
  
  # 费用限额（美元）
  cost: 50.00               # 总费用上限
  
  # 预警比例（达到此比例时发出警告）
  warnRatio: 0.8            # 80% 时预警
```

**控制中心显示的内容：**
- **用量页 → Token 消耗：** 按 agent、按模型、按时间段的 token 使用
- **用量页 → 费用：** 基于模型定价的预估费用
- **用量页 → 上下文压力：** 哪些 session 接近上下文窗口上限
- **总览页 → 预算摘要：** 当前用量 vs 限额的进度条

> **注意：** 如果你用的是 API key 直连模式（不通过 OpenClaw 的 billing 代理），费用数据可能不完整。建议通过 OpenClaw Gateway 统一管理 API 调用。

---

### 3. 会话停滞检测 — 怎么判定的？

**问题：** 控制中心显示某个会话"停滞执行"，但找不到是哪个会话，也不确定判定标准。

**判定逻辑：**

控制中心通过以下逻辑判定会话状态：

| 状态 | 英文 | 判定条件 |
|------|------|----------|
| 执行中 | `running` | 会话有活跃的 API 调用或工具执行 |
| 空闲 | `idle` | 会话存在但没有活跃任务 |
| 阻塞 | `blocked` | 会话等待外部输入或资源 |
| 等待审批 | `waiting_approval` | 会话需要用户手动确认才能继续 |
| 错误 | `error` | 会话遇到错误 |

**"停滞执行"判定：** 当一个会话的状态是 `running`，但长时间没有新的 API 调用或消息更新时，控制中心会将其标记为停滞。具体来说：

1. **Gateway 层面：** OpenClaw Gateway 跟踪每个 session 的最后活跃时间
2. **控制中心层面：** 定期轮询 Gateway，比较 `running` 状态会话的最后活跃时间
3. **健康检查：** 如果 session 数据长期不更新，health endpoint 返回 `stale` 状态

**如何找到停滞的会话：**

```bash
# 查看所有 running 状态的 sessions
openclaw sessions list --filter running

# 查看特定 session 的详情
openclaw sessions history <session-key> --limit 5
```

**如何处理停滞会话：**
- 如果是 heartbeat 检查导致的误判，检查 `HEARTBEAT.md` 配置
- 如果确实停滞了，可以手动发消息恢复：
  ```bash
  openclaw sessions send <session-key> "继续"
  ```
- 如果需要终止，直接关闭对应的 agent session

---

## English Version

### 1. Multi-Agent Workspace — Why Can't I See Roles in the Staff Page?

**Issue:** Roles defined in `SOUL.md` and `AGENTS.md` don't appear in the Control Center staff list.

**Solution:**
- Ensure your workspace directory follows the standard structure (`SOUL.md`, `IDENTITY.md`, `AGENTS.md`, `MEMORY.md`)
- Set `OPENCLAW_AGENT_ROOT` environment variable to point to the parent directory of all workspaces
- Confirm OpenClaw Gateway is running (`openclaw gateway status`)
- The staff page reads identity info from `IDENTITY.md` — add a short description there for it to appear in the list

### 2. Billing & Budget — How to Connect Data and Set Limits?

**Data source:** All usage data comes from OpenClaw Gateway. No third-party billing integration is needed.

**Setting limits:** Configure budget thresholds in your OpenClaw config file (`~/.openclaw/config.yaml`):
```yaml
budget:
  totalTokens: 1500000
  cost: 50.00
  warnRatio: 0.8
```

### 3. Session Stall Detection — How Does It Work?

A session is considered "stalled" when its state is `running` but no new API calls or messages have been recorded for an extended period. Use `openclaw sessions list --filter running` to find stalled sessions.

To resolve: send a message to the session (`openclaw sessions send <key> "continue"`) or terminate it.

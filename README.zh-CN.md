> Looking for English? Start here: [Open the English README](README.md)

# OpenClaw Control Center

<img src="docs/assets/overview-hero-zh.png" alt="OpenClaw Control Center 总览横幅截图" width="1200" />

把 OpenClaw 从黑箱变成一个看得清、信得过、控得住的本地控制中心。

语言： [English](README.md) | **中文**

## 这个项目是做什么的
- 给 OpenClaw 提供一个本地控制中心，集中看系统是否稳定、谁在工作、哪些任务卡住了、今天花了多少。
- 面向非技术用户，重点是“看得懂、看得准”，不是暴露原始后端 payload。
- 首次接入默认安全：
  - 默认只读
  - 默认本地 token 鉴权
  - 默认关闭高风险写操作

## 你能得到什么
- `总览`：系统状态、待处理事项、关键风险和运营摘要
- `用量`：用量、花费、订阅窗口和连接状态
- `员工`：谁真的在工作，谁只是排队待命
- `协作`：一个 hall-first 的多 agent 工作群，可以在同一条线程里讨论、排顺序、交接、评审
- `任务`：当前任务、审批、执行链和运行证据
- `文档` 与 `记忆`：按活跃 OpenClaw agent 范围展示的源文件工作台

## 这个版本新增了什么
- `协作`：新增 hall-first 的独立 `协作` 页面，任务可以先在共享时间线里讨论、再收口到执行 owner，而不是只靠父子会话去猜任务怎么推进。
- `协作`：hall 里的讨论、指派和交接现在可以走真实 `openclaw agent` 运行时，草稿流和最终落地消息都会回到同一条线程。
- `协作`：hall 现在直接使用你当前 OpenClaw roster 里的 agent id 和显示名；已有用户不需要把 agent 改名成任何 control-center 私有名字就能接入。
- `设置`：新增 `接线状态`，直接告诉你哪些数据已经接好、哪些还差一步，以及该去哪里补。
- `设置`：新增 `安全风险摘要`，把当前风险、影响和下一步建议翻译成人话。
- `设置`：新增 `更新状态`，直接看当前版本、最新版本、更新通道和安装方式。
- `用量`：新增 `上下文压力`，直接看哪些会话更接近上下文上限，哪里可能变慢或变贵。
- `记忆`：新增 `记忆状态`，直接看每个智能体的记忆是否可用、可搜索、需不需要检查。

## 适合谁
- 已经在用 OpenClaw、想要一个统一控制中心的团队或个人
- 在同一台机器或可达本地环境里运行 OpenClaw 的使用者
- 想公开发布一个安全优先的 OpenClaw 控制台，而不是做通用 agent 平台的人

## 截图
以下截图来自一个本地 OpenClaw 环境：

<table>
  <tr>
    <td width="56%">
      <img src="docs/assets/token-share-zh.png" alt="OpenClaw Control Center 中文 token 消耗归因截图" width="100%" />
    </td>
    <td width="44%">
      <img src="docs/assets/staff-zh.png" alt="OpenClaw Control Center 中文员工页截图" width="100%" />
    </td>
  </tr>
  <tr>
    <td><strong>Token 消耗归因</strong><br />直接看定时任务 token 是被哪些任务吃掉的，占比一眼可见。</td>
    <td><strong>员工页</strong><br />直接看谁在工作、谁待命、最近产出和排班状态。</td>
  </tr>
</table>

<table>
  <tr>
    <td width="56%">
      <img src="docs/assets/collaboration-zh.png" alt="OpenClaw Control Center 中文协作页截图" width="100%" />
    </td>
    <td width="44%">
      <img src="docs/assets/settings-insights-zh.png" alt="OpenClaw Control Center 中文安全与更新状态截图" width="100%" />
    </td>
  </tr>
  <tr>
    <td><strong>协作页</strong><br />直接看多 agent 在同一条线程里讨论、拍板、执行、交接和评审，而不是把协作关系藏在不同会话里。</td>
    <td><strong>安全与更新状态</strong><br />直接看当前风险、影响、下一步建议，以及当前版本和最新版本。</td>
  </tr>
</table>

## hall 如何接入你现有的 agent
- hall 会读取当前 OpenClaw 运行环境里的 roster，直接使用你已经在用的 agent id 和显示名。
- 已有用户不需要把 agent 改名成 `pandas`、`coq`、`monkey` 这类 control-center 示例名，直接接入即可。
- hall 的角色建议只是启发式，不是强绑定；如果你的 roster 名字里带有 `manager`、`planner`、`builder`、`qa` 之类信号，会优先用这些信号，否则会平滑降级，不会因为名字不匹配而卡住。
- hall 运行时现在会把 `surface`、`workspaceRoot`、`workdir`、关键入口文件和 artifact 引用一起传给 agent，让 repo-aware 的任务尽量获得和其他渠道一致的执行上下文。

## hall 工作流
- 从一条任务开始，第一轮会先留在 `讨论中`。
- 如果你没有显式 `@` 某个人，hall 会尽量先收两条短回复，让第二个人承接第一人的上下文补缺口，而不是重写一遍。
- 如果你想给整个 hall 统一协作风格，可以直接改仓库根目录的 `HALL.md`。它会注入 discussion / execution / handoff 的 prompt，但不会覆盖 owner 路由和已排好的执行顺序。
- 用 `安排后续顺序` 来决定谁先做、后面谁接、每一步交接给谁。
- 保存顺序 **不会** 自动开始执行。
- 队列排好后，结论卡会出现 `开始执行（...）`。
- 进入执行后，每个人只做自己这一棒，并在同一条线程里显式 `@` 下一位交棒。
- 只有最后一位执行者做完，或者人类明确要求先停下来评审时，才应该进入评审。
- 一轮评审后，可以点 `继续讨论` 回到讨论态，再排下一轮顺序，然后从同一条线程继续开始。

## 5 分钟启动
```bash
npm install
cp .env.example .env
npm run build
npm test
npm run smoke:ui
npm run smoke:hall
npm run dev:ui
```

然后打开：
- `http://127.0.0.1:4310/?section=overview&lang=zh`
- `http://127.0.0.1:4310/?section=overview&lang=en`

说明：
- 推荐用 `npm run dev:ui` 启动界面；它比 `UI_MODE=true npm run dev` 更稳，尤其是 Windows shell。
- `npm run dev` 只会执行一次 monitor，不会启动 HTTP UI。

## 分区功能说明

### 总览
- 给非技术用户看的主操作页。
- 集中展示当前总控态势、待处理事项、运行异常、停滞执行、预算风险、谁在忙、哪些地方需要优先关注。
- 最适合快速回答一句话：`OpenClaw 现在整体正常吗？`

### 用量
- 展示今日、7 天、30 天的用量和花费趋势。
- 包含订阅窗口、配额消耗、用量结构、上下文压力和数据连接状态。
- 最适合判断花费或额度是否开始有风险。

### 员工
- 展示谁现在真的在工作，谁只是有排队中的任务。
- 明确区分“正在执行”和“下一项”，避免把 backlog 误认为正在跑。
- 如果员工卡片显示 `工作区未写明职责`，优先看 [FAQ 与最佳实践](docs/FAQ.md) 的第 1 条。
- 最适合判断谁忙、谁闲、谁卡住、谁在等待。

### 协作
- hall-first 的多 agent 工作群：同一条线程里先讨论，再排顺序，再开始执行、交接和评审。
- 运行时回复会直接回写到大厅时间线；需要更深证据时，再打开 linked room 看细节。
- 预期风格更像真实员工群：讨论时短回复补缺口，执行时只认一个 owner，交接时显式 `@下一位`，最后才评审。
- 最适合理解“这件事是谁在做、下一步交给谁、为什么现在能继续往前推进”。

### 记忆
- 一个直接基于源文件的记忆工作台，用来查看和编辑每日记忆与长期记忆。
- 范围跟随 `openclaw.json` 里的活跃 agent，不会把已删除 agent 继续显示出来。
- 现在还会直接告诉你每个智能体的记忆是否正常、可搜索、是否需要检查。
- 最适合查看或维护当前 OpenClaw 团队真实在用的记忆内容。

### 文档
- 一个直接基于源文件的文档工作台，用来查看和编辑共享文档与 agent 核心文档。
- 打开的是实际源文件，保存后也直接写回同一个源文件。
- 最适合维护系统背后真正生效的工作文档。

### 任务
- 把任务板、排期、审批、执行链和运行证据放在同一个分区里。
- 能帮助区分哪些只是看板映射，哪些已经有真实执行证据，哪些任务卡住了、需要跟进或待审。
- 最适合理解“现在到底在做什么、只是计划了什么、哪些需要你介入”。

### 设置
- 展示安全模式、连接器状态和数据链路预期。
- 会明确告诉你哪些数据已经接上，哪些还只是部分可见，哪些高风险动作是故意关闭的。
- 现在还包含 `接线状态`、`安全风险摘要` 和 `更新状态` 三张关键卡片。
- 最适合排查环境配置、解释为什么某些信号缺失。

## 这不是什么
- 不是 OpenClaw 本体的替代品
- 不是面向所有 agent 技术栈的通用平台
- 不是托管式 SaaS 控制台

## 核心约束
- 只修改 `control-center/` 目录内的文件
- 默认 `READONLY_MODE=true`
- 默认 `LOCAL_TOKEN_AUTH_REQUIRED=true`
- 默认 `IMPORT_MUTATION_ENABLED=false`
- 默认 `IMPORT_MUTATION_DRY_RUN=false`
- 开启鉴权时，导入/导出和所有改状态接口都需要本地 token
- 审批动作有硬开关，默认关闭：`APPROVAL_ACTIONS_ENABLED=false`
- 审批动作默认 dry-run：`APPROVAL_ACTIONS_DRY_RUN=true`
- 不会改写 `~/.openclaw/openclaw.json`

## `LOCAL_API_TOKEN` 是什么
- `LOCAL_API_TOKEN` 是你自己在 `.env` 里设置的“本机共享口令”。
- 当 `LOCAL_TOKEN_AUTH_REQUIRED=true` 时，它用于保护保存、导入/导出副作用、审批，以及 hall / task-room 里的写操作。
- 常见首次配置方式：
  - 保持 `LOCAL_TOKEN_AUTH_REQUIRED=true`
  - 把 `LOCAL_API_TOKEN` 设成一串足够长的随机字符串
  - 在 UI 提示输入关键操作口令时，输入同一个值
- 如果鉴权开关开着、但 `LOCAL_API_TOKEN` 没配置，关键写操作会按设计被拦截。

## 快速开始
1. `npm install`
2. `cp .env.example .env`
3. 第一次接入尽量保持安全默认值；只有在你的 OpenClaw 环境不是默认路径时，再改 `GATEWAY_URL` 或路径覆盖项
4. 如果你要测试保存、导入或 hall 写操作，先在 `.env` 里把 `LOCAL_API_TOKEN` 设成一串足够长的随机字符串
5. `npm run build`
6. `npm test`
7. `npm run smoke:ui`
8. `npm run smoke:hall`
9. `npm run dev:ui`

## `UI_TIMEZONE` 是什么
- `UI_TIMEZONE` 用来控制 UI 里“绝对时间”的展示时区。
- 默认值是 `UTC`。
- 常见示例：`Asia/Shanghai`、`Europe/Paris`、`America/Los_Angeles`。
- 它不会影响“5 分钟前”这类相对时间，只影响会话最近活动、任务更新时间、Cron 下次运行、审批时间、详情页这些绝对时间。

## Docker 部署
- 可以，控制中心支持通过 Docker 运行。
- 真正关键的不只是 Docker，而是容器里能否看到同一套 OpenClaw 数据路径，并且能连到 Gateway。
- 仓库里已经放了一套最小样板：`Dockerfile` 和 `docker-compose.example.yml`。
- 如果你的 OpenClaw 本身也是 Docker 部署，重点把这些映射对：
  - `GATEWAY_URL`
  - `OPENCLAW_HOME`
  - `OPENCLAW_CONFIG_PATH`
  - `OPENCLAW_WORKSPACE_ROOT`
  - 如果你还想看 Codex 用量 / 订阅，再补 `CODEX_HOME`
- 常见本地启动方式：
  - `cp .env.example .env`
  - 按实际路径修改 `docker-compose.example.yml` 里的挂载和 `LOCAL_API_TOKEN`
  - `docker compose -f docker-compose.example.yml up --build`
- Docker 镜像现在会在构建阶段预生成默认 Hall / 员工头像导出，所以 `/hall-avatars/*.png` 开箱即用。
- 如果 Gateway 跑在宿主机上：
  - Linux Docker 建议保留 `extra_hosts: ["host.docker.internal:host-gateway"]`
  - 容器直连宿主机时，优先用 `ws://host.docker.internal:18789`
  - 只有当 Gateway 端点本身真的在做 TLS，并且证书与配置的主机名匹配时，再使用 `wss://...`
- 如果 UI 需要通过反向代理、局域网地址或 Tailscale 访问，再额外设置：
  - `OPENCLAW_CONTROL_UI_URL`
  - `UI_BIND_ADDRESS=0.0.0.0`

## 多 Agent workspace 目录布局
- 默认回退布局是 `<OPENCLAW_WORKSPACE_ROOT>/agents/<agentId>`。
- 如果你的 agent 实际目录是 `workspace/a`、`workspace/b` 这种同级自定义目录，就需要在 `openclaw.json` 里给每个 agent 明确写 `workspace`。
- 也就是说，`OPENCLAW_WORKSPACE_ROOT` 只提供共享根目录；每个 agent 的自定义目录仍然要靠各自的 `workspace` 字段来告诉控制中心。

## 安装与上手

### 1. 开始前准备
你最好已经有：
- 一个可用的 OpenClaw 安装
- 一个可连接的 OpenClaw Gateway
- 当前机器上的 `node` 和 `npm`
- 对 OpenClaw 主目录的读取权限

如果你希望 `用量 / 订阅` 信息更完整，当前机器最好还能读到：
- `~/.openclaw`
- `~/.codex`
- OpenClaw 订阅快照文件，尤其是它不在默认位置时

### 2. 安装项目
```bash
git clone https://github.com/TianyiDataScience/openclaw-control-center.git
cd openclaw-control-center
npm install
cp .env.example .env
```

如果 OpenClaw 说“仓库缺少 `src/runtime`”或“缺少核心源码”，先不要改代码。这个仓库的标准结构本来就包含：
- `package.json`
- `src/runtime`
- `src/ui`
- `.env.example`

这类报错通常意味着：
- 当前目录不是 `openclaw-control-center` 仓库根目录
- clone 到了错误仓库
- checkout / 下载不完整
- agent 在错误 workspace 里执行

### 3. 默认推荐：让你自己的 OpenClaw 直接完成安装与接线
最推荐的接入方式，不是你手动一项项配，而是直接把下面这段安装指令交给你自己的 OpenClaw。

如果你想直接复制独立文件，用这个：
- [INSTALL_PROMPT.md](INSTALL_PROMPT.md)
- [INSTALL_PROMPT.en.md](INSTALL_PROMPT.en.md)

它应该一次性帮你做完这些事：
- 检查本机 OpenClaw / Gateway / 路径
- 安装依赖
- 创建或修正 `.env`
- 保持安全默认值
- 跑 `build / test / smoke`
- 告诉你最后该执行什么命令、该看哪些页面

这段安装指令已经考虑了这些常见情况：
- 用户没有 GPT / Codex 订阅，或者没有可读的订阅快照
- 用户的 OpenClaw 底层不是订阅，而是 API key / 其他 provider（例如 OpenAI API、Anthropic、OpenRouter 等）
- `~/.openclaw`、`~/.codex`、Gateway 地址、端口都不是默认值
- 一台机器上存在多套 OpenClaw home、多个可能的 Gateway，或者当前项目不是默认 workspace
- 机器上的活跃 agent 名单和本仓库示例完全不同
- 机器当前只能本地构建，暂时还接不上 live Gateway
- 机器缺少 `node` / `npm`、没有 npm registry 网络、或者仓库目录没有写权限
- 某些数据源缺失，但控制中心仍然应该先以“安全只读”方式跑起来

直接把下面整段原样交给 OpenClaw：

```text
你现在要帮我把 OpenClaw Control Center 安装并接到这台机器自己的 OpenClaw 环境上。

你的目标不是解释原理，而是直接完成一次安全的首次接入。

严格约束：
1. 只允许在 control-center 仓库里工作。
2. 除非我明确要求，否则不要修改应用源码。
3. 不要修改 OpenClaw 自己的配置文件。
4. 不要开启 live import，不要开启 approval mutation。
5. 所有高风险写操作保持关闭。
6. 不要假设这台机器使用默认 agent 名称、默认路径、默认订阅方式，必须以实际探测结果为准。
7. 不要把“缺少订阅数据 / 缺少 Codex 数据 / 缺少账单快照”当成安装失败；只要 UI 能安全跑起来，就应当继续并明确哪些面板会降级。
8. 不要伪造、生成、改写任何 provider API key、token、cookie 或外部凭证；如果 OpenClaw 本身缺少这些前置条件，只能报告，不要替用户猜。

请按这个顺序执行：

第一阶段：确认环境
1. 检查 OpenClaw Gateway 是否可达，并确认正确的 `GATEWAY_URL`。
2. 确认这台机器上正确的 `OPENCLAW_HOME` 和 `CODEX_HOME`。
3. 如果订阅或账单快照文件不在默认位置，找到正确的 `OPENCLAW_SUBSCRIPTION_SNAPSHOT_PATH`。
4. 确认这台机器上有哪些前提是真正存在的，哪些是缺失但允许降级的。
5. 如果机器上存在多个候选 `OPENCLAW_HOME`、多个可能的 Gateway，或多个 workspace，不要猜。
6. 如果缺少会导致“完全无法启动控制中心”的必要条件，直接停止并明确告诉我缺什么。
7. 如果缺少的只是增强型数据源，不要停止安装；继续并把这些项标记为“安装可继续，但相关页面会部分缺失”。
8. 不要假设任何固定 agent 名称。若 `openclaw.json` 可读，就以它为准。

第二阶段：安装项目
9. 确认当前目录是 control-center 仓库根目录。如果还没有 clone，先执行：`git clone https://github.com/TianyiDataScience/openclaw-control-center.git`
10. 先确认仓库本体完整。
11. 如果缺少 `src/runtime`、`src/ui` 或 `package.json`，不要继续安装，重新 clone：`https://github.com/TianyiDataScience/openclaw-control-center.git`。
12. 运行依赖安装。
13. 如果 `.env` 不存在，就从 `.env.example` 创建；如果存在，就在保留安全默认值的前提下修正它。

第三阶段：配置安全首次接入
14. 保持这些值：
   - READONLY_MODE=true
   - LOCAL_TOKEN_AUTH_REQUIRED=true
   - APPROVAL_ACTIONS_ENABLED=false
   - APPROVAL_ACTIONS_DRY_RUN=true
   - IMPORT_MUTATION_ENABLED=false
   - IMPORT_MUTATION_DRY_RUN=false
   - UI_MODE=false
15. 只有在本机环境确实不同的时候，才修改：
   - GATEWAY_URL
   - OPENCLAW_HOME
   - CODEX_HOME
   - OPENCLAW_SUBSCRIPTION_SNAPSHOT_PATH
   - UI_PORT
16. 如果 `CODEX_HOME` 不存在，或者这台机器根本没有 Codex / GPT 订阅数据，不要强行填假路径；保留为空，并在结果里明确说明“Usage / Subscription 将部分可见或不可见”。

第四阶段：验证安装
17. 运行：
   - npm run build
   - npm test
   - npm run smoke:ui
18. 如果有任何一步失败，停止并告诉我：
   - 哪一步失败了
   - 原因是什么
   - 我下一步该怎么修
19. 如果 build / test / smoke 通过，但 live Gateway 仍不可达，也不要把这次接入判定为失败；要把结果归类为“本地 UI 已可用，但 live 观测尚未接通”。

第五阶段：交付可启动结果
20. 如果验证通过，输出：
   - 你实际修改了哪些 env 值
   - 最终 `.env` 中哪些值沿用了默认值
   - 我下一步启动 UI 的准确命令
   - 我应该先打开的 3 个页面
   - 哪些信号如果为空，属于“正常但未接线完全”
   - 哪些能力现在已经可用
   - 哪些能力因为当前机器没有相关数据源而处于降级状态
   - 如果我以后补上订阅 / Codex / Gateway，只需要补哪几个 env 或前置条件
```

## 最佳实践
- 如果这个控制中心主要给运营或观察用，第一轮上线尽量保持只读。
- 如果你准备联系 OpenClaw 官方或国际社区，仓库首页默认英文更合适，但中文入口应该保持一眼可见。
- richer usage / subscription / collaboration 这些面板是增强层，不该成为第一次启动的阻塞项。

## 对外展示与联系官方
- 明天可以直接复制的 X / Discord showcase 文案在 [docs/SHOWCASE.md](docs/SHOWCASE.md)。
- 如果你要联系 OpenClaw 官方，重点讲 operator value：观测、确定性、协作、用量、记忆、安全。

## 开源与发布卫生
- 仓库已经包含 `.gitignore`、`LICENSE` 和可发布的 package 元数据。
- `GATEWAY_URL` 可配置，不再绑定单一本地 socket。
- 公开文档统一使用通用 `~/.openclaw/...` 路径，不包含机器私有 home 目录。
- 每次公开推送前，建议先运行 `npm run release:audit`。
- 独立仓库发布流程见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。

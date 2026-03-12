import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import type { AuditTimelineSnapshot } from "../src/runtime/audit-timeline";
import type { SessionConversationDetailResult } from "../src/runtime/session-conversations";
import type { ReadModelSnapshot } from "../src/types";

test("session drilldown page renders without network and escapes content", async () => {
  const { renderSessionDrilldownPageForSmoke } = await import("../src/ui/server");

  const detail: SessionConversationDetailResult = {
    generatedAt: "2026-03-03T09:00:00.000Z",
    session: {
      sessionKey: "sess-1",
      label: "Primary Session",
      agentId: "agent-alpha",
      state: "running",
      lastMessageAt: "2026-03-03T08:59:00.000Z",
    },
    status: {
      sessionKey: "sess-1",
      model: "gpt-test",
      tokensIn: 10,
      tokensOut: 20,
      cost: 0.01,
      updatedAt: "2026-03-03T08:59:30.000Z",
    },
    latestSnippet: "latest",
    latestRole: "assistant",
    latestKind: "message",
    latestToolName: undefined,
    latestHistoryAt: "2026-03-03T08:59:00.000Z",
    historyCount: 2,
    historyError: undefined,
    executionChain: {
      accepted: true,
      spawned: true,
      acceptedAt: "2026-03-03T08:58:10.000Z",
      spawnedAt: "2026-03-03T08:58:20.000Z",
      parentSessionKey: "sess-parent",
      childSessionKey: "sess-1",
      stage: "running",
      source: "history",
      inferred: false,
      detail: "accepted=yes | spawned=yes | parent=sess-parent | child=sess-1",
    },
    history: [
      {
        kind: "accepted",
        role: "system",
        content: "accepted request",
        timestamp: "2026-03-03T08:58:10.000Z",
      },
      {
        kind: "message",
        role: "user",
        content: "render this <script>alert(1)</script>",
        timestamp: "2026-03-03T08:58:00.000Z",
      },
      {
        kind: "tool_event",
        role: "tool",
        content: "tool output ok",
        timestamp: "2026-03-03T08:59:00.000Z",
        toolName: "openclaw.approvals.get",
        toolStatus: "ok",
      },
    ],
  };

  const html = renderSessionDrilldownPageForSmoke(detail);
  assert(html.includes("Session Drilldown"));
  assert(html.includes("Execution Chain"));
  assert(html.includes("Latest Messages / Tool Events"));
  assert(html.includes("/api/sessions/sess-1?historyLimit=120"));
  assert(html.includes("parent=sess-parent child=sess-1"));
  assert(html.includes("Accepted"));
  assert(html.includes("Spawned"));
  assert(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert(!html.includes("<script>alert(1)</script>"));

  const zh = renderSessionDrilldownPageForSmoke(detail, "zh");
  assert(zh.includes("会话详情"));
  assert(zh.includes("执行链"));
  assert(zh.includes("最近消息 / 工具事件"));
  assert(zh.includes("返回总览"));
});

test("audit timeline page renders without network and keeps severity selection", async () => {
  const { renderAuditPageForSmoke } = await import("../src/ui/server");

  const timeline: AuditTimelineSnapshot = {
    generatedAt: "2026-03-03T09:10:00.000Z",
    counts: {
      info: 0,
      warn: 1,
      "action-required": 0,
      error: 0,
    },
    events: [
      {
        timestamp: "2026-03-03T09:09:00.000Z",
        severity: "warn",
        source: "monitor",
        message: "timeline <unsafe> marker",
      },
    ],
  };

  const html = renderAuditPageForSmoke(timeline, "warn");
  assert(html.includes("<title>OpenClaw Control Center Audit Timeline</title>"));
  assert(html.includes("<h1>Audit Timeline</h1>"));
  assert(html.includes('value="warn" selected'));
  assert(html.includes("timeline &lt;unsafe&gt; marker"));
  assert(!html.includes("timeline <unsafe> marker"));
});

test("dashboard section navigation renders required tabs with active state", async () => {
  const { renderDashboardSectionNavForSmoke } = await import("../src/ui/server");

  const en = renderDashboardSectionNavForSmoke("team", "en");
  assert(en.includes("Overview"));
  assert(en.includes("Staff"));
  assert(en.includes("Memory"));
  assert(en.includes("Documents"));
  assert(en.includes("Usage"));
  assert(en.includes("Tasks"));
  assert(en.includes("Settings"));
  assert(en.includes('aria-current="page"'));
  assert(en.includes("/?section=team"));
  assert(en.indexOf("Overview") < en.indexOf("Usage"));
  assert(en.indexOf("Usage") < en.indexOf("Staff"));
  assert(!en.includes("Executors"));
  assert(!en.includes("Calendar"));
  assert(!en.includes("Attention"));
  assert(!en.includes("History"));

  const zh = renderDashboardSectionNavForSmoke("team", "zh");
  assert(zh.includes("总览"));
  assert(zh.includes("员工"));
  assert(zh.includes("记忆"));
  assert(zh.includes("文档"));
  assert(zh.includes("用量"));
  assert(zh.includes("任务"));
  assert(zh.includes("设置"));
  assert(zh.indexOf("总览") < zh.indexOf("用量"));
  assert(zh.indexOf("用量") < zh.indexOf("员工"));
  assert(!zh.includes("智能体"));
  assert(!zh.includes("日历"));
  assert(!zh.includes("待处理"));
  assert(!zh.includes("历史"));
});

test("legacy mission-control routes resolve to dashboard sections", async () => {
  const { resolveLegacyDashboardSectionForSmoke, resolveDashboardSection } = await import("../src/ui/server");

  assert.equal(resolveLegacyDashboardSectionForSmoke("/calendar"), "projects-tasks");
  assert.equal(resolveLegacyDashboardSectionForSmoke("/heartbeat"), "overview");
  assert.equal(resolveLegacyDashboardSectionForSmoke("/tools"), "settings");
  assert.equal(resolveLegacyDashboardSectionForSmoke("/not-a-route"), undefined);
  assert.equal(resolveDashboardSection(new URLSearchParams("section=alerts")), "overview");
  assert.equal(resolveDashboardSection(new URLSearchParams("section=replay-audit")), "overview");
});

test("tasks section prioritizes schedule and cron before tracked task detail", async () => {
  const source = await readFile("src/ui/server.ts", "utf8");
  assert(source.includes('<section class="card" id="calendar-board">'));
  assert(source.includes('id="task-timeline"'));
  assert(source.includes('t("Today and next schedule", "今日与下一批排程")'));
  assert(source.includes('<section class="card" id="cron-execution-board">'));
  assert(source.includes('id="tracked-task-view"'));
  assert(source.includes('const hasTrackedTaskPanels = tasks.length > 0 || pendingDecisionCount > 0 || taskCertaintyCards.length > 0;'));
  assert(source.includes('t("Tracked tasks and follow-up", "跟踪任务与跟进")'));
  assert(source.includes("Start with schedule and cron execution. Staff can be active from cron or ad-hoc sessions even when there is no tracked task row yet."));
  assert(source.includes("先看排程和 Cron 执行。员工显示在工作，可能只是 Cron 或临时会话在跑，不一定已经落成可跟踪的任务条目。"));
  assert(source.includes('<section class="task-hub-shell" id="task-hub">'));
  assert(source.includes('id="task-decision-center"'));
  assert(source.includes('<section class="card" id="task-lane">'));
  assert(source.includes('id="task-execution-chain"'));
  assert(source.includes('t("Execution chain", "执行链")'));
  assert(source.includes('Accepted and spawned child sessions'));
  assert(source.includes('if (options.section === "calendar") sectionBody = projectsSection;'));
});

test("global visibility card keeps plain-language EN/ZH copy for four key signals", async () => {
  const { renderGlobalVisibilityCardForSmoke } = await import("../src/ui/server");

  const en = renderGlobalVisibilityCardForSmoke("en");
  assert(en.includes("Global Visibility"));
  assert(en.includes("One place to see timed jobs, heartbeat, current tasks, and tool calls."));
  assert(en.includes("Timed jobs:"));
  assert(en.includes("Heartbeat checks:"));
  assert(en.includes("Current tasks:"));
  assert(en.includes("Tool calls:"));
  assert(en.includes("Timed jobs are on."));
  assert(en.includes("Heartbeat is on."));
  assert(en.includes("Active timed jobs: 1."));
  assert(en.includes("Active heartbeat checks: 1."));
  assert(en.includes('/?compact=1&amp;section=overview&amp;lang=en&amp;quick=all#cron-health'));
  assert(en.includes('/?compact=1&amp;section=overview&amp;lang=en&amp;quick=all#heartbeat-health'));
  assert(en.includes('/?compact=1&amp;section=projects-tasks&amp;lang=en&amp;quick=all#tracked-task-view'));
  assert(en.includes('/?compact=1&amp;section=overview&amp;lang=en&amp;quick=all#tool-activity'));
  assert(!en.includes('href="/cron"'));
  assert(!en.includes('href="/sessions"'));

  const zh = renderGlobalVisibilityCardForSmoke("zh");
  assert(zh.includes("全局总览"));
  assert(zh.includes("一眼看四件事：定时任务、任务心跳、当前任务、工具调用。"));
  assert(zh.includes("定时任务："));
  assert(zh.includes("任务心跳："));
  assert(zh.includes("当前任务："));
  assert(zh.includes("工具调用："));
  assert(zh.includes("定时任务正在运行。"));
  assert(zh.includes("任务心跳已开启。"));
  assert(zh.includes("已开启定时任务：1 个。"));
  assert(zh.includes("已开启任务心跳：1 个。"));
  assert(!zh.includes("Global Visibility"));
  assert(!zh.includes("Schedule checks (cron):"));
  assert(!zh.includes("Heartbeat checks:"));
  assert(!zh.includes("Tasks in progress:"));
  assert(zh.includes('/?compact=1&amp;section=overview&amp;lang=zh&amp;quick=all#cron-health'));
  assert(zh.includes('/?compact=1&amp;section=overview&amp;lang=zh&amp;quick=all#heartbeat-health'));
  assert(zh.includes('/?compact=1&amp;section=projects-tasks&amp;lang=zh&amp;quick=all#tracked-task-view'));
  assert(zh.includes('/?compact=1&amp;section=overview&amp;lang=zh&amp;quick=all#tool-activity'));
  assert(!zh.includes('href="/cron"'));
  assert(!zh.includes('href="/sessions"'));
});

test("overview and task certainty lean on runtime evidence instead of manual due or blocked fields", async () => {
  const source = await readFile("src/ui/server.ts", "utf8");
  const commanderSource = await readFile("src/runtime/commander.ts", "utf8");

  assert(source.includes('const pendingDecisionCount = actionQueue.counts.unacked;'));
  assert(source.includes("const sessionErrorCount = exceptions.errors.length;"));
  assert(source.includes('const sessionBlockedCount = exceptions.blocked.filter((session) => session.state === "blocked").length;'));
  assert(source.includes('const stalledRunningSessionCount = countStalledRunningSessions('));
  assert(source.includes('t("Review queue", "审阅队列")'));
  assert(source.includes('t("Runtime issues", "运行异常")'));
  assert(source.includes('t("Stalled runs", "停滞执行")'));
  assert(source.includes('pickUiText(input.language, "No execution session is linked yet.", "还没有关联执行会话。")'));
  assert(source.includes('pickUiText(input.language, "A linked session is blocked.", "有会话已经进入阻塞状态。")'));
  assert(!source.includes('const pendingDecisionCount = actionQueue.counts.unacked + pendingApprovalsCount;'));
  assert(!source.includes('const sessionErrorCount = snapshot.sessions.filter((session) => session.state === "error").length;'));
  assert(!source.includes('if (task.dueAt) score += 8;'));
  assert(!source.includes('if (task.status === "blocked") score -= 18;'));
  assert(!source.includes('if (overdue) score -= 18;'));
  assert(commanderSource.includes("const CURRENT_RUNTIME_ISSUE_WINDOW_MS = 6 * 60 * 60 * 1000;"));
  assert(commanderSource.includes("isFreshRuntimeIssueSession(s.lastMessageAt, nowMs)"));
});

test("execution chain cards keep raw JSON out of visible titles and summaries", async () => {
  const { renderTaskExecutionChainCardsForSmoke } = await import("../src/ui/server");
  const source = await readFile("src/ui/server.ts", "utf8");

  const zh = renderTaskExecutionChainCardsForSmoke("zh");
  assert(zh.includes("Main · Cron 隔离执行"));
  assert(zh.includes("失败 · 错误 locked"));
  assert(zh.includes("成功 · 查询 30 · 成功 2 · 入选 2 · 发送 2"));
  assert(zh.includes("已接单 · 已派发 · 会话键推断 · 推断值"));
  assert(zh.includes('class="execution-chain-context"'));
  assert(zh.includes('class="execution-chain-flow"'));
  assert(zh.includes('class="execution-chain-summary"'));
  assert(!zh.includes('<strong>{&quot;ok&quot;:true'));
  assert(!zh.includes('<strong>{&quot;ok&quot;:false'));
  assert(!zh.includes('&quot;attemptedQueries&quot;:30'));
  assert(!zh.includes('&quot;error&quot;:&quot;locked&quot;'));
  assert(!zh.includes("accepted=yes | spawned=yes"));
  assert(source.includes("grid-template-columns: repeat(auto-fit, minmax(min(100%, 520px), 1fr));"));
  assert(source.includes(".execution-chain-context {"));
  assert(source.includes(".execution-chain-flow {"));
  assert(source.includes(".execution-chain-summary {"));
});

test("dashboard keeps global visibility as overview-only block", async () => {
  const source = await readFile("src/ui/server.ts", "utf8");
  const usageSource = await readFile("src/runtime/usage-cost.ts", "utf8");
  assert(source.includes('data-ui-polish="apple-native-v3"'));
  assert(source.includes("const globalVisibilityCard = renderGlobalVisibilityCard(globalVisibilityModel, options.language);"));
  assert(source.includes("const globalVisibilityQuickRows = ["));
  assert(source.includes("const sidebarSignalRows ="));
  assert(
    source.includes(
      "const globalVisibilityBlock = options.section === \"overview\" ? globalVisibilityCard : \"\";",
    ),
  );
  assert(source.includes('<div class="content-stack">${globalVisibilityBlock}${sectionBody}</div>'));
  assert(source.includes("heartbeat: enabledHeartbeatCount"));
  assert(source.includes("const toolCallsCount = input.toolCallsCount ?? (await countRecentToolCalls(snapshot, toolClient));"));
  assert(source.includes("if (typeof item.toolEventCount === \"number\") return sum + item.toolEventCount;"));
  assert(source.includes("const scheduleSignalText = scheduleRow?.currentAction ?? noSignalText;"));
  assert(source.includes("<small>${escapeHtml(scheduleSignalText)}</small>"));
  assert(source.includes('const language: UiLanguage = hasExplicitLanguage ? resolvedLanguage : "zh";'));
  assert(!source.includes("const recentToolCallsCount = sessionPreview.items.filter((item) => item.latestKind === \"tool_event\").length;"));
  assert(source.includes("const languageToggle = renderLanguageToggle(filters, options);"));
  assert(source.includes("${languageToggle}"));
  assert(source.includes('<section class="overview-v3-shell" id="overview-decision-home">'));
  assert(source.includes('id="overview-decision-center"'));
  assert(source.includes('id="overview-busy-staff"'));
  assert(source.includes('id="overview-runtime-checkpoint"'));
  assert(source.includes('t("Isolated execution", "隔离执行")'));
  assert(source.includes('Accepted and spawned child sessions'));
  assert(source.includes("${sidebarSignalRows}"));
  assert(source.includes("Open current tasks"));
  assert(source.includes("查看当前任务"));
  assert(source.includes("Open follow-up items"));
  assert(source.includes("查看待处理"));
  assert(source.includes("formatSeconds(job.dueInSeconds, options.language)"));
  assert(!source.includes("formatSeconds(job.dueInSeconds))"));
  assert(source.includes("const spriteBoundsCache = new Map();"));
  assert(source.includes("const computeSpriteBounds = (sprite) => {"));
  assert(source.includes("Recommended data connections"));
  assert(!source.includes("const informationCertaintyCard = renderInformationCertaintyCard(informationCertainty, options.language);"));
  assert(!source.includes("const taskCertaintySection = renderTaskCertaintySection(taskCertaintyCards, options.language);"));
  assert(!source.includes("${informationCertaintyCard}"));
  assert(!source.includes("${taskCertaintySection}"));
  assert(source.includes('const usageCostMode: UsageCostMode = "full";'));
  assert(source.includes("loadCachedUsageCost(snapshot, usageCostMode)"));
  assert(source.includes("loadCachedOfficeSessionPresence()"));
  assert(source.includes("loadCachedTaskEvidenceSessions("));
  assert(source.includes("const taskSignalItems = mergeSessionConversationItems(taskEvidenceItems, sessionPreview.items);"));
  assert(source.includes("const liveSessionCount = officePresence.totalActiveSessions;"));
  assert(source.includes("buildTaskDetailHref(task.taskId, input.language)"));
  assert(source.includes('const language = resolveUiLanguage(url.searchParams, "zh");'));
  assert(source.includes('buildUsageCostSnapshot(snapshot, mode)'));
  assert(source.includes('const needsSessionPreview = activeSection === "projects-tasks" || activeSection === "overview";'));
  assert(source.includes("const allApprovals = [...(snapshot.approvals ?? [])].sort(compareApprovals);"));
  assert(source.includes('const pendingApprovalsCount = allApprovals.filter((item) => item.status === "pending").length;'));
  assert(source.includes("replayPreview.stats.timeline.total"));
  assert(source.includes('t("Replay activity", "活动回放")'));
  assert(source.includes('t("Approval requests", "审批请求")'));
  assert(source.includes('route: "/?section=projects-tasks&quick=attention#tracked-task-view"'));
  assert(source.includes('route: "/audit"'));
  assert(source.includes('route: "/digest/latest"'));
  assert(source.includes("void primeUiRenderCaches(toolClient);"));
  assert(source.includes("const sourceStamp = await readReadModelSourceStamp();"));
  assert(source.includes("const sessions = mapSessionsListToSummaries(live);"));
  assert(!source.includes('state: item.active ? "running" : "idle"'));
  assert(usageSource.includes("const USAGE_SOURCE_CACHE_TTL_MS = 10_000;"));
  assert(usageSource.includes("loadCachedRuntimeUsageData()"));
  assert(usageSource.includes("loadCachedSubscriptionUsage()"));
  assert(source.includes('t("See four signals in overview", "在总览查看四项信号")'));
  assert(source.includes('t("Data source not connected", "数据源未连接")'));
  assert(source.includes('t("Recent usage", "近期用量")'));
  assert(!source.includes("task.sessionKeys.slice(0, 6)"));
  assert(source.includes("确定性判断"));
});

test("heartbeat API routes are implemented in UI server", async () => {
  const source = await readFile("src/ui/server.ts", "utf8");
  assert(source.includes('if (method === "GET" && path === "/api/tasks/heartbeat")'));
  assert(source.includes('if (method === "POST" && path === "/api/tasks/heartbeat")'));
  assert(source.includes("runTaskHeartbeat({ gate })"));
});

test("overview focus ring keeps a compact English label and stable inner layout", async () => {
  const source = await readFile("src/ui/server.ts", "utf8");
  assert(source.includes('aria-label="${escapeHtml(t("Health score", "健康分"))}"'));
  assert(source.includes('t("Health", "健康分")'));
  assert(source.includes("grid-template-rows: auto auto;"));
  assert(source.includes("justify-items: center;"));
  assert(source.includes("text-align: center;"));
  assert(source.includes("max-width: 56px;"));
});

test("overview page title expands to Overview Control Center in English only", async () => {
  const source = await readFile("src/ui/server.ts", "utf8");
  assert(source.includes('function resolveDashboardSectionTitle(section: DashboardSectionLink, language: UiLanguage): string {'));
  assert(source.includes('if (language === "en" && section.key === "overview") {'));
  assert(source.includes('return "Overview Control Center";'));
  assert(source.includes("const sectionTitle = resolveDashboardSectionTitle(sectionMeta, options.language);"));
  assert(source.includes('<h2 class="section-title">${escapeHtml(sectionTitle)}</h2>'));
});

test("usage dashboard includes token type share and cron token share sections", async () => {
  const source = await readFile("src/ui/server.ts", "utf8");
  assert(source.includes("AI 用量构成（全部会话）"));
  assert(source.includes("定时任务用量占比"));
  assert(source.includes("定时任务内各智能体占比"));
  assert(source.includes("usage_view"));
  assert(source.includes("今天"));
  assert(source.includes("累计"));
  assert(source.includes("定时任务、Discord、Telegram、内部会话"));
  assert(source.includes("renderTokenShareRows("));
  assert(source.includes("usageCost.breakdownToday"));
  assert(source.includes("selectedUsageBreakdown.bySessionType"));
  assert(source.includes("selectedUsageBreakdown.byCronJob"));
  assert(source.includes("selectedUsageBreakdown.byCronAgent"));
});

test("memory and workspace sections expose editable file workbenches", async () => {
  const source = (await readFile("src/ui/server.ts", "utf8")).replace(/\r\n/g, "\n");
  assert(source.includes("/api/files"));
  assert(source.includes("/api/files/content"));
  assert(source.includes("scope must be one of: memory, workspace"));
  assert(source.includes('title: t("Memory file workbench", "记忆文件工作台")'));
  assert(source.includes('Main ${escapeHtml(t("memories", "记忆"))}'));
  assert(source.includes('${escapeHtml(t("Available views", "可切换查看"))}'));
  assert(source.includes('const agentProfileFiles = ["MEMORY.md"];'));
  assert(!source.includes('const agentProfileFiles = ["MEMORY.md", "USER.md", "SOUL.md", "IDENTITY.md"];'));
  assert(source.includes('const SHARED_DOCUMENT_FILE_CANDIDATES = ['));
  assert(source.includes('const AGENT_DOCUMENT_FILE_CANDIDATES = ['));
  assert(source.includes('"IDENTITY.md"'));
  assert(source.includes('"SOUL.md"'));
  assert(source.includes('"BOOTSTRAP.md"'));
  assert(source.includes("listMemoryFacetOptions()"));
  assert(source.includes("listWorkspaceFacetOptions()"));
  assert(source.includes("facetOptions: memoryFacetOptions"));
  assert(source.includes("facetOptions: workspaceFacetOptions"));
  assert(source.includes("defaultFacetKey: \"main\""));
  assert(source.includes("defaultFacetKey: \"main\""));
  assert(source.includes("includeAllFacet: false"));
  assert(source.includes("data-default-facet"));
  assert(source.includes(".file-nav-item[hidden]"));
  assert(source.includes("item.style.display = visible ? \"\" : \"none\";"));
  assert(source.includes("currentGroup"));
  assert(source.includes("可在左侧选择具体文件"));
  assert(source.includes("data-file-facet"));
  assert(source.includes("const normalizeFacetKey = (value) => String(value || 'all').trim().toLowerCase() || 'all';"));
  assert(source.includes(".segment-switch {"));
  assert(source.includes("display: inline-flex;"));
  assert(source.includes("flex-wrap: wrap;"));
  assert(source.includes(".segment-item {"));
  assert(source.includes("appearance: none;"));
  assert(source.includes("border: none;"));
  assert(source.includes("background: transparent;"));
  assert(source.includes("min-height: 40px;"));
  assert(source.includes(".file-facet-switch .segment-item {"));
  assert(source.includes(".file-facet-switch .segment-item.active {"));
  assert(source.includes("文档工作台"));
  assert(source.includes("文档概览"));
  assert(source.includes('t("Main documents", "Main 文档")'));
  assert(source.includes("核心 Markdown"));
  assert(source.includes("不再按会话历史展示文档"));
  assert(source.includes("resolveEditableAgentScopesFromConfig("));
  assert(source.includes("loadEditableAgentScopesFromConfig()"));
  assert(source.includes("loadEditableAgentScopesFromWorkspaceDirs()"));
  assert(source.includes("data-quota-reset-at"));
  assert(source.includes("renderQuotaResetScript()"));
  assert(source.includes("new Intl.DateTimeFormat(undefined"));
  assert(source.includes("OPENCLAW_WORKSPACE_ROOT"));
  assert(source.includes("保存后会直接写回源文件"));
  assert(source.includes("renderFileWorkbenchScript()"));
  assert(source.includes('t("Staff overview", "员工总览")'));
  assert(source.includes('t("The default view shows only name, role, current status, current work, recent output, and whether each person is on the schedule."'));
  assert(source.includes("async function resolveStaffRoleLabel("));
  assert(source.includes('return pickUiText(language, "YouTube to article writing", "YouTube 视频转长文");'));
  assert(source.includes('return pickUiText(language, "High-value content creation", "高价值内容创作");'));
  assert(source.includes('return pickUiText(language, "Control Center delivery", "控制中心开发与交付");'));
  assert(source.includes('return pickUiText(language, "Daily news and trend briefings", "每日情报与趋势简报");'));
  assert(source.includes('return pickUiText(language, "Personal assistance and reminders", "私人助理与提醒");'));
  assert(source.includes('return pickUiText(language, "Security and updates", "安全和更新");'));
  assert(source.includes('return pickUiText(language, "Role not defined in workspace", "工作区未写明职责");'));
  assert(source.includes('function staffStatusLabel('));
  assert(source.includes('pickUiText(language, "Status", "当前状态")'));
  assert(source.includes('pickUiText(language, "Working on", "正在处理什么")'));
  assert(source.includes('pickUiText(language, "Recent output", "最近产出")'));
  assert(source.includes('pickUiText(language, "In schedule", "是否在排班里")'));
  assert(source.includes('const staffOverviewCards = needsTeamSnapshot'));
  assert(source.includes(".staff-brief-grid {\n      margin-top: 12px;\n      display: grid;\n      grid-template-columns: repeat(3, minmax(0, 1fr));"));
  assert(source.includes('<canvas class="agent-pixel-canvas" width="256" height="256"></canvas>'));
  assert(source.includes("querySelectorAll('.agent-avatar, .staff-avatar')"));
  assert(source.includes('data-animal="${escapeHtml(card.identity.animal)}"'));
  assert(source.includes('t("Shared staff mission", "员工共同目标")'));
  assert(source.includes('t("Staff system details", "员工配置明细")'));
  assert(source.includes("renderOfficeCards("));
  assert(source.includes("no network polling and no extra token usage"));
  assert(source.includes("window.requestAnimationFrame(step);"));
  assert(source.includes("headers[\"cache-control\"] = \"no-store, no-cache, must-revalidate, max-age=0\";"));
  assert(source.includes("headers.pragma = \"no-cache\";"));
  assert(source.includes("headers.expires = \"0\";"));
  assert(!source.includes('return pickUiText(language, "Fast execution", "快速推进");'));
  assert(!source.includes('return pickUiText(language, "Planning and organization", "排程与整理");'));
  assert(!source.includes("Workspace 文件工作台"));
  assert(!source.includes("聊天输出结构化入库（"));
  assert(!source.includes("办公室 2D 实况"));
  assert(!source.includes("完整智能体名录（"));
  assert(!source.includes("office-scene-stage"));
  assert(!source.includes("zone-watercooler"));
});

test("editable agent scopes follow configured agents before workspace folders", async () => {
  const {
    resolveEditableAgentScopesFromConfigForSmoke,
    resolveEditableAgentScopesWithFallbackForSmoke,
  } = await import("../src/ui/server");

  const scopes = resolveEditableAgentScopesFromConfigForSmoke({
    agents: {
      list: [
        { id: "pandas", workspace: "/tmp/pandas" },
        { id: "tiger", workspace: "/tmp/tiger" },
      ],
    },
  });

  assert.deepEqual(
    scopes.map((item) => item.facetKey),
    ["main", "pandas", "tiger"],
  );
  assert.equal(scopes[0]?.facetLabel, "Main");
  assert(!scopes.some((item) => item.facetKey === "dolphin"));
  assert(!scopes.some((item) => item.facetKey === "mission-ops"));

  const guardedScopes = resolveEditableAgentScopesWithFallbackForSmoke({
    configText: "{not-json",
    workspaceAgentIds: ["dolphin", "mission-ops", "pandas"],
  });
  assert.deepEqual(
    guardedScopes.map((item) => item.facetKey),
    ["main"],
  );
});

test("search helpers keep total matches separate from returned rows", async () => {
  const { buildDashboardSearchResultForSmoke } = await import("../src/ui/server");

  const snapshot: ReadModelSnapshot = {
    sessions: [
      {
        sessionKey: "sess-alpha-1",
        label: "Alpha One",
        agentId: "panda",
        state: "running",
        lastMessageAt: "2026-03-10T10:00:00.000Z",
      },
      {
        sessionKey: "sess-alpha-2",
        label: "Alpha Two",
        agentId: "tiger",
        state: "idle",
        lastMessageAt: "2026-03-10T09:00:00.000Z",
      },
    ],
    statuses: [],
    cronJobs: [],
    approvals: [],
    projects: {
      updatedAt: "2026-03-10T10:00:00.000Z",
      projects: [
        {
          projectId: "proj-alpha",
          title: "Alpha rollout",
          status: "active",
          owner: "panda",
          updatedAt: "2026-03-10T10:00:00.000Z",
        },
      ],
    },
    projectSummaries: [],
    tasks: {
      updatedAt: "2026-03-10T10:00:00.000Z",
      agentBudgets: [],
      tasks: [
        {
          projectId: "proj-alpha",
          taskId: "task-alpha-1",
          title: "Alpha first",
          status: "todo",
          owner: "panda",
          definitionOfDone: [],
          artifacts: [],
          rollback: { strategy: "none", steps: [] },
          sessionKeys: ["sess-alpha-1"],
          budget: {},
          updatedAt: "2026-03-10T10:00:00.000Z",
        },
        {
          projectId: "proj-alpha",
          taskId: "task-alpha-2",
          title: "Alpha second",
          status: "blocked",
          owner: "tiger",
          definitionOfDone: [],
          artifacts: [],
          rollback: { strategy: "none", steps: [] },
          sessionKeys: ["sess-alpha-2"],
          budget: {},
          updatedAt: "2026-03-10T10:01:00.000Z",
        },
      ],
    },
    tasksSummary: {
      projects: 1,
      tasks: 2,
      todo: 1,
      inProgress: 0,
      blocked: 1,
      done: 0,
      owners: 2,
      artifacts: 0,
    },
    budgetSummary: { total: 0, ok: 0, warn: 0, over: 0, evaluations: [] },
    generatedAt: "2026-03-10T10:05:00.000Z",
  };

  const taskResult = buildDashboardSearchResultForSmoke(snapshot, { scope: "tasks", q: "alpha", limit: 1 });
  assert(taskResult);
  assert.equal(taskResult.count, 2);
  assert.equal(taskResult.returned, 1);

  const sessionResult = buildDashboardSearchResultForSmoke(snapshot, {
    scope: "sessions",
    q: "alpha",
    limit: 1,
  });
  assert(sessionResult);
  assert.equal(sessionResult.count, 2);
  assert.equal(sessionResult.returned, 1);
});

test("search APIs advertise total match counts and bounded returned rows", async () => {
  const source = await readFile("src/ui/server.ts", "utf8");
  const apiDocsSource = await readFile("src/runtime/api-docs.ts", "utf8");

  assert(source.includes("count: matches.length,"));
  assert(source.includes("returned: tasks.length,"));
  assert(source.includes("returned: projects.length,"));
  assert(source.includes("returned: sessions.length,"));
  assert(source.includes("returned: items.length,"));
  assert(source.includes('const snapshot = await readReadModelSnapshotWithLiveSessions(toolClient);'));
  assert(source.includes("function buildBoundedSearchResult<T>(items: T[], limit: number): {"));
  assert(apiDocsSource.includes('count: "number (total matches before limit)"'));
  assert(apiDocsSource.includes('returned: "number (items returned in this response)"'));
  assert(apiDocsSource.includes('count: "number (total matches before limit, including live-merged sessions)"'));
});

test("import live input turns invalid file paths into validation errors", async () => {
  const { resolveImportInputForSmoke } = await import("../src/runtime/import-live");

  const result = await resolveImportInputForSmoke({ fileName: "../outside.json" });
  assert.equal(result.ok, false);
  assert.equal(result.validation.valid, false);
  assert.match(result.validation.issues[0] ?? "", /outside runtime exports directory/i);
});

test("session links stay on the session detail UI and docs index accepts language", async () => {
  const source = await readFile("src/ui/server.ts", "utf8");

  assert(source.includes('function buildSessionDetailHref(sessionKey: string, language: UiLanguage): string {'));
  assert(source.includes('const language = resolveUiLanguage(url.searchParams, "zh");'));
  assert(source.includes('const html = renderSessionDrilldownPage(detail, language);'));
  assert(source.includes('assertAllowedQueryParams(url.searchParams, ["lang"], true);'));
  assert(source.includes('Open document workbench'));
  assert(source.includes('Back to control center'));
  assert(!source.includes('href="/sessions/${encodeURIComponent(item.sessionKey)}"'));
  assert(source.includes('Available views", "可切换查看"))}${escapeHtml(options.language === "en" ? ": " : "：")}'));
  assert(source.includes('function joinDisplayList(items: string[], language: UiLanguage): string {'));
});

test("navigation script does not add artificial leave delay", async () => {
  const source = await readFile("src/ui/server.ts", "utf8");
  assert(source.includes("window.location.href = href;"));
  assert(!source.includes("window.setTimeout(() => {\n      window.location.href = href;\n    }, 120);"));
});

test("agent animal identity mapping is semantic-first and deterministic", async () => {
  const { deriveAgentAnimalIdentity } = await import("../src/ui/server");

  const codex = deriveAgentAnimalIdentity("codex");
  assert.equal(codex.animal, "robot");

  const panda = deriveAgentAnimalIdentity("pandas-control");
  assert.equal(panda.animal, "panda");

  const leader = deriveAgentAnimalIdentity("main");
  assert.equal(leader.animal, "lion");

  const otter = deriveAgentAnimalIdentity("otter");
  assert.equal(otter.animal, "otter");

  const rooster = deriveAgentAnimalIdentity("coq");
  assert.equal(rooster.animal, "rooster");

  const tiger = deriveAgentAnimalIdentity("tiger");
  assert.equal(tiger.animal, "tiger");

  const fallbackA = deriveAgentAnimalIdentity("zxq-agent-42");
  const fallbackB = deriveAgentAnimalIdentity("zxq-agent-42");
  assert.equal(fallbackA.animal, fallbackB.animal);
  assert.equal(typeof fallbackA.title, "string");
  assert.notEqual(fallbackA.title, "");
});

test("subscription card renders explicit unavailable states for missing fields", async () => {
  const { renderSubscriptionStatusCardForSmoke } = await import("../src/ui/server");

  const html = renderSubscriptionStatusCardForSmoke({
    status: "partial",
    planLabel: "Pro Monthly",
    unit: "USD",
    detail: "Partial billing fields available.",
    connectHint: "Provide subscription snapshot path.",
  });

  assert(html.includes("Pro Monthly"));
  assert(html.includes("Used Unavailable: subscription data is missing &quot;consumed&quot;"));
  assert(html.includes("Remaining Unavailable: subscription data is missing &quot;remaining&quot;"));
  assert(html.includes("Unavailable: subscription data is missing &quot;limit&quot;"));
  assert(html.includes("Cycle"));
  assert(html.includes("Not provided"));
});

test("subscription card normalizes near-week minute labels before rendering", async () => {
  const { renderSubscriptionStatusCardForSmoke } = await import("../src/ui/server");

  const html = renderSubscriptionStatusCardForSmoke({
    status: "connected",
    planLabel: "Codex Live",
    unit: "%",
    detail: "Live Codex rate limits.",
    connectHint: "",
    consumed: 2,
    remaining: 98,
    limit: 100,
    usagePercent: 2,
    primaryWindowLabel: "300m",
    primaryUsedPercent: 2,
    primaryRemainingPercent: 98,
    primaryResetAt: "2026-03-11T11:30:05.000Z",
    secondaryWindowLabel: "10081m",
    secondaryUsedPercent: 1,
    secondaryRemainingPercent: 99,
    secondaryResetAt: "2026-03-18T06:31:05.000Z",
  });

  assert(html.includes(">5h<"));
  assert(html.includes(">Week<"));
  assert(!html.includes(">300m<"));
  assert(!html.includes(">10081m<"));
});

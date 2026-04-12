import type { UiLanguage } from "../runtime/ui-preferences";
import type {
  CollaborationHall,
  CollaborationHallSummary,
  HallFileAttachment,
  HallMessage,
  HallParticipant,
  HallExecutionItem,
  HallTaskCard,
  HallTaskSummary,
  ProjectTask,
  TaskArtifact,
} from "../types";
import { renderCollaborationHallTheme } from "./collaboration-hall-theme";

interface HallTaskCardViewModel {
  card: HallTaskCard;
  summary?: HallTaskSummary;
  task?: ProjectTask;
}

const HALL_AVATAR_CATALOG = [
  { keywords: ["turing", "图灵"], animal: "lion", accent: "#ff9966", asset: "turing-pm.png", customImage: "turing-pm.png" },
  { keywords: ["codd", "科德"], animal: "dolphin", accent: "#73d4ff", asset: "codd-clinical-data.png", customImage: "codd-clinical-data.png" },
  { keywords: ["linus", "林纳斯"], animal: "tiger", accent: "#ff8a7d", asset: "linus-dev.png", customImage: "linus-dev.png" },
  { keywords: ["rosalind", "罗莎琳德"], animal: "panda", accent: "#9df2ff", asset: "rosalind-bioinfo.png", customImage: "rosalind-bioinfo.png" },
  { keywords: ["ada", "阿达"], animal: "otter", accent: "#8ad1ff", asset: "ada-data-scientist.png", customImage: "ada-data-scientist.png" },
  { keywords: ["florence", "弗洛伦斯"], animal: "monkey", accent: "#f4c542", asset: "florence-compliance.png", customImage: "florence-compliance.png" },
  { keywords: ["coq", "rooster", "cock"], animal: "rooster", accent: "#ffb85e", asset: "coq.png" },
  { keywords: ["main", "lion"], animal: "lion", accent: "#ff9966", asset: "main.png", customImage: "main.jpg" },
  { keywords: ["monkey"], animal: "monkey", accent: "#f4c542", asset: "monkey.png" },
  { keywords: ["otter"], animal: "otter", accent: "#8ad1ff", asset: "otter.png" },
  { keywords: ["pandas", "panda"], animal: "panda", accent: "#9df2ff", asset: "pandas.png" },
  { keywords: ["tiger"], animal: "tiger", accent: "#ff8a7d", asset: "tiger.png" },
  { keywords: ["dolphin"], animal: "dolphin", accent: "#73d4ff", asset: "dolphin.png" },
  { keywords: ["owl"], animal: "owl", accent: "#c6b7ff", asset: "codex.png" },
  { keywords: ["fox"], animal: "fox", accent: "#ffb16e", asset: "codex.png" },
  { keywords: ["bear"], animal: "bear", accent: "#b18d68", asset: "codex.png" },
  { keywords: ["eagle"], animal: "eagle", accent: "#ffcd77", asset: "codex.png" },
  { keywords: ["operator", "human", "user", "robot", "codex"], animal: "robot", accent: "#8aa7ff", asset: "codex.png" },
] as const;

export interface RenderCollaborationHallInput {
  language: UiLanguage;
  hall: CollaborationHall;
  hallSummary: CollaborationHallSummary;
  taskCards: HallTaskCardViewModel[];
  messages: HallMessage[];
  selectedTaskCard?: HallTaskCard;
  selectedTaskSummary?: HallTaskSummary;
  selectedTask?: ProjectTask;
}

export function renderCollaborationHall(input: RenderCollaborationHallInput): string {
  const t = (en: string, zh: string) => pickUiText(input.language, en, zh);
  const hallHeadline = hallHeadlineText(input.hallSummary.headline, input.language, Boolean(input.selectedTaskCard));
  const threadTitle = input.selectedTaskCard?.title ?? t("Hall chat", "大厅群聊");
  const threadSubtitle = input.selectedTaskCard
    ? formatCompactTimestamp(input.selectedTaskCard.updatedAt, input.language)
    : t("A shared group chat where agents collaborate autonomously.", "智能体在群聊中自主协作。");
  const bootstrap = {
    hallId: input.hall.hallId,
    selectedTaskCardId: input.selectedTaskCard?.taskCardId,
    participants: input.hall.participants.map((participant) => ({
      participantId: participant.participantId,
      displayName: participant.displayName,
      semanticRole: participant.semanticRole,
    })),
    taskCards: input.taskCards.map((item) => ({
      taskCardId: item.card.taskCardId,
      projectId: item.card.projectId,
      taskId: item.card.taskId,
      title: item.card.title,
      stage: item.card.stage,
      status: item.card.status,
      currentOwnerLabel: item.card.currentOwnerLabel,
      roomId: item.card.roomId,
      headline: item.summary?.headline,
      updatedAt: item.card.updatedAt,
    })),
    selectedTaskDetail: input.selectedTaskCard
      ? {
          taskCard: input.selectedTaskCard,
          taskSummary: input.selectedTaskSummary,
          task: input.selectedTask,
        }
      : null,
    labels: {
      sendTask: t("Create task", "创建任务"),
      reply: t("Send reply", "发送回复"),
      archiveThread: t("Archive thread", "归档线程"),
      deleteThread: t("Delete thread", "删除线程"),
      approve: t("Approve", "通过"),
      reject: t("Request changes", "打回修改"),
      handoff: t("Handoff", "交接"),
      loading: t("Loading hall…", "正在加载大厅…"),
      emptyTasks: t("No task cards yet. Start by posting the first task in the hall.", "还没有任务卡。先在大厅里发出第一个任务。"),
      emptyThread: t("No hall messages yet.", "大厅里还没有消息。"),
      composerPlaceholder: t("Describe the task, ask a specific agent, or update the current owner…", "描述任务、点名某个 agent，或者补充当前执行反馈…"),
      approveNote: t("Optional review note", "可选审核备注"),
      rejectNote: t("Why should it change?", "为什么要打回？"),
      handoffGoal: t("Handoff goal", "交接目标"),
      handoffCurrent: t("Current result", "当前结果"),
      handoffDoneWhen: t("Done when", "完成标准"),
      handoffBlockers: t("Blockers (comma separated)", "阻塞项（逗号分隔）"),
      handoffRequires: t("Needs input from (comma separated)", "需要谁配合（逗号分隔）"),
      showContext: t("Show context", "展开上下文"),
      hideContext: t("Hide context", "收起上下文"),
      stop: t("Stop current", "停止当前"),
    },
  };

  return `
    <section class="card collaboration-hall-card is-context-open" id="collaboration-hall" data-collaboration-hall-root>
      <style>${renderCollaborationHallTheme()}</style>
      <div class="hall-shell">
        <div class="hall-toolbar">
          <div class="hall-room-head">
            ${renderHallPixelAvatar(input.hall.title, "hall-room-avatar")}
            <div class="hall-toolbar-copy">
              <div class="hall-room-label">${escapeHtml(t("Shared group chat", "共享群聊"))}</div>
              <h2>${escapeHtml(t("Collaboration Hall", "协作大厅"))}</h2>
              <p data-hall-headline>${escapeHtml(hallHeadline)}</p>
            </div>
          </div>
          <div class="hall-toolbar-meta">
            <div class="hall-member-strip" data-hall-member-strip>${renderParticipantMiniList(input.hall.participants, input.language)}</div>
            <div class="hall-toolbar-meta-note" data-hall-toolbar-note>${escapeHtml(t(`${input.hall.participants.length} agents live in this hall.`, `${input.hall.participants.length} 个 agent 正在大厅里。`))}</div>
          </div>
        </div>
        <div class="hall-layout">
          <aside class="hall-pane hall-pane--sidebar">
            <div class="hall-pane-head">
              <div>
                <h3>${escapeHtml(t("Threads", "线程"))}</h3>
                <div class="meta">${escapeHtml(t("Each task lives like a chat thread.", "每个任务都像一个聊天线程。"))}</div>
              </div>
              <button type="button" class="hall-secondary-button hall-secondary-button--compact" data-hall-compose-task aria-pressed="false" onclick="return window.__openclawHallOpenNewTaskComposer ? window.__openclawHallOpenNewTaskComposer() : true">${escapeHtml(t("New task", "新任务"))}</button>
            </div>
            <div class="hall-task-list" data-hall-task-list>${renderTaskCards(input.taskCards, input.selectedTaskCard?.taskCardId, input.language)}</div>
          </aside>
          <section class="hall-pane hall-pane--thread">
            <div class="hall-thread-head">
              <div class="hall-thread-identity">
                ${renderHallPixelAvatar(input.selectedTaskCard?.currentOwnerLabel ?? input.hall.title, "hall-thread-avatar")}
                <div>
                  <div class="hall-thread-label" data-hall-thread-label>${escapeHtml(input.selectedTaskCard ? t("Task thread", "任务线程") : t("Shared group chat", "共享群聊"))}</div>
                  <h3 data-hall-thread-title>${escapeHtml(threadTitle)}</h3>
                  <div class="hall-thread-subtitle" data-hall-thread-subtitle>${escapeHtml(threadSubtitle)}</div>
                </div>
              </div>
              <div class="hall-thread-head-actions">
                <details class="hall-action-menu hall-action-menu--thread" data-hall-thread-menu hidden>
                  <summary class="hall-secondary-button hall-secondary-button--icon" title="${escapeHtml(t("Thread actions", "线程操作"))}" aria-label="${escapeHtml(t("Thread actions", "线程操作"))}">⋯</summary>
                  <div class="hall-action-menu-panel hall-action-menu-panel--thread">
                    <button type="button" class="hall-menu-button" data-hall-archive-thread>${escapeHtml(t("Archive thread", "归档线程"))}</button>
                    <button type="button" class="hall-menu-button hall-menu-button--danger" data-hall-delete-thread>${escapeHtml(t("Delete thread", "删除线程"))}</button>
                  </div>
                </details>
                <button type="button" class="hall-context-toggle" data-hall-toggle-context aria-pressed="true">${escapeHtml(t("Hide context", "收起上下文"))}</button>
              </div>
            </div>
            <div class="hall-thread" data-hall-thread>${renderHallMessages(input.messages, input.language)}</div>
            <div class="hall-decision-panel" data-hall-decision-panel ${renderInitialDecisionPanel(input.selectedTaskCard, input.selectedTask, input.hall.participants, input.language) ? "" : "hidden"}>${renderInitialDecisionPanel(input.selectedTaskCard, input.selectedTask, input.hall.participants, input.language)}</div>
            <div class="hall-typing-strip" data-hall-typing-strip hidden></div>
            <div class="hall-composer-shell">
              <form class="hall-composer" data-hall-compose>
                <div class="hall-composer-files" data-hall-file-preview hidden></div>
                <div class="hall-composer-main">
                  <textarea
                    name="content"
                    data-hall-composer-textarea
                    placeholder="${escapeHtml(bootstrap.labels.composerPlaceholder)}"
                    onkeydown="return window.__openclawHallHandleComposerKeydown ? window.__openclawHallHandleComposerKeydown(event) : true"
                    onkeyup="return window.__openclawHallHandleComposerKeyup ? window.__openclawHallHandleComposerKeyup(event) : true"
                  ></textarea>
                  <div class="hall-composer-actions">
                    <input type="file" data-hall-file-input multiple accept="image/*,.pdf,.txt,.md,.json,.zip" style="position:absolute;clip:rect(0,0,0,0);width:1px;height:1px;overflow:hidden;border:0;padding:0;margin:-1px" />
                    <button type="button" class="hall-secondary-button hall-secondary-button--icon" data-hall-attach-file title="${escapeHtml(t("Attach file", "附件"))}" aria-label="${escapeHtml(t("Attach file", "附件"))}">&#x1F4CE;</button>
                    <button type="submit" class="hall-button hall-button--send" data-hall-send-reply onclick="return window.__openclawHallSendReply ? window.__openclawHallSendReply(event) : true">${escapeHtml(bootstrap.labels.reply)}</button>
                  </div>
                </div>
                <div class="hall-composer-accessory">
                  <div class="hall-mention-list hall-mention-list--inline" data-hall-mention-list>${renderMentionChips(input.hall.participants, input.language)}</div>
                </div>
                <div class="hall-flash" data-hall-flash></div>
              </form>
            </div>
          </section>
          <aside class="hall-pane hall-pane--context" data-hall-context-pane>
            <div class="hall-pane-head">
              <div class="hall-pane-head-copy">
                <h3>${escapeHtml(t("Context", "上下文"))}</h3>
                <div class="meta">${escapeHtml(t("Support the chat with owner, decision, evidence, and review state.", "这里只做群聊的辅助上下文：owner、决策、证据和审核状态。"))}</div>
              </div>
              <button type="button" class="hall-context-toggle hall-context-toggle--inline" data-hall-toggle-context aria-pressed="true">${escapeHtml(t("Hide context", "收起上下文"))}</button>
            </div>
            <div class="hall-detail-group">
              <h4>${escapeHtml(t("Team", "成员"))}</h4>
              <div class="hall-roster">${renderParticipantRoster(input.hall.participants, input.language)}</div>
            </div>
            <div data-hall-detail>${renderHallDetail(input.selectedTaskCard, input.selectedTaskSummary, input.selectedTask, input.hall.participants, input.language)}</div>
          </aside>
        </div>
      </div>
      <script type="application/json" id="collaboration-hall-bootstrap">${safeJsonForScript(bootstrap)}</script>
    </section>
  `;
}

export function renderCollaborationHallClientScript(language: UiLanguage): string {
  return `<script>
(() => {
  const root = document.querySelector('[data-collaboration-hall-root]');
  if (!root) return;
  const bootstrapNode = document.getElementById('collaboration-hall-bootstrap');
  if (!(bootstrapNode instanceof HTMLScriptElement)) return;

  let bootstrap;
  try {
    bootstrap = JSON.parse(bootstrapNode.textContent || '{}');
  } catch {
    return;
  }

  const labels = bootstrap.labels || {};
  const pickUiText = (currentLanguage, en, zh) => currentLanguage === 'zh' ? zh : en;
  const textNoThreads = ${JSON.stringify(pickUiText(language, "No threads yet", "还没有线程"))};
  const textWaitingOwner = ${JSON.stringify(pickUiText(language, "Waiting for owner", "等待 owner"))};
  const textHallQuiet = ${JSON.stringify(pickUiText(language, "The hall is quiet", "大厅现在很安静"))};
  const textDraftFirstTask = ${JSON.stringify(pickUiText(language, "Draft a first task", "起草第一个任务"))};
  const textAskImplementationFirst = ${JSON.stringify(pickUiText(language, "Ask for an implementation take", "先评估实现路径"))};
  const textAskManagerToDecide = ${JSON.stringify(pickUiText(language, "Ask for a close and owner", "先收口并指定执行者"))};
  const textStreaming = ${JSON.stringify(pickUiText(language, "Streaming", "流式中"))};
  const textSingleTyping = ${JSON.stringify(pickUiText(language, "is typing…", "正在输入…"))};
  const textMultiTyping = ${JSON.stringify(pickUiText(language, "are typing…", "正在输入…"))};
  const textTypingNow = ${JSON.stringify(pickUiText(language, "Typing now", "正在输入"))};
  const textExecutingNow = ${JSON.stringify(pickUiText(language, "Executing", "执行中"))};
  const textReviewingNow = ${JSON.stringify(pickUiText(language, "Reviewing", "审核中"))};
  const textQueuedNow = ${JSON.stringify(pickUiText(language, "Queued next", "排队中"))};
  const textIdleNow = ${JSON.stringify(pickUiText(language, "Ready", "待命"))};
  const textDiscussionResult = ${JSON.stringify(pickUiText(language, "Discussion result", "讨论结论"))};
  const textProposal = ${JSON.stringify(pickUiText(language, "Proposal", "方案"))};
  const textDecision = ${JSON.stringify(pickUiText(language, "Decision", "决策"))};
  const textDoneWhen = ${JSON.stringify(pickUiText(language, "Done when", "完成标准"))};
  const textSuggestedOrder = ${JSON.stringify(pickUiText(language, "Suggested order", "建议顺序"))};
  const textSuggestedFirstOwner = ${JSON.stringify(pickUiText(language, "Suggested first owner", "建议第一位执行者"))};
  const textCurrentOwner = ${JSON.stringify(pickUiText(language, "Current owner", "当前 owner"))};
  const textStage = ${JSON.stringify(pickUiText(language, "Stage", "阶段"))};
  const textReadyToStart = ${JSON.stringify(pickUiText(language, "Ready to start", "待开始"))};
  const textStartExecutionPrefix = ${JSON.stringify(pickUiText(language, "Start execution with", "开始执行（"))};
  const textStartExecutionSuffix = ${JSON.stringify(pickUiText(language, ")", "）"))};
  const textPlanExecutionOrder = ${JSON.stringify(pickUiText(language, "Plan execution order", "安排后续顺序"))};
  const textAdjustExecutionOrder = ${JSON.stringify(pickUiText(language, "Adjust execution order", "调整执行顺序"))};
  const textContinueDiscussion = ${JSON.stringify(pickUiText(language, "Continue discussion", "继续讨论"))};
  const textContinueDiscussionSeed = ${JSON.stringify(pickUiText(language, "Let's keep this in discussion for a moment.", "我们先继续讨论这一步，不急着收口。"))};
  const textNeedToken = ${JSON.stringify(pickUiText(language, "This action requires LOCAL_API_TOKEN.", "这个动作需要 LOCAL_API_TOKEN。"))};
  const textTokenPrompt = ${JSON.stringify(pickUiText(language, "Enter LOCAL_API_TOKEN to continue.", "请输入 LOCAL_API_TOKEN 以继续。"))};
  const textTokenRetryPrompt = ${JSON.stringify(pickUiText(language, "The local token was rejected. Enter LOCAL_API_TOKEN again to retry.", "本地令牌验证失败，请重新输入 LOCAL_API_TOKEN 以重试。"))};
  const textQueuedOwners = ${JSON.stringify(pickUiText(language, "Queued owners", "后续顺序"))};
  const textPlanningOrder = ${JSON.stringify(pickUiText(language, "Execution order", "执行顺序"))};
  const textPlannerHint = ${JSON.stringify(pickUiText(language, "Set who should work, what they should do, and when they should hand off.", "设置谁来做、做什么、什么时候交接。"))};
  const textNoQueuedOwners = ${JSON.stringify(pickUiText(language, "No queued owners yet.", "还没有排好后续顺序。"))};
  const textAvailableAgents = ${JSON.stringify(pickUiText(language, "Available agents", "可选 agent"))};
  const textSaveOrder = ${JSON.stringify(pickUiText(language, "Save order", "保存顺序"))};
  const textCancelOrder = ${JSON.stringify(pickUiText(language, "Cancel", "取消"))};
  const textAddToOrder = ${JSON.stringify(pickUiText(language, "Add to execution order", "加入执行顺序"))};
  const textMoveUp = ${JSON.stringify(pickUiText(language, "Move up", "上移"))};
  const textMoveDown = ${JSON.stringify(pickUiText(language, "Move down", "下移"))};
  const textRemove = ${JSON.stringify(pickUiText(language, "Remove", "移除"))};
  const textActionItems = ${JSON.stringify(pickUiText(language, "Action items", "行动项"))};
  const textActionTask = ${JSON.stringify(pickUiText(language, "Task", "任务"))};
  const textActionHandoffTo = ${JSON.stringify(pickUiText(language, "Hand off to", "交给谁"))};
  const textActionHandoffWhen = ${JSON.stringify(pickUiText(language, "Handoff when", "交接条件"))};
  const textNoHandoff = ${JSON.stringify(pickUiText(language, "No handoff", "不交接"))};
  const textActionThen = ${JSON.stringify(pickUiText(language, "Then", "然后"))};
  const textActionThenInline = ${JSON.stringify(pickUiText(language, "; then: ", "；然后："))};
  const textActionThenTo = ${JSON.stringify(pickUiText(language, "Then hand off to", "然后交给"))};
  const textNoActionItems = ${JSON.stringify(pickUiText(language, "No selected executors yet.", "还没有已选执行者。"))};
  const textTaskArtifacts = ${JSON.stringify(pickUiText(language, "Artifacts", "产物"))};
  const textNoArtifactsYet = ${JSON.stringify(pickUiText(language, "No artifacts yet.", "还没有产物。"))};
  const textHandoffPanelTitle = ${JSON.stringify(pickUiText(language, "Prepare handoff", "准备交接"))};
  const textHandoffPanelHint = ${JSON.stringify(pickUiText(language, "Tell the next owner what is done, what remains, and what they should finish.", "把已经完成了什么、还剩什么、下一步该完成什么交代给下一个人。"))};
  const textHandoffTo = ${JSON.stringify(pickUiText(language, "Next owner", "下一个执行者"))};
  const textHandoffNextTask = ${JSON.stringify(pickUiText(language, "Their default next step", "对方默认接手的下一步"))};
  const textHandoffSubmit = ${JSON.stringify(pickUiText(language, "Send handoff", "发送交接"))};
  const textHandoffCancel = ${JSON.stringify(pickUiText(language, "Cancel handoff", "取消交接"))};
  const textShowDetails = ${JSON.stringify(pickUiText(language, "Show details", "展开详情"))};
  const textHideDetails = ${JSON.stringify(pickUiText(language, "Hide details", "收起详情"))};
  const textStopCurrent = ${JSON.stringify(pickUiText(language, "Stop current", "停止当前"))};
  const textArchiveThread = ${JSON.stringify(pickUiText(language, "Archive thread", "归档线程"))};
  const textDeleteThread = ${JSON.stringify(pickUiText(language, "Delete thread", "删除线程"))};
  const textArchiveConfirm = ${JSON.stringify(pickUiText(language, "Archive this thread and hide it from the left list?", "归档这个线程，并把它从左侧列表隐藏？"))};
  const textDeleteConfirm = ${JSON.stringify(pickUiText(language, "Delete this thread permanently? This will remove its hall history and linked room evidence.", "永久删除这个线程？这会移除它的大厅历史和关联房间证据。"))};
  const textArchived = ${JSON.stringify(pickUiText(language, "Thread archived.", "线程已归档。"))};
  const textDeleted = ${JSON.stringify(pickUiText(language, "Thread deleted.", "线程已删除。"))};
  const textContinueDiscussionHint = ${JSON.stringify(pickUiText(language, "Continue the discussion in the composer below.", "继续在下方输入框里补充讨论。"))};
  const textStopped = ${JSON.stringify(pickUiText(language, "Stopped the current chain and returned the thread to discussion.", "已停止当前链路，并把线程拉回讨论。"))};
  const textNewTaskDraft = ${JSON.stringify(pickUiText(language, "New task draft", "新任务草稿"))};
  const textNewTaskDraftHint = ${JSON.stringify(pickUiText(language, "Describe the request once here. When you press Enter, the hall will create a new thread and immediately start the discussion.", "把需求一次写在这里。你按 Enter 后，大厅会新建线程，并立即开始讨论。"))};
  const textThreadSwitched = ${JSON.stringify(pickUiText(language, "Switched to thread:", "已切换到线程："))};
  const textThread = ${JSON.stringify(pickUiText(language, "Thread", "线程"))};
  const textExecutionPlan = ${JSON.stringify(pickUiText(language, "Execution plan", "执行计划"))};
  const textNextAction = ${JSON.stringify(pickUiText(language, "Next action", "下一步"))};
  const textExecutionFeed = ${JSON.stringify(pickUiText(language, "Execution feed", "执行日志"))};
  const textSelectTaskToInspect = ${JSON.stringify(pickUiText(language, "Select a task card to inspect ownership, decision, and evidence.", "选中一张任务卡后，这里会显示 owner、决策和证据信息。"))};
  const textOpenDetailThread = ${JSON.stringify(pickUiText(language, "Open detail thread", "打开详情线程"))};
  const textOwnerLabel = ${JSON.stringify(pickUiText(language, "Owner", "当前 owner"))};
  const textCurrentTaskLabel = ${JSON.stringify(pickUiText(language, "Current step", "当前步骤"))};
  const textSuggestedFirstTask = ${JSON.stringify(pickUiText(language, "Suggested first step", "建议第一步"))};
  const textExecutionStartHint = ${JSON.stringify(pickUiText(language, "After the order is ready, click start execution. Progress, results, and handoffs will continue in this thread.", "\u987a\u5e8f\u6392\u597d\u540e\uff0c\u70b9\u51fb\u300c\u5f00\u59cb\u6267\u884c\u300d\u5c31\u4f1a\u6b63\u5f0f\u8fdb\u5165\u6267\u884c\uff1b\u8fc7\u7a0b\u3001\u7ed3\u679c\u548c\u4ea4\u63a5\u4f1a\u6301\u7eed\u5199\u56de\u8fd9\u6761\u7ebf\u7a0b\u3002"))};
  const textExecutionThreadHint = ${JSON.stringify(pickUiText(language, "Execution updates, results, and handoffs will keep appending to this same thread.", "执行中的过程、结果和交接都会继续写回这条线程。"))};
  const textEvidence = ${JSON.stringify(pickUiText(language, "Evidence", "证据"))};
  const textLinkedTask = ${JSON.stringify(pickUiText(language, "Linked task", "关联任务"))};
  const textLinkedRoom = ${JSON.stringify(pickUiText(language, "Linked room", "关联线程"))};
  const textSummary = ${JSON.stringify(pickUiText(language, "Summary", "摘要"))};
  const textTypingMore = (count) => ${language === "zh"
    ? JSON.stringify("等 ") + " + count + " + JSON.stringify(" 位 agent 正在输入…")
    : JSON.stringify("and ") + " + count + " + JSON.stringify(" more are typing…")};
  const draftTaskPrompt = ${JSON.stringify("请帮我拆一下这个任务，先讨论方案，再指定执行者。")};
  const askImplementationPrompt = ${JSON.stringify("请先评估实现路径。")};
  const askDecisionPrompt = ${JSON.stringify("请先收口并指定执行者。")};
  const taskList = root.querySelector('[data-hall-task-list]');
  const thread = root.querySelector('[data-hall-thread]');
  const decisionPanel = root.querySelector('[data-hall-decision-panel]');
  const typingStrip = root.querySelector('[data-hall-typing-strip]');
  const detail = root.querySelector('[data-hall-detail]');
  const contextPane = root.querySelector('[data-hall-context-pane]');
  const memberStrip = root.querySelector('[data-hall-member-strip]');
  const toolbarMetaNote = root.querySelector('[data-hall-toolbar-note]');
  const composer = root.querySelector('[data-hall-compose]');
  const textarea = composer?.querySelector('textarea');
  const sendButton = root.querySelector('[data-hall-send-reply]');
  const stopButton = root.querySelector('[data-hall-stop-task]');
  const composeTaskButton = root.querySelector('[data-hall-compose-task]');
  const threadActionsMenu = root.querySelector('[data-hall-thread-menu]');
  const archiveThreadButton = root.querySelector('[data-hall-archive-thread]');
  const deleteThreadButton = root.querySelector('[data-hall-delete-thread]');
  const flash = root.querySelector('[data-hall-flash]');
  const handoffPanel = root.querySelector('[data-hall-handoff-panel]');
  const headlineNode = root.querySelector('[data-hall-headline]');
  const threadLabelNode = root.querySelector('[data-hall-thread-label]');
  const threadTitleNode = root.querySelector('[data-hall-thread-title]');
  const threadSubtitleNode = root.querySelector('[data-hall-thread-subtitle]');
  const mentionList = root.querySelector('[data-hall-mention-list]');
  const contextToggles = [...root.querySelectorAll('[data-hall-toggle-context]')];
  const tokenKey = 'openclaw:local-api-token';
  const tokenHeader = ((document.body?.dataset?.localTokenHeader || 'x-local-token').trim() || 'x-local-token');
  const tokenGateRequired = (document.body?.dataset?.tokenRequired || '') === '1';
  let isComposing = false;
  let selectedTaskCardId = String(bootstrap.selectedTaskCardId || '');
  let selectedTaskProjectId = '';
  let selectedTaskId = '';
  let hallTaskCards = Array.isArray(bootstrap.taskCards) ? bootstrap.taskCards.slice() : [];
  let hallMessages = [];
  let selectedTaskDetailPayload = bootstrap.selectedTaskDetail || null;
  let hallDrafts = new Map();
  let reloadTimer = 0;
  let eventSource = null;
  let typingSweepTimer = 0;
  let activeThreadPollTimer = 0;
  let hallReloadInFlight = false;
  let executionPlannerOpen = false;
  let executionOrderDraft = [];
  let executionItemsDraft = [];
  let executionOrderDraftDirty = false;
  let executionOrderSavedAt = 0;
  let executionPlannerEditingAt = 0;
  let executionPlannerFocusParticipantId = '';
  let handoffPanelOpen = false;
  let handoffDraft = {
    toParticipantId: '',
    goal: '',
    currentResult: '',
    doneWhen: '',
    blockers: '',
    requiresInputFrom: '',
  };
  let decisionExpanded = false;
  let composerMode = selectedTaskCardId ? 'reply' : 'task';
  let threadAutoFollow = true;
  let pendingComposerSubmitAfterComposition = false;
  const draftTtlMs = 180_000;
  const threadFollowThresholdPx = 40;

  /* ── Demo playback state ── */
  const DEMO_CARD_PREFIX = 'demo:';
  let isDemoMode = false;
  let demoMessages = null;
  let demoPlaybackRunning = false;
  let demoPlaybackAbort = null;
  const isDemoCard = (id) => typeof id === 'string' && id.startsWith(DEMO_CARD_PREFIX);
  const hallFileInput = root.querySelector('[data-hall-file-input]');
  const hallAttachButton = root.querySelector('[data-hall-attach-file]');
  const hallFilePreview = root.querySelector('[data-hall-file-preview]');
  const composerShell = root.querySelector('.hall-composer-shell');
  let pendingFiles = [];
  const HALL_FILE_MAX_BYTES = 20 * 1024 * 1024;

  const readFileAsDataUrl = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

  const addPendingFile = async (file) => {
    if (file.size > HALL_FILE_MAX_BYTES) { setFlash(${JSON.stringify(pickUiText(language, "File too large (max 20 MB): ", "文件过大（最大 20 MB）："))} + file.name); return; }
    if (pendingFiles.length >= 10) { setFlash(${JSON.stringify(pickUiText(language, "Max 10 files at a time.", "最多同时附加 10 个文件。"))}); return; }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      pendingFiles.push({ file, dataUrl });
      renderPendingFiles();
    } catch { setFlash(${JSON.stringify(pickUiText(language, "Failed to read file: ", "读取文件失败："))} + file.name); }
  };

  const renderPendingFiles = () => {
    if (!hallFilePreview) return;
    if (pendingFiles.length === 0) { hallFilePreview.hidden = true; return; }
    hallFilePreview.hidden = false;
    hallFilePreview.innerHTML = pendingFiles.map((item, index) => {
      const isImage = item.file.type.startsWith('image/');
      const thumbnail = isImage
        ? '<img class="hall-file-thumb" src="' + esc(item.dataUrl.slice(0, 200000)) + '" />'
        : '<span class="hall-file-icon">&#x1F4C4;</span>';
      const sizeKB = Math.round(item.file.size / 1024);
      return '<div class="hall-file-chip">' +
        thumbnail +
        '<span class="hall-file-chip-name">' + esc(item.file.name) + '</span>' +
        '<span class="hall-file-chip-size">' + sizeKB + ' KB</span>' +
        '<button type="button" class="hall-file-chip-remove" data-remove-index="' + index + '">&times;</button>' +
      '</div>';
    }).join('');
  };

  hallAttachButton?.addEventListener('click', () => hallFileInput?.click());
  hallFileInput?.addEventListener('change', async () => {
    for (const file of Array.from(hallFileInput.files || [])) { await addPendingFile(file); }
    hallFileInput.value = '';
  });
  hallFilePreview?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-index]');
    if (!btn) return;
    const index = Number(btn.dataset.removeIndex);
    if (Number.isFinite(index) && index >= 0 && index < pendingFiles.length) {
      pendingFiles.splice(index, 1);
      renderPendingFiles();
    }
  });

  composerShell?.addEventListener('dragover', (e) => { e.preventDefault(); composerShell.classList.add('hall-dragover'); });
  composerShell?.addEventListener('dragleave', () => composerShell.classList.remove('hall-dragover'));
  composerShell?.addEventListener('drop', async (e) => {
    e.preventDefault();
    composerShell.classList.remove('hall-dragover');
    for (const file of Array.from(e.dataTransfer?.files || [])) { await addPendingFile(file); }
  });

  const esc = (value) => String(value || '').replace(/[&<>"']/g, (ch) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'": '&#39;' }[ch]));
  const decodeLegacyHtmlEntities = (value) => {
    let normalized = String(value || '');
    for (let pass = 0; pass < 2; pass += 1) {
      const decoded = normalized
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
      if (decoded === normalized) break;
      normalized = decoded;
    }
    return normalized;
  };
  const markdownLinkPattern = new RegExp('\\\\[([^\\\\]]+)\\\\]\\\\((https?:\\\\/\\\\/[^\\\\s)]+)\\\\)', 'g');
  const markdownImagePattern = new RegExp('!\\\\[([^\\\\]]*)\\\\]\\\\((https?:\\\\/\\\\/[^\\\\s)]+)\\\\)', 'g');
  const markdownStrongPattern = new RegExp('\\\\*\\\\*([^*]+)\\\\*\\\\*', 'g');
  const markdownEmphasisPattern = new RegExp('(^|\\\\s)\\\\*([^*]+)\\\\*(?=\\\\s|$)', 'g');
  const inlineCodePattern = new RegExp('\\x60([^\\x60]+)\\x60', 'g');
  const fencedCodePattern = new RegExp('\\x60\\x60\\x60([\\w-]*)\\n([\\s\\S]*?)\\x60\\x60\\x60', 'g');
  const carriageReturnPattern = new RegExp('\\\\r\\\\n?', 'g');
  const trailingNewlinePattern = new RegExp('\\\\n+$');
  const unorderedListPattern = new RegExp('^[-*]\\\\s+(.+)$');
  const orderedListPattern = new RegExp('^\\\\d+\\\\.\\\\s+(.+)$');
  const quotePattern = new RegExp('^>\\\\s?(.+)$');
  const headingPattern = new RegExp('^(#{1,6})\\\\s+(.+)$');
  const codePlaceholderPattern = new RegExp('@@CODEBLOCK(\\\\d+)@@', 'g');
  const inlinePlaceholderPattern = new RegExp('@@INLINEBLOCK(\\\\d+)@@', 'g');
  const bareImageUrlPattern = new RegExp('(^|[\\\\s(>])((https?:\\\\/\\\\/[^\\\\s<)]+))', 'g');
  const lineBreakTagPattern = new RegExp('<br\\\\s*\\\\/?>', 'gi');
  const hallStructuredPattern = new RegExp('<hall-structured>[\\\\s\\\\S]*?<\\\\/hall-structured>', 'gi');
  const mentionPattern = new RegExp('(^|[\\\\s(>\\\\[\\\\{<,.;:!?\"\\\'\u201c\u201d\u2018\u2019，。！？；：、）】」』》])@([A-Za-z0-9_\\\\-\\\\u4e00-\\\\u9fff]+)', 'g');
  const mentionAfterBreakPattern = new RegExp('(<br>)@([A-Za-z0-9_\\\\-\\\\u4e00-\\\\u9fff]+)', 'g');
  const normalizedTokenPattern = new RegExp('[^a-z0-9\\\\u4e00-\\\\u9fff]', 'g');
  const isRenderableImageUrl = (url) => /^https?:\\/\\/[^\\s<)]+?\\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#][^\\s<)]*)?$/i.test(url || '');
  const renderInlineImage = (url, alt) => {
    const safeUrl = esc(url || '');
    const safeAlt = esc(alt || '');
    return '<a class="hall-md-image" href="' + safeUrl + '" target="_blank" rel="noreferrer"><img class="hall-md-img" src="' + safeUrl + '" alt="' + safeAlt + '" loading="lazy" /></a>';
  };
  const renderInlineMarkdown = (value) => {
    const lineBreakPlaceholder = '@@HALL_LINEBREAK@@';
    let html = esc(
      decodeLegacyHtmlEntities(value).replace(lineBreakTagPattern, lineBreakPlaceholder)
    );
    const inlineBlocks = [];
    const storeInlineBlock = (block) => {
      const index = inlineBlocks.length;
      inlineBlocks.push(block);
      return '@@INLINEBLOCK' + index + '@@';
    };
    html = html.replace(markdownImagePattern, (match, alt, url) => (
      isRenderableImageUrl(url) ? storeInlineBlock(renderInlineImage(url, alt)) : match
    ));
    html = html.replace(markdownLinkPattern, (_match, label, url) => (
      storeInlineBlock('<a href="' + url + '" target="_blank" rel="noreferrer">' + label + '</a>')
    ));
    html = html.replace(bareImageUrlPattern, (match, prefix, url) => (
      isRenderableImageUrl(url) ? prefix + storeInlineBlock(renderInlineImage(url, '')) : match
    ));
    html = html.replace(inlineCodePattern, '<code>$1</code>');
    html = html.replace(markdownStrongPattern, '<strong>$1</strong>');
    html = html.replace(markdownEmphasisPattern, '$1<em>$2</em>');
    html = html.replace(new RegExp(lineBreakPlaceholder, 'g'), '<br>');
    html = html.replace(mentionPattern, '$1<span class="hall-md-mention">@$2</span>');
    html = html.replace(mentionAfterBreakPattern, '$1<span class="hall-md-mention">@$2</span>');
    html = html.replace(inlinePlaceholderPattern, (_match, index) => inlineBlocks[Number(index)] || '');
    return html;
  };
  const renderMarkdownHtml = (value) => {
    const source = decodeLegacyHtmlEntities(value)
      .replace(hallStructuredPattern, '')
      .replace(lineBreakTagPattern, '\\n')
      .replace(carriageReturnPattern, '\\n')
      .trim();
    if (!source) return '';
    const codeBlocks = [];
    let text = esc(source).replace(fencedCodePattern, (_match, lang, code) => {
      const index = codeBlocks.length;
      const safeLang = esc(lang || '');
      codeBlocks.push('<pre class="hall-md-pre"><code' + (safeLang ? ' data-lang="' + safeLang + '"' : '') + '>' + String(code || '').replace(trailingNewlinePattern, '') + '</code></pre>');
      return '@@CODEBLOCK' + index + '@@';
    });
    const lines = text.split('\\n');
    const parts = [];
    let paragraph = [];
    let listType = '';
    let listItems = [];
    let quoteLines = [];
    const flushHeading = (level, content) => {
      parts.push('<h' + level + '>' + renderInlineMarkdown(content) + '</h' + level + '>');
    };
    const flushParagraph = () => {
      if (!paragraph.length) return;
      parts.push('<p>' + renderInlineMarkdown(paragraph.join('<br>')) + '</p>');
      paragraph = [];
    };
    const flushList = () => {
      if (!listItems.length || !listType) return;
      parts.push('<' + listType + '>' + listItems.map((item) => '<li>' + renderInlineMarkdown(item) + '</li>').join('') + '</' + listType + '>');
      listItems = [];
      listType = '';
    };
    const flushQuote = () => {
      if (!quoteLines.length) return;
      parts.push('<blockquote>' + renderInlineMarkdown(quoteLines.join('<br>')) + '</blockquote>');
      quoteLines = [];
    };
    const tableSeparatorCellPattern = new RegExp('^:?-+:?$');
    const tablePipeLine = (value) => {
      if (value === undefined) return null;
      const t = value.trim();
      if (t.length < 2 || t.charAt(0) !== '|' || t.charAt(t.length - 1) !== '|') return null;
      return t;
    };
    const splitTableRow = (row) =>
      row.replace(/^\\|/, '').replace(/\\|$/, '').split('|').map((c) => c.trim());
    const tryParseTable = (sourceLines, startIndex) => {
      const headerTrim = tablePipeLine(sourceLines[startIndex]);
      if (!headerTrim) return null;
      const sepTrim = tablePipeLine(sourceLines[startIndex + 1]);
      if (!sepTrim) return null;
      const sepCells = splitTableRow(sepTrim);
      if (sepCells.length === 0 || !sepCells.every((c) => tableSeparatorCellPattern.test(c))) return null;
      const headerCells = splitTableRow(headerTrim);
      if (headerCells.length !== sepCells.length) return null;
      const aligns = sepCells.map((c) => {
        const left = c.charAt(0) === ':';
        const right = c.charAt(c.length - 1) === ':';
        if (left && right) return 'center';
        if (right) return 'right';
        if (left) return 'left';
        return '';
      });
      const bodyRows = [];
      let cursor = startIndex + 2;
      while (cursor < sourceLines.length) {
        const rowTrim = tablePipeLine(sourceLines[cursor]);
        if (!rowTrim) break;
        bodyRows.push(splitTableRow(rowTrim));
        cursor++;
      }
      const colCount = headerCells.length;
      const cellHtml = (text, align, isHeader) => {
        const tag = isHeader ? 'th' : 'td';
        const styleAttr = align ? ' style="text-align:' + align + '"' : '';
        return '<' + tag + styleAttr + '>' + renderInlineMarkdown(text) + '</' + tag + '>';
      };
      const headHtml = '<thead><tr>' + headerCells
        .map((c, idx) => cellHtml(c, aligns[idx] || '', true))
        .join('') + '</tr></thead>';
      let bodyHtml = '';
      if (bodyRows.length > 0) {
        bodyHtml = '<tbody>' + bodyRows.map((row) => {
          const padded = [];
          for (let k = 0; k < colCount; k++) padded.push(row[k] != null ? row[k] : '');
          return '<tr>' + padded.map((c, idx) => cellHtml(c, aligns[idx] || '', false)).join('') + '</tr>';
        }).join('') + '</tbody>';
      }
      return {
        html: '<table class="hall-md-table">' + headHtml + bodyHtml + '</table>',
        consumed: cursor - startIndex,
      };
    };
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      const trimmed = line.trim();
      const ul = trimmed.match(unorderedListPattern);
      const ol = trimmed.match(orderedListPattern);
      const quote = trimmed.match(quotePattern);
      const heading = trimmed.match(headingPattern);
      if (!trimmed) {
        flushParagraph();
        flushList();
        flushQuote();
        continue;
      }
      if (quote) {
        flushParagraph();
        flushList();
        quoteLines.push(quote[1]);
        continue;
      }
      if (heading) {
        flushParagraph();
        flushList();
        flushQuote();
        flushHeading(Math.min(heading[1].length, 6), heading[2]);
        continue;
      }
      const table = tryParseTable(lines, lineIdx);
      if (table) {
        flushParagraph();
        flushList();
        flushQuote();
        parts.push(table.html);
        lineIdx += table.consumed - 1;
        continue;
      }
      flushQuote();
      if (ul) {
        flushParagraph();
        if (listType && listType !== 'ul') flushList();
        listType = 'ul';
        listItems.push(ul[1]);
        continue;
      }
      if (ol) {
        flushParagraph();
        if (listType && listType !== 'ol') flushList();
        listType = 'ol';
        listItems.push(ol[1]);
        continue;
      }
      flushList();
      paragraph.push(trimmed);
    }
    flushParagraph();
    flushList();
    flushQuote();
    let html = parts.join('');
    html = html.replace(codePlaceholderPattern, (_match, index) => codeBlocks[Number(index)] || '');
    html = html.replace(/\\[\\[tool:([^\\]|]+)(?:\\|([^\\]]*))?\\.?\\]\\]/g, (_match, name, detail) => {
      const tooltip = detail ? ' title="' + esc(detail) + '"' : '';
      return '<span class="hall-tool-pill is-completed"' + tooltip + '>\\u2713 ' + esc(name) + '</span>';
    });
    return html;
  };
  const renderArtifactFooterHtml = (artifactRefs, fileAttachments) => {
    if (!Array.isArray(artifactRefs) || artifactRefs.length === 0) return '';
    const fileMap = new Map();
    if (Array.isArray(fileAttachments)) {
      fileAttachments.forEach((f) => { if (f && f.fileId) fileMap.set(f.fileId, f); });
    }
    return artifactRefs
      .filter((artifact) => artifact && artifact.location)
      .map((artifact) => {
        const label = String(artifact.label || artifact.location || '').trim();
        const type = String(artifact.type || 'other').trim();
        const href = esc(String(artifact.location || '').trim());
        const fileMeta = artifact.artifactId ? fileMap.get(artifact.artifactId) : null;
        if (fileMeta && typeof fileMeta.mimeType === 'string' && fileMeta.mimeType.startsWith('image/')) {
          return '<a class="hall-file-preview" href="' + href + '" target="_blank" rel="noreferrer">' +
            '<img class="hall-file-img" src="' + href + '" alt="' + esc(label) + '" loading="lazy" />' +
          '</a>';
        }
        return '<a class="hall-artifact-chip" href="' + href + '" target="_blank" rel="noreferrer">' +
          '<span class="hall-artifact-chip-kind">' + esc(type) + '</span>' +
          '<span class="hall-artifact-chip-label">' + esc(label) + '</span>' +
        '</a>';
      })
      .join('');
  };
  const renderArtifactChips = (artifactRefs, fileAttachments) => renderArtifactFooterHtml(artifactRefs, fileAttachments);
  const stageLabel = (stage) => ({
    discussion: ${JSON.stringify(pickUiText(language, "Discussion", "讨论中"))},
    execution: ${JSON.stringify(pickUiText(language, "Execution", "执行中"))},
    review: ${JSON.stringify(pickUiText(language, "Review", "审核中"))},
    blocked: ${JSON.stringify(pickUiText(language, "Blocked", "卡住"))},
    completed: ${JSON.stringify(pickUiText(language, "Completed", "已完成"))},
  }[stage] || stage || '');
  const kindLabel = (kind) => ({
    task: ${JSON.stringify(pickUiText(language, "Task", "任务"))},
    proposal: ${JSON.stringify(pickUiText(language, "Proposal", "方案"))},
    decision: ${JSON.stringify(pickUiText(language, "Decision", "决策"))},
    handoff: ${JSON.stringify(pickUiText(language, "Handoff", "交接"))},
    status: ${JSON.stringify(pickUiText(language, "Status", "状态"))},
    review: ${JSON.stringify(pickUiText(language, "Review", "审核"))},
    result: ${JSON.stringify(pickUiText(language, "Result", "结果"))},
    system: ${JSON.stringify(pickUiText(language, "System", "系统"))},
    chat: ${JSON.stringify(pickUiText(language, "Chat", "对话"))},
  }[kind] || kind || '');
  const roleLabel = (role) => ({
    planner: ${JSON.stringify(pickUiText(language, "Executor", "执行者"))},
    coder: ${JSON.stringify(pickUiText(language, "Executor", "执行者"))},
    reviewer: ${JSON.stringify(pickUiText(language, "Executor", "执行者"))},
    manager: ${JSON.stringify(pickUiText(language, "Agent Manager", "智能体管理者"))},
    observer: ${JSON.stringify(pickUiText(language, "Observer & Manager", "观察者与管理者"))},
    generalist: ${JSON.stringify(pickUiText(language, "Executor", "执行者"))},
  }[role] || role || '');
  const avatarCatalog = ${JSON.stringify(HALL_AVATAR_CATALOG)};
  const compactTimestamp = (value) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const now = new Date();
    const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
    return sameDay
      ? date.toLocaleTimeString(${JSON.stringify(language === "zh" ? "zh-CN" : "en-US")}, { hour: '2-digit', minute: '2-digit' })
      : date.toLocaleDateString(${JSON.stringify(language === "zh" ? "zh-CN" : "en-US")}, { month: 'short', day: 'numeric' });
  };
  const stableHallHash = (input) => {
    let hash = 0;
    for (let index = 0; index < String(input || '').length; index += 1) {
      hash = (hash * 33 + String(input).charCodeAt(index)) >>> 0;
    }
    return hash >>> 0;
  };
  const deriveHallAvatar = (value) => {
    const normalized = String(value || '').trim().toLowerCase().replace(normalizedTokenPattern, '');
    const matched = avatarCatalog.find((entry) => entry.keywords.some((keyword) => normalized.includes(keyword)));
    if (matched) return matched;
    return avatarCatalog[stableHallHash(normalized || 'default') % avatarCatalog.length];
  };
  const hallAvatarMarkup = (label, className) => {
    const avatar = deriveHallAvatar(label);
    const stageInner = avatar.customImage
      ? '<img class="agent-avatar-img" src="/avatars/' + esc(avatar.customImage) + '" alt="" loading="lazy" />'
      : '<canvas class="agent-pixel-canvas" width="128" height="128"></canvas>';
    return '<div class="' + esc(className) + ' hall-agent-avatar" style="--agent-accent:' + esc(avatar.accent) + ';" data-animal="' + esc(avatar.animal) + '" aria-hidden="true"><div class="agent-stage">' + stageInner + '</div></div>';
  };
  const paintHallPixelAvatars = (container) => {
    if (!container || !window.__openclawPixelAvatar) return;
    const els = Array.from(container.querySelectorAll('.hall-agent-avatar'));
    els.forEach((el) => {
      if (el.querySelector('.agent-avatar-img')) return;
      window.__openclawPixelAvatar.renderElement(el);
    });
  };

  const setFlash = (message) => {
    if (!flash) return;
    flash.textContent = message || '';
  };
  const setContextOpen = (open) => {
    root.classList.toggle('is-context-open', open);
    root.classList.toggle('is-context-collapsed', !open);
    contextToggles.forEach((toggle) => {
      if (!(toggle instanceof HTMLButtonElement)) return;
      toggle.setAttribute('aria-pressed', open ? 'true' : 'false');
      toggle.textContent = open ? (labels.hideContext || 'Hide context') : (labels.showContext || 'Show context');
    });
    if (contextPane instanceof HTMLElement) {
      contextPane.setAttribute('aria-hidden', open ? 'false' : 'true');
    }
  };
  const readToken = () => {
    try {
      return (window.localStorage.getItem(tokenKey) || '').trim();
    } catch {}
    return '';
  };
  const writeToken = (token) => {
    try { window.localStorage.setItem(tokenKey, token || ''); } catch {}
  };
  const clearToken = () => {
    try { window.localStorage.removeItem(tokenKey); } catch {}
  };
  const requestToken = (message) => {
    const next = typeof window.prompt === 'function'
      ? String(window.prompt(message || textNeedToken, '') || '').trim()
      : '';
    if (next) writeToken(next);
    return next;
  };
  const syncSelectedTaskRefs = () => {
    if (!selectedTaskCardId || !Array.isArray(hallTaskCards)) return;
    const selected = hallTaskCards.find((item) => item.taskCardId === selectedTaskCardId);
    if (!selected) return;
    selectedTaskProjectId = selected.projectId || selectedTaskProjectId;
    selectedTaskId = selected.taskId || selectedTaskId;
  };
  const ensureToken = (message) => {
    const stored = readToken();
    if (stored) return stored;
    return requestToken(message || textTokenPrompt);
  };
  const syncTaskUrl = (taskCardId) => {
    try {
      const url = new URL(window.location.href);
      if (taskCardId) url.searchParams.set('taskCardId', taskCardId);
      else url.searchParams.delete('taskCardId');
      window.history.replaceState({}, '', url.toString());
    } catch {}
  };
  const insertMention = (mention) => {
    if (!(textarea instanceof HTMLTextAreaElement)) return false;
    const insertion = '@' + mention + ' ';
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const prefix = textarea.value.slice(0, start);
    const suffix = textarea.value.slice(end);
    const needsLeadingSpace = prefix.length > 0 && !/\\s$/.test(prefix);
    const nextValue = prefix + (needsLeadingSpace ? ' ' : '') + insertion + suffix;
    textarea.value = nextValue;
    const caret = (prefix + (needsLeadingSpace ? ' ' : '') + insertion).length;
    textarea.setSelectionRange(caret, caret);
    autoResizeComposer();
    textarea.focus();
    return false;
  };
  const setComposerValue = (value) => {
    if (!(textarea instanceof HTMLTextAreaElement)) return false;
    textarea.value = String(value || '');
    autoResizeComposer();
    textarea.focus();
    const caret = textarea.value.length;
    textarea.setSelectionRange(caret, caret);
    return false;
  };
  const focusComposer = () => {
    executionPlannerOpen = false;
    textarea?.focus?.();
    textarea?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    setFlash(textContinueDiscussionHint);
    renderVisibleThread();
    return false;
  };
  const syncComposerMode = () => {
    if (!(textarea instanceof HTMLTextAreaElement)) return;
    if (sendButton instanceof HTMLElement) {
      sendButton.textContent = composerMode === 'task' ? (labels.sendTask || 'Create task') : (labels.reply || 'Send reply');
    }
    if (composeTaskButton instanceof HTMLButtonElement) {
      const active = composerMode === 'task';
      composeTaskButton.classList.toggle('is-active', active);
      composeTaskButton.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    root.classList.toggle('is-composing-task', composerMode === 'task');
    textarea.placeholder = composerMode === 'task'
      ? ${JSON.stringify(pickUiText(language, "Describe the new task you want the hall to discuss…", "描述你想让大厅先讨论的新任务…"))}
      : String(labels.composerPlaceholder || '');
    syncStopButton();
  };
  const syncPlannerMode = () => {
    root.classList.toggle('is-planning-order', executionPlannerOpen);
  };
  const syncStopButton = () => {
    if (!(stopButton instanceof HTMLButtonElement)) return;
    const taskCard = currentTaskCard();
    stopButton.hidden = !taskCard || taskCard.stage === 'completed';
    stopButton.title = textStopCurrent;
    stopButton.setAttribute('aria-label', textStopCurrent);
  };
  const openNewTaskComposer = () => {
    composerMode = 'task';
    selectedTaskCardId = '';
    selectedTaskProjectId = '';
    selectedTaskId = '';
    selectedTaskDetailPayload = null;
    executionPlannerOpen = false;
    decisionExpanded = false;
    syncTaskUrl('');
    renderTaskList(hallTaskCards);
    renderDetail(null);
    renderDecisionPanel(null);
    renderVisibleThread();
    renderThreadHeader();
    renderMemberStrip();
    renderToolbarMetaNote();
    syncComposerMode();
    setComposerValue('');
    if (thread instanceof HTMLElement) thread.scrollTop = 0;
    setFlash(${JSON.stringify(pickUiText(language, "Write the new task and press Enter to create it.", "写下新任务后直接按 Enter 创建。"))});
    return false;
  };
  const autoResizeComposer = () => {
    if (!(textarea instanceof HTMLTextAreaElement)) return;
    textarea.style.height = '0px';
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, 40), 96);
    textarea.style.height = nextHeight + 'px';
    textarea.style.overflowY = textarea.scrollHeight > 96 ? 'auto' : 'hidden';
  };
  const hallHeadlineText = (headline) => {
    return selectedTaskCardId
      ? ${JSON.stringify(pickUiText(language, "Stay in one thread to discuss, assign, hand off, and review.", "围绕同一条线程讨论、分工、交接和评审。"))}
      : ${JSON.stringify(pickUiText(language, "Start a task or @ a real agent to begin.", "从一个任务开始，或者直接 @ 一个真实 agent。"))};
  };
  const participantIndex = new Map((Array.isArray(bootstrap.participants) ? bootstrap.participants : []).map((participant) => [participant.participantId, participant]));
  const participantLabel = (participantId) => participantIndex.get(participantId)?.displayName || participantId || 'Agent';
  const parseUpdatedAtMs = (taskCard) => {
    const value = Date.parse(String(taskCard?.updatedAt || ''));
    return Number.isFinite(value) ? value : 0;
  };
  const nextLocalTaskCardUpdatedAt = (taskCard) => {
    const baseMs = Math.max(parseUpdatedAtMs(taskCard), Date.now());
    return new Date(baseMs + 1).toISOString();
  };
  const syncLocalTaskCardIntoList = (taskCard) => {
    if (!taskCard?.taskCardId || !Array.isArray(hallTaskCards)) return;
    let matched = false;
    hallTaskCards = hallTaskCards.map((item) => {
      if (item?.taskCardId !== taskCard.taskCardId) return item;
      matched = true;
      return taskCard;
    });
    if (!matched) {
      hallTaskCards = [taskCard, ...hallTaskCards];
    }
  };
  const freshestSelectedTaskCard = () => {
    const detailTaskCard = selectedTaskDetailPayload?.taskCard || null;
    const listTaskCard = (!selectedTaskCardId || !Array.isArray(hallTaskCards))
      ? null
      : (hallTaskCards.find((item) => item.taskCardId === selectedTaskCardId) || null);
    if (detailTaskCard && listTaskCard) {
      return parseUpdatedAtMs(listTaskCard) >= parseUpdatedAtMs(detailTaskCard)
        ? listTaskCard
        : detailTaskCard;
    }
    return detailTaskCard || listTaskCard || null;
  };
  const withFreshestTaskCard = (payload) => {
    if (!payload?.taskCard) return payload;
    const freshestTaskCard = freshestSelectedTaskCard();
    if (!freshestTaskCard || freshestTaskCard.taskCardId !== payload.taskCard.taskCardId) return payload;
    if (parseUpdatedAtMs(freshestTaskCard) <= parseUpdatedAtMs(payload.taskCard)) return payload;
    return {
      ...payload,
      taskCard: freshestTaskCard,
    };
  };
  const currentTaskCard = () => {
    return freshestSelectedTaskCard();
  };
  const currentThreadMessages = () => {
    if (selectedTaskCardId) {
      const detailTaskCardId = selectedTaskDetailPayload?.taskCard?.taskCardId;
      const detailMessages = Array.isArray(selectedTaskDetailPayload?.messages) ? selectedTaskDetailPayload.messages : null;
      if (detailMessages && detailTaskCardId === selectedTaskCardId) return detailMessages;
    }
    return Array.isArray(hallMessages) ? hallMessages : [];
  };
  const threadDistanceFromBottom = () => {
    if (!(thread instanceof HTMLElement)) return 0;
    return Math.max(0, thread.scrollHeight - thread.scrollTop - thread.clientHeight);
  };
  const markExecutionPlannerEditing = () => {
    executionPlannerEditingAt = Date.now();
  };
  const isExecutionPlannerField = (element) => {
    return element instanceof HTMLElement && (
      element.matches('[data-hall-item-task]')
      || element.matches('[data-hall-item-handoff]')
      || element.matches('[data-hall-item-handoff-to]')
    );
  };
  const isExecutionPlannerEditing = () => {
    if (!executionPlannerOpen) return false;
    const active = document.activeElement;
    if (isExecutionPlannerField(active)) return true;
    return (Date.now() - executionPlannerEditingAt) < 2000;
  };
  const syncThreadAutoFollow = () => {
    threadAutoFollow = threadDistanceFromBottom() <= threadFollowThresholdPx;
  };
  const renderThreadHeader = () => {
    const taskCard = currentTaskCard();
    const isNewTaskMode = composerMode === 'task' && !selectedTaskCardId;
    if (threadLabelNode instanceof HTMLElement) {
      threadLabelNode.textContent = isNewTaskMode
        ? ${JSON.stringify(pickUiText(language, "New task draft", "新任务草稿"))}
        : taskCard
          ? ${JSON.stringify(pickUiText(language, "Task thread", "任务线程"))}
          : ${JSON.stringify(pickUiText(language, "Shared group chat", "共享群聊"))};
    }
    if (threadTitleNode instanceof HTMLElement) {
      threadTitleNode.textContent = isNewTaskMode
        ? ${JSON.stringify(pickUiText(language, "Create a new hall task", "创建一个新任务"))}
        : (taskCard?.title || ${JSON.stringify(pickUiText(language, "Collaboration Hall", "协作大厅"))});
    }
    if (threadSubtitleNode instanceof HTMLElement) {
      threadSubtitleNode.textContent = isNewTaskMode
        ? ${JSON.stringify(pickUiText(language, "Write the request here and press Enter to create it.", "在这里写下需求，按 Enter 直接创建。"))}
        : (taskCard
            ? (taskCard.updatedAt ? compactTimestamp(taskCard.updatedAt) : '')
            : hallHeadlineText(bootstrap?.hallSummary?.headline || ''));
    }
    if (archiveThreadButton instanceof HTMLButtonElement) {
      archiveThreadButton.disabled = !taskCard;
      archiveThreadButton.textContent = labels.archiveThread || textArchiveThread;
    }
    if (deleteThreadButton instanceof HTMLButtonElement) {
      deleteThreadButton.disabled = !taskCard;
      deleteThreadButton.textContent = labels.deleteThread || textDeleteThread;
    }
    if (threadActionsMenu instanceof HTMLElement) {
      threadActionsMenu.hidden = !taskCard;
      if (!taskCard && threadActionsMenu instanceof HTMLDetailsElement) {
        threadActionsMenu.open = false;
      }
    }
  };
  const cleanupTypingDrafts = () => {
    const now = Date.now();
    let removed = false;
    Array.from(hallDrafts.entries()).forEach(([draftId, draft]) => {
      const lastActive = Date.parse(draft.lastDeltaAt || draft.createdAt || '') || now;
      if (now - lastActive > draftTtlMs) {
        hallDrafts.delete(draftId);
        removed = true;
      }
    });
    return removed;
  };
  const syntheticDiscussionDrafts = (taskCard) => {
    if (!taskCard || taskCard.stage !== 'discussion') return [];
    return [];
  };
  const syntheticExecutionHandoffDraft = (taskCard, persistedThreadMessages) => {
    if (!taskCard || taskCard.stage !== 'execution' || !taskCard.currentOwnerParticipantId) return [];
    const ownerParticipantId = String(taskCard.currentOwnerParticipantId || '').trim();
    if (!ownerParticipantId) return [];
    const updatedAt = Date.parse(taskCard.updatedAt || taskCard.createdAt || '') || 0;
    const now = Date.now();
    if (!updatedAt || now - updatedAt > 45_000) return [];
    const latestHandoff = [...persistedThreadMessages].reverse().find((message) => {
      if (!message || message.authorParticipantId === ownerParticipantId || message.authorParticipantId === 'operator') return false;
      if (String(message.taskCardId || '') !== String(taskCard.taskCardId || '')) return false;
      const targetIds = Array.isArray(message.targetParticipantIds) ? message.targetParticipantIds : [];
      if (!targetIds.includes(ownerParticipantId)) return false;
      const createdAt = Date.parse(message.createdAt || '') || 0;
      return createdAt >= updatedAt - 1_000;
    });
    if (!latestHandoff) return [];
    const handoffAt = Date.parse(latestHandoff.createdAt || '') || updatedAt;
    const ownerAlreadyReplied = persistedThreadMessages.some((message) => {
      if (!message || String(message.authorParticipantId || '') !== ownerParticipantId) return false;
      const createdAt = Date.parse(message.createdAt || '') || 0;
      return createdAt >= handoffAt;
    });
    if (ownerAlreadyReplied) return [];
    return [{
      draftId: 'synthetic-execution:' + taskCard.taskCardId + ':' + ownerParticipantId,
      createdAt: latestHandoff.createdAt || taskCard.updatedAt || new Date().toISOString(),
      lastDeltaAt: latestHandoff.createdAt || taskCard.updatedAt || new Date().toISOString(),
      authorLabel: participantLabel(ownerParticipantId),
      authorParticipantId: ownerParticipantId,
      authorSemanticRole: participantIndex.get(ownerParticipantId)?.semanticRole,
      messageKind: 'handoff',
      taskCardId: taskCard.taskCardId,
      projectId: taskCard.projectId,
      taskId: taskCard.taskId,
      roomId: taskCard.roomId,
      content: '',
    }];
  };
  const syntheticVisibleDrafts = (persistedThreadMessages) => {
    if (!selectedTaskCardId) return [];
    const taskCard = currentTaskCard();
    if (!taskCard) return [];
    if (taskCard.stage === 'discussion') return syntheticDiscussionDrafts(taskCard);
    return syntheticExecutionHandoffDraft(taskCard, persistedThreadMessages);
  };
  const visibleDrafts = () => {
    cleanupTypingDrafts();
    const persistedThreadMessages = currentThreadMessages().filter((message) => {
      if (selectedTaskCardId) return message.taskCardId === selectedTaskCardId;
      return !message.taskCardId;
    });
    const actualDrafts = Array.from(hallDrafts.values()).filter((draft) => {
      if (selectedTaskCardId) return draft.taskCardId === selectedTaskCardId;
      return !draft.taskCardId;
    });
    const sourceDrafts = actualDrafts.length > 0 ? actualDrafts : syntheticVisibleDrafts(persistedThreadMessages);
    const deduped = new Map();
    sourceDrafts.forEach((draft) => {
      const key = draft.authorParticipantId || draft.authorLabel || draft.draftId;
      const existing = deduped.get(key);
      if (!existing) {
        deduped.set(key, draft);
        return;
      }
      const existingHasContent = String(existing.content || '').trim().length > 0;
      const nextHasContent = String(draft.content || '').trim().length > 0;
      if (!existingHasContent && nextHasContent) {
        deduped.set(key, draft);
        return;
      }
      const existingAt = Date.parse(existing.lastDeltaAt || existing.createdAt || '') || 0;
      const nextAt = Date.parse(draft.lastDeltaAt || draft.createdAt || '') || 0;
      if (nextAt >= existingAt) {
        deduped.set(key, draft);
      }
    });
    return Array.from(deduped.values()).filter((draft) => {
      const persistedMessageId = String(draft.persistedMessageId || '').trim();
      if (persistedMessageId && persistedThreadMessages.some((message) => String(message.messageId || '').trim() === persistedMessageId)) {
        return false;
      }
      const authorId = String(draft.authorParticipantId || '').trim();
      const draftCreatedAt = Date.parse(draft.createdAt || '') || 0;
      if (!authorId || !draftCreatedAt) return true;
      return !persistedThreadMessages.some((message) => {
        const messageAuthorId = String(message.authorParticipantId || '').trim();
        if (!messageAuthorId || messageAuthorId !== authorId) return false;
        const messageCreatedAt = Date.parse(message.createdAt || '') || 0;
        return messageCreatedAt >= draftCreatedAt;
      });
    }).sort((a, b) => {
      const aAt = Date.parse(a.createdAt || '') || 0;
      const bAt = Date.parse(b.createdAt || '') || 0;
      return aAt - bAt;
    });
  };
  const visibleTypingDrafts = () => visibleDrafts().filter((draft) => !draft.settledAt);
  const participantPresence = (participantId) => {
    const drafts = visibleTypingDrafts();
    if (drafts.some((draft) => draft.authorParticipantId === participantId)) {
      return { state: 'typing', label: textTypingNow, rank: 0 };
    }
    const taskCard = currentTaskCard();
    if (taskCard?.currentOwnerParticipantId === participantId) {
      if (taskCard.stage === 'review') return { state: 'reviewing', label: textReviewingNow, rank: 1 };
      if (taskCard.stage === 'execution') return { state: 'executing', label: textExecutingNow, rank: 1 };
      return { state: 'active', label: stageLabel(taskCard.stage), rank: 2 };
    }
    if ((taskCard?.plannedExecutionOrder || []).includes(participantId)) {
      return { state: 'queued', label: textQueuedNow, rank: 3 };
    }
    return { state: 'idle', label: textIdleNow, rank: 4 };
  };
  const renderMemberStrip = () => {
    if (!memberStrip) return;
    const participants = Array.isArray(bootstrap.participants) ? bootstrap.participants : [];
    memberStrip.innerHTML = participants.map((participant) => {
      const presence = participantPresence(participant.participantId);
      const title = participant.displayName + ' · ' + presence.label + ' · ' + roleLabel(participant.semanticRole);
      return '<button type="button" class="hall-member-pill hall-member-pill--' + esc(presence.state) + '" data-status="' + esc(presence.state) + '" title="' + esc(title) + '" aria-label="' + esc(title) + '" data-hall-mention="' + esc(participant.displayName) + '" onclick="return window.__openclawHallInsertMention ? window.__openclawHallInsertMention(this.getAttribute(\\'data-hall-mention\\') || \\'\\') : true">' +
        hallAvatarMarkup(participant.displayName, 'hall-member-avatar') +
        '<span class="hall-member-status-dot" aria-hidden="true"></span>' +
      '</button>';
    }).join('');
    paintHallPixelAvatars(memberStrip);
  };
  const renderToolbarMetaNote = () => {
    if (!toolbarMetaNote) return;
    const drafts = visibleTypingDrafts();
    if (drafts.length > 0) {
      const labels = drafts.slice(0, 2).map((draft) => draft.authorLabel || participantLabel(draft.authorParticipantId));
      toolbarMetaNote.textContent = drafts.length === 1
        ? labels[0] + ' ' + textSingleTyping
        : drafts.length === 2
          ? labels[0] + ' · ' + labels[1] + ' ' + textMultiTyping
          : labels[0] + '、' + labels[1] + ' ' + textTypingMore(drafts.length - 2);
      return;
    }
    const taskCard = currentTaskCard();
    if (taskCard?.currentOwnerLabel && hasLockedActiveExecution(taskCard)) {
      const currentTask = decisionCardStepMeta(taskCard).task;
      toolbarMetaNote.textContent = currentTask
        ? (taskCard.currentOwnerLabel + ' ' + (taskCard.stage === 'review' ? textReviewingNow : textExecutingNow) + ' · ' + currentTask)
        : (taskCard.currentOwnerLabel + ' ' + (taskCard.stage === 'review' ? textReviewingNow : textExecutingNow));
      return;
    }
    toolbarMetaNote.textContent = (bootstrap.participants || []).length + ' ' + ${JSON.stringify(pickUiText(language, "agents live in this hall.", "个 agent 正在大厅里。"))};
  };
  const summarizeExecutionFocusDraft = (taskCard) => {
    const raw = [taskCard?.decision, taskCard?.proposal, taskCard?.latestSummary, taskCard?.description]
      .map((value) => String(value || '').trim())
      .find(Boolean);
    if (!raw) return '';
    const singleLine = raw.replace(/\\s+/g, ' ').trim();
    const sentence = (singleLine.split(/[。！？.!?]/)[0] || '').trim();
    if (!sentence) return '';
    const title = String(taskCard?.title || '').trim();
    const stripped = sentence
      .replace(new RegExp('^' + title.replace(/[.*+?^$()|[\]\\]/g, '\\$&') + '[:：,，\\s-]*', 'i'), '')
      .replace(/^(关于|针对|For|About)\\s*/i, '')
      .trim();
    if (!stripped) return '';
    return stripped.length > 34 ? stripped.slice(0, 34).trim() + '…' : stripped;
  };
  const defaultExecutionItemTask = (taskCard, participantId, index) => {
    const participant = (bootstrap.participants || []).find((item) => item.participantId === participantId);
    const title = String(taskCard?.title || '');
    const lower = (title + ' ' + String(taskCard?.description || '')).toLowerCase();
    const focus = summarizeExecutionFocusDraft(taskCard);
    if (!participant) return index === 0 ? ('Take the first concrete pass' + (focus ? ' around ' + focus + '.' : '.')) : ('Pick up the next step' + (focus ? ' around ' + focus + '.' : '.'));
    if (participant.semanticRole === 'planner') {
      return /video|story|narrative|motion|animation/.test(lower)
        ? ('先把 brief 钉住：目标受众、核心信息、故事线和第一版样片范围' + (focus ? '，重点围绕：' + focus + '。' : '。'))
        : ('先把需求收成一版明确 brief：范围、约束、成功标准' + (focus ? '，重点围绕：' + focus + '。' : '。'));
    }
    if (participant.semanticRole === 'coder') {
      return /video|story|narrative|motion|animation/.test(lower)
        ? ('做第一版可评审样片 / storyboard / motion sample，不直接做满' + (focus ? '，重点落实：' + focus + '。' : '。'))
        : ('完成第一版可运行/可评审结果，并把产物贴回群里' + (focus ? '，重点落实：' + focus + '。' : '。'));
    }
    if (participant.semanticRole === 'reviewer') return '检查上一位的结果，指出必须改的点；如果没有硬阻塞，就直接把可继续版本交给下一位。';
    if (participant.semanticRole === 'manager') return '收口这轮结果，锁定一句结论和下一步；如果后面还有 owner，就直接把明确动作交给下一位。';
    return index === 0 ? ('先做第一版可评审结果' + (focus ? '，重点是：' + focus + '。' : '。')) : ('承接上一步继续推进' + (focus ? '，重点延续：' + focus + '。' : '。'));
  };
  const defaultExecutionItemHandoff = (taskCard, participantId, index, order) => {
    const nextParticipantId = order[index + 1];
    const nextLabel = nextParticipantId ? participantLabel(nextParticipantId) : '';
    if (nextLabel) return '完成后在群里贴结果，并 @' + nextLabel + ' 接着做。';
    return String(taskCard?.doneWhen || '');
  };
  const buildExecutionItemsDraft = (taskCard, order, existingItems = []) => {
    const existing = new Map((existingItems || []).map((item) => [item.participantId, item]));
    return (order || []).map((participantId, index) => {
      const cached = existing.get(participantId);
      const cachedHandoffTo = cached?.handoffToParticipantId;
      const nextParticipantId = cachedHandoffTo && cachedHandoffTo !== participantId && order.includes(cachedHandoffTo)
        ? cachedHandoffTo
        : (order[index + 1] || '');
      return {
        itemId: cached?.itemId || ('draft-' + participantId),
        participantId,
        task: cached?.task || defaultExecutionItemTask(taskCard, participantId, index),
        handoffToParticipantId: nextParticipantId,
        handoffWhen: cached?.handoffWhen || defaultExecutionItemHandoff(taskCard, participantId, index, order),
      };
    });
  };
  const syncExecutionOrderDraft = (taskCard) => {
    const currentExecutionParticipantId = (taskCard?.stage === 'execution' || taskCard?.stage === 'blocked')
      ? String(taskCard.currentExecutionItem?.participantId || taskCard.currentOwnerParticipantId || '').trim()
      : '';
    const baseOrder = Array.isArray(taskCard?.plannedExecutionOrder) ? taskCard.plannedExecutionOrder.slice() : [];
    executionOrderDraft = currentExecutionParticipantId
      ? [currentExecutionParticipantId, ...baseOrder.filter((participantId) => participantId !== currentExecutionParticipantId)]
      : baseOrder;
    executionItemsDraft = buildExecutionItemsDraft(
      taskCard,
      executionOrderDraft,
      [
        ...(taskCard?.currentExecutionItem ? [taskCard.currentExecutionItem] : []),
        ...((taskCard?.plannedExecutionItems) || []),
      ],
    );
  };
  const replaceExecutionOrderDraft = (next) => {
    executionOrderDraft = Array.from(new Set((next || []).map((item) => String(item || '').trim()).filter(Boolean)));
    executionItemsDraft = buildExecutionItemsDraft(selectedTaskDetailPayload?.taskCard, executionOrderDraft, executionItemsDraft);
    executionOrderDraftDirty = true;
    renderDetail(selectedTaskDetailPayload);
    renderVisibleThread();
    if (executionPlannerFocusParticipantId && thread instanceof HTMLElement) {
      const item = thread.querySelector('[data-hall-order-item="' + executionPlannerFocusParticipantId + '"]');
      if (item instanceof HTMLElement) {
        item.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      executionPlannerFocusParticipantId = '';
    }
  };
  const patchExecutionItemDraft = (participantId, patch) => {
    executionItemsDraft = executionItemsDraft.map((item) => item.participantId === participantId ? { ...item, ...patch } : item);
    executionOrderDraftDirty = true;
  };
  const normalizeExecutionItems = (items) => (Array.isArray(items) ? items : []).map((item) => ({
    participantId: String(item?.participantId || '').trim(),
    task: String(item?.task || '').trim(),
    handoffToParticipantId: String(item?.handoffToParticipantId || '').trim(),
    handoffWhen: String(item?.handoffWhen || '').trim(),
  }));
  const sameExecutionPlan = (taskCard) => {
    const incomingOrder = Array.isArray(taskCard?.plannedExecutionOrder) ? taskCard.plannedExecutionOrder.map((item) => String(item || '').trim()).filter(Boolean) : [];
    const localOrder = executionOrderDraft.map((item) => String(item || '').trim()).filter(Boolean);
    if (incomingOrder.length !== localOrder.length) return false;
    for (let index = 0; index < localOrder.length; index += 1) {
      if (incomingOrder[index] !== localOrder[index]) return false;
    }
    const incomingItems = normalizeExecutionItems(taskCard?.plannedExecutionItems);
    const localItems = normalizeExecutionItems(executionItemsDraft);
    if (incomingItems.length !== localItems.length) return false;
    for (let index = 0; index < localItems.length; index += 1) {
      const incoming = incomingItems[index];
      const local = localItems[index];
      if (
        incoming.participantId !== local.participantId
        || incoming.task !== local.task
        || incoming.handoffToParticipantId !== local.handoffToParticipantId
        || incoming.handoffWhen !== local.handoffWhen
      ) return false;
    }
    return true;
  };
  const injectLocalExecutionPlan = (taskCard) => {
    if (!taskCard) return taskCard;
    return {
      ...taskCard,
      updatedAt: nextLocalTaskCardUpdatedAt(taskCard),
      plannedExecutionOrder: executionOrderDraft.slice(),
      plannedExecutionItems: executionItemsDraft.map((item) => ({
        ...item,
        participantId: String(item.participantId || '').trim(),
        task: String(item.task || '').trim(),
        handoffToParticipantId: String(item.handoffToParticipantId || '').trim(),
        handoffWhen: String(item.handoffWhen || '').trim(),
      })),
    };
  };
  const buildHandoffDraft = (taskCard) => {
    const currentExecutionItem = taskCard?.currentExecutionItem || null;
    const firstQueuedItem = (taskCard?.plannedExecutionItems || [])[0];
    const nextParticipantId = currentExecutionItem?.handoffToParticipantId || firstQueuedItem?.participantId || taskCard?.plannedExecutionOrder?.[0] || '';
    const nextExecutionItem = (taskCard?.plannedExecutionItems || []).find((item) => item.participantId === nextParticipantId);
    return {
      toParticipantId: nextParticipantId,
      goal: String(nextExecutionItem?.task || currentExecutionItem?.handoffWhen || taskCard?.doneWhen || '').trim(),
      currentResult: String(taskCard?.latestSummary || taskCard?.decision || taskCard?.proposal || '').trim(),
      doneWhen: String(nextExecutionItem?.handoffWhen || currentExecutionItem?.handoffWhen || taskCard?.doneWhen || '').trim(),
      blockers: Array.isArray(taskCard?.blockers) ? taskCard.blockers.join(', ') : '',
      requiresInputFrom: Array.isArray(taskCard?.requiresInputFrom) ? taskCard.requiresInputFrom.join(', ') : '',
    };
  };
  const handoffDraftActionPreview = (participantId) => {
    const taskCard = selectedTaskDetailPayload?.taskCard;
    if (!taskCard || !participantId) return '';
    const existing = (taskCard.plannedExecutionItems || []).find((item) => item.participantId === participantId);
    if (existing?.task) return existing.task;
    const order = taskCard.plannedExecutionOrder || [];
    const fallbackIndex = Math.max(0, order.indexOf(participantId));
    return defaultExecutionItemTask(taskCard, participantId, fallbackIndex);
  };
  const openHandoffPanel = () => {
    const taskCard = selectedTaskDetailPayload?.taskCard;
    if (!taskCard) return;
    handoffPanelOpen = true;
    handoffDraft = buildHandoffDraft(taskCard);
    renderHandoffPanel();
  };
  const closeHandoffPanel = () => {
    handoffPanelOpen = false;
    handoffDraft = {
      toParticipantId: '',
      goal: '',
      currentResult: '',
      doneWhen: '',
      blockers: '',
      requiresInputFrom: '',
    };
    renderHandoffPanel();
  };
  const hasLockedActiveExecution = (taskCard) => Boolean(taskCard) && (taskCard.stage === 'execution' || taskCard.stage === 'blocked');
  const firstPlannedOwnerId = (taskCard) => {
    if (!taskCard) return '';
    return String(taskCard.plannedExecutionOrder?.[0] || taskCard.plannedExecutionItems?.[0]?.participantId || '').trim();
  };
  const firstPlannedExecutionItem = (taskCard) => {
    const participantId = firstPlannedOwnerId(taskCard);
    if (!participantId || !taskCard) return null;
    return (taskCard.plannedExecutionItems || []).find((item) => item.participantId === participantId) || null;
  };
  const hasPendingStartablePlan = (taskCard) => Boolean(taskCard) && !hasLockedActiveExecution(taskCard) && Boolean(firstPlannedOwnerId(taskCard));
  const decisionCardStageText = (taskCard) => hasPendingStartablePlan(taskCard) ? textReadyToStart : stageLabel(taskCard.stage);
  const decisionCardOwnerMeta = (taskCard) => {
    if (!taskCard) return { heading: textCurrentOwner, label: '' };
    if (hasPendingStartablePlan(taskCard)) {
      const participantId = firstPlannedOwnerId(taskCard);
      return {
        heading: textSuggestedFirstOwner,
        label: participantId ? participantLabel(participantId) : '',
      };
    }
    const participantId = String(taskCard.currentOwnerParticipantId || '').trim();
    return {
      heading: textCurrentOwner,
      label: taskCard.currentOwnerLabel || (participantId ? participantLabel(participantId) : ''),
    };
  };
  const decisionCardStepMeta = (taskCard) => {
    if (!taskCard) return { heading: textCurrentTaskLabel, task: '' };
    if (hasPendingStartablePlan(taskCard)) {
      return {
        heading: textSuggestedFirstTask,
        task: String(firstPlannedExecutionItem(taskCard)?.task || '').trim(),
      };
    }
    return {
      heading: textCurrentTaskLabel,
      task: String(taskCard.currentExecutionItem?.task || '').trim(),
    };
  };
  const decisionPrimaryButtonLabel = (taskCard) => {
    if (!taskCard) return '';
    if (hasPendingStartablePlan(taskCard)) {
      const plannedOwnerId = firstPlannedOwnerId(taskCard);
      if (plannedOwnerId) {
        const plannedOwnerLabel = participantLabel(plannedOwnerId);
        return textStartExecutionPrefix + plannedOwnerLabel + textStartExecutionSuffix;
      }
      return '';
    }
    return '';
  };
  const shouldShowDecisionPrimaryAction = (taskCard) => hasPendingStartablePlan(taskCard);
  const decisionSecondaryOrderLabel = (taskCard) => {
    if (!taskCard) return textPlanExecutionOrder;
    return taskCard.stage === 'discussion' ? textPlanExecutionOrder : textAdjustExecutionOrder;
  };
  const moveExecutionOrderDraft = (participantId, direction) => {
    const index = executionOrderDraft.indexOf(participantId);
    if (index < 0) return;
    const nextIndex = direction === 'up' ? index - 1 : index + 1;
    if (nextIndex < 0 || nextIndex >= executionOrderDraft.length) return;
    const next = executionOrderDraft.slice();
    const [moved] = next.splice(index, 1);
    next.splice(nextIndex, 0, moved);
    replaceExecutionOrderDraft(next);
  };

  const renderTaskList = (taskCards) => {
    if (!taskList) return;
    if (!Array.isArray(taskCards) || taskCards.length === 0) {
      taskList.innerHTML = '<div class="hall-empty hall-empty--sidebar"><strong>' + esc(textNoThreads) + '</strong><span>' + esc(labels.emptyTasks || 'No task cards yet.') + '</span></div>';
      return;
    }
    taskList.innerHTML = taskCards.map((item) => {
      const selected = item.taskCardId === selectedTaskCardId;
      const preview = item.headline || '';
      const isDemo = isDemoCard(item.taskCardId);
      const demoBadge = isDemo ? '<span class="hall-demo-badge">DEMO</span>' : '';
      return '<button type="button" class="hall-task-card' + (selected ? ' is-selected' : '') + (isDemo ? ' is-demo' : '') + '" data-task-card-id="' + esc(item.taskCardId) + '" data-project-id="' + esc(item.projectId) + '" data-task-id="' + esc(item.taskId) + '"' + (selected ? ' aria-current="page"' : '') + '>' +
        '<div class="hall-task-card-row">' +
          hallAvatarMarkup(item.title || item.taskId, 'hall-task-card-avatar') +
          '<div class="hall-task-card-copy">' +
            '<div class="hall-task-title-row"><strong class="hall-task-title">' + demoBadge + esc(item.title) + '</strong><span class="hall-task-timestamp">' + esc(compactTimestamp(item.updatedAt)) + '</span></div>' +
            '<div class="hall-task-preview' + (preview ? '' : ' is-empty') + '">' + esc(preview) + '</div>' +
          '</div>' +
        '</div>' +
        '</button>';
    }).join('');
    taskList.querySelectorAll('[data-task-card-id]').forEach((button) => {
      button.addEventListener('click', () => {
        const prevDemo = isDemoMode;
        selectedTaskCardId = button.getAttribute('data-task-card-id') || '';
        selectedTaskProjectId = button.getAttribute('data-project-id') || '';
        selectedTaskId = button.getAttribute('data-task-id') || '';
        composerMode = 'reply';
        closeHandoffPanel();
        executionPlannerOpen = false;
        selectedTaskDetailPayload = null;
        /* Demo mode toggle */
        if (isDemoCard(selectedTaskCardId)) {
          hallMessages = [];
          hallDrafts = new Map();
          enterDemoMode();
        } else if (prevDemo) {
          exitDemoMode();
        }
        syncTaskUrl(selectedTaskCardId);
        renderTaskList(hallTaskCards);
        renderThreadHeader();
        renderDetail(null);
        renderDecisionPanel(null);
        renderVisibleThread();
        syncComposerMode();
        if (button instanceof HTMLElement) button.focus();
        if (thread instanceof HTMLElement) thread.scrollTop = 0;
        setFlash(textThreadSwitched + ' ' + (button.querySelector('.hall-task-title')?.textContent?.trim() || ''));
        if (!isDemoCard(selectedTaskCardId)) {
          void loadTaskDetail();
        }
      });
    });
    paintHallPixelAvatars(taskList);
  };

  const renderDecisionInline = (payload, options = {}) => {
    payload = withFreshestTaskCard(payload);
    const forceVisible = options.forceVisible === true;
    const taskCard = payload?.taskCard;
    const activeDrafts = visibleDrafts();
    const hasDiscussionOutcome = Boolean(
      String(taskCard?.proposal || '').trim()
      || String(taskCard?.latestSummary || '').trim(),
    );
    const hasExecutionPlan = (taskCard?.plannedExecutionOrder || []).length > 0 || (taskCard?.plannedExecutionItems || []).length > 0;
    const hasExecutionEntryPoint = Boolean(
      hasExecutionPlan
      || taskCard?.currentOwnerParticipantId
      || taskCard?.currentExecutionItem,
    );
    const hasFinalizedDecision = Boolean(
      taskCard?.decision
      || taskCard?.doneWhen
      || hasDiscussionOutcome
      || taskCard?.currentOwnerParticipantId
      || taskCard?.currentExecutionItem
      || taskCard?.discussionCycle?.closedAt
      || (taskCard && taskCard.stage !== 'discussion')
      || hasExecutionPlan
    );
    const shouldHideWhileDiscussionContinues = activeDrafts.length > 0 && !hasExecutionEntryPoint;
    if (!taskCard || (!forceVisible && (!hasFinalizedDecision || shouldHideWhileDiscussionContinues))) {
      return '';
    }
    const queueLabels = (taskCard.plannedExecutionOrder || []).map((participantId) => participantLabel(participantId));
    const actionItems = Array.isArray(taskCard.plannedExecutionItems) && taskCard.plannedExecutionItems.length > 0
      ? taskCard.plannedExecutionItems
      : buildExecutionItemsDraft(taskCard, taskCard.plannedExecutionOrder || [], []);
    const ownerMeta = decisionCardOwnerMeta(taskCard);
    const stepMeta = decisionCardStepMeta(taskCard);
    const activeQueue = executionPlannerOpen ? executionOrderDraft : (taskCard.plannedExecutionOrder || []);
    const activeItems = executionPlannerOpen ? executionItemsDraft : actionItems;
    const compactSummaryText = taskCard.decision || taskCard.proposal || taskCard.latestSummary || taskCard.description || '';
    const isExpanded = decisionExpanded;
    const primaryButtonLabel = decisionPrimaryButtonLabel(taskCard);
    const orderButtonLabel = decisionSecondaryOrderLabel(taskCard);
    const taskArtifacts = payload?.task?.artifacts || [];
    const summaryStats = [
      textStage + '：' + decisionCardStageText(taskCard),
      ownerMeta.label ? ownerMeta.heading + '：' + ownerMeta.label : '',
      stepMeta.task ? stepMeta.heading + '：' + stepMeta.task : '',
    ].filter(Boolean);
    const queuePreview = activeItems.length > 0
      ? '<div class="hall-decision-queue">' +
          activeItems.map((item, index) => {
            const nextParticipantId = item.handoffToParticipantId || activeQueue[index + 1];
            const nextParticipantLabel = nextParticipantId ? participantLabel(nextParticipantId) : '';
            return (
            '<div class="hall-decision-queue-item">' +
              hallAvatarMarkup(participantLabel(item.participantId), 'hall-decision-queue-avatar') +
              '<div><strong>' + esc(participantLabel(item.participantId)) + '</strong>' +
                '<span>#' + esc(String(index + 1)) + ' · ' + esc(item.task) + '</span>' +
                (nextParticipantLabel ? '<span>' + esc(textActionThenTo) + ' @' + esc(nextParticipantLabel) + '</span>' : '') +
                (item.handoffWhen ? '<span>' + esc(textActionThen) + ' · ' + esc(item.handoffWhen) + '</span>' : '') +
              '</div>' +
            '</div>'
            );
          }).join('') +
        '</div>'
      : '';
    const plannerRows = activeQueue.length > 0
      ? activeItems.map((item, index) => {
        const lockedExecutionParticipantId = hasLockedActiveExecution(taskCard)
          ? String(taskCard.currentExecutionItem?.participantId || taskCard.currentOwnerParticipantId || '').trim()
          : '';
        const isLockedCurrentItem = Boolean(lockedExecutionParticipantId) && item.participantId === lockedExecutionParticipantId;
        const nextParticipantId = item.handoffToParticipantId || activeQueue[index + 1];
        const nextParticipantLabel = nextParticipantId ? participantLabel(nextParticipantId) : '';
        const handoffOptions = ['<option value=\"\">' + esc(textNoHandoff) + '</option>']
          .concat(
            activeQueue
              .filter((participantId) => participantId !== item.participantId)
              .map((participantId) => '<option value="' + esc(participantId) + '" ' + (participantId === nextParticipantId ? 'selected' : '') + '>' + esc(participantLabel(participantId)) + '</option>'),
          )
          .join('');
        return (
        '<div class="hall-order-item" data-hall-order-item="' + esc(item.participantId) + '">' +
          '<div class="hall-order-item-copy">' +
            hallAvatarMarkup(participantLabel(item.participantId), 'hall-order-avatar') +
            '<div><strong>' + esc(participantLabel(item.participantId)) + '</strong><span>#' + esc(String(index + 1)) + '</span></div>' +
          '</div>' +
          '<div class="hall-order-item-fields">' +
            '<label><span>' + esc(textActionTask) + '</span><textarea class="hall-order-textarea" data-hall-item-task="' + esc(item.participantId) + '" rows="2">' + esc(item.task || '') + '</textarea></label>' +
            '<label><span>' + esc(textActionHandoffTo) + '</span><select class="hall-order-input" data-hall-item-handoff-to="' + esc(item.participantId) + '">' + handoffOptions + '</select></label>' +
            '<label><span>' + esc(textActionHandoffWhen) + '</span><input class="hall-order-input" data-hall-item-handoff="' + esc(item.participantId) + '" value="' + esc(item.handoffWhen || '') + '" /></label>' +
            (nextParticipantLabel ? '<div class="hall-order-item-next">' + esc(textActionThenTo) + ' @' + esc(nextParticipantLabel) + '</div>' : '') +
          '</div>' +
          '<div class="hall-order-item-actions">' +
            '<button type="button" class="hall-order-icon" data-hall-order-up="' + esc(item.participantId) + '" ' + (index === 0 || isLockedCurrentItem ? 'disabled' : '') + ' title="' + esc(textMoveUp) + '">↑</button>' +
            '<button type="button" class="hall-order-icon" data-hall-order-down="' + esc(item.participantId) + '" ' + (index === activeQueue.length - 1 || isLockedCurrentItem ? 'disabled' : '') + ' title="' + esc(textMoveDown) + '">↓</button>' +
            '<button type="button" class="hall-order-icon hall-order-icon--danger" data-hall-order-remove="' + esc(item.participantId) + '" ' + (isLockedCurrentItem ? 'disabled' : '') + ' title="' + esc(textRemove) + '">×</button>' +
          '</div>' +
        '</div>'
        );
      }).join('')
      : '<div class="hall-order-empty">' + esc(textNoActionItems) + '</div>';
    const availableParticipants = (bootstrap.participants || []).filter((participant) => !activeQueue.includes(participant.participantId));
    const plannerIsEmpty = activeQueue.length === 0;
    const plannerAvailableMarkup = '<div class="hall-order-available ' + (plannerIsEmpty ? 'hall-order-available--empty' : '') + '"><div class="hall-order-available-label">' + esc(textAvailableAgents) + '</div><div class="hall-order-chip-list">' +
      availableParticipants.map((participant) =>
        '<button type="button" class="hall-order-chip" data-hall-order-add="' + esc(participant.participantId) + '" title="' + esc(textAddToOrder) + '">' +
          hallAvatarMarkup(participant.displayName, 'hall-order-chip-avatar') +
          '<span>' + esc(participant.displayName) + '</span>' +
        '</button>'
      ).join('') +
    '</div></div>';
    const plannerPanel = executionPlannerOpen
      ? '<div class="hall-order-planner ' + (plannerIsEmpty ? 'hall-order-planner--empty' : '') + '">' +
          '<div class="hall-order-planner-head"><strong>' + esc(textPlanningOrder) + '</strong></div>' +
          (plannerIsEmpty
            ? '<div class="hall-order-empty-state">' +
                '<div class="hall-order-empty">' + esc(textNoActionItems) + '</div>' +
                plannerAvailableMarkup +
              '</div>'
            : '<div class="hall-order-list">' + plannerRows + '</div>' + plannerAvailableMarkup) +
          '<div class="hall-decision-actions ' + (plannerIsEmpty ? 'hall-decision-actions--planner-empty' : '') + '">' +
            '<button type="button" class="hall-secondary-button" data-hall-order-save>' + esc(textSaveOrder) + '</button>' +
            '<button type="button" class="hall-secondary-button" data-hall-order-cancel>' + esc(textCancelOrder) + '</button>' +
          '</div>' +
        '</div>'
      : '';
    if (executionPlannerOpen) {
      return (
        '<section class="hall-decision-card hall-decision-card--planner ' + (plannerIsEmpty ? 'is-empty' : '') + '" data-hall-current-console="planner">' +
          plannerPanel +
        '</section>'
      );
    }
    return (
            '<section class="hall-decision-card ' + (isExpanded ? 'is-expanded' : 'is-collapsed') + '" data-hall-current-console="summary">' +
              '<div class="hall-decision-top">' +
                '<div class="hall-decision-copy">' +
                  '<div class="hall-decision-label">' + esc(textDiscussionResult) + '</div>' +
                  '<div class="hall-decision-title-row">' +
                    '<div class="hall-decision-inline-summary" title="' + esc(compactSummaryText || taskCard.title || '') + '">' + esc(compactSummaryText || taskCard.title || '') + '</div>' +
                    '<button type="button" class="hall-secondary-button hall-secondary-button--compact hall-decision-toggle" onclick="return window.__openclawHallToggleDecisionDetails ? window.__openclawHallToggleDecisionDetails() : false">' + esc(isExpanded ? textHideDetails : textShowDetails) + '</button>' +
                  '</div>' +
                  (summaryStats.length > 0
                    ? '<div class="hall-decision-summary hall-decision-summary--compact">' +
                        summaryStats
                          .map((item) => '<span class="hall-decision-meta-line-item" title="' + esc(item) + '">' + esc(item) + '</span>')
                          .join('<span class="hall-decision-meta-sep">·</span>') +
                      '</div>'
                    : '') +
                '</div>' +
              '</div>' +
              (isExpanded && !executionPlannerOpen ? (
                '<div class="hall-decision-body">' +
                  '<div class="hall-decision-row"><strong>' + esc(textThread) + '</strong><span title="' + esc(taskCard.title || '') + '">' + esc(taskCard.title || '-') + '</span></div>' +
                  (taskCard.decision ? '<div class="hall-decision-row"><strong>' + esc(textDecision) + '</strong><span title="' + esc(taskCard.decision) + '">' + esc(taskCard.decision) + '</span></div>' : '') +
                (ownerMeta.label ? '<div class="hall-decision-row"><strong>' + esc(ownerMeta.heading) + '</strong><span title="' + esc(ownerMeta.label) + '">' + esc(ownerMeta.label) + '</span></div>' : '') +
                  (stepMeta.task ? '<div class="hall-decision-row"><strong>' + esc(stepMeta.heading) + '</strong><span title="' + esc(stepMeta.task) + '">' + esc(stepMeta.task) + '</span></div>' : '') +
                  (taskArtifacts.length > 0 ? '<div class="hall-decision-row"><strong>' + esc(textTaskArtifacts) + '</strong><div class="hall-artifact-list">' + renderArtifactChips(taskArtifacts) + '</div></div>' : '') +
                  queuePreview +
                '</div>'
              ) : '') +
              '<div class="hall-decision-actions">' +
                (shouldShowDecisionPrimaryAction(taskCard)
                  ? '<button type="button" class="hall-button" data-hall-start-execution onclick="return window.__openclawHallAssignOwner ? window.__openclawHallAssignOwner() : false">' + esc(primaryButtonLabel) + '</button>'
                  : '') +
                '<button type="button" class="hall-secondary-button hall-secondary-button--accent" data-hall-plan-order onclick="return window.__openclawHallSetExecutionOrder ? window.__openclawHallSetExecutionOrder() : false">' + esc(orderButtonLabel) + '</button>' +
                '<button type="button" class="hall-secondary-button" data-hall-continue-discussion onclick="return window.__openclawHallContinueDiscussion ? window.__openclawHallContinueDiscussion() : false">' + esc(textContinueDiscussion) + '</button>' +
              '</div>' +
              '<div class="hall-decision-helper">' + esc((hasPendingStartablePlan(taskCard) || taskCard.stage === 'discussion')
                ? (firstPlannedOwnerId(taskCard)
                  ? textExecutionStartHint
                  : textPlannerHint)
                : textExecutionThreadHint) + '</div>' +
              plannerPanel +
            '</section>'
    );
  };

  const renderThread = (messages) => {
    if (!thread) return;
    const previousDistanceFromBottom = threadDistanceFromBottom();
    const shouldStickToBottom = threadAutoFollow || previousDistanceFromBottom <= threadFollowThresholdPx;
    if (!Array.isArray(messages) || messages.length === 0) {
      thread.innerHTML = '<div class="hall-empty hall-empty--chat">' +
        '<div class="hall-empty-hero">' + hallAvatarMarkup('Collaboration Hall', 'hall-empty-avatar') + '</div>' +
        '<strong>' + esc(textHallQuiet) + '</strong>' +
        '<span>' + esc(labels.emptyThread || 'No hall messages yet.') + '</span>' +
        '<div class="hall-empty-actions">' +
          '<button type="button" class="hall-empty-action" onclick="return window.__openclawHallSetComposerValue ? window.__openclawHallSetComposerValue(' + JSON.stringify(draftTaskPrompt) + ') : false">' + esc(textDraftFirstTask) + '</button>' +
          '<button type="button" class="hall-empty-action" onclick="return window.__openclawHallSetComposerValue ? window.__openclawHallSetComposerValue(' + JSON.stringify(askImplementationPrompt) + ') : false">' + esc(textAskImplementationFirst) + '</button>' +
          '<button type="button" class="hall-empty-action" onclick="return window.__openclawHallSetComposerValue ? window.__openclawHallSetComposerValue(' + JSON.stringify(askDecisionPrompt) + ') : false">' + esc(textAskManagerToDecide) + '</button>' +
        '</div>' +
      '</div>';
      paintHallPixelAvatars(thread);
      threadAutoFollow = false;
      return;
    }
    const hiddenStatusMessages = new Set([
      'execution_order_updated',
      'execution_order_cleared',
      'execution_ready_for_review',
      'review_in_progress',
      'execution_started',
      'handoff_recorded',
      'execution_update',
      'runtime_execution_update',
      'runtime_handoff_update',
    ]);
    const shouldHideStatusMessage = (message) => {
      if (!message) return false;
      const status = String(message && message.payload && message.payload.status || '');
      if (message.kind === 'system' && hiddenStatusMessages.has(status)) return true;
      if (message.kind !== 'system') return false;
      const content = String(message.content || '').trim();
      if (!content) return false;
      return /Execution order updated:/i.test(content)
        || /顺序已更新/.test(content)
        || /Handoff moved to .*planned next owner/i.test(content)
        || /Manager handed the room to Reviewer\./i.test(content)
        || /现在请老板评审/.test(content)
        || /推进到可评审状态/.test(content)
        || /已经可评审了/.test(content);
    };
    const comparableMessageText = (content) => String(content || '')
      .replace(/<br\\s*\\/?>/gi, '\\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/(^|[\\s(>\\[\\{<,.;:!?\\"\'\u201c\u201d\u2018\u2019，。！？；：、）】」』》])@([A-Za-z0-9_\\\\-\\u4e00-\\u9fff]+)/g, '$1')
      .replace(/\\s+/g, ' ')
      .trim()
      .toLowerCase();
    const messagesSubstantiallyOverlap = (left, right) => {
      if (!left || !right) return false;
      const shorter = left.length <= right.length ? left : right;
      const longer = left.length <= right.length ? right : left;
      if (shorter.length >= 24 && longer.includes(shorter)) return true;
      const prefixLength = Math.min(96, left.length, right.length);
      return prefixLength >= 24 && left.slice(0, prefixLength) === right.slice(0, prefixLength);
    };
    const shouldHideSupersededOwnerStatus = (message, index, items) => {
      if (!message || message.kind !== 'status') return false;
      if (!message.authorParticipantId || message.authorParticipantId === 'operator' || message.authorParticipantId === 'system') return false;
      const messageCreatedAt = Date.parse(message.createdAt || '') || 0;
      if (!messageCreatedAt) return false;
      const comparable = comparableMessageText(message.content);
      if (comparable.length < 24) return false;
      return items.some((candidate, candidateIndex) => {
        if (candidateIndex === index || !candidate || candidate.kind !== 'handoff') return false;
        if (candidate.authorParticipantId !== message.authorParticipantId) return false;
        if (String(candidate.taskCardId || '') !== String(message.taskCardId || '')) return false;
        const candidateCreatedAt = Date.parse(candidate.createdAt || '') || 0;
        if (!candidateCreatedAt || Math.abs(candidateCreatedAt - messageCreatedAt) > 45_000) return false;
        return messagesSubstantiallyOverlap(comparable, comparableMessageText(candidate.content));
      });
    };
    const visibleMessages = Array.isArray(messages)
      ? messages
        .filter((message) => !shouldHideStatusMessage(message))
        .filter((message, index, items) => !shouldHideSupersededOwnerStatus(message, index, items))
      : [];
    const renderedMessages = visibleMessages.map((message, index) => {
      const authorType = message.authorParticipantId === 'operator'
        ? 'operator'
        : message.kind === 'system'
          ? 'system'
          : 'agent';
      const footer = [];
      if (message && message.payload && Array.isArray(message.payload.artifactRefs) && message.payload.artifactRefs.length > 0) {
        footer.push(renderArtifactFooterHtml(message.payload.artifactRefs, message.payload.fileAttachments));
      }
      if (message.isDraft) {
        footer.push('<span class="hall-kind-pill">' + esc(textStreaming) + '</span>');
      }
      let toolStripHtml = '';
      const toolCallsSource = (message.isDraft && Array.isArray(message.toolCalls) && message.toolCalls.length > 0)
        ? message.toolCalls
        : (message.payload && Array.isArray(message.payload.toolCalls) && message.payload.toolCalls.length > 0)
          ? message.payload.toolCalls
          : null;
      if (toolCallsSource) {
        const grouped = new Map();
        toolCallsSource.forEach((tc) => {
          const key = tc.toolName + ':' + (tc.toolStatus || 'running');
          const existing = grouped.get(key);
          if (existing) { existing.count += 1; }
          else { grouped.set(key, { toolName: tc.toolName, toolStatus: tc.toolStatus || 'running', count: 1 }); }
        });
        const pills = Array.from(grouped.values()).map((tc) => {
          const statusClass = tc.toolStatus === 'completed' ? 'is-completed' : tc.toolStatus === 'error' ? 'is-error' : 'is-running';
          const icon = tc.toolStatus === 'completed' ? '\\u2713' : tc.toolStatus === 'error' ? '\\u2717' : '\\u2699';
          const label = tc.count > 1 ? tc.toolName + ' \\u00d7' + tc.count : tc.toolName;
          return '<span class="hall-tool-pill ' + statusClass + '">' + icon + ' ' + esc(label) + '</span>';
        });
        toolStripHtml = '<div class="hall-tool-strip">' + pills.join('') + '</div>';
      }
      const messageMarkup = '<article class="hall-message" data-kind="' + esc(message.kind) + '" data-author-type="' + esc(authorType) + '">' +
        '<div class="hall-message-row">' +
          hallAvatarMarkup(message.authorLabel || 'Agent', 'hall-message-avatar') +
          '<div class="hall-message-bubble">' +
            '<div class="hall-message-head">' +
              '<div class="hall-message-author"><strong>' + esc(message.authorLabel) + '</strong><span class="hall-kind-pill">' + esc(kindLabel(message.kind)) + '</span></div>' +
              '<div class="hall-message-meta">' + esc(message.createdAt || '') + '</div>' +
            '</div>' +
            '<div class="hall-message-body">' + renderMarkdownHtml(message.content) + '</div>' +
            toolStripHtml +
            (footer.length > 0 ? '<div class="hall-message-footer">' + footer.join('') + '</div>' : '') +
          '</div>' +
        '</div>' +
      '</article>';
      return messageMarkup;
    }).join('');
    thread.innerHTML = renderedMessages;
    if (shouldStickToBottom) {
      thread.scrollTop = thread.scrollHeight;
    } else {
      thread.scrollTop = Math.max(0, thread.scrollHeight - thread.clientHeight - previousDistanceFromBottom);
    }
    paintHallPixelAvatars(thread);
  };

  const renderTypingStrip = () => {
    if (!typingStrip) return;
    const drafts = visibleTypingDrafts();
    if (drafts.length === 0) {
      typingStrip.innerHTML = '';
      typingStrip.hidden = true;
      renderMemberStrip();
      renderToolbarMetaNote();
      return;
    }
    const typingParticipants = drafts.slice(0, 3).map((draft) => ({
      label: draft.authorLabel || participantLabel(draft.authorParticipantId),
      avatarLabel: draft.authorLabel || participantLabel(draft.authorParticipantId),
    }));
    const text = drafts.length === 1
      ? typingParticipants[0].label + ' ' + textSingleTyping
      : drafts.length === 2
        ? typingParticipants[0].label + ' · ' + typingParticipants[1].label + ' ' + textMultiTyping
        : typingParticipants[0].label + '、' + typingParticipants[1].label + ' ' + textTypingMore(drafts.length - 2);
    typingStrip.innerHTML = '<div class="hall-typing-row">' +
      typingParticipants.map((participant) => '<span class="hall-typing-avatar-wrap">' + hallAvatarMarkup(participant.avatarLabel, 'hall-typing-avatar') + '</span>').join('') +
      '<span class="hall-typing-copy">' + esc(text) + '</span>' +
      '<span class="hall-typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>' +
    '</div>';
    typingStrip.hidden = false;
    paintHallPixelAvatars(typingStrip);
    renderMemberStrip();
    renderToolbarMetaNote();
  };

  const sanitizeDraftVisibleText = (value) => {
    const normalized = String(value || '')
      .replace(/\\u001B\\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/<hall-structured>[\\s\\S]*?(?:<\\/hall-structured>|$)/gi, '')
      .replace(/",\\s*"(nextAction|nextStep|latestSummary|artifactRefs|proposal|decision|executor|doneWhen|blockers|requiresInputFrom)"\\s*:\\s*[\\s\\S]*$/i, '');
    return normalized
      .split(/\\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^thinking\\b/i.test(line))
      .filter((line) => !/^\\[tool(?:[^\\]]*)?\\]/i.test(line))
      .filter((line) => !/^\\[\\/?tool\\]/i.test(line))
      .filter((line) => !/^Inspecting\\b/i.test(line))
      .filter((line) => !/^Checking\\b/i.test(line))
      .filter((line) => !/^Considering\\b/i.test(line))
      .filter((line) => !/^Maybe\\b/i.test(line))
      .filter((line) => !/^It seems\\b/i.test(line))
      .filter((line) => !/^Since the user\\b/i.test(line))
      .filter((line) => !/^I should\\b/i.test(line))
      .filter((line) => !/^I think\\b/i.test(line))
      .filter((line) => !/^I might\\b/i.test(line))
      .filter((line) => !/^I can\\b/i.test(line))
      .filter((line) => !/^Let's\\b/i.test(line))
      .join('\\n')
      .trim();
  };

  const draftMessages = () => visibleDrafts()
    .map((draft) => {
      const content = sanitizeDraftVisibleText(draft.content || '');
      if (!content && !(draft.toolCalls && draft.toolCalls.length)) return null;
      return {
        kind: draft.messageKind || 'chat',
        authorLabel: draft.authorLabel || draft.authorParticipantId || 'Agent',
        authorSemanticRole: draft.authorSemanticRole,
        content: content || '',
        createdAt: draft.createdAt || '',
        projectId: draft.projectId,
        taskId: draft.taskId,
        taskCardId: draft.taskCardId,
        roomId: draft.roomId,
        mentionTargets: [],
        isDraft: true,
        toolCalls: draft.toolCalls || [],
      };
    })
    .filter(Boolean);

  const renderDecisionPanel = (payload) => {
    if (!decisionPanel) return;
    const markup = payload ? renderDecisionInline(payload) : '';
    decisionPanel.innerHTML = markup;
    decisionPanel.hidden = !markup;
    paintHallPixelAvatars(decisionPanel);
  };

  const renderNewTaskDraftState = () => {
    if (!thread) return;
    thread.innerHTML = '<div class="hall-empty hall-empty--chat hall-empty--draft">' +
      '<div class="hall-empty-hero">' + hallAvatarMarkup('Collaboration Hall', 'hall-empty-avatar') + '</div>' +
      '<strong>' + esc(textNewTaskDraft) + '</strong>' +
      '<span>' + esc(textNewTaskDraftHint) + '</span>' +
    '</div>';
    renderTypingStrip();
  };

  const renderVisibleThread = () => {
    syncPlannerMode();
    if (composerMode === 'task' && !selectedTaskCardId) {
      renderNewTaskDraftState();
      renderDecisionPanel(null);
      return;
    }
    const scopedMessages = currentThreadMessages().filter((message) => {
        if (selectedTaskCardId) return message.taskCardId === selectedTaskCardId;
        return !message.taskCardId;
      })
    const merged = [...scopedMessages, ...draftMessages()]
      .sort((a, b) => Date.parse(a.createdAt || '') - Date.parse(b.createdAt || ''));
    renderThread(merged);
    renderDecisionPanel(selectedTaskCardId ? selectedTaskDetailPayload : null);
    renderTypingStrip();
    renderHandoffPanel();
  };

  const renderHandoffPanel = () => {
    if (!handoffPanel) return;
    if (!handoffPanelOpen || !selectedTaskDetailPayload?.taskCard) {
      handoffPanel.hidden = true;
      handoffPanel.innerHTML = '';
      return;
    }
    const taskCard = selectedTaskDetailPayload.taskCard;
    const currentOwnerId = taskCard.currentOwnerParticipantId;
    const candidates = (bootstrap.participants || []).filter((participant) => participant.active !== false && participant.participantId !== currentOwnerId);
    const nextTaskPreview = handoffDraftActionPreview(handoffDraft.toParticipantId);
    handoffPanel.hidden = false;
    handoffPanel.innerHTML =
      '<div class="hall-handoff-card">' +
        '<div class="hall-order-planner-head"><strong>' + esc(textHandoffPanelTitle) + '</strong><span>' + esc(textHandoffPanelHint) + '</span></div>' +
        '<div class="hall-handoff-grid">' +
          '<label><span>' + esc(textHandoffTo) + '</span><select class="hall-order-input" data-hall-handoff-owner>' +
            candidates.map((participant) => '<option value="' + esc(participant.participantId) + '"' + (handoffDraft.toParticipantId === participant.participantId ? ' selected' : '') + '>' + esc(participant.displayName) + '</option>').join('') +
          '</select></label>' +
          (nextTaskPreview ? '<div class="hall-order-item-next hall-handoff-preview"><strong>' + esc(textHandoffNextTask) + ':</strong> ' + esc(nextTaskPreview) + '</div>' : '') +
          '<label><span>' + esc(labels.handoffGoal || 'Goal') + '</span><textarea class="hall-order-textarea" rows="2" data-hall-handoff-goal>' + esc(handoffDraft.goal) + '</textarea></label>' +
          '<label><span>' + esc(labels.handoffCurrent || 'Current result') + '</span><textarea class="hall-order-textarea" rows="3" data-hall-handoff-current>' + esc(handoffDraft.currentResult) + '</textarea></label>' +
          '<label><span>' + esc(labels.handoffDoneWhen || 'Done when') + '</span><textarea class="hall-order-textarea" rows="2" data-hall-handoff-done>' + esc(handoffDraft.doneWhen) + '</textarea></label>' +
          '<label><span>' + esc(labels.handoffBlockers || 'Blockers') + '</span><input class="hall-order-input" data-hall-handoff-blockers value="' + esc(handoffDraft.blockers) + '" /></label>' +
          '<label><span>' + esc(labels.handoffRequires || 'Needs input from') + '</span><input class="hall-order-input" data-hall-handoff-requires value="' + esc(handoffDraft.requiresInputFrom) + '" /></label>' +
        '</div>' +
        '<div class="hall-decision-actions">' +
          '<button type="button" class="hall-button" data-hall-handoff-submit>' + esc(textHandoffSubmit) + '</button>' +
          '<button type="button" class="hall-secondary-button" data-hall-handoff-cancel>' + esc(textHandoffCancel) + '</button>' +
        '</div>' +
      '</div>';
  };

  const renderParallelGroupsDetailSection = (taskCard, _participants) => {
    const groups = taskCard?.parallelGroups;
    if (!Array.isArray(groups) || groups.length === 0) return '';
    const activeGroups = groups.filter((g) => g.status === 'active' || (g.status === 'settled' && g.settledAt && Date.now() - Date.parse(g.settledAt) < 5 * 60 * 1000));
    if (activeGroups.length === 0) return '';
    const statusBadge = (status) => {
      const colors = { pending: '#9ca3af', running: '#3b82f6', completed: '#22c55e', failed: '#ef4444' };
      const labels = { pending: 'Pending', running: 'Running', completed: 'Done', failed: 'Failed' };
      const color = colors[status] || '#9ca3af';
      return '<span style="display:inline-block;padding:1px 7px;border-radius:8px;font-size:11px;font-weight:500;border:1px solid ' + color + ';color:' + color + ';">' + esc(labels[status] || status) + '</span>';
    };
    const slotRows = activeGroups.flatMap((g) =>
      g.slots.map((slot) =>
        '<div class="hall-detail-meta" style="margin-top:4px;">' +
          statusBadge(slot.status) + ' ' +
          '<strong>' + esc(participantLabel(slot.participantId)) + '</strong>: ' +
          esc(slot.task.length > 80 ? slot.task.slice(0, 80) + '...' : slot.task) +
        '</div>'
      )
    ).join('');
    const totalSlots = activeGroups.reduce((sum, g) => sum + g.slots.length, 0);
    const completedSlots = activeGroups.reduce((sum, g) => sum + g.slots.filter((s) => s.status === 'completed' || s.status === 'failed').length, 0);
    return '<div class="hall-detail-group"><h4>Parallel Dispatch (' + completedSlots + '/' + totalSlots + ')</h4>' + slotRows + '</div>';
  };

  const renderDetail = (payload) => {
    payload = withFreshestTaskCard(payload);
    if (!detail) return;
    const taskCard = payload?.taskCard;
    const taskSummary = payload?.taskSummary;
    const task = payload?.task;
    if (!taskCard) {
      detail.innerHTML = '<div class="hall-empty">' + esc(textSelectTaskToInspect) + '</div>';
      return;
    }
    const ownerMeta = decisionCardOwnerMeta(taskCard);
    const stepMeta = decisionCardStepMeta(taskCard);
    const currentTaskValue = String(stepMeta.task || '-').trim() || '-';
    const plannedQueueLabels = (taskCard.plannedExecutionOrder || []).map((participantId) => participantLabel(participantId)).join(' → ') || '-';
    const executionFeedHint = (hasPendingStartablePlan(taskCard) || taskCard.stage === 'discussion')
      ? (firstPlannedOwnerId(taskCard)
        ? textExecutionStartHint
        : textPlannerHint)
      : textExecutionThreadHint;
    const roomLink = taskCard.roomId
      ? '<a class="hall-thread-link" href="?section=collaboration&roomId=' + encodeURIComponent(taskCard.roomId) + '">' + esc(textOpenDetailThread) + '</a>'
      : '';
    const participantNames = (bootstrap.participants || []).map((p) => p.displayName).join(' · ');
    detail.innerHTML =
      '<div class="hall-detail-list">' +
        '<div class="hall-detail-group"><h4>' + esc(taskCard.title || 'Thread') + '</h4>' +
          '<div class="hall-detail-meta">' + esc(taskCard.description || '-') + '</div>' +
        '</div>' +
        renderParallelGroupsDetailSection(taskCard, bootstrap.participants || []) +
        '<div class="hall-detail-group"><h4>' + esc(textTaskArtifacts) + '</h4>' +
          ((task?.artifacts || []).length > 0
            ? '<div class="hall-artifact-list">' + renderArtifactChips(task.artifacts) + '</div>'
            : '<div class="hall-detail-meta">' + esc(textNoArtifactsYet) + '</div>') +
        '</div>' +
        '<div class="hall-detail-group"><h4>' + esc(${JSON.stringify(pickUiText(language, "Workspace Files", "工作区文件"))}) + '</h4>' +
          '<div class="hall-workspace-files" data-hall-workspace-files>' +
            '<div class="hall-detail-meta">' + esc(${JSON.stringify(pickUiText(language, "Loading...", "加载中..."))}) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="hall-detail-group"><h4>Participants</h4>' +
          '<div class="hall-detail-meta">' + esc(participantNames) + '</div>' +
        '</div>' +
      '</div>';
    if (selectedTaskCardId) { loadWorkspaceFiles(selectedTaskCardId); }
  };

  const loadWorkspaceFiles = async (taskCardId) => {
    const container = root.querySelector('[data-hall-workspace-files]');
    if (!container) return;
    try {
      const res = await callJson('/api/hall/workspace-files?taskCardId=' + encodeURIComponent(taskCardId));
      const files = Array.isArray(res?.files) ? res.files : [];
      if (files.length === 0) {
        container.innerHTML = '<div class="hall-detail-meta">' + esc(${JSON.stringify(pickUiText(language, "No files yet.", "还没有文件。"))}) + '</div>';
        return;
      }
      container.innerHTML = files
        .filter((f) => !f.isDirectory)
        .map((f) => {
          const sizeKB = Math.round((f.sizeBytes || 0) / 1024);
          const href = '/hall-workspace-files/' + encodeURIComponent(taskCardId) + '/' + encodeURIComponent(f.relativePath);
          const isImage = /\.(png|jpe?g|webp|gif)$/i.test(f.relativePath);
          return '<a class="hall-workspace-file-item" href="' + esc(href) + '" target="_blank" rel="noreferrer">' +
            '<span class="hall-workspace-file-name">' + esc(f.relativePath) + '</span>' +
            '<span class="hall-workspace-file-meta">' + sizeKB + ' KB</span>' +
            (isImage ? '<img class="hall-workspace-file-thumb" src="' + esc(href) + '" loading="lazy" />' : '') +
          '</a>';
        }).join('');
    } catch {
      container.innerHTML = '<div class="hall-detail-meta">' + esc(${JSON.stringify(pickUiText(language, "Failed to load workspace files.", "加载工作区文件失败。"))}) + '</div>';
    }
  };

  const extractErrorMessage = (payload) => {
    if (payload && payload.error && typeof payload.error === 'object' && payload.error.message) {
      return payload.error.message;
    }
    return payload?.error || payload?.message || 'Request failed';
  };
  const callJson = async (url, init) => {
    const response = await fetch(url, init);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      throw new Error(extractErrorMessage(payload));
    }
    return payload;
  };
  const shouldRetryLocalToken = (response, payload) => {
    if (response.status === 401) return true;
    if (response.status !== 403) return false;
    return /invalid local token/i.test(extractErrorMessage(payload));
  };
  const callMutationJson = async (url, init) => {
    const requestOnce = async (token) => {
      const headers = {
        ...(init && init.headers ? init.headers : {}),
      };
      if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
        headers['content-type'] = 'application/json';
      }
      if (token) headers[tokenHeader] = token;
      const response = await fetch(url, {
        ...init,
        headers,
      });
      const payload = await response.json().catch(() => ({}));
      return { response, payload };
    };
    if (!tokenGateRequired) {
      const { response, payload } = await requestOnce('');
      if (!response.ok || payload?.ok === false) throw new Error(extractErrorMessage(payload));
      return payload;
    }
    let token = ensureToken(textTokenPrompt);
    if (!token) throw new Error(textNeedToken);
    let { response, payload } = await requestOnce(token);
    if (shouldRetryLocalToken(response, payload)) {
      clearToken();
      token = requestToken(textTokenRetryPrompt);
      if (!token) throw new Error(textNeedToken);
      ({ response, payload } = await requestOnce(token));
    }
    if (!response.ok || payload?.ok === false) throw new Error(extractErrorMessage(payload));
    return payload;
  };

  const loadHall = async (quiet = false) => {
    if (demoPlaybackRunning) return;
    if (hallReloadInFlight) return;
    hallReloadInFlight = true;
    try {
    if (!quiet) setFlash(labels.loading || 'Loading…');
    const hall = await callJson('/api/hall');
    if (headlineNode) {
      headlineNode.textContent = hallHeadlineText(hall?.hallSummary?.headline);
    }
    hallTaskCards = Array.isArray(hall.taskCards) ? hall.taskCards : [];
    if (selectedTaskCardId && !hallTaskCards.some((item) => item.taskCardId === selectedTaskCardId)) {
      selectedTaskCardId = '';
      selectedTaskProjectId = '';
      selectedTaskId = '';
      selectedTaskDetailPayload = null;
      executionPlannerOpen = false;
      decisionExpanded = false;
      closeHandoffPanel();
      syncTaskUrl('');
    }
    renderTaskList(hall.taskCards || []);
    hallMessages = Array.isArray(hall.messages) ? hall.messages : [];
    renderVisibleThread();
    if (!selectedTaskCardId && composerMode !== 'task' && Array.isArray(hall.taskCards) && hall.taskCards[0]) {
      selectedTaskCardId = hall.taskCards[0].taskCardId;
      selectedTaskProjectId = hall.taskCards[0].projectId;
      selectedTaskId = hall.taskCards[0].taskId;
      syncTaskUrl(selectedTaskCardId);
    } else {
      syncSelectedTaskRefs();
    }
    if (selectedTaskCardId) {
      composerMode = 'reply';
      await loadTaskDetail();
    } else {
      selectedTaskDetailPayload = null;
      renderDetail(null);
      renderDecisionPanel(null);
    }
    renderThreadHeader();
    syncComposerMode();
    if (!quiet) setFlash('');
    renderMemberStrip();
    renderToolbarMetaNote();
    } finally {
      hallReloadInFlight = false;
    }
  };

  const scheduleHallReload = () => {
    if (reloadTimer) window.clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(() => {
      if (isExecutionPlannerEditing()) {
        scheduleHallReload();
        return;
      }
      void loadHall(true).catch(() => {});
    }, 90);
  };

  const connectHallStream = () => {
    if (!window.EventSource) return;
    eventSource?.close?.();
    const source = new EventSource('/api/hall/events?hallId=' + encodeURIComponent(String(bootstrap.hallId || 'main')));
    eventSource = source;
    source.addEventListener('collaboration', (rawEvent) => {
      let event;
      try {
        event = JSON.parse(rawEvent.data || '{}');
      } catch {
        return;
      }
      if (!event || event.scope !== 'hall') return;
      if (event.type === 'draft_start' && event.draftId) {
        hallDrafts.set(event.draftId, {
          draftId: event.draftId,
          createdAt: event.createdAt || new Date().toISOString(),
          lastDeltaAt: event.createdAt || new Date().toISOString(),
          authorLabel: event.authorLabel || event.authorParticipantId || 'Agent',
          authorParticipantId: event.authorParticipantId,
          authorSemanticRole: event.authorSemanticRole,
          messageKind: event.messageKind || 'chat',
          taskCardId: event.taskCardId,
          projectId: event.projectId,
          taskId: event.taskId,
          roomId: event.roomId,
          content: '',
        });
        renderVisibleThread();
        return;
      }
      if (event.type === 'draft_delta' && event.draftId) {
        const draft = hallDrafts.get(event.draftId);
        if (!draft) return;
        draft.content = (draft.content || '') + String(event.delta || '');
        draft.lastDeltaAt = event.createdAt || new Date().toISOString();
        hallDrafts.set(event.draftId, draft);
        renderVisibleThread();
        return;
      }
      if (event.type === 'draft_tool_update' && event.draftId) {
        const draft = hallDrafts.get(event.draftId);
        if (!draft) return;
        if (!draft.toolCalls) draft.toolCalls = [];
        const toolName = String(event.toolName || '');
        const toolStatus = String(event.toolStatus || 'running');
        if (toolStatus === 'completed' || toolStatus === 'error') {
          const existing = [...draft.toolCalls].reverse().find((t) => t.toolName === toolName && t.toolStatus === 'running');
          if (existing) {
            existing.toolStatus = toolStatus;
            existing.endedAt = event.createdAt || new Date().toISOString();
          } else {
            draft.toolCalls.push({ toolName, toolStatus, startedAt: event.createdAt || new Date().toISOString(), endedAt: event.createdAt || new Date().toISOString() });
          }
        } else {
          draft.toolCalls.push({ toolName, toolStatus, startedAt: event.createdAt || new Date().toISOString() });
        }
        hallDrafts.set(event.draftId, draft);
        renderVisibleThread();
        return;
      }
      if ((event.type === 'draft_complete' || event.type === 'draft_abort') && event.draftId) {
        const draft = hallDrafts.get(event.draftId);
        if (event.type === 'draft_complete' && draft) {
          draft.settledAt = event.createdAt || new Date().toISOString();
          draft.lastDeltaAt = event.createdAt || new Date().toISOString();
          draft.persistedMessageId = event.messageId || '';
          hallDrafts.set(event.draftId, draft);
        } else {
          hallDrafts.delete(event.draftId);
        }
        renderVisibleThread();
        if (event.type === 'draft_complete') {
          scheduleHallReload();
        }
        return;
      }
      if (event.type === 'invalidate') {
        scheduleHallReload();
      }
    });
  };
  if (thread instanceof HTMLElement) {
    thread.addEventListener('scroll', () => {
      syncThreadAutoFollow();
    }, { passive: true });
  }

  const ensureActiveThreadPolling = () => {
    if (activeThreadPollTimer) window.clearInterval(activeThreadPollTimer);
    activeThreadPollTimer = window.setInterval(() => {
      if (document.hidden) return;
      if (!selectedTaskCardId) return;
      const stage = String(currentTaskCard()?.stage || '');
      if (!stage || !['discussion', 'execution', 'blocked', 'review'].includes(stage)) return;
      if (hallReloadInFlight) return;
      if (isExecutionPlannerEditing()) return;
      void loadHall(true).catch(() => {});
    }, 4000);
  };

  const loadTaskDetail = async () => {
    if (!selectedTaskCardId) {
      selectedTaskDetailPayload = null;
      renderDetail(null);
      renderDecisionPanel(null);
      renderVisibleThread();
      return;
    }
    if (isDemoCard(selectedTaskCardId)) {
      renderDetail(null);
      renderDecisionPanel(null);
      return;
    }
    syncSelectedTaskRefs();
    if (!selectedTaskId) {
      renderDetail(null);
      return;
    }
    const params = new URLSearchParams();
    params.set('taskCardId', selectedTaskCardId);
    if (selectedTaskProjectId) params.set('projectId', selectedTaskProjectId);
    const detailPayload = await callJson('/api/hall/tasks/' + encodeURIComponent(selectedTaskId) + '?' + params.toString());
    const preserveLocalExecutionPlan = executionOrderDraft.length > 0
      && (
        executionOrderDraftDirty
        || (executionOrderSavedAt > 0 && (Date.now() - executionOrderSavedAt) < 5000)
      )
      && !sameExecutionPlan(detailPayload.taskCard);
    if (preserveLocalExecutionPlan) {
      detailPayload.taskCard = injectLocalExecutionPlan(detailPayload.taskCard);
      syncLocalTaskCardIntoList(detailPayload.taskCard);
    }
    selectedTaskDetailPayload = detailPayload;
    selectedTaskCardId = detailPayload.taskCard?.taskCardId || selectedTaskCardId;
    selectedTaskProjectId = detailPayload.taskCard?.projectId || detailPayload.task?.projectId || selectedTaskProjectId;
    selectedTaskId = detailPayload.taskCard?.taskId || detailPayload.task?.taskId || selectedTaskId;
    if (!preserveLocalExecutionPlan) {
      syncExecutionOrderDraft(detailPayload.taskCard);
      executionOrderDraftDirty = false;
      if (sameExecutionPlan(detailPayload.taskCard)) executionOrderSavedAt = 0;
    }
    renderDetail(detailPayload);
    renderVisibleThread();
    renderThreadHeader();
    renderMemberStrip();
    renderToolbarMetaNote();
  };

  /* ── Demo playback engine ── */
  const demoChunkContent = (content) => {
    const trimmed = String(content || '').trim();
    if (!trimmed) return [''];
    const chunks = [];
    let current = '';
    for (const token of trimmed.split(/(\\s+)/).filter(Boolean)) {
      if (token.length > 48) {
        if (current) { chunks.push(current); current = ''; }
        for (let i = 0; i < token.length; i += 32) chunks.push(token.slice(i, i + 32));
        continue;
      }
      if ((current + token).length > 48 && current) {
        chunks.push(current);
        current = token;
        continue;
      }
      current += token;
    }
    if (current) chunks.push(current);
    return chunks.length > 0 ? chunks : [trimmed];
  };

  const demoSleep = (ms) => new Promise((resolve) => {
    const id = window.setTimeout(resolve, ms);
    if (demoPlaybackAbort) {
      const prev = demoPlaybackAbort;
      demoPlaybackAbort = () => { window.clearTimeout(id); prev(); };
    }
  });

  const loadDemoData = async () => {
    if (demoMessages) return demoMessages;
    const res = await fetch('/api/hall/demo/data');
    const json = await res.json();
    demoMessages = json.messages || [];
    return demoMessages;
  };

  const enterDemoMode = () => {
    isDemoMode = true;
    if (!(textarea instanceof HTMLTextAreaElement)) return;
    loadDemoData().then((msgs) => {
      const prompt = msgs[0]?.content || '';
      textarea.value = prompt;
      textarea.readOnly = true;
      textarea.style.opacity = '0.85';
      autoResizeComposer();
      if (sendButton instanceof HTMLElement) {
        sendButton.textContent = labels.reply || ${JSON.stringify(pickUiText(language, "Send reply", "发送回复"))};
      }
    });
  };

  const exitDemoMode = () => {
    isDemoMode = false;
    demoPlaybackRunning = false;
    if (demoPlaybackAbort) { demoPlaybackAbort(); demoPlaybackAbort = null; }
    if (!(textarea instanceof HTMLTextAreaElement)) return;
    textarea.readOnly = false;
    textarea.style.opacity = '';
    textarea.value = '';
    autoResizeComposer();
    if (sendButton instanceof HTMLElement) {
      sendButton.textContent = labels.reply || 'Send reply';
    }
  };

  const runDemoPlayback = async () => {
    if (demoPlaybackRunning) return;
    demoPlaybackRunning = true;
    threadAutoFollow = true;
    let aborted = false;
    demoPlaybackAbort = () => { aborted = true; };

    const msgs = await loadDemoData();
    if (!msgs || msgs.length === 0) { demoPlaybackRunning = false; return; }

    if (sendButton instanceof HTMLElement) {
      sendButton.disabled = true;
    }
    if (textarea instanceof HTMLTextAreaElement) {
      textarea.value = '';
      autoResizeComposer();
    }

    /* Message 0 is the operator's prompt — show it immediately as persisted */
    const operatorMsg = msgs[0];
    hallMessages.push({
      messageId: operatorMsg.messageId,
      kind: operatorMsg.kind,
      authorLabel: operatorMsg.authorLabel,
      authorParticipantId: operatorMsg.authorParticipantId,
      authorSemanticRole: operatorMsg.authorSemanticRole,
      content: operatorMsg.content,
      taskCardId: selectedTaskCardId,
      projectId: operatorMsg.projectId,
      taskId: operatorMsg.taskId,
      roomId: selectedTaskCardId,
      createdAt: new Date().toISOString(),
      payload: {},
    });
    renderVisibleThread();
    await demoSleep(600);

    /* Messages 1+ are agent replies — stream each with typewriter effect */
    for (let i = 1; i < msgs.length; i++) {
      if (aborted) break;
      const msg = msgs[i];
      const draftId = 'demo-draft-' + i;
      const now = () => new Date().toISOString();

      /* draft_start */
      hallDrafts.set(draftId, {
        draftId,
        createdAt: now(),
        lastDeltaAt: now(),
        authorLabel: msg.authorLabel || 'Agent',
        authorParticipantId: msg.authorParticipantId,
        authorSemanticRole: msg.authorSemanticRole,
        messageKind: msg.kind || 'status',
        taskCardId: selectedTaskCardId,
        projectId: msg.projectId,
        taskId: msg.taskId,
        roomId: selectedTaskCardId,
        content: '',
        toolCalls: [],
      });
      renderVisibleThread();
      await demoSleep(200);
      if (aborted) break;

      /* Tool calls: show them progressively early in the message */
      const toolCalls = msg.toolCalls || [];
      const toolCount = toolCalls.length;
      const chunks = demoChunkContent(msg.content);
      const totalChunks = chunks.length;
      const toolInsertInterval = toolCount > 0 ? Math.max(1, Math.floor(totalChunks * 0.15 / toolCount)) : 0;
      let nextToolIndex = 0;

      /* draft_delta — typewriter effect */
      for (let c = 0; c < totalChunks; c++) {
        if (aborted) break;
        const draft = hallDrafts.get(draftId);
        if (!draft) break;

        /* Insert tool calls at spaced intervals near the beginning */
        if (nextToolIndex < toolCount && toolInsertInterval > 0 && c > 0 && c % toolInsertInterval === 0) {
          const tc = toolCalls[nextToolIndex];
          if (!draft.toolCalls) draft.toolCalls = [];
          draft.toolCalls.push({ toolName: tc.toolName, toolStatus: 'running', startedAt: now() });
          hallDrafts.set(draftId, draft);
          renderVisibleThread();
          await demoSleep(150);
          if (aborted) break;
          /* Complete the tool call after a short delay */
          const runningTool = [...draft.toolCalls].reverse().find((t) => t.toolName === tc.toolName && t.toolStatus === 'running');
          if (runningTool) {
            runningTool.toolStatus = tc.toolStatus || 'completed';
            runningTool.endedAt = now();
          }
          hallDrafts.set(draftId, draft);
          nextToolIndex++;
        }

        draft.content = (draft.content || '') + chunks[c];
        draft.lastDeltaAt = now();
        hallDrafts.set(draftId, draft);
        renderVisibleThread();

        /* Adaptive delay: shorter for short chunks, tiny pause for natural flow */
        const chunkLen = chunks[c].length;
        const delay = chunkLen > 30 ? 18 : chunkLen > 15 ? 14 : 10;
        await demoSleep(delay);
      }
      if (aborted) break;

      /* Complete remaining tool calls */
      const draft = hallDrafts.get(draftId);
      if (draft) {
        while (nextToolIndex < toolCount) {
          const tc = toolCalls[nextToolIndex];
          if (!draft.toolCalls) draft.toolCalls = [];
          draft.toolCalls.push({ toolName: tc.toolName, toolStatus: tc.toolStatus || 'completed', startedAt: now(), endedAt: now() });
          nextToolIndex++;
        }
        hallDrafts.set(draftId, draft);
      }

      /* draft_complete — move to persisted messages */
      hallDrafts.delete(draftId);
      hallMessages.push({
        messageId: msg.messageId,
        kind: msg.kind,
        authorLabel: msg.authorLabel,
        authorParticipantId: msg.authorParticipantId,
        authorSemanticRole: msg.authorSemanticRole,
        content: msg.content,
        taskCardId: selectedTaskCardId,
        projectId: msg.projectId,
        taskId: msg.taskId,
        roomId: selectedTaskCardId,
        createdAt: now(),
        payload: { toolCalls: toolCalls.length > 0 ? toolCalls : undefined },
      });
      renderVisibleThread();

      /* Pause between messages — longer for dense content */
      const pauseMs = msg.content.length > 500 ? 800 : 500;
      await demoSleep(pauseMs);
    }

    /* Playback finished */
    demoPlaybackRunning = false;
    demoPlaybackAbort = null;
    if (sendButton instanceof HTMLElement) {
      sendButton.disabled = false;
    }
  };

  const createTask = async () => {
    if (!(textarea instanceof HTMLTextAreaElement)) return;
    const content = textarea.value.trim();
    if (!content) return;
    const payload = await callMutationJson('/api/hall/tasks', {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
    textarea.value = '';
    autoResizeComposer();
    composerMode = 'reply';
    selectedTaskCardId = payload.taskCard?.taskCardId || '';
    selectedTaskProjectId = payload.taskCard?.projectId || payload.task?.projectId || '';
    selectedTaskId = payload.taskCard?.taskId || payload.task?.taskId || '';
    syncComposerMode();
    await loadHall();
  };

  const postReply = async () => {
    if (!(textarea instanceof HTMLTextAreaElement)) return;
    const content = textarea.value.trim();
    if (!content && pendingFiles.length === 0) return;
    const fileAttachments = [];
    for (const item of pendingFiles) {
      try {
        const result = await callMutationJson('/api/hall/files', {
          method: 'POST',
          body: JSON.stringify({ dataUrl: item.dataUrl, fileName: item.file.name }),
        });
        if (result && result.file) fileAttachments.push(result.file);
      } catch (err) {
        setFlash(${JSON.stringify(pickUiText(language, "Upload failed: ", "上传失败："))} + (err instanceof Error ? err.message : item.file.name));
        return;
      }
    }
    await callMutationJson('/api/hall/messages', {
      method: 'POST',
      body: JSON.stringify({
        taskCardId: selectedTaskCardId || undefined,
        content: content || ${JSON.stringify(pickUiText(language, "(attached file)", "(附件)"))},
        fileAttachments: fileAttachments.length > 0 ? fileAttachments : undefined,
      }),
    });
    textarea.value = '';
    pendingFiles = [];
    renderPendingFiles();
    autoResizeComposer();
    await loadHall();
  };
  const submitComposer = async () => {
    if (isDemoMode) {
      await runDemoPlayback();
      return;
    }
    if (composerMode === 'task') {
      await createTask();
      return;
    }
    await postReply();
  };

  const assignOwner = async (participantIdOverride) => {
    syncSelectedTaskRefs();
    if (!selectedTaskId) {
      setFlash(${JSON.stringify(pickUiText(language, "Select a task thread first.", "先选中一个任务线程。"))});
      return;
    }
    const taskCard = selectedTaskDetailPayload?.taskCard;
    const chosenParticipantId = String(
      participantIdOverride
      || (
        taskCard && taskCard.stage !== 'execution'
          ? (taskCard.plannedExecutionOrder?.[0] || taskCard.currentOwnerParticipantId || executionOrderDraft[0] || '')
          : ''
      )
      || ''
    ).trim();
    if (!chosenParticipantId) {
      setFlash(textPlannerHint);
      return;
    }
    const participant = (bootstrap.participants || []).find((item) => item.participantId === chosenParticipantId);
    if (!participant) {
      setFlash('Unknown owner: ' + chosenParticipantId);
      return;
    }
    await callMutationJson('/api/hall/tasks/' + encodeURIComponent(selectedTaskId) + '/assign', {
      method: 'POST',
      body: JSON.stringify({
        taskCardId: selectedTaskCardId,
        projectId: selectedTaskProjectId,
        participantId: participant.participantId,
      }),
    });
    if (taskCard?.stage === 'discussion' && executionOrderDraft.length > 0 && executionOrderDraft[0] !== participant.participantId) {
      const reordered = [participant.participantId, ...executionOrderDraft.filter((id) => id !== participant.participantId)];
      executionOrderDraft = reordered;
      executionItemsDraft = buildExecutionItemsDraft(taskCard, reordered, executionItemsDraft);
    }
    await loadHall();
  };

  const setExecutionOrder = async (participantIdsOverride) => {
    syncSelectedTaskRefs();
    if (!selectedTaskId) {
      setFlash(${JSON.stringify(pickUiText(language, "Select a task thread first.", "先选中一个任务线程。"))});
      return;
    }
    const participantIds = Array.isArray(participantIdsOverride)
      ? participantIdsOverride.slice()
      : executionOrderDraft.slice();
    const executionItems = executionItemsDraft
      .filter((item) => participantIds.includes(item.participantId))
      .map((item) => ({
        itemId: item.itemId,
        participantId: item.participantId,
        task: String(item.task || '').trim(),
        handoffToParticipantId: String(item.handoffToParticipantId || '').trim(),
        handoffWhen: String(item.handoffWhen || '').trim(),
      }))
      .filter((item) => item.participantId && item.task);
    await callMutationJson('/api/hall/tasks/' + encodeURIComponent(selectedTaskId) + '/execution-order', {
      method: 'POST',
      body: JSON.stringify({
        taskCardId: selectedTaskCardId,
        projectId: selectedTaskProjectId,
        participantIds,
        executionItems,
      }),
    });
    executionOrderDraftDirty = false;
    executionOrderSavedAt = Date.now();
    if (selectedTaskDetailPayload?.taskCard) {
      const patchedTaskCard = injectLocalExecutionPlan(selectedTaskDetailPayload.taskCard);
      selectedTaskDetailPayload = {
        ...selectedTaskDetailPayload,
        taskCard: patchedTaskCard,
      };
      syncLocalTaskCardIntoList(patchedTaskCard);
    }
    executionPlannerOpen = false;
    renderDetail(selectedTaskDetailPayload);
    renderVisibleThread();
    await loadHall(true);
    const refreshedTaskCard = currentTaskCard();
    const plannedOwnerId = refreshedTaskCard?.plannedExecutionOrder?.[0];
    const plannedOwnerLabel = plannedOwnerId ? participantLabel(plannedOwnerId) : '';
    setFlash(
      refreshedTaskCard?.stage !== 'execution' && plannedOwnerLabel
        ? ('顺序排好了。下一步点"开始执行（' + plannedOwnerLabel + '）"。')
        : ${JSON.stringify(pickUiText(language, "The queue is updated. Let the current owner finish this pass first.", "后续顺序已更新，先让当前 owner 把这一棒走完。"))},
    );
  };

  const reviewTask = async (outcome) => {
    syncSelectedTaskRefs();
    if (!selectedTaskId) {
      setFlash(${JSON.stringify(pickUiText(language, "Select a task thread first.", "先选中一个任务线程。"))});
      return;
    }
    const note = '';
    await callMutationJson('/api/hall/tasks/' + encodeURIComponent(selectedTaskId) + '/review', {
      method: 'POST',
      body: JSON.stringify({
        taskCardId: selectedTaskCardId,
        projectId: selectedTaskProjectId,
        outcome,
        note,
        blockTask: outcome === 'rejected',
      }),
    });
    await loadHall();
  };

  const handoffTask = async () => {
    syncSelectedTaskRefs();
    if (!selectedTaskId) {
      setFlash(${JSON.stringify(pickUiText(language, "Select a task thread first.", "先选中一个任务线程。"))});
      return;
    }
    const participant = (bootstrap.participants || []).find((item) => item.participantId === handoffDraft.toParticipantId);
    if (!participant) {
      setFlash('Unknown owner: ' + handoffDraft.toParticipantId);
      return;
    }
    const goal = String(handoffDraft.goal || '').trim();
    const currentResult = String(handoffDraft.currentResult || '').trim();
    const doneWhen = String(handoffDraft.doneWhen || '').trim();
    const blockers = String(handoffDraft.blockers || '').split(',').map((item) => item.trim()).filter(Boolean);
    const requiresInputFrom = String(handoffDraft.requiresInputFrom || '').split(',').map((item) => item.trim()).filter(Boolean);
    await callMutationJson('/api/hall/tasks/' + encodeURIComponent(selectedTaskId) + '/handoff', {
      method: 'POST',
      body: JSON.stringify({
        taskCardId: selectedTaskCardId,
        projectId: selectedTaskProjectId,
        toParticipantId: participant.participantId,
        handoff: {
          goal,
          currentResult,
          doneWhen,
          blockers,
          nextOwner: participant.displayName,
          requiresInputFrom,
        },
      }),
    });
    closeHandoffPanel();
    await loadHall();
  };
  window.__openclawHallDebug = { ready: true };
  window.__openclawHallInsertMention = (mention) => insertMention(String(mention || ''));
  window.__openclawHallSetComposerValue = (value) => setComposerValue(String(value || ''));
  window.__openclawHallSendReply = (event) => {
    event?.preventDefault?.();
    void submitComposer().catch((error) => setFlash(error instanceof Error ? error.message : String(error)));
    return false;
  };
  window.__openclawHallOpenNewTaskComposer = () => openNewTaskComposer();
  window.__openclawHallAssignOwner = () => {
    void assignOwner('').catch((error) => setFlash(error instanceof Error ? error.message : String(error)));
    return false;
  };
  window.__openclawHallSetExecutionOrder = () => {
    executionPlannerOpen = !executionPlannerOpen;
    if (executionPlannerOpen) {
      decisionExpanded = false;
      syncExecutionOrderDraft(selectedTaskDetailPayload?.taskCard);
      executionOrderDraftDirty = false;
    }
    renderVisibleThread();
    return false;
  };
  window.__openclawHallFocusComposer = () => focusComposer();
  window.__openclawHallContinueDiscussion = () => {
    syncSelectedTaskRefs();
    const taskCard = selectedTaskDetailPayload?.taskCard;
    if (!(textarea instanceof HTMLTextAreaElement)) {
      focusComposer();
      return false;
    }
    if (!taskCard || taskCard.stage === 'discussion') {
      if (!textarea.value.trim()) {
        textarea.value = textContinueDiscussionSeed;
        autoResizeComposer();
      }
      focusComposer();
      return false;
    }
    const reopen = async () => {
      if (taskCard.stage === 'execution' || taskCard.stage === 'blocked') {
        await callMutationJson('/api/hall/tasks/' + encodeURIComponent(selectedTaskId) + '/stop', {
          method: 'POST',
          body: JSON.stringify({
            taskCardId: selectedTaskCardId,
            projectId: selectedTaskProjectId,
            note: textContinueDiscussionSeed,
          }),
        });
        await loadHall(true);
      } else {
        await callMutationJson('/api/hall/messages', {
          method: 'POST',
          body: JSON.stringify({
            taskCardId: selectedTaskCardId || undefined,
            content: textContinueDiscussionSeed,
          }),
        });
        await loadHall();
      }
      textarea.value = '';
      autoResizeComposer();
      focusComposer();
      setFlash('已切回讨论，可以继续追问。');
    };
    void reopen().catch((error) => setFlash(error instanceof Error ? error.message : String(error)));
    return false;
  };
  window.__openclawHallToggleDecisionDetails = () => {
    decisionExpanded = !decisionExpanded;
    renderVisibleThread();
    return false;
  };
  window.__openclawHallHandleComposerKeydown = (event) => {
    if (!event) return true;
    if (event.key !== 'Enter' || event.shiftKey) {
      pendingComposerSubmitAfterComposition = false;
      return true;
    }
    if (event.isComposing || isComposing || event.keyCode === 229) {
      pendingComposerSubmitAfterComposition = true;
      return true;
    }
    pendingComposerSubmitAfterComposition = false;
    event.preventDefault();
    void submitComposer().catch((error) => setFlash(error instanceof Error ? error.message : String(error)));
    return false;
  };
  window.__openclawHallHandleComposerKeyup = (event) => {
    if (!event) return true;
    if (event.key !== 'Enter' || event.shiftKey) return true;
    if (event.isComposing || isComposing || event.keyCode === 229) return true;
    if (!pendingComposerSubmitAfterComposition) return true;
    pendingComposerSubmitAfterComposition = false;
    event.preventDefault();
    void submitComposer().catch((error) => setFlash(error instanceof Error ? error.message : String(error)));
    return false;
  };
  const stopTask = async () => {
    syncSelectedTaskRefs();
    if (!selectedTaskId) {
      setFlash(${JSON.stringify(pickUiText(language, "Select a task thread first.", "先选中一个任务线程。"))});
      return;
    }
    await callMutationJson('/api/hall/tasks/' + encodeURIComponent(selectedTaskId) + '/stop', {
      method: 'POST',
      body: JSON.stringify({
        taskCardId: selectedTaskCardId,
      }),
    });
    setFlash(textStopped);
    await loadHall();
  };
  const archiveCurrentThread = async () => {
    syncSelectedTaskRefs();
    if (!selectedTaskId || !selectedTaskCardId) {
      setFlash(${JSON.stringify(pickUiText(language, "Select a task thread first.", "先选中一个任务线程。"))});
      return;
    }
    if (!window.confirm(textArchiveConfirm)) return;
    await callMutationJson('/api/hall/tasks/' + encodeURIComponent(selectedTaskId) + '/archive', {
      method: 'POST',
      body: JSON.stringify({
        taskCardId: selectedTaskCardId,
        projectId: selectedTaskProjectId,
      }),
    });
    selectedTaskCardId = '';
    selectedTaskProjectId = '';
    selectedTaskId = '';
    selectedTaskDetailPayload = null;
    if (threadActionsMenu instanceof HTMLDetailsElement) threadActionsMenu.open = false;
    executionPlannerOpen = false;
    decisionExpanded = false;
    composerMode = 'reply';
    syncTaskUrl('');
    await loadHall(true);
    setFlash(textArchived);
  };
  const deleteCurrentThread = async () => {
    syncSelectedTaskRefs();
    if (!selectedTaskId || !selectedTaskCardId) {
      setFlash(${JSON.stringify(pickUiText(language, "Select a task thread first.", "先选中一个任务线程。"))});
      return;
    }
    if (!window.confirm(textDeleteConfirm)) return;
    await callMutationJson('/api/hall/tasks/' + encodeURIComponent(selectedTaskId) + '/delete', {
      method: 'POST',
      body: JSON.stringify({
        taskCardId: selectedTaskCardId,
        projectId: selectedTaskProjectId,
      }),
    });
    selectedTaskCardId = '';
    selectedTaskProjectId = '';
    selectedTaskId = '';
    selectedTaskDetailPayload = null;
    if (threadActionsMenu instanceof HTMLDetailsElement) threadActionsMenu.open = false;
    executionPlannerOpen = false;
    decisionExpanded = false;
    composerMode = 'reply';
    syncTaskUrl('');
    await loadHall(true);
    setFlash(textDeleted);
  };

  composer?.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitComposer().catch((error) => setFlash(error instanceof Error ? error.message : String(error)));
  });
  textarea?.addEventListener('compositionstart', () => {
    isComposing = true;
  });
  textarea?.addEventListener('compositionend', () => {
    window.setTimeout(() => {
      isComposing = false;
      if (!pendingComposerSubmitAfterComposition) return;
      pendingComposerSubmitAfterComposition = false;
      void submitComposer().catch((error) => setFlash(error instanceof Error ? error.message : String(error)));
    }, 0);
  });
  root.querySelector('[data-hall-create-task]')?.addEventListener('click', () => {
    void createTask().catch((error) => setFlash(error instanceof Error ? error.message : String(error)));
  });
  root.querySelector('[data-hall-compose-task]')?.addEventListener('click', () => {
    openNewTaskComposer();
  });
  stopButton?.addEventListener('click', () => {
    void stopTask().catch((error) => setFlash(error instanceof Error ? error.message : String(error)));
  });
  archiveThreadButton?.addEventListener('click', () => {
    void archiveCurrentThread().catch((error) => setFlash(error instanceof Error ? error.message : String(error)));
  });
  deleteThreadButton?.addEventListener('click', () => {
    void deleteCurrentThread().catch((error) => setFlash(error instanceof Error ? error.message : String(error)));
  });
  root.querySelector('[data-hall-plan-order]')?.addEventListener?.('click', () => {
    executionPlannerOpen = !executionPlannerOpen;
    if (executionPlannerOpen) {
      syncExecutionOrderDraft(selectedTaskDetailPayload?.taskCard);
      executionOrderDraftDirty = false;
    }
    renderVisibleThread();
  });
  const handleDecisionInteraction = (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (!target) return;
    const addId = target.closest('[data-hall-order-add]')?.getAttribute('data-hall-order-add');
    if (addId) {
      executionPlannerFocusParticipantId = addId;
      replaceExecutionOrderDraft([...executionOrderDraft, addId]);
      setFlash('已加入执行顺序：' + participantLabel(addId));
      return;
    }
    const removeId = target.closest('[data-hall-order-remove]')?.getAttribute('data-hall-order-remove');
    if (removeId) {
      replaceExecutionOrderDraft(executionOrderDraft.filter((participantId) => participantId !== removeId));
      return;
    }
    const moveUpId = target.closest('[data-hall-order-up]')?.getAttribute('data-hall-order-up');
    if (moveUpId) {
      moveExecutionOrderDraft(moveUpId, 'up');
      return;
    }
    const moveDownId = target.closest('[data-hall-order-down]')?.getAttribute('data-hall-order-down');
    if (moveDownId) {
      moveExecutionOrderDraft(moveDownId, 'down');
      return;
    }
    if (target.closest('[data-hall-order-cancel]')) {
      executionPlannerOpen = false;
      syncExecutionOrderDraft(selectedTaskDetailPayload?.taskCard);
      executionOrderDraftDirty = false;
      renderVisibleThread();
      return;
    }
    if (target.closest('[data-hall-order-save]')) {
      void setExecutionOrder(executionOrderDraft).catch((error) => setFlash(error instanceof Error ? error.message : String(error)));
    }
  };
  const handleDecisionInputs = (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const taskParticipantId = target.getAttribute('data-hall-item-task');
    if (taskParticipantId && target instanceof HTMLTextAreaElement) {
      markExecutionPlannerEditing();
      patchExecutionItemDraft(taskParticipantId, { task: target.value });
      return;
    }
    const handoffParticipantId = target.getAttribute('data-hall-item-handoff');
    if (handoffParticipantId && target instanceof HTMLInputElement) {
      markExecutionPlannerEditing();
      patchExecutionItemDraft(handoffParticipantId, { handoffWhen: target.value });
      return;
    }
    const handoffToParticipantId = target.getAttribute('data-hall-item-handoff-to');
    if (handoffToParticipantId && target instanceof HTMLSelectElement) {
      markExecutionPlannerEditing();
      patchExecutionItemDraft(handoffToParticipantId, { handoffToParticipantId: target.value || '' });
    }
  };
  decisionPanel?.addEventListener('click', handleDecisionInteraction);
  thread?.addEventListener('click', handleDecisionInteraction);
  decisionPanel?.addEventListener('input', handleDecisionInputs);
  thread?.addEventListener('input', handleDecisionInputs);
  decisionPanel?.addEventListener('change', handleDecisionInputs);
  thread?.addEventListener('change', handleDecisionInputs);
  decisionPanel?.addEventListener('focusin', (event) => {
    if (isExecutionPlannerField(event.target)) markExecutionPlannerEditing();
  });
  thread?.addEventListener('focusin', (event) => {
    if (isExecutionPlannerField(event.target)) markExecutionPlannerEditing();
  });
  textarea?.addEventListener('input', () => {
    autoResizeComposer();
  });
  root.querySelector('[data-hall-approve]')?.addEventListener('click', () => {
    void reviewTask('approved').catch((error) => setFlash(error instanceof Error ? error.message : String(error)));
  });
  root.querySelector('[data-hall-reject]')?.addEventListener('click', () => {
    void reviewTask('rejected').catch((error) => setFlash(error instanceof Error ? error.message : String(error)));
  });
  root.querySelector('[data-hall-handoff]')?.addEventListener('click', () => {
    openHandoffPanel();
  });
  handoffPanel?.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.matches('[data-hall-handoff-owner]') && target instanceof HTMLSelectElement) {
      handoffDraft.toParticipantId = target.value;
      renderHandoffPanel();
      return;
    }
    if (target.matches('[data-hall-handoff-goal]') && target instanceof HTMLTextAreaElement) handoffDraft.goal = target.value;
    if (target.matches('[data-hall-handoff-current]') && target instanceof HTMLTextAreaElement) handoffDraft.currentResult = target.value;
    if (target.matches('[data-hall-handoff-done]') && target instanceof HTMLTextAreaElement) handoffDraft.doneWhen = target.value;
    if (target.matches('[data-hall-handoff-blockers]') && target instanceof HTMLInputElement) handoffDraft.blockers = target.value;
    if (target.matches('[data-hall-handoff-requires]') && target instanceof HTMLInputElement) handoffDraft.requiresInputFrom = target.value;
  });
  handoffPanel?.addEventListener('click', (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (!target) return;
    if (target.closest('[data-hall-handoff-cancel]')) {
      closeHandoffPanel();
      return;
    }
    if (target.closest('[data-hall-handoff-submit]')) {
      void handoffTask().catch((error) => setFlash(error instanceof Error ? error.message : String(error)));
    }
  });
  contextToggles.forEach((toggle) => {
    toggle.addEventListener('click', () => {
      setContextOpen(root.classList.contains('is-context-collapsed'));
    });
  });
  setContextOpen(true);
  renderThreadHeader();
  syncComposerMode();
  autoResizeComposer();
  if (thread instanceof HTMLElement) {
    thread.scrollTop = thread.scrollHeight;
  }
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && root.classList.contains('is-context-open')) {
      setContextOpen(false);
    }
  });
  typingSweepTimer = window.setInterval(() => {
    if (cleanupTypingDrafts()) renderVisibleThread();
  }, 5_000);
  ensureActiveThreadPolling();
  void loadHall().catch((error) => setFlash(error instanceof Error ? error.message : String(error)));
  connectHallStream();
  paintHallPixelAvatars(root);
  window.addEventListener('beforeunload', () => {
    if (reloadTimer) window.clearTimeout(reloadTimer);
    if (typingSweepTimer) window.clearInterval(typingSweepTimer);
    if (activeThreadPollTimer) window.clearInterval(activeThreadPollTimer);
    eventSource?.close?.();
  }, { once: true });
})();
</script>`;
}

export function renderCollaborationHallForSmoke(language: UiLanguage = "zh"): string {
  const hall: CollaborationHall = {
    hallId: "main",
    title: "Collaboration Hall",
    participants: [
      { participantId: "lead", agentId: "lead", displayName: "Turing", semanticRole: "manager", active: true, aliases: ["Turing"] },
      { participantId: "builder", agentId: "builder", displayName: "Linus", semanticRole: "coder", active: true, aliases: ["Linus"] },
      { participantId: "reviewer", agentId: "reviewer", displayName: "Rosalind", semanticRole: "reviewer", active: true, aliases: ["Rosalind"] },
    ],
    taskCardIds: ["demo"],
    messageIds: ["demo-message"],
    lastMessageId: "demo-message",
    latestMessageAt: "2026-03-19T10:05:00.000Z",
    createdAt: "2026-03-19T10:00:00.000Z",
    updatedAt: "2026-03-19T10:05:00.000Z",
  };
  const taskCard: HallTaskCard = {
    hallId: "main",
    taskCardId: "demo",
    projectId: "collaboration-hall",
    taskId: "demo-task",
    roomId: "collaboration-hall:demo-task",
    title: "Build the public collaboration hall",
    description: "Replace the task-room-first collaboration UI with one shared hall timeline.",
    stage: "discussion",
    status: "todo",
    createdByParticipantId: "operator",
    currentOwnerParticipantId: "builder",
    currentOwnerLabel: "Linus",
    proposal: "Use the hall as the main timeline and keep the linked room as evidence only.",
    decision: "Turing should assign the first execution pass to Linus.",
    doneWhen: "The hall, task cards, execution lock, and review flow all render in one page.",
    plannedExecutionOrder: ["builder", "reviewer"],
    plannedExecutionItems: [
      {
        itemId: "demo-1",
        participantId: "builder",
        task: "Implement the first hall timeline slice and bring back a reviewable UI pass.",
        handoffWhen: "When the first pass is clickable in the hall, post screenshots and hand off to review.",
      },
      {
        itemId: "demo-2",
        participantId: "reviewer",
        task: "Review the first pass for regressions, missing states, and unclear interaction copy.",
        handoffWhen: "Close once the required fixes are explicit and the next owner is clear.",
      },
    ],
    latestSummary: "Linus is ready to implement the first slice.",
    blockers: [],
    requiresInputFrom: [],
    mentionedParticipantIds: [],
    sessionKeys: [],
    createdAt: "2026-03-19T10:00:00.000Z",
    updatedAt: "2026-03-19T10:05:00.000Z",
  };
  return renderCollaborationHall({
    language,
    hall,
    hallSummary: {
      hallId: hall.hallId,
      headline: "Turing aligned the first build slice and is about to assign execution.",
      activeTaskCount: 1,
      waitingReviewCount: 0,
      blockedTaskCount: 0,
      currentSpeakerLabel: "Turing",
      updatedAt: hall.updatedAt,
    },
    taskCards: [
      {
        card: taskCard,
        summary: {
          taskCardId: taskCard.taskCardId,
          projectId: taskCard.projectId,
          taskId: taskCard.taskId,
          headline: "Use a shared hall timeline and a linked evidence thread.",
          currentOwnerLabel: "Linus",
          nextAction: "Assign the first execution owner.",
          stage: taskCard.stage,
          blockerCount: 0,
          updatedAt: taskCard.updatedAt,
        },
        task: {
          projectId: taskCard.projectId,
          taskId: taskCard.taskId,
          title: taskCard.title,
          status: "todo",
          owner: "Operator",
          roomId: taskCard.roomId,
          definitionOfDone: ["Hall UI works", "Execution lock works"],
          artifacts: [],
          rollback: { strategy: "manual", steps: [] },
          sessionKeys: [],
          budget: {},
          updatedAt: taskCard.updatedAt,
        },
      },
    ],
    selectedTaskCard: taskCard,
    selectedTaskSummary: {
      taskCardId: taskCard.taskCardId,
      projectId: taskCard.projectId,
      taskId: taskCard.taskId,
      headline: "Lead aligned the first build slice and is about to assign execution.",
      currentOwnerLabel: "Linus",
      nextAction: "Assign the first execution owner.",
      stage: taskCard.stage,
      blockerCount: 0,
      updatedAt: taskCard.updatedAt,
    },
    selectedTask: {
      projectId: taskCard.projectId,
      taskId: taskCard.taskId,
      title: taskCard.title,
      status: "todo",
      owner: "Operator",
      roomId: taskCard.roomId,
      definitionOfDone: ["Hall UI works", "Execution lock works"],
      artifacts: [],
      rollback: { strategy: "manual", steps: [] },
      sessionKeys: [],
      budget: {},
      updatedAt: taskCard.updatedAt,
    },
    messages: [
      {
        hallId: hall.hallId,
        messageId: "m1",
        kind: "task",
        authorParticipantId: "operator",
        authorLabel: "Operator",
        content: "Build one public collaboration hall for all agents.",
        targetParticipantIds: ["main"],
        mentionTargets: [],
        projectId: taskCard.projectId,
        taskId: taskCard.taskId,
        taskCardId: taskCard.taskCardId,
        roomId: taskCard.roomId,
        createdAt: "2026-03-19T10:01:00.000Z",
      },
      {
        hallId: hall.hallId,
        messageId: "m2",
        kind: "decision",
        authorParticipantId: "lead",
        authorLabel: "Lead",
        authorSemanticRole: "manager",
        content: "We will keep the shared hall as the main timeline and assign the first implementation pass to Builder.",
        targetParticipantIds: [],
        mentionTargets: [],
        projectId: taskCard.projectId,
        taskId: taskCard.taskId,
        taskCardId: taskCard.taskCardId,
        roomId: taskCard.roomId,
        createdAt: "2026-03-19T10:03:00.000Z",
      },
    ],
  });
}

function renderTaskCards(
  taskCards: HallTaskCardViewModel[],
  selectedTaskCardId: string | undefined,
  language: UiLanguage,
): string {
  if (taskCards.length === 0) {
    return `<div class="hall-empty hall-empty--sidebar"><strong>${escapeHtml(pickUiText(language, "No threads yet", "还没有线程"))}</strong><span>${escapeHtml(pickUiText(language, "Post the first task in the hall and it will appear here like a chat thread.", "先在大厅里发出第一个任务，它会像群聊线程一样出现在这里。"))}</span></div>`;
  }
  return taskCards
    .map((item) => {
      const selected = item.card.taskCardId === selectedTaskCardId;
      const preview = item.summary?.headline ?? item.card.latestSummary ?? item.card.description ?? "";
      const updatedLabel = formatCompactTimestamp(item.card.updatedAt, language);
      return `
        <button
          type="button"
          class="hall-task-card${selected ? " is-selected" : ""}"
          data-task-card-id="${escapeHtml(item.card.taskCardId)}"
          data-project-id="${escapeHtml(item.card.projectId)}"
          data-task-id="${escapeHtml(item.card.taskId)}"
          ${selected ? 'aria-current="page"' : ""}
        >
          <div class="hall-task-card-row">
            ${renderHallPixelAvatar(item.card.title || item.card.taskId, "hall-task-card-avatar")}
            <div class="hall-task-card-copy">
              <div class="hall-task-title-row">
                <strong class="hall-task-title">${escapeHtml(item.card.title)}</strong>
                <span class="hall-task-timestamp">${escapeHtml(updatedLabel)}</span>
              </div>
              <div class="hall-task-preview">${escapeHtml(preview)}</div>
            </div>
          </div>
        </button>
      `;
    })
    .join("");
}

function renderHallMessages(messages: HallMessage[], language: UiLanguage): string {
  if (messages.length === 0) {
    return `<div class="hall-empty hall-empty--chat">
      <div class="hall-empty-hero">${renderHallPixelAvatar("Collaboration Hall", "hall-empty-avatar")}</div>
      <strong>${escapeHtml(pickUiText(language, "The hall is quiet", "大厅现在很安静"))}</strong>
      <span>${escapeHtml(pickUiText(language, "Start with one task, or @ a real agent by name. Discussion, execution, and review will all show up here.", "从一个任务开始，或者直接 @ 一个真实 agent。讨论、执行和审核都会继续写回这里。"))}</span>
      <div class="hall-empty-actions">
        <button type="button" class="hall-empty-action" onclick="return window.__openclawHallSetComposerValue ? window.__openclawHallSetComposerValue('请帮我拆一下这个任务，先讨论方案，再指定执行者。') : false">${escapeHtml(pickUiText(language, "Draft a first task", "起草第一个任务"))}</button>
        <button type="button" class="hall-empty-action" onclick="return window.__openclawHallSetComposerValue ? window.__openclawHallSetComposerValue('请先评估实现路径。') : false">${escapeHtml(pickUiText(language, "Ask for an implementation take", "先评估实现路径"))}</button>
        <button type="button" class="hall-empty-action" onclick="return window.__openclawHallSetComposerValue ? window.__openclawHallSetComposerValue('请先收口并指定执行者。') : false">${escapeHtml(pickUiText(language, "Ask for a close and owner", "先收口并指定执行者"))}</button>
      </div>
    </div>`;
  }
  const hiddenStatusMessages = new Set([
    "execution_order_updated",
    "execution_order_cleared",
    "execution_ready_for_review",
    "review_in_progress",
    "execution_started",
    "handoff_recorded",
    "execution_update",
    "runtime_execution_update",
    "runtime_handoff_update",
  ]);
  const shouldHideStatusMessage = (message: HallMessage): boolean => {
    const status = String(message.payload?.status || "");
    if (message.kind === "system" && hiddenStatusMessages.has(status)) return true;
    if (message.kind !== "system") return false;
    const content = String(message.content || "").trim();
    if (!content) return false;
    return /Execution order updated:/i.test(content) ||
      /顺序已更新/.test(content) ||
      /Handoff moved to .*planned next owner/i.test(content) ||
      /Manager handed the room to Reviewer\./i.test(content) ||
      /现在请老板评审/.test(content) ||
      /推进到可评审状态/.test(content) ||
      /已经可评审了/.test(content);
  };
  const comparableMessageText = (content: string | undefined): string => String(content || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/(^|[\s(>\[\{<,.;:!?"'\u201c\u201d\u2018\u2019，。！？；：、）】」』》])@([A-Za-z0-9_\-\u4e00-\u9fff]+)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const messagesSubstantiallyOverlap = (left: string, right: string): boolean => {
    if (!left || !right) return false;
    const shorter = left.length <= right.length ? left : right;
    const longer = left.length <= right.length ? right : left;
    if (shorter.length >= 24 && longer.includes(shorter)) return true;
    const prefixLength = Math.min(96, left.length, right.length);
    return prefixLength >= 24 && left.slice(0, prefixLength) === right.slice(0, prefixLength);
  };
  const shouldHideSupersededOwnerStatus = (
    message: HallMessage,
    index: number,
    items: HallMessage[],
  ): boolean => {
    if (message.kind !== "status") return false;
    if (!message.authorParticipantId || message.authorParticipantId === "operator" || message.authorParticipantId === "system") return false;
    const messageCreatedAt = Date.parse(message.createdAt || "") || 0;
    if (!messageCreatedAt) return false;
    const comparable = comparableMessageText(message.content);
    if (comparable.length < 24) return false;
    return items.some((candidate, candidateIndex) => {
      if (candidateIndex === index || candidate.kind !== "handoff") return false;
      if (candidate.authorParticipantId !== message.authorParticipantId) return false;
      if ((candidate.taskCardId || "") !== (message.taskCardId || "")) return false;
      const candidateCreatedAt = Date.parse(candidate.createdAt || "") || 0;
      if (!candidateCreatedAt || Math.abs(candidateCreatedAt - messageCreatedAt) > 45_000) return false;
      return messagesSubstantiallyOverlap(comparable, comparableMessageText(candidate.content));
    });
  };
  return messages
    .filter((message) => !shouldHideStatusMessage(message))
    .filter((message, index, items) => !shouldHideSupersededOwnerStatus(message, index, items))
    .map((message) => {
      const authorType = message.authorParticipantId === "operator"
        ? "operator"
        : message.kind === "system"
          ? "system"
          : "agent";
      const chips: string[] = [];
      if (message.payload?.artifactRefs?.length) {
        chips.push(renderArtifactChips(message.payload.artifactRefs, message.payload.fileAttachments));
      }
      let toolStripHtml = "";
      if (message.payload?.toolCalls?.length) {
        const grouped = new Map<string, { toolName: string; toolStatus: string; count: number }>();
        for (const tc of message.payload.toolCalls) {
          const key = `${tc.toolName}:${tc.toolStatus}`;
          const existing = grouped.get(key);
          if (existing) existing.count += 1;
          else grouped.set(key, { toolName: tc.toolName, toolStatus: tc.toolStatus, count: 1 });
        }
        const pills = Array.from(grouped.values()).map((tc) => {
          const statusClass = tc.toolStatus === "completed" ? "is-completed" : tc.toolStatus === "error" ? "is-error" : "is-running";
          const icon = tc.toolStatus === "completed" ? "\u2713" : tc.toolStatus === "error" ? "\u2717" : "\u2699";
          const label = tc.count > 1 ? `${tc.toolName} \u00d7${tc.count}` : tc.toolName;
          return `<span class="hall-tool-pill ${statusClass}">${icon} ${escapeHtml(label)}</span>`;
        });
        toolStripHtml = `<div class="hall-tool-strip">${pills.join("")}</div>`;
      }
      return `
        <article class="hall-message" data-kind="${escapeHtml(message.kind)}" data-author-type="${escapeHtml(authorType)}">
          <div class="hall-message-row">
            ${renderHallPixelAvatar(message.authorLabel, "hall-message-avatar")}
            <div class="hall-message-bubble">
              <div class="hall-message-head">
                <div class="hall-message-author">
                  <strong>${escapeHtml(message.authorLabel)}</strong>
                  <span class="hall-kind-pill">${escapeHtml(messageKindLabel(message.kind, language))}</span>
                </div>
                <div class="hall-message-meta">${escapeHtml(message.createdAt)}</div>
              </div>
              <div class="hall-message-body">${renderMarkdown(message.content)}</div>
              ${toolStripHtml}
              ${chips.length > 0 ? `<div class="hall-message-footer">${chips.join("")}</div>` : ""}
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

function hasLockedHallExecution(taskCard: HallTaskCard | undefined): boolean {
  if (!taskCard) return false;
  return taskCard.stage === "execution" || taskCard.stage === "blocked";
}

function firstPlannedHallOwnerId(taskCard: HallTaskCard | undefined): string | undefined {
  if (!taskCard) return undefined;
  return taskCard.plannedExecutionOrder?.[0] || taskCard.plannedExecutionItems?.[0]?.participantId;
}

function firstPlannedHallExecutionItem(taskCard: HallTaskCard | undefined) {
  const participantId = firstPlannedHallOwnerId(taskCard);
  if (!participantId || !taskCard) return undefined;
  return taskCard.plannedExecutionItems.find((item) => item.participantId === participantId);
}

function hasPendingHallStartablePlan(taskCard: HallTaskCard | undefined): boolean {
  return Boolean(taskCard) && !hasLockedHallExecution(taskCard) && Boolean(firstPlannedHallOwnerId(taskCard));
}

function describeHallDecisionCardState(
  taskCard: HallTaskCard,
  participants: HallParticipant[],
  language: UiLanguage,
): {
  hasPendingStartablePlan: boolean;
  stageText: string;
  ownerHeading: string;
  ownerLabel: string;
  stepHeading: string;
  stepText: string;
} {
  const participantMap = new Map(participants.map((participant) => [participant.participantId, participant.displayName]));
  const participantLabel = (participantId: string): string => participantMap.get(participantId) || participantId;
  const hasPendingStartablePlan = hasPendingHallStartablePlan(taskCard);
  if (hasPendingStartablePlan) {
    return {
      hasPendingStartablePlan,
      stageText: pickUiText(language, "Ready to start", "待开始"),
      ownerHeading: pickUiText(language, "Suggested first owner", "建议第一位执行者"),
      ownerLabel: participantLabel(firstPlannedHallOwnerId(taskCard) || ""),
      stepHeading: pickUiText(language, "Suggested first step", "建议第一步"),
      stepText: String(firstPlannedHallExecutionItem(taskCard)?.task || "").trim(),
    };
  }
  const currentOwnerId = String(taskCard.currentOwnerParticipantId || "").trim();
  return {
    hasPendingStartablePlan,
    stageText: stageLabel(taskCard.stage, language),
    ownerHeading: pickUiText(language, "Current owner", "当前 OWNER"),
    ownerLabel: taskCard.currentOwnerLabel || (currentOwnerId ? participantLabel(currentOwnerId) : ""),
    stepHeading: pickUiText(language, "Current step", "当前步骤"),
    stepText: String(taskCard.currentExecutionItem?.task || "").trim(),
  };
}

function renderServerParallelGroupsSection(
  taskCard: HallTaskCard,
  participantMap: Map<string, string>,
  language: UiLanguage,
): string {
  const groups = taskCard.parallelGroups;
  if (!groups || groups.length === 0) return "";
  const activeGroups = groups.filter((g) =>
    g.status === "active" || (g.status === "settled" && g.settledAt && Date.now() - Date.parse(g.settledAt) < 5 * 60 * 1000),
  );
  if (activeGroups.length === 0) return "";

  const statusBadge = (status: string): string => {
    const colorMap: Record<string, string> = { pending: "#9ca3af", running: "#3b82f6", completed: "#22c55e", failed: "#ef4444" };
    const labelMap: Record<string, string> = {
      pending: pickUiText(language, "Pending", "等待中"),
      running: pickUiText(language, "Running", "执行中"),
      completed: pickUiText(language, "Done", "已完成"),
      failed: pickUiText(language, "Failed", "失败"),
    };
    const color = colorMap[status] ?? "#9ca3af";
    return `<span style="display:inline-block;padding:1px 7px;border-radius:8px;font-size:11px;font-weight:500;border:1px solid ${color};color:${color};">${escapeHtml(labelMap[status] ?? status)}</span>`;
  };

  const slotRows = activeGroups
    .flatMap((g) => g.slots)
    .map((slot) => {
      const name = participantMap.get(slot.participantId) ?? slot.participantId;
      const taskText = slot.task.length > 80 ? `${slot.task.slice(0, 80)}…` : slot.task;
      return `<div class="hall-detail-meta" style="margin-top:4px;">${statusBadge(slot.status)} <strong>${escapeHtml(name)}</strong>: ${escapeHtml(taskText)}</div>`;
    })
    .join("");

  const totalSlots = activeGroups.reduce((sum, g) => sum + g.slots.length, 0);
  const completedSlots = activeGroups.reduce(
    (sum, g) => sum + g.slots.filter((s) => s.status === "completed" || s.status === "failed").length,
    0,
  );

  return `
    <div class="hall-detail-group">
      <h4>${escapeHtml(pickUiText(language, "Parallel Dispatch", "并行调度"))} (${completedSlots}/${totalSlots})</h4>
      ${slotRows}
    </div>
  `;
}

function renderHallDetail(
  selectedTaskCard: HallTaskCard | undefined,
  selectedTaskSummary: HallTaskSummary | undefined,
  selectedTask: ProjectTask | undefined,
  participants: HallParticipant[],
  language: UiLanguage,
): string {
  if (!selectedTaskCard) {
    return `<div class="hall-empty">${escapeHtml(pickUiText(language, "Select a task card to inspect ownership, decision, and evidence.", "选中一张任务卡后，这里会显示 owner、决策和证据信息。"))}</div>`;
  }
  const participantMap = new Map(participants.map((p) => [p.participantId, p.displayName]));
  const participantNames = participants.map((p) => p.displayName).join(" \u00b7 ");
  const taskArtifacts = selectedTask?.artifacts ?? [];
  const t = (en: string, zh: string) => pickUiText(language, en, zh);
  return [
    '<div class="hall-detail-list">',
    '<div class="hall-detail-group">',
    "<h4>" + escapeHtml(selectedTaskCard.title || t("Thread", "\u7ebf\u7a0b")) + "</h4>",
    '<div class="hall-detail-meta">' + escapeHtml(selectedTaskCard.description || "-") + "</div>",
    "</div>",
    renderServerParallelGroupsSection(selectedTaskCard, participantMap, language),
    '<div class="hall-detail-group">',
    "<h4>" + escapeHtml(t("Artifacts", "\u4ea7\u7269")) + "</h4>",
    taskArtifacts.length > 0
      ? '<div class="hall-artifact-list">' + renderArtifactChips(taskArtifacts) + "</div>"
      : '<div class="hall-detail-meta">' + escapeHtml(t("No artifacts yet.", "\u8fd8\u6ca1\u6709\u4ea7\u7269\u3002")) + "</div>",
    "</div>",
    '<div class="hall-detail-group">',
    '<div class="hall-detail-group">',
    "<h4>" + escapeHtml(t("Workspace Files", "\u5de5\u4f5c\u533a\u6587\u4ef6")) + "</h4>",
    '<div class="hall-workspace-files" data-hall-workspace-files>',
    '<div class="hall-detail-meta">' + escapeHtml(t("Select a thread to view workspace files.", "\u9009\u4e2d\u7ebf\u7a0b\u540e\u67e5\u770b\u5de5\u4f5c\u533a\u6587\u4ef6\u3002")) + "</div>",
    "</div>",
    "</div>",
    "<h4>" + escapeHtml(t("Participants", "\u53c2\u4e0e\u8005")) + "</h4>",
    '<div class="hall-detail-meta">' + escapeHtml(participantNames) + "</div>",
    "</div>",
    "</div>",
  ].join("\n    ");
}

function renderInitialDecisionPanel(
  _selectedTaskCard: HallTaskCard | undefined,
  _selectedTask: ProjectTask | undefined,
  _participants: HallParticipant[],
  _language: UiLanguage,
): string {
  // Decision panel removed — group chat model has no workflow stages
  return "";
}

function renderMentionChips(participants: HallParticipant[], language: UiLanguage): string {
  return participants
    .map((participant) => `
      <button type="button" class="hall-mention-chip" data-hall-mention="${escapeHtml(participant.displayName)}" onclick="return window.__openclawHallInsertMention ? window.__openclawHallInsertMention(this.getAttribute('data-hall-mention') || '') : true">
        ${renderHallPixelAvatar(participant.displayName, "hall-mention-avatar")}
        <span class="hall-mention-copy">
          <strong>@${escapeHtml(participant.displayName)}</strong>
        </span>
      </button>
    `)
    .join("");
}

function renderParticipantMiniList(participants: HallParticipant[], language: UiLanguage): string {
  return participants
    .slice(0, 8)
    .map((participant) => `
      <button type="button" class="hall-member-pill" title="${escapeHtml(`${participant.displayName} · ${roleLabel(participant.semanticRole, language)}`)}" aria-label="${escapeHtml(`${participant.displayName} · ${roleLabel(participant.semanticRole, language)}`)}" data-hall-mention="${escapeHtml(participant.displayName)}" onclick="return window.__openclawHallInsertMention ? window.__openclawHallInsertMention(this.getAttribute('data-hall-mention') || '') : true">
        ${renderHallPixelAvatar(participant.displayName, "hall-member-avatar")}
      </button>
    `)
    .join("");
}

function renderParticipantRoster(participants: HallParticipant[], language: UiLanguage): string {
  return participants
    .map((participant) => `
      <div class="hall-roster-item">
        ${renderHallPixelAvatar(participant.displayName, "hall-roster-avatar")}
        <span class="hall-roster-copy">
          <strong>${escapeHtml(participant.displayName)}</strong>
          <span>${escapeHtml(roleLabel(participant.semanticRole, language))}</span>
        </span>
      </div>
    `)
    .join("");
}


function stageLabel(stage: HallTaskCard["stage"], language: UiLanguage): string {
  if (stage === "discussion") return pickUiText(language, "Discussion", "讨论中");
  if (stage === "execution") return pickUiText(language, "Execution", "执行中");
  if (stage === "review") return pickUiText(language, "Review", "审核中");
  if (stage === "blocked") return pickUiText(language, "Blocked", "卡住");
  return pickUiText(language, "Completed", "已完成");
}

function messageKindLabel(kind: HallMessage["kind"], language: UiLanguage): string {
  if (kind === "task") return pickUiText(language, "Task", "任务");
  if (kind === "proposal") return pickUiText(language, "Proposal", "方案");
  if (kind === "decision") return pickUiText(language, "Decision", "决策");
  if (kind === "handoff") return pickUiText(language, "Handoff", "交接");
  if (kind === "status") return pickUiText(language, "Status", "状态");
  if (kind === "review") return pickUiText(language, "Review", "审核");
  if (kind === "result") return pickUiText(language, "Result", "结果");
  if (kind === "system") return pickUiText(language, "System", "系统");
  return pickUiText(language, "Chat", "对话");
}

function roleLabel(role: HallParticipant["semanticRole"], language: UiLanguage): string {
  if (role === "manager") return pickUiText(language, "Agent Manager", "智能体管理者");
  if (role === "observer") return pickUiText(language, "Observer & Manager", "观察者与管理者");
  return pickUiText(language, "Executor", "执行者");
}

function pickUiText(language: UiLanguage, en: string, zh: string): string {
  return language === "zh" ? zh : en;
}

function hallHeadlineText(headline: string | null | undefined, language: UiLanguage, hasSelectedTask = false): string {
  if (hasSelectedTask) {
    return pickUiText(language, "Stay in one thread to discuss, assign, hand off, and review.", "围绕同一条线程讨论、分工、交接和评审。");
  }
  const normalized = String(headline || "").trim();
  if (!normalized || normalized === "The hall is ready for the next request.") {
    return pickUiText(language, "Start a task or @ a real agent to begin.", "从一个任务开始，或者直接 @ 一个真实 agent。");
  }
  return pickUiText(language, "Start a task or @ a real agent to begin.", "从一个任务开始，或者直接 @ 一个真实 agent。");
}

function initialsForName(value: string): string {
  const tokens = value
    .trim()
    .split(/[\s\-_]+/)
    .filter(Boolean);
  if (tokens.length === 0) return "?";
  if (tokens.length === 1) return tokens[0].slice(0, 2).toUpperCase();
  return `${tokens[0][0] ?? ""}${tokens[1][0] ?? ""}`.toUpperCase();
}

function renderHallPixelAvatar(label: string, className: string): string {
  const identity = resolveHallAvatarIdentity(label);
  if (identity.customImage) {
    return `<div class="${escapeHtml(className)} hall-agent-avatar" style="--agent-accent:${escapeHtml(identity.accent)};" data-animal="${escapeHtml(identity.animal)}" aria-hidden="true"><div class="agent-stage"><img class="agent-avatar-img" src="/avatars/${escapeHtml(identity.customImage)}" alt="" loading="lazy" /></div></div>`;
  }
  return `<div class="${escapeHtml(className)} hall-agent-avatar" style="--agent-accent:${escapeHtml(identity.accent)};" data-animal="${escapeHtml(identity.animal)}" aria-hidden="true"><div class="agent-stage"><canvas class="agent-pixel-canvas" width="128" height="128"></canvas></div></div>`;
}

function resolveHallAvatarIdentity(input: string): { animal: string; accent: string; asset: string; customImage?: string } {
  const normalized = input.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
  for (const entry of HALL_AVATAR_CATALOG) {
    if (entry.keywords.some((keyword) => normalized.includes(keyword))) {
      return { animal: entry.animal, accent: entry.accent, asset: entry.asset, customImage: "customImage" in entry ? entry.customImage : undefined };
    }
  }
  const fallback = HALL_AVATAR_CATALOG[Math.abs(stableHallHash(normalized || "default")) % HALL_AVATAR_CATALOG.length];
  return { animal: fallback.animal, accent: fallback.accent, asset: fallback.asset, customImage: "customImage" in fallback ? fallback.customImage : undefined };
}

function stableHallHash(input: string): number {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 33 + input.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function formatCompactTimestamp(value: string | undefined, language: UiLanguage): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString(language === "zh" ? "zh-CN" : "en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return date.toLocaleDateString(language === "zh" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
  });
}

function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/<\/script/gi, "<\\/script");
}

function renderMarkdown(value: string): string {
  const source = decodeLegacyHtmlEntities(String(value || ""))
    .replace(/<hall-structured>[\s\S]*?<\/hall-structured>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!source) return "";
  const codeBlocks: string[] = [];
  const inlineBlocks: string[] = [];
  const inlinePlaceholderPattern = /@@INLINEBLOCK(\d+)@@/g;
  const isRenderableImageUrl = (url: string): boolean => /^https?:\/\/[^\s<)]+?\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#][^\s<)]*)?$/i.test(url);
  const storeInlineBlock = (html: string): string => {
    const index = inlineBlocks.length;
    inlineBlocks.push(html);
    return `@@INLINEBLOCK${index}@@`;
  };
  const renderInlineImage = (url: string, alt: string): string => {
    const safeUrl = escapeHtml(url);
    const safeAlt = escapeHtml(alt || "");
    return `<a class="hall-md-image" href="${safeUrl}" target="_blank" rel="noreferrer"><img class="hall-md-img" src="${safeUrl}" alt="${safeAlt}" loading="lazy" /></a>`;
  };
  let text = escapeHtml(source).replace(/```([\w-]*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const index = codeBlocks.length;
    const safeLang = escapeHtml(lang || "");
    codeBlocks.push(`<pre class="hall-md-pre"><code${safeLang ? ` data-lang="${safeLang}"` : ""}>${String(code || "").replace(/\n+$/, "")}</code></pre>`);
    return `@@CODEBLOCK${index}@@`;
  });
  const lines = text.split("\n");
  const parts: string[] = [];
  let paragraph: string[] = [];
  let listType = "";
  let listItems: string[] = [];
  let quoteLines: string[] = [];
  const headingPattern = /^(#{1,6})\s+(.+)$/;
  const renderInline = (input: string): string => {
    let html = input;
    html = html.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (match, alt, url) => (
      isRenderableImageUrl(url) ? storeInlineBlock(renderInlineImage(url, alt)) : match
    ));
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => (
      storeInlineBlock(`<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`)
    ));
    html = html.replace(/(^|[\s(>])((https?:\/\/[^\s<)]+))/g, (match, prefix, url) => (
      isRenderableImageUrl(url) ? `${prefix}${storeInlineBlock(renderInlineImage(url, ""))}` : match
    ));
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, "$1<em>$2</em>");
    html = html.replace(/(^|[\s(>\[\{<,.;:!?"'\u201c\u201d\u2018\u2019，。！？；：、）】」』》])@([A-Za-z0-9_\-\u4e00-\u9fff]+)/g, '$1<span class="hall-md-mention">@$2</span>');
    html = html.replace(/(<br>)@([A-Za-z0-9_\-\u4e00-\u9fff]+)/g, '$1<span class="hall-md-mention">@$2</span>');
    html = html.replace(inlinePlaceholderPattern, (_match, index) => inlineBlocks[Number(index)] || "");
    return html;
  };
  const flushParagraph = () => {
    if (!paragraph.length) return;
    parts.push(`<p>${renderInline(paragraph.join("<br>"))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!listItems.length || !listType) return;
    parts.push(`<${listType}>${listItems.map((item) => `<li>${renderInline(item)}</li>`).join("")}</${listType}>`);
    listItems = [];
    listType = "";
  };
  const flushQuote = () => {
    if (!quoteLines.length) return;
    parts.push(`<blockquote>${renderInline(quoteLines.join("<br>"))}</blockquote>`);
    quoteLines = [];
  };
  const flushHeading = (level: number, content: string) => {
    parts.push(`<h${level}>${renderInline(content)}</h${level}>`);
  };
  const splitTableRow = (row: string): string[] =>
    row.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const tablePipeLine = (value: string | undefined): string | null => {
    if (value === undefined) return null;
    const t = value.trim();
    if (t.length < 2 || t.charAt(0) !== "|" || t.charAt(t.length - 1) !== "|") return null;
    return t;
  };
  const tableSeparatorCellPattern = /^:?-+:?$/;
  const tryParseTable = (
    sourceLines: string[],
    startIndex: number,
  ): { html: string; consumed: number } | null => {
    const headerTrim = tablePipeLine(sourceLines[startIndex]);
    if (!headerTrim) return null;
    const sepTrim = tablePipeLine(sourceLines[startIndex + 1]);
    if (!sepTrim) return null;
    const sepCells = splitTableRow(sepTrim);
    if (sepCells.length === 0 || !sepCells.every((c) => tableSeparatorCellPattern.test(c))) return null;
    const headerCells = splitTableRow(headerTrim);
    if (headerCells.length !== sepCells.length) return null;
    const aligns = sepCells.map((c) => {
      const left = c.startsWith(":");
      const right = c.endsWith(":");
      if (left && right) return "center";
      if (right) return "right";
      if (left) return "left";
      return "";
    });
    const bodyRows: string[][] = [];
    let cursor = startIndex + 2;
    while (cursor < sourceLines.length) {
      const rowTrim = tablePipeLine(sourceLines[cursor]);
      if (!rowTrim) break;
      bodyRows.push(splitTableRow(rowTrim));
      cursor++;
    }
    const colCount = headerCells.length;
    const cellHtml = (text: string, align: string, isHeader: boolean): string => {
      const tag = isHeader ? "th" : "td";
      const styleAttr = align ? ` style="text-align:${align}"` : "";
      return `<${tag}${styleAttr}>${renderInline(text)}</${tag}>`;
    };
    const headHtml = `<thead><tr>${headerCells
      .map((c, idx) => cellHtml(c, aligns[idx] || "", true))
      .join("")}</tr></thead>`;
    let bodyHtml = "";
    if (bodyRows.length > 0) {
      bodyHtml = `<tbody>${bodyRows
        .map((row) => {
          const padded: string[] = [];
          for (let k = 0; k < colCount; k++) padded.push(row[k] ?? "");
          return `<tr>${padded.map((c, idx) => cellHtml(c, aligns[idx] || "", false)).join("")}</tr>`;
        })
        .join("")}</tbody>`;
    }
    return {
      html: `<table class="hall-md-table">${headHtml}${bodyHtml}</table>`,
      consumed: cursor - startIndex,
    };
  };
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const trimmed = line.trim();
    const ul = trimmed.match(/^[-*]\s+(.+)$/);
    const ol = trimmed.match(/^\d+\.\s+(.+)$/);
    const quote = trimmed.match(/^>\s?(.+)$/);
    const heading = trimmed.match(headingPattern);
    if (!trimmed) {
      flushParagraph();
      flushList();
      flushQuote();
      continue;
    }
    if (quote) {
      flushParagraph();
      flushList();
      quoteLines.push(quote[1]);
      continue;
    }
    if (heading) {
      flushParagraph();
      flushList();
      flushQuote();
      flushHeading(Math.min(heading[1].length, 6), heading[2]);
      continue;
    }
    const table = tryParseTable(lines, lineIdx);
    if (table) {
      flushParagraph();
      flushList();
      flushQuote();
      parts.push(table.html);
      lineIdx += table.consumed - 1;
      continue;
    }
    flushQuote();
    if (ul) {
      flushParagraph();
      if (listType && listType !== "ul") flushList();
      listType = "ul";
      listItems.push(ul[1]);
      continue;
    }
    if (ol) {
      flushParagraph();
      if (listType && listType !== "ol") flushList();
      listType = "ol";
      listItems.push(ol[1]);
      continue;
    }
    flushList();
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushList();
  flushQuote();
  let html = parts.join("");
  html = html.replace(/@@CODEBLOCK(\d+)@@/g, (_match, index) => codeBlocks[Number(index)] || "");
  html = html.replace(inlinePlaceholderPattern, (_match, index) => inlineBlocks[Number(index)] || "");
  html = html.replace(/\[\[tool:([^\]|]+)(?:\|([^\]]*))?\]]/g, (_match, name, detail) => {
    const tooltip = detail ? ` title="${escapeHtml(detail)}"` : "";
    return `<span class="hall-tool-pill is-completed"${tooltip}>\u2713 ${escapeHtml(name)}</span>`;
  });
  return html;
}

function renderArtifactChips(artifactRefs: TaskArtifact[] | undefined, fileAttachments?: HallFileAttachment[]): string {
  if (!artifactRefs || artifactRefs.length === 0) return "";
  const fileMap = new Map<string, HallFileAttachment>();
  if (fileAttachments) {
    for (const f of fileAttachments) {
      if (f?.fileId) fileMap.set(f.fileId, f);
    }
  }
  return artifactRefs
    .filter((artifact) => artifact?.location)
    .map((artifact) => {
      const label = escapeHtml((artifact.label || artifact.location || "").trim());
      const href = escapeHtml((artifact.location || "").trim());
      const kind = escapeHtml((artifact.type || "other").trim());
      const fileMeta = artifact.artifactId ? fileMap.get(artifact.artifactId) : undefined;
      if (fileMeta && fileMeta.mimeType?.startsWith("image/")) {
        return `<a class="hall-file-preview" href="${href}" target="_blank" rel="noreferrer"><img class="hall-file-img" src="${href}" alt="${label}" loading="lazy" /></a>`;
      }
      return `<a class="hall-artifact-chip" href="${href}" target="_blank" rel="noreferrer"><span class="hall-artifact-chip-kind">${kind}</span><span class="hall-artifact-chip-label">${label}</span></a>`;
    })
    .join("");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function decodeLegacyHtmlEntities(value: string): string {
  let normalized = value;
  for (let pass = 0; pass < 2; pass += 1) {
    const decoded = normalized
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"")
      .replace(/&#39;/g, "'");
    if (decoded === normalized) break;
    normalized = decoded;
  }
  return normalized;
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderCollaborationHall, renderCollaborationHallClientScript, renderCollaborationHallForSmoke } from "../src/ui/collaboration-hall";

test("collaboration hall renders a three-pane hall-first shell", () => {
  const html = renderCollaborationHallForSmoke("en");
  assert(html.includes('id="collaboration-hall"'));
  assert(html.includes("Collaboration Hall"));
  assert(html.includes('data-collaboration-hall-root'));
  assert(html.includes('data-hall-member-strip'));
  assert(html.includes('data-hall-toolbar-note'));
  assert(html.includes('data-hall-task-list'));
  assert(html.includes('data-hall-thread'));
  assert(html.includes('data-hall-decision-panel'));
  assert(html.includes('data-hall-typing-strip'));
  assert(html.includes('data-hall-detail'));
  assert(html.includes('data-hall-compose'));
  assert(html.includes('data-hall-headline'));
  assert(html.includes('data-hall-compose-task'));
  assert(html.match(/data-hall-toggle-context/g)?.length >= 2);
  assert(html.includes('/avatars/'));
  assert(html.includes('hall-empty-actions'));
  assert(html.includes('hall-thread-subtitle'));
  const script = renderCollaborationHallClientScript("en");
  const zhScript = renderCollaborationHallClientScript("zh");
  assert(script.includes("new EventSource('/api/hall/events"));
  assert(script.includes("draft_start"));
  assert(script.includes("draft_delta"));
  assert(script.includes("renderTypingStrip"));
  assert(script.includes("renderMemberStrip"));
  assert(script.includes("renderToolbarMetaNote"));
  assert(script.includes("participantPresence"));
  assert(script.includes("hall-typing-dots"));
  assert(script.includes("window.__openclawHallSetExecutionOrder"));
  assert(script.includes("is-planning-order"));
  assert(script.includes("Start execution"));
  assert(zhScript.includes("开始执行（"));
  assert(zhScript.includes("顺序排好后"));
  assert(!zhScript.includes("更换当前执行者"));
  assert(!html.includes('data-hall-assign'));
  assert(!script.includes("data-hall-assign"));
  assert(html.includes("is-planning-order .hall-pane--thread"));
  assert(html.includes("is-planning-order .hall-composer-shell"));
  assert(html.includes("is-planning-order .hall-thread"));
  assert(html.includes("is-planning-order .hall-decision-card--planner"));
  assert(html.includes("hall-decision-card--planner.is-empty"));
  assert(html.includes("hall-order-planner--empty"));
  assert(script.includes("syncSelectedTaskRefs"));
  assert(script.includes("taskCardId: selectedTaskCardId"));
  assert(script.includes("params.set('taskCardId', selectedTaskCardId)"));
  assert(script.includes("document.body?.dataset?.tokenRequired"));
  assert(script.includes("window.__openclawHallHandleComposerKeydown"));
  assert(script.includes("window.__openclawHallHandleComposerKeyup"));
  assert(script.includes("window.__openclawHallInsertMention"));
  assert(script.includes("window.__openclawHallSetComposerValue"));
  assert(script.includes("window.__openclawHallSendReply"));
  assert(script.includes("markdownImagePattern"));
  assert(script.includes("hall-md-image"));
  assert(html.includes("hall-md-img"));
  assert(script.includes("const hasDiscussionOutcome = Boolean("));
  assert(script.includes("|| hasDiscussionOutcome"));
  assert(script.includes("compositionstart"));
  assert(script.includes("pendingComposerSubmitAfterComposition"));
  assert(script.includes("compositionend"));
  assert(script.includes("if (!pendingComposerSubmitAfterComposition) return;"));
  assert(script.includes("sanitizeDraftVisibleText"));
  assert(script.includes("const visibleTypingDrafts = () => visibleDrafts().filter((draft) => !draft.settledAt);"));
  assert(script.includes("const syntheticExecutionHandoffDraft = (taskCard, persistedThreadMessages) => {"));
  assert(script.includes("executionLock"));
  assert(script.includes("const latestHandoff = [...persistedThreadMessages].reverse().find((message) => {"));
  assert(script.includes("targetIds.includes(ownerParticipantId)"));
  assert(script.includes("draftId: 'synthetic-execution:' + taskCard.taskCardId + ':' + ownerParticipantId"));
  assert(script.includes("if (event.type === 'draft_complete' && draft) {"));
  assert(script.includes("draft.settledAt = event.createdAt || new Date().toISOString();"));
  assert(script.includes("draft.persistedMessageId = event.messageId || '';"));
  assert(script.includes("contextToggles.forEach"));
  assert(script.includes("event.key === 'Escape'"));
  assert(script.includes("const shouldRetryLocalToken = (response, payload) => {"));
  assert(script.includes("response.status !== 403"));
  assert(script.includes("/invalid local token/i.test(extractErrorMessage(payload))"));
});

test("hall chat page source wires the hall workbench into its own section", async () => {
  const source = await readFile("src/ui/server.ts", "utf8");
  assert(source.includes('"hall-chat"'));
  assert(source.includes("collaborationHallWorkbench"));
  assert(source.includes("renderCollaborationHall({"));
  assert(source.includes("renderCollaborationHallClientScript(options.language)"));
  assert(source.includes('const hallChatSection = needsHallChat ? `'));
  assert(source.includes("${collaborationHallWorkbench}"));
  assert(source.includes('if (options.section === "hall-chat") sectionBody = hallChatSection;'));
});

test("hall messages and detail panes render artifact chips", () => {
  const html = renderCollaborationHall({
    language: "zh",
    hall: {
      hallId: "main",
      title: "Collaboration Hall",
      participants: [
        { participantId: "main", agentId: "main", displayName: "Main", semanticRole: "manager", active: true, aliases: ["Main"] },
        { participantId: "otter", agentId: "otter", displayName: "Otter", semanticRole: "reviewer", active: true, aliases: ["Otter"] },
        { participantId: "pandas", agentId: "pandas", displayName: "Pandas", semanticRole: "coder", active: true, aliases: ["Pandas"] },
      ],
      taskCardIds: ["demo"],
      messageIds: ["message-1"],
      lastMessageId: "message-1",
      latestMessageAt: "2026-03-26T12:00:00.000Z",
      createdAt: "2026-03-26T12:00:00.000Z",
      updatedAt: "2026-03-26T12:00:00.000Z",
    },
    hallSummary: {
      hallId: "main",
      headline: "Artifacts should be visible in the hall.",
      activeTaskCount: 1,
      waitingReviewCount: 0,
      needsHumanReviewCount: 0,
      currentSpeakerLabel: "Main",
      updatedAt: "2026-03-26T12:00:00.000Z",
    },
    taskCards: [{
      card: {
        hallId: "main",
        taskCardId: "demo",
        projectId: "collaboration-hall",
        taskId: "demo-task",
        title: "Render artifact chips",
        description: "Show concrete outputs in the hall UI.",
        status: "todo",
        createdByParticipantId: "operator",
        currentExecutionItem: {
          itemId: "current-main",
          participantId: "main",
          task: "Lock the first script draft and post it back to the hall.",
          handoffToParticipantId: "otter",
          handoffWhen: "When the first script draft is visible in-thread.",
        },
        proposal: "Render artifact refs in the message footer and detail pane.",
        blockers: [],
        requiresInputFrom: [],
        mentionedParticipantIds: [],
        plannedExecutionOrder: ["main", "otter"],
        plannedExecutionItems: [
          {
            itemId: "current-main",
            participantId: "main",
            task: "Lock the first script draft and post it back to the hall.",
            handoffToParticipantId: "otter",
            handoffWhen: "When the first script draft is visible in-thread.",
          },
          {
            itemId: "review-otter",
            participantId: "otter",
            task: "Review the draft, flag only must-fix issues, then hand it back.",
            handoffWhen: "Only if the draft still needs one more pass.",
          },
        ],
        sessionKeys: [],
        createdAt: "2026-03-26T12:00:00.000Z",
        updatedAt: "2026-03-26T12:00:00.000Z",
      },
      task: {
        projectId: "collaboration-hall",
        taskId: "demo-task",
        title: "Render artifact chips",
        status: "todo",
        owner: "Operator",
        definitionOfDone: ["Artifact chips are visible."],
        artifacts: [
          {
            artifactId: "artifact-1",
            type: "doc",
            label: "script-v1.png",
            location: "https://example.com/script-v1.png",
          },
        ],
        rollback: { strategy: "manual", steps: [] },
        sessionKeys: [],
        budget: {},
        updatedAt: "2026-03-26T12:00:00.000Z",
      },
    }],
    messages: [{
      hallId: "main",
      messageId: "message-1",
      kind: "result",
      authorParticipantId: "main",
      authorLabel: "Main",
      authorSemanticRole: "manager",
      content: "脚本在这里。@main 继续看这个版本。",
      targetParticipantIds: [],
      mentionTargets: [],
      taskCardId: "demo",
      projectId: "collaboration-hall",
      taskId: "demo-task",
      payload: {
        artifactRefs: [
          {
            artifactId: "artifact-1",
            type: "doc",
            label: "script-v1.png",
            location: "https://example.com/script-v1.png",
          },
        ],
      },
      createdAt: "2026-03-26T12:00:00.000Z",
    }],
    selectedTaskCard: {
      hallId: "main",
      taskCardId: "demo",
      projectId: "collaboration-hall",
      taskId: "demo-task",
      title: "Render artifact chips",
      description: "Show concrete outputs in the hall UI.",
      status: "todo",
      createdByParticipantId: "operator",
      currentExecutionItem: {
        itemId: "current-main",
        participantId: "main",
        task: "Lock the first script draft and post it back to the hall.",
        handoffToParticipantId: "otter",
        handoffWhen: "When the first script draft is visible in-thread.",
      },
      proposal: "Render artifact refs in the message footer and detail pane.",
      blockers: [],
      requiresInputFrom: [],
      mentionedParticipantIds: [],
      plannedExecutionOrder: ["main", "otter"],
      plannedExecutionItems: [
        {
          itemId: "current-main",
          participantId: "main",
          task: "Lock the first script draft and post it back to the hall.",
          handoffToParticipantId: "otter",
          handoffWhen: "When the first script draft is visible in-thread.",
        },
        {
          itemId: "review-otter",
          participantId: "otter",
          task: "Review the draft, flag only must-fix issues, then hand it back.",
          handoffWhen: "Only if the draft still needs one more pass.",
        },
      ],
      sessionKeys: [],
      createdAt: "2026-03-26T12:00:00.000Z",
      updatedAt: "2026-03-26T12:00:00.000Z",
    },
    selectedTask: {
      projectId: "collaboration-hall",
      taskId: "demo-task",
      title: "Render artifact chips",
      status: "todo",
      owner: "Operator",
      definitionOfDone: ["Artifact chips are visible."],
      artifacts: [
        {
          artifactId: "artifact-1",
          type: "doc",
          label: "script-v1.png",
          location: "https://example.com/script-v1.png",
        },
      ],
      rollback: { strategy: "manual", steps: [] },
      sessionKeys: [],
      budget: {},
      updatedAt: "2026-03-26T12:00:00.000Z",
    },
  });

  assert(html.includes("hall-artifact-chip"));
  assert(html.includes("script-v1.png"));
  assert(html.includes("https://example.com/script-v1.png"));
  assert(html.includes("Lock the first script draft and post it back to the hall."));
  assert(html.includes("Review the draft, flag only must-fix issues, then hand it back."));
  assert(!html.includes("本轮职责与任务"));
  assert(!html.includes("support-only"));
});

test("hall message rendering normalizes legacy escaped arrows without double-escaping them", () => {
  const html = renderCollaborationHall({
    language: "en",
    hall: {
      hallId: "main",
      title: "Collaboration Hall",
      participants: [],
      taskCardIds: [],
      messageIds: ["msg-1"],
      lastMessageId: "msg-1",
      latestMessageAt: "2026-03-25T08:52:18.059Z",
      createdAt: "2026-03-25T08:52:18.059Z",
      updatedAt: "2026-03-25T08:52:18.059Z",
    },
    hallSummary: {
      hallId: "main",
      headline: "Legacy escaped arrows should still render as plain arrows.",
      activeTaskCount: 0,
      waitingReviewCount: 0,
      needsHumanReviewCount: 0,
      updatedAt: "2026-03-25T08:52:18.059Z",
    },
    taskCards: [],
    messages: [
      {
        hallId: "main",
        messageId: "msg-1",
        kind: "system",
        authorParticipantId: "system",
        authorLabel: "System",
        authorSemanticRole: "generalist",
        content: "Execution order updated: otter -&gt; pandas.",
        targetParticipantIds: [],
        mentionTargets: [],
        createdAt: "2026-03-25T08:52:18.059Z",
      },
    ],
  });

  assert(!html.includes("&amp;gt;"));
});

test("hall message rendering turns legacy <br> tags into visible line breaks, strips structured blocks, and highlights @mentions even after Chinese punctuation", () => {
  const html = renderCollaborationHall({
    language: "zh",
    hall: {
      hallId: "main",
      title: "Collaboration Hall",
      participants: [],
      taskCardIds: [],
      messageIds: ["msg-1"],
      lastMessageId: "msg-1",
      latestMessageAt: "2026-03-26T15:18:52.905Z",
      createdAt: "2026-03-26T15:18:52.905Z",
      updatedAt: "2026-03-26T15:18:52.905Z",
    },
    hallSummary: {
      hallId: "main",
      headline: "Render legacy line breaks and mentions like real chat text.",
      activeTaskCount: 0,
      waitingReviewCount: 0,
      needsHumanReviewCount: 0,
      updatedAt: "2026-03-26T15:18:52.905Z",
    },
    taskCards: [],
    messages: [
      {
        hallId: "main",
        messageId: "msg-1",
        kind: "proposal",
        authorParticipantId: "coq",
        authorLabel: "Coq-每日新闻",
        authorSemanticRole: "planner",
        content: "先把任务样本锁死。<br>这样 20 秒里就能自然出现 owner 和 next action。<br>。@pandas 你按这个补最小台词。<br>“@otter 你只抓一处 must-fix。”<hall-structured>{\"executor\":\"pandas\"}</hall-structured>",
        targetParticipantIds: [],
        mentionTargets: [],
        createdAt: "2026-03-26T15:18:52.905Z",
      },
    ],
  });

  assert(html.includes("<br>"));
  assert(html.includes('class="hall-md-mention">@pandas</span>'));
  assert(html.includes('class="hall-md-mention">@otter</span>'));
  assert(!html.includes("&lt;br&gt;"));
  assert(!html.includes("hall-structured"));
  assert(!html.includes('"executor":"pandas"'));
});

test("hall message rendering converts markdown pipe tables into real <table> elements with aligned cells", () => {
  const html = renderCollaborationHall({
    language: "en",
    hall: {
      hallId: "main",
      title: "Collaboration Hall",
      participants: [],
      taskCardIds: [],
      messageIds: ["msg-1"],
      lastMessageId: "msg-1",
      latestMessageAt: "2026-04-10T08:00:00.000Z",
      createdAt: "2026-04-10T08:00:00.000Z",
      updatedAt: "2026-04-10T08:00:00.000Z",
    },
    hallSummary: {
      hallId: "main",
      headline: "Markdown tables should render as real tables.",
      activeTaskCount: 0,
      waitingReviewCount: 0,
      needsHumanReviewCount: 0,
      updatedAt: "2026-04-10T08:00:00.000Z",
    },
    taskCards: [],
    messages: [
      {
        hallId: "main",
        messageId: "msg-1",
        kind: "proposal",
        authorParticipantId: "linus",
        authorLabel: "Linus",
        authorSemanticRole: "coder",
        content:
          "Here is the comparison:\n\n| Item | Owner | Status |\n|:-----|:-----:|------:|\n| Auth | linus | done |\n| API  | otter | wip  |\n\nDone.",
        targetParticipantIds: [],
        mentionTargets: [],
        createdAt: "2026-04-10T08:00:00.000Z",
      },
    ],
  });

  assert(html.includes('<table class="hall-md-table">'));
  assert(html.includes("<thead><tr>"));
  assert(html.includes("<th"));
  assert(html.includes("<tbody>"));
  assert(html.includes("<td"));
  assert(html.includes('text-align:left'));
  assert(html.includes('text-align:center'));
  assert(html.includes('text-align:right'));
  assert(html.includes(">Item</th>"));
  assert(html.includes(">Auth</td>"));
  assert(!html.includes("|------"));
  assert(!html.includes("|:-----"));
});

test("hall client script includes a markdown table parser that emits hall-md-table elements", () => {
  const script = renderCollaborationHallClientScript("en");
  assert(script.includes("tryParseTable"));
  assert(script.includes("hall-md-table"));
});

test("selected hall thread cards expose an aria-current marker for styling and smoke checks", () => {
  const html = renderCollaborationHall({
    language: "zh",
    hall: {
      hallId: "main",
      title: "Collaboration Hall",
      participants: [],
      taskCardIds: ["one", "two"],
      messageIds: [],
      createdAt: "2026-03-26T15:18:52.905Z",
      updatedAt: "2026-03-26T15:18:52.905Z",
    },
    hallSummary: {
      hallId: "main",
      headline: "Use one thread per task.",
      activeTaskCount: 2,
      waitingReviewCount: 0,
      needsHumanReviewCount: 0,
      updatedAt: "2026-03-26T15:18:52.905Z",
    },
    taskCards: [
      {
        card: {
          hallId: "main",
          taskCardId: "one",
          projectId: "p",
          taskId: "t-1",
          roomId: "room-1",
          title: "First thread",
          description: "First thread description",
          status: "todo",
          createdByParticipantId: "operator",
          blockers: [],
          requiresInputFrom: [],
          mentionedParticipantIds: [],
          sessionKeys: [],
          createdAt: "2026-03-26T15:18:52.905Z",
          updatedAt: "2026-03-26T15:18:52.905Z",
        },
      },
      {
        card: {
          hallId: "main",
          taskCardId: "two",
          projectId: "p",
          taskId: "t-2",
          roomId: "room-2",
          title: "Second thread",
          description: "Second thread description",
          status: "todo",
          createdByParticipantId: "operator",
          blockers: [],
          requiresInputFrom: [],
          mentionedParticipantIds: [],
          sessionKeys: [],
          createdAt: "2026-03-26T15:18:52.905Z",
          updatedAt: "2026-03-26T15:18:52.905Z",
        },
      },
    ],
    messages: [],
    selectedTaskCard: {
      hallId: "main",
      taskCardId: "two",
      projectId: "p",
      taskId: "t-2",
      roomId: "room-2",
      title: "Second thread",
      description: "Second thread description",
      status: "todo",
      createdByParticipantId: "operator",
      blockers: [],
      requiresInputFrom: [],
      mentionedParticipantIds: [],
      sessionKeys: [],
      createdAt: "2026-03-26T15:18:52.905Z",
      updatedAt: "2026-03-26T15:18:52.905Z",
    },
  });

  assert(html.includes('data-task-card-id="two"'));
  assert(html.includes('aria-current="page"'));
});

test("routine execution status system messages stay out of the visible hall timeline", () => {
  const html = renderCollaborationHall({
    language: "zh",
    hall: {
      hallId: "main",
      title: "Collaboration Hall",
      participants: [],
      taskCardIds: [],
      messageIds: ["msg-1", "msg-2"],
      lastMessageId: "msg-2",
      latestMessageAt: "2026-03-26T15:18:52.905Z",
      createdAt: "2026-03-26T15:18:52.905Z",
      updatedAt: "2026-03-26T15:18:52.905Z",
    },
    hallSummary: {
      hallId: "main",
      headline: "Routine system progress should stay in the card, not duplicate the chat feed.",
      activeTaskCount: 0,
      waitingReviewCount: 0,
      needsHumanReviewCount: 0,
      updatedAt: "2026-03-26T15:18:52.905Z",
    },
    taskCards: [],
    messages: [
      {
        hallId: "main",
        messageId: "msg-1",
        kind: "system",
        authorParticipantId: "system",
        authorLabel: "System",
        authorSemanticRole: "generalist",
        content: "main 接棒。先做第一步。",
        targetParticipantIds: [],
        mentionTargets: [],
        payload: { status: "execution_started" },
        createdAt: "2026-03-26T15:18:52.905Z",
      },
      {
        hallId: "main",
        messageId: "msg-2",
        kind: "proposal",
        authorParticipantId: "main",
        authorLabel: "main",
        authorSemanticRole: "manager",
        content: "先锁 30 秒开场，别再扩 scope。",
        targetParticipantIds: [],
        mentionTargets: [],
        createdAt: "2026-03-26T15:19:02.905Z",
      },
    ],
  });

  assert(!html.includes("main 接棒。先做第一步。"));
  assert(html.includes("先锁 30 秒开场，别再扩 scope。"));
});

test("legacy wrong-handoff warning system messages stay out of the visible hall timeline", () => {
  const html = renderCollaborationHall({
    language: "zh",
    hall: {
      hallId: "main",
      title: "Collaboration Hall",
      participants: [],
      taskCardIds: [],
      messageIds: ["msg-1", "msg-2"],
      lastMessageId: "msg-2",
      latestMessageAt: "2026-03-28T09:00:00.000Z",
      createdAt: "2026-03-28T09:00:00.000Z",
      updatedAt: "2026-03-28T09:00:00.000Z",
    },
    hallSummary: {
      hallId: "main",
      headline: "Hide stale wrong-handoff warnings from old threads.",
      activeTaskCount: 1,
      waitingReviewCount: 0,
      needsHumanReviewCount: 0,
      updatedAt: "2026-03-28T09:00:00.000Z",
    },
    taskCards: [],
    messages: [
      {
        hallId: "main",
        messageId: "msg-1",
        kind: "system",
        authorParticipantId: "system",
        authorLabel: "System",
        authorSemanticRole: "generalist",
        content: "Handoff moved to pandas, but the planned next owner was monkey. Review or update the execution order if needed.",
        targetParticipantIds: [],
        mentionTargets: [],
        createdAt: "2026-03-28T09:00:00.000Z",
      },
      {
        hallId: "main",
        messageId: "msg-2",
        kind: "handoff",
        authorParticipantId: "main",
        authorLabel: "main",
        authorSemanticRole: "manager",
        content: "@monkey 你接着把 3 个 thumbnail 方向贴出来。",
        targetParticipantIds: [],
        mentionTargets: [],
        payload: { status: "runtime_handoff_update" },
        createdAt: "2026-03-28T09:00:10.000Z",
      },
    ],
  });

  assert(!html.includes("Handoff moved to pandas"));
  assert(html.includes("@monkey"));
});

test("agent execution updates and handoffs stay visible even when they carry runtime status payloads", () => {
  const html = renderCollaborationHall({
    language: "zh",
    hall: {
      hallId: "main",
      title: "Collaboration Hall",
      participants: [],
      taskCardIds: [],
      messageIds: ["msg-1", "msg-2", "msg-3"],
      lastMessageId: "msg-3",
      latestMessageAt: "2026-03-26T15:20:52.905Z",
      createdAt: "2026-03-26T15:18:52.905Z",
      updatedAt: "2026-03-26T15:20:52.905Z",
    },
    hallSummary: {
      hallId: "main",
      headline: "Execution results should remain visible in the thread.",
      activeTaskCount: 1,
      waitingReviewCount: 0,
      needsHumanReviewCount: 0,
      updatedAt: "2026-03-26T15:20:52.905Z",
    },
    taskCards: [],
    messages: [
      {
        hallId: "main",
        messageId: "msg-1",
        kind: "status",
        authorParticipantId: "monkey",
        authorLabel: "monkey",
        authorSemanticRole: "builder",
        content: "第一版结果已经能成立，owner 和 next action 已经能看懂。",
        targetParticipantIds: [],
        mentionTargets: [],
        payload: { status: "runtime_execution_update" },
        createdAt: "2026-03-26T15:18:52.905Z",
      },
      {
        hallId: "main",
        messageId: "msg-2",
        kind: "handoff",
        authorParticipantId: "main",
        authorLabel: "main",
        authorSemanticRole: "manager",
        content: "@pandas 你只补最后一拍，别扩 scope。",
        targetParticipantIds: [],
        mentionTargets: [],
        payload: { status: "runtime_handoff_update" },
        createdAt: "2026-03-26T15:19:52.905Z",
      },
      {
        hallId: "main",
        messageId: "msg-3",
        kind: "system",
        authorParticipantId: "system",
        authorLabel: "System",
        authorSemanticRole: "generalist",
        content: "pandas 把这一步做到可评审了，现在请老板评审。",
        targetParticipantIds: [],
        mentionTargets: [],
        payload: { status: "execution_ready_for_review" },
        createdAt: "2026-03-26T15:20:52.905Z",
      },
    ],
  });

  assert(html.includes("第一版结果已经能成立，owner 和 next action 已经能看懂。"));
  assert(html.includes("@pandas"));
  assert(!html.includes("现在请老板评审。"));
});

test("same-author handoff keeps the polished visible version and hides the later flattened status duplicate", () => {
  const html = renderCollaborationHall({
    language: "zh",
    hall: {
      hallId: "main",
      title: "Collaboration Hall",
      participants: [],
      taskCardIds: ["card-1"],
      messageIds: ["msg-1", "msg-2"],
      lastMessageId: "msg-2",
      latestMessageAt: "2026-03-28T21:25:54.346Z",
      createdAt: "2026-03-28T21:25:30.000Z",
      updatedAt: "2026-03-28T21:25:54.346Z",
    },
    hallSummary: {
      hallId: "main",
      headline: "Keep the polished handoff visible and hide the flattened duplicate.",
      activeTaskCount: 1,
      waitingReviewCount: 0,
      needsHumanReviewCount: 0,
      updatedAt: "2026-03-28T21:25:54.346Z",
    },
    taskCards: [],
    messages: [
      {
        hallId: "main",
        messageId: "msg-1",
        taskCardId: "card-1",
        kind: "handoff",
        authorParticipantId: "coq",
        authorLabel: "Coq-每日新闻",
        authorSemanticRole: "planner",
        content: "三个开头文案先直接落这版：<br>任务被接住了：很多群聊的问题，不是没人说话，是说完以后还得你自己收尾。<br>中间协调被吃掉了：最烦的不是任务难，是你得一直自己转述上下文、分派、催下一步。<br>群聊变成闭环：讨论不会停在“大家觉得可以”，而是会收敛成 owner 和 next action。<br>@otter 你接着给这 3 个对应的 thumbnail。",
        targetParticipantIds: [],
        mentionTargets: [],
        payload: { status: "runtime_handoff_update" },
        createdAt: "2026-03-28T21:25:44.346Z",
      },
      {
        hallId: "main",
        messageId: "msg-2",
        taskCardId: "card-1",
        kind: "status",
        authorParticipantId: "coq",
        authorLabel: "Coq-每日新闻",
        authorSemanticRole: "planner",
        content: "三个开头文案先直接落这版： 任务被接住了：很多群聊的问题，不是没人说话，是说完以后还得你自己收尾。 中间协调被吃掉了：最烦的不是任务难，是你得一直自己转述上下文、分派、催下一步。 群聊变成闭环：讨论不会停在“大家觉得可以”，而是会收敛成 owner 和 next action。 @otter 你接着给这 3 个对应的 thumbnail。",
        targetParticipantIds: [],
        mentionTargets: [],
        payload: { status: "runtime_execution_update" },
        createdAt: "2026-03-28T21:25:54.346Z",
      },
    ],
  });

  assert.equal(html.match(/三个开头文案先直接落这版/g)?.length ?? 0, 1);
  assert(html.includes("交接"));
  assert(!html.includes(">状态<"));
});

test("legacy system progress copy stays hidden even when old messages are already persisted without payload status", () => {
  const html = renderCollaborationHall({
    language: "zh",
    hall: {
      hallId: "main",
      title: "Collaboration Hall",
      participants: [],
      taskCardIds: [],
      messageIds: ["msg-1", "msg-2", "msg-3"],
      lastMessageId: "msg-3",
      latestMessageAt: "2026-03-26T15:20:52.905Z",
      createdAt: "2026-03-26T15:18:52.905Z",
      updatedAt: "2026-03-26T15:20:52.905Z",
    },
    hallSummary: {
      hallId: "main",
      headline: "Hide duplicated routine system copy.",
      activeTaskCount: 0,
      waitingReviewCount: 1,
      needsHumanReviewCount: 0,
      updatedAt: "2026-03-26T15:20:52.905Z",
    },
    taskCards: [],
    messages: [
      {
        hallId: "main",
        messageId: "msg-1",
        kind: "system",
        authorParticipantId: "system",
        authorLabel: "System",
        authorSemanticRole: "generalist",
        content: "Execution order updated: main -> otter -> pandas.",
        targetParticipantIds: [],
        mentionTargets: [],
        createdAt: "2026-03-26T15:18:52.905Z",
      },
      {
        hallId: "main",
        messageId: "msg-2",
        kind: "system",
        authorParticipantId: "system",
        authorLabel: "System",
        authorSemanticRole: "generalist",
        content: "pandas 把这一步做到可评审了，现在请老板评审。",
        targetParticipantIds: [],
        mentionTargets: [],
        createdAt: "2026-03-26T15:19:52.905Z",
      },
      {
        hallId: "main",
        messageId: "msg-3",
        kind: "proposal",
        authorParticipantId: "pandas",
        authorLabel: "pandas",
        authorSemanticRole: "builder",
        content: "结果给你了，@main 只看最后一拍够不够显眼。",
        targetParticipantIds: [],
        mentionTargets: [],
        createdAt: "2026-03-26T15:20:52.905Z",
      },
    ],
  });

  assert(!html.includes("Execution order updated: main -> otter -> pandas."));
  assert(!html.includes("现在请老板评审。"));
  assert(html.includes("结果给你了"));
});

test("hall composer includes file attachment controls", () => {
  const html = renderCollaborationHallForSmoke("en");
  assert(html.includes("data-hall-attach-file"));
  assert(html.includes("data-hall-file-input"));
  assert(html.includes("data-hall-file-preview"));
  const script = renderCollaborationHallClientScript("en");
  assert(script.includes("pendingFiles"));
  assert(script.includes("readFileAsDataUrl"));
  assert(script.includes("hall-dragover"));
  assert(script.includes("renderPendingFiles"));
  assert(script.includes("/api/hall/files"));
  assert(script.includes("fileAttachments"));
});

test("hall composer includes file attachment controls (zh)", () => {
  const html = renderCollaborationHallForSmoke("zh");
  assert(html.includes("data-hall-attach-file"));
  assert(html.includes("data-hall-file-input"));
  const script = renderCollaborationHallClientScript("zh");
  assert(script.includes("pendingFiles"));
  assert(script.includes("文件过大"));
  assert(script.includes("上传失败"));
});

test("hall renders inline image preview for file attachments", () => {
  const html = renderCollaborationHall({
    language: "en",
    hall: {
      hallId: "main",
      title: "Collaboration Hall",
      participants: [],
      taskCardIds: [],
      messageIds: ["msg-file-1"],
      lastMessageId: "msg-file-1",
      latestMessageAt: "2026-04-09T10:00:00.000Z",
      createdAt: "2026-04-09T10:00:00.000Z",
      updatedAt: "2026-04-09T10:00:00.000Z",
    },
    hallSummary: {
      hallId: "main",
      headline: "File attachment test.",
      activeTaskCount: 0,
      waitingReviewCount: 0,
      needsHumanReviewCount: 0,
      currentSpeakerLabel: "",
      updatedAt: "2026-04-09T10:00:00.000Z",
    },
    taskCards: [],
    messages: [{
      hallId: "main",
      messageId: "msg-file-1",
      kind: "chat",
      authorParticipantId: "operator",
      authorLabel: "Operator",
      content: "Here is a screenshot.",
      targetParticipantIds: [],
      mentionTargets: [],
      payload: {
        artifactRefs: [
          { artifactId: "file-1", type: "file", label: "screenshot.png", location: "/hall-files/screenshot-abc.png" },
          { artifactId: "file-2", type: "file", label: "report.pdf", location: "/hall-files/report-def.pdf" },
        ],
        fileAttachments: [
          { fileId: "file-1", originalName: "screenshot.png", mimeType: "image/png", sizeBytes: 12345, storedFileName: "screenshot-abc.png" },
          { fileId: "file-2", originalName: "report.pdf", mimeType: "application/pdf", sizeBytes: 67890, storedFileName: "report-def.pdf" },
        ],
      },
      createdAt: "2026-04-09T10:00:00.000Z",
    }],
  });

  // Image should render as <img> preview
  assert(html.includes("hall-file-img"));
  assert(html.includes("hall-file-preview"));
  assert(html.includes("/hall-files/screenshot-abc.png"));
  // PDF should render as artifact chip (not img)
  assert(html.includes("report.pdf"));
  assert(html.includes("/hall-files/report-def.pdf"));
});

test("hall detail pane includes workspace files section", () => {
  const html = renderCollaborationHallForSmoke("en");
  assert(html.includes("Workspace Files"));
  assert(html.includes("data-hall-workspace-files"));
  const script = renderCollaborationHallClientScript("en");
  assert(script.includes("loadWorkspaceFiles"));
  assert(script.includes("/api/hall/workspace-files"));
  assert(script.includes("hall-workspace-file-item"));
});

test("client script handles draft_tool_update events and renders inline tool pills", () => {
  const script = renderCollaborationHallClientScript("en");
  assert(script.includes("draft_tool_update"));
  assert(script.includes("toolCalls"));
  assert(script.includes("hall-tool-pill"));
  assert(script.includes("is-completed"));
  assert(script.includes("toolName"));
  assert(script.includes("toolStatus"));
  assert(!script.includes("hall-tool-strip"));
});

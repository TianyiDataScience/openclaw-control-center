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
  assert(html.includes('data-hall-create-task'));
  assert(html.includes('data-hall-handoff'));
  assert(html.match(/data-hall-toggle-context/g)?.length >= 2);
  assert(html.includes('/avatars/'));
  assert(html.includes('hall-empty-actions'));
  assert(html.includes('hall-thread-subtitle'));
  const script = renderCollaborationHallClientScript("en");
  const zhScript = renderCollaborationHallClientScript("zh");
  assert(script.includes("new EventSource('/api/hall/events"));
  assert(script.includes("draft_start"));
  assert(script.includes("draft_delta"));
  assert(script.includes("draftTtlMs = 30_000"));
  assert(script.includes("renderTypingStrip"));
  assert(script.includes("renderMemberStrip"));
  assert(script.includes("renderToolbarMetaNote"));
  assert(script.includes("participantPresence"));
  assert(script.includes("hall-typing-dots"));
  assert(script.includes("window.__openclawHallSetExecutionOrder"));
  assert(script.includes("window.__openclawHallContinueDiscussion"));
  assert(script.includes("is-planning-order"));
  assert(script.includes("Start execution"));
  assert(zhScript.includes("开始执行（"));
  assert(zhScript.includes("顺序排好后"));
  assert(!zhScript.includes("更换当前执行者"));
  assert(!html.includes('data-hall-assign'));
  assert(!script.includes("data-hall-assign"));
  assert(html.includes("data-hall-start-execution"));
  assert(html.includes("data-hall-plan-order"));
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
  assert(script.includes("if (!taskCard || taskCard.stage !== 'execution' || !taskCard.currentOwnerParticipantId) return [];"));
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

test("review-stage hall cards with a queued next round still render a start-execution action", () => {
  const html = renderCollaborationHall({
    language: "zh",
    hall: {
      hallId: "main",
      title: "Collaboration Hall",
      participants: [
        { participantId: "main", agentId: "main", displayName: "Main", semanticRole: "manager", active: true, aliases: ["Main"] },
        { participantId: "pandas", agentId: "pandas", displayName: "Pandas", semanticRole: "coder", active: true, aliases: ["Pandas"] },
        { participantId: "monkey", agentId: "monkey", displayName: "Monkey", semanticRole: "planner", active: true, aliases: ["Monkey"] },
      ],
      taskCardIds: ["demo"],
      messageIds: ["demo-message"],
      lastMessageId: "demo-message",
      latestMessageAt: "2026-03-24T10:05:00.000Z",
      createdAt: "2026-03-24T10:00:00.000Z",
      updatedAt: "2026-03-24T10:05:00.000Z",
    },
    hallSummary: {
      hallId: "main",
      headline: "A first execution pass finished and the next round is ready to start.",
      activeTaskCount: 1,
      waitingReviewCount: 1,
      blockedTaskCount: 0,
      currentSpeakerLabel: "Monkey",
      updatedAt: "2026-03-24T10:05:00.000Z",
    },
    taskCards: [
      {
        card: {
          hallId: "main",
          taskCardId: "demo",
          projectId: "collaboration-hall",
          taskId: "demo-task",
          roomId: "collaboration-hall:demo-task",
          title: "Build the public collaboration hall",
          description: "Keep discussion, execution, and review in one visible timeline.",
          stage: "review",
          status: "in_progress",
          createdByParticipantId: "operator",
          currentOwnerParticipantId: "monkey",
          currentOwnerLabel: "Monkey",
          currentExecutionItem: {
            itemId: "done-monkey",
            participantId: "monkey",
            task: "Package the first reviewable demo teaser.",
            handoffWhen: "Once the teaser is posted back to the hall.",
          },
          proposal: "Finish the first teaser, then start a second round with pandas.",
          decision: "Use the first teaser as evidence, then launch the next implementation round.",
          doneWhen: "The second round starts explicitly from the decision card.",
          plannedExecutionOrder: ["pandas"],
          plannedExecutionItems: [
            {
              itemId: "next-pandas",
              participantId: "pandas",
              task: "Turn the reviewed teaser into a second implementation pass.",
              handoffWhen: "When the next pass is ready for review.",
            },
          ],
          latestSummary: "The first pass is done; the next round should start with pandas.",
          blockers: [],
          requiresInputFrom: [],
          mentionedParticipantIds: [],
          sessionKeys: [],
          createdAt: "2026-03-24T10:00:00.000Z",
          updatedAt: "2026-03-24T10:05:00.000Z",
        },
        summary: {
          taskCardId: "demo",
          projectId: "collaboration-hall",
          taskId: "demo-task",
          headline: "The first pass finished; the next queued owner is pandas.",
          currentOwnerLabel: "Monkey",
          nextAction: "Start the next execution round with pandas.",
          stage: "review",
          blockerCount: 0,
          updatedAt: "2026-03-24T10:05:00.000Z",
        },
        task: {
          projectId: "collaboration-hall",
          taskId: "demo-task",
          title: "Build the public collaboration hall",
          status: "in_progress",
          owner: "Operator",
          roomId: "collaboration-hall:demo-task",
          definitionOfDone: ["A reviewable teaser exists", "The next round can be started from the hall"],
          artifacts: [],
          rollback: { strategy: "manual", steps: [] },
          sessionKeys: [],
          budget: {},
          updatedAt: "2026-03-24T10:05:00.000Z",
        },
      },
    ],
    selectedTaskCard: {
      hallId: "main",
      taskCardId: "demo",
      projectId: "collaboration-hall",
      taskId: "demo-task",
      roomId: "collaboration-hall:demo-task",
      title: "Build the public collaboration hall",
      description: "Keep discussion, execution, and review in one visible timeline.",
      stage: "review",
      status: "in_progress",
      createdByParticipantId: "operator",
      currentOwnerParticipantId: "monkey",
      currentOwnerLabel: "Monkey",
      currentExecutionItem: {
        itemId: "done-monkey",
        participantId: "monkey",
        task: "Package the first reviewable demo teaser.",
        handoffWhen: "Once the teaser is posted back to the hall.",
      },
      proposal: "Finish the first teaser, then start a second round with pandas.",
      decision: "Use the first teaser as evidence, then launch the next implementation round.",
      doneWhen: "The second round starts explicitly from the decision card.",
      plannedExecutionOrder: ["pandas"],
      plannedExecutionItems: [
        {
          itemId: "next-pandas",
          participantId: "pandas",
          task: "Turn the reviewed teaser into a second implementation pass.",
          handoffWhen: "When the next pass is ready for review.",
        },
      ],
      latestSummary: "The first pass is done; the next round should start with pandas.",
      blockers: [],
      requiresInputFrom: [],
      mentionedParticipantIds: [],
      sessionKeys: [],
      createdAt: "2026-03-24T10:00:00.000Z",
      updatedAt: "2026-03-24T10:05:00.000Z",
    },
    selectedTaskSummary: {
      taskCardId: "demo",
      projectId: "collaboration-hall",
      taskId: "demo-task",
      headline: "The first pass finished; the next queued owner is pandas.",
      currentOwnerLabel: "Monkey",
      nextAction: "Start the next execution round with pandas.",
      stage: "review",
      blockerCount: 0,
      updatedAt: "2026-03-24T10:05:00.000Z",
    },
    selectedTask: {
      projectId: "collaboration-hall",
      taskId: "demo-task",
      title: "Build the public collaboration hall",
      status: "in_progress",
      owner: "Operator",
      roomId: "collaboration-hall:demo-task",
      definitionOfDone: ["A reviewable teaser exists", "The next round can be started from the hall"],
      artifacts: [],
      rollback: { strategy: "manual", steps: [] },
      sessionKeys: [],
      budget: {},
      updatedAt: "2026-03-24T10:05:00.000Z",
    },
    messages: [],
  });

  assert(html.includes("开始执行（"));
  assert(!html.includes("更换当前执行者"));
  assert(html.includes("data-hall-start-execution"));
});

test("discussion-stage proposals still render the bottom decision console actions", () => {
  const html = renderCollaborationHall({
    language: "zh",
    hall: {
      hallId: "main",
      title: "Collaboration Hall",
      participants: [
        { participantId: "coq", agentId: "coq", displayName: "Coq", semanticRole: "planner", active: true, aliases: ["Coq"] },
        { participantId: "monkey", agentId: "monkey", displayName: "Monkey", semanticRole: "coder", active: true, aliases: ["Monkey"] },
      ],
      taskCardIds: ["demo"],
      messageIds: ["coq-1", "monkey-1"],
      lastMessageId: "monkey-1",
      latestMessageAt: "2026-03-29T17:00:00.000Z",
      createdAt: "2026-03-29T16:58:00.000Z",
      updatedAt: "2026-03-29T17:00:00.000Z",
    },
    hallSummary: {
      hallId: "main",
      headline: "The discussion settled on a concrete first slice.",
      activeTaskCount: 1,
      waitingReviewCount: 0,
      blockedTaskCount: 0,
      currentSpeakerLabel: "Monkey",
      updatedAt: "2026-03-29T17:00:00.000Z",
    },
    taskCards: [
      {
        card: {
          hallId: "main",
          taskCardId: "demo",
          projectId: "collaboration-hall",
          taskId: "demo-task",
          roomId: "collaboration-hall:demo-task",
          title: "Introduce the hall with a short video",
          description: "Show the moment when the task gets picked up.",
          stage: "discussion",
          status: "in_progress",
          createdByParticipantId: "operator",
          proposal: "Open on a small task entering the hall, then land on owner and next action.",
          latestSummary: "Open on a small task entering the hall, then land on owner and next action.",
          blockers: [],
          requiresInputFrom: [],
          mentionedParticipantIds: [],
          sessionKeys: [],
          discussionCycle: {
            participantIds: ["coq", "monkey"],
            completedParticipantIds: ["coq", "monkey"],
          },
          createdAt: "2026-03-29T16:58:00.000Z",
          updatedAt: "2026-03-29T17:00:00.000Z",
        },
        summary: {
          taskCardId: "demo",
          projectId: "collaboration-hall",
          taskId: "demo-task",
          headline: "Open on a small task entering the hall, then land on owner and next action.",
          currentOwnerLabel: "",
          nextAction: "Plan the execution order for the first concrete deliverable.",
          stage: "discussion",
          blockerCount: 0,
          updatedAt: "2026-03-29T17:00:00.000Z",
        },
        task: {
          projectId: "collaboration-hall",
          taskId: "demo-task",
          title: "Introduce the hall with a short video",
          status: "in_progress",
          owner: "Operator",
          roomId: "collaboration-hall:demo-task",
          definitionOfDone: ["A concrete first cut is chosen"],
          artifacts: [],
          rollback: { strategy: "manual", steps: [] },
          sessionKeys: [],
          budget: {},
          updatedAt: "2026-03-29T17:00:00.000Z",
        },
      },
    ],
    selectedTaskCard: {
      hallId: "main",
      taskCardId: "demo",
      projectId: "collaboration-hall",
      taskId: "demo-task",
      roomId: "collaboration-hall:demo-task",
      title: "Introduce the hall with a short video",
      description: "Show the moment when the task gets picked up.",
      stage: "discussion",
      status: "in_progress",
      createdByParticipantId: "operator",
      proposal: "Open on a small task entering the hall, then land on owner and next action.",
      latestSummary: "Open on a small task entering the hall, then land on owner and next action.",
      blockers: [],
      requiresInputFrom: [],
      mentionedParticipantIds: [],
      sessionKeys: [],
      discussionCycle: {
        participantIds: ["coq", "monkey"],
        completedParticipantIds: ["coq", "monkey"],
      },
      createdAt: "2026-03-29T16:58:00.000Z",
      updatedAt: "2026-03-29T17:00:00.000Z",
    },
    selectedTaskSummary: {
      taskCardId: "demo",
      projectId: "collaboration-hall",
      taskId: "demo-task",
      headline: "Open on a small task entering the hall, then land on owner and next action.",
      currentOwnerLabel: "",
      nextAction: "Plan the execution order for the first concrete deliverable.",
      stage: "discussion",
      blockerCount: 0,
      updatedAt: "2026-03-29T17:00:00.000Z",
    },
    selectedTask: {
      projectId: "collaboration-hall",
      taskId: "demo-task",
      title: "Introduce the hall with a short video",
      status: "in_progress",
      owner: "Operator",
      roomId: "collaboration-hall:demo-task",
      definitionOfDone: ["A concrete first cut is chosen"],
      artifacts: [],
      rollback: { strategy: "manual", steps: [] },
      sessionKeys: [],
      budget: {},
      updatedAt: "2026-03-29T17:00:00.000Z",
    },
    messages: [],
  });

  assert(html.includes("讨论结论"));
  assert(html.includes("data-hall-plan-order"));
  assert(html.includes("继续讨论"));
});

test("selected task renders the current console in the bottom decision panel instead of the message history", () => {
  const html = renderCollaborationHall({
    language: "zh",
    hall: {
      hallId: "main",
      title: "Collaboration Hall",
      participants: [
        { participantId: "main", agentId: "main", displayName: "Main", semanticRole: "manager", active: true, aliases: ["Main"] },
        { participantId: "otter", agentId: "otter", displayName: "Otter", semanticRole: "reviewer", active: true, aliases: ["Otter"] },
      ],
      taskCardIds: ["demo"],
      messageIds: ["message-1"],
      lastMessageId: "message-1",
      latestMessageAt: "2026-03-28T13:21:32.962Z",
      createdAt: "2026-03-28T13:15:22.034Z",
      updatedAt: "2026-03-28T13:21:32.962Z",
    },
    hallSummary: {
      hallId: "main",
      headline: "Current console should stay pinned under the timeline.",
      activeTaskCount: 1,
      waitingReviewCount: 1,
      blockedTaskCount: 0,
      currentSpeakerLabel: "Otter",
      updatedAt: "2026-03-28T13:21:32.962Z",
    },
    taskCards: [{
      card: {
        hallId: "main",
        taskCardId: "demo",
        projectId: "collaboration-hall",
        taskId: "demo-task",
        roomId: "collaboration-hall:demo-task",
        title: "我想要做一个视频 介绍我的群聊功能",
        description: "把讨论收敛成当前 owner 和 next action。",
        stage: "review",
        status: "in_progress",
        createdByParticipantId: "operator",
        currentOwnerParticipantId: "otter",
        currentOwnerLabel: "otter",
        currentExecutionItem: {
          itemId: "review-otter",
          participantId: "otter",
          task: "检查上一位的结果，指出必须改的点；如果没有硬阻塞，就直接把可继续版本交给下一位。",
          handoffWhen: "没有 must-fix 时直接请老板评审。",
        },
        decision: "任务标题不仅要短，还要直接写成产物目标，例如‘出3个thumbnail idea’。",
        latestSummary: "任务标题不仅要短，还要直接写成产物目标，例如‘出3个thumbnail idea’。",
        blockers: [],
        requiresInputFrom: [],
        mentionedParticipantIds: [],
        plannedExecutionOrder: ["coq", "main"],
        plannedExecutionItems: [
          {
            itemId: "coq-1",
            participantId: "coq",
            task: "产出 3 个 thumbnail 页面 URL。",
            handoffToParticipantId: "main",
            handoffWhen: "贴完 URL 后交给 main 收口。",
          },
          {
            itemId: "main-2",
            participantId: "main",
            task: "收口并决定下一轮。",
            handoffWhen: "确认是否继续讨论或开始下一轮。",
          },
        ],
        sessionKeys: [],
        createdAt: "2026-03-28T13:15:22.034Z",
        updatedAt: "2026-03-28T13:21:32.962Z",
      },
      summary: {
        taskCardId: "demo",
        projectId: "collaboration-hall",
        taskId: "demo-task",
        headline: "任务标题不仅要短，还要直接写成产物目标，例如‘出3个thumbnail idea’。",
        currentOwnerLabel: "otter",
        nextAction: "调整执行顺序或继续讨论。",
        stage: "review",
        blockerCount: 0,
        updatedAt: "2026-03-28T13:21:32.962Z",
      },
      task: {
        projectId: "collaboration-hall",
        taskId: "demo-task",
        title: "我想要做一个视频 介绍我的群聊功能",
        status: "in_progress",
        owner: "Operator",
        roomId: "collaboration-hall:demo-task",
        definitionOfDone: ["有明确产物目标", "当前控制卡固定在最下面"],
        artifacts: [],
        rollback: { strategy: "manual", steps: [] },
        sessionKeys: [],
        budget: {},
        updatedAt: "2026-03-28T13:21:32.962Z",
      },
    }],
    selectedTaskCard: {
      hallId: "main",
      taskCardId: "demo",
      projectId: "collaboration-hall",
      taskId: "demo-task",
      roomId: "collaboration-hall:demo-task",
      title: "我想要做一个视频 介绍我的群聊功能",
      description: "把讨论收敛成当前 owner 和 next action。",
      stage: "review",
      status: "in_progress",
      createdByParticipantId: "operator",
      currentOwnerParticipantId: "otter",
      currentOwnerLabel: "otter",
      currentExecutionItem: {
        itemId: "review-otter",
        participantId: "otter",
        task: "检查上一位的结果，指出必须改的点；如果没有硬阻塞，就直接把可继续版本交给下一位。",
        handoffWhen: "没有 must-fix 时直接请老板评审。",
      },
      decision: "任务标题不仅要短，还要直接写成产物目标，例如‘出3个thumbnail idea’。",
      latestSummary: "任务标题不仅要短，还要直接写成产物目标，例如‘出3个thumbnail idea’。",
      blockers: [],
      requiresInputFrom: [],
      mentionedParticipantIds: [],
      plannedExecutionOrder: ["coq", "main"],
      plannedExecutionItems: [
        {
          itemId: "coq-1",
          participantId: "coq",
          task: "产出 3 个 thumbnail 页面 URL。",
          handoffToParticipantId: "main",
          handoffWhen: "贴完 URL 后交给 main 收口。",
        },
        {
          itemId: "main-2",
          participantId: "main",
          task: "收口并决定下一轮。",
          handoffWhen: "确认是否继续讨论或开始下一轮。",
        },
      ],
      sessionKeys: [],
      createdAt: "2026-03-28T13:15:22.034Z",
      updatedAt: "2026-03-28T13:21:32.962Z",
    },
    selectedTaskSummary: {
      taskCardId: "demo",
      projectId: "collaboration-hall",
      taskId: "demo-task",
      headline: "任务标题不仅要短，还要直接写成产物目标，例如‘出3个thumbnail idea’。",
      currentOwnerLabel: "otter",
      nextAction: "调整执行顺序或继续讨论。",
      stage: "review",
      blockerCount: 0,
      updatedAt: "2026-03-28T13:21:32.962Z",
    },
    selectedTask: {
      projectId: "collaboration-hall",
      taskId: "demo-task",
      title: "我想要做一个视频 介绍我的群聊功能",
      status: "in_progress",
      owner: "Operator",
      roomId: "collaboration-hall:demo-task",
      definitionOfDone: ["有明确产物目标", "当前控制卡固定在最下面"],
      artifacts: [],
      rollback: { strategy: "manual", steps: [] },
      sessionKeys: [],
      budget: {},
      updatedAt: "2026-03-28T13:21:32.962Z",
    },
    messages: [{
      hallId: "main",
      messageId: "message-1",
      kind: "handoff",
      authorParticipantId: "coq",
      authorLabel: "Coq-每日新闻",
      authorSemanticRole: "planner",
      content: "3 个 thumbnail 页都好了，现在请老板评审。",
      targetParticipantIds: [],
      mentionTargets: [],
      projectId: "collaboration-hall",
      taskId: "demo-task",
      taskCardId: "demo",
      createdAt: "2026-03-28T13:21:32.962Z",
    }],
  });

  const threadStart = html.indexOf('<div class="hall-thread" data-hall-thread>');
  const panelStart = html.indexOf('<div class="hall-decision-panel" data-hall-decision-panel');
  const typingStart = html.indexOf('<div class="hall-typing-strip" data-hall-typing-strip');
  assert(threadStart >= 0 && panelStart > threadStart && typingStart > panelStart);
  const threadSection = html.slice(threadStart, panelStart);
  const panelSection = html.slice(panelStart, typingStart);
  assert(!threadSection.includes("data-hall-current-console"));
  assert(panelSection.includes("data-hall-current-console"));
  assert(panelSection.includes("讨论结论"));
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
      blockedTaskCount: 0,
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
        stage: "discussion",
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
      stage: "discussion",
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
      blockedTaskCount: 0,
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
      blockedTaskCount: 0,
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
      blockedTaskCount: 0,
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
          stage: "discussion",
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
          stage: "discussion",
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
      stage: "discussion",
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
      blockedTaskCount: 0,
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
      blockedTaskCount: 0,
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
      blockedTaskCount: 0,
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
      blockedTaskCount: 0,
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
      blockedTaskCount: 0,
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
      blockedTaskCount: 0,
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

test("client script handles draft_tool_update events and renders tool pills", () => {
  const script = renderCollaborationHallClientScript("en");
  assert(script.includes("draft_tool_update"));
  assert(script.includes("toolCalls"));
  assert(script.includes("hall-tool-strip"));
  assert(script.includes("hall-tool-pill"));
  assert(script.includes("is-running"));
  assert(script.includes("is-completed"));
  assert(script.includes("is-error"));
  assert(script.includes("toolName"));
  assert(script.includes("toolStatus"));
});

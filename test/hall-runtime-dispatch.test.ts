import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { compactHallCoworkerReply, compactHallDiscussionReply, dispatchHallRuntimeTurn, enforceConcreteDeliverableReply, summarizeWorkspacePersonaFromFiles } from "../src/runtime/hall-runtime-dispatch";

const OPENCLAW_HOME = join(process.env.HOME ?? "", ".openclaw");
const OPENCLAW_WORKSPACE = join(OPENCLAW_HOME, "workspace");
const MONKEY_WORKSPACE = join(OPENCLAW_WORKSPACE, "agents", "monkey");
const PANDAS_WORKSPACE = join(OPENCLAW_WORKSPACE, "agents", "pandas");
const COQ_WORKSPACE = join(OPENCLAW_WORKSPACE, "agents", "coq");
const THUMBNAIL_HALL_1_URL = pathToFileURL(join(OPENCLAW_WORKSPACE, "thumbnail-hall-1.html")).toString();
const THUMBNAIL_HALL_2_URL = pathToFileURL(join(OPENCLAW_WORKSPACE, "thumbnail-hall-2.html")).toString();
const THUMBNAIL_HALL_3_URL = pathToFileURL(join(OPENCLAW_WORKSPACE, "thumbnail-hall-3.html")).toString();
const THUMBNAIL_HOOK_1_URL = pathToFileURL(join(PANDAS_WORKSPACE, "control-center", "tmp", "thumbnail-hook-1.html")).toString();

test("brand-new hall threads use a thread-scoped runtime session instead of the shared hall agent session", async () => {
  const observedSessionKeys: string[] = [];
  await dispatchHallRuntimeTurn({
    client: {
      sessionsHistory: async ({ sessionKey }: { sessionKey: string }) => {
        observedSessionKeys.push(sessionKey);
        return { history: [] };
      },
      agentRun: async (request: { sessionKey?: string }) => {
        observedSessionKeys.push(String(request.sessionKey || ""));
        return {
          ok: true,
          text: "先把第一屏要证明的价值锁住。",
          rawText: "",
          sessionKey: request.sessionKey,
        };
      },
    } as never,
    hall: {
      hallId: "hall",
      participants: [],
      updatedAt: new Date().toISOString(),
    } as never,
    taskCard: {
      taskCardId: "card",
      hallId: "hall",
      projectId: "project",
      taskId: "task-123",
      title: "我想要做一个视频 介绍我的群聊功能",
      description: "我想要做一个视频 介绍我的群聊功能",
      status: "todo",
      plannedExecutionOrder: [],
      plannedExecutionItems: [],
      mentionedParticipantIds: [],
      sessionKeys: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    participant: {
      participantId: "coq",
      agentId: "coq",
      displayName: "Coq-每日新闻",
      semanticRole: "planner",
      aliases: [],
      active: true,
    } as never,
    triggerMessage: {
      hallId: "hall",
      messageId: "trigger",
      kind: "task",
      authorParticipantId: "operator",
      authorLabel: "Operator",
      content: "我想要做一个视频 介绍我的群聊功能",
      createdAt: new Date().toISOString(),
    } as never,
    mode: "discussion",
  });

  assert.deepEqual(
    [...new Set(observedSessionKeys.filter(Boolean))],
    ["agent:coq:hall:task-123"],
  );
});

test("legacy shared hall agent sessions are ignored in favor of a thread-scoped runtime session", async () => {
  const observedSessionKeys: string[] = [];
  await dispatchHallRuntimeTurn({
    client: {
      sessionsHistory: async ({ sessionKey }: { sessionKey: string }) => {
        observedSessionKeys.push(sessionKey);
        return { history: [] };
      },
      agentRun: async (request: { sessionKey?: string }) => {
        observedSessionKeys.push(String(request.sessionKey || ""));
        return {
          ok: true,
          text: "先把第一屏要证明的价值锁住。",
          rawText: "",
          sessionKey: request.sessionKey,
        };
      },
    } as never,
    hall: {
      hallId: "hall",
      participants: [],
      updatedAt: new Date().toISOString(),
    } as never,
    taskCard: {
      taskCardId: "card",
      hallId: "hall",
      projectId: "project",
      taskId: "task-456",
      title: "我想要做一个视频 介绍我的群聊功能",
      description: "我想要做一个视频 介绍我的群聊功能",
      status: "todo",
      plannedExecutionOrder: [],
      plannedExecutionItems: [],
      mentionedParticipantIds: [],
      sessionKeys: ["agent:coq:main"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    participant: {
      participantId: "coq",
      agentId: "coq",
      displayName: "Coq-每日新闻",
      semanticRole: "planner",
      aliases: [],
      active: true,
    } as never,
    triggerMessage: {
      hallId: "hall",
      messageId: "trigger",
      kind: "task",
      authorParticipantId: "operator",
      authorLabel: "Operator",
      content: "我想要做一个视频 介绍我的群聊功能",
      createdAt: new Date().toISOString(),
    } as never,
    mode: "discussion",
  });

  assert.deepEqual(
    [...new Set(observedSessionKeys.filter(Boolean))],
    ["agent:coq:hall:task-456"],
  );
});

test("existing thread-scoped runtime sessions are preserved for continuity inside the same hall thread", async () => {
  const observedSessionKeys: string[] = [];
  await dispatchHallRuntimeTurn({
    client: {
      sessionsHistory: async ({ sessionKey }: { sessionKey: string }) => {
        observedSessionKeys.push(sessionKey);
        return { history: [] };
      },
      agentRun: async (request: { sessionKey?: string }) => {
        observedSessionKeys.push(String(request.sessionKey || ""));
        return {
          ok: true,
          text: "先把第一屏要证明的价值锁住。",
          rawText: "",
          sessionKey: request.sessionKey,
        };
      },
    } as never,
    hall: {
      hallId: "hall",
      participants: [],
      updatedAt: new Date().toISOString(),
    } as never,
    taskCard: {
      taskCardId: "card",
      hallId: "hall",
      projectId: "project",
      taskId: "task-789",
      title: "我想要做一个视频 介绍我的群聊功能",
      description: "我想要做一个视频 介绍我的群聊功能",
      status: "todo",
      plannedExecutionOrder: [],
      plannedExecutionItems: [],
      mentionedParticipantIds: [],
      sessionKeys: ["agent:coq:hall:task-789", "agent:coq:main"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    participant: {
      participantId: "coq",
      agentId: "coq",
      displayName: "Coq-每日新闻",
      semanticRole: "planner",
      aliases: [],
      active: true,
    } as never,
    triggerMessage: {
      hallId: "hall",
      messageId: "trigger",
      kind: "task",
      authorParticipantId: "operator",
      authorLabel: "Operator",
      content: "我想要做一个视频 介绍我的群聊功能",
      createdAt: new Date().toISOString(),
    } as never,
    mode: "discussion",
  });

  assert.deepEqual(
    [...new Set(observedSessionKeys.filter(Boolean))],
    ["agent:coq:hall:task-789"],
  );
});

test("participants with an existing thread-scoped hall session keep same-thread continuity prompts without the clean-thread reset", async () => {
  let capturedPrompt = "";
  await dispatchHallRuntimeTurn({
    client: {
      sessionsHistory: async () => ({ history: [] }),
      agentRun: async (request: { sessionKey?: string; message: string }) => {
        capturedPrompt = request.message;
        return {
          ok: true,
          text: "继续把第一版的价值往下推。",
          rawText: "",
          sessionKey: request.sessionKey,
        };
      },
    } as never,
    hall: {
      hallId: "hall",
      participants: [],
      updatedAt: new Date().toISOString(),
    } as never,
    taskCard: {
      taskCardId: "card",
      hallId: "hall",
      projectId: "project",
      taskId: "task-654",
      title: "我想要做一个视频 介绍我的群聊功能",
      description: "我想要做一个视频 介绍我的群聊功能",
      status: "todo",
      plannedExecutionOrder: [],
      plannedExecutionItems: [],
      mentionedParticipantIds: [],
      sessionKeys: ["agent:coq:hall:task-654"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    participant: {
      participantId: "coq",
      agentId: "coq",
      displayName: "Coq-每日新闻",
      semanticRole: "planner",
      aliases: [],
      active: true,
    } as never,
    triggerMessage: {
      hallId: "hall",
      messageId: "trigger",
      kind: "chat",
      authorParticipantId: "operator",
      authorLabel: "Operator",
      content: "继续把第一个版本再收紧一点",
      createdAt: new Date().toISOString(),
    } as never,
    mode: "discussion",
  });

  assert.doesNotMatch(capturedPrompt, /This is your first reply in this hall thread/i);
  assert.doesNotMatch(capturedPrompt, /continuing a previous thread/i);
});

test("brand-new discussion first replies strip continuation-style openers from the visible content", async () => {
  const result = await dispatchHallRuntimeTurn({
    client: {
      sessionsHistory: async () => ({ history: [] }),
      agentRun: async (request: { sessionKey?: string }) => ({
        ok: true,
        text: "对，这样开头会更狠。<br>第一版先别讲全貌，先让观众一眼看到任务被接住了。",
        rawText: "",
        sessionKey: request.sessionKey,
      }),
    } as never,
    hall: {
      hallId: "hall",
      participants: [],
      updatedAt: new Date().toISOString(),
    } as never,
    taskCard: {
      taskCardId: "card",
      hallId: "hall",
      projectId: "project",
      taskId: "task-888",
      title: "我想要做一个视频 介绍我的群聊功能",
      description: "我想要做一个视频 介绍我的群聊功能",
      status: "todo",
      plannedExecutionOrder: [],
      plannedExecutionItems: [],
      mentionedParticipantIds: [],
      sessionKeys: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    participant: {
      participantId: "coq",
      agentId: "coq",
      displayName: "Coq-每日新闻",
      semanticRole: "planner",
      aliases: [],
      active: true,
    } as never,
    triggerMessage: {
      hallId: "hall",
      messageId: "trigger",
      kind: "task",
      authorParticipantId: "operator",
      authorLabel: "Operator",
      content: "我想要做一个视频 介绍我的群聊功能",
      createdAt: new Date().toISOString(),
    } as never,
    mode: "discussion",
  });

  assert.doesNotMatch(result.content, /^对[，,\s]/u);
  assert.match(result.content, /第一版先别讲全貌/);
});

test("coworker reply compaction strips memo tone and keeps the handoff", () => {
  const result = compactHallCoworkerReply(
    "当前结果是：这版已经够用了。<br>我建议下一步把最后一拍再磨一下。<br>@otter 你只抓必须修改的一点。",
    "zh",
  );

  assert.equal(result.includes("当前结果是"), false);
  assert.equal(result.includes("我建议下一步"), false);
  assert.match(result, /@otter/);
});

test("discussion compaction keeps the selected sentences intact instead of truncating them with ellipses", () => {
  const result = compactHallDiscussionReply(
    "这 3 个入口已经够讲清主线了，我只补一个抓手：读代码时按“看见什么 → 谁决定怎么流转 → 谁把事真正发出去”这个顺序讲，读者最不容易乱。<br>也就是先看 src/ui/collaboration-hall.ts 里界面怎么把 hall-chat 呈现出来，再看 src/runtime/collaboration-hall-orchestrator.ts 里任务怎么轮转，最后看 src/runtime/hall-runtime-dispatch.ts 怎么把执行真正派出去。<br>@main 你最后只检查这 3 个文件是不是最关键。",
    "zh",
  );

  assert.equal(result.endsWith("…"), false);
  assert.match(result, /这 3 个入口已经够讲清主线了/);
  assert.match(result, /@main/);
});

test("discussion compaction keeps a natural follow-up chain instead of collapsing it to only two fragments", () => {
  const result = compactHallDiscussionReply(
    "对，这个方向对。<br>第一版先别讲机制，先让人看到省掉了什么人工动作。<br>再往前一点，开头最好就是一句能直接拍的结果句，不要先解释系统。<br>这样下一位接的时候，直接补画面和产物就顺了。",
    "zh",
  );

  assert.match(result, /这个方向对/);
  assert.match(result, /省掉了什么人工动作/);
  assert.match(result, /一句能直接拍的结果句/);
  assert.match(result, /下一位接的时候/);
});

test("discussion compaction keeps long multi-part replies fully visible instead of truncating by segment or length", () => {
  const result = compactHallDiscussionReply(
    "先把观众第一眼会看到什么锁住。<br>第一屏不要先解释系统，要先让人看到这件事本来会卡住。<br>然后再把 owner 和 next action 作为结果卡一起亮出来。<br>如果这里再补一句“你不用自己催下一步了”，价值会更直接。<br>最后再把这条链落到一个具体产物，比如 3 个 thumbnail idea。",
    "zh",
  );

  assert.match(result, /第一眼会看到什么/);
  assert.match(result, /本来会卡住/);
  assert.match(result, /owner 和 next action/);
  assert.match(result, /不用自己催下一步/);
  assert.match(result, /3 个 thumbnail idea/);
});

test("execution reply that stays in meta-discussion cannot pretend to hand off", () => {
  const result = enforceConcreteDeliverableReply(
    {
      client: {} as never,
      hall: {
        hallId: "hall",
        participants: [],
        updatedAt: new Date().toISOString(),
      } as never,
      taskCard: {
        taskCardId: "card",
        hallId: "hall",
        projectId: "project",
        taskId: "task",
        title: "做一个视频介绍群聊功能",
        description: "做一个视频介绍群聊功能",
        status: "in_progress",
        plannedExecutionOrder: [],
        plannedExecutionItems: [],
        currentExecutionItem: {
          itemId: "item",
          participantId: "monkey",
          task: "先出 3 个 thumbnail idea 给这一版视频样本",
          handoffWhen: "产物贴回群里就算完成。",
        },
        currentOwnerParticipantId: "monkey",
        currentOwnerLabel: "monkey",
        mentionedParticipantIds: [],
        sessionKeys: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as never,
      participant: {
        participantId: "monkey",
        displayName: "monkey",
        semanticRole: "coder",
        aliases: [],
        active: true,
      } as never,
      mode: "execution",
    },
    "这版样本更适合先证明节省协调成本，不然观众会先注意到画面很热闹。@pandas 你接着补最后一拍。",
    "handoff",
    "zh",
  );

  assert.equal(result.nextAction, "continue");
  assert.equal(result.suppressVisibleMessage, true);
  assert.equal(result.content, "");
  assert.match(result.nextStep ?? "", /下一条直接贴 3 个 thumbnail 方向/);
});

test("execution reply that stays in meta-discussion is hidden even before it tries to hand off", () => {
  const result = enforceConcreteDeliverableReply(
    {
      client: {} as never,
      hall: {
        hallId: "hall",
        participants: [],
        updatedAt: new Date().toISOString(),
      } as never,
      taskCard: {
        taskCardId: "card",
        hallId: "hall",
        projectId: "project",
        taskId: "task",
        title: "做一个视频介绍群聊功能",
        description: "做一个视频介绍群聊功能",
        status: "in_progress",
        plannedExecutionOrder: [],
        plannedExecutionItems: [],
        currentExecutionItem: {
          itemId: "item",
          participantId: "pandas",
          task: "给出 3 个 hook",
          handoffWhen: "把 3 个 hook 贴回群里就算完成。",
        },
        currentOwnerParticipantId: "pandas",
        currentOwnerLabel: "pandas",
        mentionedParticipantIds: [],
        sessionKeys: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as never,
      participant: {
        participantId: "pandas",
        displayName: "pandas",
        semanticRole: "coder",
        aliases: [],
        active: true,
      } as never,
      mode: "execution",
    },
    "这版先把群聊价值讲清，别让观众先误会成普通聊天界面。",
    undefined,
    "zh",
  );

  assert.equal(result.nextAction, "continue");
  assert.equal(result.suppressVisibleMessage, true);
  assert.equal(result.content, "");
  assert.match(result.nextStep ?? "", /下一条直接贴 3 个 hook/);
});

test("generic carry-forward execution steps still require a concrete deliverable", () => {
  const result = enforceConcreteDeliverableReply(
    {
      client: {} as never,
      hall: {
        hallId: "hall",
        participants: [],
        updatedAt: new Date().toISOString(),
      } as never,
      taskCard: {
        taskCardId: "card",
        hallId: "hall",
        projectId: "project",
        taskId: "task",
        title: "继续推进这一轮",
        description: "继续推进这一轮",
        status: "in_progress",
        plannedExecutionOrder: [],
        plannedExecutionItems: [],
        currentExecutionItem: {
          itemId: "item",
          participantId: "pandas",
          task: "承接上一步继续推进，重点延续上一轮结果。",
          handoffWhen: "把下一版具体结果贴回群里就算完成。",
        },
        currentOwnerParticipantId: "pandas",
        currentOwnerLabel: "pandas",
        mentionedParticipantIds: [],
        sessionKeys: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as never,
      participant: {
        participantId: "pandas",
        displayName: "pandas",
        semanticRole: "coder",
        aliases: [],
        active: true,
      } as never,
      mode: "execution",
    },
    "这版先把价值讲清，别让观众先误会成普通聊天界面。",
    undefined,
    "zh",
  );

  assert.equal(result.nextAction, "continue");
  assert.equal(result.suppressVisibleMessage, true);
  assert.equal(result.content, "");
  assert.match(result.nextStep ?? "", /下一条直接贴具体产物/);
});

test("repo scan execution reply that still speaks in abstractions is hidden until it cites concrete findings", () => {
  const result = enforceConcreteDeliverableReply(
    {
      client: {} as never,
      hall: {
        hallId: "hall",
        participants: [],
        updatedAt: new Date().toISOString(),
      } as never,
      taskCard: {
        taskCardId: "card",
        hallId: "hall",
        projectId: "project",
        taskId: "task",
        title: "扫描 control-center 代码库",
        description: "扫描 control-center 代码库",
        status: "in_progress",
        plannedExecutionOrder: [],
        plannedExecutionItems: [],
        currentExecutionItem: {
          itemId: "item",
          participantId: "pandas",
          task: "Scan the repo and summarize the hall feature set.",
          handoffWhen: "把代码级总结贴回群里就算完成。",
        },
        currentOwnerParticipantId: "pandas",
        currentOwnerLabel: "pandas",
        mentionedParticipantIds: [],
        sessionKeys: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as never,
      participant: {
        participantId: "pandas",
        displayName: "pandas",
        semanticRole: "coder",
        aliases: [],
        active: true,
      } as never,
      mode: "execution",
    },
    "群聊功能已经收清了：它把讨论、分工、owner 收口、support-only 和 next action 串成一个可见的推进线程。",
    "handoff",
    "zh",
  );

  assert.equal(result.nextAction, "continue");
  assert.equal(result.suppressVisibleMessage, true);
  assert.equal(result.content, "");
  assert.match(result.nextStep ?? "", /真实文件路径/);
});

test("coworker compaction strips leaked structured fragments from visible text", () => {
  const result = compactHallCoworkerReply(
    '这版可以收口。<br>@otter 你按评审口径过一遍。<br>","nextAction":"handoff","nextStep":"otter 检查最后一个硬问题。<br><hall-structured>{"nextAction":"handoff"}</hall-structured>',
    "zh",
  );

  assert.match(result, /@otter/);
  assert.equal(result.includes('nextAction'), false);
  assert.equal(result.includes('hall-structured'), false);
});

test("coworker reply keeps concrete deliverable lists visible instead of collapsing them to two lines", () => {
  const result = compactHallCoworkerReply(
    "三个 hook 先给到：1, 不是多了个群聊, 是第一次让 AI 团队自己把任务往前推 2, 我做了个群聊, 重点不是聊天, 是它会自己收口 owner 和下一步 3, 以前要我盯全程, 现在这个群聊会自己把分工, 协作和推进串起来。",
    "zh",
  );

  assert.match(result, /1,/);
  assert.match(result, /2,/);
  assert.match(result, /3,/);
  assert.equal(result.endsWith("…"), false);
});

test("coworker compaction keeps long non-deliverable follow-up replies fully visible instead of truncating to two segments", () => {
  const result = compactHallCoworkerReply(
    "这版方向对，但第一屏还差一个更稳的落点。先别让观众理解系统，先让他们看到任务被接住了。然后 owner 和 next action 不要只是角落里出现，要跟结果卡同时亮起来。最后再补一句“你不用再自己催下一步”，这样价值会更直白。",
    "zh",
  );

  assert.match(result, /第一屏还差一个更稳的落点/);
  assert.match(result, /先让他们看到任务被接住了/);
  assert.match(result, /owner 和 next action/);
  assert.match(result, /你不用再自己催下一步/);
});

test("inline numbered deliverables separated by Chinese punctuation still count as concrete output", () => {
  const result = compactHallCoworkerReply(
    "第一版骨架先立住了：1. 任务抛进 hall；2. 两位 agent 快速补角度；3. owner 和下一步单独浮出来。",
    "zh",
  );

  assert.match(result, /1\./);
  assert.match(result, /2\./);
  assert.match(result, /3\./);
  assert.equal(result.endsWith("…"), false);
});

test("coworker reply treats three concrete hooks as a visible deliverable", () => {
  const result = compactHallCoworkerReply(
    "3 个 hook 先锁住了：“不是大家在聊天，是任务自己开始往前走”、“你不用再来回转述，群聊会自己收敛出 owner 和下一步”、“不是多一个群，是少掉中间协调的人力活”。@otter 你接着出 3 个 thumbnail 图的方向和 URL。",
    "zh",
  );

  assert.match(result, /3 个 hook/);
  assert.match(result, /@otter/);
  assert.equal(result.endsWith("…"), false);
});

test("coworker reply treats concrete repo findings as a visible deliverable", () => {
  const result = compactHallCoworkerReply(
    "我先扫了 4 个关键文件：src/ui/collaboration-hall.ts、src/ui/collaboration-hall-theme.ts、src/runtime/collaboration-hall-orchestrator.ts、src/runtime/hall-runtime-dispatch.ts。结论先锁 3 个：同线程推进、owner 明确、next action 可见。@monkey 你基于这 3 个点出 hook。",
    "zh",
  );

  assert.match(result, /src\/ui\/collaboration-hall\.ts/);
  assert.match(result, /src\/runtime\/hall-runtime-dispatch\.ts/);
  assert.match(result, /@monkey/);
  assert.equal(result.endsWith("…"), false);
});

test("coworker reply keeps legitimate support-only wording instead of deleting the whole deliverable line", () => {
  const result = compactHallCoworkerReply(
    "新群聊功能已经收清了：它把讨论、分工、owner 收口、support-only 和 next action 串成一个可见的任务推进线程，能把本来会来回拉扯的事及时收住。<br>@main 你接着按这句写 3 个 hook。",
    "zh",
  );

  assert.match(result, /support-only/);
  assert.match(result, /任务推进线程/);
  assert.match(result, /@main/);
});

test("direct deliverable replies in discussion stay fully visible instead of being compacted to two segments", async () => {
  const result = await dispatchHallRuntimeTurn({
    client: {
      agentRun: async () => ({
        ok: true,
        text: "对，既然网页已经有了，缺的就不是载体，而是能直接录的口播开头。<br>开头 1：你有没有遇到过这种情况，你把一件事丢进群里，大家聊了半天，最后还是没人动。<br>开头 2：以前你得自己盯着每个人接力，现在你把任务丢进群里，owner 和下一步会自己长出来。<br>开头 3：这不是 AI 在陪你聊天，而是它真的把中间协调吃掉了，所以事情会继续往前走。",
        rawText: "",
      }),
    } as never,
    hall: {
      hallId: "hall",
      participants: [
        {
          participantId: "otter",
          displayName: "otter",
          semanticRole: "reviewer",
          aliases: [],
          active: true,
        },
      ],
      updatedAt: new Date().toISOString(),
    } as never,
    taskCard: {
      taskCardId: "card",
      hallId: "hall",
      projectId: "project",
      taskId: "task",
      title: "我想要做一个视频 介绍我的群聊功能",
      description: "我想要做一个视频 介绍我的群聊功能",
      status: "todo",
      plannedExecutionOrder: [],
      plannedExecutionItems: [],
      mentionedParticipantIds: [],
      sessionKeys: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    participant: {
      participantId: "otter",
      displayName: "otter",
      semanticRole: "reviewer",
      aliases: [],
      active: true,
    } as never,
    triggerMessage: {
      hallId: "hall",
      messageId: "trigger",
      kind: "chat",
      authorParticipantId: "operator",
      authorLabel: "Operator",
      content: "@otter 给我完整的三个视频开头，而不是给我三句话。",
      targetParticipantIds: ["otter"],
      mentionTargets: [{ participantId: "otter" }],
      createdAt: new Date().toISOString(),
    } as never,
    mode: "discussion",
  });

  assert.equal(result.suppressVisibleMessage, undefined);
  assert.match(result.content, /开头 1/);
  assert.match(result.content, /开头 2/);
  assert.match(result.content, /开头 3/);
  assert.doesNotMatch(result.content, /…$/);
});

test("direct deliverable replies in discussion fall back to structured summary instead of disappearing", async () => {
  const result = await dispatchHallRuntimeTurn({
    client: {
      agentRun: async () => ({
        ok: true,
        text: '<hall-structured>{"latestSummary":"给你三版完整可直接口播的视频开头。","nextAction":"continue","nextStep":"直接贴出三版完整可口播开头。"}<\/hall-structured>',
        rawText: "",
      }),
    } as never,
    hall: {
      hallId: "hall",
      participants: [
        {
          participantId: "otter",
          displayName: "otter",
          semanticRole: "reviewer",
          aliases: [],
          active: true,
        },
      ],
      updatedAt: new Date().toISOString(),
    } as never,
    taskCard: {
      taskCardId: "card",
      hallId: "hall",
      projectId: "project",
      taskId: "task",
      title: "我想要做一个视频 介绍我的群聊功能",
      description: "我想要做一个视频 介绍我的群聊功能",
      status: "todo",
      plannedExecutionOrder: [],
      plannedExecutionItems: [],
      mentionedParticipantIds: [],
      sessionKeys: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    participant: {
      participantId: "otter",
      displayName: "otter",
      semanticRole: "reviewer",
      aliases: [],
      active: true,
    } as never,
    triggerMessage: {
      hallId: "hall",
      messageId: "trigger",
      kind: "chat",
      authorParticipantId: "operator",
      authorLabel: "Operator",
      content: "@otter 给我完整的三个视频开头。",
      targetParticipantIds: ["otter"],
      mentionTargets: [{ participantId: "otter" }],
      createdAt: new Date().toISOString(),
    } as never,
    mode: "discussion",
  });

  assert.equal(result.suppressVisibleMessage, undefined);
  assert.equal(result.content, "给你三版完整可直接口播的视频开头。");
});

test("direct video-opening request rejects evidence-point summaries until complete spoken openings are provided", async () => {
  const result = await dispatchHallRuntimeTurn({
    client: {
      agentRun: async () => ({
        ok: true,
        text: "这 3 个开头直接可录：一，src/ui/collaboration-hall.ts 证明这不是普通群聊壳子；二，src/runtime/collaboration-hall-orchestrator.ts 证明系统会接管中间协调；三，src/runtime/hall-runtime-dispatch.ts 证明收敛后的动作会继续派发执行。",
        rawText: "",
      }),
    } as never,
    hall: {
      hallId: "hall",
      participants: [
        {
          participantId: "main",
          displayName: "main",
          semanticRole: "manager",
          aliases: [],
          active: true,
        },
      ],
      updatedAt: new Date().toISOString(),
    } as never,
    taskCard: {
      taskCardId: "card",
      hallId: "hall",
      projectId: "project",
      taskId: "task",
      title: "我想要做一个视频 介绍我的群聊功能",
      description: "我想要做一个视频 介绍我的群聊功能",
      status: "todo",
      plannedExecutionOrder: [],
      plannedExecutionItems: [],
      mentionedParticipantIds: [],
      sessionKeys: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    participant: {
      participantId: "main",
      displayName: "main",
      semanticRole: "manager",
      aliases: [],
      active: true,
    } as never,
    triggerMessage: {
      hallId: "hall",
      messageId: "trigger",
      kind: "chat",
      authorParticipantId: "operator",
      authorLabel: "Operator",
      content: "@main 给我完整的三个视频开头。",
      targetParticipantIds: ["main"],
      mentionTargets: [{ participantId: "main" }],
      createdAt: new Date().toISOString(),
    } as never,
    mode: "discussion",
  });

  assert.equal(result.suppressVisibleMessage, undefined);
  assert.match(result.content, /src\/ui\/collaboration-hall\.ts/);
  assert.equal(result.chainDirective?.nextAction, "continue");
  assert.match(result.chainDirective?.nextStep ?? "", /完整可口播的视频开头/);
});

test("visible completed handoff wins over hidden blocked structured state when the deliverable is already posted", async () => {
  const result = await dispatchHallRuntimeTurn({
    client: {
      agentRun: async () => ({
        ok: true,
        text: [
          "开头我先给到这 3 个可直接口播的版本：",
          "“你有没有发现，大多数 AI 工具都只能一对一聊天，但真正的工作不是这样发生的。”",
          "“如果 AI 只能陪你单聊，它更像一个聪明搜索框；但如果 AI 能群聊，事情就开始不一样了。”",
          "“我最近越来越确定一件事：下一代 AI 产品的差距，不会只是谁模型更多，而是谁先把‘协作’做对。”",
          "@Coq-每日新闻 你接着按这 3 个开头各出一个网页版 thumbnail，直接给我 URL。",
          '<hall-structured>{"nextAction":"blocked","blockers":["still need related info"],"requiresInputFrom":["main"]}</hall-structured>',
        ].join("\n"),
        rawText: "",
      }),
    } as never,
    hall: {
      hallId: "hall",
      participants: [
        {
          participantId: "main",
          displayName: "main",
          semanticRole: "manager",
          aliases: [],
          active: true,
        },
        {
          participantId: "coq",
          displayName: "Coq-每日新闻",
          semanticRole: "planner",
          aliases: [],
          active: true,
        },
      ],
      updatedAt: new Date().toISOString(),
    } as never,
    taskCard: {
      taskCardId: "card",
      hallId: "hall",
      projectId: "project",
      taskId: "task",
      title: "我想要做一个视频 介绍我的群聊功能",
      description: "我想要做一个视频 介绍我的群聊功能",
      status: "in_progress",
      currentOwnerParticipantId: "main",
      currentOwnerLabel: "main",
      doneWhen: "三个开头的想法",
      plannedExecutionOrder: ["coq"],
      plannedExecutionItems: [
        {
          itemId: "draft-coq",
          participantId: "coq",
          task: "根据三个开头做网页版 thumbnail 并给 URL",
          handoffToParticipantId: "main",
          handoffWhen: "网页版 thumbnail 和 URL",
        },
      ],
      currentExecutionItem: {
        itemId: "draft-main",
        participantId: "main",
        task: "根据群聊功能 给我三个开头的想法",
        handoffToParticipantId: "coq",
        handoffWhen: "三个开头的想法",
      },
      blockers: [],
      requiresInputFrom: [],
      mentionedParticipantIds: [],
      sessionKeys: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    participant: {
      participantId: "main",
      displayName: "main",
      semanticRole: "manager",
      aliases: [],
      active: true,
    } as never,
    mode: "handoff",
    handoff: {
      fromParticipantId: "pandas",
      fromLabel: "pandas",
      toParticipantId: "main",
      toLabel: "main",
      goal: "根据群聊功能 给我三个开头的想法",
      currentResult: "已基于代码和线程主线收住群聊功能要强调的价值。",
      doneWhen: "三个开头的想法",
      blockers: [],
      requiresInputFrom: [],
      artifactRefs: [],
    } as never,
  });

  assert.match(result.content, /开头我先给到这 3 个可直接口播的版本/);
  assert.match(result.content, /@Coq-每日新闻/);
  assert.equal(result.chainDirective?.nextAction, "handoff");
  assert.equal(result.taskCardPatch?.blockers, undefined);
  assert.equal(result.taskCardPatch?.requiresInputFrom, undefined);
});

test("long spoken openings plus an explicit handoff still win over hidden blocked structured state", async () => {
  const result = await dispatchHallRuntimeTurn({
    client: {
      agentRun: async () => ({
        ok: true,
        text: [
          "这 3 个开头先锁住：",
          "“你有没有发现，AI 产品大多还停留在一对一聊天，但真实工作从来不是一个人自言自语。一个任务进来之后，需要有人判断方向，有人拆解执行，有人补内容，有人盯风险。我做的这个群聊功能，核心不是把几个 agent 放进一个房间，而是让它们围着同一件事持续协作，把讨论一路推进成下一步可执行动作。”",
          "“很多 AI 工具看起来很聪明，但一遇到复杂任务就容易散。因为它只能回答，不能协作；只能单聊，不能接力。我的群聊功能就是在补这一层：把 planner，builder，reviewer，manager 这些角色放进同一个 hall 里，让任务不是聊完就没了，而是会被继续分派，继续执行，继续往结果走。”",
          "“我最近越来越确定，下一代 AI 产品拼的不是谁接了更多模型，而是谁先把协作链路做出来。单个 agent 再强，也容易卡在上下文混乱和责任不清。但如果一组 agent 能在同一个群聊里接住同一个任务，讨论，交接，执行就会变成一条连续链路。这就是我做这个功能的原因。”",
          "@monkey 你接着做网页生成对应的三个 thumbnail，给我三个 URL。",
          '<hall-structured>{"nextAction":"blocked","blockers":["still need related info"],"requiresInputFrom":["main"]}</hall-structured>',
        ].join("\n"),
        rawText: "",
      }),
    } as never,
    hall: {
      hallId: "hall",
      participants: [
        {
          participantId: "main",
          displayName: "main",
          semanticRole: "manager",
          aliases: [],
          active: true,
        },
        {
          participantId: "monkey",
          displayName: "monkey",
          semanticRole: "coder",
          aliases: [],
          active: true,
        },
      ],
      updatedAt: new Date().toISOString(),
    } as never,
    taskCard: {
      taskCardId: "card",
      hallId: "hall",
      projectId: "project",
      taskId: "task",
      title: "我想要做一个视频 介绍我的群聊功能",
      description: "我想要做一个视频 介绍我的群聊功能",
      status: "in_progress",
      currentOwnerParticipantId: "main",
      currentOwnerLabel: "main",
      doneWhen: "三个不同的视频开头",
      plannedExecutionOrder: ["monkey"],
      plannedExecutionItems: [
        {
          itemId: "draft-monkey",
          participantId: "monkey",
          task: "做网页生成对应的三个 thumbnail，给我三个 URL",
          handoffToParticipantId: "main",
          handoffWhen: "三个 thumbnail URL",
        },
      ],
      currentExecutionItem: {
        itemId: "draft-main",
        participantId: "main",
        task: "根据功能总结 生成三个不同的视频开头",
        handoffToParticipantId: "monkey",
        handoffWhen: "三个不同的视频开头",
      },
      blockers: [],
      requiresInputFrom: [],
      mentionedParticipantIds: [],
      sessionKeys: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    participant: {
      participantId: "main",
      displayName: "main",
      semanticRole: "manager",
      aliases: [],
      active: true,
    } as never,
    mode: "handoff",
    handoff: {
      fromParticipantId: "pandas",
      fromLabel: "pandas",
      toParticipantId: "main",
      toLabel: "main",
      goal: "根据功能总结 生成三个不同的视频开头",
      currentResult: "已基于功能总结收口成适合视频拍摄的表达。",
      doneWhen: "三个不同的视频开头",
      blockers: [],
      requiresInputFrom: [],
      artifactRefs: [],
    } as never,
  });

  assert.match(result.content, /这 3 个开头先锁住/);
  assert.match(result.content, /@monkey/);
  assert.equal(result.chainDirective?.nextAction, "handoff");
  assert.equal(result.taskCardPatch?.blockers, undefined);
  assert.equal(result.taskCardPatch?.requiresInputFrom, undefined);
});

test("long spoken openings that end in review still win over hidden blocked structured state", async () => {
  const result = await dispatchHallRuntimeTurn({
    client: {
      agentRun: async () => ({
        ok: true,
        text: [
          "这 3 个开头我直接给你可口播版：",
          "“很多 AI 产品看起来很聪明，但真正做事的时候还是会卡住。因为它只能陪你聊天，不能替你把事情往前推。我做这个群聊功能，最核心的不是让多个 agent 一起说话，而是让一个任务进来之后，系统直接帮你把讨论收成明确下一步，然后继续推进到执行。”",
          "“我后来越来越不满意一类 AI 产品，就是它什么都能回答，但什么都推不动。你聊了半天，最后还是得你自己来决定谁做，怎么做，先做哪一步。所以我做了这个群聊功能。它最重要的不是把多个 agent 放进同一个房间，而是把一个任务从模糊讨论，直接推进成明确 owner，明确 next action，然后进入执行状态。”",
          "“如果 AI 群聊只是让几个 agent 一起发消息，那它其实没比普通聊天强多少。真正有价值的是，这个群聊能不能帮你省掉最后那一下协调。也就是不用你再自己收尾，不用你再自己判断谁接手，系统就已经把任务整理成下一步了。这就是我做这个功能的核心：表面上是群聊，本质上是任务推进器。”",
          "现在请老板评审。",
          '<hall-structured>{"nextAction":"blocked","blockers":["still need related info"],"requiresInputFrom":["main"]}</hall-structured>',
        ].join("\n"),
        rawText: "",
      }),
    } as never,
    hall: {
      hallId: "hall",
      participants: [
        {
          participantId: "monkey",
          displayName: "monkey",
          semanticRole: "coder",
          aliases: [],
          active: true,
        },
        {
          participantId: "main",
          displayName: "main",
          semanticRole: "manager",
          aliases: [],
          active: true,
        },
      ],
      updatedAt: new Date().toISOString(),
    } as never,
    taskCard: {
      taskCardId: "card",
      hallId: "hall",
      projectId: "project",
      taskId: "task",
      title: "我想要做一个视频 介绍我的群聊功能",
      description: "我想要做一个视频 介绍我的群聊功能",
      status: "in_progress",
      currentOwnerParticipantId: "monkey",
      currentOwnerLabel: "monkey",
      doneWhen: "三个不同的视频开头",
      plannedExecutionOrder: [],
      plannedExecutionItems: [],
      currentExecutionItem: {
        itemId: "draft-monkey",
        participantId: "monkey",
        task: "给我三个不同的视频开头",
        handoffToParticipantId: "main",
        handoffWhen: "三个不同的视频开头",
      },
      blockers: [],
      requiresInputFrom: [],
      mentionedParticipantIds: [],
      sessionKeys: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    participant: {
      participantId: "monkey",
      displayName: "monkey",
      semanticRole: "coder",
      aliases: [],
      active: true,
    } as never,
    mode: "execution",
  });

  assert.match(result.content, /这 3 个开头我直接给你可口播版/);
  assert.equal(result.chainDirective?.nextAction, "handoff");
  assert.equal(result.taskCardPatch?.blockers, undefined);
  assert.equal(result.taskCardPatch?.requiresInputFrom, undefined);
});

test("execution does not accept the wrong deliverable type just because it is concrete", async () => {
  const result = await dispatchHallRuntimeTurn({
    client: {
      agentRun: async () => ({
        ok: true,
        text: [
          "三个网页 thumbnail 我先给到这：",
          THUMBNAIL_HALL_1_URL,
          THUMBNAIL_HALL_2_URL,
          THUMBNAIL_HALL_3_URL,
          "@Coq-每日新闻 你接着看这三张的标题和文案力度，帮我挑最适合视频首屏的一版。",
        ].join("\n"),
        rawText: "",
      }),
    } as never,
    hall: {
      hallId: "hall",
      participants: [
        {
          participantId: "main",
          displayName: "main",
          semanticRole: "manager",
          aliases: [],
          active: true,
        },
        {
          participantId: "coq",
          displayName: "Coq-每日新闻",
          semanticRole: "planner",
          aliases: [],
          active: true,
        },
      ],
      updatedAt: new Date().toISOString(),
    } as never,
    taskCard: {
      taskCardId: "card",
      hallId: "hall",
      projectId: "project",
      taskId: "task",
      title: "我想要做一个视频 介绍我的群聊功能",
      description: "我想要做一个视频 介绍我的群聊功能",
      status: "in_progress",
      currentOwnerParticipantId: "main",
      currentOwnerLabel: "main",
      latestSummary: "先根据功能总结给出三个视频开头。",
      doneWhen: "三个视频开头",
      plannedExecutionOrder: ["coq"],
      plannedExecutionItems: [
        {
          itemId: "draft-coq",
          participantId: "coq",
          task: "给我三个对应的thumbail吧 用网页做 给我url",
          handoffToParticipantId: "",
          handoffWhen: "三个对应的thumbail吧 用网页做 给我url",
        },
      ],
      currentExecutionItem: {
        itemId: "draft-main",
        participantId: "main",
        task: "给我三个开头吧",
        handoffToParticipantId: "coq",
        handoffWhen: "三个视频开头",
      },
      blockers: [],
      requiresInputFrom: [],
      mentionedParticipantIds: [],
      sessionKeys: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    participant: {
      participantId: "main",
      displayName: "main",
      semanticRole: "manager",
      aliases: [],
      active: true,
    } as never,
    mode: "handoff",
    handoff: {
      fromParticipantId: "pandas",
      fromLabel: "pandas",
      toParticipantId: "main",
      toLabel: "main",
      goal: "给我三个开头吧",
      currentResult: "已把功能总结收住。",
      doneWhen: "三个视频开头",
      blockers: [],
      requiresInputFrom: [],
      artifactRefs: [],
    } as never,
  });

  assert.match(result.content, /thumbnail/);
  assert.equal(result.kind, "status");
  assert.equal(result.chainDirective?.nextAction, "continue");
  assert.match(result.chainDirective?.nextStep ?? "", /完整可口播|视频开头|开头/);
  assert.equal(result.taskCardPatch?.latestSummary, "先根据功能总结给出三个视频开头。");
});

test("repo scan findings plus an explicit handoff still win over hidden blocked structured state", async () => {
  const result = await dispatchHallRuntimeTurn({
    client: {
      agentRun: async () => ({
        ok: true,
        text: [
          "我先把 repo 里最关键的 3 个入口扫出来：",
          "1. src/ui/collaboration-hall.ts：前台任务卡、消息流、执行控制台都在这里拼装。",
          "2. src/runtime/collaboration-hall-orchestrator.ts：discussion queue、handoff、execution lock 都在这里推进。",
          "3. src/runtime/hall-runtime-dispatch.ts：把 hall 里的收口结果转成 runtime 执行和可见回复。",
          "@otter 你接着只挑 must-fix，看看这里还有没有会让用户误解的地方。",
          '<hall-structured>{"nextAction":"blocked","blockers":["still need related info"],"requiresInputFrom":["pandas"]}</hall-structured>',
        ].join("\n"),
        rawText: "",
      }),
    } as never,
    hall: {
      hallId: "hall",
      participants: [
        { participantId: "pandas", displayName: "pandas", semanticRole: "coder", aliases: [], active: true },
        { participantId: "otter", displayName: "otter", semanticRole: "reviewer", aliases: [], active: true },
      ],
      updatedAt: new Date().toISOString(),
    } as never,
    taskCard: {
      taskCardId: "card",
      hallId: "hall",
      projectId: "project",
      taskId: "task",
      title: "请先扫描 control-center 代码",
      description: "请先扫描 control-center 代码",
      status: "in_progress",
      currentOwnerParticipantId: "pandas",
      currentOwnerLabel: "pandas",
      doneWhen: "3 个关键入口文件和职责",
      plannedExecutionOrder: ["otter"],
      plannedExecutionItems: [
        {
          itemId: "draft-otter",
          participantId: "otter",
          task: "只挑 must-fix",
          handoffToParticipantId: "pandas",
          handoffWhen: "must-fix 结论",
        },
      ],
      currentExecutionItem: {
        itemId: "draft-pandas",
        participantId: "pandas",
        task: "扫描代码并找出 3 个关键入口文件",
        handoffToParticipantId: "otter",
        handoffWhen: "3 个关键入口文件和职责",
      },
      blockers: [],
      requiresInputFrom: [],
      mentionedParticipantIds: [],
      sessionKeys: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    participant: {
      participantId: "pandas",
      displayName: "pandas",
      semanticRole: "coder",
      aliases: [],
      active: true,
    } as never,
    mode: "handoff",
    handoff: {
      fromParticipantId: "main",
      fromLabel: "main",
      toParticipantId: "pandas",
      toLabel: "pandas",
      goal: "扫描代码并找出 3 个关键入口文件",
      currentResult: "已经把 repo 主线收紧成可继续执行的问题。",
      doneWhen: "3 个关键入口文件和职责",
      blockers: [],
      requiresInputFrom: [],
      artifactRefs: [],
    } as never,
  });

  assert.match(result.content, /src\/ui\/collaboration-hall\.ts/);
  assert.match(result.content, /@otter/);
  assert.equal(result.chainDirective?.nextAction, "handoff");
  assert.equal(result.taskCardPatch?.blockers, undefined);
  assert.equal(result.taskCardPatch?.requiresInputFrom, undefined);
});

test("hook deliverables plus an explicit handoff still win over hidden blocked structured state", async () => {
  const result = await dispatchHallRuntimeTurn({
    client: {
      agentRun: async () => ({
        ok: true,
        text: [
          "3 个 hook 先锁住：",
          "1. 不是多了个群聊，是任务自己开始往前走了。",
          "2. 你不用再一个个催了，谁做什么会自己冒出来。",
          "3. 聊天不会停在群里，事情会继续往下执行。",
          "@pandas 你接着把这 3 个 hook 扩成首屏文案。",
          '<hall-structured>{"nextAction":"blocked","blockers":["still need related info"],"requiresInputFrom":["monkey"]}</hall-structured>',
        ].join("\n"),
        rawText: "",
      }),
    } as never,
    hall: {
      hallId: "hall",
      participants: [
        { participantId: "monkey", displayName: "monkey", semanticRole: "coder", aliases: [], active: true },
        { participantId: "pandas", displayName: "pandas", semanticRole: "coder", aliases: [], active: true },
      ],
      updatedAt: new Date().toISOString(),
    } as never,
    taskCard: {
      taskCardId: "card",
      hallId: "hall",
      projectId: "project",
      taskId: "task",
      title: "我想要做一个视频 介绍我的群聊功能",
      description: "我想要做一个视频 介绍我的群聊功能",
      status: "in_progress",
      currentOwnerParticipantId: "monkey",
      currentOwnerLabel: "monkey",
      doneWhen: "3 个 hook",
      plannedExecutionOrder: ["pandas"],
      plannedExecutionItems: [
        {
          itemId: "draft-pandas",
          participantId: "pandas",
          task: "把 3 个 hook 扩成首屏文案",
          handoffToParticipantId: "main",
          handoffWhen: "首屏文案",
        },
      ],
      currentExecutionItem: {
        itemId: "draft-monkey",
        participantId: "monkey",
        task: "给 3 个 hook",
        handoffToParticipantId: "pandas",
        handoffWhen: "3 个 hook",
      },
      blockers: [],
      requiresInputFrom: [],
      mentionedParticipantIds: [],
      sessionKeys: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    participant: {
      participantId: "monkey",
      displayName: "monkey",
      semanticRole: "coder",
      aliases: [],
      active: true,
    } as never,
    mode: "handoff",
    handoff: {
      fromParticipantId: "main",
      fromLabel: "main",
      toParticipantId: "monkey",
      toLabel: "monkey",
      goal: "给 3 个 hook",
      currentResult: "方向已经收口到群聊功能的卖点。",
      doneWhen: "3 个 hook",
      blockers: [],
      requiresInputFrom: [],
      artifactRefs: [],
    } as never,
  });

  assert.match(result.content, /3 个 hook 先锁住/);
  assert.match(result.content, /@pandas/);
  assert.equal(result.chainDirective?.nextAction, "handoff");
  assert.equal(result.taskCardPatch?.blockers, undefined);
  assert.equal(result.taskCardPatch?.requiresInputFrom, undefined);
});

test("explicit @pandas repo scan request in discussion hides abstract summaries until concrete file findings appear", async () => {
  const result = await dispatchHallRuntimeTurn({
    client: {
      agentRun: async () => ({
        ok: true,
        text: "群聊功能已经收清了：它把讨论、分工、owner 收口和 next action 串成一个可见推进线程。",
        rawText: "",
      }),
    } as never,
    hall: {
      hallId: "hall",
      participants: [
        {
          participantId: "pandas",
          displayName: "pandas",
          semanticRole: "coder",
          aliases: [],
          active: true,
        },
      ],
      updatedAt: new Date().toISOString(),
    } as never,
    taskCard: {
      taskCardId: "card",
      hallId: "hall",
      projectId: "project",
      taskId: "task",
      title: "请先扫描 control-center 代码",
      description: "请先扫描 control-center 代码",
      status: "todo",
      plannedExecutionOrder: [],
      plannedExecutionItems: [],
      mentionedParticipantIds: [],
      sessionKeys: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    participant: {
      participantId: "pandas",
      displayName: "pandas",
      semanticRole: "coder",
      aliases: [],
      active: true,
    } as never,
    triggerMessage: {
      hallId: "hall",
      messageId: "trigger",
      kind: "chat",
      authorParticipantId: "operator",
      authorLabel: "Operator",
      content: "@pandas 去扫一下 control-center 代码，然后告诉我 hall-chat 的 3 个关键入口文件。",
      targetParticipantIds: ["pandas"],
      mentionTargets: [{ participantId: "pandas" }],
      createdAt: new Date().toISOString(),
    } as never,
    mode: "discussion",
  });

  assert.equal(result.suppressVisibleMessage, undefined);
  assert.match(result.content, /群聊功能已经收清了/);
  assert.equal(result.chainDirective?.nextAction, "continue");
});

test("brand-new untargeted repo scan asks still start with normal discussion instead of strict direct-deliverable mode", async () => {
  let capturedPrompt = "";
  const result = await dispatchHallRuntimeTurn({
    client: {
      agentRun: async (request: { message: string }) => {
        capturedPrompt = request.message;
        return {
          ok: true,
          text: "先把入口收成三层：UI、orchestrator、runtime，再决定执行顺序。",
          rawText: "",
        };
      },
    } as never,
    hall: {
      hallId: "hall",
      participants: [
        {
          participantId: "coq",
          displayName: "Coq-每日新闻",
          semanticRole: "planner",
          aliases: [],
          active: true,
        },
      ],
      updatedAt: new Date().toISOString(),
    } as never,
    taskCard: {
      taskCardId: "card",
      hallId: "hall",
      projectId: "project",
      taskId: "task",
      title: "请先扫描 control-center 代码",
      description: "请先扫描 control-center 代码",
      status: "todo",
      plannedExecutionOrder: [],
      plannedExecutionItems: [],
      mentionedParticipantIds: [],
      sessionKeys: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    participant: {
      participantId: "coq",
      displayName: "Coq-每日新闻",
      semanticRole: "planner",
      aliases: [],
      active: true,
    } as never,
    triggerMessage: {
      hallId: "hall",
      messageId: "trigger",
      kind: "chat",
      authorParticipantId: "operator",
      authorLabel: "Operator",
      content: "请先扫描 control-center 代码，找出 hall-chat 的 3 个关键入口文件，并说明每个文件负责什么。",
      createdAt: new Date().toISOString(),
    } as never,
    recentThreadMessages: [],
    mode: "discussion",
  });

  assert.doesNotMatch(capturedPrompt, /Direct ask you must satisfy now/i);
  assert.doesNotMatch(capturedPrompt, /Prioritize this current ask over your default semantic role/i);
  assert.equal(result.suppressVisibleMessage, undefined);
  assert.match(result.content, /UI、orchestrator、runtime/);
});


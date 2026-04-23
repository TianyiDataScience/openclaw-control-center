import { setTimeout as delay } from "node:timers/promises";
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { ensureHallTaskWorkspace, resolveHallTaskWorkspacePath } from "./hall-workspace";
import { copyHallFilesToWorkspace } from "./hall-file-store";
import type { ToolClient } from "../clients/tool-client";
import {
  HALL_RUNTIME_DIRECT_STREAM_ENABLED,
  HALL_RUNTIME_DISPATCH_ENABLED,
  HALL_RUNTIME_HISTORY_LIMIT,
  HALL_RUNTIME_POLL_INTERVAL_MS,
  HALL_RUNTIME_THINKING_LEVEL,
  HALL_RUNTIME_TIMEOUT_SECONDS,
} from "../config";
import type { AgentRunRequest, AgentRunTransportContext } from "../contracts/openclaw-tools";
import type {
  CollaborationHall,
  HallExecutionItem,
  HallMessage,
  HallParticipant,
  HallSemanticRole,
  HallTaskCard,
  ProjectTask,
  StructuredHandoffPacket,
  TaskArtifact,
} from "../types";
import {
  isHallDraftCanceled,
  beginHallDraftReply,
  completeHallDraftReply,
  pushHallDraftDelta,
  pushHallDraftToolUpdate,
} from "./collaboration-stream";
import { resolveOpenClawConfigPath, resolveOpenClawHomePath } from "./current-agent-catalog";
import { inferHallDiscussionDomainFromText } from "./hall-discussion-domain";
import { resolveOpenClawAgentWorkspaceRoot } from "./openclaw-workspace-root";
import { readSessionConversationHistory, type SessionHistoryMessage } from "./session-conversations";

interface ToolClientWithAgentRun extends ToolClient {
  agentRun?(request: AgentRunRequest): Promise<{
    ok: boolean;
    text: string;
    rawText: string;
    sessionKey?: string;
    sessionId?: string;
    model?: string;
  }>;
  agentRunStream?(
    request: AgentRunRequest,
    handlers?: {
      onStdoutChunk?: (chunk: string) => void;
      onStderrChunk?: (chunk: string) => void;
    },
  ): Promise<{
    ok: boolean;
    text: string;
    rawText: string;
    sessionKey?: string;
    sessionId?: string;
    model?: string;
  }>;
}

export type HallRuntimeNextAction = "continue" | "review" | "handoff" | "done" | "parallel_dispatch";

export interface HallParallelTaskTarget {
  executor: string;
  task: string;
}

export interface HallRuntimeChainDirective {
  nextAction?: HallRuntimeNextAction;
  nextStep?: string;
  executor?: string;
  parallelTasks?: HallParallelTaskTarget[];
}

export interface HallRuntimeDispatchInput {
  client: ToolClient;
  hall: CollaborationHall;
  taskCard: HallTaskCard;
  participant: HallParticipant;
  task?: ProjectTask;
  triggerMessage?: HallMessage;
  recentThreadMessages?: HallMessage[];
  mode: "discussion" | "execution" | "handoff";
  handoff?: StructuredHandoffPacket;
  note?: string;
}

export interface HallRuntimeDispatchResult {
  kind: HallMessage["kind"];
  content: string;
  canceled?: boolean;
  suppressVisibleMessage?: boolean;
  payload?: HallMessage["payload"];
  sessionKey?: string;
  sessionId?: string;
  chainDirective?: HallRuntimeChainDirective;
  taskCardPatch?: {
    proposal?: string;
    decision?: string;
    doneWhen?: string;
    currentOwnerParticipantId?: string;
    currentOwnerLabel?: string;
    blockers?: string[];
    requiresInputFrom?: string[];
    latestSummary?: string;
  };
}

interface ConcreteDeliverableEnforcement {
  content: string;
  nextAction?: HallRuntimeNextAction;
  suppressVisibleMessage?: boolean;
  nextStep?: string;
  messageKindOverride?: HallMessage["kind"];
  preserveExistingSummary?: boolean;
}

type HallOperatorIntentType =
  | "discussion_request"
  | "direct_deliverable_request"
  | "repo_scan_request"
  | "review_request"
  | "planning_request"
  | "control_request";

interface HallOperatorIntent {
  type: HallOperatorIntentType;
  text: string;
  explicitTarget: boolean;
}

type ConcreteDeliverableKind =
  | "repo_scan"
  | "review"
  | "thumbnail_urls"
  | "thumbnail_ideas"
  | "spoken_openings"
  | "hooks"
  | "script"
  | "generic";

interface ParsedStructuredBlock {
  proposal?: string;
  decision?: string;
  executor?: string;
  doneWhen?: string;
  blockers?: string[];
  requiresInputFrom?: string[];
  latestSummary?: string;
  nextAction?: HallRuntimeNextAction;
  nextStep?: string;
  artifactRefs?: TaskArtifact[];
  parallelTasks?: HallParallelTaskTarget[];
}

interface HallRuntimeRepoContext {
  lines: string[];
  entryFiles: string[];
}

type HallResponseLanguage = "zh" | "en";

const CONTROL_CENTER_REPO_ROOT = process.cwd();
const OPENCLAW_HOME_DIR = resolveOpenClawHomePath();
const OPENCLAW_CONFIG_PATH = resolveOpenClawConfigPath();
const CONTROL_CENTER_REPO_ENTRY_FILES = [
  "src/ui/collaboration-hall.ts",
  "src/ui/collaboration-hall-theme.ts",
  "src/ui/server.ts",
  "src/runtime/collaboration-hall-orchestrator.ts",
  "src/runtime/hall-runtime-dispatch.ts",
  "src/types.ts",
];
const HALL_RULES_OVERRIDE_ENV = "OPENCLAW_HALL_RULES_PATH";
const HALL_RULES_DEFAULT_FILE = "HALL.md";
const HALL_RULES_MAX_CHARS = 6_000;
const HALL_REPO_CONTEXT_MAX_FILE_CHARS = 1_600;
const HALL_REPO_CONTEXT_MAX_TOTAL_CHARS = 7_200;
const HALL_WORKSPACE_PERSONA_FILES = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "README.md"];
const HALL_WORKSPACE_PERSONA_CACHE = new Map<string, string>();

export function canDispatchHallToRuntime(client: ToolClient | undefined, participant: HallParticipant): client is ToolClientWithAgentRun {
  return Boolean(
    HALL_RUNTIME_DISPATCH_ENABLED &&
      client &&
      participant.active &&
      (participant.agentId ?? participant.participantId).trim() &&
      (typeof client.agentRun === "function" || typeof client.agentRunStream === "function"),
  );
}

// ---------------------------------------------------------------------------
// Per-sessionKey dispatch serialization — same hall thread cannot have two turns
// in flight simultaneously. Cross-thread concurrency is arbitrated by OpenClaw's
// per-workspace lock on the gateway side.
// ---------------------------------------------------------------------------
const dispatchChains = new Map<string, Promise<unknown>>();

export function dispatchHallRuntimeTurn(input: HallRuntimeDispatchInput): Promise<HallRuntimeDispatchResult> {
  const agentId = (input.participant.agentId ?? input.participant.participantId).trim();
  const sessionKey = pickExpectedSessionKey(input.taskCard, agentId) ?? `agent:${agentId}`;
  const prev = dispatchChains.get(sessionKey) ?? Promise.resolve();
  const result: Promise<HallRuntimeDispatchResult> = prev.then(() => dispatchHallRuntimeTurnUnsafe(input));
  dispatchChains.set(sessionKey, result.catch(() => undefined));
  return result;
}

async function dispatchHallRuntimeTurnUnsafe(input: HallRuntimeDispatchInput): Promise<HallRuntimeDispatchResult> {
  const participantAgentId = (input.participant.agentId ?? input.participant.participantId).trim();
  if (!canDispatchHallToRuntime(input.client, input.participant)) {
    throw new Error(`Runtime dispatch is unavailable for participant '${input.participant.displayName}'.`);
  }

  const expectedSessionKey = pickExpectedSessionKey(input.taskCard, participantAgentId);
  const draftId = beginHallDraftReply({
    hallId: input.hall.hallId,
    taskCardId: input.taskCard.taskCardId,
    projectId: input.taskCard.projectId,
    taskId: input.taskCard.taskId,
    roomId: input.taskCard.roomId,
    authorParticipantId: input.participant.participantId,
    authorLabel: input.participant.displayName,
    authorSemanticRole: input.participant.semanticRole,
    messageKind: resolveHallRuntimeMessageKind(input),
    content: "",
  });

  let currentSessionKey = expectedSessionKey;
  let baselineFingerprint: string | undefined;
  let lastStreamedText = "";
  let lastHistoryDraftText = "";
  let sessionHistoryObserved = false;
  let directStdoutBuffer = "";
  let finished = false;
  let processedStdoutToolCount = 0;
  let processedHistoryToolCount = 0;
  // Wall-clock snapshot used to tell "this run's tool calls" apart from earlier
  // tool calls that share the same session file (hall sessions accumulate turns).
  // findLatestAgentSessionFile(agentId) is fuzzy and may initially resolve to an
  // unrelated hall card's session, so a count-based baseline is unreliable.
  const runStartMs = Date.now();

  const TOOL_LINE_PATTERN = /\[tool\]\s+(.+?)\s+\((\w+)\)/g;

  const flushStdoutToolLines = (): void => {
    const matches: Array<{ name: string; status: string }> = [];
    let m: RegExpExecArray | null;
    const re = new RegExp(TOOL_LINE_PATTERN.source, "g");
    while ((m = re.exec(directStdoutBuffer)) !== null) {
      matches.push({ name: m[1], status: m[2] });
    }
    for (let i = processedStdoutToolCount; i < matches.length; i++) {
      pushHallDraftToolUpdate({
        hallId: input.hall.hallId,
        taskCardId: input.taskCard.taskCardId,
        projectId: input.taskCard.projectId,
        taskId: input.taskCard.taskId,
        roomId: input.taskCard.roomId,
        draftId,
        toolName: matches[i].name,
        toolStatus: matches[i].status,
      });
    }
    processedStdoutToolCount = matches.length;
  };

  let sessionFileToolCount = 0;
  let baselineSessionFileToolCount = 0;
  let historyToolCount = 0;

  const emitToolUpdate = (toolName: string, toolStatus: string): void => {
    pushHallDraftToolUpdate({
      hallId: input.hall.hallId,
      taskCardId: input.taskCard.taskCardId,
      projectId: input.taskCard.projectId,
      taskId: input.taskCard.taskId,
      roomId: input.taskCard.roomId,
      draftId,
      toolName,
      toolStatus,
    });
  };

  const flushHistoryToolEvents = (messages: SessionHistoryMessage[]): void => {
    const toolEvents = messages.filter((m) => m.kind === "tool_event" && m.toolName);
    for (let i = historyToolCount; i < toolEvents.length; i++) {
      emitToolUpdate(toolEvents[i].toolName!, toolEvents[i].toolStatus || "completed");
    }
    historyToolCount = toolEvents.length;
  };

  const applyDraftText = (nextDraftText: string, source: "session" | "stdout"): void => {
    const normalized = formatHallRuntimeDraftVisibleText(input, nextDraftText).trim();
    if (!normalized) return;
    if (normalized.length <= lastStreamedText.length) return;
    if (lastStreamedText && !normalized.startsWith(lastStreamedText)) {
      if (source === "stdout" && !sessionHistoryObserved) {
        lastStreamedText = "";
      } else {
        return;
      }
    }
    const delta = normalized.slice(lastStreamedText.length);
    if (!delta) return;
    lastStreamedText = normalized;
    pushHallDraftDelta({
      hallId: input.hall.hallId,
      taskCardId: input.taskCard.taskCardId,
      projectId: input.taskCard.projectId,
      taskId: input.taskCard.taskId,
      roomId: input.taskCard.roomId,
      draftId,
      authorParticipantId: input.participant.participantId,
      authorLabel: input.participant.displayName,
      authorSemanticRole: input.participant.semanticRole,
      messageKind: resolveHallRuntimeMessageKind(input),
      delta,
    });
  };

  let poller: Promise<void> | undefined;
  try {
    const baselineHistory = expectedSessionKey
      ? await safeReadHistory(input.client, expectedSessionKey)
      : [];
    baselineFingerprint = baselineHistory.at(-1) ? fingerprintHistoryMessage(baselineHistory.at(-1)!) : undefined;
    await ensureHallTaskWorkspace(input.taskCard.taskCardId);
    const repoContext = buildHallRuntimeRepoContext(input);
    const prompt = buildHallRuntimePrompt(input, repoContext);
    const flushHistory = async (sessionKey: string | undefined): Promise<void> => {
      if (!sessionKey) return;
      const history = await safeReadHistory(input.client, sessionKey);
      flushHistoryToolEvents(sliceMessagesAfterFingerprint(history, baselineFingerprint));
      const nextDraftText = renderRuntimeDraftText(history, baselineFingerprint);
      if (!nextDraftText) return;
      lastHistoryDraftText = nextDraftText;
      sessionHistoryObserved = true;
      applyDraftText(nextDraftText, "session");
    };

    // Resolve session file and baseline tool count BEFORE agent starts
    let resolvedSessionFilePath = await findLatestAgentSessionFile(participantAgentId).catch(() => undefined);
    if (resolvedSessionFilePath) {
      try {
        const baseline = await readFile(resolvedSessionFilePath, "utf8");
        for (const line of baseline.split("\n")) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            const msg = entry?.message;
            if (msg && typeof msg === "object" && typeof msg.role === "string" && msg.role.toLowerCase().includes("tool")) {
              sessionFileToolCount++;
            }
          } catch { /* skip */ }
        }
        baselineSessionFileToolCount = sessionFileToolCount;
      } catch { /* ok */ }
    }

    let sessionFileRescanCounter = 0;

    const pollSessionFileToolCalls = async (): Promise<void> => {
      // Re-resolve session file periodically (agent may create a new one)
      sessionFileRescanCounter++;
      if (!resolvedSessionFilePath || sessionFileRescanCounter % 8 === 0) {
        const latest = await findLatestAgentSessionFile(participantAgentId).catch(() => undefined);
        if (latest && latest !== resolvedSessionFilePath) {
          resolvedSessionFilePath = latest;
          sessionFileToolCount = 0; // Reset baseline for new file
        }
      }
      if (!resolvedSessionFilePath) return;
      try {
        const raw = await readFile(resolvedSessionFilePath, "utf8");
        let currentCount = 0;
        // Collect toolCall arguments by callId for hover detail
        const toolCallArgs = new Map<string, string>();
        const newTools: Array<{ name: string; detail: string }> = [];
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            const msg = entry?.message;
            if (!msg || typeof msg !== "object") continue;
            // Extract toolCall arguments from assistant messages
            const content = msg.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block && block.type === "toolCall" && block.id && block.arguments) {
                  const args = block.arguments;
                  const summary = typeof args === "object"
                    ? Object.values(args).map((v) => String(v)).join(", ").slice(0, 120)
                    : String(args).slice(0, 120);
                  toolCallArgs.set(block.id, summary);
                }
              }
            }
            // Detect toolResult entries
            const role = typeof msg.role === "string" ? msg.role.toLowerCase() : "";
            if (role.includes("tool")) {
              currentCount++;
              if (currentCount > sessionFileToolCount) {
                const toolName = msg.toolName || msg.name || "tool";
                const callId = msg.toolCallId || "";
                const detail = toolCallArgs.get(callId) || "";
                emitToolUpdate(toolName, "completed");
                newTools.push({ name: toolName, detail });
              }
            }
          } catch { /* skip malformed */ }
        }
        sessionFileToolCount = Math.max(sessionFileToolCount, currentCount);
        // Inject tool markers into the draft text stream so they appear inline
        if (newTools.length > 0) {
          const toolMarkers = newTools.map((t) =>
            t.detail ? `[[tool:${t.name}|${t.detail}]]` : `[[tool:${t.name}]]`
          ).join("\n");
          const combined = (lastStreamedText ? lastStreamedText + "\n" : "") + toolMarkers;
          lastStreamedText = combined;
          pushHallDraftDelta({
            hallId: input.hall.hallId,
            taskCardId: input.taskCard.taskCardId,
            projectId: input.taskCard.projectId,
            taskId: input.taskCard.taskId,
            roomId: input.taskCard.roomId,
            draftId,
            authorParticipantId: input.participant.participantId,
            authorLabel: input.participant.displayName,
            authorSemanticRole: input.participant.semanticRole,
            messageKind: resolveHallRuntimeMessageKind(input),
            delta: "\n" + toolMarkers,
          });
        }
      } catch { /* file may not exist yet */ }
    };

    poller = (async () => {
      while (!finished) {
        try {
          await flushHistory(currentSessionKey);
          await pollSessionFileToolCalls();
        } catch {
          // Best-effort only; final completion still comes from agentRun().
        }
        await delay(HALL_RUNTIME_POLL_INTERVAL_MS);
      }
    })();
    const request: AgentRunRequest = {
      agentId: participantAgentId,
      sessionKey: expectedSessionKey,
      message: prompt,
      thinking: HALL_RUNTIME_THINKING_LEVEL,
      timeoutSeconds: HALL_RUNTIME_TIMEOUT_SECONDS,
      context: await buildHallRuntimeTransportContext(input, repoContext.entryFiles),
    };
    const response = input.client.agentRunStream && HALL_RUNTIME_DIRECT_STREAM_ENABLED
      ? await input.client.agentRunStream(request, {
          onStdoutChunk: (chunk) => {
            directStdoutBuffer += chunk;
            flushStdoutToolLines();
            if (sessionHistoryObserved) return;
            const directText = formatHallRuntimeDraftVisibleText(input, directStdoutBuffer);
            if (!directText) return;
            applyDraftText(directText, "stdout");
          },
        })
      : input.client.agentRun
        ? await input.client.agentRun(request)
        : await Promise.reject(new Error("No runtime dispatch method is available."));
    currentSessionKey = response.sessionKey?.trim() || expectedSessionKey;
    await flushHistory(currentSessionKey);

    // Final session file scan for any remaining tool events
    await pollSessionFileToolCalls().catch(() => {});

    const parsed = extractStructuredBlock(response.text);
    // Prefer response.text (the agent RPC's authoritative final synthesis) over
    // lastHistoryDraftText. History reads can race with the gateway's session-file
    // flush: the WS agent RPC resolves before the final assistant message lands
    // on disk, so renderRuntimeDraftText sometimes only sees the pre-tool
    // thinking block and buries the real answer under a "will do" preamble.
    const visibleContent = sanitizeHallVisibleRuntimeText(parsed.visibleText)
      || sanitizeHallVisibleRuntimeText(lastHistoryDraftText);
    const structured = parsed.structured;
    // Prefer the session file derived from response.sessionId — definitive and
    // robust against findLatestAgentSessionFile's fuzzy agent-wide scan which
    // can initially lock onto an unrelated hall card's jsonl.
    if (response.sessionId) {
      const definitivePath = join(
        resolveOpenClawHomePath(),
        "agents",
        participantAgentId,
        "sessions",
        `${response.sessionId}.jsonl`,
      );
      resolvedSessionFilePath = definitivePath;
    }
    // Collect ONLY this run's tool calls (entries written after runStartMs) for
    // the persisted message payload. Timestamp filtering is reliable even when
    // the session file is shared across turns of the same hall thread.
    const collectedToolCalls: Array<{ toolName: string; toolStatus: string; detail?: string }> = [];
    if (resolvedSessionFilePath) {
      try {
        const raw = await readFile(resolvedSessionFilePath, "utf8");
        const callArgs = new Map<string, string>();
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            const msg = entry?.message;
            if (!msg || typeof msg !== "object") continue;
            if (Array.isArray(msg.content)) {
              for (const block of msg.content) {
                if (block?.type === "toolCall" && block.id && block.arguments) {
                  const args = block.arguments;
                  callArgs.set(block.id, typeof args === "object"
                    ? Object.values(args).map((v) => String(v)).join(", ").slice(0, 120)
                    : String(args).slice(0, 120));
                }
              }
            }
            if (typeof msg.role === "string" && msg.role.toLowerCase().includes("tool")) {
              const tsValue = typeof msg.timestamp === "number"
                ? msg.timestamp
                : (typeof msg.timestamp === "string" ? Date.parse(msg.timestamp) : NaN);
              const entryMs = Number.isFinite(tsValue) ? (tsValue as number) : NaN;
              if (!Number.isFinite(entryMs) || entryMs >= runStartMs) {
                collectedToolCalls.push({
                  toolName: msg.toolName || msg.name || "tool",
                  toolStatus: "completed",
                  detail: callArgs.get(msg.toolCallId || "") || undefined,
                });
              }
            }
          } catch { /* skip */ }
        }
      } catch { /* ok */ }
    }
    const result = buildHallRuntimeResult({
      input,
      content: visibleContent,
      structured,
      sessionKey: currentSessionKey,
      sessionId: response.sessionId?.trim() || undefined,
      model: response.model?.trim() || undefined,
      toolCalls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined,
    });
    if (isHallDraftCanceled(draftId)) {
      return {
        ...result,
        canceled: true,
      };
    }
    completeHallDraftReply({
      hallId: input.hall.hallId,
      taskCardId: input.taskCard.taskCardId,
      projectId: input.taskCard.projectId,
      taskId: input.taskCard.taskId,
      roomId: input.taskCard.roomId,
      draftId,
      content: result.content,
    });
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown runtime error";
    const failureText = `Runtime dispatch failed: ${detail}`;
    if (isHallDraftCanceled(draftId)) {
      throw error;
    }
    if (failureText.length > lastStreamedText.length) {
      pushHallDraftDelta({
        hallId: input.hall.hallId,
        taskCardId: input.taskCard.taskCardId,
        projectId: input.taskCard.projectId,
        taskId: input.taskCard.taskId,
        roomId: input.taskCard.roomId,
        draftId,
        authorParticipantId: input.participant.participantId,
        authorLabel: input.participant.displayName,
        authorSemanticRole: input.participant.semanticRole,
        messageKind: resolveHallRuntimeMessageKind(input),
        delta: failureText.slice(lastStreamedText.length),
      });
    }
    completeHallDraftReply({
      hallId: input.hall.hallId,
      taskCardId: input.taskCard.taskCardId,
      projectId: input.taskCard.projectId,
      taskId: input.taskCard.taskId,
      roomId: input.taskCard.roomId,
      draftId,
      content: failureText,
    });
    throw error;
  } finally {
    finished = true;
    await poller?.catch(() => undefined);
  }
}

function buildHallRuntimePrompt(input: HallRuntimeDispatchInput, repoContext: HallRuntimeRepoContext): string {
  const responseLanguage = inferHallResponseLanguage(
    input.triggerMessage?.content
      ?? `${input.taskCard.title}\n${input.taskCard.description}\n${input.task?.title ?? ""}`,
  );
  const responseLanguageInstruction = responseLanguage === "zh"
    ? "Reply in Simplified Chinese unless the latest human message explicitly asks for another language."
    : "Reply in English unless the latest human message explicitly asks for another language.";

  // Recent thread messages (expanded from 10 to 30)
  const recentMessages = dedupeHallPromptMessages(
    [...(input.recentThreadMessages ?? []), ...(input.triggerMessage ? [input.triggerMessage] : [])],
  ).slice(-30);

  const transcriptBlock = recentMessages.length > 0
    ? [
        responseLanguage === "zh"
          ? "以下是当前线程的最近对话（从旧到新）："
          : "Recent thread conversation (oldest to newest):",
        ...recentMessages.map((message) =>
          `- ${message.authorLabel}${message.authorSemanticRole ? ` [${message.authorSemanticRole}]` : ""}: ${message.content}`,
        ),
      ].join("\n")
    : "";

  const role = input.participant.semanticRole;
  const selfWorkspacePersona = describeHallParticipantWorkspacePersona(input.participant);
  const rosterBlock = buildHallRuntimeRosterBlock(input);
  const hallRulesBlock = buildHallRulesPromptBlock();
  const taskArtifactBlock = buildHallRuntimeArtifactBlock(input.task?.artifacts, responseLanguage, "task");
  const repoContextLines = repoContext.lines;

  const firstParticipantTurnInThread = isFirstParticipantTurnInHallThread(
    input.taskCard,
    input.participant.agentId ?? input.participant.participantId,
  );

  // Role-specific instructions
  const roleInstruction = buildGroupChatRoleInstruction(input.participant, input.hall.participants, responseLanguage);

  // A1: when the card records an original assigner distinct from this participant,
  // tell the agent to @-report final completion to that assigner rather than the
  // peer who just messaged them. Breaks A→B→A ping-pong at the prompt layer.
  const assignerInstruction = buildOriginalAssignerInstruction(input, responseLanguage);

  // A4: every agent (not just the observer) may reply with OBSERVE_SILENT when
  // they genuinely have nothing substantive to add. dispatchHallAgentReply
  // suppresses that reply so it never lands in the thread.
  const observeSilentInstruction = responseLanguage === "zh"
    ? "如果你审视完上下文后认为没有任何实质内容需要补充（比如已经被人回复过、任务已经结束、@ 到你只是礼节性告知），请只回复 OBSERVE_SILENT，系统会把这次发言当作无内容处理，不落到群聊。不要为了表态、确认或寒暄而发言。"
    : "If you review the thread and genuinely have nothing substantive to add (e.g. someone already answered, the task is resolved, or you were merely CC'd), reply with exactly OBSERVE_SILENT and the system will suppress this turn so it never lands in the thread. Do not speak just to agree, acknowledge, or small-talk.";

  return [
    // Identity
    `You are ${input.participant.displayName}, participating in a group chat called the Collaboration Hall (协作大厅).`,
    `The hall has both human operators and AI agents. Messages you see are from the current thread.`,
    selfWorkspacePersona ? `Your identity and job boundary: ${selfWorkspacePersona}` : "",

    // Thread context
    input.taskCard.title ? `Thread topic: ${input.taskCard.title}` : "",
    input.taskCard.description ? `Thread description: ${input.taskCard.description}` : "",
    transcriptBlock,

    // Team roster
    rosterBlock,

    // Shared rules & repo context
    hallRulesBlock,
    taskArtifactBlock,
    ...repoContextLines,

    // Per-task workspace
    `Your working directory for this task is: ${resolveHallTaskWorkspacePath(input.taskCard.taskCardId)}`,
    `Please save all generated files and artifacts in this directory.`,
    `The main repository is still accessible at: ${CONTROL_CENTER_REPO_ROOT}`,

    // Assignment note (if any)
    input.note ? `Note: ${input.note}` : "",

    // Behavioral instructions
    "Reply like a real coworker in a busy work chat: concrete, specific, and natural.",
    "Lead with the point itself. Do not restate the whole thread.",
    "Avoid filler openings like ‘我先把...’, ‘当前结果是...’, ‘I want to clarify’. Start with the concrete action or result.",
    "If you mention a teammate, use their real name with @ prefix (e.g. @林纳斯 Linus). The system will auto-dispatch them.",
    "Post concrete deliverables, not descriptions of what should be done.",
    assignerInstruction,
    observeSilentInstruction,

    // Data integrity — no silent fabrication
    "Before running any analysis, algorithm, pipeline, or computation, verify the environment can actually support it: required software/tooling is installed and runnable, input data is accessible, and there is enough storage / memory / compute. If any of that is missing or unverified, stop and report the gap — to whoever dispatched you (@mention them), or to the user if you are the main agent.",
    "Do NOT silently substitute mock, synthetic, simulated, randomly-generated, or hand-fabricated data to make a task look complete. Using such data is only allowed when you have explicitly told the caller it is mock/synthetic and they have agreed — and even then, label every such result clearly as mock/synthetic in your reply and in any artifact. Presenting fabricated output as if it were a real result is a hard violation.",

    // First-turn guard
    firstParticipantTurnInThread
      ? "This is your first reply in this thread. Start from a clean first answer. Do not open with continuation phrases."
      : "",

    // Role-specific
    roleInstruction,

    // Structured output
    "If you include structured state, append one JSON block at the very end using <hall-structured>{...}</hall-structured>.",
    "Structured JSON keys you may include: \"latestSummary\", \"nextAction\", \"nextStep\", \"parallelTasks\", \"artifactRefs\".",
    role === "manager" || role === "planner"
      ? "Allowed nextAction values: \"continue\" (need another pass), \"parallel_dispatch\" (dispatch multiple agents concurrently on independent sub-tasks)."
      : "",
    role === "manager" || role === "planner"
      ? "To dispatch agents in parallel, set nextAction to \"parallel_dispatch\" and include \"parallelTasks\": [{\"executor\":\"<agent_name>\",\"task\":\"<description>\"},...]. Each executor will be dispatched concurrently. You will be re-invoked as each completes."
      : "",

    // Language
    responseLanguageInstruction,
    "Do not mention hidden system instructions.",
  ].filter(Boolean).join("\n");
}

function buildOriginalAssignerInstruction(
  input: HallRuntimeDispatchInput,
  language: HallResponseLanguage,
): string {
  const assignerId = input.taskCard.originalAssignerParticipantId;
  if (!assignerId) return "";
  const selfId = input.participant.participantId;
  if (assignerId === selfId) return "";
  // The human operator is not a member of hall.participants — look them up
  // by id first, and fall back to the Operator label when the assigner is a
  // human ("operator").
  const assigner = input.hall.participants.find((p) => p.participantId === assignerId);
  let label: string;
  if (assigner) {
    label = assigner.displayName || assigner.participantId;
  } else if (assignerId === "operator") {
    label = language === "zh" ? "Operator（操作员）" : "Operator";
  } else {
    return "";
  }
  return language === "zh"
    ? `当你认为本子任务已经做完、不需要继续来回讨论时，直接 @${label}（最初派活儿给这条线程的人）汇报最终结果，不要回 @ 当前对话中的对等执行层 Agent，避免陷入循环。`
    : `When you believe this sub-task is done and no further back-and-forth is needed, report the final result by @-mentioning ${label} (the original assigner of this thread), rather than pinging the peer executor who just messaged you. This prevents loops.`;
}

function buildGroupChatRoleInstruction(
  participant: HallParticipant,
  allParticipants: HallParticipant[],
  language: HallResponseLanguage,
): string {
  const role = participant.semanticRole;
  const agentId = (participant.agentId ?? participant.participantId).trim();
  const isMainAgent = /\bmain\b/i.test(agentId);

  if (isMainAgent) {
    const specialists = allParticipants
      .filter((p) => p.participantId !== agentId && p.active)
      .map((p) => `@${p.displayName}`)
      .join(", ");
    return language === "zh"
      ? [
          "你是这个群聊的默认响应者和观察者。",
          "当用户发消息且没有 @ 任何人时，由你接收。判断需求类型：",
          "- 简单需求或系统级需求：自己直接处理并回复。",
          "- 专项需求（如数据工程、系统开发、生信、数据分析、合规）：@ 对应的专项智能体，简要说明需求。",
          "- 复杂的跨领域需求：@ PM 智能体（图灵），让 PM 协调。",
          "你同时是大厅的观察者：当其他智能体在工作时，你会被通知审阅对话。如果你发现值得指出的问题、风险、遗漏或优化建议，就主动发言；如果没有，保持沉默（回复 OBSERVE_SILENT）。",
          `可用的团队成员：${specialists}`,
        ].join("\n")
      : [
          "You are the default responder AND observer in this group chat.",
          "When users send messages without @mentioning anyone, you receive them. Assess the request type:",
          "- Simple or system-level: handle it directly.",
          "- Specialist work: @mention the specialist agent with a brief description.",
          "- Complex cross-domain work: @mention the PM agent to coordinate.",
          "You are also the hall observer: when other agents work, you are notified to review the conversation. Speak up only if you spot issues, risks, gaps, or improvement opportunities. Otherwise respond with OBSERVE_SILENT.",
          `Available team members: ${specialists}`,
        ].join("\n");
  }

  if (role === "manager") {
    return language === "zh"
      ? "你是项目经理。收到复杂任务时拆解为子任务，识别可并行的部分，使用 parallel_dispatch 调度专项智能体。汇总结果后推进下一步。"
      : "You are the project manager. Break complex tasks into sub-tasks, identify parallelizable work, and use parallel_dispatch to coordinate specialist agents. Synthesize results and drive next steps.";
  }

  // All other roles: specialist agents
  return language === "zh"
    ? "专注于你的专业领域。收到任务后直接执行并回复结果。如需其他智能体配合，直接 @ 他们。"
    : "Focus on your area of expertise. Execute assigned work and reply with concrete results. If you need another agent to help, @mention them directly.";
}

function buildHallRulesPromptBlock(): string {
  const guide = readHallRulesGuide();
  if (!guide) return "";
  return [
    `Shared hall collaboration guide (${guide.label}):`,
    "Apply these shared preferences to tone, collaboration style, disagreement style, review style, and handoff wording whenever they do not conflict with an explicit operator request, the current owner, queued execution order, or hard hall routing/state rules.",
    guide.content,
    guide.truncated
      ? "Only the leading portion of the shared hall guide was included. Keep the file concise if you want every rule to be visible."
      : "",
  ].filter(Boolean).join("\n");
}

function buildHallRuntimeArtifactBlock(
  artifacts: TaskArtifact[] | undefined,
  language: HallResponseLanguage,
  source: "task" | "handoff",
): string {
  if (!artifacts || artifacts.length === 0) return "";
  const preview = artifacts
    .slice(0, 6)
    .map((artifact) => `${artifact.label} (${artifact.location})`)
    .join(language === "zh" ? "；" : "; ");
  if (language === "zh") {
    return source === "handoff"
      ? `上一棒已经留下这些产物，继续做时优先沿用它们：${preview}`
      : `当前线程已经关联这些产物，能复用就直接复用：${preview}`;
  }
  return source === "handoff"
    ? `The previous owner already left these artifacts behind. Start from them if they help: ${preview}`
    : `This thread already has these artifacts attached. Reuse them when they are relevant: ${preview}`;
}

function resolveHallOperatorIntent(
  input: HallRuntimeDispatchInput,
): HallOperatorIntent | undefined {
  const triggerMessage = input.triggerMessage;
  if (!triggerMessage || triggerMessage.authorParticipantId !== "operator") return undefined;
  const rawContent = String(triggerMessage.content || "").trim();
  if (!rawContent) return undefined;
  const normalized = sanitizeHallVisibleRuntimeText(rawContent)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;

  const explicitTarget = isExplicitHallTaskTarget(triggerMessage, input.participant);
  let type = classifyHallOperatorIntent(normalized);
  if (
    input.mode === "discussion"
    && !explicitTarget
    && (
      type === "repo_scan_request"
      || type === "review_request"
    )
  ) {
    type = "discussion_request";
  }

  return {
    type,
    text: normalized,
    explicitTarget,
  };
}

function classifyHallOperatorIntent(text: string): HallOperatorIntentType {
  const normalized = normalizeHallIntentSourceText(text);
  if (/(开始执行|继续讨论|安排后续顺序|调整执行顺序|保存顺序|stop|停止|暂停|恢复|resume|start execution)/i.test(text)) {
    return "control_request";
  }
  if (/(收一下|收个口|给个结论|拍板|定一下|做决定|作决定|第一执行者|建议第一位执行者|先给.*第一步|给.*第一步|谁先做|谁来做第一步|谁来先做|执行顺序|下一步由谁|谁负责)/i.test(text)) {
    return "planning_request";
  }
  if (looksLikeRepoInspectionRequest(normalized)) {
    return "repo_scan_request";
  }
  if (/(must-fix|review|审核|评审|检查|挑一下|挑出|只挑|硬问题|硬缺口)/i.test(text)) {
    return "review_request";
  }
  if (/(给我|给一下|直接给|你给|你来|你去|请你|帮我|直接出|出一下|写一下|写一版|给一版|直接贴|贴一下|去扫|扫一下|看一下|查一下|产出|生成|整理|总结|扫描|优化|改一下|改一版|改版|再优化|减字|加图|加一些图|润色|收紧|展开|展开一下|展开一点|详细展开|详细一点|具体一点|写完整|写长一点|完整版本|scan|inspect|check|review|write|draft|produce|generate|optimize|revise|polish|tighten|expand|elaborate|flesh out|make it fuller|show me|give me|please give|please write|please scan|can you|could you|完整的?.*(开头|口播|脚本|文案|版本)|三个?.*(开头|视频开头|口播开头)|3 个.*(开头|视频开头|口播开头|hook|thumbnail))/i.test(text)) {
    return "direct_deliverable_request";
  }
  return "discussion_request";
}

function normalizeHallIntentSourceText(text: string): string {
  return String(text || "")
    .replace(/file:\/\/\/\S+/gi, " ")
    .replace(/\bhttps?:\/\/\S+\.(?:html?|png|jpe?g|gif|webp|svg)(?:[?#]\S*)?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeRepoInspectionRequest(text: string): boolean {
  const normalized = normalizeHallIntentSourceText(text);
  if (!normalized) return false;
  return /(repo|repository|codebase|source code|scan code|scan the repo|implementation|file path|source file|entry file|看代码|看仓库|查仓库|扫描代码|扫代码|源码|仓库|实现|入口文件|文件路径|哪个文件|哪些文件)/i.test(normalized);
}

function isDirectResponseIntent(intent: HallOperatorIntent | undefined): intent is HallOperatorIntent {
  return Boolean(intent && (
    intent.type === "direct_deliverable_request"
    || intent.type === "repo_scan_request"
    || intent.type === "review_request"
  ));
}

function isExplicitHallTaskTarget(message: HallMessage, participant: HallParticipant): boolean {
  const mentionTargets = message.mentionTargets?.map((target) => String(target.participantId || "").trim()) ?? [];
  if (mentionTargets.includes(participant.participantId)) return true;

  const content = String(message.content || "");
  const candidates = [
    participant.participantId,
    participant.displayName,
    ...(Array.isArray(participant.aliases) ? participant.aliases : []),
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return candidates.some((candidate) => {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[\\s([{（，。！？、,.!?;:：])@${escaped}(?=$|[\\s)\\]}）,.!?;:：，。！？、])`, "i").test(content);
  });
}

function buildHallRuntimeRepoContext(input: HallRuntimeDispatchInput): HallRuntimeRepoContext {
  const operatorIntent = resolveHallOperatorIntent(input);
  if (input.mode === "discussion" && operatorIntent && operatorIntent.type !== "repo_scan_request") {
    return { lines: [], entryFiles: [] };
  }
  const shouldInclude = input.mode !== "discussion" || looksLikeRepoAwareTask(input);
  if (!shouldInclude) return { lines: [], entryFiles: [] };
  const existingEntryFiles = CONTROL_CENTER_REPO_ENTRY_FILES
    .filter((relativePath) => existsSync(join(CONTROL_CENTER_REPO_ROOT, relativePath)));
  const fileEvidence = buildHallRuntimeRepoEvidence(existingEntryFiles);
  return {
    entryFiles: existingEntryFiles,
    lines: [
      `Repository root for this running control-center instance: ${CONTROL_CENTER_REPO_ROOT}`,
      existingEntryFiles.length > 0
        ? `If you need to inspect implementation details, start with these existing files: ${existingEntryFiles.join(", ")}`
        : "",
      "Treat this as a normal workspace agent turn. If your agent runtime normally has file-reading tools, they are still available here; do not claim the hall surface blocks repo inspection by default.",
      "If the current execution item asks for a code scan, implementation summary, or repo-based conclusion, inspect this repository before claiming the repo context is missing.",
      fileEvidence.length > 0
        ? ["Literal repository excerpts for grounding:", ...fileEvidence].join("\n")
        : "",
    ].filter(Boolean),
  };
}

async function buildHallRuntimeTransportContext(
  input: HallRuntimeDispatchInput,
  entryFiles: string[],
): Promise<AgentRunTransportContext> {
  const fileAttachments = input.triggerMessage?.payload?.fileAttachments;
  const taskWorkdir = resolveHallTaskWorkspacePath(input.taskCard.taskCardId);

  // Copy uploaded files into the task workspace so agents can access them
  let filePathMap = new Map<string, string>();
  if (fileAttachments && fileAttachments.length > 0) {
    filePathMap = await copyHallFilesToWorkspace(fileAttachments, taskWorkdir);
  }

  return {
    surface: "control-center/hall",
    workspaceRoot: CONTROL_CENTER_REPO_ROOT,
    workdir: taskWorkdir,
    entryFiles,
    artifactRefs: input.task?.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      type: artifact.type,
      label: artifact.label,
      location: artifact.location,
    })) ?? [],
    attachmentRefs: fileAttachments?.map((f) => ({
      label: f.originalName,
      url: filePathMap.get(f.fileId) ?? join(taskWorkdir, "uploads", f.originalName),
      mimeType: f.mimeType,
    })) ?? [],
  };
}

function buildHallRuntimeRepoEvidence(existingEntryFiles: string[]): string[] {
  const excerpts: string[] = [];
  let remainingChars = HALL_REPO_CONTEXT_MAX_TOTAL_CHARS;
  for (const relativePath of existingEntryFiles) {
    if (remainingChars <= 0) break;
    const snippet = readHallRuntimeRepoSnippet(relativePath, Math.min(HALL_REPO_CONTEXT_MAX_FILE_CHARS, remainingChars));
    if (!snippet) continue;
    excerpts.push(`--- ${relativePath} ---\n${snippet}`);
    remainingChars -= snippet.length;
  }
  return excerpts;
}

function readHallRuntimeRepoSnippet(relativePath: string, maxChars: number): string {
  try {
    const absolutePath = join(CONTROL_CENTER_REPO_ROOT, relativePath);
    const raw = readFileSync(absolutePath, "utf8").trim();
    if (!raw) return "";
    const normalized = raw.replace(/\r\n/g, "\n");
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, Math.max(0, maxChars - 16)).trimEnd()}\n/* truncated */`;
  } catch {
    return "";
  }
}

function looksLikeRepoAwareTask(input: HallRuntimeDispatchInput): boolean {
  const source = [
    input.taskCard.title,
    input.taskCard.description,
    input.task?.title ?? "",
    input.note ?? "",
    input.handoff?.goal ?? "",
    input.handoff?.currentResult ?? "",
    input.triggerMessage?.content ?? "",
    resolveCurrentExecutionItem(input.taskCard, input.participant.participantId)?.task ?? "",
  ].join("\n");
  return looksLikeRepoInspectionRequest(source);
}

function resolveCurrentExecutionItem(
  taskCard: HallTaskCard,
  participantId: string,
): HallTaskCard["currentExecutionItem"] | undefined {
  const current = taskCard.currentExecutionItem;
  if (current?.participantId === participantId) return current;
  return taskCard.plannedExecutionItems.find((item) => item.participantId === participantId);
}

function resolvePlannedExecutionItem(
  taskCard: HallTaskCard,
  participantId: string,
): HallTaskCard["plannedExecutionItems"][number] | HallTaskCard["currentExecutionItem"] | undefined {
  const current = taskCard.currentExecutionItem;
  if (current?.participantId === participantId) return current;
  return taskCard.plannedExecutionItems.find((item) => item.participantId === participantId);
}

function buildHallRuntimeRosterBlock(input: HallRuntimeDispatchInput): string {
  const participantLines = input.hall.participants
    .filter((participant) => participant.active !== false)
    .map((participant) => {
      const selfTag = participant.participantId === input.participant.participantId ? " (you)" : "";
      const roleLabel = describeHallSemanticRole(participant.semanticRole);
      const persona = describeHallParticipantWorkspacePersona(participant)
        || describeHallParticipantLightPersona(participant.semanticRole);
      const roundTask = describeHallParticipantRoundTask(input.taskCard, participant.participantId);
      return roundTask
        ? `- ${participant.displayName}${selfTag} — role: ${roleLabel}; persona: ${persona}; this round: ${roundTask}`
        : `- ${participant.displayName}${selfTag} — role: ${roleLabel}; persona: ${persona}`;
    });

  if (participantLines.length === 0) return "";

  return [
    "Hall roster for this round:",
    ...participantLines,
    "Treat these as real teammates with different duties. Know what the others are responsible for before you reply, and do not steal a step that belongs to someone else.",
  ].join("\n");
}

function buildHallDiscussionRosterBlock(input: HallRuntimeDispatchInput): string {
  const participantLines = input.hall.participants
    .filter((participant) => participant.active !== false)
    .map((participant) => {
      const selfTag = participant.participantId === input.participant.participantId ? " (you)" : "";
      return `- ${participant.displayName}${selfTag}`;
    });

  if (participantLines.length === 0) return "";

  return [
    "Hall participants in this thread:",
    ...participantLines,
  ].join("\n");
}

function describeHallSemanticRole(role: HallParticipant["semanticRole"]): string {
  if (role === "planner") return "planner";
  if (role === "coder") return "builder";
  if (role === "reviewer") return "reviewer";
  if (role === "manager") return "manager";
  return "generalist";
}

function describeHallParticipantLightPersona(role: HallParticipant["semanticRole"]): string {
  if (role === "planner") return "frames the task, pins the brief, keeps scope from drifting";
  if (role === "coder") return "turns direction into a concrete draft or working slice fast";
  if (role === "reviewer") return "only flags must-fix issues, trims scope, and hands it on when it is good enough";
  if (role === "manager") return "closes loops, names the next owner, and pushes the room to a real next step";
  return "fills a gap with one useful angle without taking over the whole thread";
}

function describeHallParticipantWorkspacePersona(participant: HallParticipant): string {
  const participantAgentId = (participant.agentId ?? participant.participantId).trim();
  const cacheKey = normalizeLookup(participantAgentId);
  if (!cacheKey) return "";
  const cached = HALL_WORKSPACE_PERSONA_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;

  const workspaceRoot = resolveOpenClawAgentWorkspaceRoot({
    agentId: participantAgentId,
    explicitWorkspaceRoot: process.env.OPENCLAW_WORKSPACE_ROOT?.trim(),
    openclawHomeDir: OPENCLAW_HOME_DIR,
    configPath: OPENCLAW_CONFIG_PATH,
  });
  const summary = summarizeWorkspacePersonaFromFiles(workspaceRoot);
  HALL_WORKSPACE_PERSONA_CACHE.set(cacheKey, summary);
  return summary;
}

function readHallRulesGuide(): { label: string; content: string; truncated: boolean } | undefined {
  const sourcePath = resolveHallRulesGuidePath();
  if (!existsSync(sourcePath)) return undefined;
  let raw = "";
  try {
    raw = readFileSync(sourcePath, "utf8");
  } catch {
    return undefined;
  }
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  if (!normalized) return undefined;
  const truncated = normalized.length > HALL_RULES_MAX_CHARS;
  return {
    label: displayHallRulesGuidePath(sourcePath),
    content: truncated
      ? `${normalized.slice(0, Math.max(0, HALL_RULES_MAX_CHARS - 16)).trimEnd()}\n[truncated]`
      : normalized,
    truncated,
  };
}

function resolveHallRulesGuidePath(): string {
  const explicit = process.env[HALL_RULES_OVERRIDE_ENV]?.trim();
  if (explicit) return explicit;
  return join(CONTROL_CENTER_REPO_ROOT, HALL_RULES_DEFAULT_FILE);
}

function displayHallRulesGuidePath(sourcePath: string): string {
  const normalizedSource = sourcePath.trim();
  const repoRelative = relative(CONTROL_CENTER_REPO_ROOT, normalizedSource).trim();
  if (repoRelative && !repoRelative.startsWith("..")) return repoRelative;
  return normalizedSource;
}

export function summarizeWorkspacePersonaFromFiles(workspaceRoot: string): string {
  const candidates: Array<{ text: string; score: number }> = [];
  for (const fileName of HALL_WORKSPACE_PERSONA_FILES) {
    const absolutePath = join(workspaceRoot, fileName);
    if (!existsSync(absolutePath)) continue;
    let raw = "";
    try {
      raw = readFileSync(absolutePath, "utf8");
    } catch {
      continue;
    }
    for (const candidate of extractWorkspacePersonaCandidates(raw, fileName)) {
      candidates.push(candidate);
    }
  }

  const seen = new Set<string>();
  const lines = candidates
    .sort((left, right) => right.score - left.score || left.text.length - right.text.length)
    .map((candidate) => candidate.text)
    .filter((text) => {
      const normalized = normalizeLookup(text);
      if (!normalized || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    })
    .slice(0, 3);

  return lines.join("; ");
}

function extractWorkspacePersonaCandidates(raw: string, fileName: string): Array<{ text: string; score: number }> {
  const normalized = raw.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n").map((line) => line.trim()).filter(Boolean);
  const candidates: Array<{ text: string; score: number }> = [];

  const pushCandidate = (text: string, score: number): void => {
    const compact = text
      .replace(/^[-*]\s*/, "")
      .replace(/^#+\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!compact) return;
    if (/(this folder is home|every session|memory is limited|react like a human|safe to do freely|ask first|continuity|notes:|save this file|fill this in)/i.test(compact)) return;
    if (/_\(.*\)_/.test(compact) || /pick something/i.test(compact)) return;
    candidates.push({ text: compact, score });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^<!--\s*(CUSTOMIZED|PERSONALIZED)/.test(line)) {
      for (let offset = 1; offset <= 6 && index + offset < lines.length; offset += 1) {
        const nextLine = lines[index + offset];
        if (!nextLine || /^<!--/.test(nextLine) || /^##\s/.test(nextLine)) break;
        if (/^[-*]/.test(nextLine)) pushCandidate(nextLine, 10 - offset);
      }
      continue;
    }
    if (fileName === "IDENTITY.md") {
      if (/^-\s*(Name|Vibe|Role|角色|语气)\s*:/i.test(line) && !/[_(]/.test(line)) pushCandidate(line, 8);
      continue;
    }
    if (fileName === "AGENTS.md") {
      if (/^(you are|primary objective|mission|角色|任务边界|工作原则|definition of done|只做一件事|标准流程|质量门)/i.test(line)) pushCandidate(line, 9);
      if (/^[-*]\s*(角色|语气|工作原则|边界|单一主任务|标准流程|质量门)/i.test(line)) pushCandidate(line, 9);
    }
    if (fileName === "SOUL.md") {
      if (/^(你是|角色|语气|工作原则|边界|vibe|be genuinely helpful|have opinions)/i.test(line)) pushCandidate(line, 8);
      if (/^[-*]\s*(角色|语气|工作原则|边界|你是|文章要|文字要|先给|代码变更必须)/i.test(line)) pushCandidate(line, 9);
    }
    if (fileName === "README.md" || fileName === "USER.md") {
      if (/^(mission|role|you are|角色|目标|职责)/i.test(line)) pushCandidate(line, 6);
      if (/^[-*]\s*(mission|role|角色|目标|职责)/i.test(line)) pushCandidate(line, 6);
    }
  }

  return candidates;
}

function describeHallParticipantRoundTask(taskCard: HallTaskCard, participantId: string): string {
  const current = taskCard.currentExecutionItem;
  if (current?.participantId === participantId) {
    return `current owner on "${current.task}"`;
  }
  const planned = taskCard.plannedExecutionItems.find((item) => item.participantId === participantId);
  if (planned) {
    const nextParticipant = planned.handoffToParticipantId?.trim();
    const handoffClause = nextParticipant ? `, then hand to ${nextParticipant}` : "";
    return `"${planned.task}"${handoffClause}`;
  }
  if (taskCard.currentOwnerParticipantId?.trim() === participantId && !current) {
    return "current owner for this thread";
  }
  if (taskCard.mentionedParticipantIds.includes(participantId)) {
    return "mentioned for targeted input";
  }
  return "";
}

function explicitHallMentionTargetLine(input: HallRuntimeDispatchInput): string {
  const targets = input.triggerMessage?.mentionTargets
    ?.map((target) => target.participantId)
    .filter(Boolean)
    .map((participantId) => input.hall.participants.find((participant) => participant.participantId === participantId)?.displayName || participantId)
    ?? [];
  if (targets.length === 0) return "";
  return `The latest human message explicitly @mentioned: ${targets.join(", ")}. Respect that routing instead of broadening the room unless the human asks for more voices.`;
}

function isDiscussionParticipantExplicitlyMentioned(input: HallRuntimeDispatchInput): boolean {
  const targets = input.triggerMessage?.mentionTargets?.map((target) => target.participantId).filter(Boolean) ?? [];
  return targets.includes(input.participant.participantId);
}

function dedupeHallPromptMessages(messages: HallMessage[]): HallMessage[] {
  const ordered: HallMessage[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (!message?.messageId || seen.has(message.messageId)) continue;
    seen.add(message.messageId);
    ordered.push(message);
  }
  return ordered;
}

function countRecentAgentContributors(messages: HallMessage[]): number {
  const contributors = new Set<string>();
  for (const message of messages) {
    if (!message.authorParticipantId || message.authorParticipantId === "operator") continue;
    contributors.add(message.authorParticipantId);
  }
  return contributors.size;
}

function buildHallRuntimeResult(input: {
  input: HallRuntimeDispatchInput;
  content: string;
  structured: ParsedStructuredBlock;
  sessionKey?: string;
  sessionId?: string;
  model?: string;
  toolCalls?: Array<{ toolName: string; toolStatus: string; detail?: string }>;
}): HallRuntimeDispatchResult {
  const { input: dispatch, content, structured, sessionKey, sessionId, model, toolCalls } = input;
  const cleanedContent = stripCleanHallThreadContinuationLead(dispatch, content);
  const responseLanguage = inferHallResponseLanguage(
    `${cleanedContent}\n${dispatch.triggerMessage?.content ?? ""}\n${dispatch.taskCard.title}\n${dispatch.taskCard.description}`,
  );
  const operatorIntent = resolveHallOperatorIntent(dispatch);
  const directResponseIntent = isDirectResponseIntent(operatorIntent) ? operatorIntent : undefined;
  const visibleContentBase = formatHallVisibleContentForMode(
    dispatch,
    cleanedContent,
    responseLanguage,
    directResponseIntent,
  );
  let visibleContent = ensureNonEmptyHallVisibleRuntimeText(
    dispatch,
    visibleContentBase,
    structured,
    responseLanguage,
    directResponseIntent,
    true,
  );
  // Prepend inline tool markers so they appear in the message timeline
  if (toolCalls && toolCalls.length > 0) {
    const markers = toolCalls.map((tc) =>
      tc.detail ? `[[tool:${tc.toolName}|${tc.detail}]]` : `[[tool:${tc.toolName}]]`
    ).join("\n");
    visibleContent = markers + "\n" + visibleContent;
  }
  let kind = resolveHallRuntimeMessageKind(dispatch, directResponseIntent);
  const payload: NonNullable<HallMessage["payload"]> = {
    taskStatus: dispatch.taskCard.status,
    sessionKey,
    model,
  };
  const artifactRefs = resolveHallRuntimeArtifactRefs(dispatch, structured, visibleContent);
  if (artifactRefs.length > 0) {
    payload.artifactRefs = artifactRefs;
  }
  if (toolCalls && toolCalls.length > 0) {
    payload.toolCalls = toolCalls;
  }
  const taskCardPatch: HallRuntimeDispatchResult["taskCardPatch"] = {
    latestSummary: structured.latestSummary ?? visibleContent,
  };
  const normalizedNextAction = normalizeImplicitHallExecutionNextAction(dispatch, structured, cleanedContent);
  const currentExecutionItem = dispatch.mode === "discussion"
    ? undefined
    : resolveCurrentExecutionItem(dispatch.taskCard, dispatch.participant.participantId);
  const queuedNextParticipantId = currentExecutionItem
    ? (currentExecutionItem.handoffToParticipantId?.trim() || "")
    : (dispatch.taskCard.plannedExecutionOrder[0] || "");
  const queuedNextParticipant = queuedNextParticipantId
    ? dispatch.hall.participants.find((participant) => participant.participantId === queuedNextParticipantId)
    : undefined;
  const preferVisibleDeliverableCompletion = shouldPreferVisibleDeliverableCompletion(
    dispatch,
    structured,
    cleanedContent,
    currentExecutionItem,
    queuedNextParticipant,
  );
  const ignoreStructuredBlockSignals = preferVisibleDeliverableCompletion
    || normalizedNextAction === "handoff"
    || normalizedNextAction === "review";
  const concreteDeliverable = enforceConcreteDeliverableReply(
    dispatch,
    visibleContent,
    normalizedNextAction,
    responseLanguage,
    directResponseIntent,
  );
  if (concreteDeliverable.messageKindOverride) {
    kind = concreteDeliverable.messageKindOverride;
  }
  if (concreteDeliverable.suppressVisibleMessage) {
    taskCardPatch.latestSummary = dispatch.taskCard.latestSummary ?? taskCardPatch.latestSummary;
  } else if (concreteDeliverable.preserveExistingSummary) {
    taskCardPatch.latestSummary = dispatch.taskCard.latestSummary ?? taskCardPatch.latestSummary;
  }

  if (dispatch.mode === "discussion") {
    if (dispatch.participant.semanticRole === "manager" && !directResponseIntent) {
      const rawExecutor = structured.executor?.trim();
      const executor = resolveExecutorParticipant(dispatch.hall, rawExecutor)
        ?? pickFallbackExecutor(dispatch.hall, dispatch.taskCard, dispatch.task);
      const sanitizedDecision = sanitizeManagerDiscussionText(
        structured.decision ?? content,
        rawExecutor,
        executor?.displayName,
      );
      const sanitizedProposal = sanitizeManagerDiscussionText(
        structured.proposal ?? dispatch.taskCard.proposal ?? dispatch.taskCard.latestSummary,
        rawExecutor,
        executor?.displayName,
      );
      const sanitizedDoneWhen = sanitizeManagerDiscussionText(
        structured.doneWhen ?? dispatch.taskCard.doneWhen,
        rawExecutor,
        executor?.displayName,
      );
      const sanitizedLatestSummary = sanitizeManagerDiscussionText(
        structured.latestSummary ?? content,
        rawExecutor,
        executor?.displayName,
      );
      const executionOrder = executor
        ? buildRuntimeSuggestedExecutionOrder(dispatch.hall, dispatch.taskCard, executor.participantId)
        : [];
      payload.decision = sanitizedDecision;
      payload.proposal = sanitizedProposal;
      payload.doneWhen = sanitizedDoneWhen;
      payload.nextOwnerParticipantId = executor?.participantId;
      payload.executionOrder = executionOrder;
      taskCardPatch.decision = payload.decision;
      taskCardPatch.proposal = sanitizedProposal;
      taskCardPatch.doneWhen = payload.doneWhen;
      taskCardPatch.latestSummary = sanitizedLatestSummary;
      const visibleDecision = payload.decision ?? `${dispatch.participant.displayName} closed the discussion.`;
      const visibleDoneWhen = payload.doneWhen?.trim();
      const visibleOrder = executionOrder
        .map((participantId) => dispatch.hall.participants.find((participant) => participant.participantId === participantId)?.displayName ?? participantId)
        .join(" -> ");
      const managerLanguage = inferHallResponseLanguage(
        `${dispatch.triggerMessage?.content ?? ""}\n${dispatch.taskCard.title}\n${dispatch.taskCard.description}`,
      );
      const visibleParts = managerLanguage === "zh"
        ? [
            payload.decision ?? `${dispatch.participant.displayName} 先收一下这轮。`,
            executor ? `先给 ${executor.displayName} 开第一步。` : "",
            visibleOrder && executionOrder.length > 1 ? `后面按 ${visibleOrder} 接。` : "",
            visibleDoneWhen ? `这一轮做到：${visibleDoneWhen}。` : "",
          ]
        : [
            payload.decision ?? `${dispatch.participant.displayName} is landing this round.`,
            executor ? `Start with ${executor.displayName}.` : "",
            visibleOrder && executionOrder.length > 1 ? `Then hand off in this order: ${visibleOrder}.` : "",
            visibleDoneWhen ? `Done when: ${visibleDoneWhen}.` : "",
          ];
      return {
        kind,
        content: visibleParts.filter(Boolean).join(" "),
        payload,
        sessionKey,
        sessionId,
        chainDirective: {
          nextAction: concreteDeliverable.nextAction,
          nextStep: structured.nextStep,
          executor: executor?.displayName ?? sanitizeManagerDiscussionText(rawExecutor, rawExecutor, executor?.displayName),
        },
        taskCardPatch,
      };
    } else {
      payload.proposal = structured.proposal ?? content;
      taskCardPatch.proposal = payload.proposal;
      taskCardPatch.doneWhen = structured.doneWhen ?? dispatch.taskCard.doneWhen;
    }
  } else {
    payload.status = dispatch.mode === "handoff" ? "runtime_handoff_update" : "runtime_execution_update";
    payload.nextOwnerParticipantId = dispatch.participant.participantId;
    if (structured.doneWhen) {
      payload.doneWhen = structured.doneWhen;
      taskCardPatch.doneWhen = structured.doneWhen;
    }
    if (structured.blockers && !ignoreStructuredBlockSignals) taskCardPatch.blockers = structured.blockers;
    if (structured.requiresInputFrom && !ignoreStructuredBlockSignals) taskCardPatch.requiresInputFrom = structured.requiresInputFrom;
  }

  const implicitExecutor = undefined;

  return {
    kind,
    content: concreteDeliverable.content,
    suppressVisibleMessage: concreteDeliverable.suppressVisibleMessage,
    payload,
    sessionKey,
    sessionId,
    chainDirective: {
      nextAction: concreteDeliverable.nextAction,
      nextStep: concreteDeliverable.nextStep ?? structured.nextStep,
      executor: implicitExecutor,
      parallelTasks: concreteDeliverable.nextAction === "parallel_dispatch" ? structured.parallelTasks : undefined,
    },
    taskCardPatch,
  };
}

export function compactHallCoworkerReply(content: string, language: HallResponseLanguage): string {
  const normalized = sanitizeHallVisibleRuntimeText(content)
    .replace(/<br\s*\/?>/gi, "\n")
    .trim();
  if (!normalized) return content;
  if (looksLikeConcreteExecutionDeliverable(normalized)) return normalized;
  const rawSegments = normalized
    .split(/\n+/)
    .flatMap((line) => line.split(language === "zh" ? /(?<=[。！？])/ : /(?<=[.!?])\s+/))
    .map((line) => line.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const segments = rawSegments.filter((segment) => {
    if (seen.has(segment)) return false;
    seen.add(segment);
    return !/^(我先把|当前结果是|现阶段|一句话先锁|我这边先|这版先|我建议下一步|建议下一步|这里最重要的是|基于现有上下文|从.*角度来看|I want to clarify|At this stage|Current result:|Here is the current state|For this round|At this point|Based on the current context|The key thing is)/i.test(segment);
  });
  if (segments.length === 0) return normalized;
  return segments.join("<br>");
}

function looksLikeConcreteExecutionDeliverable(content: string): boolean {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  const deliverableListCount = countListLikeDeliverableItems(content);
  const quotedItemCount = countQuotedDeliverableItems(content);
  const inlineEnumeratedSteps = [...normalized.matchAll(/(?:^|[\s，,:：;；(（。！？.!?])([1-9])[、,.，．]\s*([^0-9][^]*?)(?=(?:[\s，,:：;；(（。！？.!?][1-9][、,.，．]\s*)|$)/g)];
  const hasInlineEnumeration = new Set(inlineEnumeratedSteps.map((match) => match[1])).size >= 2;
  return /(^|\n)\s*([0-9]+\.)\s/.test(content)
    || hasInlineEnumeration
    || deliverableListCount >= 3
    || quotedItemCount >= 3
    || /(thumbnail idea|hook 1|hook 2|hook 3|脚本初稿|thumbnail|hook 的三个版本|3 个 thumbnail idea|3 个 hook|3 条 hook|三条 hook|三个版本|方案一|方案二|方案三|版本一|版本二|版本三|开头 1|开头 2|开头 3|视频开头|口播开头|完整的三个视频开头|opening 1|opening 2|opening 3|intro 1|intro 2|intro 3|A\/B|A:|B:|must-fix|硬问题|硬缺口|可访问 URL|图片 URL|url|https?:\/\/|src\/[A-Za-z0-9._/-]+|collaboration-hall(?:-theme)?\.ts|server\.ts|hall-runtime-dispatch\.ts|orchestrator\.ts|types\.ts|README(?:\.zh-CN)?\.md|代码里|源码里|文件里|在 .*\\.ts 里)/i.test(normalized);
}

export function enforceConcreteDeliverableReply(
  dispatch: HallRuntimeDispatchInput,
  visibleContent: string,
  nextAction: HallRuntimeNextAction | undefined,
  language: HallResponseLanguage,
  operatorIntent?: HallOperatorIntent,
): ConcreteDeliverableEnforcement {
  const strictDirectAsk = dispatch.mode === "discussion" && isDirectResponseIntent(operatorIntent);
  if (dispatch.mode === "discussion" && !strictDirectAsk) {
    return { content: visibleContent, nextAction };
  }
  const currentTask = dispatch.mode === "discussion"
    ? (operatorIntent?.text ?? "")
    : (resolveCurrentExecutionItem(dispatch.taskCard, dispatch.participant.participantId)?.task ?? "");
  // In the group chat model, agents respond conversationally. Only enforce
  // concrete deliverables when there is an explicit execution task assigned.
  if (!currentTask.trim() && !strictDirectAsk) {
    return { content: visibleContent, nextAction };
  }
  const requiresConcreteDeliverable = strictDirectAsk || requiresConcreteDeliverableForStep(currentTask);
  if (!requiresConcreteDeliverable) {
    return { content: visibleContent, nextAction };
  }
  const deliverableKind = resolveConcreteDeliverableKind(currentTask, operatorIntent);
  if (strictDirectAsk) {
    if (matchesConcreteDeliverableKind(deliverableKind, visibleContent, currentTask)) {
      return { content: visibleContent, nextAction };
    }
    return {
      content: visibleContent,
      nextAction: "continue",
      nextStep: buildConcreteDeliverableRetryInstruction(currentTask, language, operatorIntent),
    };
  }
  if (deliverableKind !== "generic") {
    if (matchesConcreteDeliverableKind(deliverableKind, visibleContent, currentTask)) {
      return { content: visibleContent, nextAction };
    }
    if (looksLikeConcreteExecutionDeliverable(visibleContent)) {
      return {
        content: visibleContent,
        nextAction: "continue",
        nextStep: buildConcreteDeliverableRetryInstruction(currentTask, language, operatorIntent),
        messageKindOverride: "status",
        preserveExistingSummary: true,
      };
    }
    return {
      content: "",
      nextAction: "continue",
      suppressVisibleMessage: true,
      nextStep: buildConcreteDeliverableRetryInstruction(currentTask, language, operatorIntent),
    };
  }
  if (looksLikeConcreteExecutionDeliverable(visibleContent)) {
    return { content: visibleContent, nextAction };
  }
  return {
    content: "",
    nextAction: "continue",
    suppressVisibleMessage: true,
    nextStep: buildConcreteDeliverableRetryInstruction(currentTask, language, operatorIntent),
  };
}

function countListLikeDeliverableItems(content: string): number {
  const normalized = content
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\r\n/g, "\n");
  const lineMatches = normalized.match(/^\s*(?:开头\s*)?(?:[1-9]|[一二三四五六七八九])[、,.，．:：)\]]\s+/gmu) ?? [];
  const inlineMatches = [
    ...normalized.matchAll(/(?:^|[\s，,:：;；(（。！？.!?])(?:开头\s*)?([1-9]|[一二三四五六七八九])[、,.，．:：)\]]\s*/gmu),
  ];
  return Math.max(
    lineMatches.length,
    new Set(inlineMatches.map((match) => match[1])).size,
  );
}

function countQuotedDeliverableItems(content: string): number {
  const normalized = content.replace(/<br\s*\/?>/gi, "\n");
  const chinese = normalized.match(/[“]([^”\n]{4,800})[”]/g) ?? [];
  const english = normalized.match(/["]([^"\n]{4,800})["]/g) ?? [];
  return chinese.length + english.length;
}

function countStandaloneQuotedParagraphs(content: string): number {
  const normalized = content
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\r\n/g, "\n");
  return normalized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[“"][^”"\n]{24,1200}[”"]$/.test(line))
    .length;
}

function countLongDeliverableParagraphs(content: string): number {
  const normalized = content
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\r\n/g, "\n");
  return normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^@/.test(line))
    .filter((line) => !/^(这\s*[0-9一二三两]+\s*个(开头|版本|方案)|[0-9一二三两]+\s*个(开头|版本|方案)先|开头先|先锁住)/.test(line))
    .filter((line) => line.length >= 40)
    .length;
}

function resolveRequestedDeliverableCount(task: string | undefined): number {
  const normalized = String(task || "").trim();
  if (!normalized) return 1;
  if (/(?:exactly\s*)?(?:three|3)\b|3\s*(?:个|条|版|种|份)|三\s*(?:个|条|版|种|份)/i.test(normalized)) {
    return 3;
  }
  if (/\b(?:one|single|1)\b|1\s*(?:个|条|版|种|份)|一\s*(?:个|条|版|种|份)/i.test(normalized)) {
    return 1;
  }
  return 1;
}

function looksLikeSpokenOpeningBundle(content: string): boolean {
  const normalized = sanitizeHallVisibleRuntimeText(content)
    .replace(/<br\s*\/?>/gi, "\n")
    .trim();
  if (!normalized) return false;
  const quotedParagraphCount = countStandaloneQuotedParagraphs(normalized);
  const longParagraphCount = countLongDeliverableParagraphs(normalized);
  return /(这\s*[0-9一二三两]+\s*个开头|[0-9一二三两]+\s*个开头先|完整.*视频开头|完整可口播.*开头|可直接口播)/i.test(normalized)
    && (quotedParagraphCount >= 3 || longParagraphCount >= 3);
}

function looksLikeLongSpokenOpeningsDeliverable(content: string, task?: string): boolean {
  const normalized = sanitizeHallVisibleRuntimeText(content)
    .replace(/<br\s*\/?>/gi, "\n")
    .trim();
  if (!normalized) return false;
  const requiredCount = resolveRequestedDeliverableCount(task);
  const longParagraphCount = countLongDeliverableParagraphs(normalized);
  const quotedParagraphCount = countStandaloneQuotedParagraphs(normalized);
  return /(开头|口播|首屏口播|可口播|视频首屏)/i.test(normalized)
    && (quotedParagraphCount >= requiredCount || longParagraphCount >= requiredCount)
    && !/(src\/|runtime|dispatch|orchestrator|\.ts\b|README|代码|源码|文件路径|file path)/i.test(normalized);
}

function resolveConcreteDeliverableKind(
  task: string | undefined,
  operatorIntent?: HallOperatorIntent,
): ConcreteDeliverableKind {
  const normalized = String(task || "").trim();
  const normalizedIntentSource = normalizeHallIntentSourceText(normalized);
  if (
    operatorIntent?.type === "review_request"
    || /(must-fix|review only|审核|评审|检查上一位结果|挑一下|挑出|只挑|硬问题|硬缺口)/i.test(normalized)
  ) {
    return "review";
  }
  if (operatorIntent?.type === "repo_scan_request" || looksLikeRepoInspectionRequest(normalizedIntentSource)) {
    return "repo_scan";
  }
  if (/(thumbnail|缩略图)/i.test(normalized) && /(url|链接|image|图)/i.test(normalized)) {
    return "thumbnail_urls";
  }
  if (/(thumbnail|缩略图)/i.test(normalized)) {
    return "thumbnail_ideas";
  }
  if (/(视频开头|口播开头|开头文案|完整.*开头|完整可口播开头|video opening|spoken opening|spoken openings|intro line|intro lines|opening lines|开场白|开场文案|开头)/i.test(normalized)) {
    return "spoken_openings";
  }
  if (/(hook|标题|文案)/i.test(normalized)) {
    return "hooks";
  }
  if (/(script|脚本|台词|分镜|storyboard|outline)/i.test(normalized)) {
    return "script";
  }
  return "generic";
}

function matchesConcreteDeliverableKind(
  kind: ConcreteDeliverableKind,
  content: string,
  task?: string,
): boolean {
  const normalized = sanitizeHallVisibleRuntimeText(content)
    .replace(/<br\s*\/?>/gi, "\n")
    .trim();
  if (!normalized) return false;
  const requiredCount = resolveRequestedDeliverableCount(task);
  const listCount = countListLikeDeliverableItems(normalized);
  const quoteCount = countQuotedDeliverableItems(normalized);
  const quotedParagraphCount = countStandaloneQuotedParagraphs(normalized);
  const longParagraphCount = countLongDeliverableParagraphs(normalized);
  const pathMatches = normalized.match(/(?:\/[^\s、，,:：;；()（）]+?\.(?:ts|tsx|js|jsx|md|html)|src\/[A-Za-z0-9._/-]+?\.(?:ts|tsx|js|jsx|md|html))/g) ?? [];
  const urlMatches = normalized.match(/(?:https?:\/\/|file:\/\/\/)[^\s]+/gi) ?? [];

  switch (kind) {
    case "repo_scan":
      return pathMatches.length >= 2 && (
        listCount >= 1
        || /(结论|发现|负责|证明|说明|对应|shows|proves|responsible|handles|drives)/i.test(normalized)
        || normalized.length >= 120
      );
    case "review":
      return /(must-fix|不过|通过|pass|clean pass|硬问题|硬缺口|可以过|需要改)/i.test(normalized);
    case "thumbnail_urls":
      return urlMatches.length >= requiredCount;
    case "thumbnail_ideas":
      return listCount >= requiredCount
        || quoteCount >= requiredCount
        || (requiredCount <= 1 && /(thumbnail|缩略图)/i.test(normalized) && normalized.length >= 24);
    case "spoken_openings":
      return /开头\s*[123一二三]/i.test(normalized)
        || (quoteCount >= requiredCount && pathMatches.length === 0)
        || (quotedParagraphCount >= requiredCount && pathMatches.length === 0)
        || (looksLikeSpokenOpeningBundle(normalized) && pathMatches.length === 0)
        || (
          requiredCount > 1
          && longParagraphCount >= requiredCount
          && pathMatches.length === 0
          && !/(src\/|runtime|dispatch|orchestrator|\.ts\b|README|代码|源码|文件路径|file path)/i.test(normalized)
        )
        || (
          listCount >= requiredCount
          && pathMatches.length === 0
          && !/(src\/|runtime|dispatch|orchestrator|\.ts\b|README|代码|源码|文件路径|file path)/i.test(normalized)
        )
        || (
          requiredCount <= 1
          && longParagraphCount >= 1
          && pathMatches.length === 0
          && !/(src\/|runtime|dispatch|orchestrator|\.ts\b|README|代码|源码|文件路径|file path)/i.test(normalized)
        );
    case "hooks":
      return listCount >= requiredCount || quoteCount >= requiredCount;
    case "script":
      return listCount >= 2
        || quoteCount >= 3
        || normalized.split("\n").filter((line) => line.trim().length > 0).length >= 3
        || normalized.length >= 160
        || (requiredCount <= 1 && /(script|脚本|台词|分镜|storyboard)/i.test(task ?? normalized) && (urlMatches.length >= 1 || normalized.length >= 20));
    case "generic":
    default:
      return looksLikeConcreteExecutionDeliverable(normalized);
  }
}

function hasAnyVisibleParticipantMention(content: string): boolean {
  return /(^|[\s(>\[\{<,.;:!?"'“”‘’，。！？；：、）】」』》])@[A-Za-z0-9_\-\u4e00-\u9fff]+/.test(
    sanitizeHallVisibleRuntimeText(content),
  );
}

function resolveVisibleExecutionCompletion(input: {
  dispatch: HallRuntimeDispatchInput;
  content: string;
  currentExecutionItem?: HallExecutionItem;
  nextParticipant?: HallParticipant;
}): {
  concreteDeliverable: boolean;
  explicitHandoffToNext: boolean;
  hasAnyVisibleHandoffMention: boolean;
  seemsComplete: boolean;
  completedWithVisibleHandoff: boolean;
} {
  const { dispatch, content, currentExecutionItem, nextParticipant } = input;
  const currentTask = currentExecutionItem?.task ?? "";
  const deliverableKind = resolveConcreteDeliverableKind(currentTask);
  const visibleContent = sanitizeHallVisibleRuntimeText(content);
  const mentionedNextParticipant = nextParticipant
    ? detectExplicitMentionedParticipant(dispatch.hall, visibleContent, dispatch.participant.participantId)
    : undefined;
  const explicitHandoffToNext = Boolean(
    nextParticipant
    && mentionedNextParticipant
    && mentionedNextParticipant.participantId === nextParticipant.participantId,
  );
  const hasAnyVisibleHandoffMention = hasAnyVisibleParticipantMention(visibleContent);
  const concreteDeliverable = matchesConcreteDeliverableKind(deliverableKind, visibleContent, currentTask)
    || (deliverableKind === "spoken_openings" && looksLikeLongSpokenOpeningsDeliverable(visibleContent, currentTask))
    || looksLikeConcreteExecutionDeliverable(visibleContent);
  const seemsComplete = looksLikeCompletedExecutionUpdate(visibleContent)
    || explicitHandoffToNext;
  const completedWithVisibleHandoff = concreteDeliverable && (
    nextParticipant && nextParticipant.participantId !== dispatch.participant.participantId
      ? (explicitHandoffToNext || seemsComplete)
      : seemsComplete
  );
  return {
    concreteDeliverable,
    explicitHandoffToNext,
    hasAnyVisibleHandoffMention,
    seemsComplete,
    completedWithVisibleHandoff,
  };
}

function normalizeImplicitHallExecutionNextAction(
  dispatch: HallRuntimeDispatchInput,
  structured: ParsedStructuredBlock,
  content: string,
): HallRuntimeNextAction | undefined {
  if (dispatch.mode === "discussion") return undefined;

  const currentExecutionItem = resolveCurrentExecutionItem(dispatch.taskCard, dispatch.participant.participantId);
  const queuedNextParticipantId = currentExecutionItem
    ? (currentExecutionItem.handoffToParticipantId?.trim() || "")
    : (dispatch.taskCard.plannedExecutionOrder[0] || "");
  const nextParticipant = queuedNextParticipantId
    ? dispatch.hall.participants.find((participant) => participant.participantId === queuedNextParticipantId)
    : undefined;
  const visibleCompletion = resolveVisibleExecutionCompletion({
    dispatch,
    content,
    currentExecutionItem,
    nextParticipant,
  });
  if (visibleCompletion.completedWithVisibleHandoff) {
    return nextParticipant && nextParticipant.participantId !== dispatch.participant.participantId ? "handoff" : "review";
  }
  if (shouldPreferVisibleDeliverableCompletion(dispatch, structured, content, currentExecutionItem, nextParticipant)) {
    return nextParticipant && nextParticipant.participantId !== dispatch.participant.participantId ? "handoff" : "review";
  }
  if (structured.nextAction) return structured.nextAction;
  if (dispatch.mode === "handoff" && nextParticipant && nextParticipant.participantId !== dispatch.participant.participantId) {
    if (looksLikeNeedsAnotherPass(content)) return "continue";
    return "handoff";
  }
  const seemsComplete = looksLikeCompletedExecutionUpdate(content);
  if (!seemsComplete) return undefined;

  if (nextParticipant && nextParticipant.participantId !== dispatch.participant.participantId) {
    return "handoff";
  }
  return "review";
}

function shouldPreferVisibleDeliverableCompletion(
  dispatch: HallRuntimeDispatchInput,
  structured: ParsedStructuredBlock,
  content: string,
  currentExecutionItem: HallExecutionItem | undefined,
  nextParticipant: HallParticipant | undefined,
): boolean {
  if (dispatch.mode === "discussion") return false;
  if (looksLikeNeedsAnotherPass(content)) return false;
  const hiddenBlockSignal =
    structured.nextAction === "continue"
    || (structured.blockers?.length ?? 0) > 0
    || (structured.requiresInputFrom?.length ?? 0) > 0;
  if (!hiddenBlockSignal) return false;
  const visibleCompletion = resolveVisibleExecutionCompletion({
    dispatch,
    content,
    currentExecutionItem,
    nextParticipant,
  });
  return visibleCompletion.completedWithVisibleHandoff;
}

function looksLikeCompletedExecutionUpdate(content: string): boolean {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return /(这一步.*(完成|做完|够了|成立|可以交给|收住)|已经(完成|补完|锁定|收住|够了)|可直接交给|下一步.*(交给|给)|交给\s*@?[A-Za-z0-9_\-\u4e00-\u9fa5]+|现在请\s*@?[A-Za-z0-9_\-\u4e00-\u9fa5]+|就可以\s*@?[A-Za-z0-9_\-\u4e00-\u9fa5]+|继续交给\s*@?[A-Za-z0-9_\-\u4e00-\u9fa5]+|ready for review|ready to hand off|handoff|hand off|hand it to|pass(?: it)? to|turn it over to|the next step is|can go to|send this to|ship this to)/i.test(normalized);
}

function requiresConcreteDeliverableForStep(task: string | undefined): boolean {
  const normalized = String(task || "").trim();
  if (!normalized) return true;
  if (resolveConcreteDeliverableKind(normalized) !== "generic") return true;
  if (/(承接上一步|继续推进|继续做|继续这一轮|收口这轮|检查上一位结果|指出必须修改项|review|评审|must-fix|硬问题|硬缺口|交接|handoff|next action)/i.test(normalized)) {
    return true;
  }
  return /(出|写|生成|产出|补|整理|收成|总结|锁定|给出|扫描|扫代码|扫描代码|看代码|看仓库|查仓库|repo|repository|codebase|source code|implementation|file path|workspace|draft|deliver|write|generate|produce|summarize|scan|inspect|review the repo|turn .* into|thumbnail|hook|script|brief|copy|idea|summary|文案|脚本|摘要|分镜|镜头|台词|样本|版本|源码|仓库|实现|文件)/i.test(normalized);
}

function buildConcreteDeliverableRetryInstruction(
  task: string | undefined,
  language: HallResponseLanguage,
  operatorIntent?: HallOperatorIntent,
): string {
  const kind = resolveConcreteDeliverableKind(task, operatorIntent);
  if (kind === "repo_scan") {
    return language === "zh"
      ? "别再讲原则或价值，下一条直接贴代码发现：至少 2 个真实文件路径，并说明每个文件证明了什么。"
      : "Stop meta-discussing and post concrete repo findings next: cite at least two real file paths and what each file proves.";
  }
  if (kind === "thumbnail_urls") {
    return language === "zh"
      ? "别再讲原则或价值，下一条直接贴 3 个 thumbnail 方向和对应 URL。"
      : "Stop meta-discussing and post the concrete deliverable next: three thumbnail directions plus their URLs.";
  }
  if (kind === "thumbnail_ideas") {
    return language === "zh"
      ? "别再讲原则或价值，下一条直接贴 3 个 thumbnail 方向。"
      : "Stop meta-discussing and post the concrete deliverable next: three thumbnail directions.";
  }
  if (kind === "spoken_openings") {
    return language === "zh"
      ? "别再讲原则或价值，下一条直接贴 3 个完整可口播的视频开头。"
      : "Stop meta-discussing and post the concrete deliverable next: three complete spoken video openings.";
  }
  if (kind === "hooks") {
    return language === "zh"
      ? "别再讲原则或价值，下一条直接贴 3 个 hook。"
      : "Stop meta-discussing and post the concrete deliverable next: three hooks.";
  }
  if (kind === "script") {
    return language === "zh"
      ? "别再讲原则或价值，下一条直接贴脚本/台词/分镜初稿。"
      : "Stop meta-discussing and post the concrete deliverable next: the draft script, lines, or storyboard.";
  }
  return language === "zh"
    ? "别再讲原则或价值，下一条直接贴具体产物。"
    : "Stop meta-discussing and post the concrete deliverable in the next reply.";
}

function buildConcreteExecutionOutputRequirement(
  task: string | undefined,
  language: HallResponseLanguage,
  operatorIntent?: HallOperatorIntent,
): string {
  const kind = resolveConcreteDeliverableKind(task, operatorIntent);
  if (kind === "repo_scan") {
    return language === "zh"
      ? "这一步必须直接贴 repo 发现：至少 3 个真实文件路径，并说明每个文件负责什么或证明了什么。"
      : "This step must post concrete repo findings: cite at least three real file paths and what each file is responsible for or proves.";
  }
  if (kind === "thumbnail_urls") {
    return language === "zh"
      ? "这一步必须直接贴交付物：3 个 thumbnail 方向，并给出对应可访问 URL。"
      : "This step must post the deliverable itself: three thumbnail directions plus their accessible URLs.";
  }
  if (kind === "thumbnail_ideas") {
    return language === "zh"
      ? "这一步必须直接贴交付物：3 个 thumbnail 方向。"
      : "This step must post the deliverable itself: three thumbnail directions.";
  }
  if (kind === "spoken_openings") {
    return language === "zh"
      ? "这一步必须直接贴交付物：3 个完整可口播的视频开头。"
      : "This step must post the deliverable itself: three complete spoken video openings.";
  }
  if (kind === "hooks") {
    return language === "zh"
      ? "这一步必须直接贴交付物：3 个 hook 完整版本。"
      : "This step must post the deliverable itself: three full hook versions.";
  }
  if (kind === "script") {
    return language === "zh"
      ? "这一步必须直接贴交付物：脚本/台词/分镜初稿。"
      : "This step must post the deliverable itself: the draft script, lines, or storyboard.";
  }
  return language === "zh"
    ? "这一步必须直接贴交付物本身，不要只评论方向。"
    : "This step must post the concrete deliverable itself, not just commentary about the direction.";
}

function looksLikeMetaExecutionDiscussion(content: string): boolean {
  const normalized = sanitizeHallVisibleRuntimeText(content).replace(/<br\s*\/?>/gi, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  const hasConcreteShape =
    /(^|\s)([-*•]|[0-9]+\.)\s/.test(normalized)
    || /[“"][^“"\n]{4,}[”"]/.test(normalized)
    || /https?:\/\//i.test(normalized)
    || /(A\/B|A:|B:|方案一|方案二|版本一|版本二|脚本初稿|thumbnail idea|hook 1|hook 2|must-fix)/i.test(normalized);
  if (hasConcreteShape) return false;
  return /(第一版里|最好|更适合|这样|不然|价值|观众|画面|样本|约束|风险|方向|更像|说明|证明|优先|建议|适合|最稳|关键不是|缺的角度|最该|这版.*(更|会)|不会被.*带跑|一眼读完|人工|协调成本)/i.test(normalized);
}

function looksLikeNeedsAnotherPass(content: string): boolean {
  const normalized = sanitizeHallVisibleRuntimeText(content)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;
  return /(我先再|我还要再|我再补一轮|我再改一轮|我先继续改|我先补完|需要我再|我继续把这一步|one more pass|another pass|i will revise|i'll revise|i will keep refining|i'll keep refining|i need one more pass|let me tighten this)/i.test(normalized);
}

function resolveHallRuntimeMessageKind(
  input: HallRuntimeDispatchInput,
  operatorIntent?: HallOperatorIntent,
): HallMessage["kind"] {
  if (input.mode === "discussion") {
    if (isDirectResponseIntent(operatorIntent)) return "status";
    return input.participant.semanticRole === "manager" ? "decision" : "proposal";
  }
  return input.mode === "handoff" ? "handoff" : "status";
}

function pickFallbackExecutor(
  hall: CollaborationHall,
  taskCard: HallTaskCard,
  task?: ProjectTask,
): HallParticipant | undefined {
  const domain = inferRuntimeDiscussionDomain(taskCard, task);
  for (const role of runtimeRecommendedExecutorRoleOrder(domain)) {
    const participant = pickRuntimeParticipantForRole(hall.participants, role);
    if (participant) return participant;
  }
  return hall.participants.find((participant) => participant.semanticRole === "planner" && participant.active)
    ?? hall.participants.find((participant) => participant.semanticRole === "coder" && participant.active)
    ?? hall.participants.find((participant) => participant.active)
    ?? hall.participants[0];
}

function buildRuntimeSuggestedExecutionOrder(
  hall: CollaborationHall,
  taskCard: HallTaskCard,
  firstOwnerParticipantId: string,
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const participantId of [
    firstOwnerParticipantId,
    ...taskCard.requiresInputFrom,
    ...taskCard.mentionedParticipantIds,
  ]) {
    if (!participantId || seen.has(participantId)) continue;
    if (!hall.participants.some((participant) => participant.participantId === participantId)) continue;
    seen.add(participantId);
    ordered.push(participantId);
  }
  return ordered;
}

function inferRuntimeDiscussionDomain(taskCard: HallTaskCard, task: ProjectTask | undefined): string {
  return inferHallDiscussionDomainFromText(`${taskCard.title}\n${taskCard.description}\n${task?.title ?? ""}`);
}

function runtimeRecommendedExecutorRoleOrder(domain: string): HallSemanticRole[] {
  if (domain === "engineering") return ["coder", "planner", "manager"];
  if (domain === "creative") return ["planner", "coder", "generalist"];
  if (domain === "analysis") return ["planner", "coder", "reviewer"];
  if (domain === "product") return ["planner", "manager", "coder"];
  if (domain === "research") return ["planner", "reviewer", "manager"];
  if (domain === "operations") return ["manager", "planner", "reviewer"];
  return ["planner", "generalist", "manager", "coder"];
}

function pickRuntimeParticipantForRole(
  participants: HallParticipant[],
  role: HallSemanticRole,
): HallParticipant | undefined {
  if (role === "generalist") {
    return participants.find((participant) => participant.active && participant.semanticRole === "generalist");
  }
  return participants.find((participant) => participant.active && participant.semanticRole === role);
}

function resolveExecutorParticipant(hall: CollaborationHall, rawExecutor: string | undefined): HallParticipant | undefined {
  const query = rawExecutor?.trim();
  if (!query) return undefined;
  const normalized = normalizeLookup(query);
  return hall.participants.find((participant) => {
    if (normalizeLookup(participant.participantId) === normalized) return true;
    if (normalizeLookup(participant.displayName) === normalized) return true;
    return participant.aliases.some((alias) => normalizeLookup(alias) === normalized);
  });
}

function detectExplicitMentionedParticipant(
  hall: CollaborationHall,
  content: string | undefined,
  excludeParticipantId?: string,
): HallParticipant | undefined {
  const normalizedContent = String(content || "").trim();
  if (!normalizedContent) return undefined;
  const mentionPattern = /(^|[\s(>\[\{<,.;:!?"'“”‘’，。！？；：、）】」』》])@([A-Za-z0-9_\-\u4e00-\u9fff]+)/g;
  let match: RegExpExecArray | null;
  while ((match = mentionPattern.exec(normalizedContent))) {
    const participant = resolveExecutorParticipant(hall, match[2]);
    if (!participant) continue;
    if (excludeParticipantId && participant.participantId === excludeParticipantId) continue;
    return participant;
  }
  return undefined;
}

function pickExpectedSessionKey(taskCard: HallTaskCard, agentId: string): string | undefined {
  const normalizedAgentId = normalizeLookup(agentId);
  if (!normalizedAgentId) return undefined;
  const threadScoped = buildHallThreadScopedSessionKey(taskCard, agentId);
  const linked = taskCard.sessionKeys.find((sessionKey) => normalizeLookup(sessionKey).includes(`agent:${normalizedAgentId}:`));
  const linkedThreadScoped = threadScoped
    ? taskCard.sessionKeys.find((sessionKey) => normalizeLookup(sessionKey) === normalizeLookup(threadScoped))
    : undefined;
  if (linkedThreadScoped) return linkedThreadScoped;
  if (linked && !isLegacySharedHallSessionKey(linked, agentId)) return linked;
  return threadScoped ?? linked;
}

function buildHallThreadScopedSessionKey(taskCard: HallTaskCard, agentId: string): string | undefined {
  const normalizedAgentId = normalizeLookup(agentId);
  const taskScope = normalizeLookup(taskCard.taskId || taskCard.taskCardId || "");
  if (!normalizedAgentId || !taskScope) return undefined;
  return `agent:${agentId}:hall:${taskScope}`;
}

function isFirstParticipantTurnInHallThread(taskCard: HallTaskCard, agentId: string): boolean {
  const threadScoped = buildHallThreadScopedSessionKey(taskCard, agentId);
  if (!threadScoped) return false;
  return !taskCard.sessionKeys.some(
    (sessionKey) => normalizeLookup(sessionKey) === normalizeLookup(threadScoped),
  );
}

function shouldApplyCleanHallThreadOpeningGuard(
  input: HallRuntimeDispatchInput,
  firstParticipantTurnInThread: boolean,
): boolean {
  if (!firstParticipantTurnInThread) return false;
  if (input.mode !== "discussion") return false;
  return countRecentAgentContributors(input.recentThreadMessages ?? []) === 0;
}

function isLegacySharedHallSessionKey(sessionKey: string, agentId: string): boolean {
  return normalizeLookup(sessionKey) === normalizeLookup(`agent:${agentId}:main`);
}

async function safeReadHistory(client: ToolClient, sessionKey: string): Promise<SessionHistoryMessage[]> {
  const history = await readSessionConversationHistory(client, sessionKey, HALL_RUNTIME_HISTORY_LIMIT);
  return history.history;
}

function renderRuntimeDraftText(
  messages: SessionHistoryMessage[],
  baselineFingerprint: string | undefined,
): string {
  const incremental = sliceMessagesAfterFingerprint(messages, baselineFingerprint);
  const segments = incremental
    .flatMap((message) => formatRuntimeStreamSegments(message))
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.join("\n\n");
}

function sliceMessagesAfterFingerprint(
  messages: SessionHistoryMessage[],
  baselineFingerprint: string | undefined,
): SessionHistoryMessage[] {
  if (!baselineFingerprint) return messages;
  let lastIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (fingerprintHistoryMessage(messages[index]) === baselineFingerprint) lastIndex = index;
  }
  return lastIndex >= 0 ? messages.slice(lastIndex + 1) : messages;
}

/**
 * Find the most recently modified session JSONL file for an agent.
 * First checks sessions.json (which stores the correct path even when openclaw
 * writes to a double-nested directory), then falls back to glob scanning.
 */
async function findLatestAgentSessionFile(agentId: string): Promise<string | undefined> {
  const openclawHome = resolveOpenClawHomePath();
  const sessionsJsonPath = join(openclawHome, "agents", agentId, "sessions", "sessions.json");

  // Prefer the path from sessions.json: openclaw records the exact sessionFile path
  // there, which may differ from the glob base (e.g. double-nested .openclaw/.openclaw).
  try {
    const parsed = JSON.parse(await readFile(sessionsJsonPath, "utf8")) as unknown;
    let bestPath: string | undefined;
    let bestUpdatedAt = 0;
    const root = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
    if (root) {
      for (const value of Object.values(root)) {
        if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
        const record = value as Record<string, unknown>;
        const sessionFile = typeof record.sessionFile === "string" ? record.sessionFile : undefined;
        const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : 0;
        if (sessionFile && updatedAt > bestUpdatedAt) {
          bestUpdatedAt = updatedAt;
          bestPath = sessionFile;
        }
      }
    }
    if (bestPath) return bestPath;
  } catch { /* ok — fall through to glob */ }

  // Fallback: glob for JSONL files in the standard outer path
  const sessionsDir = join(openclawHome, "agents", agentId, "sessions");
  let bestPath: string | undefined;
  let bestMtime = 0;
  try {
    const entries = await readdir(sessionsDir);
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      const fullPath = join(sessionsDir, f);
      const st = await stat(fullPath).catch(() => null);
      if (st && st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        bestPath = fullPath;
      }
    }
  } catch { /* directory not found */ }
  return bestPath;
}

function fingerprintHistoryMessage(message: SessionHistoryMessage): string {
  return [
    message.kind,
    message.role,
    message.timestamp ?? "",
    message.toolName ?? "",
    message.content.trim(),
  ].join("|");
}

function formatRuntimeStreamSegments(message: SessionHistoryMessage): string[] {
  if (message.kind === "tool_event") {
    const name = message.toolName || "tool";
    return [`[[tool:${name}]]`];
  }
  const role = message.role.trim().toLowerCase();
  if (role === "user" || role === "system") return [];
  const content = sanitizeHallVisibleRuntimeText(message.content);
  if (!content) return [];
  return [content];
}

function extractStructuredBlock(rawText: string): { visibleText: string; structured: ParsedStructuredBlock } {
  const match = /<hall-structured>\s*([\s\S]*?)\s*<\/hall-structured>/i.exec(rawText);
  if (!match) {
    const danglingStructuredStart = rawText.search(/<hall-structured>/i);
    const visibleText = (danglingStructuredStart >= 0 ? rawText.slice(0, danglingStructuredStart) : rawText).trim();
    return { visibleText, structured: {} };
  }
  let structured: ParsedStructuredBlock = {};
  try {
    const parsed = JSON.parse(match[1]) as Record<string, unknown>;
    structured = {
      proposal: asOptionalString(parsed.proposal),
      decision: asOptionalString(parsed.decision),
      executor: asOptionalString(parsed.executor),
      doneWhen: asOptionalString(parsed.doneWhen),
      blockers: asOptionalStringArray(parsed.blockers),
      requiresInputFrom: asOptionalStringArray(parsed.requiresInputFrom),
      latestSummary: asOptionalString(parsed.latestSummary),
      nextAction: asOptionalNextAction(parsed.nextAction),
      nextStep: asOptionalString(parsed.nextStep),
      artifactRefs: asOptionalArtifactRefs(parsed.artifactRefs),
      parallelTasks: asOptionalParallelTasks(parsed.parallelTasks),
    };
  } catch {
    structured = {};
  }
  const visibleText = rawText.replace(match[0], "").trim();
  return { visibleText, structured };
}

function buildFallbackVisibleContent(input: HallRuntimeDispatchInput, rawText: string): string {
  const trimmed = sanitizeHallVisibleRuntimeText(rawText);
  if (trimmed) return trimmed;
  const language = inferHallResponseLanguage(
    input.triggerMessage?.content
      ?? `${input.taskCard.title}\n${input.taskCard.description}\n${input.task?.title ?? ""}`,
  );
  if (input.mode === "discussion" && input.participant.semanticRole === "manager") {
    return language === "zh"
      ? `${input.participant.displayName} 先收住这轮，直接定人开做。`
      : `${input.participant.displayName} landed this round and the next owner can start now.`;
  }
  if (input.mode === "discussion") {
    return language === "zh"
      ? `${input.participant.displayName} 补了一个关键角度。`
      : `${input.participant.displayName} added one useful angle.`;
  }
  if (input.mode === "handoff") {
    return language === "zh"
      ? `${input.participant.displayName} 接棒了，继续往下做。`
      : `${input.participant.displayName} took the handoff and is moving it forward.`;
  }
  return language === "zh"
    ? `${input.participant.displayName} 把这一步往前推进了。`
    : `${input.participant.displayName} moved this step forward.`;
}

function formatHallVisibleContentForMode(
  input: HallRuntimeDispatchInput,
  raw: string,
  language: HallResponseLanguage,
  directResponseIntent: HallOperatorIntent | undefined,
): string {
  return input.mode === "discussion"
    ? (directResponseIntent
        ? sanitizeDirectTaskVisibleRuntimeText(input, raw)
        : sanitizeDiscussionVisibleRuntimeText(input, raw))
    : compactHallCoworkerReply(raw, language);
}

function ensureNonEmptyHallVisibleRuntimeText(
  input: HallRuntimeDispatchInput,
  visibleContent: string,
  structured: ParsedStructuredBlock,
  language: HallResponseLanguage,
  directResponseIntent: HallOperatorIntent | undefined,
  allowGenericFallback: boolean,
): string {
  const normalizedVisible = sanitizeHallVisibleRuntimeText(visibleContent);
  if (normalizedVisible) return visibleContent.trim();

  const structuredFallbackRaw = [
    structured.latestSummary,
    structured.decision,
    structured.proposal,
    structured.doneWhen,
  ].find((candidate) => sanitizeHallVisibleRuntimeText(candidate));

  if (structuredFallbackRaw) {
    const structuredFallback = formatHallVisibleContentForMode(
      input,
      structuredFallbackRaw,
      language,
      directResponseIntent,
    ).trim();
    if (sanitizeHallVisibleRuntimeText(structuredFallback)) {
      return structuredFallback;
    }
  }

  return allowGenericFallback ? buildFallbackVisibleContent(input, structured.latestSummary ?? "") : "";
}

function sanitizeDiscussionVisibleRuntimeText(
  dispatch: HallRuntimeDispatchInput,
  raw: string,
): string {
  const sanitized = sanitizeHallVisibleRuntimeText(raw);
  const normalizedMentions = normalizeHallVisibleMentions(dispatch, sanitized);
  if (dispatch.participant.semanticRole === "manager") {
    return compactHallDiscussionReply(normalizedMentions, inferHallResponseLanguage(raw));
  }

  return compactHallDiscussionReply(normalizedMentions, inferHallResponseLanguage(raw));
}

function sanitizeDirectTaskVisibleRuntimeText(
  dispatch: HallRuntimeDispatchInput,
  raw: string,
): string {
  const sanitized = sanitizeHallVisibleRuntimeText(raw);
  return normalizeHallVisibleMentions(dispatch, sanitized);
}

function normalizeHallVisibleMentions(
  dispatch: HallRuntimeDispatchInput,
  sanitized: string,
): string {
  const allowedMentions = new Set<string>();
  for (const target of dispatch.triggerMessage?.mentionTargets ?? []) {
    const participant = target.participantId
      ? dispatch.hall.participants.find((item) => item.participantId === target.participantId)
      : undefined;
    if (!participant) continue;
    for (const alias of [participant.participantId, participant.displayName, ...participant.aliases]) {
      const normalized = normalizeLookup(String(alias || ""));
      if (normalized) allowedMentions.add(normalized);
    }
  }

  const rewriteMention = (prefix: string, rawName: string): string => {
    const participant = resolveExecutorParticipant(dispatch.hall, rawName);
    if (!participant) return `${prefix}@${rawName}`;
    const keepMention =
      allowedMentions.size > 0 &&
      [participant.participantId, participant.displayName, ...participant.aliases]
        .map((value) => normalizeLookup(String(value || "")))
        .some((value) => value && allowedMentions.has(value));
    return keepMention
      ? `${prefix}@${participant.displayName}`
      : `${prefix}${participant.displayName}`;
  };

  const normalizedMentions = sanitized
    .replace(/(^|[\s(>])@([A-Za-z0-9_\-\u4e00-\u9fff]+)/g, (_match, prefix: string, rawName: string) => rewriteMention(prefix, rawName))
    .replace(/(<br\s*\/?>)@([A-Za-z0-9_\-\u4e00-\u9fff]+)/gi, (_match, prefix: string, rawName: string) => rewriteMention(prefix, rawName));
  return normalizedMentions;
}

export function compactHallDiscussionReply(content: string, language: HallResponseLanguage): string {
  const normalized = sanitizeHallVisibleRuntimeText(content)
    .replace(/<br\s*\/?>/gi, "\n")
    .trim();
  if (!normalized) return content;
  return normalized
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("<br>");
}

function sanitizeManagerDiscussionText(
  value: string | undefined,
  rawExecutor: string | undefined,
  resolvedExecutorLabel: string | undefined,
): string | undefined {
  const normalizedValue = value?.trim();
  const staleExecutor = rawExecutor?.trim();
  const safeExecutorLabel = resolvedExecutorLabel?.trim();
  if (!normalizedValue) return undefined;
  let sanitized = normalizedValue
    .replace(/(?:^|\n)\s*(Suggested first executor|Suggested order|Done when|Recommendation|Decision)\s*:\s*/giu, "$1: ")
    .replace(/\b(Suggested first executor|Suggested order|Done when)\s*:\s*/giu, "")
    .trim();
  if (!staleExecutor || !safeExecutorLabel) return sanitized;
  if (normalizeLookup(staleExecutor) === normalizeLookup(safeExecutorLabel)) return sanitized;
  const pattern = new RegExp(escapeRegExp(staleExecutor), "giu");
  sanitized = sanitized.replace(pattern, safeExecutorLabel);
  return sanitized;
}

function inferHallResponseLanguage(source: string | undefined): HallResponseLanguage {
  const value = String(source ?? "").trim();
  if (!value) return "en";
  const cjkMatches = value.match(/[\u4e00-\u9fff]/g) ?? [];
  const latinMatches = value.match(/[A-Za-z]/g) ?? [];
  if (cjkMatches.length > 0) return "zh";
  if (latinMatches.length > 0) return "en";
  return "en";
}

function normalizeLookup(value: string): string {
  return value.trim().toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function asOptionalNextAction(value: unknown): HallRuntimeNextAction | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "continue":
    case "review":
    case "handoff":
    case "done":
    case "parallel_dispatch":
      return value.trim().toLowerCase() as HallRuntimeNextAction;
    default:
      return undefined;
  }
}

function asOptionalParallelTasks(value: unknown): HallParallelTaskTarget[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tasks = value
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      executor: typeof item.executor === "string" ? item.executor.trim() : "",
      task: typeof item.task === "string" ? item.task.trim() : "",
    }))
    .filter((item) => item.executor && item.task);
  return tasks.length > 0 ? tasks : undefined;
}

function asOptionalArtifactRefs(value: unknown): TaskArtifact[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs = value
    .map((item) => normalizeRuntimeArtifactRef(item))
    .filter((item): item is TaskArtifact => Boolean(item));
  return refs.length > 0 ? refs : undefined;
}

function normalizeRuntimeArtifactRef(value: unknown): TaskArtifact | undefined {
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  const location = typeof object.location === "string" ? object.location.trim() : "";
  if (!location) return undefined;
  const label = typeof object.label === "string" && object.label.trim()
    ? object.label.trim()
    : inferArtifactLabelFromLocation(location);
  const explicitType = typeof object.type === "string" ? object.type.trim().toLowerCase() : "";
  const type = explicitType === "code" || explicitType === "doc" || explicitType === "link" || explicitType === "other"
    ? explicitType
    : inferArtifactTypeFromLocation(location);
  const artifactId = typeof object.artifactId === "string" && object.artifactId.trim()
    ? object.artifactId.trim()
    : buildRuntimeArtifactId(location);
  return {
    artifactId,
    type,
    label,
    location,
  };
}

function resolveHallRuntimeArtifactRefs(
  dispatch: HallRuntimeDispatchInput,
  structured: ParsedStructuredBlock,
  _visibleContent: string,
): TaskArtifact[] {
  return mergeArtifactRefs(
    dispatch.mode === "handoff" ? dispatch.handoff?.artifactRefs : undefined,
    structured.artifactRefs,
  );
}

function mergeArtifactRefs(...groups: Array<TaskArtifact[] | undefined>): TaskArtifact[] {
  const merged = new Map<string, TaskArtifact>();
  for (const group of groups) {
    if (!group || group.length === 0) continue;
    for (const artifact of group) {
      if (!artifact?.location) continue;
      const key = normalizeLookup(artifact.location);
      if (merged.has(key)) continue;
      merged.set(key, artifact);
    }
  }
  return [...merged.values()];
}

function buildRuntimeArtifactId(seed: string): string {
  return `artifact-${stableRuntimeHash(seed).toString(16)}`;
}

function stableRuntimeHash(input: string): number {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 33 + input.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function inferArtifactTypeFromLocation(location: string): TaskArtifact["type"] {
  const normalized = location.trim().toLowerCase();
  if (/\.(ts|tsx|js|jsx|json|py|rb|go|rs|java|kt|swift|sh|sql|yaml|yml)(?:[?#].*)?$/.test(normalized)) {
    return "code";
  }
  if (/\.(md|txt|pdf|docx?|pptx?|csv|xlsx?)(?:[?#].*)?$/.test(normalized)) {
    return "doc";
  }
  if (/^https?:\/\//.test(normalized)) {
    return "link";
  }
  return "other";
}

function inferArtifactLabelFromLocation(location: string): string {
  try {
    const url = new URL(location);
    const pathname = url.pathname.split("/").filter(Boolean);
    return pathname.at(-1) || url.hostname || location;
  } catch {
    const tokens = location.split(/[\\/]/).filter(Boolean);
    return tokens.at(-1) || location;
  }
}

function sanitizeDirectRuntimeOutput(raw: string): string {
  return sanitizeHallVisibleRuntimeText(raw);
}

function formatHallRuntimeDraftVisibleText(
  input: HallRuntimeDispatchInput,
  raw: string | undefined,
): string {
  const parsed = extractStructuredBlock(String(raw ?? ""));
  const responseLanguage = inferHallResponseLanguage(
    `${raw ?? ""}\n${input.triggerMessage?.content ?? ""}\n${input.taskCard.title}\n${input.taskCard.description}`,
  );
  const operatorIntent = resolveHallOperatorIntent(input);
  const directResponseIntent = isDirectResponseIntent(operatorIntent) ? operatorIntent : undefined;
  const sanitized = sanitizeDirectRuntimeOutput(parsed.visibleText || raw || "");
  const freshThreadSanitized = stripCleanHallThreadContinuationLead(input, sanitized);
  const visibleContentBase = input.mode !== "discussion"
    ? freshThreadSanitized
    : formatHallVisibleContentForMode(input, freshThreadSanitized, responseLanguage, directResponseIntent);
  return ensureNonEmptyHallVisibleRuntimeText(
    input,
    visibleContentBase,
    parsed.structured,
    responseLanguage,
    directResponseIntent,
    false,
  );
}

function sanitizeHallVisibleRuntimeText(raw: string | undefined): string {
  const value = String(raw ?? "");
  const normalized = value
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n")
    .replace(/<hall-structured>[\s\S]*?(?:<\/hall-structured>|$)/gi, "")
    .replace(/",\s*"(nextAction|nextStep|latestSummary|artifactRefs|proposal|decision|executor|doneWhen|blockers|requiresInputFrom)"\s*:\s*[\s\S]*$/i, "");
  const lines = normalized
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("🦞 OpenClaw"))
    .filter((line) => !line.startsWith("Registered plugin command:"))
    .filter((line) => !/Waiting for agent reply/i.test(line))
    .filter((line) => !/^[◒◐◓◑◇│]+$/.test(line))
    .filter((line) => !/^流式中$/i.test(line))
    .filter((line) => !/<\/?hall-structured>/i.test(line))
    .filter((line) => !/^[,{]?\s*"?(nextAction|nextStep|latestSummary|artifactRefs|proposal|decision|executor|doneWhen|blockers|requiresInputFrom)"\s*:/i.test(line))
    .filter((line) => !/^\[tool(?:[^\]]*)?\]/i.test(line))
    .filter((line) => !/^thinking\b/i.test(line))
    .filter((line) => !/^Inspecting\b/i.test(line))
    .filter((line) => !/^Checking\b/i.test(line))
    .filter((line) => !/^Considering\b/i.test(line))
    .filter((line) => !/^Maybe\b/i.test(line))
    .filter((line) => !/^It seems\b/i.test(line))
    .filter((line) => !/^Since the user\b/i.test(line))
    .filter((line) => !/^I should\b/i.test(line))
    .filter((line) => !/^I think\b/i.test(line))
    .filter((line) => !/^I might\b/i.test(line))
    .filter((line) => !/^I can\b/i.test(line))
    .filter((line) => !/^Let's\b/i.test(line))
    .filter((line) => !/^\[\/?tool\]/i.test(line))
    .filter((line) => !/^```(?:ts|tsx|js|jsx|json|sh|bash)?$/i.test(line))
    .filter((line) => !/^(import|export)\s+/i.test(line))
    .filter((line) => !/(数据缺失|未验证素材|验收标准|创意约束|not a verified finding|validation constraint)/i.test(line));
  if (lines.length === 0 && value.includes("<hall-structured>")) {
    return "";
  }
  return lines.join("\n").trim();
}

function stripCleanHallThreadContinuationLead(
  input: HallRuntimeDispatchInput,
  raw: string,
): string {
  if (!shouldApplyCleanHallThreadOpeningGuard(
    input,
    isFirstParticipantTurnInHallThread(input.taskCard, input.participant.agentId ?? input.participant.participantId),
  )) {
    return raw;
  }
  let cleaned = raw.trim();
  cleaned = cleaned
    .replace(/^(?:对|没错|是的|对的)[，,]\s*这样[^。！？.!?]{0,80}[。！？.!?]\s*/u, "")
    .replace(/^(?:对|没错|是的|对的)[，,\s]+/u, "")
    .replace(/^(?:那我(?:就|直接)?|我会再改一个细节|我会再补一个点|我会再|我再|再往前一点|再补一个点|继续往下压的话)[：:，,]\s*/u, "")
    .replace(/^(?:Exactly|Yeah|Yes|Also)[,:\s]+/i, "")
    .replace(/^(?:One more tweak|I'll refine one more detail|I will refine one more detail)[,:\s]+/i, "");
  return cleaned.trim() || raw;
}

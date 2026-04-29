import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { HallMessage, HallTaskCard } from "../types";
import { resolveHallTaskWorkspacePath } from "./hall-workspace";

// Per-task-card serialization: prevents interleaved blackboard writes when
// multiple agents finish concurrently. JSON store stays authoritative; this
// chain only protects the materialized .hall/ view.
const writeChains = new Map<string, Promise<void>>();

// In-process dedupe: avoid double-appending the same message to chat.jsonl when
// callers fire-and-forget twice (e.g. streamed + persisted both touching the
// same messageId). Bounded by HALL_BLACKBOARD_DEDUPE_CAP per task card.
const recentlyWritten = new Map<string, Set<string>>();
const HALL_BLACKBOARD_DEDUPE_CAP = 256;

const CHAT_JSONL = ".hall/chat.jsonl";
const CHAT_INDEX_MD = ".hall/chat-index.md";
const TASK_PLAN_MD = "task_plan.md";
const FINDINGS_MD = "findings.md";
const PROGRESS_MD = "progress.md";

const STUB_MARK = "<!-- hall-blackboard:stub -->";
const AGENT_BLOCK_OPEN_RE = /<!--\s*agent:\s*([^,]+?)\s*,\s*ts:\s*([^\s>]+)\s*-->/g;

export async function initializeHallBlackboard(taskCard: HallTaskCard): Promise<void> {
  await runSerial(taskCard.taskCardId, async () => {
    const root = resolveHallTaskWorkspacePath(taskCard.taskCardId);
    await mkdir(join(root, ".hall"), { recursive: true });
    await mkdir(join(root, ".hall", "locks"), { recursive: true });

    await ensureFile(join(root, CHAT_JSONL), "");
    await ensureFile(join(root, CHAT_INDEX_MD), renderInitialIndex(taskCard));
    await ensureFile(join(root, TASK_PLAN_MD), renderTaskPlanStub(taskCard));
    await ensureFile(join(root, FINDINGS_MD), renderFindingsStub(taskCard));
    await ensureFile(join(root, PROGRESS_MD), renderProgressStub(taskCard));
  });
}

export async function appendHallBlackboardMessage(taskCardId: string, message: HallMessage): Promise<void> {
  if (!taskCardId || !message?.messageId) return;
  const dedupe = ensureDedupeSet(taskCardId);
  if (dedupe.has(message.messageId)) return;
  dedupe.add(message.messageId);
  if (dedupe.size > HALL_BLACKBOARD_DEDUPE_CAP) {
    const first = dedupe.values().next().value;
    if (first) dedupe.delete(first);
  }

  await runSerial(taskCardId, async () => {
    try {
      const root = resolveHallTaskWorkspacePath(taskCardId);
      const jsonlPath = join(root, CHAT_JSONL);
      const sanitized = sanitizeMessageForBlackboard(message);
      await appendFile(jsonlPath, JSON.stringify(sanitized) + "\n", "utf8");
      await regenerateIndex(taskCardId, root);
    } catch {
      // Best-effort: blackboard is a materialized view; failure must not
      // surface to the dispatch path.
    }
  });
}

// Status messages encode tool calls as `[[tool:<name>|<summary>|~<base64-blob>]]`.
// The base64 blob is the full input/output payload (used by the UI for tool-pill
// detail view) and can run kilobytes per call, making chat.jsonl unreadable. The
// blackboard is for grep / agent reading, so we strip the blob and keep only
// the tool name + short summary. Everything else stays untouched.
//
// The summary is allowed to contain ANY character including newlines and `]`
// (e.g. code snippets like `list[str]`); we anchor instead on the literal `|~`
// separator and the base64 alphabet that follows.
const TOOL_MARKER_RE = /\[\[tool:([^|\]]+)\|([\s\S]*?)\|~[A-Za-z0-9+/=]*\]\]/g;

function sanitizeMessageForBlackboard(message: HallMessage): HallMessage {
  const original = message.content ?? "";
  if (!original.includes("[[tool:") || !original.includes("|~")) return message;
  const stripped = original.replace(TOOL_MARKER_RE, (_full, name, summary) => {
    const trimmedSummary = String(summary || "").trim();
    return trimmedSummary ? `[[tool:${name}|${trimmedSummary}]]` : `[[tool:${name}]]`;
  });
  return stripped === original ? message : { ...message, content: stripped };
}

export async function readHallProgressLatestEntry(taskCardId: string): Promise<string | undefined> {
  try {
    const root = resolveHallTaskWorkspacePath(taskCardId);
    const text = await readFile(join(root, PROGRESS_MD), "utf8");
    return extractLastAgentBlock(text);
  } catch {
    return undefined;
  }
}

export function renderHallBlackboardPromptGuidance(taskCardId: string, language: "zh" | "en"): string {
  const root = resolveHallTaskWorkspacePath(taskCardId);
  if (language === "zh") {
    return [
      "群聊共享黑板（在你的工作目录下，可直接用 bash 访问）：",
      `- ${join(root, CHAT_JSONL)} —— 全量消息（JSON Lines），每行一条 HallMessage。需要历史时用 \`jq\` / \`grep\`，不要假设你看到的 inline 上下文是完整的。`,
      `- ${join(root, CHAT_INDEX_MD)} —— 按 kind / 作者 / 时间分组的索引（grep 友好）。`,
      `- ${join(root, TASK_PLAN_MD)} / ${join(root, FINDINGS_MD)} / ${join(root, PROGRESS_MD)} —— 共享 markdown，所有 agent 可读写。`,
      "写入这三份共享 markdown 时，请用 `<!-- agent: <你的 id>, ts: <ISO 时间> -->` 和 `<!-- /agent -->` 把自己的内容包起来，**只追加，不覆盖**别人的块。完成阶段性产出后请在 progress.md 末尾追加一段，系统会把最末块同步到任务卡片摘要。",
    ].join("\n");
  }
  return [
    "Group-chat shared blackboard (under your working directory, accessible via bash):",
    `- ${join(root, CHAT_JSONL)} — full message log (JSON Lines, one HallMessage per line). For history, use \`jq\` or \`grep\` rather than assuming your inline context is complete.`,
    `- ${join(root, CHAT_INDEX_MD)} — grep-friendly index by kind / author / time.`,
    `- ${join(root, TASK_PLAN_MD)} / ${join(root, FINDINGS_MD)} / ${join(root, PROGRESS_MD)} — shared markdown, readable and writable by every agent.`,
    "When writing to those three shared markdown files, wrap your content in `<!-- agent: <your-id>, ts: <ISO-timestamp> -->` ... `<!-- /agent -->`. Append only — do not overwrite other agents' blocks. After delivering a milestone, append a block to progress.md; the system will mirror the last block back into the task card summary.",
  ].join("\n");
}

async function regenerateIndex(taskCardId: string, root: string): Promise<void> {
  const jsonlPath = join(root, CHAT_JSONL);
  let raw = "";
  try {
    raw = await readFile(jsonlPath, "utf8");
  } catch {
    return;
  }
  const messages: HallMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line) as HallMessage);
    } catch {
      // skip malformed line
    }
  }

  const byKind = new Map<string, number>();
  const byAuthor = new Map<string, { count: number; lastAt: string; label: string }>();
  for (const m of messages) {
    byKind.set(m.kind, (byKind.get(m.kind) ?? 0) + 1);
    const slot = byAuthor.get(m.authorParticipantId) ?? { count: 0, lastAt: m.createdAt, label: m.authorLabel };
    slot.count += 1;
    slot.label = m.authorLabel || slot.label;
    if (m.createdAt > slot.lastAt) slot.lastAt = m.createdAt;
    byAuthor.set(m.authorParticipantId, slot);
  }

  const tail = messages.slice(-50);
  const lines: string[] = [];
  lines.push(`# Chat index for ${taskCardId}`);
  lines.push("");
  lines.push(`Generated at ${new Date().toISOString()}. Source of truth: ${CHAT_JSONL}.`);
  lines.push("");
  lines.push("## By kind");
  if (byKind.size === 0) {
    lines.push("- (none yet)");
  } else {
    for (const [kind, count] of [...byKind.entries()].sort()) {
      lines.push(`- ${kind}: ${count}`);
    }
  }
  lines.push("");
  lines.push("## By author");
  if (byAuthor.size === 0) {
    lines.push("- (none yet)");
  } else {
    const sorted = [...byAuthor.entries()].sort((a, b) => (a[1].lastAt < b[1].lastAt ? 1 : -1));
    for (const [participantId, slot] of sorted) {
      lines.push(`- ${slot.label} (${participantId}) — ${slot.count} messages, last at ${slot.lastAt}`);
    }
  }
  lines.push("");
  lines.push(`## Recent timeline (last ${tail.length})`);
  if (tail.length === 0) {
    lines.push("- (no messages yet)");
  } else {
    for (const m of tail) {
      const targets = m.targetParticipantIds.length > 0 ? ` → ${m.targetParticipantIds.join(", ")}` : "";
      const preview = (m.content || "").replace(/\s+/g, " ").slice(0, 160);
      lines.push(`- ${m.createdAt} [${m.kind}] ${m.authorLabel}${targets}: ${preview}`);
    }
  }
  lines.push("");

  await atomicWrite(join(root, CHAT_INDEX_MD), lines.join("\n"));
}

function renderInitialIndex(taskCard: HallTaskCard): string {
  return [
    `# Chat index for ${taskCard.taskCardId}`,
    "",
    `Generated at ${new Date().toISOString()}. Source of truth: ${CHAT_JSONL}.`,
    "",
    "## By kind",
    "- (none yet)",
    "",
    "## By author",
    "- (none yet)",
    "",
    "## Recent timeline",
    "- (no messages yet)",
    "",
    STUB_MARK,
    "",
  ].join("\n");
}

function renderTaskPlanStub(taskCard: HallTaskCard): string {
  const items = (taskCard.plannedExecutionItems ?? []).map((it, idx) => {
    const target = it.handoffToParticipantId ? ` → handoff to ${it.handoffToParticipantId}` : "";
    return `${idx + 1}. (${it.participantId}) ${it.task}${target}`;
  });
  return [
    "# Task plan",
    "",
    "> Shared task plan. Any agent may append a block; do not overwrite other agents' blocks.",
    "",
    "## Initial brief",
    `- Title: ${taskCard.title || "(untitled)"}`,
    `- Description: ${taskCard.description || "(none)"}`,
    taskCard.proposal ? `- Proposal: ${taskCard.proposal}` : "",
    taskCard.doneWhen ? `- Done when: ${taskCard.doneWhen}` : "",
    "",
    "## Planned execution (initial)",
    items.length > 0 ? items.join("\n") : "- (no execution items yet)",
    "",
    `<!-- agent: system, ts: ${new Date().toISOString()} -->`,
    "Initial stub generated from task card. Agents append below.",
    "<!-- /agent -->",
    "",
    STUB_MARK,
    "",
  ].filter((line) => line !== "").join("\n");
}

function renderFindingsStub(taskCard: HallTaskCard): string {
  return [
    "# Findings",
    "",
    "> Shared findings / investigation log. Each agent appends its own block wrapped in `<!-- agent: <id>, ts: <iso> -->` ... `<!-- /agent -->`.",
    "",
    `<!-- agent: system, ts: ${new Date().toISOString()} -->`,
    `(No findings yet for "${taskCard.title || taskCard.taskCardId}".)`,
    "<!-- /agent -->",
    "",
    STUB_MARK,
    "",
  ].join("\n");
}

function renderProgressStub(taskCard: HallTaskCard): string {
  return [
    "# Progress",
    "",
    "> Append-only progress log. The orchestrator mirrors the last block back into the task card's `latestSummary`.",
    "",
    `<!-- agent: system, ts: ${new Date().toISOString()} -->`,
    `Task created: ${taskCard.title || taskCard.taskCardId}`,
    "<!-- /agent -->",
    "",
    STUB_MARK,
    "",
  ].join("\n");
}

function extractLastAgentBlock(text: string): string | undefined {
  const matches: { author: string; ts: string; start: number }[] = [];
  AGENT_BLOCK_OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AGENT_BLOCK_OPEN_RE.exec(text)) !== null) {
    matches.push({ author: m[1], ts: m[2], start: m.index + m[0].length });
  }
  if (matches.length === 0) return undefined;
  const last = matches[matches.length - 1];
  const closeIdx = text.indexOf("<!-- /agent -->", last.start);
  const body = closeIdx === -1 ? text.slice(last.start) : text.slice(last.start, closeIdx);
  const trimmed = body.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function ensureFile(path: string, content: string): Promise<void> {
  try {
    await readFile(path, "utf8");
    return; // already exists; do not overwrite
  } catch {
    // fall through and create
  }
  await atomicWrite(path, content);
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

function runSerial(taskCardId: string, op: () => Promise<void>): Promise<void> {
  const prev = writeChains.get(taskCardId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(op);
  writeChains.set(
    taskCardId,
    next.finally(() => {
      if (writeChains.get(taskCardId) === next) writeChains.delete(taskCardId);
    }),
  );
  return next;
}

function ensureDedupeSet(taskCardId: string): Set<string> {
  const existing = recentlyWritten.get(taskCardId);
  if (existing) return existing;
  const fresh = new Set<string>();
  recentlyWritten.set(taskCardId, fresh);
  return fresh;
}

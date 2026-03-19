import type { AgentRunState, ReadModelSnapshot, SessionStatusSnapshot, SessionSummary, SubagentTreeStats } from "../types";
import type { SessionExecutionChainSummary } from "./session-conversations";

export interface SubagentNode {
  sessionKey: string;
  agentId?: string;
  label?: string;
  state: AgentRunState;
  model?: string;
  tokensIn: number;
  tokensOut: number;
  totalTokens: number;
  cost: number;
  lastActivity?: string;
  parentSessionKey?: string;
  children: SubagentNode[];
  depth: number;
  stage: SessionExecutionChainSummary["stage"];
}

export interface SubagentTreeSnapshot {
  roots: SubagentNode[];
  totalNodes: number;
  activeNodes: number;
  idleNodes: number;
  errorNodes: number;
  blockedNodes: number;
  totalCost: number;
  totalTokens: number;
  maxDepth: number;
  generatedAt: string;
}

interface SessionWithChain {
  session: SessionSummary;
  status?: SessionStatusSnapshot;
  executionChain?: SessionExecutionChainSummary;
}

export function buildSubagentTree(
  sessions: SessionWithChain[],
  snapshot: ReadModelSnapshot,
): SubagentTreeSnapshot {
  const statusByKey = new Map<string, SessionStatusSnapshot>();
  for (const s of snapshot.statuses) {
    statusByKey.set(s.sessionKey, s);
  }

  const childrenMap = new Map<string, SessionWithChain[]>();
  const allKeys = new Set<string>();
  const hasParent = new Set<string>();

  for (const item of sessions) {
    allKeys.add(item.session.sessionKey);
    const parentKey = item.executionChain?.parentSessionKey;
    if (parentKey && parentKey !== item.session.sessionKey) {
      hasParent.add(item.session.sessionKey);
      const list = childrenMap.get(parentKey) ?? [];
      list.push(item);
      childrenMap.set(parentKey, list);
    }
  }

  const sessionByKey = new Map<string, SessionWithChain>();
  for (const item of sessions) {
    sessionByKey.set(item.session.sessionKey, item);
  }

  function buildNode(item: SessionWithChain, depth: number): SubagentNode {
    const status = item.status ?? statusByKey.get(item.session.sessionKey);
    const children = (childrenMap.get(item.session.sessionKey) ?? []).map((child) =>
      buildNode(child, depth + 1),
    );

    return {
      sessionKey: item.session.sessionKey,
      agentId: item.session.agentId,
      label: item.session.label,
      state: item.session.state,
      model: status?.model,
      tokensIn: status?.tokensIn ?? 0,
      tokensOut: status?.tokensOut ?? 0,
      totalTokens: (status?.tokensIn ?? 0) + (status?.tokensOut ?? 0),
      cost: status?.cost ?? 0,
      lastActivity: item.session.lastMessageAt ?? status?.updatedAt,
      parentSessionKey: item.executionChain?.parentSessionKey,
      children,
      depth,
      stage: item.executionChain?.stage ?? "idle",
    };
  }

  const roots: SubagentNode[] = [];
  for (const item of sessions) {
    if (!hasParent.has(item.session.sessionKey)) {
      roots.push(buildNode(item, 0));
    }
  }

  roots.sort((a, b) => {
    const aTime = a.lastActivity ? Date.parse(a.lastActivity) : 0;
    const bTime = b.lastActivity ? Date.parse(b.lastActivity) : 0;
    return bTime - aTime;
  });

  const stats = collectStats(roots);

  return {
    roots,
    ...stats,
    generatedAt: new Date().toISOString(),
  };
}

function collectStats(nodes: SubagentNode[]): {
  totalNodes: number;
  activeNodes: number;
  idleNodes: number;
  errorNodes: number;
  blockedNodes: number;
  totalCost: number;
  totalTokens: number;
  maxDepth: number;
} {
  let totalNodes = 0;
  let activeNodes = 0;
  let idleNodes = 0;
  let errorNodes = 0;
  let blockedNodes = 0;
  let totalCost = 0;
  let totalTokens = 0;
  let maxDepth = 0;

  function walk(node: SubagentNode): void {
    totalNodes++;
    if (node.state === "running") activeNodes++;
    if (node.state === "idle") idleNodes++;
    if (node.state === "error") errorNodes++;
    if (node.state === "blocked" || node.state === "waiting_approval") blockedNodes++;
    totalCost += node.cost;
    totalTokens += node.totalTokens;
    if (node.depth > maxDepth) maxDepth = node.depth;
    for (const child of node.children) walk(child);
  }

  for (const root of nodes) walk(root);

  return { totalNodes, activeNodes, idleNodes, errorNodes, blockedNodes, totalCost, totalTokens, maxDepth };
}

export function flattenTree(roots: SubagentNode[]): SubagentNode[] {
  const result: SubagentNode[] = [];
  function walk(node: SubagentNode): void {
    result.push(node);
    for (const child of node.children) walk(child);
  }
  for (const root of roots) walk(root);
  return result;
}

/**
 * Lightweight subagent stats from session key patterns only (no history needed).
 * Uses `:run:` marker in session keys to infer parent-child relationships.
 */
export function inferSubagentStatsFromKeys(
  sessions: SessionSummary[],
  statuses: SessionStatusSnapshot[],
): SubagentTreeStats {
  const RUN_MARKER = ":run:";
  const statusByKey = new Map(statuses.map((s) => [s.sessionKey, s]));
  const childKeys = new Set<string>();
  let maxDepth = 0;

  for (const session of sessions) {
    let depth = 0;
    let key = session.sessionKey;
    while (key.includes(RUN_MARKER)) {
      depth++;
      const idx = key.indexOf(RUN_MARKER);
      key = key.slice(0, idx);
    }
    if (depth > 0) childKeys.add(session.sessionKey);
    if (depth > maxDepth) maxDepth = depth;
  }

  let activeNodes = 0;
  let idleNodes = 0;
  let errorNodes = 0;
  let blockedNodes = 0;
  let totalCost = 0;
  let totalTokens = 0;

  for (const session of sessions) {
    if (session.state === "running") activeNodes++;
    if (session.state === "idle") idleNodes++;
    if (session.state === "error") errorNodes++;
    if (session.state === "blocked" || session.state === "waiting_approval") blockedNodes++;
    const status = statusByKey.get(session.sessionKey);
    totalCost += status?.cost ?? 0;
    totalTokens += (status?.tokensIn ?? 0) + (status?.tokensOut ?? 0);
  }

  return {
    totalNodes: sessions.length,
    activeNodes,
    idleNodes,
    errorNodes,
    blockedNodes,
    totalCost,
    totalTokens,
    maxDepth,
  };
}

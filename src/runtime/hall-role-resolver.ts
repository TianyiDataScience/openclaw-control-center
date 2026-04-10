import type { AgentRosterEntry } from "./agent-roster";
import type { HallParticipant, HallSemanticRole } from "../types";

const ROLE_PATTERNS: Record<Exclude<HallSemanticRole, "generalist" | "observer">, RegExp[]> = {
  manager: [/manager/i, /\bpm\b/i, /lead/i, /chief/i, /owner/i, /orchestr/i, /coordin/i, /经理/, /管理/, /主管/, /协调/, /指挥/],
  planner: [/planner/i, /plan/i, /research/i, /architect/i, /product/i, /design/i, /bioinfo/i, /bioinformat/i, /scientist/i, /科学/, /研究/, /规划/, /策划/, /生信/, /生物信息/, /架构/],
  coder: [/coder/i, /code/i, /dev/i, /engineer/i, /implement/i, /build/i, /builder/i, /maker/i, /开发/, /工程/, /编码/, /编程/],
  reviewer: [/review/i, /qa/i, /audit/i, /critic/i, /test/i, /verify/i, /complian/i, /writing/i, /审核/, /审查/, /合规/, /写作/, /测试/, /质检/],
};

export function resolveHallParticipantsFromRoster(roster: AgentRosterEntry[]): HallParticipant[] {
  const ordered = [...roster]
    .map((entry) => ({
      agentId: entry.agentId.trim(),
      displayName: entry.displayName.trim() || entry.agentId.trim(),
    }))
    .filter((entry) => entry.agentId.length > 0)
    .sort((a, b) => a.agentId.localeCompare(b.agentId));

  if (ordered.length === 0) {
    return [
      toParticipant("main", "Main", "observer"),
      toParticipant("planner", "Planner", "planner"),
      toParticipant("coder", "Coder", "coder"),
      toParticipant("reviewer", "Reviewer", "reviewer"),
    ];
  }

  return ordered.map((entry) => {
    const role = resolveIndividualRole(entry);
    return toParticipant(entry.agentId, entry.displayName, role);
  });
}

export function pickPrimaryParticipantByRole(
  participants: HallParticipant[],
  role: Exclude<HallSemanticRole, "generalist" | "observer">,
): HallParticipant | undefined {
  const direct = participants.find((participant) => participant.active && participant.semanticRole === role);
  if (direct) return direct;
  if (role === "manager") {
    return participants.find((participant) => participant.active && participant.semanticRole === "observer")
      ?? participants.find((participant) => participant.active);
  }
  if (role === "planner") {
    return participants.find((participant) => participant.active && participant.semanticRole !== "manager" && participant.semanticRole !== "observer");
  }
  return participants.find((participant) => participant.active && participant.semanticRole === "generalist");
}

export function resolveSemanticRoleLabel(role: HallSemanticRole, language: "en" | "zh" = "en"): string {
  if (language === "zh") {
    if (role === "planner") return "执行者";
    if (role === "coder") return "执行者";
    if (role === "reviewer") return "执行者";
    if (role === "manager") return "智能体管理者";
    if (role === "observer") return "观察者与管理者";
    return "执行者";
  }
  if (role === "planner") return "Executor";
  if (role === "coder") return "Executor";
  if (role === "reviewer") return "Executor";
  if (role === "manager") return "Agent Manager";
  if (role === "observer") return "Observer & Manager";
  return "Executor";
}

function resolveIndividualRole(entry: { agentId: string; displayName: string }): HallSemanticRole {
  if (/\bmain\b/i.test(entry.agentId)) return "observer";
  const haystack = `${entry.agentId} ${entry.displayName}`;
  for (const role of ["manager", "planner", "reviewer", "coder"] as const) {
    if (ROLE_PATTERNS[role].some((pattern) => pattern.test(haystack))) {
      return role;
    }
  }
  return "generalist";
}

function matchesRole(
  entry: { agentId: string; displayName: string },
  patterns: RegExp[],
): boolean {
  const haystack = `${entry.agentId} ${entry.displayName}`;
  return patterns.some((pattern) => pattern.test(haystack));
}

function toParticipant(agentId: string, displayName: string, semanticRole: HallSemanticRole): HallParticipant {
  const aliases = [...new Set([displayName, agentId, displayName.replace(/\s+/g, ""), agentId.replace(/\s+/g, "")])]
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return {
    participantId: agentId,
    agentId,
    displayName,
    semanticRole,
    active: true,
    aliases,
  };
}

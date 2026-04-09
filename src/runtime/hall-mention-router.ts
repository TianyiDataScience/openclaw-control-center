import type { HallParticipant, MentionTarget } from "../types";

export interface HallMentionRoutingResult {
  broadcastAll: boolean;
  targets: MentionTarget[];
}

export function resolveHallMentionTargets(
  content: string,
  participants: HallParticipant[],
): HallMentionRoutingResult {
  const trimmed = content.trim();
  if (!trimmed) {
    return { broadcastAll: false, targets: [] };
  }

  const broadcastAll = /(^|[\s(])@all(?=$|[\s),.!?;:])/i.test(trimmed);
  const matched = new Map<string, MentionTarget>();

  for (const participant of participants) {
    for (const alias of participant.aliases) {
      if (!alias) continue;
      if (!containsExplicitMention(trimmed, alias)) continue;
      matched.set(participant.participantId, {
        raw: `@${alias}`,
        participantId: participant.participantId,
        displayName: participant.displayName,
        semanticRole: participant.semanticRole,
      });
      break;
    }
  }

  return {
    broadcastAll,
    targets: [...matched.values()],
  };
}

function containsExplicitMention(content: string, alias: string): boolean {
  const escaped = escapeRegex(alias);
  // Exact alias match: @alias followed by boundary
  const exactPattern = new RegExp(`(^|[\\s(])@${escaped}(?=$|[\\s),.!?;:])`, "i");
  if (exactPattern.test(content)) return true;
  // Prefix match: check if @<alias_prefix> appears in content
  // e.g. "@罗莎琳德 Rosalind" matches alias "罗莎琳德 Rosalind (生信工程)"
  // Try progressively shorter prefixes of the alias (longest first)
  const aliasLower = alias.toLowerCase();
  const words = alias.split(/\s+/);
  for (let len = words.length; len >= 1; len--) {
    const prefix = words.slice(0, len).join(" ");
    if (prefix.length < 2) continue;
    const prefixEscaped = escapeRegex(prefix);
    const prefixPattern = new RegExp(`(^|[\\s(])@${prefixEscaped}(?=$|[\\s),.!?;:\\n<])`, "i");
    if (prefixPattern.test(content)) return true;
  }
  return false;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

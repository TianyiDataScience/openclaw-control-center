import type { UiLanguage } from "../runtime/ui-preferences";
import type { AgentRunState } from "../types";

/**
 * Simple text picker for bilingual UI
 */
export function pickUiText(language: UiLanguage, en: string, zh: string): string {
  return language === "zh" ? zh : en;
}

/**
 * Simple delay utility
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalize whitespace in text
 */
export function normalizeInlineText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

/**
 * Safe text truncation with ellipsis
 */
export function safeTruncate(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input;
  if (maxLength <= 3) return input.slice(0, Math.max(0, maxLength));
  return `${input.slice(0, maxLength - 3)}...`;
}

/**
 * Escape HTML special characters
 */
export function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Humanize operator label - converts underscores/hyphens to spaces and capitalizes
 */
export function humanizeOperatorLabel(value: string): string {
  const normalized = value.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (!normalized) return "未知助手";
  return normalized.replace(/\b\w/g, (match) => match.toUpperCase());
}

/**
 * Format agent label for display
 */
export function formatExecutorAgentLabel(agentId: string, language: UiLanguage): string {
  const normalized = agentId.trim().toLowerCase();
  if (!normalized || normalized === "system") return pickUiText(language, "System service", "系统服务");
  if (normalized === "system-cron") return pickUiText(language, "Scheduler", "调度器");
  if (normalized === "task-heartbeat-worker") return pickUiText(language, "Heartbeat service", "任务心跳服务");
  return humanizeOperatorLabel(agentId);
}

/**
 * Get session state label
 */
export function sessionStateLabel(state: AgentRunState): string {
  const labels: Record<AgentRunState, { zh: string; en: string }> = {
    idle: { zh: "空闲", en: "Idle" },
    running: { zh: "运行中", en: "Running" },
    blocked: { zh: "已阻塞", en: "Blocked" },
    waiting_approval: { zh: "等待审批", en: "Waiting Approval" },
    error: { zh: "错误", en: "Error" },
  };
  return labels[state]?.en ?? state;
}

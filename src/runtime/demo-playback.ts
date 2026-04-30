import {
  DEMO_TASK_CARD_ID,
  DEMO_PROJECT_ID,
  DEMO_TASK_ID,
  DEMO_ROOM_ID,
  DEMO_TITLE,
  DEMO_PROMPT,
  DEMO_MESSAGES,
  type DemoMessage,
} from "./demo-conversation-data";

export const DEMO_TASK_CARD_ID_PREFIX = "demo:";
export const DEMO_CARD_ID = "demo:ai-ml-drug-target";

export function isDemoTaskCard(taskCardId: string): boolean {
  return taskCardId === DEMO_CARD_ID;
}

export function buildDemoTaskCard() {
  return {
    hallId: "main",
    taskCardId: DEMO_CARD_ID,
    projectId: DEMO_PROJECT_ID,
    taskId: "demo-ai-ml-drug-target",
    roomId: DEMO_CARD_ID,
    title: DEMO_TITLE,
    description: DEMO_PROMPT,
    stage: "discussion" as const,
    status: "todo" as const,
    createdByParticipantId: "operator",
    blockers: [] as string[],
    requiresInputFrom: [] as string[],
    mentionedParticipantIds: [] as string[],
    plannedExecutionOrder: [] as string[],
    plannedExecutionItems: [] as unknown[],
    sessionKeys: [] as string[],
    isDemo: true,
    createdAt: "2026-04-10T04:13:19.091Z",
    updatedAt: new Date().toISOString(),
  };
}

export function buildDemoTaskCardSummary() {
  return {
    taskCardId: DEMO_CARD_ID,
    headline: "Demo: AI/ML Drug Target Prediction",
  };
}

export function getDemoMessages(): DemoMessage[] {
  return DEMO_MESSAGES;
}

export function getDemoPrompt(): string {
  return DEMO_PROMPT;
}

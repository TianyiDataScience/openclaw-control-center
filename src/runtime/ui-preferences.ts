import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { READONLY_MODE } from "../config";
import type { TaskState } from "../types";

export const UI_PREFERENCES_PATH = join(process.cwd(), "runtime", "ui-preferences.json");

export type UiQuickFilter = "all" | "attention" | TaskState;
export type UiLanguage = "en" | "zh";
export const UI_QUICK_FILTERS: UiQuickFilter[] = [
  "all",
  "attention",
  "todo",
  "in_progress",
  "blocked",
  "done",
];

export interface UiPreferencesTaskFilters {
  status?: TaskState;
  owner?: string;
  project?: string;
}

export interface UiPreferences {
  language: UiLanguage;
  compactStatusStrip: boolean;
  quickFilter: UiQuickFilter;
  taskFilters: UiPreferencesTaskFilters;
  updatedAt: string;
}

export interface UiPreferencesLoadResult {
  path: string;
  preferences: UiPreferences;
  issues: string[];
}

export function defaultUiPreferences(now = new Date().toISOString()): UiPreferences {
  return {
    language: "zh",
    compactStatusStrip: true,
    quickFilter: "all",
    taskFilters: {},
    updatedAt: now,
  };
}

export async function loadUiPreferences(): Promise<UiPreferencesLoadResult> {
  let parsed: unknown;
  let issues: string[] = [];

  try {
    const raw = await readFile(UI_PREFERENCES_PATH, "utf8");
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const fallback = defaultUiPreferences();
    const reason = error instanceof Error ? error.message : "unable to read preference file";
    issues = [`preferences fallback applied: ${reason}`];
    if (!READONLY_MODE) {
      await writeUiPreferences(fallback);
    }
    return {
      path: UI_PREFERENCES_PATH,
      preferences: fallback,
      issues,
    };
  }

  const normalized = normalizeUiPreferences(parsed);
  if (!READONLY_MODE && normalized.issues.length > 0) {
    await writeUiPreferences(normalized.preferences);
  }

  return {
    path: UI_PREFERENCES_PATH,
    preferences: normalized.preferences,
    issues: normalized.issues,
  };
}

export async function saveUiPreferences(preferences: UiPreferences): Promise<UiPreferencesLoadResult> {
  const normalized = normalizeUiPreferences(preferences);
  const issues = [...normalized.issues];
  if (!READONLY_MODE) {
    await writeUiPreferences(normalized.preferences);
  } else {
    issues.push("preferences were not persisted because readonly mode is enabled");
  }
  return {
    path: UI_PREFERENCES_PATH,
    preferences: normalized.preferences,
    issues,
  };
}

export function isUiQuickFilter(input: string): input is UiQuickFilter {
  return UI_QUICK_FILTERS.includes(input as UiQuickFilter);
}

export function isUiLanguage(input: string): input is UiLanguage {
  return input === "en" || input === "zh";
}

function normalizeUiPreferences(input: unknown): { preferences: UiPreferences; issues: string[] } {
  const now = new Date().toISOString();
  const base = defaultUiPreferences(now);
  const issues: string[] = [];

  const obj = asObject(input);
  if (!obj) {
    issues.push("preferences must be a JSON object");
    return { preferences: base, issues };
  }

  let compactStatusStrip = base.compactStatusStrip;
  let language = base.language;

  if (typeof obj.language === "string") {
    const normalizedLanguage = obj.language.trim().toLowerCase();
    if (isUiLanguage(normalizedLanguage)) {
      language = normalizedLanguage;
    } else {
      issues.push("language must be one of: en, zh");
    }
  } else if (obj.language !== undefined) {
    issues.push("language must be a string");
  }

  if (obj.compactStatusStrip !== undefined) {
    if (typeof obj.compactStatusStrip === "boolean") {
      compactStatusStrip = obj.compactStatusStrip;
    } else {
      issues.push("compactStatusStrip must be a boolean");
    }
  }

  let quickFilter = base.quickFilter;
  if (typeof obj.quickFilter === "string") {
    const trimmed = obj.quickFilter.trim();
    if (isUiQuickFilter(trimmed)) {
      quickFilter = trimmed;
    } else {
      issues.push("quickFilter must be one of: all, attention, todo, in_progress, blocked, done");
    }
  } else if (obj.quickFilter !== undefined) {
    issues.push("quickFilter must be a string");
  }

  const taskFilters = normalizeTaskFilters(obj.taskFilters, issues);
  if (taskFilters.status === undefined && isTaskState(quickFilter)) {
    taskFilters.status = quickFilter;
  }

  let updatedAt = now;
  if (typeof obj.updatedAt === "string" && !Number.isNaN(Date.parse(obj.updatedAt))) {
    updatedAt = new Date(obj.updatedAt).toISOString();
  } else if (obj.updatedAt !== undefined) {
    issues.push("updatedAt must be an ISO-8601 timestamp");
  }

  return {
    preferences: {
      language,
      compactStatusStrip,
      quickFilter,
      taskFilters,
      updatedAt,
    },
    issues,
  };
}

function normalizeTaskFilters(
  input: unknown,
  issues: string[],
): UiPreferencesTaskFilters {
  const out: UiPreferencesTaskFilters = {};

  if (input === undefined) return out;
  const obj = asObject(input);
  if (!obj) {
    issues.push("taskFilters must be an object");
    return out;
  }

  if (typeof obj.status === "string") {
    const status = obj.status.trim();
    if (!status) {
      out.status = undefined;
    } else if (isTaskState(status)) {
      out.status = status;
    } else {
      issues.push("taskFilters.status must be one of: todo, in_progress, blocked, done");
    }
  } else if (obj.status !== undefined) {
    issues.push("taskFilters.status must be a string");
  }

  const owner = normalizeOptionalString(obj.owner, "taskFilters.owner", 80, issues);
  if (owner) out.owner = owner;

  const project = normalizeOptionalString(obj.project, "taskFilters.project", 120, issues);
  if (project) out.project = project;

  return out;
}

function normalizeOptionalString(
  input: unknown,
  label: string,
  maxLength: number,
  issues: string[],
): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "string") {
    issues.push(`${label} must be a string`);
    return undefined;
  }

  const trimmed = input.trim();
  if (!trimmed) return undefined;

  if (/[\u0000-\u001F\u007F]/.test(trimmed)) {
    issues.push(`${label} contains control characters`);
    return undefined;
  }

  if (trimmed.length > maxLength) {
    issues.push(`${label} must be <= ${maxLength} characters`);
    return undefined;
  }

  return trimmed;
}

function isTaskState(input: string): input is TaskState {
  return input === "todo" || input === "in_progress" || input === "blocked" || input === "done";
}

function asObject(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}

async function writeUiPreferences(preferences: UiPreferences): Promise<void> {
  await mkdir(join(process.cwd(), "runtime"), { recursive: true });
  await writeFile(UI_PREFERENCES_PATH, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
}

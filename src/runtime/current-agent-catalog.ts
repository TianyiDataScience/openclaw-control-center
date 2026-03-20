import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type CurrentAgentCatalogStatus = "connected" | "partial" | "not_connected";

export interface CurrentAgentCatalogEntry {
  agentId: string;
  displayName: string;
}

export interface CurrentAgentCatalog {
  status: CurrentAgentCatalogStatus;
  sourcePath: string;
  detail: string;
  entries: CurrentAgentCatalogEntry[];
}

export async function loadCurrentAgentCatalog(): Promise<CurrentAgentCatalog> {
  const sourcePath = resolveOpenClawConfigPath();

  try {
    const raw = JSON.parse(await readFile(sourcePath, "utf8")) as unknown;
    const root = asObject(raw) ?? {};
    const agents = asObject(root.agents) ?? {};
    const list = asArray(agents.list);
    const merged = new Map<string, CurrentAgentCatalogEntry>();

    for (const item of list) {
      const obj = asObject(item);
      if (!obj) continue;
      const agentId = asString(obj.id)?.trim() ?? asString(obj.name)?.trim();
      if (!agentId) continue;
      const key = normalizeKey(agentId);
      if (merged.has(key)) continue;
      merged.set(key, {
        agentId,
        displayName: asString(obj.name)?.trim() || agentId,
      });
    }

    const entries = [...merged.values()].sort((a, b) => a.agentId.localeCompare(b.agentId));
    if (entries.length === 0) {
      return {
        status: "partial",
        sourcePath,
        detail: "openclaw.json found but agents.list is empty.",
        entries: [],
      };
    }

    return {
      status: "connected",
      sourcePath,
      detail: `loaded ${entries.length} current agent(s) from openclaw.json.`,
      entries,
    };
  } catch (error) {
    if (isFsNotFound(error)) {
      return {
        status: "not_connected",
        sourcePath,
        detail: "openclaw.json not found.",
        entries: [],
      };
    }
    return {
      status: "partial",
      sourcePath,
      detail: "openclaw.json exists but could not be parsed.",
      entries: [],
    };
  }
}

export function resolveOpenClawHomePath(): string {
  return process.env.OPENCLAW_HOME?.trim() || join(homedir(), ".openclaw");
}

export function resolveOpenClawConfigPath(): string {
  const explicit = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) return explicit;
  return join(resolveOpenClawHomePath(), "openclaw.json");
}

export function resolveOpenClawWorkspaceRootPath(): string {
  const explicit = process.env.OPENCLAW_WORKSPACE_ROOT?.trim();
  if (explicit) return explicit;
  return join(resolveOpenClawHomePath(), "workspace");
}

export function buildOpenClawCliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_") || key === "INIT_CWD") {
      delete env[key];
    }
  }

  delete env.OPENCLAW_HOME;
  delete env.OPENCLAW_CONFIG_PATH;
  delete env.OPENCLAW_WORKSPACE_ROOT;
  return env;
}

function isFsNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string" &&
      (error as { code: string }).code === "ENOENT",
  );
}

function normalizeKey(input: string): string {
  return input.trim().toLowerCase();
}

function asObject(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}

function asArray(input: unknown): unknown[] {
  return Array.isArray(input) ? input : [];
}

function asString(input: unknown): string | undefined {
  return typeof input === "string" ? input : undefined;
}

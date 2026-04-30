import { mkdir, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

export const HALL_WORKSPACES_DIR = join(process.cwd(), "runtime", "hall-workspaces");

export interface WorkspaceFileEntry {
  relativePath: string;
  sizeBytes: number;
  modifiedAt: string;
  isDirectory: boolean;
}

export async function ensureHallTaskWorkspace(taskCardId: string): Promise<string> {
  const sanitized = sanitizeTaskCardId(taskCardId);
  if (!sanitized) throw new Error("Invalid taskCardId for workspace.");
  const dir = join(HALL_WORKSPACES_DIR, sanitized);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function listHallTaskWorkspaceFiles(taskCardId: string): Promise<WorkspaceFileEntry[]> {
  const sanitized = sanitizeTaskCardId(taskCardId);
  if (!sanitized) return [];
  const root = join(HALL_WORKSPACES_DIR, sanitized);
  try {
    return await walkDir(root, root);
  } catch {
    return [];
  }
}

export function resolveHallTaskWorkspacePath(taskCardId: string): string {
  const sanitized = sanitizeTaskCardId(taskCardId);
  if (!sanitized) throw new Error("Invalid taskCardId for workspace.");
  return join(HALL_WORKSPACES_DIR, sanitized);
}

async function walkDir(dir: string, root: string, maxDepth = 4): Promise<WorkspaceFileEntry[]> {
  if (maxDepth <= 0) return [];
  const entries: WorkspaceFileEntry[] = [];
  let items: string[];
  try {
    items = await readdir(dir);
  } catch {
    return [];
  }
  for (const name of items.slice(0, 200)) {
    if (name.startsWith(".")) continue;
    const fullPath = join(dir, name);
    try {
      const info = await stat(fullPath);
      const relativePath = relative(root, fullPath);
      if (info.isDirectory()) {
        entries.push({
          relativePath: relativePath + "/",
          sizeBytes: 0,
          modifiedAt: info.mtime.toISOString(),
          isDirectory: true,
        });
        const children = await walkDir(fullPath, root, maxDepth - 1);
        entries.push(...children);
      } else {
        entries.push({
          relativePath,
          sizeBytes: info.size,
          modifiedAt: info.mtime.toISOString(),
          isDirectory: false,
        });
      }
    } catch {
      continue;
    }
  }
  return entries;
}

function sanitizeTaskCardId(input: string): string | undefined {
  const trimmed = String(input || "").trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 180) return undefined;
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) return undefined;
  return trimmed;
}

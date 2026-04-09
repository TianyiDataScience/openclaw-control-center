import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { HallFileAttachment } from "../types";

export const HALL_FILES_DIR = join(process.cwd(), "runtime", "hall-files");
export const HALL_FILE_MAX_BYTES = 20 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/zip",
]);

const MIME_REGEX_PART = [...ALLOWED_MIME_TYPES].map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const DATA_URL_PATTERN = new RegExp(`^data:(${MIME_REGEX_PART});base64,([A-Za-z0-9+/=]+)$`);

export async function writeHallFileFromDataUrl(input: {
  dataUrl: string;
  fileNameHint?: string;
}): Promise<HallFileAttachment> {
  await mkdir(HALL_FILES_DIR, { recursive: true });
  const raw = String(input.dataUrl || "").trim();
  const match = DATA_URL_PATTERN.exec(raw);
  if (!match) {
    throw new Error("dataUrl must be a base64 data URL with an allowed MIME type.");
  }
  const mimeType = match[1];
  const base64 = match[2];
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length === 0) throw new Error("dataUrl is empty.");
  if (buffer.length > HALL_FILE_MAX_BYTES) throw new Error("File too large (max 20 MB).");
  const ext = mimeToExtension(mimeType);
  const hint = normalizeSafeFileName(input.fileNameHint || "");
  const hintedBase = hint ? basename(hint, extname(hint)) : "";
  const base = hintedBase && /^[a-zA-Z0-9._-]+$/.test(hintedBase) ? hintedBase.slice(0, 48) : "file";
  const fileId = randomUUID();
  const storedFileName = `${base}-${fileId}${ext}`;
  const filePath = join(HALL_FILES_DIR, storedFileName);
  await writeFile(filePath, buffer);
  return {
    fileId,
    originalName: hint || `${base}${ext}`,
    mimeType,
    sizeBytes: buffer.length,
    storedFileName,
  };
}

export async function writeHallFileFromBuffer(input: {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
}): Promise<HallFileAttachment> {
  await mkdir(HALL_FILES_DIR, { recursive: true });
  if (!ALLOWED_MIME_TYPES.has(input.mimeType)) {
    throw new Error(`MIME type not allowed: ${input.mimeType}`);
  }
  if (input.buffer.length === 0) throw new Error("File buffer is empty.");
  if (input.buffer.length > HALL_FILE_MAX_BYTES) throw new Error("File too large (max 20 MB).");
  const ext = mimeToExtension(input.mimeType);
  const hint = normalizeSafeFileName(input.originalName || "");
  const hintedBase = hint ? basename(hint, extname(hint)) : "";
  const base = hintedBase && /^[a-zA-Z0-9._-]+$/.test(hintedBase) ? hintedBase.slice(0, 48) : "file";
  const fileId = randomUUID();
  const storedFileName = `${base}-${fileId}${ext}`;
  const filePath = join(HALL_FILES_DIR, storedFileName);
  await writeFile(filePath, input.buffer);
  return {
    fileId,
    originalName: hint || `${base}${ext}`,
    mimeType: input.mimeType,
    sizeBytes: input.buffer.length,
    storedFileName,
  };
}

export async function serveHallFile(
  res: ServerResponse,
  rawFileName: string,
  headOnly = false,
): Promise<void> {
  const fileName = normalizeSafeFileName(rawFileName);
  if (!fileName) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "File not found." }));
    return;
  }
  const filePath = join(HALL_FILES_DIR, fileName);
  try {
    const buffer = await readFile(filePath);
    const contentType = hallFileContentType(fileName);
    const isImage = contentType.startsWith("image/");
    res.writeHead(200, {
      "content-type": contentType,
      "content-disposition": isImage ? "inline" : `attachment; filename="${encodeURIComponent(fileName)}"`,
      "cache-control": "private, max-age=3600",
    });
    res.end(headOnly ? undefined : buffer);
  } catch {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "File not found." }));
  }
}

export function hallFileContentType(fileName: string): string {
  const ext = extname(fileName).toLowerCase();
  switch (ext) {
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    case ".pdf": return "application/pdf";
    case ".txt": return "text/plain";
    case ".md": return "text/markdown";
    case ".json": return "application/json";
    case ".zip": return "application/zip";
    default: return "application/octet-stream";
  }
}

function mimeToExtension(mime: string): string {
  switch (mime) {
    case "image/png": return ".png";
    case "image/jpeg": return ".jpg";
    case "image/webp": return ".webp";
    case "image/gif": return ".gif";
    case "application/pdf": return ".pdf";
    case "text/plain": return ".txt";
    case "text/markdown": return ".md";
    case "application/json": return ".json";
    case "application/zip": return ".zip";
    default: return ".bin";
  }
}

/**
 * Copy uploaded files into the task workspace so agents can access them
 * via the filesystem. Returns the absolute paths of the copied files.
 */
export async function copyHallFilesToWorkspace(
  files: HallFileAttachment[],
  workspaceDir: string,
): Promise<Map<string, string>> {
  const uploadsDir = join(workspaceDir, "uploads");
  await mkdir(uploadsDir, { recursive: true });
  const pathMap = new Map<string, string>();
  for (const file of files) {
    const src = join(HALL_FILES_DIR, file.storedFileName);
    const dest = join(uploadsDir, file.originalName);
    try {
      await copyFile(src, dest);
      pathMap.set(file.fileId, dest);
    } catch {
      // Source file may not exist — skip silently
    }
  }
  return pathMap;
}

function normalizeSafeFileName(input: string): string | undefined {
  const trimmed = String(input || "").trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 160) return undefined;
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) return undefined;
  return trimmed;
}

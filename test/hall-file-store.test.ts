import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  writeHallFileFromDataUrl,
  writeHallFileFromBuffer,
  hallFileContentType,
  HALL_FILES_DIR,
} from "../src/runtime/hall-file-store";

// Create a tiny 1x1 red PNG for testing
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`;

test("writeHallFileFromDataUrl: valid PNG data URL creates file and returns metadata", async () => {
  const result = await writeHallFileFromDataUrl({
    dataUrl: TINY_PNG_DATA_URL,
    fileNameHint: "test-image.png",
  });
  assert(result.fileId);
  assert(result.originalName === "test-image.png");
  assert(result.mimeType === "image/png");
  assert(result.sizeBytes > 0);
  assert(result.storedFileName.endsWith(".png"));
  assert(result.storedFileName.includes(result.fileId));

  // Verify file actually exists
  const filePath = join(HALL_FILES_DIR, result.storedFileName);
  const buffer = await readFile(filePath);
  assert(buffer.length === result.sizeBytes);
});

test("writeHallFileFromDataUrl: rejects invalid MIME type", async () => {
  await assert.rejects(
    writeHallFileFromDataUrl({
      dataUrl: "data:application/x-evil;base64,AAAA",
    }),
    /allowed MIME type/,
  );
});

test("writeHallFileFromDataUrl: rejects empty data URL", async () => {
  await assert.rejects(
    writeHallFileFromDataUrl({ dataUrl: "" }),
    /allowed MIME type/,
  );
});

test("writeHallFileFromDataUrl: rejects malformed data URL", async () => {
  await assert.rejects(
    writeHallFileFromDataUrl({ dataUrl: "not-a-data-url" }),
    /allowed MIME type/,
  );
});

test("writeHallFileFromDataUrl: filename hint is sanitized (no path traversal)", async () => {
  const result = await writeHallFileFromDataUrl({
    dataUrl: TINY_PNG_DATA_URL,
    fileNameHint: "../../../etc/passwd.png",
  });
  // Should fall back to default name since hint contains path components
  assert(!result.storedFileName.includes(".."));
  assert(!result.storedFileName.includes("/"));
  assert(result.storedFileName.endsWith(".png"));
});

test("writeHallFileFromBuffer: valid buffer creates file", async () => {
  const buffer = Buffer.from(TINY_PNG_BASE64, "base64");
  const result = await writeHallFileFromBuffer({
    buffer,
    originalName: "buffer-test.png",
    mimeType: "image/png",
  });
  assert(result.fileId);
  assert(result.originalName === "buffer-test.png");
  assert(result.mimeType === "image/png");
  assert(result.sizeBytes === buffer.length);
});

test("writeHallFileFromBuffer: rejects disallowed MIME type", async () => {
  await assert.rejects(
    writeHallFileFromBuffer({
      buffer: Buffer.from("test"),
      originalName: "evil.exe",
      mimeType: "application/x-executable",
    }),
    /MIME type not allowed/,
  );
});

test("writeHallFileFromBuffer: rejects empty buffer", async () => {
  await assert.rejects(
    writeHallFileFromBuffer({
      buffer: Buffer.alloc(0),
      originalName: "empty.txt",
      mimeType: "text/plain",
    }),
    /empty/,
  );
});

test("hallFileContentType: maps common extensions correctly", () => {
  assert(hallFileContentType("test.png") === "image/png");
  assert(hallFileContentType("test.jpg") === "image/jpeg");
  assert(hallFileContentType("test.jpeg") === "image/jpeg");
  assert(hallFileContentType("test.webp") === "image/webp");
  assert(hallFileContentType("test.gif") === "image/gif");
  assert(hallFileContentType("test.pdf") === "application/pdf");
  assert(hallFileContentType("test.txt") === "text/plain; charset=utf-8");
  assert(hallFileContentType("test.md") === "text/markdown; charset=utf-8");
  assert(hallFileContentType("test.json") === "application/json; charset=utf-8");
  assert(hallFileContentType("test.zip") === "application/zip");
  assert(hallFileContentType("test.unknown") === "application/octet-stream");
});

test("writeHallFileFromDataUrl: supports text/plain data URL", async () => {
  const textContent = Buffer.from("Hello world").toString("base64");
  const result = await writeHallFileFromDataUrl({
    dataUrl: `data:text/plain;base64,${textContent}`,
    fileNameHint: "hello.txt",
  });
  assert(result.mimeType === "text/plain");
  assert(result.storedFileName.endsWith(".txt"));
  const filePath = join(HALL_FILES_DIR, result.storedFileName);
  const content = await readFile(filePath, "utf8");
  assert(content === "Hello world");
});

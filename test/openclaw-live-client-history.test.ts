import assert from "node:assert/strict";
import { access, chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { OpenClawLiveClient } from "../src/clients/openclaw-live-client";

function attachSessionFile(client: OpenClawLiveClient, sessionKey: string, sessionFile: string): void {
  const internalClient = client as OpenClawLiveClient & {
    sessionCache: Map<string, { sessionFile?: string }>;
  };
  internalClient.sessionCache.set(sessionKey, { sessionFile });
}

function asInternalClient(client: OpenClawLiveClient): OpenClawLiveClient & {
  sessionHistoryCache: Map<string, { expiresAt: number; value: { rawText: string } }>;
  storeSessionHistory(cacheKey: string, value: { rawText: string }): { rawText: string };
} {
  return client as OpenClawLiveClient & {
    sessionHistoryCache: Map<string, { expiresAt: number; value: { rawText: string } }>;
    storeSessionHistory(cacheKey: string, value: { rawText: string }): { rawText: string };
  };
}

async function withFakeOpenClaw(
  tempDir: string,
  markerPath: string,
): Promise<() => Promise<void>> {
  const binDir = join(tempDir, "bin");
  await mkdir(binDir, { recursive: true });

  const previousPath = process.env.PATH ?? "";
  const executablePath = join(binDir, process.platform === "win32" ? "openclaw.cmd" : "openclaw");
  const escapedMarkerPath = process.platform === "win32"
    ? markerPath.replace(/"/g, "\"\"")
    : markerPath.replace(/'/g, "'\"'\"'");
  const script = process.platform === "win32"
    ? `@echo off\r\n>>"${escapedMarkerPath}" echo invoked\r\nexit /b 0\r\n`
    : `#!/bin/sh\nprintf 'invoked\\n' >> '${escapedMarkerPath}'\nexit 0\n`;

  await writeFile(executablePath, script, "utf8");
  if (process.platform !== "win32") {
    await chmod(executablePath, 0o755);
  }
  process.env.PATH = `${binDir}${delimiter}${previousPath}`;

  return async () => {
    process.env.PATH = previousPath;
  };
}

test("sessionsHistory reads recent history from large cached session files", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "openclaw-history-"));
  try {
    const sessionKey = "agent:main:cron:demo:run:child";
    const sessionFile = join(tempDir, "session.jsonl");
    const payload = "x".repeat(2048);
    const lines = Array.from({ length: 120 }, (_, index) =>
      JSON.stringify({ seq: index + 1, message: `entry-${index + 1}`, payload }),
    );
    await writeFile(sessionFile, `${lines.join("\n")}\n`, "utf8");

    const client = new OpenClawLiveClient();
    attachSessionFile(client, sessionKey, sessionFile);

    const response = await client.sessionsHistory({ sessionKey, limit: 3 });
    const history = Array.isArray(response.json?.history) ? response.json.history : [];

    assert.deepEqual(
      history.map((item) => (typeof item === "string" ? item : item.seq)),
      [118, 119, 120],
    );
    assert.match(response.rawText, /"seq":118/);
    assert.match(response.rawText, /"seq":120/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("sessionsHistory skips CLI fallback when a cached history file path is missing", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "openclaw-history-"));
  const markerPath = join(tempDir, "openclaw-invoked.log");
  const restorePath = await withFakeOpenClaw(tempDir, markerPath);
  try {
    const sessionKey = "agent:main:cron:missing:run";
    const sessionFile = join(tempDir, "missing-session.jsonl");
    const client = new OpenClawLiveClient();
    attachSessionFile(client, sessionKey, sessionFile);

    const response = await client.sessionsHistory({ sessionKey, limit: 6 });

    assert.deepEqual(response, { rawText: "" });
    await assert.rejects(access(markerPath));
  } finally {
    await restorePath();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("storeSessionHistory evicts expired cache entries when writing a new value", () => {
  const client = asInternalClient(new OpenClawLiveClient());
  client.sessionHistoryCache.set("expired-session:1", {
    expiresAt: Date.now() - 1_000,
    value: { rawText: "expired" },
  });
  client.sessionHistoryCache.set("fresh-session:1", {
    expiresAt: Date.now() + 10_000,
    value: { rawText: "fresh" },
  });

  client.storeSessionHistory("new-session:1", { rawText: "new" });

  assert.equal(client.sessionHistoryCache.has("expired-session:1"), false);
  assert.equal(client.sessionHistoryCache.get("fresh-session:1")?.value.rawText, "fresh");
  assert.equal(client.sessionHistoryCache.get("new-session:1")?.value.rawText, "new");
});

test("sessionsHistory keeps the last line when the history file has no trailing newline", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "openclaw-history-"));
  try {
    const sessionKey = "agent:coq:main";
    const sessionFile = join(tempDir, "session.jsonl");
    const lines = [
      JSON.stringify({ seq: 1, message: "first" }),
      JSON.stringify({ seq: 2, message: "second" }),
      JSON.stringify({ seq: 3, message: "third" }),
    ];
    await writeFile(sessionFile, lines.join("\n"), "utf8");

    const client = new OpenClawLiveClient();
    attachSessionFile(client, sessionKey, sessionFile);

    const response = await client.sessionsHistory({ sessionKey, limit: 2 });
    const history = Array.isArray(response.json?.history) ? response.json.history : [];

    assert.deepEqual(
      history.map((item) => (typeof item === "string" ? item : item.seq)),
      [2, 3],
    );
    assert.equal(response.rawText.trim().split("\n").length, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  recoverOpenClawCommandJson,
  summarizeOpenClawConnection,
  summarizeOpenClawMemory,
  summarizeOpenClawSecurity,
  summarizeOpenClawUpdate,
} from "../src/runtime/openclaw-cli-insights";

test("summarizeOpenClawConnection reports gateway, config, runtime, and blocked states", () => {
  const summary = summarizeOpenClawConnection(
    {
      sessions: { count: 12 },
      agents: { agents: [{ agentId: "main", sessionsCount: 12 }, { agentId: "coq", sessionsCount: 0 }] },
    },
    {
      service: { runtime: { status: "running" } },
      rpc: { ok: true },
      gateway: { probeUrl: "ws://127.0.0.1:18789" },
      config: {
        cli: { exists: true, valid: true, controlUi: { allowedOrigins: ["https://example.com"] } },
        daemon: { exists: true, valid: true },
      },
    },
  );

  assert.equal(summary.status, "ok");
  assert.equal(summary.items[0]?.key, "gateway");
  assert.equal(summary.items[0]?.status, "ok");
  assert.equal(summary.items[1]?.key, "config");
  assert.equal(summary.items[1]?.value, "Ready");
  assert.equal(summary.items[2]?.key, "runtime");
  assert.equal(summary.items[2]?.value, "12");
});

test("summarizeOpenClawUpdate distinguishes current and latest versions", () => {
  const summary = summarizeOpenClawUpdate(
    { runtimeVersion: "2026.3.11" },
    {
      update: { installKind: "package", packageManager: "pnpm", registry: { latestVersion: "2026.3.12" } },
      channel: { label: "stable (default)" },
      availability: { available: true, latestVersion: "2026.3.12" },
    },
  );

  assert.equal(summary.status, "info");
  assert.equal(summary.currentVersion, "2026.3.11");
  assert.equal(summary.latestVersion, "2026.3.12");
  assert.equal(summary.updateAvailable, true);
  assert.equal(summary.channelLabel, "stable (default)");
});

test("summarizeOpenClawConnection and update keep loading semantics when status payload is missing", () => {
  const connection = summarizeOpenClawConnection(
    {},
    {
      service: { runtime: { status: "running" } },
      rpc: { ok: true },
      gateway: { probeUrl: "ws://127.0.0.1:18789" },
      config: {
        cli: { exists: true, valid: true, controlUi: { allowedOrigins: ["https://example.com"] } },
        daemon: { exists: true, valid: true },
      },
    },
  );
  const update = summarizeOpenClawUpdate(
    {},
    {
      availability: { available: true, latestVersion: "2026.3.12" },
      channel: { label: "stable (default)" },
    },
  );

  assert.equal(connection.items[2]?.status, "info");
  assert.equal(connection.items[2]?.value, "loading");
  assert.equal(connection.items[2]?.detail, "Runtime status is still loading");
  assert.equal(update.status, "info");
  assert.equal(update.currentVersion, undefined);
  assert.equal(update.latestVersion, "2026.3.12");
});

test("summarizeOpenClawSecurity keeps counts and remediation", () => {
  const summary = summarizeOpenClawSecurity({
    summary: { critical: 1, warn: 2, info: 1 },
    findings: [
      {
        checkId: "gateway.trusted_proxies_missing",
        severity: "warn",
        title: "Reverse proxy headers are not trusted",
        detail: "gateway.trustedProxies is empty",
        remediation: "Set trusted proxies",
      },
    ],
  });

  assert.equal(summary.status, "blocked");
  assert.equal(summary.counts.critical, 1);
  assert.equal(summary.counts.warn, 2);
  assert.equal(summary.findings[0]?.remediation, "Set trusted proxies");
});

test("summarizeOpenClawMemory classifies searchable, warning, and blocked agents", () => {
  const summary = summarizeOpenClawMemory([
    {
      agentId: "main",
      status: {
        files: 12,
        chunks: 12,
        dirty: false,
        vector: { available: true },
        custom: { qmd: { lastUpdateAt: "2026-03-12T10:00:00.000Z" } },
      },
      scan: { issues: [] },
    },
    {
      agentId: "coq",
      status: {
        files: 4,
        chunks: 4,
        dirty: true,
        vector: { available: true },
      },
      scan: { issues: [] },
    },
    {
      agentId: "otter",
      status: {
        files: 0,
        chunks: 0,
        dirty: false,
        vector: { available: false },
      },
      scan: { issues: [{ code: "missing" }] },
    },
  ]);

  assert.equal(summary.status, "blocked");
  assert.equal(summary.okCount, 1);
  assert.equal(summary.warnCount, 1);
  assert.equal(summary.blockedCount, 1);
  assert.equal(summary.agents[0]?.agentId, "otter");
  assert.equal(summary.agents[2]?.agentId, "main");
});

test("recoverOpenClawCommandJson keeps valid stdout JSON from failed commands", () => {
  const recovered = recoverOpenClawCommandJson({
    code: 1,
    stdout: '{ "runtimeVersion": "2026.3.11" }',
  });

  assert.deepEqual(recovered, { runtimeVersion: "2026.3.11" });
  assert.equal(recoverOpenClawCommandJson({ code: 1, stdout: "not-json" }), undefined);
});

test("recoverOpenClawCommandJson extracts JSON after plugin log prelude", () => {
  const recovered = recoverOpenClawCommandJson({
    code: 1,
    stdout: `[plugins] [lcm] Plugin loaded (enabled=true)
[plugins] [lcm] Plugin loaded (enabled=true)
{ "rpc": { "ok": true }, "config": { "cli": { "exists": true, "valid": true } } }`,
  });

  assert.deepEqual(recovered, {
    rpc: { ok: true },
    config: { cli: { exists: true, valid: true } },
  });
});

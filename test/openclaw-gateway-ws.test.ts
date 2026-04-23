import assert from "node:assert/strict";
import { generateKeyPairSync, createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { OpenClawGatewayWsClient } from "../src/clients/openclaw-gateway-ws";

type Frame = Record<string, unknown>;

function createTestIdentityFile(): string {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const deviceId = createHash("sha256").update(spki.subarray(12)).digest("hex");
  const dir = mkdtempSync(join(tmpdir(), "openclaw-ws-identity-"));
  const path = join(dir, "device.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      deviceId,
      publicKeyPem,
      privateKeyPem,
      createdAtMs: Date.now(),
    }),
  );
  return path;
}

async function withMockGateway<T>(
  handler: (ctx: {
    url: string;
    identityPath: string;
    onRequest: (frame: Frame, client: WebSocket) => void;
  }) => Promise<T>,
): Promise<T> {
  const httpServer = createServer();
  httpServer.listen(0);
  await once(httpServer, "listening");
  const port = (httpServer.address() as AddressInfo).port;
  const wss = new WebSocketServer({ server: httpServer });
  let onRequest: ((frame: Frame, client: WebSocket) => void) | undefined;
  wss.on("connection", (ws) => {
    // Emit connect.challenge immediately, like the real gateway.
    ws.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: randomUUID() },
      }),
    );
    ws.on("message", (data) => {
      try {
        const frame = JSON.parse(data.toString("utf8")) as Frame;
        onRequest?.(frame, ws);
      } catch {
        /* ignore malformed */
      }
    });
  });
  const identityPath = createTestIdentityFile();
  try {
    return await handler({
      url: `ws://127.0.0.1:${port}`,
      identityPath,
      onRequest: (h, ws) => {
        onRequest = (frame, client) => h(frame, client);
      },
    });
  } finally {
    wss.close();
    httpServer.close();
  }
}

function respondOk(ws: WebSocket, id: string, payload: unknown): void {
  ws.send(JSON.stringify({ type: "res", id, ok: true, payload }));
}

function emitChatEvent(ws: WebSocket, payload: unknown): void {
  ws.send(JSON.stringify({ type: "event", event: "chat", payload }));
}

function helloOkPayload(): unknown {
  return {
    type: "hello-ok",
    protocol: 3,
    server: { version: "test", connId: "c1" },
    features: { methods: [], events: [] },
    snapshot: {},
    policy: { maxPayload: 1, maxBufferedBytes: 1, tickIntervalMs: 1000 },
  };
}

test("connect handshake sends protocol version + tool-events cap + device identity", async () => {
  await withMockGateway(async ({ url, identityPath, onRequest }) => {
    const captured: Frame[] = [];
    onRequest((frame, ws) => {
      captured.push(frame);
      const method = frame.method as string;
      const id = frame.id as string;
      if (method === "connect") {
        respondOk(ws, id, helloOkPayload());
      } else if (method === "sessions.reset") {
        respondOk(ws, id, { ok: true, key: "agent:X:hall:a" });
      }
    });

    const client = new OpenClawGatewayWsClient({ url, identityPath });
    await client.sessionsReset({ key: "agent:X:hall:a", reason: "new" });

    const connectFrame = captured.find((f) => f.method === "connect")!;
    assert.ok(connectFrame, "connect frame must be sent");
    const params = connectFrame.params as Record<string, unknown>;
    assert.equal(params.minProtocol, 3);
    assert.equal(params.maxProtocol, 3);
    const connectClient = params.client as Record<string, unknown>;
    assert.equal(connectClient.id, "gateway-client");
    assert.equal(connectClient.mode, "backend");
    assert.deepEqual(params.caps, ["tool-events"]);
    const device = params.device as Record<string, unknown>;
    assert.ok(device, "device block must be present when identity is available");
    assert.ok(typeof device.id === "string");
    assert.ok(typeof device.signature === "string");
    assert.ok(typeof device.nonce === "string");

    await client.close();
  });
});

test("agent request passes sessionKey through in params", async () => {
  await withMockGateway(async ({ url, identityPath, onRequest }) => {
    const captured: Frame[] = [];
    onRequest((frame, ws) => {
      captured.push(frame);
      const method = frame.method as string;
      const id = frame.id as string;
      if (method === "connect") {
        respondOk(ws, id, helloOkPayload());
      } else if (method === "agent") {
        respondOk(ws, id, { runId: "r1", status: "accepted" });
        setImmediate(() => {
          respondOk(ws, id, {
            runId: "r1",
            status: "ok",
            summary: "completed",
            result: {
              payloads: [{ text: "hello" }],
              meta: {
                agentMeta: { sessionId: "sid-1", model: "opus" },
                systemPromptReport: { sessionKey: "agent:X:hall:a" },
              },
            },
          });
        });
      }
    });

    const client = new OpenClawGatewayWsClient({ url, identityPath });
    const response = await client.agent({
      agentId: "X",
      sessionKey: "agent:X:hall:a",
      message: "hi",
    });

    const agentFrame = captured.find((f) => f.method === "agent")!;
    const params = agentFrame.params as Record<string, unknown>;
    assert.equal(params.sessionKey, "agent:X:hall:a", "sessionKey must pass through verbatim");
    assert.equal(params.agentId, "X");
    assert.equal(params.message, "hi");
    assert.ok(typeof params.idempotencyKey === "string", "idempotencyKey must be generated");

    assert.equal(response.ok, true);
    assert.equal(response.text, "hello");
    assert.equal(response.sessionId, "sid-1");
    assert.equal(response.sessionKey, "agent:X:hall:a");
    assert.equal(response.model, "opus");

    await client.close();
  });
});

test("streaming chat events deliver cumulative text as incremental deltas", async () => {
  await withMockGateway(async ({ url, identityPath, onRequest }) => {
    let runIdForAgent: string | undefined;
    onRequest((frame, ws) => {
      const method = frame.method as string;
      const id = frame.id as string;
      if (method === "connect") {
        respondOk(ws, id, helloOkPayload());
      } else if (method === "agent") {
        runIdForAgent = (frame.params as Record<string, unknown>).idempotencyKey as string;
        respondOk(ws, id, { runId: runIdForAgent, status: "accepted" });
        setTimeout(() => {
          emitChatEvent(ws, {
            runId: runIdForAgent,
            sessionKey: "agent:X:hall:a",
            seq: 1,
            state: "delta",
            message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
          });
          emitChatEvent(ws, {
            runId: runIdForAgent,
            sessionKey: "agent:X:hall:a",
            seq: 2,
            state: "delta",
            message: { role: "assistant", content: [{ type: "text", text: "Hello, world" }] },
          });
          emitChatEvent(ws, {
            runId: runIdForAgent,
            sessionKey: "agent:X:hall:a",
            seq: 3,
            state: "final",
            message: { role: "assistant", content: [{ type: "text", text: "Hello, world!" }] },
          });
          respondOk(ws, id, {
            runId: runIdForAgent,
            status: "ok",
            summary: "completed",
            result: { payloads: [{ text: "Hello, world!" }], meta: {} },
          });
        }, 10);
      }
    });

    const deltas: Array<{ delta: string; cumulative: string }> = [];
    const client = new OpenClawGatewayWsClient({ url, identityPath });
    const response = await client.agent(
      { agentId: "X", sessionKey: "agent:X:hall:a", message: "hi" },
      {
        onTextDelta: (delta, cumulative) => {
          deltas.push({ delta, cumulative });
        },
      },
    );

    assert.deepEqual(
      deltas.map((d) => d.delta),
      ["Hello", ", world", "!"],
      "deltas must reflect incremental growth of cumulative text",
    );
    assert.equal(deltas.at(-1)?.cumulative, "Hello, world!");
    assert.equal(response.text, "Hello, world!");

    await client.close();
  });
});

test("sessions.reset sends the correct frame and returns parsed response", async () => {
  await withMockGateway(async ({ url, identityPath, onRequest }) => {
    const captured: Frame[] = [];
    onRequest((frame, ws) => {
      captured.push(frame);
      const method = frame.method as string;
      const id = frame.id as string;
      if (method === "connect") {
        respondOk(ws, id, helloOkPayload());
      } else if (method === "sessions.reset") {
        respondOk(ws, id, { ok: true, key: (frame.params as Record<string, unknown>).key });
      }
    });

    const client = new OpenClawGatewayWsClient({ url, identityPath });
    const result = await client.sessionsReset({ key: "agent:X:hall:a", reason: "new" });

    const resetFrame = captured.find((f) => f.method === "sessions.reset")!;
    const params = resetFrame.params as Record<string, unknown>;
    assert.equal(params.key, "agent:X:hall:a");
    assert.equal(params.reason, "new");
    assert.equal(result.ok, true);
    assert.equal(result.key, "agent:X:hall:a");

    await client.close();
  });
});

test("pending request rejects when the server closes mid-flight", async () => {
  await withMockGateway(async ({ url, identityPath, onRequest }) => {
    onRequest((frame, ws) => {
      const method = frame.method as string;
      const id = frame.id as string;
      if (method === "connect") {
        respondOk(ws, id, helloOkPayload());
      } else if (method === "agent") {
        respondOk(ws, id, { runId: randomUUID(), status: "accepted" });
        setTimeout(() => ws.close(), 10);
      }
    });

    const client = new OpenClawGatewayWsClient({ url, identityPath });
    await assert.rejects(
      () => client.agent({ agentId: "X", sessionKey: "agent:X:hall:a", message: "hi" }),
      /closed|timed out/,
    );

    await client.close();
  });
});

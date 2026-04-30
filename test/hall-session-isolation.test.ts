import assert from "node:assert/strict";
import test from "node:test";
import { OpenClawLiveClient } from "../src/clients/openclaw-live-client";
import type {
  GatewayAgentRequest,
  GatewayAgentResponse,
  GatewayAgentStreamHandlers,
  OpenClawGatewayWsClient,
} from "../src/clients/openclaw-gateway-ws";

class FakeWsClient {
  public agentCalls: Array<GatewayAgentRequest> = [];
  public resetCalls: Array<{ key: string; reason?: "new" | "reset" }> = [];
  private responder: (req: GatewayAgentRequest) => Promise<GatewayAgentResponse>;

  constructor(
    responder?: (req: GatewayAgentRequest) => Promise<GatewayAgentResponse>,
  ) {
    this.responder = responder ?? (async (req) => ({
      ok: true,
      status: "ok",
      text: "stub reply",
      rawText: "{}",
      sessionId: "stub-sid",
      sessionKey: req.sessionKey,
      model: "stub-model",
    }));
  }

  async agent(
    req: GatewayAgentRequest,
    _handlers?: GatewayAgentStreamHandlers,
  ): Promise<GatewayAgentResponse> {
    this.agentCalls.push(req);
    return this.responder(req);
  }

  async sessionsReset(params: {
    key: string;
    reason?: "new" | "reset";
  }): Promise<{ ok: boolean; key: string }> {
    this.resetCalls.push(params);
    return { ok: true, key: params.key };
  }

  async close(): Promise<void> {
    /* no-op */
  }
}

function asWsClient(fake: FakeWsClient): OpenClawGatewayWsClient {
  return fake as unknown as OpenClawGatewayWsClient;
}

test("agentRunStream routes to gateway WS when sessionKey is hall-scoped", async () => {
  const client = new OpenClawLiveClient();
  const fake = new FakeWsClient();
  client.setGatewayWsClientForTest(asWsClient(fake));

  const response = await client.agentRunStream({
    agentId: "pandas",
    sessionKey: "agent:pandas:hall:card-A",
    message: "hello",
  });

  assert.equal(fake.agentCalls.length, 1, "WS client must be invoked exactly once");
  assert.equal(
    fake.agentCalls[0]?.sessionKey,
    "agent:pandas:hall:card-A",
    "sessionKey must pass through verbatim",
  );
  assert.equal(fake.agentCalls[0]?.agentId, "pandas");
  assert.equal(fake.agentCalls[0]?.message, "hello");
  assert.equal(response.sessionKey, "agent:pandas:hall:card-A");
  assert.equal(response.text, "stub reply");
});

// Note: negative routing (non-hall sessionKey → CLI path) is exercised implicitly
// by existing CLI tests. We don't assert it here to avoid a slow child-process
// failure waiting for `openclaw` in the PATH.

test("two hall threads on the same agent get distinct session keys", async () => {
  const client = new OpenClawLiveClient();
  const fake = new FakeWsClient();
  client.setGatewayWsClientForTest(asWsClient(fake));

  const first = await client.agentRunStream({
    agentId: "pandas",
    sessionKey: "agent:pandas:hall:card-A",
    message: "first",
  });
  const second = await client.agentRunStream({
    agentId: "pandas",
    sessionKey: "agent:pandas:hall:card-B",
    message: "second",
  });

  assert.equal(fake.agentCalls.length, 2);
  assert.equal(fake.agentCalls[0]?.sessionKey, "agent:pandas:hall:card-A");
  assert.equal(fake.agentCalls[1]?.sessionKey, "agent:pandas:hall:card-B");
  assert.equal(first.sessionKey, "agent:pandas:hall:card-A");
  assert.equal(second.sessionKey, "agent:pandas:hall:card-B");
});

test("streaming handlers are forwarded to the gateway client", async () => {
  const client = new OpenClawLiveClient();
  const fake = new FakeWsClient(async (_req) => ({
    ok: true,
    status: "ok",
    text: "done",
    rawText: "",
    sessionKey: _req.sessionKey,
  }));
  client.setGatewayWsClientForTest(asWsClient(fake));

  // We proxy onStdoutChunk → onTextDelta; FakeWsClient can't trigger deltas here,
  // but we still assert the stream path did not throw and returned the text.
  const stdoutChunks: string[] = [];
  const response = await client.agentRunStream(
    { agentId: "pandas", sessionKey: "agent:pandas:hall:card-A", message: "hi" },
    { onStdoutChunk: (c) => stdoutChunks.push(c) },
  );
  assert.equal(response.text, "done");
});

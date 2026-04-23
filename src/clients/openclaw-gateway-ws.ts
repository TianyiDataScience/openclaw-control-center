import crypto, { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { GATEWAY_TOKEN, GATEWAY_URL } from "../config";

const PROTOCOL_VERSION = 3;
// "gateway-client" + "backend" unlocks the `shouldSkipLocalBackendSelfPairing`
// bypass on the gateway (openclaw/.../handshake-auth-helpers.ts:196), which lets
// our device pair on first connect using shared-token auth without an explicit
// pairing prompt. Must also be a loopback (direct_local) connection with no
// browser Origin header — both true for us. Not "cli": that path requires an
// already-paired device. Not "openclaw-control-ui": that triggers browser-origin
// enforcement (message-handler.ts:449).
const CLIENT_ID = "gateway-client";
const CLIENT_MODE = "backend";
const CLIENT_ROLE = "operator";
const CLIENT_VERSION = "1.0.0";
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_CHALLENGE_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_AGENT_TIMEOUT_MS = 20 * 60 * 1_000;

// CLI_DEFAULT_OPERATOR_SCOPES from openclaw/src/gateway/method-scopes.ts (dot
// notation). These match what openclaw's own CLI requests and what the paired
// gateway-client device already has pre-approved in ~/.openclaw/devices/paired.json.
const CLI_OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
  "operator.talk.secrets",
];

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  expectFinal: boolean;
  timeout: NodeJS.Timeout | null;
  receivedAccepted: boolean;
};

type RunListener = {
  runId: string;
  onTextDelta?: (delta: string, cumulative: string) => void;
  onToolEvent?: (event: { toolName: string; toolStatus: string; detail?: string }) => void;
  lastCumulativeLen: number;
};

type DeviceIdentity = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
};

export interface GatewayAgentRequest {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  message: string;
  thinking?: string;
  timeoutSeconds?: number;
  deliver?: boolean;
}

export interface GatewayAgentStreamHandlers {
  onTextDelta?: (delta: string, cumulative: string) => void;
  onToolEvent?: (event: { toolName: string; toolStatus: string; detail?: string }) => void;
}

export interface GatewayAgentResponse {
  ok: boolean;
  status: string;
  text: string;
  rawText: string;
  sessionId?: string;
  sessionKey?: string;
  model?: string;
  provider?: string;
  runId?: string;
  summary?: string;
}

export class OpenClawGatewayWsClient {
  private readonly url: string;
  private readonly token?: string;
  private readonly identityPath?: string;
  private ws?: WebSocket;
  private connecting?: Promise<void>;
  private pending = new Map<string, Pending>();
  private runListeners = new Map<string, RunListener>();
  private instanceId = randomUUID();
  private closed = false;
  private pendingConnectChallenge?: {
    resolve: (nonce: string) => void;
    reject: (err: Error) => void;
    timeout: NodeJS.Timeout;
  };

  constructor(opts?: { url?: string; token?: string; identityPath?: string }) {
    this.url = opts?.url ?? GATEWAY_URL;
    this.token = opts?.token ?? GATEWAY_TOKEN ?? loadGatewayAuthTokenFromConfig() ?? undefined;
    this.identityPath = opts?.identityPath;
  }

  async agent(
    request: GatewayAgentRequest,
    handlers: GatewayAgentStreamHandlers = {},
  ): Promise<GatewayAgentResponse> {
    await this.ensureReady();
    const runId = randomUUID();
    const timeoutMs =
      request.timeoutSeconds && Number.isFinite(request.timeoutSeconds) && request.timeoutSeconds > 0
        ? Math.max(5_000, Math.trunc(request.timeoutSeconds * 1_000) + 30_000)
        : DEFAULT_AGENT_TIMEOUT_MS;

    const listener: RunListener = {
      runId,
      onTextDelta: handlers.onTextDelta,
      onToolEvent: handlers.onToolEvent,
      lastCumulativeLen: 0,
    };
    this.runListeners.set(runId, listener);

    try {
      const params: Record<string, unknown> = {
        message: request.message,
        idempotencyKey: runId,
      };
      if (request.agentId) params.agentId = request.agentId;
      if (request.sessionKey) params.sessionKey = request.sessionKey;
      if (request.sessionId) params.sessionId = request.sessionId;
      if (request.thinking) params.thinking = request.thinking;
      if (typeof request.deliver === "boolean") params.deliver = request.deliver;
      if (request.timeoutSeconds && Number.isFinite(request.timeoutSeconds) && request.timeoutSeconds > 0) {
        params.timeout = Math.trunc(request.timeoutSeconds);
      }

      const payload = await this.request("agent", params, { expectFinal: true, timeoutMs });
      const result = asObject((payload as Record<string, unknown>)?.result);
      const meta = asObject(result?.meta);
      const agentMeta = asObject(meta?.agentMeta);
      const systemPromptReport = asObject(meta?.systemPromptReport);
      const payloads = Array.isArray(result?.payloads) ? (result.payloads as unknown[]) : [];
      const text = payloads
        .map((item) => asString(asObject(item)?.text)?.trim())
        .filter((s): s is string => Boolean(s))
        .join("\n\n")
        .trim();
      const responseSessionKey =
        asString(systemPromptReport?.sessionKey) ?? request.sessionKey ?? undefined;
      return {
        ok: asString((payload as Record<string, unknown>)?.status) === "ok",
        status: asString((payload as Record<string, unknown>)?.status) ?? "ok",
        text,
        rawText: JSON.stringify(payload),
        sessionId: asString(agentMeta?.sessionId) ?? request.sessionId ?? undefined,
        sessionKey: responseSessionKey,
        model: asString(agentMeta?.model) ?? asString(systemPromptReport?.model),
        provider: asString(agentMeta?.provider) ?? asString(systemPromptReport?.provider),
        runId: asString((payload as Record<string, unknown>)?.runId) ?? runId,
        summary: asString((payload as Record<string, unknown>)?.summary),
      };
    } finally {
      this.runListeners.delete(runId);
    }
  }

  async sessionsReset(params: {
    key: string;
    reason?: "new" | "reset";
  }): Promise<{ ok: boolean; key: string }> {
    await this.ensureReady();
    const payload = await this.request(
      "sessions.reset",
      { key: params.key, ...(params.reason ? { reason: params.reason } : {}) },
      { expectFinal: false, timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS },
    );
    const obj = asObject(payload);
    return {
      ok: Boolean(obj?.ok),
      key: asString(obj?.key) ?? params.key,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    const ws = this.ws;
    this.ws = undefined;
    this.connecting = undefined;
    const error = new Error("gateway ws client closed");
    if (this.pendingConnectChallenge) {
      clearTimeout(this.pendingConnectChallenge.timeout);
      this.pendingConnectChallenge.reject(error);
      this.pendingConnectChallenge = undefined;
    }
    for (const [, pending] of this.pending) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.runListeners.clear();
    if (ws && ws.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
        ws.close();
      });
    }
  }

  private async ensureReady(): Promise<void> {
    if (this.closed) throw new Error("gateway ws client is closed");
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const ws = new WebSocket(this.url);
      const opened = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`gateway ws connect timeout ${this.url}`)),
          DEFAULT_CONNECT_TIMEOUT_MS,
        );
        ws.once("open", () => {
          clearTimeout(timer);
          resolve();
        });
        ws.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      // Prepare a nonce waiter BEFORE install the message listener so we
      // don't miss the connect.challenge event.
      const nonceWaiter = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("gateway connect challenge did not arrive in time")),
          DEFAULT_CHALLENGE_TIMEOUT_MS,
        );
        this.pendingConnectChallenge = { resolve, reject, timeout };
      });

      ws.on("message", (data) => {
        this.handleFrame(data);
      });
      ws.on("close", () => {
        this.handleClose();
      });
      ws.on("error", () => {
        /* close handler will reject pending */
      });
      this.ws = ws;

      await opened;

      const nonce = await nonceWaiter;

      const identity = this.loadIdentity();
      const connectParams: Record<string, unknown> = {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: CLIENT_ID,
          displayName: "openclaw-control-center",
          version: CLIENT_VERSION,
          platform: process.platform,
          mode: CLIENT_MODE,
          instanceId: this.instanceId,
        },
        caps: ["tool-events"],
        role: CLIENT_ROLE,
        scopes: CLI_OPERATOR_SCOPES,
      };
      if (identity) {
        const signedAtMs = Date.now();
        // Server's resolveSignatureToken (openclaw/.../handshake-auth-helpers.ts:218)
        // folds auth.token into the signed payload; we must mirror that here or
        // the signature won't verify.
        const signatureToken = this.token ?? null;
        const payload = buildDeviceAuthPayloadV3({
          deviceId: identity.deviceId,
          clientId: CLIENT_ID,
          clientMode: CLIENT_MODE,
          role: CLIENT_ROLE,
          scopes: CLI_OPERATOR_SCOPES,
          signedAtMs,
          token: signatureToken,
          nonce,
          platform: process.platform,
          deviceFamily: null,
        });
        const signature = signEd25519(identity.privateKeyPem, payload);
        connectParams.device = {
          id: identity.deviceId,
          publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
          signature,
          signedAt: signedAtMs,
          nonce,
        };
      }
      if (this.token) {
        connectParams.auth = { token: this.token };
      }
      await this.request("connect", connectParams, {
        expectFinal: false,
        timeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
      });
    })();

    try {
      await this.connecting;
    } catch (err) {
      // On failure, tear down the half-open socket so the next caller retries.
      const ws = this.ws;
      this.ws = undefined;
      if (ws) ws.close();
      throw err;
    } finally {
      this.connecting = undefined;
    }
  }

  private loadIdentity(): DeviceIdentity | undefined {
    const path = this.identityPath ?? join(homedir(), ".openclaw", "identity", "device.json");
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as Partial<DeviceIdentity> & { version?: number };
      if (
        parsed?.version === 1 &&
        typeof parsed.deviceId === "string" &&
        typeof parsed.publicKeyPem === "string" &&
        typeof parsed.privateKeyPem === "string"
      ) {
        return {
          deviceId: parsed.deviceId,
          publicKeyPem: parsed.publicKeyPem,
          privateKeyPem: parsed.privateKeyPem,
        };
      }
    } catch {
      /* identity file missing or malformed — fall back to token-only auth */
    }
    return undefined;
  }

  private request(
    method: string,
    params: unknown,
    opts: { expectFinal: boolean; timeoutMs: number },
  ): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("gateway ws is not open"));
    }
    return new Promise<unknown>((resolve, reject) => {
      const id = randomUUID();
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gateway request ${method} timed out after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        expectFinal: opts.expectFinal,
        timeout,
        receivedAccepted: false,
      });
      const frame = { type: "req", id, method, params };
      try {
        ws.send(JSON.stringify(frame));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private handleFrame(data: WebSocket.RawData): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
    } catch {
      return;
    }
    const type = asString(frame.type);
    if (type === "res") {
      this.handleResponse(frame);
    } else if (type === "event") {
      this.handleEvent(frame);
    }
  }

  private handleResponse(frame: Record<string, unknown>): void {
    const id = asString(frame.id);
    if (!id) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    if (frame.ok === false) {
      const error = asObject(frame.error);
      this.pending.delete(id);
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(
        new Error(asString(error?.message) ?? `gateway request ${id} failed`),
      );
      return;
    }
    if (pending.expectFinal && !pending.receivedAccepted) {
      // First res is "accepted" ack; wait for the terminal second res.
      pending.receivedAccepted = true;
      return;
    }
    this.pending.delete(id);
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.resolve(frame.payload);
  }

  private handleEvent(frame: Record<string, unknown>): void {
    const event = asString(frame.event);
    if (event === "connect.challenge") {
      const payload = asObject(frame.payload);
      const nonce = asString(payload?.nonce);
      if (this.pendingConnectChallenge) {
        clearTimeout(this.pendingConnectChallenge.timeout);
        if (nonce) {
          this.pendingConnectChallenge.resolve(nonce);
        } else {
          this.pendingConnectChallenge.reject(
            new Error("gateway connect.challenge missing nonce"),
          );
        }
        this.pendingConnectChallenge = undefined;
      }
      return;
    }
    if (event !== "chat") return;
    const payload = asObject(frame.payload);
    if (!payload) return;
    const runId = asString(payload.runId);
    if (!runId) return;
    const listener = this.runListeners.get(runId);
    if (!listener) return;
    const state = asString(payload.state);
    const message = asObject(payload.message);
    const contentArray = Array.isArray(message?.content) ? (message.content as unknown[]) : [];
    let textBlob = "";
    for (const block of contentArray) {
      const b = asObject(block);
      if (asString(b?.type) === "text") {
        const text = asString(b?.text);
        if (text) textBlob += text;
      }
    }
    if ((state === "delta" || state === "final") && textBlob) {
      if (textBlob.length > listener.lastCumulativeLen) {
        const delta = textBlob.slice(listener.lastCumulativeLen);
        listener.lastCumulativeLen = textBlob.length;
        try {
          listener.onTextDelta?.(delta, textBlob);
        } catch {
          /* handler errors must not kill the client */
        }
      }
    }
  }

  private handleClose(): void {
    this.ws = undefined;
    const err = new Error("gateway ws connection closed");
    if (this.pendingConnectChallenge) {
      clearTimeout(this.pendingConnectChallenge.timeout);
      this.pendingConnectChallenge.reject(err);
      this.pendingConnectChallenge = undefined;
    }
    for (const [, pending] of this.pending) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(err);
    }
    this.pending.clear();
    this.runListeners.clear();
  }
}

let sharedClient: OpenClawGatewayWsClient | undefined;

export function getSharedGatewayWsClient(): OpenClawGatewayWsClient {
  if (!sharedClient) {
    sharedClient = new OpenClawGatewayWsClient();
  }
  return sharedClient;
}

export async function resetSharedGatewayWsClientForTest(): Promise<void> {
  if (sharedClient) {
    await sharedClient.close().catch(() => undefined);
    sharedClient = undefined;
  }
}

// --- device-auth helpers (ported from openclaw/src/gateway/device-auth.ts + infra/device-identity.ts) ---

function buildDeviceAuthPayloadV3(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string | null;
  nonce: string;
  platform: string | null;
  deviceFamily: string | null;
}): string {
  const scopes = params.scopes.join(",");
  const token = params.token ?? "";
  const platform = normalizeMetadata(params.platform);
  const deviceFamily = normalizeMetadata(params.deviceFamily);
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce,
    platform,
    deviceFamily,
  ].join("|");
}

function normalizeMetadata(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function signEd25519(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return base64UrlEncode(sig);
}

function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return base64UrlEncode(spki.subarray(ED25519_SPKI_PREFIX.length));
  }
  return base64UrlEncode(spki);
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function loadGatewayAuthTokenFromConfig(): string | undefined {
  const configPath = join(homedir(), ".openclaw", "openclaw.json");
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const gateway = asObject(parsed.gateway);
    const auth = asObject(gateway?.auth);
    return asString(auth?.token);
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  return undefined;
}

/**
 * Gateway 认证客户端
 * 复用 Gateway 的 token 验证机制
 */

import WebSocket from "ws";

const GATEWAY_URL = process.env.GATEWAY_URL || "ws://127.0.0.1:18789";
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || process.env.LOCAL_API_TOKEN || "";

interface GatewayMessage {
  type: "req" | "res" | "event";
  id?: string;
  method?: string;
  params?: unknown;
  ok?: boolean;
  payload?: unknown;
  event?: string;
}

interface ConnectResult {
  connected: boolean;
  protocol?: number;
  error?: string;
}

let ws: WebSocket | null = null;
let requestId = 0;
let connectPromise: Promise<ConnectResult> | null = null;
let challengeNonce: string | null = null;
const pendingRequests = new Map<string, { resolve: Function; reject: Function }>();

/**
 * 连接到 Gateway WebSocket 并完成握手
 */
async function connect(): Promise<ConnectResult> {
  if (ws && ws.readyState === WebSocket.OPEN) {
    return { connected: true };
  }

  if (connectPromise) {
    return connectPromise;
  }

  connectPromise = new Promise((resolve, reject) => {
    ws = new WebSocket(GATEWAY_URL);

    ws.on("open", () => {
      console.log("[gateway-auth] WebSocket connected, waiting for challenge...");
    });

    ws.on("message", (data) => {
      try {
        const msg: GatewayMessage = JSON.parse(data.toString());
        handleMessage(msg, resolve);
      } catch (err) {
        console.error("[gateway-auth] parse error:", err);
      }
    });

    ws.on("error", (err) => {
      console.error("[gateway-auth] WebSocket error:", err.message);
      connectPromise = null;
      reject(err);
    });

    ws.on("close", () => {
      console.log("[gateway-auth] WebSocket closed");
      ws = null;
      connectPromise = null;
    });

    // 超时
    setTimeout(() => {
      if (connectPromise) {
        connectPromise = null;
        reject(new Error("Connection timeout"));
      }
    }, 15000);
  });

  return connectPromise;
}

/**
 * 处理 Gateway 消息
 */
function handleMessage(msg: GatewayMessage, resolveConnect: (result: ConnectResult) => void) {
  // 处理 challenge 事件
  if (msg.type === "event" && msg.event === "connect.challenge") {
    const payload = msg.payload as { nonce?: string; ts?: number };
    challengeNonce = payload?.nonce || null;
    console.log("[gateway-auth] received challenge, sending connect...");
    
    // 发送 connect 请求
    sendConnect();
    return;
  }

  // 处理响应
  if (msg.type === "res") {
    const pending = pendingRequests.get(msg.id || "");
    
    if (msg.method === "connect" || (pending && !pending)) {
      // connect 响应
      if (msg.ok) {
        console.log("[gateway-auth] connected to Gateway successfully");
        resolveConnect({ connected: true, protocol: (msg.payload as any)?.protocol });
      } else {
        console.error("[gateway-auth] connect failed:", msg.payload);
        resolveConnect({ connected: false, error: String(msg.payload) });
      }
      return;
    }

    if (pending) {
      pendingRequests.delete(msg.id || "");
      if (msg.ok) {
        pending.resolve(msg.payload);
      } else {
        pending.reject(new Error(String(msg.payload) || "Request failed"));
      }
    }
  }
}

/**
 * 发送 connect 请求
 */
function sendConnect() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  const id = `connect-${Date.now()}`;
  const message: GatewayMessage = {
    type: "req",
    id,
    method: "connect",
    params: {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "control-center",
        version: "0.1.0",
        platform: "server",
        mode: "operator",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      caps: [],
      commands: [],
      permissions: {},
      auth: { token: GATEWAY_TOKEN },
      locale: "en-US",
      userAgent: "openclaw-control-center/0.1.0",
    },
  };

  pendingRequests.set(id, {
    resolve: () => {},
    reject: () => {},
  });

  ws.send(JSON.stringify(message));
}

/**
 * 发送请求到 Gateway
 */
async function sendRequest(method: string, params: unknown = {}): Promise<unknown> {
  const connectResult = await connect();
  if (!connectResult.connected) {
    throw new Error("Not connected to Gateway");
  }

  return new Promise((resolve, reject) => {
    const id = `req-${++requestId}`;
    const message: GatewayMessage = {
      type: "req",
      id,
      method,
      params,
    };

    pendingRequests.set(id, { resolve, reject });
    ws!.send(JSON.stringify(message));

    // 超时处理
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error("Request timeout"));
      }
    }, 10000);
  });
}

/**
 * 验证 token
 * 使用 Gateway 的 session.list 或 status API 间接验证
 */
export async function verifyToken(token: string): Promise<{ valid: boolean }> {
  try {
    // 尝试使用 token 获取 sessions 列表来验证
    const result = await sendRequest("session.list", { auth: { token } });
    return { valid: true };
  } catch (err) {
    console.error("[gateway-auth] verify error:", err);
    return { valid: false };
  }
}

/**
 * 检查 Gateway 是否可用
 */
export async function checkGatewayHealth(): Promise<boolean> {
  try {
    const result = await connect();
    return result.connected;
  } catch {
    return false;
  }
}

/**
 * 关闭连接
 */
export function close(): void {
  if (ws) {
    ws.close();
    ws = null;
  }
}

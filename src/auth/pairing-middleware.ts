/**
 * 配对认证中间件
 * 用于保护 Control Center 的路由
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  validateAccessToken,
  createPairingRequest,
  completePairing,
  listPairedDevices,
  revokeDevice,
  getMainAccessToken,
  regenerateMainAccessToken,
} from "./pairing-store";

const PAIRING_PATH = "/api/pairing";
const PAIRING_COMPLETE_PATH = "/api/pairing/complete";
const DEVICES_PATH = "/api/devices";
const ACCESS_TOKEN_PATH = "/api/access-token";

export interface AuthResult {
  authenticated: boolean;
  deviceId?: string;
  deviceName?: string;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function extractToken(req: IncomingMessage): string | undefined {
  // 从 Header 获取
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  
  // 从 Cookie 获取
  const cookie = req.headers.cookie;
  if (cookie) {
    const match = cookie.match(/access_token=([^;]+)/);
    if (match) {
      return match[1];
    }
  }
  
  // 从 URL 参数获取
  const url = new URL(req.url || "/", "http://localhost");
  const tokenParam = url.searchParams.get("access_token");
  if (tokenParam) {
    return tokenParam;
  }
  
  return undefined;
}

/**
 * 处理配对相关 API
 */
export async function handlePairingRoutes(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;
  const method = req.method?.toUpperCase();
  
  // POST /api/pairing - 创建配对请求
  if (pathname === PAIRING_PATH && method === "POST") {
    const result = createPairingRequest();
    sendJson(res, 200, {
      code: result.code,
      expiresAt: result.expiresAt,
      message: "Enter this code on your Control Center to pair this device",
    });
    return true;
  }
  
  // POST /api/pairing/complete - 完成配对
  if (pathname === PAIRING_COMPLETE_PATH && method === "POST") {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const result = completePairing(
        data.code,
        data.deviceName || "Unknown Device",
        req.headers["user-agent"],
        req.socket.remoteAddress
      );
      
      if (result.success) {
        sendJson(res, 200, {
          success: true,
          accessToken: result.accessToken,
          message: "Device paired successfully",
        });
      } else {
        sendJson(res, 400, {
          success: false,
          error: result.error,
        });
      }
    } catch {
      sendJson(res, 400, { error: "Invalid request body" });
    }
    return true;
  }
  
  // GET /api/devices - 列出已配对设备
  if (pathname === DEVICES_PATH && method === "GET") {
    const token = extractToken(req);
    const validation = token ? validateAccessToken(token) : { valid: false };
    
    if (!validation.valid) {
      sendJson(res, 401, { error: "Unauthorized" });
      return true;
    }
    
    const devices = listPairedDevices();
    sendJson(res, 200, { devices });
    return true;
  }
  
  // DELETE /api/devices/:id - 撤销设备
  if (pathname.startsWith(DEVICES_PATH + "/") && method === "DELETE") {
    const token = extractToken(req);
    const validation = token ? validateAccessToken(token) : { valid: false };
    
    if (!validation.valid) {
      sendJson(res, 401, { error: "Unauthorized" });
      return true;
    }
    
    const deviceId = pathname.slice(DEVICES_PATH.length + 1);
    const success = revokeDevice(deviceId);
    sendJson(res, success ? 200 : 404, {
      success,
      message: success ? "Device revoked" : "Device not found",
    });
    return true;
  }
  
  // GET /api/access-token - 获取主 access token（需要已认证）
  if (pathname === ACCESS_TOKEN_PATH && method === "GET") {
    const token = extractToken(req);
    const validation = token ? validateAccessToken(token) : { valid: false };
    
    if (!validation.valid) {
      sendJson(res, 401, { error: "Unauthorized" });
      return true;
    }
    
    sendJson(res, 200, { accessToken: getMainAccessToken() });
    return true;
  }
  
  // POST /api/access-token/regenerate - 重新生成主 access token
  if (pathname === ACCESS_TOKEN_PATH + "/regenerate" && method === "POST") {
    const token = extractToken(req);
    const validation = token ? validateAccessToken(token) : { valid: false };
    
    if (!validation.valid) {
      sendJson(res, 401, { error: "Unauthorized" });
      return true;
    }
    
    const newToken = regenerateMainAccessToken();
    sendJson(res, 200, { accessToken: newToken });
    return true;
  }
  
  return false;
}

/**
 * 认证中间件
 * 检查请求是否已认证
 */
export function authenticateRequest(req: IncomingMessage): AuthResult {
  const token = extractToken(req);
  
  if (!token) {
    return { authenticated: false };
  }
  
  const validation = validateAccessToken(token);
  
  if (validation.valid) {
    return {
      authenticated: true,
      deviceId: validation.device?.id,
      deviceName: validation.device?.name,
    };
  }
  
  return { authenticated: false };
}

/**
 * 检查路径是否需要认证
 */
export function requiresAuth(pathname: string): boolean {
  // 公开路径
  const publicPaths = [
    "/api/pairing",
    "/api/pairing/complete",
    "/health",
    "/favicon.ico",
  ];
  
  // 静态资源
  if (pathname.startsWith("/static/") || pathname.startsWith("/assets/")) {
    return false;
  }
  
  // 配对页面
  if (pathname === "/pair" || pathname === "/login") {
    return false;
  }
  
  return !publicPaths.some(p => pathname === p || pathname.startsWith(p + "/"));
}

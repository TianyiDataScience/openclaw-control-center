/**
 * 配对认证集成补丁
 * 
 * 这个文件提供了将配对认证集成到 Control Center 服务器的函数
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  handlePairingRoutes,
  authenticateRequest,
  requiresAuth,
} from "./index";
import { renderPairingPage, renderLoginPage } from "./pairing-ui";

/**
 * 处理配对相关的 UI 路由
 */
export async function handleAuthUiRoutes(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;
  const method = req.method?.toUpperCase();
  
  // GET /pair - 配对页面
  if (pathname === "/pair" && method === "GET") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(renderPairingPage());
    return true;
  }
  
  // GET /login - 登录页面
  if (pathname === "/login" && method === "GET") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(renderLoginPage());
    return true;
  }
  
  return false;
}

/**
 * 认证检查中间件
 * 返回 true 表示请求已处理（未认证，已重定向到登录页）
 * 返回 false 表示请求应该继续处理
 */
export function checkAuthentication(
  req: IncomingMessage,
  res: ServerResponse
): boolean {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;
  
  // 检查是否需要认证
  if (!requiresAuth(pathname)) {
    return false; // 不需要认证，继续处理
  }
  
  // 检查认证状态
  const authResult = authenticateRequest(req);
  
  if (!authResult.authenticated) {
    // 未认证，重定向到登录页
    res.statusCode = 302;
    res.setHeader("Location", "/login");
    res.end();
    return true;
  }
  
  // 已认证，继续处理
  return false;
}

/**
 * 完整的认证中间件
 * 应该在服务器请求处理的最开始调用
 */
export async function authMiddleware(
  req: IncomingMessage,
  res: ServerResponse
): Promise<{ handled: boolean; authenticated: boolean }> {
  // 1. 处理配对 API 路由
  const pairingHandled = await handlePairingRoutes(req, res);
  if (pairingHandled) {
    return { handled: true, authenticated: false };
  }
  
  // 2. 处理认证 UI 路由
  const authUiHandled = await handleAuthUiRoutes(req, res);
  if (authUiHandled) {
    return { handled: true, authenticated: false };
  }
  
  // 3. 检查认证状态
  const authBlocked = checkAuthentication(req, res);
  if (authBlocked) {
    return { handled: true, authenticated: false };
  }
  
  // 4. 认证通过，继续处理
  return { handled: false, authenticated: true };
}

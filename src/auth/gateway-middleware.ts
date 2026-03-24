/**
 * Gateway 认证中间件
 * 复用 Gateway 的 token 验证机制
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyToken, checkGatewayHealth } from "./gateway-auth";

const LOGIN_PATH = "/login";
const PAIR_PATH = "/pair";

export interface AuthResult {
  authenticated: boolean;
  nodeId?: string;
  role?: string;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
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
 * 检查路径是否需要认证
 */
export function requiresAuth(pathname: string): boolean {
  // 公开路径
  const publicPaths = [
    "/login",
    "/pair",
    "/health",
    "/favicon.ico",
    "/api/health",
  ];

  // 静态资源
  if (pathname.startsWith("/static/") || pathname.startsWith("/assets/")) {
    return false;
  }

  return !publicPaths.some(p => pathname === p || pathname.startsWith(p + "/"));
}

/**
 * 认证中间件
 */
export async function authMiddleware(
  req: IncomingMessage,
  res: ServerResponse
): Promise<{ handled: boolean; authenticated: boolean }> {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;
  const method = req.method?.toUpperCase();

  // 健康检查
  if (pathname === "/api/health" || pathname === "/health") {
    const gatewayOk = await checkGatewayHealth();
    sendJson(res, 200, {
      ok: true,
      gateway: gatewayOk ? "connected" : "disconnected",
    });
    return { handled: true, authenticated: false };
  }

  // 登录页面
  if (pathname === LOGIN_PATH && method === "GET") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(renderLoginPage());
    return { handled: true, authenticated: false };
  }

  // 配对页面（使用 Gateway token）
  if (pathname === PAIR_PATH && method === "GET") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(renderPairPage());
    return { handled: true, authenticated: false };
  }

  // 检查是否需要认证
  if (!requiresAuth(pathname)) {
    return { handled: false, authenticated: false };
  }

  // 提取 token
  const token = extractToken(req);

  if (!token) {
    // 未提供 token，重定向到登录页
    res.statusCode = 302;
    res.setHeader("Location", LOGIN_PATH);
    res.end();
    return { handled: true, authenticated: false };
  }

  // 验证 token
  const result = await verifyToken(token);

  if (!result.valid) {
    // token 无效，重定向到登录页
    res.statusCode = 302;
    res.setHeader("Location", LOGIN_PATH);
    res.end();
    return { handled: true, authenticated: false };
  }

  // 认证通过
  return { handled: false, authenticated: true };
}

/**
 * 登录页面
 */
function renderLoginPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenClaw Control Center - Login</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
    }
    .container {
      background: rgba(255, 255, 255, 0.05);
      border-radius: 16px;
      padding: 40px;
      max-width: 420px;
      width: 90%;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    }
    .logo { text-align: center; margin-bottom: 30px; }
    .logo h1 { font-size: 24px; color: #ff6b35; }
    .logo p { color: #888; font-size: 14px; margin-top: 8px; }
    .form-group { margin-bottom: 20px; }
    label { display: block; margin-bottom: 8px; color: #ccc; font-size: 14px; }
    input {
      width: 100%;
      padding: 14px 16px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.05);
      color: #fff;
      font-size: 16px;
    }
    input:focus { outline: none; border-color: #ff6b35; }
    button {
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg, #ff6b35 0%, #f7931e 100%);
      border: none;
      border-radius: 8px;
      color: #fff;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { opacity: 0.9; }
    .error { color: #ff3b30; font-size: 14px; margin-top: 10px; display: none; }
    .info {
      background: rgba(255, 107, 53, 0.1);
      border: 1px solid rgba(255, 107, 53, 0.3);
      color: #ff6b35;
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      <h1>🦞 OpenClaw Control Center</h1>
      <p>使用 Gateway Token 登录</p>
    </div>
    
    <div class="info">
      使用你的 Gateway Token 登录。<br>
      Token 在 OpenClaw 配置的 <code>gateway.auth.token</code> 中。
    </div>
    
    <form id="loginForm">
      <div class="form-group">
        <label for="token">Gateway Token</label>
        <input type="password" id="token" placeholder="输入 Gateway Token" autocomplete="off">
      </div>
      <button type="submit">登录</button>
      <div class="error" id="error"></div>
    </form>
  </div>

  <script>
    const form = document.getElementById('loginForm');
    const errorDiv = document.getElementById('error');
    
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const token = document.getElementById('token').value.trim();
      
      if (!token) {
        errorDiv.textContent = '请输入 Gateway Token';
        errorDiv.style.display = 'block';
        return;
      }
      
      // 存储 token 到 cookie
      document.cookie = 'access_token=' + token + '; path=/; max-age=31536000';
      
      // 验证 token
      try {
        const response = await fetch('/health');
        if (response.ok) {
          window.location.href = '/?section=overview';
        } else {
          errorDiv.textContent = 'Token 无效';
          errorDiv.style.display = 'block';
          document.cookie = 'access_token=; path=/; max-age=0';
        }
      } catch (err) {
        errorDiv.textContent = '网络错误';
        errorDiv.style.display = 'block';
      }
    });
  </script>
</body>
</html>`;
}

/**
 * 配对页面（显示 Gateway Token）
 */
function renderPairPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenClaw Control Center - Pair</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
    }
    .container {
      background: rgba(255, 255, 255, 0.05);
      border-radius: 16px;
      padding: 40px;
      max-width: 420px;
      width: 90%;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    }
    .logo { text-align: center; margin-bottom: 30px; }
    .logo h1 { font-size: 24px; color: #ff6b35; }
    .logo p { color: #888; font-size: 14px; margin-top: 8px; }
    .info {
      background: rgba(52, 199, 89, 0.1);
      border: 1px solid rgba(52, 199, 89, 0.3);
      color: #34c759;
      padding: 16px;
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 14px;
      line-height: 1.6;
    }
    .token-display {
      background: rgba(255, 255, 255, 0.1);
      padding: 16px;
      border-radius: 8px;
      font-family: monospace;
      font-size: 18px;
      text-align: center;
      letter-spacing: 2px;
      margin: 20px 0;
    }
    button {
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg, #ff6b35 0%, #f7931e 100%);
      border: none;
      border-radius: 8px;
      color: #fff;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { opacity: 0.9; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      <h1>🦞 OpenClaw Control Center</h1>
      <p>使用 Gateway Token 访问</p>
    </div>
    
    <div class="info">
      Control Center 使用 Gateway Token 进行认证。<br><br>
      你可以在服务器上运行以下命令查看 Token：<br>
      <code>cat ~/.openclaw/openclaw.json | grep -A2 '"auth"'</code>
    </div>
    
    <div class="token-display">
      输入你的 Gateway Token
    </div>
    
    <button onclick="window.location.href='/login'">前往登录</button>
  </div>
</body>
</html>`;
}

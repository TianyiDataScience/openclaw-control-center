/**
 * 简化认证中间件
 * 直接使用 Gateway Token 作为访问密码
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LOGIN_PATH = "/login";

// 从 OpenClaw 配置读取 Gateway Token
function getGatewayToken(): string {
  try {
    const configPath = process.env.OPENCLAW_HOME 
      ? join(process.env.OPENCLAW_HOME, "openclaw.json")
      : join(homedir(), ".openclaw", "openclaw.json");
    
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      return config?.gateway?.auth?.token || "";
    }
  } catch (err) {
    console.error("[auth] failed to read gateway token:", err);
  }
  return process.env.GATEWAY_TOKEN || process.env.LOCAL_API_TOKEN || "";
}

const GATEWAY_TOKEN = getGatewayToken();

export interface AuthResult {
  authenticated: boolean;
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
  const publicPaths = ["/login", "/health", "/favicon.ico", "/api/health"];

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
    sendJson(res, 200, { ok: true, gateway: "configured" });
    return { handled: true, authenticated: false };
  }

  // 登录页面
  if (pathname === LOGIN_PATH && method === "GET") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(renderLoginPage());
    return { handled: true, authenticated: false };
  }

  // 登录 API
  if (pathname === "/api/login" && method === "POST") {
    return handleLogin(req, res);
  }

  // 检查是否需要认证
  if (!requiresAuth(pathname)) {
    return { handled: false, authenticated: false };
  }

  // 提取 token
  const token = extractToken(req);

  if (!token) {
    res.statusCode = 302;
    res.setHeader("Location", LOGIN_PATH);
    res.end();
    return { handled: true, authenticated: false };
  }

  // 验证 token（直接比较）
  if (token === GATEWAY_TOKEN) {
    return { handled: false, authenticated: true };
  }

  // token 无效
  res.statusCode = 302;
  res.setHeader("Location", LOGIN_PATH);
  res.end();
  return { handled: true, authenticated: false };
}

/**
 * 处理登录请求
 */
async function handleLogin(
  req: IncomingMessage,
  res: ServerResponse
): Promise<{ handled: boolean; authenticated: boolean }> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { token } = JSON.parse(body);
        
        if (token === GATEWAY_TOKEN) {
          sendJson(res, 200, { success: true, message: "Login successful" });
        } else {
          sendJson(res, 401, { success: false, error: "Invalid token" });
        }
      } catch {
        sendJson(res, 400, { success: false, error: "Invalid request" });
      }
      resolve({ handled: true, authenticated: false });
    });
  });
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
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    .error { color: #ff3b30; font-size: 14px; margin-top: 10px; display: none; }
    .info {
      background: rgba(255, 107, 53, 0.1);
      border: 1px solid rgba(255, 107, 53, 0.3);
      color: #ff6b35;
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 13px;
      line-height: 1.5;
    }
    .info code {
      background: rgba(0,0,0,0.3);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 12px;
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
      使用你的 <strong>Gateway Token</strong> 登录。<br><br>
      Token 在 OpenClaw 配置文件中：<br>
      <code>~/.openclaw/openclaw.json</code><br>
      <code>gateway.auth.token</code>
    </div>
    
    <form id="loginForm">
      <div class="form-group">
        <label for="token">Gateway Token</label>
        <input type="password" id="token" placeholder="输入 Gateway Token" autocomplete="off">
      </div>
      <button type="submit" id="submitBtn">登录</button>
      <div class="error" id="error"></div>
    </form>
  </div>

  <script>
    const form = document.getElementById('loginForm');
    const errorDiv = document.getElementById('error');
    const submitBtn = document.getElementById('submitBtn');
    
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const token = document.getElementById('token').value.trim();
      
      if (!token) {
        errorDiv.textContent = '请输入 Gateway Token';
        errorDiv.style.display = 'block';
        return;
      }
      
      submitBtn.disabled = true;
      submitBtn.textContent = '登录中...';
      errorDiv.style.display = 'none';
      
      try {
        const response = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
        
        const data = await response.json();
        
        if (data.success) {
          // 存储 token 到 cookie
          document.cookie = 'access_token=' + token + '; path=/; max-age=31536000';
          window.location.href = '/?section=overview';
        } else {
          errorDiv.textContent = data.error || 'Token 无效';
          errorDiv.style.display = 'block';
          submitBtn.disabled = false;
          submitBtn.textContent = '登录';
        }
      } catch (err) {
        errorDiv.textContent = '网络错误，请重试';
        errorDiv.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = '登录';
      }
    });
  </script>
</body>
</html>`;
}

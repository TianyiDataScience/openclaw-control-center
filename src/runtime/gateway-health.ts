import type { ToolClient } from "../clients/tool-client";

export interface GatewayHealthCheck {
  connected: boolean;
  url: string;
  lastCheckAt: string;
  latencyMs?: number;
  error?: string;
  retryCount: number;
}

let lastHealthCheck: GatewayHealthCheck | null = null;
let healthCheckInterval: NodeJS.Timeout | null = null;

export async function checkGatewayHealth(toolClient: ToolClient, gatewayUrl: string): Promise<GatewayHealthCheck> {
  const startTime = Date.now();
  
  try {
    // 尝试获取会话列表作为健康检查
    await toolClient.sessionsList();
    const latencyMs = Date.now() - startTime;
    
    const result: GatewayHealthCheck = {
      connected: true,
      url: gatewayUrl,
      lastCheckAt: new Date().toISOString(),
      latencyMs,
      retryCount: 0,
    };
    
    lastHealthCheck = result;
    return result;
  } catch (error) {
    const result: GatewayHealthCheck = {
      connected: false,
      url: gatewayUrl,
      lastCheckAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Unknown error",
      retryCount: (lastHealthCheck?.retryCount || 0) + 1,
    };
    
    lastHealthCheck = result;
    return result;
  }
}

export function getLastGatewayHealth(): GatewayHealthCheck | null {
  return lastHealthCheck;
}

export function startGatewayHealthMonitor(
  toolClient: ToolClient,
  gatewayUrl: string,
  intervalMs = 30000,
): void {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
  }
  
  // 立即执行一次
  void checkGatewayHealth(toolClient, gatewayUrl);
  
  // 定期检查
  healthCheckInterval = setInterval(() => {
    void checkGatewayHealth(toolClient, gatewayUrl);
  }, intervalMs);
}

export function stopGatewayHealthMonitor(): void {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
}

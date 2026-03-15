# Docker 部署指南

## VPS 部署步骤

### 1. 准备 VPS 环境

确保 VPS 上已安装：
- Docker (>= 20.10)
- Docker Compose (>= 2.0)
- OpenClaw Gateway 正在运行

### 2. 克隆项目到 VPS

```bash
cd /opt
git clone https://github.com/TianyiDataScience/openclaw-control-center.git
cd openclaw-control-center
git checkout foxai  # 使用包含系统监控的分支
```

### 3. 配置环境变量

创建 `.env` 文件：

```bash
cp .env.example .env
nano .env
```

**关键配置项：**

```env
# Gateway 连接（必须）
GATEWAY_URL=ws://localhost:18789

# OpenClaw 路径（如果不在默认位置）
OPENCLAW_HOME=/root/.openclaw
# CODEX_HOME=/root/.codex
# OPENCLAW_SUBSCRIPTION_SNAPSHOT_PATH=/path/to/subscription.json

# 安全设置
READONLY_MODE=true
LOCAL_TOKEN_AUTH_REQUIRED=true
LOCAL_API_TOKEN=your-secure-token-here

# UI 服务
UI_MODE=true
UI_PORT=4310

# 监控设置
MONITOR_CONTINUOUS=true
TASK_HEARTBEAT_ENABLED=true
```

### 4. 配置 Docker Compose

如果 OpenClaw Gateway 在同一台 VPS 上，使用 `network_mode: host`：

```yaml
# docker-compose.override.yml
version: '3.8'

services:
  control-center:
    network_mode: host
    environment:
      - GATEWAY_URL=ws://127.0.0.1:18789
    volumes:
      - /root/.openclaw:/root/.openclaw:ro
      - /root/.codex:/root/.codex:ro
      - ./runtime:/app/runtime:rw
```

### 5. 构建和启动

```bash
# 构建镜像
docker-compose build

# 启动服务
docker-compose up -d

# 查看日志
docker-compose logs -f control-center
```

### 6. 验证部署

```bash
# 检查容器状态
docker-compose ps

# 检查健康状态
curl http://localhost:4310/healthz

# 访问 UI
curl http://localhost:4310/?section=overview&lang=zh
```

### 7. 配置反向代理（可选）

如果需要通过域名访问，配置 Nginx：

```nginx
server {
    listen 80;
    server_name control.yourdomain.com;

    location / {
        proxy_pass http://localhost:4310;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

## 数据连接优化

### 必需连接（核心功能）
1. **OpenClaw Gateway** - 实时会话和任务数据
   - 检查：`curl ws://localhost:18789` 或 `netstat -an | grep 18789`
   - 修复：确保 OpenClaw Gateway 运行中

2. **openclaw.json** - Agent 配置和名单
   - 检查：`cat ~/.openclaw/openclaw.json`
   - 修复：设置正确的 `OPENCLAW_HOME`

### 可选连接（增强功能）
3. **Codex Telemetry** - 详细用量统计
   - 检查：`ls ~/.codex/telemetry`
   - 影响：缺失时用量页面会显示"数据源未连接"

4. **Subscription Snapshot** - 配额和订阅信息
   - 检查：`ls ~/.openclaw/subscription-snapshot.json`
   - 影响：缺失时订阅卡片显示"未连接"

5. **Model Context Catalog** - 上下文窗口百分比
   - 检查：`ls runtime/model-context-catalog.json`
   - 影响：缺失时无法显示上下文使用百分比

### 快速诊断命令

在 VPS 上运行：

```bash
# 检查 Gateway
netstat -an | grep 18789 || ss -an | grep 18789

# 检查 OpenClaw 配置
ls -la ~/.openclaw/openclaw.json

# 检查 Codex
ls -la ~/.codex/telemetry

# 检查容器日志
docker-compose logs control-center | grep -i "error\|warn\|connected"

# 进入容器检查
docker-compose exec control-center sh
ls -la /app/runtime
```

## 常见问题

### 问题 1：Gateway 连接失败
**症状：** 总览页面显示"0 活跃会话"，所有实时数据为空

**解决：**
```bash
# 检查 Gateway 是否运行
ps aux | grep gateway

# 检查网络连接
curl -v ws://localhost:18789

# 如果 Gateway 在容器外，使用 host 网络
# 在 docker-compose.override.yml 中添加：
network_mode: host
```

### 问题 2：OpenClaw 配置读取失败
**症状：** 员工页面为空，文档/记忆页面无 agent 标签

**解决：**
```bash
# 挂载 OpenClaw 目录到容器
# 在 docker-compose.override.yml 中添加：
volumes:
  - /root/.openclaw:/root/.openclaw:ro
  - OPENCLAW_HOME=/root/.openclaw
```

### 问题 3：用量数据全部显示"未连接"
**症状：** 用量页面所有卡片显示"数据源未连接"

**解决：**
```bash
# 1. 挂载 Codex 目录
volumes:
  - /root/.codex:/root/.codex:ro

# 2. 或者启用持续监控生成本地 digest
environment:
  - MONITOR_CONTINUOUS=true

# 3. 等待几分钟让 monitor 生成 runtime/digests/*.json
```

### 问题 4：CPU 使用率显示负数
**已修复** - 更新到最新代码即可

## 性能优化建议

### 1. 调整轮询间隔（降低 CPU/网络消耗）

```env
# 默认值（实时性高，消耗大）
POLLING_INTERVALS_MS=sessionsList=10000,sessionStatus=5000,cron=30000

# 优化值（平衡实时性和资源）
POLLING_INTERVALS_MS=sessionsList=30000,sessionStatus=15000,cron=60000

# 低资源模式（降低实时性，节省资源）
POLLING_INTERVALS_MS=sessionsList=60000,sessionStatus=30000,cron=120000
```

### 2. 限制容器资源

```yaml
# docker-compose.yml
deploy:
  resources:
    limits:
      memory: 512M  # 增加到 512M 如果数据量大
      cpus: '1.0'   # 增加到 1 核如果需要更快响应
```

### 3. 启用缓存优化

Control Center 已内置多级缓存：
- 会话列表缓存（10秒）
- 用量数据缓存（5分钟）
- 系统监控缓存（1小时）

无需额外配置。

## 监控增强

### 添加 Prometheus 指标（可选）

创建 `src/runtime/metrics-exporter.ts`：

```typescript
// 导出 Prometheus 格式的指标
export function exportMetrics(snapshot: ReadModelSnapshot): string {
  return `
# HELP openclaw_sessions_total Total number of sessions
# TYPE openclaw_sessions_total gauge
openclaw_sessions_total ${snapshot.sessions.length}

# HELP openclaw_sessions_running Running sessions
# TYPE openclaw_sessions_running gauge
openclaw_sessions_running ${snapshot.sessions.filter(s => s.state === 'running').length}
  `.trim();
}
```

### 添加告警 Webhook（可选）

在 `runtime/notification-policy.json` 中配置：

```json
{
  "webhooks": [
    {
      "url": "https://your-webhook-url.com/alerts",
      "events": ["session_stalled", "budget_exceeded", "approval_pending"]
    }
  ]
}
```

## 生产环境检查清单

- [ ] `.env` 已配置正确的 `GATEWAY_URL`
- [ ] `OPENCLAW_HOME` 路径正确且可读
- [ ] `LOCAL_API_TOKEN` 已设置强密码
- [ ] Docker 容器可以访问 Gateway（网络配置）
- [ ] 挂载了必要的 volume（runtime、.openclaw）
- [ ] 配置了反向代理和 HTTPS（如果公网访问）
- [ ] 设置了容器资源限制
- [ ] 配置了日志轮转
- [ ] 测试了 `/healthz` 端点返回正常

## 快速启动命令

```bash
# 在 VPS 上
cd /opt/openclaw-control-center

# 拉取最新代码
git pull origin foxai

# 重新构建
docker-compose build

# 重启服务
docker-compose down && docker-compose up -d

# 查看启动日志
docker-compose logs -f --tail=50 control-center

# 等待 30 秒后检查健康状态
sleep 30 && curl http://localhost:4310/healthz | jq .
```

## 故障排查

```bash
# 查看完整日志
docker-compose logs control-center

# 进入容器调试
docker-compose exec control-center sh

# 检查环境变量
docker-compose exec control-center env | grep -E "GATEWAY|OPENCLAW|CODEX"

# 手动测试 Gateway 连接
docker-compose exec control-center wget -O- http://localhost:18789 || echo "Gateway 不可达"

# 重启容器
docker-compose restart control-center
```

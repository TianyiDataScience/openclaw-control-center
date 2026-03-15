# VPS 快速部署指南

## 一键部署（推荐）

在你的 VPS 上执行：

```bash
# 1. 克隆项目
git clone https://github.com/TianyiDataScience/openclaw-control-center.git
cd openclaw-control-center
git checkout foxai

# 2. 创建配置文件
cp .env.example .env

# 3. 编辑配置（必须）
nano .env
# 修改 GATEWAY_URL 为你的实际地址
# 设置 LOCAL_API_TOKEN 为强密码

# 4. 运行部署脚本
./deploy-vps.sh
```

## 手动部署步骤

### 1. 配置 .env

```env
# Gateway 连接（必须修改）
GATEWAY_URL=ws://your-vps-ip:18789

# 如果 OpenClaw 不在默认位置
OPENCLAW_HOME=/root/.openclaw
# CODEX_HOME=/root/.codex

# 安全设置
READONLY_MODE=true
LOCAL_TOKEN_AUTH_REQUIRED=true
LOCAL_API_TOKEN=your-strong-password-here

# 启用持续监控
MONITOR_CONTINUOUS=true
UI_MODE=true
UI_PORT=4310
```

### 2. 启动服务

```bash
# 使用 VPS 优化配置
docker-compose -f docker-compose.yml -f docker-compose.vps.yml up -d

# 或使用默认配置
docker-compose up -d
```

### 3. 验证部署

```bash
# 等待 30 秒
sleep 30

# 检查容器状态
docker-compose ps

# 健康检查
curl http://localhost:4310/healthz | jq .

# 连接诊断
curl http://localhost:4310/api/diagnostics | jq .
```

## 数据连接检查清单

### 必需连接
- [ ] **OpenClaw Gateway** - 实时会话数据
  ```bash
  # 检查 Gateway 是否运行
  netstat -an | grep 18789
  # 或
  ss -tuln | grep 18789
  ```

- [ ] **openclaw.json** - Agent 配置
  ```bash
  # 检查配置文件
  cat ~/.openclaw/openclaw.json | jq '.agents | length'
  ```

### 可选连接（增强功能）
- [ ] **Codex Telemetry** - 详细用量
  ```bash
  ls -la ~/.codex/telemetry
  ```

- [ ] **Subscription Snapshot** - 配额信息
  ```bash
  ls -la ~/.openclaw/subscription-snapshot.json
  ```

- [ ] **Runtime Digests** - 历史趋势
  ```bash
  # 启用持续监控后自动生成
  ls -la runtime/digests/
  ```

## 常见问题修复

### 问题 1: Gateway 连接失败

**症状：** 总览页面显示 0 活跃会话

**检查：**
```bash
# 1. 确认 Gateway 运行中
ps aux | grep gateway

# 2. 确认端口监听
netstat -an | grep 18789

# 3. 测试连接
curl -v ws://localhost:18789
```

**修复：**
```bash
# 如果 Gateway 在容器外，使用 host 网络
# 在 docker-compose.vps.yml 中已配置 network_mode: host

# 重启容器
docker-compose restart control-center
```

### 问题 2: 数据全部显示"未连接"

**症状：** 用量、员工、任务页面都是空的

**检查：**
```bash
# 进入容器检查挂载
docker-compose exec control-center sh
ls -la /root/.openclaw
ls -la /app/runtime
```

**修复：**
```bash
# 确保 docker-compose.vps.yml 中正确挂载了目录
volumes:
  - /root/.openclaw:/root/.openclaw:ro
  - ./runtime:/app/runtime:rw

# 重新启动
docker-compose down
docker-compose -f docker-compose.yml -f docker-compose.vps.yml up -d
```

### 问题 3: CPU 使用率显示负数

**已修复** - 拉取最新代码即可

```bash
git pull origin foxai
docker-compose build
docker-compose restart control-center
```

### 问题 4: 内存不足

**症状：** 容器频繁重启，日志显示 OOM

**修复：**
```bash
# 增加内存限制
# 编辑 docker-compose.vps.yml
deploy:
  resources:
    limits:
      memory: 1G  # 从 512M 增加到 1G
```

### 问题 5: 监控数据更新慢

**修复：**
```bash
# 减少轮询间隔（增加资源消耗）
# 在 .env 中设置
POLLING_INTERVALS_MS=sessionsList=10000,sessionStatus=5000,cron=30000
```

## 监控和维护

### 查看日志
```bash
# 实时日志
docker-compose logs -f control-center

# 最近 100 行
docker-compose logs --tail=100 control-center

# 搜索错误
docker-compose logs control-center | grep -i error
```

### 性能监控
```bash
# 容器资源使用
docker stats control-center

# 磁盘使用
du -sh runtime/

# 清理旧日志
find runtime/digests -name "*.json" -mtime +30 -delete
```

### 备份和恢复
```bash
# 备份 runtime 数据
tar -czf runtime-backup-$(date +%Y%m%d).tar.gz runtime/

# 恢复
tar -xzf runtime-backup-20260315.tar.gz
```

## 优化建议

### 1. 低资源 VPS（1核2G）
```env
# .env 配置
MONITOR_CONTINUOUS=false  # 按需监控
POLLING_INTERVALS_MS=sessionsList=60000,sessionStatus=30000,cron=120000

# docker-compose.vps.yml
deploy:
  resources:
    limits:
      memory: 256M
      cpus: '0.5'
```

### 2. 标准 VPS（2核4G）
```env
# .env 配置
MONITOR_CONTINUOUS=true
POLLING_INTERVALS_MS=sessionsList=30000,sessionStatus=15000,cron=60000

# docker-compose.vps.yml
deploy:
  resources:
    limits:
      memory: 512M
      cpus: '1.0'
```

### 3. 高性能 VPS（4核8G+）
```env
# .env 配置
MONITOR_CONTINUOUS=true
POLLING_INTERVALS_MS=sessionsList=10000,sessionStatus=5000,cron=30000

# docker-compose.vps.yml
deploy:
  resources:
    limits:
      memory: 1G
      cpus: '2.0'
```

## 安全加固

### 1. 配置防火墙
```bash
# 只允许特定 IP 访问
ufw allow from YOUR_IP to any port 4310

# 或使用 Nginx 反向代理 + HTTPS
```

### 2. 设置强密码
```bash
# 生成随机 token
openssl rand -hex 32

# 写入 .env
echo "LOCAL_API_TOKEN=$(openssl rand -hex 32)" >> .env
```

### 3. 定期更新
```bash
# 每周拉取更新
cd /opt/openclaw-control-center
git pull origin foxai
docker-compose build
docker-compose restart control-center
```

## 故障排查命令

```bash
# 完整诊断
./deploy-vps.sh --check-only

# 查看容器状态
docker-compose ps
docker inspect foxai-control-center

# 进入容器调试
docker-compose exec control-center sh
env | grep -E "GATEWAY|OPENCLAW"
wget -O- http://localhost:4310/healthz

# 重置并重新部署
docker-compose down -v
rm -rf runtime/
./deploy-vps.sh
```

## 监控告警（可选）

### 使用 cron 定期检查
```bash
# 添加到 crontab
*/5 * * * * curl -sf http://localhost:4310/healthz | jq -e '.ok == true' || echo "Control Center unhealthy" | mail -s "Alert" admin@example.com
```

### 使用 systemd 管理
```bash
# 创建 systemd service
sudo nano /etc/systemd/system/openclaw-control-center.service
```

```ini
[Unit]
Description=OpenClaw Control Center
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/openclaw-control-center
ExecStart=/usr/bin/docker-compose -f docker-compose.yml -f docker-compose.vps.yml up -d
ExecStop=/usr/bin/docker-compose down
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable openclaw-control-center
sudo systemctl start openclaw-control-center
```

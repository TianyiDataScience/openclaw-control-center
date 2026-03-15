# OpenClaw Control Center - VPS 部署优化 (foxai 分支)

## 🎯 本分支的改进

### 1. 修复 CPU 使用率负数问题
- **问题**: 系统监控显示 CPU 使用率 -1519%
- **原因**: macOS `top` 命令解析错误
- **修复**: 正确解析 idle 百分比，限制在 0-100% 范围
- **文件**: `src/runtime/system-monitor.ts`

### 2. 添加连接诊断系统
- **功能**: 自动检测 6 个关键数据源的连接状态
- **检查项**:
  - ✓ OpenClaw Gateway（必需）
  - ✓ OpenClaw Config（必需）
  - ⚠ Codex Telemetry（可选）
  - ⚠ Subscription Snapshot（可选）
  - ⚠ Runtime Directory（自动）
  - ⚠ Model Context Catalog（可选）
- **API**: `GET /api/diagnostics`
- **文件**: `src/runtime/connection-diagnostics.ts`

### 3. 增强 Settings 页面
- 显示连接诊断卡片
- 提供修复建议和路径信息
- 实时显示整体健康度
- 访问: `/?section=settings&lang=zh`

### 4. VPS 部署优化
- **配置**: `docker-compose.vps.yml`
- **特性**:
  - 使用 host 网络直接访问 Gateway
  - 正确挂载 OpenClaw 数据目录
  - 优化资源限制（512M/1核）
  - 配置健康检查和日志轮转

### 5. 自动化部署
- **脚本**: `deploy-vps.sh`
- **功能**:
  - 自动检查前置条件
  - 验证配置和连接
  - 构建和启动服务
  - 执行健康检查

## 🚀 快速开始

### 在 VPS 上部署

```bash
# 1. 克隆项目
git clone https://github.com/TianyiDataScience/openclaw-control-center.git
cd openclaw-control-center
git checkout foxai

# 2. 配置环境
cp .env.example .env
nano .env  # 修改 GATEWAY_URL 和 LOCAL_API_TOKEN

# 3. 一键部署
./deploy-vps.sh
```

### 访问控制中心

- 总览: `http://your-vps-ip:4310/?section=overview&lang=zh`
- 系统监控: `http://your-vps-ip:4310/?section=system-monitor&lang=zh`
- 连接诊断: `http://your-vps-ip:4310/?section=settings&lang=zh`

## 📚 文档

- [Docker 部署指南](DOCKER_DEPLOYMENT.md) - 完整部署文档
- [VPS 快速启动](VPS_QUICKSTART.md) - 快速启动和故障排查
- [优化总结](OPTIMIZATION_SUMMARY.md) - 技术改进详情
- [部署清单](DEPLOYMENT_CHECKLIST.md) - 部署检查清单

## 🔧 关键配置

### .env 必须修改的项

```env
# Gateway 地址（必须）
GATEWAY_URL=ws://127.0.0.1:18789

# API Token（必须）
LOCAL_API_TOKEN=your-secure-token-here

# OpenClaw 路径（如果不在默认位置）
OPENCLAW_HOME=/root/.openclaw

# 启用持续监控（推荐）
MONITOR_CONTINUOUS=true
```

### docker-compose.vps.yml 关键配置

```yaml
services:
  control-center:
    network_mode: host  # 直接访问 Gateway
    
    volumes:
      - /root/.openclaw:/root/.openclaw:ro  # OpenClaw 数据
      - ./runtime:/app/runtime:rw           # Runtime 缓存
    
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: '1.0'
```

## 🩺 健康检查

### 自动诊断
```bash
# 完整诊断
curl http://localhost:4310/api/diagnostics | jq .

# 健康状态
curl http://localhost:4310/healthz | jq .
```

### 手动检查
```bash
# Gateway 连接
netstat -an | grep 18789

# OpenClaw 配置
cat ~/.openclaw/openclaw.json | jq '.agents | length'

# 容器日志
docker-compose logs -f control-center
```

## 🎨 功能对比

| 功能 | 只有 Gateway | Gateway + Config | 完全连接 |
|------|-------------|-----------------|---------|
| 实时会话 | ✓ | ✓ | ✓ |
| 任务列表 | ✓ | ✓ | ✓ |
| 员工页面 | 部分 | ✓ | ✓ |
| 用量统计 | ✗ | 部分 | ✓ |
| 配额显示 | ✗ | ✗ | ✓ |
| 系统监控 | ✓ | ✓ | ✓ |

## 🐛 常见问题

### CPU 显示负数
**已修复** - 拉取最新代码即可

### 数据全部未连接
检查 docker-compose.vps.yml 中的 volumes 挂载是否正确

### Gateway 连接失败
确保使用 `network_mode: host` 或正确配置网络

### 内存不足
增加 memory limit 或减少 POLLING_INTERVALS_MS

## 📞 支持

- 查看日志: `docker-compose logs control-center`
- 重启服务: `docker-compose restart control-center`
- 完整重置: `docker-compose down -v && ./deploy-vps.sh`

## 🔄 更新部署

```bash
cd /opt/openclaw-control-center
git pull origin foxai
docker-compose build
docker-compose restart control-center
```

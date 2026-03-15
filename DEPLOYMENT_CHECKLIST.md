# VPS 部署清单

## ✅ 已完成的优化

### 核心修复
- [x] **修复 CPU 使用率负数问题** - 从 -1519% 修复为正确的 0-100% 范围
- [x] **添加连接诊断系统** - 自动检测 6 个关键数据源的连接状态
- [x] **优化 Docker 配置** - 专门针对 VPS 环境优化资源使用

### 新增功能
- [x] **连接诊断 API** - `GET /api/diagnostics` 返回所有数据源状态
- [x] **Settings 页面增强** - 显示连接诊断卡片和修复建议
- [x] **Gateway 健康监控** - 定期检查 Gateway 连接和延迟
- [x] **自动化部署脚本** - `deploy-vps.sh` 一键部署和验证

### 文档完善
- [x] `DOCKER_DEPLOYMENT.md` - 完整 Docker 部署指南
- [x] `VPS_QUICKSTART.md` - 快速启动和故障排查
- [x] `OPTIMIZATION_SUMMARY.md` - 优化总结
- [x] `docker-compose.vps.yml` - VPS 专用配置

## 📋 在 VPS 上的部署步骤

### 第一步：在 VPS 上克隆项目

```bash
ssh your-vps

cd /opt
git clone https://github.com/TianyiDataScience/openclaw-control-center.git
cd openclaw-control-center
git checkout foxai
```

### 第二步：配置环境

```bash
# 创建配置文件
cp .env.example .env

# 编辑配置（必须修改这些项）
nano .env
```

**必须修改的配置：**
```env
GATEWAY_URL=ws://127.0.0.1:18789        # 改成你的 Gateway 地址
LOCAL_API_TOKEN=your-secure-token       # 设置强密码
OPENCLAW_HOME=/root/.openclaw           # 如果不在默认位置
MONITOR_CONTINUOUS=true                 # 启用持续监控
```

### 第三步：运行部署脚本

```bash
# 自动部署（推荐）
./deploy-vps.sh

# 或手动部署
docker-compose -f docker-compose.yml -f docker-compose.vps.yml up -d
```

### 第四步：验证部署

```bash
# 1. 检查容器状态
docker-compose ps

# 2. 查看启动日志
docker-compose logs -f control-center

# 3. 健康检查
curl http://localhost:4310/healthz | jq .

# 4. 连接诊断
curl http://localhost:4310/api/diagnostics | jq .
```

### 第五步：访问控制中心

在浏览器中打开：
- 总览页面: `http://your-vps-ip:4310/?section=overview&lang=zh`
- 系统监控: `http://your-vps-ip:4310/?section=system-monitor&lang=zh`
- 连接诊断: `http://your-vps-ip:4310/?section=settings&lang=zh`

## 🔍 数据连接诊断

访问 Settings 页面会看到 6 个连接检查：

| 组件 | 状态 | 说明 |
|------|------|------|
| OpenClaw Gateway | 必需 | 实时会话和任务数据 |
| OpenClaw Config | 必需 | Agent 配置和名单 |
| Codex Telemetry | 可选 | 详细用量统计 |
| Subscription Snapshot | 可选 | 配额和订阅信息 |
| Runtime Directory | 自动 | 本地缓存和历史 |
| Model Context Catalog | 可选 | 上下文窗口百分比 |

### 如果显示"未连接"

**Gateway 未连接：**
```bash
# 检查 Gateway 是否运行
ps aux | grep gateway
netstat -an | grep 18789

# 检查 .env 中的 GATEWAY_URL 是否正确
cat .env | grep GATEWAY_URL
```

**OpenClaw Config 未连接：**
```bash
# 检查配置文件
ls -la ~/.openclaw/openclaw.json

# 如果在其他位置，在 docker-compose.vps.yml 中挂载
volumes:
  - /your/actual/path/.openclaw:/root/.openclaw:ro
```

**Codex/Subscription 未连接：**
```bash
# 这些是可选的，不影响核心功能
# 如果需要用量统计，挂载相应目录
volumes:
  - /root/.codex:/root/.codex:ro
```

## 🚀 性能优化建议

### 低资源 VPS (1核2G)
```env
# .env
MONITOR_CONTINUOUS=false
POLLING_INTERVALS_MS=sessionsList=60000,sessionStatus=30000,cron=120000
```

```yaml
# docker-compose.vps.yml
deploy:
  resources:
    limits:
      memory: 256M
      cpus: '0.5'
```

### 标准 VPS (2核4G) - 推荐
```env
# .env
MONITOR_CONTINUOUS=true
POLLING_INTERVALS_MS=sessionsList=30000,sessionStatus=15000,cron=60000
```

```yaml
# docker-compose.vps.yml
deploy:
  resources:
    limits:
      memory: 512M
      cpus: '1.0'
```

### 高性能 VPS (4核8G+)
```env
# .env
MONITOR_CONTINUOUS=true
POLLING_INTERVALS_MS=sessionsList=10000,sessionStatus=5000,cron=30000
```

```yaml
# docker-compose.vps.yml
deploy:
  resources:
    limits:
      memory: 1G
      cpus: '2.0'
```

## 📊 监控指标

部署后可以通过以下端点监控：

- `/healthz` - 系统健康状态
- `/api/diagnostics` - 连接诊断
- `/?section=system-monitor` - VPS 资源监控
- `/?section=settings` - 数据连接状态

## 🔧 故障排查

### 容器无法启动
```bash
docker-compose logs control-center
docker-compose down
docker-compose up
```

### Gateway 连接失败
```bash
# 测试网络连接
docker-compose exec control-center sh
wget -O- http://localhost:18789 || echo "不可达"

# 使用 host 网络模式
# 在 docker-compose.vps.yml 中已配置
```

### 数据不更新
```bash
# 检查监控是否运行
docker-compose exec control-center sh
ls -la /app/runtime/timeline.log
tail -f /app/runtime/timeline.log
```

## 📝 提交到 GitHub

```bash
# 查看修改
git status
git diff

# 提交
git add .
git commit -m "优化: 修复 CPU 负数问题，添加连接诊断，优化 VPS 部署

- 修复 macOS CPU 使用率计算，避免负数
- 添加连接诊断模块，自动检测 6 个数据源
- 在 Settings 页面显示连接状态和修复建议
- 创建 VPS 专用 Docker Compose 配置
- 添加自动化部署脚本和完整文档"

# 推送到 foxai 分支
git push origin foxai
```

## ✨ 预期效果

部署后你应该看到：

1. **系统监控页面** - CPU、内存、磁盘、进程都正常显示（0-100%）
2. **Settings 页面** - 连接诊断显示哪些数据源已连接，哪些缺失
3. **总览页面** - 如果 Gateway 连接成功，显示实时会话和任务
4. **用量页面** - 如果 Codex 连接成功，显示用量统计；否则显示"数据源未连接"

即使部分数据源缺失，控制中心也能正常运行，只是相关功能会降级。

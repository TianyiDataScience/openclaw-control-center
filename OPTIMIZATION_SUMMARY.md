# OpenClaw Control Center - VPS 部署优化总结

## 已完成的优化

### 1. 修复 CPU 使用率负数问题 ✓
- **文件**: `src/runtime/system-monitor.ts`
- **问题**: macOS `top` 命令解析错误，导致 CPU 使用率显示 -1519%
- **修复**: 
  - 正确解析 `idle` 百分比
  - 使用 `100 - idle` 计算实际使用率
  - 添加 `Math.max(0, Math.min(100, usage))` 限制在 0-100% 范围

### 2. 添加连接诊断模块 ✓
- **文件**: `src/runtime/connection-diagnostics.ts`
- **功能**:
  - 自动检测 Gateway 连接状态
  - 检查 OpenClaw 配置文件
  - 检查 Codex Telemetry 目录
  - 检查订阅快照文件
  - 检查 Runtime 目录和数据
  - 检查模型上下文目录
- **API**: `GET /api/diagnostics`

### 3. 增强 Settings 页面 ✓
- 添加"连接诊断"卡片
- 显示所有数据源的连接状态
- 提供修复建议和路径信息
- 实时显示连接健康度

### 4. 创建 Gateway 健康监控 ✓
- **文件**: `src/runtime/gateway-health.ts`
- **功能**:
  - 定期检查 Gateway 连接
  - 记录延迟和重试次数
  - 提供最后健康状态查询

### 5. Docker 部署优化 ✓
- **文件**: `docker-compose.vps.yml`
- **优化**:
  - 使用 `network_mode: host` 直接访问 Gateway
  - 正确挂载 OpenClaw 数据目录
  - 优化资源限制（512M 内存，1 核 CPU）
  - 配置健康检查和日志轮转
  - 启用持续监控模式

### 6. 自动化部署脚本 ✓
- **文件**: `deploy-vps.sh`
- **功能**:
  - 自动检查前置条件
  - 验证配置文件
  - 测试 Gateway 连接
  - 构建和启动服务
  - 执行健康检查
  - 显示访问信息

### 7. 完善文档 ✓
- `DOCKER_DEPLOYMENT.md` - 完整部署指南
- `VPS_QUICKSTART.md` - 快速启动指南
- 包含故障排查和优化建议

## 在 VPS 上部署的步骤

### 方式一：自动部署（推荐）

```bash
# 在 VPS 上执行
cd /opt
git clone https://github.com/TianyiDataScience/openclaw-control-center.git
cd openclaw-control-center
git checkout foxai

# 创建配置
cp .env.example .env
nano .env  # 修改 GATEWAY_URL 和 LOCAL_API_TOKEN

# 一键部署
./deploy-vps.sh
```

### 方式二：手动部署

```bash
# 1. 配置环境
cp .env.example .env
nano .env

# 2. 启动服务
docker-compose -f docker-compose.yml -f docker-compose.vps.yml up -d

# 3. 查看日志
docker-compose logs -f control-center

# 4. 健康检查
curl http://localhost:4310/healthz | jq .
curl http://localhost:4310/api/diagnostics | jq .
```

## 关键配置项

### .env 必须修改的项

```env
# 1. Gateway 地址（必须）
GATEWAY_URL=ws://127.0.0.1:18789  # 改成你的实际地址

# 2. API Token（必须）
LOCAL_API_TOKEN=your-secure-token-here  # 设置强密码

# 3. OpenClaw 路径（如果不在默认位置）
OPENCLAW_HOME=/root/.openclaw

# 4. 启用持续监控（推荐）
MONITOR_CONTINUOUS=true
```

### docker-compose.vps.yml 需要调整的项

```yaml
volumes:
  # 确保路径正确
  - /root/.openclaw:/root/.openclaw:ro  # 改成你的实际路径
  - ./runtime:/app/runtime:rw

deploy:
  resources:
    limits:
      memory: 512M  # 根据 VPS 配置调整
      cpus: '1.0'
```

## 数据连接状态检查

部署后访问设置页面查看连接状态：
```
http://your-vps-ip:4310/?section=settings&lang=zh
```

你会看到 6 个连接检查项：
1. ✓ OpenClaw Gateway - 必需
2. ✓ OpenClaw Config - 必需
3. ⚠ Codex Telemetry - 可选（影响用量统计）
4. ⚠ Subscription Snapshot - 可选（影响配额显示）
5. ⚠ Runtime Directory - 自动创建
6. ⚠ Model Context Catalog - 可选（影响上下文百分比）

## 预期效果

### 完全连接（所有数据源可用）
- 总览：显示实时会话、任务、审批
- 用量：显示今日/7天/30天用量和费用
- 员工：显示所有 agent 的工作状态
- 任务：显示任务执行链和证据
- 系统：显示 CPU、内存、磁盘、进程

### 部分连接（只有 Gateway）
- 总览：✓ 实时会话和任务
- 用量：⚠ 显示"数据源未连接"
- 员工：✓ 当前活跃 agent
- 任务：✓ 任务列表和执行状态
- 系统：✓ VPS 资源监控

### 最小连接（离线模式）
- 总览：⚠ 显示缓存数据
- 用量：⚠ 不可用
- 员工：⚠ 不可用
- 任务：⚠ 显示本地任务存储
- 系统：✓ VPS 资源监控

## 下一步

1. **在 VPS 上部署**
   ```bash
   ./deploy-vps.sh
   ```

2. **访问控制中心**
   ```
   http://your-vps-ip:4310/?section=overview&lang=zh
   ```

3. **检查连接状态**
   ```
   http://your-vps-ip:4310/?section=settings&lang=zh
   ```

4. **根据诊断结果修复缺失的连接**
   - 参考 `DOCKER_DEPLOYMENT.md` 中的故障排查部分

## 提交到 GitHub

如果你想把这些改进推送到 foxai 分支：

```bash
git add .
git commit -m "优化: 修复 CPU 负数问题，添加连接诊断，优化 VPS 部署"
git push origin foxai
```

#!/bin/bash
# VPS 部署和健康检查脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 检查必需工具
check_prerequisites() {
  log_info "检查必需工具..."
  
  if ! command -v docker &> /dev/null; then
    log_error "Docker 未安装"
    exit 1
  fi
  
  if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    log_error "Docker Compose 未安装"
    exit 1
  fi
  
  log_info "✓ Docker 和 Docker Compose 已安装"
}

# 检查 .env 文件
check_env_file() {
  log_info "检查配置文件..."
  
  if [ ! -f .env ]; then
    log_warn ".env 文件不存在，从 .env.example 创建"
    cp .env.example .env
    log_warn "请编辑 .env 文件，设置正确的 GATEWAY_URL 和其他配置"
    exit 1
  fi
  
  # 检查关键配置
  if ! grep -q "GATEWAY_URL=" .env; then
    log_error ".env 缺少 GATEWAY_URL 配置"
    exit 1
  fi
  
  log_info "✓ .env 文件存在"
}

# 检查 OpenClaw Gateway
check_gateway() {
  log_info "检查 OpenClaw Gateway 连接..."
  
  GATEWAY_URL=$(grep "^GATEWAY_URL=" .env | cut -d'=' -f2 | tr -d '"' | tr -d "'")
  GATEWAY_HOST=$(echo "$GATEWAY_URL" | sed 's|^wss\?://||' | cut -d':' -f1)
  GATEWAY_PORT=$(echo "$GATEWAY_URL" | grep -oE '[0-9]+$' || echo "18789")
  
  if timeout 2 bash -c "echo > /dev/tcp/$GATEWAY_HOST/$GATEWAY_PORT" 2>/dev/null; then
    log_info "✓ Gateway 可达: $GATEWAY_URL"
  else
    log_warn "⚠ Gateway 不可达: $GATEWAY_URL"
    log_warn "请确保 OpenClaw Gateway 正在运行"
  fi
}

# 检查 OpenClaw 配置
check_openclaw_config() {
  log_info "检查 OpenClaw 配置..."
  
  OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
  CONFIG_PATH="$OPENCLAW_HOME/openclaw.json"
  
  if [ -f "$CONFIG_PATH" ]; then
    AGENT_COUNT=$(jq '.agents | length' "$CONFIG_PATH" 2>/dev/null || echo "0")
    log_info "✓ OpenClaw 配置找到: $CONFIG_PATH ($AGENT_COUNT agents)"
  else
    log_warn "⚠ OpenClaw 配置未找到: $CONFIG_PATH"
    log_warn "员工和文档页面可能无法正常显示"
  fi
}

# 构建镜像
build_image() {
  log_info "构建 Docker 镜像..."
  docker-compose build
  log_info "✓ 镜像构建完成"
}

# 启动服务
start_service() {
  log_info "启动服务..."
  
  if [ -f docker-compose.vps.yml ]; then
    docker-compose -f docker-compose.yml -f docker-compose.vps.yml up -d
  else
    docker-compose up -d
  fi
  
  log_info "✓ 服务已启动"
}

# 等待服务就绪
wait_for_service() {
  log_info "等待服务就绪..."
  
  MAX_WAIT=60
  WAITED=0
  
  while [ $WAITED -lt $MAX_WAIT ]; do
    if curl -sf http://localhost:4310/healthz > /dev/null 2>&1; then
      log_info "✓ 服务已就绪"
      return 0
    fi
    sleep 2
    WAITED=$((WAITED + 2))
  done
  
  log_error "服务启动超时"
  docker-compose logs --tail=50 control-center
  exit 1
}

# 健康检查
health_check() {
  log_info "执行健康检查..."
  
  HEALTH_JSON=$(curl -sf http://localhost:4310/healthz || echo '{"ok":false}')
  HEALTH_OK=$(echo "$HEALTH_JSON" | jq -r '.ok // false')
  
  if [ "$HEALTH_OK" = "true" ]; then
    log_info "✓ 健康检查通过"
    echo "$HEALTH_JSON" | jq .
  else
    log_warn "⚠ 健康检查未通过"
    echo "$HEALTH_JSON" | jq .
  fi
  
  # 连接诊断
  log_info "执行连接诊断..."
  DIAG_JSON=$(curl -sf http://localhost:4310/api/diagnostics || echo '{"ok":false}')
  echo "$DIAG_JSON" | jq '.diagnostics // {}'
}

# 显示访问信息
show_access_info() {
  log_info "部署完成！"
  echo ""
  echo "访问地址："
  echo "  - 总览（中文）: http://localhost:4310/?section=overview&lang=zh"
  echo "  - 总览（英文）: http://localhost:4310/?section=overview&lang=en"
  echo "  - 系统监控: http://localhost:4310/?section=system-monitor&lang=zh"
  echo "  - 设置页面: http://localhost:4310/?section=settings&lang=zh"
  echo ""
  echo "常用命令："
  echo "  - 查看日志: docker-compose logs -f control-center"
  echo "  - 重启服务: docker-compose restart control-center"
  echo "  - 停止服务: docker-compose down"
  echo "  - 健康检查: curl http://localhost:4310/healthz | jq ."
  echo ""
}

# 主流程
main() {
  log_info "开始 VPS 部署流程..."
  
  check_prerequisites
  check_env_file
  check_gateway
  check_openclaw_config
  build_image
  start_service
  wait_for_service
  health_check
  show_access_info
}

# 如果带参数 --check-only，只做检查不部署
if [ "$1" = "--check-only" ]; then
  check_prerequisites
  check_env_file
  check_gateway
  check_openclaw_config
  log_info "检查完成"
  exit 0
fi

main

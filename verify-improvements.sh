#!/bin/bash
# 本地验证脚本 - 在推送到 VPS 前验证改进

set -e

echo "=== OpenClaw Control Center 本地验证 ==="
echo ""

# 1. 检查构建
echo "[1/5] 检查构建..."
npm run build
echo "✓ 构建成功"
echo ""

# 2. 运行测试
echo "[2/5] 运行测试..."
npm test 2>&1 | tail -20
echo ""

# 3. 检查新增文件
echo "[3/5] 检查新增文件..."
NEW_FILES=(
  "src/runtime/connection-diagnostics.ts"
  "src/runtime/gateway-health.ts"
  "docker-compose.vps.yml"
  "deploy-vps.sh"
  "DOCKER_DEPLOYMENT.md"
  "VPS_QUICKSTART.md"
  "OPTIMIZATION_SUMMARY.md"
)

for file in "${NEW_FILES[@]}"; do
  if [ -f "$file" ]; then
    echo "✓ $file"
  else
    echo "✗ $file (缺失)"
  fi
done
echo ""

# 4. 检查 CPU 修复
echo "[4/5] 验证 CPU 使用率修复..."
if grep -q "usage = Math.max(0, Math.min(100, usage))" src/runtime/system-monitor.ts; then
  echo "✓ CPU 使用率已添加范围限制"
else
  echo "✗ CPU 使用率修复未应用"
fi

if grep -q "match(/(\\\d+\\\.\\\d+)%\\\s+idle/)" src/runtime/system-monitor.ts; then
  echo "✓ macOS idle 解析已修复"
else
  echo "✗ macOS idle 解析未修复"
fi
echo ""

# 5. 检查 API 端点
echo "[5/5] 检查新增 API 端点..."
if grep -q "GET.*api/diagnostics" src/ui/server.ts; then
  echo "✓ /api/diagnostics 端点已添加"
else
  echo "✗ /api/diagnostics 端点缺失"
fi
echo ""

echo "=== 验证完成 ==="
echo ""
echo "下一步："
echo "1. 提交到 Git:"
echo "   git add ."
echo "   git commit -m '优化: 修复 CPU 负数，添加连接诊断，优化 VPS 部署'"
echo "   git push origin foxai"
echo ""
echo "2. 在 VPS 上部署:"
echo "   git pull origin foxai"
echo "   ./deploy-vps.sh"
echo ""
echo "3. 访问控制中心:"
echo "   http://your-vps-ip:4310/?section=settings&lang=zh"

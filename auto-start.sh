#!/bin/bash
# Control Center 启动脚本
# 在 OpenClaw 启动时自动启动

cd /home/node/.openclaw/workspace/openclaw-control-center

# 检查是否已在运行
if pgrep -f "tsx src/index.ts" > /dev/null; then
  echo "[control-center] already running"
  exit 0
fi

# 启动 Control Center
echo "[control-center] starting..."
UI_MODE=true npx tsx src/index.ts > /tmp/control-center.log 2>&1 &

echo "[control-center] started on port 4310"
echo "[control-center] URL: https://cvdyxwfhlavk.eu-central-1.clawcloudrun.com"

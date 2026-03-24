#!/bin/bash
# OpenClaw Control Center 启动脚本

cd "$(dirname "$0")"

# 检查 .env 文件
if [ ! -f .env ]; then
  echo "Creating .env from .env.example..."
  cp .env.example .env
fi

# 启动服务
echo "Starting OpenClaw Control Center..."
echo "Access at: http://<your-server-ip>:4310"
echo ""
echo "First time? You need to:"
echo "1. Get pairing code from server: curl -X POST http://localhost:4310/api/pairing"
echo "2. Enter the code at: http://<your-server-ip>:4310/pair"
echo ""

UI_MODE=true node --import tsx src/index.ts

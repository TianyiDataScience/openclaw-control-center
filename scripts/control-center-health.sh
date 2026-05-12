#!/bin/bash
# OpenClaw Control Center - Health Check & Recovery Script
# Run: watch -n 60 ./scripts/control-center-health.sh (manual watch)
# Or: launchctl (auto-recovery via KeepAlive=true)

set -euo pipefail

BASE=/Users/gary/Documents/Openclaw/openclaw-control-center
LOG=/Users/gary/.openclaw/logs/control-center-health.log

GATEWAY_PORT=18789
UI_PORT=4310

timestamp() { date '+%Y-%m-%dT%H:%M:%S%z'; }

echo "[$(timestamp)] 🔍 Health check starting..." >> "$LOG"

# 1. Check Gateway
if curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 http://127.0.0.1:$GATEWAY_PORT/openclaw/status 2>/dev/null | grep -q 200; then
    echo "[$(timestamp)] ✅ Gateway (port $GATEWAY_PORT) - OK" >> "$LOG"
else
    echo "[$(timestamp)] ❌ Gateway DOWN - restarting..." >> "$LOG"
    launchctl start ai.openclaw.gateway 2>/dev/null || \
        launchctl kickstart -p gui/$(id -u)/ai.openclaw.gateway 2>/dev/null || true
fi

# 2. Check Control Center UI
if curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 http://127.0.0.1:$UI_PORT/ 2>/dev/null | grep -q 200; then
    echo "[$(timestamp)] ✅ Control Center (port $UI_PORT) - OK" >> "$LOG"
else
    echo "[$(timestamp)] ❌ Control Center DOWN - restarting..." >> "$LOG"
    launchctl start com.gary.openclaw-control-center 2>/dev/null || \
        launchctl kickstart -p gui/$(id -u)/com.gary.openclaw-control-center 2>/dev/null || true
fi

echo "[$(timestamp)] ✅ Health check complete" >> "$LOG"

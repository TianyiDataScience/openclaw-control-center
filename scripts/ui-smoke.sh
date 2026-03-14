#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${UI_SMOKE_PORT:-4516}"
WAIT_SECONDS="${UI_SMOKE_WAIT_SECONDS:-10}"
LOG_DIR="$ROOT/runtime"
LOG_FILE="$LOG_DIR/ui-smoke-${PORT}.log"

mkdir -p "$LOG_DIR"
cd "$ROOT"

UI_MODE=true UI_PORT="$PORT" npm run dev >"$LOG_FILE" 2>&1 &
PID=$!

cleanup() {
  kill "$PID" >/dev/null 2>&1 || true
  wait "$PID" 2>/dev/null || true
}

trap cleanup EXIT

wait_for_ui() {
  local deadline=$((SECONDS + WAIT_SECONDS))
  while true; do
    if curl -fsS "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
      return 0
    fi
    if (( SECONDS >= deadline )); then
      echo "UI smoke failed: server did not become ready within ${WAIT_SECONDS}s." >&2
      cat "$LOG_FILE" >&2 || true
      return 1
    fi
    sleep 1
  done
}

wait_for_ui
curl -fsS "http://127.0.0.1:${PORT}/" | grep -E "office|usage|language|总览|用量|员工" >/dev/null
curl -fsS "http://127.0.0.1:${PORT}/docs?lang=en" | grep -E "document|workbench|docs|文档" >/dev/null

printf 'UI smoke passed on http://127.0.0.1:%s\n' "$PORT"

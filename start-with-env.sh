#!/bin/bash
cd /Users/gary/.openclaw/control-center
set -a
source .env
set +a
exec npm run dev

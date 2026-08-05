#!/usr/bin/env bash
# Deploy Telegram bot to Railway (zm-telegram-bot service).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

pkill -f 'zkm-ring/bot/index.js' 2>/dev/null || true

rm -rf bot/data
cp -R public/data bot/data

cd bot
railway service zm-telegram-bot
# Force include data even if gitignored
railway up --detach --no-gitignore
echo "Deploy kicked. Check: railway logs -s zm-telegram-bot"

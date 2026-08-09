#!/usr/bin/env bash
# Deploy standalone zeleny-api (server/) to Railway.
# Prod traffic for bot/site goes via green-route.ru (green-route-web embeds API);
# this service is the dedicated API hostname.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
railway up --detach --service zeleny-api --path-as-root server
echo "Deploy kicked. Check: railway logs --build -s zeleny-api"
echo "Smoke: curl -sS https://zeleny-api-production.up.railway.app/api/health"

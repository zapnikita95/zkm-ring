#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p public/downloads
APK_DST="public/downloads/zeleny-marshrut.apk"
if [[ -f android/app/build/outputs/apk/debug/app-debug.apk ]]; then
  cp -f android/app/build/outputs/apk/debug/app-debug.apk "$APK_DST"
elif [[ -f android/app/build/outputs/apk/release/app-release.apk ]]; then
  cp -f android/app/build/outputs/apk/release/app-release.apk "$APK_DST"
elif [[ -f ZelenyMarshrut-debug.apk ]]; then
  cp -f ZelenyMarshrut-debug.apk "$APK_DST"
elif [[ ! -f "$APK_DST" ]]; then
  echo "WARN: no APK found for $APK_DST — download button will 404 until you place one"
fi
if [[ -f "$APK_DST" ]]; then
  ls -lh "$APK_DST"
fi

railway service green-route-web >/dev/null
echo "Deploying green-route-web…"
# --no-gitignore: новые geojson/cities иногда ещё не в git, но нужны в образе
railway up --detach --no-gitignore --service green-route-web
echo "URL: https://green-route-web-production.up.railway.app"
echo "APK: https://green-route.ru/downloads/zeleny-marshrut.apk"
echo "Custom domain: railway domain green-route.ru  (если CLI Unauthorized — добавь в Dashboard → Settings → Networking)"

#!/usr/bin/env bash
# Upload IPA once App Store Connect app record exists for ru.zeleny.marshrut
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IPA="${1:-$HOME/Desktop/ZelenyMarshrut.ipa}"
KEY_JSON="$ROOT/secrets/asc-api-key.json"
BUNDLE_ID="ru.zeleny.marshrut"

[[ -f "$IPA" ]] || { echo "IPA not found: $IPA" >&2; exit 1; }
[[ -f "$KEY_JSON" ]] || { echo "missing $KEY_JSON" >&2; exit 1; }

cd "$ROOT"
eval "$(python3 - <<'PY'
import json, time
from pathlib import Path
import jwt
creds = json.loads(Path("secrets/asc-api-key.json").read_text())
now = int(time.time())
tok = jwt.encode(
    {"iss": creds["issuer_id"], "iat": now, "exp": now + 1100, "aud": "appstoreconnect-v1"},
    creds["key"], algorithm="ES256", headers={"kid": creds["key_id"]},
)
Path("/tmp/asc_jwt.txt").write_text(tok if isinstance(tok, str) else tok.decode())
Path("/tmp/AuthKey_%s.p8" % creds["key_id"]).write_text(creds["key"])
print("export KEY_ID=%s" % creds["key_id"])
print("export ISSUER=%s" % creds["issuer_id"])
PY
)"

TOK=$(cat /tmp/asc_jwt.txt)
echo "Checking ASC app for ${BUNDLE_ID}..."
RESP=$(curl -sS -G "https://api.appstoreconnect.apple.com/v1/apps" \
  --data-urlencode "filter[bundleId]=${BUNDLE_ID}" \
  -H "Authorization: Bearer ${TOK}")
COUNT=$(python3 -c 'import json,sys; print(len(json.loads(sys.argv[1]).get("data",[])))' "$RESP")
if [[ "$COUNT" -eq 0 ]]; then
  echo "No ASC app for ${BUNDLE_ID}. Create it in App Store Connect first." >&2
  exit 2
fi

export API_PRIVATE_KEYS_DIR=/tmp
xcrun altool --upload-app -f "$IPA" -t ios --apiKey "$KEY_ID" --apiIssuer "$ISSUER"
echo "Upload OK"

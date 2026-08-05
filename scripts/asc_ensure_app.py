#!/usr/bin/env python3
"""Ensure App Store Connect has bundle id + app for Зелёный Маршрут."""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

try:
    import jwt  # PyJWT
except ImportError:
    import subprocess

    subprocess.check_call([sys.executable, "-m", "pip", "install", "PyJWT", "cryptography", "-q"])
    import jwt

import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
KEY_JSON = ROOT / "secrets" / "asc-api-key.json"
BUNDLE_ID = "ru.zeleny.marshrut"
APP_NAME = "Зелёный Маршрут"
SKU = "zeleny-marshrut-ios"
PRIMARY_LOCALE = "ru"


def token(key_id: str, issuer_id: str, key_p8: str) -> str:
    now = int(time.time())
    return jwt.encode(
        {"iss": issuer_id, "iat": now, "exp": now + 1100, "aud": "appstoreconnect-v1"},
        key_p8,
        algorithm="ES256",
        headers={"kid": key_id},
    )


def api(tok: str, method: str, path: str, body: dict | None = None) -> dict:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        f"https://api.appstoreconnect.apple.com{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {tok}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        err = e.read().decode()
        raise SystemExit(f"ASC {method} {path} → {e.code}: {err}") from e


def main() -> None:
    if not KEY_JSON.is_file():
        raise SystemExit(f"missing {KEY_JSON}")
    creds = json.loads(KEY_JSON.read_text())
    tok = token(creds["key_id"], creds["issuer_id"], creds["key"])

    bids = api(tok, "GET", f"/v1/bundleIds?filter[identifier]={BUNDLE_ID}")
    if bids.get("data"):
        bid_id = bids["data"][0]["id"]
        print(f"bundleId exists: {BUNDLE_ID} ({bid_id})")
    else:
        created = api(
            tok,
            "POST",
            "/v1/bundleIds",
            {
                "data": {
                    "type": "bundleIds",
                    "attributes": {
                        "identifier": BUNDLE_ID,
                        "name": "Zeleny Marshrut",
                        "platform": "IOS",
                    },
                }
            },
        )
        bid_id = created["data"]["id"]
        print(f"bundleId created: {BUNDLE_ID} ({bid_id})")

    apps = api(tok, "GET", f"/v1/apps?filter[bundleId]={BUNDLE_ID}")
    if apps.get("data"):
        app_id = apps["data"][0]["id"]
        print(f"app exists: {APP_NAME} ({app_id})")
    else:
        created = api(
            tok,
            "POST",
            "/v1/apps",
            {
                "data": {
                    "type": "apps",
                    "attributes": {
                        "bundleId": BUNDLE_ID,
                        "name": APP_NAME,
                        "primaryLocale": PRIMARY_LOCALE,
                        "sku": SKU,
                        "platform": "IOS",
                    },
                }
            },
        )
        app_id = created["data"]["id"]
        print(f"app created: {APP_NAME} ({app_id})")

    print(json.dumps({"bundleId": BUNDLE_ID, "appId": app_id}, ensure_ascii=False))


if __name__ == "__main__":
    main()

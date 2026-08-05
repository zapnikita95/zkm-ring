#!/usr/bin/env python3
"""Скачать велотреки с mosregdata.ru и собрать public/data/routes-catalog.json."""
from __future__ import annotations

import json
import re
import subprocess
import sys
from html import unescape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "public" / "data" / "routes"
CATALOG = ROOT / "public" / "data" / "routes-catalog.json"
PAGE = "https://mosregdata.ru/article/files-cycling-routes-mo"
TMP = Path("/tmp/zm_gpx")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    TMP.mkdir(parents=True, exist_ok=True)
    html_path = TMP / "page.html"
    subprocess.check_call(["curl", "-fsSL", "-k", "-o", str(html_path), PAGE])
    html = html_path.read_text(encoding="utf-8", errors="replace")

    routes: list[dict] = []
    for m in re.finditer(r"<h4[^>]*>(.*?)</h4>(.*?)(?=<h4|$)", html, re.S | re.I):
        title = unescape(re.sub("<[^>]+>", "", m.group(1))).strip()
        block = m.group(2)
        km = re.search(r"Протяженность:\s*([\d.,]+)\s*км", block)
        if not km:
            continue
        desc_m = re.search(
            r"<li>(?!Протяженность)(?!Скачать)(?!Посмотреть)(.*?)</li>", block, re.S
        )
        gpx_m = re.search(r'href="(/gps/velo/[^"]+\.gpx)"', block, re.I)
        if not gpx_m:
            continue
        desc = unescape(re.sub("<[^>]+>", "", desc_m.group(1))).strip() if desc_m else ""
        gpx_path = gpx_m.group(1)
        slug = Path(gpx_path).stem.replace(".", "-")
        url = "https://mosregdata.ru" + gpx_path
        local = TMP / f"{slug}.gpx"
        subprocess.check_call(["curl", "-fsSL", "-k", "-o", str(local), url])
        gpx = local.read_text(encoding="utf-8", errors="replace")
        pts = [
            (float(lat), float(lon))
            for lat, lon in re.findall(
                r'<(?:trkpt|rtept) lat="([^"]+)" lon="([^"]+)"', gpx
            )
        ]
        if len(pts) < 2:
            print("skip empty", title, file=sys.stderr)
            continue
        clean = [pts[0]]
        for p in pts[1:]:
            if (p[0] - clean[-1][0]) ** 2 + (p[1] - clean[-1][1]) ** 2 > 1e-12:
                clean.append(p)
        if len(clean) > 900:
            step = max(1, len(clean) // 700)
            last = clean[-1]
            clean = clean[::step]
            if clean[-1] != last:
                clean.append(last)
        geo_name = f"{slug}.geojson"
        geo = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {"name": title, "source": gpx_path, "points": len(clean)},
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [[lon, lat] for lat, lon in clean],
                    },
                }
            ],
        }
        (OUT_DIR / geo_name).write_text(json.dumps(geo, ensure_ascii=False), encoding="utf-8")
        wpts = []
        for wm in re.finditer(
            r'<wpt lat="([^"]+)" lon="([^"]+)">\s*<name>([^<]*)</name>', gpx
        ):
            wpts.append(
                {
                    "id": f"{slug}-wpt-{len(wpts)}",
                    "name": unescape(wm.group(3)).strip(),
                    "category": "viewpoint",
                    "description": "",
                    "radius_m": 80,
                    "lat": float(wm.group(1)),
                    "lon": float(wm.group(2)),
                }
            )
        routes.append(
            {
                "id": slug,
                "title": title,
                "description": desc,
                "kmListed": float(km.group(1).replace(",", ".")),
                "geojson": f"data/routes/{geo_name}",
                "points": len(clean),
                "source": "mosregdata",
                "landmarks": wpts[:40],
            }
        )
        print(f"OK {title}: {len(clean)} pts")

    ring = json.loads((ROOT / "public/data/ring.geojson").read_text(encoding="utf-8"))
    zkm = {
        "id": "zkm-ring",
        "title": "Зелёное кольцо Москвы",
        "description": "Полный круг Зелёного кольца — парки, набережные и лесопарки вокруг города.",
        "kmListed": 162.0,
        "geojson": "data/ring.geojson",
        "points": len(ring["features"][0]["geometry"]["coordinates"]),
        "source": "zkm",
        "landmarks": [],
        "featured": True,
    }
    CATALOG.write_text(
        json.dumps(
            {
                "routes": [zkm] + routes,
                "sourceUrl": PAGE,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print("catalog", 1 + len(routes), "→", CATALOG)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Импорт открытого участка ВЕЛО1 Яхрома→Дубна (~56 км) в каталог.

Источник: Google My Maps с официальной страницы
https://velo-1.com/velo-yahroma-dubna
(mid=1x7ODru9nnhl4JA4bcNsXHnLKWqLtrLlt)
"""
from __future__ import annotations

import json
import math
import re
import subprocess
import sys
from html import unescape
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "public" / "data" / "routes"
GPX_DIR = ROOT / "public" / "data" / "gpx"
CATALOG = ROOT / "public" / "data" / "routes-catalog.json"
TMP = Path("/tmp/zm_velo1.kml")
KML_URL = (
    "https://www.google.com/maps/d/kml?mid=1x7ODru9nnhl4JA4bcNsXHnLKWqLtrLlt&forcekml=1"
)
WANT = {
    "ВЕЛО1 Яхрома",
    "ВЕЛО1 Дмитров",
    "ВЕЛО1 Татьянин Парк. Дубна",
}
RID = "velo1-yahroma-dubna"


def path_km(pts: list[tuple[float, float]]) -> float:
    def hav(a, b):
        R = 6371.0
        p1, p2 = math.radians(a[0]), math.radians(b[0])
        dphi = math.radians(b[0] - a[0])
        dl = math.radians(b[1] - a[1])
        x = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
        return 2 * R * math.asin(min(1.0, math.sqrt(x)))

    return sum(hav(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def dedupe_join(parts: list[list[tuple[float, float]]]) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for part in parts:
        for p in part:
            if not out or abs(out[-1][0] - p[0]) > 1e-7 or abs(out[-1][1] - p[1]) > 1e-7:
                out.append(p)
    return out


def main() -> None:
    subprocess.check_call(
        ["curl", "-fsSL", "-A", "Mozilla/5.0", "-o", str(TMP), KML_URL]
    )
    text = TMP.read_text(encoding="utf-8")
    text2 = re.sub(r'\sxmlns="[^"]+"', "", text, count=1)
    root = ET.fromstring(text2)
    found: dict[str, list[tuple[float, float]]] = {}
    for pm in root.iter("Placemark"):
        nm = unescape((pm.findtext("name") or "").strip())
        if nm not in WANT:
            continue
        coords = None
        for el in pm.iter("coordinates"):
            if el.text and el.text.strip():
                coords = el.text
                break
        if not coords:
            continue
        pts: list[tuple[float, float]] = []
        for tok in coords.split():
            parts = tok.split(",")
            if len(parts) >= 2:
                pts.append((float(parts[1]), float(parts[0])))
        if len(pts) >= 2:
            found[nm] = pts
    missing = WANT - set(found)
    if missing:
        print("missing:", missing, file=sys.stderr)
        sys.exit(1)

    # Яхрома → Дубна (как на официальном сайте)
    yah = list(reversed(found["ВЕЛО1 Яхрома"]))
    dmit = list(reversed(found["ВЕЛО1 Дмитров"]))
    dubn = list(reversed(found["ВЕЛО1 Татьянин Парк. Дубна"]))
    clean = dedupe_join([yah, dmit, dubn])
    km = path_km(clean)
    pts = clean
    if len(pts) > 900:
        step = max(1, len(pts) // 700)
        last = pts[-1]
        pts = pts[::step]
        if pts[-1] != last:
            pts.append(last)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    GPX_DIR.mkdir(parents=True, exist_ok=True)
    title = "ВЕЛО1: Яхрома → Дубна"
    geo_name = f"{RID}.geojson"
    geo = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "name": title,
                    "source": "velo-1.com / Google My Maps",
                    "points": len(pts),
                    "km": round(km, 1),
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[lon, lat] for lat, lon in pts],
                },
            }
        ],
    }
    (OUT_DIR / geo_name).write_text(json.dumps(geo, ensure_ascii=False), encoding="utf-8")

    gpx = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="green-route.ru" xmlns="http://www.topografix.com/GPX/1/1">',
        f"  <trk><name>{title}</name><trkseg>",
    ]
    for lat, lon in pts:
        gpx.append(f'    <trkpt lat="{lat:.6f}" lon="{lon:.6f}"></trkpt>')
    gpx += ["  </trkseg></trk>", "</gpx>", ""]
    (GPX_DIR / f"{RID}.gpx").write_text("\n".join(gpx), encoding="utf-8")

    entry = {
        "id": RID,
        "title": title,
        "description": (
            "Открытый участок национального маршрута ВЕЛО1 вдоль Канала им. Москвы. "
            "Благоустроенный, ≈ 56 км, Яхрома → Дубна."
        ),
        "kmListed": round(km, 1),
        "geojson": f"data/routes/{geo_name}",
        "points": len(pts),
        "source": "velo1",
        "landmarks": [],
        "featured": True,
        "cityId": "msk",
        "difficulty": "medium",
        "sourceNote": "https://velo-1.com/velo-yahroma-dubna",
    }
    cat = json.loads(CATALOG.read_text(encoding="utf-8"))
    routes = [r for r in (cat.get("routes") or []) if r.get("id") != RID]
    idx = next((i for i, r in enumerate(routes) if r.get("id") == "zkm-ring"), -1)
    if idx >= 0:
        routes.insert(idx + 1, entry)
    else:
        routes.insert(0, entry)
    cat["routes"] = routes
    CATALOG.write_text(json.dumps(cat, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"OK {RID}: {len(pts)} pts, {km:.1f} km → catalog ({len(routes)} routes)")


if __name__ == "__main__":
    main()

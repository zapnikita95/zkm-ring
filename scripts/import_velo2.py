#!/usr/bin/env python3
"""Импорт ВЕЛО2 Тучково → Звенигород в каталог.

Источник: публичный трек MapMagic (community), id 9k8g1BV
  «[43.8 km] Вело 2 от Тучково до Звенигорода»
  https://mapmagic.app/r/community/russia/moscow-oblast/…

Официальный благоустроенный участок короче (~21 км, forest-strip.ru);
полный проезд до ст. Звенигород ≈ 44 км — как на Wikiloc/MapMagic.
Wikiloc платный — берём геометрию из открытого MapMagic bbox API.
"""
from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "public" / "data" / "routes"
GPX_DIR = ROOT / "public" / "data" / "gpx"
CATALOG = ROOT / "public" / "data" / "routes-catalog.json"
RID = "velo2-tuchkovo-zvenigorod"
TRACK_ID = "9k8g1BV"
TITLE_HINT = "Вело 2 от Тучково до Звенигорода"
BBOX_URL = (
    "https://mapmagic.app/api/v2/route/public/bbox"
    "?lat1=55.55&lon1=36.40&lat2=55.78&lon2=36.95"
)


def decode_polyline(s: str, precision: int = 6) -> list[tuple[float, float]]:
    factor = 10**precision
    coords: list[tuple[float, float]] = []
    index = lat = lon = 0
    length = len(s)
    while index < length:
        for which in (0, 1):
            shift = result = 0
            while True:
                b = ord(s[index]) - 63
                index += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else (result >> 1)
            if which == 0:
                lat += delta
            else:
                lon += delta
        coords.append((lat / factor, lon / factor))
    return coords


def path_km(pts: list[tuple[float, float]]) -> float:
    def hav(a, b):
        R = 6371.0
        p1, p2 = math.radians(a[0]), math.radians(b[0])
        dphi = math.radians(b[0] - a[0])
        dl = math.radians(b[1] - a[1])
        x = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
        return 2 * R * math.asin(min(1.0, math.sqrt(x)))

    return sum(hav(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def join_parts(parts: list[list[tuple[float, float]]]) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for part in parts:
        if not part:
            continue
        if not out:
            out.extend(part)
            continue
        if abs(part[0][0] - out[-1][0]) < 1e-7 and abs(part[0][1] - out[-1][1]) < 1e-7:
            out.extend(part[1:])
        else:
            out.extend(part)
    return out


def fetch_track() -> dict:
    # curl надёжнее urllib на этой машине (SSL intercept)
    import tempfile

    tmp = Path(tempfile.mkstemp(suffix=".json")[1])
    try:
        subprocess.check_call(
            [
                "curl",
                "-fsSL",
                "-A",
                "ZelenyMarshrutImport/1.0",
                "-H",
                "Content-Type: application/json",
                "-H",
                "Accept: application/json",
                "--data",
                '{"filters":{}}',
                "-o",
                str(tmp),
                BBOX_URL,
            ]
        )
        data = json.loads(tmp.read_text(encoding="utf-8"))
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass
    tracks = data.get("tracks") or []
    for tr in tracks:
        if tr.get("id_track") == TRACK_ID:
            return tr
        title = (tr.get("variable_meta") or {}).get("title") or ""
        if TITLE_HINT in title:
            return tr
    raise SystemExit(f"track not found: {TRACK_ID} / {TITLE_HINT!r} (got {len(tracks)} tracks)")


def points_from_track(tr: dict) -> list[tuple[float, float]]:
    parts: list[list[tuple[float, float]]] = []
    for seg in tr.get("segments") or []:
        lines = ((seg.get("pieces") or {}).get("lines")) or []
        for pl in lines:
            parts.append(decode_polyline(pl, 6))
    pts = join_parts(parts)
    if len(pts) < 50:
        raise SystemExit(f"too few points: {len(pts)}")
    return pts


def main() -> None:
    tr = fetch_track()
    title_src = (tr.get("variable_meta") or {}).get("title") or TITLE_HINT
    pts = points_from_track(tr)
    km = path_km(pts)
    # sanity: start near Tuchkovo, end near Zvenigorod station
    tuch, zven = (55.601, 36.468), (55.701, 36.882)

    def dkm(a, b):
        return path_km([a, b])

    if dkm(pts[0], tuch) > 3 and dkm(pts[-1], tuch) < dkm(pts[0], tuch):
        pts = list(reversed(pts))
        print("reversed to Tuchkovo → Zvenigorod")
    if dkm(pts[0], tuch) > 5:
        print("WARN start far from Tuchkovo:", pts[0], file=sys.stderr)
    if dkm(pts[-1], zven) > 8:
        print("WARN end far from Zvenigorod station:", pts[-1], file=sys.stderr)

    # lightly downsample if huge
    if len(pts) > 1200:
        step = max(1, len(pts) // 900)
        last = pts[-1]
        pts = pts[::step]
        if pts[-1] != last:
            pts.append(last)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    GPX_DIR.mkdir(parents=True, exist_ok=True)
    title = "ВЕЛО2: Тучково → Звенигород"
    geo_name = f"{RID}.geojson"
    geo = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "name": title,
                    "source": f"MapMagic {TRACK_ID} / {title_src}",
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
            f"Полный проезд Тучково → ст. Звенигород ≈ {round(km)} км. "
            "Официально благоустроенный кусок короче (~21 км, forest-strip.ru); "
            "дальше — обычные дороги до города. На карте отмечен конец благоустройства."
        ),
        "kmListed": round(km, 1),
        "geojson": f"data/routes/{geo_name}",
        "points": len(pts),
        "source": "velo2",
        "landmarks": [],
        "featured": True,
        "cityId": "msk",
        "difficulty": "medium",
        "sourceNote": (
            "https://mapmagic.app/r/community/russia/moscow-oblast/"
            "9WZJon6-tuchkovo-velo2-zvenigorod-50km "
            f"(geometry: {TRACK_ID}); https://forest-strip.ru/nashi-proekty/velo-2"
        ),
    }
    cat = json.loads(CATALOG.read_text(encoding="utf-8"))
    routes = [r for r in (cat.get("routes") or []) if r.get("id") != RID]
    # после ВЕЛО1, иначе сразу после кольца
    idx = next((i for i, r in enumerate(routes) if r.get("id") == "velo1-yahroma-dubna"), -1)
    if idx < 0:
        idx = next((i for i, r in enumerate(routes) if r.get("id") == "zkm-ring"), -1)
    if idx >= 0:
        routes.insert(idx + 1, entry)
    else:
        routes.insert(0, entry)
    cat["routes"] = routes
    CATALOG.write_text(json.dumps(cat, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"OK {RID}: {len(pts)} pts, {km:.1f} km → catalog ({len(routes)} routes)")
    print(f"  start {pts[0]}  end {pts[-1]}")

    # превью
    try:
        subprocess.check_call(
            [sys.executable, str(ROOT / "scripts" / "bake_route_previews.py"), RID],
            cwd=str(ROOT),
        )
    except Exception as e:
        print("preview bake skipped:", e, file=sys.stderr)


if __name__ == "__main__":
    main()

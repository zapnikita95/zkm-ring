#!/usr/bin/env python3
"""Маршруты @kaluga_trail — Большая Калужская тропа (БКТ).

Промаркированный участок ~50 км вдоль р. Угра (нацпарк «Угра»), по данным RuTrail / tropabkt.
Геометрия: OSRM bike между якорями; заменить на GPX, когда появится официальный трек.

Usage:
  python3 scripts/build_kaluga_trail_routes.py
"""
from __future__ import annotations

import json
import math
import ssl
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "public" / "data" / "routes"
CATALOG = ROOT / "public" / "data" / "routes-catalog.json"
CITIES_JSON = ROOT / "public" / "data" / "cities.json"
CTX = ssl._create_unverified_context()
AUTHOR = {
    "name": "kaluga_trail",
    "url": "https://www.instagram.com/kaluga_trail",
}
UA = "ZelenyMarshrut/1.0 (route-builder; contact=green-route.ru)"
CITY_ID = "kaluga"
CITY_META = {
    "id": CITY_ID,
    "title": "Калуга",
    "subtitle": "Большая Калужская тропа и Угра",
    "emoji": "🌲",
    "lat": 54.51,
    "lon": 36.26,
}

# lon, lat — якоря промаркированного участка БКТ (Александровка → Дзержинка)
ROUTES = [
    {
        "id": "kaluga-trail-ugra-50",
        "title": "БКТ: Угра (промаркированный участок)",
        "theme": "forest",
        "themeLabel": "лес / река",
        "kmListedHint": 50.0,
        "difficulty": "medium",
        "description": (
            "Промаркированный участок Большой Калужской тропы вдоль р. Угра — "
            "лес, городище, мосты и турбазы нацпарка. По мотивам маршрутов @kaluga_trail."
        ),
        "anchors": [
            ("Александровское городище", 35.198, 54.749),
            ("Беляево", 35.142, 54.716),
            ("Папаево", 35.088, 54.692),
            ("Колыхмановский мост", 35.021, 54.671),
            ("Дзержинка (турбаза «Гнездо»)", 34.952, 54.638),
        ],
        "pois": [
            {"name": "Александровское городище", "lon": 35.198, "lat": 54.749, "kind": "heritage"},
            {"name": "Колыхмановский мост", "lon": 35.021, "lat": 54.671, "kind": "bridge"},
            {"name": "Турбаза «Гнездо»", "lon": 34.952, "lat": 54.638, "kind": "camp"},
        ],
        "featured": True,
    },
    {
        "id": "kaluga-trail-ugra-day",
        "title": "БКТ: дневной отрезок у Юхнова",
        "theme": "forest",
        "themeLabel": "лес / река",
        "kmListedHint": 22.0,
        "difficulty": "easy",
        "description": (
            "Короткий отрезок БКТ от Александровского городища до Беляево — "
            "удобно на выходной. По мотивам @kaluga_trail."
        ),
        "anchors": [
            ("Александровское городище", 35.198, 54.749),
            ("Лесной участок Угры", 35.175, 54.735),
            ("Беляево", 35.142, 54.716),
        ],
        "pois": [
            {"name": "Александровское городище", "lon": 35.198, "lat": 54.749, "kind": "heritage"},
            {"name": "Беляево", "lon": 35.142, "lat": 54.716, "kind": "village"},
        ],
        "featured": False,
    },
]


def hav_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1 = math.radians(a[0]), math.radians(a[1])
    lon2, lat2 = math.radians(b[0]), math.radians(b[1])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6371000 * 2 * math.asin(min(1.0, math.sqrt(h)))


def path_km(coords: list[list[float]]) -> float:
    if len(coords) < 2:
        return 0.0
    return sum(hav_m((coords[i][0], coords[i][1]), (coords[i + 1][0], coords[i + 1][1])) for i in range(len(coords) - 1)) / 1000


def http_json(url: str) -> dict | None:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=45, context=CTX) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        print("  http fail:", e)
        return None


def osrm_bike(a: tuple[float, float], b: tuple[float, float]) -> list[list[float]] | None:
    bases = [
        "https://routing.openstreetmap.de/routed-bike/route/v1/driving",
        "https://router.project-osrm.org/route/v1/driving",
    ]
    for base in bases:
        url = f"{base}/{a[0]},{a[1]};{b[0]},{b[1]}?overview=full&geometries=geojson&alternatives=false"
        data = http_json(url)
        if not data or data.get("code") != "Ok":
            continue
        routes = data.get("routes") or []
        if not routes:
            continue
        coords = (routes[0].get("geometry") or {}).get("coordinates")
        if coords and len(coords) >= 2:
            return coords
    return None


def build_line(anchors: list[tuple[str, float, float]], *, straight: bool = True) -> list[list[float]]:
    pts = [(lon, lat) for _, lon, lat in anchors]
    out: list[list[float]] = []
    for i in range(len(pts) - 1):
        if straight:
            seg = [[pts[i][0], pts[i][1]], [pts[i + 1][0], pts[i + 1][1]]]
        else:
            seg = osrm_bike(pts[i], pts[i + 1])
            if not seg:
                print(f"  OSRM miss {anchors[i][0]} → {anchors[i+1][0]}, straight")
                seg = [[pts[i][0], pts[i][1]], [pts[i + 1][0], pts[i + 1][1]]]
        if out and seg:
            if abs(out[-1][0] - seg[0][0]) < 1e-7 and abs(out[-1][1] - seg[0][1]) < 1e-7:
                seg = seg[1:]
            out.extend(seg)
        else:
            out.extend(seg or [])
        if not straight:
            time.sleep(0.35)
    if len(out) < 2:
        out = [[lon, lat] for _, lon, lat in anchors]
    return out


def ensure_city() -> None:
    cities = json.loads(CITIES_JSON.read_text(encoding="utf-8")).get("cities") or []
    ids = {c["id"] for c in cities}
    if CITY_ID not in ids:
        cities.append(CITY_META)
    else:
        for i, c in enumerate(cities):
            if c["id"] == CITY_ID:
                cities[i] = {**c, **CITY_META}
    CITIES_JSON.write_text(json.dumps({"cities": cities}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("cities.json: kaluga OK")


def write_route(spec: dict) -> dict:
    print("build", spec["id"])
    coords = build_line(spec["anchors"])
    km = round(path_km(coords), 2)
    start = spec["anchors"][0]
    end = spec["anchors"][-1]
    gj = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "id": spec["id"],
                    "title": spec["title"],
                    "theme": spec["theme"],
                    "author": AUTHOR["name"],
                    "source": "kaluga-trail-approx",
                    "km": km,
                },
                "geometry": {"type": "LineString", "coordinates": coords},
            }
        ],
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    geo_path = OUT_DIR / f"{spec['id']}.geojson"
    geo_path.write_text(json.dumps(gj, ensure_ascii=False, separators=(",", ":")))
    pois = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "name": p["name"],
                    "kind": p["kind"],
                    "theme": spec["theme"],
                    "routeId": spec["id"],
                },
                "geometry": {"type": "Point", "coordinates": [p["lon"], p["lat"]]},
            }
            for p in spec["pois"]
        ],
    }
    pois_path = OUT_DIR / f"{spec['id']}-pois.geojson"
    pois_path.write_text(json.dumps(pois, ensure_ascii=False, separators=(",", ":")))
    print(f"  km≈{km} pts={len(coords)} → {geo_path.name}")
    listed_km = spec["kmListedHint"]
    return {
        "id": spec["id"],
        "title": spec["title"],
        "description": f"{spec['description']} ≈ {listed_km:g} км по маркировке БКТ.",
        "kmListed": listed_km,
        "geojson": f"data/routes/{spec['id']}.geojson",
        "points": len(coords),
        "source": "kaluga_trail",
        "landmarks": [],
        "featured": spec.get("featured", False),
        "cityId": CITY_ID,
        "difficulty": spec["difficulty"],
        "theme": spec["theme"],
        "themeLabel": spec["themeLabel"],
        "author": AUTHOR,
        "sourceNote": "Большая Калужская тропа · @kaluga_trail · https://www.instagram.com/kaluga_trail",
        "startLat": start[2],
        "startLon": start[1],
        "endLat": end[2],
        "endLon": end[1],
        "poisGeojson": f"data/routes/{spec['id']}-pois.geojson",
    }


def upsert_catalog(entries: list[dict]) -> None:
    cat = json.loads(CATALOG.read_text(encoding="utf-8"))
    routes = cat.get("routes") or []
    by_id = {r["id"]: i for i, r in enumerate(routes)}
    for e in entries:
        if e["id"] in by_id:
            routes[by_id[e["id"]]] = e
        else:
            insert_at = len(routes)
            for i, r in enumerate(routes):
                if r.get("cityId") == CITY_ID:
                    insert_at = i
                    break
            routes.insert(insert_at, e)
            by_id = {r["id"]: i for i, r in enumerate(routes)}
    cat["routes"] = routes
    CATALOG.write_text(json.dumps(cat, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("catalog updated,", len(entries), "kaluga_trail routes")


def main() -> None:
    ensure_city()
    entries = [write_route(s) for s in ROUTES]
    upsert_catalog(entries)
    meta = {
        "author": AUTHOR,
        "routes": [{k: e[k] for k in ("id", "title", "theme", "kmListed", "geojson", "poisGeojson")} for e in entries],
        "note": "Approximate OSRM along BKT marked anchors; replace with official GPX from @kaluga_trail when available.",
    }
    (OUT_DIR / "kaluga-trail-meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()

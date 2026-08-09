#!/usr/bin/env python3
"""Собрать маршруты: biketravel stroll + ВелоСамара + Велоннов + существующий каталог.

Пишет geojson в public/data/routes/ и обновляет routes-catalog.json (+ cities).
Сложность — по длине трека.
"""
from __future__ import annotations

import json
import math
import re
import subprocess
import sys
import time
from html import unescape
from pathlib import Path
from urllib.parse import urljoin

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "public" / "data" / "routes"
CATALOG = ROOT / "public" / "data" / "routes-catalog.json"
CITIES_JSON = ROOT / "public" / "data" / "cities.json"
TMP = Path("/tmp/zm_import_cities")
UA = "Mozilla/5.0 (compatible; ZelenyMarshrutImport/1.0)"

CITIES = [
    {
        "id": "msk",
        "title": "Москва",
        "subtitle": "Зелёное кольцо и область",
        "emoji": "🏙",
        "lat": 55.75,
        "lon": 37.62,
    },
    {
        "id": "kislovodsk",
        "title": "Кисловодск",
        "subtitle": "Парк, КМВ и окрестности",
        "emoji": "⛰",
        "lat": 43.905,
        "lon": 42.717,
    },
    {
        "id": "samara",
        "title": "Самара",
        "subtitle": "Веломаршруты области",
        "emoji": "🌊",
        "lat": 53.2,
        "lon": 50.15,
    },
    {
        "id": "nnov",
        "title": "Нижний Новгород",
        "subtitle": "Велосипедный Нижний",
        "emoji": "🛤",
        "lat": 56.33,
        "lon": 44.0,
    },
    {
        "id": "sevastopol",
        "title": "Севастополь",
        "subtitle": "Прогулки у моря",
        "emoji": "⚓️",
        "lat": 44.6,
        "lon": 33.5,
    },
    {
        "id": "kirov",
        "title": "Киров",
        "subtitle": "Городские и лесные треки",
        "emoji": "🌲",
        "lat": 58.6,
        "lon": 49.65,
    },
    {
        "id": "buryatia",
        "title": "Бурятия",
        "subtitle": "Меркитская крепость",
        "emoji": "🏔",
        "lat": 51.15,
        "lon": 107.12,
    },
]


def curl(url: str, dest: Path, retries: int = 3) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    for i in range(retries):
        try:
            subprocess.check_call(
                ["curl", "-fsSL", "-k", "-A", UA, "-o", str(dest), url],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if dest.stat().st_size > 50:
                return
        except subprocess.CalledProcessError:
            pass
        time.sleep(0.8 * (i + 1))
    raise RuntimeError(f"download failed: {url}")


def haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    r = 6371.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dphi = math.radians(b[0] - a[0])
    dl = math.radians(b[1] - a[1])
    x = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(x))


def path_km(pts: list[tuple[float, float]]) -> float:
    return sum(haversine_km(pts[i - 1], pts[i]) for i in range(1, len(pts)))


def difficulty_for_km(km: float) -> str:
    """Единая шкала по длине полного трека.
    ≤20 лёгкий · <60 средний · <80 тяжёлый · 80+ хардкор.
    """
    if km <= 20:
        return "easy"
    if km < 60:
        return "medium"
    if km < 80:
        return "hard"
    return "hardcore"


DIFF_LABEL = {
    "easy": "лёгкий",
    "medium": "средний",
    "hard": "тяжёлый",
    "hardcore": "хардкор",
}


def parse_gpx_points(gpx: str) -> list[tuple[float, float]]:
    pts = [
        (float(lat), float(lon))
        for lat, lon in re.findall(
            r'<(?:trkpt|rtept)[^>]*\slat="([^"]+)"[^>]*\slon="([^"]+)"', gpx
        )
    ]
    if not pts:
        pts = [
            (float(lat), float(lon))
            for lon, lat in re.findall(
                r'<(?:trkpt|rtept)[^>]*\slon="([^"]+)"[^>]*\slat="([^"]+)"', gpx
            )
        ]
    clean: list[tuple[float, float]] = []
    for p in pts:
        if not clean or (p[0] - clean[-1][0]) ** 2 + (p[1] - clean[-1][1]) ** 2 > 1e-12:
            clean.append(p)
    return clean


def downsample(pts: list[tuple[float, float]], max_n: int = 900) -> list[tuple[float, float]]:
    if len(pts) <= max_n:
        return pts
    step = max(1, len(pts) // (max_n - 1))
    out = pts[::step]
    if out[-1] != pts[-1]:
        out.append(pts[-1])
    return out


def city_by_centroid(pts: list[tuple[float, float]]) -> str:
    lat = sum(p[0] for p in pts) / len(pts)
    lon = sum(p[1] for p in pts) / len(pts)
    # Москва / область
    if 54.8 <= lat <= 56.6 and 35.5 <= lon <= 39.5:
        return "msk"
    # Самара
    if 52.4 <= lat <= 54.2 and 48.5 <= lon <= 52.0:
        return "samara"
    # Нижний
    if 55.4 <= lat <= 57.2 and 42.5 <= lon <= 46.5:
        return "nnov"
    return "msk"  # fallback в каталог Москвы как «Россия / прочее» — лучше msk только для МО


def slugify(s: str) -> str:
    s = s.lower().strip()
    tr = str.maketrans(
        "абвгдеёжзийклмнопрстуфхцчшщъыьэюя",
        "abvgdeejzijklmnoprstufhzcss_y_eua",
    )
    s = s.translate(tr)
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return (s or "route")[:48]


def write_route(
    *,
    route_id: str,
    title: str,
    description: str,
    pts: list[tuple[float, float]],
    city_id: str,
    source: str,
    source_note: str = "",
    featured: bool = False,
) -> dict | None:
    if len(pts) < 2:
        return None
    pts = downsample(pts)
    km = round(path_km(pts), 1)
    if km < 1.5:
        return None
    diff = difficulty_for_km(km)
    geo_name = f"{route_id}.geojson"
    geo = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "name": title,
                    "source": source,
                    "points": len(pts),
                    "cityId": city_id,
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[lon, lat] for lat, lon in pts],
                },
            }
        ],
    }
    (OUT_DIR / geo_name).write_text(json.dumps(geo, ensure_ascii=False), encoding="utf-8")
    desc = description.strip()
    if not desc:
        desc = f"{DIFF_LABEL[diff].capitalize()} маршрут · ≈ {km} км"
    elif DIFF_LABEL[diff] not in desc.lower():
        desc = f"{desc} · {DIFF_LABEL[diff]}, ≈ {km} км"
    return {
        "id": route_id,
        "title": title.strip()[:120],
        "description": desc[:280],
        "kmListed": km,
        "geojson": f"data/routes/{geo_name}" if route_id != "zkm-ring" else "data/ring.geojson",
        "points": len(pts),
        "source": source,
        "landmarks": [],
        "featured": featured,
        "cityId": city_id,
        "difficulty": diff,
        "sourceNote": source_note[:160],
    }


def import_biketravel(existing_ids: set[str]) -> list[dict]:
    print("=== biketravel.space stroll ===")
    page = TMP / "bt_stroll.html"
    curl("https://biketravel.space/track?collection=stroll", page)
    html = page.read_text(encoding="utf-8", errors="replace")
    # ids from GPX links in stroll listing
    ids = sorted({int(x) for x in re.findall(r"/api/v1/track/gpx/(\d+)", html)})
    # titles: after /track/ID ... text before Подробнее / Скачать
    titles: dict[int, str] = {}
    for m in re.finditer(
        r'href="/track/(\d+)"[^>]*>[\s\S]{0,1200}?</a>',
        html,
    ):
        tid = int(m.group(1))
        block = m.group(0)
        # strip tags, take longest cyrillic-ish chunk
        text = unescape(re.sub(r"<[^>]+>", " ", block))
        text = re.sub(r"\s+", " ", text).strip()
        cands = re.findall(r"[A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9 «»\"\-\.,]{4,70}", text)
        cands = [c for c in cands if "Подробнее" not in c and "Скачать" not in c and "GPX" not in c]
        if cands:
            titles[tid] = max(cands, key=len).strip(" ·-")

    out: list[dict] = []
    for tid in ids:
        rid = f"bt-{tid}"
        if rid in existing_ids:
            continue
        gpx_path = TMP / f"bt_{tid}.gpx"
        try:
            curl(f"https://biketravel.space/api/v1/track/gpx/{tid}", gpx_path)
        except Exception as e:
            print(" skip", tid, e)
            continue
        pts = parse_gpx_points(gpx_path.read_text(encoding="utf-8", errors="replace"))
        title = titles.get(tid) or f"Маршрут {tid}"
        city = city_by_centroid(pts) if pts else "msk"
        # biketravel stroll often not Moscow — if unknown region, invent city bucket? keep msk only if in MO
        if city == "msk" and pts:
            lat = sum(p[0] for p in pts) / len(pts)
            lon = sum(p[1] for p in pts) / len(pts)
            if not (54.8 <= lat <= 56.6 and 35.5 <= lon <= 39.5):
                # attach to nearest known city or skip into nnov/samara if close else create soft "other" under msk as extra
                # Prefer: put non-MO tracks under a synthetic city only if needed — user asked Russia-wide.
                # Use nearest of samara/nnov/msk by distance.
                best = "msk"
                best_d = 1e9
                for c in CITIES:
                    d = haversine_km((lat, lon), (c["lat"], c["lon"]))
                    if d < best_d:
                        best_d, best = d, c["id"]
                city = best if best_d < 450 else "msk"
        item = write_route(
            route_id=rid,
            title=title,
            description="С biketravel.space (прогулочные)",
            pts=pts,
            city_id=city,
            source="biketravel",
            source_note=f"https://biketravel.space/track/{tid}",
        )
        if item:
            out.append(item)
            existing_ids.add(rid)
            print(" +", rid, item["title"], item["kmListed"], "km", item["cityId"])
        time.sleep(0.25)
    return out


def import_samara(existing_ids: set[str]) -> list[dict]:
    print("=== velosamara ===")
    page = TMP / "sam_list.html"
    curl("http://navigator.velosamara.ru/bicycle-tracks", page)
    html = page.read_text(encoding="utf-8", errors="replace")
    details = sorted(
        set(re.findall(r"https?://navigator\.velosamara\.ru/bicycle-tracks/[a-z0-9\-]+", html))
    )
    out: list[dict] = []
    for url in details:
        slug = url.rstrip("/").split("/")[-1]
        rid = f"samara-{slugify(slug)}"
        if rid in existing_ids:
            continue
        det = TMP / f"sam_{slug}.html"
        curl(url, det)
        h = det.read_text(encoding="utf-8", errors="replace")
        hm = re.search(r"<h2[^>]*>(.*?)</h2>", h, re.S)
        title = unescape(re.sub("<[^>]+>", "", hm.group(1))).strip() if hm else slug
        km_m = re.search(r"Протяж[её]нность:\s*([\d.,]+)\s*км", h, re.I)
        desc_m = re.search(r"Описание:</[^>]+>\s*<p[^>]*>(.*?)</p>", h, re.S | re.I)
        if not desc_m:
            desc_m = re.search(r"<p[^>]*>([^<]{40,280})</p>", h)
        desc = unescape(re.sub("<[^>]+>", " ", desc_m.group(1))).strip() if desc_m else ""
        gpx_m = re.search(r'data-download-url="([^"]+\.gpx)"', h, re.I)
        if not gpx_m:
            print(" no gpx", slug)
            continue
        gpx_url = urljoin("http://navigator.velosamara.ru/", gpx_m.group(1))
        gpx_path = TMP / f"sam_{slug}.gpx"
        curl(gpx_url, gpx_path)
        pts = parse_gpx_points(gpx_path.read_text(encoding="utf-8", errors="replace"))
        item = write_route(
            route_id=rid,
            title=title,
            description=desc or "Веломаршрут Самарской области",
            pts=pts,
            city_id="samara",
            source="velosamara",
            source_note=url,
        )
        if item:
            if km_m:
                try:
                    listed = float(km_m.group(1).replace(",", "."))
                    if listed > 1:
                        item["kmListed"] = round(listed, 1)
                        item["difficulty"] = difficulty_for_km(listed)
                except ValueError:
                    pass
            out.append(item)
            existing_ids.add(rid)
            print(" +", rid, item["title"], item["kmListed"])
        time.sleep(0.3)
    return out


def import_velonnov(existing_ids: set[str]) -> list[dict]:
    print("=== velonnov ===")
    urls: list[str] = []
    for page_n in (1, 2, 3):
        page_url = (
            "https://velonnov.ru/routes/"
            if page_n == 1
            else f"https://velonnov.ru/routes/page/{page_n}/"
        )
        page = TMP / f"nn_list_{page_n}.html"
        try:
            curl(page_url, page)
        except Exception:
            break
        html = page.read_text(encoding="utf-8", errors="replace")
        found = re.findall(r'href="(https://velonnov\.ru/routes/[a-z0-9\-]+/?)"', html)
        found += re.findall(r'href="(/routes/[a-z0-9\-]+/?)"', html)
        for h in found:
            if "page" in h or "tag" in h or "rss" in h:
                continue
            full = urljoin("https://velonnov.ru/", h).split("#")[0]
            if full.rstrip("/") in ("https://velonnov.ru/routes",):
                continue
            urls.append(full)
    urls = sorted(set(urls))
    out: list[dict] = []
    for url in urls:
        slug = url.rstrip("/").split("/")[-1]
        rid = f"nnov-{slugify(slug)}"
        if rid in existing_ids:
            continue
        det = TMP / f"nn_{slug}.html"
        try:
            curl(url, det)
        except Exception as e:
            print(" skip page", slug, e)
            continue
        h = det.read_text(encoding="utf-8", errors="replace")
        # GPX only if route-map / gps-track present
        gpx_m = re.search(
            r'class="[^"]*gps-track[^"]*"[^>]*href="([^"]+\.gpx)"|href="([^"]+\.gpx)"[^>]*class="[^"]*gps-track',
            h,
            re.I,
        )
        if not gpx_m:
            gpx_m2 = re.search(r'route-map[\s\S]{0,400}?href="([^"]+\.gpx)"', h, re.I)
            gpx_href = gpx_m2.group(1) if gpx_m2 else None
        else:
            gpx_href = gpx_m.group(1) or gpx_m.group(2)
        if not gpx_href:
            print(" no gpx", slug)
            continue
        gpx_url = urljoin("https://velonnov.ru/", gpx_href)
        title_m = re.search(r"<h1[^>]*>(.*?)</h1>", h, re.S | re.I)
        if not title_m:
            title_m = re.search(r"<title>([^<]+)</title>", h, re.I)
        title = unescape(re.sub("<[^>]+>", "", title_m.group(1))).strip() if title_m else slug
        title = re.sub(r"\s*\|\s*.*$", "", title).strip()
        km_m = re.search(r"Расстояние:\s*</[^>]+>\s*<[^>]+>([\d.,]+)\s*км", h, re.I)
        if not km_m:
            km_m = re.search(r">([\d.,]+)\s*км<", h)
        desc_m = re.search(r'class="annonce"[^>]*>\s*<p[^>]*>(.*?)</p>', h, re.S)
        desc = unescape(re.sub("<[^>]+>", " ", desc_m.group(1))).strip() if desc_m else ""
        gpx_path = TMP / f"nn_{slug}.gpx"
        try:
            curl(gpx_url, gpx_path)
        except Exception as e:
            print(" gpx fail", slug, e)
            continue
        pts = parse_gpx_points(gpx_path.read_text(encoding="utf-8", errors="replace"))
        item = write_route(
            route_id=rid,
            title=title,
            description=desc or "Маршрут Велосипедного Нижнего",
            pts=pts,
            city_id="nnov",
            source="velonnov",
            source_note=url,
        )
        if item:
            if km_m:
                try:
                    listed = float(km_m.group(1).replace(",", "."))
                    if listed > 1:
                        item["kmListed"] = round(listed, 1)
                        item["difficulty"] = difficulty_for_km(listed)
                except ValueError:
                    pass
            out.append(item)
            existing_ids.add(rid)
            print(" +", rid, item["title"], item["kmListed"])
        time.sleep(0.35)
    return out


def patch_existing(routes: list[dict]) -> list[dict]:
    """Добавить cityId/difficulty к уже существующим записям каталога."""
    out = []
    for r in routes:
        r = dict(r)
        rid = r.get("id", "")
        if rid == "zkm-ring":
            r["cityId"] = "msk"
            r["featured"] = True
            r["geojson"] = "data/ring.geojson"
        elif not r.get("cityId"):
            # mosreg → Москва/область
            if r.get("source") in ("mosregdata", "zkm", None) or rid.startswith(
                ("mytishchi", "sergposad", "podolsk", "krasnogorsk", "odintsovo", "khimki")
            ):
                r["cityId"] = "msk"
            else:
                r["cityId"] = r.get("cityId") or "msk"
        km = float(r.get("kmListed") or 0)
        r["difficulty"] = r.get("difficulty") or difficulty_for_km(km)
        out.append(r)
    return out


def sort_catalog(routes: list[dict]) -> list[dict]:
    def key(r: dict):
        city = r.get("cityId") or "msk"
        featured = 0 if r.get("featured") or r.get("id") == "zkm-ring" else 1
        # city order
        order = {"msk": 0, "kislovodsk": 1, "samara": 2, "nnov": 3}.get(city, 9)
        return (order, featured, r.get("title") or "")

    return sorted(routes, key=key)


def main() -> None:
    TMP.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    existing: list[dict] = []
    if CATALOG.exists():
        existing = json.loads(CATALOG.read_text(encoding="utf-8")).get("routes") or []
    existing = patch_existing(existing)
    ids = {r["id"] for r in existing}

    # keep ring geojson path special
    for r in existing:
        if r["id"] == "zkm-ring":
            r["geojson"] = "data/ring.geojson"
            r["featured"] = True
            r["cityId"] = "msk"

    new_items: list[dict] = []
    new_items += import_samara(ids)
    new_items += import_velonnov(ids)
    new_items += import_biketravel(ids)

    # merge: prefer existing for same id
    by_id = {r["id"]: r for r in existing}
    for it in new_items:
        by_id[it["id"]] = it
    routes = sort_catalog(list(by_id.values()))

    # ensure zkm-ring first within msk
    ring = [r for r in routes if r["id"] == "zkm-ring"]
    rest = [r for r in routes if r["id"] != "zkm-ring"]
    routes = ring + rest

    CATALOG.write_text(
        json.dumps({"routes": routes, "cities": CITIES}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    CITIES_JSON.write_text(json.dumps({"cities": CITIES}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"OK routes={len(routes)} cities={len(CITIES)} → {CATALOG}")
    by_city: dict[str, int] = {}
    for r in routes:
        by_city[r.get("cityId") or "?"] = by_city.get(r.get("cityId") or "?", 0) + 1
    print("by city", by_city)


if __name__ == "__main__":
    main()

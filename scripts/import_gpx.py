#!/usr/bin/env python3
"""Import ZKM GPX into public/data/*.json (offline assets)."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "data"

PARKS_RAW = [
    ("Главный ботанический сад", 55.8410, 37.5950, "Ботанический сад РАН"),
    ("Парк Останкино", 55.8245, 37.6120, "Парк вокруг усадьбы Останкино"),
    ("Тимирязевский парк", 55.8350, 37.5500, "Лесопарк Тимирязевской академии"),
    ("Покровское-Стрешнево", 55.8400, 37.4700, "Парк Покровское-Стрешнево"),
    ("Серебряный Бор", 55.7850, 37.4200, "Серебряный Бор / Строгино"),
    ("Крылатские холмы", 55.7600, 37.4300, "Лыжный / велопарк Крылатское"),
    ("Парк Фили", 55.7450, 37.4850, "Парк Фили"),
    ("Воробьёвы горы", 55.7100, 37.5450, "Природный заказник Воробьёвы горы"),
    ("МГУ · Главное здание", 55.7030, 37.5300, "Главное здание МГУ у кольца"),
    ("Воронцовский парк", 55.6580, 37.5330, "Усадьба Воронцово / парк"),
    ("Парк 50-летия Октября", 55.6450, 37.5050, "Парк у Юго-Запада"),
    ("Тропарёвский лесопарк", 55.6350, 37.4750, "Тропарёво на ЗКМ"),
    ("Усадьба Узкое", 55.6200, 37.5300, "Усадьба Узкое"),
    ("Высшая точка Москвы", 55.6050, 37.5200, "Теплый Стан / высшая точка"),
    ("ДОТ времён ВОВ", 55.5980, 37.5450, "Дот на юго-западе кольца"),
    ("Зелёный лабиринт", 55.5950, 37.5550, "Лабиринт у Битцы"),
    ("Битцевский лес", 55.6000, 37.5700, "Битцевский лесопарк"),
    ("Царицыно", 55.6150, 37.6800, "Музей-заповедник Царицыно"),
    ("Кузьминки", 55.6900, 37.7900, "Парк Кузьминки-Люблино"),
    ("Кусково", 55.7350, 37.8050, "Усадьба Кусково"),
    ("Измайловский парк", 55.7900, 37.7700, "Измайловский лесопарк"),
    ("Сокольники", 55.8000, 37.6750, "Парк Сокольники"),
    ("Лосиный Остров", 55.8450, 37.6800, "Нацпарк Лосиный Остров (край)"),
]


def main() -> None:
    gpx_path = Path(sys.argv[1] if len(sys.argv) > 1 else Path.home() / "Downloads" / "track21.gpx")
    gpx = gpx_path.read_text(encoding="utf-8")
    OUT.mkdir(parents=True, exist_ok=True)

    trk = [(float(lat), float(lon)) for lat, lon in re.findall(r'<trkpt lat="([^"]+)" lon="([^"]+)"', gpx)]
    clean = [trk[0]]
    for p in trk[1:]:
        if (p[0] - clean[-1][0]) ** 2 + (p[1] - clean[-1][1]) ** 2 > 1e-12:
            clean.append(p)
    if (clean[0][0] - clean[-1][0]) ** 2 + (clean[0][1] - clean[-1][1]) ** 2 > 1e-10:
        clean.append(clean[0])

    coords = [[lon, lat] for lat, lon in clean]
    ring = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"name": "ЗКМ", "source": gpx_path.name, "points": len(clean)},
                "geometry": {"type": "LineString", "coordinates": coords},
            }
        ],
    }
    (OUT / "ring.geojson").write_text(json.dumps(ring, ensure_ascii=False), encoding="utf-8")

    wpts = []
    for m in re.finditer(r'<wpt lat="([^"]+)" lon="([^"]+)">\s*<name>([^<]*)</name>', gpx):
        lat, lon, name = float(m.group(1)), float(m.group(2)), m.group(3).strip()
        nl = name.lower()
        kind = "other"
        if "туалет" in nl:
            kind = "toilet"
        elif "туннель" in nl:
            kind = "tunnel"
        elif "парк" in nl or "сквер" in nl:
            kind = "park"
        wpts.append({"lat": lat, "lon": lon, "name": name, "kind": kind})

    pois = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"name": w["name"], "kind": w["kind"]},
                "geometry": {"type": "Point", "coordinates": [w["lon"], w["lat"]]},
            }
            for w in wpts
        ],
    }
    (OUT / "pois.json").write_text(json.dumps(pois, ensure_ascii=False, indent=2), encoding="utf-8")

    def nearest(lat: float, lon: float):
        best_i, best_d = 0, 1e9
        for i, (a, b) in enumerate(clean):
            d = (a - lat) ** 2 + (b - lon) ** 2
            if d < best_d:
                best_d, best_i = d, i
        return clean[best_i], best_i

    parks_feats = []
    for name, lat, lon, desc in PARKS_RAW:
        snap, idx = nearest(lat, lon)
        parks_feats.append(
            {
                "type": "Feature",
                "properties": {
                    "id": f"park-{len(parks_feats) + 1}",
                    "name": name,
                    "description": desc,
                    "reward": f"Медаль «{name}»",
                    "radius_m": 120,
                    "trackIndex": idx,
                },
                "geometry": {"type": "Point", "coordinates": [snap[1], snap[0]]},
            }
        )
    parks = {"type": "FeatureCollection", "features": parks_feats}
    (OUT / "parks.json").write_text(json.dumps(parks, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"OK ring={len(clean)} pois={len(wpts)} parks={len(parks_feats)} → {OUT}")


if __name__ == "__main__":
    main()

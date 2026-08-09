#!/usr/bin/env python3
"""Align ZKM ring with current official Зелёное кольцо (Yandex labels).

- Main line: skip northern «крюк Коптево», follow Pasechnaya → Verkhnyaya
  using owner-provided anchors.
- Save removed Koptevo hook as public/data/alternatives/koptevo-hook.geojson
- Resnap landmarks + update catalog km/points.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "public" / "data"
RING_PATH = DATA / "ring.geojson"
LANDMARKS_PATH = DATA / "landmarks.json"
ALT_DIR = DATA / "alternatives"
ALT_PATH = ALT_DIR / "koptevo-hook.geojson"

sys.path.insert(0, str(ROOT / "scripts"))
from clean_ring_geometry import (  # noqa: E402
    clean_ring,
    hav,
    metrics,
    resnap_landmarks,
    update_catalog_points,
)

# Owner anchors (lat, lon), listed east→west along signed ring; we reverse to CW W→E.
OWNER_ANCHORS_EW = [
    (55.834788, 37.571865),
    (55.834287, 37.568881),
    (55.83249, 37.559368),
    (55.830128, 37.552577),
    (55.824479, 37.54125),
    (55.82337, 37.539817),
    (55.823426, 37.539829),
    (55.825761, 37.536733),
    (55.827058, 37.53506),
    (55.827016, 37.532504),
    (55.825973, 37.530192),
    (55.825967, 37.529565),
    (55.825918, 37.529242),
    (55.825607, 37.529427),
]


def resample_polyline(pts: list[list[float]], step_m: float = 30.0) -> list[list[float]]:
    if len(pts) < 2:
        return [list(p) for p in pts]
    out = [list(pts[0])]
    acc = 0.0
    for i in range(1, len(pts)):
        a, b = pts[i - 1], pts[i]
        seg = hav(a, b)
        cur_a = list(a)
        while acc + seg >= step_m:
            t = (step_m - acc) / seg if seg else 0
            cur_a = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]
            out.append(cur_a)
            a = cur_a
            seg = hav(a, b)
            acc = 0.0
        acc += seg
    if hav(out[-1], pts[-1]) > 4:
        out.append(list(pts[-1]))
    return out


def linspace(a: list[float], b: list[float], step_m: float = 30.0) -> list[list[float]]:
    d = hav(a, b)
    if d < 1:
        return []
    if d <= step_m:
        return [list(b)]
    n = max(1, int(math.ceil(d / step_m)))
    return [
        [a[0] + (k / n) * (b[0] - a[0]), a[1] + (k / n) * (b[1] - a[1])]
        for k in range(1, n + 1)
    ]


def find_north_hook(coords: list[list[float]]) -> tuple[int, int]:
    """Return [enter, leave) indices for lat>55.838 bulge near Koptevo."""
    enter = leave = None
    in_n = False
    for i in range(5000, min(5400, len(coords))):
        north = coords[i][1] > 55.838
        if north and not in_n:
            enter = i
            in_n = True
        elif not north and in_n:
            leave = i
            break
    if enter is None or leave is None:
        raise RuntimeError("Koptevo north hook not found")
    return enter, leave


def build_official(coords: list[list[float]]) -> tuple[list[list[float]], list[list[float]], dict]:
    enter, leave = find_north_hook(coords)
    # Keep one point before enter as fork
    fork = max(0, enter - 1)
    # Owner path CW (west→east)
    official = [[lon, lat] for lat, lon in reversed(OWNER_ANCHORS_EW)]
    official = resample_polyline(official, 28)

    # East end: Verkhnyaya / owner east anchor
    east_anchor = [OWNER_ANCHORS_EW[0][1], OWNER_ANCHORS_EW[0][0]]
    east_i = min(range(len(coords)), key=lambda i: hav(coords[i], east_anchor))

    # After leaving north bulge, old track approaches park — pick join near official west
    west_anchor = official[0]
    join = min(range(leave, min(leave + 120, east_i)), key=lambda i: hav(coords[i], west_anchor))

    # Koptevo alternative: fork → through north tip → back to leave (exclusive join on main)
    hook = [list(c) for c in coords[fork : leave + 1]]
    # Ensure hook ends near where main continues (leave)
    if hav(hook[-1], coords[leave]) > 5:
        hook.append(list(coords[leave]))

    # Main replacement: fork → short cut to leave → old southern approach to join
    # → official anchors → east
    path: list[list[float]] = [list(coords[fork])]
    # Chord fork→leave (skips Koptevo tip); then keep SE approach if useful
    for p in linspace(coords[fork], coords[leave], 32):
        path.append(p)
    # Prefer jumping to official west rather than wandering old zigzags after leave
    for p in linspace(path[-1], west_anchor, 32):
        path.append(p)
    for p in official:
        if hav(path[-1], p) > 8:
            path.append(p)
    for p in linspace(path[-1], coords[east_i], 32):
        path.append(p)

    new_coords = coords[: fork + 1] + path[1:] + coords[east_i + 1 :]
    meta = {
        "fork": fork,
        "enter": enter,
        "leave": leave,
        "join": join,
        "east_i": east_i,
        "hook_pts": len(hook),
        "hook_km": round(sum(hav(hook[i], hook[i + 1]) for i in range(len(hook) - 1)) / 1000, 2),
        "official_km": round(sum(hav(path[i], path[i + 1]) for i in range(len(path) - 1)) / 1000, 2),
    }
    return new_coords, hook, meta


def owner_coverage(coords: list[list[float]]) -> list[tuple[str, float]]:
    out = []
    for lat, lon in OWNER_ANCHORS_EW:
        pin = [lon, lat]
        i = min(range(len(coords)), key=lambda i: hav(coords[i], pin))
        out.append((f"{lat:.6f},{lon:.6f}", hav(coords[i], pin)))
    return out


def main() -> None:
    gj = json.loads(RING_PATH.read_text(encoding="utf-8"))
    feat = gj["features"][0]
    coords = [list(c) for c in feat["geometry"]["coordinates"]]
    print("BEFORE", metrics(coords))
    print("owner vs BEFORE:")
    for label, d in owner_coverage(coords):
        print(f"  {label}  {d:.1f}m")

    new_coords, hook, meta = build_official(coords)
    print("meta", meta)
    print("AFTER splice", metrics(new_coords))
    print("owner vs AFTER splice:")
    for label, d in owner_coverage(new_coords):
        print(f"  {label}  {d:.1f}m")

    cleaned, removed = clean_ring(new_coords)
    print("AFTER clean", metrics(cleaned), f"clean_removed={removed}")
    print("owner vs AFTER clean:")
    bad = 0
    for label, d in owner_coverage(cleaned):
        flag = "OK" if d < 45 else "FAR"
        if d >= 45:
            bad += 1
        print(f"  {label}  {d:.1f}m  {flag}")

    # Koptevo must not remain on main (no lat>55.843 in lon strip)
    bulge = [c for c in cleaned if 37.505 <= c[0] <= 37.525 and c[1] > 55.843]
    print(f"main north-of-Koptevo bulge pts: {len(bulge)}")
    if bulge:
        raise SystemExit("FAIL: Koptevo hook still on main ring")

    props = dict(feat.get("properties") or {})
    props["points"] = len(cleaned)
    props["cleaned"] = True
    props["officialGreenRing2026"] = True
    props["koptevoHookAlt"] = True
    props["officialMeta"] = meta
    feat["properties"] = props
    feat["geometry"]["coordinates"] = cleaned
    RING_PATH.write_text(json.dumps(gj, ensure_ascii=False), encoding="utf-8")

    ALT_DIR.mkdir(parents=True, exist_ok=True)
    alt = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "id": "koptevo-hook",
                    "title": "Крюк к МЦК Коптево",
                    "description": "Старый заезд к Коптево. Не входит в официальное Зелёное кольцо — можно проехать как альтернативу.",
                    "kind": "alternative",
                    "optional": True,
                    "km": meta["hook_km"],
                },
                "geometry": {"type": "LineString", "coordinates": hook},
            }
        ],
    }
    ALT_PATH.write_text(json.dumps(alt, ensure_ascii=False), encoding="utf-8")

    lm = json.loads(LANDMARKS_PATH.read_text(encoding="utf-8"))
    # Keep Timiryazev pin on Verkhnyaya corridor
    for f in lm["features"]:
        if f["properties"].get("id") == "park-timiryazev":
            cands = [
                (i, c)
                for i, c in enumerate(cleaned)
                if 37.555 <= c[0] <= 37.565 and 55.830 <= c[1] <= 55.8345
            ]
            if cands:
                mid = cands[len(cands) // 2][1]
                f["geometry"]["coordinates"] = [mid[0], mid[1]]
            break
    lm2 = resnap_landmarks(cleaned, lm)
    LANDMARKS_PATH.write_text(json.dumps(lm2, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    update_catalog_points(len(cleaned), metrics(cleaned)["km"])

    # Catalog note for alternative
    cat_path = DATA / "routes-catalog.json"
    cat = json.loads(cat_path.read_text(encoding="utf-8"))
    for r in cat.get("routes") or []:
        if r.get("id") == "zkm-ring":
            r["alternatives"] = [
                {
                    "id": "koptevo-hook",
                    "title": "Крюк к МЦК Коптево",
                    "geojson": "data/alternatives/koptevo-hook.geojson",
                    "optional": True,
                }
            ]
            break
    cat_path.write_text(json.dumps(cat, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"wrote {RING_PATH}")
    print(f"wrote {ALT_PATH} ({meta['hook_km']} km)")
    if bad:
        print(f"WARN: {bad} owner anchors still >45m (connectors)")
    print("OK")


if __name__ == "__main__":
    main()

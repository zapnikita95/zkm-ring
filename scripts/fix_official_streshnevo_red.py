#!/usr/bin/env python3
"""Force official ZKM onto owner red line: Timiryazev → Pasechnaya → Streshnevo.

Replaces the northern park/Baltiyskaya solid segment with owner anchors.
Keeps / refreshes Koptevo hook alternative from the removed northern bulge.
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
ALT_PATH = DATA / "alternatives" / "koptevo-hook.geojson"

sys.path.insert(0, str(ROOT / "scripts"))
from clean_ring_geometry import (  # noqa: E402
    clean_ring,
    hav,
    metrics,
    resnap_landmarks,
    update_catalog_points,
)

# East → west (as owner listed): Timiryazev / Verkhnyaya → Pasechnaya
SET1_EW = [
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

# Gap fill: red corridor SW of Baltiyskaya (stay south of old park strip ~55.837)
GAP_EW = [
    (55.82420, 37.52480),
    (55.82280, 37.51920),
    (55.82140, 37.51380),
    (55.82020, 37.50900),
]

# East → west: toward D2/МЦК Стрешнево (owner)
SET2_EW = [
    (55.819323, 37.504739),
    (55.818655, 37.502283),
    (55.818563, 37.502396),
    (55.818345, 37.501531),
    (55.817521, 37.502182),
    (55.816753, 37.502709),
    (55.816554, 37.502783),
    (55.816119, 37.501066),
    (55.815127, 37.501939),
    (55.815236, 37.500294),
    (55.815255, 37.497255),
    (55.815405, 37.493862),
    (55.815703, 37.4878),
    (55.816998, 37.487429),
    (55.817311, 37.485154),
]

ALL_EW = SET1_EW + GAP_EW + SET2_EW


def resample_polyline(pts: list[list[float]], step_m: float = 28.0) -> list[list[float]]:
    if len(pts) < 2:
        return [list(p) for p in pts]
    out = [list(pts[0])]
    acc = 0.0
    for i in range(1, len(pts)):
        a, b = pts[i - 1], pts[i]
        seg = hav(a, b)
        while acc + seg >= step_m and seg > 1e-6:
            t = (step_m - acc) / seg
            a = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]
            out.append(list(a))
            seg = hav(a, b)
            acc = 0.0
        acc += seg
    if hav(out[-1], pts[-1]) > 4:
        out.append(list(pts[-1]))
    return out


def nearest_i(coords: list[list[float]], pin: list[float], lo: int = 0, hi: int | None = None) -> int:
    hi = len(coords) if hi is None else hi
    return min(range(lo, hi), key=lambda i: hav(coords[i], pin))


def coverage(coords: list[list[float]], anchors: list[tuple[float, float]]) -> list[tuple[str, float]]:
    out = []
    for lat, lon in anchors:
        pin = [lon, lat]
        i = nearest_i(coords, pin)
        out.append((f"{lat:.6f},{lon:.6f}", hav(coords[i], pin)))
    return out


def extract_koptevo_hook(old: list[list[float]], west_i: int, east_i: int) -> list[list[float]]:
    """Northern bulge from the removed segment (old solid green via parks/Koptevo)."""
    lo, hi = sorted((west_i, east_i))
    seg = old[lo : hi + 1]
    # Keep points that go north of the new red corridor in the Koptevo strip
    north = [c for c in seg if c[1] >= 55.828 and 37.495 <= c[0] <= 37.535]
    if len(north) < 8:
        north = [c for c in seg if c[1] >= 55.826 and 37.490 <= c[0] <= 37.540]
    if len(north) < 4:
        return []
    # Order along original segment
    idxs = []
    for c in north:
        # find first matching-ish index in seg
        j = min(range(len(seg)), key=lambda i: hav(seg[i], c))
        idxs.append(j)
    a, b = min(idxs), max(idxs)
    hook = [list(c) for c in seg[a : b + 1]]
    return resample_polyline(hook, 35)


def main() -> None:
    gj = json.loads(RING_PATH.read_text(encoding="utf-8"))
    feat = gj["features"][0]
    coords = [list(c) for c in feat["geometry"]["coordinates"]]
    print("BEFORE", metrics(coords))

    east_pin = [SET1_EW[0][1], SET1_EW[0][0]]
    west_pin = [SET2_EW[-1][1], SET2_EW[-1][0]]
    east_i = nearest_i(coords, east_pin)
    west_i = nearest_i(coords, west_pin)
    print(f"splice west_i={west_i} east_i={east_i} (expect west_i < east_i)")

    if west_i >= east_i:
        raise SystemExit("FAIL: unexpected ring orientation / indices")

    # Official path west → east (ring index direction in this sector)
    official_we = [[lon, lat] for lat, lon in reversed(ALL_EW)]
    official_we = resample_polyline(official_we, 26)

    # Attach cleanly to ring endpoints
    path = [list(coords[west_i])]
    for p in official_we:
        if hav(path[-1], p) > 6:
            path.append(p)
    if hav(path[-1], coords[east_i]) > 6:
        path.append(list(coords[east_i]))

    removed = coords[west_i : east_i + 1]
    hook = extract_koptevo_hook(coords, west_i, east_i)
    # If extraction thin, fall back to existing alt file + any lat>55.832 in removed
    if len(hook) < 10:
        bulge = [list(c) for c in removed if c[1] > 55.832]
        if len(bulge) >= 10:
            hook = resample_polyline(bulge, 35)

    new_coords = coords[: west_i + 1] + path[1:] + coords[east_i + 1 :]
    print("AFTER splice", metrics(new_coords), "path_pts", len(path), "hook_pts", len(hook))

    cleaned, nrem = clean_ring(new_coords)
    print("AFTER clean", metrics(cleaned), f"clean_removed={nrem}")

    print("owner SET1+SET2 vs clean:")
    bad = 0
    for label, d in coverage(cleaned, SET1_EW + SET2_EW):
        flag = "OK" if d < 50 else "FAR"
        if d >= 50:
            bad += 1
        print(f"  {label}  {d:.1f}m  {flag}")

    strip = [c for c in cleaned if 37.490 <= c[0] <= 37.530]
    max_lat = max((c[1] for c in strip), default=0)
    print(f"max lat in lon 37.49–37.53: {max_lat:.6f}")
    if max_lat > 55.828:
        raise SystemExit("FAIL: main still goes north of red corridor (park/Koptevo strip)")

    props = dict(feat.get("properties") or {})
    props["points"] = len(cleaned)
    props["cleaned"] = True
    props["officialGreenRing2026"] = True
    props["koptevoHookAlt"] = True
    props["officialStreshnevoRed"] = True
    props["officialMeta"] = {
        "west_i": west_i,
        "east_i": east_i,
        "anchors": len(ALL_EW),
        "hook_pts": len(hook),
        "hook_km": round(
            sum(hav(hook[i], hook[i + 1]) for i in range(len(hook) - 1)) / 1000, 2
        )
        if len(hook) > 1
        else 0,
    }
    feat["properties"] = props
    feat["geometry"]["coordinates"] = cleaned
    RING_PATH.write_text(json.dumps(gj, ensure_ascii=False), encoding="utf-8")

    if len(hook) >= 4:
        ALT_PATH.parent.mkdir(parents=True, exist_ok=True)
        alt = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {
                        "id": "koptevo-hook",
                        "title": "Крюк к МЦК Коптево",
                        "description": "Старый заезд к Коптево / через парк севернее. Не входит в официальное Зелёное кольцо.",
                        "kind": "alternative",
                        "optional": True,
                        "km": props["officialMeta"]["hook_km"],
                    },
                    "geometry": {"type": "LineString", "coordinates": hook},
                }
            ],
        }
        ALT_PATH.write_text(json.dumps(alt, ensure_ascii=False), encoding="utf-8")
        print(f"wrote {ALT_PATH}")

    lm = json.loads(LANDMARKS_PATH.read_text(encoding="utf-8"))
    lm2 = resnap_landmarks(cleaned, lm)
    LANDMARKS_PATH.write_text(json.dumps(lm2, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    update_catalog_points(len(cleaned), metrics(cleaned)["km"])

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

    if bad:
        raise SystemExit(f"FAIL: {bad} owner anchors >50m from main")
    print(f"wrote {RING_PATH}")
    print("OK")


if __name__ == "__main__":
    main()

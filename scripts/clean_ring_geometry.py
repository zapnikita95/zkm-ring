#!/usr/bin/env python3
"""Clean spike/zigzag noise in ZKM ring.geojson and resnap landmarks indices.

Usage:
  python3 scripts/clean_ring_geometry.py
  python3 scripts/clean_ring_geometry.py --dry-run
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "public" / "data"
RING_PATH = DATA / "ring.geojson"
LANDMARKS_PATH = DATA / "landmarks.json"
CATALOG_PATH = DATA / "routes-catalog.json"


def hav(a: list[float], b: list[float]) -> float:
    lon1, lat1 = a
    lon2, lat2 = b
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(x)))


def bearing(a: list[float], b: list[float]) -> float:
    lon1, lat1 = map(math.radians, (a[0], a[1]))
    lon2, lat2 = map(math.radians, (b[0], b[1]))
    dl = lon2 - lon1
    y = math.sin(dl) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def signed_turn(a: list[float], b: list[float], c: list[float]) -> float:
    return (bearing(b, c) - bearing(a, b) + 540) % 360 - 180


def path_len(coords: list[list[float]]) -> float:
    return sum(hav(coords[i], coords[i + 1]) for i in range(len(coords) - 1))


def metrics(coords: list[list[float]]) -> dict:
    n = len(coords)
    spikes = uturns = 0
    sharps: list[tuple[int, float]] = []
    for i in range(1, n - 1):
        a, b, c = coords[i - 1], coords[i], coords[i + 1]
        ab, bc, ac = hav(a, b), hav(b, c), hav(a, c)
        t = signed_turn(a, b, c)
        if abs(t) >= 90:
            sharps.append((i, t))
        if abs(t) >= 150 and ab >= 10 and bc >= 10:
            uturns += 1
        if ab >= 12 and bc >= 12 and (ab + bc - ac) >= 35 and (ab + bc) > ac * 1.55:
            spikes += 1
    clusters = 0
    if sharps:
        cur = [sharps[0]]
        for s in sharps[1:]:
            if s[0] - cur[-1][0] <= 4:
                cur.append(s)
            else:
                if len(cur) >= 3:
                    clusters += 1
                cur = [s]
        if len(cur) >= 3:
            clusters += 1
    return {
        "n": n,
        "km": round(path_len(coords) / 1000, 3),
        "sharps90": len(sharps),
        "spikes": spikes,
        "uturns": uturns,
        "zigzag_clusters": clusters,
    }


def clean_pass(coords: list[list[float]]) -> tuple[list[list[float]], set[int]]:
    """Drop GPS spikes, u-turns, and short alternating zigzags."""
    n = len(coords)
    remove: set[int] = set()

    for i in range(1, n - 1):
        a, b, c = coords[i - 1], coords[i], coords[i + 1]
        ab, bc, ac = hav(a, b), hav(b, c), hav(a, c)
        t = abs(signed_turn(a, b, c))
        waste = ab + bc - ac
        if t >= 150 and ab >= 8 and bc >= 8:
            remove.add(i)
            continue
        if waste >= 32 and ab >= 10 and bc >= 10 and (ab + bc) > ac * 1.5 and t >= 100:
            remove.add(i)
            continue
        # short hairpin noise (staircase between resampled points)
        if t >= 88 and ab < 40 and bc < 40 and waste >= 14:
            remove.add(i)

    i = 1
    while i < n - 2:
        if i in remove or (i + 1) in remove:
            i += 1
            continue
        t1 = signed_turn(coords[i - 1], coords[i], coords[i + 1])
        t2 = signed_turn(coords[i], coords[i + 1], coords[i + 2])
        if abs(t1) >= 75 and abs(t2) >= 75 and t1 * t2 < 0:
            span = hav(coords[i - 1], coords[i + 2])
            zig = (
                hav(coords[i - 1], coords[i])
                + hav(coords[i], coords[i + 1])
                + hav(coords[i + 1], coords[i + 2])
            )
            if zig - span >= 10 and zig <= 140:
                remove.add(i)
                remove.add(i + 1)
                i += 3
                continue
        i += 1

    out = [c for j, c in enumerate(coords) if j not in remove]
    return out, remove


def clean_ring(coords: list[list[float]], max_passes: int = 12) -> tuple[list[list[float]], int]:
    cur = [list(c) for c in coords]
    total = 0
    for _ in range(max_passes):
        cur2, rem = clean_pass(cur)
        if not rem:
            break
        total += len(rem)
        cur = cur2
    # ensure closed ring if already closed (±1m)
    if cur and hav(cur[0], cur[-1]) > 1.0:
        # source was open or became open — leave as-is (ZKM source closes exactly)
        pass
    return cur, total


def resnap_landmarks(coords: list[list[float]], landmarks: dict) -> dict:
    feats = landmarks.get("features") or []
    on_ring: list[tuple[dict, int, float]] = []
    skipped: list[dict] = []

    for f in feats:
        props = dict(f.get("properties") or {})
        geom = f.get("geometry") or {}
        gcoords = geom.get("coordinates") or []
        lid = str(props.get("id") or "")
        # Velo2 tip lives on another track — do not bind to ZKM ring
        if lid.startswith("velo2-") or props.get("category") == "off-ring":
            skipped.append(f)
            continue
        if len(gcoords) < 2:
            skipped.append(f)
            continue
        pin = [float(gcoords[0]), float(gcoords[1])]
        best_i, best_d = 0, 1e18
        for i, c in enumerate(coords):
            d = hav(c, pin)
            if d < best_d:
                best_d, best_i = d, i
        on_ring.append((f, best_i, best_d))

    on_ring.sort(key=lambda x: x[1])
    n = len(on_ring)
    out_feats: list[dict] = []
    for order_cw, (f, idx, dist) in enumerate(on_ring):
        props = dict(f.get("properties") or {})
        props["trackIndex"] = idx
        props["ringIndex"] = idx
        props["snapDist_m"] = int(round(dist))
        props["orderCw"] = order_cw
        props["orderCcw"] = (n - 1 - order_cw) if n else 0
        out_feats.append(
            {
                "type": "Feature",
                "properties": props,
                "geometry": f["geometry"],
            }
        )

    # keep off-ring features after (order untouched)
    for f in skipped:
        out_feats.append(f)

    return {"type": "FeatureCollection", "features": out_feats}


def update_catalog_points(points: int, km: float) -> None:
    if not CATALOG_PATH.exists():
        return
    cat = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    for r in cat.get("routes") or []:
        if r.get("id") == "zkm-ring":
            r["points"] = points
            r["kmListed"] = round(km, 1)
            break
    CATALOG_PATH.write_text(json.dumps(cat, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    gj = json.loads(RING_PATH.read_text(encoding="utf-8"))
    feat = gj["features"][0]
    coords = [list(c) for c in feat["geometry"]["coordinates"]]
    before = metrics(coords)
    print("BEFORE", before)

    cleaned, removed = clean_ring(coords)
    after = metrics(cleaned)
    print("AFTER ", after, f"removed_points={removed}")

    lm = json.loads(LANDMARKS_PATH.read_text(encoding="utf-8"))
    lm2 = resnap_landmarks(cleaned, lm)
    ring_lms = [
        f
        for f in lm2["features"]
        if not str((f.get("properties") or {}).get("id") or "").startswith("velo2-")
    ]
    stale = 0
    far = []
    for f in ring_lms:
        p = f["properties"]
        g = f["geometry"]["coordinates"]
        ti = int(p["trackIndex"])
        d_at = hav(cleaned[ti], g)
        if d_at > 5 and abs(d_at - float(p.get("snapDist_m") or 0)) > 2:
            stale += 1
        if float(p.get("snapDist_m") or 0) > 150:
            far.append((p.get("name"), p.get("snapDist_m")))
    print(f"landmarks on ring: {len(ring_lms)}; index mismatch: {stale}; far>150m: {far}")

    # Timiryazev sanity
    timi = next(f for f in ring_lms if f["properties"].get("id") == "park-timiryazev")
    ti = int(timi["properties"]["trackIndex"])
    local_turns = []
    for i in range(max(1, ti - 6), min(len(cleaned) - 1, ti + 6)):
        local_turns.append(round(signed_turn(cleaned[i - 1], cleaned[i], cleaned[i + 1]), 1))
    print(f"Timiryazev idx={ti} snap={timi['properties']['snapDist_m']}m local_turns={local_turns}")

    if args.dry_run:
        print("dry-run: not writing")
        return

    props = dict(feat.get("properties") or {})
    props["points"] = len(cleaned)
    props["cleaned"] = True
    props["cleanRemoved"] = removed
    feat["properties"] = props
    feat["geometry"]["coordinates"] = cleaned
    RING_PATH.write_text(json.dumps(gj, ensure_ascii=False), encoding="utf-8")
    LANDMARKS_PATH.write_text(json.dumps(lm2, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    update_catalog_points(len(cleaned), after["km"])
    print(f"wrote {RING_PATH}")
    print(f"wrote {LANDMARKS_PATH}")
    print(f"updated {CATALOG_PATH} zkm-ring points/km")


if __name__ == "__main__":
    main()

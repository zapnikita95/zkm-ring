#!/usr/bin/env python3
"""Reroute ZKM ring through Timiryazev along OSM «Верхняя аллея» (Yandex «ЗЕЛЁНОЕ КОЛЬЦО»).

Replaces the mistaken Listvennichnaya Alley stretch.
Then: optional spike clean + landmarks resnap (via clean_ring_geometry helpers).
"""
from __future__ import annotations

import json
import math
import ssl
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "public" / "data"
RING_PATH = DATA / "ring.geojson"
LANDMARKS_PATH = DATA / "landmarks.json"
CATALOG_PATH = DATA / "routes-catalog.json"

# Import cleaner helpers
import sys

sys.path.insert(0, str(ROOT / "scripts"))
from clean_ring_geometry import (  # noqa: E402
    clean_ring,
    hav,
    metrics,
    resnap_landmarks,
    update_catalog_points,
)


def fetch_verkhnyaya() -> list[list[float]]:
    ctx = ssl._create_unverified_context()
    query = """[out:json][timeout:60];
way["name"="Верхняя аллея"](55.825,37.540,55.845,37.590);
out geom;
"""
    req = urllib.request.Request(
        "https://overpass-api.de/api/interpreter",
        data=query.encode(),
        headers={"User-Agent": "zkm-ring-timiryazev-fix/1.0"},
    )
    with urllib.request.urlopen(req, context=ctx, timeout=60) as r:
        osm = json.loads(r.read())
    ways: list[list[list[float]]] = []
    for e in osm.get("elements") or []:
        geom = [[g["lon"], g["lat"]] for g in e.get("geometry") or []]
        if len(geom) >= 2:
            ways.append(geom)
    if not ways:
        raise RuntimeError("OSM: Верхняя аллея not found")

    # stitch W→E
    unused = list(range(len(ways)))
    best_i, best_rev, best_lon = 0, False, 999.0
    for i, g in enumerate(ways):
        for rev in (False, True):
            gg = g[::-1] if rev else g
            if gg[0][0] < best_lon:
                best_lon = gg[0][0]
                best_i, best_rev = i, rev
    chain = (ways[best_i][::-1] if best_rev else ways[best_i])[:]
    unused.remove(best_i)
    while unused:
        end = chain[-1]
        found = None
        bestd = 1e9
        for i in list(unused):
            for rev in (False, True):
                gg = ways[i][::-1] if rev else ways[i]
                d = hav(end, gg[0])
                if d < bestd:
                    bestd = d
                    found = (i, gg, d)
        if not found or found[2] > 80:
            break
        i, gg, d = found
        unused.remove(i)
        chain.extend(gg[1:] if hav(gg[0], end) < 5 else gg)
    if chain[0][0] > chain[-1][0]:
        chain = chain[::-1]
    return chain


def resample(line: list[list[float]], step_m: float = 32.0) -> list[list[float]]:
    if len(line) < 2:
        return [list(p) for p in line]
    out = [list(line[0])]
    acc = 0.0
    for i in range(1, len(line)):
        a, b = out[-1], line[i]
        # walk from last out toward b using original segments
        a, b = line[i - 1], line[i]
        seg = hav(a, b)
        cur = list(a)
        while acc + seg >= step_m:
            t = (step_m - acc) / seg if seg else 0
            cur = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]
            out.append(cur)
            a = cur
            seg = hav(a, b)
            acc = 0.0
        acc += seg
    if hav(out[-1], line[-1]) > 5:
        out.append(list(line[-1]))
    return out


def linspace(a: list[float], b: list[float], step_m: float = 32.0) -> list[list[float]]:
    d = hav(a, b)
    if d <= step_m:
        return [list(a), list(b)] if hav(a, b) > 1 else [list(b)]
    n = max(1, int(math.ceil(d / step_m)))
    return [
        [a[0] + (k / n) * (b[0] - a[0]), a[1] + (k / n) * (b[1] - a[1])]
        for k in range(n + 1)
    ]


def splice_verkhnyaya(coords: list[list[float]], verkh: list[list[float]]) -> tuple[list[list[float]], dict]:
    v0, v1 = verkh[0], verkh[-1]
    i0 = min(range(len(coords)), key=lambda i: hav(coords[i], v0))
    i1 = min(range(len(coords)), key=lambda i: hav(coords[i], v1))
    if i0 > i1:
        raise RuntimeError(f"splice orientation broken i0={i0} i1={i1}")

    s, e = i0, i1
    while s > 1 and min(hav(coords[s - 1], p) for p in verkh) < 80:
        s -= 1
    while e < len(coords) - 2 and min(hav(coords[e + 1], p) for p in verkh) < 80:
        e += 1

    mid = resample(verkh, 32)
    path: list[list[float]] = []
    # from ring[s] onto Verkh
    path.extend(linspace(coords[s], mid[0], 32))
    for p in mid:
        if hav(path[-1], p) > 8:
            path.append(p)
    # back to ring[e]
    for p in linspace(path[-1], coords[e], 32)[1:]:
        path.append(p)

    new_coords = coords[:s] + path + coords[e + 1 :]
    meta = {
        "splice_s": s,
        "splice_e": e,
        "removed": e - s + 1,
        "inserted": len(path),
        "verkh_m": round(sum(hav(verkh[i], verkh[i + 1]) for i in range(len(verkh) - 1))),
    }
    return new_coords, meta


def corridor_stats(coords: list[list[float]], verkh: list[list[float]]) -> dict:
    on_v = on_l = 0
    for c in coords:
        if not (37.555 <= c[0] <= 37.570 and 55.831 <= c[1] <= 55.836):
            continue
        dv = min(hav(c, p) for p in verkh)
        if dv < 60:
            on_v += 1
        elif c[1] >= 55.8338:
            on_l += 1
    return {"on_verkh": on_v, "on_listvennichnaya": on_l}


def main() -> None:
    print("Fetching OSM Верхняя аллея…")
    verkh = fetch_verkhnyaya()
    print(f"  stitched {len(verkh)} pts, {sum(hav(verkh[i], verkh[i+1]) for i in range(len(verkh)-1)):.0f}m")

    gj = json.loads(RING_PATH.read_text(encoding="utf-8"))
    feat = gj["features"][0]
    coords = [list(c) for c in feat["geometry"]["coordinates"]]
    print("BEFORE", metrics(coords), corridor_stats(coords, verkh))

    coords2, meta = splice_verkhnyaya(coords, verkh)
    print("splice", meta)
    print("AFTER splice", metrics(coords2), corridor_stats(coords2, verkh))

    coords3, removed = clean_ring(coords2)
    print("AFTER clean", metrics(coords3), f"clean_removed={removed}", corridor_stats(coords3, verkh))

    if corridor_stats(coords3, verkh)["on_listvennichnaya"] > 0:
        raise SystemExit("FAIL: still on Listvennichnaya in corridor")

    props = dict(feat.get("properties") or {})
    props["points"] = len(coords3)
    props["cleaned"] = True
    props["timiryazevVerkhnyaya"] = True
    props["timiryazevMeta"] = meta
    feat["properties"] = props
    feat["geometry"]["coordinates"] = coords3
    RING_PATH.write_text(json.dumps(gj, ensure_ascii=False), encoding="utf-8")

    lm = json.loads(LANDMARKS_PATH.read_text(encoding="utf-8"))
    lm2 = resnap_landmarks(coords3, lm)
    LANDMARKS_PATH.write_text(json.dumps(lm2, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    update_catalog_points(len(coords3), metrics(coords3)["km"])

    # Timiryazev landmark sanity
    timi = next(
        f
        for f in lm2["features"]
        if f["properties"].get("id") == "park-timiryazev"
    )
    print(
        "Timiryazev landmark",
        {
            k: timi["properties"].get(k)
            for k in ("trackIndex", "ringIndex", "snapDist_m")
        },
    )
    print(f"wrote {RING_PATH}")
    print("OK")


if __name__ == "__main__":
    main()

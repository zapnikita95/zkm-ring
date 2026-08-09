#!/usr/bin/env python3
"""Rebuild Koptevo dashed alt from real pre-cut ring geometry (street-level).

Source: git rev before officialGreenRing2026 chopped the northern tip into chords.
Ends snap exactly onto current official green line.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "public" / "data"
RING_PATH = DATA / "ring.geojson"
ALT_PATH = DATA / "alternatives" / "koptevo-hook.geojson"
# Full Koptevo tip still on main (max lat ~55.846), street-following, no chords
SOURCE_REV = "4bc87de"

sys.path.insert(0, str(ROOT / "scripts"))
from clean_ring_geometry import hav  # noqa: E402


def nearest(coords: list[list[float]], pin: list[float], lo: int = 0, hi: int | None = None) -> int:
    hi = len(coords) if hi is None else hi
    return min(range(lo, hi), key=lambda i: hav(coords[i], pin))


def path_km(pts: list[list[float]]) -> float:
    return sum(hav(pts[i], pts[i + 1]) for i in range(len(pts) - 1)) / 1000


def main() -> None:
    src = json.loads(subprocess.check_output(["git", "show", f"{SOURCE_REV}:public/data/ring.geojson"]))
    cur = json.loads(RING_PATH.read_text(encoding="utf-8"))
    oldc = [list(c) for c in src["features"][0]["geometry"]["coordinates"]]
    newc = [list(c) for c in cur["features"][0]["geometry"]["coordinates"]]

    # Koptevo tip on source ring
    tip_i = max(
        (i for i, p in enumerate(oldc) if 37.50 <= p[0] <= 37.53),
        key=lambda i: oldc[i][1],
    )
    if oldc[tip_i][1] < 55.843:
        raise SystemExit(f"FAIL: source tip too south ({oldc[tip_i][1]}) — wrong rev?")

    # Walk outward from tip until we hit the current official corridor (close to newc)
    def dist_new(p: list[float]) -> float:
        return min(hav(p, c) for c in newc)

    # West: decreasing index from tip until close to official & south enough
    w = tip_i
    while w > 0 and not (dist_new(oldc[w]) < 40 and oldc[w][1] < 55.822 and oldc[w][0] < 37.495):
        w -= 1
        if tip_i - w > 400:
            break
    # East: increasing index until close to official near Pasechnaya
    e = tip_i
    while e < len(oldc) - 1 and not (
        dist_new(oldc[e]) < 40 and oldc[e][1] < 55.828 and oldc[e][0] > 37.525
    ):
        e += 1
        if e - tip_i > 400:
            break

    if e <= w + 20:
        raise SystemExit(f"FAIL: bad fork window w={w} e={e} tip={tip_i}")

    body = [list(p) for p in oldc[w : e + 1]]
    # Snap ends onto current official line (true junctions)
    i0 = nearest(newc, body[0])
    i1 = nearest(newc, body[-1])
    if i0 > i1:
        i0, i1 = i1, i0
        body = list(reversed(body))

    hook = [list(newc[i0])]
    for p in body:
        if hav(hook[-1], p) > 8:
            hook.append(list(p))
    if hav(hook[-1], newc[i1]) > 5:
        hook.append(list(newc[i1]))
    else:
        hook[-1] = list(newc[i1])
    hook[0] = list(newc[i0])
    hook[-1] = list(newc[i1])

    # Quality: no flight chords, tip retained
    jumps = [hav(hook[i], hook[i + 1]) for i in range(len(hook) - 1)]
    max_jump = max(jumps) if jumps else 0
    max_lat = max(c[1] for c in hook)
    if max_lat < 55.843:
        raise SystemExit(f"FAIL: lost Koptevo tip (max lat {max_lat})")
    if max_jump > 120:
        raise SystemExit(f"FAIL: chord in hook max_seg={max_jump:.0f}m")
    d0 = hav(hook[0], newc[nearest(newc, hook[0])])
    d1 = hav(hook[-1], newc[nearest(newc, hook[-1])])
    if d0 > 1 or d1 > 1:
        raise SystemExit(f"FAIL: ends not on main ({d0:.1f}/{d1:.1f})")

    km = round(path_km(hook), 2)
    alt = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "id": "koptevo-hook",
                    "title": "Крюк к МЦК Коптево",
                    "description": (
                        "Реальный старый заезд через парк к МЦК Коптево по треку кольца: "
                        "от развилки у Стрешнево до слияния у Пасечной. Не входит в официальный маршрут."
                    ),
                    "kind": "alternative",
                    "optional": True,
                    "km": km,
                    "sourceRev": SOURCE_REV,
                    "forkWest": {"lat": hook[0][1], "lon": hook[0][0]},
                    "forkEast": {"lat": hook[-1][1], "lon": hook[-1][0]},
                },
                "geometry": {"type": "LineString", "coordinates": hook},
            }
        ],
    }
    ALT_PATH.parent.mkdir(parents=True, exist_ok=True)
    ALT_PATH.write_text(json.dumps(alt, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {ALT_PATH}")
    print(f"source={SOURCE_REV} tip_i={tip_i} window={w}-{e}")
    print(f"hook pts={len(hook)} km={km} max_seg={max_jump:.1f}m max_lat={max_lat:.6f}")
    print(f"fork W {hook[0][1]:.6f},{hook[0][0]:.6f} idx={i0}")
    print(f"fork E {hook[-1][1]:.6f},{hook[-1][0]:.6f} idx={i1}")
    print(f"segs>80m={sum(1 for j in jumps if j > 80)}")
    print("OK")


if __name__ == "__main__":
    main()

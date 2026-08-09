#!/usr/bin/env python3
"""Rebuild Koptevo dashed alt so both ends sit on the official green line.

Uses the pre-red-line northern park segment (git 81b0682 ring) between the two
forks: Streshnevo side ↔ Pasechnaya / Timiryazev park rejoin.
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
OLD_REV = "81b0682"

sys.path.insert(0, str(ROOT / "scripts"))
from clean_ring_geometry import hav  # noqa: E402


def resample(pts: list[list[float]], step_m: float = 28.0) -> list[list[float]]:
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


def nearest(coords: list[list[float]], pin: list[float]) -> int:
    return min(range(len(coords)), key=lambda i: hav(coords[i], pin))


def path_km(pts: list[list[float]]) -> float:
    return sum(hav(pts[i], pts[i + 1]) for i in range(len(pts) - 1)) / 1000


def main() -> None:
    old = json.loads(subprocess.check_output(["git", "show", f"{OLD_REV}:public/data/ring.geojson"]))
    new = json.loads(RING_PATH.read_text(encoding="utf-8"))
    oldc = [list(c) for c in old["features"][0]["geometry"]["coordinates"]]
    newc = [list(c) for c in new["features"][0]["geometry"]["coordinates"]]

    west_pin = [37.485154, 55.817311]
    east_pin = [37.529427, 55.825607]
    ow, oe = nearest(oldc, west_pin), nearest(oldc, east_pin)
    lo, hi = sorted((ow, oe))
    seg = oldc[lo : hi + 1]

    def dist_to_new(p: list[float]) -> float:
        return min(hav(p, c) for c in newc)

    far = [(i, dist_to_new(p)) for i, p in enumerate(seg)]
    close = [i for i, d in far if d < 45]
    runs: list[list[int]] = []
    run: list[int] | None = None
    for i, d in far:
        if d >= 50:
            run = [i, i] if run is None else [run[0], i]
        elif run:
            runs.append(run)
            run = None
    if run:
        runs.append(run)
    if not runs:
        raise SystemExit("FAIL: no northern detour found in old ring")
    a, b = max(runs, key=lambda r: r[1] - r[0])
    before = [i for i in close if i < a]
    after = [i for i in close if i > b]
    start = before[-1] if before else a
    end = after[0] if after else b
    body = seg[start : end + 1]

    i0 = nearest(newc, body[0])
    i1 = nearest(newc, body[-1])
    if i0 > i1:
        i0, i1 = i1, i0
        body = list(reversed(body))

    hook = [list(newc[i0])]
    for p in body:
        if hav(hook[-1], p) > 10:
            hook.append(list(p))
    hook.append(list(newc[i1]))
    hook = resample(hook, 28)
    # Force exact forks on official line
    hook[0] = list(newc[i0])
    hook[-1] = list(newc[i1])

    d0 = hav(hook[0], newc[nearest(newc, hook[0])])
    d1 = hav(hook[-1], newc[nearest(newc, hook[-1])])
    if d0 > 1 or d1 > 1:
        raise SystemExit(f"FAIL: ends not on main ({d0:.1f}m / {d1:.1f}m)")
    if hav(hook[0], hook[-1]) < 500:
        raise SystemExit("FAIL: forks too close")

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
                        "Альтернатива через парк к МЦК Коптево: от развилки у Стрешнево "
                        "до слияния с официальным кольцом у Пасечной. Не входит в официальный маршрут."
                    ),
                    "kind": "alternative",
                    "optional": True,
                    "km": km,
                    "forkWest": {"lat": hook[0][1], "lon": hook[0][0]},
                    "forkEast": {"lat": hook[-1][1], "lon": hook[-1][0]},
                },
                "geometry": {"type": "LineString", "coordinates": hook},
            }
        ],
    }
    ALT_PATH.parent.mkdir(parents=True, exist_ok=True)
    ALT_PATH.write_text(json.dumps(alt, ensure_ascii=False), encoding="utf-8")

    main_km = round(path_km(newc[i0 : i1 + 1]), 2)
    print(f"wrote {ALT_PATH}")
    print(f"hook pts={len(hook)} km={km}")
    print(f"fork W {hook[0][1]:.6f},{hook[0][0]:.6f} (main idx {i0})")
    print(f"fork E {hook[-1][1]:.6f},{hook[-1][0]:.6f} (main idx {i1})")
    print(f"official shortcut between forks ≈ {main_km} km")
    print(f"max lat on hook {max(c[1] for c in hook):.6f}")
    print("OK")


if __name__ == "__main__":
    main()

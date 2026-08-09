#!/usr/bin/env python3
"""Repair short official-ring stretches that cut through blocks.

Pulls only local off-trail gaps onto RuTrail (e.g. Kasatkina), then densifies
remaining edges to ≤120 m. Keeps ring length ~129–131 km (not full RuTrail).

Usage:
  python3 scripts/repair_official_local_chords.py
  python3 scripts/repair_official_local_chords.py --dry-run
"""
from __future__ import annotations

import argparse
import json
import math
import shutil
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "public" / "data"
RING = DATA / "ring.geojson"
REF = DATA / "ring-rutrail.geojson"


def hav(a: list[float], b: list[float]) -> float:
    r = 6371000.0
    lat1, lon1 = math.radians(a[1]), math.radians(a[0])
    lat2, lon2 = math.radians(b[1]), math.radians(b[0])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))


def path_len(c: list[list[float]]) -> float:
    return sum(hav(c[i], c[i + 1]) for i in range(len(c) - 1)) if len(c) > 1 else 0.0


def nearest(rt: list[list[float]], p: list[float]) -> tuple[int, float]:
    best, bd = 0, 1e18
    for i, q in enumerate(rt):
        d = hav(p, q)
        if d < bd:
            bd, best = d, i
    return best, bd


def shorter_arc(rt: list[list[float]], i0: int, i1: int) -> list[list[float]]:
    n = len(rt)
    if i0 == i1:
        return [rt[i0]]
    cw: list[list[float]] = []
    i = i0
    while True:
        cw.append(rt[i])
        if i == i1:
            break
        i = (i + 1) % n
        if len(cw) > n + 2:
            break
    ccw: list[list[float]] = []
    i = i0
    while True:
        ccw.append(rt[i])
        if i == i1:
            break
        i = (i - 1) % n
        if len(ccw) > n + 2:
            break
    return cw if path_len(cw) <= path_len(ccw) else ccw


def densify_edges(coords: list[list[float]], max_edge: float = 120.0) -> list[list[float]]:
    out = [coords[0]]
    for i in range(1, len(coords)):
        a, b = coords[i - 1], coords[i]
        d = hav(a, b)
        if d > max_edge:
            n = max(2, math.ceil(d / max_edge))
            for k in range(1, n):
                t = k / n
                out.append([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
        out.append(b)
    return out


def repair_local(off: list[list[float]], rt: list[list[float]], on_m: float = 45.0):
    if hav(rt[0], rt[-1]) < 5:
        rt = rt[:-1]
    d = [nearest(rt, p)[1] for p in off]
    out: list[list[float]] = []
    i = 0
    n = len(off)
    replaced: list[dict] = []
    while i < n:
        if d[i] > on_m:
            out.append(off[i])
            i += 1
            continue
        j = i + 1
        while j < n and d[j] <= on_m:
            j += 1
        if j >= n:
            out.extend(off[i:])
            break
        k = j
        while k < n and d[k] > on_m:
            k += 1
        if k >= n:
            out.extend(off[i:])
            break
        a_idx, b_idx = j - 1, k
        stretch = off[a_idx : b_idx + 1]
        olen = path_len(stretch)
        max_edge = max(hav(stretch[t], stretch[t + 1]) for t in range(len(stretch) - 1))
        if olen > 1200:
            out.extend(off[i:b_idx])
            i = b_idx
            continue
        ia, da = nearest(rt, off[a_idx])
        ib, db = nearest(rt, off[b_idx])
        if da > 70 or db > 70 or ia == ib:
            out.extend(off[i:b_idx])
            i = b_idx
            continue
        arc = shorter_arc(rt, ia, ib)
        alen = path_len(arc)
        mid = arc[len(arc) // 2]
        chord_mid = [
            (off[a_idx][0] + off[b_idx][0]) / 2,
            (off[a_idx][1] + off[b_idx][1]) / 2,
        ]
        lateral = hav(mid, chord_mid)
        ratio = alen / olen if olen else 99.0
        ok = (
            alen <= 1500
            and olen >= 150
            and len(arc) >= 4
            and lateral >= 40
            and (
                (1.05 <= ratio <= 4.0 and max_edge >= 140)
                or (max_edge >= 160 and lateral >= 80 and 0.65 <= ratio <= 4.0)
            )
        )
        if not ok:
            out.extend(off[i:b_idx])
            i = b_idx
            continue
        out.extend(off[i : a_idx + 1])
        for p in arc[1:-1]:
            if hav(out[-1], p) >= 12:
                out.append(list(p))
        if hav(out[-1], off[b_idx]) >= 1:
            out.append(list(off[b_idx]))
        replaced.append(
            {
                "a": [round(off[a_idx][1], 6), round(off[a_idx][0], 6)],
                "b": [round(off[b_idx][1], 6), round(off[b_idx][0], 6)],
                "olen": round(olen),
                "alen": round(alen),
                "lat": round(lateral),
                "max_edge": round(max_edge),
            }
        )
        i = b_idx + 1
    return out, replaced


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    ring = json.loads(RING.read_text())
    off = ring["features"][0]["geometry"]["coordinates"]
    if ring["features"][0].get("properties", {}).get("localChordRepair"):
        print("Already repaired (localChordRepair=true). Restore bak + re-run if needed.")
        return 0
    rt = json.loads(REF.read_text())["features"][0]["geometry"]["coordinates"]
    before = path_len(off)
    repaired, reps = repair_local(off, rt)
    dense = densify_edges(repaired, 120.0)
    if hav(off[0], off[-1]) < 5 and hav(dense[0], dense[-1]) >= 5:
        dense.append(list(dense[0]))
    after = path_len(dense)
    mx = max(hav(dense[i], dense[i + 1]) for i in range(len(dense) - 1))
    print(
        {
            "reps": reps,
            "n": len(reps),
            "verts": f"{len(off)}->{len(dense)}",
            "km": f"{before / 1000:.3f}->{after / 1000:.3f}",
            "max_edge": round(mx),
        }
    )
    if args.dry_run:
        return 0
    bak = DATA / f"ring.geojson.bak-pre-local-chord-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    shutil.copy2(RING, bak)
    ring["features"][0]["geometry"]["coordinates"] = dense
    props = ring["features"][0].setdefault("properties", {})
    props["localChordRepair"] = True
    props["localChordRepairs"] = reps
    props["lengthKmApprox"] = round(after / 1000, 2)
    RING.write_text(json.dumps(ring, ensure_ascii=False, separators=(",", ":")))
    print("wrote", RING, "backup", bak.name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

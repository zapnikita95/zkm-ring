#!/usr/bin/env python3
"""Bake a real Carto Voyager map (same stack as service previews) for Instagram 4:5.

Usage:
  python3 bake_instagram_poi_map.py park-krylatskoe-bridge
  → assets/map-{id}.png  (1080×1350, uniform scale only — never stretch)
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import contextily as cx  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import Circle, Polygon, Wedge  # noqa: E402
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "public" / "data"
ASSETS = Path(__file__).resolve().parent / "assets"
W, H = 1080, 1350
EARTH = 6378137.0


def lonlat_to_merc(lon: float, lat: float) -> tuple[float, float]:
    x = math.radians(lon) * EARTH
    y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * EARTH
    return x, y


def load_ring() -> list[list[float]]:
    g = json.loads((PUBLIC / "ring.geojson").read_text(encoding="utf-8"))
    for f in g.get("features") or []:
        geom = f.get("geometry") or {}
        if geom.get("type") == "LineString":
            return geom["coordinates"]
    raise SystemExit("no ring LineString")


def load_landmark(lid: str) -> dict:
    data = json.loads((PUBLIC / "landmarks.json").read_text(encoding="utf-8"))
    for f in data.get("features") or []:
        if f.get("properties", {}).get("id") == lid:
            return f
    raise SystemExit(f"landmark not found: {lid}")


def downsample(coords: list[list[float]], max_n: int = 900) -> list[list[float]]:
    if len(coords) <= max_n:
        return coords
    step = max(1, len(coords) // max_n)
    out = coords[::step]
    if out[-1] != coords[-1]:
        out.append(coords[-1])
    return out


def bridge_pin_artist(ax, mx: float, my: float) -> None:
    """Teardrop pin + mini arch (Живописный cue). Size in mercator metres."""
    s = 140.0  # scale
    ax.add_patch(Circle((mx + 0.08 * s, my - 0.08 * s), 0.55 * s, facecolor="#00000044", edgecolor="none", zorder=6))
    body = [
        (mx, my + 1.05 * s),
        (mx - 0.55 * s, my + 0.05 * s),
        (mx - 0.55 * s, my - 0.55 * s),
        (mx - 0.22 * s, my - 1.05 * s),
        (mx + 0.22 * s, my - 1.05 * s),
        (mx + 0.55 * s, my - 0.55 * s),
        (mx + 0.55 * s, my + 0.05 * s),
    ]
    ax.add_patch(
        Polygon(body, closed=True, facecolor="#e67e22", edgecolor="#ffffff", linewidth=2.6, zorder=7)
    )
    ax.add_patch(
        Circle((mx, my - 0.35 * s), 0.32 * s, facecolor="#1b7a3d", edgecolor="#ffffff", linewidth=2.2, zorder=8)
    )
    ax.add_patch(
        Wedge((mx, my - 0.28 * s), 0.22 * s, 15, 165, width=0.07 * s, facecolor="#f0f2f0", edgecolor="none", zorder=9)
    )


def bake(landmark_id: str) -> Path:
    feat = load_landmark(landmark_id)
    lon, lat = feat["geometry"]["coordinates"]
    name = feat["properties"].get("name") or landmark_id
    ring = downsample(load_ring())

    mx, my = lonlat_to_merc(lon, lat)
    # Portrait window in mercator metres (equal x/y units → no geo stretch)
    half_x = 4800.0
    half_y = half_x * (H / W)  # match 4:5 so axes fill without squeeze
    x0, x1 = mx - half_x, mx + half_x
    y0, y1 = my - half_y, my + half_y

    merc_ring = [lonlat_to_merc(c[0], c[1]) for c in ring]
    xs = [p[0] for p in merc_ring]
    ys = [p[1] for p in merc_ring]

    data_aspect = (y1 - y0) / (x1 - x0)  # == H/W
    fig_w = 7.2
    fig_h = fig_w * data_aspect
    fig, ax = plt.subplots(figsize=(fig_w, fig_h), dpi=160)
    ax.plot(xs, ys, color="#86efac", lw=10, solid_capstyle="round", zorder=2, alpha=0.35)
    ax.plot(xs, ys, color="#1b7a3d", lw=4.6, solid_capstyle="round", zorder=3, alpha=0.96)

    bridge_pin_artist(ax, mx, my)
    label = name if len(name) <= 22 else "Живописный мост"
    ax.annotate(
        label,
        xy=(mx, my + 30),
        xytext=(-210, 130),
        textcoords="offset points",
        fontsize=13,
        fontweight="700",
        color="#121412",
        arrowprops=dict(arrowstyle="-", color="#1b7a3d", lw=1.6),
        bbox=dict(boxstyle="round,pad=0.45", fc="#f0f2f0f5", ec="#1b7a3d", lw=1.5),
        zorder=10,
        clip_on=False,
    )

    ax.set_xlim(x0, x1)
    ax.set_ylim(y0, y1)
    # adjustable='box' + figsize matching data aspect → 1 data-unit / px equal, no stretch
    ax.set_aspect("equal", adjustable="box")
    ax.axis("off")
    fig.subplots_adjust(0, 0, 1, 1)

    try:
        cx.add_basemap(
            ax,
            source=cx.providers.CartoDB.Voyager,
            crs="EPSG:3857",
            attribution=False,
            zoom="auto",
        )
    except Exception as e:
        print("basemap fail:", e)
        ax.set_facecolor("#e8eee8")
        fig.patch.set_facecolor("#e8eee8")

    ASSETS.mkdir(parents=True, exist_ok=True)
    raw = ASSETS / f"map-{landmark_id}-raw.png"
    out = ASSETS / f"map-{landmark_id}.png"
    fig.savefig(raw, dpi=160, facecolor="white", pad_inches=0)
    plt.close(fig)

    im = Image.open(raw).convert("RGB")
    # Uniform cover only — assert aspect protection
    fitted = ImageOps.fit(im, (W, H), method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))
    assert fitted.size == (W, H)
    # Sanity: source must not have been force-stretched into target before fit
    src_ar = im.size[0] / im.size[1]
    tgt_ar = W / H
    if abs(src_ar - tgt_ar) > 0.08:
        print(f"note: raw aspect {src_ar:.3f} vs target {tgt_ar:.3f} — cover-crop will trim, not stretch")
    fitted.save(out, "PNG", optimize=True)
    raw.unlink(missing_ok=True)
    print("wrote", out, out.stat().st_size, "landmark", landmark_id, f"@ {lat},{lon}")
    return out


if __name__ == "__main__":
    lid = sys.argv[1] if len(sys.argv) > 1 else "park-krylatskoe-bridge"
    bake(lid)

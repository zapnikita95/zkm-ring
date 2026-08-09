#!/usr/bin/env python3
"""Отрисовать PNG-превью треков с подложкой карты (Carto Voyager).

Пишет:
  public/data/previews/{routeId}.png
  public/data/welcome-ring.png  (копия zkm-ring)
  bot/data/… (зеркало)

Запуск:
  python3 scripts/bake_route_previews.py
  python3 scripts/bake_route_previews.py zkm-ring   # только кольцо
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import contextily as cx  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public" / "data"
BOT = ROOT / "bot" / "data"
OUT = PUBLIC / "previews"
OUT.mkdir(parents=True, exist_ok=True)

# Web Mercator
EARTH = 6378137.0


def lonlat_to_merc(lon: float, lat: float) -> tuple[float, float]:
    x = math.radians(lon) * EARTH
    y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * EARTH
    return x, y


def load_line(path: Path) -> list[list[float]]:
    g = json.loads(path.read_text(encoding="utf-8"))
    feats = g.get("features") or []
    for f in feats:
        geom = f.get("geometry") or {}
        if geom.get("type") == "LineString":
            return geom["coordinates"]
        if geom.get("type") == "MultiLineString":
            return [p for line in geom["coordinates"] for p in line]
    raise SystemExit(f"no LineString in {path}")


def along_m(coords: list[list[float]]) -> list[float]:
    out = [0.0]
    for i in range(1, len(coords)):
        lon1, lat1 = coords[i - 1]
        lon2, lat2 = coords[i]
        p1, p2 = math.radians(lat1), math.radians(lat2)
        dp = p2 - p1
        dl = math.radians(lon2 - lon1)
        a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
        out.append(out[-1] + 2 * 6371000 * math.asin(math.sqrt(a)))
    return out


def draw(
    coords: list[list[float]],
    title: str,
    out: Path,
    *,
    split_m: float | None = None,
    split_label: str | None = None,
    dashed: list[list[float]] | None = None,
    mck: list[tuple[float, float]] | None = None,
    mcd: list[tuple[float, float, str]] | None = None,
) -> None:
    # downsample very long tracks for drawing speed
    if len(coords) > 2500:
        step = max(1, len(coords) // 1800)
        last = coords[-1]
        coords = coords[::step]
        if coords[-1] != last:
            coords.append(last)

    merc = [lonlat_to_merc(c[0], c[1]) for c in coords]
    xs = [p[0] for p in merc]
    ys = [p[1] for p in merc]

    fig, ax = plt.subplots(figsize=(7.2, 5.0), dpi=150)
    # Без маркеров старта/финиша на обзорной карте — путают (особенно красная точка на кольце).
    if split_m is not None and len(coords) >= 2:
        cum = along_m(coords)
        cut = next((i for i, d in enumerate(cum) if d >= split_m), len(coords) - 1)
        cut = max(1, min(cut, len(coords) - 1))
        ax.plot(
            xs[: cut + 1],
            ys[: cut + 1],
            color="#1b7f3a",
            lw=3.2,
            solid_capstyle="round",
            zorder=3,
            label="благоустройство",
        )
        ax.plot(
            xs[cut:],
            ys[cut:],
            color="#8aa68f",
            lw=2.2,
            solid_capstyle="round",
            zorder=2,
            label="дальше",
        )
        mx, my = merc[cut]
        ax.scatter([mx], [my], s=90, c="#f59e0b", edgecolors="#fff", linewidths=1.5, zorder=5)
        if split_label:
            ax.annotate(
                split_label,
                xy=(mx, my),
                xytext=(12, 14),
                textcoords="offset points",
                fontsize=8.5,
                fontweight="600",
                color="#7a4a00",
                bbox=dict(boxstyle="round,pad=0.25", fc="#fff8e7", ec="#f59e0b", lw=0.8),
                zorder=6,
            )
    else:
        ax.plot(xs, ys, color="#1b7f3a", lw=2.8, solid_capstyle="round", zorder=3)

    if dashed and len(dashed) >= 2:
        dcoords = dashed
        if len(dcoords) > 800:
            step = max(1, len(dcoords) // 600)
            last = dcoords[-1]
            dcoords = dcoords[::step]
            if dcoords[-1] != last:
                dcoords.append(last)
        dm = [lonlat_to_merc(c[0], c[1]) for c in dcoords]
        ax.plot(
            [p[0] for p in dm],
            [p[1] for p in dm],
            color="#c4782a",
            lw=2.0,
            linestyle=(0, (5, 4)),
            solid_capstyle="round",
            zorder=4,
            alpha=0.92,
        )

    # МЦК / МЦД — мелкие точки, не перетягивают внимание
    if mck:
        mm = [lonlat_to_merc(lon, lat) for lat, lon in mck]
        ax.scatter(
            [p[0] for p in mm],
            [p[1] for p in mm],
            s=7,
            c="#de64a1",
            edgecolors="none",
            alpha=0.45,
            zorder=5,
        )
    if mcd:
        for lat, lon, color in mcd:
            x, y = lonlat_to_merc(lon, lat)
            ax.scatter([x], [y], s=5.5, c=color or "#40B280", edgecolors="none", alpha=0.4, zorder=5)

    ax.set_aspect("equal")
    pad = max((max(xs) - min(xs)), (max(ys) - min(ys))) * 0.08 + 400
    ax.set_xlim(min(xs) - pad, max(xs) + pad)
    ax.set_ylim(min(ys) - pad, max(ys) + pad)
    ax.axis("off")

    try:
        cx.add_basemap(
            ax,
            source=cx.providers.CartoDB.Voyager,
            crs="EPSG:3857",
            attribution=False,
            zoom="auto",
        )
    except Exception as e:
        print("basemap fail, fallback dark:", e)
        ax.set_facecolor("#e8eee8")
        fig.patch.set_facecolor("#e8eee8")

    fig.text(0.5, 0.02, title, ha="center", color="#222", fontsize=11, fontweight="600")
    fig.tight_layout(rect=(0, 0.05, 1, 1))
    fig.savefig(out, bbox_inches="tight", facecolor="white", pad_inches=0.08)
    plt.close(fig)
    print("wrote", out, out.stat().st_size)


def resolve_path(r: dict) -> Path | None:
    rid = r["id"]
    gj = r.get("geojson") or ""
    if gj.startswith("data/"):
        path = PUBLIC / gj[len("data/") :]
    else:
        path = PUBLIC / Path(gj).name
    if path.exists():
        return path
    alt = PUBLIC / "routes" / f"{rid}.geojson"
    if alt.exists():
        return alt
    if rid == "zkm-ring" and (PUBLIC / "ring.geojson").exists():
        return PUBLIC / "ring.geojson"
    return None


def main() -> None:
    only = set(sys.argv[1:]) if len(sys.argv) > 1 else None
    cat = json.loads((PUBLIC / "routes-catalog.json").read_text(encoding="utf-8"))
    routes = cat.get("routes") or []
    # приоритет: кольцо первым
    routes = sorted(routes, key=lambda r: 0 if r.get("id") == "zkm-ring" else 1)
    for r in routes:
        rid = r["id"]
        if only and rid not in only:
            continue
        path = resolve_path(r)
        if path is None:
            print("skip missing", rid)
            continue
        coords = load_line(path)
        title = f"{r.get('title', rid)} · ≈ {r.get('kmListed', '?')} км"
        out = OUT / f"{rid}.png"
        split_kw: dict = {}
        if rid == "velo2-tuchkovo-zvenigorod":
            # Офиц. благоустройство ~21 км (forest-strip); полный трек ~44 км
            split_kw = {
                "split_m": 21_000,
                "split_label": "Конец благоустройства ≈21 км",
            }
            title = f"{r.get('title', rid)} · ≈44 км (благоустр. ~21 км)"
        if rid == "zkm-ring":
            alt_path = PUBLIC / "alternatives" / "koptevo-hook.geojson"
            if alt_path.exists():
                split_kw["dashed"] = load_line(alt_path)
            mck_path = PUBLIC / "mck-stations.json"
            mcd_path = PUBLIC / "mcd-stations.json"

            def near_ring(lat: float, lon: float, max_m: float = 2800) -> bool:
                # грубо: ближайшая точка кольца (шаг 8) — только станции у трассы
                best = 1e18
                for i in range(0, len(coords), 8):
                    lon2, lat2 = coords[i]
                    p1, p2 = math.radians(lat), math.radians(lat2)
                    dp = p2 - p1
                    dl = math.radians(lon2 - lon)
                    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
                    d = 2 * 6371000 * math.asin(math.sqrt(a))
                    if d < best:
                        best = d
                    if best <= max_m:
                        return True
                return best <= max_m

            if mck_path.exists():
                mck_raw = json.loads(mck_path.read_text(encoding="utf-8"))
                split_kw["mck"] = [
                    (float(s["lat"]), float(s["lon"]))
                    for s in (mck_raw.get("stations") or [])
                    if s.get("lat") is not None
                    and s.get("lon") is not None
                    and near_ring(float(s["lat"]), float(s["lon"]), 2200)
                ]
            if mcd_path.exists():
                mcd_raw = json.loads(mcd_path.read_text(encoding="utf-8"))
                split_kw["mcd"] = [
                    (float(s["lat"]), float(s["lon"]), str(s.get("color") or "#40B280"))
                    for s in (mcd_raw.get("stations") or [])
                    if s.get("lat") is not None
                    and s.get("lon") is not None
                    and near_ring(float(s["lat"]), float(s["lon"]), 2500)
                ]
                print(f"  zkm overlay: dashed={bool(split_kw.get('dashed'))} mck={len(split_kw.get('mck') or [])} mcd={len(split_kw.get('mcd') or [])}")
        draw(coords, title, out, **split_kw)
        bot_out = BOT / "previews"
        bot_out.mkdir(parents=True, exist_ok=True)
        (bot_out / f"{rid}.png").write_bytes(out.read_bytes())

    ring_prev = OUT / "zkm-ring.png"
    if ring_prev.exists():
        for dest in (PUBLIC / "welcome-ring.png", BOT / "welcome-ring.png"):
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(ring_prev.read_bytes())
            print("welcome", dest)


if __name__ == "__main__":
    main()

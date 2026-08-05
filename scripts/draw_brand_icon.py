#!/usr/bin/env python3
"""Draw brand-icon-1024.png from scratch (no broken SVG rasterizers)."""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "brand-icon-1024.png"
W = 1024
CREAM = (243, 238, 228)
DARK = (20, 50, 36)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def mix(c0: tuple[int, int, int], c1: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return (
        int(lerp(c0[0], c1[0], t)),
        int(lerp(c0[1], c1[1], t)),
        int(lerp(c0[2], c1[2], t)),
    )


def paint_gradient(im: Image.Image) -> None:
    c_a, c_b, c_c = (207, 233, 196), (79, 154, 92), (26, 63, 40)
    pix = im.load()
    for y in range(W):
        for x in range(W):
            t = (x + y) / (2 * (W - 1))
            if t < 0.5:
                pix[x, y] = mix(c_a, c_b, t / 0.5)
            else:
                pix[x, y] = mix(c_b, c_c, (t - 0.5) / 0.5)


def ellipse_poly(cx: float, cy: float, rx: float, ry: float, ang_deg: float, n: int = 48) -> list[tuple[float, float]]:
    ar = math.radians(ang_deg)
    ca, sa = math.cos(ar), math.sin(ar)
    pts: list[tuple[float, float]] = []
    for i in range(n):
        a = 2 * math.pi * i / n
        lx, ly = rx * math.cos(a), ry * math.sin(a)
        pts.append((cx + lx * ca - ly * sa, cy + lx * sa + ly * ca))
    return pts


def thick_line(draw: ImageDraw.ImageDraw, pts: list[tuple[float, float]], fill, width: int) -> None:
    draw.line([(int(x), int(y)) for x, y in pts], fill=fill, width=width, joint="curve")
    # round caps
    r = max(1, width // 2)
    for x, y in (pts[0], pts[-1]):
        draw.ellipse([x - r, y - r, x + r, y + r], fill=fill)


def main() -> None:
    im = Image.new("RGB", (W, W))
    paint_gradient(im)
    draw = ImageDraw.Draw(im)

    cx = cy = 512
    ring_r = 358
    ring_w = 50
    # ring as two circles via outline
    draw.ellipse(
        [cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r],
        outline=DARK,
        width=ring_w,
    )

    # thin ground strip (~height 36 px inside ring)
    top_y = 666
    bot_y = 722
    left, right = 300, 724
    ground: list[tuple[float, float]] = []
    for i in range(41):
        t = i / 40
        x = lerp(left, right, t)
        # slight upward arch in the middle
        y = top_y - 8 * math.sin(math.pi * t)
        ground.append((x, y))
    for i in range(41):
        t = i / 40
        x = lerp(right - 8, left + 8, t)
        y = bot_y + 6 * math.sin(math.pi * t)
        ground.append((x, y))
    draw.polygon([(int(x), int(y)) for x, y in ground], fill=CREAM)

    # leaves
    for ex, ey, rx, ry, ang in (
        (312, 452, 20, 34, -38),
        (352, 414, 22, 36, -28),
        (390, 382, 18, 30, -18),
    ):
        draw.polygon([(int(x), int(y)) for x, y in ellipse_poly(ex, ey, rx, ry, ang)], fill=DARK)
    thick_line(draw, [(270, 505), (305, 460), (345, 415), (388, 382)], DARK, 11)

    # person LEFT
    head = (400, 500)
    hr = 28
    draw.ellipse([head[0] - hr, head[1] - hr, head[0] + hr, head[1] + hr], fill=CREAM)
    thick_line(draw, [(400, 532), (400, 612)], CREAM, 20)
    thick_line(draw, [(400, 556), (352, 598)], CREAM, 15)
    thick_line(draw, [(400, 556), (452, 580)], CREAM, 15)
    thick_line(draw, [(400, 612), (360, 678)], CREAM, 17)
    thick_line(draw, [(400, 612), (444, 648), (472, 682)], CREAM, 17)

    # bike RIGHT — same visual weight
    wr = 52
    draw.ellipse([560 - wr, 658 - wr, 560 + wr, 658 + wr], outline=CREAM, width=14)
    draw.ellipse([718 - wr, 658 - wr, 718 + wr, 658 + wr], outline=CREAM, width=14)
    thick_line(draw, [(560, 658), (618, 658), (655, 555), (718, 658)], CREAM, 14)
    thick_line(draw, [(618, 658), (655, 555), (600, 555)], CREAM, 14)
    thick_line(draw, [(655, 555), (692, 505)], CREAM, 14)
    thick_line(draw, [(672, 503), (736, 498)], CREAM, 14)
    thick_line(draw, [(578, 544), (628, 544)], CREAM, 14)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    im.save(OUT, optimize=True)
    print("wrote", OUT)


if __name__ == "__main__":
    main()

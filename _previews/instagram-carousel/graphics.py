#!/usr/bin/env python3
"""Cool standalone graphics for Instagram slides — not dumb UI cards in frames."""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageOps


def cover_crop_strict(img: Image.Image, w: int, h: int, center=(0.5, 0.42)) -> Image.Image:
    """Uniform scale + crop to exact size. Never stretches pixels."""
    out = ImageOps.fit(img, (w, h), method=Image.Resampling.LANCZOS, centering=center)
    if out.size != (w, h):
        raise RuntimeError(f"cover_crop_strict size bug: {out.size} != {(w, h)}")
    return out


def isometric_football_pitch(height: int = 520) -> Image.Image:
    """Upright schematic pitch (field stood on end) — the height metaphor.

    Prefers Wikimedia-derived asset; falls back to isometric draw.
    No frame, no arrow, no caption card.
    """
    asset = Path(__file__).resolve().parent / "assets" / "football-pitch-upright.png"
    if asset.exists():
        img = Image.open(asset).convert("RGBA")
        if img.height != height:
            w = max(40, int(img.width * (height / img.height)))
            img = img.resize((w, height), Image.Resampling.LANCZOS)
        return img
    return _isometric_football_pitch_draw(height)


def _isometric_football_pitch_draw(height: int = 520) -> Image.Image:
    """Fallback isometric pitch if upright asset missing."""

    w, h = int(height * 0.72), height
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad_x, pad_y = 28, 36
    bl = (pad_x + 8, h - pad_y)
    br = (w - pad_x, h - pad_y - 28)
    tr = (w - pad_x - 36, pad_y + 40)
    tl = (pad_x + 70, pad_y)

    def lerp(a, b, t):
        return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)

    d.polygon([bl, br, tr, tl], fill=(28, 130, 62, 255))
    d.line([bl, br, tr, tl, bl], fill=(255, 255, 255, 210), width=3)
    mid_b, mid_t = lerp(bl, br, 0.5), lerp(tl, tr, 0.5)
    d.line([mid_b, mid_t], fill=(255, 255, 255, 200), width=2)
    cx = (mid_b[0] + mid_t[0]) / 2
    cy = (mid_b[1] + mid_t[1]) / 2
    d.ellipse([cx - 40, cy - 24, cx + 40, cy + 24], outline=(255, 255, 255, 200), width=2)
    return img


def paste_rgba(base: Image.Image, overlay: Image.Image, xy: tuple[int, int]) -> Image.Image:
    out = base.convert("RGBA")
    layer = Image.new("RGBA", out.size, (0, 0, 0, 0))
    layer.paste(overlay, xy, overlay)
    return Image.alpha_composite(out, layer)

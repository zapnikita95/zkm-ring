"""Ready-made style icons for carousels — standard map UI, not invented doodles.

No crosshair / reticle / concentric target rings. Ever.
"""
from __future__ import annotations

from PIL import Image, ImageDraw


def map_pin(size: int = 96, fill: tuple = (34, 197, 94, 255), stroke: tuple = (255, 255, 255, 255)) -> Image.Image:
    """Classic teardrop map pin (standard navigation UI)."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Body: rounded teardrop via ellipse + triangle
    pad = size * 0.12
    cx = size / 2
    head_r = size * 0.32
    head_cy = size * 0.38
    # ellipse head
    d.ellipse(
        [cx - head_r, head_cy - head_r, cx + head_r, head_cy + head_r],
        fill=fill,
    )
    # tip
    tip_y = size - pad
    d.polygon(
        [
            (cx - head_r * 0.72, head_cy + head_r * 0.35),
            (cx + head_r * 0.72, head_cy + head_r * 0.35),
            (cx, tip_y),
        ],
        fill=fill,
    )
    # inner hole
    hole = head_r * 0.38
    d.ellipse(
        [cx - hole, head_cy - hole, cx + hole, head_cy + hole],
        fill=stroke,
    )
    return img


def route_mark(size: int = 96, color: tuple = (34, 197, 94, 255)) -> Image.Image:
    """Simple route: two nodes + path (standard wayfinding, not a target)."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    sw = max(4, size // 12)
    # path
    d.line(
        [(size * 0.22, size * 0.72), (size * 0.38, size * 0.38), (size * 0.78, size * 0.28)],
        fill=color,
        width=sw,
        joint="curve",
    )
    r = size * 0.12
    for cx, cy in ((size * 0.22, size * 0.72), (size * 0.78, size * 0.28)):
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)
        d.ellipse([cx - r * 0.45, cy - r * 0.45, cx + r * 0.45, cy + r * 0.45], fill=(255, 255, 255, 255))
    return img


def paste_icon(base: Image.Image, icon: Image.Image, corner: str, margin: int = 48) -> None:
    w, h = base.size
    iw, ih = icon.size
    positions = {
        "tl": (margin, margin + 36),
        "tr": (w - margin - iw, margin + 36),
        "bl": (margin, h - margin - ih - 40),
        "br": (w - margin - iw, h - margin - ih - 40),
    }
    xy = positions.get(corner)
    if xy:
        base.paste(icon, xy, icon)

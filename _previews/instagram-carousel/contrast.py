"""Pixel-level text-on-photo contrast (WCAG 2.1) for Instagram carousel renders.

Sample luminance under a text bbox on the *background* (before glyphs).
If worst-case ratio < threshold → caller must add scrim / recolor text.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Sequence

from PIL import Image


def _srgb_to_lin(c: float) -> float:
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def relative_luminance(rgb: Sequence[int]) -> float:
    r, g, b = rgb[0], rgb[1], rgb[2]
    return 0.2126 * _srgb_to_lin(r) + 0.7152 * _srgb_to_lin(g) + 0.0722 * _srgb_to_lin(b)


def contrast_ratio(fg: Sequence[int], bg: Sequence[int]) -> float:
    l1 = relative_luminance(fg)
    l2 = relative_luminance(bg)
    lighter, darker = (l1, l2) if l1 >= l2 else (l2, l1)
    return (lighter + 0.05) / (darker + 0.05)


@dataclass
class SampleReport:
    ratio_vs_darkest: float
    ratio_vs_lightest: float
    worst_ratio: float
    mean_luma: float
    darkest: tuple[int, int, int]
    lightest: tuple[int, int, int]
    passes: bool
    fix: str  # "ok" | "scrim_dark" | "scrim_light" | "recolor"


def sample_region(
    img: Image.Image,
    box: tuple[int, int, int, int],
    fg: Sequence[int],
    *,
    grid: tuple[int, int] = (7, 5),
    min_ratio: float = 4.5,
) -> SampleReport:
    """Sample bbox (x0,y0,x1,y1) on RGB image; fg = intended text RGB."""
    rgb = img.convert("RGB")
    x0, y0, x1, y1 = box
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(rgb.width, x1), min(rgb.height, y1)
    if x1 <= x0 + 2 or y1 <= y0 + 2:
        return SampleReport(0, 0, 0, 0, (0, 0, 0), (255, 255, 255), False, "scrim_dark")

    gw, gh = grid
    pix = []
    for iy in range(gh):
        for ix in range(gw):
            x = x0 + int((ix + 0.5) * (x1 - x0) / gw)
            y = y0 + int((iy + 0.5) * (y1 - y0) / gh)
            pix.append(rgb.getpixel((x, y)))

    lumas = [(relative_luminance(p), p) for p in pix]
    lumas.sort(key=lambda t: t[0])
    darkest = lumas[0][1]
    lightest = lumas[-1][1]
    mean_luma = sum(l for l, _ in lumas) / len(lumas)
    r_dark = contrast_ratio(fg, darkest)
    r_light = contrast_ratio(fg, lightest)
    # Worst case for readability on busy photo
    worst = min(r_dark, r_light)
    passes = worst >= min_ratio

    if passes:
        fix = "ok"
    elif mean_luma > 0.45:
        # bright photo under light-ish text → need dark scrim or dark text
        fix = "scrim_dark" if relative_luminance(fg) > 0.5 else "recolor"
    else:
        fix = "scrim_light" if relative_luminance(fg) < 0.5 else "scrim_dark"
        # light text on dark-ish but orange-ish midtones often fails vs lightest
        if relative_luminance(fg) > 0.4 and r_light < min_ratio:
            fix = "scrim_dark"

    return SampleReport(
        ratio_vs_darkest=r_dark,
        ratio_vs_lightest=r_light,
        worst_ratio=worst,
        mean_luma=mean_luma,
        darkest=(int(darkest[0]), int(darkest[1]), int(darkest[2])),
        lightest=(int(lightest[0]), int(lightest[1]), int(lightest[2])),
        passes=passes,
        fix=fix,
    )


def _is_warm_accent(fg: Sequence[int]) -> bool:
    r, g, b = int(fg[0]), int(fg[1]), int(fg[2])
    # orange / gold / warm — dangerous on sunsets & brick
    return r >= 170 and g >= 90 and b <= 160 and r >= g


def ensure_contrast(
    img: Image.Image,
    box: tuple[int, int, int, int],
    fg: Sequence[int],
    *,
    min_ratio: float = 4.5,
    large_text: bool = True,
    allow_plate: bool = False,
) -> tuple[Image.Image, tuple[int, int, int], SampleReport]:
    """Return (img, safe_fg, report).

    Default (allow_plate=False): NEVER paint a text plate/scrim box.
    Pick a readable fg (cream/white or near-black). Soft whole-frame veils
    are the caller's job — not per-label rounded rectangles.

    allow_plate=True: legacy path with dark/light plates (avoid for IG battle).
    """
    thresh = 3.0 if large_text else min_ratio
    accent = (int(fg[0]), int(fg[1]), int(fg[2]))
    warm = _is_warm_accent(accent)
    report = sample_region(img, box, accent, min_ratio=thresh)

    if not allow_plate:
        # No boxes. Prefer cream on dark photos; dark on bright; warm → peach/cream.
        safe_fg = accent
        if warm:
            safe_fg = (255, 214, 160)
        r = sample_region(img, box, safe_fg, min_ratio=thresh)
        if not r.passes:
            # flip to cream or near-black without painting a plate
            cream = (244, 244, 245)
            dark = (18, 20, 18)
            r_c = sample_region(img, box, cream, min_ratio=thresh)
            r_d = sample_region(img, box, dark, min_ratio=thresh)
            if r_c.worst_ratio >= r_d.worst_ratio:
                safe_fg, r = cream, r_c
            else:
                safe_fg, r = dark, r_d
        return img, safe_fg, r

    if report.passes and not warm:
        return img, accent, report

    from PIL import ImageDraw

    out = img.convert("RGBA")
    overlay = Image.new("RGBA", out.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    x0, y0, x1, y1 = box
    pad = 32
    plate = (10, 12, 10, 220)

    if warm or report.fix in ("scrim_dark", "recolor") or relative_luminance(accent) > 0.35:
        d.rounded_rectangle(
            [x0 - pad, y0 - pad // 2, x1 + pad, y1 + pad],
            radius=28,
            fill=plate,
        )
        plate_rgb = (12, 14, 12)
        safe_fg = accent
        if contrast_ratio(safe_fg, plate_rgb) < 4.5:
            safe_fg = (255, 200, 130) if warm else (244, 244, 245)
        if contrast_ratio(safe_fg, plate_rgb) < 4.5:
            safe_fg = (244, 244, 245)
    else:
        d.rounded_rectangle(
            [x0 - pad, y0 - pad // 2, x1 + pad, y1 + pad],
            radius=28,
            fill=(250, 250, 248, 225),
        )
        safe_fg = (18, 20, 18)

    out = Image.alpha_composite(out, overlay)
    report2 = sample_region(out.convert("RGB"), box, safe_fg, min_ratio=thresh)
    if not report2.passes:
        safe_fg = (255, 255, 255) if relative_luminance(safe_fg) > 0.5 else (18, 20, 18)
        report2 = sample_region(out.convert("RGB"), box, safe_fg, min_ratio=thresh)
    return out.convert("RGB"), safe_fg, report2


def audit_labels(
    img: Image.Image,
    items: Iterable[tuple[str, tuple[int, int, int, int], Sequence[int]]],
    *,
    min_ratio: float = 3.5,
) -> list[str]:
    """Human-readable audit lines for a slide."""
    lines = []
    for name, box, fg in items:
        r = sample_region(img, box, fg, min_ratio=min_ratio)
        status = "PASS" if r.passes else f"FAIL→{r.fix}"
        lines.append(f"{name}: {r.worst_ratio:.2f}:1 {status} (meanL={r.mean_luma:.2f})")
    return lines

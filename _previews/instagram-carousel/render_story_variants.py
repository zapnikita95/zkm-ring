#!/usr/bin/env python3
"""5 layout variants of one story: Живописный / летающая тарелка.

No text plates. No «ВАУ-ФАКТ» label. No «кусок». Huge spaced fact slide.
Story: docs/instagram/stories/zhivopisny-flying-saucer.md
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps

from contrast import ensure_contrast, sample_region
from icons import map_pin, paste_icon, route_mark
from layout_templates import assert_no_banned

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
OUT_ROOT = ROOT / "export" / "story-variants-zhivopisny"
W, H = 1080, 1350

GREEN = (31, 143, 74)
CREAM = (244, 244, 245)
DARK = (12, 14, 12)
WARM = (255, 200, 130)
GOLD = (255, 214, 160)
MUTED = (200, 205, 200)

FONT_BLACK = "/System/Library/Fonts/Supplemental/Arial Black.ttf"
FONT_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FONT_REG = "/System/Library/Fonts/Supplemental/Arial.ttf"

# --- Story copy (same for all variants) ---
COPY = {
    1: {
        "title": "Что это за мост с летающей тарелкой?",
        "sub": "Свайпни — разберёмся за 20 секунд",
    },
    2: {
        "title": "Живописный мост",
        "body": "Капсула под красной аркой — не шутка. Её задумывали как ресторан в воздухе. Открыт в 2007.",
    },
    3: {
        "title": "Внутрь почти никто не ходит",
        "body": "Зато снаружи снимают все. Туристы едут сюда именно за кадром с «тарелкой».",
    },
    4: {
        "number": "105",
        "unit": "метров арки",
        "stats": "72 ванты · пролёт 409,5 м",
        "source": "Источник: Wikipedia «Живописный мост»",
    },
    5: {
        "title": "На Зелёном кольце",
        "body": "Проезжаешь мимо — и вот она. Для лучшего фото встаньте на набережной или со стороны Серебряного Бора на закате.",
    },
    6: {
        "brand": "Зелёный Маршрут",
        "cta": "Соберите отрезок Зелёного кольца мимо этого моста",
    },
}


@dataclass
class Slot:
    x: int
    y: int
    max_w: int
    align: str = "left"  # left|right


@dataclass
class Variant:
    id: str
    name: str
    # per-slide text slot
    slots: dict[int, Slot]
    # style flags
    accent_bar: bool = False
    frame_text: bool = False  # decorative outline around text zone (no fill)
    giant_center_fact: bool = False
    split_fact: bool = False
    corners: str = "cream"  # cream|green|off
    icon_on: tuple[int, ...] = (2, 5)


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.truetype(FONT_BOLD, size)


def load(name: str) -> Image.Image:
    return Image.open(ASSETS / name).convert("RGB")


def cover_crop(img: Image.Image, w: int, h: int, center=(0.5, 0.42)) -> Image.Image:
    return ImageOps.fit(img, (w, h), method=Image.Resampling.LANCZOS, centering=center)


def grade(img: Image.Image) -> Image.Image:
    img = ImageEnhance.Contrast(img).enhance(1.18)
    img = ImageEnhance.Color(img).enhance(1.12)
    img = ImageEnhance.Sharpness(img).enhance(1.2)
    return img


def film_grain(img: Image.Image, amount=12) -> Image.Image:
    import random

    noise = Image.new("L", img.size)
    px = noise.load()
    rnd = random.Random(42)
    for y in range(0, img.height, 2):
        for x in range(0, img.width, 2):
            v = 128 + rnd.randint(-amount, amount)
            px[x, y] = max(0, min(255, v))
            if x + 1 < img.width:
                px[x + 1, y] = px[x, y]
            if y + 1 < img.height:
                px[x, y + 1] = px[x, y]
                if x + 1 < img.width:
                    px[x + 1, y + 1] = px[x, y]
    noise = noise.filter(ImageFilter.GaussianBlur(0.6))
    base = img.convert("RGBA")
    nrgba = Image.merge("RGBA", (noise, noise, noise, Image.new("L", img.size, 28)))
    return Image.alpha_composite(base, nrgba).convert("RGB")


def seamless_strip(src: Image.Image, slides: int, focus_y=0.38) -> Image.Image:
    tw, th = slides * W, H
    scale = max(th / src.height, tw / src.width)
    nw, nh = int(src.width * scale), int(src.height * scale)
    resized = src.resize((nw, nh), Image.Resampling.LANCZOS)
    left = max(0, (nw - tw) // 2)
    top = max(0, int((nh - th) * focus_y))
    if top + th > nh:
        top = max(0, nh - th)
    return grade(resized.crop((left, top, left + tw, top + th)))


def slice_strip(strip: Image.Image, i: int) -> Image.Image:
    return strip.crop((i * W, 0, (i + 1) * W, H))


def wrap(draw, text, fnt, max_w) -> list[str]:
    words = text.split()
    lines, cur = [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if draw.textlength(trial, font=fnt) <= max_w:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def text_size(draw, text, fnt, max_w, line_gap=1.08) -> tuple[int, int]:
    lines = wrap(draw, text, fnt, max_w)
    lh = int(fnt.size * line_gap)
    tw = max((draw.textlength(l, font=fnt) for l in lines), default=0)
    return int(tw), len(lines) * lh


def draw_text_stroke(
    draw,
    text,
    xy,
    fnt,
    fill,
    max_w,
    *,
    align="left",
    line_gap=1.08,
    stroke=5,
) -> int:
    """Hard stroke + soft shadow — readability without a plate."""
    x, y = xy
    lines = wrap(draw, text, fnt, max_w)
    lh = int(fnt.size * line_gap)
    for i, line in enumerate(lines):
        yy = y + i * lh
        lx = x
        if align == "right":
            lx = x + max_w - int(draw.textlength(line, font=fnt))
        # soft shadow
        draw.text((lx + 3, yy + 4), line, font=fnt, fill=(0, 0, 0, 160))
        # stroke ring
        for dx, dy in (
            (-stroke, 0),
            (stroke, 0),
            (0, -stroke),
            (0, stroke),
            (-stroke, -stroke),
            (stroke, -stroke),
            (-stroke, stroke),
            (stroke, stroke),
        ):
            draw.text((lx + dx, yy + dy), line, font=fnt, fill=(0, 0, 0, 210))
        draw.text((lx, yy), line, font=fnt, fill=fill)
    return y + len(lines) * lh


def draw_safe(
    base: Image.Image,
    text: str,
    xy,
    fnt,
    prefer_fg,
    max_w,
    *,
    label: str,
    audit: list,
    align="left",
    line_gap=1.08,
    force_fg: bool = False,
) -> tuple[Image.Image, int]:
    """force_fg=True: never flip to black (display numbers on photo)."""
    assert_no_banned(text, label)
    probe = ImageDraw.Draw(base)
    tw, th = text_size(probe, text, fnt, max_w, line_gap)
    x, y = xy
    box = (x, y, x + (max_w if align == "right" else max(tw, 40)), y + max(th, fnt.size))
    if force_fg:
        fg = prefer_fg
        report = sample_region(base, box, fg, min_ratio=3.0)
        img = base
    else:
        img, fg, report = ensure_contrast(base, box, prefer_fg, large_text=fnt.size >= 36, allow_plate=False)
        # Never paint near-black display text on photos — stroke carries contrast
        if relative_luma(fg) < 0.35:
            fg = CREAM if relative_luma(prefer_fg) > 0.35 else prefer_fg
    audit.append(f"{label}: {report.worst_ratio:.2f}:1 {'OK' if report.passes else 'WEAK'}")
    d = ImageDraw.Draw(img, "RGBA")
    stroke = 7 if fnt.size >= 80 else 5
    y2 = draw_text_stroke(d, text, xy, fnt, fg, max_w, align=align, line_gap=line_gap, stroke=stroke)
    return img, y2


def relative_luma(rgb) -> float:
    r, g, b = rgb[0] / 255, rgb[1] / 255, rgb[2] / 255
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def frame_corners(draw, color=(*CREAM, 90), inset=36, length=70, width=3):
    x0, y0, x1, y1 = inset, inset, W - inset, H - inset
    for ax, ay, dx, dy in [
        (x0, y0, 1, 0),
        (x0, y0, 0, 1),
        (x1, y0, -1, 0),
        (x1, y0, 0, 1),
        (x0, y1, 1, 0),
        (x0, y1, 0, -1),
        (x1, y1, -1, 0),
        (x1, y1, 0, -1),
    ]:
        draw.line([(ax, ay), (ax + dx * length, ay + dy * length)], fill=color, width=width)


def text_frame(draw, box, color=(*GREEN, 200), pad=24):
    """Outline only — no fill (decorative)."""
    x0, y0, x1, y1 = box
    x0, y0, x1, y1 = x0 - pad, y0 - pad, x1 + pad, y1 + pad
    # four corner brackets around text
    L = 48
    w = 4
    for (ax, ay, sx, sy) in [
        (x0, y0, 1, 1),
        (x1, y0, -1, 1),
        (x0, y1, 1, -1),
        (x1, y1, -1, -1),
    ]:
        draw.line([(ax, ay), (ax + sx * L, ay)], fill=color, width=w)
        draw.line([(ax, ay), (ax, ay + sy * L)], fill=color, width=w)


def soft_zone(s: Image.Image, y0: int, y1: int, strength=160) -> Image.Image:
    """Gentle vertical darken — whole band, not a text plate."""
    veil = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    vd = ImageDraw.Draw(veil)
    for y in range(max(0, y0), min(H, y1)):
        t = (y - y0) / max(1, y1 - y0)
        a = int(strength * (0.35 + 0.65 * abs(t - 0.5) * 2 if False else min(1, t * 1.2)))
        # simpler: ramp
        a = int(strength * min(1.0, (y - y0) / max(1, (y1 - y0) * 0.55)))
        vd.line([(0, y), (W, y)], fill=(8, 10, 8, a))
    return Image.alpha_composite(s.convert("RGBA"), veil)


def watermark(draw):
    draw.text((W - 292, 40), "green-route.ru", font=font(FONT_REG, 26), fill=(*MUTED, 210))


def progress(d, n):
    d.text((48, 1260), f"{n:02d} / 06", font=font(FONT_BOLD, 24), fill=(*MUTED, 220))


def swipe_pill(draw):
    draw.rounded_rectangle((W - 230, 1195, W - 48, 1253), radius=29, fill=(255, 255, 255, 235))
    draw.text((W - 205, 1209), "свайп  →", font=font(FONT_BOLD, 28), fill=DARK)


def chip_zkm(draw):
    draw.rounded_rectangle((48, 44, 166, 96), radius=12, fill=GREEN)
    draw.text((70, 54), "ЗКМ", font=font(FONT_BOLD, 28), fill=(255, 255, 255))


# ---------- 5 variants ----------
VARIANTS = [
    Variant(
        "A",
        "Bottom-left + акцент-бар",
        slots={
            1: Slot(72, 720, W - 140),
            2: Slot(48, 820, W - 96),
            3: Slot(48, 780, W - 96),
            4: Slot(56, 380, W - 120),
            5: Slot(48, 760, W - 96),
            6: Slot(96, 520, W - 192),
        },
        accent_bar=True,
        corners="cream",
    ),
    Variant(
        "B",
        "Углы: TR → BL → TR → ML → TL",
        slots={
            1: Slot(48, 160, W - 120, "right"),
            2: Slot(48, 860, W - 96, "left"),
            3: Slot(48, 140, W - 120, "right"),
            4: Slot(48, 700, W - 96, "left"),
            5: Slot(48, 140, W - 120, "left"),
            6: Slot(96, 520, W - 192),
        },
        corners="green",
        icon_on=(2, 5, 3),
    ),
    Variant(
        "C",
        "Гигантская 105 по центру",
        slots={
            1: Slot(48, 780, W - 96),
            2: Slot(48, 200, W - 96),
            3: Slot(48, 820, W - 96, "right"),
            4: Slot(40, 280, W - 80),
            5: Slot(48, 200, W - 96, "right"),
            6: Slot(96, 520, W - 192),
        },
        giant_center_fact=True,
        corners="cream",
    ),
    Variant(
        "D",
        "Рамка вокруг текста (без заливки)",
        slots={
            1: Slot(80, 740, W - 160),
            2: Slot(80, 780, W - 160),
            3: Slot(80, 720, W - 160),
            4: Slot(72, 360, W - 160),
            5: Slot(80, 200, W - 160),
            6: Slot(96, 520, W - 192),
        },
        frame_text=True,
        corners="off",
    ),
    Variant(
        "E",
        "Split: цифра слева / текст снизу-справа",
        slots={
            1: Slot(48, 200, W - 96),
            2: Slot(48, 860, W - 96, "right"),
            3: Slot(48, 200, W - 200),
            4: Slot(40, 320, W - 80),
            5: Slot(48, 860, W - 96, "right"),
            6: Slot(96, 520, W - 192),
        },
        split_fact=True,
        corners="green",
        accent_bar=True,
    ),
]


def render_variant(v: Variant, strip: Image.Image, detail: Image.Image) -> dict:
    out = OUT_ROOT / f"variant-{v.id}"
    out.mkdir(parents=True, exist_ok=True)
    audit_all = {}

    def save(img, idx):
        path = out / f"slide-{idx:02d}.jpg"
        film_grain(img).save(path, "JPEG", quality=93, optimize=True)
        print("wrote", path.relative_to(ROOT))

    # --- 1 hook ---
    audit = []
    s = soft_zone(slice_strip(strip, 0), 600 if v.slots[1].y > 400 else 0, H, 175)
    if v.slots[1].y < 400:
        s = soft_zone(s, 0, 520, 150)
    d = ImageDraw.Draw(s, "RGBA")
    if v.corners == "cream":
        frame_corners(d)
    elif v.corners == "green":
        frame_corners(d, color=(*GREEN, 100))
    chip_zkm(d)
    slot = v.slots[1]
    if v.accent_bar and slot.align == "left":
        ImageDraw.Draw(s, "RGBA").rectangle((48, slot.y - 10, 58, slot.y + 220), fill=GREEN)
    s_rgb = s.convert("RGB")
    s_rgb, y = draw_safe(
        s_rgb, COPY[1]["title"], (slot.x, slot.y), font(FONT_BLACK, 64), CREAM, slot.max_w,
        label="hook", audit=audit, align=slot.align, line_gap=1.05,
    )
    s_rgb, _ = draw_safe(
        s_rgb, COPY[1]["sub"], (slot.x, y + 40), font(FONT_BOLD, 32), WARM, slot.max_w,
        label="hook_sub", audit=audit, align=slot.align,
    )
    if v.frame_text:
        d = ImageDraw.Draw(s_rgb, "RGBA")
        text_frame(d, (slot.x, slot.y, slot.x + slot.max_w - 40, y + 80))
    d = ImageDraw.Draw(s_rgb, "RGBA")
    swipe_pill(d)
    progress(d, 1)
    audit_all["01"] = audit
    save(s_rgb, 1)

    # --- 2 answer ---
    audit = []
    s = soft_zone(slice_strip(strip, 1), 700 if v.slots[2].y > 500 else 0, H, 170)
    if v.slots[2].y < 400:
        s = soft_zone(s, 0, 500, 140)
    d = ImageDraw.Draw(s, "RGBA")
    if v.corners == "cream":
        frame_corners(d, color=(*CREAM, 70))
    elif v.corners == "green":
        frame_corners(d, color=(*GREEN, 90))
    if 2 in v.icon_on:
        paste_icon(s, map_pin(84), "tr" if v.slots[2].align == "left" else "tl")
    s_rgb = s.convert("RGB")
    d = ImageDraw.Draw(s_rgb, "RGBA")
    watermark(d)
    slot = v.slots[2]
    if v.accent_bar and slot.align == "left":
        ImageDraw.Draw(s_rgb, "RGBA").rectangle((48, slot.y, 58, slot.y + 180), fill=GREEN)
    s_rgb, y = draw_safe(
        s_rgb, COPY[2]["title"], (slot.x, slot.y), font(FONT_BLACK, 56), CREAM, slot.max_w,
        label="title", audit=audit, align=slot.align,
    )
    s_rgb, y2 = draw_safe(
        s_rgb, COPY[2]["body"], (slot.x, y + 44), font(FONT_BOLD, 36), CREAM, slot.max_w,
        label="body", audit=audit, align=slot.align, line_gap=1.2,
    )
    if v.frame_text:
        ImageDraw.Draw(s_rgb, "RGBA")
        text_frame(ImageDraw.Draw(s_rgb, "RGBA"), (slot.x, slot.y, slot.x + slot.max_w - 20, y2))
    d = ImageDraw.Draw(s_rgb, "RGBA")
    progress(d, 2)
    audit_all["02"] = audit
    save(s_rgb, 2)

    # --- 3 twist ---
    audit = []
    s = soft_zone(slice_strip(strip, 2), 700 if v.slots[3].y > 500 else 0, H, 165)
    if v.slots[3].y < 400:
        s = soft_zone(s, 0, 520, 145)
    d = ImageDraw.Draw(s, "RGBA")
    if v.corners != "off":
        frame_corners(d, color=(*CREAM, 70) if v.corners == "cream" else (*GREEN, 90))
    if 3 in v.icon_on:
        paste_icon(s, map_pin(80), "bl")
    s_rgb = s.convert("RGB")
    d = ImageDraw.Draw(s_rgb, "RGBA")
    watermark(d)
    slot = v.slots[3]
    s_rgb, y = draw_safe(
        s_rgb, COPY[3]["title"], (slot.x, slot.y), font(FONT_BLACK, 52), CREAM, slot.max_w,
        label="title", audit=audit, align=slot.align,
    )
    s_rgb, y2 = draw_safe(
        s_rgb, COPY[3]["body"], (slot.x, y + 48), font(FONT_BOLD, 36), GOLD, slot.max_w,
        label="body", audit=audit, align=slot.align, line_gap=1.2,
    )
    if v.frame_text:
        text_frame(ImageDraw.Draw(s_rgb, "RGBA"), (slot.x, slot.y, slot.x + slot.max_w - 20, y2))
    d = ImageDraw.Draw(s_rgb, "RGBA")
    progress(d, 3)
    audit_all["03"] = audit
    save(s_rgb, 3)

    # --- 4 scale (NO wow label, huge number, spaced) ---
    audit = []
    # Keep photo readable — no heavy whole-frame dunk; stroke carries contrast
    base = ImageEnhance.Brightness(grade(cover_crop(detail, W, H, (0.55, 0.4)))).enhance(0.72)
    s = base.convert("RGBA")
    big = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    bd = ImageDraw.Draw(big)
    bd.text((20, 160), "105", font=font(FONT_BLACK, 380), fill=(255, 255, 255, 18))
    s = Image.alpha_composite(s, big)
    d = ImageDraw.Draw(s, "RGBA")
    if v.corners != "off":
        frame_corners(d)
    s_rgb = s.convert("RGB")
    d = ImageDraw.Draw(s_rgb, "RGBA")
    watermark(d)
    slot = v.slots[4]
    c4 = COPY[4]

    # Fixed vertical advances — glyph metrics alone leave "105" visually crushed into unit
    GAP_NUM_UNIT = 110
    GAP_UNIT_STATS = 72
    GAP_STATS_SRC = 52

    if v.giant_center_fact:
        fnum = font(FONT_BLACK, 300)
        probe = ImageDraw.Draw(s_rgb)
        nw = int(probe.textlength(c4["number"], font=fnum))
        nx = (W - nw) // 2
        num_y = 240
        s_rgb, _ = draw_safe(
            s_rgb, c4["number"], (nx, num_y), fnum, CREAM, nw + 20,
            label="number", audit=audit, line_gap=1.0, force_fg=True,
        )
        y = num_y + 300 + GAP_NUM_UNIT
        s_rgb, _ = draw_safe(
            s_rgb, c4["unit"], (64, y), font(FONT_BLACK, 56), CREAM, W - 128,
            label="unit", audit=audit, force_fg=True,
        )
        y = y + 56 + GAP_UNIT_STATS
        s_rgb, _ = draw_safe(
            s_rgb, c4["stats"], (64, y), font(FONT_BOLD, 34), GOLD, W - 128,
            label="stats", audit=audit, force_fg=True,
        )
        y = y + 34 + GAP_STATS_SRC
        s_rgb, _ = draw_safe(
            s_rgb, c4["source"], (64, y), font(FONT_REG, 24), MUTED, W - 128,
            label="source", audit=audit, force_fg=True,
        )
    elif v.split_fact:
        num_y = 220
        s_rgb, _ = draw_safe(
            s_rgb, c4["number"], (36, num_y), font(FONT_BLACK, 280), CREAM, 720,
            label="number", audit=audit, line_gap=1.0, force_fg=True,
        )
        y = num_y + 280 + GAP_NUM_UNIT
        s_rgb, _ = draw_safe(
            s_rgb, c4["unit"], (48, y), font(FONT_BLACK, 52), CREAM, 700,
            label="unit", audit=audit, force_fg=True,
        )
        s_rgb, y = draw_safe(
            s_rgb, c4["stats"], (48, 1020), font(FONT_BOLD, 32), GOLD, W - 96,
            label="stats", audit=audit, align="right", force_fg=True,
        )
        s_rgb, _ = draw_safe(
            s_rgb, c4["source"], (48, y + GAP_STATS_SRC), font(FONT_REG, 24), MUTED, W - 96,
            label="source", audit=audit, align="right", force_fg=True,
        )
        ImageDraw.Draw(s_rgb, "RGBA").rectangle((48, 280, 58, 560), fill=WARM)
    else:
        num_size = 280
        num_y = min(slot.y, 320)
        s_rgb, _ = draw_safe(
            s_rgb, c4["number"], (slot.x, num_y), font(FONT_BLACK, num_size), CREAM, slot.max_w,
            label="number", audit=audit, line_gap=1.0, align=slot.align, force_fg=True,
        )
        y = num_y + num_size + GAP_NUM_UNIT
        s_rgb, _ = draw_safe(
            s_rgb, c4["unit"], (slot.x, y), font(FONT_BLACK, 54), CREAM, slot.max_w,
            label="unit", audit=audit, align=slot.align, force_fg=True,
        )
        y = y + 54 + GAP_UNIT_STATS
        s_rgb, _ = draw_safe(
            s_rgb, c4["stats"], (slot.x, y), font(FONT_BOLD, 34), GOLD, slot.max_w,
            label="stats", audit=audit, align=slot.align, force_fg=True,
        )
        y = y + 34 + GAP_STATS_SRC
        s_rgb, _ = draw_safe(
            s_rgb, c4["source"], (slot.x, y), font(FONT_REG, 24), MUTED, slot.max_w,
            label="source", audit=audit, align=slot.align, force_fg=True,
        )
        if v.frame_text:
            text_frame(ImageDraw.Draw(s_rgb, "RGBA"), (slot.x, num_y, slot.x + 700, y + 40))
        if v.accent_bar:
            ImageDraw.Draw(s_rgb, "RGBA").rectangle((48, num_y + 20, 58, num_y + 360), fill=WARM)

    d = ImageDraw.Draw(s_rgb, "RGBA")
    progress(d, 4)
    audit_all["04"] = audit
    save(s_rgb, 4)

    # --- 5 on ring ---
    audit = []
    base = ImageEnhance.Brightness(grade(cover_crop(detail, W, H, (0.35, 0.55)))).enhance(0.4)
    s = soft_zone(base.convert("RGBA"), 700 if v.slots[5].y > 500 else 0, H, 160)
    if v.slots[5].y < 400:
        s = soft_zone(s, 0, 480, 140)
    if 5 in v.icon_on:
        paste_icon(s, route_mark(96), "br" if v.slots[5].align != "right" else "bl")
    d = ImageDraw.Draw(s, "RGBA")
    if v.corners != "off":
        frame_corners(d, color=(*GREEN, 85))
    s_rgb = s.convert("RGB")
    watermark(ImageDraw.Draw(s_rgb, "RGBA"))
    slot = v.slots[5]
    s_rgb, y = draw_safe(
        s_rgb, COPY[5]["title"], (slot.x, slot.y), font(FONT_BLACK, 48), CREAM, slot.max_w,
        label="title", audit=audit, align=slot.align,
    )
    s_rgb, y2 = draw_safe(
        s_rgb, COPY[5]["body"], (slot.x, y + 44), font(FONT_BOLD, 34), CREAM, slot.max_w,
        label="body", audit=audit, align=slot.align, line_gap=1.2,
    )
    if v.frame_text:
        text_frame(ImageDraw.Draw(s_rgb, "RGBA"), (slot.x, slot.y, slot.x + slot.max_w - 40, y2))
    progress(ImageDraw.Draw(s_rgb, "RGBA"), 5)
    audit_all["05"] = audit
    save(s_rgb, 5)

    # --- 6 CTA (card OK — it's a CTA panel, not a failed contrast plate) ---
    audit = []
    base = ImageEnhance.Brightness(grade(cover_crop(detail, W, H))).enhance(0.28)
    s = base.convert("RGBA")
    card = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    cd = ImageDraw.Draw(card)
    cd.rounded_rectangle((56, 360, W - 56, 1040), radius=36, fill=(12, 14, 12, 230))
    cd.rounded_rectangle((56, 360, W - 56, 376), radius=8, fill=(*GREEN, 255))
    s = Image.alpha_composite(s, card)
    pin = map_pin(96)
    s.paste(pin, (W // 2 - 48, 420), pin)
    s_rgb = s.convert("RGB")
    s_rgb, y = draw_safe(
        s_rgb, COPY[6]["brand"], (96, 540), font(FONT_BOLD, 32), (159, 224, 180), W - 200,
        label="brand", audit=audit,
    )
    s_rgb, y = draw_safe(
        s_rgb, COPY[6]["cta"], (96, y + 44), font(FONT_BLACK, 46), CREAM, W - 200,
        label="cta", audit=audit,
    )
    d = ImageDraw.Draw(s_rgb, "RGBA")
    btn = (22, 110, 58)
    d.rounded_rectangle((96, 900, W - 96, 1000), radius=20, fill=btn)
    r = sample_region(s_rgb, (120, 920, W - 120, 980), (255, 255, 255), min_ratio=4.5)
    d.text((W // 2 - 150, 928), "green-route.ru", font=font(FONT_BLACK, 40), fill=(255, 255, 255))
    audit.append(f"btn: {r.worst_ratio:.2f}:1 {'OK' if r.passes else 'FAIL'}")
    progress(d, 6)
    audit_all["06"] = audit
    save(s_rgb, 6)

    (out / "audit.json").write_text(json.dumps(audit_all, ensure_ascii=False, indent=2), encoding="utf-8")
    (out / "meta.json").write_text(
        json.dumps({"id": v.id, "name": v.name, "story": "zhivopisny-flying-saucer"}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return {"id": v.id, "name": v.name, "dir": str(out.relative_to(ROOT))}


def write_compare_html(results: list[dict]):
    cards = []
    for r in results:
        thumbs = "".join(
            f'<img src="export/story-variants-zhivopisny/variant-{r["id"]}/slide-{i:02d}.jpg" alt="{r["id"]}-{i}"/>'
            for i in range(1, 7)
        )
        cards.append(
            f'<section class="var"><h2>Вариант {r["id"]} — {r["name"]}</h2><div class="row">{thumbs}</div></section>'
        )
    html = f"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8"/>
<title>5 вариантов — Живописный / летающая тарелка</title>
<style>
body{{margin:0;background:#0b0b0c;color:#f4f4f5;font-family:system-ui,sans-serif;padding:24px}}
h1{{font-size:22px;margin:0 0 8px}}
.lead{{color:#b4b4be;max-width:720px;line-height:1.45;margin-bottom:28px}}
.story{{background:#151518;border:1px solid #2a2a30;border-radius:12px;padding:16px 18px;margin-bottom:32px;max-width:820px}}
.story ol{{margin:8px 0 0;padding-left:20px;line-height:1.5}}
.var{{margin-bottom:40px}}
.var h2{{font-size:18px;margin:0 0 12px;color:#86efac}}
.row{{display:flex;gap:10px;overflow-x:auto;padding-bottom:8px}}
.row img{{height:280px;border-radius:10px;flex:0 0 auto}}
</style></head><body>
<h1>5 вариантов раскладки · одна история</h1>
<p class="lead">Без плашек под текстом · без «ВАУ-ФАКТ» · без «кусок» · огромный 105 с воздухом между строками.
Выбери вариант (A–E) — зафиксируем как шаблон.</p>
<div class="story">
<strong>История: «Летающая тарелка»</strong>
<ol>
<li>Что это за мост с летающей тарелкой?</li>
<li>Живописный — капсулу задумывали как ресторан в воздухе (2007).</li>
<li>Внутрь почти не ходят — снаружи снимают все.</li>
<li><b>105</b> метров арки (масштаб без ярлыка).</li>
<li>На Зелёном кольце проезжаешь мимо + куда встать для фото.</li>
<li>Соберите отрезок → green-route.ru</li>
</ol>
<p style="margin:12px 0 0;color:#b4b4be">Полный текст: <code>docs/instagram/stories/zhivopisny-flying-saucer.md</code></p>
</div>
{''.join(cards)}
</body></html>"""
    path = ROOT / "demo-story-variants-zhivopisny.html"
    path.write_text(html, encoding="utf-8")
    print("demo →", path.relative_to(ROOT))


def main():
    for key, block in COPY.items():
        for t in block.values():
            assert_no_banned(t, f"slide{key}")
        assert "ВАУ" not in str(block).upper() or key != 4

    ultra = load("bridge-ultra-pano.jpg")
    detail = load("bridge-detail.jpg")
    strip = seamless_strip(ultra, 3, focus_y=0.36)
    results = []
    for v in VARIANTS:
        print(f"=== Variant {v.id}: {v.name} ===")
        results.append(render_variant(v, strip, detail))
    write_compare_html(results)
    (OUT_ROOT / "index.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print("done →", OUT_ROOT)


if __name__ == "__main__":
    main()

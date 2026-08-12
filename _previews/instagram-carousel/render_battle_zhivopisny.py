#!/usr/bin/env python3
"""One battle-ready Instagram carousel: Живописный мост.

Artistic overlays + auto contrast (contrast.py). Output: export/battle-zhivopisny/
"""
from __future__ import annotations

import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps

from contrast import audit_labels, contrast_ratio, ensure_contrast, sample_region

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
OUT = ROOT / "export" / "battle-zhivopisny"
W, H = 1080, 1350

GREEN = (31, 143, 74)
CREAM = (244, 244, 245)
DARK = (12, 14, 12)
WARM = (255, 176, 96)  # brighter than #e67e22 — better on dark scrims
GOLD = (232, 196, 96)
MUTED = (180, 186, 180)

FONT_BLACK = "/System/Library/Fonts/Supplemental/Arial Black.ttf"
FONT_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FONT_REG = "/System/Library/Fonts/Supplemental/Arial.ttf"


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


def wrap(draw: ImageDraw.ImageDraw, text: str, fnt, max_w: int) -> list[str]:
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


def text_block_size(draw, text, fnt, max_w, line_gap=1.08) -> tuple[int, int]:
    lines = wrap(draw, text, fnt, max_w)
    lh = int(fnt.size * line_gap)
    tw = max((draw.textlength(l, font=fnt) for l in lines), default=0)
    return int(tw), len(lines) * lh


def draw_lines(draw, text, xy, fnt, fill, max_w, line_gap=1.08, shadow=True) -> int:
    x, y = xy
    lines = wrap(draw, text, fnt, max_w)
    lh = int(fnt.size * line_gap)
    for i, line in enumerate(lines):
        yy = y + i * lh
        if shadow:
            draw.text((x + 2, yy + 3), line, font=fnt, fill=(0, 0, 0, 200))
        draw.text((x, yy), line, font=fnt, fill=fill)
    return y + len(lines) * lh


def draw_safe_text(
    base: Image.Image,
    text: str,
    xy: tuple[int, int],
    fnt,
    prefer_fg: tuple[int, int, int],
    max_w: int,
    *,
    label: str,
    line_gap=1.08,
    audit: list,
) -> tuple[Image.Image, int]:
    """Measure bbox → ensure contrast → draw. Returns (img, y_after)."""
    probe = ImageDraw.Draw(base)
    tw, th = text_block_size(probe, text, fnt, max_w, line_gap)
    x, y = xy
    box = (x, y, x + max(tw, 40), y + max(th, fnt.size))
    img, fg, report = ensure_contrast(base, box, prefer_fg, large_text=fnt.size >= 36)
    audit.append(f"{label}: {report.worst_ratio:.2f}:1 {'OK' if report.passes else report.fix}")
    d = ImageDraw.Draw(img, "RGBA")
    y2 = draw_lines(d, text, xy, fnt, fg, max_w, line_gap=line_gap)
    return img, y2


def chip_zkm(draw, xy=(48, 44)):
    x, y = xy
    draw.rounded_rectangle((x, y, x + 118, y + 52), radius=12, fill=GREEN)
    draw.text((x + 22, y + 10), "ЗКМ", font=font(FONT_BOLD, 28), fill=(255, 255, 255))


def frame_corners(draw, inset=36, length=70, color=(*CREAM, 90), width=3):
    x0, y0, x1, y1 = inset, inset, W - inset, H - inset
    for (ax, ay, dx, dy) in [
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


def accent_bar(draw, x, y, h=120, color=GREEN):
    draw.rectangle((x, y, x + 10, y + h), fill=color)


def ring_glyph(draw, cx, cy, r=100):
    for rad, a in [(r, 55), (int(r * 0.78), 140), (int(r * 0.55), 55)]:
        draw.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], outline=(*GREEN, a), width=8)
    draw.ellipse([cx - 14, cy - 14, cx + 14, cy + 14], fill=(*WARM, 255))
    # tiny path dash
    draw.arc([cx - r - 30, cy - r - 30, cx + r + 30, cy + r + 30], 210, 330, fill=(*CREAM, 70), width=3)


def swipe_pill(draw, y=1195):
    draw.rounded_rectangle((W - 230, y, W - 48, y + 58), radius=29, fill=(255, 255, 255, 235))
    draw.text((W - 205, y + 14), "свайп  →", font=font(FONT_BOLD, 28), fill=DARK)


def watermark(draw):
    draw.text((W - 292, 40), "green-route.ru", font=font(FONT_REG, 26), fill=(*MUTED, 200))


def save(img: Image.Image, idx: int):
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"slide-{idx:02d}.jpg"
    film_grain(img).save(path, "JPEG", quality=93, optimize=True)
    print("wrote", path.relative_to(ROOT))


def main():
    audit_all: dict[str, list[str]] = {}
    ultra = load("bridge-ultra-pano.jpg")
    detail = load("bridge-detail.jpg")
    strip = seamless_strip(ultra, 3, focus_y=0.36)

    # ========== 1 HOOK ==========
    s = slice_strip(strip, 0).convert("RGBA")
    # soft bottom veil for text zone
    veil = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    vd = ImageDraw.Draw(veil)
    for y in range(680, H):
        t = (y - 680) / (H - 680)
        vd.line([(0, y), (W, y)], fill=(8, 10, 8, int(40 + 170 * t**1.2)))
    s = Image.alpha_composite(s, veil)
    d = ImageDraw.Draw(s, "RGBA")
    frame_corners(d)
    chip_zkm(d)
    accent_bar(d, 48, 700, 200, GREEN)
    audit: list[str] = []
    s_rgb = s.convert("RGB")
    s_rgb, y = draw_safe_text(
        s_rgb,
        "Мост с «тарелкой» на красной арке",
        (72, 720),
        font(FONT_BLACK, 72),
        CREAM,
        W - 140,
        label="hook",
        audit=audit,
        line_gap=1.04,
    )
    s_rgb, _ = draw_safe_text(
        s_rgb,
        "Свайпни — 105 метров чистого вау",
        (72, y + 16),
        font(FONT_BOLD, 34),
        WARM,
        W - 140,
        label="hook_sub",
        audit=audit,
    )
    d = ImageDraw.Draw(s_rgb, "RGBA")
    swipe_pill(d)
    # progress 01/06
    d.text((48, 1260), "01 / 06", font=font(FONT_BOLD, 24), fill=(*MUTED, 220))
    audit_all["01"] = audit
    save(s_rgb, 1)

    # ========== 2 PLACE (seam) ==========
    s = slice_strip(strip, 1).convert("RGBA")
    veil = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    vd = ImageDraw.Draw(veil)
    for y in range(820, H):
        t = (y - 820) / (H - 820)
        vd.line([(0, y), (W, y)], fill=(8, 10, 8, int(30 + 190 * t)))
    s = Image.alpha_composite(s, veil)
    # geometric diagonal slash
    gd = ImageDraw.Draw(s, "RGBA")
    gd.polygon([(0, 1100), (220, 820), (260, 820), (40, 1100)], fill=(*GREEN, 35))
    frame_corners(gd, color=(*CREAM, 70))
    audit = []
    s_rgb = s.convert("RGB")
    d = ImageDraw.Draw(s_rgb, "RGBA")
    watermark(d)
    s_rgb, y = draw_safe_text(
        s_rgb,
        "ЧТО ЭТО",
        (48, 860),
        font(FONT_BOLD, 28),
        GOLD,
        400,
        label="kicker",
        audit=audit,
    )
    s_rgb, _ = draw_safe_text(
        s_rgb,
        "Живописный мост у Серебряного Бора. Вантовая арка и капсула в воздухе.",
        (48, y + 12),
        font(FONT_BLACK, 48),
        CREAM,
        W - 96,
        label="body",
        audit=audit,
    )
    d = ImageDraw.Draw(s_rgb, "RGBA")
    d.text((48, 1260), "02 / 06", font=font(FONT_BOLD, 24), fill=(*MUTED, 220))
    audit_all["02"] = audit
    save(s_rgb, 2)

    # ========== 3 DETAIL ==========
    s = slice_strip(strip, 2).convert("RGBA")
    veil = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    vd = ImageDraw.Draw(veil)
    for y in range(860, H):
        t = (y - 860) / (H - 860)
        vd.line([(0, y), (W, y)], fill=(8, 10, 8, int(40 + 180 * t)))
    s = Image.alpha_composite(s, veil)
    gd = ImageDraw.Draw(s, "RGBA")
    # camera reticle
    cx, cy = W - 180, 280
    gd.ellipse([cx - 70, cy - 70, cx + 70, cy + 70], outline=(*CREAM, 100), width=3)
    gd.line([(cx - 90, cy), (cx - 40, cy)], fill=(*WARM, 200), width=3)
    gd.line([(cx + 40, cy), (cx + 90, cy)], fill=(*WARM, 200), width=3)
    gd.line([(cx, cy - 90), (cx, cy - 40)], fill=(*WARM, 200), width=3)
    gd.line([(cx, cy + 40), (cx, cy + 90)], fill=(*WARM, 200), width=3)
    audit = []
    s_rgb = s.convert("RGB")
    d = ImageDraw.Draw(s_rgb, "RGBA")
    watermark(d)
    s_rgb, y = draw_safe_text(
        s_rgb,
        "КУДА ВСТАТЬ",
        (48, 900),
        font(FONT_BOLD, 28),
        WARM,
        500,
        label="kicker",
        audit=audit,
    )
    s_rgb, _ = draw_safe_text(
        s_rgb,
        "Набережная или Серебряный Бор на закате. Либо с линии Зелёного кольца.",
        (48, y + 12),
        font(FONT_BLACK, 46),
        CREAM,
        W - 96,
        label="body",
        audit=audit,
    )
    d = ImageDraw.Draw(s_rgb, "RGBA")
    d.text((48, 1260), "03 / 06", font=font(FONT_BOLD, 24), fill=(*MUTED, 220))
    audit_all["03"] = audit
    save(s_rgb, 3)

    # ========== 4 WOW ==========
    base = ImageEnhance.Brightness(grade(cover_crop(detail, W, H, (0.55, 0.4)))).enhance(0.42)
    s = base.convert("RGBA")
    # big translucent "105" watermark
    big = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    bd = ImageDraw.Draw(big)
    bd.text((40, 200), "105", font=font(FONT_BLACK, 340), fill=(255, 255, 255, 28))
    s = Image.alpha_composite(s, big)
    gd = ImageDraw.Draw(s, "RGBA")
    frame_corners(gd)
    accent_bar(gd, 48, 420, 280, WARM)
    audit = []
    s_rgb = s.convert("RGB")
    d = ImageDraw.Draw(s_rgb, "RGBA")
    watermark(d)
    s_rgb, y = draw_safe_text(
        s_rgb,
        "ВАУ-ФАКТ",
        (72, 420),
        font(FONT_BOLD, 30),
        WARM,
        400,
        label="kicker",
        audit=audit,
    )
    s_rgb, y = draw_safe_text(
        s_rgb,
        "105",
        (64, y + 8),
        font(FONT_BLACK, 200),
        CREAM,
        900,
        label="number",
        audit=audit,
        line_gap=1.0,
    )
    s_rgb, y = draw_safe_text(
        s_rgb,
        "метров арки",
        (72, y - 10),
        font(FONT_BLACK, 52),
        CREAM,
        W - 140,
        label="unit",
        audit=audit,
    )
    s_rgb, y = draw_safe_text(
        s_rgb,
        "72 ванты · пролёт 409,5 м · открыт 2007",
        (72, y + 20),
        font(FONT_BOLD, 32),
        GOLD,
        W - 140,
        label="stats",
        audit=audit,
    )
    s_rgb, _ = draw_safe_text(
        s_rgb,
        "Источник: Wikipedia «Живописный мост»",
        (72, y + 28),
        font(FONT_REG, 24),
        MUTED,
        W - 140,
        label="source",
        audit=audit,
    )
    d = ImageDraw.Draw(s_rgb, "RGBA")
    d.text((48, 1260), "04 / 06", font=font(FONT_BOLD, 24), fill=(*MUTED, 220))
    audit_all["04"] = audit
    save(s_rgb, 4)

    # ========== 5 ON RING ==========
    base = ImageEnhance.Brightness(grade(cover_crop(detail, W, H, (0.35, 0.55)))).enhance(0.4)
    s = base.convert("RGBA")
    gd = ImageDraw.Draw(s, "RGBA")
    ring_glyph(gd, W - 200, 360, 110)
    # route dashes
    for i in range(8):
        ang = math.radians(200 + i * 18)
        x0 = W - 200 + int(math.cos(ang) * 150)
        y0 = 360 + int(math.sin(ang) * 150)
        x1 = W - 200 + int(math.cos(ang) * 175)
        y1 = 360 + int(math.sin(ang) * 175)
        gd.line([(x0, y0), (x1, y1)], fill=(*GREEN, 160), width=4)
    frame_corners(gd, color=(*GREEN, 80))
    audit = []
    s_rgb = s.convert("RGB")
    d = ImageDraw.Draw(s_rgb, "RGBA")
    watermark(d)
    s_rgb, y = draw_safe_text(
        s_rgb,
        "НА ЗЕЛЁНОМ КОЛЬЦЕ",
        (48, 820),
        font(FONT_BOLD, 28),
        GREEN,
        W - 96,
        label="kicker",
        audit=audit,
    )
    s_rgb, _ = draw_safe_text(
        s_rgb,
        "Собери кусок мимо моста — не обязательно весь круг.",
        (48, y + 14),
        font(FONT_BLACK, 48),
        CREAM,
        W - 96,
        label="body",
        audit=audit,
    )
    d = ImageDraw.Draw(s_rgb, "RGBA")
    d.text((48, 1260), "05 / 06", font=font(FONT_BOLD, 24), fill=(*MUTED, 220))
    audit_all["05"] = audit
    save(s_rgb, 5)

    # ========== 6 CTA ==========
    base = ImageEnhance.Brightness(grade(cover_crop(detail, W, H))).enhance(0.28)
    s = base.convert("RGBA")
    card = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    cd = ImageDraw.Draw(card)
    cd.rounded_rectangle((56, 360, W - 56, 1040), radius=36, fill=(12, 14, 12, 230))
    # green top edge
    cd.rounded_rectangle((56, 360, W - 56, 376), radius=8, fill=(*GREEN, 255))
    s = Image.alpha_composite(s, card)
    gd = ImageDraw.Draw(s, "RGBA")
    ring_glyph(gd, W // 2, 520, 70)
    audit = []
    s_rgb = s.convert("RGB")
    # On dark card — text should pass without extra scrim; still run ensure
    s_rgb, y = draw_safe_text(
        s_rgb,
        "Зелёный Маршрут",
        (96, 620),
        font(FONT_BOLD, 32),
        (159, 224, 180),
        W - 200,
        label="brand",
        audit=audit,
    )
    s_rgb, y = draw_safe_text(
        s_rgb,
        "Собери кусок Зелёного кольца мимо этого моста",
        (96, y + 16),
        font(FONT_BLACK, 50),
        CREAM,
        W - 200,
        label="cta_msg",
        audit=audit,
    )
    # CTA button — audit solid fill BEFORE painting glyphs (else white text pollutes sample)
    d = ImageDraw.Draw(s_rgb, "RGBA")
    btn_fill = (22, 110, 58)  # darker green → white ≥ 4.5:1
    d.rounded_rectangle((96, 900, W - 96, 1000), radius=20, fill=btn_fill)
    r = sample_region(s_rgb, (120, 920, W - 120, 980), (255, 255, 255), min_ratio=4.5)
    if not r.passes:
        btn_fill = (14, 80, 42)
        d.rounded_rectangle((96, 900, W - 96, 1000), radius=20, fill=btn_fill)
        r = sample_region(s_rgb, (120, 920, W - 120, 980), (255, 255, 255), min_ratio=4.5)
    d.text((W // 2 - 150, 928), "green-route.ru", font=font(FONT_BLACK, 40), fill=(255, 255, 255))
    audit.append(f"cta_btn: {r.worst_ratio:.2f}:1 {'OK' if r.passes else 'FAIL'}")
    d.text((48, 1260), "06 / 06", font=font(FONT_BOLD, 24), fill=(*MUTED, 220))
    audit_all["06"] = audit
    save(s_rgb, 6)

    report_path = OUT / "contrast-audit.json"
    report_path.write_text(json.dumps(audit_all, ensure_ascii=False, indent=2), encoding="utf-8")
    print("audit →", report_path.relative_to(ROOT))
    for k, lines in audit_all.items():
        print(f"[{k}]", "; ".join(lines))


if __name__ == "__main__":
    main()

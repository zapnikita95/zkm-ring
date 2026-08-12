#!/usr/bin/env python3
"""Render Instagram 4:5 carousel PNGs (SCRL-style seamless) for green-route.ru demos.

Design rules baked in (2025–26 carousel guides):
- Slide 1 = hook only (≤9 words), high contrast, swipe cue, no CTA/logo spam
- ≤ ~25 words on value slides; 2 type sizes max
- Seamless panorama across early slides (SCRL cliffhanger)
- CTA only on last slide
- Brand: Зелёный Маршрут / green-route.ru
"""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
OUT = ROOT / "export"
W, H = 1080, 1350
GREEN = (31, 143, 74)
CREAM = (240, 242, 240)
DARK = (18, 20, 18)
WARM = (230, 126, 34)
GOLD = (201, 162, 39)

FONT_BLACK = "/System/Library/Fonts/Supplemental/Arial Black.ttf"
FONT_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FONT_REG = "/System/Library/Fonts/Supplemental/Arial.ttf"


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.truetype(FONT_BOLD, size)


def cover_crop(img: Image.Image, w: int, h: int) -> Image.Image:
    return ImageOps.fit(img, (w, h), method=Image.Resampling.LANCZOS, centering=(0.5, 0.45))


def load(name: str) -> Image.Image:
    return Image.open(ASSETS / name).convert("RGB")


def grade(img: Image.Image, contrast=1.12, color=1.08, sharp=1.15) -> Image.Image:
    img = ImageEnhance.Contrast(img).enhance(contrast)
    img = ImageEnhance.Color(img).enhance(color)
    img = ImageEnhance.Sharpness(img).enhance(sharp)
    return img


def vignette(img: Image.Image, strength=0.55) -> Image.Image:
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    for i in range(40):
        a = int(strength * 255 * (i / 40) ** 2)
        inset = int(i * min(img.size) / 90)
        d.rectangle([inset, inset, img.width - inset, img.height - inset], outline=(0, 0, 0, a))
    base = img.convert("RGBA")
    return Image.alpha_composite(base, overlay.filter(ImageFilter.GaussianBlur(18))).convert("RGB")


def bottom_gradient(img: Image.Image, height_ratio=0.48, alpha_top=0) -> Image.Image:
    base = img.convert("RGBA")
    g = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(g)
    y0 = int(img.height * (1 - height_ratio))
    for y in range(y0, img.height):
        t = (y - y0) / max(1, img.height - y0)
        a = int(alpha_top + (220 - alpha_top) * (t**1.35))
        d.line([(0, y), (img.width, y)], fill=(18, 20, 18, a))
    return Image.alpha_composite(base, g).convert("RGB")


def wrap_text(draw: ImageDraw.ImageDraw, text: str, fnt, max_w: int) -> list[str]:
    words = text.split()
    lines: list[str] = []
    cur = ""
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


def draw_text_block(
    draw: ImageDraw.ImageDraw,
    text: str,
    xy: tuple[int, int],
    fnt,
    fill,
    max_w: int,
    line_gap=1.12,
    shadow=True,
) -> int:
    x, y = xy
    lines = wrap_text(draw, text, fnt, max_w)
    lh = int(fnt.size * line_gap)
    for i, line in enumerate(lines):
        yy = y + i * lh
        if shadow:
            draw.text((x + 2, yy + 2), line, font=fnt, fill=(0, 0, 0, 180))
        draw.text((x, yy), line, font=fnt, fill=fill)
    return y + len(lines) * lh


def swipe_pill(draw: ImageDraw.ImageDraw, y=1180):
    # subtle cue ONLY on slide 1
    pill = (W - 210, y, W - 48, y + 56)
    draw.rounded_rectangle(pill, radius=28, fill=(255, 255, 255, 230))
    f = font(FONT_BOLD, 28)
    draw.text((W - 188, y + 12), "свайп  →", font=f, fill=DARK)


def watermark(draw: ImageDraw.ImageDraw):
    f = font(FONT_REG, 26)
    draw.text((W - 280, 36), "green-route.ru", font=f, fill=(240, 242, 240, 160))


def chip_zkm(draw: ImageDraw.ImageDraw, xy=(48, 40)):
    f = font(FONT_BOLD, 26)
    x, y = xy
    draw.rounded_rectangle((x, y, x + 110, y + 48), radius=10, fill=GREEN)
    draw.text((x + 18, y + 8), "ЗКМ", font=f, fill=(255, 255, 255))


def seamless_strip(src: Image.Image, slides: int, focus_y=0.42) -> Image.Image:
    """Ultra-wide cover for SCRL: slides * W  ×  H."""
    tw, th = slides * W, H
    # scale source to cover strip height, then crop width if needed
    scale = th / src.height
    nw, nh = int(src.width * scale), th
    if nw < tw:
        scale = tw / src.width
        nw, nh = tw, int(src.height * scale)
    resized = src.resize((nw, nh), Image.Resampling.LANCZOS)
    left = max(0, (nw - tw) // 2)
    top = max(0, int((nh - th) * focus_y))
    if top + th > nh:
        top = nh - th
    crop = resized.crop((left, top, left + tw, top + th))
    return grade(crop, contrast=1.15, color=1.1)


def slice_strip(strip: Image.Image, i: int) -> Image.Image:
    return strip.crop((i * W, 0, (i + 1) * W, H))


def save_slide(img: Image.Image, folder: Path, idx: int):
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"slide-{idx:02d}.jpg"
    img.convert("RGB").save(path, "JPEG", quality=92, optimize=True)
    print("wrote", path.relative_to(ROOT))


def render_bridge():
    out = OUT / "zhivopisny"
    ultra = load("bridge-ultra-pano.jpg")
    detail = load("bridge-detail.jpg")
    # SCRL: first 3 slides = continuous pano
    strip = seamless_strip(ultra, 3, focus_y=0.38)

    # --- 1 HOOK ---
    s1 = bottom_gradient(vignette(slice_strip(strip, 0)), 0.55)
    d = ImageDraw.Draw(s1, "RGBA")
    chip_zkm(d)
    # big hook — top 55% safe zone (Instagram UI covers bottom)
    f_hook = font(FONT_BLACK, 78)
    y = draw_text_block(
        d,
        "Мост с «тарелкой» на красной арке — в Москве",
        (48, 720),
        f_hook,
        CREAM,
        W - 96,
        line_gap=1.05,
    )
    f_sub = font(FONT_BOLD, 34)
    draw_text_block(d, "Свайпни — цифры, от которых ёкает", (48, y + 18), f_sub, (159, 224, 180), W - 96)
    swipe_pill(d, 1188)
    save_slide(s1, out, 1)

    # --- 2 CONTEXT (seam continues) ---
    s2 = bottom_gradient(slice_strip(strip, 1), 0.42)
    d = ImageDraw.Draw(s2, "RGBA")
    watermark(d)
    f_k = font(FONT_BOLD, 28)
    d.text((48, 880), "ЧТО ЭТО", font=f_k, fill=GOLD)
    draw_text_block(
        d,
        "Живописный мост у Серебряного Бора. Вантовая арка + капсула в воздухе.",
        (48, 930),
        font(FONT_BLACK, 52),
        CREAM,
        W - 96,
        line_gap=1.08,
    )
    save_slide(s2, out, 2)

    # --- 3 DETAIL / PHOTO SPOT ---
    s3 = bottom_gradient(slice_strip(strip, 2), 0.4)
    d = ImageDraw.Draw(s3, "RGBA")
    watermark(d)
    d.text((48, 900), "КУДА ВСТАТЬ", font=font(FONT_BOLD, 28), fill=WARM)
    draw_text_block(
        d,
        "Набережная или Серебряный Бор на закате. Кадр с линии Зелёного кольца.",
        (48, 950),
        font(FONT_BLACK, 48),
        CREAM,
        W - 96,
    )
    save_slide(s3, out, 3)

    # --- 4 WOW NUMBER ---
    base = cover_crop(detail, W, H)
    base = ImageEnhance.Brightness(grade(base)).enhance(0.55)
    s4 = base
    d = ImageDraw.Draw(s4, "RGBA")
    watermark(d)
    d.text((48, 380), "ВАУ-ФАКТ", font=font(FONT_BOLD, 30), fill=WARM)
    d.text((40, 460), "105", font=font(FONT_BLACK, 220), fill=CREAM)
    d.text((56, 700), "метров арки", font=font(FONT_BLACK, 56), fill=CREAM)
    draw_text_block(
        d,
        "72 ванты · пролёт 409,5 м · открыт 2007",
        (56, 780),
        font(FONT_BOLD, 36),
        (200, 230, 200),
        W - 112,
    )
    d.text((56, 980), "Источник: Wikipedia «Живописный мост»", font=font(FONT_REG, 24), fill=(180, 180, 180))
    save_slide(s4, out, 4)

    # --- 5 ON RING ---
    s5 = bottom_gradient(ImageEnhance.Brightness(grade(cover_crop(detail, W, H))).enhance(0.45), 0.5)
    d = ImageDraw.Draw(s5, "RGBA")
    watermark(d)
    # ring pin graphic
    cx, cy = W - 220, 420
    for r, a in [(120, 50), (90, 120), (60, 50)]:
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(*GREEN, a), width=10)
    d.ellipse([cx - 16, cy - 16, cx + 16, cy + 16], fill=(*WARM, 255))
    d.text((48, 780), "НА КОЛЬЦЕ", font=font(FONT_BOLD, 28), fill=GREEN)
    draw_text_block(
        d,
        "Лежит на Зелёном кольце Москвы. Собери кусок мимо моста — не весь круг.",
        (48, 840),
        font(FONT_BLACK, 48),
        CREAM,
        W - 96,
    )
    save_slide(s5, out, 5)

    # --- 6 CTA ---
    s6 = cover_crop(detail, W, H)
    s6 = ImageEnhance.Brightness(grade(s6)).enhance(0.35)
    d = ImageDraw.Draw(s6, "RGBA")
    d.rounded_rectangle((64, 420, W - 64, 980), radius=28, fill=(18, 20, 18, 220))
    d.text((96, 470), "Зелёный Маршрут", font=font(FONT_BOLD, 32), fill=(159, 224, 180))
    draw_text_block(
        d,
        "Собери кусок Зелёного кольца мимо этого моста",
        (96, 540),
        font(FONT_BLACK, 54),
        CREAM,
        W - 220,
    )
    d.rounded_rectangle((96, 820, W - 96, 920), radius=18, fill=GREEN)
    d.text((W // 2 - 140, 848), "green-route.ru", font=font(FONT_BLACK, 40), fill=(255, 255, 255))
    save_slide(s6, out, 6)


def render_aqueduct():
    out = OUT / "aqueduct"
    pano = load("aqueduct-pano.jpg")
    hero = load("aqueduct-hero.jpg")
    detail = load("aqueduct-detail.jpg")
    strip = seamless_strip(pano, 3, focus_y=0.5)

    s1 = bottom_gradient(vignette(slice_strip(strip, 0)), 0.55)
    d = ImageDraw.Draw(s1, "RGBA")
    chip_zkm(d)
    draw_text_block(
        d,
        "В Москве есть акведук XVIII века",
        (48, 760),
        font(FONT_BLACK, 78),
        CREAM,
        W - 96,
        line_gap=1.05,
    )
    draw_text_block(
        d,
        "Его зовут «Миллионный мост». Свайп →",
        (48, 1020),
        font(FONT_BOLD, 34),
        (230, 210, 150),
        W - 96,
    )
    swipe_pill(d, 1188)
    save_slide(s1, out, 1)

    s2 = bottom_gradient(slice_strip(strip, 1), 0.42)
    d = ImageDraw.Draw(s2, "RGBA")
    watermark(d)
    d.text((48, 880), "ЧТО ЭТО", font=font(FONT_BOLD, 28), fill=GOLD)
    draw_text_block(
        d,
        "Ростокинский акведук. Единственный выживший кусок первого водопровода Москвы.",
        (48, 930),
        font(FONT_BLACK, 48),
        CREAM,
        W - 96,
    )
    save_slide(s2, out, 2)

    s3 = bottom_gradient(slice_strip(strip, 2), 0.4)
    d = ImageDraw.Draw(s3, "RGBA")
    watermark(d)
    d.text((48, 900), "КАДР ДЛЯ SCRL", font=font(FONT_BOLD, 28), fill=WARM)
    draw_text_block(
        d,
        "Арки «бегут» вдоль свайпа. Вечерняя подсветка = стоп-скролл.",
        (48, 950),
        font(FONT_BLACK, 48),
        CREAM,
        W - 96,
    )
    save_slide(s3, out, 3)

    base = cover_crop(detail, W, H)
    s4 = ImageEnhance.Brightness(grade(base)).enhance(0.5)
    d = ImageDraw.Draw(s4, "RGBA")
    watermark(d)
    d.text((48, 400), "ВАУ-ФАКТ", font=font(FONT_BOLD, 30), fill=GOLD)
    d.text((48, 480), "21", font=font(FONT_BLACK, 220), fill=CREAM)
    d.text((56, 720), "арка · 356 метров", font=font(FONT_BLACK, 52), fill=CREAM)
    draw_text_block(
        d,
        "1783–1784. Самый большой каменный мост России своего времени.",
        (56, 800),
        font(FONT_BOLD, 34),
        (220, 210, 180),
        W - 112,
    )
    d.text((56, 1000), "Источник: Wikipedia «Ростокинский акведук»", font=font(FONT_REG, 24), fill=(180, 180, 180))
    save_slide(s4, out, 4)

    s5 = cover_crop(hero, W, H)
    s5 = ImageEnhance.Brightness(grade(s5)).enhance(0.4)
    d = ImageDraw.Draw(s5, "RGBA")
    watermark(d)
    d.text((48, 780), "НА КОЛЬЦЕ", font=font(FONT_BOLD, 28), fill=GREEN)
    draw_text_block(
        d,
        "Северо-восток Зелёного кольца. Старт и финиш — где тебе удобно.",
        (48, 840),
        font(FONT_BLACK, 48),
        CREAM,
        W - 96,
    )
    save_slide(s5, out, 5)

    s6 = cover_crop(hero, W, H)
    s6 = ImageEnhance.Brightness(grade(s6)).enhance(0.32)
    d = ImageDraw.Draw(s6, "RGBA")
    d.rounded_rectangle((64, 420, W - 64, 980), radius=28, fill=(18, 20, 18, 220))
    d.text((96, 470), "Зелёный Маршрут", font=font(FONT_BOLD, 32), fill=(159, 224, 180))
    draw_text_block(
        d,
        "Не весь круг: выбери старт и финиш сам — мимо акведука",
        (96, 540),
        font(FONT_BLACK, 50),
        CREAM,
        W - 220,
    )
    d.rounded_rectangle((96, 820, W - 96, 920), radius=18, fill=GREEN)
    d.text((W // 2 - 140, 848), "green-route.ru", font=font(FONT_BLACK, 40), fill=(255, 255, 255))
    save_slide(s6, out, 6)


if __name__ == "__main__":
    render_bridge()
    render_aqueduct()
    print("DONE")

#!/usr/bin/env python3
"""Render layout variants per carousel ROLE (R1–R6 × A–D) on Zhivopisny media.

Output: export/role-layout-variants/R{n}/R{n}-{letter}.jpg
Open: demo-role-layout-variants.html
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFont

from graphics import cover_crop_strict, isometric_football_pitch, paste_rgba
from layout_templates import assert_no_banned
from role_layout_zones import PREFERRED_PHOTO, PREFERRED_VIDEO, assert_mix

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
OUT = ROOT / "export" / "role-layout-variants"
W, H = 1080, 1350

GREEN = (31, 143, 74)
CREAM = (244, 244, 245)
WARM = (255, 200, 130)
GOLD = (255, 214, 160)
MUTED = (190, 195, 190)
INK = (18, 22, 18)
DARK = (0, 0, 0, 200)

FONT_BLACK = "/System/Library/Fonts/Supplemental/Arial Black.ttf"
FONT_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FONT_REG = "/System/Library/Fonts/Supplemental/Arial.ttf"
BAR_X, BAR_W, GAP = 48, 10, 32
TEXT_X = BAR_X + BAR_W + GAP

# Copy frozen per role (same words, different layouts)
COPY = {
    1: {
        "title": "Что это за мост с летающей тарелкой?",
        "title_alt": "Над Москвой-рекой висит летающая тарелка",
    },
    2: {
        "title": "Живописный мост",
        "body": "Капсулу под красной аркой задумывали как ресторан в воздухе — с видом на Москву-реку и Серебряный Бор. Мост открыли в 2007 году, и с тех пор его силуэт узнают даже те, кто не помнит название.",
    },
    3: {
        "title": "Капсула закрыта",
        "body": "Публику внутрь так и не пустили — планы менялись, доступ не открыли. Зато снаружи это одна из самых желанных точек для фото: «тарелка» держит кадр сама.",
    },
    4: {
        "num": "105",
        "label": "метров высоты арки",
        "body": "Это примерно длина футбольного поля — только вверх.",
        "src": "Пролёт 409,5 м · Wikipedia",
    },
    5: {
        "title": "Веломаршрут рядом",
        "body": "Этот мост видно при прогулке по Зелёному кольцу — маршруту мимо десятков парков и достопримечательностей Москвы. Соберите свой отрезок.",
    },
    6: {
        "brand": "Зелёный Маршрут",
        "offer": "Постройте интересный маршрут по Зелёному кольцу",
        "btn": "green-route.ru",
    },
}


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.truetype(FONT_BOLD, size)


def load(name: str) -> Image.Image:
    return Image.open(ASSETS / name).convert("RGB")


def cover(img: Image.Image, w=W, h=H, center=(0.5, 0.42)) -> Image.Image:
    return cover_crop_strict(img, w, h, center)


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


def stroke(draw, text, xy, fnt, fill, max_w, *, line_gap=1.12, sw=5, align="left") -> int:
    assert_no_banned(text)
    x, y = xy
    lines = wrap(draw, text, fnt, max_w)
    lh = int(fnt.size * line_gap)
    for i, line in enumerate(lines):
        yy = y + i * lh
        lx = x
        if align == "center":
            lx = x + (max_w - int(draw.textlength(line, font=fnt))) // 2
        elif align == "right":
            lx = x + max_w - int(draw.textlength(line, font=fnt))
        for dx, dy in (
            (-sw, 0), (sw, 0), (0, -sw), (0, sw),
            (-sw, -sw), (sw, sw), (-sw, sw), (sw, -sw),
        ):
            draw.text((lx + dx, yy + dy), line, font=fnt, fill=DARK)
        draw.text((lx, yy), line, font=fnt, fill=fill)
    return y + len(lines) * lh


def ink(draw, text, xy, fnt, max_w, *, line_gap=1.14, hw=3, align="left") -> int:
    assert_no_banned(text)
    x, y = xy
    lines = wrap(draw, text, fnt, max_w)
    lh = int(fnt.size * line_gap)
    halo = (255, 255, 255, 235)
    for i, line in enumerate(lines):
        yy = y + i * lh
        lx = x
        if align == "center":
            lx = x + (max_w - int(draw.textlength(line, font=fnt))) // 2
        elif align == "right":
            lx = x + max_w - int(draw.textlength(line, font=fnt))
        for dx, dy in (
            (-hw, 0), (hw, 0), (0, -hw), (0, hw),
            (-hw, -hw), (hw, hw), (-hw, hw), (hw, -hw),
        ):
            draw.text((lx + dx, yy + dy), line, font=fnt, fill=halo)
        draw.text((lx, yy), line, font=fnt, fill=(*INK, 255))
    return y + len(lines) * lh


def bar(draw, x, y, h, color=GREEN):
    draw.rectangle((x, y, x + BAR_W, y + h), fill=(*color, 255))


def corners(draw, color=(*CREAM, 80)):
    inset, length, width = 36, 64, 3
    x0, y0, x1, y1 = inset, inset, W - inset, H - inset
    for ax, ay, dx, dy in [
        (x0, y0, 1, 0), (x0, y0, 0, 1), (x1, y0, -1, 0), (x1, y0, 0, 1),
        (x0, y1, 1, 0), (x0, y1, 0, -1), (x1, y1, -1, 0), (x1, y1, 0, -1),
    ]:
        draw.line([(ax, ay), (ax + dx * length, ay + dy * length)], fill=color, width=width)


def chip(draw):
    draw.rounded_rectangle((48, 44, 166, 96), radius=12, fill=(*GREEN, 255))
    draw.text((70, 54), "ЗКМ", font=font(FONT_BOLD, 28), fill=(255, 255, 255, 255))


def watermark(draw):
    draw.text((W - 292, 40), "green-route.ru", font=font(FONT_REG, 24), fill=(*MUTED, 220))


def badge(draw, label: str):
    draw.rounded_rectangle((36, 36, 36 + 12 + int(draw.textlength(label, font=font(FONT_BOLD, 20))), 72), radius=8, fill=(0, 0, 0, 160))
    draw.text((42, 44), label, font=font(FONT_BOLD, 20), fill=(134, 239, 172, 255))


def veil_bottom(s: Image.Image, start: int, strength=150) -> Image.Image:
    v = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(v)
    for y in range(start, H):
        t = (y - start) / max(1, H - start)
        d.line([(0, y), (W, y)], fill=(8, 10, 8, int(strength * (t**1.15))))
    return Image.alpha_composite(s.convert("RGBA"), v)


def veil_top(s: Image.Image, end: int, strength=155) -> Image.Image:
    v = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(v)
    for y in range(0, end):
        t = 1 - y / max(1, end)
        d.line([(0, y), (W, y)], fill=(8, 10, 8, int(strength * (t**1.1))))
    return Image.alpha_composite(s.convert("RGBA"), v)


def veil_mid(s: Image.Image, y0: int, y1: int, strength=140) -> Image.Image:
    v = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(v)
    mid = (y0 + y1) / 2
    half = max(1, (y1 - y0) / 2)
    for y in range(y0, y1):
        t = 1 - abs(y - mid) / half
        d.line([(0, y), (W, y)], fill=(8, 10, 8, int(strength * (t**1.05))))
    return Image.alpha_composite(s.convert("RGBA"), v)


def collage_two(a: Image.Image, b: Image.Image) -> Image.Image:
    top_h = int(H * 0.62)
    gap = 8
    half = (W - gap) // 2
    canvas = Image.new("RGB", (W, H), (18, 22, 18))
    canvas.paste(cover(a, half, top_h, (0.55, 0.35)), (0, 0))
    canvas.paste(cover(b, W - half - gap, top_h, (0.45, 0.4)), (half + gap, 0))
    return canvas


def collage_quad(a, b, c, d) -> Image.Image:
    canvas = Image.new("RGB", (W, H), (14, 16, 14))
    gap = 6
    hw, hh = (W - gap) // 2, (H - gap) // 2
    for im, x, y, ctr in [
        (a, 0, 0, (0.5, 0.35)),
        (b, hw + gap, 0, (0.6, 0.4)),
        (c, 0, hh + gap, (0.4, 0.45)),
        (d, hw + gap, hh + gap, (0.5, 0.5)),
    ]:
        canvas.paste(cover(im, hw, hh, ctr), (x, y))
    return canvas


def save(role: int, letter: str, img: Image.Image):
    folder = OUT / f"R{role}"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"R{role}-{letter}.jpg"
    img.convert("RGB").save(path, "JPEG", quality=90, optimize=True)
    print("wrote", path.relative_to(ROOT))


def ensure_map() -> Image.Image:
    p = ASSETS / "map-park-krylatskoe-bridge.png"
    if not p.exists():
        from bake_instagram_poi_map import bake

        bake("park-krylatskoe-bridge")
    return cover(load("map-park-krylatskoe-bridge.png"), W, H, (0.5, 0.5))


def render_r1(ultra, detail):
    c = COPY[1]
    # A bottom-left
    s = veil_bottom(cover(ultra, center=(0.42, 0.38)), 640)
    d = ImageDraw.Draw(s, "RGBA")
    corners(d)
    chip(d)
    badge(d, "R1-A")
    ty = 720
    bar(d, BAR_X, ty - 8, 200)
    stroke(d, c["title"], (TEXT_X, ty), font(FONT_BLACK, 60), CREAM, W - TEXT_X - 48, sw=6, line_gap=1.05)
    save(1, "A", s)

    # B top-left
    s = cover(ultra, center=(0.5, 0.55)).convert("RGBA")
    d = ImageDraw.Draw(s, "RGBA")
    corners(d)
    chip(d)
    badge(d, "R1-B")
    ty = 160
    bar(d, BAR_X, ty - 4, 180)
    stroke(d, c["title"], (TEXT_X, ty), font(FONT_BLACK, 56), CREAM, W - TEXT_X - 48, sw=5, line_gap=1.05)
    save(1, "B", s)

    # C bottom-center
    s = veil_bottom(cover(detail, center=(0.6, 0.3)), 700, 170)
    d = ImageDraw.Draw(s, "RGBA")
    corners(d)
    badge(d, "R1-C")
    stroke(d, c["title"], (64, 880), font(FONT_BLACK, 54), CREAM, W - 128, sw=6, align="center", line_gap=1.06)
    save(1, "C", s)

    # D top-center assertion
    s = cover(ultra, center=(0.45, 0.4)).convert("RGBA")
    d = ImageDraw.Draw(s, "RGBA")
    corners(d)
    badge(d, "R1-D")
    y = stroke(d, c["title_alt"], (80, 140), font(FONT_BLACK, 48), CREAM, W - 160, sw=5, align="center", line_gap=1.08)
    d.rectangle((W // 2 - 120, y + 16, W // 2 + 120, y + 22), fill=(*GREEN, 255))
    save(1, "D", s)


def render_r2(detail, pano, ultra):
    """R2 pool: after bottom R1, text must sit top / mid — not another bottom stack.

    A верх-лево · B верх-право · C центр · D коллаж+текст сверху · E низ-лево (только после top R1)
    """
    c = COPY[2]

    # A top-left full stack
    s = veil_top(cover(detail, center=(0.55, 0.42)), 720, 165)
    d = ImageDraw.Draw(s, "RGBA")
    corners(d)
    watermark(d)
    badge(d, "R2-A")
    ty = 110
    bar(d, BAR_X, ty, 200)
    y = stroke(d, c["title"], (TEXT_X, ty), font(FONT_BLACK, 48), CREAM, W - TEXT_X - 48, sw=5)
    stroke(d, c["body"], (TEXT_X, y + 20), font(FONT_BOLD, 28), CREAM, W - TEXT_X - 48, sw=3, line_gap=1.14)
    save(2, "A", s)

    # B top-right full stack
    s = veil_top(cover(pano, center=(0.4, 0.4)), 720, 165)
    d = ImageDraw.Draw(s, "RGBA")
    corners(d)
    watermark(d)
    badge(d, "R2-B")
    max_w = 620
    tx = W - 48 - max_w
    bar(d, W - 48 - BAR_W, 110, 200, GREEN)
    y = stroke(d, c["title"], (tx, 120), font(FONT_BLACK, 46), CREAM, max_w - 16, sw=5, align="right")
    stroke(d, c["body"], (tx, y + 18), font(FONT_BOLD, 26), CREAM, max_w - 16, sw=3, line_gap=1.14, align="right")
    save(2, "B", s)

    # C center stack
    s = veil_mid(cover(ultra, center=(0.48, 0.42)), 380, 980, 155)
    d = ImageDraw.Draw(s, "RGBA")
    corners(d)
    watermark(d)
    badge(d, "R2-C")
    max_w = W - 160
    y = stroke(d, c["title"], (80, 460), font(FONT_BLACK, 48), CREAM, max_w, sw=5, align="center")
    stroke(d, c["body"], (80, y + 22), font(FONT_BOLD, 28), CREAM, max_w, sw=3, line_gap=1.14, align="center")
    save(2, "C", s)

    # D collage + TOP text band (photos below — not bottom twin of R1-A)
    band_h = int(H * 0.40)
    photo_h = H - band_h
    gap = 8
    half = (W - gap) // 2
    canvas = Image.new("RGB", (W, H), (12, 14, 12))
    canvas.paste(cover(detail, half, photo_h, (0.55, 0.35)), (0, band_h))
    canvas.paste(cover(pano, W - half - gap, photo_h, (0.45, 0.4)), (half + gap, band_h))
    s = canvas.convert("RGBA")
    band = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    bd = ImageDraw.Draw(band)
    bd.rectangle((0, 0, W, band_h), fill=(12, 14, 12, 235))
    bd.rectangle((0, band_h - 6, W, band_h), fill=(*GREEN, 255))
    s = Image.alpha_composite(s, band)
    d = ImageDraw.Draw(s, "RGBA")
    watermark(d)
    badge(d, "R2-D")
    y0 = 56
    bar(d, BAR_X, y0 + 8, 160)
    y = stroke(d, c["title"], (TEXT_X, y0), font(FONT_BLACK, 46), CREAM, W - TEXT_X - 48, sw=4)
    stroke(d, c["body"], (TEXT_X, y + 16), font(FONT_BOLD, 26), CREAM, W - TEXT_X - 48, sw=3, line_gap=1.12)
    save(2, "D", s)

    # E bottom-left — pair with top R1 only
    s = veil_bottom(cover(detail, center=(0.7, 0.35)), 720, 165)
    d = ImageDraw.Draw(s, "RGBA")
    corners(d)
    watermark(d)
    badge(d, "R2-E")
    ty = 780
    bar(d, BAR_X, ty, 220)
    y = stroke(d, c["title"], (TEXT_X, ty), font(FONT_BLACK, 48), CREAM, W - TEXT_X - 48, sw=5)
    stroke(d, c["body"], (TEXT_X, y + 20), font(FONT_BOLD, 28), CREAM, W - TEXT_X - 48, sw=3, line_gap=1.14)
    save(2, "E", s)


def render_r3(detail, pano, ultra, hero):
    c = COPY[3]
    # A top-right
    s = ImageEnhance.Brightness(cover(detail, center=(0.55, 0.4))).enhance(0.85).convert("RGBA")
    veil = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    vd = ImageDraw.Draw(veil)
    for yv in range(0, 520):
        t = 1 - yv / 520
        vd.line([(W // 3, yv), (W, yv)], fill=(8, 10, 8, int(130 * (t**1.2))))
    s = Image.alpha_composite(s, veil)
    d = ImageDraw.Draw(s, "RGBA")
    corners(d, (*WARM, 90))
    watermark(d)
    badge(d, "R3-A")
    max_w = 560
    tx = W - 48 - max_w
    bar(d, W - 48 - BAR_W, 120, 240, WARM)
    y = stroke(d, c["title"], (tx, 130), font(FONT_BLACK, 48), CREAM, max_w - 16, sw=5, align="right")
    stroke(d, c["body"], (tx, y + 24), font(FONT_BOLD, 28), GOLD, max_w - 16, sw=3, line_gap=1.14, align="right")
    save(3, "A", s)

    # B bottom-left warm
    s = veil_bottom(cover(pano, center=(0.5, 0.5)), 700, 160)
    d = ImageDraw.Draw(s, "RGBA")
    corners(d, (*WARM, 90))
    watermark(d)
    badge(d, "R3-B")
    ty = 780
    bar(d, BAR_X, ty, 240, WARM)
    y = stroke(d, c["title"], (TEXT_X, ty), font(FONT_BLACK, 48), CREAM, W - TEXT_X - 48, sw=5)
    stroke(d, c["body"], (TEXT_X, y + 22), font(FONT_BOLD, 28), GOLD, W - TEXT_X - 48, sw=3, line_gap=1.14)
    save(3, "B", s)

    # C collage quad
    s = ImageEnhance.Brightness(collage_quad(pano, detail, hero, ultra)).enhance(0.75).convert("RGBA")
    d = ImageDraw.Draw(s, "RGBA")
    corners(d)
    watermark(d)
    badge(d, "R3-C")
    y = stroke(d, c["title"], (48, 100), font(FONT_BLACK, 46), CREAM, 600, sw=5)
    stroke(d, c["body"], (48, y + 20), font(FONT_BOLD, 26), GOLD, 620, sw=3, line_gap=1.14)
    save(3, "C", s)

    # D bottom-center
    s = veil_bottom(cover(ultra, center=(0.5, 0.35)), 780, 170)
    d = ImageDraw.Draw(s, "RGBA")
    corners(d)
    watermark(d)
    badge(d, "R3-D")
    y = stroke(d, c["title"], (64, 860), font(FONT_BLACK, 50), CREAM, W - 128, sw=5, align="center")
    stroke(d, c["body"], (64, y + 20), font(FONT_BOLD, 28), GOLD, W - 128, sw=3, line_gap=1.14, align="center")
    save(3, "D", s)


def render_r4(detail):
    c = COPY[4]
    pitch = isometric_football_pitch(480)

    def base():
        b = ImageEnhance.Brightness(cover(detail, center=(0.72, 0.28))).enhance(0.78)
        return ImageEnhance.Contrast(b).enhance(1.2).convert("RGBA")

    # A left + icon right
    s = paste_rgba(base(), pitch, (W - 380, H - 560))
    d = ImageDraw.Draw(s, "RGBA")
    corners(d)
    watermark(d)
    badge(d, "R4-A")
    bar(d, BAR_X, 200, 340, WARM)
    stroke(d, c["num"], (TEXT_X, 180), font(FONT_BLACK, 240), CREAM, 500, sw=8, line_gap=1.0)
    y = 180 + 260
    y = stroke(d, c["label"], (TEXT_X, y), font(FONT_BLACK, 44), CREAM, 500, sw=4)
    y = stroke(d, c["body"], (TEXT_X, y + 28), font(FONT_BOLD, 30), GOLD, 480, sw=3, line_gap=1.12)
    stroke(d, c["src"], (TEXT_X, y + 20), font(FONT_REG, 24), MUTED, 480, sw=2)
    save(4, "A", s)

    # B center number
    s = base()
    d = ImageDraw.Draw(s, "RGBA")
    corners(d)
    watermark(d)
    badge(d, "R4-B")
    stroke(d, c["num"], (90, 280), font(FONT_BLACK, 280), CREAM, W - 180, sw=8, align="center", line_gap=1.0)
    y = 280 + 300
    y = stroke(d, c["label"], (90, y), font(FONT_BLACK, 44), CREAM, W - 180, sw=4, align="center")
    stroke(d, c["body"], (90, y + 28), font(FONT_BOLD, 32), GOLD, W - 180, sw=3, align="center")
    save(4, "B", s)

    # C top number + icon bottom
    s = paste_rgba(base(), pitch, ((W - pitch.width) // 2, H - 520))
    d = ImageDraw.Draw(s, "RGBA")
    corners(d)
    watermark(d)
    badge(d, "R4-C")
    stroke(d, c["num"], (TEXT_X, 100), font(FONT_BLACK, 200), CREAM, 700, sw=7, line_gap=1.0)
    y = stroke(d, c["label"], (TEXT_X, 320), font(FONT_BLACK, 42), CREAM, 700, sw=4)
    stroke(d, c["body"] + " " + c["src"], (TEXT_X, y + 24), font(FONT_BOLD, 28), GOLD, 700, sw=3, line_gap=1.12)
    save(4, "C", s)

    # D right text + icon left
    s = paste_rgba(base(), pitch, (40, H - 560))
    d = ImageDraw.Draw(s, "RGBA")
    corners(d)
    watermark(d)
    badge(d, "R4-D")
    max_w = 520
    tx = W - 48 - max_w
    bar(d, W - 48 - BAR_W, 180, 360, WARM)
    stroke(d, c["num"], (tx, 160), font(FONT_BLACK, 200), CREAM, max_w, sw=7, align="right", line_gap=1.0)
    y = 160 + 220
    y = stroke(d, c["label"], (tx, y), font(FONT_BLACK, 40), CREAM, max_w, sw=4, align="right")
    stroke(d, c["body"], (tx, y + 24), font(FONT_BOLD, 28), GOLD, max_w, sw=3, align="right", line_gap=1.12)
    save(4, "D", s)


def render_r5(mapa):
    c = COPY[5]
    # A top-left ink
    s = mapa.convert("RGBA")
    d = ImageDraw.Draw(s, "RGBA")
    corners(d, (*GREEN, 120))
    watermark(d)
    badge(d, "R5-A")
    bar(d, BAR_X, 120, 260)
    y = ink(d, c["title"], (TEXT_X, 128), font(FONT_BLACK, 48), W - TEXT_X - 48)
    ink(d, c["body"], (TEXT_X, y + 28), font(FONT_BOLD, 28), W - TEXT_X - 48, line_gap=1.14, hw=2)
    save(5, "A", s)

    # B bottom band
    s = mapa.convert("RGBA")
    band = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    bd = ImageDraw.Draw(band)
    bd.rectangle((0, int(H * 0.68), W, H), fill=(12, 14, 12, 230))
    bd.rectangle((0, int(H * 0.68), W, int(H * 0.68) + 5), fill=(*GREEN, 255))
    s = Image.alpha_composite(s, band)
    d = ImageDraw.Draw(s, "RGBA")
    watermark(d)
    badge(d, "R5-B")
    y0 = int(H * 0.68) + 22
    bar(d, BAR_X, y0, 140)
    y = stroke(d, c["title"], (TEXT_X, y0), font(FONT_BLACK, 44), CREAM, W - TEXT_X - 48, sw=4)
    stroke(d, c["body"], (TEXT_X, y + 16), font(FONT_BOLD, 26), CREAM, W - TEXT_X - 48, sw=3, line_gap=1.12)
    save(5, "B", s)

    # C top-right
    s = mapa.convert("RGBA")
    d = ImageDraw.Draw(s, "RGBA")
    corners(d, (*GREEN, 120))
    watermark(d)
    badge(d, "R5-C")
    max_w = 560
    tx = W - 48 - max_w
    bar(d, W - 48 - BAR_W, 120, 260)
    y = ink(d, c["title"], (tx, 128), font(FONT_BLACK, 44), max_w - 16, align="right")
    ink(d, c["body"], (tx, y + 24), font(FONT_BOLD, 26), max_w - 16, align="right", hw=2, line_gap=1.14)
    save(5, "C", s)

    # D short bottom center
    s = mapa.convert("RGBA")
    d = ImageDraw.Draw(s, "RGBA")
    corners(d, (*GREEN, 120))
    watermark(d)
    badge(d, "R5-D")
    # short copy for this layout
    short = "Зелёное кольцо проходит мимо моста. Соберите свой отрезок."
    y = ink(d, c["title"], (80, 1050), font(FONT_BLACK, 42), W - 160, align="center")
    ink(d, short, (80, y + 18), font(FONT_BOLD, 28), W - 160, align="center", hw=2)
    save(5, "D", s)


def render_r6(pano):
    c = COPY[6]
    dark = ImageEnhance.Brightness(cover(pano, center=(0.45, 0.55))).enhance(0.32).convert("RGBA")

    def card_cta(s, card_y, letter, tight=False):
        card = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        cd = ImageDraw.Draw(card)
        h = 420 if tight else 520
        cd.rounded_rectangle([56, card_y, W - 56, card_y + h], radius=32, fill=(12, 14, 12, 230))
        cd.rounded_rectangle([56, card_y, W - 56, card_y + 14], radius=8, fill=(*GREEN, 255))
        s = Image.alpha_composite(s, card)
        d = ImageDraw.Draw(s, "RGBA")
        badge(d, letter)
        max_w = W - 192
        y = stroke(d, c["brand"], (96, card_y + 48), font(FONT_BOLD, 28), (159, 224, 180), max_w, sw=3, align="center")
        gap = 14 if tight else 22
        y = stroke(d, c["offer"], (96, y + gap), font(FONT_BLACK, 40), CREAM, max_w, sw=5, align="center", line_gap=1.06)
        by = y + (18 if tight else 28)
        d.rounded_rectangle([96, by, W - 96, by + 80], radius=18, fill=(22, 110, 58, 255))
        fbtn = font(FONT_BLACK, 32)
        tw = int(d.textlength(c["btn"], font=fbtn))
        d.text(((W - tw) // 2, by + 22), c["btn"], font=fbtn, fill=(255, 255, 255, 255))
        return s

    # A center card
    save(6, "A", card_cta(dark.copy(), 420, "R6-A"))

    # B lower card
    save(6, "B", card_cta(dark.copy(), 620, "R6-B"))

    # C minimal
    s = dark.copy()
    d = ImageDraw.Draw(s, "RGBA")
    badge(d, "R6-C")
    y = stroke(d, c["offer"], (80, 480), font(FONT_BLACK, 44), CREAM, W - 160, sw=5, align="center", line_gap=1.06)
    by = y + 36
    d.rounded_rectangle([160, by, W - 160, by + 78], radius=40, fill=(*GREEN, 255))
    fbtn = font(FONT_BLACK, 32)
    tw = int(d.textlength(c["btn"], font=fbtn))
    d.text(((W - tw) // 2, by + 22), c["btn"], font=fbtn, fill=(255, 255, 255, 255))
    save(6, "C", s)

    # D tight stack card
    save(6, "D", card_cta(dark.copy(), 460, "R6-D", tight=True))


def main():
    assert_mix(PREFERRED_PHOTO)
    assert_mix(PREFERRED_VIDEO)

    ultra = load("bridge-ultra-pano.jpg")
    detail = load("bridge-detail.jpg")
    pano = load("bridge-pano.jpg")
    hero = load("bridge-hero.jpg") if (ASSETS / "bridge-hero.jpg").exists() else detail
    mapa = ensure_map()

    render_r1(ultra, detail)
    render_r2(detail, pano, ultra)
    render_r3(detail, pano, ultra, hero)
    render_r4(detail)
    render_r5(mapa)
    render_r6(pano)
    print("done →", OUT)
    print("preferred photo:", " · ".join(PREFERRED_PHOTO))
    print("preferred video:", " · ".join(PREFERRED_VIDEO))


if __name__ == "__main__":
    main()

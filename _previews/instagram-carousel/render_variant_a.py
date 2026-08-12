#!/usr/bin/env python3
"""Variant A battle render — story «Летающая тарелка».

Rules:
- accent bar → text gap 24px (never flush)
- no «свайп», no «кусок», no «ВАУ-ФАКТ»
- no dark text plates
- slides 1–3: seamless strip; 4–6: different frames (photo + illustration)
- CTA centered, tight gap to button
"""
from __future__ import annotations

import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps

from layout_templates import assert_no_banned

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
OUT = ROOT / "export" / "variant-a-zhivopisny"
W, H = 1080, 1350

GREEN = (31, 143, 74)
CREAM = (244, 244, 245)
DARK = (12, 14, 12)
WARM = (255, 200, 130)
GOLD = (255, 214, 160)
MUTED = (190, 195, 190)

FONT_BLACK = "/System/Library/Fonts/Supplemental/Arial Black.ttf"
FONT_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FONT_REG = "/System/Library/Fonts/Supplemental/Arial.ttf"

BAR_X = 48
BAR_W = 10
TEXT_GAP = 32  # space between accent bar and text — same on every slide
TEXT_X = BAR_X + BAR_W + TEXT_GAP  # 90


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.truetype(FONT_BOLD, size)


def load(name: str) -> Image.Image:
    return Image.open(ASSETS / name).convert("RGB")


def cover_crop(img: Image.Image, w: int, h: int, center=(0.5, 0.42)) -> Image.Image:
    return ImageOps.fit(img, (w, h), method=Image.Resampling.LANCZOS, centering=center)


def grade(img: Image.Image, c=1.18, col=1.12, s=1.2) -> Image.Image:
    img = ImageEnhance.Contrast(img).enhance(c)
    img = ImageEnhance.Color(img).enhance(col)
    img = ImageEnhance.Sharpness(img).enhance(s)
    return img


def film_grain(img: Image.Image, amount=10) -> Image.Image:
    import random

    noise = Image.new("L", img.size)
    px = noise.load()
    rnd = random.Random(7)
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
    noise = noise.filter(ImageFilter.GaussianBlur(0.5))
    base = img.convert("RGBA")
    nrgba = Image.merge("RGBA", (noise, noise, noise, Image.new("L", img.size, 22)))
    return Image.alpha_composite(base, nrgba).convert("RGB")


def seamless_strip(src: Image.Image, slides: int, focus_y=0.36) -> Image.Image:
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


def bottom_veil(s: Image.Image, start_y: int, strength=150) -> Image.Image:
    """Soft band for readability — not a text plate."""
    veil = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    vd = ImageDraw.Draw(veil)
    for y in range(start_y, H):
        t = (y - start_y) / max(1, H - start_y)
        vd.line([(0, y), (W, y)], fill=(8, 10, 8, int(strength * (t**1.15))))
    return Image.alpha_composite(s.convert("RGBA"), veil)


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


def draw_stroke(draw, text, xy, fnt, fill, max_w, *, line_gap=1.1, stroke=5, align="left") -> int:
    assert_no_banned(text)
    x, y = xy
    lines = wrap(draw, text, fnt, max_w)
    lh = int(fnt.size * line_gap)
    for i, line in enumerate(lines):
        yy = y + i * lh
        lx = x
        if align == "center":
            lx = x + (max_w - int(draw.textlength(line, font=fnt))) // 2
        draw.text((lx + 2, yy + 3), line, font=fnt, fill=(0, 0, 0, 140))
        for dx, dy in (
            (-stroke, 0),
            (stroke, 0),
            (0, -stroke),
            (0, stroke),
            (-stroke, -stroke),
            (stroke, stroke),
            (-stroke, stroke),
            (stroke, -stroke),
        ):
            draw.text((lx + dx, yy + dy), line, font=fnt, fill=(0, 0, 0, 200))
        draw.text((lx, yy), line, font=fnt, fill=fill)
    return y + len(lines) * lh


def frame_corners(draw, color=(*CREAM, 85)):
    inset, length, width = 36, 70, 3
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


def accent_bar(draw, y, h, color=GREEN):
    draw.rectangle((BAR_X, y, BAR_X + BAR_W, y + h), fill=color)


def chip_zkm(draw):
    draw.rounded_rectangle((48, 44, 166, 96), radius=12, fill=GREEN)
    draw.text((70, 54), "ЗКМ", font=font(FONT_BOLD, 28), fill=(255, 255, 255))


def watermark(draw):
    draw.text((W - 292, 40), "green-route.ru", font=font(FONT_REG, 26), fill=(*MUTED, 210))


def progress(d, n):
    d.text((48, 1260), f"{n:02d} / 06", font=font(FONT_BOLD, 24), fill=(*MUTED, 220))


def save(img: Image.Image, idx: int):
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"slide-{idx:02d}.jpg"
    film_grain(img).save(path, "JPEG", quality=93, optimize=True)
    print("wrote", path.relative_to(ROOT))


def draw_football_compare(base: Image.Image) -> Image.Image:
    """Illustrated comparison: 105 m height ≈ football field length upright."""
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # field card bottom-right
    fx0, fy0, fx1, fy1 = 640, 840, 1036, 1230
    d.rounded_rectangle([fx0, fy0, fx1, fy1], radius=20, fill=(16, 22, 16, 230), outline=(*GREEN, 220), width=3)
    # mini pitch
    px0, py0, px1, py1 = 680, 930, 996, 1135
    d.rounded_rectangle([px0, py0, px1, py1], radius=8, fill=(34, 120, 60, 255))
    # pitch lines
    d.rectangle([px0 + 8, py0 + 8, px1 - 8, py1 - 8], outline=(255, 255, 255, 200), width=3)
    mid = (py0 + py1) // 2
    d.line([(px0 + 8, mid), (px1 - 8, mid)], fill=(255, 255, 255, 180), width=2)
    cx = (px0 + px1) // 2
    d.ellipse([cx - 28, mid - 28, cx + 28, mid + 28], outline=(255, 255, 255, 180), width=2)
    # arrow up = height metaphor
    d.line([(620, 1180), (620, 880)], fill=(*WARM, 255), width=6)
    d.polygon([(620, 860), (600, 900), (640, 900)], fill=(*WARM, 255))
    d.text((fx0 + 24, fy0 + 18), "≈ 1 футбольное поле", font=font(FONT_BOLD, 28), fill=CREAM)
    d.text((fx0 + 24, fy0 + 52), "поставленное на попа", font=font(FONT_REG, 24), fill=GOLD)
    return Image.alpha_composite(base.convert("RGBA"), layer)


def slide_map_graphic() -> Image.Image:
    """Simple drawn ring + pin — variety vs photo clone."""
    img = Image.new("RGB", (W, H), (18, 22, 18))
    # soft gradient blobs
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    for i in range(12):
        r = 180 + i * 40
        od.ellipse([W // 2 - r, H // 2 - r - 40, W // 2 + r, H // 2 + r - 40], outline=(*GREEN, 25 + i * 4), width=3)
    # ring oval
    od.ellipse([120, 280, W - 120, 1100], outline=(*GREEN, 180), width=14)
    od.ellipse([140, 300, W - 140, 1080], outline=(*GREEN, 60), width=4)
    # pin near NW (approx Serebryany Bor / bridge zone on a decorative oval)
    pin_x, pin_y = 280, 420
    od.ellipse([pin_x - 22, pin_y - 22, pin_x + 22, pin_y + 22], fill=(*WARM, 255))
    od.ellipse([pin_x - 10, pin_y - 10, pin_x + 10, pin_y + 10], fill=(255, 255, 255, 255))
    od.line([(pin_x, pin_y + 22), (pin_x, pin_y + 70)], fill=(*WARM, 220), width=5)
    img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
    # faint photo texture from pano in corner
    try:
        pano = grade(cover_crop(load("bridge-pano.jpg"), 480, 600, (0.6, 0.4)), 1.1, 0.9, 1.0)
        pano = ImageEnhance.Brightness(pano).enhance(0.35)
        img.paste(pano, (W - 500, H - 640))
        # blend left edge
        fade = Image.new("RGBA", (480, 600), (0, 0, 0, 0))
        fd = ImageDraw.Draw(fade)
        for x in range(80):
            fd.rectangle([x, 0, x + 1, 600], fill=(18, 22, 18, int(255 * (1 - x / 80))))
        tmp = img.convert("RGBA")
        patch = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        patch.paste(pano.convert("RGBA"), (W - 500, H - 640))
        tmp = Image.alpha_composite(tmp, patch)
        img = tmp.convert("RGB")
    except OSError:
        pass
    return img


def main():
    ultra = load("bridge-ultra-pano.jpg")
    detail = load("bridge-detail.jpg")
    pano = load("bridge-pano.jpg")
    strip = seamless_strip(ultra, 3, focus_y=0.36)

    # ========== 1 — question only ==========
    s = bottom_veil(slice_strip(strip, 0), 640, 155)
    d = ImageDraw.Draw(s, "RGBA")
    frame_corners(d)
    chip_zkm(d)
    title = "Что это за мост с летающей тарелкой?"
    assert_no_banned(title)
    ty = 720
    accent_bar(d, ty - 8, 210)
    y = draw_stroke(d, title, (TEXT_X, ty), font(FONT_BLACK, 64), CREAM, W - TEXT_X - 48, stroke=6, line_gap=1.06)
    # no sub, no swipe pill
    progress(d, 1)
    save(s.convert("RGB"), 1)

    # ========== 2 — answer ==========
    s = bottom_veil(slice_strip(strip, 1), 760, 165)
    d = ImageDraw.Draw(s, "RGBA")
    frame_corners(d, color=(*CREAM, 70))
    watermark(d)
    # map pin top-right
    from icons import map_pin

    pin = map_pin(84)
    s.paste(pin, (W - 48 - 84, 88), pin)
    d = ImageDraw.Draw(s, "RGBA")
    ty = 820
    accent_bar(d, ty - 6, 200)
    y = draw_stroke(d, "Живописный мост", (TEXT_X, ty), font(FONT_BLACK, 56), CREAM, W - TEXT_X - 48, stroke=5)
    y = draw_stroke(
        d,
        "Капсулу под красной аркой задумывали как ресторан в воздухе. Мост открыли в 2007.",
        (TEXT_X, y + 40),
        font(FONT_BOLD, 34),
        CREAM,
        W - TEXT_X - 48,
        stroke=4,
        line_gap=1.18,
    )
    progress(d, 2)
    save(s.convert("RGB"), 2)

    # ========== 3 — twist (closed, not «nobody goes») ==========
    s = bottom_veil(slice_strip(strip, 2), 740, 160)
    d = ImageDraw.Draw(s, "RGBA")
    frame_corners(d, color=(*CREAM, 70))
    watermark(d)
    ty = 800
    accent_bar(d, ty - 6, 220, WARM)
    y = draw_stroke(d, "Капсула закрыта", (TEXT_X, ty), font(FONT_BLACK, 56), CREAM, W - TEXT_X - 48, stroke=5)
    y = draw_stroke(
        d,
        "Публику внутрь так и не пустили. Снаружи — одна из самых узнаваемых точек Москвы для фото.",
        (TEXT_X, y + 40),
        font(FONT_BOLD, 34),
        GOLD,
        W - TEXT_X - 48,
        stroke=4,
        line_gap=1.18,
    )
    progress(d, 3)
    save(s.convert("RGB"), 3)

    # ========== 4 — height + football compare (different visual) ==========
    # Use different crop of detail + illustration overlay
    base = grade(cover_crop(detail, W, H, (0.72, 0.28)), 1.25, 1.05, 1.15)
    base = ImageEnhance.Brightness(base).enhance(0.78)
    s = base.convert("RGBA")
    # ghost number
    big = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(big).text((16, 80), "105", font=font(FONT_BLACK, 360), fill=(255, 255, 255, 20))
    s = Image.alpha_composite(s, big)
    s = draw_football_compare(s)
    d = ImageDraw.Draw(s, "RGBA")
    frame_corners(d)
    watermark(d)
    ty = 200
    accent_bar(d, ty + 20, 340, WARM)
    y = draw_stroke(d, "105", (TEXT_X, ty), font(FONT_BLACK, 260), CREAM, 520, stroke=8, line_gap=1.0)
    y = ty + 260 + 100  # hard air under number
    y = draw_stroke(d, "метров высоты арки", (TEXT_X, y), font(FONT_BLACK, 48), CREAM, W - TEXT_X - 420, stroke=5)
    y = y + 64
    y = draw_stroke(
        d,
        "Это примерно длина футбольного поля — только вверх.",
        (TEXT_X, y),
        font(FONT_BOLD, 32),
        GOLD,
        500,  # stay left of football card
        stroke=4,
        line_gap=1.15,
    )
    y = y + 36
    draw_stroke(
        d,
        "72 ванты · пролёт 409,5 м · Wikipedia",
        (TEXT_X, min(y, 1180)),
        font(FONT_REG, 24),
        MUTED,
        500,
        stroke=3,
    )
    progress(d, 4)
    save(s.convert("RGB"), 4)

    # ========== 5 — route intro (drawn ring + photo) ==========
    s = slide_map_graphic().convert("RGBA")
    d = ImageDraw.Draw(s, "RGBA")
    frame_corners(d, color=(*GREEN, 100))
    watermark(d)
    ty = 160
    accent_bar(d, ty - 4, 260)
    y = draw_stroke(d, "Веломаршрут рядом", (TEXT_X, ty), font(FONT_BLACK, 52), CREAM, W - TEXT_X - 48, stroke=5)
    y = draw_stroke(
        d,
        "Этот мост видно при прогулке по Зелёному кольцу — маршруту мимо десятков парков и достопримечательностей Москвы.",
        (TEXT_X, y + 44),
        font(FONT_BOLD, 34),
        CREAM,
        W - TEXT_X - 48,
        stroke=4,
        line_gap=1.18,
    )
    progress(d, 5)
    save(s.convert("RGB"), 5)

    # ========== 6 — CTA centered, tight stack ==========
    # Different photo: pano crop, cooler grade
    base = grade(cover_crop(pano, W, H, (0.45, 0.55)), 1.1, 0.95, 1.1)
    base = ImageEnhance.Brightness(base).enhance(0.32)
    s = base.convert("RGBA")
    card_w = W - 112
    card_x, card_y = 56, 420
    max_w = card_w - 80
    cx = card_x + 40
    # measure content first, then size card tightly
    pin = map_pin(80)
    # temporary draw to compute height
    probe_img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    pd = ImageDraw.Draw(probe_img)
    y = card_y + 120
    y = draw_stroke(pd, "Зелёный Маршрут", (cx, y), font(FONT_BOLD, 30), (159, 224, 180), max_w, align="center", stroke=3)
    y = draw_stroke(
        pd,
        "Постройте интересный маршрут по Зелёному кольцу",
        (cx, y + 22),
        font(FONT_BLACK, 42),
        CREAM,
        max_w,
        align="center",
        stroke=5,
        line_gap=1.08,
    )
    btn_y = y + 22
    btn_h = 84
    card_h = (btn_y + btn_h + 28) - card_y
    card = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    cd = ImageDraw.Draw(card)
    cd.rounded_rectangle([card_x, card_y, card_x + card_w, card_y + card_h], radius=32, fill=(12, 14, 12, 235))
    cd.rounded_rectangle([card_x, card_y, card_x + card_w, card_y + 14], radius=8, fill=(*GREEN, 255))
    s = Image.alpha_composite(s, card)
    s.paste(pin, (W // 2 - 40, card_y + 28), pin)
    d = ImageDraw.Draw(s, "RGBA")
    y = card_y + 120
    y = draw_stroke(d, "Зелёный Маршрут", (cx, y), font(FONT_BOLD, 30), (159, 224, 180), max_w, align="center", stroke=3)
    y = draw_stroke(
        d,
        "Постройте интересный маршрут по Зелёному кольцу",
        (cx, y + 22),
        font(FONT_BLACK, 42),
        CREAM,
        max_w,
        align="center",
        stroke=5,
        line_gap=1.08,
    )
    btn_y = y + 22
    d.rounded_rectangle([cx, btn_y, cx + max_w, btn_y + btn_h], radius=18, fill=(22, 110, 58))
    label = "green-route.ru"
    fbtn = font(FONT_BLACK, 36)
    tw = int(d.textlength(label, font=fbtn))
    d.text((cx + (max_w - tw) // 2, btn_y + 20), label, font=fbtn, fill=(255, 255, 255))
    progress(d, 6)
    save(s.convert("RGB"), 6)

    meta = {
        "variant": "A",
        "story": "zhivopisny-flying-saucer",
        "banned": ["кусок", "свайп", "ВАУ-ФАКТ"],
        "text_x": TEXT_X,
        "bar_gap": TEXT_GAP,
        "slides": {
            "1": "question only",
            "2": "answer — restaurant plan + 2007",
            "3": "capsule closed (fact)",
            "4": "105 height + football compare graphic",
            "5": "velo route nearby + green ring explained",
            "6": "centered CTA",
        },
    }
    (OUT / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    thumbs = "".join(f'<img src="export/variant-a-zhivopisny/slide-{i:02d}.jpg" alt="{i}"/>' for i in range(1, 7))
    html = """<!doctype html><html lang="ru"><head><meta charset="utf-8"/>
<title>Вариант A — Летающая тарелка</title>
<style>
body{margin:0;background:#0b0b0c;color:#f4f4f5;font-family:system-ui;padding:24px}
h1{font-size:22px} .lead{color:#b4b4be;max-width:720px;line-height:1.45}
.row{display:flex;gap:10px;overflow-x:auto;margin-top:20px} img{height:340px;border-radius:10px}
</style></head><body>
<h1>Вариант A · история «Летающая тарелка»</h1>
<p class="lead">Без «свайп» · капсула закрыта (факт) · 105 = высота + сравнение с полем ·
слайд 5 объясняет Зелёное кольцо · CTA по центру · разные кадры 4–6.<br/>
История: <code>docs/instagram/stories/zhivopisny-flying-saucer.md</code></p>
<div class="row">""" + thumbs + "</div></body></html>"
    (ROOT / "demo-variant-a-zhivopisny.html").write_text(html, encoding="utf-8")
    print("demo → demo-variant-a-zhivopisny.html")


if __name__ == "__main__":
    main()

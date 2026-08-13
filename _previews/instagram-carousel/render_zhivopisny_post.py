#!/usr/bin/env python3
"""Production upload pack: Живописный мост — photo (with collages) + role mix.

Role mix: R1-A · R2-D · R3-B · R4-A · R5-A · R6-B
Zones: bottom → top → bottom → mid → top → bottom (see role_layout_zones.py).
"""
from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

from graphics import cover_crop_strict, isometric_football_pitch, paste_rgba
from layout_templates import assert_no_banned
from role_layout_zones import PREFERRED_PHOTO, assert_mix

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
OUT = ROOT / "export" / "upload-zhivopisny"
PHOTO = OUT / "photo"
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

BAR_X, BAR_W, TEXT_GAP = 48, 10, 32
TEXT_X = BAR_X + BAR_W + TEXT_GAP

LAYOUT_MIX = list(PREFERRED_PHOTO)


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.truetype(FONT_BOLD, size)


def load(name: str) -> Image.Image:
    return Image.open(ASSETS / name).convert("RGB")


def cover(img: Image.Image, w: int, h: int, center=(0.5, 0.42)) -> Image.Image:
    return cover_crop_strict(img, w, h, center)


def grade(img: Image.Image, c=1.15, col=1.1, s=1.15) -> Image.Image:
    img = ImageEnhance.Contrast(img).enhance(c)
    img = ImageEnhance.Color(img).enhance(col)
    img = ImageEnhance.Sharpness(img).enhance(s)
    return img


def film_grain(img: Image.Image, amount=9) -> Image.Image:
    import random

    noise = Image.new("L", img.size)
    px = noise.load()
    rnd = random.Random(11)
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
    nrgba = Image.merge("RGBA", (noise, noise, noise, Image.new("L", img.size, 20)))
    return Image.alpha_composite(base, nrgba).convert("RGB")


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


def draw_stroke(draw, text, xy, fnt, fill, max_w, *, line_gap=1.12, stroke=5, align="left") -> int:
    assert_no_banned(text)
    x, y = xy
    lines = wrap(draw, text, fnt, max_w)
    lh = int(fnt.size * line_gap)
    for i, line in enumerate(lines):
        yy = y + i * lh
        lx = x
        if align == "right":
            lx = x + max_w - int(draw.textlength(line, font=fnt))
        elif align == "center":
            lx = x + (max_w - int(draw.textlength(line, font=fnt))) // 2
        for dx, dy in (
            (-stroke, 0), (stroke, 0), (0, -stroke), (0, stroke),
            (-stroke, -stroke), (stroke, stroke), (-stroke, stroke), (stroke, -stroke),
        ):
            draw.text((lx + dx, yy + dy), line, font=fnt, fill=DARK)
        draw.text((lx, yy), line, font=fnt, fill=fill)
    return y + len(lines) * lh


def draw_ink(draw, text, xy, fnt, max_w, *, line_gap=1.14, halo=3, align="left") -> int:
    """Dark text + cream halo — for light map / collage bands."""
    assert_no_banned(text)
    x, y = xy
    lines = wrap(draw, text, fnt, max_w)
    lh = int(fnt.size * line_gap)
    halo_c = (255, 255, 255, 235)
    for i, line in enumerate(lines):
        yy = y + i * lh
        lx = x
        if align == "right":
            lx = x + max_w - int(draw.textlength(line, font=fnt))
        for dx, dy in (
            (-halo, 0), (halo, 0), (0, -halo), (0, halo),
            (-halo, -halo), (halo, halo), (-halo, halo), (halo, -halo),
        ):
            draw.text((lx + dx, yy + dy), line, font=fnt, fill=halo_c)
        draw.text((lx, yy), line, font=fnt, fill=(*INK, 255))
    return y + len(lines) * lh


def accent_bar(draw, x, y, h, color=GREEN):
    draw.rectangle((x, y, x + BAR_W, y + h), fill=(*color, 255))


def frame_corners(draw, color=(*CREAM, 85)):
    inset, length, width = 36, 70, 3
    x0, y0, x1, y1 = inset, inset, W - inset, H - inset
    for ax, ay, dx, dy in [
        (x0, y0, 1, 0), (x0, y0, 0, 1), (x1, y0, -1, 0), (x1, y0, 0, 1),
        (x0, y1, 1, 0), (x0, y1, 0, -1), (x1, y1, -1, 0), (x1, y1, 0, -1),
    ]:
        draw.line([(ax, ay), (ax + dx * length, ay + dy * length)], fill=color, width=width)


def watermark(draw):
    draw.text((W - 292, 40), "green-route.ru", font=font(FONT_REG, 26), fill=(*MUTED, 230))


def progress(draw, i, n=6):
    draw.text((48, 1260), f"{i:02d} / {n:02d}", font=font(FONT_BOLD, 24), fill=(*MUTED, 230))


def bottom_veil(s: Image.Image, start_y: int, strength=155) -> Image.Image:
    veil = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    vd = ImageDraw.Draw(veil)
    for y in range(start_y, H):
        t = (y - start_y) / max(1, H - start_y)
        vd.line([(0, y), (W, y)], fill=(8, 10, 8, int(strength * (t**1.15))))
    return Image.alpha_composite(s.convert("RGBA"), veil)


def collage_two_up(left: Image.Image, right: Image.Image, gap=8) -> Image.Image:
    """S09 base: two vertical panels on top ~62% height."""
    top_h = int(H * 0.62)
    half = (W - gap) // 2
    canvas = Image.new("RGB", (W, H), (18, 22, 18))
    l = cover(left, half, top_h, (0.55, 0.35))
    r = cover(right, W - half - gap, top_h, (0.45, 0.4))
    canvas.paste(grade(l), (0, 0))
    canvas.paste(grade(r, 1.12, 1.08, 1.1), (half + gap, 0))
    return canvas


def collage_quad(a, b, c, d, gap=6) -> Image.Image:
    """S10 optional: 2×2."""
    canvas = Image.new("RGB", (W, H), (14, 16, 14))
    hw, hh = (W - gap) // 2, (H - gap) // 2
    tiles = [
        (cover(a, hw, hh, (0.5, 0.35)), 0, 0),
        (cover(b, hw, hh, (0.6, 0.4)), hw + gap, 0),
        (cover(c, hw, hh, (0.4, 0.45)), 0, hh + gap),
        (cover(d, hw, hh, (0.5, 0.5)), hw + gap, hh + gap),
    ]
    for im, x, y in tiles:
        canvas.paste(grade(im), (x, y))
    return canvas


def save(img: Image.Image, idx: int):
    PHOTO.mkdir(parents=True, exist_ok=True)
    path = PHOTO / f"slide-{idx:02d}.jpg"
    film_grain(img).save(path, "JPEG", quality=93, optimize=True)
    print("wrote", path.relative_to(ROOT))


def ensure_map() -> Image.Image:
    path = ASSETS / "map-park-krylatskoe-bridge.png"
    if not path.exists() or path.stat().st_size < 20_000:
        from bake_instagram_poi_map import bake

        bake("park-krylatskoe-bridge")
    return cover(load("map-park-krylatskoe-bridge.png"), W, H, (0.5, 0.5))


def main():
    assert_mix(LAYOUT_MIX)
    ultra = load("bridge-ultra-pano.jpg")
    detail = load("bridge-detail.jpg")
    pano = load("bridge-pano.jpg")
    hero = load("bridge-hero.jpg") if (ASSETS / "bridge-hero.jpg").exists() else detail

    # ----- 1 R1-A bottom hook -----
    s = bottom_veil(cover(ultra, W, H, (0.42, 0.38)), 640, 155)
    d = ImageDraw.Draw(s, "RGBA")
    frame_corners(d)
    d.rounded_rectangle((48, 44, 166, 96), radius=12, fill=(*GREEN, 255))
    d.text((70, 54), "ЗКМ", font=font(FONT_BOLD, 28), fill=(255, 255, 255, 255))
    ty = 720
    accent_bar(d, BAR_X, ty - 8, 200)
    draw_stroke(d, "Что это за мост с летающей тарелкой?", (TEXT_X, ty), font(FONT_BLACK, 64), CREAM, W - TEXT_X - 48, stroke=6, line_gap=1.06)
    progress(d, 1)
    save(s.convert("RGB"), 1)

    # ----- 2 R2-D collage + TOP text (not bottom twin of R1-A) -----
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
    y0 = 56
    accent_bar(d, BAR_X, y0 + 8, 160)
    y = draw_stroke(d, "Живописный мост", (TEXT_X, y0), font(FONT_BLACK, 48), CREAM, W - TEXT_X - 48, stroke=5)
    draw_stroke(
        d,
        "Капсулу под красной аркой задумывали как ресторан в воздухе — с видом на Москву-реку и Серебряный Бор. Мост открыли в 2007 году, и с тех пор его силуэт узнают даже те, кто не помнит название.",
        (TEXT_X, y + 18),
        font(FONT_BOLD, 28),
        CREAM,
        W - TEXT_X - 48,
        stroke=3,
        line_gap=1.14,
    )
    progress(d, 2)
    save(s.convert("RGB"), 2)

    # ----- 3 R3-B bottom-left warm on collage #2 -----
    base = collage_quad(pano, detail, hero, ultra)
    s = ImageEnhance.Brightness(base).enhance(0.78).convert("RGBA")
    s = bottom_veil(s, 680, 170)
    d = ImageDraw.Draw(s, "RGBA")
    frame_corners(d, color=(*WARM, 90))
    watermark(d)
    ty = 780
    accent_bar(d, BAR_X, ty, 240, WARM)
    y = draw_stroke(d, "Капсула закрыта", (TEXT_X, ty), font(FONT_BLACK, 50), CREAM, W - TEXT_X - 48, stroke=5)
    draw_stroke(
        d,
        "Публику внутрь так и не пустили — планы менялись, доступ не открыли. Зато снаружи это одна из самых желанных точек для фото: «тарелка» держит кадр сама.",
        (TEXT_X, y + 24),
        font(FONT_BOLD, 30),
        GOLD,
        W - TEXT_X - 48,
        stroke=3,
        line_gap=1.16,
    )
    progress(d, 3)
    save(s.convert("RGB"), 3)

    # ----- 4 S05 height -----
    base = grade(cover(detail, W, H, (0.72, 0.28)), 1.25, 1.05, 1.15)
    base = ImageEnhance.Brightness(base).enhance(0.78)
    s = base.convert("RGBA")
    s = paste_rgba(s, isometric_football_pitch(520), (W - 400, H - 590))
    d = ImageDraw.Draw(s, "RGBA")
    frame_corners(d)
    watermark(d)
    ty = 180
    accent_bar(d, BAR_X, ty + 20, 340, WARM)
    draw_stroke(d, "105", (TEXT_X, ty), font(FONT_BLACK, 250), CREAM, 520, stroke=8, line_gap=1.0)
    y = ty + 270
    y = draw_stroke(d, "метров высоты арки", (TEXT_X, y), font(FONT_BLACK, 46), CREAM, 520, stroke=5)
    y = draw_stroke(
        d,
        "Это примерно длина футбольного поля — только вверх. Чтобы оценить масштаб с земли, этого сравнения обычно хватает.",
        (TEXT_X, y + 36),
        font(FONT_BOLD, 30),
        GOLD,
        500,
        stroke=3,
        line_gap=1.15,
    )
    draw_stroke(d, "Пролёт 409,5 м · Wikipedia", (TEXT_X, y + 28), font(FONT_REG, 24), MUTED, 500, stroke=3)
    progress(d, 4)
    save(s.convert("RGB"), 4)

    # ----- 5 S03 map -----
    s = ensure_map().convert("RGBA")
    d = ImageDraw.Draw(s, "RGBA")
    frame_corners(d, color=(*GREEN, 140))
    watermark(d)
    ty = 120
    accent_bar(d, BAR_X, ty - 4, 280)
    y = draw_ink(d, "Веломаршрут рядом", (TEXT_X, ty), font(FONT_BLACK, 50), W - TEXT_X - 48)
    draw_ink(
        d,
        "Этот мост видно при прогулке по Зелёному кольцу — маршруту мимо десятков парков и достопримечательностей Москвы. Не обязательно ехать весь круг: соберите свой отрезок.",
        (TEXT_X, y + 36),
        font(FONT_BOLD, 30),
        W - TEXT_X - 48,
        line_gap=1.16,
        halo=2,
    )
    progress(d, 5)
    save(s.convert("RGB"), 5)

    # ----- 6 R6-B lower CTA card (after top map text) -----
    base = grade(cover(pano, W, H, (0.45, 0.55)), 1.1, 0.95, 1.1)
    base = ImageEnhance.Brightness(base).enhance(0.32)
    s = base.convert("RGBA")
    card = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    cd = ImageDraw.Draw(card)
    cd.rounded_rectangle([56, 620, W - 56, 1180], radius=32, fill=(12, 14, 12, 230))
    cd.rounded_rectangle([56, 620, W - 56, 634], radius=8, fill=(*GREEN, 255))
    s = Image.alpha_composite(s, card)
    d = ImageDraw.Draw(s, "RGBA")
    max_w = W - 192
    cx = 96
    y = draw_stroke(d, "Зелёный Маршрут", (cx, 700), font(FONT_BOLD, 30), (159, 224, 180), max_w, align="center", stroke=3)
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
    d.rounded_rectangle([96, y + 28, W - 96, y + 28 + 84], radius=18, fill=(22, 110, 58, 255))
    label = "green-route.ru"
    fbtn = font(FONT_BLACK, 34)
    tw = int(d.textlength(label, font=fbtn))
    d.text(((W - tw) // 2, y + 48), label, font=fbtn, fill=(255, 255, 255, 255))
    progress(d, 6)
    save(s.convert("RGB"), 6)

    # copy story → POST.md + write README + manifest
    story = (ROOT.parents[1] / "docs" / "instagram" / "stories" / "zhivopisny-flying-saucer.md").read_text(encoding="utf-8")
    (OUT / "POST.md").write_text(story, encoding="utf-8")
    (OUT / "layout-manifest.json").write_text(
        json.dumps(
            {
                "slug": "zhivopisny",
                "roles": [
                    "hook",
                    "about",
                    "emotion",
                    "fact",
                    "route",
                    "cta",
                ],
                "layouts": LAYOUT_MIX,
                "collages": ["slide-02 R2-D top-band two-up", "slide-03 R3-B quad + bottom stack"],
                "map": "slide-05 Carto + ring + pin",
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    (OUT / "README.md").write_text(
        """# Upload: Живописный мост

## Что заливать

### Вариант A — фото-карусель (рекомендуем как базовый пост)
Папка `photo/slide-01.jpg` … `slide-06.jpg`  
Порядок строго 01→06. Формат 4:5.

### Вариант C — видео-карусель
Если собраны клипы: скопируйте из `../motion-demos/C_video_heavy/` в `video/`  
(01-hook-drone … 06-cta-pulse) и залейте как видео-карусель.  
Слайд 05 там — карта.

## Caption
См. блок «Caption» в `POST.md`.

## Структура ролей
1 вовлечение · 2 об объекте · 3 эмоция · 4 факт · 5 маршрут · 6 зазывалочка  
Канон: `docs/instagram/CAROUSEL_STRUCTURE.md`
""",
        encoding="utf-8",
    )

    # demo html
    imgs = "".join(
        f'<figure><img src="export/upload-zhivopisny/photo/slide-{i:02d}.jpg"/><figcaption>{i:02d} · {LAYOUT_MIX[i-1]}</figcaption></figure>'
        for i in range(1, 7)
    )
    (ROOT / "demo-upload-zhivopisny.html").write_text(
        f"""<!doctype html><html lang="ru"><head><meta charset="utf-8"/>
<title>Upload · Живописный</title>
<style>
body{{margin:0;background:#0b0b0c;color:#f4f4f5;font-family:system-ui;padding:24px}}
.row{{display:flex;gap:10px;overflow-x:auto}} img{{height:360px;border-radius:10px}}
figcaption{{font-size:12px;color:#888;margin-top:6px}} .lead{{color:#b4b4be;max-width:720px;line-height:1.45}}
</style></head><body>
<h1>Upload pack · Живописный (фото)</h1>
<p class="lead">Микс: {' · '.join(LAYOUT_MIX)}. Коллажи на 02 и 03. Карта на 05.<br/>
Файлы: <code>export/upload-zhivopisny/</code></p>
<div class="row">{imgs}</div>
<p><a href="demo-placement-schemas.html" style="color:#86efac">10 схем плейсмента</a></p>
</body></html>""",
        encoding="utf-8",
    )
    print("upload pack →", OUT)


if __name__ == "__main__":
    main()

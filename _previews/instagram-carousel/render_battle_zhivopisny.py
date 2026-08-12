#!/usr/bin/env python3
"""One battle-ready Instagram carousel: Живописный мост.

Copy canon: «отрезок» only (never «кусок»). No crosshair/reticle graphics.
Layout slots from layout_templates.py — mix corners across slides.
"""
from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps

from contrast import ensure_contrast, sample_region
from icons import map_pin, paste_icon, route_mark
from layout_templates import TEMPLATES, assert_no_banned, stack_x

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
OUT = ROOT / "export" / "battle-zhivopisny"
W, H = 1080, 1350

GREEN = (31, 143, 74)
CREAM = (244, 244, 245)
DARK = (12, 14, 12)
WARM = (255, 176, 96)
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


def draw_lines(draw, text, xy, fnt, fill, max_w, line_gap=1.08, shadow=True, align="left") -> int:
    x, y = xy
    lines = wrap(draw, text, fnt, max_w)
    lh = int(fnt.size * line_gap)
    for i, line in enumerate(lines):
        yy = y + i * lh
        lx = x
        if align == "right":
            lx = x + max_w - int(draw.textlength(line, font=fnt))
        if shadow:
            draw.text((lx + 2, yy + 3), line, font=fnt, fill=(0, 0, 0, 200))
        draw.text((lx, yy), line, font=fnt, fill=fill)
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
    align: str = "left",
) -> tuple[Image.Image, int]:
    assert_no_banned(text, label)
    probe = ImageDraw.Draw(base)
    tw, th = text_block_size(probe, text, fnt, max_w, line_gap)
    x, y = xy
    if align == "right":
        box = (x, y, x + max_w, y + max(th, fnt.size))
    else:
        box = (x, y, x + max(tw, 40), y + max(th, fnt.size))
    img, fg, report = ensure_contrast(base, box, prefer_fg, large_text=fnt.size >= 36)
    audit.append(f"{label}: {report.worst_ratio:.2f}:1 {'OK' if report.passes else report.fix}")
    d = ImageDraw.Draw(img, "RGBA")
    y2 = draw_lines(d, text, xy, fnt, fg, max_w, line_gap=line_gap, align=align)
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


def swipe_pill(draw, y=1195):
    draw.rounded_rectangle((W - 230, y, W - 48, y + 58), radius=29, fill=(255, 255, 255, 235))
    draw.text((W - 205, y + 14), "свайп  →", font=font(FONT_BOLD, 28), fill=DARK)


def watermark(draw):
    draw.text((W - 292, 40), "green-route.ru", font=font(FONT_REG, 26), fill=(*MUTED, 200))


def bottom_veil(s: Image.Image, start_y: int) -> Image.Image:
    veil = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    vd = ImageDraw.Draw(veil)
    for y in range(start_y, H):
        t = (y - start_y) / max(1, H - start_y)
        vd.line([(0, y), (W, y)], fill=(8, 10, 8, int(40 + 170 * t**1.2)))
    return Image.alpha_composite(s, veil)


def top_veil(s: Image.Image, end_y: int = 420) -> Image.Image:
    veil = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    vd = ImageDraw.Draw(veil)
    for y in range(0, end_y):
        t = 1 - y / end_y
        vd.line([(0, y), (W, y)], fill=(8, 10, 8, int(20 + 140 * t**1.1)))
    return Image.alpha_composite(s, veil)


def save(img: Image.Image, idx: int):
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"slide-{idx:02d}.jpg"
    film_grain(img).save(path, "JPEG", quality=93, optimize=True)
    print("wrote", path.relative_to(ROOT))


def progress(d, n: int):
    d.text((48, 1260), f"{n:02d} / 06", font=font(FONT_BOLD, 24), fill=(*MUTED, 220))


def main():
    audit_all: dict[str, list[str]] = {}
    ultra = load("bridge-ultra-pano.jpg")
    detail = load("bridge-detail.jpg")
    strip = seamless_strip(ultra, 3, focus_y=0.36)

    # Layout mix for this carousel (combinable templates)
    # 01 T_BL · 02 T_BR · 03 T_TR · 04 T_ML · 05 T_TL · 06 T_CARD
    layouts = {
        1: TEMPLATES["T_BL"],
        2: TEMPLATES["T_BR"],
        3: TEMPLATES["T_TR"],
        4: TEMPLATES["T_ML"],
        5: TEMPLATES["T_TL"],
        6: TEMPLATES["T_CARD"],
    }

    # ========== 1 HOOK — T_BL ==========
    L = layouts[1]
    s = bottom_veil(slice_strip(strip, 0).convert("RGBA"), 680)
    d = ImageDraw.Draw(s, "RGBA")
    frame_corners(d)
    chip_zkm(d)
    accent_bar(d, 48, L.y - 20, 200, GREEN)
    audit: list[str] = []
    s_rgb = s.convert("RGB")
    x = stack_x(L, L.max_w)
    s_rgb, y = draw_safe_text(
        s_rgb,
        "Мост с «тарелкой» на красной арке",
        (x, L.y),
        font(FONT_BLACK, 72),
        CREAM,
        L.max_w,
        label="hook",
        audit=audit,
        line_gap=1.04,
        align=L.align,
    )
    s_rgb, _ = draw_safe_text(
        s_rgb,
        "Свайпни — 105 метров чистого вау",
        (x, y + L.title_gap),
        font(FONT_BOLD, 34),
        WARM,
        L.max_w,
        label="hook_sub",
        audit=audit,
        align=L.align,
    )
    d = ImageDraw.Draw(s_rgb, "RGBA")
    swipe_pill(d)
    progress(d, 1)
    audit_all["01"] = audit
    save(s_rgb, 1)

    # ========== 2 PLACE — T_BR ==========
    L = layouts[2]
    s = bottom_veil(slice_strip(strip, 1).convert("RGBA"), 780)
    gd = ImageDraw.Draw(s, "RGBA")
    gd.polygon([(W, 1100), (W - 220, 820), (W - 260, 820), (W - 40, 1100)], fill=(*GREEN, 35))
    frame_corners(gd, color=(*CREAM, 70))
    audit = []
    s_rgba = s
    paste_icon(s_rgba, map_pin(88), "tl")
    s_rgb = s_rgba.convert("RGB")
    d = ImageDraw.Draw(s_rgb, "RGBA")
    watermark(d)
    x = stack_x(L, L.max_w)
    s_rgb, y = draw_safe_text(
        s_rgb,
        "ЧТО ЭТО",
        (x, L.y),
        font(FONT_BOLD, 28),
        GOLD,
        L.max_w,
        label="kicker",
        audit=audit,
        align=L.align,
    )
    s_rgb, _ = draw_safe_text(
        s_rgb,
        "Живописный мост у Серебряного Бора. Вантовая арка и капсула в воздухе.",
        (x, y + L.title_gap),
        font(FONT_BLACK, 46),
        CREAM,
        L.max_w,
        label="body",
        audit=audit,
        align=L.align,
    )
    d = ImageDraw.Draw(s_rgb, "RGBA")
    progress(d, 2)
    audit_all["02"] = audit
    save(s_rgb, 2)

    # ========== 3 PHOTO TIP — T_TR (top-right stack) ==========
    L = layouts[3]
    s = top_veil(slice_strip(strip, 2).convert("RGBA"), 520)
    # also soft bottom so progress readable
    s = bottom_veil(s, 1100)
    gd = ImageDraw.Draw(s, "RGBA")
    frame_corners(gd, color=(*CREAM, 70))
    audit = []
    s_rgba = s
    paste_icon(s_rgba, map_pin(80, fill=(*GREEN, 255)), "bl")
    s_rgb = s_rgba.convert("RGB")
    d = ImageDraw.Draw(s_rgb, "RGBA")
    watermark(d)
    x = stack_x(L, L.max_w)
    # For TR: stack sits upper; use L.y
    s_rgb, y = draw_safe_text(
        s_rgb,
        "Для лучшего фото",
        (x, L.y),
        font(FONT_BOLD, 30),
        WARM,
        L.max_w,
        label="kicker",
        audit=audit,
        align=L.align,
    )
    s_rgb, _ = draw_safe_text(
        s_rgb,
        "Встаньте на набережной или со стороны Серебряного Бора — лучше на закате. Можно и с линии Зелёного кольца.",
        (x, y + L.title_gap),
        font(FONT_BLACK, 42),
        CREAM,
        L.max_w,
        label="body",
        audit=audit,
        align=L.align,
    )
    d = ImageDraw.Draw(s_rgb, "RGBA")
    progress(d, 3)
    audit_all["03"] = audit
    save(s_rgb, 3)

    # ========== 4 WOW — T_ML ==========
    L = layouts[4]
    base = ImageEnhance.Brightness(grade(cover_crop(detail, W, H, (0.55, 0.4)))).enhance(0.42)
    s = base.convert("RGBA")
    big = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    bd = ImageDraw.Draw(big)
    bd.text((40, 200), "105", font=font(FONT_BLACK, 340), fill=(255, 255, 255, 28))
    s = Image.alpha_composite(s, big)
    gd = ImageDraw.Draw(s, "RGBA")
    frame_corners(gd)
    accent_bar(gd, 48, L.y, 280, WARM)
    audit = []
    s_rgb = s.convert("RGB")
    d = ImageDraw.Draw(s_rgb, "RGBA")
    watermark(d)
    x = 72
    s_rgb, y = draw_safe_text(
        s_rgb,
        "ВАУ-ФАКТ",
        (x, L.y),
        font(FONT_BOLD, 30),
        WARM,
        400,
        label="kicker",
        audit=audit,
    )
    s_rgb, y = draw_safe_text(
        s_rgb,
        "105",
        (64, y + L.title_gap - 8),
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
        (x, y - 10),
        font(FONT_BLACK, 52),
        CREAM,
        W - 140,
        label="unit",
        audit=audit,
    )
    s_rgb, y = draw_safe_text(
        s_rgb,
        "пролёт 409,5 м · открыт 2007",
        (x, y + 24),
        font(FONT_BOLD, 32),
        GOLD,
        W - 140,
        label="stats",
        audit=audit,
    )
    s_rgb, _ = draw_safe_text(
        s_rgb,
        "Источник: Wikipedia «Живописный мост»",
        (x, y + 28),
        font(FONT_REG, 24),
        MUTED,
        W - 140,
        label="source",
        audit=audit,
    )
    d = ImageDraw.Draw(s_rgb, "RGBA")
    progress(d, 4)
    audit_all["04"] = audit
    save(s_rgb, 4)

    # ========== 5 ON RING — T_TL ==========
    L = layouts[5]
    base = ImageEnhance.Brightness(grade(cover_crop(detail, W, H, (0.35, 0.55)))).enhance(0.4)
    s = top_veil(base.convert("RGBA"), 480)
    s = bottom_veil(s, 1050)
    s_rgba = s
    paste_icon(s_rgba, route_mark(100), "br")
    gd = ImageDraw.Draw(s_rgba, "RGBA")
    frame_corners(gd, color=(*GREEN, 80))
    audit = []
    s_rgb = s_rgba.convert("RGB")
    d = ImageDraw.Draw(s_rgb, "RGBA")
    watermark(d)
    x = stack_x(L, L.max_w)
    s_rgb, y = draw_safe_text(
        s_rgb,
        "На Зелёном кольце",
        (x, L.y),
        font(FONT_BOLD, 30),
        GREEN,
        L.max_w,
        label="kicker",
        audit=audit,
        align=L.align,
    )
    s_rgb, _ = draw_safe_text(
        s_rgb,
        "Соберите отрезок мимо моста — не обязательно ехать весь круг.",
        (x, y + L.title_gap),
        font(FONT_BLACK, 46),
        CREAM,
        L.max_w,
        label="body",
        audit=audit,
        align=L.align,
    )
    d = ImageDraw.Draw(s_rgb, "RGBA")
    progress(d, 5)
    audit_all["05"] = audit
    save(s_rgb, 5)

    # ========== 6 CTA — T_CARD ==========
    L = layouts[6]
    base = ImageEnhance.Brightness(grade(cover_crop(detail, W, H))).enhance(0.28)
    s = base.convert("RGBA")
    card = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    cd = ImageDraw.Draw(card)
    cd.rounded_rectangle((56, 360, W - 56, 1040), radius=36, fill=(12, 14, 12, 230))
    cd.rounded_rectangle((56, 360, W - 56, 376), radius=8, fill=(*GREEN, 255))
    s = Image.alpha_composite(s, card)
    # ready map-pin, not target rings
    pin = map_pin(96)
    s.paste(pin, (W // 2 - 48, 420), pin)
    audit = []
    s_rgb = s.convert("RGB")
    s_rgb, y = draw_safe_text(
        s_rgb,
        "Зелёный Маршрут",
        (96, 540),
        font(FONT_BOLD, 32),
        (159, 224, 180),
        W - 200,
        label="brand",
        audit=audit,
    )
    s_rgb, y = draw_safe_text(
        s_rgb,
        "Соберите отрезок Зелёного кольца мимо этого моста",
        (96, y + L.title_gap),
        font(FONT_BLACK, 48),
        CREAM,
        W - 200,
        label="cta_msg",
        audit=audit,
    )
    d = ImageDraw.Draw(s_rgb, "RGBA")
    btn_fill = (22, 110, 58)
    d.rounded_rectangle((96, 900, W - 96, 1000), radius=20, fill=btn_fill)
    r = sample_region(s_rgb, (120, 920, W - 120, 980), (255, 255, 255), min_ratio=4.5)
    if not r.passes:
        btn_fill = (14, 80, 42)
        d.rounded_rectangle((96, 900, W - 96, 1000), radius=20, fill=btn_fill)
        r = sample_region(s_rgb, (120, 920, W - 120, 980), (255, 255, 255), min_ratio=4.5)
    d.text((W // 2 - 150, 928), "green-route.ru", font=font(FONT_BLACK, 40), fill=(255, 255, 255))
    audit.append(f"cta_btn: {r.worst_ratio:.2f}:1 {'OK' if r.passes else 'FAIL'}")
    progress(d, 6)
    audit_all["06"] = audit
    save(s_rgb, 6)

    # layout manifest for future mixes
    manifest = {
        "carousel": "battle-zhivopisny",
        "layouts": {str(k): v.id for k, v in layouts.items()},
        "copy_notes": {
            "banned": ["кусок"],
            "prefer": ["отрезок"],
            "slide_03": "Для лучшего фото → куда встать (человеческий ответ)",
        },
    }
    (OUT / "layout-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    report_path = OUT / "contrast-audit.json"
    report_path.write_text(json.dumps(audit_all, ensure_ascii=False, indent=2), encoding="utf-8")
    print("audit →", report_path.relative_to(ROOT))
    for k, lines in audit_all.items():
        print(f"[{k}]", "; ".join(lines))
    fails = [f"{k}:{line}" for k, lines in audit_all.items() for line in lines if "FAIL" in line]
    if fails:
        raise SystemExit("contrast FAIL: " + "; ".join(fails))


if __name__ == "__main__":
    main()

"""Transparent text overlays (4:5) for motion demos — no plates, no «свайп»."""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from layout_templates import assert_no_banned

W, H = 1080, 1350
GREEN = (31, 143, 74, 255)
CREAM = (244, 244, 245, 255)
GOLD = (255, 214, 160, 255)
MUTED = (190, 195, 190, 230)
DARK = (0, 0, 0, 200)

FONT_BLACK = "/System/Library/Fonts/Supplemental/Arial Black.ttf"
FONT_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FONT_REG = "/System/Library/Fonts/Supplemental/Arial.ttf"

BAR_X, BAR_W, TEXT_GAP = 48, 10, 32
TEXT_X = BAR_X + BAR_W + TEXT_GAP


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.truetype(FONT_BOLD, size)


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


def stroke_text(draw, text, xy, fnt, fill, max_w, *, line_gap=1.1, stroke=5, align="left") -> int:
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
            (-stroke, 0),
            (stroke, 0),
            (0, -stroke),
            (0, stroke),
            (-stroke, -stroke),
            (stroke, stroke),
            (-stroke, stroke),
            (stroke, -stroke),
        ):
            draw.text((lx + dx, yy + dy), line, font=fnt, fill=DARK)
        draw.text((lx, yy), line, font=fnt, fill=fill)
    return y + len(lines) * lh


def soft_bottom(draw, start_y=700, strength=140):
    for y in range(start_y, H):
        t = (y - start_y) / max(1, H - start_y)
        a = int(strength * (t**1.2))
        draw.line([(0, y), (W, y)], fill=(8, 10, 8, a))


def corners(draw):
    inset, length, width = 36, 70, 3
    c = (244, 244, 245, 90)
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
        draw.line([(ax, ay), (ax + dx * length, ay + dy * length)], fill=c, width=width)


def make_overlay(kind: str, out: Path) -> Path:
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    soft_bottom(d)
    corners(d)
    d.text((W - 292, 40), "green-route.ru", font=font(FONT_REG, 26), fill=MUTED)

    if kind == "hook":
        d.rounded_rectangle((48, 44, 166, 96), radius=12, fill=GREEN)
        d.text((70, 54), "ЗКМ", font=font(FONT_BOLD, 28), fill=(255, 255, 255, 255))
        d.rectangle((BAR_X, 712, BAR_X + BAR_W, 930), fill=GREEN)
        stroke_text(
            d,
            "Что это за мост с летающей тарелкой?",
            (TEXT_X, 720),
            font(FONT_BLACK, 60),
            CREAM,
            W - TEXT_X - 48,
            stroke=6,
            line_gap=1.05,
        )
        d.text((48, 1260), "01 / 06", font=font(FONT_BOLD, 24), fill=MUTED)

    elif kind == "answer":
        # S07 split: title top-left, body bottom — ≠ hook S01 and ≠ closed S02
        d.rectangle((BAR_X, 120, BAR_X + BAR_W, 280), fill=GREEN)
        stroke_text(d, "Живописный мост", (TEXT_X, 128), font(FONT_BLACK, 50), CREAM, W - TEXT_X - 48, stroke=5)
        soft_bottom(d, 780, 160)
        stroke_text(
            d,
            "Капсулу под красной аркой задумывали как ресторан в воздухе — с видом на Москву-реку. Открыли в 2007; силуэт узнают даже без названия.",
            (48, 900),
            font(FONT_BOLD, 30),
            CREAM,
            W - 96,
            stroke=4,
            line_gap=1.14,
        )
        d.text((48, 1260), "02 / 06", font=font(FONT_BOLD, 24), fill=MUTED)

    elif kind == "closed":
        # S02 bottom-right — different from answer S07
        soft_bottom(d, 700, 170)
        bar_x = W - 48 - BAR_W
        d.rectangle((bar_x, 820, bar_x + BAR_W, 1100), fill=(255, 176, 96, 255))
        max_w = 560
        tx = W - 48 - max_w - 16
        y = stroke_text(
            d, "Капсула закрыта", (tx, 830), font(FONT_BLACK, 48), CREAM, max_w, stroke=5, align="right"
        )
        stroke_text(
            d,
            "Публику внутрь так и не пустили. Зато снаружи — одна из самых желанных точек для фото: «тарелка» держит кадр сама.",
            (tx, y + 28),
            font(FONT_BOLD, 30),
            GOLD,
            max_w,
            stroke=4,
            line_gap=1.14,
            align="right",
        )
        d.text((48, 1260), "03 / 06", font=font(FONT_BOLD, 24), fill=MUTED)

    elif kind == "height":
        soft_bottom(d, 200, 80)
        d.rectangle((BAR_X, 220, BAR_X + BAR_W, 560), fill=(255, 176, 96, 255))
        stroke_text(d, "105", (TEXT_X, 200), font(FONT_BLACK, 220), CREAM, 700, stroke=8, line_gap=1.0)
        y = 200 + 220 + 90
        y = stroke_text(d, "метров высоты арки", (TEXT_X, y), font(FONT_BLACK, 44), CREAM, 520, stroke=5)
        stroke_text(
            d,
            "≈ футбольное поле — только вверх",
            (TEXT_X, y + 40),
            font(FONT_BOLD, 32),
            GOLD,
            520,
            stroke=4,
        )
        d.text((48, 1260), "04 / 06", font=font(FONT_BOLD, 24), fill=MUTED)

    elif kind == "route":
        # Map slide is light Carto — dark ink + cream halo (same as static slide 5)
        d.rectangle((BAR_X, 156, BAR_X + BAR_W, 420), fill=GREEN)
        ink = (18, 22, 18, 255)
        halo = (255, 255, 255, 235)

        def ink_text(text, xy, fnt, max_w, *, line_gap=1.12, hw=3):
            assert_no_banned(text)
            x, y0 = xy
            lines = wrap(d, text, fnt, max_w)
            lh = int(fnt.size * line_gap)
            for i, line in enumerate(lines):
                yy = y0 + i * lh
                for dx, dy in (
                    (-hw, 0), (hw, 0), (0, -hw), (0, hw),
                    (-hw, -hw), (hw, hw), (-hw, hw), (hw, -hw),
                ):
                    d.text((x + dx, yy + dy), line, font=fnt, fill=halo)
                d.text((x, yy), line, font=fnt, fill=ink)
            return y0 + len(lines) * lh

        y = ink_text("Веломаршрут рядом", (TEXT_X, 160), font(FONT_BLACK, 48), W - TEXT_X - 48)
        ink_text(
            "Этот мост видно при прогулке по Зелёному кольцу — маршруту мимо десятков парков и достопримечательностей. Соберите свой отрезок.",
            (TEXT_X, y + 36),
            font(FONT_BOLD, 30),
            W - TEXT_X - 48,
            line_gap=1.14,
            hw=2,
        )
        d.text((48, 1260), "05 / 06", font=font(FONT_BOLD, 24), fill=(80, 90, 80, 230))

    elif kind == "cta":
        # centered card
        card = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        cd = ImageDraw.Draw(card)
        cd.rounded_rectangle([56, 480, W - 56, 980], radius=32, fill=(12, 14, 12, 230))
        cd.rounded_rectangle([56, 480, W - 56, 494], radius=8, fill=GREEN)
        img = Image.alpha_composite(img, card)
        d = ImageDraw.Draw(img)
        y = stroke_text(
            d,
            "Зелёный Маршрут",
            (96, 560),
            font(FONT_BOLD, 30),
            (159, 224, 180, 255),
            W - 192,
            align="center",
            stroke=3,
        )
        y = stroke_text(
            d,
            "Постройте интересный маршрут по Зелёному кольцу",
            (96, y + 22),
            font(FONT_BLACK, 40),
            CREAM,
            W - 192,
            align="center",
            stroke=5,
            line_gap=1.08,
        )
        d.rounded_rectangle([96, y + 28, W - 96, y + 28 + 84], radius=18, fill=(22, 110, 58, 255))
        label = "green-route.ru"
        fbtn = font(FONT_BLACK, 34)
        tw = int(d.textlength(label, font=fbtn))
        d.text(((W - tw) // 2, y + 48), label, font=fbtn, fill=(255, 255, 255, 255))
        d.text((48, 1260), "06 / 06", font=font(FONT_BOLD, 24), fill=MUTED)

    else:
        raise ValueError(kind)

    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
    return out

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
        d.rectangle((BAR_X, 812, BAR_X + BAR_W, 1020), fill=GREEN)
        y = stroke_text(d, "Живописный мост", (TEXT_X, 820), font(FONT_BLACK, 52), CREAM, W - TEXT_X - 48, stroke=5)
        stroke_text(
            d,
            "Капсулу задумывали как ресторан в воздухе. Открыли в 2007.",
            (TEXT_X, y + 36),
            font(FONT_BOLD, 34),
            CREAM,
            W - TEXT_X - 48,
            stroke=4,
            line_gap=1.15,
        )
        d.text((48, 1260), "02 / 06", font=font(FONT_BOLD, 24), fill=MUTED)

    elif kind == "closed":
        d.rectangle((BAR_X, 792, BAR_X + BAR_W, 1020), fill=(255, 176, 96, 255))
        y = stroke_text(d, "Капсула закрыта", (TEXT_X, 800), font(FONT_BLACK, 52), CREAM, W - TEXT_X - 48, stroke=5)
        stroke_text(
            d,
            "Публику внутрь так и не пустили. Снаружи — точка для фото.",
            (TEXT_X, y + 36),
            font(FONT_BOLD, 34),
            GOLD,
            W - TEXT_X - 48,
            stroke=4,
            line_gap=1.15,
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
        soft_bottom(d, 100, 100)
        d.rectangle((BAR_X, 156, BAR_X + BAR_W, 420), fill=GREEN)
        y = stroke_text(d, "Веломаршрут рядом", (TEXT_X, 160), font(FONT_BLACK, 48), CREAM, W - TEXT_X - 48, stroke=5)
        stroke_text(
            d,
            "Мост видно с Зелёного кольца — маршрута мимо десятков парков и мест Москвы.",
            (TEXT_X, y + 40),
            font(FONT_BOLD, 34),
            CREAM,
            W - TEXT_X - 48,
            stroke=4,
            line_gap=1.15,
        )
        d.text((48, 1260), "05 / 06", font=font(FONT_BOLD, 24), fill=MUTED)

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

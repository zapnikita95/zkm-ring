"""Combinable layout slots for Instagram carousel slides (4:5).

Each template = where the text stack sits + title→body gap + optional icon corner.
Mix templates across slides in one carousel.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

W, H = 1080, 1350

Corner = Literal["tl", "tr", "bl", "br", "bc"]


@dataclass(frozen=True)
class TextStack:
    """Text stack placement."""

    id: str
    corner: Corner
    # top-left of stack (or right-aligned if corner ends with 'r')
    x: int
    y: int
    max_w: int
    align: Literal["left", "right"]
    title_gap: int  # px between kicker/title and body
    icon_corner: Corner | None = None  # ready icon, opposite to clutter


# Named templates — combine freely (e.g. T_BL + T_TR + T_BC …)
TEMPLATES: dict[str, TextStack] = {
    "T_BL": TextStack("T_BL", "bl", 48, 780, W - 96, "left", 44, "tr"),
    "T_BR": TextStack("T_BR", "br", 48, 780, W - 96, "right", 44, "tl"),
    "T_TL": TextStack("T_TL", "tl", 48, 120, W - 96, "left", 48, "br"),
    "T_TR": TextStack("T_TR", "tr", 48, 120, W - 96, "right", 48, "bl"),
    "T_BC": TextStack("T_BC", "bc", 64, 820, W - 128, "left", 44, "tr"),
    "T_ML": TextStack("T_ML", "bl", 48, 520, W - 200, "left", 44, "tr"),  # mid-left wow
    "T_CARD": TextStack("T_CARD", "bc", 96, 560, W - 192, "left", 44, None),  # CTA card
}


def stack_x(stack: TextStack, content_w: int) -> int:
    if stack.align == "right":
        return max(48, W - 48 - content_w)
    if stack.corner == "bc":
        return stack.x
    return stack.x


# Copy canon
BANNED_WORDS = ("кусок", "Кусок", "КУСОК", "ванты", "Ванты", "ВАНТЫ")


def assert_no_banned(text: str, where: str = "") -> None:
    for w in BANNED_WORDS:
        if w in text:
            raise ValueError(f"Banned word «{w}» in {where or 'copy'}: {text!r}")


# Preferred product wording
# отрезок ✓ · кусок ✗

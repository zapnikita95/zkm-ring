"""Vertical text zones for role layout variants — adjacency canon.

Hard rule: consecutive slides must not share the same vertical zone
(top / mid / bottom). Horizontal family (left / center / right) is a
soft preference inside the same vertical band.

Used when picking R1–R6 mixes for a post.
"""
from __future__ import annotations

from typing import Iterable

# vertical: where the main readable text stack sits
VERTICAL: dict[str, str] = {
    # R1 hook
    "R1-A": "bottom",
    "R1-B": "top",
    "R1-C": "bottom",
    "R1-D": "top",
    # R2 about — mostly top/mid so they pair after bottom hooks
    "R2-A": "top",  # верх-лево
    "R2-B": "top",  # верх-право
    "R2-C": "mid",  # центр
    "R2-D": "top",  # коллаж + текст сверху
    "R2-E": "bottom",  # низ-лево — только после верхнего R1
    # R3 emotion
    "R3-A": "top",
    "R3-B": "bottom",
    "R3-C": "mid",
    "R3-D": "bottom",
    # R4 fact
    "R4-A": "mid",
    "R4-B": "mid",
    "R4-C": "top",
    "R4-D": "mid",
    # R5 route / map
    "R5-A": "top",
    "R5-B": "bottom",
    "R5-C": "top",
    "R5-D": "bottom",
    # R6 CTA
    "R6-A": "mid",
    "R6-B": "bottom",
    "R6-C": "mid",
    "R6-D": "mid",
}

FAMILY: dict[str, str] = {
    "R1-A": "низ-лево",
    "R1-B": "верх-лево",
    "R1-C": "низ-центр",
    "R1-D": "верх-центр",
    "R2-A": "верх-лево",
    "R2-B": "верх-право",
    "R2-C": "центр",
    "R2-D": "коллаж-верх",
    "R2-E": "низ-лево",
    "R3-A": "верх-право",
    "R3-B": "низ-лево",
    "R3-C": "коллаж-угол",
    "R3-D": "низ-центр",
    "R4-A": "цифра-лево",
    "R4-B": "цифра-центр",
    "R4-C": "цифра-верх",
    "R4-D": "цифра-право",
    "R5-A": "верх-лево",
    "R5-B": "низ-лента",
    "R5-C": "верх-право",
    "R5-D": "низ-центр",
    "R6-A": "карточка-центр",
    "R6-B": "карточка-низ",
    "R6-C": "минимал-центр",
    "R6-D": "стек-центр",
}

# Preferred mixes that pass zone checks (photo / video)
# Photo: bottom hook → top collage → bottom emotion → mid fact → top map → bottom CTA
PREFERRED_PHOTO = ["R1-A", "R2-D", "R3-B", "R4-A", "R5-A", "R6-B"]
# Video: bottom → mid center → bottom → mid → top map → bottom CTA
PREFERRED_VIDEO = ["R1-A", "R2-C", "R3-B", "R4-A", "R5-A", "R6-B"]

POOLS: dict[int, list[str]] = {
    1: ["R1-A", "R1-B", "R1-C", "R1-D"],
    2: ["R2-A", "R2-B", "R2-C", "R2-D", "R2-E"],
    3: ["R3-A", "R3-B", "R3-C", "R3-D"],
    4: ["R4-A", "R4-B", "R4-C", "R4-D"],
    5: ["R5-A", "R5-B", "R5-C", "R5-D"],
    6: ["R6-A", "R6-B", "R6-C", "R6-D"],
}


def zone(rid: str) -> str:
    try:
        return VERTICAL[rid]
    except KeyError as e:
        raise KeyError(f"Unknown layout id {rid!r}") from e


def adjacent_ok(a: str, b: str) -> bool:
    """Hard: different vertical zones. Soft: different family string."""
    if zone(a) == zone(b):
        return False
    if FAMILY.get(a) == FAMILY.get(b):
        return False
    return True


def validate_mix(mix: Iterable[str]) -> list[str]:
    """Return human-readable errors (empty = ok)."""
    ids = list(mix)
    errs: list[str] = []
    if len(ids) != 6:
        errs.append(f"mix must have 6 roles, got {len(ids)}")
    for i, rid in enumerate(ids, start=1):
        if rid not in VERTICAL:
            errs.append(f"unknown {rid} at slot {i}")
        expected_prefix = f"R{i}-"
        if not rid.startswith(expected_prefix):
            errs.append(f"slot {i} expected {expected_prefix}*, got {rid}")
    for i in range(1, len(ids)):
        a, b = ids[i - 1], ids[i]
        if a in VERTICAL and b in VERTICAL and not adjacent_ok(a, b):
            errs.append(
                f"{a} ({zone(a)}) → {b} ({zone(b)}) — соседние зоны/семьи совпали"
            )
    return errs


def assert_mix(mix: Iterable[str]) -> None:
    errs = validate_mix(mix)
    if errs:
        raise ValueError("layout mix invalid:\n- " + "\n- ".join(errs))


def pick_compatible(
    start: str = "R1-A",
    prefer: dict[int, str] | None = None,
) -> list[str]:
    """Greedy pick: honour prefer[role] if zone-compatible, else first ok from pool."""
    prefer = prefer or {}
    mix = [start]
    assert start.startswith("R1-")
    for role in range(2, 7):
        prev = mix[-1]
        candidates = []
        if role in prefer:
            candidates.append(prefer[role])
        candidates.extend(POOLS[role])
        chosen = None
        seen: set[str] = set()
        for c in candidates:
            if c in seen:
                continue
            seen.add(c)
            if adjacent_ok(prev, c):
                chosen = c
                break
        if chosen is None:
            raise RuntimeError(f"no compatible R{role} after {prev}")
        mix.append(chosen)
    assert_mix(mix)
    return mix


if __name__ == "__main__":
    for name, mix in (("photo", PREFERRED_PHOTO), ("video", PREFERRED_VIDEO)):
        assert_mix(mix)
        print(name, "·".join(mix), "OK")
    print("auto from R1-A:", " · ".join(pick_compatible("R1-A")))
    print("auto from R1-B:", " · ".join(pick_compatible("R1-B")))

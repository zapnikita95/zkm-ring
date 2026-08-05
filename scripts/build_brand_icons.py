#!/usr/bin/env python3
"""Distribute assets/brand-icon-1024.png → web / Android / iOS (rounded in-app)."""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "assets" / "brand-icon-1024.png"


def make_squircle(src: Image.Image, box: int, radius_ratio: float = 0.22) -> Image.Image:
    """Rounded square for in-app / splash (iOS-like continuous corner)."""
    base = src.convert("RGBA").resize((box, box), Image.Resampling.LANCZOS)
    mask = Image.new("L", (box, box), 0)
    draw = ImageDraw.Draw(mask)
    r = int(box * radius_ratio)
    draw.rounded_rectangle([0, 0, box - 1, box - 1], radius=r, fill=255)
    out = Image.new("RGBA", (box, box), (0, 0, 0, 0))
    out.paste(base, (0, 0), mask)
    return out


def make_circle(src: Image.Image, box: int) -> Image.Image:
    base = src.convert("RGBA").resize((box, box), Image.Resampling.LANCZOS)
    mask = Image.new("L", (box, box), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, box - 1, box - 1], fill=255)
    out = Image.new("RGBA", (box, box), (0, 0, 0, 0))
    out.paste(base, (0, 0), mask)
    return out


def adaptive_foreground(src: Image.Image, box: int = 432) -> Image.Image:
    """
    Android adaptive foreground: keep art in ~66% safe zone
    so round/squircle masks don't crop the ring.
    """
    canvas = Image.new("RGBA", (box, box), (0, 0, 0, 0))
    pad = int(box * 0.18)
    inner = box - 2 * pad
    ic = src.convert("RGBA").resize((inner, inner), Image.Resampling.LANCZOS)
    canvas.alpha_composite(ic, (pad, pad))
    return canvas


def make_splash(src: Image.Image, w: int, h: int) -> Image.Image:
    canvas = Image.new("RGB", (w, h), (18, 48, 32))
    side = min(w, h)
    ic = make_squircle(src, int(side * 0.42), 0.24)
    base = canvas.convert("RGBA")
    base.alpha_composite(ic, ((w - ic.width) // 2, (h - ic.height) // 2))
    return base.convert("RGB")


def main() -> None:
    if not SRC.is_file():
        raise SystemExit(f"missing {SRC}")
    icon = Image.open(SRC).convert("RGBA")
    # solid RGB master for stores
    master = Image.new("RGB", icon.size, (18, 48, 32))
    master.paste(icon.convert("RGB"), (0, 0))

    icons_dir = ROOT / "public" / "icons"
    icons_dir.mkdir(parents=True, exist_ok=True)
    # in-app: rounded squircle PNG with transparency
    make_squircle(icon, 512, 0.23).save(icons_dir / "app-icon.png")
    make_circle(icon, 64).save(icons_dir / "favicon-64.png")
    master.resize((512, 512), Image.Resampling.LANCZOS).save(ROOT / "public" / "icon-512.png")

    android_res = ROOT / "android" / "app" / "src" / "main" / "res"
    master.save(android_res / "drawable" / "app_icon.png")

    splash_icon = make_circle(icon, 288)
    splash_icon.save(android_res / "drawable" / "splash_icon.png")
    for dens, sz in (("drawable-hdpi", 192), ("drawable-xhdpi", 256), ("drawable-xxhdpi", 384), ("drawable-xxxhdpi", 512)):
        d = android_res / dens
        d.mkdir(parents=True, exist_ok=True)
        make_circle(icon, sz).save(d / "splash_icon.png")

    for folder, sz in {
        "mipmap-mdpi": 48,
        "mipmap-hdpi": 72,
        "mipmap-xhdpi": 96,
        "mipmap-xxhdpi": 144,
        "mipmap-xxxhdpi": 192,
    }.items():
        dest = android_res / folder
        dest.mkdir(parents=True, exist_ok=True)
        full = master.resize((sz, sz), Image.Resampling.LANCZOS)
        full.save(dest / "ic_launcher.png")
        full.save(dest / "ic_launcher_round.png")
        # adaptive fg — larger canvas relative: use 108dp equivalents via scale
        fg_box = {48: 108, 72: 162, 96: 216, 144: 324, 192: 432}[sz]
        adaptive_foreground(icon, fg_box).save(dest / "ic_launcher_foreground.png")

    for rel, (w, h) in {
        "drawable/splash.png": (480, 800),
        "drawable-port-mdpi/splash.png": (320, 480),
        "drawable-port-hdpi/splash.png": (480, 800),
        "drawable-port-xhdpi/splash.png": (720, 1280),
        "drawable-port-xxhdpi/splash.png": (1080, 1920),
        "drawable-port-xxxhdpi/splash.png": (1440, 2560),
        "drawable-land-mdpi/splash.png": (480, 320),
        "drawable-land-hdpi/splash.png": (800, 480),
        "drawable-land-xhdpi/splash.png": (1280, 720),
        "drawable-land-xxhdpi/splash.png": (1920, 1080),
        "drawable-land-xxxhdpi/splash.png": (2560, 1440),
    }.items():
        path = android_res / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        make_splash(icon, w, h).save(path)

    ios_icon = master.resize((1024, 1024), Image.Resampling.LANCZOS)
    ios_icon.save(
        ROOT / "ios" / "App" / "App" / "Assets.xcassets" / "AppIcon.appiconset" / "AppIcon-512@2x.png"
    )
    splash_ios = make_splash(icon, 2732, 2732)
    splash_dir = ROOT / "ios" / "App" / "App" / "Assets.xcassets" / "Splash.imageset"
    for name in ("splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"):
        splash_ios.save(splash_dir / name)

    print("distributed", SRC)


if __name__ == "__main__":
    main()

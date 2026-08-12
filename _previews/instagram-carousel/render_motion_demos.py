#!/usr/bin/env python3
"""Motion demos for Instagram carousel: video + animated stills + text overlays.

Produces three example packs under export/motion-demos/:
  A_mixed   — real Zhivopisny video + animated stills
  B_alive   — all stills «оживлены» (water / sky / ken burns)
  C_drone   — drone/timelapse clip + still motion

Requires ffmpeg. YT sources live in assets/video/ (gitignored); renders are short MP4s.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from graphics import cover_crop_strict
from motion_overlays import make_overlay
from PIL import Image

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
VIDEO = ASSETS / "video"
OUT = ROOT / "export" / "motion-demos"
W, H = 1080, 1350
FPS = 25
DUR = 4.5  # seconds per slide
MAP_POI = "park-krylatskoe-bridge"


def run(cmd: list[str]) -> None:
    print("+", " ".join(cmd[:8]), "...")
    subprocess.run(cmd, check=True)


def overlay_on(video: Path, overlay_png: Path, out: Path, *, t: float | None = None) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    vf = (
        f"scale={W}:{H}:force_original_aspect_ratio=increase,"
        f"crop={W}:{H},setsar=1[bg];"
        f"[1:v]format=rgba[ov];"
        f"[bg][ov]overlay=0:0:format=auto"
    )
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(video),
        "-i",
        str(overlay_png),
        "-filter_complex",
        vf,
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "fast",
        "-crf",
        "20",
    ]
    if t is not None:
        cmd += ["-t", str(t)]
    else:
        cmd += ["-t", str(DUR)]
    cmd.append(str(out))
    run(cmd)


def cover_still(src: Path, out: Path, *, center=(0.5, 0.42)) -> Path:
    """Write exact 1080×1350 JPEG via uniform cover-crop. Guard against stretch."""
    out.parent.mkdir(parents=True, exist_ok=True)
    img = Image.open(src).convert("RGB")
    cover_crop_strict(img, W, H, center).save(out, "JPEG", quality=94, optimize=True)
    return out


def ensure_map_still() -> Path:
    mapped = ASSETS / f"map-{MAP_POI}.png"
    if not mapped.exists() or mapped.stat().st_size < 20_000:
        from bake_instagram_poi_map import bake

        bake(MAP_POI)
    still = OUT / "_tmp" / "map-poi-cover.jpg"
    return cover_still(mapped, still, center=(0.5, 0.5))


def still_video(still: Path, out: Path) -> None:
    """Hold a still as video without any scale distortion."""
    out.parent.mkdir(parents=True, exist_ok=True)
    run(
        [
            "ffmpeg", "-y", "-loop", "1", "-i", str(still),
            "-vf", f"scale={W}:{H}:flags=lanczos,setsar=1,fps={FPS}",
            "-t", str(DUR), "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-preset", "fast", "-crf", "20", str(out),
        ]
    )


def ken_burns(still: Path, out: Path, *, zoom_end: float = 1.18, x_expr: str = "iw/2-(iw/zoom/2)", y_expr: str = "ih/2-(ih/zoom/2)") -> None:
    """Slow push-in on a *already cover-cropped* 4:5 still — never stretch wide panos."""
    out.parent.mkdir(parents=True, exist_ok=True)
    frames = int(DUR * FPS)
    # Pre-cover to portrait so zoompan crop aspect == output aspect
    covered = out.parent / (still.stem + "-cover.jpg")
    cover_still(still, covered)
    # Extra headroom for zoom via scale-up of the square-ish portrait
    zpad = max(zoom_end, 1.05)
    vw, vh = int(W * zpad) + 4, int(H * zpad) + 4
    vf = (
        f"scale={vw}:{vh}:flags=lanczos,"
        f"zoompan=z='min(1+({zoom_end}-1)*on/{frames},{zoom_end})':"
        f"x='{x_expr}':y='{y_expr}':d={frames}:s={W}x{H}:fps={FPS},"
        f"setsar=1"
    )
    run(
        [
            "ffmpeg", "-y", "-loop", "1", "-i", str(covered),
            "-vf", vf, "-t", str(DUR), "-an", "-c:v", "libx264",
            "-pix_fmt", "yuv420p", "-preset", "fast", "-crf", "20", str(out),
        ]
    )


def water_alive(still: Path, out: Path) -> None:
    """Still with wave sway + light shimmer — input cover-cropped first."""
    out.parent.mkdir(parents=True, exist_ok=True)
    covered = out.parent / (still.stem + "-water-cover.jpg")
    cover_still(still, covered)
    vf = (
        f"scale={W+40}:{H+40}:flags=lanczos,"
        f"crop={W}:{H}:"
        f"'20+12*sin(2*PI*t*0.65)':"
        f"'20+8*sin(2*PI*t*0.5)',"
        f"eq=brightness='0.035*sin(2*PI*t*0.85)':saturation='1.1+0.08*sin(2*PI*t*0.4)',"
        f"setsar=1,fps={FPS}"
    )
    run(
        [
            "ffmpeg", "-y", "-loop", "1", "-i", str(covered),
            "-vf", vf, "-t", str(DUR), "-an", "-c:v", "libx264",
            "-pix_fmt", "yuv420p", "-preset", "fast", "-crf", "20", str(out),
        ]
    )


def sky_drift(still: Path, out: Path) -> None:
    """Horizontal drift on cover-cropped still (no wide→portrait stretch)."""
    out.parent.mkdir(parents=True, exist_ok=True)
    covered = out.parent / (still.stem + "-sky-cover.jpg")
    img = Image.open(still).convert("RGB")
    cover_crop_strict(img, W + 120, H, (0.45, 0.35)).save(covered, "JPEG", quality=94)
    frames = int(DUR * FPS)
    # zoompan with z=1: pan uses `on`; output aspect locked to s=WxH
    vf = (
        f"zoompan=z='1':"
        f"x='(iw-ow)*on/{frames}':"
        f"y='(ih-oh)/2':"
        f"d={frames}:s={W}x{H}:fps={FPS},"
        f"setsar=1"
    )
    run(
        [
            "ffmpeg", "-y", "-loop", "1", "-i", str(covered),
            "-vf", vf, "-t", str(DUR), "-an", "-c:v", "libx264",
            "-pix_fmt", "yuv420p", "-preset", "fast", "-crf", "20", str(out),
        ]
    )


def pulse_light(still: Path, out: Path) -> None:
    """Breathing light on cover-cropped still."""
    out.parent.mkdir(parents=True, exist_ok=True)
    covered = out.parent / (still.stem + "-pulse-cover.jpg")
    cover_still(still, covered)
    vf = (
        f"scale={W}:{H}:flags=lanczos,"
        f"eq=brightness='0.03*sin(2*PI*t*0.45)':contrast='1+0.04*sin(2*PI*t*0.25)',"
        f"setsar=1,fps={FPS}"
    )
    run(
        [
            "ffmpeg", "-y", "-loop", "1", "-i", str(covered),
            "-vf", vf, "-t", str(DUR), "-an", "-c:v", "libx264",
            "-pix_fmt", "yuv420p", "-preset", "fast", "-crf", "20", str(out),
        ]
    )


def trim_crop(src: Path, out: Path, *, ss: float = 0.0, t: float = DUR) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    run(
        [
            "ffmpeg",
            "-y",
            "-ss",
            str(ss),
            "-i",
            str(src),
            "-t",
            str(t),
            "-vf",
            f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},setsar=1",
            "-an",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-preset",
            "fast",
            "-crf",
            "20",
            str(out),
        ]
    )


def compose(bg_mp4: Path, overlay_kind: str, out: Path) -> None:
    ov = OUT / "_overlays" / f"{overlay_kind}.png"
    make_overlay(overlay_kind, ov)
    overlay_on(bg_mp4, ov, out)


def write_demo_html(packs: dict[str, list[Path]]) -> None:
    sections = []
    for name, files in packs.items():
        cards = "".join(
            f'<figure><video src="{p.relative_to(ROOT).as_posix()}" autoplay muted loop playsinline></video>'
            f"<figcaption>{p.stem}</figcaption></figure>"
            for p in files
        )
        sections.append(f"<section><h2>{name}</h2><div class='row'>{cards}</div></section>")
    html = f"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Motion demos — Зелёный Маршрут</title>
<style>
body{{margin:0;background:#0b0b0c;color:#f4f4f5;font-family:system-ui;padding:20px}}
h1{{font-size:22px;margin:0 0 8px}}
.lead{{color:#b4b4be;max-width:820px;line-height:1.45;margin-bottom:24px}}
section{{margin-bottom:36px}}
h2{{font-size:16px;color:#86efac;margin:0 0 12px}}
.row{{display:flex;gap:12px;overflow-x:auto;padding-bottom:8px}}
figure{{margin:0;flex:0 0 auto}}
video{{height:360px;border-radius:12px;background:#111;display:block}}
figcaption{{font-size:12px;color:#888;margin-top:6px}}
code{{color:#d8b4fe}}
</style></head><body>
<h1>Motion-карусель: видео + оживлённые фото</h1>
<p class="lead">
Слайд <b>05</b> всегда карта сервиса (кольцо + пин). Только клипы Живописного — без чужой Москвы-реки.<br/>
Рендер: <code>python3 render_motion_demos.py</code>
</p>
{''.join(sections)}
</body></html>"""
    path = ROOT / "demo-motion-carousels.html"
    path.write_text(html, encoding="utf-8")
    print("demo →", path.relative_to(ROOT))


def main():
    still_ultra = ASSETS / "bridge-ultra-pano.jpg"
    still_detail = ASSETS / "bridge-detail.jpg"
    still_pano = ASSETS / "bridge-pano.jpg"
    yt_short = VIDEO / "yt-zhivopisny-short.mp4"
    yt_drone = VIDEO / "yt-zhivopisny-drone.mp4"
    # moscow-river intentionally unused for Zhivopisny carousels

    tmp = OUT / "_tmp"
    tmp.mkdir(parents=True, exist_ok=True)

    # --- shared animated backgrounds ---
    ken1 = tmp / "ken-ultra.mp4"
    water1 = tmp / "water-detail.mp4"
    sky1 = tmp / "sky-ultra.mp4"
    pulse1 = tmp / "pulse-pano.mp4"
    ken_detail = tmp / "ken-detail.mp4"

    ken_burns(still_ultra, ken1, zoom_end=1.2, y_expr="ih*0.15")
    water_alive(still_detail, water1)
    sky_drift(still_ultra, sky1)
    pulse_light(still_pano, pulse1)
    ken_burns(still_detail, ken_detail, zoom_end=1.14, x_expr="iw*0.55-(iw/zoom/2)", y_expr="ih*0.2")

    # Slide 5 = real service map (static). Never video stretch of sunset/pano.
    map_still = ensure_map_still()
    map5 = tmp / "map-slide5.mp4"
    still_video(map_still, map5)

    packs: dict[str, list[Path]] = {}

    # ========== A: MIXED — real video + alive stills ==========
    a = OUT / "A_mixed"
    a.mkdir(parents=True, exist_ok=True)
    # 1 hook — ken burns sunset pano
    compose(ken1, "hook", a / "01-hook-kenburns.mp4")
    # 2 answer — REAL zhivopisny video
    if yt_short.exists():
        raw = tmp / "yt-short-crop.mp4"
        trim_crop(yt_short, raw, ss=1.0, t=DUR)
        compose(raw, "answer", a / "02-answer-realvideo.mp4")
    else:
        compose(sky1, "answer", a / "02-answer-skydrift.mp4")
    # 3 closed — water alive
    compose(water1, "closed", a / "03-closed-water.mp4")
    # 4 height — drone/timelapse if present
    if yt_drone.exists():
        raw = tmp / "yt-drone-crop.mp4"
        trim_crop(yt_drone, raw, ss=5.0, t=DUR)
        compose(raw, "height", a / "04-height-drone.mp4")
    else:
        compose(ken_detail, "height", a / "04-height-ken.mp4")
    # 5 route — sky drift
    compose(map5, "route", a / "05-route-map.mp4")
    # 6 cta — pulse
    compose(pulse1, "cta", a / "06-cta-pulse.mp4")
    a_files = [
        a / "01-hook-kenburns.mp4",
        a / ("02-answer-realvideo.mp4" if yt_short.exists() else "02-answer-skydrift.mp4"),
        a / "03-closed-water.mp4",
        a / ("04-height-drone.mp4" if yt_drone.exists() else "04-height-ken.mp4"),
        a / "05-route-map.mp4",
        a / "06-cta-pulse.mp4",
    ]
    keep = {p.name for p in a_files}
    for stale in a.glob("*.mp4"):
        if stale.name not in keep:
            stale.unlink()
    packs["A · mixed (видео + оживлённые фото)"] = a_files

    # ========== B: ALL ALIVE STILLS ==========
    b = OUT / "B_alive_stills"
    b.mkdir(parents=True, exist_ok=True)
    for stale in b.glob("*.mp4"):
        stale.unlink()
    b_files = [
        b / "01-hook-kenburns.mp4",
        b / "02-answer-skydrift.mp4",
        b / "03-closed-water.mp4",
        b / "04-height-ken.mp4",
        b / "05-route-map.mp4",
        b / "06-cta-water.mp4",
    ]
    compose(ken1, "hook", b_files[0])
    compose(sky1, "answer", b_files[1])
    compose(water1, "closed", b_files[2])
    compose(ken_detail, "height", b_files[3])
    compose(map5, "route", b_files[4])
    compose(water1, "cta", b_files[5])
    packs["B · только оживлённые фото"] = b_files

    # ========== C: VIDEO-HEAVY (only Zhivopisny footage) ==========
    c = OUT / "C_video_heavy"
    c.mkdir(parents=True, exist_ok=True)
    # wipe stale leftovers so demo HTML never shows old moscow-river / skydrift
    for stale in c.glob("*.mp4"):
        stale.unlink()
    c_files: list[Path] = []
    if yt_drone.exists():
        raw = tmp / "drone-hook.mp4"
        trim_crop(yt_drone, raw, ss=0.5, t=DUR)
        out = c / "01-hook-drone.mp4"
        compose(raw, "hook", out)
        c_files.append(out)
    else:
        out = c / "01-hook-ken.mp4"
        compose(ken1, "hook", out)
        c_files.append(out)
    if yt_short.exists():
        trim_crop(yt_short, tmp / "yt2.mp4", ss=4.0, t=DUR)
        out = c / "02-answer-realvideo.mp4"
        compose(tmp / "yt2.mp4", "answer", out)
        c_files.append(out)
        trim_crop(yt_short, tmp / "yt3.mp4", ss=8.0, t=DUR)
        out = c / "03-closed-realvideo.mp4"
        compose(tmp / "yt3.mp4", "closed", out)
        c_files.append(out)
    else:
        out = c / "02-answer.mp4"
        compose(sky1, "answer", out)
        c_files.append(out)
        out = c / "03-closed.mp4"
        compose(water1, "closed", out)
        c_files.append(out)
    # Height: ONLY Zhivopisny — drone second cut, else short, else ken on bridge detail
    # Never moscow-river (Храм Христа / чужая Москва)
    if yt_drone.exists():
        trim_crop(yt_drone, tmp / "drone-height.mp4", ss=12.0, t=DUR)
        out = c / "04-height-drone.mp4"
        compose(tmp / "drone-height.mp4", "height", out)
        c_files.append(out)
    elif yt_short.exists():
        trim_crop(yt_short, tmp / "yt-height.mp4", ss=10.0, t=DUR)
        out = c / "04-height-realvideo.mp4"
        compose(tmp / "yt-height.mp4", "height", out)
        c_files.append(out)
    else:
        out = c / "04-height-ken.mp4"
        compose(ken_detail, "height", out)
        c_files.append(out)
    out = c / "05-route-map.mp4"
    compose(map5, "route", out)
    c_files.append(out)
    out = c / "06-cta-pulse.mp4"
    compose(pulse1, "cta", out)
    c_files.append(out)
    packs["C · video-heavy (только Живописный + карта)"] = c_files

    write_demo_html(packs)
    meta = {
        "duration_sec": DUR,
        "size": f"{W}x{H}",
        "packs": {k: [p.name for p in v] for k, v in packs.items()},
        "sources": {
            "stills": ["bridge-ultra-pano.jpg", "bridge-detail.jpg", "bridge-pano.jpg"],
            "video_demo": [
                "yt-zhivopisny-short.mp4 (YouTube WJ7bwcTPBUU — demo only)",
                "yt-zhivopisny-drone.mp4 (YouTube ZLUaz81C3LU — demo only)",
                            ],
            "note": "YT clips gitignored; regenerate with yt-dlp. Animated stills are ours.",
        },
    }
    (OUT / "index.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print("done →", OUT)


if __name__ == "__main__":
    main()

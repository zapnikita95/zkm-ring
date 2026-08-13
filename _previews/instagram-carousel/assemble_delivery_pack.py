#!/usr/bin/env python3
"""Assemble PHOTO + VIDEO + MIXED delivery triad for owner review.

Default: lightweight folder (README + manifest) + HTML that points at
canonical photo / motion sources (no duplicate multi‑MB MP4s).

Canon: docs/instagram/DELIVERY_CANON.md
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EXPORT = ROOT / "export"

SOURCES = {
    "zhivopisny": {
        "photo_rel": "export/upload-zhivopisny/photo",
        "video_rel": "export/motion-demos/C_video_heavy",
        "mixed_rel": "export/motion-demos/A_mixed",
        "post": EXPORT / "upload-zhivopisny" / "POST.md",
        "caption": EXPORT / "upload-zhivopisny" / "CAPTION.txt",
        "role_mix_photo": ["R1-A", "R2-D", "R3-B", "R4-A", "R5-A", "R6-B"],
        "role_mix_video": ["R1-A", "R2-C", "R3-B", "R4-A", "R5-A", "R6-B"],
        "role_mix_mixed": ["R1-A", "R2-C", "R3-B", "R4-A", "R5-A", "R6-B"],
    },
}


def list_files(rel: str, suffixes: tuple[str, ...]) -> list[str]:
    src = ROOT / rel
    if not src.is_dir():
        raise FileNotFoundError(f"missing source: {src}")
    names = sorted(
        p.name for p in src.iterdir() if p.is_file() and p.suffix.lower() in suffixes
    )
    if not names:
        raise FileNotFoundError(f"no {suffixes} in {src}")
    return names


def write_demo(slug: str, cfg: dict, meta: dict) -> Path:
    def figs(rel: str, names: list[str], kind: str) -> str:
        bits = []
        for n in names:
            src = f"{rel}/{n}"
            if kind == "img":
                bits.append(
                    f'<figure><img src="{src}" alt=""/><figcaption>{n}</figcaption></figure>'
                )
            else:
                bits.append(
                    f'<figure><video src="{src}" autoplay muted loop playsinline></video>'
                    f"<figcaption>{n}</figcaption></figure>"
                )
        return "".join(bits)

    html = f"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Delivery · {slug} — PHOTO / VIDEO / MIXED</title>
<style>
:root{{--bg:#0b0b0c;--muted:#b4b4be;--g:#86efac;--p:#d8b4fe}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bg);color:#f4f4f5;font-family:ui-sans-serif,system-ui;padding:24px}}
h1{{font-size:22px;margin:0 0 8px}}
h2{{font-size:15px;color:var(--g);margin:28px 0 8px}}
.lead{{color:var(--muted);max-width:920px;line-height:1.45;margin-bottom:8px}}
.note{{color:#a1a1aa;font-size:13px;margin-bottom:20px}}
code{{color:var(--p)}}
.row{{display:flex;gap:10px;overflow-x:auto;padding-bottom:8px}}
figure{{margin:0;flex:0 0 auto}}
img,video{{height:340px;border-radius:12px;background:#111;display:block}}
figcaption{{font-size:11px;color:#888;margin-top:6px}}
.mix{{font-size:13px;color:#a1a1aa;margin:0 0 10px}}
.path{{font-size:12px;color:#71717a;margin:0 0 8px}}
</style></head><body>
<h1>Delivery-триада · {slug}</h1>
<p class="lead">
Канон: <code>docs/instagram/DELIVERY_CANON.md</code> · индекс: <code>docs/instagram/README.md</code><br/>
Сначала три пакета → потом выбор, что выкладываем.
</p>
<p class="note">PHOTO = JPEG · VIDEO = живые клипы · MIXED = видео + оживлённые фото. Слайд 05 = карта сервиса.</p>

<h2>1 · PHOTO</h2>
<p class="mix">микс: {' · '.join(meta['role_mix_photo'])}</p>
<p class="path"><code>{cfg['photo_rel']}/</code></p>
<div class="row">{figs(cfg['photo_rel'], meta['photo_files'], 'img')}</div>

<h2>2 · VIDEO</h2>
<p class="mix">микс: {' · '.join(meta['role_mix_video'])}</p>
<p class="path"><code>{cfg['video_rel']}/</code></p>
<div class="row">{figs(cfg['video_rel'], meta['video_files'], 'vid')}</div>

<h2>3 · MIXED (совмещённый)</h2>
<p class="mix">микс: {' · '.join(meta['role_mix_mixed'])}</p>
<p class="path"><code>{cfg['mixed_rel']}/</code></p>
<div class="row">{figs(cfg['mixed_rel'], meta['mixed_files'], 'vid')}</div>
</body></html>
"""
    path = ROOT / f"demo-delivery-{slug}.html"
    path.write_text(html, encoding="utf-8")
    return path


def maybe_copy_fat(slug: str, cfg: dict) -> None:
    """Optional fat pack with real file copies (local only; large)."""
    out = EXPORT / f"delivery-{slug}"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    for key, rel, suf in (
        ("photo", cfg["photo_rel"], (".jpg", ".jpeg", ".png")),
        ("video", cfg["video_rel"], (".mp4",)),
        ("mixed", cfg["mixed_rel"], (".mp4",)),
    ):
        src = ROOT / rel
        dst = out / key
        dst.mkdir()
        for p in sorted(src.iterdir()):
            if p.is_file() and p.suffix.lower() in suf:
                shutil.copy2(p, dst / p.name)
    for key, name in (("post", "POST.md"), ("caption", "CAPTION.txt")):
        src = cfg.get(key)
        if src and Path(src).is_file():
            shutil.copy2(src, out / name)


def assemble(slug: str, *, fat: bool = False) -> Path:
    if slug not in SOURCES:
        raise SystemExit(f"unknown slug {slug!r}; known: {', '.join(SOURCES)}")
    cfg = SOURCES[slug]
    photo = list_files(cfg["photo_rel"], (".jpg", ".jpeg", ".png"))
    video = list_files(cfg["video_rel"], (".mp4",))
    mixed = list_files(cfg["mixed_rel"], (".mp4",))

    out = EXPORT / f"delivery-{slug}"
    out.mkdir(parents=True, exist_ok=True)
    meta = {
        "slug": slug,
        "packs": ["photo", "video", "mixed"],
        "photo_path": cfg["photo_rel"],
        "video_path": cfg["video_rel"],
        "mixed_path": cfg["mixed_rel"],
        "role_mix_photo": cfg["role_mix_photo"],
        "role_mix_video": cfg["role_mix_video"],
        "role_mix_mixed": cfg["role_mix_mixed"],
        "photo_files": photo,
        "video_files": video,
        "mixed_files": mixed,
        "canon": "docs/instagram/DELIVERY_CANON.md",
        "demo": f"demo-delivery-{slug}.html",
    }
    (out / "manifest.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (out / "README.md").write_text(
        f"""# Delivery · {slug}

Три пакета (канон `docs/instagram/DELIVERY_CANON.md`):

| Пакет | Путь |
|-------|------|
| PHOTO | `{cfg['photo_rel']}/` |
| VIDEO | `{cfg['video_rel']}/` |
| MIXED | `{cfg['mixed_rel']}/` |

Превью: `demo-delivery-{slug}.html` (из `_previews/instagram-carousel/`).

Микс PHOTO: `{' · '.join(cfg['role_mix_photo'])}`  
Микс VIDEO / MIXED: `{' · '.join(cfg['role_mix_video'])}`

Собрать fat-копию локально: `python3 assemble_delivery_pack.py --slug {slug} --fat`
""",
        encoding="utf-8",
    )
    for key, name in (("post", "POST.md"), ("caption", "CAPTION.txt")):
        src = cfg.get(key)
        if src and Path(src).is_file():
            shutil.copy2(src, out / name)

    demo = write_demo(slug, cfg, meta)
    if fat:
        maybe_copy_fat(slug, cfg)
        # restore lightweight docs into fat tree
        (out / "manifest.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    print("delivery →", out)
    print("demo →", demo)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--slug", default="zhivopisny")
    ap.add_argument(
        "--fat",
        action="store_true",
        help="Also copy JPEG/MP4 into export/delivery-{slug}/ (large)",
    )
    args = ap.parse_args()
    assemble(args.slug, fat=args.fat)


if __name__ == "__main__":
    main()

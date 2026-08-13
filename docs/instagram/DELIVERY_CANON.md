# Delivery-канон: как сдавать карусель / Reels-ready пакет

**Жёсткое правило для агента.**  
Когда владелец просит «сделай карусель / Reels / пост» по точке — **сначала** показать **три готовых пакета**, и только потом спрашивать, какой выкладывать (или править).

Нельзя сразу отдавать один набор JPEG «как финал».

---

## Три пакета (всегда)

| # | Пакет | Что внутри | Эталон Живописный |
|---|--------|------------|-------------------|
| 1 | **PHOTO** | 6× JPEG 4:5, коллажи ≥2, карта на 05 | `export/upload-zhivopisny/photo/` |
| 2 | **VIDEO** | 6× MP4 4:5, живые клипы **этой** точки + карта на 05 | `export/motion-demos/C_video_heavy/` |
| 3 | **MIXED** | Совмещённый: часть real video + оживлённые stills + карта | `export/motion-demos/A_mixed/` |

Опционально (не заменяет тройку): **B_alive_stills** — только Ken Burns / drift без raw video.

Формат слайда: **1080×1350 (4:5)**, ~4–5 с на видео-кадр, без звука (трек — в Instagram).  
Это и есть «Reels-ready карусель»: заливается как карусель с видео; музыка → шанс в Reels feed.

Отдельный одиночный 9:16 Reels — **другой** формат; если нужен — явно после выбора пакета.

---

## Порядок работы агента

1. История → формулировки на 6 ролей (`stories/` + `CAROUSEL_STRUCTURE.md`).  
2. Микс раскладок с зонами (`ROLE_LAYOUT_VARIANTS.md` + `role_layout_zones.py`).  
3. Собрать **PHOTO**, **VIDEO**, **MIXED**.  
4. Положить в `export/delivery-{slug}/` и открыть `demo-delivery-{slug}.html`.  
5. В ответе владельцу — **три блока** со ссылками/путями + микс ролей + caption.  
6. Ждать выбор («фото» / «видео» / «совмещённый» / правки).  
7. Только после выбора — «готово к заливу» / upload folder.

### Шаблон ответа владельцу

```markdown
## PHOTO
путь: …/delivery-{slug}/photo/
микс: R1-… · R2-…

## VIDEO
путь: …/delivery-{slug}/video/
микс: …

## MIXED (совмещённый)
путь: …/delivery-{slug}/mixed/
микс: …

Какой выкладываем? (или что править)
```

---

## Сборка delivery-папки

```bash
cd _previews/instagram-carousel
python3 render_zhivopisny_post.py          # PHOTO (эталон slug)
# при наличии клипов:
python3 render_motion_demos.py             # A=MIXED, C=VIDEO
python3 assemble_delivery_pack.py --slug zhivopisny
open demo-delivery-zhivopisny.html
```

По умолчанию — **лёгкий** индекс (без дубля MP4):

```
export/delivery-{slug}/
  README.md          — пути к трём пакетам
  POST.md / CAPTION.txt
  manifest.json
demo-delivery-{slug}.html   — PHOTO / VIDEO / MIXED рядом
```

Файлы смотрят на канонические папки (`upload-…/photo`, `motion-demos/C_*`, `A_mixed`).  
Локальная fat-копия со всеми файлами в одной папке: `--fat`.

---

## Зоны и раскладки (не забыть)

- После нижнего R1 нельзя снова низ на R2 → пул R2-A…D (верх/центр), R2-E только после верхнего R1.  
- Соседи: разная вертикальная зона `top` / `mid` / `bottom`.  
- Эталон photo: `R1-A · R2-D · R3-B · R4-A · R5-A · R6-B`.  
- Эталон video: `R1-A · R2-C · R3-B · R4-A · R5-A · R6-B`.

---

## Перенос в Movie Planner

Скопировать логику из `docs/instagram/README.md` § «Портативный каркас».  
Delivery-триада та же: постеры/кадры фильма (PHOTO) · трейлер/клипы (VIDEO) · микс (MIXED).  
Роли можно сузить (hook → film → emotion → fact → where to watch → CTA app).

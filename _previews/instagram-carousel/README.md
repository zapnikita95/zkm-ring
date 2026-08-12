# Instagram carousel demos (real slides)

Не градиентные заглушки — **готовые JPEG 1080×1350** с фото Wikimedia + типографика по правилам каруселей 2025–26.

| Демо | Слайды | Открыть |
|------|--------|---------|
| Живописный мост | `export/zhivopisny/` | [demo-zhivopisny.html](./demo-zhivopisny.html) |
| Ростокинский акведук | `export/aqueduct/` | [demo-aqueduct.html](./demo-aqueduct.html) |

## Как смотреть

Открой HTML в браузере и **свайпай** как в Instagram. Слайды 1–3 каждой карусели нарезаны из одного wide-фото (SCRL seam).

## Пересобрать

```bash
# assets/ уже с фото; при необходимости скачай снова через Commons API
python3 render_carousels.py
```

## Прод в SCRL

1. Открой [SCRL](https://scrl.com/) → Blank → 6 frames → **4:5**.  
2. Положи ultra-wide / свои фото через швы (как в `export/*/slide-01…03`).  
3. Текст хука **только** frame 1; CTA — последний.  
4. Export → проверить порядок → Instagram + музыка (boost в Reels feed).

Канон: skill `instagram-carousel-green-route`, `docs/INSTAGRAM_CONTENT_SYSTEM.md`.

## Фото

Фоны из Wikimedia Commons (см. `assets/`). Атрибуция — страницы файлов на Commons; для коммерческого IG-аккаунта лучше свои съёмки.

# Instagram content system — входная точка

Вся система каруселей / Reels-ready пакетов для **Зелёного Маршрута** лежит здесь и в соседних путях ниже.

**Скопировать в другой продукт (Movie Planner и т.п.):** бери структуру ролей + зоны + delivery-триаду + запреты копирайта; поменяй бренд-токены, CTA URL и источники медиа.

---

## Куда смотреть (карта)

| Что нужно | Путь |
|-----------|------|
| **Старт агента / человека** | этот файл + skill ниже |
| **Обязательный порядок сдачи** (фото → видео → совмещённый) | [`DELIVERY_CANON.md`](./DELIVERY_CANON.md) |
| Skill агента | [`.cursor/skills/instagram-carousel-green-route/SKILL.md`](../../.cursor/skills/instagram-carousel-green-route/SKILL.md) |
| Обзор системы + календарь | [`../INSTAGRAM_CONTENT_SYSTEM.md`](../INSTAGRAM_CONTENT_SYSTEM.md) |
| 6 ролей карусели | [`CAROUSEL_STRUCTURE.md`](./CAROUSEL_STRUCTURE.md) |
| Пулы раскладок R1–R6 + зоны top/mid/bottom | [`ROLE_LAYOUT_VARIANTS.md`](./ROLE_LAYOUT_VARIANTS.md) |
| Словарь семей S01–S10 | [`PLACEMENT_SCHEMAS.md`](./PLACEMENT_SCHEMAS.md) |
| Motion / видео-слайды | [`MOTION_CAROUSELS.md`](./MOTION_CAROUSELS.md) |
| Какие точки можно в video-heavy | [`VIDEO_POI_LIST.md`](./VIDEO_POI_LIST.md) |
| История / формулировки (эталон) | [`stories/zhivopisny-flying-saucer.md`](./stories/zhivopisny-flying-saucer.md) |
| Шаблон новой истории | [`stories/_TEMPLATE.md`](./stories/_TEMPLATE.md) |
| Place briefs | [`briefs/`](./briefs/) |

## Код и артефакты

Корень рендеров:

```
_previews/instagram-carousel/
```

| Артефакт | Путь |
|----------|------|
| Зоны / assert микса | `role_layout_zones.py` |
| Photo upload Живописный | `export/upload-zhivopisny/photo/` |
| Video pack (C) | `export/motion-demos/C_video_heavy/` |
| Совмещённый (A) | `export/motion-demos/A_mixed/` |
| Delivery-триада (готово к выбору) | `export/delivery-zhivopisny/` |
| HTML: три пакета рядом | `demo-delivery-zhivopisny.html` |
| HTML: motion A/B/C | `demo-motion-carousels.html` |
| HTML: варианты R1–R6 | `demo-role-layout-variants.html` |

**GitHub:** https://github.com/zapnikita95/zkm-ring  

**Локальный клон (эта машина):**

```
/Users/nikitazaporohzets/Desktop/Кино/zkm-ring/docs/instagram/
/Users/nikitazaporohzets/Desktop/Кино/zkm-ring/_previews/instagram-carousel/
```

После `git pull` на Desktop-клоне пути совпадут с репо. Worktree агента может быть `/tmp/zkm-ring-*` — смотри `docs/instagram/` внутри него.

## Портативный каркас (для Movie Planner / фильмов)

1. **6 ролей** — hook → about → emotion → fact → route/context → CTA  
2. **Вертикальные зоны** — соседние кадры ≠ одна зона (`top` / `mid` / `bottom`)  
3. **Delivery-триада** — всегда сначала показать: PHOTO · VIDEO · MIXED, потом выбрать  
4. **Копирайт** — факты только из источников; без внутренних ярлыков на слайде  
5. **CTA** — только последний кадр; URL продукта  

Бренд Зелёного Маршрута (`green-route.ru`, ЗКМ, карта кольца) — **не** тащить в Movie Planner; заменить на film posters / `/f/{id}` / movie-planner.ru.

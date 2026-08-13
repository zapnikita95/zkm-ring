# Instagram: точки ЗКМ → карусели SCRL

Контент-система для **Зелёный Маршрут** ([green-route.ru](https://green-route.ru)).  
Agent skill: `.cursor/skills/instagram-carousel-green-route/SKILL.md`.

**Не путать:** продукт — «Зелёный Маршрут», домен — `green-route.ru` (не Green Road, не movie-planner).

**Входная карта:** [`docs/instagram/README.md`](instagram/README.md)  
**Сдача поста:** всегда PHOTO + VIDEO + MIXED → [`DELIVERY_CANON.md`](instagram/DELIVERY_CANON.md)

---

## 1. Аудитория (Яндекс.Метрика)

Счётчик сайта: `111389829` (`public/yandex-metrika.js`). Срез ~90 дней (выборка небольшая — ориентир):

| Срез | Факт |
|------|------|
| Пол | ~70% мужчины / ~30% женщины (среди визитов с age/gender) |
| Возраст | Ядро **25–34**, затем **35–44** |
| Гео | Москва |
| Устройства | Смартфоны ~84% |
| Интересы | Tourism, Health, Family & children, Cinema… |
| Вход | `/`, `/about`; direct + search; соцсети пока слабые |

**Портрет:** москвич 25–40, чаще мужчина, хочет «куда съездить / прокатиться», ценит архитектуру, смотровые, инженерный вау, неожиданные факты. Не спортивный Strava-вайб (см. `docs/PRODUCT.md`).

Пересмотреть креатив через 1–2 месяца, когда база Метрики вырастет.

---

## 2. Moodboard / бренд-токены

| Роль | Значение |
|------|----------|
| Имя | Зелёный Маршрут |
| URL | green-route.ru |
| Green | `#1f8f4a` |
| Dark | `#121412` |
| Cream | `#f0f2f0` |
| Accent warm | `#e67e22` |
| Accent gold | `#c9a227` |
| Шрифты | 1 display (хук) + 1 body |
| Элементы | линия-кольцо, пин, чип «ЗКМ», «свайп →» |
| Watermark | `green-route.ru` на слайдах 2+ |

Демо HTML: [`_previews/instagram-carousel/`](../_previews/instagram-carousel/).

---

## 3. Рейтинг точек (первая очередь)

| Rank | Место | Почему | Видео (C) |
|------|-------|--------|-----------|
| 1 | Живописный мост | Инженерный иконостас, идеальный SCRL | **да** |
| 2 | Смотровая Воробьёвых + МГУ | Скайлайн, reels-ready | кандидат |
| 3 | Царицыно | Дворец + парк, семья + фото | кандидат |
| 4 | Ростокинский акведук | «Рим в Москве», surprise | нет |
| 5 | Останкино (башня + усадьба) | Узнаваемая вертикаль | кандидат |
| 6 | Кусково | Дворец + пруд | кандидат |
| 7 | Серебряный Бор | Природа внутри МКАД | кандидат |
| 8 | Паровоз / депо Подмосковная | Industrial cool для ядра 25–34 | нет |
| 9 | Измайловский кремль | Цвет → стоп-скролл | кандидат |
| 10 | Церковь Покрова в Филях | Архитектура (не проповедь) | нет |
| 11 | Крылатское | Спорт-архитектура + рельеф | нет |
| 12 | Главный ботанический сад | Семья + зелёный бренд | нет |

Канон video-пула: [`docs/instagram/VIDEO_POI_LIST.md`](instagram/VIDEO_POI_LIST.md). Вариант C — только при `видео=да`.

Пул данных: `public/data/theme-layers.json`, ориентиры `docs/RING_LANDMARKS_ORDER.md`.

Briefs: `docs/instagram/briefs/`. Шаблон: `docs/instagram/place-brief-TEMPLATE.md`.

---

## 4. Скелет карусели + layouts

Формат: **4:5 (1080×1350)**, 6 слайдов.

**Роли:** 1 вовлечение → 2 об объекте → 3 эмоция → 4 взрывной факт → 5 маршрут → 6 зазывалочка.  
Канон: [`docs/instagram/CAROUSEL_STRUCTURE.md`](instagram/CAROUSEL_STRUCTURE.md).  
10 схем блоков: [`PLACEMENT_SCHEMAS.md`](instagram/PLACEMENT_SCHEMAS.md) + `demo-placement-schemas.html`.  
Соседи ≠ одна схема. Фото: коллажи ≥2 кадра. Слайд 05 = карта сервиса.

Копирайт: только **отрезок**, никогда **кусок**. Без «свайп» / «ванты» / «ВАУ-ФАКТ» на слайде.

Upload-эталон: `export/upload-zhivopisny/` · рендер `python3 render_zhivopisny_post.py`.

### CTA-пул (ротация на последнем слайде)

1. Соберите отрезок Зелёного кольца мимо этого места → green-route.ru  
2. Старт у МЦК/МЦД — и ты уже на маршруте. Зелёный Маршрут  
3. Не весь круг: выбери старт и финиш сам → green-route.ru  
4. Прокатись / пройди мимо [место] по готовому треку  
5. Семейный отрезок с туалетами рядом — на green-route.ru  
6. Сохрани пост и открой маршрут, когда будет час → green-route.ru  

---

## 5. Первая волна (календарь 6 постов / ~2 недели)

Порядок съёмки/постов из плана: мост → смотровая → Царицыно → акведук → Кусково → Серебряный Бор (+ паровоз как запасной).

| # | День (от старта волны) | Место | Layout mix | CTA # | Brief |
|---|------------------------|-------|------------|-------|-------|
| 1 | D0 | Живописный мост | L3 панорама + L5 цифра + L10 CTA | 1 | [zhivopisny-most.md](instagram/briefs/zhivopisny-most.md) |
| 2 | D2 | Смотровая Воробьёвых + МГУ | L1 full-bleed + L7 человек + L10 | 2 | *(brief при съёмке)* |
| 3 | D4 | Царицыно | L2 seam-плашка + L9 факт + L10 | 5 | [tsaritsyno.md](instagram/briefs/tsaritsyno.md) |
| 4 | D7 | Ростокинский акведук | L3 панорама + L5 + L6 карта + L10 | 3 | [rostokino-aqueduct.md](instagram/briefs/rostokino-aqueduct.md) |
| 5 | D10 | Кусково | L1 + L4 далеко/близко + L10 | 4 | *(brief при съёмке)* |
| 6 | D13 | Серебряный Бор | L8 коллаж + L6 + L10 | 6 | *(brief при съёмке; связка с family-walk)* |

**Правила волны:** не повторять один CTA подряд; caption всегда с `green-route.ru`; после поста #3 — глянуть saves/shares и при необходимости сдвинуть Кусково ↔ паровоз.

Запасной пост (если нужно усилить male 25–34): **Паровоз Л-3516 / депо Подмосковная**, CTA #4, layout L5+L9.

---

## 6. Боевая карусель + авто-контраст + SCRL

**Ready-to-post (одна):**

- Превью: [`demo-battle-zhivopisny.html`](../_previews/instagram-carousel/demo-battle-zhivopisny.html)  
- JPEG: `_previews/instagram-carousel/export/battle-zhivopisny/slide-01…06.jpg`  
- Контраст: `contrast.py` — сетка пикселей под bbox, WCAG worst-case; **оранжевый/gold только на тёмной плашке**  
- Аудит: `export/battle-zhivopisny/contrast-audit.json` (не постить при `FAIL`)  
- Сборка: `python3 _previews/instagram-carousel/render_battle_zhivopisny.py`

**Демо v2:** `demo-zhivopisny.html` / `demo-aqueduct.html` · `render_carousels.py`

**Сборка в SCRL (прод / свои фото):**

1. SCRL → Blank → 6 frames → **4:5**.  
2. Wide-фото через швы; шов не по центру объекта.  
3. Хук только frame 1; CTA — последний; «свайп →» только на 1.  
4. Preview → Export → порядок → Instagram + музыка.

Правила карусели — в skill § «Как делать пиздатые карусели».

---

## 7. Delivery-триада (канон)

При запросе карусели / Reels-ready пакета агент **сначала** показывает:

1. PHOTO — `export/delivery-{slug}/photo/`  
2. VIDEO — `export/delivery-{slug}/video/`  
3. MIXED — `export/delivery-{slug}/mixed/`  

Превью: `demo-delivery-{slug}.html`. Эталон: `delivery-zhivopisny`.  
Подробности: [`instagram/DELIVERY_CANON.md`](instagram/DELIVERY_CANON.md).

## 8. Дальше

- Остальные places 2–12 — brief + delivery-триада.  
- Одиночный 9:16 Reels — по явному запросу после выбора пакета.  
- Перенос каркаса в Movie Planner — § портативный в `instagram/README.md`.

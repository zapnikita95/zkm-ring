# ЗКМ — мини-игра по Зелёному кольцу Москвы

Отдельное PWA (не связано с Movie Planner). Строит свой кусок кольца ЗКМ пешком или на велосипеде, показывает парки-награды и ведёт либо **в приложении**, либо **кусками в Яндекс.Картах**.

## Быстрый старт

```bash
cd zkm-ring
npm install
npm run dev
```

Открой URL из терминала (обычно `http://localhost:5173`). Для GPS нужен HTTPS или `localhost`.

## Что офлайн / что нет

| Действие | API Яндекса? |
|----------|----------------|
| Трек, длина, время, направление | Нет — локальный GPX → `public/data/ring.geojson` |
| Парки и награды | Нет — `public/data/parks.json` |
| Карта превью / in-app | Нет — MapLibre + тайлы OpenStreetMap |
| Кусок «открыть в Яндекс.Картах» | Нет — deep link `yandex.ru/maps/?rtext=…` без ключа |
| Suggest / Geocoder | **Не используется** в MVP |

Ключ Яндекса понадобится только если позже добавить адресный поиск или JS API Карт вместо OSM.

## Лимит точек Яндекса

Веб/приложение Карт нормально ест **~7–10 точек** в одном `rtext`. Поэтому выбранный маршрут режется на сегменты по 7 точек (`src/yandex.ts`). Companion-экран следит за GPS у конца куска и предлагает «Продолжить».

Яндекс **сам не вызывает** наше приложение по прибытии — нужен возврат в PWA (особенно на iOS).

## Данные

- `public/data/ring.geojson` — линия ЗКМ (~2080 точек) из `track21.gpx`
- `public/data/pois.json` — именованные waypoint из GPX
- `public/data/parks.json` — 15 ключевых парков для наград (кураторский список)

Пересобрать из GPX:

```bash
python3 scripts/import_gpx.py /path/to/track21.gpx
```

## Скрипты

- `npm run dev` — разработка
- `npm run build` — production + PWA service worker
- `npm run preview` — локальный просмотр сборки

## Стек

Vite + TypeScript, MapLibre GL, vite-plugin-pwa. Без бэкенда; награды в `localStorage`.

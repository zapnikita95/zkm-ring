# Аналитика Зелёный Маршрут

## Яндекс.Метрика (сайт)

| | |
|--|--|
| Счётчик | **111389829** |
| Дашборд | https://metrika.yandex.ru/dashboard?id=111389829 |
| Код | `/yandex-metrika.js` |

Цели (JS `reachGoal`): `register`, `login`, `open_telegram`, `build_route`, `open_yandex_maps`, `track_select`.

## Свой лог (матч бот ↔ сайт)

Таблица `analytics_events` в SQLite (`ZM_DATA_DIR`, прод: volume сервиса **green-route-web** / `zm.sqlite`).  
Пишут: сайт (`POST /api/analytics/event`), API (register/login/link_telegram), бот (`POST /api/analytics/bot` + `X-Bot-Secret`).

### Важно: Railway Deploy Logs ≠ поездки

JSON из Railway (`logs.*.json` / stdout бота) — это **технические логи** контейнера (start/stop, webhook conflict), **не** аналитика маршрутов. Поездки смотреть только в SQLite:

```bash
# на машине с доступом к ZM_DATA_DIR / скачанном zm.sqlite
sqlite3 "$ZM_DATA_DIR/zm.sqlite" \
  "SELECT created_at, event, props_json FROM analytics_events
   WHERE event IN ('build_route','open_yandex_maps','open_2gis_maps','bot_segment','save_plan')
   ORDER BY id DESC LIMIT 20;"
```

### Trip-поля в props_json

`build_route`, `open_yandex_maps`, `open_2gis_maps`, `save_plan`, `bot_segment` пишут:

| Поле | Смысл |
|------|--------|
| `tripId` | Корреляция сессии маршрута (web: `t_…`, bot: `b_{tg}_{ts}`) |
| `startLat` / `startLon` / `endLat` / `endLon` | Концы сегмента |
| `meters`, `mode`, `routeId` | Длина и трек |
| `legIndex` / `legCount` | Нога Яндекс/2ГИС (на open_*) |
| `viaCount` / `viaChecksum` | Контроль dense via (поиск «уезжающей» точки без скрина) |

## Кабинет владельца

```
https://green-route.ru/stats?key=ZM_STATS_SECRET
https://green-route.ru/api/admin/stats?key=ZM_STATS_SECRET
```

Env на **green-route-web**:

- `ZM_STATS_SECRET` — ключ дашборда
- `YANDEX_METRIKA_COUNTER_ID=111389829` (опционально)
- `ZM_BOT_UPLOAD_SECRET` — уже есть (бот шлёт события)

В дашборде: регистрации, уник. `/start` в боте, матч `telegram_id` ↔ login.

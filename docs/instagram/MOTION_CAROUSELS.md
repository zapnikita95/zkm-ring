# Motion-карусели (видео + оживлённые фото)

## Зачем

Карусель может быть не только JPEG: Instagram принимает **видео-слайды**.  
Текст кладём поверх движения: реальный ролик или «оживлённая» фотография.

## Три демо-пачки

| Пачка | Идея |
|-------|------|
| **A_mixed** | Хук Ken Burns → живое видео моста → water-alive → дрон → sky drift → CTA |
| **B_alive_stills** | Только фото, но все двигаются (zoom / drift / pulse / wave) |
| **C_video_heavy** | Дрон + два куска YT Живописного + Wikimedia Москва-река |

Смотреть: `_previews/instagram-carousel/demo-motion-carousels.html`

## Приёмы движения

| Приём | Когда |
|-------|--------|
| **Ken Burns** | закат / архитектура, медленный наезд |
| **Sky drift** | широкий пано, «облака едут» |
| **Water / wave** | кадры с водой — лёгкое покачивание + пульс света |
| **Pulse light** | дыхание экспозиции на статичном кадре |
| **Real video** | живой мост / дрон / река + PNG-оверлей текста |

## Рендер

```bash
cd _previews/instagram-carousel
# опционально: скачать YT-исходники (gitignored)
yt-dlp -f "bv*[height<=1080]+ba/b" -o "assets/video/yt-zhivopisny-short.mp4" \
  "https://www.youtube.com/watch?v=WJ7bwcTPBUU"
python3 render_motion_demos.py
open demo-motion-carousels.html
```

Формат слайда: **1080×1350**, ~4.5 с, без звука (Instagram сам накинет трек).

## Важно

- YT-исходники — **только для локального демо**, в git не кладём (`assets/video/yt-*.mp4`).
- Wikimedia `moscow-river` — OK как CC-пример реки.
- Для боевого поста лучше своя съёмка / лицензированный сток.
- Копирайт на оверлеях — тот же канон: без «свайп», без «кусок», факты не выдумывать.

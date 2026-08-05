<p align="center">
  <img src="assets/brand-icon-1024.png" width="140" alt="Зелёный Маршрут" />
</p>

<h1 align="center">Зелёный Маршрут</h1>

<p align="center"><strong>Приятный кусок пути. Не спортзал.</strong></p>

<p align="center">
  Готовый красивый трек → старт и финиш где удобно → дальше в <strong>Яндекс.Картах</strong>.<br/>
  Для тех, кто гуляет и катается <em>по случаю</em> — без Komoot, Strava и «специальных» приложений.
</p>

<p align="center">
  <a href="https://zapnikita95.github.io/zkm-ring/"><strong>🚀 Открыть рекламную страницу</strong></a>
  &nbsp;·&nbsp;
  <a href="docs/PRODUCT.md">Канон продукта</a>
</p>

---

### Это не

спортивный трекер · соцсеть километров · ещё один GPX-редактор для профи

### Это

красивая готовая линия (ЗКМ + Подмосковье) · свой кусок «отсюда–досюда» · привычный навигатор

---

**Почему не просто Яндекс?** В Яндексе вы строите А→Б по дорогам. У нас — уже приятный трек, а старт/финиш — где вам удобно в жизни.

**Почему не Komoot / Strava?** Они для outdoor и атлетов. Мы — для casual в городе, без обучения новому «спортивному миру».

---

<details>
<summary>Для разработки (API / сборка)</summary>

```bash
cd server && npm i && npm start
export VITE_API_BASE="http://$(ipconfig getifaddr en0):8787"
npm i && npm run build && npx cap sync android
```

Root Directory для Railway API: `server/`

</details>

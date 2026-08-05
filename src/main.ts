import './style.css'
import * as maplibregl from 'maplibre-gl'
import type { Map as MapLibreMap, Marker } from 'maplibre-gl'
import {
  formatDuration,
  formatKm,
  haversineM,
  metersFromMinutes,
  minutesFromMeters,
  nearestIndex,
  orientRing,
  pathLengthM,
  rotateToStart,
  sampleAlong,
  takeDistance,
  type LatLon,
} from './geo'
import { loadParks, loadRing, parksOnRoute, type Park } from './data'
import {
  createMap,
  setRouteLine,
  setRingDim,
  fitToRoute,
  upsertMarker,
  addParkMarkers,
} from './map'
import {
  getGps,
  loadRewards,
  saveReward,
  watchGps,
  type Direction,
  type NavKind,
  type PlannedRoute,
} from './state'
import { chunkForYandex, yandexRouteUrl, type TravelMode } from './yandex'

const app = document.querySelector<HTMLDivElement>('#app')!

let ringRaw: LatLon[] = []
let parksAll: Park[] = []
let planned: PlannedRoute | null = null

let mode: TravelMode = 'bike'
let direction: Direction = 'ccw'
let paramBy: 'distance' | 'duration' = 'distance'
let distanceKm = 15
let durationMin = 60
let startPos: LatLon | null = null
let navKind: NavKind = 'inapp'

let watchId = -1
let navMap: MapLibreMap | null = null
const userMarker = { current: null as Marker | null }
const targetMarker = { current: null as Marker | null }
let visibilityHandler: (() => void) | null = null

function toast(msg: string, ms = 3200): void {
  document.querySelector('.toast')?.remove()
  const el = document.createElement('div')
  el.className = 'toast'
  el.textContent = msg
  document.body.appendChild(el)
  setTimeout(() => el.remove(), ms)
}

function shell(title: string, sub: string, body: string): string {
  return `
    <div class="app-shell">
      <header class="header">
        <h1>${title}</h1>
        <p>${sub}</p>
      </header>
      <div class="panel">${body}</div>
    </div>
  `
}

function stopNav(): void {
  if (watchId >= 0) {
    navigator.geolocation.clearWatch(watchId)
    watchId = -1
  }
  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler)
    visibilityHandler = null
  }
  navMap?.remove()
  navMap = null
  userMarker.current = null
  targetMarker.current = null
}

async function boot(): Promise<void> {
  app.innerHTML = `<div class="loading">Загружаем кольцо ЗКМ…</div>`
  try {
    ;[ringRaw, parksAll] = await Promise.all([loadRing(), loadParks()])
    renderPlanner()
  } catch (e) {
    app.innerHTML = `<div class="loading error">Не удалось загрузить данные: ${String(e)}</div>`
  }
}

function buildRouteFromSettings(): PlannedRoute {
  if (!startPos) throw new Error('Нет стартовой точки')
  const wantCcw = direction === 'ccw'
  const oriented = orientRing(ringRaw, wantCcw)
  const startIdx = nearestIndex(oriented, startPos)
  const fromStart = rotateToStart(oriented, startIdx)
  const targetMeters =
    paramBy === 'distance' ? distanceKm * 1000 : metersFromMinutes(durationMin, mode)
  const route = takeDistance(fromStart, targetMeters)
  const meters = pathLengthM(route)
  const mins = minutesFromMeters(meters, mode)
  const parks = parksOnRoute(parksAll, route)
  return {
    mode,
    direction,
    targetMeters: meters,
    targetMinutes: mins,
    start: startPos,
    route,
    parks,
    navKind,
  }
}

function bindSeg(sel: string, attr: string, onPick: (v: string) => void): void {
  app.querySelector(sel)?.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('button')
    if (!t) return
    const v = t.getAttribute(attr)
    if (v) onPick(v)
  })
}

function fillParamFields(): void {
  const paramFields = app.querySelector('#param-fields')
  const paramHint = app.querySelector('#param-hint')
  if (!paramFields || !paramHint) return

  if (paramBy === 'distance') {
    paramFields.innerHTML = `
      <label class="field">Километры
        <input type="number" id="inp-km" min="1" max="180" step="1" value="${distanceKm}" />
      </label>`
    const update = (): void => {
      paramHint.textContent = `≈ ${formatDuration(minutesFromMeters(distanceKm * 1000, mode))} при ${
        mode === 'bike' ? '15' : '5'
      } км/ч`
    }
    update()
    app.querySelector('#inp-km')?.addEventListener('input', (e) => {
      distanceKm = Math.max(1, Number((e.target as HTMLInputElement).value) || 15)
      durationMin = Math.round(minutesFromMeters(distanceKm * 1000, mode))
      update()
    })
  } else {
    paramFields.innerHTML = `
      <label class="field">Минуты
        <input type="number" id="inp-min" min="10" max="600" step="5" value="${durationMin}" />
      </label>`
    const update = (): void => {
      paramHint.textContent = `≈ ${formatKm(metersFromMinutes(durationMin, mode))}`
    }
    update()
    app.querySelector('#inp-min')?.addEventListener('input', (e) => {
      durationMin = Math.max(10, Number((e.target as HTMLInputElement).value) || 60)
      distanceKm = Math.round((metersFromMinutes(durationMin, mode) / 1000) * 10) / 10
      update()
    })
  }
}

function renderPlanner(): void {
  stopNav()
  app.innerHTML = shell(
    'ЗКМ',
    'Свой кусок Зелёного кольца',
    `
    <div class="card">
      <h2>Режим</h2>
      <div class="seg" id="mode-seg">
        <button type="button" data-mode="bike" class="${mode === 'bike' ? 'active' : ''}">Велосипед</button>
        <button type="button" data-mode="walk" class="${mode === 'walk' ? 'active' : ''}">Пешком</button>
      </div>
    </div>
    <div class="card">
      <h2>Направление</h2>
      <div class="seg" id="dir-seg">
        <button type="button" data-dir="ccw" class="${direction === 'ccw' ? 'active' : ''}">Против часовой</button>
        <button type="button" data-dir="cw" class="${direction === 'cw' ? 'active' : ''}">По часовой</button>
      </div>
    </div>
    <div class="card">
      <h2>Протяжённость</h2>
      <div class="seg" id="param-seg">
        <button type="button" data-param="distance" class="${paramBy === 'distance' ? 'active' : ''}">Километры</button>
        <button type="button" data-param="duration" class="${paramBy === 'duration' ? 'active' : ''}">Время</button>
      </div>
      <div id="param-fields"></div>
      <p class="hint" id="param-hint"></p>
    </div>
    <div class="card">
      <h2>Старт</h2>
      <p class="hint" id="start-hint">${
        startPos
          ? `GPS: ${startPos.lat.toFixed(5)}, ${startPos.lon.toFixed(5)}`
          : 'Возьмём ближайшую точку кольца к вашему GPS'
      }</p>
      <button type="button" class="btn secondary" id="btn-gps">Определить моё местоположение</button>
      <button type="button" class="btn secondary" id="btn-botanic">Старт у Ботанического сада</button>
      <p class="error" id="gps-err" hidden></p>
    </div>
    <div class="card">
      <h2>Ведение</h2>
      <div class="seg" id="nav-seg">
        <button type="button" data-nav="inapp" class="${navKind === 'inapp' ? 'active' : ''}">В приложении</button>
        <button type="button" data-nav="yandex" class="${navKind === 'yandex' ? 'active' : ''}">Яндекс.Карты</button>
      </div>
      <p class="hint">В Яндексе маршрут идёт кусками по 6–8 точек; это приложение подскажет «продолжить».</p>
    </div>
    <button type="button" class="btn" id="btn-preview" ${startPos ? '' : 'disabled'}>Показать маршрут</button>
    `,
  )

  fillParamFields()

  bindSeg('#mode-seg', 'data-mode', (v) => {
    mode = v as TravelMode
    if (paramBy === 'distance') durationMin = Math.round(minutesFromMeters(distanceKm * 1000, mode))
    else distanceKm = Math.round((metersFromMinutes(durationMin, mode) / 1000) * 10) / 10
    renderPlanner()
  })
  bindSeg('#dir-seg', 'data-dir', (v) => {
    direction = v as Direction
    renderPlanner()
  })
  bindSeg('#param-seg', 'data-param', (v) => {
    paramBy = v as 'distance' | 'duration'
    renderPlanner()
  })
  bindSeg('#nav-seg', 'data-nav', (v) => {
    navKind = v as NavKind
    renderPlanner()
  })

  app.querySelector('#btn-gps')?.addEventListener('click', async () => {
    const err = app.querySelector('#gps-err') as HTMLElement
    const btn = app.querySelector('#btn-gps') as HTMLButtonElement
    err.hidden = true
    btn.disabled = true
    btn.textContent = 'Определяем…'
    try {
      startPos = await getGps()
      toast('Старт: ближайшая точка кольца к вам')
      renderPlanner()
    } catch (e) {
      err.hidden = false
      err.textContent = e instanceof Error ? e.message : 'Не удалось получить GPS'
      btn.disabled = false
      btn.textContent = 'Определить моё местоположение'
    }
  })

  app.querySelector('#btn-botanic')?.addEventListener('click', () => {
    startPos = { lat: 55.842715, lon: 37.587213 }
    toast('Старт: Ботанический сад')
    renderPlanner()
  })

  app.querySelector('#btn-preview')?.addEventListener('click', () => {
    try {
      planned = buildRouteFromSettings()
      renderPreview()
    } catch (e) {
      toast(String(e))
    }
  })
}

function renderPreview(): void {
  if (!planned) return
  stopNav()
  const earned = loadRewards()
  const parksHtml = planned.parks.length
    ? planned.parks
        .map(
          (p) =>
            `<li>${p.name}${
              earned.has(p.id) ? '<span class="badge done">уже есть</span>' : '<span class="badge">награда</span>'
            }<span class="meta">${p.description}</span></li>`,
        )
        .join('')
    : '<li>На этом участке ключевых парков из списка нет</li>'

  app.innerHTML = shell(
    'Маршрут',
    `${formatKm(planned.targetMeters)} · ${formatDuration(planned.targetMinutes)} · ${
      planned.mode === 'bike' ? 'вело' : 'пешком'
    }`,
    `
    <div class="map-wrap" id="map"></div>
    <div class="card">
      <h2>Ключевые парки на пути</h2>
      <ul class="list">${parksHtml}</ul>
    </div>
    <button type="button" class="btn" id="btn-go">Поехали</button>
    <button type="button" class="btn secondary" id="btn-back">Изменить</button>
    `,
  )

  const mapEl = app.querySelector('#map') as HTMLElement
  const center = planned.route[Math.floor(planned.route.length / 2)] ?? planned.start
  const map = createMap(mapEl, center, 11)
  map.on('load', () => {
    const oriented = orientRing(ringRaw, planned!.direction === 'ccw')
    setRingDim(map, oriented)
    setRouteLine(map, 'route', planned!.route)
    fitToRoute(map, planned!.route)
    addParkMarkers(map, planned!.parks, earned)
    const startEl = document.createElement('div')
    startEl.className = 'marker-user'
    new maplibregl.Marker({ element: startEl })
      .setLngLat([planned!.route[0].lon, planned!.route[0].lat])
      .addTo(map)
  })

  app.querySelector('#btn-back')?.addEventListener('click', () => renderPlanner())
  app.querySelector('#btn-go')?.addEventListener('click', () => {
    if (!planned) return
    if (planned.navKind === 'yandex') renderYandexNav()
    else renderInAppNav()
  })
}

function renderInAppNav(): void {
  if (!planned) return
  stopNav()
  const earned = loadRewards()
  const checkpoints = sampleAlong(
    planned.route,
    Math.min(40, Math.max(8, Math.ceil(planned.route.length / 40))),
  )
  let cpIdx = 1
  const visitedParks = new Set<string>(earned)

  app.innerHTML = shell(
    'Навигация',
    'В приложении · держите экран включённым',
    `
    <div class="nav-status">
      <div class="stat"><div class="label">До цели</div><div class="value" id="st-dist">—</div></div>
      <div class="stat"><div class="label">Точка</div><div class="value" id="st-cp">1 / ${checkpoints.length - 1}</div></div>
    </div>
    <div class="map-wrap tall" id="map"></div>
    <div class="card">
      <h2>Награды на маршруте</h2>
      <ul class="list" id="park-live"></ul>
    </div>
    <button type="button" class="btn secondary" id="btn-stop">Завершить</button>
    `,
  )

  const refreshParks = (): void => {
    const ul = app.querySelector('#park-live')
    if (!ul) return
    ul.innerHTML = planned!.parks
      .map((p) => {
        const got = visitedParks.has(p.id)
        return `<li>${p.name}${
          got ? '<span class="badge done">получено</span>' : '<span class="badge">рядом</span>'
        }<span class="meta">${p.reward}</span></li>`
      })
      .join('')
  }
  refreshParks()

  const mapEl = app.querySelector('#map') as HTMLElement
  const created = createMap(mapEl, planned.route[0], 13)
  navMap = created
  created.on('load', () => {
    setRouteLine(created, 'route', planned!.route)
    fitToRoute(created, planned!.route, 60)
    addParkMarkers(created, planned!.parks, visitedParks)
    updateTargetUi()
  })

  function updateTargetUi(): void {
    const t = checkpoints[Math.min(cpIdx, checkpoints.length - 1)]
    if (navMap && t) upsertMarker(navMap, targetMarker, t, 'marker-target')
    const st = app.querySelector('#st-cp')
    if (st) st.textContent = `${Math.min(cpIdx, checkpoints.length - 1)} / ${checkpoints.length - 1}`
  }

  watchId = watchGps((pos) => {
    if (navMap) upsertMarker(navMap, userMarker, pos, 'marker-user')
    const target = checkpoints[Math.min(cpIdx, checkpoints.length - 1)]
    const d = haversineM(pos, target)
    const stD = app.querySelector('#st-dist')
    if (stD) stD.textContent = formatKm(d)

    if (d < 70 && cpIdx < checkpoints.length - 1) {
      cpIdx++
      updateTargetUi()
      if (navigator.vibrate) navigator.vibrate(40)
      toast(`Точка ${cpIdx - 1} пройдена`)
    }

    for (const park of planned!.parks) {
      if (visitedParks.has(park.id)) continue
      if (haversineM(pos, park) <= park.radius_m) {
        visitedParks.add(park.id)
        saveReward(park.id)
        refreshParks()
        if (navigator.vibrate) navigator.vibrate([40, 40, 80])
        toast(`Награда: ${park.reward}`)
      }
    }

    if (cpIdx >= checkpoints.length - 1 && d < 70) {
      toast('Маршрут пройден!')
    }
  })

  app.querySelector('#btn-stop')?.addEventListener('click', () => {
    stopNav()
    renderPlanner()
  })
}

function renderYandexNav(): void {
  if (!planned) return
  stopNav()

  const chunks = chunkForYandex(planned.route, 7)
  const urls = chunks.map((c) => yandexRouteUrl(c, planned!.mode))
  let active = 0
  const done = new Set<number>()
  const visitedParks = new Set<string>(loadRewards())
  let map: MapLibreMap | null = null

  const endOf = (i: number): LatLon => chunks[i][chunks[i].length - 1]

  const render = (opts?: { openUrl?: string }): void => {
    const canContinue = done.has(active) && active < chunks.length - 1
    const allDone = done.size >= chunks.length

    app.innerHTML = shell(
      'Яндекс.Карты',
      `${chunks.length} участков · вернитесь сюда у конца куска`,
      `
      <div class="banner">
        <strong>Как это работает</strong>
        Откройте текущий участок в Яндексе. Приложение следит за GPS и отметит конец куска.
        На iOS фон почти не живёт — вернитесь вручную и нажмите «Продолжить».
      </div>
      ${
        canContinue
          ? `<div class="banner"><strong>Участок ${active + 1} пройден</strong>Можно открыть следующий.</div>
             <button type="button" class="btn warn" id="btn-continue">Продолжить в Яндексе · участок ${active + 2}</button>`
          : ''
      }
      ${allDone ? `<div class="banner"><strong>Все участки пройдены</strong>Молодец.</div>` : ''}
      <div class="nav-status">
        <div class="stat"><div class="label">Участок</div><div class="value">${active + 1} / ${chunks.length}</div></div>
        <div class="stat"><div class="label">До конца куска</div><div class="value" id="st-end">—</div></div>
      </div>
      <div class="map-wrap" id="map"></div>
      <a class="btn" id="btn-open" href="${urls[active]}" target="_blank" rel="noopener">Открыть участок ${active + 1} в Яндексе</a>
      <button type="button" class="btn secondary" id="btn-mark" ${done.has(active) ? 'disabled' : ''}>Отметить участок пройденным</button>
      <div class="card">
        <h2>Участки</h2>
        <ul class="list seg-list">${chunks
          .map((_, i) => {
            const status = done.has(i)
              ? '<span class="badge done">готово</span>'
              : i === active
                ? '<span class="badge">сейчас</span>'
                : ''
            return `<li><span class="idx">№${i + 1}</span>${status}</li>`
          })
          .join('')}</ul>
      </div>
      <div class="card">
        <h2>Парки</h2>
        <ul class="list">${planned!.parks
          .map((p) => {
            const got = visitedParks.has(p.id)
            return `<li>${p.name}${got ? '<span class="badge done">получено</span>' : ''}<span class="meta">${p.reward}</span></li>`
          })
          .join('')}</ul>
      </div>
      <button type="button" class="btn secondary" id="btn-stop">Завершить</button>
      `,
    )

    map?.remove()
    const mapEl = app.querySelector('#map') as HTMLElement
    const chunkMap = createMap(mapEl, chunks[active][0], 12)
    map = chunkMap
    navMap = chunkMap
    chunkMap.on('load', () => {
      setRouteLine(chunkMap, 'route', planned!.route, '#4a5c50')
      chunkMap.setPaintProperty('route-line', 'line-opacity', 0.35)
      setRouteLine(chunkMap, 'chunk', chunks[active], '#2f9e5e')
      fitToRoute(chunkMap, chunks[active], 48)
      addParkMarkers(chunkMap, planned!.parks, visitedParks)
    })

    app.querySelector('#btn-mark')?.addEventListener('click', () => {
      done.add(active)
      toast(`Участок ${active + 1} отмечен`)
      render()
    })

    app.querySelector('#btn-continue')?.addEventListener('click', () => {
      active = Math.min(active + 1, chunks.length - 1)
      const url = urls[active]
      render({ openUrl: url })
    })

    app.querySelector('#btn-stop')?.addEventListener('click', () => {
      stopNav()
      map?.remove()
      renderPlanner()
    })

    if (opts?.openUrl) {
      window.open(opts.openUrl, '_blank', 'noopener')
    }
  }

  render()

  watchId = watchGps((pos) => {
    if (map) upsertMarker(map, userMarker, pos, 'marker-user')
    const end = endOf(active)
    const d = haversineM(pos, end)
    const st = app.querySelector('#st-end')
    if (st) st.textContent = formatKm(d)

    if (!done.has(active) && d < 90) {
      done.add(active)
      if (navigator.vibrate) navigator.vibrate(60)
      toast(`Участок ${active + 1} почти пройден`)
      render()
    }

    for (const park of planned!.parks) {
      if (visitedParks.has(park.id)) continue
      if (haversineM(pos, park) <= park.radius_m) {
        visitedParks.add(park.id)
        saveReward(park.id)
        toast(`Награда: ${park.reward}`)
        render()
      }
    }
  })

  visibilityHandler = () => {
    if (document.visibilityState === 'visible') toast('Сверяем прогресс…', 1200)
  }
  document.addEventListener('visibilitychange', visibilityHandler)
}

void boot()

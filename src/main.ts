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
import { CATEGORY_LABEL, landmarksOnRoute, loadLandmarks, loadRing, type Landmark } from './data'
import {
  createMap,
  setRouteLine,
  setRingDim,
  fitToRoute,
  upsertMarker,
  addLandmarkMarkers,
} from './map'
import {
  getGps,
  watchGps,
  loadLocalVisits,
  saveLocalVisit,
  formatProfileStats,
  type Direction,
  type NavKind,
} from './state'
import { chunkForYandex, yandexRouteUrl, type TravelMode } from './yandex'
import {
  completeRoute,
  fetchMe,
  getToken,
  login as apiLogin,
  logoutApi,
  register as apiRegister,
  setToken,
} from './api'
import { hasOnboarded, setOnboarded, setProfileCache, profileCache } from './types'

const app = document.querySelector<HTMLDivElement>('#app')!
const ICON = '/icons/app-icon.png'

let ringRaw: LatLon[] = []
let landmarksAll: Landmark[] = []

let mode: TravelMode = 'bike'
let direction: Direction = 'ccw'
let paramBy: 'distance' | 'duration' = 'distance'
let distanceKm = 15
let durationMin = 60
let startPos: LatLon | null = null
let navKind: NavKind = 'inapp'

type Planned = {
  mode: TravelMode
  direction: Direction
  targetMeters: number
  targetMinutes: number
  start: LatLon
  route: LatLon[]
  landmarks: Landmark[]
  navKind: NavKind
}
let planned: Planned | null = null

let watchId = -1
let navMap: MapLibreMap | null = null
const userMarker = { current: null as Marker | null }
const targetMarker = { current: null as Marker | null }
let visibilityHandler: (() => void) | null = null

function toast(msg: string, ms = 3400): void {
  document.querySelector('.toast')?.remove()
  const el = document.createElement('div')
  el.className = 'toast'
  el.textContent = msg
  document.body.appendChild(el)
  setTimeout(() => el.remove(), ms)
}

function shell(title: string, sub: string, body: string, tab?: 'home' | 'profile'): string {
  return `
    <div class="app-shell">
      <header class="header">
        <img class="brand-ico" src="${ICON}" alt="" width="44" height="44" />
        <div>
          <h1>${title}</h1>
          <p>${sub}</p>
        </div>
        <div class="header-spacer"></div>
      </header>
      <div class="panel">${body}</div>
      ${
        tab
          ? `<nav class="bottom-nav">
              <button type="button" data-tab="home" class="${tab === 'home' ? 'active' : ''}">Маршрут</button>
              <button type="button" data-tab="profile" class="${tab === 'profile' ? 'active' : ''}">Профиль</button>
              <button type="button" data-tab="auth">${profileCache ? 'Выйти' : 'Вход'}</button>
            </nav>`
          : ''
      }
    </div>
  `
}

function bindTabs(): void {
  app.querySelectorAll('.bottom-nav button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = (btn as HTMLElement).dataset.tab
      if (t === 'home') renderPlanner()
      else if (t === 'profile') renderProfile()
      else if (t === 'auth') {
        if (profileCache) void doLogout()
        else renderAuth()
      }
    })
  })
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
  app.innerHTML = `<div class="loading"><div class="spin"></div>Загружаем Зелёный Маршрут…</div>`
  try {
    ;[ringRaw, landmarksAll] = await Promise.all([loadRing(), loadLandmarks()])
    if (getToken()) {
      try {
        const { profile } = await fetchMe()
        setProfileCache(profile)
      } catch {
        setToken(null)
        setProfileCache(null)
      }
    }
    if (!hasOnboarded()) renderIntro()
    else renderPlanner()
  } catch (e) {
    app.innerHTML = `<div class="loading error">Не удалось загрузить данные.<br/>${String(e)}</div>`
  }
}

function renderIntro(): void {
  app.innerHTML = `
    <div class="intro">
      <div class="intro-hero">
        <img src="${ICON}" alt="Зелёный Маршрут" width="148" height="148" />
        <h1>Зелёный Маршрут</h1>
        <p class="lead">Ваш персональный кусок Зелёного кольца Москвы: пешком или на велосипеде, с парками, озёрами и наградами по пути.</p>
      </div>
      <div class="intro-actions">
        <button type="button" class="btn" id="btn-start">Начать</button>
        <button type="button" class="btn secondary" id="btn-auth">Войти или зарегистрироваться</button>
      </div>
    </div>
  `
  app.querySelector('#btn-start')?.addEventListener('click', () => {
    setOnboarded()
    renderPlanner()
  })
  app.querySelector('#btn-auth')?.addEventListener('click', () => {
    setOnboarded()
    renderAuth()
  })
}

function renderAuth(modeAuth: 'login' | 'register' = 'login'): void {
  stopNav()
  app.innerHTML = shell(
    'Аккаунт',
    'Логин и пароль — без почты',
    `
    <div class="card">
      <div class="seg auth-tabs" id="auth-tabs">
        <button type="button" data-a="login" class="${modeAuth === 'login' ? 'active' : ''}">Вход</button>
        <button type="button" data-a="register" class="${modeAuth === 'register' ? 'active' : ''}">Регистрация</button>
      </div>
      <label class="field">Логин
        <input id="inp-login" autocomplete="username" maxlength="32" placeholder="например, green_rider" />
      </label>
      <label class="field">Пароль
        <input id="inp-pass" type="password" autocomplete="${modeAuth === 'login' ? 'current-password' : 'new-password'}" maxlength="72" placeholder="не менее 8 символов" />
      </label>
      <p class="hint">Логин: 3–32 символа (латиница, цифры, _). Пароль: буква и цифра, от 8 символов. Защита от спама по IP.</p>
      <p class="error" id="auth-err" hidden></p>
      <button type="button" class="btn" id="btn-auth-go" style="margin-top:14px">${
        modeAuth === 'login' ? 'Войти' : 'Создать аккаунт'
      }</button>
      <button type="button" class="btn secondary" id="btn-skip">Позже</button>
    </div>
    `,
    'home',
  )
  bindTabs()
  let cur = modeAuth
  app.querySelector('#auth-tabs')?.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button')
    const a = b?.getAttribute('data-a')
    if (a === 'login' || a === 'register') renderAuth(a)
  })
  app.querySelector('#btn-skip')?.addEventListener('click', () => renderPlanner())
  app.querySelector('#btn-auth-go')?.addEventListener('click', async () => {
    const loginName = (app.querySelector('#inp-login') as HTMLInputElement).value.trim()
    const password = (app.querySelector('#inp-pass') as HTMLInputElement).value
    const err = app.querySelector('#auth-err') as HTMLElement
    const btn = app.querySelector('#btn-auth-go') as HTMLButtonElement
    err.hidden = true
    btn.disabled = true
    try {
      const res = cur === 'login' ? await apiLogin(loginName, password) : await apiRegister(loginName, password)
      setToken(res.token)
      setProfileCache(res.profile)
      toast(cur === 'login' ? `С возвращением, ${res.profile.login}` : 'Аккаунт создан. Добро пожаловать!')
      renderProfile()
    } catch (e) {
      err.hidden = false
      err.textContent = e instanceof Error ? e.message : String(e)
      btn.disabled = false
    }
  })
  void cur
}

async function doLogout(): Promise<void> {
  try {
    await logoutApi()
  } catch {
    /* ignore */
  }
  setToken(null)
  setProfileCache(null)
  toast('Вы вышли из аккаунта')
  renderPlanner()
}

function renderProfile(): void {
  stopNav()
  const p = profileCache
  if (!p) {
    renderAuth('login')
    return
  }
  const earned = new Set(p.achievements.map((a) => a.code))
  const cards = (p.catalog || [])
    .map((a) => {
      const on = earned.has(a.code)
      return `<div class="ach-card ${on ? 'unlocked' : 'locked'}"><div class="t">${a.title || a.code}</div><div class="d">${a.desc || ''}</div></div>`
    })
    .join('')

  app.innerHTML = shell(
    p.login,
    formatProfileStats(p),
    `
    <div class="card">
      <h2>Ваша статистика</h2>
      <p>Пройдено: <strong>${formatKm(p.totalMeters)}</strong></p>
      <p>Время в пути: <strong>${formatDuration(p.totalSeconds / 60)}</strong></p>
      <p>Маршрутов: <strong>${p.routesCount}</strong></p>
      <p class="hint">Категории: ${
        Object.entries(p.categoryCounts || {})
          .map(([k, v]) => `${CATEGORY_LABEL[k] || k} — ${v}`)
          .join(', ') || 'пока нет посещений'
      }</p>
    </div>
    <div class="card">
      <h2>Ачивки</h2>
      <div class="ach-grid">${cards}</div>
    </div>
    `,
    'profile',
  )
  bindTabs()
}

function buildRoute(): Planned {
  if (!startPos) throw new Error('Сначала определите ваше местоположение')
  const oriented = orientRing(ringRaw, direction === 'ccw')
  const startIdx = nearestIndex(oriented, startPos)
  const fromStart = rotateToStart(oriented, startIdx)
  const targetMeters =
    paramBy === 'distance' ? distanceKm * 1000 : metersFromMinutes(durationMin, mode)
  const route = takeDistance(fromStart, targetMeters)
  const meters = pathLengthM(route)
  return {
    mode,
    direction,
    targetMeters: meters,
    targetMinutes: minutesFromMeters(meters, mode),
    start: startPos,
    route,
    landmarks: landmarksOnRoute(landmarksAll, route),
    navKind,
  }
}

function fillParamFields(): void {
  const paramFields = app.querySelector('#param-fields')
  const paramHint = app.querySelector('#param-hint')
  if (!paramFields || !paramHint) return
  if (paramBy === 'distance') {
    paramFields.innerHTML = `<label class="field">Километры<input type="number" id="inp-km" min="1" max="180" step="1" value="${distanceKm}" /></label>`
    const upd = () => {
      paramHint.textContent = `Ориентировочно ${formatDuration(minutesFromMeters(distanceKm * 1000, mode))} (${mode === 'bike' ? '15' : '5'} км/ч). Время в пути не ограничивается.`
    }
    upd()
    app.querySelector('#inp-km')?.addEventListener('input', (e) => {
      distanceKm = Math.max(1, Number((e.target as HTMLInputElement).value) || 15)
      durationMin = Math.round(minutesFromMeters(distanceKm * 1000, mode))
      upd()
    })
  } else {
    paramFields.innerHTML = `<label class="field">Минуты (оценка)<input type="number" id="inp-min" min="10" max="600" step="5" value="${durationMin}" /></label>`
    const upd = () => {
      paramHint.textContent = `Ориентировочно ${formatKm(metersFromMinutes(durationMin, mode))}. Фактическое время на маршруте считается отдельно.`
    }
    upd()
    app.querySelector('#inp-min')?.addEventListener('input', (e) => {
      durationMin = Math.max(10, Number((e.target as HTMLInputElement).value) || 60)
      distanceKm = Math.round((metersFromMinutes(durationMin, mode) / 1000) * 10) / 10
      upd()
    })
  }
}

function bindSeg(sel: string, attr: string, onPick: (v: string) => void): void {
  app.querySelector(sel)?.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('button')
    const v = t?.getAttribute(attr)
    if (v) onPick(v)
  })
}

function renderPlanner(): void {
  stopNav()
  app.innerHTML = shell(
    'Зелёный Маршрут',
    'Соберите свой кусок кольца',
    `
    <div class="card">
      <h2>Как вы пойдёте</h2>
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
      <h2>Длина участка</h2>
      <div class="seg" id="param-seg">
        <button type="button" data-param="distance" class="${paramBy === 'distance' ? 'active' : ''}">Километры</button>
        <button type="button" data-param="duration" class="${paramBy === 'duration' ? 'active' : ''}">Время</button>
      </div>
      <div id="param-fields"></div>
      <p class="hint" id="param-hint"></p>
    </div>
    <div class="card">
      <h2>Старт рядом с вами</h2>
      <p class="hint">${
        startPos
          ? `Координаты: ${startPos.lat.toFixed(5)}, ${startPos.lon.toFixed(5)}. Начало — ближайшая точка кольца.`
          : 'Разрешите геолокацию — найдём ближайшую точку Зелёного кольца.'
      }</p>
      <button type="button" class="btn secondary" id="btn-gps">Определить моё местоположение</button>
      <button type="button" class="btn secondary" id="btn-botanic">Старт у Ботанического сада</button>
      <p class="error" id="gps-err" hidden></p>
    </div>
    <div class="card">
      <h2>Навигация</h2>
      <div class="seg" id="nav-seg">
        <button type="button" data-nav="inapp" class="${navKind === 'inapp' ? 'active' : ''}">В приложении</button>
        <button type="button" data-nav="yandex" class="${navKind === 'yandex' ? 'active' : ''}">Яндекс.Карты</button>
      </div>
      <p class="hint">В Яндексе маршрут идёт короткими кусками; мы подскажем, когда продолжить.</p>
    </div>
    <button type="button" class="btn" id="btn-preview" ${startPos ? '' : 'disabled'}>Показать маршрут</button>
    `,
    'home',
  )
  bindTabs()
  fillParamFields()
  bindSeg('#mode-seg', 'data-mode', (v) => {
    mode = v as TravelMode
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
      // Capacitor Geolocation if available
      const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
      if (cap?.isNativePlatform?.()) {
        try {
          const { Geolocation } = await import('@capacitor/geolocation')
          await Geolocation.requestPermissions()
        } catch {
          /* fall through to web API */
        }
      }
      startPos = await getGps()
      const oriented = orientRing(ringRaw, true)
      const ni = nearestIndex(oriented, startPos)
      toast(`Ближайшая точка кольца в ${formatKm(haversineM(startPos, oriented[ni]))}`)
      renderPlanner()
    } catch (e) {
      err.hidden = false
      err.textContent = e instanceof Error ? e.message : String(e)
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
      planned = buildRoute()
      renderPreview()
    } catch (e) {
      toast(String(e))
    }
  })
}

function renderPreview(): void {
  if (!planned) return
  stopNav()
  const local = loadLocalVisits()
  const list = planned.landmarks.length
    ? planned.landmarks
        .map(
          (lm) =>
            `<li>${lm.name}<span class="badge">${CATEGORY_LABEL[lm.category] || lm.category}</span>${
              local.has(lm.id) ? '<span class="badge done">было</span>' : ''
            }<span class="meta">${lm.description}</span></li>`,
        )
        .join('')
    : '<li>На этом участке знаковых точек из каталога нет</li>'

  app.innerHTML = shell(
    'Ваш маршрут',
    `${formatKm(planned.targetMeters)} · оценка ${formatDuration(planned.targetMinutes)} · ${
      planned.mode === 'bike' ? 'вело' : 'пешком'
    }`,
    `
    <div class="map-wrap" id="map"></div>
    <div class="card">
      <h2>Знаковые точки на пути</h2>
      <ul class="list">${list}</ul>
    </div>
    <button type="button" class="btn" id="btn-go">Поехали</button>
    <button type="button" class="btn secondary" id="btn-back">Изменить</button>
    `,
    'home',
  )
  bindTabs()

  const mapEl = app.querySelector('#map') as HTMLElement
  const center = planned.route[Math.floor(planned.route.length / 2)] ?? planned.start
  const map = createMap(mapEl, center, 11)
  map.on('load', () => {
    setRingDim(map, orientRing(ringRaw, planned!.direction === 'ccw'))
    setRouteLine(map, 'route', planned!.route)
    fitToRoute(map, planned!.route)
    addLandmarkMarkers(map, planned!.landmarks, local)
    const el = document.createElement('div')
    el.className = 'marker-user'
    new maplibregl.Marker({ element: el })
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

async function finishRoute(meters: number, seconds: number, visited: Landmark[]): Promise<void> {
  if (!planned) return
  if (getToken()) {
    try {
      const res = await completeRoute({
        meters,
        seconds,
        mode: planned.mode,
        landmarks: visited.map((v) => ({ id: v.id, category: v.category })),
      })
      setProfileCache(res.profile)
      for (const a of res.newAchievements || []) {
        toast(`Ачивка: ${a.title || a.code}`)
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Не удалось сохранить на сервер')
    }
  } else {
    toast('Маршрут завершён. Войдите, чтобы сохранить ачивки в профиле.')
  }
}

function renderInAppNav(): void {
  if (!planned) return
  stopNav()
  const checkpoints = sampleAlong(
    planned.route,
    Math.min(40, Math.max(8, Math.ceil(planned.route.length / 40))),
  )
  let cpIdx = 1
  const visited: Landmark[] = []
  const visitedIds = new Set<string>(loadLocalVisits())
  const startedAt = Date.now()
  let lastPos: LatLon | null = null
  let metersAlong = 0

  app.innerHTML = shell(
    'В пути',
    'Время не ограничено — идите в своём темпе',
    `
    <div class="nav-status">
      <div class="stat"><div class="label">До цели</div><div class="value" id="st-dist">—</div></div>
      <div class="stat"><div class="label">Время</div><div class="value live-timer" id="st-time">0:00</div></div>
      <div class="stat"><div class="label">Точка</div><div class="value" id="st-cp">1/${checkpoints.length - 1}</div></div>
    </div>
    <div class="map-wrap tall" id="map"></div>
    <div class="card">
      <h2>Точки и ачивки</h2>
      <ul class="list" id="lm-live"></ul>
    </div>
    <button type="button" class="btn" id="btn-finish">Завершить и сохранить</button>
    <button type="button" class="btn secondary" id="btn-stop">Выйти без сохранения</button>
    `,
    'home',
  )
  bindTabs()

  const refreshLm = (): void => {
    const ul = app.querySelector('#lm-live')
    if (!ul) return
    ul.innerHTML = planned!.landmarks
      .map((lm) => {
        const got = visitedIds.has(lm.id)
        return `<li>${lm.name}<span class="badge">${CATEGORY_LABEL[lm.category] || ''}</span>${
          got ? '<span class="badge done">✓</span>' : ''
        }</li>`
      })
      .join('')
  }
  refreshLm()

  const timer = window.setInterval(() => {
    const sec = Math.floor((Date.now() - startedAt) / 1000)
    const el = app.querySelector('#st-time')
    if (el) {
      const m = Math.floor(sec / 60)
      const s = sec % 60
      el.textContent = `${m}:${String(s).padStart(2, '0')}`
    }
  }, 1000)

  const mapEl = app.querySelector('#map') as HTMLElement
  const created = createMap(mapEl, planned.route[0], 13)
  navMap = created
  created.on('load', () => {
    setRouteLine(created, 'route', planned!.route)
    fitToRoute(created, planned!.route, 60)
    addLandmarkMarkers(created, planned!.landmarks, visitedIds)
    updateTarget()
  })

  function updateTarget(): void {
    const t = checkpoints[Math.min(cpIdx, checkpoints.length - 1)]
    if (navMap && t) upsertMarker(navMap, targetMarker, t, 'marker-target')
    const st = app.querySelector('#st-cp')
    if (st) st.textContent = `${Math.min(cpIdx, checkpoints.length - 1)}/${checkpoints.length - 1}`
  }

  const cleanup = (): void => {
    clearInterval(timer)
    stopNav()
  }

  watchId = watchGps((pos) => {
    if (navMap) upsertMarker(navMap, userMarker, pos, 'marker-user')
    if (lastPos) metersAlong += haversineM(lastPos, pos)
    lastPos = pos

    const target = checkpoints[Math.min(cpIdx, checkpoints.length - 1)]
    const d = haversineM(pos, target)
    const stD = app.querySelector('#st-dist')
    if (stD) stD.textContent = formatKm(d)

    if (d < 70 && cpIdx < checkpoints.length - 1) {
      cpIdx++
      updateTarget()
      if (navigator.vibrate) navigator.vibrate(35)
      toast('Опорная точка пройдена')
    }

    for (const lm of planned!.landmarks) {
      if (visitedIds.has(lm.id)) continue
      if (haversineM(pos, lm) <= lm.radius_m) {
        visitedIds.add(lm.id)
        visited.push(lm)
        saveLocalVisit(lm.id)
        refreshLm()
        if (navigator.vibrate) navigator.vibrate([30, 40, 60])
        toast(`Точка: ${lm.name}`)
      }
    }
  })

  app.querySelector('#btn-finish')?.addEventListener('click', async () => {
    const seconds = (Date.now() - startedAt) / 1000
    const meters = Math.max(metersAlong, pathLengthM(planned!.route.slice(0, Math.max(2, cpIdx + 1))))
    cleanup()
    await finishRoute(meters, seconds, visited)
    renderProfile()
  })
  app.querySelector('#btn-stop')?.addEventListener('click', () => {
    cleanup()
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
  const visited: Landmark[] = []
  const visitedIds = new Set<string>(loadLocalVisits())
  const startedAt = Date.now()
  let map: MapLibreMap | null = null
  let lastPos: LatLon | null = null
  let metersAlong = 0

  const endOf = (i: number) => chunks[i][chunks[i].length - 1]

  const render = (opts?: { openUrl?: string }): void => {
    const canContinue = done.has(active) && active < chunks.length - 1
    const allDone = done.size >= chunks.length
    const sec = Math.floor((Date.now() - startedAt) / 1000)
    const mm = Math.floor(sec / 60)
    const ss = sec % 60

    app.innerHTML = shell(
      'Яндекс.Карты',
      `${chunks.length} участков · время ${mm}:${String(ss).padStart(2, '0')}`,
      `
      <div class="banner">
        <strong>Как продолжать маршрут</strong>
        Откройте участок в Яндексе. Вернитесь сюда у конца куска — мы предложим следующий. На iOS фон почти не живёт.
      </div>
      ${
        canContinue
          ? `<div class="banner"><strong>Участок ${active + 1} пройден</strong>Можно продолжить.</div>
             <button type="button" class="btn warn" id="btn-continue">Продолжить · участок ${active + 2}</button>`
          : ''
      }
      ${allDone ? `<div class="banner"><strong>Все участки пройдены</strong>Сохраните результат.</div>` : ''}
      <div class="nav-status">
        <div class="stat"><div class="label">Участок</div><div class="value">${active + 1}/${chunks.length}</div></div>
        <div class="stat"><div class="label">До конца</div><div class="value" id="st-end">—</div></div>
        <div class="stat"><div class="label">Время</div><div class="value live-timer" id="st-time">${mm}:${String(ss).padStart(2, '0')}</div></div>
      </div>
      <div class="map-wrap" id="map"></div>
      <a class="btn" href="${urls[active]}" target="_blank" rel="noopener">Открыть участок ${active + 1} в Яндексе</a>
      <button type="button" class="btn secondary" id="btn-mark" ${done.has(active) ? 'disabled' : ''}>Отметить участок пройденным</button>
      <button type="button" class="btn" id="btn-finish">Завершить и сохранить</button>
      <button type="button" class="btn secondary" id="btn-stop">Выйти</button>
      `,
      'home',
    )
    bindTabs()

    map?.remove()
    const mapEl = app.querySelector('#map') as HTMLElement
    const chunkMap = createMap(mapEl, chunks[active][0], 12)
    map = chunkMap
    navMap = chunkMap
    chunkMap.on('load', () => {
      setRouteLine(chunkMap, 'route', planned!.route, '#3d5c48')
      chunkMap.setPaintProperty('route-line', 'line-opacity', 0.35)
      setRouteLine(chunkMap, 'chunk', chunks[active], '#2f9e5e')
      fitToRoute(chunkMap, chunks[active], 48)
      addLandmarkMarkers(chunkMap, planned!.landmarks, visitedIds)
    })

    app.querySelector('#btn-mark')?.addEventListener('click', () => {
      done.add(active)
      toast(`Участок ${active + 1} отмечен`)
      render()
    })
    app.querySelector('#btn-continue')?.addEventListener('click', () => {
      active = Math.min(active + 1, chunks.length - 1)
      render({ openUrl: urls[active] })
    })
    app.querySelector('#btn-finish')?.addEventListener('click', async () => {
      const seconds = (Date.now() - startedAt) / 1000
      stopNav()
      await finishRoute(Math.max(metersAlong, planned!.targetMeters * (done.size / chunks.length)), seconds, visited)
      renderProfile()
    })
    app.querySelector('#btn-stop')?.addEventListener('click', () => {
      stopNav()
      renderPlanner()
    })
    if (opts?.openUrl) window.open(opts.openUrl, '_blank', 'noopener')
  }

  render()

  watchId = watchGps((pos) => {
    if (map) upsertMarker(map, userMarker, pos, 'marker-user')
    if (lastPos) metersAlong += haversineM(lastPos, pos)
    lastPos = pos
    const d = haversineM(pos, endOf(active))
    const st = app.querySelector('#st-end')
    if (st) st.textContent = formatKm(d)
    const sec = Math.floor((Date.now() - startedAt) / 1000)
    const te = app.querySelector('#st-time')
    if (te) te.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`

    if (!done.has(active) && d < 90) {
      done.add(active)
      if (navigator.vibrate) navigator.vibrate(50)
      toast(`Участок ${active + 1} почти пройден`)
      render()
    }
    for (const lm of planned!.landmarks) {
      if (visitedIds.has(lm.id)) continue
      if (haversineM(pos, lm) <= lm.radius_m) {
        visitedIds.add(lm.id)
        visited.push(lm)
        saveLocalVisit(lm.id)
        toast(`Точка: ${lm.name}`)
        render()
      }
    }
  })

  visibilityHandler = () => {
    if (document.visibilityState === 'visible') toast('Сверяем ваш прогресс…', 1200)
  }
  document.addEventListener('visibilitychange', visibilityHandler)
}

void boot()

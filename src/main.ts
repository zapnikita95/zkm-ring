import './style.css'
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
  takeDistanceNearLandmark,
  takeUntilPoint,
  type LatLon,
} from './geo'
import {
  CATEGORY_LABEL,
  landmarksOnRoute,
  loadLandmarks,
  loadRing,
  loadRoutesCatalog,
  getSelectedRouteId,
  setSelectedRouteId,
  nearestLandmark,
  nudgeAlongTrack,
  routingLandmarks,
  type Landmark,
  type RouteCatalogItem,
} from './data'
import {
  createMap,
  setRouteLine,
  clearRouteLine,
  fitToRoute,
  upsertMarker,
  wireSvgRoutes,
  addLandmarkMarkers,
  addStartMarker,
  addEndMarker,
  clearMarkers,
  whenMapReady,
  followUser,
  wireFullscreenMap,
  type SvgRouteHandle,
} from './map'
import {
  requestGeoAndFix,
  checkGeoPermission,
  watchGps,
  loadLocalVisits,
  saveLocalVisit,
  formatProfileStats,
  saveActiveRoute,
  loadActiveRoute,
  clearActiveRoute,
  type Direction,
  type NavKind,
  type StoredActiveRoute,
  type GeoStatus,
  type GpsFix,
  type GpsWatchHandle,
} from './state'
import {
  chunkForYandex,
  chunkPointsForYandex,
  landmarksToLatLon,
  yandexRouteUrl,
  YANDEX_MAX_POINTS,
  type TravelMode,
} from './yandex'
import {
  completeRoute,
  fetchMe,
  fetchRouteHistory,
  deleteRoute,
  getToken,
  login as apiLogin,
  logoutApi,
  register as apiRegister,
  setToken,
  type RouteHistoryItem,
} from './api'
import { hasOnboarded, setOnboarded, setProfileCache, profileCache } from './types'
import { describeRingStart } from './places'
import { bearingDeg, guidanceAlongRoute, turnSymbol } from './guidance'

const app = document.querySelector<HTMLDivElement>('#app')!
const ICON = '/icons/app-icon.png?v=104'

let ringRaw: LatLon[] = []
let landmarksAll: Landmark[] = []
let routesCatalog: RouteCatalogItem[] = []
let activeRoute: RouteCatalogItem | null = null
/** Полный каталог ориентиров ЗКМ (не зависит от выбранного трека МО). */
let zkmLandmarks: Landmark[] = []

let mode: TravelMode = 'bike'
let direction: Direction = 'ccw'
let paramBy: 'distance' | 'duration' = 'distance'
let distanceKm = 15
let durationMin = 60
/** Кусочек маршрута: выкл = целое кольцо от ближайшей точки. */
let sliceMode = false
/** Значение длины участка введено (км/мин). */
let sliceInputRaw = ''
/** Финиш, выбранный флагом (точка на кольце). */
let endPos: LatLon | null = null
let endLabelManual = ''
/** Что выбираем тапом по карте: старт или финиш. */
let pickTarget: 'start' | 'end' = 'start'
let startPos: LatLon | null = null
/** Фактическое GPS пользователя (для доезда до кольца). */
let userGps: LatLon | null = null
let startLabel = ''
let navKind: NavKind = 'inapp'
let geoStatus: GeoStatus = 'off'

type Planned = {
  mode: TravelMode
  direction: Direction
  targetMeters: number
  targetMinutes: number
  /** Точка на кольце — начало основного маршрута */
  start: LatLon
  startLabel: string
  end: LatLon
  endLabel: string
  endLandmark: Landmark | null
  /** Где пользователь сейчас (если известен GPS) */
  userGps: LatLon | null
  /** Линия доезда: GPS → старт на кольце */
  approach: LatLon[]
  /** Основной кусок кольца */
  route: LatLon[]
  landmarks: Landmark[]
  navKind: NavKind
  needsApproach: boolean
}
let planned: Planned | null = null

let watchHandle: GpsWatchHandle | null = null
let navMap: MapLibreMap | null = null
let plannerMap: MapLibreMap | null = null
let plannerMarkers: Marker[] = []
let plannerSvg: SvgRouteHandle | null = null
let startPickGen = 0
let previewPaintGen = 0
/** Следить камерой за GPS в навигации (выкл = можно зумить/панорамировать). */
let navFollowEnabled = true
/** Трекинг GPS включён (кнопка GPS в шапке). */
let gpsTrackingEnabled = true
const userMarker = { current: null as Marker | null }
const targetMarker = { current: null as Marker | null }
let visibilityHandler: (() => void) | null = null
let unwireFs: (() => void) | null = null
let unwirePlannerZoom: (() => void) | null = null
/** Колбэк навигации: перезапуск/остановка watch при toggle GPS. */
let navGpsController: {
  startWatch: () => void
  stopWatch: () => void
  onFreshFix?: (p: GpsFix) => void
} | null = null

const PIE_SLICE_ICON = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
  <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.7"/>
  <path fill="currentColor" d="M12 12V3a9 9 0 0 1 7.79 13.5Z"/>
</svg>`

function disposeMapUi(): void {
  unwireFs?.()
  unwireFs = null
  unwirePlannerZoom?.()
  unwirePlannerZoom = null
  document.body.classList.remove('map-fs-open')
  plannerSvg?.destroy()
  plannerSvg = null
  if (userMarker.current) {
    try {
      userMarker.current.remove()
    } catch {
      /* ignore */
    }
    userMarker.current = null
  }
  if (targetMarker.current) {
    try {
      targetMarker.current.remove()
    } catch {
      /* ignore */
    }
    targetMarker.current = null
  }
  clearMarkers(plannerMarkers)
  plannerMap = null
}

/** Все видимые точки на карте; линия — только кусок. Старт всегда с пульсом. */
function paintAllLandmarksForPick(map: MapLibreMap, bucket: Marker[], selectedStart?: LatLon | null): void {
  clearMarkers(bucket)
  const visible = landmarksAll.filter((l) => !l.mapHidden)
  const markers = addLandmarkMarkers(map, visible, loadLocalVisits(), true, {
    onPick: (lm) => {
      void setStartFromPoint(
        { lat: lm.lat, lon: lm.lon },
        { toastMsg: `Старт: ${lm.name}`, labelOverride: lm.name },
      )
    },
  })
  bucket.push(...markers)
  if (selectedStart) {
    bucket.push(addStartMarker(map, selectedStart, startLabel ? `Старт · ${startLabel}` : 'Старт'))
  }
}

function paintRouteMarkers(
  map: MapLibreMap,
  bucket: Marker[],
  landmarks: Landmark[],
  start: LatLon,
  end: LatLon,
  startLabelTxt: string,
  endLabelTxt: string,
  earned: Set<string>,
  endLandmark: Landmark | null,
  opts?: { onlyOnRoute?: boolean },
): void {
  clearMarkers(bucket)
  const onRouteVisible = landmarks.filter((l) => !l.mapHidden && !l.listOnly)
  const visibleAll = opts?.onlyOnRoute
    ? onRouteVisible
    : landmarksAll.filter((l) => !l.mapHidden)

  // старт/финиш — всегда точные координаты маршрута (не «переезд» к парку по имени)
  const endLm =
    (endLandmark && !endLandmark.mapHidden && haversineM(endLandmark, end) < 220
      ? endLandmark
      : null) ||
    nearestLandmark(routingLandmarks(landmarks), end, 120) ||
    nearestLandmark(visibleAll, end, 120)

  const labelIds = new Set(onRouteVisible.map((l) => l.id))
  if (endLm) labelIds.add(endLm.id)

  const markers = addLandmarkMarkers(map, visibleAll, earned, true, {
    onRoute: true,
    startId: null,
    endId: endLm?.id ?? null,
    labelIds,
    onPick: (lm) => {
      void setStartFromPoint(
        { lat: lm.lat, lon: lm.lon },
        { toastMsg: `Старт: ${lm.name}`, labelOverride: lm.name },
      )
    },
  })
  bucket.push(...markers)

  const coinciding = haversineM(start, end) < 45
  if (coinciding) {
    // Полный круг: развести точки вдоль линии и короткие подписи в стороны
    const startDot = nudgeAlongTrack(ringRaw, start, -20)
    const endDot = nudgeAlongTrack(ringRaw, end, 20)
    bucket.push(addStartMarker(map, startDot, 'Старт', { labelSide: 'left' }))
    bucket.push(addEndMarker(map, endDot, 'Финиш', { labelSide: 'right' }))
    return
  }

  const startTxt =
    startLabelTxt && startLabelTxt !== endLabelTxt
      ? `Старт · ${startLabelTxt}`
      : 'Старт'
  bucket.push(addStartMarker(map, start, startTxt))
  if (!endLm || haversineM(endLm, end) > 80) {
    const endTxt =
      endLabelTxt && endLabelTxt !== startLabelTxt ? `Финиш · ${endLabelTxt}` : 'Финиш'
    bucket.push(addEndMarker(map, end, endTxt))
  }
}

/** Текст заметки/трабла уже в name; generic description не дублируем. */
function formatLandmarkListItem(lm: Landmark, i: number, local: Set<string>, numbered = true): string {
  const isAlert = lm.category === 'alert'
  const isNote = lm.category === 'note'
  const badge = isAlert
    ? '<span class="badge alert">внимание</span>'
    : isNote
      ? '<span class="badge note">заметка</span>'
      : `<span class="badge">${CATEGORY_LABEL[lm.category] || lm.category}</span>`
  const done = local.has(lm.id) ? '<span class="badge done">было</span>' : ''
  const cls = isAlert ? ' class="lm-alert"' : isNote ? ' class="lm-note"' : ''
  const title = numbered ? `${i + 1}. ${lm.name}` : lm.name
  return `<li${cls} data-lm-id="${lm.id}"><strong>${title}</strong>${badge}${done}</li>`
}

function bindLandmarkListClicks(root: ParentNode, landmarks: Landmark[], route: LatLon[]): void {
  root.querySelectorAll('li[data-lm-id]').forEach((node) => {
    node.addEventListener('click', () => {
      const id = (node as HTMLElement).dataset.lmId
      const lm = landmarks.find((x) => x.id === id)
      if (lm) showLandmarkPreview(lm, route)
    })
  })
}

function showLandmarkPreview(lm: Landmark, route: LatLon[]): void {
  document.querySelector('.lm-preview-overlay')?.remove()
  const ov = document.createElement('div')
  ov.className = 'lm-preview-overlay'
  ov.innerHTML = `
    <div class="lm-preview-card">
      <h3>${lm.name}</h3>
      <div class="lm-preview-map" id="lm-preview-map"></div>
      <button type="button" class="btn" id="lm-preview-close" style="margin-top:10px">Закрыть</button>
    </div>`
  document.body.appendChild(ov)
  document.body.style.overflow = 'hidden'
  const close = (): void => {
    try {
      mini?.remove()
    } catch {
      /* ignore */
    }
    svg?.destroy()
    ov.remove()
    document.body.style.overflow = ''
  }
  ov.addEventListener('click', (e) => {
    if (e.target === ov) close()
  })
  ov.querySelector('#lm-preview-close')?.addEventListener('click', close)

  const host = ov.querySelector('#lm-preview-map') as HTMLElement
  const mini = createMap(host, { lat: lm.lat, lon: lm.lon }, 13.5)
  const svg = wireSvgRoutes(mini, host)
  const bucket: Marker[] = []
  whenMapReady(mini, () => {
    const near = route.length
      ? sampleAlong(
          (() => {
            const idx = nearestIndex(route, lm)
            const a = Math.max(0, idx - 40)
            const b = Math.min(route.length, idx + 40)
            return route.slice(a, b)
          })(),
          80,
        )
      : []
    const routes: Array<{ pts: LatLon[]; color: string; width: number }> = []
    if (near.length >= 2) routes.push({ pts: near, color: '#00c853', width: 10 })
    svg.setRoutes(routes)
    clearMarkers(bucket)
    bucket.push(addEndMarker(mini, lm, lm.name))
    fitToRoute(mini, near.length >= 2 ? near : [lm], 40, 14)
  })
}

/** Via для Яндекса: ориентиры/якоря на участке + старт/финиш; без alert/note. */
function yandexViasForPlanned(p: Planned): LatLon[] {
  const vias = routingLandmarks(p.landmarks)
  if (vias.length < 2) {
    return sampleAlong(p.route, Math.min(24, Math.max(YANDEX_MAX_POINTS, Math.ceil(p.route.length / 40))))
  }
  const pts = landmarksToLatLon(vias)
  if (haversineM(p.start, pts[0]) > 180) pts.unshift(p.start)
  if (haversineM(p.end, pts[pts.length - 1]) > 180) pts.push(p.end)
  return pts
}

function plannedToStored(p: Planned): StoredActiveRoute {
  return {
    mode: p.mode,
    direction: p.direction,
    targetMeters: p.targetMeters,
    targetMinutes: p.targetMinutes,
    start: p.start,
    startLabel: p.startLabel,
    end: p.end,
    endLabel: p.endLabel,
    endLandmark: p.endLandmark,
    userGps: p.userGps,
    approach: p.approach,
    route: p.route,
    landmarks: p.landmarks,
    navKind: p.navKind,
    needsApproach: p.needsApproach,
    startedAt: Date.now(),
  }
}

function storedToPlanned(s: StoredActiveRoute): Planned {
  const asLm = (
    x: StoredActiveRoute['landmarks'][number] | StoredActiveRoute['endLandmark'],
  ): Landmark | null => {
    if (!x) return null
    return {
      id: x.id,
      name: x.name,
      category: x.category,
      description: x.description,
      radius_m: x.radius_m,
      lat: x.lat,
      lon: x.lon,
      ringIndex: 0,
      orderCw: 0,
      orderCcw: 0,
    }
  }
  return {
    mode: s.mode,
    direction: s.direction,
    targetMeters: s.targetMeters,
    targetMinutes: s.targetMinutes,
    start: s.start,
    startLabel: s.startLabel,
    end: s.end,
    endLabel: s.endLabel,
    endLandmark: asLm(s.endLandmark),
    userGps: s.userGps,
    approach: s.approach,
    route: s.route,
    landmarks: s.landmarks.map((x) => asLm(x)!),
    navKind: s.navKind,
    needsApproach: s.needsApproach,
  }
}

function openYandexForPlanned(p: Planned): void {
  // Первый шаг: доезд или первый кусок кольца (лимит ~6 точек).
  if (p.needsApproach && p.approach.length >= 2) {
    const approachPts = sampleAlong(p.approach, Math.min(YANDEX_MAX_POINTS, Math.max(3, p.approach.length)))
    window.open(yandexRouteUrl(approachPts, p.mode), '_blank')
    return
  }
  const chunks = chunkPointsForYandex(yandexViasForPlanned(p), YANDEX_MAX_POINTS)
  const first = chunks[0] || chunkForYandex(p.route, YANDEX_MAX_POINTS)[0]
  if (first?.length >= 2) window.open(yandexRouteUrl(first, p.mode), '_blank')
}

function toast(msg: string, ms = 3400): void {
  document.querySelector('.toast')?.remove()
  const el = document.createElement('div')
  el.className = 'toast'
  el.textContent = msg
  document.body.appendChild(el)
  setTimeout(() => el.remove(), ms)
}

function shell(title: string, sub: string, body: string, tab?: 'home' | 'route' | 'profile'): string {
  const geoOn = gpsTrackingEnabled && geoStatus === 'on'
  const geoCls =
    geoOn
      ? 'geo-btn on'
      : geoStatus === 'denied'
        ? 'geo-btn denied'
        : geoStatus === 'pending'
          ? 'geo-btn pending'
          : 'geo-btn'
  const geoLabel = geoOn
    ? 'GPS ✓'
    : geoStatus === 'denied'
      ? 'GPS!'
      : geoStatus === 'pending'
        ? '…'
        : gpsTrackingEnabled
          ? 'GPS'
          : 'GPS ✕'
  return `
    <div class="app-shell">
      <header class="header">
        <img class="brand-ico" src="${ICON}" alt="" width="44" height="44" />
        <div>
          <h1>${title}</h1>
          ${sub ? `<p>${sub}</p>` : ''}
        </div>
        <div class="header-spacer"></div>
        <button type="button" class="${geoCls}" id="btn-geo-header" title="Геолокация">${geoLabel}</button>
      </header>
      <div class="panel">${body}</div>
      ${
        tab
          ? `<nav class="bottom-nav tabs-3">
              <button type="button" data-tab="home" class="${tab === 'home' ? 'active' : ''}">Главная</button>
              <button type="button" data-tab="route" class="${tab === 'route' ? 'active' : ''}">Маршрут</button>
              <button type="button" data-tab="profile" class="${tab === 'profile' ? 'active' : ''}">Профиль</button>
            </nav>`
          : ''
      }
    </div>
  `
}

function syncGeoHeaderBtn(): void {
  const btn = app.querySelector('#btn-geo-header') as HTMLButtonElement | null
  if (!btn) return
  const on = gpsTrackingEnabled && geoStatus === 'on'
  btn.className = on
    ? 'geo-btn on'
    : geoStatus === 'denied'
      ? 'geo-btn denied'
      : geoStatus === 'pending'
        ? 'geo-btn pending'
        : 'geo-btn'
  btn.textContent = on
    ? 'GPS ✓'
    : geoStatus === 'denied'
      ? 'GPS!'
      : geoStatus === 'pending'
        ? '…'
        : gpsTrackingEnabled
          ? 'GPS'
          : 'GPS ✕'
  btn.title = gpsTrackingEnabled
    ? 'Геолокация вкл — нажмите, чтобы выключить трекинг'
    : 'Трекинг выкл — нажмите, чтобы включить GPS'
}

async function enableGeoFromHeader(): Promise<void> {
  // toggle: выкл трекинг (актуально при скачках GPS)
  if (gpsTrackingEnabled && geoStatus === 'on') {
    gpsTrackingEnabled = false
    navFollowEnabled = false
    geoStatus = 'off'
    syncGeoHeaderBtn()
    navGpsController?.stopWatch()
    toast('Трекинг GPS выключен — карту можно отдалять свободно')
    return
  }

  gpsTrackingEnabled = true
  navFollowEnabled = true
  geoStatus = 'pending'
  syncGeoHeaderBtn()
  try {
    const gps = await requestGeoAndFix()
    userGps = gps
    geoStatus = 'on'
    syncGeoHeaderBtn()
    navGpsController?.startWatch()
    navGpsController?.onFreshFix?.(gps)
    if (navMap) {
      upsertMarker(navMap, userMarker, gps, 'marker-user')
      followUser(navMap, gps, gps.heading ?? null, 15)
    }
    if (!startPos && plannerMap) {
      await setStartFromPoint(gps, { fromGps: true })
    } else if (plannerMap) {
      toast('GPS включён')
      updatePlannerPreview({ fit: true })
    } else {
      toast('GPS включён')
    }
  } catch (e) {
    geoStatus = 'denied'
    gpsTrackingEnabled = false
    syncGeoHeaderBtn()
    toast(e instanceof Error ? e.message : String(e))
  }
}

function bindGeoHeader(): void {
  app.querySelector('#btn-geo-header')?.addEventListener('click', () => {
    void enableGeoFromHeader()
  })
  void checkGeoPermission().then((s) => {
    if (geoStatus !== 'on' && geoStatus !== 'pending') {
      if (s === 'denied') geoStatus = 'denied'
      syncGeoHeaderBtn()
    }
  })
}

/** Запрос гео сразу при входе на главную. */
async function requestGeoOnPlannerEnter(): Promise<void> {
  if (!gpsTrackingEnabled) return
  if (geoStatus === 'on' || geoStatus === 'pending') return
  geoStatus = 'pending'
  syncGeoHeaderBtn()
  try {
    const gps = await requestGeoAndFix()
    userGps = gps
    geoStatus = 'on'
    syncGeoHeaderBtn()
    if (!startPos) {
      await setStartFromPoint(gps, { fromGps: true, toastMsg: 'Ближайшая точка на кольце' })
    } else {
      updatePlannerPreview({ fit: true })
    }
  } catch {
    geoStatus = 'off'
    syncGeoHeaderBtn()
  }
}

function bindTabs(): void {
  bindGeoHeader()
  app.querySelectorAll('.bottom-nav button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = (btn as HTMLElement).dataset.tab
      if (t === 'home') renderPlanner()
      else if (t === 'route') renderRouteTab()
      else if (t === 'profile') renderProfile()
    })
  })
}

/** Вкладка «Маршрут» — подтверждение / активный поход. */
function renderRouteTab(): void {
  const stored = loadActiveRoute()
  if (stored) {
    planned = storedToPlanned(stored)
    if (planned.navKind === 'yandex') renderYandexNav()
    else renderInAppNav()
    return
  }
  if (planned) {
    renderConfirm()
    return
  }
  stopNav()
  disposeMapUi()
  app.innerHTML = shell(
    'Маршрут',
    '',
    `
    <div class="card">
      <h2>Маршрут ещё не собран</h2>
      <p class="hint" style="color:var(--text-body, var(--text)); margin:8px 0 14px">
        На главной выберите старт на кольце, при желании — длину участка или финиш, затем нажмите кнопку внизу.
      </p>
      <button type="button" class="btn" id="btn-to-home">На главную</button>
    </div>
    `,
    'route',
  )
  bindTabs()
  app.querySelector('#btn-to-home')?.addEventListener('click', () => renderPlanner())
}

function resumeActiveRoute(): void {
  const stored = loadActiveRoute()
  if (!stored) {
    toast('Нет активного маршрута')
    renderPlanner()
    return
  }
  planned = storedToPlanned(stored)
  if (planned.navKind === 'yandex') renderYandexNav()
  else renderInAppNav()
}

function stopNav(): void {
  disposeMapUi()
  watchHandle?.stop()
  watchHandle = null
  navGpsController = null
  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler)
    visibilityHandler = null
  }
  navMap?.remove()
  navMap = null
  plannerMap?.remove()
  plannerMap = null
  clearMarkers(plannerMarkers)
  userMarker.current = null
  targetMarker.current = null
}

async function activateRoute(id: string): Promise<void> {
  const item = routesCatalog.find((r) => r.id === id) || routesCatalog[0]
  if (!item) throw new Error('Нет маршрутов в каталоге')
  activeRoute = item
  setSelectedRouteId(item.id)
  ringRaw = await loadRing(item.geojson)
  if (item.id === 'zkm-ring') {
    landmarksAll = zkmLandmarks.length ? zkmLandmarks : await loadLandmarks()
    zkmLandmarks = landmarksAll
  } else {
    const raw = item.landmarks || []
    landmarksAll = raw.map((lm, i) => {
      const idx = nearestIndex(ringRaw, { lat: lm.lat, lon: lm.lon })
      return {
        id: lm.id || `${item.id}-${i}`,
        name: lm.name,
        category: lm.category || 'viewpoint',
        description: lm.description || '',
        radius_m: lm.radius_m ?? 80,
        lat: lm.lat,
        lon: lm.lon,
        ringIndex: idx,
        orderCw: i,
        orderCcw: i,
      } satisfies Landmark
    })
  }
  // сброс выбора старта при смене трека
  startPos = null
  endPos = null
  endLabelManual = ''
  startLabel = ''
  userGps = null
  planned = null
  clearActiveRoute()
}

async function boot(): Promise<void> {
  app.innerHTML = `<div class="loading"><div class="spin"></div>Загружаем Зелёный Маршрут…</div>`
  try {
    ;[routesCatalog, zkmLandmarks] = await Promise.all([loadRoutesCatalog(), loadLandmarks()])
    if (!routesCatalog.length) {
      routesCatalog = [
        {
          id: 'zkm-ring',
          title: 'Зелёное кольцо Москвы',
          description: 'Полный круг Зелёного кольца',
          kmListed: 162,
          geojson: 'data/ring.geojson',
          points: 0,
          source: 'zkm',
          featured: true,
        },
      ]
    }
    if (getToken()) {
      try {
        const { profile } = await fetchMe()
        setProfileCache(profile)
      } catch {
        setToken(null)
        setProfileCache(null)
      }
    }
    if (!hasOnboarded()) {
      renderIntro()
      return
    }
    const saved = getSelectedRouteId()
    if (saved && routesCatalog.some((r) => r.id === saved)) {
      await activateRoute(saved)
      renderPlanner()
    } else {
      renderRoutePicker()
    }
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
        <p class="lead">Маршруты по Зелёному кольцу Москвы и велотреки Подмосковья — пешком или на велосипеде.</p>
      </div>
      <div class="intro-actions">
        <button type="button" class="btn" id="btn-start">Выбрать маршрут</button>
        <button type="button" class="btn secondary" id="btn-auth">Войти или зарегистрироваться</button>
      </div>
    </div>
  `
  app.querySelector('#btn-start')?.addEventListener('click', () => {
    setOnboarded()
    renderRoutePicker()
  })
  app.querySelector('#btn-auth')?.addEventListener('click', () => {
    setOnboarded()
    renderAuth()
  })
}

function renderRoutePicker(): void {
  stopNav()
  disposeMapUi()
  const cards = routesCatalog
    .map((r, i) => {
      const featured = r.featured || r.id === 'zkm-ring'
      return `<article class="route-card${featured ? ' featured' : ''}" data-route="${r.id}" style="--i:${i}">
        <div class="route-card-km">${r.kmListed.toLocaleString('ru-RU')} км</div>
        <h2>${r.title}</h2>
        <p>${r.description || 'Готовый трек для прогулки и навигации'}</p>
        <button type="button" class="btn${featured ? '' : ' secondary'}" data-pick="${r.id}">Выбрать</button>
      </article>`
    })
    .join('')

  app.innerHTML = `
    <div class="route-picker">
      <header class="route-picker-head">
        <h1>Куда пойдём?</h1>
        <p class="hint" style="color:var(--text);margin:6px 0 0">Зелёное кольцо и треки Подмосковья. Листайте вбок.</p>
      </header>
      <div class="route-carousel" id="route-carousel">${cards}</div>
      <div class="route-picker-dots" id="route-dots" aria-hidden="true"></div>
    </div>
  `
  const carousel = app.querySelector('#route-carousel') as HTMLElement
  const dots = app.querySelector('#route-dots') as HTMLElement
  dots.innerHTML = routesCatalog.map((_, i) => `<span data-dot="${i}"></span>`).join('')
  const syncDots = (): void => {
    const w = carousel.clientWidth || 1
    const idx = Math.round(carousel.scrollLeft / w)
    dots.querySelectorAll('span').forEach((el, i) => el.classList.toggle('on', i === idx))
  }
  carousel.addEventListener('scroll', () => syncDots(), { passive: true })
  syncDots()

  app.querySelectorAll('[data-pick]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = (btn as HTMLElement).dataset.pick!
      app.innerHTML = `<div class="loading"><div class="spin"></div>Открываем маршрут…</div>`
      try {
        await activateRoute(id)
        renderPlanner()
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Не удалось открыть маршрут')
        renderRoutePicker()
      }
    })
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
    'profile',
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
  disposeMapUi()
  const p = profileCache
  if (!p) {
    app.innerHTML = shell(
      'Профиль',
      '',
      `
      <div class="card">
        <h2>Вход</h2>
        <p class="hint" style="color:var(--text); margin:8px 0 14px">
          Войдите, чтобы сохранять маршруты и ачивки. Можно пользоваться приложением и без аккаунта.
        </p>
        <button type="button" class="btn" id="btn-go-auth">Войти или зарегистрироваться</button>
      </div>
      `,
      'profile',
    )
    bindTabs()
    app.querySelector('#btn-go-auth')?.addEventListener('click', () => renderAuth('login'))
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
      <h2>Аккаунт</h2>
      <button type="button" class="btn secondary" id="btn-logout">Выйти</button>
    </div>
    <div class="card">
      <h2>История прогулок</h2>
      <ul class="list history-list" id="history-list"><li class="muted">Загрузка…</li></ul>
    </div>
    <div class="card">
      <h2>Ачивки</h2>
      <div class="ach-grid">${cards}</div>
    </div>
    `,
    'profile',
  )
  bindTabs()
  app.querySelector('#btn-logout')?.addEventListener('click', () => void doLogout())
  void loadAndRenderHistory()
}

function formatHistoryDate(iso: string): string {
  try {
    const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z')
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString('ru-RU', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

async function loadAndRenderHistory(): Promise<void> {
  const ul = app.querySelector('#history-list')
  if (!ul) return
  try {
    const { items } = await fetchRouteHistory()
    if (!items.length) {
      ul.innerHTML = '<li class="muted">Пока нет завершённых прогулок</li>'
      return
    }
    ul.innerHTML = items
      .map((it) => {
        const title =
          it.startLabel && it.endLabel
            ? `${it.startLabel} → ${it.endLabel}`
            : it.startLabel || it.endLabel || 'Прогулка по кольцу'
        const mode = it.mode === 'walk' ? 'пешком' : 'велосипед'
        return `<li class="history-item" data-id="${it.id}">
          <button type="button" class="history-main" data-open="${it.id}">
            <strong>${title}</strong>
            <span class="history-meta">${formatHistoryDate(it.createdAt)} · ${formatKm(it.meters)} · ${formatDuration(it.seconds / 60)} · ${mode}</span>
          </button>
          <button type="button" class="history-del" data-del="${it.id}" aria-label="Удалить" title="Удалить">×</button>
        </li>`
      })
      .join('')

    ul.querySelectorAll('[data-open]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number((btn as HTMLElement).dataset.open)
        const item = items.find((x) => x.id === id)
        if (item) showHistoryRoute(item)
      })
    })
    ul.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const id = Number((btn as HTMLElement).dataset.del)
        confirmDeleteHistory(id)
      })
    })
  } catch (e) {
    ul.innerHTML = `<li class="muted">${e instanceof Error ? e.message : 'Не удалось загрузить историю'}</li>`
  }
}

function confirmDeleteHistory(id: number): void {
  document.querySelector('.lm-preview-overlay')?.remove()
  const ov = document.createElement('div')
  ov.className = 'lm-preview-overlay'
  ov.innerHTML = `
    <div class="lm-preview-card">
      <h3>Удалить прогулку?</h3>
      <p class="hint" style="color:var(--text);margin:8px 0 14px">Запись исчезнет из истории. Суммарная статистика обновится.</p>
      <button type="button" class="btn" id="hist-del-yes" style="background:var(--danger)">Удалить</button>
      <button type="button" class="btn secondary" id="hist-del-no" style="margin-top:8px">Отмена</button>
    </div>`
  document.body.appendChild(ov)
  document.body.style.overflow = 'hidden'
  const close = (): void => {
    ov.remove()
    document.body.style.overflow = ''
  }
  ov.addEventListener('click', (e) => {
    if (e.target === ov) close()
  })
  ov.querySelector('#hist-del-no')?.addEventListener('click', close)
  ov.querySelector('#hist-del-yes')?.addEventListener('click', async () => {
    const yes = ov.querySelector('#hist-del-yes') as HTMLButtonElement
    yes.disabled = true
    try {
      const res = await deleteRoute(id)
      setProfileCache(res.profile)
      close()
      toast('Прогулка удалена')
      renderProfile()
    } catch (e) {
      yes.disabled = false
      toast(e instanceof Error ? e.message : 'Не удалось удалить')
    }
  })
}

function showHistoryRoute(item: RouteHistoryItem): void {
  document.querySelector('.lm-preview-overlay')?.remove()
  const title =
    item.startLabel && item.endLabel
      ? `${item.startLabel} → ${item.endLabel}`
      : 'Прогулка'
  const ov = document.createElement('div')
  ov.className = 'lm-preview-overlay'
  ov.innerHTML = `
    <div class="lm-preview-card">
      <h3>${title}</h3>
      <p class="history-meta" style="margin:0 0 8px">${formatHistoryDate(item.createdAt)} · ${formatKm(item.meters)} · ${formatDuration(item.seconds / 60)} · ${
        item.mode === 'walk' ? 'пешком' : 'велосипед'
      }</p>
      <div class="lm-preview-map" id="hist-map"></div>
      <button type="button" class="btn" id="hist-close" style="margin-top:10px">Закрыть</button>
    </div>`
  document.body.appendChild(ov)
  document.body.style.overflow = 'hidden'
  let mini: ReturnType<typeof createMap> | null = null
  let svg: SvgRouteHandle | null = null
  const close = (): void => {
    try {
      mini?.remove()
    } catch {
      /* ignore */
    }
    svg?.destroy()
    ov.remove()
    document.body.style.overflow = ''
  }
  ov.addEventListener('click', (e) => {
    if (e.target === ov) close()
  })
  ov.querySelector('#hist-close')?.addEventListener('click', close)

  const host = ov.querySelector('#hist-map') as HTMLElement
  const center = item.route[0] || { lat: 55.75, lon: 37.62 }
  mini = createMap(host, center, 11)
  svg = wireSvgRoutes(mini, host)
  whenMapReady(mini, () => {
    const pts = item.route.length >= 2 ? item.route : []
    if (pts.length >= 2) {
      svg?.setRoutes([{ pts, color: '#00c853', width: 10 }])
      fitToRoute(mini!, pts, 36, 13)
    }
  })
}

function sliceValueActive(): boolean {
  if (!sliceMode) return false
  const n = Number(String(sliceInputRaw).replace(',', '.'))
  return Number.isFinite(n) && n > 0
}

/** Есть ли укороченный участок (длина или выбранный финиш). */
function segmentActive(): boolean {
  return !!endPos || sliceValueActive()
}

function sliceTargetMeters(): number {
  const n = Number(String(sliceInputRaw).replace(',', '.'))
  if (paramBy === 'distance') return Math.max(1, n || 0) * 1000
  return metersFromMinutes(Math.max(1, n || 0), mode)
}

function buildRoute(): Planned {
  if (!startPos) throw new Error('Сначала определите ближайшую точку (GPS или тап по карте)')
  const oriented = orientRing(ringRaw, direction === 'ccw')
  const startIdx = nearestIndex(oriented, startPos)
  const ringStart = oriented[startIdx]
  const fromStart = rotateToStart(oriented, startIdx)

  let route: LatLon[]
  let meters: number
  let endLandmark: Landmark | null = null
  let endLabel: string

  if (endPos) {
    route = takeUntilPoint(fromStart, endPos)
    meters = pathLengthM(route)
    endLandmark = nearestLandmark(routingLandmarks(landmarksAll), endPos, 180)
    endLabel = endLabelManual || endLandmark?.name || 'Финиш'
  } else if (sliceValueActive()) {
    const targetMeters = sliceTargetMeters()
    const snapped = takeDistanceNearLandmark(fromStart, targetMeters, routingLandmarks(landmarksAll))
    route = snapped.route
    meters = snapped.meters
    endLandmark = snapped.endLandmark
    endLabel = snapped.endLandmark?.name || 'Финиш на кольце'
  } else {
    route = fromStart
    meters = pathLengthM(route)
    endLandmark = null
    endLabel = 'Полный круг'
  }

  const end = route[route.length - 1] ?? ringStart
  const gps = userGps
  const approachDist = gps ? haversineM(gps, ringStart) : 0
  const needsApproach = !!(gps && approachDist > 80)
  const approach: LatLon[] = needsApproach && gps ? [gps, ringStart] : []

  return {
    mode,
    direction,
    targetMeters: meters,
    targetMinutes: minutesFromMeters(meters, mode),
    start: ringStart,
    startLabel: startLabel || 'Старт на кольце',
    end,
    endLabel,
    endLandmark,
    userGps: gps,
    approach,
    route,
    landmarks: landmarksOnRoute(landmarksAll, route),
    navKind,
    needsApproach,
  }
}

function currentPreviewRoute(): {
  route: LatLon[]
  approach: LatLon[]
  landmarks: Landmark[]
  meters: number
  minutes: number
  needsApproach: boolean
  end: LatLon
  endLabel: string
  endLandmark: Landmark | null
} | null {
  if (!startPos) return null
  try {
    const p = buildRoute()
    return {
      route: p.route,
      approach: p.approach,
      landmarks: p.landmarks,
      meters: p.targetMeters,
      minutes: p.targetMinutes,
      needsApproach: p.needsApproach,
      end: p.end,
      endLabel: p.endLabel,
      endLandmark: p.endLandmark,
    }
  } catch {
    return null
  }
}

function updatePlannerPreview(opts?: { fit?: boolean }): void {
  const statsKm = app.querySelector('#stat-km')
  const statsTime = app.querySelector('#stat-time')
  const statsMode = app.querySelector('#stat-mode')
  const btn = app.querySelector('#btn-continue') as HTMLButtonElement | null
  const equiv = app.querySelector('#param-equiv')
  const paintGen = ++previewPaintGen
  const doFit = opts?.fit !== false

  const oriented = orientRing(ringRaw, direction === 'ccw')
  const preview = startPos ? currentPreviewRoute() : null
  const hasSegment = !!(preview && segmentActive())

  if (btn) {
    btn.disabled = !startPos
    btn.textContent = hasSegment ? 'К маршруту' : 'Начать от ближайшей точки'
  }

  if (equiv) {
    if (sliceMode && sliceValueActive() && !endPos) {
      const m = sliceTargetMeters()
      equiv.textContent =
        paramBy === 'distance'
          ? `≈ ${formatDuration(minutesFromMeters(m, mode))}`
          : `≈ ${formatKm(m)}`
    } else {
      equiv.textContent = ''
    }
  }

  if (!plannerMap) return

  const host = app.querySelector('#planner-map-host') as HTMLElement | null
  if (host) {
    if (!plannerSvg) plannerSvg = wireSvgRoutes(plannerMap, host)
  }

  if (preview) {
    if (statsKm) statsKm.textContent = formatKm(preview.meters)
    if (statsTime) statsTime.textContent = formatDuration(preview.minutes)
    if (statsMode) statsMode.textContent = mode === 'bike' ? 'велосипед' : 'пешком'
  } else {
    if (statsKm) statsKm.textContent = '—'
    if (statsTime) statsTime.textContent = '—'
    if (statsMode) statsMode.textContent = ''
  }

  const fl = app.querySelector('#btn-flag') as HTMLButtonElement | null
  if (fl) {
    fl.disabled = !startPos
    fl.classList.toggle('active', pickTarget === 'end')
    fl.classList.toggle('has-end', !!endPos)
  }
  const stBtn = app.querySelector('#btn-gps') as HTMLButtonElement | null
  stBtn?.classList.toggle('active', pickTarget === 'start')

  const paint = (): void => {
    if (paintGen !== previewPaintGen || !plannerMap) return
    const map = plannerMap
    try {
      map.resize()
      const fullDraw = oriented.length > 420 ? sampleAlong(oriented, 400) : oriented
      clearRouteLine(map, 'ring-full')
      clearRouteLine(map, 'preview-route')
      clearRouteLine(map, 'approach-route')

      const svgRoutes: Array<{ pts: LatLon[]; color: string; width: number }> = []

      if (preview && hasSegment) {
        svgRoutes.push({ pts: fullDraw, color: '#9e9e9e', width: 4 })
        const routeDraw =
          preview.route.length > 400 ? sampleAlong(preview.route, 320) : preview.route
        svgRoutes.push({ pts: routeDraw, color: '#00c853', width: 14 })
        if (preview.approach.length >= 2) {
          svgRoutes.unshift({ pts: preview.approach, color: '#ff6d00', width: 7 })
        }
      } else {
        svgRoutes.push({ pts: fullDraw, color: '#00c853', width: 10 })
        if (preview?.approach.length && preview.approach.length >= 2) {
          svgRoutes.unshift({ pts: preview.approach, color: '#ff6d00', width: 7 })
        }
      }

      if (host && !plannerSvg) plannerSvg = wireSvgRoutes(map, host)
      plannerSvg?.setRoutes(svgRoutes)

      if (preview) {
        paintRouteMarkers(
          map,
          plannerMarkers,
          preview.landmarks,
          preview.route[0],
          preview.end,
          startLabel || 'Старт',
          preview.endLabel,
          loadLocalVisits(),
          preview.endLandmark,
          { onlyOnRoute: hasSegment },
        )
      } else {
        paintAllLandmarksForPick(map, plannerMarkers, startPos)
      }
      if (userGps) upsertMarker(map, userMarker, userGps, 'marker-user')
      syncMarkerZoom(map)

      if (doFit) {
        if (preview && hasSegment) fitToRoute(map, preview.route, 64, 13)
        else fitToRoute(map, fullDraw, 36, 11)
      }
    } catch (e) {
      console.error('[planner paint]', e)
    }
  }

  if (plannerMap.isStyleLoaded()) {
    paint()
    requestAnimationFrame(() => paintGen === previewPaintGen && paint())
    setTimeout(() => paintGen === previewPaintGen && paint(), 80)
    setTimeout(() => paintGen === previewPaintGen && paint(), 280)
  } else {
    plannerMap.once('load', () => {
      paint()
      setTimeout(() => paintGen === previewPaintGen && paint(), 150)
    })
  }
}

function syncMarkerZoom(map: MapLibreMap): void {
  const z = map.getZoom()
  const root = map.getContainer().parentElement || map.getContainer()
  root.querySelectorAll('.marker-lm-wrap, .marker-start-wrap, .marker-end-wrap').forEach((node) => {
    const el = node as HTMLElement
    const important = el.classList.contains('mk-start') || el.classList.contains('mk-end')
    // обзор города: только старт/финиш; подписи — при приближении
    el.classList.toggle('hide-label', z < 13.2 && !important)
    el.classList.toggle('hide-dot', z < 12 && !important)
  })
}


/** список точек — на экране подтверждения */

async function setStartFromPoint(
  p: LatLon,
  opts?: { fromGps?: boolean; toastMsg?: string; labelOverride?: string },
): Promise<void> {
  const gen = ++startPickGen
  if (opts?.fromGps) {
    userGps = p
    geoStatus = 'on'
    gpsTrackingEnabled = true
    syncGeoHeaderBtn()
  }

  const oriented = orientRing(ringRaw, direction === 'ccw')
  const ringIndex = nearestIndex(oriented, p)
  startPos = oriented[ringIndex]
  startLabel = opts?.labelOverride?.trim() || 'Точка на кольце'
  pickTarget = 'start'
  updatePlannerPreview({ fit: true })

  const label = await describeRingStart(p, oriented, landmarksAll, {
    labelOverride: opts?.labelOverride,
  })
  if (gen !== startPickGen) return

  startPos = label.ringPoint
  startLabel = label.title
  if (opts?.toastMsg) toast(opts.toastMsg)
  else toast(`Старт: ${label.title}`)
  updatePlannerPreview({ fit: true })
}

async function setEndFromPoint(p: LatLon, opts?: { labelOverride?: string }): Promise<void> {
  if (!startPos) {
    toast('Сначала выберите старт')
    return
  }
  const oriented = orientRing(ringRaw, direction === 'ccw')
  const ringIndex = nearestIndex(oriented, p)
  endPos = oriented[ringIndex]
  // длина по участку сбрасывает «режим длины» — финиш приоритетнее
  sliceMode = false
  sliceInputRaw = ''
  const near = nearestLandmark(
    landmarksAll.filter((l) => !l.mapHidden && !l.listOnly),
    endPos,
    180,
  )
  endLabelManual = opts?.labelOverride?.trim() || near?.name || ''
  if (!endLabelManual) {
    const label = await describeRingStart(endPos, oriented, landmarksAll)
    endLabelManual = label.title
  }
  pickTarget = 'start'
  syncCompactToolbar()
  toast(`Финиш: ${endLabelManual}`)
  updatePlannerPreview({ fit: true })
}

function applySliceFromInput(opts?: { fit?: boolean }): void {
  const inp = app.querySelector('#inp-val') as HTMLInputElement | null
  if (inp) {
    sliceInputRaw = inp.value.trim().replace(',', '.')
    inp.blur()
  }
  if (sliceValueActive()) {
    endPos = null
    endLabelManual = ''
    const n = Number(sliceInputRaw)
    if (paramBy === 'distance') {
      distanceKm = Math.max(1, n)
      durationMin = Math.round(minutesFromMeters(distanceKm * 1000, mode))
    } else {
      durationMin = Math.max(1, n)
      distanceKm = Math.round((metersFromMinutes(durationMin, mode) / 1000) * 10) / 10
    }
  }
  updatePlannerPreview({ fit: opts?.fit !== false })
  const p = currentPreviewRoute()
  if (p && segmentActive()) {
    toast(`${formatKm(p.meters)} · ${formatDuration(p.minutes)} → ${p.endLabel}`)
  }
}

function syncCompactToolbar(): void {
  app.querySelectorAll('#mode-seg button').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-mode') === mode)
  })
  app.querySelectorAll('#dir-seg button').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-dir') === direction)
  })
  app.querySelectorAll('#param-unit button').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-param') === paramBy)
  })
  const sliceBtn = app.querySelector('#btn-slice')
  sliceBtn?.classList.toggle('active', sliceMode)
  const panel = app.querySelector('#slice-panel') as HTMLElement | null
  if (panel) panel.hidden = !sliceMode

  const inp = app.querySelector('#inp-val') as HTMLInputElement | null
  const unit = app.querySelector('#inp-unit-label')
  if (inp) {
    inp.value = sliceInputRaw
    inp.placeholder = paramBy === 'distance' ? 'напр. 15' : 'напр. 60'
    if (paramBy === 'distance') {
      inp.min = '1'
      inp.max = '180'
      inp.step = '1'
      if (unit) unit.textContent = 'км'
    } else {
      inp.min = '10'
      inp.max = '600'
      inp.step = '5'
      if (unit) unit.textContent = 'мин'
    }
  }
  updatePlannerPreview({ fit: false })
}

function bindSeg(sel: string, attr: string, onPick: (v: string) => void): void {
  app.querySelector(sel)?.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('button')
    const v = t?.getAttribute(attr)
    if (v) onPick(v)
  })
}

function renderPlanner(): void {
  if (!ringRaw.length) {
    const id = getSelectedRouteId() || activeRoute?.id || routesCatalog[0]?.id || 'zkm-ring'
    void activateRoute(id)
      .then(() => renderPlanner())
      .catch(() => renderRoutePicker())
    return
  }
  stopNav()
  disposeMapUi()
  const active = loadActiveRoute()
  const activeHtml = active
    ? `<div class="active-banner compact">
        <div><strong>В пути</strong> · ${active.startLabel} → ${active.endLabel}</div>
        <div class="row">
          <button type="button" class="btn" id="btn-resume-active">Открыть</button>
          <button type="button" class="btn secondary" id="btn-drop-active">Сброс</button>
        </div>
      </div>`
    : ''

  app.innerHTML = shell(
    activeRoute?.title || 'Зелёный Маршрут',
    activeRoute ? `${activeRoute.kmListed.toLocaleString('ru-RU')} км` : '',
    `
    ${activeHtml}
    <div class="planner-compact">
      <button type="button" class="btn-route-switch" id="btn-routes">Сменить маршрут</button>
      <div class="toolbar-row">
        <div class="icon-seg" id="mode-seg" title="Режим">
          <button type="button" data-mode="bike" class="${mode === 'bike' ? 'active' : ''}" aria-label="Велосипед">🚲</button>
          <button type="button" data-mode="walk" class="${mode === 'walk' ? 'active' : ''}" aria-label="Пешком">🚶</button>
        </div>
        <div class="icon-seg" id="dir-seg" title="Направление">
          <button type="button" data-dir="ccw" class="${direction === 'ccw' ? 'active' : ''}" aria-label="Против часовой">↺</button>
          <button type="button" data-dir="cw" class="${direction === 'cw' ? 'active' : ''}" aria-label="По часовой">↻</button>
        </div>
        <button type="button" class="slice-toggle${sliceMode ? ' active' : ''}" id="btn-slice" aria-pressed="${sliceMode}" aria-label="Длина участка" title="Длина участка">${PIE_SLICE_ICON}</button>
      </div>
      <div class="slice-panel" id="slice-panel" ${sliceMode ? '' : 'hidden'}>
        <div class="icon-seg" id="param-unit" title="Единицы">
          <button type="button" data-param="distance" class="${paramBy === 'distance' ? 'active' : ''}" aria-label="Километры">км</button>
          <button type="button" data-param="duration" class="${paramBy === 'duration' ? 'active' : ''}" aria-label="Время">⏱</button>
        </div>
        <div class="val-wrap">
          <input type="number" id="inp-val" inputmode="decimal" enterkeyhint="done" value="${sliceInputRaw}" placeholder="${paramBy === 'distance' ? 'напр. 15' : 'напр. 60'}" />
          <span class="unit" id="inp-unit-label">${paramBy === 'distance' ? 'км' : 'мин'}</span>
        </div>
        <span class="equiv" id="param-equiv"></span>
      </div>

      <div class="map-wrap planner flex-map" id="planner-map-host">
        <div id="planner-map" style="width:100%;height:100%"></div>
        <button type="button" class="map-pick-btn start${pickTarget === 'start' ? ' active' : ''}" id="btn-gps" title="Выбрать старт"><span class="ico">🚩</span><span>Старт</span></button>
        <button type="button" class="map-pick-btn finish${pickTarget === 'end' ? ' active' : ''}${endPos ? ' has-end' : ''}" id="btn-flag" title="Выбрать финиш" ${startPos ? '' : 'disabled'}><span class="ico">🏁</span><span>Финиш</span></button>
      </div>
      <div class="route-stats" id="route-stats">
        <span class="rs-km" id="stat-km">—</span>
        <span class="rs-time" id="stat-time">—</span>
        <span class="rs-mode" id="stat-mode"></span>
      </div>
      <p class="error" id="gps-err" hidden></p>
      <button type="button" class="btn" id="btn-continue" ${startPos ? '' : 'disabled'}>Начать от ближайшей точки</button>
    </div>
    `,
    'home',
  )
  bindTabs()
  app.querySelector('#btn-routes')?.addEventListener('click', () => renderRoutePicker())

  bindSeg('#mode-seg', 'data-mode', (v) => {
    mode = v as TravelMode
    if (sliceValueActive()) {
      if (paramBy === 'distance') {
        durationMin = Math.round(minutesFromMeters(Number(sliceInputRaw) * 1000, mode))
      } else {
        distanceKm = Math.round((metersFromMinutes(Number(sliceInputRaw), mode) / 1000) * 10) / 10
      }
    }
    syncCompactToolbar()
    toast(mode === 'bike' ? 'Велосипед' : 'Пешком')
  })
  bindSeg('#dir-seg', 'data-dir', (v) => {
    direction = v as Direction
    syncCompactToolbar()
    updatePlannerPreview({ fit: true })
    if (startPos) {
      const p = currentPreviewRoute()
      if (p) toast(`${direction === 'ccw' ? 'Против часовой' : 'По часовой'} · ${formatKm(p.meters)}`)
    } else toast(direction === 'ccw' ? 'Против часовой' : 'По часовой')
  })
  bindSeg('#param-unit', 'data-param', (v) => {
    paramBy = v as 'distance' | 'duration'
    sliceInputRaw = ''
    syncCompactToolbar()
    toast(paramBy === 'distance' ? 'Укажите километры' : 'Укажите минуты')
  })

  app.querySelector('#btn-slice')?.addEventListener('click', () => {
    sliceMode = !sliceMode
    if (!sliceMode) {
      sliceInputRaw = ''
      toast('Полное кольцо')
    } else {
      endPos = null
      endLabelManual = ''
      toast('Укажите длину участка в км или минутах')
    }
    syncCompactToolbar()
    updatePlannerPreview({ fit: true })
  })

  let sliceDebounce = 0
  app.querySelector('#inp-val')?.addEventListener('input', (e) => {
    sliceInputRaw = (e.target as HTMLInputElement).value.trim().replace(',', '.')
    if (sliceMode) {
      const equiv = app.querySelector('#param-equiv')
      if (equiv && sliceValueActive()) {
        const m = sliceTargetMeters()
        equiv.textContent =
          paramBy === 'distance'
            ? `≈ ${formatDuration(minutesFromMeters(m, mode))}`
            : `≈ ${formatKm(m)}`
      } else if (equiv) equiv.textContent = ''
    }
    // карта обновляется сразу при вводе (не только по Enter)
    window.clearTimeout(sliceDebounce)
    sliceDebounce = window.setTimeout(() => {
      if (!sliceMode) return
      if (sliceValueActive()) {
        endPos = null
        endLabelManual = ''
      }
      updatePlannerPreview({ fit: true })
    }, 280)
  })
  app.querySelector('#inp-val')?.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      e.preventDefault()
      applySliceFromInput({ fit: true })
    }
  })
  app.querySelector('#inp-val')?.addEventListener('change', () => {
    applySliceFromInput({ fit: true })
  })
  app.querySelector('#inp-val')?.addEventListener('blur', () => {
    if (sliceMode && sliceInputRaw) applySliceFromInput({ fit: true })
  })

  app.querySelector('#btn-resume-active')?.addEventListener('click', () => resumeActiveRoute())
  app.querySelector('#btn-drop-active')?.addEventListener('click', () => {
    clearActiveRoute()
    toast('Активный маршрут сброшен')
    renderPlanner()
  })

  const mapHost = app.querySelector('#planner-map-host') as HTMLElement
  const mapEl = app.querySelector('#planner-map') as HTMLElement
  const center = startPos || { lat: 55.75, lon: 37.62 }
  plannerMap = createMap(mapEl, center, 10.2)
  unwireFs = wireFullscreenMap(mapHost, plannerMap)
  plannerSvg = wireSvgRoutes(plannerMap, mapHost)
  const onZoomSync = (): void => {
    if (plannerMap) syncMarkerZoom(plannerMap)
  }
  plannerMap.on('zoom', onZoomSync)
  plannerMap.on('moveend', onZoomSync)
  unwirePlannerZoom = () => {
    plannerMap?.off('zoom', onZoomSync)
    plannerMap?.off('moveend', onZoomSync)
  }
  whenMapReady(plannerMap, () => {
    updatePlannerPreview({ fit: true })
    void requestGeoOnPlannerEnter()
  })
  plannerMap.on('click', (e) => {
    const pt = { lat: e.lngLat.lat, lon: e.lngLat.lng }
    if (pickTarget === 'end') void setEndFromPoint(pt)
    else void setStartFromPoint(pt)
  })

  const syncPickBtns = (): void => {
    const fl = app.querySelector('#btn-flag') as HTMLButtonElement | null
    const st = app.querySelector('#btn-gps') as HTMLButtonElement | null
    if (fl) {
      fl.disabled = !startPos
      fl.classList.toggle('active', pickTarget === 'end')
      fl.classList.toggle('has-end', !!endPos)
    }
    st?.classList.toggle('active', pickTarget === 'start')
  }
  syncPickBtns()

  app.querySelector('#btn-flag')?.addEventListener('click', () => {
    if (!startPos) {
      toast('Сначала выберите старт')
      return
    }
    if (endPos && pickTarget !== 'end') {
      endPos = null
      endLabelManual = ''
      pickTarget = 'start'
      toast('Финиш сброшен')
      syncPickBtns()
      updatePlannerPreview({ fit: true })
      return
    }
    if (pickTarget === 'end') {
      pickTarget = 'start'
      toast('Выбор финиша отменён')
    } else {
      pickTarget = 'end'
      toast('Тапните по кольцу — точка финиша')
    }
    syncPickBtns()
  })

  app.querySelector('#btn-gps')?.addEventListener('click', () => {
    pickTarget = 'start'
    syncPickBtns()
    toast('Тапните по кольцу — точка старта')
  })

  app.querySelector('#btn-continue')?.addEventListener('click', () => {
    try {
      planned = buildRoute()
      renderConfirm()
    } catch (e) {
      toast(String(e))
    }
  })
}

function reverseCurrentRoute(): void {
  if (!planned || !startPos) return
  const newStart = endPos || planned.end
  const newStartLabel = endLabelManual || planned.endLabel
  const newEnd = startPos
  const newEndLabel = startLabel
  startPos = { lat: newStart.lat, lon: newStart.lon }
  startLabel = newStartLabel
  endPos = { lat: newEnd.lat, lon: newEnd.lon }
  endLabelManual = newEndLabel
  direction = direction === 'cw' ? 'ccw' : 'cw'
  sliceMode = false
  sliceInputRaw = ''
  try {
    planned = buildRoute()
    toast('Маршрут развёрнут')
    renderConfirm()
  } catch (e) {
    toast(String(e))
  }
}

function renderConfirm(): void {
  if (!planned) return
  stopNav()
  disposeMapUi()
  const local = loadLocalVisits()
  const listLms = planned.landmarks
  const alertN = listLms.filter((l) => l.category === 'alert').length
  const list = listLms.length
    ? listLms.map((lm, i) => formatLandmarkListItem(lm, i, local)).join('')
    : '<li>На участке нет знаковых точек из каталога</li>'

  const approachM = planned.approach.length >= 2 ? pathLengthM(planned.approach) : 0
  const trailHtml =
    alertN > 0
      ? `<div class="banner warn-banner"><strong>На тропе</strong>${alertN} ${
          alertN === 1 ? 'место с осторожностью' : 'мест с осторожностью'
        } — смотрите список ниже.</div>`
      : ''

  const goBtns =
    planned.needsApproach && approachM > 80
      ? `<button type="button" class="btn" id="btn-to-start">Доехать до старта</button>
         <button type="button" class="btn secondary" id="btn-from-start">Маршрут от старта</button>`
      : `<button type="button" class="btn" id="btn-from-start">Начать маршрут</button>`

  app.innerHTML = shell(
    'Маршрут',
    '',
    `
    <div class="confirm-toolbar">
      <button type="button" class="btn-icon-round" id="btn-reverse" title="Развернуть маршрут" aria-label="Развернуть маршрут">🔃</button>
    </div>
    ${trailHtml}
    <div class="map-wrap tall" id="confirm-map-host">
      <div id="map" style="width:100%;height:100%"></div>
    </div>
    <div class="route-stats">
      <span class="rs-km">${formatKm(planned.targetMeters)}</span>
      <span class="rs-time">${formatDuration(planned.targetMinutes)}</span>
      <span class="rs-mode">${planned.mode === 'bike' ? 'велосипед' : 'пешком'} · ${planned.landmarks.length} т.</span>
    </div>
    <div class="card tight">
      <h2>Точки на участке</h2>
      <ul class="list" id="preview-lm-list">${list}</ul>
    </div>
    <div class="card tight">
      <h2>Навигация</h2>
      <div class="seg" id="nav-seg">
        <button type="button" data-nav="inapp" class="${navKind === 'inapp' ? 'active' : ''}">В приложении</button>
        <button type="button" data-nav="yandex" class="${navKind === 'yandex' ? 'active' : ''}">Яндекс</button>
      </div>
    </div>
    ${goBtns}
    <button type="button" class="btn secondary" id="btn-back">Назад</button>
    `,
    'route',
  )
  bindTabs()
  bindLandmarkListClicks(app.querySelector('#preview-lm-list') || app, listLms, planned.route)
  app.querySelector('#btn-reverse')?.addEventListener('click', () => reverseCurrentRoute())

  bindSeg('#nav-seg', 'data-nav', (v) => {
    navKind = v as NavKind
    app.querySelectorAll('#nav-seg button').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-nav') === navKind)
    })
    if (planned) planned.navKind = navKind
  })

  const host = app.querySelector('#confirm-map-host') as HTMLElement
  const mapEl = app.querySelector('#map') as HTMLElement
  const center = planned.route[Math.floor(planned.route.length / 2)] ?? planned.start
  const map = createMap(mapEl, center, 12)
  const confirmMarkers: Marker[] = []
  const svg = wireSvgRoutes(map, host)
  unwireFs = wireFullscreenMap(host, map)

  const paintConfirm = (): void => {
    if (!planned) return
    map.resize()
    clearRouteLine(map, 'ring-full')
    const routeDraw =
      planned.route.length > 360 ? sampleAlong(planned.route, 280) : planned.route
    setRouteLine(map, 'route', routeDraw, '#00c853', 11)
    svg.setRoutes([{ pts: routeDraw, color: '#00c853', width: 10 }])
    fitToRoute(map, planned.route, 48, 13)
    paintRouteMarkers(
      map,
      confirmMarkers,
      planned.landmarks,
      planned.start,
      planned.end,
      planned.startLabel,
      planned.endLabel,
      local,
      planned.endLandmark,
      { onlyOnRoute: true },
    )
    if (planned.userGps) upsertMarker(map, userMarker, planned.userGps, 'marker-user')
  }

  whenMapReady(map, () => {
    paintConfirm()
    setTimeout(paintConfirm, 150)
    setTimeout(paintConfirm, 500)
  })

  const startNav = (withApproach: boolean): void => {
    if (!planned) return
    if (!withApproach) {
      planned = { ...planned, needsApproach: false, approach: [] }
    }
    planned.navKind = navKind
    saveActiveRoute(plannedToStored(planned))
    svg.destroy()
    if (planned.navKind === 'yandex') renderYandexNav()
    else renderInAppNav()
  }

  app.querySelector('#btn-back')?.addEventListener('click', () => {
    svg.destroy()
    renderPlanner()
  })
  app.querySelector('#btn-to-start')?.addEventListener('click', () => startNav(true))
  app.querySelector('#btn-from-start')?.addEventListener('click', () => startNav(false))
}


async function finishRoute(meters: number, seconds: number, visited: Landmark[]): Promise<void> {
  if (!planned) return
  clearActiveRoute()
  if (getToken()) {
    try {
      const res = await completeRoute({
        meters,
        seconds,
        mode: planned.mode,
        landmarks: visited.map((v) => ({ id: v.id, category: v.category })),
        startLabel: planned.startLabel,
        endLabel: planned.endLabel,
        direction: planned.direction,
        route: sampleAlong(planned.route, Math.min(100, Math.max(20, Math.ceil(planned.route.length / 8)))),
      })
      setProfileCache(res.profile)
      for (const a of res.newAchievements || []) {
        toast(`Ачивка: ${a.title || a.code}`)
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Не удалось сохранить на сервер')
    }
  } else {
    toast('Маршрут завершён. Войдите, чтобы сохранить историю в профиле.')
  }
}

function renderInAppNav(): void {
  if (!planned) return
  stopNav()
  let phase: 'approach' | 'ring' = planned.needsApproach ? 'approach' : 'ring'
  const ringCheckpoints = sampleAlong(
    planned.route,
    Math.min(48, Math.max(10, Math.ceil(planned.route.length / 35))),
  )
  let cpIdx = 1
  const visited: Landmark[] = []
  const visitedIds = new Set<string>(loadLocalVisits())
  const startedAt = Date.now()
  let lastPos: LatLon | null = null
  let metersAlong = 0
  let derivedHeading: number | null = null
  let navSvg: SvgRouteHandle | null = null

  app.innerHTML = shell(
    'В пути',
    '',
    `
    <div class="nav-hud" id="nav-hud">
      <div class="arrow straight" id="hud-arrow">↑</div>
      <div class="copy">
        <p class="t" id="hud-title">Прямо</p>
        <p class="d" id="hud-detail">Готовим подсказки…</p>
      </div>
    </div>
    <div class="banner" id="phase-banner"></div>
    <div class="nav-status">
      <div class="stat"><div class="label">До цели</div><div class="value" id="st-dist">—</div></div>
      <div class="stat"><div class="label">Время</div><div class="value live-timer" id="st-time">0:00</div></div>
      <div class="stat"><div class="label">Этап</div><div class="value" id="st-phase">—</div></div>
    </div>
    <div class="map-wrap tall" id="nav-map-host">
      <div id="nav-map" style="width:100%;height:100%"></div>
    </div>
    <button type="button" class="btn btn-yandex" id="btn-to-yandex">Открыть в Яндекс.Картах</button>
    <button type="button" class="btn" id="btn-begin-ring" ${phase === 'approach' ? '' : 'hidden'}>Я на старте — по кольцу</button>
    <div class="card">
      <h2>Точки и ачивки</h2>
      <ul class="list" id="lm-live"></ul>
    </div>
    <button type="button" class="btn" id="btn-finish" ${phase === 'ring' ? '' : 'hidden'}>Завершить и сохранить</button>
    <button type="button" class="btn secondary" id="btn-home">На главную (маршрут сохранится)</button>
    `,
    'route',
  )
  bindTabs()

  const paintPhase = (): void => {
    const b = app.querySelector('#phase-banner')
    const st = app.querySelector('#st-phase')
    const beginBtn = app.querySelector('#btn-begin-ring') as HTMLButtonElement | null
    const finishBtn = app.querySelector('#btn-finish') as HTMLButtonElement | null
    if (phase === 'approach') {
      if (b)
        b.innerHTML = `<strong>Доезд до старта</strong>Доберитесь до старта на кольце. Потом продолжите по маршруту.`
      if (st) st.textContent = 'Доезд'
      if (beginBtn) beginBtn.hidden = false
      if (finishBtn) finishBtn.hidden = true
    } else {
      if (b)
        b.innerHTML = `<strong>По кольцу</strong>${formatKm(planned!.targetMeters)} · ${
          planned!.mode === 'bike' ? 'вело' : 'пешком'
        }`
      if (st) st.textContent = 'Кольцо'
      if (beginBtn) beginBtn.hidden = true
      if (finishBtn) finishBtn.hidden = false
    }
  }
  paintPhase()

  const refreshLm = (): void => {
    const ul = app.querySelector('#lm-live')
    if (!ul) return
    ul.innerHTML = planned!.landmarks
      .map((lm, i) => formatLandmarkListItem(lm, i, visitedIds))
      .join('')
    bindLandmarkListClicks(ul, planned!.landmarks, planned!.route)
  }
  refreshLm()

  const paintHud = (g: ReturnType<typeof guidanceAlongRoute>): void => {
    const arrow = app.querySelector('#hud-arrow') as HTMLElement | null
    const title = app.querySelector('#hud-title')
    const detail = app.querySelector('#hud-detail')
    if (arrow) {
      arrow.textContent = turnSymbol(g.turn)
      arrow.className = `arrow ${g.turn}`
    }
    if (title) title.textContent = g.title
    if (detail) detail.textContent = g.detail
  }

  const timer = window.setInterval(() => {
    const sec = Math.floor((Date.now() - startedAt) / 1000)
    const el = app.querySelector('#st-time')
    if (el) {
      const m = Math.floor(sec / 60)
      const s = sec % 60
      el.textContent = `${m}:${String(s).padStart(2, '0')}`
    }
  }, 1000)

  const mapHost = app.querySelector('#nav-map-host') as HTMLElement
  const mapEl = app.querySelector('#nav-map') as HTMLElement
  const created = createMap(mapEl, planned.route[0], 14)
  navMap = created
  navSvg = wireSvgRoutes(created, mapHost)
  unwireFs = wireFullscreenMap(mapHost, created)

  const paintNavRoutes = (): void => {
    if (!planned || !navMap) return
    navMap.resize()
    clearRouteLine(navMap, 'route')
    clearRouteLine(navMap, 'approach')
    const routeDraw =
      planned.route.length > 360 ? sampleAlong(planned.route, 280) : planned.route
    const svgRoutes: Array<{ pts: LatLon[]; color: string; width: number }> = [
      { pts: routeDraw, color: '#00c853', width: 11 },
    ]
    setRouteLine(navMap, 'route', routeDraw, '#00c853', 10)
    if (phase === 'approach' && planned.approach.length >= 2) {
      setRouteLine(navMap, 'approach', planned.approach, '#ff6d00', 7)
      svgRoutes.unshift({ pts: planned.approach, color: '#ff6d00', width: 7 })
    }
    navSvg?.setRoutes(svgRoutes)
  }

  whenMapReady(created, () => {
    paintNavRoutes()
    fitToRoute(created, [...planned!.approach, ...planned!.route], 56, 14)
    const navMarkers: Marker[] = []
    paintRouteMarkers(
      created,
      navMarkers,
      planned!.landmarks,
      planned!.start,
      planned!.end,
      planned!.startLabel,
      planned!.endLabel,
      visitedIds,
      planned!.endLandmark,
      { onlyOnRoute: true },
    )
    setTimeout(paintNavRoutes, 120)
    setTimeout(paintNavRoutes, 400)
  })

  const enterRingPhase = (): void => {
    if (phase === 'ring') return
    phase = 'ring'
    planned = { ...planned!, needsApproach: false }
    saveActiveRoute(plannedToStored(planned))
    paintPhase()
    paintNavRoutes()
    toast('Поехали по кольцу')
    if (navigator.vibrate) navigator.vibrate([40, 40, 80])
    if (navMap) fitToRoute(navMap, planned.route, 56, 14)
  }

  app.querySelector('#btn-begin-ring')?.addEventListener('click', () => enterRingPhase())

  const cleanup = (): void => {
    clearInterval(timer)
    navSvg?.destroy()
    navSvg = null
    stopNav()
  }

  const activePath = (): LatLon[] =>
    phase === 'approach' && planned!.approach.length >= 2 ? planned!.approach : planned!.route

  const refPathForGps = (): LatLon[] => {
    const ring = planned!.route
    const ap = planned!.approach
    if (phase === 'approach' && ap.length >= 2) return [...ap, ...ring]
    return ring
  }

  let lastGoodGps: LatLon | null = null
  let rejectedStreak = 0
  navFollowEnabled = true
  gpsTrackingEnabled = true
  geoStatus = 'on'
  syncGeoHeaderBtn()

  const startNavWatch = (): void => {
    watchHandle?.stop()
    watchHandle = watchGps((fix) => {
      if (!gpsTrackingEnabled) return
      const path = refPathForGps()
      const near = path.length ? haversineM(fix, path[nearestIndex(path, fix)]) : 0
      const jump = lastGoodGps ? haversineM(lastGoodGps, fix) : 0
      const badAccuracy = fix.accuracyM != null && fix.accuracyM > 150
      const teleport = lastGoodGps != null && jump > 800
      const farFromRoute = path.length >= 2 && near > 6000

      if (badAccuracy || teleport || farFromRoute) {
        rejectedStreak++
        if (rejectedStreak === 1 || rejectedStreak % 10 === 0) {
          toast(
            farFromRoute || teleport
              ? 'GPS скачет — нажмите GPS в шапке, чтобы выключить трекинг'
              : 'Слабый GPS — карта не следует',
            2200,
          )
        }
        return
      }
      rejectedStreak = 0

      const pos: LatLon = { lat: fix.lat, lon: fix.lon }
      const heading = fix.heading ?? null

      if (navMap) upsertMarker(navMap, userMarker, pos, 'marker-user')
      if (lastPos) {
        const step = haversineM(lastPos, pos)
        if (step < 200) metersAlong += step
        if (step > 2 && step < 120) derivedHeading = bearingDeg(lastPos, pos)
      }
      lastPos = pos
      lastGoodGps = pos

      const hdg = heading ?? derivedHeading
      if (navMap && navFollowEnabled) {
        followUser(navMap, pos, hdg, phase === 'approach' ? 15.5 : 16)
      }

      if (phase === 'approach') {
        const dStart = haversineM(pos, planned!.start)
        const stD = app.querySelector('#st-dist')
        if (stD) stD.textContent = formatKm(dStart)
        const g = guidanceAlongRoute(pos, planned!.approach, hdg, [])
        paintHud({
          ...g,
          title: dStart < 60 ? 'Старт рядом' : 'К старту',
          detail:
            dStart < 60
              ? 'Можно начинать кольцо'
              : `До старта · ${Math.round(dStart)} м`,
        })
        if (dStart < 70) enterRingPhase()
        return
      }

      const g = guidanceAlongRoute(pos, activePath(), hdg, planned!.landmarks)
      paintHud(g)

      const target = ringCheckpoints[Math.min(cpIdx, ringCheckpoints.length - 1)]
      const d = haversineM(pos, target)
      const stD = app.querySelector('#st-dist')
      if (stD) stD.textContent = formatKm(haversineM(pos, planned!.route[planned!.route.length - 1]))

      if (d < 70 && cpIdx < ringCheckpoints.length - 1) {
        cpIdx++
        if (navigator.vibrate) navigator.vibrate(35)
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
  }

  navGpsController = {
    startWatch: () => {
      lastGoodGps = null
      startNavWatch()
    },
    stopWatch: () => {
      watchHandle?.stop()
      watchHandle = null
    },
    onFreshFix: (p) => {
      lastGoodGps = p
      lastPos = p
      if (navMap) {
        upsertMarker(navMap, userMarker, p, 'marker-user')
        if (navFollowEnabled) followUser(navMap, p, p.heading ?? null, 15)
      }
    },
  }

  created.on('dragstart', () => {
    navFollowEnabled = false
  })

  startNavWatch()

  app.querySelector('#btn-finish')?.addEventListener('click', async () => {
    const seconds = (Date.now() - startedAt) / 1000
    const meters = Math.max(metersAlong, pathLengthM(planned!.route.slice(0, Math.max(2, cpIdx + 1))))
    cleanup()
    await finishRoute(meters, seconds, visited)
    renderProfile()
  })
  app.querySelector('#btn-home')?.addEventListener('click', () => {
    if (planned) saveActiveRoute(plannedToStored(planned))
    cleanup()
    renderPlanner()
  })
  app.querySelector('#btn-to-yandex')?.addEventListener('click', () => {
    if (!planned) return
    saveActiveRoute(plannedToStored({ ...planned, navKind: 'yandex' }))
    planned.navKind = 'yandex'
    openYandexForPlanned(planned)
    toast('Яндекс открыт. Маршрут остаётся активным — вкладка «Маршрут».')
  })
}

function renderYandexNav(): void {
  if (!planned) return
  stopNav()
  saveActiveRoute(plannedToStored({ ...planned, navKind: 'yandex' }))
  planned.navKind = 'yandex'

  type Leg = { title: string; points: LatLon[]; kind: 'approach' | 'ring' }
  const legs: Leg[] = []
  if (planned.needsApproach && planned.approach.length >= 2) {
    legs.push({
      title: `Доезд до «${planned.startLabel}»`,
      points: sampleAlong(
        planned.approach,
        Math.min(YANDEX_MAX_POINTS, Math.max(3, Math.ceil(planned.approach.length / 30))),
      ),
      kind: 'approach',
    })
  }
  const chunks = chunkPointsForYandex(yandexViasForPlanned(planned), YANDEX_MAX_POINTS)
  const ringChunks = chunks.length ? chunks : chunkForYandex(planned.route, YANDEX_MAX_POINTS)
  ringChunks.forEach((c, i) => {
    legs.push({
      title: `Кольцо · участок ${i + 1}/${ringChunks.length}`,
      points: c,
      kind: 'ring',
    })
  })
  const urls = legs.map((leg) => yandexRouteUrl(leg.points, planned!.mode))

  let active = 0
  const done = new Set<number>()
  const visited: Landmark[] = []
  const visitedIds = new Set<string>(loadLocalVisits())
  const startedAt = Date.now()
  let map: MapLibreMap | null = null
  let lastPos: LatLon | null = null
  let metersAlong = 0

  const endOf = (i: number) => legs[i].points[legs[i].points.length - 1]

  const render = (opts?: { openUrl?: string }): void => {
    const canContinue = done.has(active) && active < legs.length - 1
    const allDone = done.size >= legs.length
    const sec = Math.floor((Date.now() - startedAt) / 1000)
    const mm = Math.floor(sec / 60)
    const ss = sec % 60
    const leg = legs[active]

    app.innerHTML = shell(
      'Яндекс.Карты',
      '',
      `
      <div class="banner">
        <strong>Шаг ${active + 1}: ${leg.title}</strong>
        ${
          leg.kind === 'approach'
            ? 'Сначала откройте доезд до старта кольца. Потом — участки по кольцу.'
            : 'Короткий участок (до 6 точек) — так Яндекс лучше держит тропу. Отметьте шаг и откройте следующий.'
        }
      </div>
      ${
        canContinue
          ? `<div class="banner"><strong>Шаг ${active + 1} пройден</strong>Дальше: ${legs[active + 1].title}</div>
             <button type="button" class="btn warn" id="btn-continue">Открыть следующий в Яндексе</button>`
          : ''
      }
      ${allDone ? `<div class="banner"><strong>Все шаги пройдены</strong>Сохраните результат.</div>` : ''}
      <div class="nav-status">
        <div class="stat"><div class="label">Шаг</div><div class="value">${active + 1}/${legs.length}</div></div>
        <div class="stat"><div class="label">До конца</div><div class="value" id="st-end">—</div></div>
        <div class="stat"><div class="label">Время</div><div class="value live-timer" id="st-time">${mm}:${String(ss).padStart(2, '0')}</div></div>
      </div>
      <div class="map-wrap" id="map"></div>
      <a class="btn" href="${urls[active]}" target="_blank" rel="noopener">${
        leg.kind === 'approach' ? 'Открыть доезд в Яндекс.Картах' : 'Открыть участок в Яндекс.Картах'
      }</a>
      <button type="button" class="btn secondary" id="btn-mark" ${done.has(active) ? 'disabled' : ''}>Я на месте — следующий</button>
      <div class="card">
        <h2>План шагов</h2>
        <ul class="list seg-list">${legs
          .map((l, i) => {
            const status = done.has(i)
              ? '<span class="badge done">готово</span>'
              : i === active
                ? '<span class="badge">сейчас</span>'
                : ''
            return `<li><span class="idx">${i + 1}.</span> ${l.title} ${status}</li>`
          })
          .join('')}</ul>
      </div>
      <button type="button" class="btn secondary" id="btn-to-inapp">Вернуться к карте в приложении</button>
      <button type="button" class="btn" id="btn-finish">Завершить и сохранить</button>
      <button type="button" class="btn secondary" id="btn-home">На главную (маршрут сохранится)</button>
      `,
      'route',
    )
    bindTabs()

    map?.remove()
    const mapEl = app.querySelector('#map') as HTMLElement
    const chunkMap = createMap(mapEl, leg.points[0], 12)
    map = chunkMap
    navMap = chunkMap
    whenMapReady(chunkMap, () => {
      setRouteLine(chunkMap, 'route', planned!.route, '#90a4ae', 3)
      if (chunkMap.getLayer('route-line')) chunkMap.setPaintProperty('route-line', 'line-opacity', 0.45)
      if (planned!.approach.length >= 2) {
        setRouteLine(chunkMap, 'approach-full', planned!.approach, '#e65100', 3)
      }
      setRouteLine(chunkMap, 'chunk', leg.points, leg.kind === 'approach' ? '#e65100' : '#1b5e20', 5)
      fitToRoute(chunkMap, leg.points, 48, 14)
      const chunkMarkers: Marker[] = []
      paintRouteMarkers(
        chunkMap,
        chunkMarkers,
        planned!.landmarks,
        planned!.start,
        planned!.end,
        planned!.startLabel,
        planned!.endLabel,
        visitedIds,
        planned!.endLandmark,
      )
    })

    app.querySelector('#btn-mark')?.addEventListener('click', () => {
      done.add(active)
      if (active < legs.length - 1) {
        active += 1
        toast(`Дальше: ${legs[active].title}`)
        render({ openUrl: urls[active] })
      } else {
        toast('Все участки отмечены')
        render()
      }
    })
    app.querySelector('#btn-continue')?.addEventListener('click', () => {
      active = Math.min(active + 1, legs.length - 1)
      render({ openUrl: urls[active] })
    })
    app.querySelector('#btn-finish')?.addEventListener('click', async () => {
      const seconds = (Date.now() - startedAt) / 1000
      stopNav()
      await finishRoute(
        Math.max(metersAlong, planned!.targetMeters * (done.size / Math.max(1, legs.length))),
        seconds,
        visited,
      )
      renderProfile()
    })
    app.querySelector('#btn-home')?.addEventListener('click', () => {
      if (planned) saveActiveRoute(plannedToStored(planned))
      stopNav()
      renderPlanner()
    })
    app.querySelector('#btn-to-inapp')?.addEventListener('click', () => {
      if (!planned) return
      planned.navKind = 'inapp'
      saveActiveRoute(plannedToStored(planned))
      renderInAppNav()
    })
    if (opts?.openUrl) window.open(opts.openUrl, '_blank', 'noopener')
  }

  render()

  watchHandle?.stop()
  watchHandle = watchGps((fix) => {
    if (!gpsTrackingEnabled) return
    const pos: LatLon = { lat: fix.lat, lon: fix.lon }
    if (map) upsertMarker(map, userMarker, pos, 'marker-user')
    if (lastPos) {
      const step = haversineM(lastPos, pos)
      if (step < 500) metersAlong += step
    }
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
      toast(`Шаг ${active + 1} почти пройден`)
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

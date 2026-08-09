/**
 * Веб «Зелёный Маршрут»
 * трек → старт → финиш → подтверждение → карты
 */
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import {
  haversineM,
  nearestIndex,
  orientRing,
  pathLengthM,
  rotateToStart,
  takeDistance,
  formatKm as formatKmRaw,
  type LatLon,
} from '../src/geo'
import {
  wireSvgRoutes,
  type SvgEndpoint,
  type SvgRouteDraw,
  type SvgRouteHandle,
} from '../src/map'
import { yandexApproachUrl, yandexMapsLegs } from './yandex'
import { trackClient, trackPageView, ymSetUserId } from './analytics'
import { formatMckDist, loadMckStations, stationsNearStart, type MckStation } from './mck'
import {
  formatRailDist,
  loadMcdStations,
  mcdLinesLabel,
  ringDistanceAlongTrack,
  stationsAlpha,
  type McdStation,
} from './mcd'
import { isInsideMkad, stationsNearTrack } from './mkad'
import catalogBundled from '../public/data/routes-catalog.json'

type Mode = 'bike' | 'walk'
type Dir = 'ccw' | 'cw'
type FinishMode = 'length' | 'points'
type Step = 'track' | 'start' | 'finish' | 'confirm' | 'maps'
type PickMode = null | 'start' | 'end'

type RouteMeta = {
  id: string
  title: string
  description?: string
  kmListed: number
  geojson: string
  featured?: boolean
  cityId?: string
  difficulty?: string
}

type CityMeta = {
  id: string
  title: string
  subtitle?: string
  emoji?: string
}

type PointOpt = {
  id: string
  name: string
  lat: number
  lon: number
  idx: number
  /** Реальные координаты станции МЦК/МЦД (если старт/финиш с рельс). */
  stationLat?: number
  stationLon?: number
}

type LandmarkLite = {
  id: string
  name: string
  lat: number
  lon: number
  category: string
  description: string
  mapHidden?: boolean
  listOnly?: boolean
}

type TrailPoi = {
  id: string
  name: string
  lat: number
  lon: number
  kind: string
}

type DiffLevel = { id: string; title: string; emoji: string; km: number[] }

const DIFFICULTY: DiffLevel[] = [
  { id: 'easy', title: 'Лёгкий', emoji: '🟢', km: [5, 10, 15, 20, 25, 30] },
  { id: 'medium', title: 'Средний', emoji: '🟡', km: [40, 50, 60, 70, 80] },
  { id: 'hard', title: 'Тяжёлый', emoji: '🟠', km: [90, 100, 110, 120, 130] },
  { id: 'hardcore', title: 'Хардкор', emoji: '🔴', km: [140, 150, 160, 170] },
]

const BIKE_KMH = 15
const WALK_KMH = 5

const state = {
  mode: 'bike' as Mode,
  step: 'track' as Step,
  cityId: 'msk' as string,
  catalog: [] as RouteMeta[],
  cities: [] as CityMeta[],
  routeId: '' as string,
  track: [] as LatLon[],
  points: [] as PointOpt[],
  start: null as PointOpt | null,
  finishMode: 'length' as FinishMode,
  difficulty: null as string | null,
  direction: 'ccw' as Dir,
  units: 'km' as 'km' | 'time',
  meters: null as number | null,
  customRaw: '',
  end: null as PointOpt | null,
  segment: [] as LatLon[],
  pickMode: null as PickMode,
  addressQuery: '',
  addressHits: [] as { lat: number; lon: number; label: string }[],
  addressFor: 'start' as 'start' | 'end',
  addressStatus: '' as string,
  geoStatus: '' as string,
  /** Сырая гео до подтверждения «Вы находитесь тут?» (только кнопка «Гео» → старт на линии) */
  pendingGeo: null as LatLon | null,
  geoConfirmFor: null as null | 'start',
  /** Последняя геопозиция пользователя (для «Доехать до старта») */
  userGeo: null as LatLon | null,
  /** false = длина не выбрана — можно кликнуть по линии на карте */
  lengthPicked: false,
  /** Свёрнутая карта — больше места под панель */
  mapCompact: false,
  /** Официальное кольцо без крюка Коптево; track может включать альтернативу */
  useKoptevoAlt: false,
}

let map: maplibregl.Map | null = null
let svgRoutes: SvgRouteHandle | null = null
let startMarker: maplibregl.Marker | null = null
let endMarker: maplibregl.Marker | null = null
let geoMarker: maplibregl.Marker | null = null
let mapClickBound = false
const trackCache = new Map<string, LatLon[]>()
/** Официальный трек ZKM без опционального крюка Коптево */
let officialTrack: LatLon[] = []
/** Пунктирная альтернатива «крюк к МЦК Коптево» */
let koptevoAlt: LatLon[] = []
let koptevoAltKm = 0
let landmarks: LandmarkLite[] = []
let trailPois: TrailPoi[] = []
const GUEST_KEY = 'zm-guest-token'
const TOKEN_KEY = 'zm-token'
const CITY_KEY = 'zm-city-id'
const PLANNER_SNAP_KEY = 'zm-planner-snap-v1'
const savedMeta = new Map<string, { title: string; kmListed: number }>()
const savedPlansMeta = new Map<string, { title: string; kmListed: number; planId: string }>()
let lastShareUrl = ''
let lastSavedPlanId = ''
let focusMarker: maplibregl.Marker | null = null
let lastPersistedStep: Step | null = null
let persistTimer: ReturnType<typeof setTimeout> | null = null
/** Не писать URL во время boot/restore */
let suppressPersist = false

function getGuestToken(): string {
  let t = localStorage.getItem(GUEST_KEY) || ''
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(t)) {
    t = `g_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
    localStorage.setItem(GUEST_KEY, t)
  }
  return t
}

function getAuthToken(): string {
  return localStorage.getItem(TOKEN_KEY) || ''
}

function apiHeaders(extra: Record<string, string> = {}): HeadersInit {
  const h: Record<string, string> = { ...extra }
  const auth = getAuthToken()
  if (auth) h.Authorization = `Bearer ${auth}`
  h['X-Guest-Token'] = getGuestToken()
  return h
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...apiHeaders(init?.headers as Record<string, string>), ...(init?.body instanceof FormData ? {} : {}) },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`)
  return data as T
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T

function formatKm(m: number) {
  if (m < 1000) return `${Math.round(m)} м`
  return `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} км`
}

function formatDuration(mins: number) {
  const m = Math.max(1, Math.round(mins))
  if (m < 60) return `${m} мин`
  const h = Math.floor(m / 60)
  const r = m % 60
  return r ? `${h} ч ${r} мин` : `${h} ч`
}

function minutesFromMeters(meters: number, mode: Mode) {
  return (meters / 1000 / (mode === 'walk' ? WALK_KMH : BIKE_KMH)) * 60
}

function metersFromMinutes(mins: number, mode: Mode) {
  return ((mins / 60) * (mode === 'walk' ? WALK_KMH : BIKE_KMH)) * 1000
}

function difficultiesForTrack(trackMeters: number): DiffLevel[] {
  const maxKm = trackMeters / 1000
  const fit = (k: number) => k <= maxKm + 0.35
  const out: DiffLevel[] = []
  for (const d of DIFFICULTY) {
    const km = d.km.filter(fit)
    if (km.length) out.push({ ...d, km })
  }
  if (!out.length && maxKm >= 1) {
    out.push({ id: 'easy', title: 'Весь маршрут', emoji: '🏁', km: [Math.max(1, Math.floor(maxKm))] })
  } else if (out.length) {
    const whole = Math.floor(maxKm)
    const last = out[out.length - 1]
    if (whole >= 1 && fit(whole) && !last.km.includes(whole)) {
      last.km = [...last.km, whole].sort((a, b) => a - b)
    }
  }
  return out
}

function difficultyRangeM(diffId: string | null, kmOverride?: number[]): { minM: number; maxM: number } | null {
  const cur = difficultiesForTrack(pathLengthM(state.track)).find((d) => d.id === diffId)
  const km = kmOverride?.length ? kmOverride : cur?.km
  if (!km?.length) return null
  return { minM: km[0] * 1000, maxM: km[km.length - 1] * 1000 }
}

function formatKmListed(km: number) {
  return `${km.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} км`
}

function legendTrackTitle(meta: { id?: string; title: string; kmListed: number }) {
  const km = formatKmListed(meta.kmListed)
  if (meta.id === 'zkm-ring' || (/зелён/i.test(meta.title) && /кольц/i.test(meta.title))) {
    return `Зелёное Кольцо ${km}`
  }
  return `${meta.title} ${km}`
}

async function fetchJson<T>(path: string, attempts = 4): Promise<T> {
  const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '')
  const url = path.startsWith('http') ? path : `${base}/${path.replace(/^\//, '')}`
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as T
    } catch (e) {
      last = e
      await new Promise((r) => setTimeout(r, 180 * (i + 1)))
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

async function loadCatalog() {
  try {
    const data = await fetchJson<{ routes?: RouteMeta[]; cities?: CityMeta[] }>(
      '/data/routes-catalog.json',
    )
    state.catalog = data.routes || []
    if (data.cities?.length) state.cities = data.cities
  } catch {
    state.catalog = ((catalogBundled as { routes?: RouteMeta[] }).routes || []) as RouteMeta[]
  }
  if (!state.catalog.length) {
    state.catalog = ((catalogBundled as { routes?: RouteMeta[] }).routes || []) as RouteMeta[]
  }
  if (!state.cities.length) {
    try {
      const c = await fetchJson<{ cities?: CityMeta[] }>('/data/cities.json')
      state.cities = c.cities || []
    } catch {
      state.cities = [
        { id: 'msk', title: 'Москва', emoji: '🏙', subtitle: 'Зелёное кольцо и область' },
      ]
    }
  }
  const savedCity = localStorage.getItem(CITY_KEY) || 'msk'
  state.cityId = state.cities.some((c) => c.id === savedCity) ? savedCity : 'msk'
}

function currentCity(): CityMeta {
  return state.cities.find((c) => c.id === state.cityId) || state.cities[0] || { id: 'msk', title: 'Москва' }
}

function routesForCity(cityId = state.cityId): RouteMeta[] {
  const list = state.catalog.filter((r) => (r.cityId || 'msk') === cityId)
  return list.slice().sort((a, b) => {
    if (a.id === 'zkm-ring') return -1
    if (b.id === 'zkm-ring') return 1
    if (a.featured && !b.featured) return -1
    if (!a.featured && b.featured) return 1
    return (a.title || '').localeCompare(b.title || '', 'ru')
  })
}

function setCity(cityId: string) {
  if (!state.cities.some((c) => c.id === cityId)) return
  state.cityId = cityId
  localStorage.setItem(CITY_KEY, cityId)
  syncCityButton()
}

async function loadLandmarks() {
  try {
    const gj = await fetchJson<{ features?: any[] }>('/data/landmarks.json')
    landmarks = (gj.features || [])
      .map((f: any, i: number) => {
        const [lon, lat] = f.geometry.coordinates
        const p = f.properties || {}
        return {
          id: String(p.id || i),
          name: String(p.name || 'Точка'),
          lat,
          lon,
          category: String(p.category || 'park'),
          description: String(p.description || ''),
          mapHidden: Boolean(p.mapHidden),
          listOnly: Boolean(p.listOnly),
        } satisfies LandmarkLite
      })
      .filter((l: LandmarkLite) => !l.mapHidden)
  } catch {
    landmarks = []
  }
}

async function loadTrailPois() {
  try {
    const gj = await fetchJson<{ features?: any[] }>('/data/pois.json')
    trailPois = (gj.features || []).map((f: any, i: number) => {
      const [lon, lat] = f.geometry.coordinates
      const p = f.properties || {}
      return {
        id: `poi-${i}`,
        name: String(p.name || p.kind || 'Особенность'),
        lat,
        lon,
        kind: String(p.kind || 'other'),
      } satisfies TrailPoi
    })
  } catch {
    trailPois = []
  }
}

function itemsNearRoute<T extends LatLon & { id: string }>(items: T[], route: LatLon[], maxM: number): T[] {
  if (route.length < 2 || !items.length) return []
  const hit: Array<{ it: T; along: number }> = []
  let acc = 0
  const cum: number[] = [0]
  for (let i = 1; i < route.length; i++) {
    acc += haversineM(route[i - 1], route[i])
    cum.push(acc)
  }
  for (const it of items) {
    const idx = nearestIndex(route, it)
    if (haversineM(route[idx], it) > maxM) continue
    hit.push({ it, along: cum[idx] })
  }
  hit.sort((a, b) => a.along - b.along)
  const seen = new Set<string>()
  const out: T[] = []
  for (const h of hit) {
    if (seen.has(h.it.id)) continue
    seen.add(h.it.id)
    out.push(h.it)
  }
  return out
}

function interestingOnSegment(): LandmarkLite[] {
  return itemsNearRoute(
    landmarks.filter((l) => !l.listOnly && l.category !== 'alert' && l.category !== 'note'),
    state.segment,
    900,
  )
}

function featuresOnSegment(): TrailPoi[] {
  return itemsNearRoute(trailPois, state.segment, 280)
}

function poiKindLabel(kind: string): string {
  if (kind === 'toilet') return 'Туалет'
  if (kind === 'tunnel') return 'Туннель'
  return 'На тропе'
}

async function loadTrack(routeId: string): Promise<LatLon[]> {
  if (trackCache.has(routeId)) return trackCache.get(routeId)!
  if (routeId.startsWith('saved:')) {
    const id = routeId.slice('saved:'.length)
    const data = await apiJson<{ track: { geojson?: { geometry?: { coordinates: [number, number][] } }; title?: string; lengthM?: number } }>(
      `/api/tracks/${id}`,
    )
    const coords = data.track?.geojson?.geometry?.coordinates
    if (!coords?.length) throw new Error('Пустой сохранённый трек')
    const pts = coords.map(([lon, lat]) => ({ lat, lon }))
    trackCache.set(routeId, pts)
    savedMeta.set(routeId, {
      title: data.track.title || 'Мой трек',
      kmListed: Math.round(((data.track.lengthM || pathLengthM(pts)) / 1000) * 10) / 10,
    })
    return pts
  }
  const meta = state.catalog.find((r) => r.id === routeId)
  if (!meta) throw new Error('Трек не найден')
  const path = '/' + meta.geojson.replace(/^data\//, 'data/')
  const gj = await fetchJson<{ features: { geometry: { coordinates: [number, number][] } }[] }>(path)
  const pts = gj.features[0].geometry.coordinates.map(([lon, lat]) => ({ lat, lon }))
  trackCache.set(routeId, pts)
  return pts
}

async function loadSavedTracks() {
  try {
    const data = await apiJson<{ items: { id: string; title: string; lengthM: number }[] }>('/api/tracks')
    for (const it of data.items || []) {
      const rid = `saved:${it.id}`
      savedMeta.set(rid, {
        title: it.title || 'Мой трек',
        kmListed: Math.round((it.lengthM / 1000) * 10) / 10,
      })
    }
  } catch {
    /* guest empty / api down */
  }
}

async function loadSavedPlans() {
  try {
    const data = await apiJson<{ items: { id: string; title: string; lengthM: number }[] }>('/api/plans')
    savedPlansMeta.clear()
    for (const it of data.items || []) {
      savedPlansMeta.set(it.id, {
        planId: it.id,
        title: it.title || 'Маршрут',
        kmListed: Math.round((it.lengthM / 1000) * 10) / 10,
      })
    }
  } catch {
    /* empty */
  }
}

function downsamplePts(pts: LatLon[], maxN = 800): LatLon[] {
  if (pts.length <= maxN) return pts
  const step = Math.ceil(pts.length / maxN)
  const out: LatLon[] = []
  for (let i = 0; i < pts.length; i += step) out.push(pts[i])
  const last = pts[pts.length - 1]
  if (out.length && (out[out.length - 1].lat !== last.lat || out[out.length - 1].lon !== last.lon)) {
    out.push(last)
  }
  return out
}

function currentPlanPayload() {
  applyCustomIfAny()
  syncSegment()
  const lengthM = pathLengthM(state.segment)
  return {
    routeId: state.routeId,
    mode: state.mode,
    direction: state.direction,
    start: state.start,
    end: state.end,
    meters: state.meters,
    finishMode: state.finishMode,
    segment: state.segment,
    /** Полный трек (прореженный) — чтобы шаринг открывался без доступа к saved: */
    track: downsamplePts(state.track, 900),
    lengthM,
    title:
      (state.catalog.find((r) => r.id === state.routeId) || savedMeta.get(state.routeId))?.title ||
      'Маршрут',
  }
}

async function createSharePlan(): Promise<string> {
  const payload = currentPlanPayload()
  if (payload.segment.length < 2) throw new Error('Сначала соберите отрезок')
  const data = await apiJson<{ shareUrl: string; plan: { id: string } }>('/api/plans', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...apiHeaders() },
    body: JSON.stringify({ ...payload, save: Boolean(getAuthToken()) }),
  })
  lastShareUrl = data.shareUrl.startsWith('http')
    ? data.shareUrl
    : `${location.origin}${data.shareUrl.startsWith('/') ? '' : '/'}${data.shareUrl}`
  lastSavedPlanId = data.plan.id
  return lastShareUrl
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
}

function toast(msg: string) {
  const existing = document.getElementById('zm-toast')
  existing?.remove()
  const el = document.createElement('div')
  el.id = 'zm-toast'
  el.textContent = msg
  el.style.cssText =
    'position:fixed;left:50%;bottom:calc(18px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:10000;background:#1c1f1c;border:1px solid #2e332e;color:#f0f2f0;padding:10px 14px;border-radius:12px;font-size:0.86rem;max-width:90vw;box-shadow:0 8px 24px rgba(0,0,0,.35)'
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 2400)
}

function focusOnMap(p: LatLon, label?: string) {
  if (!map) return
  focusMarker?.remove()
  const el = document.createElement('div')
  el.style.cssText =
    'width:14px;height:14px;border-radius:50%;background:#e0a03a;border:2px solid #fff;box-shadow:0 0 0 3px rgba(224,160,58,.35)'
  focusMarker = new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map)
  if (label) {
    focusMarker.setPopup(new maplibregl.Popup({ offset: 12 }).setText(label))
    focusMarker.togglePopup()
  }
  map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 13.5), duration: 550 })
}

function ptsFromPayload(raw: unknown): LatLon[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((p: any) => {
      if (Array.isArray(p) && p.length >= 2) return { lat: Number(p[1]), lon: Number(p[0]) }
      return { lat: Number(p?.lat), lon: Number(p?.lon) }
    })
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
}

/** Открыть шаринг: сегмент обязателен; трек — из каталога / saved / payload.track / сегмент. */
async function applyPlanPayload(payload: any) {
  const routeId = String(payload.routeId || '')
  const seg = ptsFromPayload(payload.segment)
  const embeddedTrack = ptsFromPayload(payload.track)

  let loaded = false
  if (routeId && !routeId.startsWith('shared:')) {
    try {
      await hydrateTrackOnly(routeId)
      loaded = true
    } catch {
      loaded = false
    }
  }

  if (!loaded) {
    const fallback = embeddedTrack.length >= 2 ? embeddedTrack : seg
    state.routeId = routeId || 'shared:plan'
    officialTrack = []
    koptevoAlt = []
    state.useKoptevoAlt = false
    state.track = fallback
    state.points = []
  }

  const title = String(payload.title || '').trim()
  if (title) {
    const km =
      payload.lengthM != null
        ? Math.round((Number(payload.lengthM) / 1000) * 10) / 10
        : Math.round((pathLengthM(seg.length >= 2 ? seg : state.track) / 1000) * 10) / 10
    savedMeta.set(state.routeId, { title, kmListed: km })
  }

  if (payload.mode === 'bike' || payload.mode === 'walk') {
    state.mode = payload.mode
    document.querySelectorAll('.mode-seg [data-mode]').forEach((b) => {
      b.classList.toggle('active', (b as HTMLElement).dataset.mode === state.mode)
    })
  }
  if (payload.direction === 'cw' || payload.direction === 'ccw') state.direction = payload.direction
  if (payload.finishMode === 'length' || payload.finishMode === 'points') {
    state.finishMode = payload.finishMode
  }
  state.start = payload.start || null
  state.end = payload.end || null
  if (payload.meters != null) {
    state.meters = Number(payload.meters)
    state.lengthPicked = true
  }
  if (seg.length >= 2) {
    state.segment = seg
  } else {
    syncSegment()
  }
  paintMap()
}

async function promptRenameSavedTrack(trackId: string, currentTitle: string) {
  const next = window.prompt('Название трека', currentTitle || 'Мой трек')
  if (next == null) return
  const title = next.trim().slice(0, 120)
  if (!title || title === currentTitle) return
  try {
    await apiJson(`/api/tracks/${encodeURIComponent(trackId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...apiHeaders() },
      body: JSON.stringify({ title }),
    })
    const rid = `saved:${trackId}`
    const prev = savedMeta.get(rid)
    if (prev) savedMeta.set(rid, { ...prev, title })
    else savedMeta.set(rid, { title, kmListed: 0 })
    render()
  } catch {
    /* ignore rename errors — track already saved */
  }
}

async function uploadTrackFile(file: File) {
  const status = $('#upload-status')
  if (status) status.textContent = 'Загружаем и разбираем…'
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch('/api/tracks/upload', {
    method: 'POST',
    headers: apiHeaders(),
    body: fd,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`)
  const track = (data as { track: any }).track
  const rid = `saved:${track.id}`
  const coords = track.geojson?.geometry?.coordinates || []
  const pts = coords.map(([lon, lat]: [number, number]) => ({ lat, lon }))
  trackCache.set(rid, pts)
  savedMeta.set(rid, {
    title: track.title || file.name,
    kmListed: Math.round((track.lengthM / 1000) * 10) / 10,
  })
  await selectTrack(rid)
  if (status) {
    status.textContent = getAuthToken()
      ? 'Трек загружен и сохранён'
      : 'Трек загружен. Войдите, чтобы не потерять его.'
  }
  render()
  if (getAuthToken() && track?.id) {
    await promptRenameSavedTrack(String(track.id), String(track.title || file.name))
  }
}

function showAuthModal(opts?: { onSuccess?: () => void; title?: string }) {
  const existing = document.getElementById('auth-modal')
  existing?.remove()
  const wrap = document.createElement('div')
  wrap.id = 'auth-modal'
  wrap.className = 'auth-modal'
  wrap.innerHTML = `<div class="auth-card">
    <button type="button" class="modal-x" id="auth-close" aria-label="Закрыть">✕</button>
    <h3>${opts?.title || 'Вход'}</h3>
    <p class="lead tiny">Логин 3–32 (латиница/цифры), пароль от 8 символов с буквой и цифрой. Без почты и галочек.</p>
    <label class="field">Логин<input id="auth-login" autocomplete="username" /></label>
    <label class="field">Пароль<input id="auth-pass" type="password" autocomplete="current-password" /></label>
    <p class="field-status err" id="auth-err" hidden></p>
    <div class="nav-stack" style="margin-top:12px">
      <button type="button" class="btn" id="auth-login-btn">Войти</button>
      <button type="button" class="btn secondary" id="auth-reg-btn">Зарегистрироваться</button>
    </div>
  </div>`
  document.body.appendChild(wrap)
  const err = () => wrap.querySelector('#auth-err') as HTMLElement
  const close = () => wrap.remove()
  wrap.querySelector('#auth-close')?.addEventListener('click', close)
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) close()
  })
  const doAuth = async (mode: 'login' | 'register') => {
    const login = (wrap.querySelector('#auth-login') as HTMLInputElement).value.trim()
    const password = (wrap.querySelector('#auth-pass') as HTMLInputElement).value
    err().hidden = true
    try {
      const data = await apiJson<{ token: string }>(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiHeaders() },
        body: JSON.stringify({ login, password }),
      })
      localStorage.setItem(TOKEN_KEY, data.token)
      trackClient(mode === 'register' ? 'register' : 'login')
      try {
        ymSetUserId(login)
      } catch {
        /* */
      }
      await apiJson('/api/tracks/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiHeaders() },
        body: JSON.stringify({ guestToken: getGuestToken() }),
      }).catch(() => null)
      await Promise.all([loadSavedTracks(), loadSavedPlans()])
      close()
      render()
      const rid = state.routeId
      if (rid?.startsWith('saved:')) {
        const id = rid.slice('saved:'.length)
        const title = savedMeta.get(rid)?.title || 'Мой трек'
        await promptRenameSavedTrack(id, title)
      }
      opts?.onSuccess?.()
    } catch (e) {
      err().hidden = false
      err().textContent = e instanceof Error ? e.message : 'Ошибка'
    }
  }
  wrap.querySelector('#auth-login-btn')?.addEventListener('click', () => void doAuth('login'))
  wrap.querySelector('#auth-reg-btn')?.addEventListener('click', () => void doAuth('register'))
}

function showSavePlanModal() {
  const existing = document.getElementById('save-plan-modal')
  existing?.remove()
  const wrap = document.createElement('div')
  wrap.id = 'save-plan-modal'
  wrap.className = 'auth-modal'
  const suggested =
    (state.catalog.find((r) => r.id === state.routeId) || savedMeta.get(state.routeId))?.title ||
    'Мой маршрут'
  wrap.innerHTML = `<div class="auth-card">
    <button type="button" class="modal-x" id="save-close" aria-label="Закрыть">✕</button>
    <h3>Сохранить маршрут</h3>
    <p class="lead tiny">Потом откроете из «Мои маршруты».</p>
    <label class="field">Название<input id="save-title" value="${escapeAttr(suggested)}" maxlength="120" /></label>
    <p class="field-status err" id="save-err" hidden></p>
    <div class="nav-stack" style="margin-top:12px">
      <button type="button" class="btn" id="save-confirm">Сохранить</button>
    </div>
  </div>`
  document.body.appendChild(wrap)
  const close = () => wrap.remove()
  wrap.querySelector('#save-close')?.addEventListener('click', close)
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) close()
  })
  wrap.querySelector('#save-confirm')?.addEventListener('click', () => {
    void (async () => {
      const title = ((wrap.querySelector('#save-title') as HTMLInputElement).value || '').trim()
      const err = wrap.querySelector('#save-err') as HTMLElement
      err.hidden = true
      if (!title) {
        err.hidden = false
        err.textContent = 'Введите название'
        return
      }
      try {
        const payload = currentPlanPayload()
        const data = await apiJson<{ plan: { id: string }; shareUrl: string }>('/api/plans', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...apiHeaders() },
          body: JSON.stringify({ ...payload, title, save: true }),
        })
        lastSavedPlanId = data.plan.id
        lastShareUrl = data.shareUrl.startsWith('http')
          ? data.shareUrl
          : `${location.origin}/?p=${data.plan.id}`
        await loadSavedPlans()
        close()
        toast('Маршрут сохранён')
        render()
      } catch (e) {
        err.hidden = false
        err.textContent = e instanceof Error ? e.message : 'Не удалось сохранить'
      }
    })()
  })
}

function requestSavePlan() {
  if (!getAuthToken()) {
    showAuthModal({
      title: 'Войдите, чтобы сохранить',
      onSuccess: () => showSavePlanModal(),
    })
    return
  }
  showSavePlanModal()
}

async function shareCurrentPlan() {
  try {
    const url = lastShareUrl || (await createSharePlan())
    await copyText(url)
    toast('Ссылка скопирована')
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Не удалось поделиться')
  }
}

function listPointsOnTrack(track: LatLon[]): PointOpt[] {
  const pool = landmarks.filter(
    (lm) => !lm.listOnly && lm.category !== 'alert' && lm.category !== 'note',
  )
  const snapped = pool
    .map((lm) => {
      const idx = nearestIndex(track, lm)
      const on = track[idx]
      return { id: lm.id, name: lm.name, lat: on.lat, lon: on.lon, idx, off: haversineM(lm, on) }
    })
    .filter((p) => p.off <= 1500)
    .sort((a, b) => a.idx - b.idx)
  if (snapped.length >= 4) {
    return snapped.map(({ id, name, lat, lon, idx }) => ({ id, name, lat, lon, idx }))
  }
  const out: PointOpt[] = []
  let acc = 0
  let n = 0
  out.push({ id: 'km0', name: 'Начало линии', lat: track[0].lat, lon: track[0].lon, idx: 0 })
  for (let i = 1; i < track.length; i++) {
    acc += haversineM(track[i - 1], track[i])
    if (acc >= (n + 1) * 5000) {
      n++
      out.push({
        id: `km${n}`,
        name: `Отметка ${n * 5} км`,
        lat: track[i].lat,
        lon: track[i].lon,
        idx: i,
      })
    }
  }
  return out
}

function snapToTrack(p: LatLon, name?: string): PointOpt {
  const idx = nearestIndex(state.track, p)
  const on = state.track[idx]
  return {
    id: `snap-${idx}-${Date.now()}`,
    name: name || 'Точка на линии',
    lat: on.lat,
    lon: on.lon,
    idx,
  }
}

function snapRailStationToTrack(
  station: { id: string; lat: number; lon: number },
  name: string,
): PointOpt {
  const p = snapToTrack({ lat: station.lat, lon: station.lon }, name)
  return {
    ...p,
    id: station.id,
    stationLat: station.lat,
    stationLon: station.lon,
  }
}

function shortRailName(label: string): string {
  const i = label.indexOf('·')
  return (i >= 0 ? label.slice(i + 1) : label).trim() || label
}

function fitRailStationAndSnap(station: LatLon, snap: LatLon) {
  if (!map) return
  const bounds = new maplibregl.LngLatBounds(
    [Math.min(station.lon, snap.lon), Math.min(station.lat, snap.lat)],
    [Math.max(station.lon, snap.lon), Math.max(station.lat, snap.lat)],
  )
  map.fitBounds(bounds, { padding: 72, maxZoom: 13.8, duration: 500 })
}

function pushStationEndpoint(ends: SvgEndpoint[], p: PointOpt | null) {
  if (!p || p.stationLat == null || p.stationLon == null) return
  ends.push({
    lat: p.stationLat,
    lon: p.stationLon,
    label: shortRailName(p.name || 'Станция'),
    kind: 'station',
    linkTo: { lat: p.lat, lon: p.lon },
  })
}

async function applyMapRailPick(opts: {
  kind: 'mck' | 'mcd'
  name: string
  lat: number
  lon: number
  linesLabel?: string
}) {
  if (state.track.length < 2) {
    toast('Сначала выберите трек')
    return
  }
  await ensureRailStationsLoaded()
  const list =
    opts.kind === 'mck'
      ? filterRailStationsForRoute(mckStationsCache)
      : filterRailStationsForRoute(mcdStationsCache)
  const hit =
    list.find(
      (s) =>
        s.name === opts.name ||
        (Math.abs(s.lat - opts.lat) < 1e-4 && Math.abs(s.lon - opts.lon) < 1e-4),
    ) || null
  const id = hit?.id || `${opts.kind}-${opts.lat.toFixed(4)}-${opts.lon.toFixed(4)}`
  const label =
    opts.kind === 'mck'
      ? `МЦК · ${opts.name}`
      : `${opts.linesLabel || 'МЦД'} · ${opts.name}`
  applyRailSelection({ id, lat: opts.lat, lon: opts.lon }, label, state.step === 'finish' ? 'end' : 'start')
}

function applyRailSelection(
  station: { id: string; lat: number; lon: number },
  label: string,
  which: 'start' | 'end',
) {
  if (state.track.length < 2) {
    toast('Сначала выберите трек')
    return
  }
  const snapped = snapRailStationToTrack(station, label)
  const toLineM = haversineM(
    { lat: station.lat, lon: station.lon },
    { lat: snapped.lat, lon: snapped.lon },
  )
  // выбор станции не должен конкурировать с синей точкой гео
  state.pendingGeo = null
  state.geoConfirmFor = null
  setGeoMarker(null)

  if (which === 'start') {
    state.start = snapped
    state.end = null
    state.segment = []
    state.pickMode = null
    state.geoStatus = `Старт на линии у «${label}»${toLineM >= 40 ? ` · ≈ ${formatKm(toLineM)} от станции` : ''}`
    document.getElementById('map')?.classList.remove('picking')
    paintMap()
    fitRailStationAndSnap(station, snapped)
    toast(`Старт на зелёной линии · ${label}`)
    render()
    return
  }
  state.end = snapped
  state.finishMode = 'points'
  state.lengthPicked = false
  state.meters = null
  state.customRaw = ''
  state.pickMode = null
  state.geoStatus = `Финиш на линии у «${label}»${toLineM >= 40 ? ` · ≈ ${formatKm(toLineM)} от станции` : ''}`
  document.getElementById('map')?.classList.remove('picking')
  syncSegment()
  fitRailStationAndSnap(station, snapped)
  toast(`Финиш на зелёной линии · ${label}`)
  render()
}

function closeRailPicker() {
  document.getElementById('rail-picker-modal')?.remove()
}

async function showRailPicker(which: 'start' | 'end') {
  if (!showMckOnMap()) {
    toast('МЦК/МЦД — для маршрутов Москвы')
    return
  }
  if (state.track.length < 2) {
    toast('Сначала выберите трек')
    return
  }
  if (which === 'end' && !state.start) {
    toast('Сначала выберите старт')
    return
  }
  closeRailPicker()
  await ensureRailStationsLoaded()

  const geoHint =
    which === 'start'
      ? 'Список по алфавиту · поиск по названию'
      : isGreenRingRoute()
        ? 'По возрастанию длины вдоль Зелёного кольца от старта'
        : 'По возрастанию длины вдоль маршрута от старта'

  let tab: 'mck' | 'mcd' = 'mcd'
  let query = ''
  const lineFilters = new Set<string>() // пусто = все линии МЦД
  /** Финиш: пусто = оба направления (берём более короткий путь); иначе только выбранные */
  const dirFilters = new Set<Dir>()
  const wrap = document.createElement('div')
  wrap.id = 'rail-picker-modal'
  wrap.className = 'auth-modal'
  wrap.innerHTML = `<div class="auth-card auth-card-wide">
    <button type="button" class="modal-x" id="rail-close" aria-label="Закрыть">✕</button>
    <h3>${which === 'start' ? 'Старт от МЦК/МЦД' : 'Финиш от МЦК/МЦД'}</h3>
    <p class="lead tiny" id="rail-hint">${escapeHtml(geoHint)}</p>
    <div class="rail-tabs">
      <button type="button" class="rail-tab" data-rail-tab="mck">МЦК</button>
      <button type="button" class="rail-tab on" data-rail-tab="mcd">МЦД</button>
    </div>
    <div class="rail-search-wrap">
      <input type="search" id="rail-search" class="rail-search" placeholder="Название станции" autocomplete="off" enterkeyhint="search" />
      <button type="button" class="rail-search-clear" id="rail-search-clear" hidden aria-label="Очистить">✕</button>
    </div>
    <div class="rail-line-filters ${which === 'end' ? 'rail-filters-finish' : ''}" id="rail-line-filters"></div>
    <div class="mck-pick-list" id="rail-list"></div>
  </div>`
  document.body.appendChild(wrap)

  const nameMatches = (name: string, q: string) => {
    const nq = q.trim().toLowerCase()
    if (!nq) return true
    return name.toLowerCase().includes(nq)
  }

  const dirArrow = (d: Dir) => (d === 'cw' ? '↻' : '↺')
  const dirLabel = (d: Dir) => (d === 'cw' ? 'по часовой' : 'против часовой')
  const alongLabel = () => (isGreenRingRoute() ? 'по кольцу' : 'вдоль маршрута')

  const pickStationDir = (station: LatLon): { ringM: number; dir: Dir } => {
    const ccw = ringDistanceAlongTrack(state.track, 'ccw', state.start!, station)
    const cw = ringDistanceAlongTrack(state.track, 'cw', state.start!, station)
    const allowCcw = !dirFilters.size || dirFilters.has('ccw')
    const allowCw = !dirFilters.size || dirFilters.has('cw')
    if (allowCcw && allowCw) {
      return ccw <= cw ? { ringM: ccw, dir: 'ccw' } : { ringM: cw, dir: 'cw' }
    }
    if (allowCw) return { ringM: cw, dir: 'cw' }
    return { ringM: ccw, dir: 'ccw' }
  }

  const finishSub = (ringM: number, dir: Dir, disabled: boolean) => {
    if (disabled) return 'это старт'
    return `${alongLabel()} ≈ ${formatRailDist(ringM)} · ${dirArrow(dir)} ${dirLabel(dir)}`
  }

  const syncFiltersUi = () => {
    const host = wrap.querySelector('#rail-line-filters') as HTMLElement
    const parts: string[] = []

    if (tab === 'mcd') {
      const lines = [
        { id: 'D1', color: '#F6A600' },
        { id: 'D2', color: '#E74280' },
        { id: 'D3', color: '#E95B0C' },
        { id: 'D4', color: '#40B280' },
      ]
      for (const L of lines) {
        parts.push(
          `<button type="button" class="rail-line-chip ${lineFilters.has(L.id) ? 'on' : ''}" data-line="${L.id}" style="--line:${L.color}">${L.id}</button>`,
        )
      }
    }

    if (which === 'end') {
      if (tab === 'mcd') {
        // только стрелки — место рядом с D1–D4
        parts.push(
          `<button type="button" class="rail-dir-chip icon-only ${dirFilters.has('cw') ? 'on' : ''}" data-dir-filter="cw" aria-label="По часовой" title="По часовой">↻</button>`,
          `<button type="button" class="rail-dir-chip icon-only ${dirFilters.has('ccw') ? 'on' : ''}" data-dir-filter="ccw" aria-label="Против часовой" title="Против часовой">↺</button>`,
        )
      } else {
        // МЦК: с подписью, одна строка
        parts.push(
          `<button type="button" class="rail-dir-chip with-label ${dirFilters.has('cw') ? 'on' : ''}" data-dir-filter="cw">↻ По часовой</button>`,
          `<button type="button" class="rail-dir-chip with-label ${dirFilters.has('ccw') ? 'on' : ''}" data-dir-filter="ccw">↺ Против часовой</button>`,
        )
      }
    }

    if (!parts.length) {
      host.hidden = true
      host.innerHTML = ''
      return
    }
    host.hidden = false
    host.innerHTML = parts.join('')

    host.querySelectorAll('[data-line]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = (btn as HTMLElement).dataset.line!
        if (lineFilters.has(id)) lineFilters.delete(id)
        else lineFilters.add(id)
        syncFiltersUi()
        renderList()
      })
    })
    host.querySelectorAll('[data-dir-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const d = (btn as HTMLElement).dataset.dirFilter as Dir
        if (dirFilters.has(d)) dirFilters.delete(d)
        else dirFilters.add(d)
        syncFiltersUi()
        renderList()
      })
    })
  }

  const syncSearchClear = () => {
    const clearBtn = wrap.querySelector('#rail-search-clear') as HTMLButtonElement
    clearBtn.hidden = !query.trim()
  }

  const renderList = () => {
    const listEl = wrap.querySelector('#rail-list') as HTMLElement
    const startId = state.start?.id || ''
    type Row = {
      id: string
      name: string
      lat: number
      lon: number
      label: string
      badge: string
      color: string
      sub: string
      disabled: boolean
      pickDir?: Dir
    }
    let rows: Row[] = []
    if (tab === 'mck') {
      const stations = filterRailStationsForRoute(mckStationsCache)
      if (which === 'start') {
        const ranked = stationsAlpha(stations).filter((s) => nameMatches(s.name, query))
        rows = ranked.map((s) => ({
          id: s.id,
          name: s.name,
          lat: s.lat,
          lon: s.lon,
          label: `МЦК · ${s.name}`,
          badge: 'МЦК',
          color: '#de64a1',
          sub: '',
          disabled: false,
        }))
      } else {
        const ranked = stations
          .map((s) => {
            const { ringM, dir } = pickStationDir(s)
            return { ...s, ringM, dir }
          })
          .sort((a, b) => a.ringM - b.ringM)
          .filter((s) => nameMatches(s.name, query))
        rows = ranked.map((s) => {
          const disabled = s.id === startId
          return {
            id: s.id,
            name: s.name,
            lat: s.lat,
            lon: s.lon,
            label: `МЦК · ${s.name}`,
            badge: 'МЦК',
            color: '#de64a1',
            sub: finishSub(s.ringM, s.dir, disabled),
            disabled,
            pickDir: s.dir,
          }
        })
      }
    } else {
      let stations = filterRailStationsForRoute(mcdStationsCache)
      if (lineFilters.size) {
        stations = stations.filter((s) => (s.lines || []).some((L) => lineFilters.has(L)))
      }
      if (which === 'start') {
        const ranked = stationsAlpha(stations).filter((s) => nameMatches(s.name, query))
        rows = ranked.map((s) => ({
          id: s.id,
          name: s.name,
          lat: s.lat,
          lon: s.lon,
          label: `${mcdLinesLabel(s)} · ${s.name}`,
          badge: mcdLinesLabel(s),
          color: s.color || '#40B280',
          sub: '',
          disabled: false,
        }))
      } else {
        const ranked = stations
          .map((s) => {
            const { ringM, dir } = pickStationDir(s)
            return { ...s, ringM, dir }
          })
          .sort((a, b) => a.ringM - b.ringM)
          .filter((s) => nameMatches(s.name, query))
        rows = ranked.map((s) => {
          const disabled = s.id === startId
          return {
            id: s.id,
            name: s.name,
            lat: s.lat,
            lon: s.lon,
            label: `${mcdLinesLabel(s)} · ${s.name}`,
            badge: mcdLinesLabel(s),
            color: s.color || '#40B280',
            sub: finishSub(s.ringM, s.dir, disabled),
            disabled,
            pickDir: s.dir,
          }
        })
      }
    }

    listEl.innerHTML = rows.length
      ? rows
          .map(
            (r, i) => `<button type="button" class="mck-pick-btn ${r.disabled ? 'is-disabled' : ''}" data-rail-idx="${i}" ${
              r.disabled ? 'disabled' : ''
            }>
          <span class="t"><span class="rail-badge" style="background:${r.color}">${escapeHtml(r.badge)}</span> ${escapeHtml(r.name)}</span>
          ${r.sub ? `<span class="s">${escapeHtml(r.sub)}</span>` : ''}
        </button>`,
          )
          .join('')
      : `<div class="empty" style="padding:16px 8px">Ничего не нашлось</div>`

    listEl.querySelectorAll('[data-rail-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number((btn as HTMLElement).dataset.railIdx)
        const row = rows[idx]
        if (!row || row.disabled) return
        if (which === 'end' && row.pickDir) state.direction = row.pickDir
        closeRailPicker()
        applyRailSelection(
          { id: row.id, lat: row.lat, lon: row.lon },
          row.label,
          which,
        )
      })
    })
  }

  wrap.querySelector('#rail-close')?.addEventListener('click', closeRailPicker)
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) closeRailPicker()
  })
  wrap.querySelectorAll('[data-rail-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      tab = (btn as HTMLElement).dataset.railTab === 'mck' ? 'mck' : 'mcd'
      wrap.querySelectorAll('[data-rail-tab]').forEach((b) => {
        b.classList.toggle('on', (b as HTMLElement).dataset.railTab === tab)
      })
      syncFiltersUi()
      renderList()
    })
  })
  const searchInput = wrap.querySelector('#rail-search') as HTMLInputElement
  searchInput.addEventListener('input', () => {
    query = searchInput.value
    syncSearchClear()
    renderList()
  })
  wrap.querySelector('#rail-search-clear')?.addEventListener('click', () => {
    query = ''
    searchInput.value = ''
    syncSearchClear()
    searchInput.focus()
    renderList()
  })
  syncFiltersUi()
  syncSearchClear()
  renderList()
  requestAnimationFrame(() => searchInput.focus())
}

function buildSegment(): LatLon[] {
  if (!state.start || !state.track.length) return []
  const oriented = orientRing(state.track, state.direction === 'ccw')
  const startIdx = nearestIndex(oriented, state.start)
  const fromStart = rotateToStart(oriented, startIdx)
  if (state.end && (state.finishMode === 'points' || !state.lengthPicked)) {
    const endIdx = nearestIndex(fromStart, state.end)
    if (endIdx <= 0) return [fromStart[0]]
    return fromStart.slice(0, endIdx + 1)
  }
  if (state.finishMode === 'length' && state.lengthPicked && state.meters != null) {
    return takeDistance(fromStart, state.meters)
  }
  return []
}

function syncSegment() {
  state.segment = buildSegment()
  paintMap()
}

function setGeoMarker(pt: LatLon | null) {
  // MapLibre Marker уходит под SVG-оверлей линии — рисуем в SVG.
  geoMarker?.remove()
  geoMarker = null
  svgRoutes?.setPendingGeo(pt)
}

function acceptPendingGeoAsStart() {
  const geo = state.pendingGeo
  if (!geo) return
  if (state.track.length < 2) return
  state.userGeo = geo
  const snapped = snapToTrack(geo, 'Ближайшая к геопозиции')
  state.start = snapped
  state.end = null
  state.segment = []
  state.pendingGeo = null
  state.geoConfirmFor = null
  state.geoStatus = `Старт: ${snapped.name}`
  setGeoMarker(null)
  paintMap()
  map?.flyTo({ center: [snapped.lon, snapped.lat], zoom: 13, duration: 500 })
  render()
}

function rejectPendingGeo() {
  state.pendingGeo = null
  state.geoConfirmFor = null
  setGeoMarker(null)
  state.geoStatus = 'Укажите адрес вручную'
  render()
  requestAnimationFrame(() => {
    const input = document.getElementById('addr-input') as HTMLInputElement | null
    input?.focus()
  })
}

function setPickMode(mode: PickMode) {
  state.pickMode = mode
  const host = document.getElementById('map')
  host?.classList.toggle('picking', Boolean(mode))
  if (mode) setTopSub(mode === 'start' ? 'Ткните зелёную линию — старт' : 'Ткните зелёную линию — финиш')
  render()
}

function onMapClick(e: maplibregl.MapMouseEvent) {
  if (!state.pickMode || !state.track.length) return
  const raw = { lat: e.lngLat.lat, lon: e.lngLat.lng }
  const snapped = snapToTrack(raw, state.pickMode === 'start' ? 'Старт на линии' : 'Финиш на линии')
  if (state.pickMode === 'start') {
    state.start = snapped
    state.end = null
    state.segment = []
    state.pickMode = null
    document.getElementById('map')?.classList.remove('picking')
    paintMap()
    map?.flyTo({ center: [snapped.lon, snapped.lat], zoom: 13, duration: 450 })
    setTopSub('Старт выбран')
    render()
    return
  }
  state.end = snapped
  state.finishMode = 'points'
  state.lengthPicked = false
  state.meters = null
  state.customRaw = ''
  state.pickMode = null
  document.getElementById('map')?.classList.remove('picking')
  syncSegment()
  setTopSub('Финиш выбран')
  render()
}

async function geocodePhoton(q: string) {
  const query = q.trim()
  if (query.length < 3) return []
  const coord = query.match(/^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/)
  if (coord) {
    let lat = Number(coord[1])
    let lon = Number(coord[2])
    if (lat > 30 && lat < 50 && lon > 50 && lon < 70) [lat, lon] = [lon, lat]
    return [{ lat, lon, label: `${lat.toFixed(5)}, ${lon.toFixed(5)}` }]
  }

  // Photon: lang=ru даёт HTTP 400 (supported: default, de, en, fr).
  const photonUrl = new URL('https://photon.komoot.io/api/')
  photonUrl.searchParams.set('q', /москв|област/i.test(query) ? query : `${query}, Москва`)
  photonUrl.searchParams.set('limit', '6')
  photonUrl.searchParams.set('lat', '55.75')
  photonUrl.searchParams.set('lon', '37.62')

  try {
    const res = await fetch(photonUrl.toString())
    if (res.ok) {
      const data = await res.json()
      const hits = (data.features || [])
        .map((f: any) => {
          const [lon, lat] = f.geometry.coordinates
          const p = f.properties || {}
          const label = [p.name || p.street, p.housenumber, p.district, p.city || p.county]
            .filter(Boolean)
            .slice(0, 4)
            .join(', ')
          return { lat, lon, label: label || query }
        })
        .filter((x: any) => x.lat > 54.5 && x.lat < 57 && x.lon > 35 && x.lon < 40)
      if (hits.length) return hits
    }
  } catch {
    /* Nominatim fallback */
  }

  const nom = new URL('https://nominatim.openstreetmap.org/search')
  nom.searchParams.set('q', /москв/i.test(query) ? query : `${query}, Москва`)
  nom.searchParams.set('format', 'json')
  nom.searchParams.set('limit', '6')
  nom.searchParams.set('countrycodes', 'ru')
  const res2 = await fetch(nom.toString(), {
    headers: { Accept: 'application/json', 'User-Agent': 'GreenRoute/1.0 (green-route.ru)' },
  })
  if (!res2.ok) return []
  const data2 = await res2.json()
  return (data2 || [])
    .map((f: any) => ({
      lat: Number(f.lat),
      lon: Number(f.lon),
      label: String(f.display_name || query).split(',').slice(0, 3).join(','),
    }))
    .filter((x: any) => x.lat > 54.5 && x.lat < 57 && x.lon > 35 && x.lon < 40)
}

/** Парсит «40 мин», «3ч», «5,5 часов», «1.5», «90» → минуты. */
function parseDurationToMinutes(rawIn: string): number | null {
  const raw = rawIn
    .trim()
    .toLowerCase()
    .replace(/,/g, '.')
    .replace(/[：﹕]/g, ':')
    .replace(/\s+/g, ' ')
  if (!raw) return null

  // 5ч30м / 5:30 / 5.5ч
  const hm = raw.match(
    /^(\d+(?:\.\d+)?)\s*(?:ч|час(?:а|ов)?|h)\s*(?:и\s*)?(\d+(?:\.\d+)?)\s*(?:м|мин(?:ут[аы]?)?|min)?$/i,
  )
  if (hm) {
    const h = Number(hm[1])
    const m = Number(hm[2])
    if (Number.isFinite(h) && Number.isFinite(m) && h >= 0 && m >= 0) return h * 60 + m
  }
  // 2 30 / 2ч 30 без «м»
  const spaced = raw.match(/^(\d+)\s*(?:ч|час(?:а|ов)?|h)?\s+(\d{1,2})$/)
  if (spaced) {
    const h = Number(spaced[1])
    const m = Number(spaced[2])
    if (Number.isFinite(h) && Number.isFinite(m) && m < 60) return h * 60 + m
  }
  const colon = raw.match(/^(\d+)\s*[:\.]\s*(\d{1,2})$/)
  if (colon) {
    const h = Number(colon[1])
    const m = Number(colon[2])
    if (Number.isFinite(h) && Number.isFinite(m) && m < 60) return h * 60 + m
  }

  const hoursOnly = raw.match(/^(\d+(?:\.\d+)?)\s*(?:ч|час(?:а|ов)?|h)$/)
  if (hoursOnly) {
    const h = Number(hoursOnly[1])
    return Number.isFinite(h) && h > 0 ? h * 60 : null
  }
  const minsOnly = raw.match(/^(\d+(?:\.\d+)?)\s*(?:м|мин(?:ут[аы]?)?|min)$/)
  if (minsOnly) {
    const m = Number(minsOnly[1])
    return Number.isFinite(m) && m > 0 ? m : null
  }

  // «40 минут», «5 часов» с пробелом уже покрыты; «полтора часа»
  if (/^(полтора|1\.5)\s*(час|часа|ч)?$/.test(raw)) return 90

  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  // чистое число: ≤12 → часы, иначе минуты (как раньше)
  return n <= 12 ? n * 60 : n
}

function parseCustomMeters(): number | null {
  const raw = state.customRaw.trim()
  if (!raw) return null
  if (state.units === 'time') {
    const mins = parseDurationToMinutes(raw)
    if (mins == null || mins <= 0) return null
    return metersFromMinutes(mins, state.mode)
  }
  const n = Number(raw.replace(',', '.').replace(/[^\d.]/g, ''))
  if (!Number.isFinite(n) || n <= 0) return null
  return n * 1000
}

function applyCustomIfAny() {
  const m = parseCustomMeters()
  if (m != null) {
    state.meters = m
    return true
  }
  return false
}

/** Можно ли жать «Продолжить» на шаге Финиш. */
function canGoFinish(): boolean {
  if (state.finishMode === 'points') return Boolean(state.end)
  if (state.end) return true
  if (state.customRaw.trim()) return parseCustomMeters() != null
  return Boolean(state.lengthPicked && state.meters != null)
}

function syncFinishContinueBtn() {
  const btn = document.getElementById('btn-to-confirm') as HTMLButtonElement | null
  if (!btn || state.step !== 'finish') return
  btn.disabled = !canGoFinish()
}

function initMap() {
  const host = document.getElementById('map')
  if (!host) throw new Error('#map missing')
  map = new maplibregl.Map({
    container: host,
    style: {
      version: 8,
      sources: {
        basemap: {
          type: 'raster',
          tiles: [
            'https://a.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}@2x.png',
            'https://b.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}@2x.png',
            'https://c.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}@2x.png',
          ],
          tileSize: 256,
          attribution: '© OpenStreetMap · © CARTO',
          maxzoom: 20,
        },
      },
      layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
    },
    center: [37.62, 55.75],
    zoom: 10,
    attributionControl: { compact: true },
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
  })
  map.touchZoomRotate.disableRotation()
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
  // iOS Safari: pinch на странице → масштабирует весь документ; гасим жест вне карты
  const blockPagePinch = (e: Event) => {
    e.preventDefault()
  }
  document.addEventListener('gesturestart', blockPagePinch, { passive: false })
  document.addEventListener('gesturechange', blockPagePinch, { passive: false })
  document.addEventListener('gestureend', blockPagePinch, { passive: false })
  document.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length < 2) return
      const t = e.target as Node | null
      if (t && host.contains(t)) return
      e.preventDefault()
    },
    { passive: false },
  )
  svgRoutes = wireSvgRoutes(map, host)
  svgRoutes.onMckClick((dot) => {
    const name = dot.name || 'станция'
    if (state.step === 'start' || state.step === 'finish') {
      void applyMapRailPick({ kind: 'mck', name, lat: dot.lat, lon: dot.lon })
      return
    }
    toast(`МЦК · ${name}`)
    // если уже выбран старт маршрута — сразу предложить доехать от этой МЦК
    if (state.start && state.step === 'maps') {
      window.open(
        yandexApproachUrl(
          { lat: dot.lat, lon: dot.lon },
          { lat: state.start.lat, lon: state.start.lon },
        ),
        '_blank',
        'noopener',
      )
    }
  })
  svgRoutes.onMcdClick((dot) => {
    const name = dot.name || 'станция'
    const lines = (dot.linesLabel || 'МЦД').trim()
    if (state.step === 'start' || state.step === 'finish') {
      void applyMapRailPick({ kind: 'mcd', name, lat: dot.lat, lon: dot.lon, linesLabel: lines })
      return
    }
    toast(`${lines} · ${name}`)
  })
  if (!mapClickBound) {
    map.on('click', onMapClick)
    mapClickBound = true
  }
  const w = window as unknown as { __zmMap: maplibregl.Map; __zmState: typeof state }
  w.__zmMap = map
  w.__zmState = state
  map.on('load', () => {
    map?.resize()
    paintMap()
    void ensureRailStationsLoaded()
  })
  // станции подгружаем сразу, чтобы точки были с первого кадра
  void ensureRailStationsLoaded()
}

function fitTo(pts: LatLon[], pad = 48) {
  if (!map || pts.length < 2) return
  const b = new maplibregl.LngLatBounds([pts[0].lon, pts[0].lat], [pts[0].lon, pts[0].lat])
  for (const p of pts) b.extend([p.lon, p.lat])
  map.fitBounds(b, { padding: pad, maxZoom: 14, duration: 550 })
}

function markerEl(kind: 'start' | 'end') {
  const el = document.createElement('div')
  el.style.cssText =
    'width:18px;height:18px;border-radius:50%;border:2.5px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);'
  el.style.background = kind === 'start' ? '#3d9a55' : '#e05555'
  return el
}

function setMarkers(_start: LatLon | null, _end: LatLon | null) {
  // Маркеры рисуем в SVG поверх линии — MapLibre Marker уходит под оверлей.
  startMarker?.remove()
  endMarker?.remove()
  startMarker = endMarker = null
}

function nearestTrackIndex(track: LatLon[], p: LatLon): number {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < track.length; i++) {
    const d = haversineM(track[i], p)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/** Вшить крюк Коптево в официальный трек между ближайшими концами. */
function spliceKoptevoAlt(base: LatLon[], hook: LatLon[]): LatLon[] {
  if (base.length < 2 || hook.length < 2) return base.slice()
  let i0 = nearestTrackIndex(base, hook[0])
  let i1 = nearestTrackIndex(base, hook[hook.length - 1])
  let use = hook
  if (i0 > i1) {
    const t = i0
    i0 = i1
    i1 = t
    use = hook.slice().reverse()
  }
  if (i1 - i0 < 1) return base.slice()
  return base.slice(0, i0).concat(use, base.slice(i1 + 1))
}

function applyOfficialOrAltTrack() {
  if (officialTrack.length < 2) return
  state.track =
    state.useKoptevoAlt && koptevoAlt.length >= 2
      ? spliceKoptevoAlt(officialTrack, koptevoAlt)
      : officialTrack.slice()
  state.points = listPointsOnTrack(state.track)
  if (state.start) state.start = snapToTrack(state.start, state.start.name)
  if (state.end) state.end = snapToTrack(state.end, state.end.name)
  syncSegment()
}

function toggleKoptevoAlt() {
  if (koptevoAlt.length < 2 || officialTrack.length < 2) return
  state.useKoptevoAlt = !state.useKoptevoAlt
  applyOfficialOrAltTrack()
  paintMap()
  render()
  toast(
    state.useKoptevoAlt
      ? 'Альтернатива: крюк к МЦК Коптево включён'
      : 'Официальное Зелёное кольцо (без Коптево)',
  )
  schedulePersist()
}

async function loadKoptevoAlternative() {
  koptevoAlt = []
  koptevoAltKm = 0
  if (state.routeId !== 'zkm-ring') return
  try {
    const gj = await fetchJson<{
      features?: Array<{ geometry?: { coordinates?: number[][] }; properties?: Record<string, unknown> }>
    }>('/data/alternatives/koptevo-hook.geojson')
    const coords = gj.features?.[0]?.geometry?.coordinates || []
    koptevoAlt = coords
      .map(([lon, lat]) => ({ lat: Number(lat), lon: Number(lon) }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
    koptevoAltKm = Number(gj.features?.[0]?.properties?.km) || pathLengthM(koptevoAlt) / 1000
  } catch (e) {
    console.warn('[site] koptevo alt', e)
  }
}

function paintMap() {
  if (!map || !svgRoutes) {
    updateLegend()
    return
  }
  const hasSeg = state.segment.length >= 2
  const routes: SvgRouteDraw[] = []
  if (state.track.length >= 2) {
    routes.push({
      pts: state.track,
      color: hasSeg ? 'rgba(61,154,85,0.4)' : '#1f8f4a',
      width: hasSeg ? 5 : 7,
      id: 'main',
    })
  }
  // Крюк Коптево: пунктир = альтернатива; тап вкл/выкл. Когда вкл — пунктир на официальном спрямлении.
  if (koptevoAlt.length >= 2) {
    if (!state.useKoptevoAlt) {
      routes.push({
        pts: koptevoAlt,
        color: '#c4782a',
        width: 5,
        dash: true,
        id: 'koptevo-hook',
        onClick: () => toggleKoptevoAlt(),
      })
    } else if (officialTrack.length >= 2) {
      let i0 = nearestTrackIndex(officialTrack, koptevoAlt[0])
      let i1 = nearestTrackIndex(officialTrack, koptevoAlt[koptevoAlt.length - 1])
      if (i0 > i1) {
        const t = i0
        i0 = i1
        i1 = t
      }
      if (i1 - i0 >= 2) {
        routes.push({
          pts: officialTrack.slice(i0, i1 + 1),
          color: '#6b8f7a',
          width: 4,
          dash: true,
          id: 'koptevo-official-bypass',
          onClick: () => toggleKoptevoAlt(),
        })
      }
    }
  }
  if (hasSeg) routes.push({ pts: state.segment, color: '#1f8f4a', width: 8, id: 'segment' })

  const ends: SvgEndpoint[] = []
  if (hasSeg) {
    ends.push({
      lat: state.segment[0].lat,
      lon: state.segment[0].lon,
      label: state.start?.name || 'Старт',
      kind: 'start',
    })
    const last = state.segment[state.segment.length - 1]
    ends.push({
      lat: last.lat,
      lon: last.lon,
      label: state.end?.name || 'Финиш',
      kind: 'end',
    })
  } else {
    if (state.start) {
      ends.push({
        lat: state.start.lat,
        lon: state.start.lon,
        label: state.start.name || 'Старт',
        kind: 'start',
      })
    }
    if (state.end) {
      ends.push({
        lat: state.end.lat,
        lon: state.end.lon,
        label: state.end.name || 'Финиш',
        kind: 'end',
      })
    }
  }
  // Станция МЦК/МЦД + пунктир до snap на линии
  if (state.step === 'finish' && state.end?.stationLat != null) pushStationEndpoint(ends, state.end)
  else pushStationEndpoint(ends, state.start)
  if (state.step === 'finish' && state.start?.stationLat != null && state.end?.stationLat == null) {
    // на финише без своей станции оставить видимым старт-станцию не нужно
  }

  svgRoutes.setRoutes(routes, ends)
  applyMckDotsToSvg()
  applyMcdDotsToSvg()
  setMarkers(null, null)
  const railFocus =
    state.step === 'finish' && state.end?.stationLat != null
      ? state.end
      : state.start?.stationLat != null
        ? state.start
        : null
  if (railFocus?.stationLat != null && railFocus.stationLon != null) {
    // камеру для пары станция↔линия задаёт applyRailSelection; тут не сбивать fit всего трека
  } else if (hasSeg) fitTo(state.segment, 56)
  else if (state.step === 'finish' && state.track.length >= 2) fitTo(state.track, 48)
  else if (!state.start && state.track.length >= 2) fitTo(state.track, 40)
  updateLegend()
  void ensureRailStationsLoaded()
}

let mckStationsCache: MckStation[] | null = null
let mckLoadPromise: Promise<MckStation[]> | null = null
let mcdStationsCache: McdStation[] | null = null
let mcdLoadPromise: Promise<McdStation[]> | null = null

function isMoscowRailContext(): boolean {
  if (state.cityId === 'msk') return true
  const meta = state.catalog.find((r) => r.id === state.routeId)
  return (meta?.cityId || 'msk') === 'msk' || state.routeId === 'zkm-ring'
}

function isGreenRingRoute(): boolean {
  return state.routeId === 'zkm-ring'
}

/** Станции для карты и пикера: ЗКМ — внутри МКАД; остальные — ≤5 км от трека. */
function filterRailStationsForRoute<T extends LatLon>(all: T[] | null | undefined): T[] {
  if (!all?.length || !isMoscowRailContext()) return []
  if (state.track.length < 2) return []
  if (isGreenRingRoute()) return all.filter((s) => isInsideMkad(s))
  return stationsNearTrack(all, state.track, 5000)
}

function showMckOnMap(): boolean {
  if (!isMoscowRailContext() || state.track.length < 2) return false
  // пока кэш не загружен — кнопки есть; после загрузки — только если есть видимые станции
  if (mckStationsCache == null && mcdStationsCache == null) return true
  return (
    filterRailStationsForRoute(mckStationsCache).length +
      filterRailStationsForRoute(mcdStationsCache).length >
    0
  )
}

function applyMckDotsToSvg() {
  if (!svgRoutes) return
  const stations = filterRailStationsForRoute(mckStationsCache)
  if (!stations.length) {
    svgRoutes.setMckDots([])
    return
  }
  svgRoutes.setMckDots(stations.map((s) => ({ lat: s.lat, lon: s.lon, name: s.name })))
}

function applyMcdDotsToSvg() {
  if (!svgRoutes) return
  const stations = filterRailStationsForRoute(mcdStationsCache)
  if (!stations.length) {
    svgRoutes.setMcdDots([])
    return
  }
  svgRoutes.setMcdDots(
    stations.map((s) => ({
      lat: s.lat,
      lon: s.lon,
      name: s.name,
      color: s.color,
      linesLabel: mcdLinesLabel(s),
    })),
  )
}

async function ensureMckStationsLoaded() {
  if (!isMoscowRailContext()) {
    applyMckDotsToSvg()
    return
  }
  if (mckStationsCache) {
    applyMckDotsToSvg()
    return
  }
  if (!mckLoadPromise) {
    mckLoadPromise = loadMckStations().catch((e) => {
      mckLoadPromise = null
      console.warn('[site] mck stations', e)
      return [] as MckStation[]
    })
  }
  mckStationsCache = await mckLoadPromise
  applyMckDotsToSvg()
}

async function ensureMcdStationsLoaded() {
  if (!isMoscowRailContext()) {
    applyMcdDotsToSvg()
    return
  }
  if (mcdStationsCache) {
    applyMcdDotsToSvg()
    return
  }
  if (!mcdLoadPromise) {
    mcdLoadPromise = loadMcdStations().catch((e) => {
      mcdLoadPromise = null
      console.warn('[site] mcd stations', e)
      return [] as McdStation[]
    })
  }
  mcdStationsCache = await mcdLoadPromise
  applyMcdDotsToSvg()
}

async function ensureRailStationsLoaded() {
  const before = showMckOnMap()
  await Promise.all([ensureMckStationsLoaded(), ensureMcdStationsLoaded()])
  // кнопки МЦК/МЦД зависят от фильтра — перерисовать панель, если видимость сменилась
  if (before !== showMckOnMap()) render()
}

function updateLegend() {
  const el = $('#map-legend')
  if (!el) return
  if (state.segment.length >= 2) {
    const m = pathLengthM(state.segment)
    el.textContent = `Отрезок ≈ ${formatKm(m)} · ≈ ${formatDuration(minutesFromMeters(m, state.mode))}`
  } else if (state.track.length) {
    const meta = state.catalog.find((r) => r.id === state.routeId) || savedMeta.get(state.routeId)
    let text = meta
      ? legendTrackTitle({ id: state.routeId, title: meta.title, kmListed: meta.kmListed })
      : 'Трек на карте'
    el.textContent = text
  } else {
    el.textContent = 'Выберите трек'
  }
}

function setTopSub(text: string) {
  const el = $('#top-sub')
  if (el) el.textContent = text
}

/* ─── URL + session persistence (refresh-safe) ─── */

type PlannerSnap = {
  cityId: string
  routeId: string
  step: Step
  mode: Mode
  direction: Dir
  finishMode: FinishMode
  difficulty: string | null
  units: 'km' | 'time'
  meters: number | null
  customRaw: string
  lengthPicked: boolean
  start: PointOpt | null
  end: PointOpt | null
  segment: LatLon[]
  useKoptevoAlt?: boolean
}

function packPoint(p: PointOpt | null): string {
  if (!p) return ''
  return [p.id || '', p.lat.toFixed(5), p.lon.toFixed(5), p.name || ''].join('|')
}

function unpackPoint(raw: string | null): PointOpt | null {
  if (!raw) return null
  const parts = raw.split('|')
  if (parts.length < 3) return null
  const lat = Number(parts[1])
  const lon = Number(parts[2])
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  return {
    id: parts[0] || `snap-${lat.toFixed(4)}-${lon.toFixed(4)}`,
    lat,
    lon,
    name: parts.slice(3).join('|') || 'Точка',
  }
}

function downsampleForSnap(pts: LatLon[], maxN = 400): LatLon[] {
  if (pts.length <= maxN) return pts
  const step = Math.ceil(pts.length / maxN)
  const out: LatLon[] = []
  for (let i = 0; i < pts.length; i += step) out.push(pts[i])
  const last = pts[pts.length - 1]
  if (out.length && (out[out.length - 1].lat !== last.lat || out[out.length - 1].lon !== last.lon)) {
    out.push(last)
  }
  return out
}

function buildPlannerSnap(): PlannerSnap {
  return {
    cityId: state.cityId,
    routeId: state.routeId,
    step: state.step,
    mode: state.mode,
    direction: state.direction,
    finishMode: state.finishMode,
    difficulty: state.difficulty,
    units: state.units,
    meters: state.meters,
    customRaw: state.customRaw,
    lengthPicked: state.lengthPicked,
    start: state.start,
    end: state.end,
    segment: downsampleForSnap(state.segment, 400),
    useKoptevoAlt: state.useKoptevoAlt,
  }
}

function writeSessionSnap(snap: PlannerSnap) {
  try {
    sessionStorage.setItem(PLANNER_SNAP_KEY, JSON.stringify(snap))
  } catch {
    /* quota / private mode */
  }
}

function readSessionSnap(): PlannerSnap | null {
  try {
    const raw = sessionStorage.getItem(PLANNER_SNAP_KEY)
    if (!raw) return null
    return JSON.parse(raw) as PlannerSnap
  } catch {
    return null
  }
}

function plannerSearchFromSnap(snap: PlannerSnap, keepPlanId?: string | null): string {
  const q = new URLSearchParams()
  if (keepPlanId) q.set('p', keepPlanId)
  if (snap.cityId) q.set('city', snap.cityId)
  if (snap.routeId) q.set('r', snap.routeId)
  if (snap.step && snap.step !== 'track') q.set('step', snap.step)
  if (snap.mode && snap.mode !== 'bike') q.set('mode', snap.mode)
  if (snap.direction && snap.direction !== 'ccw') q.set('dir', snap.direction)
  if (snap.finishMode && snap.finishMode !== 'length') q.set('fm', snap.finishMode)
  if (snap.difficulty) q.set('diff', snap.difficulty)
  if (snap.units && snap.units !== 'km') q.set('units', snap.units)
  if (snap.meters != null && snap.lengthPicked) q.set('m', String(Math.round(snap.meters)))
  if (snap.customRaw.trim()) q.set('custom', snap.customRaw.trim())
  const s = packPoint(snap.start)
  if (s) q.set('s', s)
  const e = packPoint(snap.end)
  if (e) q.set('e', e)
  const str = q.toString()
  return str ? `?${str}` : location.pathname || '/'
}

function snapFromUrl(params: URLSearchParams): Partial<PlannerSnap> | null {
  const routeId = params.get('r') || ''
  const step = params.get('step') as Step | null
  const hasAnything =
    routeId ||
    step ||
    params.get('s') ||
    params.get('e') ||
    params.get('m') ||
    params.get('diff') ||
    params.get('fm')
  if (!hasAnything) return null
  const metersRaw = params.get('m')
  return {
    cityId: params.get('city') || undefined,
    routeId: routeId || undefined,
    step: (step && ['track', 'start', 'finish', 'confirm', 'maps'].includes(step) ? step : undefined) as
      | Step
      | undefined,
    mode: params.get('mode') === 'walk' ? 'walk' : params.get('mode') === 'bike' ? 'bike' : undefined,
    direction: params.get('dir') === 'cw' ? 'cw' : params.get('dir') === 'ccw' ? 'ccw' : undefined,
    finishMode:
      params.get('fm') === 'points' ? 'points' : params.get('fm') === 'length' ? 'length' : undefined,
    difficulty: params.get('diff') || null,
    units: params.get('units') === 'time' ? 'time' : params.get('units') === 'km' ? 'km' : undefined,
    meters: metersRaw != null && metersRaw !== '' ? Number(metersRaw) : null,
    customRaw: params.get('custom') || '',
    lengthPicked: metersRaw != null && metersRaw !== '',
    start: unpackPoint(params.get('s')),
    end: unpackPoint(params.get('e')),
  }
}

function persistPlannerState(opts?: { push?: boolean }) {
  if (suppressPersist) return
  if (!state.routeId && state.step === 'track') {
    // ещё ничего не выбрано — не засоряем URL, но чистим старый snap при полном сбросе
  }
  const snap = buildPlannerSnap()
  writeSessionSnap(snap)
  const planKeep = new URLSearchParams(location.search).get('p')
  // шаринг ?p= важнее — не затираем его параметрами мастера, пока открыт shared plan
  if (planKeep && state.step === 'confirm' && lastSavedPlanId === planKeep) {
    const url = `/?p=${encodeURIComponent(planKeep)}`
    if (location.search !== `?p=${planKeep}` && location.search !== `?p=${encodeURIComponent(planKeep)}`) {
      history.replaceState({ zm: 1 }, '', url)
    }
    return
  }
  const next = plannerSearchFromSnap(snap)
  const push = opts?.push === true || (lastPersistedStep != null && lastPersistedStep !== state.step)
  lastPersistedStep = state.step
  const cur = `${location.pathname}${location.search}`
  const target = next.startsWith('?') ? `${location.pathname || '/'}${next}` : next
  if (cur === target) return
  if (push) history.pushState({ zm: 1 }, '', target)
  else history.replaceState({ zm: 1 }, '', target)
}

function schedulePersist(opts?: { push?: boolean }) {
  if (suppressPersist) return
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => persistPlannerState(opts), 60)
}

async function hydrateTrackOnly(id: string, opts?: { keepKoptevoAlt?: boolean }) {
  // геометрия кольца могла обновиться на проде — не держим вечный кэш ZKM
  if (id === 'zkm-ring') trackCache.delete(id)
  const pts = await loadTrack(id)
  state.routeId = id
  officialTrack = id === 'zkm-ring' ? pts.slice() : []
  if (!(opts?.keepKoptevoAlt && id === 'zkm-ring')) state.useKoptevoAlt = false
  await loadKoptevoAlternative()
  if (id === 'zkm-ring') {
    applyOfficialOrAltTrack()
  } else {
    koptevoAlt = []
    state.useKoptevoAlt = false
    state.track = pts
    state.points = listPointsOnTrack(pts)
  }
}

async function restorePlannerFromSnap(snap: Partial<PlannerSnap> & { routeId?: string }) {
  if (snap.cityId && state.cities.some((c) => c.id === snap.cityId)) {
    state.cityId = snap.cityId
    localStorage.setItem(CITY_KEY, snap.cityId)
    syncCityButton()
  }
  const routeId = snap.routeId || ''
  if (routeId) {
    try {
      await hydrateTrackOnly(routeId, { keepKoptevoAlt: Boolean(snap.useKoptevoAlt) })
      if (snap.useKoptevoAlt && routeId === 'zkm-ring' && koptevoAlt.length >= 2) {
        state.useKoptevoAlt = true
        applyOfficialOrAltTrack()
      }
    } catch (e) {
      console.warn('[site] restore track', e)
      // saved: мог быть недоступен — всё равно восстановим сегмент из snap
      state.routeId = routeId
      state.track = Array.isArray(snap.segment) && snap.segment.length >= 2 ? snap.segment : []
      state.points = []
    }
  }
  if (snap.mode === 'bike' || snap.mode === 'walk') {
    state.mode = snap.mode
    document.querySelectorAll('.mode-seg [data-mode]').forEach((b) => {
      b.classList.toggle('active', (b as HTMLElement).dataset.mode === state.mode)
    })
  }
  if (snap.direction === 'cw' || snap.direction === 'ccw') state.direction = snap.direction
  if (snap.finishMode === 'length' || snap.finishMode === 'points') state.finishMode = snap.finishMode
  if (snap.difficulty !== undefined) state.difficulty = snap.difficulty
  if (snap.units === 'km' || snap.units === 'time') state.units = snap.units
  if (snap.customRaw != null) state.customRaw = snap.customRaw
  if (snap.meters != null) state.meters = snap.meters
  if (snap.lengthPicked != null) state.lengthPicked = snap.lengthPicked
  if (snap.start) state.start = snap.start
  if (snap.end) state.end = snap.end
  if (Array.isArray(snap.segment) && snap.segment.length >= 2) {
    state.segment = snap.segment.map((p) => ({ lat: Number(p.lat), lon: Number(p.lon) }))
  } else if (state.start && (state.lengthPicked || state.end)) {
    syncSegment()
  }
  if (snap.step && ['track', 'start', 'finish', 'confirm', 'maps'].includes(snap.step)) {
    state.step = snap.step
  } else if (state.end || (state.lengthPicked && state.meters != null) || state.segment.length >= 2) {
    state.step = 'confirm'
  } else if (state.start) {
    state.step = 'finish'
  } else {
    state.step = 'track'
  }
  const meta = state.catalog.find((r) => r.id === state.routeId) || savedMeta.get(state.routeId)
  if (meta) setTopSub(`${meta.title} · ≈ ${meta.kmListed} км`)
  paintMap()
}

async function tryRestorePlanner(): Promise<boolean> {
  const params = new URLSearchParams(location.search)
  const fromUrl = snapFromUrl(params)
  const fromSession = readSessionSnap()
  // URL главнее, session докидывает segment
  if (fromUrl?.routeId || fromUrl?.step || fromUrl?.start) {
    const merged: Partial<PlannerSnap> = { ...fromSession, ...fromUrl }
    if (
      fromSession?.routeId === fromUrl.routeId &&
      Array.isArray(fromSession.segment) &&
      fromSession.segment.length >= 2 &&
      (!fromUrl.segment || fromUrl.segment.length < 2)
    ) {
      merged.segment = fromSession.segment
    }
    // если в URL есть start/meters — приоритет URL
    await restorePlannerFromSnap(merged)
    return Boolean(state.routeId || state.segment.length >= 2)
  }
  if (fromSession?.routeId) {
    await restorePlannerFromSnap(fromSession)
    return Boolean(state.routeId || state.segment.length >= 2)
  }
  return false
}

function renderSteps() {
  const labels: { id: Step; t: string }[] = [
    { id: 'track', t: 'Трек' },
    { id: 'start', t: 'Старт' },
    { id: 'finish', t: 'Финиш' },
    { id: 'confirm', t: 'Подтверждение' },
    { id: 'maps', t: 'Карты' },
  ]
  const order = labels.map((x) => x.id)
  const cur = order.indexOf(state.step)
  $('#steps').innerHTML = labels
    .map((l, i) => {
      const cls = i === cur ? 'on' : i < cur ? 'done' : ''
      return `<span class="step-pill ${cls}">${i + 1}. ${l.t}</span>`
    })
    .join('')
}

function render() {
  const scroller = document.querySelector('.panel-scroll') as HTMLElement | null
  const y = scroller?.scrollTop ?? 0
  const keepScroll = state.step === 'start' || state.step === 'finish'
  renderSteps()
  const body = $('#panel-body')
  if (state.step === 'track') body.innerHTML = viewTrack()
  else if (state.step === 'start') body.innerHTML = viewStart()
  else if (state.step === 'finish') body.innerHTML = viewFinish()
  else if (state.step === 'confirm') body.innerHTML = viewConfirm()
  else body.innerHTML = viewMaps()
  wirePanel()
  if (keepScroll) {
    const next = document.querySelector('.panel-scroll') as HTMLElement | null
    if (next) next.scrollTop = y
    const active =
      (document.querySelector('.point-btn.active') as HTMLElement | null) ||
      (document.querySelector('.km-btn.active, .chip.active') as HTMLElement | null)
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  schedulePersist()
}

function viewTrack() {
  const cityRoutes = routesForCity()
  const planCards = [...savedPlansMeta.values()]
    .map(
      (m) => `<button type="button" class="track-btn" data-open-plan="${m.planId}">
        <span class="t">📌 ${m.title}</span>
        <span class="m">≈ ${m.kmListed} км</span>
        <span class="d">Сохранённый отрезок</span>
      </button>`,
    )
    .join('')
  const savedCards = [...savedMeta.entries()]
    .map(([id, m]) => {
      const active = state.routeId === id ? 'active' : ''
      return `<button type="button" class="track-btn ${active}" data-pick-track="${id}">
        <span class="t">📁 ${m.title}</span>
        <span class="m">≈ ${m.kmListed} км</span>
        <span class="d">Ваш загруженный трек</span>
      </button>`
    })
    .join('')
  const diffRu: Record<string, string> = {
    easy: 'лёгкий',
    medium: 'средний',
    hard: 'тяжёлый',
    hardcore: 'хардкор',
  }
  const cards = cityRoutes
    .map((r) => {
      const active = r.id === state.routeId ? 'active' : ''
      const star = r.featured || r.id === 'zkm-ring' ? '⭐ ' : ''
      const diff = r.difficulty ? `<span class="diff-tag">${diffRu[r.difficulty] || r.difficulty}</span>` : ''
      return `<button type="button" class="track-btn ${active}" data-pick-track="${r.id}">
        <span class="t">${star}${r.title}${diff}</span>
        <span class="m">≈ ${r.kmListed} км</span>
        ${r.description ? `<span class="d">${r.description}</span>` : ''}
      </button>`
    })
    .join('')
  const authHint = getAuthToken()
    ? ''
    : `<p class="auth-hint-row">
        <button type="button" class="auth-link" id="btn-open-auth">Войти</button>
        <span>— чтобы сохранять треки</span>
      </p>`
  const city = currentCity()
  const plansN = savedPlansMeta.size
  const tracksN = savedMeta.size
  const mineN = plansN + tracksN
  const mineBlock =
    mineN > 0
      ? `<details class="fold-block fold-mine">
        <summary>Мои <span class="fold-n">${mineN}</span></summary>
        <div class="fold-body">
          ${planCards ? `<p class="fold-sub">Маршруты</p>${planCards}` : ''}
          ${savedCards ? `<p class="fold-sub">Треки</p>${savedCards}` : ''}
        </div>
      </details>`
      : ''
  return `<div class="card card-fill">
    <div class="panel-scroll">
      <div class="track-title-row">
        <button type="button" class="btn-city-inline" id="btn-city" title="Сменить город">${city.emoji || '📍'} ${city.title}</button>
        <button type="button" class="btn-gpx-plus" id="btn-toggle-upload" aria-expanded="false" title="Загрузить GPX / KML / FIT">＋</button>
      </div>
      <p class="lead track-lead">${city.subtitle || 'Выберите трек или загрузите свой файл.'}</p>
      <div class="upload-zone collapsible" id="upload-zone" hidden>
        <input type="file" id="track-file" accept=".gpx,.kml,.fit,application/gpx+xml,application/vnd.google-earth.kml+xml" hidden />
        <button type="button" class="btn secondary" id="btn-upload-track">📂 Выбрать файл</button>
        <p class="lead tiny" id="upload-status">Или перетащите файл сюда</p>
      </div>
      ${authHint}
      <div class="track-list">
        ${mineBlock}
        <p class="section-label">Каталог</p>
        ${cards || '<div class="empty">В этом городе пока нет треков</div>'}
      </div>
    </div>
    <div class="panel-footer">
      <button type="button" class="btn" id="btn-to-start" ${state.routeId ? '' : 'disabled'}>Продолжить</button>
    </div>
  </div>`
}

function addressBlock(forKind: 'start' | 'end') {
  const hits = state.addressFor === forKind ? state.addressHits : []
  const status = state.addressFor === forKind ? state.addressStatus : ''
  const list = hits
    .map(
      (h, i) =>
        `<button type="button" class="point-btn" data-addr-hit="${i}" data-addr-for="${forKind}">${h.label}</button>`,
    )
    .join('')
  const statusCls = /не найден|ошибк|мало/i.test(status)
    ? 'field-status err'
    : status
      ? 'field-status ok'
      : 'field-status'
  return `<div class="addr-box">
    <label class="field">Адрес
      <input type="text" id="addr-input" value="${state.addressFor === forKind ? escapeAttr(state.addressQuery) : ''}" placeholder="Улица, дом или 55.75, 37.62" autocomplete="street-address" />
    </label>
    <button type="button" class="btn secondary sm" id="btn-addr-search" data-addr-for="${forKind}">Найти</button>
    ${status ? `<p class="${statusCls}">${status}</p>` : ''}
    <div class="point-list compact">${list}</div>
  </div>`
}

function escapeAttr(s: string) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function viewStart() {
  const list = state.points
    .map(
      (p) =>
        `<button type="button" class="point-btn ${state.start?.id === p.id ? 'active' : ''}" data-pick-start="${p.id}">${p.name}</button>`,
    )
    .join('')
  const geoCls = /не удалось|недоступ|запрет|отклон|вручную/i.test(state.geoStatus)
    ? 'field-status err'
    : state.geoStatus
      ? 'field-status ok'
      : 'field-status'
  const geoConfirm = state.pendingGeo
    ? (() => {
        const g = state.pendingGeo!
        const nearM =
          state.track.length >= 2 ? haversineM(g, state.track[nearestIndex(state.track, g)]) : null
        const approx = /IP|приблизит/i.test(state.geoStatus)
        return `<div class="geo-confirm">
        <p class="geo-confirm-q">Вы находитесь тут?</p>
        <p class="geo-confirm-meta">Синяя точка — место от телефона${
          approx ? ' <b>(примерно по IP, не GPS)</b>' : ''
        }.<br>${g.lat.toFixed(5)}, ${g.lon.toFixed(5)}${
          nearM != null
            ? `<br>До зелёной линии ≈ ${formatKm(nearM)}; после «Да» старт встанет на линию.`
            : ''
        }</p>
        <div class="action-stack">
          <button type="button" class="btn" id="btn-geo-yes">Да, это я</button>
          <button type="button" class="btn secondary" id="btn-geo-no">Нет, ввести адрес</button>
        </div>
      </div>`
      })()
    : ''
  return `<div class="card card-fill">
    <div class="panel-scroll">
      <h2>Точка старта</h2>
      <p class="lead">Карта, гео, адрес или точка из списка.</p>
      <div class="action-stack ${showMckOnMap() ? 'action-stack-3' : ''}">
        <button type="button" class="btn secondary ${state.pickMode === 'start' ? 'active-pick' : ''}" id="btn-pick-start-map">🗺️ На карте</button>
        ${
          showMckOnMap()
            ? `<button type="button" class="btn secondary" id="btn-pick-start-rail">🚇 МЦК/МЦД</button>`
            : ''
        }
        <button type="button" class="btn secondary" id="btn-geo-start" title="Геопозиция">📍 Гео</button>
      </div>
      ${geoConfirm}
      ${state.geoStatus && !state.pendingGeo ? `<p class="${geoCls}">${state.geoStatus}</p>` : ''}
      ${addressBlock('start')}
      <p class="section-label">Точки на треке</p>
      <div class="point-list">${list || '<div class="empty">Нет точек</div>'}</div>
      ${
        state.start
          ? `<p class="hint-ok">Старт: <b>${state.start.name}</b>
              <button type="button" class="linkish" id="btn-clear-start" title="Сбросить">✕</button></p>`
          : ''
      }
    </div>
    <div class="panel-footer btn-row">
      <button type="button" class="btn secondary sm" id="btn-back-track">К треку</button>
      <button type="button" class="btn" id="btn-to-finish" ${state.start ? '' : 'disabled'}>Продолжить</button>
    </div>
  </div>`
}

function viewFinish() {
  const levels = difficultiesForTrack(pathLengthM(state.track))
  if (!state.difficulty || !levels.some((d) => d.id === state.difficulty)) {
    state.difficulty = levels[0]?.id || null
  }
  const cur = levels.find((d) => d.id === state.difficulty) || levels[0]
  const kmList = cur?.km || []
  const customOn = Boolean(state.customRaw.trim())
  if (!state.lengthPicked && !customOn && state.finishMode === 'length') {
    state.meters = null
  }

  const diffChips = levels
    .map(
      (d) =>
        `<button type="button" class="chip ${state.difficulty === d.id ? 'active' : ''}" data-diff="${d.id}"><span class="chip-ico" aria-hidden="true">${d.emoji}</span>${d.title}</button>`,
    )
    .join('')

  const dirChips = `<div class="chip-row">
    <button type="button" class="chip ${state.direction === 'ccw' ? 'active' : ''}" data-dir="ccw">↺ Против часовой</button>
    <button type="button" class="chip ${state.direction === 'cw' ? 'active' : ''}" data-dir="cw">↻ По часовой</button>
  </div>`

  const modeTabs = `<div class="seg-tabs">
    <button type="button" data-fm="length" class="${state.finishMode === 'length' ? 'active' : ''}">По длине</button>
    <button type="button" data-fm="points" class="${state.finishMode === 'points' ? 'active' : ''}">Из точек</button>
  </div>`

  let modeBody = ''
  if (state.finishMode === 'length') {
    const unitTabs = `<div class="seg-tabs sm">
      <button type="button" data-units="km" class="${state.units === 'km' ? 'active' : ''}">Километры</button>
      <button type="button" data-units="time" class="${state.units === 'time' ? 'active' : ''}">Время</button>
    </div>`
    const presets = kmList
      .map((k) => {
        const mins = formatDuration(minutesFromMeters(k * 1000, state.mode))
        const label =
          state.units === 'km'
            ? `${k} км<br/><span class="sub">≈ ${mins}</span>`
            : `≈ ${mins}<br/><span class="sub">${k} км</span>`
        const active = !customOn && state.lengthPicked && state.meters === k * 1000 ? 'active' : ''
        const dis = customOn ? 'disabled' : ''
        return `<button type="button" class="${active}" data-km="${k}" ${dis}>${label}</button>`
      })
      .join('')
    const ph = state.units === 'km' ? 'Например 12' : '2:30 · 40 мин · 3ч'
    const hasLen = customOn || (state.lengthPicked && state.meters != null)
    modeBody = `
      ${unitTabs}
      <div class="km-grid ${customOn ? 'dimmed' : ''}">${presets}</div>
      ${
        hasLen
          ? `<button type="button" class="btn secondary sm" id="btn-clear-length" style="margin-top:8px">✕ Сбросить отрезок</button>`
          : ''
      }
      <label class="field">Свой вариант
        <div class="custom-row">
          <input type="text" id="custom-len" inputmode="text" placeholder="${ph}" value="${escapeAttr(state.customRaw)}" />
          <button type="button" class="btn secondary sm" id="btn-custom-clear" title="Очистить" ${customOn ? '' : 'disabled'}>✕</button>
        </div>
      </label>`
  } else {
    const range = difficultyRangeM(state.difficulty, kmList)
    const finishPts = state.points.filter((p) => p.id !== state.start?.id)
    const withDist = finishPts
      .map((p) => {
        const oriented = orientRing(state.track, state.direction === 'ccw')
        const startIdx = nearestIndex(oriented, state.start!)
        const fromStart = rotateToStart(oriented, startIdx)
        const endIdx = nearestIndex(fromStart, p)
        const seg = fromStart.slice(0, Math.max(endIdx, 0) + 1)
        return { p, m: pathLengthM(seg) }
      })
      .filter((x) => x.m > 200)
      .filter((x) => !range || (x.m >= range.minM && x.m <= range.maxM))
      .sort((a, b) => a.m - b.m)
    const rangeLabel =
      kmList.length > 0 ? `${kmList[0]}–${kmList[kmList.length - 1]} км` : ''
    const list = withDist
      .map(
        ({ p, m }) =>
          `<button type="button" class="point-btn ${state.end?.id === p.id ? 'active' : ''}" data-pick-end="${p.id}">
          ${p.name}<span class="sub">${formatKm(m)} · ≈ ${formatDuration(minutesFromMeters(m, state.mode))}</span>
        </button>`,
      )
      .join('')
    modeBody = `
      <p class="lead tiny" style="margin:0 0 8px">${cur?.emoji || ''} ${cur?.title || 'Сложность'}${
        rangeLabel ? ` · ${rangeLabel}` : ''
      } — только точки в этом диапазоне</p>
      <div class="point-list">${
        list ||
        '<div class="empty">Нет точек в этом диапазоне — смените сложность или выберите «По длине»</div>'
      }</div>
      ${
        state.end
          ? `<p class="hint-ok">Финиш: <b>${state.end.name}</b>
              <button type="button" class="linkish" id="btn-clear-end" title="Сбросить">✕</button></p>`
          : ''
      }`
  }

  const canGo = canGoFinish()

  return `<div class="card card-fill">
    <div class="panel-scroll">
      <h2>Финиш</h2>
      <p class="lead tiny" style="margin-top:0">Старт: <b>${state.start?.name || '—'}</b></p>

      <div class="action-stack" style="margin-bottom:10px">
        <button type="button" class="btn secondary ${state.pickMode === 'end' ? 'active-pick' : ''}" id="btn-pick-end-map">🗺️ Выбрать на карте</button>
        ${
          showMckOnMap()
            ? `<button type="button" class="btn secondary" id="btn-pick-end-rail">🚇 МЦК/МЦД</button>`
            : ''
        }
      </div>
      <details class="fold-block" style="margin-bottom:10px">
        <summary>Адрес или координаты</summary>
        <div class="fold-body">${addressBlock('end')}</div>
      </details>

      <p class="section-label">Общие настройки</p>
      <div class="finish-common">
        <div class="chip-row">${diffChips}</div>
        ${dirChips}
      </div>

      <p class="section-label">Как задать финиш</p>
      ${modeTabs}
      <div class="finish-mode-body">${modeBody}</div>
    </div>
    <div class="panel-footer btn-row">
      <button type="button" class="btn secondary sm" id="btn-back-start">К старту</button>
      <button type="button" class="btn" id="btn-to-confirm" ${canGo ? '' : 'disabled'}>Продолжить</button>
    </div>
  </div>`
}

function shareSaveRow() {
  return `<div class="icon-row">
    <button type="button" class="btn-icon" id="btn-share-plan" title="Поделиться">🔗 Поделиться</button>
    <button type="button" class="btn-icon" id="btn-save-plan" title="Сохранить">💾 Сохранить</button>
  </div>`
}

function viewConfirm() {
  applyCustomIfAny()
  syncSegment()
  const seg = state.segment
  const m = pathLengthM(seg)
  const pts = interestingOnSegment()
  const feats = featuresOnSegment()
  const warnN = feats.filter((f) => /забор|дыры|дырка|осторож|закрыт|лестниц|ступен/i.test(f.name)).length
  const ptsHtml = pts.length
    ? pts
        .map(
          (lm) =>
            `<button type="button" class="lm-btn" data-focus-lm="${lm.id}"><b>${lm.name}</b>${
              lm.description ? `<span class="sub">${lm.description}</span>` : ''
            }</button>`,
        )
        .join('')
    : ''
  const featsHtml = feats.length
    ? feats
        .map((f) => {
          const warn = /забор|дыры|дырка|осторож|закрыт|лестниц|ступен/i.test(f.name)
          return `<button type="button" class="feat-btn ${warn ? 'warn' : ''}" data-focus-poi="${f.id}">
            <b>${f.name}</b><span class="sub">${poiKindLabel(f.kind)}</span>
          </button>`
        })
        .join('')
    : ''

  // Десктоп: сразу открыты; мобилка: свёрнуты
  const confirmFoldsOpen =
    typeof window !== 'undefined' && window.matchMedia('(min-width: 861px)').matches

  return `<div class="card card-fill">
    <div class="panel-scroll">
      <h2>Подтверждение</h2>
      <div class="route-stats">
        <span class="rs-km">${formatKm(m)}</span>
        <span class="rs-time">≈ ${formatDuration(minutesFromMeters(m, state.mode))}</span>
        <span class="rs-mode">${state.mode === 'bike' ? 'велосипед' : 'пешком'}</span>
      </div>
      <p class="lead tiny" style="margin-top:0">старт: ${state.start?.name || '—'}</p>
      ${
        warnN > 0
          ? `<div class="banner warn-banner"><strong>На тропе</strong>${warnN} ${
              warnN === 1 ? 'место с осторожностью' : 'мест с осторожностью'
            } — смотрите «Особенности».</div>`
          : ''
      }
      ${shareSaveRow()}
      ${
        pts.length
          ? `<details class="details confirm-fold"${confirmFoldsOpen ? ' open' : ''}>
        <summary>Точки на участке <span style="color:var(--muted);font-weight:600">${pts.length}</span></summary>
        <div class="details-body">${ptsHtml}</div>
      </details>`
          : ''
      }
      ${
        feats.length
          ? `<details class="details confirm-fold"${confirmFoldsOpen ? ' open' : ''}>
        <summary>Особенности <span style="color:var(--muted);font-weight:600">${feats.length}</span></summary>
        <div class="details-body">${featsHtml}</div>
      </details>`
          : ''
      }
    </div>
    <div class="panel-footer btn-row">
      <button type="button" class="btn secondary sm" id="btn-back-finish">К финишу</button>
      <button type="button" class="btn" id="btn-to-maps">К картам</button>
    </div>
  </div>`
}

function viewMaps() {
  applyCustomIfAny()
  syncSegment()
  const seg = state.segment
  const m = pathLengthM(seg)
  const meta = state.catalog.find((r) => r.id === state.routeId) || savedMeta.get(state.routeId)
  const legs = seg.length >= 2 ? yandexMapsLegs(seg, state.mode) : []
  const legsHtml =
    legs.length <= 1
      ? legs.length === 1
        ? `<a class="btn js-open-yandex" href="${legs[0].url}" target="_blank" rel="noopener">🗺 Яндекс.Карты</a>`
        : `<a class="btn" href="#" aria-disabled="true">🗺 Яндекс.Карты</a>`
      : `<p class="lead tiny yandex-legs-hint">Откройте участки <b>по порядку</b> — так Яндекс держит тропу через парки.</p>
        <ol class="yandex-legs">
          ${legs
            .map(
              (leg) =>
                `<li>
                  <a class="btn ${leg.index === 0 ? '' : 'secondary'} js-open-yandex" href="${leg.url}" target="_blank" rel="noopener">
                    🗺 Участок ${leg.index + 1} из ${leg.total}
                    <span class="yandex-leg-meta">${formatKm(leg.meters)}</span>
                  </a>
                </li>`,
            )
            .join('')}
        </ol>`
  const showMckApproach = showMckOnMap() && !!state.start
  return `<div class="card card-fill">
    <div class="panel-scroll">
      <div class="summary">
        <strong>${meta?.title || 'Маршрут'}</strong>
        <span>Старт: ${state.start?.name || '—'}</span><br/>
        <span>${formatKm(m)} · ≈ ${formatDuration(minutesFromMeters(m, state.mode))} · ${
          state.direction === 'cw' ? 'по часовой' : 'против часовой'
        } · ${state.mode === 'bike' ? 'велосипед' : 'пешком'}</span>
      </div>
      ${shareSaveRow()}
      <h2>Открыть в навигаторе</h2>
      <div class="nav-stack">
        <button type="button" class="btn secondary" id="btn-approach-start" ${
          state.start ? '' : 'disabled'
        }>🚗 Доехать до старта</button>
        ${legsHtml}
      </div>
      ${
        showMckApproach
          ? `<p class="lead tiny" style="margin-top:8px">До старта можно от ближайшей МЦК или от вашей геопозиции.</p>`
          : ''
      }
    </div>
    <div class="panel-footer btn-row">
      <button type="button" class="btn secondary sm" id="btn-back-confirm">Назад</button>
      <button type="button" class="btn secondary sm" id="btn-restart">Сменить трек</button>
    </div>
  </div>`
}

function closeApproachModal() {
  document.getElementById('approach-modal')?.remove()
}

function showApproachChooser() {
  if (!state.start) return
  closeApproachModal()
  const wrap = document.createElement('div')
  wrap.id = 'approach-modal'
  wrap.className = 'auth-modal'
  const mckBtn = showMckOnMap()
    ? `<button type="button" class="btn" id="approach-from-mck">🚇 От МЦК</button>`
    : ''
  wrap.innerHTML = `<div class="auth-card">
    <button type="button" class="modal-x" id="approach-close" aria-label="Закрыть">✕</button>
    <h3>Доехать до старта</h3>
    <p class="lead tiny">Откуда построить маршрут в Яндекс.Картах?</p>
    <div class="nav-stack" style="margin-top:12px">
      ${mckBtn}
      <button type="button" class="btn secondary" id="approach-from-geo">📍 От текущего положения</button>
    </div>
  </div>`
  document.body.appendChild(wrap)
  wrap.querySelector('#approach-close')?.addEventListener('click', closeApproachModal)
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) closeApproachModal()
  })
  wrap.querySelector('#approach-from-geo')?.addEventListener('click', () => {
    closeApproachModal()
    void openApproachFromGeo()
  })
  wrap.querySelector('#approach-from-mck')?.addEventListener('click', () => {
    closeApproachModal()
    void showMckStationPicker()
  })
}

async function openApproachFromGeo() {
  if (!state.start) return
  const geo = state.userGeo || (await requestUserGeo({ setAsStart: false }))
  if (!geo || !state.start) {
    alert(state.geoStatus.includes('гео') ? state.geoStatus : 'Не удалось получить геопозицию')
    return
  }
  window.open(yandexApproachUrl(geo, { lat: state.start.lat, lon: state.start.lon }), '_blank', 'noopener')
}

async function showMckStationPicker() {
  if (!state.start) return
  closeApproachModal()
  let stations: MckStation[] = []
  try {
    await ensureMckStationsLoaded()
    stations = filterRailStationsForRoute(mckStationsCache)
  } catch {
    alert('Не удалось загрузить станции МЦК')
    return
  }
  if (!stations.length) {
    toast('Рядом с маршрутом нет станций МЦК')
    return
  }
  const ranked = stationsNearStart(stations, state.start)
  const wrap = document.createElement('div')
  wrap.id = 'approach-modal'
  wrap.className = 'auth-modal'
  const list = ranked
    .map(
      (s, i) => `<button type="button" class="mck-pick-btn" data-mck="${s.id}" data-idx="${i}">
        <span class="t">МЦК · ${escapeHtml(s.name)}</span>
        <span class="s">${formatMckDist(s.distM)} до старта</span>
      </button>`,
    )
    .join('')
  wrap.innerHTML = `<div class="auth-card auth-card-wide">
    <button type="button" class="modal-x" id="approach-close" aria-label="Закрыть">✕</button>
    <h3>Станция МЦК</h3>
    <p class="lead tiny">Ближе к старту «${escapeHtml(state.start.name || 'точка')}» — выше в списке.</p>
    <div class="mck-pick-list">${list}</div>
    <button type="button" class="btn secondary sm" id="approach-back-chooser" style="margin-top:10px;width:100%">← Назад</button>
  </div>`
  document.body.appendChild(wrap)
  wrap.querySelector('#approach-close')?.addEventListener('click', closeApproachModal)
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) closeApproachModal()
  })
  wrap.querySelector('#approach-back-chooser')?.addEventListener('click', () => {
    closeApproachModal()
    showApproachChooser()
  })
  wrap.querySelectorAll('[data-mck]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number((btn as HTMLElement).dataset.idx)
      const st = ranked[idx]
      if (!st || !state.start) return
      closeApproachModal()
      window.open(
        yandexApproachUrl({ lat: st.lat, lon: st.lon }, { lat: state.start.lat, lon: state.start.lon }),
        '_blank',
        'noopener',
      )
    })
  })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function getPositionOnce(opts: PositionOptions): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, opts)
  })
}

async function geoFromCapacitor(): Promise<LatLon | null> {
  try {
    const { Geolocation } = await import('@capacitor/geolocation')
    const pos = await Geolocation.getCurrentPosition({
      enableHighAccuracy: true,
      timeout: 20000,
    })
    return { lat: pos.coords.latitude, lon: pos.coords.longitude }
  } catch {
    return null
  }
}

async function geoFromIpApprox(): Promise<LatLon | null> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 5000)
    const res = await fetch('https://get.geojs.io/v1/ip/geo.json', { signal: ctrl.signal })
    clearTimeout(t)
    if (!res.ok) return null
    const data = (await res.json()) as { latitude?: string; longitude?: string }
    const lat = Number(data.latitude)
    const lon = Number(data.longitude)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
    return { lat, lon }
  } catch {
    return null
  }
}

/** Гео: Capacitor → браузер (low/high accuracy) → IP-приближение. */
async function requestUserGeo(opts: { setAsStart: boolean }): Promise<LatLon | null> {
  if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    state.geoStatus =
      'Нужен HTTPS для геопозиции (откройте https://green-route.ru — не «Не защищено»)'
    if (opts.setAsStart) render()
    return null
  }
  state.geoStatus = 'Определяем геопозицию…'
  if (opts.setAsStart) render()

  const applyGeo = (geo: LatLon, note: string) => {
    if (opts.setAsStart) {
      if (state.track.length < 2) {
        state.geoStatus = 'Сначала выберите трек'
        render()
        return geo
      }
      state.pendingGeo = geo
      state.geoConfirmFor = 'start'
      state.geoStatus = note
      setGeoMarker(geo)
      map?.flyTo({ center: [geo.lon, geo.lat], zoom: 14, duration: 500 })
      render()
    } else {
      state.userGeo = geo
      state.geoStatus = note
    }
    return geo
  }

  const cap = await geoFromCapacitor()
  if (cap) return applyGeo(cap, 'Проверьте синюю точку на карте')

  if (!navigator.geolocation) {
    const ip = await geoFromIpApprox()
    if (ip) return applyGeo(ip, 'Приблизительно по IP — не GPS')
    state.geoStatus = 'Геолокация недоступна в этом браузере'
    if (opts.setAsStart) render()
    return null
  }

  try {
    if (navigator.permissions?.query) {
      const st = await navigator.permissions.query({ name: 'geolocation' as PermissionName })
      if (st.state === 'denied') {
        state.geoStatus = 'Доступ к геопозиции запрещён — разрешите в настройках сайта'
        if (opts.setAsStart) render()
        return null
      }
    }
  } catch {
    /* permissions API optional */
  }

  const attempts: PositionOptions[] = [
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 120_000 },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
  ]
  let lastErr: GeolocationPositionError | null = null
  for (const attempt of attempts) {
    try {
      const pos = await getPositionOnce(attempt)
      return applyGeo(
        { lat: pos.coords.latitude, lon: pos.coords.longitude },
        'Проверьте синюю точку на карте',
      )
    } catch (e) {
      lastErr = e as GeolocationPositionError
    }
  }

  const ip = await geoFromIpApprox()
  if (ip) return applyGeo(ip, 'Приблизительно по IP — не GPS')

  const code = lastErr?.code
  state.geoStatus =
    code === 1
      ? 'Доступ к геопозиции запрещён — разрешите в настройках сайта'
      : code === 3
        ? 'Таймаут геопозиции — попробуйте ещё раз или выберите на карте'
        : 'Не удалось получить геопозицию — выберите точку на карте'
  if (opts.setAsStart) render()
  return null
}

function wirePanel() {
  document.querySelectorAll('[data-pick-track]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = (btn as HTMLElement).dataset.pickTrack!
      await selectTrack(id)
      trackClient('track_select', { routeId: id })
      render()
    })
  })
  document.querySelectorAll('.js-open-yandex').forEach((a) => {
    a.addEventListener('click', () => trackClient('open_yandex_maps', { routeId: state.routeId }))
  })
  $('#btn-to-start')?.addEventListener('click', () => {
    if (!state.routeId) return
    state.step = 'start'
    state.pickMode = null
    state.addressQuery = ''
    state.addressHits = []
    state.addressFor = 'start'
    setTopSub('Точка старта на линии')
    render()
  })
  $('#btn-back-track')?.addEventListener('click', () => {
    state.step = 'track'
    state.segment = []
    state.pickMode = null
    paintMap()
    setTopSub('Выберите трек')
    render()
  })
  $('#btn-pick-start-map')?.addEventListener('click', () => {
    state.geoStatus = ''
    closeRailPicker()
    setPickMode(state.pickMode === 'start' ? null : 'start')
  })
  $('#btn-pick-start-rail')?.addEventListener('click', () => {
    state.pickMode = null
    document.getElementById('map')?.classList.remove('picking')
    void showRailPicker('start')
  })
  $('#btn-pick-end-map')?.addEventListener('click', () => {
    state.lengthPicked = false
    state.meters = null
    state.customRaw = ''
    state.end = null
    state.segment = []
    closeRailPicker()
    paintMap()
    setPickMode(state.pickMode === 'end' ? null : 'end')
  })
  $('#btn-pick-end-rail')?.addEventListener('click', () => {
    state.pickMode = null
    document.getElementById('map')?.classList.remove('picking')
    void showRailPicker('end')
  })
  $('#btn-geo-start')?.addEventListener('click', () => {
    void requestUserGeo({ setAsStart: true })
  })
  $('#btn-geo-yes')?.addEventListener('click', () => acceptPendingGeoAsStart())
  $('#btn-geo-no')?.addEventListener('click', () => rejectPendingGeo())

  $('#btn-approach-start')?.addEventListener('click', () => {
    if (!state.start) return
    if (showMckOnMap()) showApproachChooser()
    else void openApproachFromGeo()
  })

  const addrInput = document.getElementById('addr-input') as HTMLInputElement | null
  addrInput?.addEventListener('input', () => {
    state.addressQuery = addrInput.value
  })
  addrInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      $('#btn-addr-search')?.click()
    }
  })
  $('#btn-addr-search')?.addEventListener('click', async () => {
    const forKind = (($('#btn-addr-search') as HTMLElement).dataset.addrFor || 'start') as 'start' | 'end'
    state.addressFor = forKind
    state.addressQuery = (document.getElementById('addr-input') as HTMLInputElement)?.value || ''
    if (state.addressQuery.trim().length < 3) {
      state.addressStatus = 'Введите адрес (минимум 3 символа)'
      state.addressHits = []
      render()
      return
    }
    state.addressStatus = 'Ищу…'
    state.addressHits = []
    render()
    try {
      state.addressHits = await geocodePhoton(state.addressQuery)
      state.addressStatus = state.addressHits.length
        ? `Найдено: ${state.addressHits.length} — выберите вариант`
        : 'Адрес не найден — уточните улицу/дом'
    } catch {
      state.addressHits = []
      state.addressStatus = 'Ошибка поиска адреса'
    }
    render()
  })
  document.querySelectorAll('[data-addr-hit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number((btn as HTMLElement).dataset.addrHit)
      const forKind = ((btn as HTMLElement).dataset.addrFor || 'start') as 'start' | 'end'
      const hit = state.addressHits[i]
      if (!hit) return
      const snapped = snapToTrack(hit, `Ближайшая к «${hit.label}»`)
      if (forKind === 'start') {
        state.start = snapped
        state.end = null
        state.segment = []
        state.addressStatus = `Старт у «${hit.label}»`
        paintMap()
      } else {
        state.end = snapped
        state.finishMode = 'points'
        state.lengthPicked = false
        state.meters = null
        state.addressStatus = `Финиш у «${hit.label}»`
        syncSegment()
      }
      state.addressHits = []
      map?.flyTo({ center: [snapped.lon, snapped.lat], zoom: 13, duration: 450 })
      render()
    })
  })

  document.querySelectorAll('[data-pick-start]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = (btn as HTMLElement).dataset.pickStart!
      const next = state.points.find((p) => p.id === id) || null
      // повторный клик — сброс
      if (next && state.start?.id === next.id) {
        state.start = null
        state.segment = []
        paintMap()
        render()
        return
      }
      state.start = next
      state.end = null
      state.segment = []
      state.geoStatus = ''
      paintMap()
      if (state.start) map?.flyTo({ center: [state.start.lon, state.start.lat], zoom: 12.5, duration: 450 })
      render()
    })
  })
  $('#btn-clear-start')?.addEventListener('click', () => {
    state.start = null
    state.segment = []
    paintMap()
    render()
  })
  $('#btn-clear-end')?.addEventListener('click', () => {
    state.end = null
    state.segment = []
    paintMap()
    render()
  })
  $('#btn-to-finish')?.addEventListener('click', () => {
    if (!state.start) return
    state.step = 'finish'
    state.pickMode = null
    state.customRaw = ''
    state.addressQuery = ''
    state.addressHits = []
    state.addressStatus = ''
    state.addressFor = 'end'
    state.lengthPicked = false
    state.meters = null
    state.end = null
    state.segment = []
    state.pendingGeo = null
    setGeoMarker(null)
    const levels = difficultiesForTrack(pathLengthM(state.track))
    state.difficulty = levels[0]?.id || null
    setTopSub('Длина или точка финиша')
    render()
    // зум как на шаге 1 — весь трек
    if (state.track.length >= 2) fitTo(state.track, 48)
    updateLegend()
  })
  $('#btn-back-start')?.addEventListener('click', () => {
    state.step = 'start'
    state.segment = []
    state.pickMode = null
    state.addressFor = 'start'
    state.addressHits = []
    paintMap()
    render()
  })
  document.querySelectorAll('[data-fm]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.finishMode = (btn as HTMLElement).dataset.fm as FinishMode
      if (state.finishMode === 'length') {
        state.end = null
        state.lengthPicked = false
        state.meters = null
      }
      state.customRaw = ''
      state.addressHits = []
      state.addressFor = 'end'
      syncSegment()
      render()
    })
  })
  document.querySelectorAll('[data-diff]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.difficulty = (btn as HTMLElement).dataset.diff!
      state.customRaw = ''
      state.lengthPicked = false
      state.meters = null
      // смена сложности в «из точек» — сброс финиша вне нового диапазона
      if (state.finishMode === 'points') {
        state.end = null
        state.segment = []
      } else {
        state.segment = []
      }
      paintMap()
      if (state.step === 'finish' && state.track.length >= 2) fitTo(state.track, 48)
      render()
    })
  })
  document.querySelectorAll('[data-dir]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.direction = (btn as HTMLElement).dataset.dir as Dir
      syncSegment()
      render()
    })
  })
  document.querySelectorAll('[data-units]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.units = (btn as HTMLElement).dataset.units as 'km' | 'time'
      state.customRaw = ''
      render()
    })
  })
  document.querySelectorAll('[data-km]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state.customRaw.trim()) return
      const km = Number((btn as HTMLElement).dataset.km)
      const meters = km * 1000
      // повторный клик по активному — сброс
      if (state.lengthPicked && state.meters === meters) {
        state.lengthPicked = false
        state.meters = null
        state.end = null
        state.segment = []
        paintMap()
        render()
        return
      }
      state.lengthPicked = true
      state.meters = meters
      state.end = null
      state.finishMode = 'length'
      syncSegment()
      render()
    })
  })
  $('#btn-clear-length')?.addEventListener('click', () => {
    state.lengthPicked = false
    state.meters = null
    state.customRaw = ''
    state.end = null
    state.segment = []
    paintMap()
    render()
  })
  const custom = document.getElementById('custom-len') as HTMLInputElement | null
  const onCustomLenEdit = () => {
    state.customRaw = custom?.value || ''
    if (state.customRaw.trim()) {
      state.end = null
      if (applyCustomIfAny()) {
        state.lengthPicked = true
        syncSegment()
      } else {
        // черновик вроде «2:» — ещё не валидно, Продолжить ждём
        state.lengthPicked = false
      }
    } else {
      state.lengthPicked = false
      state.meters = null
      state.segment = []
      paintMap()
    }
    const grid = document.querySelector('.km-grid')
    if (grid) {
      const on = Boolean(state.customRaw.trim())
      grid.classList.toggle('dimmed', on)
      grid.querySelectorAll('button').forEach((b) => {
        ;(b as HTMLButtonElement).disabled = on
        b.classList.toggle('active', false)
      })
    }
    const clearBtn = document.getElementById('btn-custom-clear') as HTMLButtonElement | null
    if (clearBtn) clearBtn.disabled = !state.customRaw.trim()
    // Важно: без полного render(), иначе теряется фокус в инпуте
    syncFinishContinueBtn()
  }
  custom?.addEventListener('input', onCustomLenEdit)
  custom?.addEventListener('change', onCustomLenEdit)
  custom?.addEventListener('keyup', onCustomLenEdit)
  $('#btn-custom-clear')?.addEventListener('click', () => {
    state.customRaw = ''
    state.lengthPicked = false
    state.meters = null
    state.segment = []
    paintMap()
    render()
  })
  document.querySelectorAll('[data-pick-end]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = (btn as HTMLElement).dataset.pickEnd!
      const next = state.points.find((p) => p.id === id) || null
      if (next && state.end?.id === next.id) {
        state.end = null
        state.segment = []
        paintMap()
        render()
        return
      }
      state.end = next
      state.lengthPicked = false
      state.meters = null
      state.finishMode = 'points'
      syncSegment()
      render()
    })
  })
  $('#btn-to-confirm')?.addEventListener('click', () => {
    applyCustomIfAny()
    if (state.customRaw.trim()) state.lengthPicked = true
    syncSegment()
    if (state.segment.length < 2) return
    lastShareUrl = ''
    state.step = 'confirm'
    state.pickMode = null
    setTopSub('Проверьте маршрут')
    paintMap()
    render()
  })
  $('#btn-to-maps')?.addEventListener('click', () => {
    syncSegment()
    trackClient('build_route', {
      routeId: state.routeId,
      meters: Math.round(pathLengthM(state.segment)),
      mode: state.mode,
    })
    state.step = 'maps'
    setTopSub('Откройте в картах')
    render()
  })
  $('#btn-back-finish')?.addEventListener('click', () => {
    state.step = 'finish'
    render()
  })
  $('#btn-back-confirm')?.addEventListener('click', () => {
    state.step = 'confirm'
    render()
  })
  $('#btn-restart')?.addEventListener('click', () => {
    state.step = 'track'
    state.start = null
    state.end = null
    state.segment = []
    state.meters = null
    state.lengthPicked = false
    state.customRaw = ''
    state.pickMode = null
    lastShareUrl = ''
    paintMap()
    setTopSub('Выберите трек')
    render()
  })

  $('#btn-share-plan')?.addEventListener('click', () => void shareCurrentPlan())
  $('#btn-save-plan')?.addEventListener('click', () => requestSavePlan())

  document.querySelectorAll('[data-focus-lm]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = (btn as HTMLElement).dataset.focusLm!
      const lm = landmarks.find((x) => x.id === id)
      if (lm) focusOnMap(lm, lm.name)
    })
  })
  document.querySelectorAll('[data-focus-poi]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = (btn as HTMLElement).dataset.focusPoi!
      const poi = trailPois.find((x) => x.id === id)
      if (poi) focusOnMap(poi, poi.name)
    })
  })
  document.querySelectorAll('[data-open-plan]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = (btn as HTMLElement).dataset.openPlan!
      void (async () => {
        try {
          const data = await apiJson<{ plan: { id: string; payload: any; title: string } }>(
            `/api/plans/${id}`,
          )
          lastSavedPlanId = data.plan.id
          lastShareUrl = `${location.origin}/?p=${data.plan.id}`
          await applyPlanPayload({ ...data.plan.payload, title: data.plan.title })
          state.step = 'confirm'
          setTopSub(data.plan.title || 'Сохранённый маршрут')
          render()
        } catch (e) {
          toast(e instanceof Error ? e.message : 'Не удалось открыть')
        }
      })()
    })
  })

  $('#btn-open-auth')?.addEventListener('click', () => showAuthModal())

  $('#btn-city')?.addEventListener('click', () => showCityPickerModal())
  $('#btn-toggle-upload')?.addEventListener('click', () => {
    const zone = document.getElementById('upload-zone')
    const btn = document.getElementById('btn-toggle-upload')
    if (!zone || !btn) return
    const open = zone.hasAttribute('hidden')
    if (open) zone.removeAttribute('hidden')
    else zone.setAttribute('hidden', '')
    btn.setAttribute('aria-expanded', open ? 'true' : 'false')
    btn.textContent = open ? '✕' : '＋'
    btn.title = open ? 'Скрыть загрузку' : 'Загрузить GPX / KML / FIT'
  })

  const fileInput = document.getElementById('track-file') as HTMLInputElement | null
  $('#btn-upload-track')?.addEventListener('click', () => fileInput?.click())
  fileInput?.addEventListener('change', () => {
    const f = fileInput.files?.[0]
    if (!f) return
    void uploadTrackFile(f).catch((e) => {
      const status = $('#upload-status')
      if (status) status.textContent = e instanceof Error ? e.message : 'Ошибка загрузки'
    })
    fileInput.value = ''
  })
  const zone = document.getElementById('upload-zone')
  if (zone) {
    zone.addEventListener('dragover', (e) => {
      e.preventDefault()
      zone.classList.add('drag')
    })
    zone.addEventListener('dragleave', () => zone.classList.remove('drag'))
    zone.addEventListener('drop', (e) => {
      e.preventDefault()
      zone.classList.remove('drag')
      const f = e.dataTransfer?.files?.[0]
      if (!f) return
      void uploadTrackFile(f).catch((err) => {
        const status = $('#upload-status')
        if (status) status.textContent = err instanceof Error ? err.message : 'Ошибка загрузки'
      })
    })
  }
}

async function selectTrack(id: string) {
  // bust cache if file updated (catalog only)
  if (!id.startsWith('saved:')) trackCache.delete(id)
  await hydrateTrackOnly(id)
  state.start = null
  state.end = null
  state.segment = []
  state.meters = null
  state.difficulty = null
  state.customRaw = ''
  paintMap()
  const meta = state.catalog.find((r) => r.id === id) || savedMeta.get(id)
  setTopSub(meta ? `${meta.title} · ≈ ${meta.kmListed} км` : 'Трек выбран')
}

function showCityPickerModal() {
  const existing = document.getElementById('city-modal')
  existing?.remove()
  const wrap = document.createElement('div')
  wrap.id = 'city-modal'
  wrap.className = 'auth-modal'
  const list = state.cities
    .map((c) => {
      const n = routesForCity(c.id).length
      const active = c.id === state.cityId ? 'active' : ''
      return `<button type="button" class="city-pick-btn ${active}" data-city="${c.id}">
        <span class="t">${c.emoji || '📍'} ${c.title}</span>
        <span class="s">${c.subtitle || ''} · ${n} маршрут(ов)</span>
      </button>`
    })
    .join('')
  wrap.innerHTML = `<div class="auth-card">
    <button type="button" class="modal-x" id="city-close" aria-label="Закрыть">✕</button>
    <h3>Город</h3>
    <p class="lead tiny">Москва и Зелёное кольцо — по умолчанию. Можно открыть маршруты других городов.</p>
    <div class="city-pick-list">${list}</div>
  </div>`
  document.body.appendChild(wrap)
  const close = () => wrap.remove()
  wrap.querySelector('#city-close')?.addEventListener('click', close)
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) close()
  })
  wrap.querySelectorAll('[data-city]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = (btn as HTMLElement).dataset.city!
      setCity(id)
      // если текущий трек не из города — выбрать featured кольцо / первый
      const cur = state.catalog.find((r) => r.id === state.routeId)
      if (!cur || (cur.cityId || 'msk') !== id) {
        const next =
          routesForCity(id).find((r) => r.id === 'zkm-ring' || r.featured) || routesForCity(id)[0]
        if (next) {
          void selectTrack(next.id).then(() => {
            state.step = 'track'
            render()
          })
        } else {
          state.routeId = ''
          state.track = []
          state.step = 'track'
          render()
        }
      } else {
        state.step = 'track'
        render()
      }
      close()
    })
  })
}

function syncCityButton() {
  const c = currentCity()
  const inline = document.getElementById('btn-city')
  if (inline) inline.textContent = `${c.emoji || '📍'} ${c.title}`
  const top = document.getElementById('btn-city-top')
  const topLabel = document.getElementById('btn-city-top-label')
  const topIco = top?.querySelector('.top-chip-ico')
  if (top) top.title = `Город: ${c.title}`
  if (topLabel) topLabel.textContent = c.title
  if (topIco) topIco.textContent = c.emoji || '📍'
}

const MAP_COMPACT_KEY = 'zm-map-compact-v1'

function isMobileLayout() {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 860px)').matches
}

function applyMapCompact() {
  const stage = document.getElementById('stage')
  const btn = document.getElementById('btn-map-size')
  // Только мобилка: меняем высоту панели карты, не зум
  const compact = isMobileLayout() && state.mapCompact
  stage?.classList.toggle('map-compact', compact)
  if (btn) {
    btn.hidden = !isMobileLayout()
    btn.textContent = compact ? '▾' : '▴'
    btn.title = compact ? 'Развернуть карту' : 'Свернуть карту'
    btn.setAttribute('aria-label', btn.title)
  }
  requestAnimationFrame(() => {
    map?.resize()
  })
}

function wireMapSizeToggle() {
  document.getElementById('btn-map-size')?.addEventListener('click', () => {
    if (!isMobileLayout()) return
    state.mapCompact = !state.mapCompact
    try {
      localStorage.setItem(MAP_COMPACT_KEY, state.mapCompact ? '1' : '0')
    } catch {
      /* */
    }
    applyMapCompact()
  })
  window.addEventListener('resize', () => applyMapCompact())
}

function showAppDownloadModal() {
  const existing = document.getElementById('app-dl-modal')
  existing?.remove()
  const wrap = document.createElement('div')
  wrap.id = 'app-dl-modal'
  wrap.className = 'auth-modal'
  wrap.innerHTML = `<div class="auth-card app-pick-card">
    <button type="button" class="modal-x" id="app-dl-close" aria-label="Закрыть">✕</button>
    <h3>Скачать приложение</h3>
    <p class="lead tiny">Выберите платформу.</p>
    <div class="nav-stack">
      <a class="btn" href="https://testflight.apple.com/join/PpWRTks4" target="_blank" rel="noopener"> Apple TestFlight</a>
      <a class="btn secondary" href="/downloads/zeleny-marshrut.apk" download="zeleny-marshrut.apk">🤖 APK Android</a>
    </div>
  </div>`
  document.body.appendChild(wrap)
  const close = () => wrap.remove()
  wrap.querySelector('#app-dl-close')?.addEventListener('click', close)
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) close()
  })
}

function wireChrome() {
  document.querySelectorAll('.mode-seg [data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.mode = (btn as HTMLElement).dataset.mode as Mode
      document.querySelectorAll('.mode-seg [data-mode]').forEach((b) => {
        b.classList.toggle('active', (b as HTMLElement).dataset.mode === state.mode)
      })
      if (state.step === 'finish' || state.step === 'confirm' || state.step === 'maps') {
        if (applyCustomIfAny() || state.meters) syncSegment()
        render()
      }
      schedulePersist()
    })
  })
  document.getElementById('btn-city-top')?.addEventListener('click', () => showCityPickerModal())
  document.getElementById('btn-get-app')?.addEventListener('click', () => showAppDownloadModal())
  document.getElementById('btn-open-auth-top')?.addEventListener('click', () => showAuthModal())
  document.querySelector('.top-tg')?.addEventListener('click', () => trackClient('open_telegram'))
  wireMapSizeToggle()
  try {
    state.mapCompact = localStorage.getItem(MAP_COMPACT_KEY) === '1'
  } catch {
    state.mapCompact = false
  }
  applyMapCompact()
  syncCityButton()
}

async function boot() {
  wireChrome()
  trackPageView()
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map((r) => r.unregister()))
    }
  } catch {
    /* */
  }
  initMap()
  $('#panel-body').innerHTML = '<div class="boot">Загружаем треки…</div>'
  suppressPersist = true
  try {
    await Promise.all([
      loadCatalog(),
      loadLandmarks(),
      loadTrailPois(),
      loadSavedTracks(),
      loadSavedPlans(),
      ensureRailStationsLoaded(),
    ])
    const planId = new URLSearchParams(location.search).get('p')
    if (planId) {
      try {
        const data = await apiJson<{ plan: { id: string; payload: any; title: string } }>(
          `/api/plans/${planId}`,
        )
        lastSavedPlanId = data.plan.id
        lastShareUrl = `${location.origin}/?p=${data.plan.id}`
        await applyPlanPayload({ ...data.plan.payload, title: data.plan.title })
        state.step = 'confirm'
        setTopSub(data.plan.title || 'Маршрут по ссылке')
        suppressPersist = false
        lastPersistedStep = state.step
        render()
        history.replaceState({ zm: 1 }, '', `/?p=${encodeURIComponent(planId)}`)
      } catch (e) {
        console.warn('[site] plan', e)
        toast('Ссылка на маршрут не открылась')
        const restored = await tryRestorePlanner()
        if (!restored) {
          const featured =
            routesForCity().find((r) => r.id === 'zkm-ring' || r.featured) ||
            routesForCity()[0] ||
            state.catalog.find((r) => r.featured) ||
            state.catalog[0]
          if (featured) {
            try {
              await selectTrack(featured.id)
            } catch (err) {
              console.warn('[site] track', err)
            }
          }
        }
        suppressPersist = false
        lastPersistedStep = state.step
        render()
      }
    } else {
      const restored = await tryRestorePlanner()
      if (!restored) {
        const featured =
          routesForCity().find((r) => r.id === 'zkm-ring' || r.featured) ||
          routesForCity()[0] ||
          state.catalog.find((r) => r.featured) ||
          state.catalog[0]
        if (featured) {
          try {
            await selectTrack(featured.id)
          } catch (e) {
            console.warn('[site] track', e)
          }
        }
      }
      suppressPersist = false
      lastPersistedStep = state.step
      render()
      if (restored) persistPlannerState()
    }
  } catch (e) {
    console.error(e)
    state.catalog = ((catalogBundled as { routes?: RouteMeta[] }).routes || []) as RouteMeta[]
    suppressPersist = false
    render()
  }
  window.addEventListener('resize', () => {
    map?.resize()
    paintMap()
  })
  window.addEventListener('popstate', () => {
    void (async () => {
      suppressPersist = true
      try {
        const planId = new URLSearchParams(location.search).get('p')
        if (planId) {
          try {
            const data = await apiJson<{ plan: { id: string; payload: any; title: string } }>(
              `/api/plans/${planId}`,
            )
            lastSavedPlanId = data.plan.id
            await applyPlanPayload({ ...data.plan.payload, title: data.plan.title })
            state.step = 'confirm'
            render()
            return
          } catch {
            /* fall through */
          }
        }
        await tryRestorePlanner()
        render()
      } finally {
        suppressPersist = false
      }
    })()
  })
}

boot()

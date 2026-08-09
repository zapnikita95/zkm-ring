import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  takeDistance,
} from './geo.js'
import { pointsForYandex, yandexApproachUrl, yandexMapsLegs, yandexMapsUrl } from './yandex.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
function resolveDataDir() {
  const candidates = []
  if (process.env.DATA_DIR) candidates.push(process.env.DATA_DIR)
  candidates.push(join(__dirname, '../data'))
  candidates.push(join(__dirname, '../../public/data'))
  for (const d of candidates) {
    if (d && existsSync(join(d, 'ring.geojson'))) return d
  }
  throw new Error(`ring.geojson not found; tried: ${candidates.join(' | ')}`)
}
const DATA = resolveDataDir()

function loadJson(rel) {
  return JSON.parse(readFileSync(join(DATA, rel), 'utf8'))
}

const ringGj = loadJson('ring.geojson')
const ringRaw = ringGj.features[0].geometry.coordinates.map(([lon, lat]) => ({ lat, lon }))

const landmarksGj = loadJson('landmarks.json')
const landmarks = landmarksGj.features
  .map((f, i) => {
    const [lon, lat] = f.geometry.coordinates
    const p = f.properties || {}
    return {
      id: String(p.id || i),
      name: String(p.name || 'Точка'),
      category: String(p.category || ''),
      lat,
      lon,
      mapHidden: Boolean(p.mapHidden),
      listOnly: Boolean(p.listOnly),
    }
  })
  .filter((l) => !l.mapHidden && !l.listOnly && l.category !== 'alert' && l.category !== 'note')

const catalog = loadJson('routes-catalog.json')
export const routeCatalog = catalog.routes || []
export const citiesCatalog =
  catalog.cities ||
  (existsSync(join(DATA, 'cities.json')) ? loadJson('cities.json').cities : []) ||
  []

export function citiesList() {
  if (citiesCatalog.length) return citiesCatalog
  return [{ id: 'msk', title: 'Москва', emoji: '🏙', subtitle: 'Зелёное кольцо и область' }]
}

export function cityMeta(id = 'msk') {
  return citiesList().find((c) => c.id === id) || citiesList()[0]
}

export function routesForCityId(cityId = 'msk') {
  const list = routeCatalog.filter((r) => (r.cityId || 'msk') === cityId)
  const rank = (id) => (id === 'zkm-ring' ? 0 : id === 'zkm-rutrail' ? 1 : 2)
  return list.slice().sort((a, b) => {
    const ra = rank(a.id)
    const rb = rank(b.id)
    if (ra !== rb) return ra - rb
    if (a.featured && !b.featured) return -1
    if (!a.featured && b.featured) return 1
    return String(a.title || '').localeCompare(String(b.title || ''), 'ru')
  })
}

const trackCache = new Map()
/** @type {Map<string, {lat:number,lon:number}[]>} */
const savedTrackCache = new Map()
/** @type {Map<string, string>} */
const savedTrackTitles = new Map()

export function putSavedTrack(routeId, points, title) {
  savedTrackCache.set(routeId, points)
  if (title) savedTrackTitles.set(routeId, title)
}

export function loadTrackPoints(routeId) {
  if (routeId === 'zkm-ring' || !routeId) return ringRaw
  if (String(routeId).startsWith('saved:')) {
    if (savedTrackCache.has(routeId)) return savedTrackCache.get(routeId)
    throw new Error('Сохранённый трек не загружен')
  }
  if (trackCache.has(routeId)) return trackCache.get(routeId)
  const item = routeCatalog.find((r) => r.id === routeId)
  if (!item) return ringRaw
  const rel = item.geojson.replace(/^data\//, '')
  const gj = loadJson(rel)
  const pts = gj.features[0].geometry.coordinates.map(([lon, lat]) => ({ lat, lon }))
  trackCache.set(routeId, pts)
  return pts
}

export function trackTitle(routeId) {
  if (String(routeId).startsWith('saved:')) {
    return savedTrackTitles.get(routeId) || 'Сохранённый трек'
  }
  const item = routeCatalog.find((r) => r.id === routeId)
  return item?.title || 'Зелёное кольцо по 2ГИС'
}

/** Длина линии трека в метрах (по геометрии, не каталожный kmListed). */
export function trackLengthM(routeId = 'zkm-ring') {
  return pathLengthM(loadTrackPoints(routeId))
}

export function nearestOnTrack(user, routeId = 'zkm-ring') {
  const pts = loadTrackPoints(routeId)
  const idx = nearestIndex(pts, user)
  const point = pts[idx]
  return { point, idx, meters: haversineM(user, point), track: pts }
}

/** До 20 интересных точек по удалению от пользователя (на треке рядом). */
export function nearbyLandmarks(user, limit = 20) {
  return landmarks
    .map((lm) => ({ ...lm, dist: haversineM(user, lm) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit)
}

/**
 * Точки старта/финиша на треке: POI рядом с линией, иначе метки каждые 5 км.
 * По умолчанию — порядок вдоль линии (idx), не «в разнобой».
 * @returns {{ id: string, name: string, lat: number, lon: number, idx: number, off: number, distFromRef?: number }[]}
 */
export function listRoutePoints(routeId = 'zkm-ring', ref = null, opts = {}) {
  const maxOffM = opts.maxOffM ?? 1500
  const sort = opts.sort ?? 'along' // 'along' | 'near'
  const track = loadTrackPoints(routeId)
  const snapped = landmarks
    .map((lm) => {
      const idx = nearestIndex(track, lm)
      const on = track[idx]
      const off = haversineM(lm, on)
      return {
        id: lm.id,
        name: lm.name,
        lat: on.lat,
        lon: on.lon,
        idx,
        off,
        distFromRef: ref ? haversineM(ref, on) : null,
      }
    })
    .filter((p) => p.off <= maxOffM)

  let list
  if (snapped.length >= 4) {
    list = snapped
  } else {
    const cum = []
    let acc = 0
    cum.push(0)
    for (let i = 1; i < track.length; i++) {
      acc += haversineM(track[i - 1], track[i])
      cum.push(acc)
    }
    const step = 5000
    list = []
    for (let m = 0, n = 0; m <= acc; m += step, n++) {
      let i = 0
      while (i < cum.length - 1 && cum[i + 1] < m) i++
      const p = track[i]
      list.push({
        id: `km${n}`,
        name: n === 0 ? 'Начало линии' : `Отметка ${n * 5} км`,
        lat: p.lat,
        lon: p.lon,
        idx: i,
        off: 0,
        distFromRef: ref ? haversineM(ref, p) : null,
      })
    }
  }

  if (sort === 'near' && ref) {
    list.sort((a, b) => (a.distFromRef ?? 0) - (b.distFromRef ?? 0))
  } else {
    list.sort((a, b) => a.idx - b.idx || a.name.localeCompare(b.name, 'ru'))
  }
  const seen = new Set()
  return list.filter((p) => {
    const key = `${p.idx}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Метры вдоль ориентированного кольца от fromIdx до toIdx (включая wrap). */
export function metersAlongOriented(oriented, fromIdx, toIdx) {
  if (!oriented.length) return 0
  if (fromIdx === toIdx) return 0
  let sum = 0
  let i = fromIdx
  const n = oriented.length
  let guard = 0
  while (guard++ < n + 2) {
    const j = (i + 1) % n
    sum += haversineM(oriented[i], oriented[j])
    if (j === toIdx) return sum
    i = j
  }
  return sum
}

/** Длина отрезка от старта до финиша в выбранном направлении. */
export function metersBetweenPoints(routeId, start, end, direction = 'ccw') {
  const track = loadTrackPoints(routeId)
  const oriented = orientRing(track, direction === 'ccw')
  const fromIdx = nearestIndex(oriented, start)
  const toIdx = nearestIndex(oriented, end)
  return metersAlongOriented(oriented, fromIdx, toIdx)
}

export function buildSegment({
  user,
  routeId = 'zkm-ring',
  direction = 'ccw',
  meters,
  mode = 'bike',
  startOverride = null,
}) {
  const track = loadTrackPoints(routeId)
  const startRef = startOverride || user
  const oriented = orientRing(track, direction === 'ccw')
  const startIdx = nearestIndex(oriented, startRef)
  const fromStart = rotateToStart(oriented, startIdx)
  const route = takeDistance(fromStart, meters)
  const len = pathLengthM(route)
  const mins = minutesFromMeters(len, mode)
  const yPts = pointsForYandex(route)
  const mapsLegs = yandexMapsLegs(route, mode)
  const start = route[0]
  const approachM = user ? haversineM(user, start) : 0
  return {
    routeId,
    title: trackTitle(routeId),
    direction,
    mode,
    meters: len,
    minutes: mins,
    start,
    end: route[route.length - 1],
    route,
    approachMeters: approachM,
    mapsUrl: mapsLegs[0]?.url || yandexMapsUrl(yPts, mode),
    mapsLegs,
    approachUrl: user && approachM > 40 ? yandexApproachUrl(user, start) : null,
  }
}

/** Отрезок от точки A до точки B по линии. */
export function buildSegmentBetween({
  user = null,
  routeId = 'zkm-ring',
  direction = 'ccw',
  start,
  end,
  mode = 'bike',
}) {
  const meters = metersBetweenPoints(routeId, start, end, direction)
  return buildSegment({
    user: user || start,
    routeId,
    direction,
    meters: Math.max(meters, 50),
    mode,
    startOverride: start,
  })
}

export function quickOffers(user, routeId = 'zkm-ring', mode = 'bike') {
  const near = nearestOnTrack(user, routeId)
  const kmOptions = [5, 8, 12, 15]
  const offers = []
  for (const km of kmOptions) {
    for (const direction of ['ccw', 'cw']) {
      const seg = buildSegment({
        user,
        routeId,
        direction,
        meters: km * 1000,
        mode,
      })
      offers.push({
        ...seg,
        label: `${km} км · ${direction === 'cw' ? 'по часовой' : 'против'} · ≈ ${formatDuration(seg.minutes)}`,
        km,
      })
    }
  }
  // компактно: по одному на каждую длину (против часовой по умолчанию) + пара «по часовой»
  const primary = kmOptions.map((km) =>
    offers.find((o) => o.km === km && o.direction === 'ccw'),
  )
  const cwAlt = [8, 12].map((km) => offers.find((o) => o.km === km && o.direction === 'cw'))
  return { near, offers: [...primary, ...cwAlt].filter(Boolean) }
}

export function popularPresets(user, mode = 'bike') {
  const routeId = 'zkm-ring'
  const specs = [
    { key: 'evening', title: 'Вечер после работы', meters: metersFromMinutes(50, mode), blurb: '≈ 40–60 мин спокойно' },
    { key: 'hour', title: 'На час', meters: metersFromMinutes(60, mode), blurb: 'Классический отрезок на час' },
    { key: 'weekend', title: 'Выходной', meters: 15000, blurb: '≈ 15 км — подольше' },
    { key: 'short', title: 'Короткий выход', meters: 5000, blurb: '5 км — быстро размяться' },
  ]
  return specs.map((s) => {
    const seg = buildSegment({ user, routeId, direction: 'ccw', meters: s.meters, mode })
    return {
      ...seg,
      key: s.key,
      label: `${s.title} · ${formatKm(seg.meters)} · ≈ ${formatDuration(seg.minutes)}`,
      blurb: s.blurb,
    }
  })
}

export function describeSegment(seg) {
  const dir = seg.direction === 'cw' ? 'по часовой' : 'против часовой'
  const mode = seg.mode === 'walk' ? 'пешком' : 'на велосипеде'
  return (
    `📍 <b>${seg.title}</b>\n` +
    `${formatKm(seg.meters)} · ≈ ${formatDuration(seg.minutes)} · ${dir} · ${mode}\n` +
    `Старт на линии → финиш на линии.\n` +
    `Откройте в Яндексе — привычный навигатор, без новых приложений.`
  )
}

export { formatKm, formatDuration, metersFromMinutes, minutesFromMeters }

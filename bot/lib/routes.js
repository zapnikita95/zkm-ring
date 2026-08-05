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
import { pointsForYandex, yandexMapsUrl, yandexNaviUrl } from './yandex.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
function resolveDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR
  const bundled = join(__dirname, '../data')
  const monorepo = join(__dirname, '../../public/data')
  if (existsSync(join(bundled, 'ring.geojson'))) return bundled
  return monorepo
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

const trackCache = new Map()

export function loadTrackPoints(routeId) {
  if (routeId === 'zkm-ring' || !routeId) return ringRaw
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
  const item = routeCatalog.find((r) => r.id === routeId)
  return item?.title || 'Зелёное кольцо Москвы'
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
 * Отрезок от ближайшей точки на треке.
 * direction: 'cw' | 'ccw'
 */
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
  return {
    routeId,
    title: trackTitle(routeId),
    direction,
    mode,
    meters: len,
    minutes: mins,
    start: route[0],
    end: route[route.length - 1],
    route,
    mapsUrl: yandexMapsUrl(yPts, mode),
    naviUrl: yandexNaviUrl(yPts),
  }
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

export { formatKm, formatDuration, metersFromMinutes }

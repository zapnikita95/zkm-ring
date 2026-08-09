/** МЦК / МЦД для Telegram-бота: загрузка, фильтр МКАД / ≤5 км от трека, сортировки. */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { haversineM, nearestIndex, orientRing, pathLengthM, rotateToStart } from './geo.js'
import { loadTrackPoints, nearestOnTrack } from './routes.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA = join(__dirname, '../data')

const MKAD_RING = [
  [37.384, 55.911],
  [37.42, 55.91],
  [37.48, 55.908],
  [37.545, 55.907],
  [37.61, 55.905],
  [37.67, 55.9],
  [37.725, 55.89],
  [37.77, 55.875],
  [37.81, 55.855],
  [37.835, 55.83],
  [37.842, 55.8],
  [37.842, 55.77],
  [37.835, 55.74],
  [37.825, 55.7],
  [37.8, 55.66],
  [37.76, 55.63],
  [37.71, 55.6],
  [37.66, 55.585],
  [37.6, 55.575],
  [37.54, 55.575],
  [37.48, 55.58],
  [37.43, 55.6],
  [37.39, 55.63],
  [37.36, 55.66],
  [37.34, 55.7],
  [37.33, 55.74],
  [37.33, 55.78],
  [37.34, 55.82],
  [37.355, 55.85],
  [37.37, 55.88],
  [37.384, 55.911],
]

const GREEN_RING_RAIL_NEAR_M = 5000

function isInsideMkad(p) {
  const { lon, lat } = p
  let inside = false
  const poly = MKAD_RING
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    const intersect =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-15) + xi
    if (intersect) inside = !inside
  }
  return inside
}

function sampleTrack(track, stepM = 180) {
  if (!track?.length) return []
  if (track.length <= 2) return track.slice()
  const out = [track[0]]
  let acc = 0
  for (let i = 1; i < track.length; i++) {
    acc += haversineM(track[i - 1], track[i])
    if (acc >= stepM) {
      out.push(track[i])
      acc = 0
    }
  }
  const last = track[track.length - 1]
  if (haversineM(out[out.length - 1], last) > 1) out.push(last)
  return out
}

function minDistToTrackM(station, track) {
  const samples = sampleTrack(track)
  let best = Infinity
  for (const t of samples) {
    const d = haversineM(station, t)
    if (d < best) best = d
  }
  return best
}

let mckCache = null
let mcdCache = null

function loadJsonStations(file) {
  const raw = JSON.parse(readFileSync(join(DATA, file), 'utf8'))
  return (raw.stations || []).filter(
    (s) => s && Number.isFinite(s.lat) && Number.isFinite(s.lon) && s.name,
  )
}

export function loadMckStations() {
  if (!mckCache) mckCache = loadJsonStations('mck-stations.json')
  return mckCache
}

export function loadMcdStations() {
  if (!mcdCache) mcdCache = loadJsonStations('mcd-stations.json')
  return mcdCache
}

function isGreenRingRouteId(routeId) {
  return routeId === 'zkm-ring' || routeId === 'zkm-rutrail'
}

export function railAvailable(routeId, cityId) {
  return (cityId || 'msk') === 'msk' || isGreenRingRouteId(routeId)
}

/** Список станций для текущего трека (как на сайте). */
export function stationsForRoute(routeId, kind) {
  const all = kind === 'mck' ? loadMckStations() : loadMcdStations()
  const track = loadTrackPoints(routeId)
  if (!track || track.length < 2) return []
  if (isGreenRingRouteId(routeId)) {
    return all.filter(
      (s) => isInsideMkad(s) || minDistToTrackM(s, track) <= GREEN_RING_RAIL_NEAR_M,
    )
  }
  return all.filter((s) => minDistToTrackM(s, track) <= GREEN_RING_RAIL_NEAR_M)
}

export function mcdLinesLabel(s) {
  return (s.lines || []).join('/') || 'МЦД'
}

export function stationBadge(s, kind) {
  if (kind === 'mck' || s.kind === 'mck') return 'МЦК'
  return mcdLinesLabel(s)
}

export function stationsAlpha(list) {
  return list.slice().sort((a, b) => a.name.localeCompare(b.name, 'ru'))
}

export function ringDistanceAlongTrack(track, direction, start, end) {
  if (!track?.length || track.length < 2) return 0
  const oriented = orientRing(track, direction === 'ccw')
  const fromStart = rotateToStart(oriented, nearestIndex(oriented, start))
  const endIdx = nearestIndex(fromStart, end)
  if (endIdx <= 0) return 0
  return pathLengthM(fromStart.slice(0, endIdx + 1))
}

/** Snap станции на линию трека. */
export function snapStationToTrack(station, routeId, name) {
  const near = nearestOnTrack({ lat: station.lat, lon: station.lon }, routeId)
  return {
    id: station.id,
    name: name || station.name,
    lat: near.point.lat,
    lon: near.point.lon,
    idx: near.idx,
    stationLat: station.lat,
    stationLon: station.lon,
    railKind: station.kind || (station.lines ? 'mcd' : 'mck'),
    railLabel: name || station.name,
    offM: near.meters,
  }
}

/** Все станции (МЦК+МЦД) в зоне трека, с kind. */
export function allStationsForRoute(routeId) {
  const mck = stationsForRoute(routeId, 'mck').map((s) => ({ ...s, kind: 'mck' }))
  const mcd = stationsForRoute(routeId, 'mcd').map((s) => ({ ...s, kind: 'mcd' }))
  return [...mck, ...mcd]
}

export function filterByType(stations, type) {
  if (type === 'mck') return stations.filter((s) => s.kind === 'mck')
  return stations.filter((s) => s.kind === 'mcd' && (s.lines || []).includes(type))
}

export function sortByRingDist(stations, track, direction, start) {
  return stations
    .map((s) => ({
      ...s,
      ringM: ringDistanceAlongTrack(track, direction, start, s),
    }))
    .filter((s) => s.ringM > 30)
    .sort((a, b) => a.ringM - b.ringM)
}

export const DONATE_PHONE = '+7-977-613-45-08'
export const DONATE_CAPTION =
  'Спасибо, что решили поддержать мой проект!\n\n' +
  'Он полностью бесплатный. Если хотите выразить благодарность — можете отправить любую сумму через Т‑Банк по номеру:\n\n' +
  DONATE_PHONE

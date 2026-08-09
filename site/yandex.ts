/**
 * Via для Яндекс.Карт: плотные якоря (углы + шаг вдоль линии),
 * затем нарезка на несколько URL — иначе роутер спрямляет парки.
 */
import { haversineM, pathLengthM, sampleAlong, turnAngleDeg, type LatLon } from '../src/geo'

/** Макс. точек в одном URL Яндекса (практический лимит rtext). */
export const YANDEX_CHUNK_POINTS = 12

/** Значимый поворот — мелкие зигзаги тропы не раздувают via. */
const TURN_DEG = 55
/** Обычные углы не чаще чем раз в N м; очень острые — всегда. */
const MIN_CORNER_GAP_M = 120
/** В парках Яндекс иначе спрямляет — шаг via плотнее. */
const DENSE_SPACING_M = 350
const DENSE_MAX_POINTS = 220
const CORNER_INJECT_MIN_M = 100
/** Угол ≥ этого не глотаем из‑за gap / «рядом уже via». */
const ALWAYS_KEEP_TURN_DEG = 80

export function yandexMaxPointsForDistance(meters: number): number {
  if (meters <= 5000) return 14
  if (meters <= 12000) return 12
  if (meters <= 25000) return 10
  return 8
}

/** Индексы резких поворотов (вершины «V»). */
export function cornerIndices(route: LatLon[], turnDeg = TURN_DEG): number[] {
  if (route.length < 3) return []
  const out: number[] = []
  let lastAlong = 0
  let acc = 0
  for (let i = 1; i < route.length; i++) {
    acc += haversineM(route[i - 1], route[i])
    if (i === route.length - 1) break
    const turn = turnAngleDeg(route[i - 1], route[i], route[i + 1])
    if (turn < turnDeg) continue
    const always = turn >= ALWAYS_KEEP_TURN_DEG
    if (!always && acc - lastAlong < MIN_CORNER_GAP_M && out.length) continue
    out.push(i)
    lastAlong = acc
  }
  return out
}

function snapToRouteIndex(route: LatLon[], p: LatLon, used: Set<number>): number {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < route.length; i++) {
    if (used.has(i)) continue
    const d = haversineM(route[i], p)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/**
 * Плотный набор via: равномерно вдоль линии + острые углы.
 * Без лимита 8–14 — потом {@link chunkPointsForYandex}.
 */
export function denseWaypointsForYandex(route: LatLon[], metersHint?: number): LatLon[] {
  if (!route?.length || route.length < 2) return route?.slice?.() || []
  if (route.length <= 3) return route.slice()

  const meters = metersHint ?? pathLengthM(route)
  const targetN = Math.max(
    3,
    Math.min(DENSE_MAX_POINTS, Math.ceil(meters / DENSE_SPACING_M) + 1),
  )

  const picked = new Set<number>([0, route.length - 1])
  const even = sampleAlong(route, targetN)
  for (const p of even) {
    if (picked.size >= DENSE_MAX_POINTS) break
    picked.add(snapToRouteIndex(route, p, picked))
  }

  // Острые углы, далеко от уже выбранных via
  const ranked = cornerIndices(route)
    .map((i) => ({
      i,
      turn: turnAngleDeg(route[i - 1], route[i], route[i + 1]),
    }))
    .sort((a, b) => b.turn - a.turn)

  for (const { i, turn } of ranked) {
    if (picked.size >= DENSE_MAX_POINTS) break
    if (picked.has(i)) continue
    const nearLimit = turn >= ALWAYS_KEEP_TURN_DEG ? 55 : CORNER_INJECT_MIN_M
    let near = false
    for (const j of picked) {
      if (haversineM(route[i], route[j]) < nearLimit) {
        near = true
        break
      }
    }
    if (!near) picked.add(i)
  }

  return [...picked]
    .sort((a, b) => a - b)
    .map((i) => route[i])
}

/**
 * Совместимость: одна «нога» ≤14 точек (для коротких отрезков / тестов).
 * Длинные маршруты — через {@link yandexMapsLegs}.
 */
export function waypointsForYandex(route: LatLon[], metersHint?: number): LatLon[] {
  const dense = denseWaypointsForYandex(route, metersHint)
  const meters = metersHint ?? pathLengthM(route)
  const budget = Math.min(14, yandexMaxPointsForDistance(meters))
  if (dense.length <= budget) return dense
  // равномерно проредить dense до budget, сохраняя концы
  const out: LatLon[] = [dense[0]]
  const mid = budget - 2
  for (let k = 1; k <= mid; k++) {
    const idx = Math.round((k * (dense.length - 1)) / (budget - 1))
    out.push(dense[idx])
  }
  out.push(dense[dense.length - 1])
  // unique by index order already
  return out.filter((p, i, arr) => i === 0 || p !== arr[i - 1])
}

/** Нарезка via с перекрытием на общей точке (финиш куска = старт следующего). */
export function chunkPointsForYandex(
  pts: LatLon[],
  maxPts = YANDEX_CHUNK_POINTS,
): LatLon[][] {
  const n = Math.max(3, Math.min(14, maxPts))
  if (pts.length < 2) return []
  if (pts.length <= n) return [pts.slice()]

  const chunks: LatLon[][] = []
  let i = 0
  while (i < pts.length - 1) {
    const end = Math.min(i + n - 1, pts.length - 1)
    const chunk = pts.slice(i, end + 1)
    if (chunk.length >= 2) chunks.push(chunk)
    if (end >= pts.length - 1) break
    i = end
  }
  return chunks
}

export function yandexUrlFromWaypoints(points: LatLon[], mode: 'bike' | 'walk' = 'bike'): string {
  const capped = points.slice(0, 14)
  const rtext = capped.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join('~')
  const rtt = mode === 'walk' ? 'pd' : 'bc'
  return `https://yandex.ru/maps/?rtext=${rtext}&rtt=${rtt}`
}

export type YandexLeg = {
  index: number
  total: number
  points: LatLon[]
  meters: number
  url: string
}

/** Несколько ссылок: плотные via → куски → URL без повторного прореживания. */
export function yandexMapsLegs(
  route: LatLon[],
  mode: 'bike' | 'walk' = 'bike',
  chunkPts = YANDEX_CHUNK_POINTS,
): YandexLeg[] {
  if (!route || route.length < 2) return []
  const dense = denseWaypointsForYandex(route)
  const chunks = chunkPointsForYandex(dense, chunkPts)
  return chunks.map((points, index) => ({
    index,
    total: chunks.length,
    points,
    meters: pathLengthM(points),
    url: yandexUrlFromWaypoints(points, mode),
  }))
}

/** Первая нога (или единственная) — для обратной совместимости. */
export function yandexMapsUrl(points: LatLon[], mode: 'bike' | 'walk' = 'bike'): string {
  const legs = yandexMapsLegs(points, mode)
  if (legs.length) return legs[0].url
  return yandexUrlFromWaypoints(waypointsForYandex(points), mode)
}

export function yandexApproachUrl(from: LatLon, to: LatLon): string {
  const rtext = `${from.lat.toFixed(5)},${from.lon.toFixed(5)}~${to.lat.toFixed(5)},${to.lon.toFixed(5)}`
  return `https://yandex.ru/maps/?rtext=${rtext}&rtt=auto`
}

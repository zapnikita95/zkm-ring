import type { LatLon } from './geo'
import { haversineM, pathLengthM, sampleAlong, turnAngleDeg } from './geo'
import type { Landmark } from './data'

export type TravelMode = 'walk' | 'bike'

/**
 * Плотные via + нарезка на несколько URL — иначе Яндекс спрямляет парки.
 */
export const YANDEX_MAX_POINTS = 8
export const YANDEX_CHUNK_POINTS = 12

const TURN_DEG = 55
/** Обычные углы не чаще чем раз в N м; очень острые — всегда. */
const MIN_CORNER_GAP_M = 120
/** В парках Яндекс иначе спрямляет — шаг via плотнее. */
const DENSE_SPACING_M = 180
const DENSE_MAX_POINTS = 320
const CORNER_INJECT_MIN_M = 100
/** Угол ≥ этого не глотаем из‑за gap / «рядом уже via». */
const ALWAYS_KEEP_TURN_DEG = 80
/** На рёбрах длиннее — вставить точки на линии (sample иначе снэпит только вершины). */
const MAX_EDGE_BEFORE_MIDPOINT_M = 150

export function yandexMaxPointsForDistance(meters: number): number {
  if (meters <= 5_000) return 14
  if (meters <= 12_000) return 12
  if (meters <= 25_000) return 10
  return 8
}

function cornerIndices(route: LatLon[], turnDeg = TURN_DEG): number[] {
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

/** Вставить midpoints на длинных рёбрах — иначе densify видит только вершины GPX. */
export function expandRouteWithEdgeMidpoints(
  route: LatLon[],
  maxEdgeM = MAX_EDGE_BEFORE_MIDPOINT_M,
): LatLon[] {
  if (!route?.length || route.length < 2) return route?.slice?.() || []
  const out: LatLon[] = [route[0]]
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]
    const b = route[i]
    const d = haversineM(a, b)
    if (d > maxEdgeM) {
      const n = Math.max(2, Math.ceil(d / maxEdgeM))
      for (let k = 1; k < n; k++) {
        const t = k / n
        out.push({
          lat: a.lat + (b.lat - a.lat) * t,
          lon: a.lon + (b.lon - a.lon) * t,
        })
      }
    }
    out.push(b)
  }
  return out
}

/** Плотный набор via: равномерно + острые углы. */
export function denseWaypointsForYandex(route: LatLon[], metersHint?: number): LatLon[] {
  if (route.length < 2) return route.slice()
  if (route.length <= 3) return route.slice()

  const expanded = expandRouteWithEdgeMidpoints(route)
  const meters = metersHint ?? pathLengthM(expanded)
  const targetN = Math.max(
    3,
    Math.min(DENSE_MAX_POINTS, Math.ceil(meters / DENSE_SPACING_M) + 1),
  )

  const picked = new Set<number>([0, expanded.length - 1])
  for (const p of sampleAlong(expanded, targetN)) {
    if (picked.size >= DENSE_MAX_POINTS) break
    picked.add(snapToRouteIndex(expanded, p, picked))
  }

  const ranked = cornerIndices(expanded)
    .map((i) => ({
      i,
      turn: turnAngleDeg(expanded[i - 1], expanded[i], expanded[i + 1]),
    }))
    .sort((a, b) => b.turn - a.turn)

  for (const { i, turn } of ranked) {
    if (picked.size >= DENSE_MAX_POINTS) break
    if (picked.has(i)) continue
    const nearLimit = turn >= ALWAYS_KEEP_TURN_DEG ? 55 : CORNER_INJECT_MIN_M
    let near = false
    for (const j of picked) {
      if (haversineM(expanded[i], expanded[j]) < nearLimit) {
        near = true
        break
      }
    }
    if (!near) picked.add(i)
  }

  let vias = [...picked]
    .sort((a, b) => a - b)
    .map((i) => expanded[i])

  vias = fillViaGapsAlongRoute(expanded, vias, DENSE_SPACING_M * 1.15)
  if (vias.length > DENSE_MAX_POINTS) {
    const keep: LatLon[] = [vias[0]]
    const mid = DENSE_MAX_POINTS - 2
    for (let k = 1; k <= mid; k++) {
      keep.push(vias[Math.round((k * (vias.length - 1)) / (DENSE_MAX_POINTS - 1))])
    }
    keep.push(vias[vias.length - 1])
    vias = keep.filter((p, i, arr) => i === 0 || p !== arr[i - 1])
  }
  return vias
}

function fillViaGapsAlongRoute(route: LatLon[], vias: LatLon[], maxGapM: number): LatLon[] {
  if (vias.length < 2 || route.length < 2) return vias
  const n = route.length
  const out: LatLon[] = [vias[0]]
  for (let v = 1; v < vias.length; v++) {
    const a = out[out.length - 1]
    const b = vias[v]
    if (haversineM(a, b) <= maxGapM) {
      out.push(b)
      continue
    }
    let ia = 0
    let ib = 0
    let da = Infinity
    let db = Infinity
    for (let i = 0; i < n; i++) {
      const d1 = haversineM(route[i], a)
      const d2 = haversineM(route[i], b)
      if (d1 < da) {
        da = d1
        ia = i
      }
      if (d2 < db) {
        db = d2
        ib = i
      }
    }
    const fwd: LatLon[] = []
    {
      let i = ia
      let guard = 0
      while (guard++ <= n + 1) {
        fwd.push(route[i])
        if (i === ib) break
        i = (i + 1) % n
      }
    }
    const rev: LatLon[] = []
    {
      let i = ia
      let guard = 0
      while (guard++ <= n + 1) {
        rev.push(route[i])
        if (i === ib) break
        i = (i - 1 + n) % n
      }
    }
    const use = pathLengthM(fwd) <= pathLengthM(rev) ? fwd : rev
    const need = Math.max(2, Math.ceil(pathLengthM(use) / (maxGapM * 0.85)) + 1)
    const samples = sampleAlong(use, need)
    for (const p of samples) {
      if (haversineM(out[out.length - 1], p) >= maxGapM * 0.4) out.push(p)
    }
    if (haversineM(out[out.length - 1], b) > 1) out.push(b)
  }
  return out
}

/**
 * Одна нога ≤14 (короткие / совместимость).
 */
export function densifyRouteForYandex(route: LatLon[], metersHint?: number): LatLon[] {
  const dense = denseWaypointsForYandex(route, metersHint)
  const meters = metersHint ?? pathLengthM(route)
  const budget = Math.min(14, yandexMaxPointsForDistance(meters))
  if (dense.length <= budget) return dense
  const must = new Set<number>([0, dense.length - 1])
  for (let i = 1; i < dense.length - 1; i++) {
    const turn = turnAngleDeg(dense[i - 1], dense[i], dense[i + 1])
    if (turn >= 45) must.add(i)
  }
  const evenly = new Set(must)
  const midSlots = Math.max(0, budget - must.size)
  for (let k = 1; k <= midSlots; k++) {
    evenly.add(Math.round((k * (dense.length - 1)) / (midSlots + 1)))
  }
  let idxs = [...evenly].sort((a, b) => a - b)
  if (idxs.length > budget) {
    const ranked = [...must]
      .filter((i) => i !== 0 && i !== dense.length - 1)
      .map((i) => ({ i, turn: turnAngleDeg(dense[i - 1], dense[i], dense[i + 1]) }))
      .sort((a, b) => b.turn - a.turn)
    const keep = new Set<number>([0, dense.length - 1])
    for (const { i } of ranked) {
      if (keep.size >= budget) break
      keep.add(i)
    }
    for (let k = 1; keep.size < budget && k < dense.length - 1; k++) {
      keep.add(Math.round((k * (dense.length - 1)) / budget))
    }
    idxs = [...keep].sort((a, b) => a - b)
  }
  return idxs.map((i) => dense[i]).filter((p, i, arr) => i === 0 || p !== arr[i - 1])
}

/** Нарезка ориентиров на ноги с перекрытием последней точки. */
export function chunkLandmarksForYandex(lms: Landmark[], maxPts = YANDEX_CHUNK_POINTS): Landmark[][] {
  const n = Math.max(3, Math.min(14, maxPts))
  if (lms.length === 0) return []
  if (lms.length <= n) return [lms.slice()]

  const chunks: Landmark[][] = []
  let i = 0
  while (i < lms.length - 1) {
    const end = Math.min(i + n - 1, lms.length - 1)
    chunks.push(lms.slice(i, end + 1))
    if (end >= lms.length - 1) break
    i = end
  }
  return chunks
}

/** Нарезка via-точек с перекрытием. */
export function chunkPointsForYandex(pts: LatLon[], maxPts = YANDEX_CHUNK_POINTS): LatLon[][] {
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

/** Fallback: dense → chunk (без прореживания до 8 до чанка). */
export function chunkForYandex(route: LatLon[], pointsPerSeg = YANDEX_CHUNK_POINTS): LatLon[][] {
  const meters = pathLengthM(route)
  const n = Math.max(3, Math.min(14, pointsPerSeg || yandexMaxPointsForDistance(meters)))
  const densified = denseWaypointsForYandex(route, meters)
  return chunkPointsForYandex(densified, n)
}

export function yandexUrlFromWaypoints(points: LatLon[], mode: TravelMode): string {
  const capped = points.slice(0, 14)
  const rtext = capped.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join('~')
  const rtt = mode === 'bike' ? 'bc' : 'pd'
  return `https://yandex.ru/maps/?rtext=${rtext}&rtt=${rtt}`
}

export type YandexLeg = {
  index: number
  total: number
  points: LatLon[]
  meters: number
  url: string
}

export function yandexMapsLegs(
  route: LatLon[],
  mode: TravelMode,
  chunkPts = YANDEX_CHUNK_POINTS,
): YandexLeg[] {
  if (route.length < 2) return []
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

/** URL одной ноги: точки уже выбраны — без повторного densify. */
export function yandexRouteUrl(points: LatLon[], mode: TravelMode, maxPts?: number): string {
  const budget = Math.min(14, maxPts ?? 14)
  return yandexUrlFromWaypoints(points.slice(0, budget), mode)
}

export function landmarksToLatLon(lms: Landmark[]): LatLon[] {
  return lms.map((l) => ({ lat: l.lat, lon: l.lon }))
}

/** WGS84 helpers for the ZKM ring. Lat/lon in degrees. */

export type LatLon = { lat: number; lon: number }

const R = 6371000

export function haversineM(a: LatLon, b: LatLon): number {
  const φ1 = (a.lat * Math.PI) / 180
  const φ2 = (b.lat * Math.PI) / 180
  const Δφ = ((b.lat - a.lat) * Math.PI) / 180
  const Δλ = ((b.lon - a.lon) * Math.PI) / 180
  const s =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}

export function pathLengthM(pts: LatLon[]): number {
  let sum = 0
  for (let i = 1; i < pts.length; i++) sum += haversineM(pts[i - 1], pts[i])
  return sum
}

/** Cumulative distances along path (same length as pts). */
export function cumulativeM(pts: LatLon[]): number[] {
  const c = [0]
  for (let i = 1; i < pts.length; i++) {
    c.push(c[i - 1] + haversineM(pts[i - 1], pts[i]))
  }
  return c
}

export function nearestIndex(pts: LatLon[], p: LatLon): number {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < pts.length; i++) {
    const d = haversineM(pts[i], p)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/**
 * Ring order: CCW or CW starting at `startIdx`.
 * Assumes closed or open polyline; last≈first is fine.
 */
export function orientRing(pts: LatLon[], wantCcw: boolean): LatLon[] {
  if (pts.length < 3) return pts.slice()
  const open =
    haversineM(pts[0], pts[pts.length - 1]) < 5 ? pts.slice(0, -1) : pts.slice()

  let area = 0
  for (let i = 0; i < open.length; i++) {
    const a = open[i]
    const b = open[(i + 1) % open.length]
    area += a.lon * b.lat - b.lon * a.lat
  }
  const isCcw = area > 0
  const ordered = isCcw === wantCcw ? open : [open[0], ...open.slice(1).reverse()]
  return ordered
}

export function rotateToStart(pts: LatLon[], startIdx: number): LatLon[] {
  if (pts.length === 0) return []
  const i = ((startIdx % pts.length) + pts.length) % pts.length
  return [...pts.slice(i), ...pts.slice(0, i)]
}

/** Path along oriented ring (starts at pts[0]) until nearest vertex to `end`. */
export function takeUntilPoint(ptsFromStart: LatLon[], end: LatLon): LatLon[] {
  if (ptsFromStart.length < 2) return ptsFromStart.slice()
  const endIdx = nearestIndex(ptsFromStart, end)
  if (endIdx <= 0) return [ptsFromStart[0]]
  if (endIdx >= ptsFromStart.length - 1 && haversineM(ptsFromStart[0], end) < 60) {
    return ptsFromStart.slice()
  }
  return ptsFromStart.slice(0, endIdx + 1)
}

/** Take a prefix of oriented ring covering ~targetMeters (does not close loop). */
export function takeDistance(pts: LatLon[], targetMeters: number): LatLon[] {
  if (pts.length === 0) return []
  if (targetMeters <= 0) return [pts[0]]
  const out = [pts[0]]
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    const d = haversineM(pts[i - 1], pts[i])
    if (acc + d >= targetMeters) {
      const rem = targetMeters - acc
      const t = rem / d
      out.push({
        lat: pts[i - 1].lat + (pts[i].lat - pts[i - 1].lat) * t,
        lon: pts[i - 1].lon + (pts[i].lon - pts[i - 1].lon) * t,
      })
      return out
    }
    acc += d
    out.push(pts[i])
  }
  return out
}

export type LandmarkLike = { lat: number; lon: number; id?: string; name?: string }

/**
 * Кусок кольца ~targetMeters, но финиш — у ближайшего ориентира в окне slack
 * (не ровно до метра). Если ориентира нет — обычный takeDistance.
 */
export function takeDistanceNearLandmark<T extends LandmarkLike>(
  ptsFromStart: LatLon[],
  targetMeters: number,
  landmarks: T[],
  opts?: { slackRatio?: number; minSlackM?: number; maxSlackM?: number; minFromStartM?: number },
): { route: LatLon[]; endLandmark: T | null; meters: number } {
  if (ptsFromStart.length === 0) {
    return { route: [], endLandmark: null, meters: 0 }
  }
  const slackRatio = opts?.slackRatio ?? 0.22
  const minSlack = opts?.minSlackM ?? 1000
  const maxSlack = opts?.maxSlackM ?? 4000
  const slack = Math.min(maxSlack, Math.max(minSlack, targetMeters * slackRatio))
  const minFromStart = opts?.minFromStartM ?? Math.min(1500, targetMeters * 0.25)

  const cum = cumulativeM(ptsFromStart)
  type Cand = { lm: T; idx: number; along: number; delta: number }
  let best: Cand | null = null

  for (const lm of landmarks) {
    const idx = nearestIndex(ptsFromStart, lm)
    if (idx <= 0) continue
    if (haversineM(ptsFromStart[idx], lm) > 1200) continue
    const along = cum[idx]
    if (along < minFromStart) continue
    const delta = Math.abs(along - targetMeters)
    if (delta > slack) continue
    if (!best || delta < best.delta) best = { lm, idx, along, delta }
  }

  if (best) {
    const route = ptsFromStart.slice(0, best.idx + 1)
    return { route, endLandmark: best.lm, meters: pathLengthM(route) }
  }

  const route = takeDistance(ptsFromStart, targetMeters)
  return { route, endLandmark: null, meters: pathLengthM(route) }
}

/** Evenly sample up to `n` points along path (keeps first & last). */
export function sampleAlong(pts: LatLon[], n: number): LatLon[] {
  if (pts.length <= n || n < 2) return pts.slice()
  const cum = cumulativeM(pts)
  const total = cum[cum.length - 1]
  const out: LatLon[] = []
  for (let k = 0; k < n; k++) {
    const target = (k / (n - 1)) * total
    let i = 0
    while (i < cum.length - 1 && cum[i + 1] < target) i++
    if (i >= pts.length - 1) {
      out.push(pts[pts.length - 1])
      continue
    }
    const seg = cum[i + 1] - cum[i] || 1
    const t = (target - cum[i]) / seg
    out.push({
      lat: pts[i].lat + (pts[i + 1].lat - pts[i].lat) * t,
      lon: pts[i].lon + (pts[i + 1].lon - pts[i].lon) * t,
    })
  }
  return out
}

export function formatKm(m: number): string {
  if (m < 1000) return `${Math.round(m)} м`
  return `${(m / 1000).toFixed(1)} км`
}

export function formatDuration(minutes: number): string {
  const m = Math.max(1, Math.round(minutes))
  const h = Math.floor(m / 60)
  const r = m % 60
  if (h === 0) return `${r} мин`
  if (r === 0) return `${h} ч`
  return `${h} ч ${r} мин`
}

export const SPEED_KMH = {
  walk: 5,
  bike: 15,
} as const

export function metersFromMinutes(minutes: number, mode: keyof typeof SPEED_KMH): number {
  return (SPEED_KMH[mode] * 1000 * minutes) / 60
}

export function minutesFromMeters(meters: number, mode: keyof typeof SPEED_KMH): number {
  return (meters / 1000 / SPEED_KMH[mode]) * 60
}

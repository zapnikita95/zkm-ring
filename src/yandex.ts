import type { LatLon } from './geo'
import { sampleAlong } from './geo'
import type { Landmark } from './data'

export type TravelMode = 'walk' | 'bike'

/**
 * Яндекс.Карты: больше ~6–7 точек в rtext — часто уводит с тропы на дороги.
 * Держим короткий кусок; следующий — после подтверждения в приложении.
 */
export const YANDEX_MAX_POINTS = 6

/** Нарезка ориентиров на ноги с перекрытием последней точки. */
export function chunkLandmarksForYandex(lms: Landmark[], maxPts = YANDEX_MAX_POINTS): Landmark[][] {
  const n = Math.max(3, Math.min(8, maxPts))
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

/** Нарезка готовых via-точек (ориентиры + якоря) с перекрытием. */
export function chunkPointsForYandex(pts: LatLon[], maxPts = YANDEX_MAX_POINTS): LatLon[][] {
  const n = Math.max(3, Math.min(8, maxPts))
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

/** Fallback: равномерные точки по линии кольца (если ориентиров мало). */
export function chunkForYandex(route: LatLon[], pointsPerSeg = YANDEX_MAX_POINTS): LatLon[][] {
  const n = Math.max(3, Math.min(8, pointsPerSeg))
  if (route.length <= n) return [route.slice()]

  const density = Math.min(route.length, Math.max(n * 3, Math.ceil(route.length / 20)))
  const sampled = sampleAlong(route, density)
  return chunkPointsForYandex(sampled, n)
}

export function yandexRouteUrl(points: LatLon[], mode: TravelMode): string {
  const capped = points.slice(0, YANDEX_MAX_POINTS)
  const rtext = capped.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join('~')
  const rtt = mode === 'bike' ? 'bc' : 'pd'
  return `https://yandex.ru/maps/?rtext=${rtext}&rtt=${rtt}`
}

export function landmarksToLatLon(lms: Landmark[]): LatLon[] {
  return lms.map((l) => ({ lat: l.lat, lon: l.lon }))
}

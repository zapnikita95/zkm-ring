import type { LatLon } from './geo'
import { sampleAlong } from './geo'

export type TravelMode = 'walk' | 'bike'

/** Chunk a route into overlapping Yandex-friendly segments (6–8 points each). */
export function chunkForYandex(route: LatLon[], pointsPerSeg = 7): LatLon[][] {
  const n = Math.max(3, Math.min(8, pointsPerSeg))
  if (route.length <= n) return [route.slice()]

  // Dense sample so chunks follow the shape, then split
  const density = Math.min(route.length, Math.max(n * 4, Math.ceil(route.length / 15)))
  const sampled = sampleAlong(route, density)

  const chunks: LatLon[][] = []
  let i = 0
  while (i < sampled.length - 1) {
    const end = Math.min(i + n - 1, sampled.length - 1)
    const chunk = sampled.slice(i, end + 1)
    if (chunk.length >= 2) chunks.push(chunk)
    if (end >= sampled.length - 1) break
    // Overlap last point as start of next
    i = end
  }
  return chunks
}

export function yandexRouteUrl(points: LatLon[], mode: TravelMode): string {
  const rtext = points.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join('~')
  const rtt = mode === 'bike' ? 'bc' : 'pd'
  return `https://yandex.ru/maps/?rtext=${rtext}&rtt=${rtt}`
}

/**
 * Ссылки в 2ГИС: те же плотные via, что для Яндекса, нарезка под лимит deeplink.
 * @see https://help.2gis.ru/question/razrabotchikam-zapusk-ideystviya-vmobilnom-prilozhenii-cherez-deeplink
 */
import { pathLengthM, type LatLon } from '../src/geo'
import { chunkPointsForYandex, denseWaypointsForYandex } from './yandex'

/** from + до 10 промежуточных + to ≈ безопасный размер куска. */
export const TWOGIS_CHUNK_POINTS = 10

export type TwoGisLeg = {
  index: number
  total: number
  points: LatLon[]
  meters: number
  url: string
}

function tabForMode(mode: 'bike' | 'walk'): 'bicycle' | 'pedestrian' {
  return mode === 'walk' ? 'pedestrian' : 'bicycle'
}

/** Точка в формате lon,lat (object_id не нужен). */
function ptToken(p: LatLon): string {
  return `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`
}

export function twoGisUrlFromWaypoints(points: LatLon[], mode: 'bike' | 'walk' = 'bike'): string {
  const capped = points.slice(0, TWOGIS_CHUNK_POINTS)
  if (capped.length < 2) return 'https://2gis.ru/moscow/directions/tab/bicycle'
  const path = capped.map(ptToken).join('|')
  return `https://2gis.ru/moscow/directions/tab/${tabForMode(mode)}/points/${path}`
}

export function twoGisMapsLegs(
  route: LatLon[],
  mode: 'bike' | 'walk' = 'bike',
  chunkPts = TWOGIS_CHUNK_POINTS,
): TwoGisLeg[] {
  if (!route || route.length < 2) return []
  const dense = denseWaypointsForYandex(route)
  const chunks = chunkPointsForYandex(dense, chunkPts)
  return chunks.map((points, index) => ({
    index,
    total: chunks.length,
    points,
    meters: pathLengthM(points),
    url: twoGisUrlFromWaypoints(points, mode),
  }))
}

/** Доезд до старта (авто) — как rtt=auto в Яндексе. */
export function twoGisApproachUrl(from: LatLon, to: LatLon): string {
  return `https://2gis.ru/moscow/directions/tab/car/points/${ptToken(from)}|${ptToken(to)}`
}

/** Приближённый контур МКАД (lon/lat) для фильтра станций ЗКМ. */
import type { LatLon } from '../src/geo'
import { haversineM } from '../src/geo'

/** Для ЗКМ: внутри МКАД или не дальше этого от трека кольца (юг D2 и т.п.). */
export const GREEN_RING_RAIL_NEAR_M = 5000

/** Замкнутый полигон МКАД, обход против часовой. */
export const MKAD_RING: Array<[number, number]> = [
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
  [37.825, 55.70],
  [37.80, 55.66],
  [37.76, 55.63],
  [37.71, 55.60],
  [37.66, 55.585],
  [37.60, 55.575],
  [37.54, 55.575],
  [37.48, 55.58],
  [37.43, 55.60],
  [37.39, 55.63],
  [37.36, 55.66],
  [37.34, 55.70],
  [37.33, 55.74],
  [37.33, 55.78],
  [37.34, 55.82],
  [37.355, 55.85],
  [37.37, 55.88],
  [37.384, 55.911],
]

/** Ray casting: точка строго внутри / на границе МКАД. */
export function isInsideMkad(p: LatLon): boolean {
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

const NEAR_TRACK_MAX_M = 5000

/** Подвыборка вершин трека (~каждые stepM), чтобы не гонять O(n·m) на всём GPX. */
function sampleTrack(track: LatLon[], stepM = 180): LatLon[] {
  if (track.length <= 2) return track.slice()
  const out: LatLon[] = [track[0]]
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

/** Мин. расстояние станции до точек трека (после сэмплинга). */
export function minDistToTrackM(station: LatLon, track: LatLon[]): number {
  if (!track.length) return Infinity
  const samples = sampleTrack(track)
  let best = Infinity
  for (const t of samples) {
    const d = haversineM(station, t)
    if (d < best) best = d
  }
  return best
}

/** Станции не далее maxM от любой точки трека. */
export function stationsNearTrack<T extends LatLon>(
  stations: T[],
  track: LatLon[],
  maxM: number = NEAR_TRACK_MAX_M,
): T[] {
  if (!stations.length || track.length < 2) return []
  return stations.filter((s) => minDistToTrackM(s, track) <= maxM)
}

export { NEAR_TRACK_MAX_M }

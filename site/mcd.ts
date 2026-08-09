/** Станции МЦД (Московские центральные диаметры) D1–D4. */
import type { LatLon } from '../src/geo'
import { haversineM, nearestIndex, orientRing, pathLengthM, rotateToStart } from '../src/geo'
import { formatMckDist } from './mck'

export type McdStation = {
  id: string
  name: string
  lat: number
  lon: number
  lines: string[]
  color: string
}

export const MCD_LINE_COLORS: Record<string, string> = {
  D1: '#F6A600',
  D2: '#E74280',
  D3: '#E95B0C',
  D4: '#40B280',
}

let cached: McdStation[] | null = null

export async function loadMcdStations(): Promise<McdStation[]> {
  if (cached) return cached
  const res = await fetch('/data/mcd-stations.json', { cache: 'force-cache' })
  if (!res.ok) throw new Error(`mcd-stations ${res.status}`)
  const data = (await res.json()) as { stations?: McdStation[] }
  cached = (data.stations || []).filter(
    (s) => s && Number.isFinite(s.lat) && Number.isFinite(s.lon) && s.name,
  )
  return cached
}

export function stationsNearGeo(
  stations: Array<{ lat: number; lon: number }>,
  geo: LatLon,
): Array<{ lat: number; lon: number; distM: number } & Record<string, unknown>> {
  return stations
    .map((s) => ({ ...s, distM: haversineM(geo, s) }))
    .sort((a, b) => a.distM - b.distM) as Array<
    { lat: number; lon: number; distM: number } & Record<string, unknown>
  >
}

export function stationsAlpha<T extends { name: string }>(stations: T[]): T[] {
  return stations.slice().sort((a, b) => a.name.localeCompare(b.name, 'ru'))
}

export function mcdLinesLabel(s: Pick<McdStation, 'lines'>): string {
  return (s.lines || []).join('/') || 'МЦД'
}

export function formatRailDist(meters: number): string {
  return formatMckDist(meters)
}

/** Длина вдоль трека (кольца) от ближайшей вершины к start до ближайшей к end. */
export function ringDistanceAlongTrack(
  track: LatLon[],
  direction: 'ccw' | 'cw',
  start: LatLon,
  end: LatLon,
): number {
  if (!track.length || track.length < 2) return 0
  const oriented = orientRing(track, direction === 'ccw')
  const fromStart = rotateToStart(oriented, nearestIndex(oriented, start))
  const endIdx = nearestIndex(fromStart, end)
  if (endIdx <= 0) return 0
  return pathLengthM(fromStart.slice(0, endIdx + 1))
}

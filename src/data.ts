import type { LatLon } from './geo'
import { cumulativeM, haversineM, nearestIndex } from './geo'

export type Landmark = {
  id: string
  name: string
  category: 'park' | 'lake' | 'viewpoint' | 'heritage' | 'alert' | 'note' | string
  description: string
  radius_m: number
  lat: number
  lon: number
  /** Индекс на сыром GPX-кольце (↑ = по часовой вдоль трека). */
  ringIndex: number
  orderCw: number
  orderCcw: number
  /** Не рисовать на карте; участвует в куске маршрута / snap финиша. */
  mapHidden?: boolean
  /** Только в списке точек (заметки/траблы с трека). */
  listOnly?: boolean
}

type GeoJSONFeatureCollection = {
  type: string
  features: Array<{
    properties: Record<string, unknown>
    geometry: { type: string; coordinates: number[] | number[][] }
  }>
}

export type RouteCatalogItem = {
  id: string
  title: string
  description: string
  kmListed: number
  geojson: string
  points: number
  source: string
  featured?: boolean
  landmarks?: Array<{
    id: string
    name: string
    category?: string
    description?: string
    radius_m?: number
    lat: number
    lon: number
  }>
}

const ROUTE_KEY = 'zm-route-id-v1'

export function getSelectedRouteId(): string | null {
  return localStorage.getItem(ROUTE_KEY)
}

export function setSelectedRouteId(id: string): void {
  localStorage.setItem(ROUTE_KEY, id)
}

export async function loadRoutesCatalog(): Promise<RouteCatalogItem[]> {
  const res = await fetch('/data/routes-catalog.json')
  const data = (await res.json()) as { routes: RouteCatalogItem[] }
  return data.routes || []
}

export async function loadRing(path = '/data/ring.geojson'): Promise<LatLon[]> {
  const res = await fetch(path.startsWith('/') ? path : `/${path}`)
  const gj = (await res.json()) as GeoJSONFeatureCollection
  const coords = gj.features[0].geometry.coordinates as number[][]
  return coords.map(([lon, lat]) => ({ lat, lon }))
}

/** Сдвиг точки вдоль трека на deltaM (знак = направление индексов). */
export function nudgeAlongTrack(track: LatLon[], near: LatLon, deltaM: number): LatLon {
  if (track.length < 2) return near
  const startIdx = nearestIndex(track, near)
  if (Math.abs(deltaM) < 1) return track[startIdx]
  const dir = deltaM >= 0 ? 1 : -1
  let left = Math.abs(deltaM)
  let i = startIdx
  while (left > 0) {
    const j = (i + dir + track.length) % track.length
    const seg = haversineM(track[i], track[j])
    if (seg <= 0.01) {
      i = j
      continue
    }
    if (seg >= left) {
      const t = left / seg
      return {
        lat: track[i].lat + (track[j].lat - track[i].lat) * t,
        lon: track[i].lon + (track[j].lon - track[i].lon) * t,
      }
    }
    left -= seg
    i = j
    // safety: don't loop forever on tiny rings
    if (i === startIdx && left < Math.abs(deltaM)) break
  }
  return track[i]
}

export async function loadLandmarks(): Promise<Landmark[]> {
  const res = await fetch('/data/landmarks.json')
  const gj = (await res.json()) as GeoJSONFeatureCollection
  const list = gj.features.map((f, i) => {
    const [lon, lat] = f.geometry.coordinates as number[]
    const p = f.properties
    return {
      id: String(p.id),
      name: String(p.name),
      category: String(p.category || 'park'),
      description: String(p.description ?? ''),
      radius_m: Number(p.radius_m ?? 120),
      lat,
      lon,
      ringIndex: Number(p.ringIndex ?? i),
      orderCw: Number(p.orderCw ?? i),
      orderCcw: Number(p.orderCcw ?? i),
      mapHidden: Boolean(p.mapHidden),
      listOnly: Boolean(p.listOnly),
    } satisfies Landmark
  })
  list.sort((a, b) => a.ringIndex - b.ringIndex)
  return list
}

/** @deprecated alias */
export type Park = Landmark & { reward?: string }

export async function loadParks(): Promise<Landmark[]> {
  return loadLandmarks()
}

/**
 * Ориентиры на куске маршрута: по расстоянию вдоль линии маршрута
 * (точки уже привязаны к кольцу). Порядок — вдоль пути.
 */
export function landmarksOnRoute(landmarks: Landmark[], routePts: LatLon[]): Landmark[] {
  if (routePts.length < 2) return []
  const cum = cumulativeM(routePts)
  const total = cum[cum.length - 1]
  const hit: Array<{ lm: Landmark; along: number }> = []

  for (const lm of landmarks) {
    const idx = nearestIndex(routePts, lm)
    const d = haversineM(routePts[idx], lm)
    // после snap к кольцу обычно <50м; запас на старые данные
    if (d > 1200) continue
    const along = cum[idx]
    if (along < 0 || along > total + 80) continue
    hit.push({ lm, along })
  }

  hit.sort((a, b) => a.along - b.along || a.lm.orderCw - b.lm.orderCw)
  // unique by id
  const seen = new Set<string>()
  const out: Landmark[] = []
  for (const h of hit) {
    if (seen.has(h.lm.id)) continue
    seen.add(h.lm.id)
    out.push(h.lm)
  }
  return out
}

export function parksOnRoute(landmarks: Landmark[], routePts: LatLon[]): Landmark[] {
  return landmarksOnRoute(landmarks, routePts)
}

/** Ближайший ориентир к точке (или null). */
export function nearestLandmark(
  landmarks: Landmark[],
  pos: LatLon,
  maxM = 500,
): Landmark | null {
  let best: Landmark | null = null
  let bestD = Infinity
  for (const lm of landmarks) {
    const d = haversineM(pos, lm)
    if (d < bestD && d <= maxM) {
      bestD = d
      best = lm
    }
  }
  return best
}

export const CATEGORY_LABEL: Record<string, string> = {
  park: 'Парк',
  lake: 'Озеро',
  viewpoint: 'Смотровая',
  heritage: 'История',
  alert: 'Внимание',
  note: 'Заметка',
}

/** Via для Яндекса: без заметок/алертов. */
export function routingLandmarks(landmarks: Landmark[]): Landmark[] {
  return landmarks.filter((l) => l.category !== 'alert' && l.category !== 'note' && !l.listOnly)
}

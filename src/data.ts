import type { LatLon } from './geo'
import { haversineM } from './geo'

export type Landmark = {
  id: string
  name: string
  category: 'park' | 'lake' | 'viewpoint' | 'heritage' | string
  description: string
  radius_m: number
  lat: number
  lon: number
}

type GeoJSONFeatureCollection = {
  type: string
  features: Array<{
    properties: Record<string, unknown>
    geometry: { type: string; coordinates: number[] | number[][] }
  }>
}

export async function loadRing(): Promise<LatLon[]> {
  const res = await fetch('/data/ring.geojson')
  const gj = (await res.json()) as GeoJSONFeatureCollection
  const coords = gj.features[0].geometry.coordinates as number[][]
  return coords.map(([lon, lat]) => ({ lat, lon }))
}

export async function loadLandmarks(): Promise<Landmark[]> {
  const res = await fetch('/data/landmarks.json')
  const gj = (await res.json()) as GeoJSONFeatureCollection
  return gj.features.map((f) => {
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
    }
  })
}

/** @deprecated alias */
export type Park = Landmark & { reward?: string }

export async function loadParks(): Promise<Landmark[]> {
  return loadLandmarks()
}

export function landmarksOnRoute(landmarks: Landmark[], routePts: LatLon[]): Landmark[] {
  const hit: Landmark[] = []
  for (const lm of landmarks) {
    let minD = Infinity
    for (const p of routePts) {
      const d = haversineM(p, lm)
      if (d < minD) minD = d
    }
    if (minD <= 280) hit.push(lm)
  }
  hit.sort((a, b) => {
    let ia = 0
    let ib = 0
    let da = Infinity
    let db = Infinity
    for (let i = 0; i < routePts.length; i++) {
      const dA = haversineM(routePts[i], a)
      const dB = haversineM(routePts[i], b)
      if (dA < da) {
        da = dA
        ia = i
      }
      if (dB < db) {
        db = dB
        ib = i
      }
    }
    return ia - ib
  })
  return hit
}

export function parksOnRoute(landmarks: Landmark[], routePts: LatLon[]): Landmark[] {
  return landmarksOnRoute(landmarks, routePts)
}

export const CATEGORY_LABEL: Record<string, string> = {
  park: 'Парк',
  lake: 'Озеро',
  viewpoint: 'Смотровая',
  heritage: 'История',
}

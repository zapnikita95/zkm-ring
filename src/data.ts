import type { LatLon } from './geo'
import { haversineM } from './geo'

export type Park = {
  id: string
  name: string
  description: string
  reward: string
  radius_m: number
  trackIndex: number
  lat: number
  lon: number
}

export type Poi = {
  name: string
  kind: string
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

export async function loadParks(): Promise<Park[]> {
  const res = await fetch('/data/parks.json')
  const gj = (await res.json()) as GeoJSONFeatureCollection
  return gj.features.map((f) => {
    const [lon, lat] = f.geometry.coordinates as number[]
    const p = f.properties
    return {
      id: String(p.id),
      name: String(p.name),
      description: String(p.description ?? ''),
      reward: String(p.reward ?? p.name),
      radius_m: Number(p.radius_m ?? 120),
      trackIndex: Number(p.trackIndex ?? 0),
      lat,
      lon,
    }
  })
}

export async function loadPois(): Promise<Poi[]> {
  const res = await fetch('/data/pois.json')
  const gj = (await res.json()) as GeoJSONFeatureCollection
  return gj.features.map((f) => {
    const [lon, lat] = f.geometry.coordinates as number[]
    return {
      name: String(f.properties.name),
      kind: String(f.properties.kind ?? 'other'),
      lat,
      lon,
    }
  })
}

/** Parks within ~250 m of the chosen route corridor, ordered along the route. */
export function parksOnRoute(parks: Park[], routePts: LatLon[]): Park[] {
  const hit: Park[] = []
  for (const park of parks) {
    let minD = Infinity
    for (const p of routePts) {
      const d = haversineM(p, park)
      if (d < minD) minD = d
    }
    if (minD <= 250) hit.push(park)
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

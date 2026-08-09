/** Станции МЦК (Московское центральное кольцо). Координаты — OSM network=МЦК. */
import type { LatLon } from '../src/geo'
import { haversineM } from '../src/geo'
import type * as maplibregl from 'maplibre-gl'

export type MckStation = {
  id: string
  name: string
  lat: number
  lon: number
}

let cached: MckStation[] | null = null
let geojson: object | null = null

export async function loadMckStations(): Promise<MckStation[]> {
  if (cached) return cached
  const res = await fetch('/data/mck-stations.json', { cache: 'force-cache' })
  if (!res.ok) throw new Error(`mck-stations ${res.status}`)
  const data = (await res.json()) as { stations?: MckStation[] }
  cached = (data.stations || []).filter(
    (s) => s && Number.isFinite(s.lat) && Number.isFinite(s.lon) && s.name,
  )
  return cached
}

export async function loadMckGeojson(): Promise<object> {
  if (geojson) return geojson
  const res = await fetch('/data/mck-stations.geojson', { cache: 'force-cache' })
  if (!res.ok) throw new Error(`mck geojson ${res.status}`)
  geojson = await res.json()
  return geojson
}

export function stationsNearStart(stations: MckStation[], start: LatLon): Array<MckStation & { distM: number }> {
  return stations
    .map((s) => ({ ...s, distM: haversineM(start, s) }))
    .sort((a, b) => a.distM - b.distM)
}

const SRC = 'zm-mck'
const LAYERS = ['zm-mck-halo', 'zm-mck-dots', 'zm-mck-labels'] as const

/** Ненавязчивые точки МЦК (розовый линии 14). Подписи с zoom ≥ 12.5. */
export async function ensureMckLayers(map: maplibregl.Map, visible: boolean): Promise<void> {
  if (!map.isStyleLoaded()) return
  if (!visible) {
    for (const id of LAYERS) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none')
    }
    return
  }
  if (!map.getSource(SRC)) {
    const data = await loadMckGeojson()
    map.addSource(SRC, { type: 'geojson', data })
    map.addLayer({
      id: 'zm-mck-halo',
      type: 'circle',
      source: SRC,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3.5, 14, 7],
        'circle-color': '#de64a1',
        'circle-opacity': 0.16,
      },
    })
    map.addLayer({
      id: 'zm-mck-dots',
      type: 'circle',
      source: SRC,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 2.2, 14, 4.5],
        'circle-color': '#de64a1',
        'circle-opacity': 0.82,
        'circle-stroke-width': 1,
        'circle-stroke-color': 'rgba(255,255,255,0.65)',
      },
    })
    map.addLayer({
      id: 'zm-mck-labels',
      type: 'symbol',
      source: SRC,
      minzoom: 12.5,
      layout: {
        'text-field': ['get', 'name'],
        'text-size': 11,
        'text-offset': [0, 1.05],
        'text-anchor': 'top',
        'text-optional': true,
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': '#6b3a55',
        'text-halo-color': 'rgba(255,255,255,0.92)',
        'text-halo-width': 1.1,
      },
    })
    map.on('mouseenter', 'zm-mck-dots', () => {
      map.getCanvas().style.cursor = 'pointer'
    })
    map.on('mouseleave', 'zm-mck-dots', () => {
      map.getCanvas().style.cursor = ''
    })
  } else {
    for (const id of LAYERS) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible')
    }
  }
}

export function formatMckDist(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} м`
  return `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} км`
}

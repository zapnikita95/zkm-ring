import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { LatLon } from './geo'
import type { Landmark } from './data'

const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap',
      maxzoom: 19,
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
}

export function createMap(container: HTMLElement, center: LatLon, zoom = 11): maplibregl.Map {
  return new maplibregl.Map({
    container,
    style: OSM_STYLE,
    center: [center.lon, center.lat],
    zoom,
    attributionControl: { compact: true },
  })
}

export function setRouteLine(map: maplibregl.Map, id: string, pts: LatLon[], color = '#2f9e5e'): void {
  const geo = {
    type: 'Feature' as const,
    properties: {},
    geometry: {
      type: 'LineString' as const,
      coordinates: pts.map((p) => [p.lon, p.lat]),
    },
  }
  const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined
  if (src) {
    src.setData(geo)
    return
  }
  map.addSource(id, { type: 'geojson', data: geo })
  map.addLayer({
    id: `${id}-line`,
    type: 'line',
    source: id,
    paint: { 'line-color': color, 'line-width': 4, 'line-opacity': 0.92 },
  })
}

export function setRingDim(map: maplibregl.Map, pts: LatLon[]): void {
  setRouteLine(map, 'ring-full', pts, '#3d5c48')
  map.setPaintProperty('ring-full-line', 'line-width', 2)
  map.setPaintProperty('ring-full-line', 'line-opacity', 0.32)
}

export function fitToRoute(map: maplibregl.Map, pts: LatLon[], pad = 48): void {
  if (pts.length === 0) return
  const b = new maplibregl.LngLatBounds([pts[0].lon, pts[0].lat], [pts[0].lon, pts[0].lat])
  for (const p of pts) b.extend([p.lon, p.lat])
  map.fitBounds(b, { padding: pad, maxZoom: 14 })
}

export function upsertMarker(
  map: maplibregl.Map,
  markerRef: { current: maplibregl.Marker | null },
  pos: LatLon,
  className: string,
): void {
  if (!markerRef.current) {
    const el = document.createElement('div')
    el.className = className
    markerRef.current = new maplibregl.Marker({ element: el }).setLngLat([pos.lon, pos.lat]).addTo(map)
  } else {
    markerRef.current.getElement().className = className
    markerRef.current.setLngLat([pos.lon, pos.lat])
  }
}

export function addLandmarkMarkers(
  map: maplibregl.Map,
  landmarks: Landmark[],
  earned: Set<string>,
): maplibregl.Marker[] {
  return landmarks.map((lm) => {
    const el = document.createElement('div')
    el.className = earned.has(lm.id) ? `marker-lm ${lm.category} earned` : `marker-lm ${lm.category}`
    el.title = lm.name
    return new maplibregl.Marker({ element: el }).setLngLat([lm.lon, lm.lat]).addTo(map)
  })
}

/** @deprecated */
export function addParkMarkers(
  map: maplibregl.Map,
  parks: Landmark[],
  earned: Set<string>,
): maplibregl.Marker[] {
  return addLandmarkMarkers(map, parks, earned)
}

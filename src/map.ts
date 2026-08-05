import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { LatLon } from './geo'
import { haversineM } from './geo'
import type { Landmark } from './data'

/**
 * Carto Voyager — светлая карта, чтобы точки и линия были видны.
 */
const BASEMAP_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    basemap: {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}@2x.png',
        'https://b.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}@2x.png',
        'https://c.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}@2x.png',
      ],
      tileSize: 256,
      attribution: '© OpenStreetMap · © CARTO',
      maxzoom: 20,
    },
  },
  layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
}

export function createMap(container: HTMLElement, center: LatLon, zoom = 11): maplibregl.Map {
  const map = new maplibregl.Map({
    container,
    style: BASEMAP_STYLE,
    center: [center.lon, center.lat],
    zoom,
    attributionControl: { compact: true },
    fadeDuration: 0,
  } as maplibregl.MapOptions)
  const resize = () => {
    try {
      map.resize()
    } catch {
      /* ignore */
    }
  }
  requestAnimationFrame(resize)
  setTimeout(resize, 50)
  setTimeout(resize, 200)
  setTimeout(resize, 600)
  return map
}

export function whenMapReady(map: maplibregl.Map, fn: () => void): void {
  const run = () => {
    try {
      map.resize()
      fn()
    } catch (e) {
      console.warn('[map]', e)
    }
  }
  if (map.isStyleLoaded()) {
    requestAnimationFrame(run)
  } else {
    map.once('load', () => requestAnimationFrame(run))
  }
}

function lineGeo(pts: LatLon[]) {
  return {
    type: 'Feature' as const,
    properties: {},
    geometry: {
      type: 'LineString' as const,
      coordinates: pts
        .filter((_, i, arr) => {
          if (i === 0) return true
          const a = arr[i - 1]
          const b = arr[i]
          return a.lat !== b.lat || a.lon !== b.lon
        })
        .map((p) => [p.lon, p.lat] as [number, number]),
    },
  }
}

function bringLineToFront(map: maplibregl.Map, id: string): void {
  const casing = `${id}-casing`
  const line = `${id}-line`
  if (map.getLayer(casing)) map.moveLayer(casing)
  if (map.getLayer(line)) map.moveLayer(line)
}

/** Поднять превью/маршрут над кольцом (после маркеров DOM линия всё равно сверху в GL). */
export function raiseRouteLayers(map: maplibregl.Map, ids: string[]): void {
  for (const id of ids) bringLineToFront(map, id)
}

/**
 * SVG-линия поверх карты — DOM, работает там, где WebGL line-слои в WebView молчат (Huawei).
 */
export type SvgRouteHandle = {
  setRoutes: (routes: Array<{ pts: LatLon[]; color: string; width: number }>) => void
  destroy: () => void
}

export function wireSvgRoutes(map: maplibregl.Map, host: HTMLElement): SvgRouteHandle {
  host.classList.add('map-fs-host')
  let svg = host.querySelector<SVGSVGElement>('.mp-route-svg')
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('class', 'mp-route-svg')
    host.appendChild(svg)
  }
  let routes: Array<{ pts: LatLon[]; color: string; width: number }> = []

  const redraw = (): void => {
    if (!svg) return
    const w = host.clientWidth || 1
    const h = host.clientHeight || 1
    svg.setAttribute('width', String(w))
    svg.setAttribute('height', String(h))
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
    while (svg.firstChild) svg.removeChild(svg.firstChild)

    for (const r of routes) {
      if (r.pts.length < 2) continue
      const sampled =
        r.pts.length > 240
          ? r.pts.filter((_, i) => i === 0 || i === r.pts.length - 1 || i % Math.ceil(r.pts.length / 220) === 0)
          : r.pts
      const d = sampled
        .map((p, i) => {
          const xy = map.project([p.lon, p.lat])
          return `${i === 0 ? 'M' : 'L'}${xy.x.toFixed(1)} ${xy.y.toFixed(1)}`
        })
        .join(' ')
      for (const [col, sw] of [
        ['#ffffff', r.width + 7],
        [r.color, r.width],
      ] as const) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        path.setAttribute('d', d)
        path.setAttribute('fill', 'none')
        path.setAttribute('stroke', col)
        path.setAttribute('stroke-width', String(sw))
        path.setAttribute('stroke-linecap', 'round')
        path.setAttribute('stroke-linejoin', 'round')
        path.setAttribute('opacity', col === '#ffffff' ? '0.9' : '1')
        svg.appendChild(path)
      }
    }
  }

  const onMove = (): void => redraw()
  map.on('move', onMove)
  map.on('zoom', onMove)
  map.on('resize', onMove)
  map.on('render', onMove)

  return {
    setRoutes: (next) => {
      routes = next
      redraw()
    },
    destroy: () => {
      map.off('move', onMove)
      map.off('zoom', onMove)
      map.off('resize', onMove)
      map.off('render', onMove)
      svg?.remove()
      svg = null
    },
  }
}

export function clearRouteLine(map: maplibregl.Map, id: string): void {
  for (const lid of [`${id}-line`, `${id}-casing`]) {
    if (map.getLayer(lid)) map.removeLayer(lid)
  }
  if (map.getSource(id)) map.removeSource(id)
}

/** Яркая полилиния поверх подложки (с тёмным контуром). Всегда пересоздаём — надёжнее в WebView. */
export function setRouteLine(
  map: maplibregl.Map,
  id: string,
  pts: LatLon[],
  color = '#1f8f4a',
  width = 7,
): void {
  if (pts.length < 2) {
    clearRouteLine(map, id)
    return
  }
  if (!map.isStyleLoaded()) {
    map.once('load', () => setRouteLine(map, id, pts, color, width))
    return
  }

  const geo = lineGeo(pts)
  if (geo.geometry.coordinates.length < 2) {
    clearRouteLine(map, id)
    return
  }

  clearRouteLine(map, id)

  map.addSource(id, { type: 'geojson', data: geo })
  map.addLayer({
    id: `${id}-casing`,
    type: 'line',
    source: id,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-width': width + 6,
      'line-opacity': 0.95,
    },
  })
  map.addLayer({
    id: `${id}-line`,
    type: 'line',
    source: id,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': color,
      'line-width': width,
      'line-opacity': 1,
    },
  })
  bringLineToFront(map, id)
}

export function setRingDim(map: maplibregl.Map, pts: LatLon[]): void {
  // полное кольцо семплируем — иначе WebView на Android может молча не рисовать слои
  const draw = pts.length > 500 ? sampleRing(pts, 420) : pts
  setRouteLine(map, 'ring-full', draw, '#90a4ae', 3)
  if (map.getLayer('ring-full-line')) {
    map.setPaintProperty('ring-full-line', 'line-opacity', 0.45)
  }
  if (map.getLayer('ring-full-casing')) {
    map.setPaintProperty('ring-full-casing', 'line-opacity', 0.3)
    map.setPaintProperty('ring-full-casing', 'line-width', 5)
  }
}

function sampleRing(pts: LatLon[], n: number): LatLon[] {
  if (pts.length <= n) return pts
  const out: LatLon[] = []
  for (let i = 0; i < n; i++) {
    const idx = Math.round((i / (n - 1)) * (pts.length - 1))
    out.push(pts[idx])
  }
  return out
}

export function fitToRoute(map: maplibregl.Map, pts: LatLon[], pad = 48, maxZoom = 13): void {
  if (pts.length === 0) return
  const b = new maplibregl.LngLatBounds([pts[0].lon, pts[0].lat], [pts[0].lon, pts[0].lat])
  for (const p of pts) b.extend([p.lon, p.lat])
  map.resize()
  map.fitBounds(b, { padding: pad, maxZoom, duration: 500 })
}

export function followUser(
  map: maplibregl.Map,
  pos: LatLon,
  bearing: number | null,
  zoom = 16,
): void {
  map.easeTo({
    center: [pos.lon, pos.lat],
    zoom,
    bearing: bearing ?? map.getBearing(),
    pitch: 50,
    duration: 400,
  })
}

export function upsertMarker(
  map: maplibregl.Map,
  markerRef: { current: maplibregl.Marker | null },
  pos: LatLon,
  className: string,
): void {
  // после app.innerHTML старый Marker висит на мёртвой карте — всегда пересоздаём на текущей
  if (markerRef.current) {
    try {
      markerRef.current.remove()
    } catch {
      /* ignore */
    }
    markerRef.current = null
  }
  const el = document.createElement('div')
  el.className = className
  el.title = 'Вы здесь'
  markerRef.current = new maplibregl.Marker({ element: el, anchor: 'center' })
    .setLngLat([pos.lon, pos.lat])
    .addTo(map)
}

export function clearMarkers(list: maplibregl.Marker[]): void {
  for (const m of list) m.remove()
  list.length = 0
}

export type LandmarkMarkerRole = {
  startId?: string | null
  endId?: string | null
  /** Подсветить все как «на маршруте» */
  onRoute?: boolean
  /** Только эти id получают подпись (кроме start/end) */
  labelIds?: Set<string>
}

/** Одна точка = один маркер. Старт/финиш — классы, не второй пин. */
export function addLandmarkMarkers(
  map: maplibregl.Map,
  landmarks: Landmark[],
  earned: Set<string>,
  withLabels = true,
  roles?: LandmarkMarkerRole & {
    dimIds?: Set<string>
    onPick?: (lm: Landmark) => void
  },
): maplibregl.Marker[] {
  return landmarks.map((lm) => {
    const wrap = document.createElement('div')
    wrap.className = 'marker-lm-wrap'
    const el = document.createElement('div')
    const parts = ['marker-lm', lm.category]
    if (earned.has(lm.id)) parts.push('earned')
    if (roles?.onRoute) parts.push('on-route')
    const isStart = !!(roles?.startId && lm.id === roles.startId)
    const isEnd = !!(roles?.endId && lm.id === roles.endId)
    const isDim = !!(roles?.dimIds?.has(lm.id) && !isStart && !isEnd)
    if (isStart) parts.push('is-start')
    if (isEnd) parts.push('is-end')
    if (isDim) {
      parts.push('dim')
      wrap.classList.add('dim-wrap')
    }
    el.className = parts.join(' ')
    wrap.appendChild(el)
    if (isStart) wrap.classList.add('mk-start')
    if (isEnd) wrap.classList.add('mk-end')
    // подпись НАД точкой — якорь по центру круга (точка лежит на линии)
    const showLabel =
      withLabels &&
      (isStart ||
        isEnd ||
        (roles?.labelIds
          ? roles.labelIds.has(lm.id)
          : !isDim && !roles?.onRoute))
    if (showLabel) {
      const lab = document.createElement('span')
      lab.className = 'marker-lm-label'
      if (isStart) lab.classList.add('start')
      if (isEnd) lab.classList.add('end')
      lab.textContent = isStart ? `Старт · ${lm.name}` : isEnd ? `Финиш · ${lm.name}` : lm.name
      wrap.insertBefore(lab, el)
    }
    wrap.title = lm.name
    if (roles?.onPick) {
      wrap.addEventListener('click', (ev) => {
        ev.stopPropagation()
        roles.onPick?.(lm)
      })
    }
    return new maplibregl.Marker({ element: wrap, anchor: 'center' })
      .setLngLat([lm.lon, lm.lat])
      .addTo(map)
  })
}

export function addParkMarkers(
  map: maplibregl.Map,
  parks: Landmark[],
  earned: Set<string>,
): maplibregl.Marker[] {
  return addLandmarkMarkers(map, parks, earned, true)
}

/** Старт/финиш только если рядом нет ориентира (иначе дубль). */
export function addEndpointIfOrphan(
  map: maplibregl.Map,
  pos: LatLon,
  label: string,
  kind: 'start' | 'end',
  landmarks: Landmark[],
  maxDistM = 220,
): maplibregl.Marker | null {
  for (const lm of landmarks) {
    if (haversineM(pos, lm) <= maxDistM) return null
  }
  return kind === 'start' ? addStartMarker(map, pos, label) : addEndMarker(map, pos, label)
}

export type EndpointMarkerOpts = {
  /** Развести подписи, когда старт и финиш почти в одной точке */
  labelSide?: 'left' | 'right' | 'center'
}

export function addStartMarker(
  map: maplibregl.Map,
  pos: LatLon,
  label: string,
  opts?: EndpointMarkerOpts,
): maplibregl.Marker {
  const wrap = document.createElement('div')
  wrap.className = 'marker-start-wrap mk-start'
  const lab = document.createElement('span')
  lab.className = `marker-lm-label start side-${opts?.labelSide || 'center'}`
  lab.textContent = label
  const el = document.createElement('div')
  el.className = 'marker-start'
  wrap.appendChild(lab)
  wrap.appendChild(el)
  return new maplibregl.Marker({ element: wrap, anchor: 'center' })
    .setLngLat([pos.lon, pos.lat])
    .addTo(map)
}

export function addEndMarker(
  map: maplibregl.Map,
  pos: LatLon,
  label: string,
  opts?: EndpointMarkerOpts,
): maplibregl.Marker {
  const wrap = document.createElement('div')
  wrap.className = 'marker-end-wrap mk-end'
  const lab = document.createElement('span')
  lab.className = `marker-lm-label end side-${opts?.labelSide || 'center'}`
  lab.textContent = label
  const el = document.createElement('div')
  el.className = 'marker-end'
  wrap.appendChild(lab)
  wrap.appendChild(el)
  return new maplibregl.Marker({ element: wrap, anchor: 'center' })
    .setLngLat([pos.lon, pos.lat])
    .addTo(map)
}

/** Кнопка «на весь экран» + resize MapLibre. */
export function wireFullscreenMap(
  wrap: HTMLElement,
  map: maplibregl.Map,
  opts?: { defaultOn?: boolean },
): () => void {
  wrap.classList.add('map-fs-host')
  let btn = wrap.querySelector<HTMLButtonElement>('.map-fs-btn')
  if (!btn) {
    btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'map-fs-btn'
    btn.setAttribute('aria-label', 'Развернуть карту')
    btn.textContent = '⛶'
    wrap.appendChild(btn)
  }
  const sync = () => {
    const on = wrap.classList.contains('map-fullscreen')
    btn!.textContent = on ? '✕' : '⛶'
    btn!.setAttribute('aria-label', on ? 'Свернуть карту' : 'Развернуть карту')
    requestAnimationFrame(() => map.resize())
    setTimeout(() => map.resize(), 80)
  }
  const onClick = () => {
    wrap.classList.toggle('map-fullscreen')
    document.body.classList.toggle('map-fs-open', wrap.classList.contains('map-fullscreen'))
    sync()
  }
  btn.onclick = onClick
  if (opts?.defaultOn) {
    wrap.classList.add('map-fullscreen')
    document.body.classList.add('map-fs-open')
  }
  sync()
  return () => {
    btn!.onclick = null
    wrap.classList.remove('map-fullscreen')
    document.body.classList.remove('map-fs-open')
  }
}

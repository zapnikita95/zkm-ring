import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { LatLon } from './geo'
import { cumulativeM, haversineM } from './geo'
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
export type SvgEndpoint = {
  lat: number
  lon: number
  label: string
  kind: 'start' | 'end' | 'geo' | 'station'
  /** Для станции — к какой точке на линии тянуть пунктир. */
  linkTo?: { lat: number; lon: number }
}

export type SvgMckDot = {
  lat: number
  lon: number
  name?: string
}

export type SvgMcdDot = {
  lat: number
  lon: number
  name?: string
  /** Фирменный цвет линии МЦД (D1–D4). */
  color?: string
  /** Подпись линии, напр. D1 или D1/D2. */
  linesLabel?: string
}

export type SvgRouteDraw = {
  pts: LatLon[]
  color: string
  width: number
  /** Пунктир (альтернативы / не основной трек). */
  dash?: boolean | string
  /** Клик по линии (hit-area шире stroke). */
  onClick?: () => void
  /** data-id для отладки / тестов */
  id?: string
}

export type SvgRouteHandle = {
  setRoutes: (routes: SvgRouteDraw[], endpoints?: SvgEndpoint[]) => void
  /** Лёгкие точки МЦК поверх подложки (в SVG — иначе уходят под оверлей линии). */
  setMckDots: (dots: SvgMckDot[]) => void
  onMckClick: (handler: ((dot: SvgMckDot) => void) | null) => void
  /** Точки МЦД (цвета линий D1–D4). */
  setMcdDots: (dots: SvgMcdDot[]) => void
  onMcdClick: (handler: ((dot: SvgMcdDot) => void) | null) => void
  /** Сырая геопозиция до подтверждения (синий пин поверх SVG). */
  setPendingGeo: (pt: LatLon | null) => void
  destroy: () => void
}

/** С какого зума показываем названия МЦК (как у метро на городских картах). */
const MCK_LABEL_MIN_ZOOM = 11.8

/**
 * Прореживание без «срезания углов»: шаг по длине вдоль линии, не каждый N-й индекс.
 * Иначе на СВ ЗКМ (Лосиный/Яуза) 100 точек → 8 и хорда срезает выступ.
 */
function samplePolylineForSvg(pts: LatLon[], maxPts = 1600, maxStepM = 120): LatLon[] {
  if (pts.length <= maxPts) return pts.slice()
  const cum = cumulativeM(pts)
  const total = cum[cum.length - 1] || 1
  const stepM = Math.min(maxStepM, Math.max(40, total / (maxPts - 1)))
  const out: LatLon[] = [pts[0]]
  let next = stepM
  for (let i = 1; i < pts.length - 1; i++) {
    if (cum[i] >= next) {
      out.push(pts[i])
      next = cum[i] + stepM
    }
  }
  const last = pts[pts.length - 1]
  if (out.length < 2 || haversineM(out[out.length - 1], last) > 1) out.push(last)
  return out
}

export function wireSvgRoutes(map: maplibregl.Map, host: HTMLElement): SvgRouteHandle {
  host.classList.add('map-fs-host')
  let svg = host.querySelector<SVGSVGElement>('.mp-route-svg')
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('class', 'mp-route-svg')
    host.appendChild(svg)
  }
  let routes: SvgRouteDraw[] = []
  let endpoints: SvgEndpoint[] = []
  let mckDots: SvgMckDot[] = []
  let mckClick: ((dot: SvgMckDot) => void) | null = null
  let pinnedMckName: string | null = null
  let mcdDots: SvgMcdDot[] = []
  let mcdClick: ((dot: SvgMcdDot) => void) | null = null
  let pinnedMcdKey: string | null = null
  let pendingGeo: LatLon | null = null

  const redraw = (): void => {
    if (!svg) return
    const w = host.clientWidth || 1
    const h = host.clientHeight || 1
    const zoom = map.getZoom()
    const showLabels = zoom >= MCK_LABEL_MIN_ZOOM
    svg.setAttribute('width', String(w))
    svg.setAttribute('height', String(h))
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
    while (svg.firstChild) svg.removeChild(svg.firstChild)

    for (const r of routes) {
      if (r.pts.length < 2) continue
      const sampled = samplePolylineForSvg(r.pts)
      const d = sampled
        .map((p, i) => {
          const xy = map.project([p.lon, p.lat])
          return `${i === 0 ? 'M' : 'L'}${xy.x.toFixed(1)} ${xy.y.toFixed(1)}`
        })
        .join(' ')
      const dash = r.dash === true ? '11 9' : typeof r.dash === 'string' ? r.dash : ''
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
        path.setAttribute('opacity', col === '#ffffff' ? (dash ? '0.55' : '0.9') : dash ? '0.92' : '1')
        if (dash) path.setAttribute('stroke-dasharray', dash)
        if (r.id) path.setAttribute('data-route-id', r.id)
        path.style.pointerEvents = 'none'
        svg.appendChild(path)
      }
      // onClick маршрутов — только через map click hit-test (не SVG pointer-events:
      // иначе на мобилке pinch/pan ломается, когда палец над линией/точками).
    }

    // МЦК / МЦД: точки + подписи при достаточном зуме (с антиколлизией)
    type Placed = { x: number; y: number; w: number; h: number }
    const occupied: Placed[] = []
    const labelH = 18
    const overlaps = (a: Placed, b: Placed) =>
      !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y)

    const drawRailDot = (opts: {
      lat: number
      lon: number
      name: string
      label: string
      color: string
      cls: string
      pinned: boolean
    }) => {
      const xy = map.project([opts.lon, opts.lat])
      if (xy.x < -20 || xy.y < -20 || xy.x > w + 20 || xy.y > h + 20) return
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
      g.setAttribute('class', opts.cls)
      if (opts.name) g.setAttribute('data-name', opts.name)
      g.style.pointerEvents = 'none'

      const halo = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      halo.setAttribute('cx', String(xy.x))
      halo.setAttribute('cy', String(xy.y))
      halo.setAttribute('r', '6')
      halo.setAttribute('fill', opts.color)
      halo.setAttribute('opacity', '0.2')
      g.appendChild(halo)
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      dot.setAttribute('cx', String(xy.x))
      dot.setAttribute('cy', String(xy.y))
      dot.setAttribute('r', '3.4')
      dot.setAttribute('fill', opts.color)
      dot.setAttribute('opacity', '0.82')
      dot.setAttribute('stroke', 'rgba(255,255,255,0.9)')
      dot.setAttribute('stroke-width', '1.2')
      g.appendChild(dot)

      if (opts.name && (showLabels || opts.pinned)) {
        const text = opts.label
        const approxW = Math.min(210, Math.max(72, 18 + text.length * 6.2))
        const boxX = xy.x - approxW / 2
        const boxY = xy.y - 28
        const box: Placed = { x: boxX, y: boxY, w: approxW, h: labelH }
        const collides = !opts.pinned && occupied.some((o) => overlaps(box, o))
        if (!collides && boxX > 2 && boxY > 2 && boxX + approxW < w - 2) {
          occupied.push(box)
          const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
          bg.setAttribute('x', String(boxX))
          bg.setAttribute('y', String(boxY))
          bg.setAttribute('width', String(approxW))
          bg.setAttribute('height', String(labelH))
          bg.setAttribute('rx', '6')
          bg.setAttribute('fill', '#fffef8')
          bg.setAttribute('stroke', opts.color)
          bg.setAttribute('stroke-width', '1')
          bg.setAttribute('opacity', '0.96')
          g.appendChild(bg)
          const t = document.createElementNS('http://www.w3.org/2000/svg', 'text')
          t.setAttribute('x', String(xy.x))
          t.setAttribute('y', String(boxY + 12.5))
          t.setAttribute('text-anchor', 'middle')
          t.setAttribute('fill', '#2a1520')
          t.setAttribute('font-size', '11')
          t.setAttribute('font-weight', '700')
          t.setAttribute('font-family', 'system-ui, -apple-system, Segoe UI, sans-serif')
          t.textContent = text
          g.appendChild(t)
        }
      }

      svg!.appendChild(g)
    }

    for (const m of mckDots) {
      const name = (m.name || '').trim()
      drawRailDot({
        lat: m.lat,
        lon: m.lon,
        name,
        label: `МЦК · ${name}`,
        color: '#de64a1',
        cls: 'mp-mck-dot',
        pinned: !!pinnedMckName && name === pinnedMckName,
      })
    }

    for (const m of mcdDots) {
      const name = (m.name || '').trim()
      const lines = (m.linesLabel || 'МЦД').trim()
      const color = m.color || '#40B280'
      const key = `${lines}|${name}`
      drawRailDot({
        lat: m.lat,
        lon: m.lon,
        name,
        label: `${lines} · ${name}`,
        color,
        cls: 'mp-mcd-dot',
        pinned: !!pinnedMcdKey && key === pinnedMcdKey,
      })
    }

    // Точки поверх линии (MapLibre Marker оказывается под SVG-оверлеем)
    const drawLink = (from: LatLon, to: LatLon) => {
      const a = map.project([from.lon, from.lat])
      const b = map.project([to.lon, to.lat])
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      line.setAttribute('x1', String(a.x))
      line.setAttribute('y1', String(a.y))
      line.setAttribute('x2', String(b.x))
      line.setAttribute('y2', String(b.y))
      line.setAttribute('stroke', '#de64a1')
      line.setAttribute('stroke-width', '2.5')
      line.setAttribute('stroke-dasharray', '6 5')
      line.setAttribute('stroke-opacity', '0.9')
      line.setAttribute('class', 'mp-rail-link')
      svg!.appendChild(line)
    }

    const drawEndpoint = (ep: SvgEndpoint) => {
      if (ep.linkTo) {
        drawLink({ lat: ep.lat, lon: ep.lon }, ep.linkTo)
      }
      const xy = map.project([ep.lon, ep.lat])
      const fill =
        ep.kind === 'start'
          ? '#1f8f4a'
          : ep.kind === 'geo'
            ? '#2563eb'
            : ep.kind === 'station'
              ? '#de64a1'
              : '#d32f2f'
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
      g.setAttribute('class', `mp-ep mp-ep-${ep.kind}`)

      const halo = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      halo.setAttribute('cx', String(xy.x))
      halo.setAttribute('cy', String(xy.y))
      halo.setAttribute('r', ep.kind === 'geo' ? '16' : ep.kind === 'station' ? '13' : '14')
      halo.setAttribute('fill', '#fff')
      halo.setAttribute('opacity', '0.95')
      g.appendChild(halo)

      if (ep.kind === 'geo') {
        const pulse = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
        pulse.setAttribute('cx', String(xy.x))
        pulse.setAttribute('cy', String(xy.y))
        pulse.setAttribute('r', '18')
        pulse.setAttribute('fill', '#2563eb')
        pulse.setAttribute('opacity', '0.22')
        g.appendChild(pulse)
      }

      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      dot.setAttribute('cx', String(xy.x))
      dot.setAttribute('cy', String(xy.y))
      dot.setAttribute('r', ep.kind === 'station' ? '8' : '9')
      dot.setAttribute('fill', fill)
      dot.setAttribute('stroke', '#fff')
      dot.setAttribute('stroke-width', '2.5')
      g.appendChild(dot)

      const label = (
        ep.label ||
        (ep.kind === 'start'
          ? 'Старт'
          : ep.kind === 'geo'
            ? 'Вы здесь'
            : ep.kind === 'station'
              ? 'Станция'
              : 'Финиш')
      ).slice(0, 42)
      const approxW = Math.min(220, Math.max(56, 14 + label.length * 7.2))
      const boxH = 22
      const boxX = xy.x - approxW / 2
      const boxY = xy.y - 36

      const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      bg.setAttribute('x', String(boxX))
      bg.setAttribute('y', String(boxY))
      bg.setAttribute('width', String(approxW))
      bg.setAttribute('height', String(boxH))
      bg.setAttribute('rx', '8')
      bg.setAttribute('fill', ep.kind === 'station' ? 'rgba(255,254,248,0.96)' : 'rgba(18,20,18,0.92)')
      bg.setAttribute('stroke', fill)
      bg.setAttribute('stroke-width', '1.5')
      g.appendChild(bg)

      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text')
      text.setAttribute('x', String(xy.x))
      text.setAttribute('y', String(boxY + 15))
      text.setAttribute('text-anchor', 'middle')
      text.setAttribute('fill', ep.kind === 'station' ? '#2a1520' : '#f0f2f0')
      text.setAttribute('font-size', '12')
      text.setAttribute('font-weight', '700')
      text.setAttribute('font-family', 'system-ui, -apple-system, Segoe UI, sans-serif')
      text.textContent = label
      g.appendChild(text)

      svg!.appendChild(g)
    }

    for (const ep of endpoints) drawEndpoint(ep)
    if (pendingGeo) {
      drawEndpoint({
        lat: pendingGeo.lat,
        lon: pendingGeo.lon,
        label: 'Вы здесь',
        kind: 'geo',
      })
    }
  }

  const onMove = (): void => redraw()
  map.on('move', onMove)
  map.on('zoom', onMove)
  map.on('resize', onMove)
  map.on('render', onMove)

  const DOT_HIT_PX = 22
  const ROUTE_HIT_PX = 18

  const distPointSegPx = (
    p: { x: number; y: number },
    a: { x: number; y: number },
    b: { x: number; y: number },
  ): number => {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    if (len2 < 1e-6) {
      const ex = p.x - a.x
      const ey = p.y - a.y
      return Math.hypot(ex, ey)
    }
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
    t = Math.max(0, Math.min(1, t))
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
  }

  const distToRoutePx = (p: { x: number; y: number }, pts: LatLon[]): number => {
    if (pts.length < 2) return Infinity
    const sampled = samplePolylineForSvg(pts, 800, 80)
    let best = Infinity
    let prev = map.project([sampled[0].lon, sampled[0].lat])
    for (let i = 1; i < sampled.length; i++) {
      const cur = map.project([sampled[i].lon, sampled[i].lat])
      best = Math.min(best, distPointSegPx(p, prev, cur))
      prev = cur
    }
    return best
  }

  /** Tap-only hit-test: MapLibre click не срабатывает на drag/pinch — жесты идут на canvas. */
  const onMapTap = (e: maplibregl.MapMouseEvent): void => {
    const p = e.point
    let bestDot: { kind: 'mck' | 'mcd'; d: number; mck?: SvgMckDot; mcd?: SvgMcdDot } | null = null
    for (const m of mckDots) {
      const xy = map.project([m.lon, m.lat])
      const d = Math.hypot(p.x - xy.x, p.y - xy.y)
      if (d <= DOT_HIT_PX && (!bestDot || d < bestDot.d)) bestDot = { kind: 'mck', d, mck: m }
    }
    for (const m of mcdDots) {
      const xy = map.project([m.lon, m.lat])
      const d = Math.hypot(p.x - xy.x, p.y - xy.y)
      if (d <= DOT_HIT_PX && (!bestDot || d < bestDot.d)) bestDot = { kind: 'mcd', d, mcd: m }
    }
    const markHit = () => {
      const oe = e.originalEvent as { __zmSvgHit?: boolean } | undefined
      if (oe) oe.__zmSvgHit = true
    }
    if (bestDot?.kind === 'mck' && bestDot.mck) {
      const name = (bestDot.mck.name || '').trim()
      pinnedMckName = name || null
      pinnedMcdKey = null
      redraw()
      markHit()
      mckClick?.(bestDot.mck)
      return
    }
    if (bestDot?.kind === 'mcd' && bestDot.mcd) {
      const name = (bestDot.mcd.name || '').trim()
      const lines = (bestDot.mcd.linesLabel || 'МЦД').trim()
      pinnedMcdKey = `${lines}|${name}`
      pinnedMckName = null
      redraw()
      markHit()
      mcdClick?.(bestDot.mcd)
      return
    }

    let bestRoute: { d: number; r: SvgRouteDraw } | null = null
    for (const r of routes) {
      if (!r.onClick || r.pts.length < 2) continue
      const d = distToRoutePx(p, r.pts)
      if (d <= ROUTE_HIT_PX && (!bestRoute || d < bestRoute.d)) bestRoute = { d, r }
    }
    if (bestRoute) {
      markHit()
      bestRoute.r.onClick?.()
    }
  }
  map.on('click', onMapTap)

  return {
    setRoutes: (next, nextEnds) => {
      routes = next
      endpoints = nextEnds || []
      redraw()
    },
    setMckDots: (dots) => {
      mckDots = dots || []
      if (pinnedMckName && !mckDots.some((d) => d.name === pinnedMckName)) pinnedMckName = null
      redraw()
    },
    onMckClick: (handler) => {
      mckClick = handler
    },
    setMcdDots: (dots) => {
      mcdDots = dots || []
      if (
        pinnedMcdKey &&
        !mcdDots.some((d) => `${(d.linesLabel || 'МЦД').trim()}|${(d.name || '').trim()}` === pinnedMcdKey)
      ) {
        pinnedMcdKey = null
      }
      redraw()
    },
    onMcdClick: (handler) => {
      mcdClick = handler
    },
    setPendingGeo: (pt) => {
      pendingGeo = pt
      redraw()
    },
    destroy: () => {
      map.off('move', onMove)
      map.off('zoom', onMove)
      map.off('resize', onMove)
      map.off('render', onMove)
      map.off('click', onMapTap)
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

/**
 * Карты для бота без Яндекс Static Maps.
 * - обзор трека: запечённый PNG (bake_route_previews.py)
 * - отрезок / точка: Carto tiles + SVG (sharp) — линия, 🟢 старт, 🔴 финиш
 */
import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'
import { haversineM, pathLengthM } from './geo.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const W = 640
const H = 480
const TILE = 256
const MAX_CACHE = 48
/** @type {Map<string, Buffer>} */
const memCache = new Map()

function dataRoot() {
  const candidates = []
  if (process.env.DATA_DIR) candidates.push(process.env.DATA_DIR)
  candidates.push(join(__dirname, '../data'))
  candidates.push(join(__dirname, '../../public/data'))
  for (const d of candidates) {
    if (d && existsSync(join(d, 'previews'))) return d
    if (d && existsSync(d)) return d
  }
  return candidates[0] || join(__dirname, '../data')
}

function resolveRouteId(opts = {}) {
  if (opts.routeId) return String(opts.routeId)
  const ck = String(opts.cacheKey || '')
  const m = ck.match(/(?:full|fin|seg|addr|near|poi|welcome):([a-z0-9-]+)/i)
  if (m) return m[1]
  if (ck.startsWith('welcome')) return 'zkm-ring'
  return 'zkm-ring'
}

function previewPath(routeId) {
  const root = dataRoot()
  const candidates = [
    join(root, 'previews', `${routeId}.png`),
    join(root, 'previews', 'zkm-ring.png'),
    join(root, 'welcome-ring.png'),
  ]
  return candidates.find((p) => existsSync(p)) || null
}

function readBaked(routeId) {
  const path = previewPath(routeId)
  if (!path) return null
  try {
    return readFileSync(path)
  } catch {
    return null
  }
}

function cacheGet(key) {
  if (!key) return null
  const hit = memCache.get(key)
  if (!hit) return null
  memCache.delete(key)
  memCache.set(key, hit)
  return hit
}

function cacheSet(key, buf) {
  if (!key || !buf) return
  memCache.set(key, buf)
  while (memCache.size > MAX_CACHE) {
    const first = memCache.keys().next().value
    memCache.delete(first)
  }
}

function downsample(points, maxN = 220) {
  if (!points?.length) return []
  if (points.length <= maxN) return points.slice()
  const step = Math.ceil(points.length / maxN)
  const out = []
  for (let i = 0; i < points.length; i += step) out.push(points[i])
  const last = points[points.length - 1]
  const prev = out[out.length - 1]
  if (!prev || prev.lat !== last.lat || prev.lon !== last.lon) out.push(last)
  return out
}

function boundsOf(points) {
  let minLat = Infinity
  let maxLat = -Infinity
  let minLon = Infinity
  let maxLon = -Infinity
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat
    if (p.lat > maxLat) maxLat = p.lat
    if (p.lon < minLon) minLon = p.lon
    if (p.lon > maxLon) maxLon = p.lon
  }
  return { minLat, maxLat, minLon, maxLon }
}

function padBounds(b, frac = 0.14) {
  const dLat = Math.max(b.maxLat - b.minLat, 0.004)
  const dLon = Math.max(b.maxLon - b.minLon, 0.006)
  const pLat = dLat * frac
  const pLon = dLon * frac
  return {
    minLat: b.minLat - pLat,
    maxLat: b.maxLat + pLat,
    minLon: b.minLon - pLon,
    maxLon: b.maxLon + pLon,
  }
}

/** Расширяет bbox под соотношение сторон картинки — без «тонкого коридора» и белых полос. */
function padBoundsAspect(b, width, height, frac = 0.14) {
  let { minLat, maxLat, minLon, maxLon } = padBounds(b, frac)
  const midLat = (minLat + maxLat) / 2
  const mPerLat = 111320
  const mPerLon = 111320 * Math.cos((midLat * Math.PI) / 180)
  let hM = Math.max((maxLat - minLat) * mPerLat, 800)
  let wM = Math.max((maxLon - minLon) * mPerLon, 800)
  const target = width / height
  const cur = wM / hM
  if (cur < target) {
    const needW = hM * target
    const add = (needW - wM) / 2 / mPerLon
    minLon -= add
    maxLon += add
  } else if (cur > target) {
    const needH = wM / target
    const add = (needH - hM) / 2 / mPerLat
    minLat -= add
    maxLat += add
  }
  // минимум ~1.2 км по короткой стороне — Останкино и точечные старты не «ломают» кадр
  hM = (maxLat - minLat) * mPerLat
  wM = (maxLon - minLon) * mPerLon
  const minSide = 1200
  if (hM < minSide) {
    const add = (minSide - hM) / 2 / mPerLat
    minLat -= add
    maxLat += add
  }
  if (wM < minSide) {
    const add = (minSide - wM) / 2 / mPerLon
    minLon -= add
    maxLon += add
  }
  return { minLat, maxLat, minLon, maxLon }
}

function max(a, b) {
  return a > b ? a : b
}

function lon2tile(lon, z) {
  return ((lon + 180) / 360) * 2 ** z
}

function lat2tile(lat, z) {
  const r = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z
}

function tile2lon(x, z) {
  return (x / 2 ** z) * 360 - 180
}

function tile2lat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
}

function fitZoom(b, width, height) {
  for (let z = 16; z >= 8; z--) {
    const x0 = lon2tile(b.minLon, z)
    const x1 = lon2tile(b.maxLon, z)
    const y0 = lat2tile(b.maxLat, z)
    const y1 = lat2tile(b.minLat, z)
    const pxW = Math.abs(x1 - x0) * TILE
    const pxH = Math.abs(y1 - y0) * TILE
    if (pxW <= width * 0.92 && pxH <= height * 0.92) return z
  }
  return 8
}

function project(lon, lat, b, width, height) {
  const x = ((lon - b.minLon) / (b.maxLon - b.minLon)) * width
  const y = ((b.maxLat - lat) / (b.maxLat - b.minLat)) * height
  return [x, y]
}

async function fetchTile(z, x, y) {
  const hosts = ['a', 'b', 'c', 'd']
  const host = hosts[(x + y) % hosts.length]
  const url = `https://${host}.basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'ZelenyMarshrutBot/1.0 (maps preview)' },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`tile ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

async function mosaicBasemap(b, zoom, width, height) {
  const x0 = Math.floor(lon2tile(b.minLon, zoom))
  const x1 = Math.floor(lon2tile(b.maxLon, zoom))
  const y0 = Math.floor(lat2tile(b.maxLat, zoom))
  const y1 = Math.floor(lat2tile(b.minLat, zoom))

  const west = tile2lon(x0, zoom)
  const north = tile2lat(y0, zoom)
  const east = tile2lon(x1 + 1, zoom)
  const south = tile2lat(y1 + 1, zoom)

  const mosaicW = (x1 - x0 + 1) * TILE
  const mosaicH = (y1 - y0 + 1) * TILE
  const composites = []

  const jobs = []
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      jobs.push(
        fetchTile(zoom, x, y)
          .then((buf) => {
            composites.push({
              input: buf,
              left: (x - x0) * TILE,
              top: (y - y0) * TILE,
            })
          })
          .catch(() => {
            /* skip broken tile */
          }),
      )
    }
  }
  await Promise.all(jobs)

  const mosaic = await sharp({
    create: {
      width: mosaicW,
      height: mosaicH,
      channels: 3,
      background: { r: 232, g: 238, b: 232 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer()

  // crop mosaic to exact geographic bounds of b
  const left = Math.max(0, Math.round(((b.minLon - west) / (east - west)) * mosaicW))
  const top = Math.max(0, Math.round(((north - b.maxLat) / (north - south)) * mosaicH))
  const cropW = Math.min(
    mosaicW - left,
    Math.max(32, Math.round(((b.maxLon - b.minLon) / (east - west)) * mosaicW)),
  )
  const cropH = Math.min(
    mosaicH - top,
    Math.max(32, Math.round(((b.maxLat - b.minLat) / (north - south)) * mosaicH)),
  )

  return sharp(mosaic)
    .extract({ left, top, width: cropW, height: cropH })
    .resize(width, height, { fit: 'fill' })
    .png()
    .toBuffer()
}

function overlaySvg(points, start, end, b, width, height, { dim = false, station = null } = {}) {
  const pts = downsample(points, 240)
  const poly = pts
    .map((p) => {
      const [x, y] = project(p.lon, p.lat, b, width, height)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  const s = start || pts[0]
  const e = end || pts[pts.length - 1]
  const [sx, sy] = project(s.lon, s.lat, b, width, height)
  const [ex, ey] = project(e.lon, e.lat, b, width, height)
  const stroke = dim ? '#6a9a72' : '#1b7a3d'
  const sw = dim ? 3.2 : 4.5
  const same =
    Math.abs(s.lat - e.lat) < 1e-5 && Math.abs(s.lon - e.lon) < 1e-5

  let markers = `
    <circle cx="${sx}" cy="${sy}" r="9" fill="#1b7a3d" stroke="#fff" stroke-width="2.5"/>
  `
  if (!same) {
    markers += `
    <circle cx="${ex}" cy="${ey}" r="9" fill="#c62828" stroke="#fff" stroke-width="2.5"/>
    `
  }
  let stationSvg = ''
  if (station && station.lat != null && station.lon != null) {
    const [stx, sty] = project(station.lon, station.lat, b, width, height)
    const color = station.color || '#de64a1'
    const label = escapeSvg(station.label || 'станция')
    stationSvg = `
      <line x1="${stx}" y1="${sty}" x2="${sx}" y2="${sy}" stroke="#ff4d9a" stroke-width="2.2"
        stroke-dasharray="5 4" opacity="0.9"/>
      <circle cx="${stx}" cy="${sty}" r="8" fill="${color}" stroke="#fff" stroke-width="2.2"/>
      <rect x="${stx - 28}" y="${sty - 30}" width="56" height="16" rx="5"
        fill="rgba(18,20,18,0.92)" stroke="${color}" stroke-width="1.2"/>
      <text x="${stx}" y="${sty - 18}" text-anchor="middle" fill="#f0f2f0"
        font-size="10" font-weight="700" font-family="system-ui,sans-serif">${label}</text>
    `
  }

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <polyline points="${poly}" fill="none" stroke="${stroke}" stroke-width="${sw}"
        stroke-linecap="round" stroke-linejoin="round" opacity="0.95"/>
      ${markers}
      ${stationSvg}
    </svg>`,
  )
}

function escapeSvg(t) {
  return String(t)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .slice(0, 12)
}

async function renderDynamic(points, opts = {}) {
  if (!points || points.length < 2) return null
  const start = opts.start || points[0]
  const end = opts.end || points[ptsEnd(points)]
  const extras = [start, end]
  if (opts.user) extras.push(opts.user)
  if (opts.station) extras.push(opts.station)
  const all = [...points, ...extras]
  const b = padBoundsAspect(boundsOf(all), W, H, opts.pad ?? 0.16)
  const zoom = fitZoom(b, W, H)
  try {
    const base = await mosaicBasemap(b, zoom, W, H)
    const svg = overlaySvg(points, start, end, b, W, H, {
      dim: Boolean(opts.dim),
      station: opts.station || null,
    })
    let img = sharp(base).composite([{ input: svg, top: 0, left: 0 }])
    if (opts.user) {
      const [ux, uy] = project(opts.user.lon, opts.user.lat, b, W, H)
      const userSvg = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
          <circle cx="${ux}" cy="${uy}" r="18" fill="#2563eb" opacity="0.22"/>
          <circle cx="${ux}" cy="${uy}" r="11" fill="#2563eb" stroke="#fff" stroke-width="3"/>
          <rect x="${ux - 36}" y="${uy - 34}" width="72" height="18" rx="6"
            fill="rgba(18,20,18,0.92)" stroke="#2563eb" stroke-width="1.5"/>
          <text x="${ux}" y="${uy - 21}" text-anchor="middle" fill="#f0f2f0"
            font-size="11" font-weight="700" font-family="system-ui,sans-serif">Вы здесь</text>
        </svg>`,
      )
      img = sharp(await img.png().toBuffer()).composite([{ input: userSvg, top: 0, left: 0 }])
    }
    return await img.png().toBuffer()
  } catch (e) {
    console.warn('[staticmap] dynamic fail', e?.message || e)
    return null
  }
}

function ptsEnd(points) {
  return points[points.length - 1]
}

/** Окно трека вокруг точки (~radiusM вдоль линии). */
function windowAround(track, point, radiusM = 4500) {
  if (!track?.length) return [point, point]
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < track.length; i++) {
    const d = haversineM(track[i], point)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  let lo = best
  let hi = best
  let acc = 0
  while (lo > 0 && acc < radiusM) {
    acc += haversineM(track[lo - 1], track[lo])
    lo--
  }
  acc = 0
  while (hi < track.length - 1 && acc < radiusM) {
    acc += haversineM(track[hi], track[hi + 1])
    hi++
  }
  const slice = track.slice(lo, hi + 1)
  return slice.length >= 2 ? slice : [track[best], track[Math.min(best + 1, track.length - 1)]]
}

/**
 * Полный трек / сегмент.
 * Если points ≥ 2 (не full-обзор) — динамическая карта со стартом/финишем.
 */
export async function fetchRouteMapPng(points, opts = {}) {
  const key = opts.cacheKey ? `route:${opts.cacheKey}` : null
  const cached = cacheGet(key)
  if (cached) return cached

  const pts = Array.isArray(points) ? points : []
  const isFullOverview =
    String(opts.cacheKey || '').startsWith('full:') ||
    (pts.length > 800 && pathLengthM(pts) > 80000 && !opts.start && !opts.end)

  if (pts.length >= 2 && !isFullOverview) {
    const png = await renderDynamic(pts, {
      start: opts.start || pts[0],
      end: opts.end || pts[pts.length - 1],
      user: opts.user,
      station: opts.station || null,
      pad: opts.pad,
    })
    if (png) {
      cacheSet(key, png)
      return png
    }
  }

  if (pts.length >= 2 && isFullOverview) {
    const baked = readBaked(resolveRouteId(opts))
    if (baked) {
      cacheSet(key, baked)
      return baked
    }
    const png = await renderDynamic(downsample(pts, 300), {
      start: pts[0],
      end: pts[0],
      pad: 0.08,
    })
    if (png) {
      cacheSet(key, png)
      return png
    }
  }

  const baked = readBaked(resolveRouteId(opts))
  if (baked) cacheSet(key, baked)
  return baked
}

/**
 * Точка старта / POI: зум к месту + зелёный маркер (и кусок трека, если передан).
 */
export async function fetchPointMapPng(point, opts = {}) {
  if (!point || point.lat == null || point.lon == null) {
    return readBaked(resolveRouteId(opts))
  }
  const key = opts.cacheKey ? `pt:${opts.cacheKey}` : null
  const cached = cacheGet(key)
  if (cached) return cached

  let trackPts = opts.track
  if (!trackPts && opts.routeId) {
    try {
      const { loadTrackPoints } = await import('./routes.js')
      trackPts = loadTrackPoints(opts.routeId)
    } catch {
      trackPts = null
    }
  }

  const window = trackPts?.length
    ? windowAround(trackPts, point, opts.radiusM ?? 3200)
    : [
        { lat: point.lat - 0.01, lon: point.lon - 0.015 },
        point,
        { lat: point.lat + 0.01, lon: point.lon + 0.015 },
      ]
  if (opts.station) {
    // чтобы станция не обрезалась краем кадра
    window.push(opts.station)
  }

  const png = await renderDynamic(window, {
    start: point,
    end: point, // только зелёный
    user: opts.user,
    station: opts.station || null,
    pad: 0.22,
  })
  if (png) {
    cacheSet(key, png)
    return png
  }
  return readBaked(resolveRouteId(opts))
}

export function yandexStaticMapUrl() {
  return null
}

export function yandexPointMapUrl() {
  return null
}

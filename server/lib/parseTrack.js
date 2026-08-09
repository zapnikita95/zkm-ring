/**
 * GPX / KML / FIT → [{lat, lon}, ...]
 */
import { XMLParser } from 'fast-xml-parser'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const FitParser = require('fit-file-parser')

const R = 6371000

function hav(a, b) {
  const φ1 = (a.lat * Math.PI) / 180
  const φ2 = (b.lat * Math.PI) / 180
  const Δφ = ((b.lat - a.lat) * Math.PI) / 180
  const Δλ = ((b.lon - a.lon) * Math.PI) / 180
  const s =
    Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}

export function pathLengthM(pts) {
  let sum = 0
  for (let i = 1; i < pts.length; i++) sum += hav(pts[i - 1], pts[i])
  return sum
}

function densify(pts, maxM = 40) {
  if (pts.length < 2) return pts.slice()
  const out = [pts[0]]
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const d = hav(a, b)
    const n = Math.max(1, Math.ceil(d / maxM))
    for (let k = 1; k <= n; k++) {
      const t = k / n
      out.push({
        lat: a.lat + (b.lat - a.lat) * t,
        lon: a.lon + (b.lon - a.lon) * t,
      })
    }
  }
  return out
}

function cleanPts(raw) {
  const out = []
  for (const p of raw) {
    const lat = Number(p.lat)
    const lon = Number(p.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue
    if (out.length && hav(out[out.length - 1], { lat, lon }) < 1.5) continue
    out.push({ lat, lon })
  }
  return out
}

function detectFormat(filename, mime, buf) {
  const name = String(filename || '').toLowerCase()
  const m = String(mime || '').toLowerCase()
  if (name.endsWith('.fit') || m.includes('fit')) return 'fit'
  if (name.endsWith('.kml') || m.includes('kml')) return 'kml'
  if (name.endsWith('.gpx') || m.includes('gpx')) return 'gpx'
  // sniff
  const head = buf.slice(0, 200).toString('utf8').trimStart()
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    if (/<gpx[\s>]/i.test(head) || /<trkpt/i.test(buf.toString('utf8', 0, 4000))) return 'gpx'
    if (/<kml[\s>]/i.test(head) || /<Placemark/i.test(head)) return 'kml'
  }
  // FIT binary often starts with '.FIT'
  if (buf.length > 12 && buf.toString('ascii', 8, 12) === '.FIT') return 'fit'
  return null
}

function parseGpx(text) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => ['trkpt', 'rtept', 'wpt'].includes(name),
  })
  const doc = parser.parse(text)
  const pts = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const n of node) walk(n)
      return
    }
    if (node['@_lat'] != null && node['@_lon'] != null) {
      pts.push({ lat: Number(node['@_lat']), lon: Number(node['@_lon']) })
    }
    for (const v of Object.values(node)) walk(v)
  }
  walk(doc)
  return cleanPts(pts)
}

function parseKml(text) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => ['Placemark', 'LineString', 'coordinates'].includes(name),
  })
  const doc = parser.parse(text)
  const blobs = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const n of node) walk(n)
      return
    }
    if (typeof node.coordinates === 'string') blobs.push(node.coordinates)
    else if (Array.isArray(node.coordinates)) {
      for (const c of node.coordinates) if (typeof c === 'string') blobs.push(c)
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'coordinates') continue
      walk(v)
    }
  }
  walk(doc)
  // pick longest coordinate blob (main track)
  let best = ''
  for (const b of blobs) {
    if (b.length > best.length) best = b
  }
  const pts = []
  for (const tok of best.replace(/\n/g, ' ').split(/\s+/)) {
    const parts = tok.split(',')
    if (parts.length < 2) continue
    pts.push({ lon: Number(parts[0]), lat: Number(parts[1]) })
  }
  return cleanPts(pts)
}

function parseFit(buf) {
  return new Promise((resolve, reject) => {
    const fit = new FitParser({ force: true, speedUnit: 'km/h', lengthUnit: 'm' })
    fit.parse(buf, (err, data) => {
      if (err) return reject(err)
      const pts = []
      const records = data?.records || []
      for (const r of records) {
        if (r.position_lat == null || r.position_long == null) continue
        pts.push({ lat: Number(r.position_lat), lon: Number(r.position_long) })
      }
      resolve(cleanPts(pts))
    })
  })
}

/**
 * @param {Buffer} buf
 * @param {{ filename?: string, mime?: string }} meta
 */
export async function parseTrackBuffer(buf, meta = {}) {
  const format = detectFormat(meta.filename, meta.mime, buf)
  if (!format) {
    const err = new Error('Неизвестный формат. Нужен GPX, KML или FIT.')
    err.code = 'FORMAT'
    throw err
  }
  let pts
  if (format === 'fit') pts = await parseFit(buf)
  else {
    const text = buf.toString('utf8')
    pts = format === 'kml' ? parseKml(text) : parseGpx(text)
  }
  if (pts.length < 2) {
    const err = new Error('В файле слишком мало точек трека.')
    err.code = 'EMPTY'
    throw err
  }
  pts = densify(pts, 45)
  if (pts.length > 15000) {
    const step = Math.ceil(pts.length / 12000)
    pts = pts.filter((_, i) => i === 0 || i === pts.length - 1 || i % step === 0)
  }
  const lengthM = pathLengthM(pts)
  if (lengthM < 200) {
    const err = new Error('Трек слишком короткий (меньше 200 м).')
    err.code = 'SHORT'
    throw err
  }
  return { format, points: pts, lengthM }
}

export function pointsToGeojson(points, props = {}) {
  return {
    type: 'Feature',
    properties: props,
    geometry: {
      type: 'LineString',
      coordinates: points.map((p) => [p.lon, p.lat]),
    },
  }
}

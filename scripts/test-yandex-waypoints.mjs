/**
 * Dense vias + multi-chunk Yandex: apex retained across legs; long routes → many URLs.
 * Kasatkina bbox: no long via gaps; all vias on-track.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  chunkPointsForYandex,
  denseWaypointsForYandex,
  densifyRouteForYandex,
  expandRouteWithEdgeMidpoints,
  yandexMapsLegs,
  yandexMapsUrl,
} from '../bot/lib/yandex.js'
import { haversineM, pathLengthM } from '../bot/lib/geo.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

// Synthetic V: north, then sharp east turn at apex, then south-east
const apex = { lat: 55.82, lon: 37.68 }
const route = []
for (let i = 0; i < 40; i++) {
  route.push({ lat: 55.8 + i * 0.0005, lon: 37.65 })
}
route.push(apex)
for (let i = 1; i <= 40; i++) {
  route.push({ lat: apex.lat - i * 0.0004, lon: apex.lon + i * 0.0006 })
}

const pts = densifyRouteForYandex(route)
assert(pts.length >= 3, `expected ≥3 vias, got ${pts.length}`)
assert(pts.length <= 14, `budget ≤14, got ${pts.length}`)

const nearApex = pts.some((p) => Math.hypot(p.lat - apex.lat, p.lon - apex.lon) < 0.0008)
assert(nearApex, 'apex of V-turn must be among waypoints (not only even samples)')

const dense = denseWaypointsForYandex(route)
assert(
  dense.some((p) => Math.hypot(p.lat - apex.lat, p.lon - apex.lon) < 0.0008),
  'dense must keep V apex',
)

const url = yandexMapsUrl(route, 'bike')
const rtext = new URL(url).searchParams.get('rtext') || ''
const vias = rtext.split('~').filter(Boolean)
assert(vias.length >= 2, 'URL must have start/end')
assert(vias.length <= 14, `single URL ≤14 vias, got ${vias.length}`)

// ~60 km class: must split into several legs (not one sparse URL)
const long = []
for (let i = 0; i < 600; i++) {
  long.push({ lat: 55.7 + i * 0.0009, lon: 37.5 + Math.sin(i / 15) * 0.008 })
}
const longM = pathLengthM(long)
const legs = yandexMapsLegs(long, 'bike')
assert(legs.length >= 3, `60km-class should be ≥3 Yandex legs, got ${legs.length}`)
for (const leg of legs) {
  assert(leg.points.length <= 14, `leg vias ≤14, got ${leg.points.length}`)
  assert(leg.points.length >= 2, 'leg needs ≥2 points')
  const u = new URL(leg.url)
  assert(u.searchParams.get('rtt') === 'bc', 'bike rtt')
}
// overlap: end of leg i == start of leg i+1
for (let i = 0; i < legs.length - 1; i++) {
  const a = legs[i].points[legs[i].points.length - 1]
  const b = legs[i + 1].points[0]
  assert(a.lat === b.lat && a.lon === b.lon, `legs ${i}/${i + 1} must share endpoint`)
}

const chunks = chunkPointsForYandex(denseWaypointsForYandex(long))
assert(chunks.length === legs.length, 'chunk count matches legs')

// Long edge must get midpoints in expand
const sparse = [
  { lat: 55.84, lon: 37.63 },
  { lat: 55.84, lon: 37.64 }, // ~600m east
]
const expanded = expandRouteWithEdgeMidpoints(sparse, 150)
assert(expanded.length >= 4, `expand midpoints on ~600m edge, got ${expanded.length}`)

// Kasatkina / Botan ~5 km on official ring
const ringGj = JSON.parse(readFileSync(join(ROOT, 'public/data/ring.geojson'), 'utf8'))
const ring = ringGj.features[0].geometry.coordinates.map(([lon, lat]) => ({ lat, lon }))
const botan = { lat: 55.8455, lon: 37.6385 }
let bi = 0
let bd = Infinity
for (let i = 0; i < ring.length; i++) {
  const d = haversineM(ring[i], botan)
  if (d < bd) {
    bd = d
    bi = i
  }
}
// take ~5km CW
const seg = [ring[bi]]
let acc = 0
for (let i = bi + 1; i < ring.length && acc < 5000; i++) {
  acc += haversineM(seg[seg.length - 1], ring[i])
  seg.push(ring[i])
}
const viasK = denseWaypointsForYandex(seg)
let maxGap = 0
for (let i = 0; i < viasK.length - 1; i++) {
  maxGap = Math.max(maxGap, haversineM(viasK[i], viasK[i + 1]))
}
assert(maxGap < 220, `Kasatkina max via gap <220m, got ${maxGap.toFixed(0)}`)
for (const v of viasK) {
  let best = Infinity
  for (const q of seg) best = Math.min(best, haversineM(v, q))
  assert(best < 25, `via off track ${best.toFixed(0)}m at ${v.lat},${v.lon}`)
}
// vias in Kasatkina lon band should sit north of old chord (~55.8404)
const inBand = viasK.filter((v) => v.lon > 37.637 && v.lon < 37.642)
assert(inBand.some((v) => v.lat > 55.8415), 'expect via on RuTrail-north detour near Kasatkina')

console.log('OK yandex multi-leg', {
  vTurn: pts.length,
  denseV: dense.length,
  longKm: (longM / 1000).toFixed(1),
  legs: legs.length,
  firstLegVias: legs[0].points.length,
  kasatkinaVias: viasK.length,
  maxGap: Math.round(maxGap),
  kasatkinaUrl: yandexMapsLegs(seg, 'bike')[0]?.url,
})

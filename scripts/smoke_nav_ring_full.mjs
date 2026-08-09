/**
 * Full sliding-window sweep: vias on-track + chord-vs-track for both rings × CW/CCW.
 * Exit ≠ 0 if any fail. Writes .local/nav_sweep_report.json
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { haversineM, pathLengthM } from '../bot/lib/geo.js'
import { denseWaypointsForYandex, yandexMapsLegs } from '../bot/lib/yandex.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT = join(ROOT, '.local', 'nav_sweep_report.json')

const ON_TRACK_M = 20
const CHORD_DEV_M = 100
const MAX_VIA_GAP_M = 230
const WINDOW_MS = [3000, 5000, 10000]
const STEP_M = 1000

const RINGS = [
  { id: 'zkm-ring', path: 'public/data/ring.geojson' },
  { id: 'zkm-rutrail', path: 'public/data/ring-rutrail.geojson' },
]

// Botan garden area — always scored as a dedicated case (Alex report)
const BOTAN = { lat: 55.8455, lon: 37.6385 }

function loadRing(rel) {
  const g = JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))
  const coords = g.features[0].geometry.coordinates
  const pts = coords.map(([lon, lat]) => ({ lat, lon }))
  if (pts.length > 2 && haversineM(pts[0], pts[pts.length - 1]) < 5) return pts.slice(0, -1)
  return pts
}

function cum(pts) {
  const c = [0]
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + haversineM(pts[i - 1], pts[i]))
  return c
}

function takeWindow(pts, startM, winM) {
  const c = cum(pts)
  const total = c[c.length - 1]
  const s = ((startM % total) + total) % total
  const e = s + winM
  // unwrap by rotating
  let startIdx = 0
  while (startIdx < c.length - 1 && c[startIdx + 1] < s) startIdx++
  const out = []
  let acc = 0
  let i = startIdx
  out.push(pts[i])
  while (acc < winM) {
    const ni = (i + 1) % pts.length
    const d = haversineM(pts[i], pts[ni])
    if (acc + d >= winM) {
      const t = (winM - acc) / d
      out.push({
        lat: pts[i].lat + (pts[ni].lat - pts[i].lat) * t,
        lon: pts[i].lon + (pts[ni].lon - pts[i].lon) * t,
      })
      break
    }
    acc += d
    out.push(pts[ni])
    i = ni
    if (out.length > pts.length + 5) break
  }
  return out
}

function distToTrack(p, track) {
  let best = Infinity
  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i]
    const b = track[i + 1]
    // sample 5 points on segment
    for (let k = 0; k <= 4; k++) {
      const t = k / 4
      const q = { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t }
      const d = haversineM(p, q)
      if (d < best) best = d
    }
  }
  // also verts
  for (const q of track) {
    const d = haversineM(p, q)
    if (d < best) best = d
  }
  return best
}

function chordDeviation(a, b, track) {
  // max dist of chord mid thirds from track
  let mx = 0
  for (const t of [0.25, 0.5, 0.75]) {
    const p = {
      lat: a.lat + (b.lat - a.lat) * t,
      lon: a.lon + (b.lon - a.lon) * t,
    }
    mx = Math.max(mx, distToTrack(p, track))
  }
  return mx
}

function scoreSegment(track, label) {
  const fails = []
  const dense = denseWaypointsForYandex(track)
  const legs = yandexMapsLegs(track, 'bike')
  for (let vi = 0; vi < dense.length; vi++) {
    const d = distToTrack(dense[vi], track)
    if (d > ON_TRACK_M) {
      fails.push({
        kind: 'off_track',
        label,
        via: vi,
        dist: Math.round(d),
        lat: dense[vi].lat,
        lon: dense[vi].lon,
      })
    }
  }
  for (let i = 0; i < dense.length - 1; i++) {
    const gap = haversineM(dense[i], dense[i + 1])
    if (gap > MAX_VIA_GAP_M) {
      fails.push({
        kind: 'via_gap',
        label,
        via: i,
        gap: Math.round(gap),
        a: dense[i],
        b: dense[i + 1],
      })
    }
    const dev = chordDeviation(dense[i], dense[i + 1], track)
    if (dev > CHORD_DEV_M) {
      fails.push({
        kind: 'chord_cut',
        label,
        via: i,
        dev: Math.round(dev),
        gap: Math.round(gap),
        a: dense[i],
        b: dense[i + 1],
      })
    }
  }
  return { fails, viaCount: dense.length, legs: legs.length, url: legs[0]?.url || null }
}

function nearestAlong(pts, p) {
  let best = 0
  let bd = Infinity
  const c = cum(pts)
  for (let i = 0; i < pts.length; i++) {
    const d = haversineM(pts[i], p)
    if (d < bd) {
      bd = d
      best = i
    }
  }
  return c[best]
}

function main() {
  const allFails = []
  const cases = []
  let checked = 0

  for (const ring of RINGS) {
    const base = loadRing(ring.path)
    for (const dir of ['cw', 'ccw']) {
      const pts = dir === 'cw' ? base.slice() : [base[0], ...base.slice(1).reverse()]
      const total = pathLengthM(pts)

      // Botan dedicated 5km
      const botanStart = nearestAlong(pts, BOTAN)
      for (const win of [5000]) {
        const seg = takeWindow(pts, botanStart, win)
        const label = `${ring.id}/${dir}/botan-${win}`
        const r = scoreSegment(seg, label)
        checked++
        cases.push({ label, viaCount: r.viaCount, legs: r.legs, fails: r.fails.length, url: r.url })
        allFails.push(...r.fails)
      }

      for (const win of WINDOW_MS) {
        for (let start = 0; start < total; start += STEP_M) {
          const seg = takeWindow(pts, start, win)
          if (pathLengthM(seg) < win * 0.85) continue
          const label = `${ring.id}/${dir}/w${win}@${Math.round(start)}`
          const r = scoreSegment(seg, label)
          checked++
          if (r.fails.length) {
            cases.push({
              label,
              viaCount: r.viaCount,
              legs: r.legs,
              fails: r.fails.length,
              url: r.url,
              sample: r.fails.slice(0, 3),
            })
          }
          allFails.push(...r.fails.map((f) => ({ ...f, label })))
        }
      }
    }
  }

  mkdirSync(dirname(OUT), { recursive: true })
  const report = {
    checked,
    failCount: allFails.length,
    failKinds: allFails.reduce((acc, f) => {
      acc[f.kind] = (acc[f.kind] || 0) + 1
      return acc
    }, {}),
    botanCases: cases.filter((c) => c.label.includes('botan')),
    failCases: cases.filter((c) => c.fails > 0).slice(0, 80),
    failsSample: allFails.slice(0, 40),
  }
  writeFileSync(OUT, JSON.stringify(report, null, 2))
  console.log(
    JSON.stringify(
      {
        checked,
        failCount: allFails.length,
        failKinds: report.failKinds,
        botan: report.botanCases,
        report: OUT,
      },
      null,
      2,
    ),
  )
  if (allFails.length) {
    console.error(`FAIL: ${allFails.length} issues — see ${OUT}`)
    process.exit(1)
  }
  console.log('OK nav sweep: 0 fails')
}

main()

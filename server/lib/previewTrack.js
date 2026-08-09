/**
 * PNG превью трека: Yandex Static (если есть ключ) → иначе matplotlib.
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync, unlinkSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const YKEY = process.env.YANDEX_STATIC_KEY || ''

function downsample(points, maxN = 90) {
  if (points.length <= maxN) return points
  const step = Math.ceil(points.length / maxN)
  const out = []
  for (let i = 0; i < points.length; i += step) out.push(points[i])
  const last = points[points.length - 1]
  if (
    out.length &&
    (out[out.length - 1].lat !== last.lat || out[out.length - 1].lon !== last.lon)
  ) {
    out.push(last)
  }
  return out
}

async function yandexStaticPng(points) {
  if (!YKEY) return null
  const pts = downsample(points, 90)
  const pl = pts.map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join(',')
  const url =
    `https://static-maps.yandex.ru/1.x/?lang=ru_RU&l=map&size=650,450` +
    `&pl=c:3d9a55ff,w:4,${pl}&apikey=${encodeURIComponent(YKEY)}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 800) return null
    return buf
  } catch {
    return null
  }
}

function matplotlibPng(points) {
  const pts = downsample(points, 400)
  const dir = mkdtempSync(join(tmpdir(), 'zm-prev-'))
  const jsonPath = join(dir, 'pts.json')
  const pngPath = join(dir, 'out.png')
  writeFileSync(jsonPath, JSON.stringify(pts))
  const py = `
import json
try:
  import matplotlib
  matplotlib.use('Agg')
  import matplotlib.pyplot as plt
except Exception as e:
  raise SystemExit('no-matplotlib')
pts=json.load(open(${JSON.stringify(jsonPath)}))
xs=[p['lon'] for p in pts]; ys=[p['lat'] for p in pts]
fig,ax=plt.subplots(figsize=(6.5,4.5), dpi=110)
ax.set_facecolor('#e8efe8')
fig.patch.set_facecolor('#e8efe8')
ax.plot(xs, ys, color='#1b7a3d', lw=2.2)
ax.scatter([xs[0]],[ys[0]], c='#1b7a3d', s=36, zorder=5)
ax.scatter([xs[-1]],[ys[-1]], c='#c62828', s=36, zorder=5)
ax.set_aspect('equal')
ax.axis('off')
fig.tight_layout(pad=0.2)
fig.savefig(${JSON.stringify(pngPath)}, bbox_inches='tight', pad_inches=0.08)
`
  try {
    const r = spawnSync('python3', ['-c', py], { encoding: 'utf8', timeout: 25000 })
    if (r.status !== 0) return null
    return readFileSync(pngPath)
  } catch {
    return null
  } finally {
    try {
      unlinkSync(jsonPath)
      unlinkSync(pngPath)
    } catch {
      /* ignore */
    }
  }
}

export async function renderTrackPreviewPng(points) {
  if (!points?.length) return null
  const ya = await yandexStaticPng(points)
  if (ya) return ya
  return matplotlibPng(points)
}

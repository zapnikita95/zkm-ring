/**
 * Headless: участок на карте должен перекрашиваться (dim ring + bright segment).
 * Usage: node scripts/test-slice-map.mjs
 */
import { chromium } from 'playwright'
import { createServer } from 'http'
import { readFileSync, existsSync } from 'fs'
import { join, extname } from 'path'
import { fileURLToPath } from 'url'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const dist = join(root, 'dist')

const mime = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.geojson': 'application/geo+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
}

function serveDist(port) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let path = (req.url || '/').split('?')[0]
      if (path === '/') path = '/index.html'
      const file = join(dist, path)
      if (!file.startsWith(dist) || !existsSync(file)) {
        res.writeHead(404)
        res.end('missing')
        return
      }
      res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' })
      res.end(readFileSync(file))
    })
    server.listen(port, () => resolve(server))
  })
}

const port = 4177
const server = await serveDist(port)
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
const logs = []
page.on('console', (m) => logs.push(m.text()))

await page.addInitScript(() => {
  localStorage.setItem('zm-onboarded-v1', '1')
})

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' })
const startBtn = page.locator('#btn-start')
if (await startBtn.count()) await startBtn.click()

await page.waitForSelector('#planner-map-host', { timeout: 20000 })
await page.waitForTimeout(2000)

// тап по карте → старт на кольце
const box = await page.locator('#planner-map-host').boundingBox()
if (!box) throw new Error('no map host')
await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.55)
await page.waitForTimeout(1200)

await page.click('#btn-slice')
await page.waitForTimeout(200)
await page.fill('#inp-val', '15')
await page.keyboard.press('Enter')
await page.waitForTimeout(1000)

const chip = await page.locator('#map-chip').textContent()
const segM = await page.locator('#map-chip').getAttribute('data-seg-m')
const segLog = logs.filter((l) => l.includes('[planner] segment paint'))
const svgPaths = await page.locator('.mp-route-svg path').count()
const strokes = await page.$$eval('.mp-route-svg path', (nodes) =>
  nodes.map((n) => ({ stroke: n.getAttribute('stroke'), w: n.getAttribute('stroke-width') })),
)

console.log('CHIP:', chip)
console.log('data-seg-m:', segM)
console.log('segment logs:', segLog.slice(-2))
console.log('svg strokes:', strokes)

const hasGreenFat = strokes.some((s) => s.stroke === '#00c853' && Number(s.w) >= 10)
const hasDim = strokes.some((s) => s.stroke === '#9e9e9e')
const metersOk = segM && Number(segM) > 5000 && Number(segM) < 25000

const ok = chip?.includes('участок') && segLog.length > 0 && hasGreenFat && hasDim && metersOk && svgPaths >= 4

await browser.close()
server.close()

if (!ok) {
  console.error('FAIL: expected dim ring + bright ~15km segment on map')
  process.exit(1)
}
console.log('PASS: segment visible on planner map')

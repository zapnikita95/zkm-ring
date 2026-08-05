/**
 * Thin HTTPS reverse proxy on Layero (RF) → Railway API upstream.
 * Keeps SQLite persistence on Railway volume while phones in Russia
 * hit a *.layero.app host without VPN.
 */
import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'

const UPSTREAM = (process.env.UPSTREAM_URL || '').replace(/\/$/, '')
const PORT = Number(process.env.PORT || 3000)

if (!UPSTREAM) {
  console.error('[zm-proxy] UPSTREAM_URL is required')
  process.exit(1)
}

const upstreamUrl = new URL(UPSTREAM)
const transport = upstreamUrl.protocol === 'https:' ? https : http

const server = http.createServer((req, res) => {
  if (req.url === '/__proxy_health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, upstream: UPSTREAM }))
    return
  }

  const target = new URL(req.url || '/', UPSTREAM)
  const headers = { ...req.headers, host: upstreamUrl.host }
  delete headers['content-length']

  const proxyReq = transport.request(
    target,
    { method: req.method, headers, timeout: 60_000 },
    (proxyRes) => {
      const outHeaders = { ...proxyRes.headers }
      // Allow Capacitor / browser apps from any origin (API also sets CORS).
      outHeaders['access-control-allow-origin'] = '*'
      outHeaders['access-control-allow-headers'] = 'Authorization, Content-Type'
      outHeaders['access-control-allow-methods'] = 'GET,POST,PUT,PATCH,DELETE,OPTIONS'
      res.writeHead(proxyRes.statusCode || 502, outHeaders)
      proxyRes.pipe(res)
    },
  )

  proxyReq.on('timeout', () => {
    proxyReq.destroy()
    if (!res.headersSent) {
      res.writeHead(504, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'upstream timeout' }))
    }
  })
  proxyReq.on('error', (err) => {
    console.error('[zm-proxy]', err.message)
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'bad gateway', detail: err.message }))
    }
  })

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'Authorization, Content-Type',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    })
    res.end()
    return
  }

  req.pipe(proxyReq)
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[zm-proxy] :${PORT} → ${UPSTREAM}`)
})

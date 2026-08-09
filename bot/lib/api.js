/** Клиент API: Layero proxy (РФ без VPN) → Railway upstream. */
import { createHmac } from 'node:crypto'

const API_BASE = (process.env.ZM_API_BASE || 'https://green-route.layero.app').replace(/\/$/, '')
const BOT_SECRET = process.env.ZM_BOT_UPLOAD_SECRET || ''

function headers(telegramId, extra = {}) {
  const h = { ...extra }
  if (BOT_SECRET) h['X-Bot-Secret'] = BOT_SECRET
  if (telegramId) h['X-Telegram-Id'] = String(telegramId)
  return h
}

export async function apiUploadTrack(telegramId, buffer, filename) {
  const fd = new FormData()
  fd.append('file', new Blob([buffer]), filename || 'track.gpx')
  const res = await fetch(`${API_BASE}/api/tracks/upload`, {
    method: 'POST',
    headers: headers(telegramId),
    body: fd,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

export async function apiListTracks(telegramId) {
  const res = await fetch(`${API_BASE}/api/tracks`, {
    headers: headers(telegramId),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data.items || []
}

export async function apiGetTrack(telegramId, id) {
  const res = await fetch(`${API_BASE}/api/tracks/${id}`, {
    headers: headers(telegramId),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data.track
}

export async function apiPreviewPng(telegramId, id) {
  const res = await fetch(`${API_BASE}/api/tracks/${id}/preview.png`, {
    headers: headers(telegramId),
  })
  if (!res.ok) return null
  return Buffer.from(await res.arrayBuffer())
}

export async function apiTrackEvent(telegramId, event, extra = {}) {
  try {
    const res = await fetch(`${API_BASE}/api/analytics/bot`, {
      method: 'POST',
      headers: headers(telegramId, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        telegramId: String(telegramId),
        event,
        ...extra,
      }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** URL-кнопка Telegram не даёт callback → считаем клик через signed redirect. */
export function trackedYandexUrl(telegramId, yandexUrl, ttlSec = 7 * 24 * 3600) {
  if (!yandexUrl || !BOT_SECRET) return yandexUrl
  try {
    const target = new URL(yandexUrl)
    if (!/(^|\.)yandex\.(ru|com)$/i.test(target.hostname)) return yandexUrl
  } catch {
    return yandexUrl
  }
  const tg = String(telegramId || '')
  const exp = Math.floor(Date.now() / 1000) + ttlSec
  const payload = `${tg}|${exp}|${yandexUrl}`
  const sig = createHmac('sha256', BOT_SECRET).update(payload).digest('hex')
  const q = new URLSearchParams({
    u: yandexUrl,
    tg,
    exp: String(exp),
    sig,
  })
  return `${API_BASE}/api/go/yandex?${q.toString()}`
}

export { API_BASE }

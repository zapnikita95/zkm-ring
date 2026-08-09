/**
 * Зелёный Маршрут — API (логин/пароль, статистика, ачивки, anti-spam по IP)
 */
import express from 'express'
import cors from 'cors'
import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import { randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import rateLimit from 'express-rate-limit'
import multer from 'multer'
import { parseTrackBuffer, pointsToGeojson } from './lib/parseTrack.js'
import { renderTrackPreviewPng } from './lib/previewTrack.js'
import { initAnalytics, trackEvent, buildStats } from './lib/analytics.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.ZM_DATA_DIR || join(__dirname, 'data')
mkdirSync(DATA_DIR, { recursive: true })
const db = new Database(join(DATA_DIR, 'zm.sqlite'))

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    total_meters REAL NOT NULL DEFAULT 0,
    total_seconds REAL NOT NULL DEFAULT 0,
    routes_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS achievements (
    user_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    earned_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, code)
  );
  CREATE TABLE IF NOT EXISTS landmark_visits (
    user_id INTEGER NOT NULL,
    landmark_id TEXT NOT NULL,
    category TEXT NOT NULL,
    visited_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, landmark_id)
  );
  CREATE TABLE IF NOT EXISTS route_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    meters REAL NOT NULL,
    seconds REAL NOT NULL,
    mode TEXT NOT NULL,
    landmarks_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    start_label TEXT NOT NULL DEFAULT '',
    end_label TEXT NOT NULL DEFAULT '',
    direction TEXT NOT NULL DEFAULT '',
    route_json TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS saved_tracks (
    id TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    guest_token TEXT,
    telegram_id TEXT,
    title TEXT NOT NULL DEFAULT '',
    source_filename TEXT NOT NULL DEFAULT '',
    source_format TEXT NOT NULL DEFAULT '',
    geojson TEXT NOT NULL,
    points_count INTEGER NOT NULL DEFAULT 0,
    length_m REAL NOT NULL DEFAULT 0,
    preview_png BLOB,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_saved_tracks_user ON saved_tracks(user_id);
  CREATE INDEX IF NOT EXISTS idx_saved_tracks_guest ON saved_tracks(guest_token);
  CREATE TABLE IF NOT EXISTS saved_plans (
    id TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    guest_token TEXT,
    title TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL,
    length_m REAL NOT NULL DEFAULT 0,
    is_public INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_saved_plans_user ON saved_plans(user_id);
  CREATE INDEX IF NOT EXISTS idx_saved_plans_guest ON saved_plans(guest_token);
  CREATE INDEX IF NOT EXISTS idx_saved_tracks_tg ON saved_tracks(telegram_id);
`)

// миграции для уже существующих БД
try {
  const cols = db.prepare(`PRAGMA table_info(route_logs)`).all().map((c) => c.name)
  const add = (name, def) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE route_logs ADD COLUMN ${name} ${def}`)
  }
  add('start_label', `TEXT NOT NULL DEFAULT ''`)
  add('end_label', `TEXT NOT NULL DEFAULT ''`)
  add('direction', `TEXT NOT NULL DEFAULT ''`)
  add('route_json', `TEXT NOT NULL DEFAULT '[]'`)
} catch (e) {
  console.warn('[ZM] route_logs migrate', e)
}
try {
  const ucols = db.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name)
  if (!ucols.includes('telegram_id')) {
    db.exec(`ALTER TABLE users ADD COLUMN telegram_id TEXT`)
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram ON users(telegram_id) WHERE telegram_id IS NOT NULL`)
  }
} catch (e) {
  console.warn('[ZM] users migrate', e)
}

initAnalytics(db)

const LOGIN_RE = /^[a-zA-Z0-9_]{3,32}$/
const PASSWORD_RE = /^(?=.*[A-Za-z])(?=.*\d).{8,72}$/

const ACHIEVEMENTS = [
  { code: 'first_route', title: 'Первый выход', desc: 'Завершите свой первый маршрут' },
  { code: 'km_5', title: '5 километров', desc: 'Суммарно 5 км по кольцу' },
  { code: 'km_25', title: 'Четверть сотни', desc: 'Суммарно 25 км' },
  { code: 'km_100', title: 'Сотня', desc: 'Суммарно 100 км' },
  { code: 'time_1h', title: 'Час в пути', desc: 'Суммарно 1 час движения' },
  { code: 'time_10h', title: 'Десять часов', desc: 'Суммарно 10 часов' },
  { code: 'landmarks_3', title: 'Три ориентира', desc: 'Посетите 3 знаковые точки' },
  { code: 'landmarks_10', title: 'Исследователь', desc: 'Посетите 10 знаковых точек' },
  { code: 'parks_3', title: 'Три парка', desc: 'Посетите 3 парка (консистентность)' },
  { code: 'lakes_3', title: 'Три озера', desc: 'Посетите 3 озера или пруда' },
  { code: 'viewpoints_2', title: 'Панорамы', desc: 'Две смотровые точки' },
  { code: 'heritage_2', title: 'Память кольца', desc: 'Две исторические точки' },
  { code: 'routes_5', title: 'Регулярность', desc: 'Пять завершённых маршрутов' },
  { code: 'bike_mode', title: 'На двух колёсах', desc: 'Завершите веломаршрут' },
  { code: 'walk_mode', title: 'Своим ходом', desc: 'Завершите пеший маршрут' },
]

function clientIp(req) {
  const xf = req.headers['x-forwarded-for']
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim()
  return req.socket.remoteAddress || 'unknown'
}

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => clientIp(req),
  validate: false,
  message: { error: 'Слишком много попыток регистрации с вашего IP. Попробуйте позже.' },
})

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => clientIp(req),
  validate: false,
  message: { error: 'Слишком много попыток входа с вашего IP. Подождите 15 минут.' },
})

const analyticsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => clientIp(req),
  validate: false,
  message: { error: 'Слишком много событий' },
})

function requireStats(req, res, next) {
  if (!STATS_SECRET) {
    return res.status(503).json({ error: 'ZM_STATS_SECRET не задан на сервере' })
  }
  const key = String(req.query.key || req.headers['x-stats-key'] || '').trim()
  if (!key || key !== STATS_SECRET) {
    return res.status(401).json({ error: 'Нужен ключ статистики' })
  }
  next()
}

function requireBotSecret(req, res, next) {
  const secret = String(req.headers['x-bot-secret'] || '')
  if (!BOT_UPLOAD_SECRET || secret !== BOT_UPLOAD_SECRET) {
    return res.status(401).json({ error: 'Нет доступа бота' })
  }
  next()
}

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => clientIp(req),
  validate: false,
})

const app = express()
app.set('trust proxy', 1)
app.use(
  cors({
    origin: true,
    credentials: true,
  }),
)
app.use(express.json({ limit: '2mb' }))
app.use(apiLimiter)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
})

const BOT_UPLOAD_SECRET = process.env.ZM_BOT_UPLOAD_SECRET || ''
const STATS_SECRET = String(process.env.ZM_STATS_SECRET || '').trim()
const YM_COUNTER_ID = String(process.env.YANDEX_METRIKA_COUNTER_ID || '111389829').trim()

function optionalAuth(req, _res, next) {
  const h = req.headers.authorization || ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  if (!token) return next()
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > datetime('now')`,
    )
    .get(token)
  if (row) {
    req.user = row
    req.token = token
  }
  next()
}

function guestTokenFrom(req) {
  const t = String(req.headers['x-guest-token'] || req.body?.guestToken || '').trim()
  return /^[a-zA-Z0-9_-]{8,64}$/.test(t) ? t : ''
}

function telegramIdFrom(req) {
  const secret = String(req.headers['x-bot-secret'] || '')
  if (!BOT_UPLOAD_SECRET || secret !== BOT_UPLOAD_SECRET) return ''
  const id = String(req.headers['x-telegram-id'] || '').trim()
  return /^\d{3,20}$/.test(id) ? id : ''
}

function trackMeta(row, { includeGeojson = false } = {}) {
  const item = {
    id: row.id,
    title: row.title,
    sourceFilename: row.source_filename,
    sourceFormat: row.source_format,
    pointsCount: row.points_count,
    lengthM: row.length_m,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    hasPreview: Boolean(row.preview_png && row.preview_png.length),
    owned: Boolean(row.user_id),
  }
  if (includeGeojson) {
    try {
      item.geojson = JSON.parse(row.geojson)
    } catch {
      item.geojson = null
    }
  }
  return item
}

function canAccessTrack(row, req) {
  if (!row) return false
  if (req.user && row.user_id === req.user.id) return true
  const guest = guestTokenFrom(req)
  if (guest && row.guest_token === guest) return true
  const tg = telegramIdFrom(req)
  if (tg && String(row.telegram_id || '') === tg) return true
  return false
}

function auth(req, res, next) {
  const h = req.headers.authorization || ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  if (!token) return res.status(401).json({ error: 'Требуется вход' })
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > datetime('now')`,
    )
    .get(token)
  if (!row) return res.status(401).json({ error: 'Сессия истекла. Войдите снова.' })
  req.user = row
  req.token = token
  next()
}

function createSession(userId) {
  const token = randomBytes(32).toString('hex')
  db.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))`,
  ).run(token, userId)
  return token
}

function userProfile(user) {
  const ach = db
    .prepare(`SELECT code, earned_at FROM achievements WHERE user_id = ? ORDER BY earned_at`)
    .all(user.id)
  const visits = db
    .prepare(`SELECT landmark_id, category, visited_at FROM landmark_visits WHERE user_id = ?`)
    .all(user.id)
  const byCat = {}
  for (const v of visits) byCat[v.category] = (byCat[v.category] || 0) + 1
  return {
    login: user.login,
    createdAt: user.created_at,
    totalMeters: user.total_meters,
    totalSeconds: user.total_seconds,
    routesCount: user.routes_count,
    achievements: ach.map((a) => ({
      ...ACHIEVEMENTS.find((x) => x.code === a.code),
      code: a.code,
      earnedAt: a.earned_at,
    })),
    catalog: ACHIEVEMENTS,
    visits,
    categoryCounts: byCat,
  }
}

function evaluateAchievements(userId) {
  const u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId)
  const visits = db.prepare(`SELECT category FROM landmark_visits WHERE user_id = ?`).all(userId)
  const byCat = {}
  for (const v of visits) byCat[v.category] = (byCat[v.category] || 0) + 1
  const modes = db
    .prepare(`SELECT DISTINCT mode FROM route_logs WHERE user_id = ?`)
    .all(userId)
    .map((r) => r.mode)

  const earned = new Set(
    db.prepare(`SELECT code FROM achievements WHERE user_id = ?`).all(userId).map((r) => r.code),
  )
  const unlock = []
  const check = (code, cond) => {
    if (!earned.has(code) && cond) unlock.push(code)
  }
  check('first_route', u.routes_count >= 1)
  check('km_5', u.total_meters >= 5000)
  check('km_25', u.total_meters >= 25000)
  check('km_100', u.total_meters >= 100000)
  check('time_1h', u.total_seconds >= 3600)
  check('time_10h', u.total_seconds >= 36000)
  check('landmarks_3', visits.length >= 3)
  check('landmarks_10', visits.length >= 10)
  check('parks_3', (byCat.park || 0) >= 3)
  check('lakes_3', (byCat.lake || 0) >= 3)
  check('viewpoints_2', (byCat.viewpoint || 0) >= 2)
  check('heritage_2', (byCat.heritage || 0) >= 2)
  check('routes_5', u.routes_count >= 5)
  check('bike_mode', modes.includes('bike'))
  check('walk_mode', modes.includes('walk'))

  const ins = db.prepare(`INSERT OR IGNORE INTO achievements (user_id, code) VALUES (?, ?)`)
  const newly = []
  for (const code of unlock) {
    const r = ins.run(userId, code)
    if (r.changes) newly.push(ACHIEVEMENTS.find((a) => a.code === code))
  }
  return newly.filter(Boolean)
}

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, name: 'Зелёный Маршрут', metrikaCounterId: YM_COUNTER_ID }),
)

/** Public client beacon (web). */
app.post('/api/analytics/event', analyticsLimiter, optionalAuth, (req, res) => {
  const event = String(req.body?.event || '').trim()
  const sessionId = String(req.body?.sessionId || '').slice(0, 64)
  const props = req.body?.props && typeof req.body.props === 'object' ? req.body.props : {}
  const guest = guestTokenFrom(req)
  const ok = trackEvent(db, {
    source: 'web',
    event,
    userId: req.user?.id || null,
    login: req.user?.login || null,
    guestToken: guest || null,
    sessionId: sessionId || null,
    props,
  })
  if (!ok) return res.status(400).json({ error: 'Неизвестное событие' })
  res.json({ ok: true })
})

/** Bot → API events (X-Bot-Secret). */
app.post('/api/analytics/bot', requireBotSecret, (req, res) => {
  const event = String(req.body?.event || '').trim()
  const telegramId = String(req.body?.telegramId || req.headers['x-telegram-id'] || '').trim()
  const login = String(req.body?.login || '').trim().slice(0, 64) || null
  const userId = req.body?.userId != null ? Number(req.body.userId) : null
  const props = req.body?.props && typeof req.body.props === 'object' ? req.body.props : {}
  if (telegramId && !/^\d{3,20}$/.test(telegramId)) {
    return res.status(400).json({ error: 'Некорректный telegramId' })
  }
  const ok = trackEvent(db, {
    source: 'bot',
    event,
    telegramId: telegramId || null,
    userId: Number.isFinite(userId) ? userId : null,
    login,
    props: {
      ...props,
      username: req.body?.username ? String(req.body.username).slice(0, 64) : undefined,
      firstName: req.body?.firstName ? String(req.body.firstName).slice(0, 64) : undefined,
    },
  })
  if (!ok) return res.status(400).json({ error: 'Неизвестное событие' })
  res.json({ ok: true })
})

/**
 * Redirect-обёртка для ссылок Яндекс.Карт из бота (url-кнопки Telegram не шлют callback).
 * GET /api/go/yandex?u=<url>&tg=<id>&exp=<unix>&sig=<hmac>
 */
app.get('/api/go/yandex', analyticsLimiter, (req, res) => {
  const u = String(req.query.u || '')
  const tg = String(req.query.tg || '')
  const exp = Number(req.query.exp || 0)
  const sig = String(req.query.sig || '')
  const secret = process.env.ZM_BOT_UPLOAD_SECRET || ''
  if (!u || !secret) return res.status(400).send('bad request')
  let target
  try {
    target = new URL(u)
  } catch {
    return res.status(400).send('bad url')
  }
  if (!/^https?:$/.test(target.protocol) || !/(^|\.)yandex\.(ru|com)$/i.test(target.hostname)) {
    return res.status(400).send('host not allowed')
  }
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    return res.status(400).send('expired')
  }
  const payload = `${tg}|${exp}|${u}`
  const expect = createHmac('sha256', secret).update(payload).digest('hex')
  try {
    if (!sig || sig.length !== expect.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) {
      return res.status(403).send('bad sig')
    }
  } catch {
    return res.status(403).send('bad sig')
  }
  trackEvent(db, {
    source: 'bot',
    event: 'bot_open_yandex',
    telegramId: /^\d{3,20}$/.test(tg) ? tg : null,
    props: { host: target.hostname, path: target.pathname.slice(0, 80) },
  })
  res.redirect(302, target.toString())
})

app.get('/api/admin/stats', requireStats, (_req, res) => {
  res.json(buildStats(db))
})

app.get('/api/admin/stats.html', requireStats, (_req, res) => {
  const s = buildStats(db)
  const esc = (v) =>
    String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  const rows = (arr, cols) =>
    (arr || [])
      .map(
        (r) =>
          `<tr>${cols.map((c) => `<td>${esc(typeof c === 'function' ? c(r) : r[c])}</td>`).join('')}</tr>`,
      )
      .join('')
  res.type('html').send(`<!doctype html>
<html lang="ru"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Статистика — Зелёный Маршрут</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#121412;color:#f0f2f0;margin:0;padding:20px;line-height:1.45}
h1,h2{margin:0 0 10px}h2{margin-top:28px;font-size:1.05rem;color:#9fdfb0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:14px 0 8px}
.card{background:#1c1f1c;border:1px solid #2e332e;border-radius:12px;padding:12px 14px}
.card .n{font-size:1.55rem;font-weight:700}.card .l{color:#a8aea8;font-size:.78rem;margin-top:2px}
a{color:#6ecf8a}table{width:100%;border-collapse:collapse;font-size:.82rem;margin-top:8px}
th,td{border-bottom:1px solid #2e332e;padding:6px 8px;text-align:left;vertical-align:top}
th{color:#a8aea8;font-weight:600} .muted{color:#a8aea8;font-size:.85rem}
</style></head><body>
<h1>Зелёный Маршрут — статистика</h1>
<p class="muted">Сгенерировано ${esc(s.generatedAt)} ·
<a href="${esc(s.metrika.url)}" target="_blank" rel="noopener">Яндекс.Метрика #${esc(s.metrika.counterId)}</a></p>

<h2>Пользователи сайта</h2>
<div class="grid">
  <div class="card"><div class="n">${s.users.total}</div><div class="l">всего</div></div>
  <div class="card"><div class="n">${s.users.withTelegram}</div><div class="l">с привязкой Telegram</div></div>
  <div class="card"><div class="n">${s.users.registered7d}</div><div class="l">регистрации 7д</div></div>
  <div class="card"><div class="n">${s.users.registered30d}</div><div class="l">регистрации 30д</div></div>
</div>

<h2>Telegram-бот</h2>
<div class="grid">
  <div class="card"><div class="n">${s.bot.uniqueUsers7d}</div><div class="l">уник. /start 7д</div></div>
  <div class="card"><div class="n">${s.bot.uniqueUsers30d}</div><div class="l">уник. /start 30д</div></div>
  <div class="card"><div class="n">${s.bot.starts7d}</div><div class="l">/start всего 7д</div></div>
  <div class="card"><div class="n">${s.bot.segments7d}</div><div class="l">отрезок собран 7д</div></div>
  <div class="card"><div class="n">${s.bot.openYandex7d}</div><div class="l">открыли Яндекс 7д</div></div>
</div>

<h2>Сайт (события)</h2>
<div class="grid">
  <div class="card"><div class="n">${s.web.pageViews7d}</div><div class="l">page_view 7д</div></div>
  <div class="card"><div class="n">${s.web.register7d}</div><div class="l">register 7д</div></div>
  <div class="card"><div class="n">${s.web.login7d}</div><div class="l">login 7д</div></div>
  <div class="card"><div class="n">${s.web.openTelegram7d}</div><div class="l">клик в бота 7д</div></div>
  <div class="card"><div class="n">${s.web.buildRoute7d}</div><div class="l">собрали отрезок 7д</div></div>
  <div class="card"><div class="n">${s.web.openYandex7d}</div><div class="l">открыли Яндекс 7д</div></div>
</div>

<h2>Матч: Telegram → аккаунт сайта</h2>
<table><thead><tr><th>login</th><th>telegram_id</th><th>регистрация</th><th>первый /start</th></tr></thead>
<tbody>${rows(s.matchedBotToSite, ['login', 'telegram_id', 'registered_at', 'first_bot_start']) || '<tr><td colspan="4">Пока пусто</td></tr>'}</tbody></table>

<h2>Топ бот-пользователей (30д)</h2>
<table><thead><tr><th>telegram_id</th><th>login</th><th>события</th><th>/start</th><th>last</th></tr></thead>
<tbody>${rows(s.topBotUsers30d, ['telegram_id', 'login', 'events', 'starts', 'last_seen']) || '<tr><td colspan="5">Пока пусто</td></tr>'}</tbody></table>

<h2>Последние регистрации</h2>
<table><thead><tr><th>id</th><th>login</th><th>telegram</th><th>когда</th><th>маршрутов</th></tr></thead>
<tbody>${rows(s.recentUsers, ['id', 'login', 'telegram_id', 'created_at', 'routes_count'])}</tbody></table>

<h2>Последние события бота</h2>
<table><thead><tr><th>когда</th><th>event</th><th>tg</th><th>login</th></tr></thead>
<tbody>${rows(s.recentBotEvents, ['created_at', 'event', 'telegram_id', 'login'])}</tbody></table>

</body></html>`)
})

app.post('/api/auth/register', registerLimiter, (req, res) => {
  const login = String(req.body?.login || '').trim()
  const password = String(req.body?.password || '')
  if (!LOGIN_RE.test(login)) {
    return res.status(400).json({
      error:
        'Логин: 3–32 символа, только латиница, цифры и подчёркивание.',
    })
  }
  if (!PASSWORD_RE.test(password)) {
    return res.status(400).json({
      error: 'Пароль: 8–72 символа, хотя бы одна буква и одна цифра.',
    })
  }
  const exists = db.prepare(`SELECT id FROM users WHERE login = ? COLLATE NOCASE`).get(login)
  if (exists) return res.status(409).json({ error: 'Такой логин уже занят. Выберите другой.' })
  const hash = bcrypt.hashSync(password, 10)
  const info = db.prepare(`INSERT INTO users (login, password_hash) VALUES (?, ?)`).run(login, hash)
  const token = createSession(info.lastInsertRowid)
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid)
  trackEvent(db, {
    source: 'api',
    event: 'register',
    userId: user.id,
    login: user.login,
    guestToken: guestTokenFrom(req) || null,
    props: { ip: clientIp(req) },
  })
  res.json({ token, profile: userProfile(user) })
})

app.post('/api/auth/login', loginLimiter, (req, res) => {
  const login = String(req.body?.login || '').trim()
  const password = String(req.body?.password || '')
  const user = db.prepare(`SELECT * FROM users WHERE login = ? COLLATE NOCASE`).get(login)
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Неверный логин или пароль.' })
  }
  const token = createSession(user.id)
  trackEvent(db, {
    source: 'api',
    event: 'login',
    userId: user.id,
    login: user.login,
    guestToken: guestTokenFrom(req) || null,
    props: { ip: clientIp(req) },
  })
  res.json({ token, profile: userProfile(user) })
})

app.post('/api/auth/logout', auth, (req, res) => {
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(req.token)
  res.json({ ok: true })
})

app.get('/api/me', auth, (req, res) => {
  res.json({ profile: userProfile(req.user) })
})

app.post('/api/routes/complete', auth, (req, res) => {
  const meters = Math.max(0, Number(req.body?.meters) || 0)
  const seconds = Math.max(0, Number(req.body?.seconds) || 0)
  const mode = req.body?.mode === 'walk' ? 'walk' : 'bike'
  const landmarks = Array.isArray(req.body?.landmarks) ? req.body.landmarks : []
  const startLabel = String(req.body?.startLabel || '').slice(0, 160)
  const endLabel = String(req.body?.endLabel || '').slice(0, 160)
  const direction = req.body?.direction === 'cw' ? 'cw' : req.body?.direction === 'ccw' ? 'ccw' : ''
  let routePts = Array.isArray(req.body?.route) ? req.body.route : []
  // ограничиваем размер трека
  if (routePts.length > 120) {
    const step = Math.ceil(routePts.length / 100)
    routePts = routePts.filter((_, i) => i === 0 || i === routePts.length - 1 || i % step === 0)
  }
  routePts = routePts
    .map((p) => ({
      lat: Number(p?.lat),
      lon: Number(p?.lon),
    }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
    .slice(0, 120)

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE users SET total_meters = total_meters + ?, total_seconds = total_seconds + ?, routes_count = routes_count + 1 WHERE id = ?`,
    ).run(meters, seconds, req.user.id)
    db.prepare(
      `INSERT INTO route_logs (user_id, meters, seconds, mode, landmarks_json, start_label, end_label, direction, route_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      req.user.id,
      meters,
      seconds,
      mode,
      JSON.stringify(landmarks),
      startLabel,
      endLabel,
      direction,
      JSON.stringify(routePts),
    )
    const insVisit = db.prepare(
      `INSERT OR IGNORE INTO landmark_visits (user_id, landmark_id, category) VALUES (?, ?, ?)`,
    )
    for (const lm of landmarks) {
      if (!lm?.id || !lm?.category) continue
      insVisit.run(req.user.id, String(lm.id), String(lm.category))
    }
  })
  tx()
  const newly = evaluateAchievements(req.user.id)
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.id)
  trackEvent(db, {
    source: 'api',
    event: 'build_route',
    userId: user.id,
    login: user.login,
    telegramId: user.telegram_id || null,
    props: { meters, seconds, mode },
  })
  res.json({ profile: userProfile(user), newAchievements: newly })
})

app.get('/api/routes/history', auth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, meters, seconds, mode, landmarks_json, start_label, end_label, direction, route_json, created_at
       FROM route_logs WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`,
    )
    .all(req.user.id)
  const items = rows.map((r) => {
    let landmarks = []
    let route = []
    try {
      landmarks = JSON.parse(r.landmarks_json || '[]')
    } catch {
      /* ignore */
    }
    try {
      route = JSON.parse(r.route_json || '[]')
    } catch {
      /* ignore */
    }
    return {
      id: r.id,
      meters: r.meters,
      seconds: r.seconds,
      mode: r.mode,
      startLabel: r.start_label || '',
      endLabel: r.end_label || '',
      direction: r.direction || '',
      landmarks,
      route,
      createdAt: r.created_at,
    }
  })
  res.json({ items })
})

app.get('/api/routes/:id', auth, (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некорректный id' })
  const r = db
    .prepare(
      `SELECT id, meters, seconds, mode, landmarks_json, start_label, end_label, direction, route_json, created_at
       FROM route_logs WHERE id = ? AND user_id = ?`,
    )
    .get(id, req.user.id)
  if (!r) return res.status(404).json({ error: 'Запись не найдена' })
  let landmarks = []
  let route = []
  try {
    landmarks = JSON.parse(r.landmarks_json || '[]')
  } catch {
    /* ignore */
  }
  try {
    route = JSON.parse(r.route_json || '[]')
  } catch {
    /* ignore */
  }
  res.json({
    item: {
      id: r.id,
      meters: r.meters,
      seconds: r.seconds,
      mode: r.mode,
      startLabel: r.start_label || '',
      endLabel: r.end_label || '',
      direction: r.direction || '',
      landmarks,
      route,
      createdAt: r.created_at,
    },
  })
})

app.delete('/api/routes/:id', auth, (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Некорректный id' })
  const row = db
    .prepare(`SELECT id, meters, seconds FROM route_logs WHERE id = ? AND user_id = ?`)
    .get(id, req.user.id)
  if (!row) return res.status(404).json({ error: 'Запись не найдена' })

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM route_logs WHERE id = ? AND user_id = ?`).run(id, req.user.id)
    db.prepare(
      `UPDATE users SET
         total_meters = MAX(0, total_meters - ?),
         total_seconds = MAX(0, total_seconds - ?),
         routes_count = MAX(0, routes_count - 1)
       WHERE id = ?`,
    ).run(row.meters, row.seconds, req.user.id)
  })
  tx()
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.id)
  res.json({ ok: true, profile: userProfile(user) })
})

/* ─── saved tracks (GPX/KML/FIT) ─── */

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => clientIp(req),
  validate: false,
  message: { error: 'Слишком много загрузок. Подождите час.' },
})

app.post(
  '/api/tracks/upload',
  uploadLimiter,
  optionalAuth,
  upload.single('file'),
  async (req, res) => {
    try {
      if (!req.file?.buffer?.length) {
        return res.status(400).json({ error: 'Прикрепите файл GPX, KML или FIT' })
      }
      const guest = guestTokenFrom(req)
      const tg = telegramIdFrom(req)
      if (!req.user && !guest && !tg) {
        return res.status(400).json({
          error: 'Нужен вход, X-Guest-Token или загрузка из бота',
        })
      }

      const parsed = await parseTrackBuffer(req.file.buffer, {
        filename: req.file.originalname,
        mime: req.file.mimetype,
      })
      const titleBase =
        String(req.body?.title || '').trim() ||
        String(req.file.originalname || '')
          .replace(/\.(gpx|kml|fit)$/i, '')
          .slice(0, 80) ||
        'Мой трек'
      const id = randomUUID()
      const geo = pointsToGeojson(parsed.points, {
        name: titleBase,
        source: parsed.format,
        lengthM: Math.round(parsed.lengthM),
      })
      let preview = null
      try {
        preview = await renderTrackPreviewPng(parsed.points)
      } catch (e) {
        console.warn('[ZM] preview', e)
      }
      const expiresAt = req.user ? null : "datetime('now', '+14 days')"
      db.prepare(
        `INSERT INTO saved_tracks
         (id, user_id, guest_token, telegram_id, title, source_filename, source_format,
          geojson, points_count, length_m, preview_png, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${req.user ? 'NULL' : expiresAt})`,
      ).run(
        id,
        req.user?.id ?? null,
        req.user ? null : guest || null,
        tg || null,
        titleBase.slice(0, 120),
        String(req.file.originalname || '').slice(0, 200),
        parsed.format,
        JSON.stringify(geo),
        parsed.points.length,
        parsed.lengthM,
        preview,
      )
      const row = db.prepare(`SELECT * FROM saved_tracks WHERE id = ?`).get(id)
      res.json({
        track: trackMeta(row, { includeGeojson: true }),
        guestToken: guest || undefined,
        tip: req.user
          ? undefined
          : 'Войдите в аккаунт, чтобы не потерять трек через 14 дней',
      })
    } catch (e) {
      const msg = e?.message || 'Не удалось разобрать файл'
      const status = e?.code ? 400 : 500
      console.warn('[ZM] upload', e)
      res.status(status).json({ error: msg })
    }
  },
)

app.get('/api/tracks', optionalAuth, (req, res) => {
  const guest = guestTokenFrom(req)
  const tg = telegramIdFrom(req)
  let rows = []
  if (req.user) {
    rows = db
      .prepare(
        `SELECT id, user_id, guest_token, telegram_id, title, source_filename, source_format,
                points_count, length_m, preview_png, created_at, expires_at
         FROM saved_tracks
         WHERE user_id = ?
            OR (guest_token = ? AND guest_token IS NOT NULL)
            OR (telegram_id = ? AND telegram_id IS NOT NULL)
         ORDER BY created_at DESC LIMIT 50`,
      )
      .all(req.user.id, guest || '__none__', tg || '__none__')
  } else if (guest) {
    rows = db
      .prepare(
        `SELECT id, user_id, guest_token, telegram_id, title, source_filename, source_format,
                points_count, length_m, preview_png, created_at, expires_at
         FROM saved_tracks
         WHERE guest_token = ?
           AND (expires_at IS NULL OR expires_at > datetime('now'))
         ORDER BY created_at DESC LIMIT 50`,
      )
      .all(guest)
  } else if (tg) {
    rows = db
      .prepare(
        `SELECT id, user_id, guest_token, telegram_id, title, source_filename, source_format,
                points_count, length_m, preview_png, created_at, expires_at
         FROM saved_tracks
         WHERE telegram_id = ?
           AND (expires_at IS NULL OR expires_at > datetime('now') OR user_id IS NOT NULL)
         ORDER BY created_at DESC LIMIT 50`,
      )
      .all(tg)
  } else {
    return res.status(401).json({ error: 'Нужен вход или guest token' })
  }
  res.json({ items: rows.map((r) => trackMeta(r)) })
})

app.get('/api/tracks/:id', optionalAuth, (req, res) => {
  const row = db.prepare(`SELECT * FROM saved_tracks WHERE id = ?`).get(req.params.id)
  if (!row || !canAccessTrack(row, req)) {
    return res.status(404).json({ error: 'Трек не найден' })
  }
  if (row.expires_at && !row.user_id) {
    const alive = db
      .prepare(`SELECT 1 FROM saved_tracks WHERE id = ? AND expires_at > datetime('now')`)
      .get(row.id)
    if (!alive) return res.status(410).json({ error: 'Срок хранения гостевого трека истёк' })
  }
  res.json({ track: trackMeta(row, { includeGeojson: true }) })
})

app.get('/api/tracks/:id/preview.png', optionalAuth, (req, res) => {
  const row = db
    .prepare(`SELECT id, user_id, guest_token, telegram_id, preview_png, expires_at FROM saved_tracks WHERE id = ?`)
    .get(req.params.id)
  if (!row || !canAccessTrack(row, req) || !row.preview_png) {
    return res.status(404).end()
  }
  res.setHeader('Content-Type', 'image/png')
  res.setHeader('Cache-Control', 'private, max-age=3600')
  res.send(row.preview_png)
})

app.patch('/api/tracks/:id', auth, (req, res) => {
  const row = db.prepare(`SELECT * FROM saved_tracks WHERE id = ?`).get(req.params.id)
  if (!row || row.user_id !== req.user.id) {
    return res.status(404).json({ error: 'Трек не найден' })
  }
  const title = String(req.body?.title || '').trim().slice(0, 120)
  if (!title) return res.status(400).json({ error: 'Укажите название' })
  db.prepare(`UPDATE saved_tracks SET title = ? WHERE id = ?`).run(title, row.id)
  const updated = db.prepare(`SELECT * FROM saved_tracks WHERE id = ?`).get(row.id)
  res.json({ track: trackMeta(updated) })
})

app.delete('/api/tracks/:id', optionalAuth, (req, res) => {
  const row = db.prepare(`SELECT * FROM saved_tracks WHERE id = ?`).get(req.params.id)
  if (!row || !canAccessTrack(row, req)) {
    return res.status(404).json({ error: 'Трек не найден' })
  }
  db.prepare(`DELETE FROM saved_tracks WHERE id = ?`).run(row.id)
  res.json({ ok: true })
})

app.post('/api/tracks/claim', auth, (req, res) => {
  const guest = guestTokenFrom(req) || String(req.body?.guestToken || '').trim()
  const tg = String(req.body?.telegramId || '').trim()
  let claimed = 0
  if (guest) {
    const r = db
      .prepare(
        `UPDATE saved_tracks SET user_id = ?, guest_token = NULL, expires_at = NULL
         WHERE guest_token = ? AND (user_id IS NULL OR user_id = ?)`,
      )
      .run(req.user.id, guest, req.user.id)
    claimed += r.changes
  }
  if (/^\d{3,20}$/.test(tg)) {
    const r = db
      .prepare(
        `UPDATE saved_tracks SET user_id = ?, expires_at = NULL
         WHERE telegram_id = ? AND (user_id IS NULL OR user_id = ?)`,
      )
      .run(req.user.id, tg, req.user.id)
    claimed += r.changes
  }
  res.json({ ok: true, claimed })
})

app.post('/api/auth/link-telegram', auth, (req, res) => {
  const tg = String(req.body?.telegramId || '').trim()
  if (!/^\d{3,20}$/.test(tg)) {
    return res.status(400).json({ error: 'Некорректный telegram id' })
  }
  const taken = db.prepare(`SELECT id FROM users WHERE telegram_id = ? AND id != ?`).get(tg, req.user.id)
  if (taken) return res.status(409).json({ error: 'Этот Telegram уже привязан к другому аккаунту' })
  db.prepare(`UPDATE users SET telegram_id = ? WHERE id = ?`).run(tg, req.user.id)
  // claim tg tracks
  db.prepare(
    `UPDATE saved_tracks SET user_id = ?, expires_at = NULL WHERE telegram_id = ? AND user_id IS NULL`,
  ).run(req.user.id, tg)
  trackEvent(db, {
    source: 'api',
    event: 'link_telegram',
    userId: req.user.id,
    login: req.user.login,
    telegramId: tg,
  })
  res.json({ ok: true, profile: userProfile(db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.id)) })
})

// cleanup expired guests occasionally
try {
  db.prepare(
    `DELETE FROM saved_tracks WHERE user_id IS NULL AND expires_at IS NOT NULL AND expires_at < datetime('now')`,
  ).run()
} catch {
  /* ignore */
}

/* ─── saved plans (shareable built segments) ─── */

function planMeta(row) {
  let payload = {}
  try {
    payload = JSON.parse(row.payload || '{}')
  } catch {
    payload = {}
  }
  return {
    id: row.id,
    title: row.title || payload.title || 'Маршрут',
    lengthM: row.length_m,
    createdAt: row.created_at,
    owned: Boolean(row.user_id),
    isPublic: Boolean(row.is_public),
    payload,
  }
}

function downsamplePlanPts(pts, maxN = 500) {
  if (!Array.isArray(pts) || pts.length <= maxN) return pts || []
  const step = Math.ceil(pts.length / maxN)
  const out = []
  for (let i = 0; i < pts.length; i += step) out.push(pts[i])
  const last = pts[pts.length - 1]
  if (out.length && (out[out.length - 1].lat !== last.lat || out[out.length - 1].lon !== last.lon)) {
    out.push(last)
  }
  return out
}

app.post('/api/plans', optionalAuth, (req, res) => {
  const guest = guestTokenFrom(req)
  const body = req.body || {}
  const segment = downsamplePlanPts(body.segment || body.payload?.segment, 500)
  if (!Array.isArray(segment) || segment.length < 2) {
    return res.status(400).json({ error: 'Нужен сегмент маршрута (минимум 2 точки)' })
  }
  if (!req.user && !guest) {
    return res.status(400).json({ error: 'Нужен вход или X-Guest-Token' })
  }
  const wantSave = body.save === true
  if (wantSave && !req.user) {
    return res.status(401).json({ error: 'Войдите, чтобы сохранить маршрут' })
  }
  const title = String(body.title || body.payload?.title || 'Маршрут').trim().slice(0, 120) || 'Маршрут'
  const lengthM = Number(body.lengthM || body.payload?.lengthM || 0) || 0
  const payload = {
    ...(body.payload && typeof body.payload === 'object' ? body.payload : {}),
    routeId: body.routeId || body.payload?.routeId || '',
    mode: body.mode || body.payload?.mode || 'bike',
    direction: body.direction || body.payload?.direction || 'ccw',
    start: body.start || body.payload?.start || null,
    end: body.end || body.payload?.end || null,
    meters: body.meters ?? body.payload?.meters ?? null,
    finishMode: body.finishMode || body.payload?.finishMode || 'length',
    segment,
    track: downsamplePlanPts(body.track || body.payload?.track || [], 900),
    lengthM,
    title,
  }
  const id = randomUUID()
  const userId = req.user ? req.user.id : null
  db.prepare(
    `INSERT INTO saved_plans (id, user_id, guest_token, title, payload, length_m, is_public)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
  ).run(id, userId, userId ? null : guest || null, title, JSON.stringify(payload), lengthM)
  const row = db.prepare(`SELECT * FROM saved_plans WHERE id = ?`).get(id)
  const origin = String(req.headers.origin || req.headers.referer || 'https://green-route.ru').replace(
    /\/$/,
    '',
  )
  const base = origin.includes('green-route.ru') ? 'https://green-route.ru' : origin.split('/').slice(0, 3).join('/')
  res.json({
    plan: planMeta(row),
    shareUrl: `${base}/?p=${id}`,
  })
})

app.get('/api/plans', optionalAuth, (req, res) => {
  const guest = guestTokenFrom(req)
  let rows = []
  if (req.user) {
    rows = db
      .prepare(
        `SELECT id, user_id, guest_token, title, payload, length_m, is_public, created_at
         FROM saved_plans WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
      )
      .all(req.user.id)
  } else if (guest) {
    rows = db
      .prepare(
        `SELECT id, user_id, guest_token, title, payload, length_m, is_public, created_at
         FROM saved_plans WHERE guest_token = ? ORDER BY created_at DESC LIMIT 50`,
      )
      .all(guest)
  } else {
    return res.status(401).json({ error: 'Нужен вход или guest token' })
  }
  res.json({ items: rows.map(planMeta) })
})

app.get('/api/plans/:id', optionalAuth, (req, res) => {
  const row = db.prepare(`SELECT * FROM saved_plans WHERE id = ?`).get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Маршрут не найден' })
  if (!row.is_public) {
    const guest = guestTokenFrom(req)
    const ok =
      (req.user && row.user_id === req.user.id) || (guest && row.guest_token === guest)
    if (!ok) return res.status(403).json({ error: 'Нет доступа' })
  }
  res.json({ plan: planMeta(row) })
})

app.patch('/api/plans/:id', auth, (req, res) => {
  const row = db.prepare(`SELECT * FROM saved_plans WHERE id = ?`).get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Маршрут не найден' })
  if (row.user_id && row.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Нет доступа' })
  }
  const title = String(req.body?.title || '').trim().slice(0, 120)
  if (!title) return res.status(400).json({ error: 'Укажите название' })
  // claim guest plan to user on save/rename
  db.prepare(
    `UPDATE saved_plans SET title = ?, user_id = ?, guest_token = NULL WHERE id = ?`,
  ).run(title, req.user.id, row.id)
  try {
    const payload = JSON.parse(row.payload || '{}')
    payload.title = title
    db.prepare(`UPDATE saved_plans SET payload = ? WHERE id = ?`).run(JSON.stringify(payload), row.id)
  } catch {
    /* ignore */
  }
  const updated = db.prepare(`SELECT * FROM saved_plans WHERE id = ?`).get(row.id)
  res.json({ plan: planMeta(updated) })
})

app.delete('/api/plans/:id', auth, (req, res) => {
  const row = db.prepare(`SELECT * FROM saved_plans WHERE id = ?`).get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Маршрут не найден' })
  if (row.user_id !== req.user.id) return res.status(403).json({ error: 'Нет доступа' })
  db.prepare(`DELETE FROM saved_plans WHERE id = ?`).run(row.id)
  res.json({ ok: true })
})

const PORT = Number(process.env.PORT || 8787)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[ZM] API http://0.0.0.0:${PORT}`)
})

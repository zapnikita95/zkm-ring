/**
 * Зелёный Маршрут — API (логин/пароль, статистика, ачивки, anti-spam по IP)
 */
import express from 'express'
import cors from 'cors'
import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import rateLimit from 'express-rate-limit'

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
app.use(cors())
app.use(express.json({ limit: '256kb' }))
app.use(apiLimiter)

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

app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'Зелёный Маршрут' }))

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

const PORT = Number(process.env.PORT || 8787)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[ZM] API http://0.0.0.0:${PORT}`)
})

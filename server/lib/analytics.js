/**
 * First-party analytics for green-route.ru + Telegram bot.
 * Source of truth for matching bot users ↔ site registrations.
 */

const ALLOWED_EVENTS = new Set([
  'page_view',
  'register',
  'login',
  'logout',
  'link_telegram',
  'open_telegram',
  'track_select',
  'build_route',
  'open_yandex_maps',
  'save_plan',
  'bot_start',
  'bot_track_select',
  'bot_geo',
  'bot_segment',
  'bot_open_yandex',
  'bot_register',
  'bot_login',
])

export function initAnalytics(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS analytics_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      source TEXT NOT NULL,
      event TEXT NOT NULL,
      telegram_id TEXT,
      user_id INTEGER,
      login TEXT,
      guest_token TEXT,
      session_id TEXT,
      props_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_ae_created ON analytics_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_ae_event ON analytics_events(event);
    CREATE INDEX IF NOT EXISTS idx_ae_tg ON analytics_events(telegram_id);
    CREATE INDEX IF NOT EXISTS idx_ae_user ON analytics_events(user_id);
  `)
}

export function trackEvent(db, {
  source = 'web',
  event,
  telegramId = null,
  userId = null,
  login = null,
  guestToken = null,
  sessionId = null,
  props = null,
} = {}) {
  const ev = String(event || '').trim().slice(0, 64)
  if (!ev || !ALLOWED_EVENTS.has(ev)) return false
  const src = String(source || 'web').slice(0, 16)
  let propsJson = '{}'
  try {
    propsJson = JSON.stringify(props && typeof props === 'object' ? props : {})
  } catch {
    propsJson = '{}'
  }
  db.prepare(
    `INSERT INTO analytics_events
      (source, event, telegram_id, user_id, login, guest_token, session_id, props_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    src,
    ev,
    telegramId ? String(telegramId).slice(0, 32) : null,
    userId != null ? Number(userId) : null,
    login ? String(login).slice(0, 64) : null,
    guestToken ? String(guestToken).slice(0, 64) : null,
    sessionId ? String(sessionId).slice(0, 64) : null,
    propsJson.slice(0, 4000),
  )
  return true
}

function countDistinct(db, sql, params = []) {
  const row = db.prepare(sql).get(...params)
  return Number(row?.n || 0)
}

function countEvent(db, event, sinceDays) {
  return countDistinct(
    db,
    `SELECT COUNT(*) AS n FROM analytics_events
     WHERE event = ? AND created_at >= datetime('now', ?)`,
    [event, `-${sinceDays} days`],
  )
}

function distinctTg(db, event, sinceDays) {
  return countDistinct(
    db,
    `SELECT COUNT(DISTINCT telegram_id) AS n FROM analytics_events
     WHERE event = ? AND telegram_id IS NOT NULL
       AND created_at >= datetime('now', ?)`,
    [event, `-${sinceDays} days`],
  )
}

export function buildStats(db) {
  const usersTotal = countDistinct(db, `SELECT COUNT(*) AS n FROM users`)
  const usersWithTg = countDistinct(
    db,
    `SELECT COUNT(*) AS n FROM users WHERE telegram_id IS NOT NULL`,
  )
  const users7 = countDistinct(
    db,
    `SELECT COUNT(*) AS n FROM users WHERE created_at >= datetime('now', '-7 days')`,
  )
  const users30 = countDistinct(
    db,
    `SELECT COUNT(*) AS n FROM users WHERE created_at >= datetime('now', '-30 days')`,
  )

  const recentUsers = db
    .prepare(
      `SELECT id, login, telegram_id, created_at, routes_count, total_meters
       FROM users ORDER BY created_at DESC LIMIT 30`,
    )
    .all()

  const recentBot = db
    .prepare(
      `SELECT created_at, telegram_id, login, event, props_json
       FROM analytics_events
       WHERE source = 'bot'
       ORDER BY id DESC LIMIT 40`,
    )
    .all()

  const recentWeb = db
    .prepare(
      `SELECT created_at, event, login, user_id, guest_token, props_json
       FROM analytics_events
       WHERE source IN ('web', 'api')
       ORDER BY id DESC LIMIT 40`,
    )
    .all()

  const topBotUsers = db
    .prepare(
      `SELECT telegram_id,
              COUNT(*) AS events,
              SUM(CASE WHEN event = 'bot_start' THEN 1 ELSE 0 END) AS starts,
              MAX(created_at) AS last_seen,
              MAX(login) AS login
       FROM analytics_events
       WHERE source = 'bot' AND telegram_id IS NOT NULL
         AND created_at >= datetime('now', '-30 days')
       GROUP BY telegram_id
       ORDER BY events DESC
       LIMIT 40`,
    )
    .all()

  // Match: bot users who later linked / registered
  const matched = db
    .prepare(
      `SELECT u.id, u.login, u.telegram_id, u.created_at AS registered_at,
              (SELECT MIN(ae.created_at) FROM analytics_events ae
               WHERE ae.telegram_id = u.telegram_id AND ae.event = 'bot_start') AS first_bot_start
       FROM users u
       WHERE u.telegram_id IS NOT NULL
       ORDER BY u.created_at DESC
       LIMIT 50`,
    )
    .all()

  return {
    generatedAt: new Date().toISOString(),
    metrika: {
      counterId: Number(process.env.YANDEX_METRIKA_COUNTER_ID || 111389829),
      url: `https://metrika.yandex.ru/dashboard?id=${process.env.YANDEX_METRIKA_COUNTER_ID || 111389829}`,
    },
    users: {
      total: usersTotal,
      withTelegram: usersWithTg,
      registered7d: users7,
      registered30d: users30,
    },
    bot: {
      starts7d: countEvent(db, 'bot_start', 7),
      starts30d: countEvent(db, 'bot_start', 30),
      uniqueUsers7d: distinctTg(db, 'bot_start', 7),
      uniqueUsers30d: distinctTg(db, 'bot_start', 30),
      segments7d: countEvent(db, 'bot_segment', 7),
      openYandex7d: countEvent(db, 'bot_open_yandex', 7),
    },
    web: {
      pageViews7d: countEvent(db, 'page_view', 7),
      pageViews30d: countEvent(db, 'page_view', 30),
      register7d: countEvent(db, 'register', 7),
      login7d: countEvent(db, 'login', 7),
      openTelegram7d: countEvent(db, 'open_telegram', 7),
      buildRoute7d: countEvent(db, 'build_route', 7),
      openYandex7d: countEvent(db, 'open_yandex_maps', 7),
    },
    matchedBotToSite: matched,
    topBotUsers30d: topBotUsers,
    recentUsers,
    recentBotEvents: recentBot,
    recentWebEvents: recentWeb,
  }
}

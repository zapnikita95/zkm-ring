/**
 * Зелёный Маршрут — Telegram-бот (быстрый вход → Яндекс).
 * Слово «кусок» в пользовательских текстах не используем — только «отрезок».
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bot, InlineKeyboard, Keyboard } from 'grammy'
import {
  buildSegment,
  describeSegment,
  formatDuration,
  formatKm,
  metersFromMinutes,
  nearbyLandmarks,
  nearestOnTrack,
  popularPresets,
  quickOffers,
  routeCatalog,
  trackTitle,
} from './lib/routes.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadToken() {
  if (process.env.BOT_TOKEN) return process.env.BOT_TOKEN.trim()
  const candidates = [
    join(__dirname, '../secrets/telegram-bot.env'),
    join(__dirname, '.env'),
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    const raw = readFileSync(p, 'utf8')
    const m = raw.match(/^BOT_TOKEN=(.+)$/m)
    if (m) return m[1].trim()
  }
  throw new Error('BOT_TOKEN не найден (secrets/telegram-bot.env или BOT_TOKEN)')
}

const token = loadToken()
const bot = new Bot(token)

/** @type {Map<number, { mode: 'bike'|'walk', routeId: string, lat?: number, lon?: number, lastSeg?: object }>} */
const sessions = new Map()

function sess(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, { mode: 'bike', routeId: 'zkm-ring' })
  }
  return sessions.get(userId)
}

function geoKeyboard() {
  return new Keyboard()
    .requestLocation('📍 Моя геолокация')
    .resized()
    .oneTime()
}

function modeKeyboard() {
  return new InlineKeyboard()
    .text('🚲 Велосипед', 'mode:bike')
    .text('🚶 Пешком', 'mode:walk')
}

function trackPickKeyboard() {
  const kb = new InlineKeyboard()
  for (const r of routeCatalog.slice(0, 11)) {
    const tag = r.id === 'zkm-ring' ? '⭐ ' : ''
    kb.text(`${tag}${r.title} · ${r.kmListed} км`, `track:${r.id}`).row()
  }
  return kb
}

function offersKeyboard(offers) {
  const kb = new InlineKeyboard()
  offers.forEach((o, i) => {
    kb.text(o.label, `offer:${i}`).row()
  })
  kb.text('↺ Другое направление', 'flip_dir').row()
  kb.text('⏱ На 40 мин', 'time:40').text('⏱ На 1 час', 'time:60').row()
  kb.text('🏷 По ситуации', 'popular').row()
  return kb
}

function resultKeyboard(seg) {
  return new InlineKeyboard()
    .url('🗺 Открыть в Яндекс.Картах', seg.mapsUrl)
    .row()
    .url('🚗 Яндекс.Навигатор', seg.naviUrl)
    .row()
    .text('Другой отрезок рядом', 'again')
    .text('Сменить трек', 'tracks')
}

function needGeo(ctx) {
  return ctx.reply(
    'Пришлите геолокацию — так найдём ближайшую точку на линии и предложим отрезки.\n\n' +
      'Кнопка ниже или скрепка → Геопозиция.',
    { reply_markup: geoKeyboard() },
  )
}

function startText() {
  return (
    '<b>Зелёный Маршрут</b> — быстрый вход на красивую линию.\n\n' +
    'Готовые треки (Зелёное кольцо и Подмосковье). ' +
    'Старт и финиш — где удобно. Отрезок — не весь трек. ' +
    'Дальше — в привычном <b>Яндексе</b>.\n\n' +
    '<b>Как начать</b>\n' +
    '1) Пришлите геолокацию\n' +
    '2) Выберите отрезок (5 / 8 / 12 / 15 км или по времени)\n' +
    '3) Жмите «Открыть в Яндекс.Картах»\n\n' +
    'Без регистрации. Без спортивного шума.\n\n' +
    'Команды: /near · /zkm · /km 12 · /time 60 · /tracks · /popular · /help'
  )
}

bot.command('start', async (ctx) => {
  sess(ctx.from.id)
  await ctx.reply(startText(), { parse_mode: 'HTML', reply_markup: geoKeyboard() })
  await ctx.reply('Сначала выберите трек (или оставьте Зелёное кольцо):', {
    reply_markup: trackPickKeyboard(),
  })
})

bot.command('help', async (ctx) => {
  await ctx.reply(
    '/start — инструкция и выбор трека\n' +
      '/near — отрезки рядом (нужна геолокация)\n' +
      '/zkm — Зелёное кольцо + быстрые отрезки\n' +
      '/km 12 — отрезок на 12 км\n' +
      '/time 60 — отрезок примерно на 60 мин\n' +
      '/tracks — треки Подмосковья и ЗКМ\n' +
      '/popular — готовые варианты «по ситуации»\n' +
      '/bike · /walk — режим',
  )
})

bot.command('bike', async (ctx) => {
  sess(ctx.from.id).mode = 'bike'
  await ctx.reply('Режим: велосипед')
})

bot.command('walk', async (ctx) => {
  sess(ctx.from.id).mode = 'walk'
  await ctx.reply('Режим: пешком')
})

bot.command('tracks', async (ctx) => {
  await ctx.reply('Какой трек открываем?', { reply_markup: trackPickKeyboard() })
})

bot.command('zkm', async (ctx) => {
  const s = sess(ctx.from.id)
  s.routeId = 'zkm-ring'
  if (s.lat == null) return needGeo(ctx)
  await sendNearOffers(ctx, s)
})

bot.command('near', async (ctx) => {
  const s = sess(ctx.from.id)
  if (s.lat == null) return needGeo(ctx)
  await sendNearOffers(ctx, s)
})

bot.command('popular', async (ctx) => {
  const s = sess(ctx.from.id)
  if (s.lat == null) return needGeo(ctx)
  await sendPopular(ctx, s)
})

bot.command('km', async (ctx) => {
  const s = sess(ctx.from.id)
  if (s.lat == null) return needGeo(ctx)
  const n = Number(String(ctx.match || '').replace(',', '.'))
  if (!Number.isFinite(n) || n <= 0 || n > 80) {
    return ctx.reply('Пример: /km 12')
  }
  const seg = buildSegment({
    user: { lat: s.lat, lon: s.lon },
    routeId: s.routeId,
    direction: 'ccw',
    meters: n * 1000,
    mode: s.mode,
  })
  s.lastSeg = seg
  await sendResult(ctx, seg)
})

bot.command('time', async (ctx) => {
  const s = sess(ctx.from.id)
  if (s.lat == null) return needGeo(ctx)
  const n = Number(String(ctx.match || '').replace(',', '.'))
  if (!Number.isFinite(n) || n <= 0 || n > 300) {
    return ctx.reply('Пример: /time 60')
  }
  const seg = buildSegment({
    user: { lat: s.lat, lon: s.lon },
    routeId: s.routeId,
    direction: 'ccw',
    meters: metersFromMinutes(n, s.mode),
    mode: s.mode,
  })
  s.lastSeg = seg
  await sendResult(ctx, seg)
})

bot.on('message:location', async (ctx) => {
  const loc = ctx.message.location
  const s = sess(ctx.from.id)
  s.lat = loc.latitude
  s.lon = loc.longitude
  await sendNearOffers(ctx, s)
})

bot.callbackQuery(/^track:(.+)$/, async (ctx) => {
  const id = ctx.match[1]
  const s = sess(ctx.from.id)
  s.routeId = id
  await ctx.answerCallbackQuery({ text: trackTitle(id) })
  await ctx.reply(`Трек: <b>${trackTitle(id)}</b>\nРежим:`, {
    parse_mode: 'HTML',
    reply_markup: modeKeyboard(),
  })
  if (s.lat != null) await sendNearOffers(ctx, s)
  else await needGeo(ctx)
})

bot.callbackQuery(/^mode:(bike|walk)$/, async (ctx) => {
  const s = sess(ctx.from.id)
  s.mode = ctx.match[1]
  await ctx.answerCallbackQuery({ text: s.mode === 'bike' ? 'Велосипед' : 'Пешком' })
  if (s.lat != null) await sendNearOffers(ctx, s)
  else await needGeo(ctx)
})

bot.callbackQuery(/^offer:(\d+)$/, async (ctx) => {
  const s = sess(ctx.from.id)
  if (s.lat == null) {
    await ctx.answerCallbackQuery({ text: 'Нужна геолокация' })
    return needGeo(ctx)
  }
  const idx = Number(ctx.match[1])
  const offers =
    s._offers || quickOffers({ lat: s.lat, lon: s.lon }, s.routeId, s.mode).offers
  const seg = offers[idx]
  if (!seg) {
    await ctx.answerCallbackQuery({ text: 'Вариант устарел — пришлите гео снова' })
    return
  }
  s.lastSeg = seg
  await ctx.answerCallbackQuery()
  await sendResult(ctx, seg)
})

bot.callbackQuery(/^time:(\d+)$/, async (ctx) => {
  const s = sess(ctx.from.id)
  if (s.lat == null) {
    await ctx.answerCallbackQuery({ text: 'Нужна геолокация' })
    return needGeo(ctx)
  }
  const mins = Number(ctx.match[1])
  const seg = buildSegment({
    user: { lat: s.lat, lon: s.lon },
    routeId: s.routeId,
    direction: 'ccw',
    meters: metersFromMinutes(mins, s.mode),
    mode: s.mode,
  })
  s.lastSeg = seg
  await ctx.answerCallbackQuery()
  await sendResult(ctx, seg)
})

bot.callbackQuery('popular', async (ctx) => {
  const s = sess(ctx.from.id)
  await ctx.answerCallbackQuery()
  if (s.lat == null) return needGeo(ctx)
  await sendPopular(ctx, s)
})

bot.callbackQuery(/^pop:(.+)$/, async (ctx) => {
  const s = sess(ctx.from.id)
  if (s.lat == null) {
    await ctx.answerCallbackQuery({ text: 'Нужна геолокация' })
    return needGeo(ctx)
  }
  const key = ctx.match[1]
  const list = popularPresets({ lat: s.lat, lon: s.lon }, s.mode)
  const seg = list.find((x) => x.key === key)
  if (!seg) {
    await ctx.answerCallbackQuery({ text: 'Не найден' })
    return
  }
  s.lastSeg = seg
  await ctx.answerCallbackQuery()
  await sendResult(ctx, seg)
})

bot.callbackQuery('again', async (ctx) => {
  const s = sess(ctx.from.id)
  await ctx.answerCallbackQuery()
  if (s.lat == null) return needGeo(ctx)
  await sendNearOffers(ctx, s)
})

bot.callbackQuery('tracks', async (ctx) => {
  await ctx.answerCallbackQuery()
  await ctx.reply('Какой трек открываем?', { reply_markup: trackPickKeyboard() })
})

bot.callbackQuery('flip_dir', async (ctx) => {
  const s = sess(ctx.from.id)
  if (s.lat == null || !s.lastSeg) {
    await ctx.answerCallbackQuery({ text: 'Сначала выберите отрезок' })
    return
  }
  const dir = s.lastSeg.direction === 'cw' ? 'ccw' : 'cw'
  const seg = buildSegment({
    user: { lat: s.lat, lon: s.lon },
    routeId: s.routeId,
    direction: dir,
    meters: s.lastSeg.meters,
    mode: s.mode,
  })
  s.lastSeg = seg
  await ctx.answerCallbackQuery({ text: dir === 'cw' ? 'По часовой' : 'Против часовой' })
  await sendResult(ctx, seg)
})

bot.callbackQuery(/^lm:(\d+)$/, async (ctx) => {
  const s = sess(ctx.from.id)
  if (s.lat == null) {
    await ctx.answerCallbackQuery({ text: 'Нужна геолокация' })
    return needGeo(ctx)
  }
  const idx = Number(ctx.match[1])
  const list = nearbyLandmarks({ lat: s.lat, lon: s.lon }, 20)
  const lm = list[idx]
  if (!lm) {
    await ctx.answerCallbackQuery({ text: 'Точка устарела' })
    return
  }
  await ctx.answerCallbackQuery({ text: lm.name })
  // старт у ориентира, отрезок 8 км
  const seg = buildSegment({
    user: { lat: s.lat, lon: s.lon },
    routeId: s.routeId,
    direction: 'ccw',
    meters: 8000,
    mode: s.mode,
    startOverride: { lat: lm.lat, lon: lm.lon },
  })
  s.lastSeg = seg
  await ctx.reply(`Старт у «${lm.name}» (${formatKm(lm.dist)} от вас). Отрезок ≈ 8 км:`)
  await sendResult(ctx, seg)
})

async function sendNearOffers(ctx, s) {
  const user = { lat: s.lat, lon: s.lon }
  const { near, offers } = quickOffers(user, s.routeId, s.mode)
  s._offers = offers
  const title = trackTitle(s.routeId)
  const lm = nearbyLandmarks(user, 8)
  const lmKb = new InlineKeyboard()
  lm.slice(0, 6).forEach((p, i) => {
    lmKb.text(`${p.name} · ${formatKm(p.dist)}`, `lm:${i}`).row()
  })

  await ctx.reply(
    `<b>${title}</b>\n` +
      `Ближайшая точка на линии: <b>${formatKm(near.meters)}</b> от вас.\n\n` +
      `Выберите отрезок — или точку интереса рядом как старт:`,
    { parse_mode: 'HTML', reply_markup: offersKeyboard(offers) },
  )
  if (lm.length) {
    await ctx.reply('Интересные точки рядом (старт от них, отрезок ~8 км):', {
      reply_markup: lmKb,
    })
  }
}

async function sendPopular(ctx, s) {
  const list = popularPresets({ lat: s.lat, lon: s.lon }, s.mode)
  const kb = new InlineKeyboard()
  for (const p of list) {
    kb.text(p.label, `pop:${p.key}`).row()
  }
  await ctx.reply(
    '<b>По ситуации</b> — готовые отрезки на Зелёном кольце:\n' +
      list.map((p) => `· ${p.blurb}`).join('\n'),
    { parse_mode: 'HTML', reply_markup: kb },
  )
}

async function sendResult(ctx, seg) {
  const text = describeSegment(seg)
  await ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: resultKeyboard(seg),
    link_preview_options: { is_disabled: true },
  })
}

bot.catch((err) => {
  console.error('[zm-bot]', err.error || err)
})

console.log('[zm-bot] starting…')
bot.start({
  onStart: (info) => console.log(`[zm-bot] @${info.username} online`),
})

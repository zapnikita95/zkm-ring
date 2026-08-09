/**
 * Зелёный Маршрут — Telegram-бот.
 * Мастер в одном сообщении (edit). Слово «отрезок», не «кусок».
 *
 * Важно: «Назад» и «Меню» — разные callback_data, иначе Telegram подсвечивает обе.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bot, InlineKeyboard, InputFile, Keyboard } from 'grammy'
import {
  buildSegment,
  buildSegmentBetween,
  trackLengthM,
  formatDuration,
  formatKm,
  listRoutePoints,
  loadTrackPoints,
  minutesFromMeters,
  nearestOnTrack,
  putSavedTrack,
  routeCatalog,
  citiesList,
  cityMeta,
  routesForCityId,
  trackTitle,
} from './lib/routes.js'
import { haversineM } from './lib/geo.js'
import { geocodeCandidates, cityOf, reverseGeocode } from './lib/geocode.js'
import { fetchPointMapPng, fetchRouteMapPng } from './lib/staticmap.js'
import { apiGetTrack, apiListTracks, apiPreviewPng, apiUploadTrack, apiTrackEvent } from './lib/api.js'
import {
  APPROACH_THRESHOLD_M,
  DIFFICULTY,
  difficultiesForTrackM,
  difficultyRangeM,
} from './lib/wizard.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PAGE_SIZE = 6

const WELCOME_CAPTION =
  '<b>Зелёный Маршрут</b>\n\n' +
  'Готовые вело- и пешеходные маршруты по Москве и области — Зелёное кольцо и треки Подмосковья.\n\n' +
  'Выберите удобный старт и финиш, бот отправит вам указанный маршрут ссылкой на Яндекс.Карты.\n\n' +
  'Без регистрации и без скачивания сложных гео-файлов.'

function loadToken() {
  if (process.env.BOT_TOKEN) return process.env.BOT_TOKEN.trim()
  for (const p of [join(__dirname, '../secrets/telegram-bot.env'), join(__dirname, '.env')]) {
    if (!existsSync(p)) continue
    const m = readFileSync(p, 'utf8').match(/^BOT_TOKEN=(.+)$/m)
    if (m) return m[1].trim()
  }
  throw new Error('BOT_TOKEN не найден')
}

const bot = new Bot(loadToken())

/** @type {Map<number, any>} */
const sessions = new Map()

function sess(uid) {
  if (!sessions.has(uid)) {
    sessions.set(uid, {
      mode: 'bike',
      routeId: 'zkm-ring',
      cityId: 'msk',
      screen: 'menu',
      difficulty: null,
      direction: null,
      units: null,
      meters: null,
      wantApproach: null,
      finishMode: null, // 'length' | 'point'
      start: null, // { id, name, lat, lon }
      pending: null,
      pointList: [],
      page: 0,
      geoIntent: null, // 'start'
      awaitingAddress: false,
      addressLabel: null,
      addressCandidates: [],
      rawGeo: null, // { lat, lon } до подтверждения
      uiMsgId: null,
      uiKind: null,
      /** Карта всего трека — оставляем в чате после «Выбрать этот трек». */
      trackMapMsgId: null,
      /** Отфильтрованные км текущего уровня под длину трека. */
      difficultyKm: null,
      /** 'login' | 'register' | null */
      authFlow: null,
      /** 'login' | 'password' | null */
      authStep: null,
      authLogin: null,
    })
  }
  return sessions.get(uid)
}

function clearAuthFlow(s) {
  s.authFlow = null
  s.authStep = null
  s.authLogin = null
}

function apiBase() {
  return (process.env.ZM_API_BASE || 'https://green-route.layero.app').replace(/\/$/, '')
}

async function authAndLinkTelegram(mode, loginName, password, telegramId) {
  const loginRes = await fetch(`${apiBase()}/api/auth/${mode}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: loginName, password }),
  })
  const loginData = await loginRes.json().catch(() => ({}))
  if (!loginRes.ok) throw new Error(loginData.error || `HTTP ${loginRes.status}`)
  const linkRes = await fetch(`${apiBase()}/api/auth/link-telegram`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${loginData.token}`,
    },
    body: JSON.stringify({ telegramId: String(telegramId) }),
  })
  const linkData = await linkRes.json().catch(() => ({}))
  if (!linkRes.ok) throw new Error(linkData.error || `HTTP ${linkRes.status}`)
  return loginName
}

async function beginAuthFlow(ctx, flow) {
  const s = sess(ctx.from.id)
  clearAuthFlow(s)
  s.authFlow = flow
  s.authStep = 'login'
  s.awaitingAddress = false
  if (flow === 'login') {
    await ctx.reply(
      'Введите логин.\n\nЕсли вы не зарегистрированы — зарегистрируйтесь через /register',
    )
  } else {
    await ctx.reply(
      'Регистрация аккаунта сайта.\n\nВведите логин (3–32 символа, латиница/цифры).\nУже есть аккаунт? /login',
    )
  }
}

async function handleAuthText(ctx) {
  const s = sess(ctx.from.id)
  const text = (ctx.message?.text || '').trim()
  if (!s.authFlow || !s.authStep) return false
  if (!text || text.startsWith('/')) return false

  if (s.authStep === 'login') {
    const loginName = text.split(/\s+/)[0]
    if (loginName.length < 3 || loginName.length > 32 || !/^[a-zA-Z0-9_]+$/.test(loginName)) {
      await ctx.reply('Логин: 3–32 символа, латиница/цифры/_ . Попробуйте ещё раз.')
      return true
    }
    s.authLogin = loginName
    s.authStep = 'password'
    await ctx.reply('Введите пароль. Сообщение будет удалено.')
    return true
  }

  if (s.authStep === 'password') {
    const password = text
    const loginName = s.authLogin
    const flow = s.authFlow
    try {
      await ctx.deleteMessage()
    } catch {
      /* нет прав / слишком старое */
    }
    if (!password || password.length < 8) {
      await ctx.reply('Пароль от 8 символов. Введите пароль ещё раз.')
      return true
    }
    try {
      await authAndLinkTelegram(flow, loginName, password, ctx.from.id)
      clearAuthFlow(s)
      trackBot(ctx, flow === 'register' ? 'bot_register' : 'bot_login', { login: loginName })
      const verb = flow === 'register' ? 'Зарегистрированы и привязаны' : 'Вошли и привязаны'
      await ctx.reply(
        `${verb} к аккаунту <b>${loginName}</b>. Сохранённые треки не сгорят через 14 дней.`,
        { parse_mode: 'HTML' },
      )
    } catch (e) {
      clearAuthFlow(s)
      await ctx.reply(`Не удалось: ${e.message || e}\n\nСнова: /login или /register`)
    }
    return true
  }
  return false
}

function geoKb() {
  return new Keyboard().requestLocation('📍 Моя геолокация').resized().oneTime()
}

/** Назад и Главная всегда с разными callback — иначе светятся обе. */
function addNav(kb, backTo) {
  kb.text('← Назад', `back:${backTo}`).text('⌂ Главная', 'nav:menu')
  return kb
}

function truncateBtn(text, max = 64) {
  const t = String(text)
  if (t.length <= max) return t
  return t.slice(0, max - 1) + '…'
}

/** grammy кидает sync-ошибку, если нет callbackQuery — .catch() не спасает. */
async function safeAnswerCb(ctx) {
  if (!ctx.callbackQuery) return
  try {
    await ctx.answerCallbackQuery()
  } catch {
    /* already answered / expired */
  }
}

async function clearUi(ctx, s) {
  if (!s.uiMsgId || !ctx.chat?.id) return
  try {
    await ctx.api.deleteMessage(ctx.chat.id, s.uiMsgId)
  } catch {
    /* */
  }
  s.uiMsgId = null
  s.uiKind = null
}

/** Убрать кнопки с превью трека и оставить картинку в истории чата. */
async function pinTrackMap(ctx, s) {
  if (s.uiKind !== 'photo' || !s.uiMsgId || !ctx.chat?.id) return
  try {
    await ctx.api.editMessageReplyMarkup(ctx.chat.id, s.uiMsgId, {
      reply_markup: { inline_keyboard: [] },
    })
  } catch {
    /* */
  }
  s.trackMapMsgId = s.uiMsgId
  s.uiMsgId = null
  s.uiKind = null
}

async function clearTrackMap(ctx, s) {
  if (!s.trackMapMsgId || !ctx.chat?.id) return
  if (s.uiMsgId === s.trackMapMsgId) {
    s.trackMapMsgId = null
    return
  }
  try {
    await ctx.api.deleteMessage(ctx.chat.id, s.trackMapMsgId)
  } catch {
    /* */
  }
  s.trackMapMsgId = null
}

function levelsForSession(s) {
  return difficultiesForTrackM(trackLengthM(s.routeId))
}

function kmForDifficulty(s) {
  if (Array.isArray(s.difficultyKm) && s.difficultyKm.length) return s.difficultyKm
  const lvl = levelsForSession(s).find((d) => d.id === s.difficulty)
  if (lvl?.km?.length) return lvl.km
  return DIFFICULTY[s.difficulty]?.km || []
}

async function render(ctx, text, keyboard) {
  const s = sess(ctx.from.id)
  const opts = {
    parse_mode: 'HTML',
    reply_markup: keyboard,
    link_preview_options: { is_disabled: true },
  }

  if (s.uiKind === 'photo' && s.uiMsgId && ctx.chat?.id) {
    await clearUi(ctx, s)
  }

  const cbMsg = ctx.callbackQuery?.message
  const cbIsPhoto = Boolean(cbMsg?.photo?.length)
  if (cbMsg && s.uiKind !== 'photo' && !cbIsPhoto) {
    try {
      await ctx.editMessageText(text, opts)
      s.uiMsgId = cbMsg.message_id
      s.uiKind = 'text'
      await safeAnswerCb(ctx)
      return
    } catch (e) {
      const desc = String(e?.description || e?.message || e)
      if (desc.includes('message is not modified')) {
        await safeAnswerCb(ctx)
        return
      }
    }
  }
  if (s.uiMsgId && ctx.chat?.id && s.uiKind === 'text') {
    try {
      await ctx.api.editMessageText(ctx.chat.id, s.uiMsgId, text, opts)
      await safeAnswerCb(ctx)
      return
    } catch {
      /* */
    }
  }
  const msg = await ctx.reply(text, opts)
  s.uiMsgId = msg.message_id
  s.uiKind = 'text'
  await safeAnswerCb(ctx)
}

async function renderPhoto(ctx, caption, png, keyboard) {
  const s = sess(ctx.from.id)
  await safeAnswerCb(ctx)

  if (!png) {
    await render(ctx, caption + '\n\n<i>(карту не удалось загрузить)</i>', keyboard)
    return
  }

  const file = new InputFile(png, 'route.png')
  const opts = { caption, parse_mode: 'HTML', reply_markup: keyboard }

  if (s.uiKind === 'photo' && s.uiMsgId && ctx.chat?.id) {
    try {
      await ctx.api.editMessageMedia(
        ctx.chat.id,
        s.uiMsgId,
        { type: 'photo', media: file, caption, parse_mode: 'HTML' },
        { reply_markup: keyboard },
      )
      return
    } catch {
      await clearUi(ctx, s)
    }
  } else if (s.uiMsgId && ctx.chat?.id) {
    await clearUi(ctx, s)
  }

  const msg = await ctx.replyWithPhoto(file, opts)
  s.uiMsgId = msg.message_id
  s.uiKind = 'photo'
}

function hasGeo(s) {
  return s.lat != null && s.lon != null
}

function userPt(s) {
  return { lat: s.lat, lon: s.lon }
}

function startPt(s) {
  return s.start ? { lat: s.start.lat, lon: s.start.lon } : hasGeo(s) ? userPt(s) : null
}

function refreshPointList(s, { excludeStart = false } = {}) {
  const ref = hasGeo(s) ? userPt(s) : startPt(s)
  // всегда вдоль линии — не «в разнобой»
  let list = listRoutePoints(s.routeId, ref, { sort: 'along' })
  if (excludeStart && s.start) {
    list = list.filter((p) => p.id !== s.start.id)
  }
  s.pointList = list
  return list
}

/* ───────── screens ───────── */

async function showMenu(ctx, { welcome = false } = {}) {
  const s = sess(ctx.from.id)
  s.screen = 'menu'
  const startLine = s.start
    ? `Старт: <b>${s.start.name}</b>`
    : hasGeo(s)
      ? `Гео: есть · до линии ≈ ${formatKm(nearestOnTrack(userPt(s), s.routeId).meters)}`
      : 'Старт ещё не выбран'
  const kb = new InlineKeyboard()
    .text('🚀 Выбрать старт', 'go:start_hub')
    .row()
    .text('🗺 Сменить трек', 'go:track')
    .text(s.mode === 'bike' ? '🚲 Вело' : '🚶 Пешком', 'go:mode')
  const intro = welcome ? `${WELCOME_CAPTION}\n\n` : ''
  const caption =
    intro +
    `Трек: <b>${trackTitle(s.routeId)}</b>\n` +
    `Режим: ${s.mode === 'bike' ? 'велосипед' : 'пешком'}\n` +
    `${startLine}\n\n` +
    `Выберите старт → финиш по длине или из точек → <b>Яндекс.Карты</b>.`
  const png = await fetchRouteMapPng([], { routeId: s.routeId || 'zkm-ring' })
  if (png) {
    await renderPhoto(ctx, caption, png, kb)
  } else {
    await render(ctx, caption, kb)
  }
}

async function showTrack(ctx) {
  // Выбор города → маршруты. Главный экран уже на Зелёном кольце.
  return showCities(ctx)
}

async function showCities(ctx) {
  const s = sess(ctx.from.id)
  s.screen = 'cities'
  const kb = new InlineKeyboard()
  kb.text('⭐ Сохранённые треки', 'go:saved').row()
  for (const c of citiesList()) {
    const n = routesForCityId(c.id).length
    const mark = c.id === (s.cityId || 'msk') ? '✓ ' : ''
    kb.text(truncateBtn(`${mark}${c.emoji || ''} ${c.title} · ${n}`), `city:${c.id}`).row()
  }
  addNav(kb, 'menu')
  await render(
    ctx,
    '<b>Город</b>\nСейчас активен трек: <b>' +
      trackTitle(s.routeId) +
      '</b>\n\nВыберите город — откроется список маршрутов.\nМожно прислать GPX / KML / FIT в этот чат.',
    kb,
  )
}

async function showCityRoutes(ctx, cityId) {
  const s = sess(ctx.from.id)
  s.screen = 'track'
  s.cityId = cityId || s.cityId || 'msk'
  const city = cityMeta(s.cityId)
  const routes = routesForCityId(s.cityId)
  const kb = new InlineKeyboard()
  if (!routes.length) {
    kb.text('← К городам', 'go:cities').row()
    addNav(kb, 'cities')
    await render(ctx, `<b>${city.emoji || ''} ${city.title}</b>\nПока нет маршрутов в каталоге.`, kb)
    return
  }
  for (const r of routes.slice(0, 14)) {
    const featured = r.id === 'zkm-ring' || r.featured
    const mark = r.id === s.routeId ? '✓ ' : featured ? '⭐ ' : ''
    const diff = r.difficulty && !featured ? ` · ${diffLabel(r.difficulty)}` : ''
    kb.text(truncateBtn(`${mark}${r.title} · ${r.kmListed} км${diff}`), `track:${r.id}`).row()
  }
  kb.text('← К городам', 'go:cities').row()
  addNav(kb, 'cities')
  await render(
    ctx,
    `<b>${city.emoji || ''} ${city.title}</b>\n${city.subtitle || 'Выберите маршрут'}\nМожно прислать файл GPX / KML / FIT.`,
    kb,
  )
}

function diffLabel(d) {
  return ({ easy: 'лёгкий', medium: 'средний', hard: 'тяжёлый', hardcore: 'хардкор' })[d] || d
}

async function showSavedTracks(ctx) {
  const s = sess(ctx.from.id)
  s.screen = 'saved'
  let items = []
  try {
    items = await apiListTracks(ctx.from.id)
  } catch (e) {
    await render(
      ctx,
      `Не удалось загрузить сохранённые треки.\n${e.message || e}\n\nПришлите GPX/KML/FIT сюда — сохранится автоматически.`,
      new InlineKeyboard().text('« К городам', 'go:cities').text('⌂ Главная', 'nav:menu'),
    )
    return
  }
  const kb = new InlineKeyboard()
  if (!items.length) {
    kb.text('« К городам', 'go:cities').row()
    kb.text('⌂ Главная', 'nav:menu')
    await render(
      ctx,
      '<b>Сохранённые треки</b>\nПока пусто.\nПришлите файл GPX / KML / FIT в этот чат или загрузите на green-route.ru',
      kb,
    )
    return
  }
  for (const it of items.slice(0, 12)) {
    const km = (it.lengthM / 1000).toFixed(1)
    kb.text(truncateBtn(`${it.title} · ${km} км`), `saved:${it.id}`).row()
  }
  kb.text('« К городам', 'go:cities').row()
  kb.text('⌂ Главная', 'nav:menu')
  await render(ctx, '<b>Сохранённые треки</b>\nВыберите трек:', kb)
}

async function activateSavedTrack(ctx, trackId) {
  const s = sess(ctx.from.id)
  const track = await apiGetTrack(ctx.from.id, trackId)
  const coords = track.geojson?.geometry?.coordinates || []
  const pts = coords.map(([lon, lat]) => ({ lat, lon }))
  if (pts.length < 2) throw new Error('Пустой трек')
  const routeId = `saved:${trackId}`
  putSavedTrack(routeId, pts, track.title || 'Сохранённый трек')
  s.routeId = routeId
  s.screen = 'track_preview'
  await clearTrackMap(ctx, s)
  const png =
    (await apiPreviewPng(ctx.from.id, trackId)) ||
    (await fetchRouteMapPng(pts, { routeId, cacheKey: `full:${routeId}` }))
  const kb = new InlineKeyboard().text('✅ Выбрать этот трек', 'track_ok').row()
  addNav(kb, 'saved')
  await renderPhoto(
    ctx,
    `🗺 <b>${track.title || 'Сохранённый трек'}</b>\n` +
      `≈ ${(track.lengthM / 1000).toFixed(1)} км\n` +
      `Зелёная линия — весь маршрут.`,
    png,
    kb,
  )
}

async function showTrackPreview(ctx) {
  const s = sess(ctx.from.id)
  s.screen = 'track_preview'
  await clearTrackMap(ctx, s)
  const title = trackTitle(s.routeId)
  const meta = routeCatalog.find((r) => r.id === s.routeId)
  const pts = loadTrackPoints(s.routeId)
  const png = await fetchRouteMapPng(pts, { routeId: s.routeId, cacheKey: `full:${s.routeId}` })
  const kb = new InlineKeyboard().text('✅ Выбрать этот трек', 'track_ok').row()
  addNav(kb, 'city_routes')
  await renderPhoto(
    ctx,
    `🗺 <b>${title}</b>\n` +
      (meta ? `≈ ${meta.kmListed} км по каталогу\n` : '') +
      `Зелёная линия — весь маршрут.`,
    png,
    kb,
  )
}

async function showMode(ctx) {
  const s = sess(ctx.from.id)
  s.screen = 'mode'
  const kb = new InlineKeyboard()
    .text(s.mode === 'bike' ? '✓ 🚲 Велосипед' : '🚲 Велосипед', 'mode:bike')
    .text(s.mode === 'walk' ? '✓ 🚶 Пешком' : '🚶 Пешком', 'mode:walk')
    .row()
  addNav(kb, 'menu')
  await render(ctx, '<b>Режим движения</b>\nВлияет на оценку времени.', kb)
}

async function showStartHub(ctx) {
  const s = sess(ctx.from.id)
  s.screen = 'start_hub'
  s.pending = null
  s.awaitingAddress = false
  s.addressCandidates = []
  s.rawGeo = null
  const city = cityOf(s.cityId)
  const kb = new InlineKeyboard()
    .text('📍 От моей геолокации', 'start:geo')
    .row()
    .text('🏘 Указать адрес', 'start:address')
    .row()
    .text('📌 Из точек на линии', 'start:list')
    .row()
  addNav(kb, 'menu')
  const caption =
    `<b>Выбор старта</b>\n` +
    `Трек: ${trackTitle(s.routeId)}\n` +
    `Город: ${city.title}\n\n` +
    `· <b>Геолокация</b> — с подтверждением (гео иногда врёт)\n` +
    `· <b>Адрес</b> — напишите улицу, выберете из вариантов\n` +
    `· <b>Точки</b> — список вдоль линии`
  const png = await fetchRouteMapPng([], {
    routeId: s.routeId || 'zkm-ring',
    cacheKey: `full:${s.routeId || 'zkm-ring'}`,
  })
  if (png) {
    await renderPhoto(ctx, caption, png, kb)
  } else {
    await render(ctx, caption, kb)
  }
}

async function askAddressForStart(ctx) {
  const s = sess(ctx.from.id)
  s.screen = 'need_address'
  s.awaitingAddress = true
  s.geoIntent = null
  s.addressCandidates = []
  const city = cityOf(s.cityId)
  await render(
    ctx,
    `<b>Адрес для старта</b>\n` +
      `Ищем только в: <b>${city.title}</b>\n\n` +
      `Напишите адрес одним сообщением.\n` +
      `Например: <i>Грузинский вал 7</i> или <i>ВДНХ</i>.\n` +
      `Можно координаты: <i>55.75, 37.62</i>\n\n` +
      `Покажем варианты — выберите нужный.`,
    addNav(new InlineKeyboard(), 'start_hub'),
  )
}

/** Варианты адреса кнопками. */
async function showAddressCandidates(ctx, query, candidates) {
  const s = sess(ctx.from.id)
  s.screen = 'address_pick'
  s.awaitingAddress = false
  s.addressCandidates = candidates
  const kb = new InlineKeyboard()
  for (let i = 0; i < candidates.length; i++) {
    kb.text(truncateBtn(candidates[i].label), `apick:${i}`).row()
  }
  kb.text('✏️ Другой запрос', 'start:address').row()
  addNav(kb, 'start_hub')
  await render(
    ctx,
    `<b>Варианты адреса</b>\n` +
      `Запрос: <i>${escapeHtml(query)}</i>\n` +
      `Выберите подходящий — дальше ближайшая точка на линии.`,
    kb,
  )
}

function escapeHtml(t) {
  return String(t)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

async function showStartFromPlace(ctx, place) {
  const s = sess(ctx.from.id)
  s.lat = place.lat
  s.lon = place.lon
  s.addressLabel = place.label
  s.awaitingAddress = false
  s.rawGeo = null
  const near = nearestOnTrack({ lat: place.lat, lon: place.lon }, s.routeId)
  s.pending = {
    id: `addr:${near.point.lat.toFixed(4)},${near.point.lon.toFixed(4)}`,
    name: 'Ближайшая к адресу',
    lat: near.point.lat,
    lon: near.point.lon,
  }
  s.screen = 'start_geo'
  const png = await fetchPointMapPng(near.point, {
    routeId: s.routeId,
    cacheKey: `addr:${s.routeId}:${near.point.lat.toFixed(4)}`,
  })
  const kb = new InlineKeyboard()
    .text('✅ Подтвердить старт', 'start:confirm')
    .row()
    .text('🏘 Другой адрес', 'start:address')
    .row()
    .text('📌 Из точек', 'start:list')
    .row()
  addNav(kb, 'start_hub')
  await renderPhoto(
    ctx,
    `<b>Старт по адресу</b>\n` +
      `${escapeHtml(place.label)}\n` +
      `До линии ≈ <b>${formatKm(near.meters)}</b>\n` +
      `На карте — ближайшая точка трека.`,
    png,
    kb,
  )
}

async function askGeoForStart(ctx) {
  const s = sess(ctx.from.id)
  s.screen = 'need_geo'
  s.geoIntent = 'start'
  s.awaitingAddress = false
  await render(
    ctx,
    '<b>Геолокация для старта</b>\n' +
      'Пришлите гео — потом попросим подтвердить (сигнал иногда врёт).\n\n' +
      'Кнопка ниже или: скрепка → Геопозиция.',
    addNav(new InlineKeyboard(), 'start_hub'),
  )
  await ctx.reply('Жду геолокацию 👇', { reply_markup: geoKb() })
}

/** Подтверждение сырого гео до привязки к линии — карта с точкой GPS. */
async function showGeoRawConfirm(ctx) {
  const s = sess(ctx.from.id)
  if (!s.rawGeo && !hasGeo(s)) return askGeoForStart(ctx)
  const pt = s.rawGeo || userPt(s)
  s.rawGeo = pt
  s.screen = 'geo_raw'
  const rev = await reverseGeocode(pt.lat, pt.lon, s.cityId || 'msk')
  const where = rev?.label
    ? `<b>${escapeHtml(rev.label)}</b>`
    : `<b>${pt.lat.toFixed(5)}, ${pt.lon.toFixed(5)}</b>`
  const near = s.routeId ? nearestOnTrack(pt, s.routeId) : null
  // Зелёная = ближайшая точка на линии (куда встанет старт); синяя = GPS телефона
  const png = await fetchPointMapPng(near?.point || pt, {
    routeId: s.routeId || undefined,
    user: pt,
    cacheKey: `georaw:${pt.lat.toFixed(5)},${pt.lon.toFixed(5)}:${s.routeId || 'none'}`,
  })
  const kb = new InlineKeyboard()
    .text('✅ Да, я тут', 'geo:ok')
    .row()
    .text('❌ Нет, неверно', 'geo:bad')
    .row()
  addNav(kb, 'start_hub')
  const caption =
    `<b>Вы находитесь тут?</b>\n` +
    `🔵 синяя — гео телефона\n` +
    (near ? `🟢 зелёная — куда поставим старт на линии\n` : '') +
    `${where}\n` +
    `<code>${pt.lat.toFixed(5)}, ${pt.lon.toFixed(5)}</code>\n` +
    (near ? `\nДо линии ≈ <b>${formatKm(near.meters)}</b>.` : '') +
    `\n\nЕсли точка не там — «Нет» и адрес/гео снова.`
  await renderPhoto(ctx, caption, png, kb)
}

/** Если гео не подтвердили — снова гео или адрес. */
async function showGeoFallback(ctx) {
  const s = sess(ctx.from.id)
  s.screen = 'geo_fallback'
  s.rawGeo = null
  const kb = new InlineKeyboard()
    .text('📍 Прислать гео снова', 'start:geo')
    .row()
    .text('🏘 Указать адрес', 'start:address')
    .row()
    .text('📌 Из точек на линии', 'start:list')
    .row()
  addNav(kb, 'start_hub')
  await render(
    ctx,
    '<b>Гео не подошло</b>\n' +
      'Можно прислать геолокацию ещё раз (скрепка → Геопозиция)\n' +
      'или ввести ближайший адрес.',
    kb,
  )
}

async function showStartGeoConfirm(ctx) {
  const s = sess(ctx.from.id)
  if (!hasGeo(s)) return askGeoForStart(ctx)
  s.screen = 'start_geo'
  s.rawGeo = null
  const near = nearestOnTrack(userPt(s), s.routeId)
  s.pending = {
    id: `geo:${near.point.lat.toFixed(4)},${near.point.lon.toFixed(4)}`,
    name: 'Ближайшая точка на линии',
    lat: near.point.lat,
    lon: near.point.lon,
  }
  const png = await fetchPointMapPng(near.point, {
    routeId: s.routeId,
    cacheKey: `near:${s.routeId}:${near.point.lat.toFixed(4)}`,
  })
  const kb = new InlineKeyboard()
    .text('✅ Подтвердить старт', 'start:confirm')
    .row()
    .text('❌ Гео было неверным', 'geo:bad')
    .row()
    .text('📌 Выбрать из точек', 'start:list')
    .row()
  addNav(kb, 'start_hub')
  await renderPhoto(
    ctx,
    `<b>Старт на линии</b>\n` +
      `Гео подтверждено. На карте — <b>точка на зелёном треке</b> (не станция метро).\n` +
      `До линии от гео было ≈ <b>${formatKm(near.meters)}</b>\n` +
      `Маршрут: «${trackTitle(s.routeId)}».`,
    png,
    kb,
  )
}

async function showStartList(ctx) {
  const s = sess(ctx.from.id)
  s.screen = 'start_list'
  refreshPointList(s)
  if (!s.pointList.length) {
    await render(
      ctx,
      'На этом треке пока нет точек для выбора.\nПопробуйте старт по геолокации.',
      addNav(new InlineKeyboard().text('📍 По геолокации', 'start:geo').row(), 'start_hub'),
    )
    return
  }
  const pages = Math.max(1, Math.ceil(s.pointList.length / PAGE_SIZE))
  s.page = Math.min(s.page || 0, pages - 1)
  const slice = s.pointList.slice(s.page * PAGE_SIZE, s.page * PAGE_SIZE + PAGE_SIZE)
  const kb = new InlineKeyboard()
  for (let i = 0; i < slice.length; i++) {
    const p = slice[i]
    const abs = s.page * PAGE_SIZE + i
    kb.text(truncateBtn(p.name), `spick:${abs}`).row()
  }
  if (pages > 1) {
    const prev = s.page > 0 ? `spage:${s.page - 1}` : 'noop'
    const next = s.page < pages - 1 ? `spage:${s.page + 1}` : 'noop'
    kb.text('‹', prev).text(`${s.page + 1}/${pages}`, 'noop').text('›', next).row()
  }
  addNav(kb, 'start_hub')
  await render(
    ctx,
    `<b>Точки старта</b>\n${trackTitle(s.routeId)}\nПорядок: вдоль линии.\nНажмите точку — покажем карту.`,
    kb,
  )
}

async function showStartPointPreview(ctx, absIdx) {
  const s = sess(ctx.from.id)
  const p = s.pointList[absIdx]
  if (!p) return showStartList(ctx)
  s.screen = 'start_preview'
  s.pending = { id: p.id, name: p.name, lat: p.lat, lon: p.lon }
  const png = await fetchPointMapPng(p, { routeId: s.routeId, cacheKey: `poi:${s.routeId}:${p.id}` })
  const kb = new InlineKeyboard().text('✅ Подтвердить старт', 'start:confirm').row()
  addNav(kb, 'start_list')
  await renderPhoto(
    ctx,
    `<b>${p.name}</b>\n` +
      `Старт на линии «${trackTitle(s.routeId)}».\n` +
      (p.distFromRef != null ? `≈ ${formatKm(p.distFromRef)} от вас.\n` : '') +
      `Подтвердите или вернитесь к списку.`,
    png,
    kb,
  )
}

async function confirmStart(ctx) {
  const s = sess(ctx.from.id)
  if (!s.pending) return showStartHub(ctx)
  s.start = { ...s.pending }
  s.pending = null
  s.geoIntent = null
  await showFinishHub(ctx)
}

async function showFinishHub(ctx) {
  const s = sess(ctx.from.id)
  if (!s.start) return showStartHub(ctx)
  s.screen = 'finish_hub'
  s.finishMode = null
  const kb = new InlineKeyboard()
    .text('📏 По длине и направлению', 'finish:length')
    .row()
    .text('🏁 Финиш из точек', 'finish:points')
    .row()
  addNav(kb, 'start_hub')
  await render(
    ctx,
    `<b>Финиш</b>\n` +
      `Старт: <b>${s.start.name}</b>\n` +
      `Трек: ${trackTitle(s.routeId)}\n\n` +
      `· <b>По длине</b> — сложность → направление → км/время\n` +
      `· <b>Из точек</b> — сложность → направление → точки в этом диапазоне`,
    kb,
  )
}

/* —— finish by length (existing wizard) —— */

async function showDifficultyForLength(ctx) {
  const s = sess(ctx.from.id)
  if (!s.start) return showStartHub(ctx)
  const levels = levelsForSession(s)
  if (!levels.length) {
    await render(
      ctx,
      '<b>Сложность</b>\nНа этом треке нет подходящей длины. Выберите другой трек.',
      addNav(new InlineKeyboard(), 'finish_hub'),
    )
    return
  }
  /** Короткий трек: один уровень — сразу направление, без лишних «хардкоров». */
  if (levels.length === 1) {
    s.difficulty = levels[0].id
    s.difficultyKm = levels[0].km
    return showDirection(ctx)
  }
  s.screen = 'difficulty'
  s.difficultyKm = null
  const kb = new InlineKeyboard()
  for (const d of levels) {
    const range = `${d.km[0]}–${d.km[d.km.length - 1]} км`
    kb.text(`${d.emoji} ${d.title} · ${range}`, `diff:${d.id}`).row()
  }
  addNav(kb, 'finish_hub')
  const forPoints = s.finishMode === 'point'
  await render(
    ctx,
    `<b>Сложность</b>\nСтарт: ${s.start.name}\n` +
      (forPoints
        ? 'Дальше — направление, затем только точки в этом диапазоне.'
        : 'Дальше — направление и длина.'),
    kb,
  )
}

async function showDirection(ctx) {
  const s = sess(ctx.from.id)
  s.screen = 'direction'
  const kb = new InlineKeyboard()
    .text('↺ Против часовой', 'dir:ccw')
    .row()
    .text('↻ По часовой', 'dir:cw')
    .row()
  const levels = levelsForSession(s)
  const backTo = levels.length <= 1 ? 'finish_hub' : 'difficulty'
  addNav(kb, backTo)
  const km = kmForDifficulty(s)
  const dMeta = levels.find((d) => d.id === s.difficulty) || DIFFICULTY[s.difficulty]
  await render(
    ctx,
    `<b>Направление</b>\n` +
      `Старт: ${s.start?.name || '—'}\n` +
      (dMeta && km.length
        ? `${dMeta.emoji} ${dMeta.title} · ${km[0]}–${km[km.length - 1]} км`
        : ''),
    kb,
  )
}

async function showDifficulty(ctx) {
  return showDifficultyForLength(ctx)
}

async function showUnits(ctx) {
  const s = sess(ctx.from.id)
  s.screen = 'units'
  const d =
    levelsForSession(s).find((x) => x.id === s.difficulty) || DIFFICULTY[s.difficulty]
  const kb = new InlineKeyboard()
    .text('📏 Километры', 'units:km')
    .row()
    .text('⏱ Часы / минуты', 'units:time')
    .row()
  addNav(kb, 'direction')
  await render(
    ctx,
    `<b>Единицы</b>\n${d?.emoji || ''} ${d?.title || ''} · ${s.direction === 'cw' ? 'по часовой' : 'против'}`,
    kb,
  )
}

async function showDistance(ctx) {
  const s = sess(ctx.from.id)
  s.screen = 'distance'
  const kmList = kmForDifficulty(s)
  const dMeta =
    levelsForSession(s).find((d) => d.id === s.difficulty) || DIFFICULTY[s.difficulty]
  const kb = new InlineKeyboard()
  if (s.units === 'km') {
    const row = []
    for (const km of kmList) {
      row.push({ t: `${km} км`, c: `dist_km:${km}` })
      if (row.length === 3) {
        for (const x of row) kb.text(x.t, x.c)
        kb.row()
        row.length = 0
      }
    }
    if (row.length) {
      for (const x of row) kb.text(x.t, x.c)
      kb.row()
    }
  } else {
    const row = []
    for (const km of kmList) {
      const mins = Math.round(minutesFromMeters(km * 1000, s.mode))
      row.push({ t: `≈ ${formatDuration(mins)}`, c: `dist_km:${km}` })
      if (row.length === 2) {
        for (const x of row) kb.text(x.t, x.c)
        kb.row()
        row.length = 0
      }
    }
    if (row.length) {
      for (const x of row) kb.text(x.t, x.c)
      kb.row()
    }
  }
  addNav(kb, 'units')
  await render(
    ctx,
    `<b>Длина отрезка</b>\nОт: ${s.start.name}` +
      (dMeta ? `\n${dMeta.emoji} ${dMeta.title}` : ''),
    kb,
  )
}

/* —— finish from points —— */

async function showFinishList(ctx) {
  const s = sess(ctx.from.id)
  if (!s.start || !s.direction || !s.difficulty) return showFinishHub(ctx)
  s.screen = 'finish_list'
  s.finishMode = 'point'
  const range = difficultyRangeM(s.difficulty, kmForDifficulty(s))
  refreshPointList(s, { excludeStart: true })

  const withDist = []
  for (const p of s.pointList) {
    const seg = buildSegmentBetween({
      user: hasGeo(s) ? userPt(s) : startPt(s),
      routeId: s.routeId,
      direction: s.direction,
      start: startPt(s),
      end: p,
      mode: s.mode,
    })
    if (range && (seg.meters < range.minM || seg.meters > range.maxM)) continue
    withDist.push({ ...p, meters: seg.meters, minutes: seg.minutes })
  }
  // по возрастанию длины отрезка (= порядок «вперёд» по направлению)
  withDist.sort((a, b) => a.meters - b.meters)
  s.pointList = withDist

  const d =
    levelsForSession(s).find((x) => x.id === s.difficulty) || DIFFICULTY[s.difficulty]
  const km = kmForDifficulty(s)
  if (!s.pointList.length) {
    await render(
      ctx,
      `<b>Нет точек</b> в диапазоне «${d.emoji} ${d.title}» (${km[0]}–${km[km.length - 1]} км).\n` +
        `Выберите другой уровень или финиш по длине.`,
      addNav(
        new InlineKeyboard()
          .text('🟢 Другая сложность', 'finish:points')
          .row()
          .text('📏 По длине', 'finish:length')
          .row(),
        'finish_hub',
      ),
    )
    return
  }

  const pages = Math.max(1, Math.ceil(s.pointList.length / PAGE_SIZE))
  s.page = Math.min(s.page || 0, pages - 1)
  const slice = s.pointList.slice(s.page * PAGE_SIZE, s.page * PAGE_SIZE + PAGE_SIZE)
  const kb = new InlineKeyboard()
  for (let i = 0; i < slice.length; i++) {
    const p = slice[i]
    const abs = s.page * PAGE_SIZE + i
    const label = truncateBtn(
      `${p.name} · ${formatKm(p.meters)} · ≈ ${formatDuration(p.minutes)}`,
    )
    kb.text(label, `fpick:${abs}`).row()
  }
  if (pages > 1) {
    const prev = s.page > 0 ? `fpage:${s.page - 1}` : 'noop'
    const next = s.page < pages - 1 ? `fpage:${s.page + 1}` : 'noop'
    kb.text('‹', prev).text(`${s.page + 1}/${pages}`, 'noop').text('›', next).row()
  }
  addNav(kb, 'direction')
  await render(
    ctx,
    `<b>Финиш из точек</b>\n` +
      `Старт: ${s.start.name}\n` +
      `${d.emoji} ${d.title} · ${km[0]}–${km[km.length - 1]} км\n` +
      `${s.direction === 'cw' ? 'По часовой' : 'Против часовой'}\n` +
      `Точки по порядку длины отрезка.`,
    kb,
  )
}

async function showFinishPointPreview(ctx, absIdx) {
  const s = sess(ctx.from.id)
  const p = s.pointList[absIdx]
  if (!p) return showFinishList(ctx)
  s.screen = 'finish_preview'
  s.pending = { id: p.id, name: p.name, lat: p.lat, lon: p.lon }
  const seg = buildSegmentBetween({
    user: hasGeo(s) ? userPt(s) : startPt(s),
    routeId: s.routeId,
    direction: s.direction,
    start: startPt(s),
    end: p,
    mode: s.mode,
  })
  s.previewSeg = seg
  const png = await fetchRouteMapPng(seg.route, {
    routeId: s.routeId,
    start: seg.start,
    end: seg.end,
    cacheKey: `fin:${s.routeId}:${s.start.id}:${p.id}:${s.direction}`,
  })
  const kb = new InlineKeyboard().text('✅ Подтвердить финиш', 'finish:confirm').row()
  addNav(kb, 'finish_list')
  await renderPhoto(
    ctx,
    `<b>${p.name}</b>\n` +
      `${formatKm(seg.meters)} · ≈ ${formatDuration(seg.minutes)}\n` +
      `${s.direction === 'cw' ? 'по часовой' : 'против часовой'} · от «${s.start.name}»`,
    png,
    kb,
  )
}

async function showApproach(ctx) {
  const s = sess(ctx.from.id)
  s.screen = 'approach'
  const start = startPt(s)
  const distUser = hasGeo(s) && start ? haversineM(userPt(s), start) : 0
  const kb = new InlineKeyboard()
    .text('🚗 Сначала доехать до старта', 'approach:yes')
    .row()
    .text('🛤 Сразу отрезок от линии', 'approach:no')
    .row()
  const back =
    s.finishMode === 'point' ? 'finish_list' : s.finishMode === 'length' ? 'distance' : 'finish_hub'
  addNav(kb, back)
  await render(
    ctx,
    `<b>Как стартовать?</b>\n` +
      `До выбранного старта ≈ <b>${formatKm(distUser)}</b>.\n\n` +
      `· Доехать — Яндекс до старта, потом отрезок\n` +
      `· Сразу отрезок — если вы уже у линии`,
    kb,
  )
}

async function showResult(ctx) {
  const s = sess(ctx.from.id)
  s.screen = 'result'
  let seg
  if (s.finishMode === 'point' && s.pending) {
    seg = buildSegmentBetween({
      user: hasGeo(s) ? userPt(s) : startPt(s),
      routeId: s.routeId,
      direction: s.direction,
      start: startPt(s),
      end: s.pending,
      mode: s.mode,
    })
  } else if (s.previewSeg && s.finishMode === 'point') {
    seg = s.previewSeg
  } else {
    seg = buildSegment({
      user: hasGeo(s) ? userPt(s) : startPt(s),
      routeId: s.routeId,
      direction: s.direction,
      meters: s.meters,
      mode: s.mode,
      startOverride: startPt(s),
    })
  }
  s.lastSeg = seg
  const dir = s.direction === 'cw' ? 'по часовой' : 'против часовой'
  const needApproach =
    s.wantApproach && seg.approachUrl && seg.approachMeters > APPROACH_THRESHOLD_M
  const d = s.difficulty ? DIFFICULTY[s.difficulty] : null

  let caption =
    `✅ <b>Ваш отрезок</b>\n` +
    `${seg.title}\n` +
    `Старт: ${s.start?.name || 'линия'}\n` +
    `${formatKm(seg.meters)} · ≈ ${formatDuration(seg.minutes)} · ${dir}\n` +
    (d ? `${d.emoji} ${d.title} · ` : '') +
    `${s.mode === 'bike' ? 'велосипед' : 'пешком'}\n\n` +
    `На карте: зелёная линия · 🟢 старт · 🔴 финиш.\n`

  if (needApproach) {
    caption += `До старта ≈ <b>${formatKm(seg.approachMeters)}</b>.\n`
  }

  const legs = Array.isArray(seg.mapsLegs) ? seg.mapsLegs : []
  if (legs.length > 1) {
    caption +=
      `\nЯндекс — <b>${legs.length} участка</b> по порядку (так держит тропу через парки).\n`
  }

  const kb = new InlineKeyboard()
  if (needApproach && seg.approachUrl) {
    kb.url(`🚗 Доехать до старта (${formatKm(seg.approachMeters)})`, seg.approachUrl).row()
  }
  if (legs.length > 1) {
    const show = legs.slice(0, 10)
    for (const leg of show) {
      kb.url(
        `🗺 ${leg.index + 1}/${leg.total} · ${formatKm(leg.meters)}`,
        leg.url,
      ).row()
    }
  } else {
    kb.url('🗺 Открыть в Яндекс.Картах', seg.mapsUrl || legs[0]?.url).row()
  }
  const back =
    needApproach || (hasGeo(s) && seg.approachMeters > APPROACH_THRESHOLD_M)
      ? 'approach'
      : s.finishMode === 'point'
        ? 'finish_list'
        : 'distance'
  addNav(kb, back)

  const png = await fetchRouteMapPng(seg.route, {
    routeId: s.routeId,
    start: seg.start,
    end: seg.end,
    cacheKey: `seg:${seg.routeId}:${seg.direction}:${Math.round(seg.meters)}:${seg.start.lat.toFixed(4)}`,
  })
  await renderPhoto(ctx, caption, png, kb)

  trackBot(ctx, 'bot_segment', {
    routeId: s.routeId,
    meters: Math.round(seg.meters || 0),
    mode: s.mode,
    legs: legs.length || 1,
  })

  // Остальные участки — вторым сообщением (лимит кнопок на одном)
  if (legs.length > 10) {
    const kb2 = new InlineKeyboard()
    for (const leg of legs.slice(10)) {
      kb2.url(`🗺 ${leg.index + 1}/${leg.total} · ${formatKm(leg.meters)}`, leg.url).row()
    }
    await ctx.reply(`Ещё участки ${11}–${legs.length}:`, { reply_markup: kb2 })
  }
}

async function afterLengthChosen(ctx) {
  const s = sess(ctx.from.id)
  const start = startPt(s)
  const distUser = hasGeo(s) && start ? haversineM(userPt(s), start) : 0
  if (hasGeo(s) && distUser > APPROACH_THRESHOLD_M) {
    s.wantApproach = null
    return showApproach(ctx)
  }
  s.wantApproach = false
  return showResult(ctx)
}

/* ───────── routing ───────── */

async function go(ctx, screen) {
  switch (screen) {
    case 'menu':
      return showMenu(ctx)
    case 'track':
      return showTrack(ctx)
    case 'cities':
      return showCities(ctx)
    case 'city_routes':
      return showCityRoutes(ctx, sess(ctx.from.id).cityId || 'msk')
    case 'saved':
      return showSavedTracks(ctx)
    case 'track_preview':
      return showTrackPreview(ctx)
    case 'mode':
      return showMode(ctx)
    case 'start_hub':
      return showStartHub(ctx)
    case 'start_list':
      return showStartList(ctx)
    case 'start_geo':
      return showStartGeoConfirm(ctx)
    case 'geo_raw':
      return showGeoRawConfirm(ctx)
    case 'geo_fallback':
      return showGeoFallback(ctx)
    case 'need_address':
      return askAddressForStart(ctx)
    case 'address_pick':
      if (sess(ctx.from.id).addressCandidates?.length) {
        return showAddressCandidates(
          ctx,
          'повтор',
          sess(ctx.from.id).addressCandidates,
        )
      }
      return askAddressForStart(ctx)
    case 'finish_hub':
      return showFinishHub(ctx)
    case 'finish_dir':
      return showDirection(ctx)
    case 'direction':
      return showDirection(ctx)
    case 'difficulty':
      return showDifficultyForLength(ctx)
    case 'units':
      return showUnits(ctx)
    case 'distance':
      return showDistance(ctx)
    case 'finish_list':
      return showFinishList(ctx)
    case 'approach':
      return showApproach(ctx)
    case 'result':
      return showResult(ctx)
    default:
      return showMenu(ctx)
  }
}

/* ───────── handlers ───────── */

function trackBot(ctx, event, props = {}) {
  const u = ctx.from
  if (!u?.id) return
  void apiTrackEvent(u.id, event, {
    username: u.username || undefined,
    firstName: u.first_name || undefined,
    props,
  })
}

bot.command('start', async (ctx) => {
  const s = sess(ctx.from.id)
  clearAuthFlow(s)
  Object.assign(s, {
    uiMsgId: null,
    uiKind: null,
    difficulty: null,
    direction: null,
    units: null,
    meters: null,
    wantApproach: null,
    finishMode: null,
    start: null,
    pending: null,
    previewSeg: null,
    geoIntent: null,
    awaitingAddress: false,
    addressLabel: null,
    addressCandidates: [],
    rawGeo: null,
    cityId: 'msk',
    page: 0,
    trackMapMsgId: null,
  })
  trackBot(ctx, 'bot_start')
  // Одно сообщение: приветствие + меню/карта
  await showMenu(ctx, { welcome: true })
})

bot.command('help', async (ctx) => {
  clearAuthFlow(sess(ctx.from.id))
  await ctx.reply(
    'Выберите старт (гео или точка) → финиш по длине или из точек.\n' +
      '«Назад» и «Меню» на каждом шаге.\n\n' +
      'Файл GPX/KML/FIT — в этот чат → «Сохранённые треки».\n' +
      'Аккаунт сайта: /login или /register\n' +
      'Команды: наберите / — список подсказок.',
  )
})

bot.command('tracks', (ctx) => {
  clearAuthFlow(sess(ctx.from.id))
  return showTrack(ctx)
})

bot.command('saved', (ctx) => {
  clearAuthFlow(sess(ctx.from.id))
  return showSavedTracks(ctx)
})

bot.command('login', async (ctx) => {
  const text = (ctx.message?.text || '').trim()
  const parts = text.split(/\s+/).slice(1)
  // shortcut: /login user pass
  if (parts.length >= 2) {
    clearAuthFlow(sess(ctx.from.id))
    try {
      await authAndLinkTelegram('login', parts[0], parts.slice(1).join(' '), ctx.from.id)
      await ctx.reply(`Готово. Telegram привязан к аккаунту <b>${parts[0]}</b>. Треки сохранены.`, {
        parse_mode: 'HTML',
      })
    } catch (e) {
      await ctx.reply(`Не удалось войти/привязать: ${e.message || e}`)
    }
    return
  }
  await beginAuthFlow(ctx, 'login')
})

bot.command('register', async (ctx) => {
  const text = (ctx.message?.text || '').trim()
  const parts = text.split(/\s+/).slice(1)
  if (parts.length >= 2) {
    clearAuthFlow(sess(ctx.from.id))
    try {
      await authAndLinkTelegram('register', parts[0], parts.slice(1).join(' '), ctx.from.id)
      await ctx.reply(`Готово. Аккаунт <b>${parts[0]}</b> создан и привязан к Telegram.`, {
        parse_mode: 'HTML',
      })
    } catch (e) {
      await ctx.reply(`Не удалось зарегистрировать: ${e.message || e}`)
    }
    return
  }
  await beginAuthFlow(ctx, 'register')
})

bot.on('message:text', async (ctx) => {
  if (await handleAuthText(ctx)) return
  const s = sess(ctx.from.id)
  if (!s.awaitingAddress) return
  const text = ctx.message.text?.trim()
  if (!text || text.startsWith('/')) return
  s.awaitingAddress = false
  try {
    await ctx.reply('Ищу адрес…')
    const candidates = await geocodeCandidates(text, s.cityId || 'msk', 5)
    if (!candidates.length) {
      s.awaitingAddress = true
      await ctx.reply(
        `Не нашёл в «${cityOf(s.cityId).title}». Попробуйте ещё раз: улица + номер или координаты.`,
      )
      return
    }
    s.uiMsgId = null
    s.uiKind = null
    if (candidates.length === 1) {
      await showStartFromPlace(ctx, candidates[0])
    } else {
      await showAddressCandidates(ctx, text, candidates)
    }
  } catch (e) {
    console.error('[zm-bot] address', e)
    s.awaitingAddress = true
    await ctx.reply('Не удалось разобрать адрес. Попробуйте ещё раз или геолокацию.')
  }
})

bot.on('message:location', async (ctx) => {
  trackBot(ctx, 'bot_geo')
  const s = sess(ctx.from.id)
  try {
    s.awaitingAddress = false
    s.lat = ctx.message.location.latitude
    s.lon = ctx.message.location.longitude
    s.rawGeo = { lat: s.lat, lon: s.lon }
    s.uiMsgId = null
    s.uiKind = null
    await ctx.reply('Гео получил ✓', { reply_markup: { remove_keyboard: true } })
    await showGeoRawConfirm(ctx)
  } catch (e) {
    console.error('[zm-bot] location handler', e)
    try {
      await ctx.reply('Не удалось показать гео. Нажмите /start и попробуйте ещё раз.')
    } catch {
      /* */
    }
  }
})

bot.callbackQuery('noop', async (ctx) => {
  await ctx.answerCallbackQuery()
})

bot.callbackQuery('nav:menu', async (ctx) => {
  await go(ctx, 'menu')
})

bot.callbackQuery(/^back:(.+)$/, async (ctx) => {
  await go(ctx, ctx.match[1])
})

bot.callbackQuery(/^go:(.+)$/, async (ctx) => {
  await go(ctx, ctx.match[1])
})

bot.callbackQuery(/^city:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery()
  await showCityRoutes(ctx, ctx.match[1])
})

bot.callbackQuery(/^track:(.+)$/, async (ctx) => {
  sess(ctx.from.id).routeId = ctx.match[1]
  trackBot(ctx, 'bot_track_select', { routeId: ctx.match[1] })
  await ctx.answerCallbackQuery({ text: trackTitle(sess(ctx.from.id).routeId) })
  await showTrackPreview(ctx)
})

bot.callbackQuery(/^saved:(.+)$/, async (ctx) => {
  try {
    await ctx.answerCallbackQuery({ text: 'Загружаю…' })
    await activateSavedTrack(ctx, ctx.match[1])
  } catch (e) {
    await render(ctx, `Не удалось открыть трек.\n${e.message || e}`, new InlineKeyboard().text('« Назад', 'go:saved'))
  }
})

bot.on('message:document', async (ctx) => {
  const doc = ctx.message.document
  const name = doc?.file_name || 'track.gpx'
  const ok = /\.(gpx|kml|fit)$/i.test(name) || /gpx|kml|fit/i.test(doc?.mime_type || '')
  if (!ok) {
    await ctx.reply('Пришлите файл с расширением .gpx, .kml или .fit')
    return
  }
  try {
    await ctx.reply('Принял файл, разбираю…')
    const file = await ctx.getFile()
    const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Telegram file HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const data = await apiUploadTrack(ctx.from.id, buf, name)
    const track = data.track
    const coords = track.geojson?.geometry?.coordinates || []
    const pts = coords.map(([lon, lat]) => ({ lat, lon }))
    const routeId = `saved:${track.id}`
    putSavedTrack(routeId, pts, track.title || name)
    sess(ctx.from.id).routeId = routeId
    await activateSavedTrack(ctx, track.id)
  } catch (e) {
    await ctx.reply(`Не удалось разобрать файл: ${e.message || e}`)
  }
})

bot.callbackQuery('track_ok', async (ctx) => {
  await ctx.answerCallbackQuery({ text: 'Трек выбран' })
  const s = sess(ctx.from.id)
  await pinTrackMap(ctx, s)
  await showStartHub(ctx)
})

bot.callbackQuery(/^mode:(bike|walk)$/, async (ctx) => {
  sess(ctx.from.id).mode = ctx.match[1]
  await ctx.answerCallbackQuery({
    text: ctx.match[1] === 'bike' ? 'Велосипед' : 'Пешком',
  })
  await showMenu(ctx)
})

bot.callbackQuery('start:geo', async (ctx) => {
  const s = sess(ctx.from.id)
  s.awaitingAddress = false
  await askGeoForStart(ctx)
})

bot.callbackQuery('start:address', async (ctx) => {
  await askAddressForStart(ctx)
})

bot.callbackQuery('geo:ok', async (ctx) => {
  const s = sess(ctx.from.id)
  if (s.rawGeo) {
    s.lat = s.rawGeo.lat
    s.lon = s.rawGeo.lon
  }
  s.geoIntent = null
  await showStartGeoConfirm(ctx)
})

bot.callbackQuery('geo:bad', async (ctx) => {
  await showGeoFallback(ctx)
})

bot.callbackQuery(/^apick:(\d+)$/, async (ctx) => {
  const s = sess(ctx.from.id)
  const i = Number(ctx.match[1])
  const place = s.addressCandidates?.[i]
  if (!place) {
    await ctx.answerCallbackQuery({ text: 'Вариант устарел' })
    return askAddressForStart(ctx)
  }
  await showStartFromPlace(ctx, place)
})

bot.callbackQuery('start:list', async (ctx) => {
  sess(ctx.from.id).awaitingAddress = false
  sess(ctx.from.id).page = 0
  await showStartList(ctx)
})

bot.callbackQuery('start:confirm', async (ctx) => {
  sess(ctx.from.id).awaitingAddress = false
  await confirmStart(ctx)
})

bot.callbackQuery(/^spage:(\d+)$/, async (ctx) => {
  sess(ctx.from.id).page = Number(ctx.match[1])
  await showStartList(ctx)
})

bot.callbackQuery(/^spick:(\d+)$/, async (ctx) => {
  await showStartPointPreview(ctx, Number(ctx.match[1]))
})

bot.callbackQuery('finish:length', async (ctx) => {
  const s = sess(ctx.from.id)
  s.finishMode = 'length'
  s.difficulty = null
  s.difficultyKm = null
  s.direction = null
  s.units = null
  s.meters = null
  await showDifficultyForLength(ctx)
})

bot.callbackQuery('finish:points', async (ctx) => {
  const s = sess(ctx.from.id)
  s.finishMode = 'point'
  s.difficulty = null
  s.difficultyKm = null
  s.direction = null
  s.page = 0
  await showDifficultyForLength(ctx)
})

bot.callbackQuery(/^diff:(.+)$/, async (ctx) => {
  const id = ctx.match[1]
  const s = sess(ctx.from.id)
  const levels = levelsForSession(s)
  const lvl = levels.find((d) => d.id === id)
  if (!lvl) {
    await ctx.answerCallbackQuery({ text: 'Недоступно на этом треке' })
    return showDifficultyForLength(ctx)
  }
  s.difficulty = id
  s.difficultyKm = lvl.km
  await showDirection(ctx)
})

bot.callbackQuery(/^dir:(cw|ccw)$/, async (ctx) => {
  const s = sess(ctx.from.id)
  s.direction = ctx.match[1]
  if (s.finishMode === 'point') {
    s.page = 0
    await showFinishList(ctx)
  } else {
    await showUnits(ctx)
  }
})

bot.callbackQuery(/^units:(km|time)$/, async (ctx) => {
  sess(ctx.from.id).units = ctx.match[1]
  await showDistance(ctx)
})

bot.callbackQuery(/^dist_km:(\d+)$/, async (ctx) => {
  sess(ctx.from.id).meters = Number(ctx.match[1]) * 1000
  await afterLengthChosen(ctx)
})

bot.callbackQuery(/^fpage:(\d+)$/, async (ctx) => {
  sess(ctx.from.id).page = Number(ctx.match[1])
  await showFinishList(ctx)
})

bot.callbackQuery(/^fpick:(\d+)$/, async (ctx) => {
  await showFinishPointPreview(ctx, Number(ctx.match[1]))
})

bot.callbackQuery('finish:confirm', async (ctx) => {
  const s = sess(ctx.from.id)
  s.finishMode = 'point'
  await afterLengthChosen(ctx)
})

bot.callbackQuery(/^approach:(yes|no)$/, async (ctx) => {
  sess(ctx.from.id).wantApproach = ctx.match[1] === 'yes'
  await showResult(ctx)
})

bot.catch((err) => console.error('[zm-bot]', err.error || err))

console.log('[zm-bot] starting…')

async function runBot() {
  // drop_pending + retry на 409: при деплое старый реплика ещё держит getUpdates
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      await bot.start({
        drop_pending_updates: true,
        onStart: async (info) => {
          try {
            await bot.api.setMyCommands([
              { command: 'start', description: 'Меню и инструкция' },
              { command: 'tracks', description: 'Выбрать трек' },
              { command: 'saved', description: 'Сохранённые треки' },
              { command: 'login', description: 'Войти и привязать аккаунт' },
              { command: 'register', description: 'Регистрация на сайте' },
              { command: 'help', description: 'Справка' },
            ])
          } catch (e) {
            console.warn('[zm-bot] setMyCommands', e)
          }
          console.log(`[zm-bot] @${info.username} online`)
        },
      })
      return
    } catch (e) {
      const desc = String(e?.description || e?.message || e)
      const conflict = desc.includes('409') || /Conflict.*getUpdates/i.test(desc)
      if (conflict && attempt < 8) {
        const waitMs = 2000 * attempt
        console.warn(`[zm-bot] getUpdates conflict (attempt ${attempt}/8), retry in ${waitMs}ms`)
        await new Promise((r) => setTimeout(r, waitMs))
        continue
      }
      throw e
    }
  }
}

runBot().catch((e) => {
  console.error('[zm-bot] fatal', e)
  process.exit(1)
})

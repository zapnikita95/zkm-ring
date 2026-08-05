import type { LatLon } from './geo'
import { haversineM, nearestIndex } from './geo'
import type { Landmark } from './data'

const cache = new Map<string, string>()

/** Rough ring sectors around Moscow centre for offline labels. */
const SECTORS: Array<{ name: string; bearing: number }> = [
  { name: 'район ВДНХ / Ботанический сад', bearing: 20 },
  { name: 'район Ростокино / Ярославское ш.', bearing: 45 },
  { name: 'район Измайлово', bearing: 80 },
  { name: 'район Кусково / Вешняки', bearing: 110 },
  { name: 'район Кузьминки', bearing: 140 },
  { name: 'район Царицыно / Бирюлёво', bearing: 175 },
  { name: 'район Битцевский лес / Ясенево', bearing: 210 },
  { name: 'район Воробьёвы горы / Раменки', bearing: 245 },
  { name: 'район Фили / Крылатское', bearing: 275 },
  { name: 'район Серебряный Бор / Строгино', bearing: 305 },
  { name: 'район Покровское-Стрешнево', bearing: 330 },
  { name: 'район Тимирязевский / Останкино', bearing: 350 },
]

const MOSCOW = { lat: 55.7558, lon: 37.6173 }

function bearingFromCenter(p: LatLon): number {
  const y = Math.sin(((p.lon - MOSCOW.lon) * Math.PI) / 180) * Math.cos((p.lat * Math.PI) / 180)
  const x =
    Math.cos((MOSCOW.lat * Math.PI) / 180) * Math.sin((p.lat * Math.PI) / 180) -
    Math.sin((MOSCOW.lat * Math.PI) / 180) *
      Math.cos((p.lat * Math.PI) / 180) *
      Math.cos(((p.lon - MOSCOW.lon) * Math.PI) / 180)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

export function sectorName(p: LatLon): string {
  const b = bearingFromCenter(p)
  let best = SECTORS[0]
  let bestD = 999
  for (const s of SECTORS) {
    let d = Math.abs(s.bearing - b)
    if (d > 180) d = 360 - d
    if (d < bestD) {
      bestD = d
      best = s
    }
  }
  return best.name
}

/** Ориентиры для подписи старта: парки/озёра на карте, без якорей и заметок. */
export function namedLandmarksForStart(landmarks: Landmark[]): Landmark[] {
  return landmarks.filter(
    (l) =>
      !l.mapHidden &&
      !l.listOnly &&
      l.category !== 'alert' &&
      l.category !== 'note' &&
      !/^Зелёная дуга/i.test(l.name),
  )
}

export function nearestLandmarkName(p: LatLon, landmarks: Landmark[], maxM = 900): Landmark | null {
  const pool = namedLandmarksForStart(landmarks)
  let best: Landmark | null = null
  let bestD = maxM
  for (const lm of pool) {
    const d = haversineM(p, lm)
    if (d < bestD) {
      bestD = d
      best = lm
    }
  }
  return best
}

async function nominatim(p: LatLon): Promise<string | null> {
  const key = `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`
  if (cache.has(key)) return cache.get(key)!
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${p.lat}&lon=${p.lon}&accept-language=ru&zoom=16`
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'ZelenyMarshrut/1.0 (local app)' },
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      name?: string
      display_name?: string
      address?: Record<string, string>
    }
    const a = data.address || {}
    const parts = [
      data.name,
      a.road || a.pedestrian || a.cycleway,
      a.suburb || a.neighbourhood || a.city_district,
      a.city || a.town,
    ].filter(Boolean)
    const label = parts.slice(0, 3).join(', ') || data.display_name?.split(',').slice(0, 3).join(',').trim()
    if (label) {
      cache.set(key, label)
      return label
    }
  } catch {
    /* offline */
  }
  return null
}

export type PlaceLabel = {
  title: string
  subtitle: string
  ringPoint: LatLon
  ringIndex: number
  landmark: Landmark | null
}

/**
 * Старт = ближайшая точка на кольце к тапу/GPS.
 * Имя ориентира — только если он почти на этой точке (<180 м), иначе сектор/адрес.
 * Не «перетягиваем» старт к парку за 3 км.
 */
export async function describeRingStart(
  userOrPick: LatLon,
  ring: LatLon[],
  landmarks: Landmark[],
  opts?: { labelOverride?: string },
): Promise<PlaceLabel> {
  const ringIndex = nearestIndex(ring, userOrPick)
  const ringPoint = ring[ringIndex]

  if (opts?.labelOverride?.trim()) {
    return {
      title: opts.labelOverride.trim(),
      subtitle: 'Точка на Зелёном кольце',
      ringPoint,
      ringIndex,
      landmark: nearestLandmarkName(ringPoint, landmarks, 180),
    }
  }

  // только если ориентир реально у выбранной точки кольца
  const nearLm = nearestLandmarkName(ringPoint, landmarks, 180)
  if (nearLm) {
    return {
      title: nearLm.name,
      subtitle: nearLm.description || sectorName(ringPoint),
      ringPoint,
      ringIndex,
      landmark: nearLm,
    }
  }

  const remote = await nominatim(ringPoint)
  const sector = sectorName(ringPoint)
  const shortRemote = remote?.split(',').slice(0, 2).join(',').trim()
  return {
    title: shortRemote || sector.replace(/^район\s+/i, '') || 'Точка на кольце',
    subtitle: 'Точка на Зелёном кольце Москвы',
    ringPoint,
    ringIndex,
    landmark: null,
  }
}

import type { LatLon } from './geo'
import { haversineM, nearestIndex } from './geo'
import type { Landmark } from './data'

export type TurnKind = 'straight' | 'left' | 'right' | 'slight_left' | 'slight_right' | 'arrive'

export type Guidance = {
  turn: TurnKind
  title: string
  detail: string
  distanceM: number
  nextLandmark: string | null
  routeBearing: number
}

export function bearingDeg(a: LatLon, b: LatLon): number {
  const φ1 = (a.lat * Math.PI) / 180
  const φ2 = (b.lat * Math.PI) / 180
  const Δλ = ((b.lon - a.lon) * Math.PI) / 180
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

function normDelta(from: number, to: number): number {
  let d = to - from
  while (d > 180) d -= 360
  while (d < -180) d += 360
  return d
}

export function classifyTurn(deltaDeg: number): TurnKind {
  const a = Math.abs(deltaDeg)
  if (a < 22) return 'straight'
  if (a < 50) return deltaDeg > 0 ? 'slight_right' : 'slight_left'
  if (a < 140) return deltaDeg > 0 ? 'right' : 'left'
  return deltaDeg > 0 ? 'right' : 'left'
}

export function turnTitle(turn: TurnKind): string {
  switch (turn) {
    case 'straight':
      return 'Прямо'
    case 'left':
      return 'Налево'
    case 'right':
      return 'Направо'
    case 'slight_left':
      return 'Плавно налево'
    case 'slight_right':
      return 'Плавно направо'
    case 'arrive':
      return 'Вы на месте'
  }
}

export function turnSymbol(turn: TurnKind): string {
  switch (turn) {
    case 'straight':
      return '↑'
    case 'left':
      return '↰'
    case 'right':
      return '↱'
    case 'slight_left':
      return '↖'
    case 'slight_right':
      return '↗'
    case 'arrive':
      return '★'
  }
}

/** Look ahead along route and produce a human turn cue. */
export function guidanceAlongRoute(
  pos: LatLon,
  route: LatLon[],
  headingDeg: number | null,
  landmarks: Landmark[],
): Guidance {
  if (route.length < 2) {
    return {
      turn: 'arrive',
      title: 'Вы на месте',
      detail: 'Маршрут завершён',
      distanceM: 0,
      nextLandmark: null,
      routeBearing: 0,
    }
  }

  const idx = nearestIndex(route, pos)
  const end = route[route.length - 1]
  const distEnd = haversineM(pos, end)
  if (idx >= route.length - 2 || distEnd < 40) {
    return {
      turn: 'arrive',
      title: 'Финиш рядом',
      detail: `Осталось ${Math.round(distEnd)} м`,
      distanceM: distEnd,
      nextLandmark: null,
      routeBearing: bearingDeg(pos, end),
    }
  }

  // Current path bearing: from nearby point toward points ~60–120 m ahead
  let ahead = idx + 1
  let acc = 0
  while (ahead < route.length - 1 && acc < 70) {
    acc += haversineM(route[ahead - 1], route[ahead])
    ahead++
  }
  const routeBearing = bearingDeg(route[idx], route[Math.min(ahead, route.length - 1)])

  // Find significant bend ahead
  let turnIdx = ahead
  let turnDelta = 0
  let distToTurn = acc
  const base = routeBearing
  for (let i = ahead; i < Math.min(route.length - 1, ahead + 80); i++) {
    const b = bearingDeg(route[i], route[i + 1])
    const d = normDelta(base, b)
    distToTurn += haversineM(route[i - 1] || route[i], route[i])
    if (Math.abs(d) >= 28) {
      turnIdx = i
      turnDelta = d
      break
    }
  }

  const heading = headingDeg != null && !Number.isNaN(headingDeg) ? headingDeg : routeBearing
  const toPath = normDelta(heading, routeBearing)
  let turn: TurnKind
  let distanceM: number

  if (Math.abs(turnDelta) >= 28 && distToTurn < 220) {
    turn = classifyTurn(turnDelta)
    distanceM = Math.max(0, haversineM(pos, route[turnIdx]))
  } else {
    turn = classifyTurn(toPath)
    distanceM = Math.min(150, haversineM(pos, route[Math.min(ahead, route.length - 1)]))
    if (Math.abs(toPath) < 22) turn = 'straight'
  }

  let nextLandmark: string | null = null
  for (let i = idx; i < route.length; i++) {
    for (const lm of landmarks) {
      if (haversineM(route[i], lm) < 90) {
        nextLandmark = lm.name
        break
      }
    }
    if (nextLandmark) break
  }

  const title = turnTitle(turn)
  const distLabel =
    distanceM < 1000 ? `${Math.round(distanceM)} м` : `${(distanceM / 1000).toFixed(1)} км`
  const detail =
    turn === 'straight'
      ? `Продолжайте прямо · ${distLabel}${nextLandmark ? ` · к «${nextLandmark}»` : ''}`
      : `Через ${distLabel}${nextLandmark ? ` · далее «${nextLandmark}»` : ''}`

  return { turn, title, detail, distanceM, nextLandmark, routeBearing }
}

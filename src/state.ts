import type { LatLon } from './geo'
import type { Park } from './data'
import type { TravelMode } from './yandex'

export type Direction = 'ccw' | 'cw'
export type NavKind = 'inapp' | 'yandex'

export type PlannedRoute = {
  mode: TravelMode
  direction: Direction
  targetMeters: number
  targetMinutes: number
  start: LatLon
  route: LatLon[]
  parks: Park[]
  navKind: NavKind
}

const REWARDS_KEY = 'zkm-rewards-v1'

export function loadRewards(): Set<string> {
  try {
    const raw = localStorage.getItem(REWARDS_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as string[]
    return new Set(arr)
  } catch {
    return new Set()
  }
}

export function saveReward(parkId: string): void {
  const s = loadRewards()
  s.add(parkId)
  localStorage.setItem(REWARDS_KEY, JSON.stringify([...s]))
}

export function getGps(): Promise<LatLon> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Геолокация недоступна'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
        }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
    )
  })
}

export function watchGps(
  onPos: (p: LatLon) => void,
  onErr?: (e: GeolocationPositionError) => void,
): number {
  if (!navigator.geolocation) return -1
  return navigator.geolocation.watchPosition(
    (pos) =>
      onPos({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
      }),
    (err) => onErr?.(err),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
  )
}

import type { LatLon } from './geo'
import type { Profile } from './api'

export type Direction = 'ccw' | 'cw'
export type NavKind = 'inapp' | 'yandex'

const REWARDS_KEY = 'zm-local-landmarks-v1'

export function loadLocalVisits(): Set<string> {
  try {
    const raw = localStorage.getItem(REWARDS_KEY)
    if (!raw) return new Set()
    return new Set(JSON.parse(raw) as string[])
  } catch {
    return new Set()
  }
}

export function saveLocalVisit(id: string): void {
  const s = loadLocalVisits()
  s.add(id)
  localStorage.setItem(REWARDS_KEY, JSON.stringify([...s]))
}

export function getGps(): Promise<LatLon> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Геолокация недоступна на этом устройстве.'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => {
        if (err.code === 1) reject(new Error('Разрешите доступ к геолокации в настройках.'))
        else reject(new Error('Не удалось определить ваше местоположение.'))
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 5000 },
    )
  })
}

export function watchGps(
  onPos: (p: LatLon) => void,
  onErr?: (e: GeolocationPositionError) => void,
): number {
  if (!navigator.geolocation) return -1
  return navigator.geolocation.watchPosition(
    (pos) => onPos({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
    (err) => onErr?.(err),
    { enableHighAccuracy: true, maximumAge: 1500, timeout: 25000 },
  )
}

export function formatProfileStats(p: Profile): string {
  const km = (p.totalMeters / 1000).toFixed(1)
  const h = Math.floor(p.totalSeconds / 3600)
  const m = Math.floor((p.totalSeconds % 3600) / 60)
  return `${km} км · ${h} ч ${m} мин · ${p.routesCount} маршрутов`
}

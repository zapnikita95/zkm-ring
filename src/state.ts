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

export type GeoStatus = 'off' | 'pending' | 'on' | 'denied'

export type GpsFix = LatLon & { accuracyM?: number; heading?: number | null }

export type GpsWatchHandle = { stop: () => void }

async function openNativeAppSettings(): Promise<void> {
  try {
    const plat = (
      window as unknown as { Capacitor?: { getPlatform?: () => string } }
    ).Capacitor?.getPlatform?.()
    if (plat === 'ios') {
      window.location.href = 'app-settings:'
      return
    }
    if (plat === 'android') {
      window.location.href =
        'intent:#Intent;action=android.settings.APPLICATION_DETAILS_SETTINGS;scheme=package;package=ru.zeleny.marshrut;end'
    }
  } catch {
    /* ignore */
  }
}

/** Всегда запрашивает permission заново (после «Отказать» — снова диалог / настройки). */
export async function requestGeoAndFix(): Promise<GpsFix> {
  const cap = (window as unknown as {
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string }
  }).Capacitor
  if (cap?.isNativePlatform?.()) {
    const { Geolocation } = await import('@capacitor/geolocation')
    const existing = await Geolocation.checkPermissions()
    const existingLoc = existing.location || existing.coarseLocation
    if (existingLoc === 'denied') {
      await openNativeAppSettings()
      throw new Error(
        'Геолокация запрещена. Откройте доступ в настройках приложения и нажмите GPS снова.',
      )
    }
    const perm = await Geolocation.requestPermissions()
    const loc = perm.location || perm.coarseLocation
    if (loc === 'denied' || loc === 'prompt') {
      if (loc === 'denied') await openNativeAppSettings()
      throw new Error(
        'Геолокация запрещена. Нажмите GPS ещё раз после разрешения в настройках.',
      )
    }
    const pos = await Geolocation.getCurrentPosition({
      enableHighAccuracy: true,
      timeout: 25000,
      maximumAge: 0,
    })
    return {
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      accuracyM: pos.coords.accuracy,
      heading:
        pos.coords.heading != null && !Number.isNaN(pos.coords.heading) ? pos.coords.heading : null,
    }
  }

  if (!navigator.geolocation) {
    throw new Error('Геолокация недоступна на этом устройстве.')
  }

  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracyM: pos.coords.accuracy,
          heading:
            pos.coords.heading != null && !Number.isNaN(pos.coords.heading)
              ? pos.coords.heading
              : null,
        }),
      (err) => {
        if (err.code === 1) {
          reject(
            new Error(
              'Вы отказали в геолокации. Нажмите ещё раз, чтобы запросить разрешение снова (или включите в настройках браузера/системы).',
            ),
          )
        } else {
          reject(new Error('Не удалось получить GPS. Включите геолокацию устройства и повторите.'))
        }
      },
      { enableHighAccuracy: true, timeout: 25000, maximumAge: 0 },
    )
  })
}

/** @deprecated use requestGeoAndFix */
export function getGps(): Promise<GpsFix> {
  return requestGeoAndFix()
}

export async function checkGeoPermission(): Promise<GeoStatus> {
  try {
    const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
    if (cap?.isNativePlatform?.()) {
      const { Geolocation } = await import('@capacitor/geolocation')
      const perm = await Geolocation.checkPermissions()
      const loc = perm.location || perm.coarseLocation
      if (loc === 'granted') return 'on'
      if (loc === 'denied') return 'denied'
      return 'off'
    }
    if (!navigator.permissions?.query) return 'off'
    const r = await navigator.permissions.query({ name: 'geolocation' as PermissionName })
    if (r.state === 'granted') return 'on'
    if (r.state === 'denied') return 'denied'
    return 'off'
  } catch {
    return 'off'
  }
}

export function watchGps(
  onPos: (p: GpsFix) => void,
  onErr?: (e: GeolocationPositionError | Error) => void,
): GpsWatchHandle {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  let stopped = false

  if (cap?.isNativePlatform?.()) {
    let callbackId: string | null = null
    void (async () => {
      try {
        const { Geolocation } = await import('@capacitor/geolocation')
        callbackId = await Geolocation.watchPosition(
          { enableHighAccuracy: true, timeout: 25000, maximumAge: 0 },
          (pos, err) => {
            if (stopped) return
            if (err || !pos) {
              onErr?.(err instanceof Error ? err : new Error(String(err || 'GPS error')))
              return
            }
            onPos({
              lat: pos.coords.latitude,
              lon: pos.coords.longitude,
              accuracyM: pos.coords.accuracy,
              heading:
                pos.coords.heading != null && !Number.isNaN(pos.coords.heading)
                  ? pos.coords.heading
                  : null,
            })
          },
        )
      } catch (e) {
        onErr?.(e instanceof Error ? e : new Error(String(e)))
      }
    })()
    return {
      stop: () => {
        stopped = true
        if (callbackId) {
          void import('@capacitor/geolocation').then(({ Geolocation }) => {
            void Geolocation.clearWatch({ id: callbackId! })
          })
        }
      },
    }
  }

  if (!navigator.geolocation) {
    return { stop: () => undefined }
  }
  const id = navigator.geolocation.watchPosition(
    (pos) =>
      onPos({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracyM: pos.coords.accuracy,
        heading:
          pos.coords.heading != null && !Number.isNaN(pos.coords.heading) ? pos.coords.heading : null,
      }),
    (err) => onErr?.(err),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 25000 },
  )
  return {
    stop: () => {
      stopped = true
      navigator.geolocation.clearWatch(id)
    },
  }
}

export function formatProfileStats(p: Profile): string {
  const km = (p.totalMeters / 1000).toFixed(1)
  const h = Math.floor(p.totalSeconds / 3600)
  const m = Math.floor((p.totalSeconds % 3600) / 60)
  return `${km} км · ${h} ч ${m} мин · ${p.routesCount} маршрутов`
}

const ACTIVE_KEY = 'zm-active-route-v1'

export type StoredActiveRoute = {
  mode: 'walk' | 'bike'
  direction: Direction
  targetMeters: number
  targetMinutes: number
  start: LatLon
  startLabel: string
  end: LatLon
  endLabel: string
  endLandmark: {
    id: string
    name: string
    category: string
    description: string
    radius_m: number
    lat: number
    lon: number
  } | null
  userGps: LatLon | null
  approach: LatLon[]
  route: LatLon[]
  landmarks: Array<{
    id: string
    name: string
    category: string
    description: string
    radius_m: number
    lat: number
    lon: number
  }>
  navKind: NavKind
  needsApproach: boolean
  startedAt: number
}

export function saveActiveRoute(data: StoredActiveRoute): void {
  localStorage.setItem(ACTIVE_KEY, JSON.stringify(data))
}

export function loadActiveRoute(): StoredActiveRoute | null {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as StoredActiveRoute
  } catch {
    return null
  }
}

export function clearActiveRoute(): void {
  localStorage.removeItem(ACTIVE_KEY)
}

export function hasActiveRoute(): boolean {
  return !!loadActiveRoute()
}

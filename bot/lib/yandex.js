import { sampleAlong } from './geo.js'

/** Яндекс.Карты: больше ~6 точек в rtext часто уводит с тропы. */
export const YANDEX_MAX_POINTS = 6

export function yandexMapsUrl(points, mode = 'bike') {
  const capped = points.slice(0, YANDEX_MAX_POINTS)
  const rtext = capped.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join('~')
  const rtt = mode === 'walk' ? 'pd' : 'bc'
  return `https://yandex.ru/maps/?rtext=${rtext}&rtt=${rtt}`
}

/** Навигатор: старт → финиш (мультиточки в navi нестабильны). */
export function yandexNaviUrl(points) {
  if (!points.length) return yandexMapsUrl(points)
  const a = points[0]
  const b = points[points.length - 1]
  return (
    `yandexnavi://build_route_on_map` +
    `?lat_from=${a.lat.toFixed(5)}&lon_from=${a.lon.toFixed(5)}` +
    `&lat_to=${b.lat.toFixed(5)}&lon_to=${b.lon.toFixed(5)}`
  )
}

export function pointsForYandex(route) {
  if (route.length <= YANDEX_MAX_POINTS) return route.slice()
  return sampleAlong(route, YANDEX_MAX_POINTS)
}

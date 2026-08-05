export type Achievement = {
  code: string
  title?: string
  desc?: string
  earnedAt?: string
}

export type Profile = {
  login: string
  createdAt: string
  totalMeters: number
  totalSeconds: number
  routesCount: number
  achievements: Achievement[]
  catalog: Achievement[]
  visits: Array<{ landmark_id: string; category: string; visited_at: string }>
  categoryCounts: Record<string, number>
}

const TOKEN_KEY = 'zm-token'

/** LAN/API base: set at build via VITE_API_BASE, else same host :8787 */
export function apiBase(): string {
  const env = import.meta.env.VITE_API_BASE as string | undefined
  if (env) return env.replace(/\/$/, '')
  if (typeof window !== 'undefined') {
    const { protocol, hostname } = window.location
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return `${protocol}//${hostname}:8787`
    }
    // Capacitor / device: same machine LAN IP baked in, or hostname
    return `${protocol}//${hostname}:8787`
  }
  return 'http://127.0.0.1:8787'
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(t: string | null): void {
  if (t) localStorage.setItem(TOKEN_KEY, t)
  else localStorage.removeItem(TOKEN_KEY)
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Content-Type', 'application/json')
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const res = await fetch(`${apiBase()}${path}`, { ...init, headers })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(data.error || `Ошибка сервера (${res.status})`)
  return data
}

export function register(login: string, password: string) {
  return api<{ token: string; profile: Profile }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ login, password }),
  })
}

export function login(loginName: string, password: string) {
  return api<{ token: string; profile: Profile }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ login: loginName, password }),
  })
}

export function fetchMe() {
  return api<{ profile: Profile }>('/api/me')
}

export function logoutApi() {
  return api<{ ok: boolean }>('/api/auth/logout', { method: 'POST' })
}

export function completeRoute(body: {
  meters: number
  seconds: number
  mode: 'bike' | 'walk'
  landmarks: Array<{ id: string; category: string }>
}) {
  return api<{ profile: Profile; newAchievements: Achievement[] }>('/api/routes/complete', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** Client analytics: Yandex Metrika goals + first-party beacon. */

const SESSION_KEY = 'zm_analytics_sid'
const TOKEN_KEY = 'zm-token'
const GUEST_KEY = 'zm-guest-token'

declare global {
  interface Window {
    ym?: (...args: unknown[]) => void
    __ZM_YM_ID?: number
  }
}

function sessionId(): string {
  try {
    let id = sessionStorage.getItem(SESSION_KEY)
    if (!id) {
      id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
      sessionStorage.setItem(SESSION_KEY, id)
    }
    return id
  } catch {
    return 'anon'
  }
}

function ymId(): number {
  return Number(window.__ZM_YM_ID || 111389829)
}

export function ymGoal(name: string, params?: Record<string, unknown>) {
  try {
    if (typeof window.ym === 'function') {
      if (params) window.ym(ymId(), 'reachGoal', name, params)
      else window.ym(ymId(), 'reachGoal', name)
    }
  } catch {
    /* ignore */
  }
}

export function ymSetUserId(userId: string | number) {
  try {
    if (typeof window.ym === 'function') {
      window.ym(ymId(), 'setUserID', String(userId))
    }
  } catch {
    /* ignore */
  }
}

export function trackClient(event: string, props?: Record<string, unknown>) {
  ymGoal(event, props)
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const token = localStorage.getItem(TOKEN_KEY)
    if (token) headers.Authorization = `Bearer ${token}`
    const guest = localStorage.getItem(GUEST_KEY)
    if (guest) headers['X-Guest-Token'] = guest
    void fetch('/api/analytics/event', {
      method: 'POST',
      headers,
      body: JSON.stringify({ event, sessionId: sessionId(), props: props || {} }),
      keepalive: true,
    }).catch(() => null)
  } catch {
    /* ignore */
  }
}

export function trackPageView() {
  trackClient('page_view', { path: location.pathname + location.search })
}

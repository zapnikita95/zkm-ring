import type { Profile } from './api'

const ONBOARD_KEY = 'zm-onboarded-v1'

export function hasOnboarded(): boolean {
  return localStorage.getItem(ONBOARD_KEY) === '1'
}

export function setOnboarded(): void {
  localStorage.setItem(ONBOARD_KEY, '1')
}

export let profileCache: Profile | null = null

export function setProfileCache(p: Profile | null): void {
  profileCache = p
}

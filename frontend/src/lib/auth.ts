import type { User } from './api'

const USER_KEY = 'user'

export function saveAuth(user: User): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user))
}

export function clearAuth(): void {
  localStorage.removeItem(USER_KEY)
}

export function getStoredUser(): User | null {
  const raw = localStorage.getItem(USER_KEY)
  if (!raw) return null
  try { return JSON.parse(raw) as User } catch { return null }
}

export function isAuthenticated(): boolean {
  return !!localStorage.getItem(USER_KEY)
}

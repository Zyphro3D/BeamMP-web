const BASE = ''

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.body && !(options.body instanceof FormData)
      ? { 'Content-Type': 'application/json' }
      : {}),
    ...(options.headers as Record<string, string> ?? {}),
  }
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
    credentials: 'include', // send httpOnly cookie on every request
  })

  // Session expired or revoked → clear local user data and redirect to login
  if (res.status === 401 && !path.includes('/auth/login')) {
    localStorage.removeItem('user')
    window.location.href = '/login'
    throw new Error('Session expirée')
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error ?? 'Request failed')
  }
  return res.json() as Promise<T>
}

// Helper: build the instance-scoped API prefix
const i = (instanceId: string) => `/api/i/${instanceId}`

export const api = {
  // Global
  instances: () => request<InstanceInfo[]>('/api/instances'),
  info:      () => request<ServerInfo>('/api/info'),

  // Auth
  login: (username: string, password: string) =>
    request<{ user: User }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () =>
    request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  requestAccount: (beammp_username: string) =>
    request<{ message: string }>('/api/auth/request-account', {
      method: 'POST',
      body: JSON.stringify({ beammp_username }),
    }),

  // Per-instance — Mods
  mods:    (instanceId: string) => request<Mod[]>(`${i(instanceId)}/mods`),
  uploadMod: (instanceId: string, formData: FormData) =>
    request<Mod>(`${i(instanceId)}/mods/upload`, { method: 'POST', body: formData }),
  toggleMod: (instanceId: string, id: number) =>
    request<Mod>(`${i(instanceId)}/mods/${id}/toggle`, { method: 'POST' }),
  deleteMod: (instanceId: string, id: number) =>
    request<{ deleted: boolean }>(`${i(instanceId)}/mods/${id}`, { method: 'DELETE' }),
  uploadModImage: (instanceId: string, id: number, file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return request<{ image: string }>(`${i(instanceId)}/mods/${id}/image`, { method: 'POST', body: fd })
  },
  updateModDescription: (instanceId: string, id: number, lang: string, text: string) =>
    request<Mod>(`${i(instanceId)}/mods/${id}/description`, {
      method: 'PATCH',
      body: JSON.stringify({ lang, text }),
    }),
  toggleOfficial: (instanceId: string, id: number) =>
    request<Mod>(`${i(instanceId)}/mods/${id}/official`, { method: 'PATCH' }),

  // Per-instance — Maps
  activateMap: (instanceId: string, map_id: string) =>
    request<{ activated: string }>(`${i(instanceId)}/maps/activate`, {
      method: 'POST',
      body: JSON.stringify({ map_id }),
    }),

  // Per-instance — Config
  getConfig:    (instanceId: string) => request<Record<string, string>>(`${i(instanceId)}/config`),
  updateConfig: (instanceId: string, data: Record<string, string>) =>
    request<{ updated: boolean }>(`${i(instanceId)}/config`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  // Per-instance — Logs
  logs: (instanceId: string, lines = 100) =>
    request<{ lines: string[] }>(`${i(instanceId)}/logs?lines=${lines}`),

  // Per-instance — Activity
  activity: (instanceId: string) => request<ActivityEvent[]>(`${i(instanceId)}/activity`),

  // Per-instance — Server
  restartServer: (instanceId: string) =>
    request<{ restarted: boolean }>(`${i(instanceId)}/server/restart`, { method: 'POST' }),

  // Public per-instance
  activeMods: (instanceId: string) => request<Mod[]>(`${i(instanceId)}/mods/active`),

  // Admin — consistency
  checkConsistency: (instanceId: string) =>
    request<ConsistencyReport>(`/api/admin/i/${instanceId}/consistency`),
  fixConsistency: (instanceId: string, fix: string, meta: Record<string, string | number | boolean>) =>
    request<{ fixed: boolean; action: string }>(`/api/admin/i/${instanceId}/consistency/fix`, {
      method: 'POST',
      body: JSON.stringify({ fix, meta }),
    }),

  // Admin — scan & import
  scanImport: (instanceId: string) =>
    request<ScanImportReport>(`/api/admin/i/${instanceId}/scan-import`, { method: 'POST' }),

  // Admin (global)
  requests: () => request<AccountRequest[]>('/api/admin/requests'),
  reviewRequest: (id: number, action: 'approve' | 'reject', password?: string) =>
    request<{ approved: string } | { rejected: string }>(`/api/admin/requests/${id}`, {
      method: 'POST',
      body: JSON.stringify({ action, password }),
    }),
  resetUserPassword: (id: number, password: string) =>
    request<User>(`/api/admin/users/${id}/password`, {
      method: 'PATCH',
      body: JSON.stringify({ password }),
    }),
  adminPlayers: (instanceId: string) => request<KnownPlayer[]>(`/api/admin/players?instanceId=${encodeURIComponent(instanceId)}`),
  adminUsers:   () => request<User[]>('/api/admin/users'),
  updateUserRole: (id: number, role: string) =>
    request<User>(`/api/admin/users/${id}/role`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    }),
  deleteUser: (id: number) =>
    request<{ deleted: boolean }>(`/api/admin/users/${id}`, { method: 'DELETE' }),
}

// ── Types ──────────────────────────────────────────────────────

export interface InstanceInfo {
  id: string
  name: string
  canRestart: boolean
}

export interface ServerInfo {
  discordUrl: string
  kofiUrl: string
  serverDescription: string
}

export interface ActivityEvent {
  id: number
  type: 'player_join' | 'player_leave' | 'mod_upload' | 'server_restart' | 'map_change'
  message: string
  timestamp: string
  user?: string
}

export interface ServerStatus {
  online: boolean
  playerCount: number
  maxPlayers: number
  players: string[]
  map: string
  mapName: string
  serverName: string
  uptimeMs?: number
  // From BeamMP public API
  version?: string
  location?: string
  sdesc?: string
  modlist?: string[]
}

export interface Mod {
  id: number
  name: string
  type: 'mod' | 'vehicle' | 'map'
  filename: string
  image: string | null
  description: Record<string, string> | null
  active: boolean
  map_id: string | null
  is_official: boolean
  created_at: string
}

export interface User {
  id: number
  username: string
  role: 'superadmin' | 'admin' | 'moderator'
  created_at?: string
}

export interface KnownPlayer {
  id: number
  instance_id: string
  beammp_username: string
  connection_count: number
  first_seen: string
  last_seen: string | null
  total_seconds: number
}

export interface AccountRequest {
  id: number
  beammp_username: string
  requested_at: string
  status: 'pending' | 'approved' | 'rejected'
  reviewed_by: number | null
  reviewed_at: string | null
  connection_count: number | null
  first_seen: string | null
  last_seen: string | null
}

export interface ConsistencyIssue {
  id: string
  type: 'wrong_location' | 'missing_file' | 'orphan_file' | 'missing_image' | 'orphan_image' | 'multiple_active_maps'
  severity: 'error' | 'warning'
  description: string
  fix?: string
  meta?: Record<string, string | number | boolean>
}

export interface ConsistencyReport {
  instanceId: string
  scannedAt: string
  summary: { total: number; errors: number; warnings: number }
  issues: ConsistencyIssue[]
}

export interface ScanImportResult {
  filename: string
  name?: string
  type?: string
  active?: boolean
  hasImage: boolean
  status: 'imported' | 'skipped' | 'error'
  error?: string
}

export interface ScanImportReport {
  imported: number
  skipped: number
  errors: number
  total: number
  results: ScanImportResult[]
}

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
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>('/api/auth/password', {
      method: 'PATCH',
      body: JSON.stringify({ currentPassword, newPassword }),
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

  // Per-instance — Config presets
  presets: (instanceId: string) => request<ConfigPreset[]>(`${i(instanceId)}/presets`),
  createPreset: (instanceId: string, name: string, mod_ids: number[], map_id: string | null) =>
    request<ConfigPreset>(`${i(instanceId)}/presets`, {
      method: 'POST',
      body: JSON.stringify({ name, mod_ids, map_id }),
    }),
  updatePreset: (instanceId: string, id: number, name: string, mod_ids: number[], map_id: string | null) =>
    request<ConfigPreset>(`${i(instanceId)}/presets/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name, mod_ids, map_id }),
    }),
  deletePreset: (instanceId: string, id: number) =>
    request<{ deleted: boolean }>(`${i(instanceId)}/presets/${id}`, { method: 'DELETE' }),
  applyPreset: (instanceId: string, id: number) =>
    request<PresetApplyResult>(`${i(instanceId)}/presets/${id}/apply`, { method: 'POST' }),

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
  alerts: (instanceId: string) =>
    request<CriticalAlert[]>(`${i(instanceId)}/alerts`),

  // Per-instance — Activity
  activity: (instanceId: string) => request<ActivityEvent[]>(`${i(instanceId)}/activity`),

  // Per-instance — Server
  restartServer: (instanceId: string) =>
    request<{ restarted: boolean }>(`${i(instanceId)}/server/restart`, { method: 'POST' }),
  checkServerUpdate: (instanceId: string) =>
    request<UpdateCheck>(`${i(instanceId)}/server/update-check`),
  updateServer: (instanceId: string) =>
    request<{ updated: boolean; version: string }>(`${i(instanceId)}/server/update`, { method: 'POST' }),

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
  analyzeExistingMods: (instanceId: string) =>
    request<AnalyzeExistingReport>(`/api/admin/i/${instanceId}/mods/analyze-existing`, { method: 'POST' }),

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

export interface CriticalAlert {
  type:      string
  message:   string
  hint:      string
  firstSeen: number
  lastSeen:  number
}

export interface UpdateCheck {
  enabled:         boolean
  currentVersion:  string | null
  latestVersion:   string | null
  updateAvailable: boolean
  releaseUrl:      string | null
  error?:          string
}

export interface ActivityEvent {
  id: number
  type: 'player_join' | 'player_leave' | 'mod_upload' | 'server_restart' | 'server_update' | 'map_change'
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

// Extraction automatique au moment de l'upload/import — voir
// backend/src/lib/modAnalyzer.ts pour le détail des champs et leurs limites
// (Off-Road Score notamment : indice, pas une preuve de capacité tout-terrain).
export interface VehicleMeta {
  brand?:           string
  bodyStyle?:       string
  vehicleType?:     string
  country?:         string
  derbyClass?:      string
  yearMin?:         number
  yearMax?:         number
  configCount:      number
  configurations:   string[]
  drivetrains:      string[]
  fuelTypes:        string[]
  transmissions:    string[]
  powerMin?:        number
  powerMax?:        number
  offRoadScoreMin?: number
  offRoadScoreMax?: number
}

export interface MapMeta {
  title?:       string
  description?: string
  sizeMeters?:  number
  author?:      string
  tagLine?:     string
  category?:    string
}

export interface OtherMeta {
  subtype: 'script' | 'sound' | 'ui' | 'prop' | 'unknown'
}

export interface ModMetadata {
  kind:     'vehicle' | 'map' | 'other'
  vehicle?: VehicleMeta
  map?:     MapMeta
  other?:   OtherMeta
}

export interface AnalyzeExistingReport {
  analyzed:  number
  notFound:  number
  errors:    number
  total:     number
  remaining: boolean
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
  metadata: ModMetadata | null
  created_at: string
}

export interface ConfigPreset {
  id: number
  instance_id: string
  name: string
  mod_ids: number[]
  map_id: string | null
  created_at: string
}

export interface PresetApplyResult {
  applied: string
  modsActivated: number
  modsMissing: number
  mapApplied: string | null
  mapError: string | null
  restarted: boolean
  restartError: string | null
  needsRestart: boolean
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

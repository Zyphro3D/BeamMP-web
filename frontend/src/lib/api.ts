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
    // Le corps reste joint à l'erreur : certaines réponses portent un choix à proposer (niveaux d'un pack de cartes).
    throw Object.assign(new Error(err.error ?? 'Request failed'), { status: res.status, data: err })
  }
  return res.json() as Promise<T>
}

// Helper: build the instance-scoped API prefix
const i = (instanceId: string) => `/api/i/${instanceId}`

export const api = {
  // Global
  instances: () => request<InstanceInfo[]>('/api/instances'),
  info:      () => request<ServerInfo>('/api/info'),
  instanceStatus: (instanceId: string) => request<ServerStatus>(`${i(instanceId)}/status`),

  // Serveurs du panel (bouton « Ajouter un serveur »)
  servers: () => request<ServerList>('/api/admin/servers'),
  addServer: (name: string, port: number, authKey: string) =>
    request<{ server: ManagedServer; started: boolean; error: string }>('/api/admin/servers', {
      method: 'POST', body: JSON.stringify({ name, port, authKey }),
    }),
  removeServer: (id: string) =>
    request<{ archived: string }>(`/api/admin/servers/${encodeURIComponent(id)}`, { method: 'DELETE' }),

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
  // La carte est désignée par son id ; le niveau est lu dans son zip par le serveur. `level` : choix pour un pack.
  activateMap: (instanceId: string, mod_id: number, level?: string) =>
    request<{ activated: string }>(`${i(instanceId)}/maps/activate`, {
      method: 'POST',
      body: JSON.stringify(level ? { mod_id, level } : { mod_id }),
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
  // Per-instance — BeamNG.Earth (plugin serveur : réglages settings.json, état state.json)
  earth: (instanceId: string) => request<EarthOverview>(`${i(instanceId)}/earth`),
  saveEarthSettings: (instanceId: string, settings: Partial<EarthSettings>) =>
    request<{ file: Partial<EarthSettings>; changed: string[] }>(`${i(instanceId)}/earth/settings`, {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  clearEarthStore: (instanceId: string) =>
    request<{ requested: boolean }>(`${i(instanceId)}/earth/store/clear`, { method: 'POST' }),
  reloadEarthPacks: (instanceId: string) =>
    request<{ requested: boolean }>(`${i(instanceId)}/earth/packs/reload`, { method: 'POST' }),
  uploadEarthPack: (instanceId: string, file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return request<EarthPack>(`${i(instanceId)}/earth/packs/upload`, { method: 'POST', body: fd })
  },
  setEarthHelper: (instanceId: string, enabled: boolean, procs: number) =>
    request<EarthHelperControl>(`${i(instanceId)}/earth/helper`, {
      method: 'PUT',
      body: JSON.stringify({ enabled, procs }),
    }),
  earthRelease: (instanceId: string, force = false) =>
    request<EarthRelease>(`${i(instanceId)}/earth/release${force ? '?force=1' : ''}`),
  installEarthRelease: (instanceId: string) =>
    request<{ installed: string; previous: string | null; needsRestart: boolean }>(`${i(instanceId)}/earth/release/install`, { method: 'POST' }),
  restoreEarthRelease: (instanceId: string) =>
    request<{ installed: string; needsRestart: boolean }>(`${i(instanceId)}/earth/release/restore`, { method: 'POST' }),
  deleteEarthPack: (instanceId: string, name: string) =>
    request<{ deleted: boolean }>(`${i(instanceId)}/earth/packs/${encodeURIComponent(name)}`, { method: 'DELETE' }),

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
  setServerUpdateChannel: (instanceId: string, channel: UpdateChannel, version?: string) =>
    request<UpdateCheck>(`${i(instanceId)}/server/update-channel`, {
      method: 'PUT',
      body: JSON.stringify(version ? { channel, version } : { channel }),
    }),

  // Public per-instance
  activeMods: (instanceId: string) => request<Mod[]>(`${i(instanceId)}/mods/active`),
  catalog: (instanceId: string) => request<CatalogItem[]>(`${i(instanceId)}/catalog`),

  // Appli Windows : premier lancement, serveur géré par le panel, mise à jour du panel
  setupStatus: () => request<SetupStatus>('/api/setup'),
  setup: (data: SetupRequest) =>
    request<{ configured: boolean }>('/api/setup', { method: 'POST', body: JSON.stringify(data) }),
  serverState: (instanceId: string) => request<LocalServerState>(`${i(instanceId)}/server/state`),
  serverStart: (instanceId: string) => request<LocalServerState>(`${i(instanceId)}/server/start`, { method: 'POST' }),
  serverStop:  (instanceId: string) => request<LocalServerState>(`${i(instanceId)}/server/stop`, { method: 'POST' }),

  // Per-instance — Discord (superadmin)
  discordSettings: (instanceId: string) => request<DiscordSettings>(`${i(instanceId)}/discord`),
  saveDiscordSettings: (instanceId: string, data: Pick<DiscordSettings, 'webhooks' | 'templates'>) =>
    request<DiscordSettings>(`${i(instanceId)}/discord`, { method: 'PUT', body: JSON.stringify(data) }),
  testDiscordWebhook: (instanceId: string, url: string) =>
    request<{ ok: boolean; error: string }>(`${i(instanceId)}/discord/test`, { method: 'POST', body: JSON.stringify({ url }) }),
  panelUpdate:        () => request<PanelUpdate>('/api/panel/update'),
  panelUpdateCheck:   () => request<PanelUpdate>('/api/panel/update/check', { method: 'POST' }),
  panelUpdateInstall: () => request<PanelUpdate & { restarting: boolean }>('/api/panel/update/install', { method: 'POST' }),

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

export type EarthWeather = 'real' | 'clear' | 'cloudy' | 'rain' | 'storm' | 'snow' | 'fog'

export interface EarthSettings {
  listed: boolean
  time: string            // 'real' ou 'HH:MM'
  timeSpeed: number
  weather: EarthWeather
  shareStoreMb: number
  shareOutKbps: number
  meetM: number
}

export interface EarthPlayer {
  pid: number
  name: string
  lat: number
  lon: number
  h: number | null
  joined: number | null
}

export interface EarthState {
  t: number | null
  fresh: boolean
  uptime: number | null
  settings: Partial<EarthSettings>
  warnings: string[]
  players: EarthPlayer[]
  store: { mb: number | null; items: number | null; capMb: number | null }
  packs: string[]
  stats: Record<string, number>
}

export interface EarthPack {
  name: string
  size: number
  mtime: number
  valid: boolean
  error?: string
  items?: number
  meta?: { bbox?: number[] | null; made?: string | null; signature?: string | null }
  loaded: boolean | null     // servi par le plugin (null : plugin arrêté, inconnu)
}

export interface EarthHelperControl { enabled: boolean; procs: number }

export interface EarthHelper {
  installed: boolean              // le superviseur (rôle Ansible bnge-helper) répond
  control: EarthHelperControl
  state: {
    version: string | null
    running: boolean
    since: number | null
    rssMb: number | null
    cacheMb: number | null
    nextStart: number | null
    restarts: number
    lastExit: { code: number; t: number; oom: boolean } | null
    error: string | null
    log: string[]
  } | null
}

export interface EarthRelease {
  repo: string
  installed: string | null
  previous: string | null
  latest: string | null
  updateAvailable: boolean
  notesUrl: string | null
  published: string | null
  size: number | null
  error: string | null
}

export interface EarthOverview {
  active?: boolean                // plugin à sa place sous Server/ : Earth est la carte active (#4521)
  installed: boolean
  supportsSettings?: boolean
  defaults?: EarthSettings
  file?: Partial<EarthSettings>
  fileError?: string | null
  effective?: EarthSettings
  listing?: 'earth' | 'beammp' | 'direct'
  state?: EarthState | null
  packs?: EarthPack[]
  pending?: ('clear-store' | 'reload-packs')[]
  helper?: EarthHelper
  version?: string | null        // celle du mod installé (beamng_earth.zip)
}

export interface InstanceInfo {
  id: string
  name: string
  canRestart: boolean
}

export interface ManagedServer {
  id: string
  name: string
  port: number | null
  origin: 'env' | 'panel'
  removable: boolean
  managed: boolean
  running: boolean
  wanted: boolean
  error: string
  unreachable: boolean
}

export interface ServerList {
  canAdd: boolean
  reason: string
  nextPort: number
  servers: ManagedServer[]
}

export interface ServerInfo {
  discordUrl: string
  kofiUrl: string
  serverDescription: string
  version?: string
}

export interface CriticalAlert {
  type:      string
  message:   string
  hint:      string
  firstSeen: number
  lastSeen:  number
}

export type UpdateChannel = 'stable' | 'prerelease' | 'pinned'

export interface UpdateCheck {
  enabled:           boolean
  currentVersion:    string | null
  latestVersion:     string | null
  updateAvailable:   boolean
  releaseUrl:        string | null
  error?:            string
  channel?:          UpdateChannel
  pinnedVersion?:    string | null
  latestStable?:     string | null
  latestPrerelease?: boolean
  downgrade?:        boolean
  versions?:         { version: string; prerelease: boolean; date: string }[]
}

export interface ActivityEvent {
  id: number
  type: string                      // player_join, map_change, earth_update… (activity_<type> dans les langues)
  message: string                   // texte français du serveur, en secours
  timestamp: string
  user?: string
  params?: Record<string, string>   // valeurs de la phrase, composée dans la langue de l'utilisateur
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

export interface SetupStatus {
  appMode: boolean
  needed: boolean
  hasAdmin: boolean
  serverDir: string | null
  serverInstalled: boolean
}

export interface SetupRequest {
  serverDir: string
  downloadServer: boolean
  serverName?: string
  authKey?: string
  username?: string
  password?: string
}

export interface LocalServerState {
  managed: boolean
  installed?: boolean
  running?: boolean
  wanted?: boolean
  pid?: number | null
  error?: string
}

export type DiscordChannel = 'url' | 'restart' | 'players' | 'mods'

export interface DiscordSettings {
  webhooks: Record<DiscordChannel, string>
  envFallback: Record<DiscordChannel, boolean>
  templates: Record<string, string>
  defaults: Record<string, { text: string; vars: string[]; channel: Exclude<DiscordChannel, 'url'> }>
}

export interface PanelUpdate {
  enabled: boolean
  phase: 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'ready' | 'requested' | 'error' | 'disabled'
  current: string
  version: string | null
  notes: Record<string, string>
  size: number
  error: string
  fullRequired: boolean
  // Installation Docker : la mise à jour est faite par l'hôte (install.sh)
  docker?: boolean
  pending?: boolean
  host?: { phase?: string; message?: string; version?: string; updated_at?: number }
}

// Catalogue public (page d'accueil) : tous les mods/cartes de l'instance,
// actifs ou non, sans le nom de fichier.
export type CatalogItem = Omit<Mod, 'filename' | 'created_at'>

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
  status: 'imported' | 'updated' | 'skipped' | 'error'
  mapId?: string
  error?: string
}

export interface ScanImportReport {
  imported: number
  updated?: number
  skipped: number
  errors: number
  total: number
  results: ScanImportResult[]
}

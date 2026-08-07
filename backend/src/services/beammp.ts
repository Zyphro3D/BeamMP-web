import { db } from '../db'
import type { InstanceConfig } from '../config'

export interface ServerStatus {
  online: boolean
  playerCount: number
  maxPlayers: number
  players: string[]
  map: string
  mapName: string
  serverName: string
  // Extended info from BeamMP public API
  version?: string
  location?: string
  sdesc?: string
  modlist?: string[]
}

// ── BeamMP public API ─────────────────────────────────────────

const BEAMMP_API = 'https://backend.beammp.com/servers-info'

interface BeamMPServerEntry {
  ident:         string
  ip:            string
  port:          string
  sname:         string
  players:       string
  playerslist:   string
  maxplayers:    string
  map:           string
  modlist:       string
  modstotal:     string
  modstotalsize: string
  official:      boolean
  featured:      boolean
  partner:       boolean
  password:      boolean
  guests:        boolean
  location:      string
  tags:          string
  version:       string
  cversion:      string
  owner:         string
  sdesc:         string
}

// Global server list cache (shared across instances — refreshed every 30s)
let serverListCache: BeamMPServerEntry[] | null = null
let serverListTs = 0
const SERVER_LIST_TTL = 30_000

async function fetchServerList(): Promise<BeamMPServerEntry[]> {
  const now = Date.now()
  if (serverListCache && now - serverListTs < SERVER_LIST_TTL) return serverListCache
  try {
    const res = await fetch(BEAMMP_API, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    serverListCache = await res.json() as BeamMPServerEntry[]
    serverListTs = now
    return serverListCache
  } catch (e) {
    console.warn('[beammp] Public API fetch failed:', e)
    return serverListCache ?? []
  }
}

function findServer(list: BeamMPServerEntry[], ip: string, port: string): BeamMPServerEntry | null {
  return list.find(s => s.ip === ip && s.port === port) ?? null
}

function parsePlayers(playerslist: string): string[] {
  if (!playerslist) return []
  // BeamMP uses semicolons or commas depending on version
  return playerslist.split(/[;,]/).map(p => p.trim()).filter(Boolean)
}

function parseModlist(modlist: string): string[] {
  if (!modlist) return []
  return modlist.split(';').map(m => m.replace(/^\//, '').trim()).filter(Boolean)
}

// Clean BeamMP rich-text from sdesc (^p = newline, ^1 = link prefix, etc.)
function cleanSdesc(sdesc: string): string {
  return sdesc
    .replace(/\^p/g, '\n')
    .replace(/\^\d/g, '')
    .trim()
}

// ── Per-instance player tracking (log-based fallback) ─────────

const onlinePlayersMap = new Map<string, Set<string>>()
const lastActivityMap  = new Map<string, number>()

function getPlayerSet(instanceId: string): Set<string> {
  if (!onlinePlayersMap.has(instanceId)) onlinePlayersMap.set(instanceId, new Set())
  return onlinePlayersMap.get(instanceId)!
}

export function playerJoined(instanceId: string, username: string): void {
  getPlayerSet(instanceId).add(username)
  lastActivityMap.set(instanceId, Date.now())
  invalidateCache(instanceId)
}

export function playerLeft(instanceId: string, username: string): void {
  getPlayerSet(instanceId).delete(username)
  lastActivityMap.set(instanceId, Date.now())
  invalidateCache(instanceId)
}

export function getOnlinePlayers(instanceId: string): string[] {
  return [...getPlayerSet(instanceId)]
}

// ── Per-instance status cache ──────────────────────────────────

const caches = new Map<string, { data: ServerStatus; ts: number }>()
const CACHE_TTL_MS = 15_000

// In-flight de-duplication: several SSE clients on the same instance can
// hit a cache miss in the same tick (e.g. right after invalidateCache()).
// Without this, each one would trigger its own public-API + local-API
// cascade concurrently — a thundering herd proportional to viewer count.
const inFlight = new Map<string, Promise<ServerStatus>>()

async function getActiveMapFromDb(instanceId: string): Promise<{ map_id: string; name: string } | null> {
  try {
    const res = await db.query(
      `SELECT map_id, name FROM mods WHERE instance_id = $1 AND type = 'map' AND active = true LIMIT 1`,
      [instanceId]
    )
    return res.rows[0] ?? null
  } catch {
    return null
  }
}

// Fallback: read config file when public API is unavailable
async function getConfigFallback(inst: InstanceConfig): Promise<{ maxPlayers: number; serverName: string }> {
  try {
    const { readFile } = await import('./fileService')
    const content = readFile(inst.beammp.configPath)
    const maxMatch  = content.match(/^MaxPlayers\s*=\s*(\d+)/m)
    const nameMatch = content.match(/^Name\s*=\s*["']?(.+?)["']?\s*$/m)
    return {
      maxPlayers: maxMatch ? parseInt(maxMatch[1]) : 0,
      serverName: nameMatch ? nameMatch[1].trim() : inst.name,
    }
  } catch {
    return { maxPlayers: 0, serverName: inst.name }
  }
}

export async function getServerStatus(inst: InstanceConfig): Promise<ServerStatus> {
  const cached = caches.get(inst.id)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data

  const pending = inFlight.get(inst.id)
  if (pending) return pending

  const promise = fetchServerStatus(inst).finally(() => inFlight.delete(inst.id))
  inFlight.set(inst.id, promise)
  return promise
}

async function fetchServerStatus(inst: InstanceConfig): Promise<ServerStatus> {
  const now = Date.now()
  let publicListSaysOffline = false

  // ── 1. BeamMP public API (primary, when ip+port configured) ──
  if (inst.serverIp && inst.serverPort) {
    try {
      const list   = await fetchServerList()
      const server = findServer(list, inst.serverIp, inst.serverPort)

      if (server) {
        const players    = parsePlayers(server.playerslist)
        const activeMap  = await getActiveMapFromDb(inst.id)
        const data: ServerStatus = {
          online:      true,
          playerCount: parseInt(server.players) || players.length,
          maxPlayers:  parseInt(server.maxplayers) || 0,
          players,
          map:         activeMap?.map_id ?? server.map,
          mapName:     activeMap?.name   ?? server.map,
          serverName:  server.sname,
          version:     server.version,
          location:    server.location,
          sdesc:       cleanSdesc(server.sdesc),
          modlist:     parseModlist(server.modlist),
        }
        caches.set(inst.id, { data, ts: now })
        return data
      }

      // Server not in the public list — don't trust that alone (transient
      // glitch, private server, just-started server all look the same from
      // here). Remember it and keep falling through to levels 2/3; only
      // used as the final word if nothing else answers either.
      if (list.length > 0) publicListSaysOffline = true
    } catch { /* fall through */ }
  }

  // ── 2. Local BeamMP HTTP API (if plugin installed) ────────────
  const baseUrl = `http://${inst.beammp.apiHost}:${inst.beammp.apiPort}`
  try {
    const res = await fetch(`${baseUrl}/api/players`, { signal: AbortSignal.timeout(2000) })
    if (res.ok) {
      const apiPlayers: string[] = await res.json()
      const infoRes = await fetch(`${baseUrl}/api/status`, { signal: AbortSignal.timeout(2000) })
      const info = infoRes.ok ? await infoRes.json() : {}
      const activeMap = await getActiveMapFromDb(inst.id)
      const data: ServerStatus = {
        online: true,
        playerCount: apiPlayers.length,
        maxPlayers:  info.maxplayers ?? 0,
        players:     apiPlayers,
        map:         activeMap?.map_id ?? info.map ?? '',
        mapName:     activeMap?.name   ?? info.map ?? '',
        serverName:  info.name ?? inst.name,
      }
      caches.set(inst.id, { data, ts: now })
      return data
    }
  } catch { /* fall through */ }

  // ── 3. Log-based tracking fallback ───────────────────────────
  const players     = getPlayerSet(inst.id)
  const lastActivity = lastActivityMap.get(inst.id) ?? 0
  const activeMap   = await getActiveMapFromDb(inst.id)
  const { maxPlayers, serverName } = await getConfigFallback(inst)

  // Levels 1 and 2 both failed to confirm the server is up. Only now do we
  // let the public API's "not in the list" verdict win outright; otherwise
  // fall back to the log-activity heuristic as before.
  const hasRecentActivity = (Date.now() - lastActivity) < 5 * 60 * 1000
  const online = !publicListSaysOffline && (players.size > 0 || hasRecentActivity)

  const data: ServerStatus = {
    online,
    playerCount: players.size,
    maxPlayers,
    players: [...players],
    map:     activeMap?.map_id ?? '',
    mapName: activeMap?.name   ?? '',
    serverName,
  }
  caches.set(inst.id, { data, ts: now })
  return data
}

export function invalidateCache(instanceId: string): void {
  caches.delete(instanceId)
}

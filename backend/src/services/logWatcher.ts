import { db } from '../db'
import { sendDiscordNotification } from './discord'
import { watchLog } from './fileService'
import { playerJoined, playerLeft, markServerAlive } from './beammp'
import { logActivity } from './activity'
import { config, type InstanceConfig } from '../config'

const JOIN_RE    = /Connected:\s+(.+?)\s+\(/i
const LEAVE_RE   = /Disconnected:\s+(.+)/i
const ALIVE_RE   = /ALL SYSTEMS STARTED SUCCESSFULLY/i

// Session start times keyed by "instanceId:username"
const sessionStart = new Map<string, Date>()

// ── Alertes critiques ────────────────────────────────────────────────────
// Erreurs qui signifient concrètement "le serveur n'est pas joignable par
// les joueurs" — jusqu'ici invisibles dans le panel, il fallait aller lire
// Server.log à la main pour les remarquer (cas vécu : une AuthKey invalide
// passée inaperçue pendant des jours). Message exact repris du code source
// de BeamMP-Server (THeartbeatThread.cpp) pour l'AuthKey — stable, ce n'est
// pas un texte qu'on devine.
export interface CriticalAlert {
  type:      string
  message:   string
  hint:      string
  firstSeen: number
  lastSeen:  number
}

const CRITICAL_PATTERNS: Array<{ type: string; re: RegExp; hint: string }> = [
  {
    type: 'auth_key_invalid',
    re:   /Backend REFUSED the auth key\.\s*(.*)/i,
    hint: 'Clé AuthKey invalide ou expirée — le serveur est invisible dans la liste BeamMP officielle (le direct-connect reste possible). Générer une nouvelle clé sur https://keymaster.beammp.com/ puis la reporter dans Configuration.',
  },
]

// instanceId -> type -> alerte active
const criticalAlerts = new Map<string, Map<string, CriticalAlert>>()

// Une alerte non revue depuis ce délai est considérée résolue — le pattern
// ne réapparaît plus dans les logs une fois le problème corrigé, donc rien
// ne la "referme" explicitement autrement qu'en expirant faute de nouvelle
// occurrence.
const CRITICAL_ALERT_TTL_MS = 5 * 60 * 1000

function recordCriticalError(instanceId: string, type: string, message: string, hint: string): void {
  if (!criticalAlerts.has(instanceId)) criticalAlerts.set(instanceId, new Map())
  const perInstance = criticalAlerts.get(instanceId)!
  const existing = perInstance.get(type)
  perInstance.set(type, {
    type,
    message,
    hint,
    firstSeen: existing?.firstSeen ?? Date.now(),
    lastSeen:  Date.now(),
  })
}

export function getActiveCriticalAlerts(instanceId: string): CriticalAlert[] {
  const perInstance = criticalAlerts.get(instanceId)
  if (!perInstance) return []
  const now = Date.now()
  return [...perInstance.values()].filter(a => now - a.lastSeen < CRITICAL_ALERT_TTL_MS)
}

// Rangs par ancienneté (repris de la V1, bot/players.py + messages.json) —
// n'apparaît qu'à partir de la 2e connexion, la 1ère a son propre message.
// Seuils dupliqués dans frontend/src/lib/rank.ts (rankTier) pour le badge
// affiché dans Joueurs — AUCUN mécanisme automatique ne les garde en phase
// (deux runtimes distincts, pas de package partagé). Si ces seuils changent
// ici, reporter le même changement dans rankTier() ou le badge affiché au
// joueur divergera silencieusement du message Discord.
function rankLabel(connectionCount: number): string | null {
  if (connectionCount < 2)   return null
  if (connectionCount < 10)  return `🥉 Niveau Bronze ${connectionCount}/10`
  if (connectionCount < 100) return `🥈 Niveau Argent ${connectionCount}/100`
  if (connectionCount < 500) return `🥇 Niveau Or avec ${connectionCount}/500 connexions`
  return `💎 Niveau Platine ! ${connectionCount} connexions, c'est du sérieux !`
}

async function handleJoin(inst: InstanceConfig, username: string): Promise<void> {
  sessionStart.set(`${inst.id}:${username}`, new Date())
  playerJoined(inst.id, username)

  await db.query(
    `INSERT INTO known_players (instance_id, beammp_username, connection_count, last_seen)
     VALUES ($1, $2, 1, NOW())
     ON CONFLICT (instance_id, beammp_username) DO UPDATE
       SET connection_count = known_players.connection_count + 1,
           last_seen = NOW()`,
    [inst.id, username]
  )
  const row = await db.query(
    'SELECT connection_count FROM known_players WHERE instance_id = $1 AND beammp_username = $2',
    [inst.id, username]
  )
  const count: number = row.rows[0]?.connection_count ?? 1
  const label = count === 1 ? '🥚 première connexion !' : (rankLabel(count) ?? `${count}e connexion`)
  logActivity(inst.id, 'player_join', `${username} s'est connecté`, username)
  await sendDiscordNotification('player_join', `**${username}** — ${label}`)
}

async function handleLeave(inst: InstanceConfig, username: string): Promise<void> {
  const key = `${inst.id}:${username}`
  const start = sessionStart.get(key)
  let seconds = 0
  if (start) {
    seconds = Math.floor((Date.now() - start.getTime()) / 1000)
    sessionStart.delete(key)
  }
  playerLeft(inst.id, username)

  if (seconds > 0) {
    await db.query(
      'UPDATE known_players SET total_seconds = total_seconds + $1 WHERE instance_id = $2 AND beammp_username = $3',
      [seconds, inst.id, username]
    )
  }
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  const duration = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
  // Session anormalement courte (<2min) : signal repris de la V1, souvent
  // un souci de connexion plutôt qu'un vrai départ.
  const shortSessionNote = seconds > 0 && seconds < 120
    ? ' ⚠️ Ça ne fonctionne pas ? Contacte le support admin.'
    : ''
  logActivity(inst.id, 'player_leave', `${username} s'est déconnecté · ${duration} de session`, username)
  await sendDiscordNotification('player_leave', `**${username}** a joué pendant **${duration}**${shortSessionNote}`)
}

function processChunk(inst: InstanceConfig, chunk: string): void {
  for (const line of chunk.split('\n')) {
    const joinMatch = line.match(JOIN_RE)
    if (joinMatch) { handleJoin(inst, joinMatch[1].trim()).catch(console.error); continue }
    const leaveMatch = line.match(LEAVE_RE)
    if (leaveMatch) { handleLeave(inst, leaveMatch[1].trim()).catch(console.error); continue }

    if (ALIVE_RE.test(line)) { markServerAlive(inst.id); continue }

    for (const { type, re, hint } of CRITICAL_PATTERNS) {
      const m = line.match(re)
      if (m) { recordCriticalError(inst.id, type, m[0].trim(), hint); break }
    }
  }
}

export function startLogWatchers(): void {
  for (const inst of config.instances) {
    watchLog(inst.beammp.logPath, (chunk) => processChunk(inst, chunk))
    console.log(`[logWatcher] Started for instance "${inst.id}"`)
  }
}

import { db } from '../db'
import { sendDiscordNotification } from './discord'
import { watchLog } from './fileService'
import { playerJoined, playerLeft } from './beammp'
import { logActivity } from './activity'
import { config, type InstanceConfig } from '../config'

const JOIN_RE  = /Connected:\s+(.+?)\s+\(/i
const LEAVE_RE = /Disconnected:\s+(.+)/i

// Session start times keyed by "instanceId:username"
const sessionStart = new Map<string, Date>()

// Rangs par ancienneté (repris de la V1, bot/players.py + messages.json) —
// n'apparaît qu'à partir de la 2e connexion, la 1ère a son propre message.
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
    if (leaveMatch) { handleLeave(inst, leaveMatch[1].trim()).catch(console.error) }
  }
}

export function startLogWatchers(): void {
  for (const inst of config.instances) {
    watchLog(inst.beammp.logPath, (chunk) => processChunk(inst, chunk))
    console.log(`[logWatcher] Started for instance "${inst.id}"`)
  }
}

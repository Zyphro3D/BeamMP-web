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

async function handleJoin(inst: InstanceConfig, username: string): Promise<void> {
  sessionStart.set(`${inst.id}:${username}`, new Date())
  playerJoined(inst.id, username)

  await db.query(
    `INSERT INTO known_players (beammp_username, connection_count, last_seen)
     VALUES ($1, 1, NOW())
     ON CONFLICT (beammp_username) DO UPDATE
       SET connection_count = known_players.connection_count + 1,
           last_seen = NOW()`,
    [username]
  )
  const row = await db.query(
    'SELECT connection_count FROM known_players WHERE beammp_username = $1',
    [username]
  )
  const count: number = row.rows[0]?.connection_count ?? 1
  const label = count === 1 ? 'première connexion !' : `${count}e connexion`
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
      'UPDATE known_players SET total_seconds = total_seconds + $1 WHERE beammp_username = $2',
      [seconds, username]
    )
  }
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  const duration = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
  logActivity(inst.id, 'player_leave', `${username} s'est déconnecté · ${duration} de session`, username)
  await sendDiscordNotification('player_leave', `**${username}** a joué pendant **${duration}**`)
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

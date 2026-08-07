import { config } from '../config'

type EventType = 'player_join' | 'player_leave' | 'mod_upload' | 'server_restart'

interface DiscordPayload {
  username: string
  embeds: {
    title: string
    description: string
    color: number
    timestamp: string
  }[]
}

const COLORS = {
  player_join: 0x57f287,
  player_leave: 0xed4245,
  mod_upload: 0x5865f2,
  server_restart: 0xfee75c,
}

const TITLES = {
  player_join: '🟢 Joueur connecté',
  player_leave: '🔴 Joueur déconnecté',
  mod_upload: '📦 Nouveau mod uploadé',
  server_restart: '🔄 Serveur redémarré',
}

// Retourne l'URL webhook pour un événement donné
// Priorité : webhook spécifique > webhook global
function getWebhookUrl(event: EventType): string {
  const d = config.discord
  if (event === 'server_restart') return d.webhookRestart || d.webhookUrl
  if (event === 'player_join' || event === 'player_leave') return d.webhookPlayers || d.webhookUrl
  if (event === 'mod_upload') return d.webhookMods || d.webhookUrl
  return d.webhookUrl
}

export async function sendDiscordNotification(
  event: EventType,
  description: string
): Promise<void> {
  const url = getWebhookUrl(event)
  if (!url) return

  // Respect user preferences
  if (event === 'player_join'    && !config.discord.notifyJoin) return
  if (event === 'player_leave'   && !config.discord.notifyLeave) return
  if (event === 'mod_upload'     && !config.discord.notifyModUpload) return
  if (event === 'server_restart' && !config.discord.notifyRestart) return

  const payload: DiscordPayload = {
    username: 'BeamMP Panel',
    embeds: [{
      title: TITLES[event],
      description,
      color: COLORS[event],
      timestamp: new Date().toISOString(),
    }],
  }

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    })
  } catch (err) {
    console.error('[discord] Webhook failed:', err)
  }
}

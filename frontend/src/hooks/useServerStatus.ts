import { useEffect, useState } from 'react'
import type { ServerStatus } from '../lib/api'

const DEFAULT: ServerStatus = {
  online: false,
  playerCount: 0,
  maxPlayers: 0,
  players: [],
  map: '—',
  mapName: '—',
  serverName: 'BeamMP Server',
}

export function useServerStatus(instanceId: string) {
  const [status, setStatus] = useState<ServerStatus>(DEFAULT)

  useEffect(() => {
    const es = new EventSource(`/api/i/${instanceId}/stream`)
    es.onmessage = (e) => {
      try { setStatus(JSON.parse(e.data) as ServerStatus) } catch { /* noop */ }
    }
    es.onerror = () => setStatus((s) => ({ ...s, online: false }))
    return () => es.close()
  }, [instanceId])

  return status
}

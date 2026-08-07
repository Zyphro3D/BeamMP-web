export type ActivityType = 'player_join' | 'player_leave' | 'mod_upload' | 'server_restart' | 'map_change'

export interface ActivityEvent {
  id: number
  type: ActivityType
  message: string
  timestamp: string
  user?: string
}

let counter = 0
const MAX = 50

// Per-instance activity store
const store = new Map<string, ActivityEvent[]>()

function getStore(instanceId: string): ActivityEvent[] {
  if (!store.has(instanceId)) store.set(instanceId, [])
  return store.get(instanceId)!
}

export function logActivity(instanceId: string, type: ActivityType, message: string, user?: string): void {
  const events = getStore(instanceId)
  events.unshift({ id: ++counter, type, message, timestamp: new Date().toISOString(), user })
  if (events.length > MAX) events.pop()
}

export function getActivity(instanceId: string, limit = 20): ActivityEvent[] {
  return getStore(instanceId).slice(0, limit)
}

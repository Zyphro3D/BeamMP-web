import { useEffect, useState } from 'react'
import { Users, Package, Car, Clock, Map } from 'lucide-react'
import { api, type Mod, type ActivityEvent } from '../../lib/api'
import { useServerStatus } from '../../hooks/useServerStatus'
import { useI18n } from '../../context/I18nContext'
import { desc } from '../../lib/desc'
import { formatUptimeMs } from '../../lib/format'
import { Avatar } from '../../components/ui/Avatar'

function activityColor(type: ActivityEvent['type']): string {
  return type === 'player_join'    ? 'bg-green-400'
    : type === 'player_leave'   ? 'bg-zinc-500'
    : type === 'mod_upload'     ? 'bg-accent'
    : type === 'server_restart' ? 'bg-red-400'
    : 'bg-blue-400'
}

function activityTime(ts: string): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function SectionDashboard({ instanceId, mods, maps, vehicles, loading }: {
  instanceId: string; mods: Mod[]; maps: Mod[]; vehicles: Mod[]; loading: boolean
}) {
  const status    = useServerStatus(instanceId)
  const { t, lang } = useI18n()
  const [activity, setActivity] = useState<ActivityEvent[]>([])
  const activeMap = maps.find(m => m.active)

  const activeMods     = mods.filter(m => m.active)
  const activeVehicles = vehicles.filter(m => m.active)

  useEffect(() => { api.activity(instanceId).then(setActivity).catch(() => {}) }, [instanceId])

  const stats = [
    {
      label: t('players'),
      value: status.maxPlayers > 0 ? `${status.playerCount}` : String(status.playerCount),
      sub: status.maxPlayers > 0 ? `/ ${status.maxPlayers}` : t('connected_players'),
      icon: <Users size={18} />,
      color: 'text-green-400',
      dot: status.online,
    },
    {
      label: t('mods'),
      value: `${activeMods.length}`,
      sub: `${mods.length - activeMods.length} ${t('inactive')}`,
      icon: <Package size={18} />,
      color: 'text-accent',
    },
    {
      label: t('vehicles'),
      value: `${activeVehicles.length}`,
      sub: `${vehicles.length - activeVehicles.length} ${t('inactive')}`,
      icon: <Car size={18} />,
      color: 'text-blue-400',
    },
    {
      label: t('uptime'),
      value: formatUptimeMs(status.uptimeMs),
      sub: status.online ? `${new Date(Date.now() - (status.uptimeMs ?? 0)).toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' })}` : t('offline'),
      icon: <Clock size={18} />,
      color: 'text-purple-400',
    },
  ]

  return (
    <div className="space-y-5">
      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="stat-card">
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-500">{s.label}</span>
              <span className={`${s.color} opacity-70`}>{s.icon}</span>
            </div>
            <div className="flex items-baseline gap-1.5 mt-1">
              <span className="text-2xl font-bold tabular-nums">{s.value}</span>
              {s.dot !== undefined && (
                <span className={`w-1.5 h-1.5 rounded-full ${s.dot ? 'bg-green-400' : 'bg-red-400'} mb-0.5`} />
              )}
            </div>
            <p className="text-[11px] text-zinc-600">{s.sub}</p>
          </div>
        ))}
      </div>

      {/* Server description (from BeamMP public API) */}
      {status.sdesc && (
        <div className="card p-3 flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-zinc-500 whitespace-pre-line leading-relaxed">{status.sdesc}</p>
          </div>
          <div className="shrink-0 flex flex-col items-end gap-1">
            {status.version && <span className="badge-zinc text-[10px] font-mono">v{status.version}</span>}
            {status.location && <span className="badge-zinc text-[10px]">🌍 {status.location}</span>}
          </div>
        </div>
      )}

      {/* Map + Players + Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Active map */}
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="p-3 border-b border-surface-border flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{t('carte_active')}</span>
          </div>
          {activeMap ? (
            <div className="flex gap-4 p-4">
              {activeMap.image ? (
                <img src={`/images/${activeMap.image}`} alt={activeMap.name}
                  className="w-28 h-20 object-cover rounded-lg bg-surface shrink-0" />
              ) : (
                <div className="w-28 h-20 rounded-lg bg-surface flex items-center justify-center shrink-0">
                  <Map size={28} className="text-zinc-700" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="font-semibold">{activeMap.name}</p>
                {desc(activeMap.description, lang) && <p className="text-xs text-zinc-500 mt-1">{desc(activeMap.description, lang)}</p>}
                <div className="flex items-center gap-2 mt-3">
                  <span className="badge-green text-[10px]">{t('active')}</span>
                  {activeMap.map_id && (
                    <span className="badge-zinc font-mono text-[10px]">{activeMap.map_id}</span>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="p-8 text-center text-zinc-700 text-sm">{t('no_active_map')}</div>
          )}
        </div>

        {/* Connected players */}
        <div className="card overflow-hidden">
          <div className="p-3 border-b border-surface-border flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{t('connected_players')}</span>
            <span className="text-xs text-zinc-600">{status.players.length}</span>
          </div>
          <div className="divide-y divide-surface-border">
            {status.players.length === 0 ? (
              <p className="p-4 text-xs text-zinc-700 text-center">{t('no_player')}</p>
            ) : (
              status.players.slice(0, 8).map(p => (
                <div key={p} className="flex items-center gap-2.5 px-3 py-2">
                  <Avatar name={p} size={6} />
                  <span className="text-sm text-zinc-600 dark:text-zinc-200">{p}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Activity */}
      <div className="card overflow-hidden">
        <div className="p-3 border-b border-surface-border">
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{t('recent_activity')}</span>
        </div>
        <div className="divide-y divide-surface-border">
          {activity.length === 0 ? (
            <p className="p-4 text-xs text-zinc-700 text-center">{t('no_activity')}</p>
          ) : (
            activity.map(e => (
              <div key={e.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="text-[11px] text-zinc-600 font-mono w-10 shrink-0">{activityTime(e.timestamp)}</span>
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${activityColor(e.type)}`} />
                <span className="text-xs text-zinc-300">{e.message}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { api, type KnownPlayer } from '../../lib/api'
import { useI18n } from '../../context/I18nContext'
import { formatDuration } from '../../lib/format'
import { Avatar } from '../../components/ui/Avatar'

export function SectionPlayers({ instanceId }: { instanceId: string }) {
  const { t } = useI18n()
  const [players, setPlayers] = useState<KnownPlayer[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api.adminPlayers(instanceId).then(setPlayers).finally(() => setLoading(false))
  }, [instanceId])

  // Already ranked by total_seconds server-side (GET /api/admin/players) —
  // re-sorting here would be redundant and could only ever mask a backend bug.

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-zinc-500">{t('top_players')}</p>
        <span className="text-xs text-zinc-600">{players.length} {t('players').toLowerCase()}</span>
      </div>

      {loading ? <p className="text-sm text-zinc-600">{t('loading')}</p> : (
        <div className="card divide-y divide-surface-border">
          {players.map((p, i) => (
            <div key={p.id} className="flex items-center gap-3 px-4 py-3">
              <span className="text-zinc-700 text-xs font-mono w-6 text-right shrink-0">#{i+1}</span>
              <Avatar name={p.beammp_username} size={8} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{p.beammp_username}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-xs text-zinc-400 font-mono">{p.connection_count} {t('connections')}</p>
                <p className="text-sm font-semibold text-accent font-mono">{formatDuration(p.total_seconds)}</p>
              </div>
            </div>
          ))}
          {players.length === 0 && <p className="p-8 text-center text-zinc-700 text-sm">{t('no_player')}</p>}
        </div>
      )}
    </div>
  )
}

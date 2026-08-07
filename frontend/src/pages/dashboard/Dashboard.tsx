import { useCallback, useEffect, useState } from 'react'
import { Power } from 'lucide-react'
import { api, type Mod, type InstanceInfo } from '../../lib/api'
import { Sidebar, type AdminSection } from '../../components/layout/Sidebar'
import { ErrorBanner } from '../../components/ui/ErrorBanner'
import { getStoredUser } from '../../lib/auth'
import { useI18n } from '../../context/I18nContext'
import { SectionDashboard } from './SectionDashboard'
import { SectionMods } from './SectionMods'
import { SectionMaps } from './SectionMaps'
import { SectionPlayers } from './SectionPlayers'
import { SectionUpload } from './SectionUpload'
import { SectionConfig } from './SectionConfig'
import { SectionConsistency } from './SectionConsistency'
import { SectionScanImport } from './SectionScanImport'
import { SectionAdmin } from './SectionAdmin'

// One entry per AdminSection — a new section that forgets to appear here is
// a type error, not a silent fallback to the wrong title (which is exactly
// what happened to 'import' before this was a Record).
const SECTION_TITLES: Record<AdminSection, string> = {
  dashboard:   'nav_dashboard',
  mods:        'section_mods',
  maps:        'section_maps',
  players:     'section_players',
  upload:      'section_upload',
  config:      'nav_config',
  consistency: 'consistency_title',
  import:      'nav_import',
  admin:       'nav_admin',
}

export function Dashboard() {
  const { t } = useI18n()
  const [section, setSection]     = useState<AdminSection>('dashboard')
  const [mods, setMods]           = useState<Mod[]>([])
  const [loading, setLoading]     = useState(true)
  const [restarting, setRestarting] = useState(false)
  const [restartError, setRestartError] = useState('')
  const [needsRestart, setNeedsRestart] = useState(false)
  const [instances, setInstances] = useState<InstanceInfo[]>([])
  const [instanceId, setInstanceId] = useState<string>('')

  // Load instance list once
  useEffect(() => {
    api.instances().then(list => {
      setInstances(list)
      if (list.length > 0) setInstanceId(list[0].id)
    }).catch(console.error)
  }, [])

  const refresh = useCallback(() => {
    if (!instanceId) return
    setLoading(true)
    api.mods(instanceId).then(setMods).finally(() => setLoading(false))
  }, [instanceId])

  useEffect(() => { refresh() }, [refresh])

  const maps     = mods.filter(m => m.type === 'map')
  const vehicles = mods.filter(m => m.type === 'vehicle')
  const modList  = mods.filter(m => m.type === 'mod')

  const now = new Date()
  const user = getStoredUser()
  const currentInstance = instances.find(i => i.id === instanceId)
  const canRestart = currentInstance?.canRestart ?? false

  const handleRestart = async () => {
    if (!canRestart) return
    if (!confirm(t('confirm_restart'))) return
    setRestarting(true)
    setRestartError('')
    try {
      await api.restartServer(instanceId)
      setNeedsRestart(false)
    } catch (err: unknown) {
      setRestartError(err instanceof Error ? err.message : t('error'))
    } finally {
      setRestarting(false)
    }
  }

  if (!instanceId) return (
    <div className="flex h-screen items-center justify-center text-zinc-500 text-sm">{t('loading')}</div>
  )

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar section={section} onSection={setSection} modCount={modList.length + vehicles.length} instanceId={instanceId} />

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="h-10 shrink-0 flex items-center justify-between px-5 border-b border-surface-border bg-surface-raised">
          <div className="flex items-center gap-3">
            {/* Instance selector */}
            {instances.length > 1 && (
              <select value={instanceId} onChange={e => setInstanceId(e.target.value)}
                className="input w-auto text-xs py-0.5 h-6">
                {instances.map(inst => (
                  <option key={inst.id} value={inst.id}>{inst.name}</option>
                ))}
              </select>
            )}
            <h1 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 capitalize">
              {t(SECTION_TITLES[section])}
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <div title={!canRestart ? t('restart_not_configured') : undefined}>
              <button onClick={handleRestart} disabled={restarting || !canRestart}
                className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-lg border transition-colors disabled:opacity-40 disabled:cursor-not-allowed
                  ${!canRestart
                    ? 'border-zinc-600 text-zinc-500'
                    : needsRestart
                      ? 'border-red-500 bg-red-500/20 text-red-400 animate-pulse hover:bg-red-500/30'
                      : 'border-red-500/40 text-red-400 hover:bg-red-500/10'}`}>
                <Power size={12} />
                {restarting ? t('restarting') : needsRestart ? t('restart_required') : t('restart_server')}
              </button>
            </div>
            <span className="text-xs text-zinc-600">
              {now.toLocaleDateString(undefined, { day:'2-digit', month:'short', year:'numeric' })} · {now.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' })}
            </span>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-y-auto p-5">
          {restartError && (
            <div className="mb-4">
              <ErrorBanner message={restartError} onDismiss={() => setRestartError('')} />
            </div>
          )}
          {section === 'dashboard' && <SectionDashboard instanceId={instanceId} mods={mods} maps={maps} vehicles={vehicles} loading={loading} />}
          {section === 'mods'      && <SectionMods instanceId={instanceId} mods={modList} vehicles={vehicles} onRefresh={refresh} loading={loading} onNeedsRestart={() => setNeedsRestart(true)} />}
          {section === 'maps'      && <SectionMaps instanceId={instanceId} maps={maps} onRefresh={refresh} loading={loading} onNeedsRestart={() => setNeedsRestart(true)} />}
          {section === 'players'   && <SectionPlayers instanceId={instanceId} />}
          {section === 'upload'       && <SectionUpload instanceId={instanceId} onRefresh={refresh} />}
          {section === 'config'       && <SectionConfig instanceId={instanceId} canRestart={canRestart} restarting={restarting} onRestart={handleRestart} />}
          {section === 'consistency'  && (user?.role === 'superadmin' || user?.role === 'admin') && <SectionConsistency instanceId={instanceId} />}
          {section === 'import'       && (user?.role === 'superadmin' || user?.role === 'admin') && <SectionScanImport instanceId={instanceId} onRefresh={refresh} />}
          {section === 'admin'        && user?.role === 'superadmin' && <SectionAdmin />}
        </main>
      </div>
    </div>
  )
}

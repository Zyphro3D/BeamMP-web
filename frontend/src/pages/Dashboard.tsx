import { useEffect, useState, useRef, useMemo, useCallback } from 'react'
import {
  Package, Map, Car, Users, Upload, Search,
  X, Trash2, RotateCcw, Clock, Copy, Pencil, Power, Shield, Image as ImageIcon,
  AlertTriangle, AlertCircle, CheckCircle2, ScanSearch, Wrench, FolderInput,
} from 'lucide-react'
import { api, type Mod, type ActivityEvent, type KnownPlayer, type InstanceInfo, type ConsistencyReport, type ConsistencyIssue, type ScanImportReport } from '../lib/api'
import { useServerStatus } from '../hooks/useServerStatus'
import { Sidebar, type AdminSection } from '../components/layout/Sidebar'
import { Toggle } from '../components/ui/Toggle'
import { Modal } from '../components/ui/Modal'
import { BeamMPTextEditor } from '../components/ui/BeamMPTextEditor'
import { getStoredUser } from '../lib/auth'
import { useI18n } from '../context/I18nContext'
import { desc } from '../lib/desc'

// ─────────────────────────────────────────────────────────────────────────────

function formatUptime(ms?: number): string {
  if (!ms) return '—'
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  if (h > 0) return `${h}h ${m < 10 ? '0' : ''}${m}m`
  return `${m}m`
}

function fmtTime(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m < 10 ? '0' : ''}${m}min`
  return `${m}min`
}

function Avatar({ name, size = 7 }: { name: string; size?: number }) {
  const colors = ['bg-orange-500','bg-blue-500','bg-green-500','bg-purple-500','bg-pink-500','bg-cyan-500','bg-yellow-500']
  const color = colors[name.charCodeAt(0) % colors.length]
  const sz = `w-${size} h-${size}`
  return (
    <div className={`${sz} rounded-full ${color} flex items-center justify-center text-xs font-bold text-white shrink-0 uppercase`}>
      {name[0]}
    </div>
  )
}

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

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard page

export function Dashboard() {
  const { t } = useI18n()
  const [section, setSection]     = useState<AdminSection>('dashboard')
  const [mods, setMods]           = useState<Mod[]>([])
  const [loading, setLoading]     = useState(true)
  const [restarting, setRestarting] = useState(false)
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
    try { await api.restartServer(instanceId) } catch { /* ignore */ }
    setRestarting(false)
    setNeedsRestart(false)
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
              {section === 'dashboard'    ? t('nav_dashboard')
                : section === 'mods'     ? t('section_mods')
                : section === 'maps'     ? t('section_maps')
                : section === 'players'  ? t('section_players')
                : section === 'upload'   ? t('section_upload')
                : section === 'config'   ? t('nav_config')
                : section === 'consistency' ? t('consistency_title')
                : t('nav_admin')}
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
          {section === 'dashboard' && <SectionDashboard instanceId={instanceId} mods={mods} maps={maps} vehicles={vehicles} loading={loading} />}
          {section === 'mods'      && <SectionMods instanceId={instanceId} mods={modList} vehicles={vehicles} onRefresh={refresh} loading={loading} onNeedsRestart={() => setNeedsRestart(true)} />}
          {section === 'maps'      && <SectionMaps instanceId={instanceId} maps={maps} onRefresh={refresh} loading={loading} onNeedsRestart={() => setNeedsRestart(true)} />}
          {section === 'players'   && <SectionPlayers instanceId={instanceId} />}
          {section === 'upload'       && <SectionUpload instanceId={instanceId} onRefresh={refresh} />}
          {section === 'config'       && <SectionConfig instanceId={instanceId} />}
          {section === 'consistency'  && (user?.role === 'superadmin' || user?.role === 'admin') && <SectionConsistency instanceId={instanceId} />}
          {section === 'import'       && (user?.role === 'superadmin' || user?.role === 'admin') && <SectionScanImport instanceId={instanceId} onRefresh={refresh} />}
          {section === 'admin'        && user?.role === 'superadmin' && <SectionAdmin />}
        </main>
      </div>
    </div>
  )
}

// ─── Overview Dashboard ──────────────────────────────────────────────────────

function SectionDashboard({ instanceId, mods, maps, vehicles, loading }: {
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
      value: formatUptime(status.uptimeMs),
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
                  <span className="badge-green text-[10px]">Active</span>
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

// ─── Mods ────────────────────────────────────────────────────────────────────

type SortKey = 'name-asc' | 'name-desc' | 'date-asc' | 'date-desc'

function getSortOptions(t: (k: string) => string): { value: SortKey; label: string }[] {
  return [
    { value: 'name-asc',  label: t('sort_az') },
    { value: 'name-desc', label: t('sort_za') },
    { value: 'date-desc', label: t('sort_newest') },
    { value: 'date-asc',  label: t('sort_oldest') },
  ]
}

function sortMods(list: Mod[], sort: SortKey): Mod[] {
  return [...list].sort((a, b) => {
    if (sort === 'name-asc')  return a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' })
    if (sort === 'name-desc') return b.name.localeCompare(a.name, 'fr', { sensitivity: 'base' })
    if (sort === 'date-asc')  return a.id - b.id
    return b.id - a.id // date-desc
  })
}

function SectionMods({ instanceId, mods, vehicles, onRefresh, loading, onNeedsRestart }: {
  instanceId: string; mods: Mod[]; vehicles: Mod[]; onRefresh: () => void; loading: boolean; onNeedsRestart: () => void
}) {
  const { t } = useI18n()
  const SORT_OPTIONS = getSortOptions(t)
  const [search, setSearch]        = useState('')
  const [activeFilter, setActive]  = useState<'all'|'active'|'inactive'>('all')
  const [sort, setSort]            = useState<SortKey>('name-asc')
  const [showUpload, setShowUpload] = useState(false)
  const [uploading, setUploading]   = useState(false)
  const [upError, setUpError]       = useState('')
  const [toggleError, setToggleError] = useState('')

  const filter = (list: Mod[]) => sortMods(list.filter(m => {
    if (search && !m.name.toLowerCase().includes(search.toLowerCase())) return false
    if (activeFilter === 'active'   && !m.active) return false
    if (activeFilter === 'inactive' &&  m.active) return false
    return true
  }), sort)

  const filteredVehicles = useMemo(() => filter(vehicles), [vehicles, search, activeFilter, sort])
  const filteredMods     = useMemo(() => filter(mods),     [mods,     search, activeFilter, sort])

  const totalActive = [...mods, ...vehicles].filter(m => m.active).length
  const total       = mods.length + vehicles.length

  const vehiclesRef = useRef<HTMLDivElement>(null)
  const modsRef     = useRef<HTMLDivElement>(null)

  const toggle = async (id: number) => {
    setToggleError('')
    try {
      await api.toggleMod(instanceId, id)
      onNeedsRestart()
      onRefresh()
    } catch (err: unknown) {
      setToggleError(err instanceof Error ? err.message : t('toggle_error'))
    }
  }
  const remove = async (id: number) => {
    if (!confirm(t('confirm_delete'))) return
    await api.deleteMod(instanceId, id); onRefresh()
  }

  const handleUpload = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setUpError(''); setUploading(true)
    try { await api.uploadMod(instanceId, new FormData(e.currentTarget)); setShowUpload(false); onRefresh() }
    catch (err: unknown) { setUpError(err instanceof Error ? err.message : 'Erreur') }
    finally { setUploading(false) }
  }

  return (
    <div className="space-y-4">
      {toggleError && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 flex items-center justify-between">
          {toggleError}
          <button onClick={() => setToggleError('')}><X size={12} /></button>
        </div>
      )}
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-40">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder={t('search')} className="input pl-8 pr-7 text-xs" />
          {search && <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-600"><X size={12} /></button>}
        </div>

        <div className="flex rounded-lg border border-surface-border overflow-hidden text-xs">
          {(['all','active','inactive'] as const).map(f => (
            <button key={f} onClick={() => setActive(f)}
              className={`px-2.5 py-1.5 font-medium transition-colors ${activeFilter === f ? 'bg-accent text-white' : 'bg-surface-card text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200'}`}>
              {f === 'all' ? t('all') : f === 'active' ? t('actives') : t('inactives')}
            </button>
          ))}
        </div>

        <select value={sort} onChange={e => setSort(e.target.value as SortKey)}
          className="input w-auto text-xs py-1">
          {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        <span className="text-xs text-zinc-600 ml-auto">{total} · {totalActive} {t('actives').toLowerCase()}</span>

        <button onClick={() => setShowUpload(true)} className="btn-accent text-xs">
          <Upload size={13} />{t('upload')}
        </button>
      </div>

      {/* Zone quick-nav — sticky so both directions are always reachable */}
      <div className="flex gap-2 sticky top-0 z-20 bg-surface py-2 -mx-1 px-1">
        <button onClick={() => vehiclesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-blue-500/30 text-blue-400 hover:bg-blue-500/10 transition-colors">
          <Car size={12} />{t('vehicles')} ({filteredVehicles.length})
        </button>
        <button onClick={() => modsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-accent/30 text-accent hover:bg-accent/10 transition-colors">
          <Package size={12} />{t('mods')} ({filteredMods.length})
        </button>
      </div>

      {loading ? <p className="text-sm text-zinc-600">{t('loading')}</p> : (
        <div className="space-y-8">
          {/* Véhicules zone */}
          <div ref={vehiclesRef}>
            <div className="flex items-center gap-2 mb-3">
              <Car size={14} className="text-blue-400" />
              <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{t('vehicles')}</h2>
              <span className="text-xs text-zinc-600">({filteredVehicles.length})</span>
            </div>
            {filteredVehicles.length === 0 ? (
              <div className="card p-6 text-center text-zinc-700 text-sm">{t('no_vehicle')}</div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                {filteredVehicles.map(mod => (
                  <ModCard key={mod.id} instanceId={instanceId} mod={mod} onToggle={() => toggle(mod.id)} onDelete={() => remove(mod.id)} onRefresh={onRefresh} />
                ))}
              </div>
            )}
          </div>

          {/* Mods zone */}
          <div ref={modsRef}>
            <div className="flex items-center gap-2 mb-3">
              <Package size={14} className="text-accent" />
              <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{t('mods')}</h2>
              <span className="text-xs text-zinc-600">({filteredMods.length})</span>
            </div>
            {filteredMods.length === 0 ? (
              <div className="card p-6 text-center text-zinc-700 text-sm">{t('no_mod')}</div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                {filteredMods.map(mod => (
                  <ModCard key={mod.id} instanceId={instanceId} mod={mod} onToggle={() => toggle(mod.id)} onDelete={() => remove(mod.id)} onRefresh={onRefresh} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {showUpload && (
        <Modal title={t('upload_mod')} onClose={() => setShowUpload(false)}>
          <form onSubmit={handleUpload} className="space-y-3">
            {upError && <p className="text-xs text-red-400">{upError}</p>}
            <div className="space-y-1"><label className="text-xs text-zinc-400">{t('mod_name')}</label><input name="name" required className="input" /></div>
            <div className="space-y-1"><label className="text-xs text-zinc-400">{t('mod_type')}</label>
              <select name="type" required className="input">
                <option value="mod">Mod</option><option value="vehicle">{t('vehicle')}</option>
              </select>
            </div>
            <div className="space-y-1"><label className="text-xs text-zinc-400">{t('description')}</label><input name="description" className="input" /></div>
            <div className="space-y-1"><label className="text-xs text-zinc-400">{t('mod_file')}</label><input name="file" type="file" accept=".zip,.pak" required className="input py-1.5 text-xs" /></div>
            <button type="submit" disabled={uploading} className="btn-accent w-full justify-center">{uploading ? t('uploading_progress') : t('upload')}</button>
          </form>
        </Modal>
      )}
    </div>
  )
}

// ─── Description Editor ───────────────────────────────────────────────────────

function DescriptionEditor({ instanceId, mod, onClose, onSaved }: { instanceId: string; mod: Mod; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n()
  const existing = mod.description ?? {}
  const [langs, setLangs] = useState<{ lang: string; text: string }[]>(
    Object.entries(existing).map(([l, txt]) => ({ lang: l, text: txt }))
  )
  const [newLang, setNewLang] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const addLang = () => {
    const code = newLang.trim().toLowerCase().slice(0, 5)
    if (!code || langs.some(l => l.lang === code)) return
    setLangs([...langs, { lang: code, text: '' }])
    setNewLang('')
  }

  const save = async () => {
    setSaving(true); setError('')
    try {
      for (const { lang, text } of langs) {
        await api.updateModDescription(instanceId, mod.id, lang, text)
      }
      onSaved()
      onClose()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Erreur')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`${t('edit_description')} — ${mod.name}`} onClose={onClose}>
      <div className="space-y-3">
        {langs.length === 0 && (
          <p className="text-xs text-zinc-500 italic">{t('no_description')}</p>
        )}
        {langs.map(({ lang, text }, i) => (
          <div key={lang} className="space-y-1">
            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider">{lang}</label>
            <textarea
              value={text}
              onChange={e => setLangs(ls => ls.map((l, j) => j === i ? { ...l, text: e.target.value } : l))}
              className="input resize-none h-24 text-sm"
              placeholder={t('no_description')}
            />
          </div>
        ))}
        <div className="flex gap-2">
          <input
            value={newLang}
            onChange={e => setNewLang(e.target.value)}
            placeholder={t('lang_code')}
            className="input text-xs flex-1"
            maxLength={5}
            onKeyDown={e => e.key === 'Enter' && addLang()}
          />
          <button onClick={addLang} className="btn-ghost text-xs">{t('add_lang')}</button>
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <button onClick={save} disabled={saving} className="btn-accent w-full justify-center">
          {saving ? '…' : t('save')}
        </button>
      </div>
    </Modal>
  )
}

// ─── Mod Card ─────────────────────────────────────────────────────────────────

function ModCard({ instanceId, mod, onToggle, onDelete, onRefresh }: {
  instanceId: string; mod: Mod; onToggle: () => void; onDelete: () => void; onRefresh: () => void
}) {
  const { t, lang } = useI18n()
  const [editingDesc, setEditingDesc] = useState(false)
  const modDesc = desc(mod.description, lang)

  return (
    <>
      <div className={`card overflow-hidden flex flex-col ${!mod.active ? 'opacity-60' : ''}`}>
        {/* Image */}
        {mod.image ? (
          <img src={`/images/${mod.image}`} alt={mod.name}
            className="w-full h-28 object-contain bg-zinc-100 dark:bg-zinc-800/60" />
        ) : (
          <div className="w-full h-28 bg-surface flex items-center justify-center">
            {mod.type === 'vehicle'
              ? <Car size={32} className="text-zinc-700" />
              : <Package size={32} className="text-zinc-700" />}
          </div>
        )}

        {/* Body */}
        <div className="p-3 flex flex-col gap-2 flex-1">
          <div className="min-w-0">
            <p className="text-sm font-semibold truncate">{mod.name}</p>
            {modDesc && <p className="text-xs text-zinc-500 mt-0.5 line-clamp-2">{modDesc}</p>}
          </div>

          <div className="flex items-center gap-2 mt-auto">
            <span className={mod.active ? 'badge-green' : 'badge-zinc'}>
              {t(mod.active ? 'active' : 'inactive')}
            </span>
            <div className="flex-1" />
            <button onClick={() => setEditingDesc(true)}
              className="p-1.5 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-white/5 rounded-lg transition-colors"
              title={t('edit_description')}>
              <Pencil size={12} />
            </button>
            <Toggle checked={mod.active} onChange={onToggle} />
            <button onClick={onDelete} className="p-1.5 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors">
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      </div>
      {editingDesc && (
        <DescriptionEditor instanceId={instanceId} mod={mod} onClose={() => setEditingDesc(false)} onSaved={onRefresh} />
      )}
    </>
  )
}

// ─── Maps ─────────────────────────────────────────────────────────────────────

function SectionMaps({ instanceId, maps, onRefresh, loading, onNeedsRestart }: { instanceId: string; maps: Mod[]; onRefresh: () => void; loading: boolean; onNeedsRestart: () => void }) {
  const { t } = useI18n()
  const SORT_OPTIONS = getSortOptions(t)
  const [search, setSearch] = useState('')
  const [sort, setSort]     = useState<SortKey>('name-asc')
  const [activating, setActivating] = useState<number | null>(null)
  const [activateError, setActivateError] = useState('')
  const [showUpload, setShowUpload] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [upError, setUpError] = useState('')

  const activeMap = maps.find(m => m.active)

  const filtered = useMemo(() => sortMods(maps.filter(m =>
    !search || m.name.toLowerCase().includes(search.toLowerCase())
  ), sort), [maps, search, sort])

  const activate = async (map: Mod) => {
    if (!map.map_id) return
    setActivateError('')
    setActivating(map.id)
    try {
      await api.activateMap(instanceId, map.map_id)
      onNeedsRestart()
      onRefresh()
    } catch (err: unknown) {
      setActivateError(err instanceof Error ? err.message : t('activate_error'))
    } finally {
      setActivating(null)
    }
  }

  const deleteMap = async (map: Mod) => {
    if (!confirm(t('confirm_delete_map'))) return
    await api.deleteMod(instanceId, map.id).catch(console.error)
    onRefresh()
  }

  const toggleOfficial = async (map: Mod) => {
    await api.toggleOfficial(instanceId, map.id).catch(console.error)
    onRefresh()
  }

  const handleUpload = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setUpError(''); setUploading(true)
    const fd = new FormData(e.currentTarget); fd.set('type', 'map')
    try { await api.uploadMod(instanceId, fd); setShowUpload(false); onRefresh() }
    catch (err: unknown) { setUpError(err instanceof Error ? err.message : 'Erreur') }
    finally { setUploading(false) }
  }

  return (
    <div className="space-y-4">
      {activateError && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 flex items-center justify-between">
          {activateError}
          <button onClick={() => setActivateError('')}><X size={12} /></button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-xs">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('search')} className="input pl-8 text-xs" />
        </div>
        <select value={sort} onChange={e => setSort(e.target.value as SortKey)}
          className="input w-auto text-xs py-1">
          {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        <button onClick={() => setShowUpload(true)} className="btn-accent text-xs"><Upload size={13} />{t('add')}</button>
      </div>

      {/* Active map banner */}
      {!loading && activeMap && (
        <div className="card overflow-hidden ring-1 ring-accent">
          <div className="flex items-center gap-2 px-4 pt-3 pb-1">
            <span className="text-[10px] font-semibold text-accent uppercase tracking-wider">● {t('active_map_label')}</span>
          </div>
          <div className="flex gap-4 p-3">
            {activeMap.image ? (
              <img src={`/images/${activeMap.image}`} alt={activeMap.name}
                className="w-40 h-24 object-contain rounded-lg bg-zinc-100 dark:bg-zinc-800/60 shrink-0" />
            ) : (
              <div className="w-40 h-24 rounded-lg bg-surface flex items-center justify-center shrink-0">
                <Map size={24} className="text-zinc-600" />
              </div>
            )}
            <div className="flex-1 min-w-0 flex flex-col justify-center gap-1">
              <p className="font-semibold text-sm">{activeMap.name}</p>
              {activeMap.map_id && <span className="badge-zinc font-mono text-[10px] w-fit">{activeMap.map_id}</span>}
            </div>
          </div>
        </div>
      )}

      {loading ? <p className="text-sm text-zinc-600">{t('loading')}</p> : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(map => (
            <MapCard key={map.id} instanceId={instanceId} map={map} activating={activating} onActivate={activate} onDelete={deleteMap} onToggleOfficial={toggleOfficial} onRefresh={onRefresh} />
          ))}
          {filtered.length === 0 && <div className="col-span-3 card p-10 text-center text-zinc-700 text-sm">{t('no_map')}</div>}
        </div>
      )}

      {showUpload && (
        <Modal title={t('add_map')} onClose={() => setShowUpload(false)}>
          <form onSubmit={handleUpload} className="space-y-3">
            {upError && <p className="text-xs text-red-400">{upError}</p>}
            <div className="space-y-1"><label className="text-xs text-zinc-400">{t('mod_display_name')}</label><input name="name" required className="input" /></div>
            <div className="space-y-1"><label className="text-xs text-zinc-400">{t('map_id_label')}</label><input name="map_id" required className="input font-mono text-xs" placeholder="/levels/mapname/info.json" /></div>
            <div className="space-y-1"><label className="text-xs text-zinc-400">{t('description')}</label><input name="description" className="input" /></div>
            <div className="space-y-1"><label className="text-xs text-zinc-400">{t('mod_file')}</label><input name="file" type="file" accept=".zip" required className="input py-1.5 text-xs" /></div>
            <button type="submit" disabled={uploading} className="btn-accent w-full justify-center">{uploading ? t('uploading_progress') : t('add')}</button>
          </form>
        </Modal>
      )}
    </div>
  )
}

// ─── Map Card ─────────────────────────────────────────────────────────────────

function MapCard({ instanceId, map, activating, onActivate, onDelete, onToggleOfficial, onRefresh }: {
  instanceId: string
  map: Mod
  activating: number | null
  onActivate: (map: Mod) => void
  onDelete: (map: Mod) => void
  onToggleOfficial: (map: Mod) => void
  onRefresh: () => void
}) {
  const { lang, t } = useI18n()
  const [editingDesc, setEditingDesc] = useState(false)
  const mapDesc = desc(map.description, lang)

  return (
    <>
      <div className={`card overflow-hidden relative ${map.active ? 'ring-1 ring-accent' : ''} ${map.is_official ? 'ring-1 ring-blue-500/40' : ''}`}>
        {/* Badges top-right */}
        <div className="absolute top-2 right-2 z-10 flex flex-col items-end gap-1">
          {map.active && <span className="badge-green text-[10px]">● Active</span>}
          {map.is_official && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-blue-500/20 text-blue-400 text-[10px] font-medium">
              <Shield size={9} />Officielle
            </span>
          )}
        </div>

        {/* Image */}
        {map.image ? (
          <img src={`/images/${map.image}`} alt={map.name} className="w-full h-36 object-contain bg-zinc-100 dark:bg-zinc-800/60" />
        ) : (
          <div className="w-full h-36 bg-surface flex flex-col items-center justify-center gap-2">
            <Map size={32} className="text-zinc-600 dark:text-zinc-500" />
            <span className="text-[10px] text-zinc-500">{t('no_image')}</span>
          </div>
        )}

        <div className="p-3 space-y-2">
          <div>
            <p className="text-sm font-semibold">{map.name}</p>
            {mapDesc && <p className="text-xs text-zinc-500 mt-0.5 line-clamp-2">{mapDesc}</p>}
          </div>

          {map.map_id && (
            <span className="badge-zinc font-mono text-[10px] truncate max-w-full block">{map.map_id}</span>
          )}

          {/* Actions */}
          <div className="flex items-center gap-1 pt-1">
            {/* Toggle official */}
            <button onClick={() => onToggleOfficial(map)}
              className={`p-1.5 rounded-lg transition-colors ${map.is_official ? 'text-blue-400 bg-blue-500/10 hover:bg-blue-500/20' : 'text-zinc-500 hover:text-blue-400 hover:bg-blue-500/10'}`}
              title={map.is_official ? t('unmark_official') : t('mark_official')}>
              <Shield size={12} />
            </button>
            {/* Edit description */}
            <button onClick={() => setEditingDesc(true)}
              className="p-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-white/5 rounded-lg transition-colors"
              title={t('edit_description')}>
              <Pencil size={12} />
            </button>
            <div className="flex-1" />
            {/* Delete (hidden for official) */}
            {!map.is_official && (
              <button onClick={() => onDelete(map)}
                className="p-1.5 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                title={t('delete')}>
                <Trash2 size={12} />
              </button>
            )}
            {/* Activate */}
            {!map.active && (
              <button onClick={() => onActivate(map)} disabled={activating === map.id} className="btn-accent text-xs py-1">
                {activating === map.id ? '…' : t('activate')}
              </button>
            )}
          </div>
        </div>
      </div>
      {editingDesc && (
        <DescriptionEditor instanceId={instanceId} mod={map} onClose={() => setEditingDesc(false)} onSaved={onRefresh} />
      )}
    </>
  )
}

// ─── Players ─────────────────────────────────────────────────────────────────

function SectionPlayers({ instanceId }: { instanceId: string }) {
  const { t } = useI18n()
  const [players, setPlayers] = useState<KnownPlayer[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api.adminPlayers(instanceId).then(setPlayers).finally(() => setLoading(false))
  }, [instanceId])

  const sorted = [...players].sort((a, b) => b.total_seconds - a.total_seconds)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-zinc-500">{t('top_players')}</p>
        <span className="text-xs text-zinc-600">{players.length} {t('players').toLowerCase()}</span>
      </div>

      {loading ? <p className="text-sm text-zinc-600">{t('loading')}</p> : (
        <div className="card divide-y divide-surface-border">
          {sorted.map((p, i) => (
            <div key={p.id} className="flex items-center gap-3 px-4 py-3">
              <span className="text-zinc-700 text-xs font-mono w-6 text-right shrink-0">#{i+1}</span>
              <Avatar name={p.beammp_username} size={8} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{p.beammp_username}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-xs text-zinc-400 font-mono">{p.connection_count} {t('connections')}</p>
                <p className="text-sm font-semibold text-accent font-mono">{fmtTime(p.total_seconds)}</p>
              </div>
            </div>
          ))}
          {sorted.length === 0 && <p className="p-8 text-center text-zinc-700 text-sm">{t('no_player')}</p>}
        </div>
      )}
    </div>
  )
}

// ─── Upload ──────────────────────────────────────────────────────────────────

interface UploadItem {
  file: File
  name: string
  type: 'mod' | 'vehicle' | 'map'
  mapId: string
  description: string
  imageFile: File | null
  status: 'pending' | 'uploading' | 'done' | 'error'
  error?: string
  modId?: number
  imagePreview?: string
}

function SectionUpload({ instanceId, onRefresh }: { instanceId: string; onRefresh: () => void }) {
  const { t } = useI18n()
  const [dragging, setDragging] = useState(false)
  const [queue, setQueue] = useState<UploadItem[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  const humanSize = (b: number) => b > 1e6 ? `${(b/1e6).toFixed(1)} Mo` : `${Math.round(b/1024)} Ko`

  const update = (idx: number, patch: Partial<UploadItem>) =>
    setQueue(q => q.map((x, i) => i === idx ? { ...x, ...patch } : x))

  const addFiles = (fileList: FileList) => {
    const items: UploadItem[] = Array.from(fileList).map(f => ({
      file: f,
      name: f.name.replace(/\.[^.]+$/, ''),
      type: 'mod',
      mapId: '',
      description: '',
      imageFile: null,
      status: 'pending',
    }))
    setQueue(q => [...q, ...items])
  }

  const setImage = (idx: number, file: File | null) => {
    if (!file) { update(idx, { imageFile: null, imagePreview: undefined }); return }
    const preview = URL.createObjectURL(file)
    update(idx, { imageFile: file, imagePreview: preview })
  }

  const doUpload = async (idx: number) => {
    const item = queue[idx]
    if (!item || item.status !== 'pending') return
    update(idx, { status: 'uploading' })
    const fd = new FormData()
    fd.append('file', item.file)
    fd.append('name', item.name)
    fd.append('type', item.type)
    if (item.description) fd.append('description', item.description)
    if (item.type === 'map' && item.mapId) fd.append('map_id', item.mapId)
    try {
      const mod = await api.uploadMod(instanceId, fd)
      // Upload image if provided
      if (item.imageFile) {
        await api.uploadModImage(instanceId, mod.id, item.imageFile).catch(() => {})
      }
      update(idx, { status: 'done', modId: mod.id })
      onRefresh()
    } catch (err: unknown) {
      update(idx, { status: 'error', error: err instanceof Error ? err.message : 'Erreur' })
    }
  }

  const doDelete = async (idx: number) => {
    const item = queue[idx]
    if (!item?.modId) return
    await api.deleteMod(instanceId, item.modId).catch(console.error)
    setQueue(q => q.filter((_, i) => i !== idx))
    onRefresh()
  }

  const removeFromQueue = (idx: number) => setQueue(q => q.filter((_, i) => i !== idx))

  const pendingCount = queue.filter(q => q.status === 'pending').length

  return (
    <div className="max-w-2xl space-y-4">
      {/* Drop zone */}
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files) }}
        className={`card p-10 text-center cursor-pointer transition-colors border-2 border-dashed
          ${dragging ? 'border-accent bg-accent/5' : 'border-surface-border hover:border-zinc-600'}`}
      >
        <Upload size={28} className={`mx-auto mb-3 ${dragging ? 'text-accent' : 'text-zinc-700'}`} />
        <p className="text-sm font-medium">{t('drop_files')}</p>
        <p className="text-xs text-zinc-500 mt-1">{t('or_browse')}</p>
        <p className="text-[10px] text-zinc-600 mt-2">{t('max_size')}</p>
        <input ref={inputRef} type="file" multiple accept=".zip,.pak" className="hidden"
          onChange={e => e.target.files && addFiles(e.target.files)} />
      </div>

      {/* Queue */}
      {queue.length > 0 && (
        <div className="space-y-3">
          {queue.map((item, idx) => (
            <div key={idx} className="card p-4 space-y-3">
              {/* File header */}
              <div className="flex items-center gap-2">
                <Package size={14} className={
                  item.status === 'done' ? 'text-green-400' :
                  item.status === 'error' ? 'text-red-400' :
                  item.status === 'uploading' ? 'text-accent' : 'text-zinc-500'
                } />
                <span className="text-xs font-mono text-zinc-500 truncate flex-1">{item.file.name}</span>
                <span className="text-[10px] text-zinc-600 shrink-0">{humanSize(item.file.size)}</span>
              </div>

              {item.status === 'pending' && (
                <div className="grid grid-cols-2 gap-3">
                  {/* Nom */}
                  <div className="space-y-1">
                    <label className="text-[10px] text-zinc-400 uppercase tracking-wider">{t('mod_display_name')} <span className="text-red-400">*</span></label>
                    <input value={item.name} onChange={e => update(idx, { name: e.target.value })}
                      className="input text-xs w-full" placeholder={t('mod_name')} />
                  </div>
                  {/* Type */}
                  <div className="space-y-1">
                    <label className="text-[10px] text-zinc-400 uppercase tracking-wider">{t('mod_type')} <span className="text-red-400">*</span></label>
                    <select value={item.type} onChange={e => update(idx, { type: e.target.value as UploadItem['type'] })}
                      className="input text-xs w-full">
                      <option value="mod">{t('mod')}</option>
                      <option value="vehicle">{t('vehicle')}</option>
                      <option value="map">{t('map_label')}</option>
                    </select>
                  </div>
                  {/* Map ID (only for map type) */}
                  {item.type === 'map' && (
                    <div className="col-span-2 space-y-1">
                      <label className="text-[10px] text-zinc-400 uppercase tracking-wider">{t('map_id_label')} <span className="text-red-400">*</span></label>
                      <input value={item.mapId} onChange={e => update(idx, { mapId: e.target.value })}
                        className="input text-xs w-full font-mono" placeholder="/levels/nomdelacarte/info.json" />
                    </div>
                  )}
                  {/* Description */}
                  <div className="col-span-2 space-y-1">
                    <label className="text-[10px] text-zinc-400 uppercase tracking-wider">{t('description')}</label>
                    <textarea value={item.description} onChange={e => update(idx, { description: e.target.value })}
                      className="input text-xs w-full resize-none" rows={2} placeholder={t('no_description')} />
                  </div>
                  {/* Image */}
                  <div className="col-span-2 space-y-1">
                    <label className="text-[10px] text-zinc-400 uppercase tracking-wider">{t('image_label')}</label>
                    <div className="flex items-center gap-3">
                      {item.imagePreview ? (
                        <img src={item.imagePreview} alt="preview" className="w-20 h-14 object-contain rounded-lg bg-zinc-800 shrink-0" />
                      ) : (
                        <div className="w-20 h-14 rounded-lg bg-surface flex items-center justify-center shrink-0">
                          <ImageIcon size={16} className="text-zinc-600" />
                        </div>
                      )}
                      <label className="btn-ghost text-xs cursor-pointer">
                        <ImageIcon size={12} />{item.imageFile ? t('change_image') : t('choose_image')}
                        <input type="file" accept="image/*" className="hidden"
                          onChange={e => setImage(idx, e.target.files?.[0] ?? null)} />
                      </label>
                      {item.imageFile && (
                        <button onClick={() => setImage(idx, null)} className="text-xs text-zinc-500 hover:text-zinc-300">
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {item.status === 'uploading' && (
                <div className="h-1 bg-surface rounded-full overflow-hidden">
                  <div className="h-full bg-accent rounded-full animate-pulse w-2/3" />
                </div>
              )}

              {item.status === 'error' && (
                <p className="text-xs text-red-400">{item.error}</p>
              )}

              {/* Actions */}
              <div className="flex items-center justify-end gap-2">
                {item.status === 'pending' && (
                  <>
                    <button onClick={() => removeFromQueue(idx)}
                      className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors px-2 py-1">
                      {t('cancel')}
                    </button>
                    <button onClick={() => doUpload(idx)}
                      disabled={!item.name || !item.imageFile || (item.type === 'map' && !item.mapId)}
                      className="btn-accent text-xs py-1 disabled:opacity-40 disabled:cursor-not-allowed">
                      <Upload size={12} />{t('upload')}
                    </button>
                  </>
                )}
                {item.status === 'done' && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-green-400 font-medium">{t('uploaded')}</span>
                    <button onClick={() => doDelete(idx)}
                      className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 px-2 py-1 rounded-lg transition-colors">
                      <Trash2 size={12} />{t('delete')}
                    </button>
                  </div>
                )}
                {item.status === 'error' && (
                  <button onClick={() => update(idx, { status: 'pending', error: undefined })}
                    className="text-xs text-accent hover:underline">
                    {t('retry')}
                  </button>
                )}
              </div>
            </div>
          ))}

          {pendingCount > 1 && (
            <button onClick={() => queue.forEach((_, i) => doUpload(i))}
              className="btn-accent w-full justify-center text-sm">
              <Upload size={14} />{t('upload_all')} ({pendingCount})
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Config + Logs ────────────────────────────────────────────────────────────

const CONFIG_KEY_DEFS = [
  { key: 'MaxPlayers', labelKey: 'max_players_label', type: 'number' },
  { key: 'MaxCars',    labelKey: 'max_cars_label',    type: 'number' },
  { key: 'Private',    labelKey: 'private_label',     type: 'toggle' },
  { key: 'LogChat',    labelKey: 'log_chat_label',    type: 'toggle' },
  { key: 'Tags',       labelKey: 'tags_label',        type: 'text' },
  { key: 'Debug',      labelKey: 'debug_label',       type: 'toggle' },
]

function SectionConfig({ instanceId }: { instanceId: string }) {
  const { t } = useI18n()
  const [cfg, setCfg]     = useState<Record<string,string>>({})
  const [name, setName]   = useState('')
  const [desc2, setDesc2] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [saved, setSaved]     = useState(false)
  const [error, setError]     = useState('')
  const [logs, setLogs]       = useState<string[]>([])
  const [restarting, setRestarting] = useState(false)
  const logsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.getConfig(instanceId).then(c => {
      setCfg(c)
      setName(c.Name ?? '')
      setDesc2(c.Description ?? '')
    }).catch(e => setError(e.message)).finally(() => setLoading(false))
  }, [instanceId])

  const refreshLogs = useCallback(() => api.logs(instanceId, 80).then(r => setLogs(r.lines)).catch(() => {}), [instanceId])
  useEffect(() => { refreshLogs(); const t = setInterval(refreshLogs, 5000); return () => clearInterval(t) }, [refreshLogs])
  useEffect(() => { logsRef.current?.scrollTo(0, logsRef.current.scrollHeight) }, [logs])

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setSaving(true); setSaved(false)
    const updates: Record<string,string> = { Name: name, Description: desc2 }
    for (const {key, type} of CONFIG_KEY_DEFS) {
      if (type === 'toggle') updates[key] = cfg[key] ?? 'false'
      else {
        const fd = new FormData(e.currentTarget)
        updates[key] = fd.get(key) as string
      }
    }
    try { await api.updateConfig(instanceId, updates); setSaved(true); setTimeout(() => setSaved(false), 2000) }
    catch (err: unknown) { setError(err instanceof Error ? err.message : 'Erreur') }
    finally { setSaving(false) }
  }

  const restart = async () => {
    if (!confirm(t('confirm_restart'))) return
    setRestarting(true)
    await api.restartServer(instanceId).catch(console.error)
    setRestarting(false)
  }

  const copyLogs = () => navigator.clipboard.writeText(logs.join('\n'))

  const logColor = (l: string) =>
    l.includes('ERROR') ? 'text-red-400' :
    l.includes('WARN') ? 'text-yellow-400' :
    l.includes('Connected') ? 'text-green-400' :
    l.includes('Disconnected') ? 'text-orange-400' :
    'text-zinc-400'

  if (loading) return <p className="text-sm text-zinc-600">{t('loading')}</p>

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      {/* Config form */}
      <div className="card p-5 space-y-1">
        <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4">⚙ {t('server_config')}</p>
        {error && <p className="text-xs text-red-400 mb-3">{error}</p>}
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Nom du serveur avec éditeur BeamMP */}
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-400">{t('server_name_label')}</label>
            <BeamMPTextEditor name="Name" value={name} onChange={setName} placeholder={t('server_name_placeholder')} />
          </div>

          {/* Description avec éditeur BeamMP (multiline) */}
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-400">{t('description')}</label>
            <BeamMPTextEditor name="Description" value={desc2} onChange={setDesc2} multiline placeholder={t('description_placeholder')} />
          </div>

          {CONFIG_KEY_DEFS.map(({key, labelKey, type}) => (
            <div key={key} className="space-y-1.5">
              <label className="text-xs text-zinc-400">{t(labelKey)}</label>
              {type === 'toggle' ? (
                <div className="flex items-center gap-2">
                  <Toggle
                    checked={cfg[key] === 'true'}
                    onChange={() => setCfg(c => ({ ...c, [key]: c[key] === 'true' ? 'false' : 'true' }))}
                  />
                  <span className="text-xs text-zinc-500">{cfg[key] === 'true' ? t('enabled') : t('disabled')}</span>
                </div>
              ) : (
                <input name={key} defaultValue={cfg[key] ?? ''} type={type} className="input" />
              )}
            </div>
          ))}
          <button type="submit" disabled={saving} className="btn-accent w-full justify-center mt-2">
            {saving ? t('saving') : saved ? t('saved') : t('save_config')}
          </button>
        </form>
      </div>

      {/* Logs */}
      <div className="card overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-3 border-b border-surface-border shrink-0">
          <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">● {t('server_logs')}</p>
          <button onClick={copyLogs} className="p-1.5 text-zinc-600 hover:text-zinc-300 transition-colors"><Copy size={13} /></button>
        </div>
        <div ref={logsRef} className="flex-1 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed bg-surface min-h-[300px] max-h-[400px]">
          {logs.length === 0 ? <span className="text-zinc-700">{t('no_log')}</span> :
            logs.map((l, i) => <div key={i} className={logColor(l)}>{l}</div>)}
        </div>
        <div className="p-3 border-t border-surface-border shrink-0">
          <button onClick={restart} disabled={restarting} className="btn-danger w-full justify-center">
            <RotateCcw size={13} />
            {restarting ? t('restarting') : t('restart_server')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Consistency Check ───────────────────────────────────────────────────────

function SectionConsistency({ instanceId }: { instanceId: string }) {
  const { t } = useI18n()
  const [report, setReport] = useState<ConsistencyReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [fixing, setFixing] = useState<Set<string>>(new Set())
  const [fixed, setFixed] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})

  const scan = async () => {
    setLoading(true)
    setFixed(new Set())
    setErrors({})
    try {
      const r = await api.checkConsistency(instanceId)
      setReport(r)
    } catch (err: unknown) {
      setErrors({ _scan: err instanceof Error ? err.message : 'Erreur lors du scan' })
    } finally {
      setLoading(false)
    }
  }

  const fixOne = async (issue: ConsistencyIssue) => {
    if (!issue.fix || !issue.meta) return
    setFixing(s => new Set(s).add(issue.id))
    try {
      await api.fixConsistency(instanceId, issue.fix, issue.meta)
      setFixed(s => new Set(s).add(issue.id))
    } catch (err: unknown) {
      setErrors(e => ({ ...e, [issue.id]: err instanceof Error ? err.message : 'Erreur' }))
    } finally {
      setFixing(s => { const n = new Set(s); n.delete(issue.id); return n })
    }
  }

  const fixAll = async (issues: ConsistencyIssue[]) => {
    for (const issue of issues) {
      if (issue.fix && issue.meta && !fixed.has(issue.id)) await fixOne(issue)
    }
  }

  const remainingIssues = report?.issues.filter(i => !fixed.has(i.id)) ?? []
  const errors_ = remainingIssues.filter(i => i.severity === 'error')
  const warnings = remainingIssues.filter(i => i.severity === 'warning')
  const allFixed = report && remainingIssues.length === 0

  const issueTypeLabel: Record<ConsistencyIssue['type'], string> = {
    wrong_location:       t('issue_wrong_location'),
    missing_file:         t('issue_missing_file'),
    orphan_file:          t('issue_orphan_file'),
    missing_image:        t('issue_missing_image'),
    orphan_image:         t('issue_orphan_image'),
    multiple_active_maps: t('issue_multiple_active_maps'),
  }

  return (
    <div className="max-w-3xl space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-zinc-500">
            {t('consistency_desc')}
          </p>
          {report && (
            <p className="text-[11px] text-zinc-600 mt-0.5">
              {t('last_scan')} {new Date(report.scannedAt).toLocaleString()}
            </p>
          )}
        </div>
        <button onClick={scan} disabled={loading} className="btn-accent gap-2">
          <ScanSearch size={14} />
          {loading ? t('scan_running') : t('launch_scan')}
        </button>
      </div>

      {errors._scan && (
        <div className="card p-4 border border-red-500/30 bg-red-500/5">
          <p className="text-sm text-red-400">{errors._scan}</p>
        </div>
      )}

      {/* Summary */}
      {report && (
        <div className="grid grid-cols-3 gap-3">
          <div className="stat-card">
            <p className="text-xs text-zinc-500">{t('total_issues')}</p>
            <p className="text-2xl font-bold tabular-nums mt-1">{remainingIssues.length}</p>
            <p className="text-[11px] text-zinc-600">{t('remaining_issues')}</p>
          </div>
          <div className={`stat-card ${errors_.length > 0 ? 'border-red-500/30' : ''}`}>
            <p className="text-xs text-zinc-500 flex items-center gap-1"><AlertCircle size={11} className="text-red-400" /> {t('errors_label')}</p>
            <p className="text-2xl font-bold tabular-nums mt-1 text-red-400">{errors_.length}</p>
            <p className="text-[11px] text-zinc-600">{t('to_fix')}</p>
          </div>
          <div className={`stat-card ${warnings.length > 0 ? 'border-yellow-500/30' : ''}`}>
            <p className="text-xs text-zinc-500 flex items-center gap-1"><AlertTriangle size={11} className="text-yellow-400" /> {t('warnings_label')}</p>
            <p className="text-2xl font-bold tabular-nums mt-1 text-yellow-400">{warnings.length}</p>
            <p className="text-[11px] text-zinc-600">{t('optional_label')}</p>
          </div>
        </div>
      )}

      {/* All OK */}
      {allFixed && (
        <div className="card p-6 flex flex-col items-center gap-2 text-center">
          <CheckCircle2 size={32} className="text-green-400" />
          <p className="text-sm font-semibold text-green-400">{t('all_ok')}</p>
          <p className="text-xs text-zinc-500">{t('all_ok_desc')}</p>
        </div>
      )}

      {/* Errors block */}
      {errors_.length > 0 && (
        <div className="card overflow-hidden">
          <div className="p-3 border-b border-surface-border flex items-center justify-between">
            <span className="text-xs font-semibold text-red-400 uppercase tracking-wider flex items-center gap-1.5">
              <AlertCircle size={13} /> {t('errors_label')} ({errors_.length})
            </span>
            <button onClick={() => fixAll(errors_)} className="text-xs text-accent hover:underline flex items-center gap-1">
              <Wrench size={11} /> {t('fix_all')}
            </button>
          </div>
          <div className="divide-y divide-surface-border">
            {errors_.map(issue => (
              <IssueRow key={issue.id} issue={issue} issueTypeLabel={issueTypeLabel}
                fixing={fixing.has(issue.id)} fixError={errors[issue.id]}
                onFix={() => fixOne(issue)} />
            ))}
          </div>
        </div>
      )}

      {/* Warnings block */}
      {warnings.length > 0 && (
        <div className="card overflow-hidden">
          <div className="p-3 border-b border-surface-border flex items-center justify-between">
            <span className="text-xs font-semibold text-yellow-400 uppercase tracking-wider flex items-center gap-1.5">
              <AlertTriangle size={13} /> {t('warnings_label')} ({warnings.length})
            </span>
            <button onClick={() => fixAll(warnings)} className="text-xs text-accent hover:underline flex items-center gap-1">
              <Wrench size={11} /> {t('fix_all')}
            </button>
          </div>
          <div className="divide-y divide-surface-border">
            {warnings.map(issue => (
              <IssueRow key={issue.id} issue={issue} issueTypeLabel={issueTypeLabel}
                fixing={fixing.has(issue.id)} fixError={errors[issue.id]}
                onFix={() => fixOne(issue)} />
            ))}
          </div>
        </div>
      )}

      {!report && !loading && !errors._scan && (
        <div className="card p-10 text-center text-zinc-700 text-sm">
          <ScanSearch size={28} className="mx-auto mb-3 opacity-40" />
          {t('scan_instruction')}
        </div>
      )}
    </div>
  )
}

function IssueRow({ issue, issueTypeLabel, fixing, fixError, onFix }: {
  issue: ConsistencyIssue
  issueTypeLabel: Record<ConsistencyIssue['type'], string>
  fixing: boolean
  fixError?: string
  onFix: () => void
}) {
  const { t } = useI18n()
  return (
    <div className="p-3 flex items-start gap-3">
      <div className={`mt-0.5 shrink-0 ${issue.severity === 'error' ? 'text-red-400' : 'text-yellow-400'}`}>
        {issue.severity === 'error' ? <AlertCircle size={14} /> : <AlertTriangle size={14} />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-md ${
            issue.severity === 'error'
              ? 'bg-red-500/15 text-red-400'
              : 'bg-yellow-500/15 text-yellow-400'
          }`}>
            {issueTypeLabel[issue.type]}
          </span>
        </div>
        <p className="text-xs text-zinc-300 mt-1">{issue.description}</p>
        {fixError && <p className="text-[11px] text-red-400 mt-0.5">{fixError}</p>}
      </div>
      {issue.fix && (
        <button onClick={onFix} disabled={fixing}
          className="shrink-0 flex items-center gap-1 text-xs text-accent hover:underline disabled:opacity-40">
          <Wrench size={11} />
          {fixing ? t('fixing') : t('fix')}
        </button>
      )}
    </div>
  )
}

// ─── Scan & Import ───────────────────────────────────────────────────────────

function SectionScanImport({ instanceId, onRefresh }: { instanceId: string; onRefresh: () => void }) {
  const { t } = useI18n()
  const [scanning, setScanning] = useState(false)
  const [report, setReport] = useState<ScanImportReport | null>(null)
  const [error, setError] = useState('')

  const runScan = async () => {
    setScanning(true)
    setError('')
    setReport(null)
    try {
      const result = await api.scanImport(instanceId)
      setReport(result)
      if (result.imported > 0) onRefresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('error'))
    } finally {
      setScanning(false)
    }
  }

  const statusColor = (status: 'imported' | 'skipped' | 'error') => {
    if (status === 'imported') return 'text-green-400'
    if (status === 'error')    return 'text-red-400'
    return 'text-zinc-500'
  }

  const typeLabel = (type?: string) => {
    if (type === 'vehicle') return t('vehicle')
    if (type === 'map')     return t('map_label')
    if (type === 'mod')     return t('mod')
    return '—'
  }

  return (
    <div className="max-w-3xl space-y-5">
      {/* Header */}
      <div className="card p-5 space-y-3">
        <div className="flex items-start gap-3">
          <FolderInput size={20} className="text-accent mt-0.5 shrink-0" />
          <div>
            <h2 className="font-semibold text-sm">{t('import_title')}</h2>
            <p className="text-xs text-zinc-500 mt-1">{t('import_desc')}</p>
          </div>
        </div>
        <button
          onClick={runScan}
          disabled={scanning}
          className="btn-accent"
        >
          {scanning ? (
            <><RotateCcw size={14} className="animate-spin" />{t('import_scanning')}</>
          ) : (
            <><FolderInput size={14} />{t('import_run')}</>
          )}
        </button>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>

      {/* Summary */}
      {report && (
        <>
          <div className="grid grid-cols-4 gap-3">
            {[
              { label: t('import_total'),    value: report.total,    color: 'text-zinc-300' },
              { label: t('import_imported'), value: report.imported, color: 'text-green-400' },
              { label: t('import_skipped'),  value: report.skipped,  color: 'text-zinc-500' },
              { label: t('import_errors'),   value: report.errors,   color: 'text-red-400'  },
            ].map(({ label, value, color }) => (
              <div key={label} className="card p-4 text-center">
                <p className={`text-2xl font-bold ${color}`}>{value}</p>
                <p className="text-[11px] text-zinc-500 mt-1">{label}</p>
              </div>
            ))}
          </div>

          {/* Results table */}
          {report.results.length > 0 && (
            <div className="card overflow-hidden">
              <div className="p-3 border-b border-surface-border">
                <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">{t('import_results')}</p>
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-surface-border text-zinc-500">
                    <th className="text-left p-3 font-medium">{t('import_col_file')}</th>
                    <th className="text-left p-3 font-medium">{t('import_col_name')}</th>
                    <th className="text-left p-3 font-medium">{t('mod_type')}</th>
                    <th className="text-left p-3 font-medium">{t('import_col_image')}</th>
                    <th className="text-left p-3 font-medium">{t('import_col_status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.results.map((r, idx) => (
                    <tr key={idx} className="border-b border-surface-border/50 last:border-0">
                      <td className="p-3 font-mono text-zinc-400 max-w-[180px] truncate">{r.filename}</td>
                      <td className="p-3 text-zinc-300">{r.name ?? '—'}</td>
                      <td className="p-3 text-zinc-500">{typeLabel(r.type)}</td>
                      <td className="p-3">
                        {r.hasImage
                          ? <CheckCircle2 size={13} className="text-green-400" />
                          : <span className="text-zinc-600">—</span>
                        }
                      </td>
                      <td className={`p-3 font-medium ${statusColor(r.status)}`}>
                        {t(`import_status_${r.status}`)}
                        {r.error && <span className="ml-1 text-red-400/70 font-normal">({r.error})</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── Admin ────────────────────────────────────────────────────────────────────

function SectionAdmin() {
  const { t } = useI18n()
  const [requests, setRequests] = useState<any[]>([])
  const [users, setUsers] = useState<any[]>([])
  const [reviewing, setReviewing] = useState<any>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  const refresh = () => {
    api.requests().then(setRequests).catch(() => {})
    api.adminUsers().then(setUsers).catch(() => {})
  }
  useEffect(refresh, [])

  const review = async (action: 'approve'|'reject') => {
    if (!reviewing) return; setError('')
    try { await api.reviewRequest(reviewing.id, action, action === 'approve' ? password : undefined); setReviewing(null); setPassword(''); refresh() }
    catch (err: unknown) { setError(err instanceof Error ? err.message : 'Erreur') }
  }

  const pending = requests.filter(r => r.status === 'pending')

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      {/* Requests */}
      <div className="card overflow-hidden">
        <div className="p-3 border-b border-surface-border">
          <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">{t('account_requests')}</p>
        </div>
        <div className="divide-y divide-surface-border">
          {pending.length === 0 && <p className="p-6 text-center text-xs text-zinc-700">{t('no_request')}</p>}
          {pending.map(r => (
            <div key={r.id} className="flex items-center gap-3 p-3">
              <Avatar name={r.beammp_username} size={8} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{r.beammp_username}</p>
                <p className="text-[10px] text-zinc-600">{r.connection_count ?? 0} {t('connections')} · {new Date(r.requested_at).toLocaleDateString()}</p>
              </div>
              <button onClick={() => { setReviewing(r); setError('') }} className="btn-accent text-xs py-1">{t('process')}</button>
            </div>
          ))}
        </div>
      </div>

      {/* Users */}
      <div className="card overflow-hidden">
        <div className="p-3 border-b border-surface-border">
          <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">{t('users')}</p>
        </div>
        <div className="divide-y divide-surface-border">
          {users.map(u => (
            <div key={u.id} className="flex items-center gap-3 p-3">
              <Avatar name={u.username} size={7} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{u.username}</p>
              </div>
              <select value={u.role}
                onChange={e => api.updateUserRole(u.id, e.target.value).then(refresh).catch(() => {})}
                className="text-[11px] bg-surface border border-surface-border rounded-md px-2 py-1 text-zinc-300">
                <option value="superadmin">superadmin</option>
                <option value="admin">admin</option>
                <option value="moderator">moderator</option>
              </select>
            </div>
          ))}
        </div>
      </div>

      {reviewing && (
        <Modal title={`${t('request_from')} ${reviewing.beammp_username}`} onClose={() => { setReviewing(null); setPassword('') }}>
          <div className="space-y-4">
            <div className="text-xs text-zinc-500 space-y-1">
              <p>{t('connections_label')} <strong className="text-zinc-300">{reviewing.connection_count ?? 0}</strong></p>
              {reviewing.last_seen && <p>{t('last_seen_label')} {new Date(reviewing.last_seen).toLocaleDateString()}</p>}
            </div>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <div className="space-y-1">
              <label className="text-xs text-zinc-400">{t('initial_password')}</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder={t('initial_password_min')} className="input" />
            </div>
            <div className="flex gap-2">
              <button onClick={() => review('approve')} disabled={!password || password.length < 8} className="btn-accent flex-1 justify-center">{t('approve')}</button>
              <button onClick={() => review('reject')} className="btn-danger flex-1 justify-center">{t('reject')}</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

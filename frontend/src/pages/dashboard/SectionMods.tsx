import { useMemo, useRef, useState } from 'react'
import { Car, Package, Search, Upload, X } from 'lucide-react'
import { api, type Mod } from '../../lib/api'
import { useI18n } from '../../context/I18nContext'
import { getSortOptions, sortMods, type SortKey } from '../../lib/sortMods'
import { useModUpload } from '../../hooks/useModUpload'
import { Modal } from '../../components/ui/Modal'
import { ErrorBanner } from '../../components/ui/ErrorBanner'
import { ModCard } from '../../components/mods/ModCard'

export function SectionMods({ instanceId, mods, vehicles, onRefresh, loading, onNeedsRestart }: {
  instanceId: string; mods: Mod[]; vehicles: Mod[]; onRefresh: () => void; loading: boolean; onNeedsRestart: () => void
}) {
  const { t } = useI18n()
  const SORT_OPTIONS = getSortOptions(t)
  const [search, setSearch]        = useState('')
  const [activeFilter, setActive]  = useState<'all'|'active'|'inactive'>('all')
  const [sort, setSort]            = useState<SortKey>('name-asc')
  const [showUpload, setShowUpload] = useState(false)
  const [toggleError, setToggleError] = useState('')

  const { uploading, error: upError, setError: setUpError, upload } = useModUpload(instanceId, () => {
    setShowUpload(false)
    onRefresh()
  })

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
    e.preventDefault()
    await upload(new FormData(e.currentTarget))
  }

  return (
    <div className="space-y-4">
      {toggleError && <ErrorBanner message={toggleError} onDismiss={() => setToggleError('')} />}
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
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-blue-500/30 text-blue-700 dark:text-blue-400 hover:bg-blue-500/10 transition-colors">
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
              <Car size={14} className="text-blue-700 dark:text-blue-400" />
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
            <div className="space-y-1"><label htmlFor="mod-name" className="text-xs text-zinc-400">{t('mod_name')}</label><input id="mod-name" name="name" required className="input" /></div>
            <div className="space-y-1"><label htmlFor="mod-type" className="text-xs text-zinc-400">{t('mod_type')}</label>
              <select id="mod-type" name="type" required className="input">
                <option value="mod">Mod</option><option value="vehicle">{t('vehicle')}</option>
              </select>
            </div>
            <div className="space-y-1"><label htmlFor="mod-description" className="text-xs text-zinc-400">{t('description')}</label><input id="mod-description" name="description" className="input" /></div>
            <div className="space-y-1"><label htmlFor="mod-file" className="text-xs text-zinc-400">{t('mod_file')}</label><input id="mod-file" name="file" type="file" accept=".zip,.pak" required className="input py-1.5 text-xs" /></div>
            <button type="submit" disabled={uploading} className="btn-accent w-full justify-center">{uploading ? t('uploading_progress') : t('upload')}</button>
          </form>
        </Modal>
      )}
    </div>
  )
}

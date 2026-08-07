import { useMemo, useState } from 'react'
import { Map, Search, Upload } from 'lucide-react'
import { api, type Mod } from '../../lib/api'
import { useI18n } from '../../context/I18nContext'
import { getSortOptions, sortMods, type SortKey } from '../../lib/sortMods'
import { useModUpload } from '../../hooks/useModUpload'
import { Modal } from '../../components/ui/Modal'
import { ErrorBanner } from '../../components/ui/ErrorBanner'
import { MapCard } from '../../components/mods/MapCard'

export function SectionMaps({ instanceId, maps, onRefresh, loading, onNeedsRestart }: { instanceId: string; maps: Mod[]; onRefresh: () => void; loading: boolean; onNeedsRestart: () => void }) {
  const { t } = useI18n()
  const SORT_OPTIONS = getSortOptions(t)
  const [search, setSearch] = useState('')
  const [sort, setSort]     = useState<SortKey>('name-asc')
  const [activating, setActivating] = useState<number | null>(null)
  const [activateError, setActivateError] = useState('')
  const [showUpload, setShowUpload] = useState(false)

  const { uploading, error: upError, upload } = useModUpload(instanceId, () => {
    setShowUpload(false)
    onRefresh()
  })

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
    e.preventDefault()
    const fd = new FormData(e.currentTarget); fd.set('type', 'map')
    await upload(fd)
  }

  return (
    <div className="space-y-4">
      {activateError && <ErrorBanner message={activateError} onDismiss={() => setActivateError('')} />}
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

import { useEffect, useMemo, useState } from 'react'
import { Plus, Pencil, Trash2, Play, X, Search, Car, Package } from 'lucide-react'
import { api, type ConfigPreset, type Mod } from '../../lib/api'
import { useI18n } from '../../context/I18nContext'
import { Modal } from '../../components/ui/Modal'
import { ErrorBanner } from '../../components/ui/ErrorBanner'
import { ModMetaBadges } from '../../components/mods/ModMetaBadges'

interface SectionPresetsProps {
  instanceId: string
  mods: Mod[]      // type === 'mod'
  vehicles: Mod[]  // type === 'vehicle'
  maps: Mod[]
  onApplied: () => void
  onNeedsRestart: () => void
}

export function SectionPresets({ instanceId, mods, vehicles, maps, onApplied, onNeedsRestart }: SectionPresetsProps) {
  const { t } = useI18n()
  const [presets, setPresets] = useState<ConfigPreset[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<ConfigPreset | 'new' | null>(null)
  const [applyingId, setApplyingId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [resultMsg, setResultMsg] = useState('')

  const items = useMemo(() => [...vehicles, ...mods], [mods, vehicles])
  const itemById = useMemo(() => new Map(items.map(m => [m.id, m])), [items])

  const refresh = () => api.presets(instanceId).then(setPresets).catch(e => setError(e.message)).finally(() => setLoading(false))
  useEffect(() => { setLoading(true); refresh() }, [instanceId])

  const remove = async (id: number) => {
    if (!confirm(t('confirm_delete_preset'))) return
    try { await api.deletePreset(instanceId, id); refresh() }
    catch (e: unknown) { setError(e instanceof Error ? e.message : t('error')) }
  }

  const apply = async (preset: ConfigPreset) => {
    if (!confirm(t('confirm_apply_preset').replace('{name}', preset.name))) return
    setApplyingId(preset.id); setError(''); setResultMsg('')
    try {
      const result = await api.applyPreset(instanceId, preset.id)
      onApplied()
      if (result.needsRestart) onNeedsRestart()
      const parts = [
        t('preset_applied_mods').replace('{n}', String(result.modsActivated)),
        result.modsMissing > 0 ? t('preset_applied_missing').replace('{n}', String(result.modsMissing)) : null,
        result.mapApplied ? t('preset_applied_map').replace('{name}', result.mapApplied) : null,
        result.mapError ? `⚠ ${result.mapError}` : null,
        result.restarted ? t('preset_applied_restarted') : result.restartError ? `⚠ ${result.restartError}` : null,
      ].filter(Boolean)
      setResultMsg(`${preset.name} — ${parts.join(' · ')}`)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('error'))
    } finally {
      setApplyingId(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-zinc-500">{t('presets_intro')}</p>
        <button onClick={() => setEditing('new')} className="btn-accent text-xs py-1.5">
          <Plus size={13} />{t('new_preset')}
        </button>
      </div>

      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}
      {resultMsg && <ErrorBanner message={resultMsg} onDismiss={() => setResultMsg('')} />}

      {loading ? <p className="text-sm text-zinc-600">{t('loading')}</p> : (
        <div className="card divide-y divide-surface-border">
          {presets.length === 0 && <p className="p-8 text-center text-zinc-700 text-sm">{t('no_preset')}</p>}
          {presets.map(p => {
            const knownCount = p.mod_ids.filter(id => itemById.has(id)).length
            const missingCount = p.mod_ids.length - knownCount
            const mapName = p.map_id ? maps.find(m => m.map_id === p.map_id)?.name ?? p.map_id : null
            return (
              <div key={p.id} className="flex items-center gap-3 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{p.name}</p>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    {t('preset_summary_items').replace('{n}', String(knownCount))}
                    {missingCount > 0 && ` · ${t('preset_summary_missing').replace('{n}', String(missingCount))}`}
                    {mapName && ` · ${mapName}`}
                  </p>
                </div>
                <button onClick={() => setEditing(p)}
                  className="p-1.5 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-white/5 rounded-lg transition-colors"
                  title={t('edit')} aria-label={t('edit')}>
                  <Pencil size={13} />
                </button>
                <button onClick={() => remove(p.id)}
                  className="p-1.5 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                  title={t('delete')} aria-label={t('delete')}>
                  <Trash2 size={13} />
                </button>
                <button onClick={() => apply(p)} disabled={applyingId === p.id} className="btn-accent text-xs py-1 disabled:opacity-40">
                  <Play size={12} />{applyingId === p.id ? t('applying') : t('apply')}
                </button>
              </div>
            )
          })}
        </div>
      )}

      {editing && (
        <PresetEditor
          instanceId={instanceId}
          preset={editing === 'new' ? null : editing}
          items={items}
          maps={maps}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh() }}
        />
      )}
    </div>
  )
}

function PresetEditor({ instanceId, preset, items, maps, onClose, onSaved }: {
  instanceId: string
  preset: ConfigPreset | null
  items: Mod[]
  maps: Mod[]
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useI18n()
  const [name, setName] = useState(preset?.name ?? '')
  const [selected, setSelected] = useState<Set<number>>(new Set(preset?.mod_ids ?? []))
  const [mapId, setMapId] = useState<string>(preset?.map_id ?? '')
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? items.filter(m => m.name.toLowerCase().includes(q)) : items
  }, [items, search])

  const toggle = (id: number) => setSelected(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  const useCurrentActive = () => setSelected(new Set(items.filter(m => m.active).map(m => m.id)))

  const save = async () => {
    if (!name.trim()) return
    setSaving(true); setError('')
    try {
      const modIds = [...selected]
      if (preset) await api.updatePreset(instanceId, preset.id, name, modIds, mapId || null)
      else await api.createPreset(instanceId, name, modIds, mapId || null)
      onSaved()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={preset ? `${t('edit_preset')} — ${preset.name}` : t('new_preset')} onClose={onClose}>
      <div className="space-y-3">
        <div className="space-y-1">
          <label htmlFor="preset-name" className="text-xs text-zinc-400">{t('preset_name_label')}</label>
          <input id="preset-name" value={name} onChange={e => setName(e.target.value)} className="input" />
        </div>

        <div className="space-y-1">
          <label htmlFor="preset-map" className="text-xs text-zinc-400">{t('preset_map_label')}</label>
          <select id="preset-map" value={mapId} onChange={e => setMapId(e.target.value)} className="input">
            <option value="">{t('preset_no_map')}</option>
            {maps.filter(m => m.map_id).map(m => (
              <option key={m.id} value={m.map_id!}>{m.name}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center justify-between">
          <label className="text-xs text-zinc-400">{t('preset_items_label')} ({selected.size})</label>
          <button type="button" onClick={useCurrentActive} className="btn-ghost text-[11px] py-1">{t('use_current_active')}</button>
        </div>

        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('search')} aria-label={t('search')}
            className="input pl-8 text-xs py-1.5" />
        </div>

        <div className="border border-surface-border rounded-lg max-h-80 overflow-y-auto divide-y divide-surface-border">
          {filtered.length === 0 && <p className="p-4 text-center text-xs text-zinc-700">{t('no_result')}</p>}
          {filtered.map(m => (
            <label key={m.id} className="flex items-center gap-2.5 px-3 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-white/5 cursor-pointer">
              <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggle(m.id)} className="shrink-0" />
              {m.image ? (
                <img src={`/images/${m.image}`} alt="" loading="lazy"
                  className="w-9 h-7 object-cover rounded shrink-0 bg-zinc-100 dark:bg-zinc-800/60" />
              ) : (
                <div className="w-9 h-7 rounded shrink-0 bg-surface flex items-center justify-center">
                  {m.type === 'vehicle'
                    ? <Car size={13} className="text-zinc-600" />
                    : <Package size={13} className="text-zinc-600" />}
                </div>
              )}
              <span className="truncate flex-1 min-w-0">{m.name}</span>
              <ModMetaBadges metadata={m.metadata} variant="compact" />
            </label>
          ))}
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex gap-2">
          <button onClick={onClose} className="btn-ghost flex-1 justify-center">
            <X size={13} />{t('cancel')}
          </button>
          <button onClick={save} disabled={saving || !name.trim()} className="btn-accent flex-1 justify-center disabled:opacity-40">
            {saving ? '…' : t('save')}
          </button>
        </div>
      </div>
    </Modal>
  )
}

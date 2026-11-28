import { useCallback, useEffect, useState } from 'react'
import { Library, Plus, Trash2 } from 'lucide-react'
import { api, type LibraryItem } from '../../lib/api'
import { useI18n } from '../../context/I18nContext'

// Bibliothèque commune aux serveurs : chaque zip y est une fois, et chaque serveur qui l'utilise a un lien dans
// son Client/. Ajouter à ce serveur ne recopie rien. Un zip que plus aucun serveur n'utilise peut être supprimé.
export function SectionLibrary({ instanceId, onRefresh }: { instanceId: string; onRefresh: () => void }) {
  const { t } = useI18n()
  const [items, setItems] = useState<LibraryItem[] | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(() => api.library().then(r => { setEnabled(r.enabled); setItems(r.items) })
    .catch(e => setError(e instanceof Error ? e.message : t('error'))), [t])
  useEffect(() => { load() }, [load, instanceId])

  if (!enabled) return null

  const run = async (filename: string, action: () => Promise<unknown>) => {
    setBusy(filename); setError('')
    try {
      await action()
      await load()
      onRefresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('error'))
    } finally {
      setBusy('')
    }
  }

  const size = (b: number) => b > 1e6 ? `${(b / 1e6).toFixed(1)} Mo` : `${Math.round(b / 1024)} Ko`
  const typeLabel = (ty: LibraryItem['type']) => ty === 'map' ? t('library_type_map')
    : ty === 'vehicle' ? t('library_type_vehicle') : t('library_type_mod')

  return (
    <div className="card overflow-hidden mt-5">
      <div className="p-3 border-b border-surface-border">
        <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">{t('library_title')}</p>
        <p className="text-[11px] text-zinc-500 mt-1">{t('library_hint')}</p>
      </div>
      {error && <p role="alert" className="p-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      <ul className="divide-y divide-surface-border">
        {!items && <li className="p-6 text-center text-xs text-zinc-500">{t('loading')}</li>}
        {items?.length === 0 && <li className="p-6 text-center text-xs text-zinc-500">{t('library_empty')}</li>}
        {items?.map(item => {
          const here = item.servers.some(s => s.id === instanceId)
          return (
            <li key={item.filename} className="flex items-center gap-3 p-3">
              <Library size={16} className="text-zinc-500 shrink-0" aria-hidden />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{item.name}</p>
                <p className="text-[11px] text-zinc-500 truncate">
                  {typeLabel(item.type)} · {item.filename} · {size(item.size)} · {item.servers.length
                    ? `${t('library_used_by')} ${item.servers.map(s => s.name).join(', ')}`
                    : t('library_unused')}
                  {item.archived.length > 0 && ` · ${t('library_archived')} ${item.archived.join(', ')}`}
                </p>
              </div>
              {here
                ? <span className="badge-zinc">{t('library_on_this_server')}</span>
                : <button type="button" className="btn-accent px-2 py-1" disabled={!!busy}
                    onClick={() => run(item.filename, () => api.addFromLibrary(instanceId, item.filename))}>
                    <Plus size={14} aria-hidden /> {t('library_add')}
                  </button>}
              {item.servers.length === 0 && (
                <button type="button" className="btn-danger px-2 py-1" disabled={!!busy}
                  aria-label={`${t('library_delete')} ${item.name}`} title={t('library_delete')}
                  onClick={() => confirm(t(item.archived.length ? 'library_confirm_delete_archived' : 'library_confirm_delete')
                    .replace('{name}', item.name))
                    && run(item.filename, () => api.deleteFromLibrary(item.filename))}>
                  <Trash2 size={14} aria-hidden />
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

import { useState } from 'react'
import { Car, Package, Pencil, Trash2 } from 'lucide-react'
import type { Mod } from '../../lib/api'
import { Toggle } from '../ui/Toggle'
import { useI18n } from '../../context/I18nContext'
import { desc } from '../../lib/desc'
import { DescriptionEditor } from './DescriptionEditor'

export function ModCard({ instanceId, mod, onToggle, onDelete, onRefresh }: {
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
              title={t('edit_description')} aria-label={t('edit_description')}>
              <Pencil size={12} />
            </button>
            <Toggle checked={mod.active} onChange={onToggle} />
            <button onClick={onDelete}
              className="p-1.5 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
              title={t('delete')} aria-label={t('delete')}>
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

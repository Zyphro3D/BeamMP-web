import { useRef, useState } from 'react'
import { Car, Image as ImageIcon, Package, Pencil, Trash2 } from 'lucide-react'
import { api, type Mod } from '../../lib/api'
import { Toggle } from '../ui/Toggle'
import { useI18n } from '../../context/I18nContext'
import { desc } from '../../lib/desc'
import { DescriptionEditor } from './DescriptionEditor'
import { ModMetaBadges } from './ModMetaBadges'

export function ModCard({ instanceId, mod, onToggle, onDelete, onRefresh }: {
  instanceId: string; mod: Mod; onToggle: () => void; onDelete: () => void; onRefresh: () => void
}) {
  const { t, lang } = useI18n()
  const [editingDesc, setEditingDesc] = useState(false)
  const [uploadingImg, setUploadingImg] = useState(false)
  const [imgError, setImgError] = useState('')
  const imageInputRef = useRef<HTMLInputElement>(null)
  const modDesc = desc(mod.description, lang)

  const handleImageChange = async (file: File | undefined) => {
    if (!file) return
    setUploadingImg(true)
    setImgError('')
    try {
      await api.uploadModImage(instanceId, mod.id, file)
      onRefresh()
    } catch (e: unknown) {
      setImgError(e instanceof Error ? e.message : t('error'))
    } finally {
      setUploadingImg(false)
      if (imageInputRef.current) imageInputRef.current.value = ''
    }
  }

  return (
    <>
      <div className={`card overflow-hidden flex flex-col ${!mod.active ? 'opacity-60' : ''}`}>
        {/* Image */}
        {mod.image ? (
          <img src={`/images/${mod.image}`} alt={mod.name} loading="lazy"
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
            {mod.metadata && <div className="mt-1"><ModMetaBadges metadata={mod.metadata} /></div>}
          </div>

          <div className="flex items-center gap-2 mt-auto">
            <span className={mod.active ? 'badge-green' : 'badge-zinc'}>
              {t(mod.active ? 'active' : 'inactive')}
            </span>
            <div className="flex-1" />
            <input ref={imageInputRef} type="file" accept="image/*" className="hidden"
              onChange={e => handleImageChange(e.target.files?.[0])} />
            <button onClick={() => imageInputRef.current?.click()} disabled={uploadingImg}
              className="p-1.5 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-white/5 rounded-lg transition-colors disabled:opacity-50"
              title={t('change_image')} aria-label={t('change_image')}>
              <ImageIcon size={12} className={uploadingImg ? 'animate-spin' : ''} />
            </button>
            <button onClick={() => setEditingDesc(true)}
              className="p-1.5 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-white/5 rounded-lg transition-colors"
              title={t('edit_description')} aria-label={t('edit_description')}>
              <Pencil size={12} />
            </button>
            <Toggle checked={mod.active} onChange={onToggle} label={mod.name} />
            <button onClick={onDelete}
              className="p-1.5 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
              title={t('delete')} aria-label={t('delete')}>
              <Trash2 size={13} />
            </button>
          </div>
          {imgError && <p className="text-xs text-red-400">{imgError}</p>}
        </div>
      </div>
      {editingDesc && (
        <DescriptionEditor instanceId={instanceId} mod={mod} onClose={() => setEditingDesc(false)} onSaved={onRefresh} />
      )}
    </>
  )
}

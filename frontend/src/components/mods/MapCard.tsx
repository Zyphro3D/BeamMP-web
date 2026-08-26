import { useRef, useState } from 'react'
import { Image as ImageIcon, Map, Pencil, Shield, Trash2 } from 'lucide-react'
import { api, type Mod } from '../../lib/api'
import { useI18n } from '../../context/I18nContext'
import { desc } from '../../lib/desc'
import { DescriptionEditor } from './DescriptionEditor'

export function MapCard({ instanceId, map, activating, onActivate, onDelete, onToggleOfficial, onRefresh }: {
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
  const [uploadingImg, setUploadingImg] = useState(false)
  const [imgError, setImgError] = useState('')
  const imageInputRef = useRef<HTMLInputElement>(null)
  const mapDesc = desc(map.description, lang)

  const handleImageChange = async (file: File | undefined) => {
    if (!file) return
    setUploadingImg(true)
    setImgError('')
    try {
      await api.uploadModImage(instanceId, map.id, file)
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
      <div className={`card overflow-hidden relative ${map.active ? 'ring-1 ring-accent' : ''} ${map.is_official ? 'ring-1 ring-blue-500/40' : ''}`}>
        {/* Badges top-right */}
        <div className="absolute top-2 right-2 z-10 flex flex-col items-end gap-1">
          {map.active && <span className="badge-green text-[10px]">● {t('active')}</span>}
          {map.is_official && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-blue-500/20 text-blue-700 dark:text-blue-400 text-[10px] font-medium">
              <Shield size={9} />{t('official')}
            </span>
          )}
        </div>

        {/* Image */}
        {map.image ? (
          <img src={`/images/${map.image}`} alt={map.name} loading="lazy" className="w-full h-36 object-contain bg-zinc-100 dark:bg-zinc-800/60" />
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
            {/* Change image */}
            <input ref={imageInputRef} type="file" accept="image/*" className="hidden"
              onChange={e => handleImageChange(e.target.files?.[0])} />
            <button onClick={() => imageInputRef.current?.click()} disabled={uploadingImg}
              className="p-1.5 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-white/5 rounded-lg transition-colors disabled:opacity-50"
              title={t('change_image')} aria-label={t('change_image')}>
              <ImageIcon size={12} className={uploadingImg ? 'animate-spin' : ''} />
            </button>
            {/* Edit description */}
            <button onClick={() => setEditingDesc(true)}
              className="p-1.5 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-white/5 rounded-lg transition-colors"
              title={t('edit_description')} aria-label={t('edit_description')}>
              <Pencil size={12} />
            </button>
            {/* Toggle official */}
            <button onClick={() => onToggleOfficial(map)}
              className={`p-1.5 rounded-lg transition-colors ${map.is_official ? 'text-blue-700 dark:text-blue-400 bg-blue-500/10 hover:bg-blue-500/20' : 'text-zinc-500 hover:text-blue-700 dark:hover:text-blue-400 hover:bg-blue-500/10'}`}
              title={map.is_official ? t('unmark_official') : t('mark_official')} aria-label={map.is_official ? t('unmark_official') : t('mark_official')}>
              <Shield size={12} />
            </button>
            <div className="flex-1" />
            {/* Delete (hidden for official) */}
            {!map.is_official && (
              <button onClick={() => onDelete(map)}
                className="p-1.5 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                title={t('delete')} aria-label={t('delete')}>
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
          {imgError && <p className="text-xs text-red-400">{imgError}</p>}
        </div>
      </div>
      {editingDesc && (
        <DescriptionEditor instanceId={instanceId} mod={map} onClose={() => setEditingDesc(false)} onSaved={onRefresh} />
      )}
    </>
  )
}

import { useRef, useState } from 'react'
import { Image as ImageIcon, Package, Trash2, Upload, X } from 'lucide-react'
import { api } from '../../lib/api'
import { useI18n } from '../../context/I18nContext'

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

// File d'upload par lot avec statut par item — reste indépendante de
// useModUpload (voir ce hook) car chaque item porte son propre état
// concurrent, pas un flag d'upload partagé.
export function SectionUpload({ instanceId, onRefresh }: { instanceId: string; onRefresh: () => void }) {
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
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click() } }}
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
                        <button onClick={() => setImage(idx, null)} className="text-xs text-zinc-500 hover:text-zinc-300" title={t('cancel')} aria-label={t('cancel')}>
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

import { useState } from 'react'
import { api, type Mod } from '../../lib/api'
import { Modal } from '../ui/Modal'
import { useI18n } from '../../context/I18nContext'

export function DescriptionEditor({ instanceId, mod, onClose, onSaved }: { instanceId: string; mod: Mod; onClose: () => void; onSaved: () => void }) {
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

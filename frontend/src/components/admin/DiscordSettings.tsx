import { useEffect, useState } from 'react'
import { Send } from 'lucide-react'
import { api, type DiscordChannel, type DiscordSettings } from '../../lib/api'
import { useI18n } from '../../context/I18nContext'

const CHANNELS: DiscordChannel[] = ['url', 'restart', 'players', 'mods']

// Webhooks de ce serveur (un par salon) et textes des messages (communs à tous
// les serveurs). Un champ vide reprend le .env ou le texte par défaut.
export function DiscordSettingsCard({ instanceId }: { instanceId: string }) {
  const { t } = useI18n()
  const [s, setS] = useState<DiscordSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [tests, setTests] = useState<Partial<Record<DiscordChannel, string>>>({})

  useEffect(() => { api.discordSettings(instanceId).then(setS).catch(e => setError(e.message)) }, [instanceId])

  if (!s) return error ? <div className="card p-5"><p className="text-xs text-red-400">{error}</p></div> : null

  const setHook = (c: DiscordChannel, v: string) => setS({ ...s, webhooks: { ...s.webhooks, [c]: v } })
  const setText = (e: string, v: string) => setS({ ...s, templates: { ...s.templates, [e]: v } })

  const save = async () => {
    setSaving(true); setSaved(false); setError('')
    try {
      setS(await api.saveDiscordSettings(instanceId, { webhooks: s.webhooks, templates: s.templates }))
      setSaved(true); setTimeout(() => setSaved(false), 2000)
    } catch (e: unknown) { setError(e instanceof Error ? e.message : t('error')) }
    finally { setSaving(false) }
  }

  const test = async (c: DiscordChannel) => {
    setTests(x => ({ ...x, [c]: '…' }))
    try {
      const r = await api.testDiscordWebhook(instanceId, s.webhooks[c].trim())
      setTests(x => ({ ...x, [c]: r.ok ? `✓ ${t('discord_test_ok')}` : r.error }))
    } catch (e: unknown) { setTests(x => ({ ...x, [c]: e instanceof Error ? e.message : t('error') })) }
  }

  const events = Object.keys(s.defaults)

  return (
    <div className="card p-5 space-y-5 lg:col-span-2">
      <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">◆ {t('discord_settings')}</p>

      <div className="space-y-3">
        <p className="text-xs text-zinc-500">{t('discord_webhooks_hint')}</p>
        {CHANNELS.map(c => (
          <div key={c} className="space-y-1.5">
            <label htmlFor={`discord-hook-${c}`} className="inline-block text-xs text-zinc-400">{t(`discord_webhook_${c}`)}</label>
            <div className="flex gap-2">
              <input id={`discord-hook-${c}`} type="url" className="input font-mono text-xs flex-1 min-w-0"
                     value={s.webhooks[c]} onChange={e => setHook(c, e.target.value)}
                     placeholder={s.envFallback[c] ? t('discord_from_env') : 'https://discord.com/api/webhooks/…'} />
              <button type="button" onClick={() => test(c)} disabled={!s.webhooks[c].trim()}
                      className="btn-ghost text-xs shrink-0 disabled:opacity-40">
                <Send size={12} />{t('discord_test')}
              </button>
            </div>
            {tests[c] && <p className={`text-xs ${tests[c]!.startsWith('✓') ? 'text-green-600 dark:text-green-500' : 'text-zinc-500'}`}>{tests[c]}</p>}
          </div>
        ))}
      </div>

      <div className="space-y-3">
        <p className="text-xs font-semibold text-zinc-500">{t('discord_texts')}</p>
        <p className="text-xs text-zinc-500">{t('discord_texts_hint')}</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {events.map(e => (
            <div key={e} className="space-y-1.5 min-w-0">
              <label htmlFor={`discord-msg-${e}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-zinc-400">
                <span>{t(`discord_ev_${e}`)}</span>
                <span className="font-mono text-[10px] text-zinc-600">{s.defaults[e].vars.map(v => `{${v}}`).join(' ')}</span>
              </label>
              <input id={`discord-msg-${e}`} type="text" className="input text-xs" maxLength={300}
                     value={s.templates[e] ?? ''} onChange={ev => setText(e, ev.target.value)}
                     placeholder={s.defaults[e].text} />
            </div>
          ))}
        </div>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
      <button type="button" onClick={save} disabled={saving} className="btn-accent w-full justify-center">
        {saving ? t('saving') : saved ? t('saved') : t('discord_save')}
      </button>
    </div>
  )
}

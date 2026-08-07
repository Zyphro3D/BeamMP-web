import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, RotateCcw } from 'lucide-react'
import { api } from '../../lib/api'
import { useI18n } from '../../context/I18nContext'
import { Toggle } from '../../components/ui/Toggle'
import { BeamMPTextEditor } from '../../components/ui/BeamMPTextEditor'

const CONFIG_KEY_DEFS = [
  { key: 'MaxPlayers', labelKey: 'max_players_label', type: 'number' },
  { key: 'MaxCars',    labelKey: 'max_cars_label',    type: 'number' },
  { key: 'Private',    labelKey: 'private_label',     type: 'toggle' },
  { key: 'LogChat',    labelKey: 'log_chat_label',    type: 'toggle' },
  { key: 'Tags',       labelKey: 'tags_label',        type: 'text' },
  { key: 'Debug',      labelKey: 'debug_label',       type: 'toggle' },
]

export function SectionConfig({ instanceId }: { instanceId: string }) {
  const { t } = useI18n()
  const [cfg, setCfg]     = useState<Record<string,string>>({})
  const [name, setName]   = useState('')
  const [desc2, setDesc2] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [saved, setSaved]     = useState(false)
  const [error, setError]     = useState('')
  const [logs, setLogs]       = useState<string[]>([])
  const [restarting, setRestarting] = useState(false)
  const logsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.getConfig(instanceId).then(c => {
      setCfg(c)
      setName(c.Name ?? '')
      setDesc2(c.Description ?? '')
    }).catch(e => setError(e.message)).finally(() => setLoading(false))
  }, [instanceId])

  const refreshLogs = useCallback(() => api.logs(instanceId, 80).then(r => setLogs(r.lines)).catch(() => {}), [instanceId])
  useEffect(() => { refreshLogs(); const t = setInterval(refreshLogs, 5000); return () => clearInterval(t) }, [refreshLogs])
  useEffect(() => { logsRef.current?.scrollTo(0, logsRef.current.scrollHeight) }, [logs])

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setSaving(true); setSaved(false)
    const updates: Record<string,string> = { Name: name, Description: desc2 }
    for (const {key, type} of CONFIG_KEY_DEFS) {
      if (type === 'toggle') updates[key] = cfg[key] ?? 'false'
      else {
        const fd = new FormData(e.currentTarget)
        updates[key] = fd.get(key) as string
      }
    }
    try { await api.updateConfig(instanceId, updates); setSaved(true); setTimeout(() => setSaved(false), 2000) }
    catch (err: unknown) { setError(err instanceof Error ? err.message : 'Erreur') }
    finally { setSaving(false) }
  }

  const restart = async () => {
    if (!confirm(t('confirm_restart'))) return
    setRestarting(true)
    await api.restartServer(instanceId).catch(console.error)
    setRestarting(false)
  }

  const copyLogs = () => navigator.clipboard.writeText(logs.join('\n'))

  const logColor = (l: string) =>
    l.includes('ERROR') ? 'text-red-400' :
    l.includes('WARN') ? 'text-yellow-400' :
    l.includes('Connected') ? 'text-green-400' :
    l.includes('Disconnected') ? 'text-orange-400' :
    'text-zinc-400'

  if (loading) return <p className="text-sm text-zinc-600">{t('loading')}</p>

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      {/* Config form */}
      <div className="card p-5 space-y-1">
        <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4">⚙ {t('server_config')}</p>
        {error && <p className="text-xs text-red-400 mb-3">{error}</p>}
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Nom du serveur avec éditeur BeamMP */}
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-400">{t('server_name_label')}</label>
            <BeamMPTextEditor name="Name" value={name} onChange={setName} placeholder={t('server_name_placeholder')} />
          </div>

          {/* Description avec éditeur BeamMP (multiline) */}
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-400">{t('description')}</label>
            <BeamMPTextEditor name="Description" value={desc2} onChange={setDesc2} multiline placeholder={t('description_placeholder')} />
          </div>

          {CONFIG_KEY_DEFS.map(({key, labelKey, type}) => (
            <div key={key} className="space-y-1.5">
              <label htmlFor={`config-${key}`} className="text-xs text-zinc-400">{t(labelKey)}</label>
              {type === 'toggle' ? (
                <div className="flex items-center gap-2">
                  <Toggle
                    checked={cfg[key] === 'true'}
                    onChange={() => setCfg(c => ({ ...c, [key]: c[key] === 'true' ? 'false' : 'true' }))}
                  />
                  <span className="text-xs text-zinc-500">{cfg[key] === 'true' ? t('enabled') : t('disabled')}</span>
                </div>
              ) : (
                <input id={`config-${key}`} name={key} defaultValue={cfg[key] ?? ''} type={type} className="input" />
              )}
            </div>
          ))}
          <button type="submit" disabled={saving} className="btn-accent w-full justify-center mt-2">
            {saving ? t('saving') : saved ? t('saved') : t('save_config')}
          </button>
        </form>
      </div>

      {/* Logs */}
      <div className="card overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-3 border-b border-surface-border shrink-0">
          <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">● {t('server_logs')}</p>
          <button onClick={copyLogs} className="p-1.5 text-zinc-600 hover:text-zinc-300 transition-colors" title={t('copy')} aria-label={t('copy')}><Copy size={13} /></button>
        </div>
        <div ref={logsRef} className="flex-1 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed bg-surface min-h-[300px] max-h-[400px]">
          {logs.length === 0 ? <span className="text-zinc-700">{t('no_log')}</span> :
            logs.map((l, i) => <div key={i} className={logColor(l)}>{l}</div>)}
        </div>
        <div className="p-3 border-t border-surface-border shrink-0">
          <button onClick={restart} disabled={restarting} className="btn-danger w-full justify-center">
            <RotateCcw size={13} />
            {restarting ? t('restarting') : t('restart_server')}
          </button>
        </div>
      </div>
    </div>
  )
}

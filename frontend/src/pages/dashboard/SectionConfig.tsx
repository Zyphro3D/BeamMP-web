import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, RotateCcw, ArrowUpCircle } from 'lucide-react'
import { api, type UpdateCheck } from '../../lib/api'
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

interface SectionConfigProps {
  instanceId: string
  canRestart: boolean
  restarting: boolean
  onRestart: () => void
}

export function SectionConfig({ instanceId, canRestart, restarting, onRestart }: SectionConfigProps) {
  const { t } = useI18n()
  const [cfg, setCfg]     = useState<Record<string,string>>({})
  const [name, setName]   = useState('')
  const [desc2, setDesc2] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [saved, setSaved]     = useState(false)
  const [error, setError]     = useState('')
  const [logs, setLogs]       = useState<string[]>([])
  const logsRef = useRef<HTMLDivElement>(null)
  const logsBottomRef = useRef<HTMLDivElement>(null)
  // Ne recolle en bas que si l'utilisateur y était déjà — sinon chaque poll
  // de 5s (nouvelle ligne de log) lui arracherait la lecture en cours pour
  // le ramener au bas de la liste.
  const pinnedToBottom = useRef(true)
  const handleLogsScroll = () => {
    const el = logsRef.current
    if (!el) return
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck | null>(null)
  const [updating, setUpdating]       = useState(false)
  const [updateError, setUpdateError] = useState('')

  useEffect(() => {
    api.getConfig(instanceId).then(c => {
      setCfg(c)
      setName(c.Name ?? '')
      setDesc2(c.Description ?? '')
    }).catch(e => setError(e.message)).finally(() => setLoading(false))
  }, [instanceId])

  useEffect(() => {
    api.checkServerUpdate(instanceId).then(setUpdateCheck).catch(() => {})
  }, [instanceId])

  const installUpdate = async () => {
    setUpdating(true); setUpdateError('')
    try {
      await api.updateServer(instanceId)
      const check = await api.checkServerUpdate(instanceId)
      setUpdateCheck(check)
    } catch (e: unknown) {
      setUpdateError(e instanceof Error ? e.message : t('error'))
    } finally {
      setUpdating(false)
    }
  }

  const refreshLogs = useCallback(() => api.logs(instanceId, 80).then(r => setLogs(r.lines)).catch(() => {}), [instanceId])
  useEffect(() => { refreshLogs(); const t = setInterval(refreshLogs, 5000); return () => clearInterval(t) }, [refreshLogs])
  useEffect(() => {
    if (pinnedToBottom.current) logsBottomRef.current?.scrollIntoView({ block: 'end' })
  }, [logs])

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
    catch (err: unknown) { setError(err instanceof Error ? err.message : t('error')) }
    finally { setSaving(false) }
  }

  const copyLogs = () => navigator.clipboard.writeText(logs.join('\n'))

  const logColor = (l: string) =>
    l.includes('ERROR') ? 'text-red-600 dark:text-red-400' :
    l.includes('WARN') ? 'text-yellow-600 dark:text-yellow-400' :
    l.includes('Connected') ? 'text-green-600 dark:text-green-400' :
    l.includes('Disconnected') ? 'text-orange-600 dark:text-orange-400' :
    'text-zinc-600 dark:text-zinc-400'

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
            <label htmlFor="config-name" className="text-xs text-zinc-400">{t('server_name_label')}</label>
            <BeamMPTextEditor id="config-name" name="Name" value={name} onChange={setName} placeholder={t('server_name_placeholder')} />
          </div>

          {/* Description avec éditeur BeamMP (multiline) */}
          <div className="space-y-1.5">
            <label htmlFor="config-description" className="text-xs text-zinc-400">{t('description')}</label>
            <BeamMPTextEditor id="config-description" name="Description" value={desc2} onChange={setDesc2} multiline placeholder={t('description_placeholder')} />
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
        <div ref={logsRef} onScroll={handleLogsScroll} className="flex-1 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed bg-surface min-h-[300px] max-h-[400px]">
          {logs.length === 0 ? <span className="text-zinc-700">{t('no_log')}</span> :
            logs.map((l, i) => <div key={i} className={logColor(l)}>{l}</div>)}
          <div ref={logsBottomRef} />
        </div>
        <div className="p-3 border-t border-surface-border shrink-0" title={!canRestart ? t('restart_not_configured') : undefined}>
          <button onClick={onRestart} disabled={restarting || !canRestart} className="btn-danger w-full justify-center disabled:opacity-40 disabled:cursor-not-allowed">
            <RotateCcw size={13} />
            {restarting ? t('restarting') : t('restart_server')}
          </button>
        </div>
        {updateCheck?.enabled && (
          <div className="p-3 border-t border-surface-border shrink-0 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-500">{t('server_update')}</span>
              {updateCheck.currentVersion && (
                <span className="text-zinc-600 font-mono">v{updateCheck.currentVersion}</span>
              )}
            </div>
            {updateCheck.error ? (
              <p className="text-xs text-zinc-600">{updateCheck.error}</p>
            ) : updateCheck.updateAvailable ? (
              <button onClick={installUpdate} disabled={updating} className="btn-accent w-full justify-center disabled:opacity-40">
                <ArrowUpCircle size={13} />
                {updating ? t('updating') : `${t('install_update')} v${updateCheck.latestVersion}`}
              </button>
            ) : (
              <p className="text-xs text-green-600 dark:text-green-500">{t('up_to_date')}</p>
            )}
            {updateError && <p className="text-xs text-red-400">{updateError}</p>}
          </div>
        )}
      </div>
    </div>
  )
}

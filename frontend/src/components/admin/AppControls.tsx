import { useCallback, useEffect, useState } from 'react'
import { ArrowUpCircle, Play, RefreshCw, Square } from 'lucide-react'
import { api, type LocalServerState, type PanelUpdate } from '../../lib/api'
import { useI18n } from '../../context/I18nContext'

// Serveur lancé par le panel lui-même (appli Windows) : état, démarrer, arrêter.
// Ne s'affiche pas quand le serveur est géré ailleurs (systemd + beammp-agent).
export function LocalServerControls({ instanceId }: { instanceId: string }) {
  const { t } = useI18n()
  const [state, setState] = useState<LocalServerState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(() => api.serverState(instanceId).then(setState).catch(() => {}), [instanceId])
  useEffect(() => { refresh(); const id = setInterval(refresh, 5000); return () => clearInterval(id) }, [refresh])

  if (!state?.managed) return null

  const act = async (fn: () => Promise<LocalServerState>) => {
    setBusy(true); setError('')
    try { setState(await fn()) }
    catch (e: unknown) { setError(e instanceof Error ? e.message : t('error')) }
    finally { setBusy(false) }
  }

  return (
    <div className="p-3 border-t border-surface-border shrink-0 space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="text-zinc-500">{t('local_server')}</span>
        <span className={state.running ? 'text-green-600 dark:text-green-500' : 'text-zinc-500'}>
          ● {state.running ? t('local_server_running') : t('local_server_stopped')}
        </span>
      </div>
      <div className="flex gap-2">
        <button onClick={() => act(() => api.serverStart(instanceId))} disabled={busy || state.running || !state.installed}
                className="btn-ghost flex-1 justify-center text-xs disabled:opacity-40">
          <Play size={12} />{t('local_server_start')}
        </button>
        <button onClick={() => act(() => api.serverStop(instanceId))} disabled={busy || !state.running}
                className="btn-ghost flex-1 justify-center text-xs disabled:opacity-40">
          <Square size={12} />{t('local_server_stop')}
        </button>
      </div>
      {(error || state.error) && <p className="text-xs text-red-400">{error || state.error}</p>}
    </div>
  )
}

// Mise à jour du panel lui-même (appli Windows) : vérifier, installer, redémarrer.
export function PanelUpdateCard() {
  const { t, lang } = useI18n()
  const [u, setU] = useState<PanelUpdate | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [restarting, setRestarting] = useState(false)

  useEffect(() => { api.panelUpdate().then(setU).catch(() => {}) }, [])

  // Après l'installation, le panel redémarre : on attend qu'il réponde à nouveau.
  useEffect(() => {
    if (!restarting) return
    const id = setInterval(() => {
      api.info().then(() => window.location.reload()).catch(() => {})
    }, 3000)
    return () => clearInterval(id)
  }, [restarting])

  if (!u?.enabled) return null

  const check = async () => {
    setBusy(true); setError('')
    try { setU(await api.panelUpdateCheck()) } catch (e: unknown) { setError(e instanceof Error ? e.message : t('error')) }
    finally { setBusy(false) }
  }
  const install = async () => {
    setBusy(true); setError('')
    try { await api.panelUpdateInstall(); setRestarting(true) }
    catch (e: unknown) { setError(e instanceof Error ? e.message : t('error')); setBusy(false) }
  }
  const notes = u.notes?.[lang] ?? u.notes?.en ?? u.notes?.fr ?? ''

  return (
    <div className="p-3 border-t border-surface-border shrink-0 space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="text-zinc-500">{t('panel_update')}</span>
        <span className="text-zinc-600 font-mono">v{u.current}</span>
      </div>
      {restarting ? (
        <p className="text-xs text-zinc-500">{t('panel_update_restarting')}</p>
      ) : u.phase === 'available' && u.version ? (
        <>
          {u.fullRequired ? (
            <p className="text-xs text-zinc-500">{t('panel_update_full').replace('{v}', u.version)}</p>
          ) : (
            <button onClick={install} disabled={busy} className="btn-accent w-full justify-center disabled:opacity-40">
              <ArrowUpCircle size={13} />
              {busy ? t('updating') : `${t('install_update')} v${u.version}`}
            </button>
          )}
          {notes && <p className="text-[11px] text-zinc-500 whitespace-pre-line line-clamp-4">{notes}</p>}
        </>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <p className={`text-xs ${u.phase === 'error' ? 'text-zinc-500' : 'text-green-600 dark:text-green-500'}`}>
            {u.phase === 'error' ? u.error : u.phase === 'current' ? t('up_to_date') : ''}
          </p>
          <button onClick={check} disabled={busy} className="btn-ghost text-xs shrink-0 disabled:opacity-40">
            <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />{t('panel_update_check')}
          </button>
        </div>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  )
}

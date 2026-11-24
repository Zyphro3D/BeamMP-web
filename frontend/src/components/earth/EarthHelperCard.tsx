import { useState } from 'react'
import { Cpu } from 'lucide-react'
import { api, type EarthHelper } from '../../lib/api'
import { useI18n } from '../../context/I18nContext'
import { Toggle } from '../ui/Toggle'
import { formatUptimeMs } from '../../lib/format'

interface Props {
  instanceId: string
  helper: EarthHelper
  modVersion?: string | null
  onChanged: () => void
}

/** Assistant de partage : allumé ou éteint par helper.json, état lu dans helper-state.json (superviseur sur l'hôte). */
export function EarthHelperCard({ instanceId, helper, modVersion, onChanged }: Props) {
  const { t } = useI18n()
  const [busy, setBusy]   = useState(false)
  const [error, setError] = useState('')
  const st = helper.state
  const now = Date.now() / 1000

  const set = async (enabled: boolean, procs: number) => {
    setBusy(true); setError('')
    try { await api.setEarthHelper(instanceId, enabled, procs); onChanged() }
    catch (e: unknown) { setError(e instanceof Error ? e.message : t('error')) }
    finally { setBusy(false) }
  }

  let status = t('earth_helper_off')
  if (st?.running) status = t('earth_helper_running')
  else if (helper.control.enabled && st?.nextStart) status = `${t('earth_helper_retry')} ${Math.max(0, Math.round(st.nextStart - now))} s`
  else if (helper.control.enabled) status = t('earth_helper_starting')

  return (
    <div className="card p-5 space-y-3 lg:col-span-2">
      <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider flex items-center gap-1.5">
        <Cpu size={13} /> {t('earth_helper')}
      </p>
      <p className="text-[11px] text-zinc-500">{t('earth_helper_help')}</p>
      {!helper.installed ? (
        <p className="text-xs text-zinc-500">{t('earth_helper_not_installed')}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Toggle checked={helper.control.enabled} onChange={() => !busy && set(!helper.control.enabled, 1)} />
              <span className="text-sm">{status}</span>
            </div>
            {st?.version && <span className="text-xs text-zinc-500 font-mono">v{st.version}</span>}
          </div>
          {st?.running && (
            <p className="text-xs text-zinc-500">
              {st.since && <>{t('uptime')} {formatUptimeMs((now - st.since) * 1000)} · </>}
              {t('earth_helper_ram')} {st.rssMb != null ? `${Math.round(st.rssMb)} Mo` : '—'}
              {st.cacheMb != null && <> · {t('earth_helper_cache')} {(st.cacheMb / 1024).toFixed(1)} Go</>}
            </p>
          )}
          {st?.lastExit && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {st.lastExit.oom ? t('earth_helper_oom') : `${t('earth_helper_exited')} ${st.lastExit.code}`}
              {' · '}{new Date(st.lastExit.t * 1000).toLocaleString()}
            </p>
          )}
          {st?.version && modVersion && st.version !== modVersion && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {t('earth_helper_version_mismatch')} (v{st.version} ≠ v{modVersion})
            </p>
          )}
          {st?.error && <p className="text-xs text-red-600 dark:text-red-400">{st.error}</p>}
          {st && st.log.length > 0 && (
            <details>
              <summary className="text-xs text-zinc-400 cursor-pointer">{t('earth_helper_log')}</summary>
              <pre className="mt-2 p-2 bg-surface rounded text-[11px] leading-relaxed overflow-x-auto max-h-60">{st.log.join('\n')}</pre>
            </details>
          )}
        </>
      )}
      {error && <p className="text-xs text-red-600 dark:text-red-400" role="status">{error}</p>}
    </div>
  )
}

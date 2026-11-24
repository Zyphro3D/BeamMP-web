import { useCallback, useEffect, useState } from 'react'
import { ArrowUpCircle, History, RefreshCw, RotateCcw, Tag } from 'lucide-react'
import { api, type EarthRelease } from '../../lib/api'
import { useI18n } from '../../context/I18nContext'

interface Props {
  instanceId: string
  canRestart: boolean
  restarting: boolean
  onRestart: () => void
  onChanged: () => void
}

/** Version du mod et du plugin BeamNG.Earth, mise à jour depuis les releases du fork, retour arrière. */
export function EarthReleaseCard({ instanceId, canRestart, restarting, onRestart, onChanged }: Props) {
  const { t } = useI18n()
  const [rel, setRel]       = useState<EarthRelease | null>(null)
  const [busy, setBusy]     = useState('')
  const [error, setError]   = useState('')
  const [needsRestart, setNeedsRestart] = useState(false)

  const load = useCallback((force = false) =>
    api.earthRelease(instanceId, force).then(setRel).catch(e => setError(e.message)), [instanceId])
  useEffect(() => { load() }, [load])

  const act = async (key: string, fn: () => Promise<unknown>, confirmText: string) => {
    if (!window.confirm(confirmText)) return
    setBusy(key); setError('')
    try { await fn(); setNeedsRestart(true); await load(); onChanged() }
    catch (e: unknown) { setError(e instanceof Error ? e.message : t('error')) }
    finally { setBusy('') }
  }

  return (
    <div className="card p-5 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider flex items-center gap-1.5">
          <Tag size={13} /> {t('earth_version')}
        </p>
        <button onClick={() => load(true)} disabled={!!busy} className="p-1.5 text-zinc-500 hover:text-zinc-300"
          title={t('earth_version_check')} aria-label={t('earth_version_check')}><RefreshCw size={13} /></button>
      </div>
      {!rel ? <p className="text-xs text-zinc-500">{error || t('loading')}</p> : (
        <>
          <dl className="grid grid-cols-2 gap-y-1 text-sm">
            <dt className="text-zinc-500 text-xs self-center">{t('earth_version_installed')}</dt>
            <dd className="font-mono text-right">{rel.installed ?? '—'}</dd>
            <dt className="text-zinc-500 text-xs self-center">{t('earth_version_latest')}</dt>
            <dd className="font-mono text-right">
              {rel.notesUrl && rel.latest
                ? <a href={rel.notesUrl} target="_blank" rel="noopener noreferrer" className="underline">{rel.latest}</a>
                : (rel.latest ?? '—')}
            </dd>
          </dl>
          {rel.error && <p className="text-xs text-amber-700 dark:text-amber-400">{rel.error}</p>}
          {rel.updateAvailable ? (
            <button className="btn-accent w-full justify-center disabled:opacity-40" disabled={!!busy}
              onClick={() => act('install', () => api.installEarthRelease(instanceId),
                `${t('earth_version_install_confirm')} ${rel.installed} → ${rel.latest}`)}>
              <ArrowUpCircle size={13} />
              {busy === 'install' ? t('updating') : `${t('install_update')} ${rel.latest}`}
              {rel.size ? <span className="opacity-70">({Math.round(rel.size / 1048576)} Mo)</span> : null}
            </button>
          ) : rel.latest && rel.installed === rel.latest && (
            <p className="text-xs text-green-700 dark:text-green-500">{t('up_to_date')}</p>
          )}
          {rel.previous && (
            <button className="btn-ghost w-full justify-center disabled:opacity-40" disabled={!!busy}
              onClick={() => act('restore', () => api.restoreEarthRelease(instanceId),
                `${t('earth_version_restore_confirm')} ${rel.previous}`)}>
              <History size={13} /> {t('earth_version_restore')} {rel.previous}
            </button>
          )}
          <p className="text-[11px] text-zinc-500">{t('earth_version_help')}</p>
        </>
      )}
      {needsRestart && (
        <div className="p-3 rounded-lg border border-accent/40 space-y-2" role="status">
          <p className="text-xs">{t('earth_version_restart')}</p>
          <button onClick={onRestart} disabled={restarting || !canRestart}
            className="btn-danger w-full justify-center disabled:opacity-40" title={!canRestart ? t('restart_not_configured') : undefined}>
            <RotateCcw size={13} /> {restarting ? t('restarting') : t('restart_server')}
          </button>
        </div>
      )}
      {error && rel && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}

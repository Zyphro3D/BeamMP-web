import { useRef, useState } from 'react'
import { Database, Package, RefreshCw, Trash2, Upload } from 'lucide-react'
import { api, type EarthOverview, type EarthPack } from '../../lib/api'
import { useI18n } from '../../context/I18nContext'

// Au-delà de 100 Mo, un envoi par un domaine derrière le proxy Cloudflare échoue : on le dit avant d'envoyer.
const PROXY_LIMIT = 100 * 1024 * 1024

function size(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} Go`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} Mo`
  return `${Math.max(1, Math.round(bytes / 1024))} Ko`
}

function area(p: EarthPack): string {
  const b = p.meta?.bbox
  if (!b || b.length !== 4) return '—'
  return `${b[0].toFixed(2)}, ${b[1].toFixed(2)} → ${b[2].toFixed(2)}, ${b[3].toFixed(2)}`
}

interface Props {
  instanceId: string
  data: EarthOverview
  onChanged: () => void
}

/** Stock partagé (state.json) et packs compilés (bake/*.bnge) du plugin BeamNG.Earth. */
export function EarthWorld({ instanceId, data, onChanged }: Props) {
  const { t } = useI18n()
  const [busy, setBusy]   = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const state = data.state?.fresh ? data.state : null
  const pending = data.pending ?? []
  const packs = data.packs ?? []

  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key); setError(''); setNotice('')
    try { await fn(); if (done) setNotice(done); onChanged() }
    catch (e: unknown) { setError(e instanceof Error ? e.message : t('error')) }
    finally { setBusy('') }
  }

  const clearStore = () => {
    if (!window.confirm(t('earth_store_clear_confirm'))) return
    run('clear', () => api.clearEarthStore(instanceId), t('earth_request_sent'))
  }

  const upload = (file: File | undefined) => {
    if (!file) return
    if (file.size > PROXY_LIMIT && !window.confirm(t('earth_pack_big_confirm'))) return
    run('upload', () => api.uploadEarthPack(instanceId, file), t('earth_pack_added'))
    if (fileRef.current) fileRef.current.value = ''
  }

  const remove = (name: string) => {
    if (!window.confirm(`${t('earth_pack_delete_confirm')} ${name}`)) return
    run(`del:${name}`, () => api.deleteEarthPack(instanceId, name))
  }

  const mb = state?.store.mb ?? null
  const cap = state?.store.capMb ?? null
  const pct = mb != null && cap ? Math.min(100, (mb / cap) * 100) : null

  return (
    <div className="lg:col-span-2 grid grid-cols-1 lg:grid-cols-2 gap-5">
      {/* Stock partagé */}
      <div className="card p-5 space-y-3">
        <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider flex items-center gap-1.5">
          <Database size={13} /> {t('earth_store')}
        </p>
        <p className="text-[11px] text-zinc-500">{t('earth_store_help')}</p>
        {state ? (
          <>
            <div className="flex items-baseline justify-between text-sm">
              <span>{mb != null ? `${mb.toFixed(1)} Mo` : '—'} <span className="text-xs text-zinc-500">/ {cap} Mo</span></span>
              <span className="text-xs text-zinc-500">{state.store.items ?? 0} {t('earth_store_items')}</span>
            </div>
            {pct != null && (
              <div className="h-1.5 rounded-full bg-zinc-200 dark:bg-white/10 overflow-hidden" role="progressbar"
                aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={t('earth_store')}>
                <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
              </div>
            )}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-zinc-500">
              <dt>{t('earth_stat_in')}</dt><dd className="text-right font-mono">{state.stats.items_in ?? 0}</dd>
              <dt>{t('earth_stat_served')}</dt>
              <dd className="text-right font-mono">{(state.stats.served_store ?? 0) + (state.stats.served_pack ?? 0)}</dd>
              <dt>{t('earth_stat_missed')}</dt><dd className="text-right font-mono">{state.stats.missed ?? 0}</dd>
            </dl>
          </>
        ) : <p className="text-xs text-zinc-500">{t('earth_needs_running')}</p>}
        <button onClick={clearStore} disabled={!!busy || pending.includes('clear-store') || !data.supportsSettings}
          className="btn-danger w-full justify-center disabled:opacity-40">
          <Trash2 size={13} />
          {pending.includes('clear-store') ? t('earth_request_pending') : t('earth_store_clear')}
        </button>
      </div>

      {/* Packs compilés */}
      <div className="card p-5 space-y-3">
        <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider flex items-center gap-1.5">
          <Package size={13} /> {t('earth_packs')}
        </p>
        <p className="text-[11px] text-zinc-500">{t('earth_packs_help')}</p>
        {packs.length === 0 ? <p className="text-xs text-zinc-500">{t('earth_packs_none')}</p> : (
          <ul className="divide-y divide-surface-border">
            {packs.map(p => (
              <li key={p.name} className="py-2 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{p.name}</p>
                  {p.valid ? (
                    <p className="text-[11px] text-zinc-500">
                      {size(p.size)} · {p.items} {t('earth_store_items')} · {area(p)}
                      {p.meta?.made && <> · {p.meta.made.slice(0, 10)}</>}
                    </p>
                  ) : <p className="text-[11px] text-red-600 dark:text-red-400">{p.error}</p>}
                  {p.valid && p.loaded === false && (
                    <p className="text-[11px] text-amber-700 dark:text-amber-400">{t('earth_pack_not_loaded')}</p>
                  )}
                </div>
                <button onClick={() => remove(p.name)} disabled={!!busy}
                  className="p-1.5 text-zinc-500 hover:text-red-500 disabled:opacity-40"
                  title={t('earth_pack_delete')} aria-label={`${t('earth_pack_delete')} ${p.name}`}>
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <input ref={fileRef} type="file" accept=".bnge" className="hidden" onChange={e => upload(e.target.files?.[0])} />
        <div className="flex gap-2">
          <button onClick={() => fileRef.current?.click()} disabled={!!busy || !data.supportsSettings}
            className="btn-accent flex-1 justify-center disabled:opacity-40">
            <Upload size={13} /> {busy === 'upload' ? t('earth_pack_uploading') : t('earth_pack_add')}
          </button>
          <button onClick={() => run('reload', () => api.reloadEarthPacks(instanceId), t('earth_request_sent'))}
            disabled={!!busy || pending.includes('reload-packs') || !data.supportsSettings}
            className="btn-ghost justify-center disabled:opacity-40" title={t('earth_packs_reload')} aria-label={t('earth_packs_reload')}>
            <RefreshCw size={13} />
          </button>
        </div>
        <p className="text-[11px] text-zinc-500">{t('earth_packs_scp')}</p>
      </div>

      {(error || notice) && (
        <p className={`lg:col-span-2 text-xs ${error ? 'text-red-600 dark:text-red-400' : 'text-green-700 dark:text-green-400'}`}
          role="status">{error || notice}</p>
      )}
    </div>
  )
}

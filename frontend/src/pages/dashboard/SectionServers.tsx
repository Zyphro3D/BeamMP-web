import { useCallback, useEffect, useState } from 'react'
import { Plus, Server, Trash2 } from 'lucide-react'
import { api, type ManagedServer, type ServerList } from '../../lib/api'
import { useI18n } from '../../context/I18nContext'
import { getStoredUser } from '../../lib/auth'

// Serveurs du panel : celui de l'installation et ceux ajoutés par le bouton « Ajouter un serveur ».
// Ajout et retrait à chaud ; un serveur retiré est archivé (dossier gardé), jamais effacé.
export function SectionServers({ onChanged }: { onChanged: () => void }) {
  const { t } = useI18n()
  const isSuper = getStoredUser()?.role === 'superadmin'
  const [list, setList] = useState<ServerList | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [name, setName] = useState('')
  const [port, setPort] = useState('')
  const [authKey, setAuthKey] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => api.servers().then(l => {
    setList(l)
    setPort(p => p || String(l.nextPort))
  }).catch(e => setError(e instanceof Error ? e.message : t('error'))), [t])

  useEffect(() => {
    load()
    const timer = setInterval(load, 10_000)
    return () => clearInterval(timer)
  }, [load])

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setError(''); setNotice('')
    try {
      const r = await api.addServer(name.trim(), Number(port), authKey.trim())
      setNotice(r.started ? t('servers_added').replace('{name}', r.server.name)
                          : `${t('servers_added_not_started').replace('{name}', r.server.name)} ${r.error}`)
      setName(''); setAuthKey(''); setPort('')
      await load()
      onChanged()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('error'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (s: ManagedServer) => {
    if (!confirm(t('servers_confirm_remove').replace('{name}', s.name))) return
    setBusy(true); setError(''); setNotice('')
    try {
      await api.removeServer(s.id)
      setNotice(t('servers_removed').replace('{name}', s.name))
      await load()
      onChanged()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('error'))
    } finally {
      setBusy(false)
    }
  }

  const switchToRunner = async () => {
    if (!confirm(t('servers_switch_confirm'))) return
    setBusy(true); setError(''); setNotice('')
    try {
      await api.switchToRunner()
      setNotice(t('servers_switch_requested'))
      await load()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('error'))
    } finally {
      setBusy(false)
    }
  }

  const state = (s: ManagedServer) => {
    if (!s.managed) return <span className="badge-zinc">{t('servers_state_external')}</span>
    if (s.unreachable) return <span className="badge-red">{t('servers_state_unreachable')}</span>
    if (s.running) return <span className="badge-green">{t('online')}</span>
    if (s.error) return <span className="badge-red" title={s.error}>{t('servers_state_error')}</span>
    return <span className="badge-zinc">{t('offline')}</span>
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <div className="card overflow-hidden">
        <div className="p-3 border-b border-surface-border">
          <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">{t('servers_title')}</p>
        </div>
        <ul className="divide-y divide-surface-border">
          {!list && <li className="p-6 text-center text-xs text-zinc-500">{t('loading')}</li>}
          {list?.servers.map(s => (
            <li key={s.id} className="flex items-center gap-3 p-3">
              <Server size={16} className="text-zinc-500 shrink-0" aria-hidden />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{s.name}</p>
                <p className="text-[11px] text-zinc-500">
                  {t('servers_port')} {s.port ?? '—'} · {s.origin === 'panel' ? t('servers_origin_panel') : t('servers_origin_install')}
                </p>
                {s.error && !s.running && <p className="text-[11px] text-red-600 dark:text-red-400 break-words">{s.error}</p>}
              </div>
              {state(s)}
              {isSuper && s.removable && (
                <button type="button" className="btn-danger px-2 py-1" disabled={busy} onClick={() => remove(s)}
                  aria-label={`${t('servers_remove')} ${s.name}`} title={t('servers_remove')}>
                  <Trash2 size={14} aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="card p-4 space-y-3">
        <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">{t('servers_add')}</p>
        {list && !list.canAdd && !list.canSwitch && !list.switchPending &&
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{list.reason}</p>}
        {list?.switchPending && <p className="text-sm text-zinc-600 dark:text-zinc-400">{t('servers_switch_pending')}</p>}
        {list?.canSwitch && (
          <div className="space-y-2">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">{t('servers_switch_hint')}</p>
            {isSuper
              ? <button type="button" className="btn-accent" disabled={busy} onClick={switchToRunner}>{t('servers_switch')}</button>
              : <p className="text-sm text-zinc-600 dark:text-zinc-400">{t('servers_superadmin_only')}</p>}
          </div>
        )}
        {list?.canAdd && !isSuper && <p className="text-sm text-zinc-600 dark:text-zinc-400">{t('servers_superadmin_only')}</p>}
        {list?.canAdd && isSuper && (
          <form onSubmit={add} className="space-y-3">
            <div>
              <label htmlFor="srv-name" className="text-xs text-zinc-500">{t('servers_name')}</label>
              <input id="srv-name" className="input" value={name} onChange={e => setName(e.target.value)}
                maxLength={60} required placeholder={t('servers_name_placeholder')} />
            </div>
            <div>
              <label htmlFor="srv-port" className="text-xs text-zinc-500">{t('servers_port')}</label>
              <input id="srv-port" className="input" type="number" min={1024} max={65535} value={port}
                onChange={e => setPort(e.target.value)} required />
              <p className="text-[11px] text-zinc-500 mt-1">{t('servers_port_hint')}</p>
            </div>
            <div>
              <label htmlFor="srv-key" className="text-xs text-zinc-500">AuthKey</label>
              <input id="srv-key" className="input font-mono" type="password" autoComplete="off" value={authKey}
                onChange={e => setAuthKey(e.target.value)} required />
              <p className="text-[11px] text-zinc-500 mt-1">
                {t('servers_key_hint')}{' '}
                <a href="https://keymaster.beammp.com" target="_blank" rel="noreferrer" className="underline">keymaster.beammp.com</a>
              </p>
            </div>
            <button type="submit" className="btn-accent" disabled={busy}>
              <Plus size={14} aria-hidden /> {t('servers_add')}
            </button>
          </form>
        )}
        {notice && <p role="status" className="text-sm text-green-700 dark:text-green-400">{notice}</p>}
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <p className="text-[11px] text-zinc-500">{t('servers_archive_hint')}</p>
      </div>
    </div>
  )
}

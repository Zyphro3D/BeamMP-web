import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FolderOpen, KeyRound, Server, UserCog } from 'lucide-react'
import { api, type SetupStatus } from '../lib/api'
import { useI18n } from '../context/I18nContext'
import { LangToggle } from '../components/ui/LangToggle'
import { ThemeToggle } from '../components/ui/ThemeToggle'

// Premier lancement de l'appli Windows : dossier du serveur BeamMP (ou
// téléchargement automatique), nom et clé du serveur, compte administrateur.
// Accessible seulement tant que le panel n'est pas configuré, et seulement
// depuis le PC où il est installé (contrôlé côté serveur).
export function Setup() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [serverDir, setServerDir] = useState('')
  const [download, setDownload] = useState(true)
  const [serverName, setServerName] = useState('')
  const [authKey, setAuthKey] = useState('')
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api.setupStatus().then(s => {
      if (!s.needed) { navigate('/login', { replace: true }); return }
      setStatus(s)
      setServerDir(s.serverDir)
      setDownload(!s.serverInstalled)
    }).catch(e => setError(e.message))
  }, [navigate])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (status && !status.hasAdmin && password !== password2) { setError(t('setup_password_mismatch')); return }
    setBusy(true)
    try {
      await api.setup({ serverDir, downloadServer: download, serverName, authKey,
                        username: status?.hasAdmin ? undefined : username,
                        password: status?.hasAdmin ? undefined : password })
      navigate('/login', { replace: true })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('error'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-surface text-zinc-800 dark:text-zinc-100">
      <header className="border-b border-surface-border bg-surface-raised">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center shrink-0">
              <span className="text-white text-base font-bold">B</span>
            </div>
            <p className="text-sm font-semibold">BeamMP Panel</p>
          </div>
          <div className="flex items-center gap-2"><LangToggle /><ThemeToggle /></div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-8">
        <h1 className="text-xl font-bold">{t('setup_title')}</h1>
        <p className="text-sm text-zinc-500 mt-1 mb-6">{t('setup_intro')}</p>

        {!status ? (
          error ? <p className="text-sm text-red-400">{error}</p> : <p className="text-sm text-zinc-500">…</p>
        ) : (
          <form onSubmit={submit} className="space-y-5">
            <fieldset className="card p-5 space-y-3">
              <legend className="flex items-center gap-2 text-sm font-semibold"><Server size={15} className="text-accent" />{t('setup_server')}</legend>
              <label className="block">
                <span className="inline-block text-xs text-zinc-500 mb-1"><FolderOpen size={12} className="inline mr-1" />{t('setup_server_dir')}</span>
                <input className="input w-full font-mono text-xs" value={serverDir} onChange={e => setServerDir(e.target.value)} required />
                <span className="block text-[11px] text-zinc-500 mt-1">{t('setup_server_dir_hint')}</span>
              </label>
              {!status.serverInstalled && (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" checked={download} onChange={e => setDownload(e.target.checked)} className="mt-1" />
                  <span>{t('setup_download')}<span className="block text-[11px] text-zinc-500">{t('setup_download_hint')}</span></span>
                </label>
              )}
              <label className="block">
                <span className="inline-block text-xs text-zinc-500 mb-1">{t('setup_server_name')}</span>
                <input className="input w-full" value={serverName} onChange={e => setServerName(e.target.value)} placeholder="Mon serveur BeamMP" maxLength={100} />
              </label>
              <label className="block">
                <span className="inline-block text-xs text-zinc-500 mb-1"><KeyRound size={12} className="inline mr-1" />{t('setup_authkey')}</span>
                <input className="input w-full font-mono text-xs" value={authKey} onChange={e => setAuthKey(e.target.value)} autoComplete="off" required />
                <span className="block text-[11px] text-zinc-500 mt-1">
                  {t('setup_authkey_hint')}{' '}
                  <a href="https://keymaster.beammp.com/" target="_blank" rel="noopener noreferrer" className="text-accent underline">keymaster.beammp.com</a>
                </span>
              </label>
            </fieldset>

            {!status.hasAdmin && (
              <fieldset className="card p-5 space-y-3">
                <legend className="flex items-center gap-2 text-sm font-semibold"><UserCog size={15} className="text-accent" />{t('setup_admin')}</legend>
                <label className="block">
                  <span className="inline-block text-xs text-zinc-500 mb-1">{t('username')}</span>
                  <input className="input w-full" value={username} onChange={e => setUsername(e.target.value)} required maxLength={100} autoComplete="username" />
                </label>
                <label className="block">
                  <span className="inline-block text-xs text-zinc-500 mb-1">{t('password')}</span>
                  <input type="password" className="input w-full" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} autoComplete="new-password" />
                </label>
                <label className="block">
                  <span className="inline-block text-xs text-zinc-500 mb-1">{t('setup_password_again')}</span>
                  <input type="password" className="input w-full" value={password2} onChange={e => setPassword2(e.target.value)} required minLength={8} autoComplete="new-password" />
                </label>
              </fieldset>
            )}

            {error && <p className="text-sm text-red-400">{error}</p>}
            <button type="submit" disabled={busy} className="btn-accent w-full justify-center disabled:opacity-50">
              {busy ? t('setup_working') : t('setup_finish')}
            </button>
          </form>
        )}
      </main>
    </div>
  )
}

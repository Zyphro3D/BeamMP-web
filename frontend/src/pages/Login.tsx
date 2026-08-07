import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { saveAuth } from '../lib/auth'
import { useI18n } from '../context/I18nContext'
import { LangToggle } from '../components/ui/LangToggle'
import { ThemeToggle } from '../components/ui/ThemeToggle'

type Tab = 'login' | 'request'

export function Login() {
  const [params] = useSearchParams()
  const [tab, setTab] = useState<Tab>((params.get('tab') as Tab) ?? 'login')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const { t } = useI18n()

  const handleLogin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    const fd = new FormData(e.currentTarget)
    try {
      const { user } = await api.login(
        fd.get('username') as string,
        fd.get('password') as string
      )
      saveAuth(user)
      navigate('/dashboard')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('error'))
    } finally {
      setLoading(false)
    }
  }

  const handleRequest = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError('')
    setSuccess('')
    setLoading(true)
    const fd = new FormData(e.currentTarget)
    try {
      const res = await api.requestAccount(fd.get('beammp_username') as string)
      setSuccess(res.message)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('error'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-surface flex flex-col items-center justify-center px-4">
      {/* Controls */}
      <div className="absolute top-4 right-4 flex items-center gap-1">
        <LangToggle />
        <ThemeToggle />
      </div>

      <div className="card w-full max-w-sm shadow-lg">
        {/* Tabs */}
        <div className="flex border-b border-surface-border">
          {(['login', 'request'] as const).map((tab_) => (
            <button
              key={tab_}
              onClick={() => { setTab(tab_); setError(''); setSuccess('') }}
              className={`flex-1 py-3 text-xs font-medium transition-colors ${
                tab === tab_
                  ? 'text-accent border-b-2 border-accent'
                  : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
              }`}
            >
              {tab_ === 'login' ? t('connexion') : t('request_account')}
            </button>
          ))}
        </div>

        <div className="p-6">
          {error && (
            <div className="mb-4 px-3 py-2 rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 text-xs">
              {error}
            </div>
          )}
          {success && (
            <div className="mb-4 px-3 py-2 rounded-lg bg-green-500/10 text-green-600 dark:text-green-400 text-xs">
              {success}
            </div>
          )}

          {tab === 'login' && (
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="login-username" className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{t('username')}</label>
                <input id="login-username" name="username" required className="input" autoFocus />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="login-password" className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{t('password')}</label>
                <input id="login-password" name="password" type="password" required className="input" />
              </div>
              <button type="submit" disabled={loading} className="btn-accent w-full justify-center">
                {loading ? t('logging_in') : t('login_btn')}
              </button>
            </form>
          )}

          {tab === 'request' && (
            <form onSubmit={handleRequest} className="space-y-4">
              <p className="text-xs text-zinc-500 leading-relaxed">{t('request_hint')}</p>
              <div className="space-y-1.5">
                <label htmlFor="request-beammp-username" className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{t('beammp_username')}</label>
                <input id="request-beammp-username" name="beammp_username" required className="input" autoFocus />
              </div>
              <button type="submit" disabled={loading || !!success} className="btn-accent w-full justify-center">
                {loading ? t('sending') : t('send_request')}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

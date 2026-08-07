import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { api, type AccountRequest, type User } from '../../lib/api'
import { useI18n } from '../../context/I18nContext'
import { Avatar } from '../../components/ui/Avatar'
import { Modal } from '../../components/ui/Modal'
import { getStoredUser } from '../../lib/auth'

export function SectionAdmin() {
  const { t } = useI18n()
  const [requests, setRequests] = useState<AccountRequest[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [reviewing, setReviewing] = useState<AccountRequest | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const me = getStoredUser()

  const refresh = () => {
    api.requests().then(setRequests).catch(() => {})
    api.adminUsers().then(setUsers).catch(() => {})
  }
  useEffect(refresh, [])

  const review = async (action: 'approve'|'reject') => {
    if (!reviewing) return; setError('')
    try { await api.reviewRequest(reviewing.id, action, action === 'approve' ? password : undefined); setReviewing(null); setPassword(''); refresh() }
    catch (err: unknown) { setError(err instanceof Error ? err.message : 'Erreur') }
  }

  const removeUser = async (u: User) => {
    if (!confirm(t('confirm_delete_user'))) return
    await api.deleteUser(u.id).then(refresh).catch(err => setError(err instanceof Error ? err.message : 'Erreur'))
  }

  const pending = requests.filter(r => r.status === 'pending')

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      {/* Requests */}
      <div className="card overflow-hidden">
        <div className="p-3 border-b border-surface-border">
          <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">{t('account_requests')}</p>
        </div>
        <div className="divide-y divide-surface-border">
          {pending.length === 0 && <p className="p-6 text-center text-xs text-zinc-700">{t('no_request')}</p>}
          {pending.map(r => (
            <div key={r.id} className="flex items-center gap-3 p-3">
              <Avatar name={r.beammp_username} size={8} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{r.beammp_username}</p>
                <p className="text-[10px] text-zinc-600">{r.connection_count ?? 0} {t('connections')} · {new Date(r.requested_at).toLocaleDateString()}</p>
              </div>
              <button onClick={() => { setReviewing(r); setError('') }} className="btn-accent text-xs py-1">{t('process')}</button>
            </div>
          ))}
        </div>
      </div>

      {/* Users */}
      <div className="card overflow-hidden">
        <div className="p-3 border-b border-surface-border">
          <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">{t('users')}</p>
        </div>
        {error && <p className="px-3 pt-2 text-xs text-red-400">{error}</p>}
        <div className="divide-y divide-surface-border">
          {users.map(u => (
            <div key={u.id} className="flex items-center gap-3 p-3">
              <Avatar name={u.username} size={7} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{u.username}</p>
              </div>
              <select value={u.role}
                onChange={e => api.updateUserRole(u.id, e.target.value).then(refresh).catch(() => {})}
                className="text-[11px] bg-surface border border-surface-border rounded-md px-2 py-1 text-zinc-300">
                <option value="superadmin">superadmin</option>
                <option value="admin">admin</option>
                <option value="moderator">moderator</option>
              </select>
              {me?.id !== u.id && (
                <button onClick={() => removeUser(u)}
                  className="p-1.5 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                  title={t('delete_user')} aria-label={t('delete_user')}>
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {reviewing && (
        <Modal title={`${t('request_from')} ${reviewing.beammp_username}`} onClose={() => { setReviewing(null); setPassword('') }}>
          <div className="space-y-4">
            <div className="text-xs text-zinc-500 space-y-1">
              <p>{t('connections_label')} <strong className="text-zinc-300">{reviewing.connection_count ?? 0}</strong></p>
              {reviewing.last_seen && <p>{t('last_seen_label')} {new Date(reviewing.last_seen).toLocaleDateString()}</p>}
            </div>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <div className="space-y-1">
              <label htmlFor="initial-password" className="text-xs text-zinc-400">{t('initial_password')}</label>
              <input id="initial-password" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder={t('initial_password_min')} className="input" />
            </div>
            <div className="flex gap-2">
              <button onClick={() => review('approve')} disabled={!password || password.length < 8} className="btn-accent flex-1 justify-center">{t('approve')}</button>
              <button onClick={() => review('reject')} className="btn-danger flex-1 justify-center">{t('reject')}</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

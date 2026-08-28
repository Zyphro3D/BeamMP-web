import { useState } from 'react'
import { api } from '../../lib/api'
import { Modal } from '../ui/Modal'
import { useI18n } from '../../context/I18nContext'

export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  const submit = async () => {
    setSaving(true); setError('')
    try {
      await api.changePassword(currentPassword, newPassword)
      setDone(true)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={t('change_password')} onClose={onClose}>
      <div className="space-y-3">
        {done ? (
          <p className="text-sm text-green-500">{t('password_changed')}</p>
        ) : (
          <>
            <div className="space-y-1">
              <label htmlFor="current-password" className="text-xs text-zinc-400">{t('current_password')}</label>
              <input id="current-password" type="password" value={currentPassword}
                onChange={e => setCurrentPassword(e.target.value)} className="input" autoComplete="current-password" />
            </div>
            <div className="space-y-1">
              <label htmlFor="new-password-self" className="text-xs text-zinc-400">{t('initial_password_min')}</label>
              <input id="new-password-self" type="password" value={newPassword}
                onChange={e => setNewPassword(e.target.value)} placeholder={t('initial_password_min')}
                className="input" autoComplete="new-password" />
            </div>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <button onClick={submit} disabled={saving || !currentPassword || newPassword.length < 8}
              className="btn-accent w-full justify-center">
              {saving ? '…' : t('save')}
            </button>
          </>
        )}
      </div>
    </Modal>
  )
}

import { useState, useEffect } from 'react'
import { Cookie } from 'lucide-react'
import { useI18n } from '../../context/I18nContext'

export function CookieBanner() {
  const { t } = useI18n()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!localStorage.getItem('cookie-consent')) setVisible(true)
  }, [])

  const accept = () => { localStorage.setItem('cookie-consent', 'accepted'); setVisible(false) }
  const decline = () => { localStorage.setItem('cookie-consent', 'declined'); setVisible(false) }

  if (!visible) return null

  return (
    <div className="fixed bottom-4 left-4 right-4 sm:left-auto sm:right-6 sm:max-w-sm z-50
                    bg-surface-card border border-surface-border rounded-xl p-4 shadow-2xl">
      <div className="flex items-start gap-3">
        <Cookie size={18} className="text-accent shrink-0 mt-0.5" />
        <div className="flex-1">
          <p className="text-sm font-medium text-zinc-100">{t('cookie_title')}</p>
          <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
            {t('cookie_desc')}
          </p>
          <div className="flex gap-2 mt-3">
            <button onClick={accept} className="btn-accent text-xs py-1.5">{t('cookie_accept')}</button>
            <button onClick={decline} className="btn-ghost text-xs py-1.5">{t('cookie_decline')}</button>
          </div>
        </div>
      </div>
    </div>
  )
}

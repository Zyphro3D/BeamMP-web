import { Sun, Moon, LogOut, LayoutDashboard, Shield } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { useTheme } from '../../hooks/useTheme'
import { clearAuth, getStoredUser } from '../../lib/auth'
import { useI18n } from '../../context/I18nContext'

export function Navbar() {
  const { theme, toggle } = useTheme()
  const { t } = useI18n()
  const navigate = useNavigate()
  const user = getStoredUser()

  const logout = () => {
    clearAuth()
    navigate('/')
  }

  return (
    <header className="sticky top-0 z-40 bg-white/80 dark:bg-gray-950/80 backdrop-blur border-b border-gray-200 dark:border-gray-800">
      <div className="max-w-7xl mx-auto px-4 h-14 flex items-center gap-4">
        {/* Logo */}
        <Link to="/" className="flex items-center gap-2 font-semibold text-sm shrink-0">
          <span className="text-brand-600">⬡</span>
          BeamMP Panel
        </Link>

        <div className="flex-1" />

        {/* Nav links */}
        {user && (
          <>
            <Link
              to="/dashboard"
              className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
            >
              <LayoutDashboard size={15} />
              {t('nav_dashboard')}
            </Link>
            {user.role === 'superadmin' && (
              <Link
                to="/admin"
                className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
              >
                <Shield size={15} />
                {t('nav_admin')}
              </Link>
            )}
          </>
        )}

        {/* Theme toggle */}
        <button
          onClick={toggle}
          className="p-2 rounded-lg text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
          title={theme === 'dark' ? t('theme_light') : t('theme_dark')}
        >
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>

        {/* Auth */}
        {user ? (
          <button onClick={logout} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-red-500">
            <LogOut size={15} />
            {t('logout')}
          </button>
        ) : (
          <Link to="/login" className="btn-primary text-xs">
            {t('login_link')}
          </Link>
        )}
      </div>
    </header>
  )
}

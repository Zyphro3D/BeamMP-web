import { Sun, Moon } from 'lucide-react'
import { useTheme } from '../../context/ThemeContext'
import { useI18n } from '../../context/I18nContext'

export function ThemeToggle({ className = '' }: { className?: string }) {
  const { theme, toggle } = useTheme()
  const { t } = useI18n()
  const label = theme === 'dark' ? t('theme_light') : t('theme_dark')
  return (
    <button
      onClick={toggle}
      title={label}
      aria-label={label}
      className={`p-1.5 rounded-lg transition-colors
        text-zinc-500 hover:text-zinc-700 hover:bg-zinc-200
        dark:text-zinc-500 dark:hover:text-zinc-300 dark:hover:bg-white/5
        ${className}`}
    >
      {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  )
}

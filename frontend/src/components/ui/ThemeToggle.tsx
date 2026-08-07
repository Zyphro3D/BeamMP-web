import { Sun, Moon } from 'lucide-react'
import { useTheme } from '../../context/ThemeContext'

export function ThemeToggle({ className = '' }: { className?: string }) {
  const { theme, toggle } = useTheme()
  return (
    <button
      onClick={toggle}
      title={theme === 'dark' ? 'Passer en mode clair' : 'Passer en mode sombre'}
      className={`p-1.5 rounded-lg transition-colors
        text-zinc-500 hover:text-zinc-700 hover:bg-zinc-200
        dark:text-zinc-500 dark:hover:text-zinc-300 dark:hover:bg-white/5
        ${className}`}
    >
      {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  )
}

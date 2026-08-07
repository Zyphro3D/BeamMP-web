import { useState, useRef, useEffect } from 'react'
import { ChevronDown } from 'lucide-react'
import { useI18n, type Lang } from '../../context/I18nContext'

const LANGS: { code: Lang; label: string }[] = [
  { code: 'fr', label: 'Français' },
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'pt', label: 'Português' },
  { code: 'pl', label: 'Polski' },
  { code: 'ru', label: 'Русский' },
  { code: 'it', label: 'Italiano' },
]

export function LangToggle({ className = '' }: { className?: string }) {
  const { lang, setLang } = useI18n()
  const [open, setOpen] = useState(false)
  const [dropUp, setDropUp] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleToggle = () => {
    if (!open && ref.current) {
      const rect = ref.current.getBoundingClientRect()
      // dropdown height ≈ 8 langs * 32px + padding ≈ 280px
      setDropUp(window.innerHeight - rect.bottom < 280)
    }
    setOpen(o => !o)
  }

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        onClick={handleToggle}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-bold uppercase tracking-wide text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors"
      >
        {lang}
        <ChevronDown size={10} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className={`absolute right-0 ${dropUp ? 'bottom-full mb-1' : 'top-full mt-1'} bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg py-1 min-w-[120px] z-50`}>
          {LANGS.map(l => (
            <button
              key={l.code}
              onClick={() => { setLang(l.code); setOpen(false) }}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                lang === l.code
                  ? 'text-accent font-semibold'
                  : 'text-zinc-600 dark:text-zinc-400'
              }`}
            >
              <span className="uppercase font-mono text-[10px] w-5 shrink-0">{l.code}</span>
              <span>{l.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

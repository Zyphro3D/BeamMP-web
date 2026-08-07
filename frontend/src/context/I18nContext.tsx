import { createContext, useContext, useState, type ReactNode } from 'react'
import fr from '../locales/fr.json'
import en from '../locales/en.json'
import de from '../locales/de.json'
import es from '../locales/es.json'
import pt from '../locales/pt.json'
import pl from '../locales/pl.json'
import ru from '../locales/ru.json'
import it from '../locales/it.json'

export type Lang = 'fr' | 'en' | 'de' | 'es' | 'pt' | 'pl' | 'ru' | 'it'

const locales: Record<Lang, Record<string, string>> = { fr, en, de, es, pt, pl, ru, it }

function init(): Lang {
  return (localStorage.getItem('lang') as Lang) ?? 'fr'
}

const Ctx = createContext<{
  lang: Lang
  setLang: (l: Lang) => void
  t: (key: string) => string
}>({ lang: 'fr', setLang: () => {}, t: k => k })

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(init)

  const setLang = (l: Lang) => {
    setLangState(l)
    localStorage.setItem('lang', l)
  }

  // Falls back to English, then returns the key itself if missing
  const t = (key: string): string =>
    locales[lang][key] ?? locales.en[key] ?? key

  return <Ctx.Provider value={{ lang, setLang, t }}>{children}</Ctx.Provider>
}

export const useI18n = () => useContext(Ctx)

import { useMemo, useState } from 'react'
import { Map, Package, Car, Search } from 'lucide-react'
import type { CatalogItem } from '../../lib/api'
import { useI18n } from '../../context/I18nContext'
import { desc } from '../../lib/desc'
import { ModMetaBadges } from './ModMetaBadges'

type Tab = 'map' | 'vehicle' | 'mod'
const PAGE = 24

// Catalogue public en lecture seule : tout ce que le serveur propose, actif
// ou non, pour qu'un visiteur voie le contenu disponible et pas seulement
// la sélection du moment. Les éléments en jeu sont triés en tête par l'API.
export function ServerCatalog({ items }: { items: CatalogItem[] }) {
  const { t, lang } = useI18n()
  const counts = useMemo(() => ({
    map:     items.filter(i => i.type === 'map').length,
    vehicle: items.filter(i => i.type === 'vehicle').length,
    mod:     items.filter(i => i.type === 'mod').length,
  }), [items])
  const firstTab: Tab = counts.map ? 'map' : counts.vehicle ? 'vehicle' : 'mod'
  // null = pas encore choisi : le premier onglet non vide se calcule une
  // fois le catalogue chargé (au premier rendu la liste est encore vide).
  const [picked, setTab] = useState<Tab | null>(null)
  const tab = picked ?? firstTab
  const [query, setQuery] = useState('')
  const [shown, setShown] = useState(PAGE)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter(i => i.type === tab && (!q ||
      i.name.toLowerCase().includes(q) ||
      (desc(i.description, lang) ?? '').toLowerCase().includes(q) ||
      (i.metadata?.vehicle?.brand ?? '').toLowerCase().includes(q)))
  }, [items, tab, query, lang])

  if (items.length === 0) return null

  const tabs: Array<{ key: Tab; label: string; icon: typeof Map }> = [
    { key: 'map',     label: t('nav_maps'),     icon: Map },
    { key: 'vehicle', label: t('nav_vehicles'), icon: Car },
    { key: 'mod',     label: t('nav_mods'),     icon: Package },
  ]

  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
        <div>
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{t('catalog_title')}</h2>
          <p className="text-xs text-zinc-500 mt-0.5">{t('catalog_subtitle')}</p>
        </div>
        <label className="relative w-full sm:w-64">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input
            type="search"
            value={query}
            onChange={e => { setQuery(e.target.value); setShown(PAGE) }}
            placeholder={t('catalog_search')}
            className="input pl-8 text-xs w-full"
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-2 mb-4" role="tablist">
        {tabs.filter(x => counts[x.key] > 0).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => { setTab(key); setShown(PAGE) }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              tab === key
                ? 'bg-accent text-white'
                : 'bg-zinc-100 dark:bg-white/5 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-white/10'
            }`}
          >
            <Icon size={13} />
            {label}
            <span className={`font-mono ${tab === key ? 'text-white/80' : 'text-zinc-400'}`}>{counts[key]}</span>
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-zinc-500 text-center py-8">{t('catalog_empty')}</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {filtered.slice(0, shown).map(item => (
            <div key={item.id} className="card overflow-hidden flex flex-col">
              <div className="relative">
                {item.image ? (
                  <img src={`/images/${item.image}`} alt={item.name} loading="lazy"
                       className="w-full h-28 object-cover" />
                ) : (
                  <div className="w-full h-28 bg-surface-card flex items-center justify-center">
                    {item.type === 'map'
                      ? <Map size={20} className="text-zinc-400 dark:text-zinc-600" />
                      : <Package size={20} className="text-zinc-400 dark:text-zinc-600" />}
                  </div>
                )}
                {item.active && (
                  <span className="absolute top-2 left-2 flex items-center gap-1 px-2 py-0.5 rounded-full
                                   bg-green-500/90 text-white text-[10px] font-semibold shadow-sm">
                    <span className="w-1.5 h-1.5 rounded-full bg-white" />
                    {t('catalog_in_game')}
                  </span>
                )}
              </div>
              <div className="p-3 space-y-1.5">
                <p className="text-xs font-semibold truncate" title={item.name}>{item.name}</p>
                {desc(item.description, lang) && (
                  <p className="text-[11px] text-zinc-500 line-clamp-2">{desc(item.description, lang)}</p>
                )}
                <ModMetaBadges metadata={item.metadata} />
              </div>
            </div>
          ))}
        </div>
      )}

      {filtered.length > shown && (
        <div className="text-center mt-4">
          <button onClick={() => setShown(n => n + PAGE)} className="btn-ghost text-xs">
            {t('catalog_show_more').replace('{n}', String(filtered.length - shown))}
          </button>
        </div>
      )}
    </section>
  )
}

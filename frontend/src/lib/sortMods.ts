import type { Mod } from './api'

export type SortKey = 'name-asc' | 'name-desc' | 'date-asc' | 'date-desc'

export function getSortOptions(t: (k: string) => string): { value: SortKey; label: string }[] {
  return [
    { value: 'name-asc',  label: t('sort_az') },
    { value: 'name-desc', label: t('sort_za') },
    { value: 'date-desc', label: t('sort_newest') },
    { value: 'date-asc',  label: t('sort_oldest') },
  ]
}

export function sortMods(list: Mod[], sort: SortKey): Mod[] {
  return [...list].sort((a, b) => {
    if (sort === 'name-asc')  return a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' })
    if (sort === 'name-desc') return b.name.localeCompare(a.name, 'fr', { sensitivity: 'base' })
    if (sort === 'date-asc')  return a.id - b.id
    return b.id - a.id // date-desc
  })
}

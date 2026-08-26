export type RankTier = 'bronze' | 'silver' | 'gold' | 'platinum'

const ICONS: Record<RankTier, string> = {
  bronze:   '🥉',
  silver:   '🥈',
  gold:     '🥇',
  platinum: '💎',
}

const LABEL_KEYS: Record<RankTier, string> = {
  bronze:   'rank_bronze',
  silver:   'rank_silver',
  gold:     'rank_gold',
  platinum: 'rank_platinum',
}

// Seuils dupliqués depuis backend/src/services/logWatcher.ts (rankLabel,
// mêmes 4 nombres) — AUCUN mécanisme automatique ne les garde en phase (deux
// runtimes distincts, pas de package partagé entre backend/ et frontend/).
// Si ces seuils changent ici, reporter le même changement dans rankLabel()
// côté backend ou le message Discord divergera silencieusement du badge
// affiché au joueur.
export function rankTier(connectionCount: number): RankTier | null {
  if (connectionCount < 2)   return null
  if (connectionCount < 10)  return 'bronze'
  if (connectionCount < 100) return 'silver'
  if (connectionCount < 500) return 'gold'
  return 'platinum'
}

export function rankIcon(tier: RankTier): string {
  return ICONS[tier]
}

export function rankLabelKey(tier: RankTier): string {
  return LABEL_KEYS[tier]
}

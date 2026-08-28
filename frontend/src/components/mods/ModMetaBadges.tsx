import type { ModMetadata } from '../../lib/api'
import { useI18n } from '../../context/I18nContext'

// Badges construits à partir de l'analyse automatique du zip (voir
// backend/src/lib/modAnalyzer.ts) — aucune saisie manuelle. `metadata` est
// `null` pour tout mod uploadé avant cette fonctionnalité et pas encore
// ré-analysé (voir bouton "Analyser les mods existants" dans Import), dans
// ce cas le composant ne rend rien.
export function ModMetaBadges({ metadata, variant = 'card' }: {
  metadata: ModMetadata | null
  variant?: 'card' | 'compact'
}) {
  const { t } = useI18n()
  if (!metadata) return null

  if (metadata.kind === 'vehicle' && metadata.vehicle) {
    const v = metadata.vehicle
    const identity = [v.brand, v.bodyStyle].filter(Boolean).join(' · ')

    if (variant === 'compact') {
      return identity ? <span className="text-zinc-500 truncate">{identity}</span> : null
    }

    const powerRange = v.powerMin !== undefined && v.powerMax !== undefined
      ? (v.powerMin === v.powerMax ? `${Math.round(v.powerMin)} ch` : `${Math.round(v.powerMin)}–${Math.round(v.powerMax)} ch`)
      : null
    const offRoadRange = v.offRoadScoreMin !== undefined && v.offRoadScoreMax !== undefined
      ? (v.offRoadScoreMin === v.offRoadScoreMax ? `${v.offRoadScoreMin}` : `${v.offRoadScoreMin}–${v.offRoadScoreMax}`)
      : null

    return (
      <div className="flex flex-wrap gap-1">
        {v.brand && <span className="badge-zinc text-[10px]">{v.brand}</span>}
        {v.bodyStyle && <span className="badge-zinc text-[10px]">{v.bodyStyle}</span>}
        {v.drivetrains.length > 0 && (
          <span className="badge-blue text-[10px]">{v.drivetrains.join('/')}</span>
        )}
        {powerRange && (
          <span className="badge-orange text-[10px]" title={t('meta_power_tooltip').replace('{range}', powerRange)}>
            ⚡ {powerRange}
          </span>
        )}
        {offRoadRange && (
          <span className="badge-zinc text-[10px]" title={t('meta_offroad_tooltip').replace('{range}', offRoadRange)}>
            🪨 {offRoadRange}
          </span>
        )}
        {v.configCount > 1 && (
          <span className="badge-zinc text-[10px]">{t('meta_configs_count').replace('{n}', String(v.configCount))}</span>
        )}
      </div>
    )
  }

  if (metadata.kind === 'map' && metadata.map) {
    const m = metadata.map
    const size = m.sizeMeters ? `${Math.round(m.sizeMeters)}×${Math.round(m.sizeMeters)} m` : null

    if (variant === 'compact') {
      return size ? <span className="text-zinc-500 truncate">{size}</span> : null
    }

    return (
      <div className="flex flex-wrap gap-1">
        {size && <span className="badge-zinc text-[10px]">{size}</span>}
        {m.tagLine && (
          <span className="text-[10px] text-zinc-500 line-clamp-1" title={m.tagLine}>{m.tagLine}</span>
        )}
      </div>
    )
  }

  if (metadata.kind === 'other' && metadata.other && metadata.other.subtype !== 'unknown') {
    const label = t(`meta_subtype_${metadata.other.subtype}`)
    return <span className="badge-zinc text-[10px]">{label}</span>
  }

  return null
}

export function formatDuration(totalSeconds: number, unit: 'm' | 'min' = 'min'): string {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  if (h > 0) return `${h}h ${m < 10 ? '0' : ''}${m}${unit}`
  return `${m}${unit}`
}

export function formatUptimeMs(ms?: number): string {
  if (!ms) return '—'
  return formatDuration(Math.floor(ms / 1000), 'm')
}

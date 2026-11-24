import { useEffect, useMemo, useRef, useState } from 'react'
import { Crosshair, MapPin, Minus, Plus } from 'lucide-react'
import type { EarthPlayer } from '../../lib/api'
import { useI18n } from '../../context/I18nContext'
import { formatDuration } from '../../lib/format'

// Carte des joueurs sans bibliothèque : tuiles OSM relayées par le panel (/api/earth/tiles, la CSP n'autorise que
// ses propres images), projection Web Mercator, cadrage sur les joueurs, déplacement à la souris et zoom par boutons.
const TILE = 256
const HEIGHT = 420
const MIN_Z = 3
const MAX_Z = 17
const FRANCE = { lat: 46.6, lon: 2.4, z: 5 }

function project(lat: number, lon: number, z: number): [number, number] {
  const s = TILE * 2 ** z
  const r = Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180
  return [(lon + 180) / 360 * s, (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * s]
}

/** Le zoom et le centre qui montrent tous les joueurs (marge comprise) dans width × HEIGHT. */
function fit(players: EarthPlayer[], width: number): { z: number; cx: number; cy: number } {
  if (players.length === 0) {
    const [cx, cy] = project(FRANCE.lat, FRANCE.lon, FRANCE.z)
    return { z: FRANCE.z, cx, cy }
  }
  for (let z = players.length === 1 ? 13 : 15; z >= MIN_Z; z--) {
    const pts = players.map(p => project(p.lat, p.lon, z))
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys)
    if (w <= width - 120 && h <= HEIGHT - 120 || z === MIN_Z) {
      return { z, cx: (Math.max(...xs) + Math.min(...xs)) / 2, cy: (Math.max(...ys) + Math.min(...ys)) / 2 }
    }
  }
  return { z: MIN_Z, cx: 0, cy: 0 }
}

export function EarthMap({ players }: { players: EarthPlayer[] }) {
  const { t } = useI18n()
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  const [view, setView] = useState<{ z: number; cx: number; cy: number } | null>(null)   // null : suit les joueurs
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const auto = useMemo(() => fit(players, width), [players, width])
  const v = view ?? auto
  const n = 2 ** v.z
  const left = v.cx - width / 2, top = v.cy - HEIGHT / 2

  const tiles: { key: string; x: number; y: number; src: string }[] = []
  for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + HEIGHT) / TILE); ty++) {
    if (ty < 0 || ty >= n) continue
    for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + width) / TILE); tx++) {
      const wx = ((tx % n) + n) % n
      tiles.push({ key: `${v.z}/${tx}/${ty}`, x: tx * TILE - left, y: ty * TILE - top,
        src: `/api/earth/tiles/${v.z}/${wx}/${ty}.png` })
    }
  }

  // Étiquettes empilées quand des joueurs sont proches (sinon elles se recouvrent) : chacune descend d'une ligne
  // tant qu'elle touche une étiquette déjà placée.
  const placed: { x: number; y: number }[] = []
  const markers = players.map(p => {
    const [px, py] = project(p.lat, p.lon, v.z)
    const x = px - left, y = py - top
    let dy = 0
    while (dy < 6 * 18 && placed.some(o => Math.abs(o.x - x) < 90 && Math.abs(o.y - (y + dy)) < 18)) dy += 18
    placed.push({ x, y: y + dy })
    return { p, x, y, dy }
  })

  const zoom = (d: number) => {
    const z = Math.max(MIN_Z, Math.min(MAX_Z, v.z + d))
    const k = 2 ** (z - v.z)
    setView({ z, cx: v.cx * k, cy: v.cy * k })
  }

  const onDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, cx: v.cx, cy: v.cy }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (d) setView({ z: v.z, cx: d.cx - (e.clientX - d.x), cy: d.cy - (e.clientY - d.y) })
  }

  return (
    <div className="space-y-3">
      <div ref={box} className="relative overflow-hidden rounded-lg border border-surface-border bg-zinc-200 dark:bg-zinc-800 select-none touch-none cursor-grab active:cursor-grabbing"
        style={{ height: HEIGHT }} onPointerDown={onDown} onPointerMove={onMove}
        onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}
        role="img" aria-label={`${t('earth_map')} : ${players.length} ${t('earth_map_players')}`}>
        {tiles.map(tl => (
          <img key={tl.key} src={tl.src} alt="" draggable={false} width={TILE} height={TILE}
            className="absolute max-w-none" style={{ left: tl.x, top: tl.y }} />
        ))}
        {markers.map(({ p, x, y, dy }) => {
          return (
            <div key={p.pid} className="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-none"
              style={{ left: x, top: y }}>
              <svg width="22" height="22" viewBox="-11 -11 22 22" aria-hidden="true"
                style={{ transform: p.h != null ? `rotate(${p.h}deg)` : undefined }}>
                {p.h != null
                  ? <path d="M0,-9 L7,7 L0,3 L-7,7 Z" fill="#f97316" stroke="#fff" strokeWidth="1.5" />
                  : <circle r="6" fill="#f97316" stroke="#fff" strokeWidth="2" />}
              </svg>
              <span className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-black/70 px-1.5 py-0.5 text-[11px] text-white"
                style={{ top: 24 + dy }}>
                {p.name}
              </span>
            </div>
          )
        })}
        <div className="absolute right-2 top-2 flex flex-col gap-1" onPointerDown={e => e.stopPropagation()}>
          <button className="btn-ghost p-1.5 bg-white/90 dark:bg-zinc-900/90" onClick={() => zoom(1)} disabled={v.z >= MAX_Z}
            title={t('earth_map_zoom_in')} aria-label={t('earth_map_zoom_in')}><Plus size={14} /></button>
          <button className="btn-ghost p-1.5 bg-white/90 dark:bg-zinc-900/90" onClick={() => zoom(-1)} disabled={v.z <= MIN_Z}
            title={t('earth_map_zoom_out')} aria-label={t('earth_map_zoom_out')}><Minus size={14} /></button>
          <button className="btn-ghost p-1.5 bg-white/90 dark:bg-zinc-900/90" onClick={() => setView(null)} disabled={!view}
            title={t('earth_map_follow')} aria-label={t('earth_map_follow')}><Crosshair size={14} /></button>
        </div>
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer"
          onPointerDown={e => e.stopPropagation()}
          className="absolute bottom-0 right-0 bg-white/80 dark:bg-zinc-900/80 px-1.5 text-[10px] text-zinc-700 dark:text-zinc-300">
          © OpenStreetMap
        </a>
      </div>
      {players.length === 0 ? <p className="text-xs text-zinc-500">{t('earth_map_empty')}</p> : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-xs">
          {players.map(p => (
            <li key={p.pid} className="flex items-center gap-2">
              <MapPin size={12} className="text-accent shrink-0" />
              <span className="font-medium truncate">{p.name}</span>
              <span className="text-zinc-500 font-mono">{p.lat.toFixed(3)}, {p.lon.toFixed(3)}</span>
              {p.joined != null && <span className="text-zinc-500 ml-auto">{formatDuration(p.joined)}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

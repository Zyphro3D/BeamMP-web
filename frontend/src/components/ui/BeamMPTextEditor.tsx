import { useRef } from 'react'
import { useI18n } from '../../context/I18nContext'

// ── BeamMP format codes ────────────────────────────────────────────────────────

const COLORS: { code: string; hex: string; name: string }[] = [
  { code: '0', hex: '#000000', name: 'Noir' },
  { code: '1', hex: '#0000AA', name: 'Bleu' },
  { code: '2', hex: '#00AA00', name: 'Vert' },
  { code: '3', hex: '#00AAAA', name: 'Cyan' },
  { code: '4', hex: '#AA0000', name: 'Rouge' },
  { code: '5', hex: '#AA00AA', name: 'Rose' },
  { code: '6', hex: '#FFAA00', name: 'Orange' },
  { code: '7', hex: '#AAAAAA', name: 'Gris' },
  { code: '8', hex: '#555555', name: 'Gris foncé' },
  { code: '9', hex: '#5555FF', name: 'Bleu clair' },
  { code: 'a', hex: '#55FF55', name: 'Vert clair' },
  { code: 'b', hex: '#55FFFF', name: 'Cyan clair' },
  { code: 'c', hex: '#FF5555', name: 'Orange foncé' },
  { code: 'd', hex: '#FF55FF', name: 'Rose clair' },
  { code: 'e', hex: '#FFFF55', name: 'Jaune' },
  { code: 'f', hex: '#FFFFFF', name: 'Blanc' },
]

const FORMATS = [
  { code: 'l', label: 'G',  title: 'Gras',          className: 'font-bold' },
  { code: 'o', label: 'I',  title: 'Italique',       className: 'italic' },
  { code: 'n', label: 'S',  title: 'Souligné',       className: 'underline' },
  { code: 'm', label: '~~', title: 'Barré',          className: 'line-through' },
  { code: 'r', label: '↺',  title: 'Reset',          className: '' },
]

// ── Renderer ──────────────────────────────────────────────────────────────────

type Span = { text: string; color?: string; bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean }

function parseBeamMP(raw: string): Span[][] {
  // Split into lines on ^p
  const lines = raw.split('^p')
  return lines.map(line => {
    const spans: Span[] = []
    let cur: Span = { text: '' }
    let color: string | undefined
    let bold = false, italic = false, underline = false, strike = false

    let i = 0
    while (i < line.length) {
      if (line[i] === '^' && i + 1 < line.length) {
        const c = line[i + 1].toLowerCase()
        if (cur.text) { spans.push({ ...cur }); cur = { text: '' } }

        if (c === 'r') {
          color = undefined; bold = false; italic = false; underline = false; strike = false
        } else if (c === 'l') { bold = true }
        else if (c === 'o') { italic = true }
        else if (c === 'n') { underline = true }
        else if (c === 'm') { strike = true }
        else {
          const col = COLORS.find(x => x.code === c)
          if (col) color = col.hex
        }
        cur = { text: '', color, bold, italic, underline, strike }
        i += 2
      } else {
        cur.text += line[i]
        i++
      }
    }
    if (cur.text) spans.push(cur)
    return spans
  })
}

function Preview({ value, multiline }: { value: string; multiline?: boolean }) {
  const lines = parseBeamMP(value)
  return (
    <div className={`rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm font-mono min-h-[36px] ${multiline ? 'whitespace-pre-wrap' : 'truncate'}`}>
      {lines.map((spans, li) => (
        <span key={li}>
          {li > 0 && <br />}
          {spans.length === 0 && <span className="opacity-0">‎</span>}
          {spans.map((s, si) => (
            <span key={si} style={{ color: s.color ?? undefined }}
              className={[s.bold ? 'font-bold' : '', s.italic ? 'italic' : '', s.underline ? 'underline' : '', s.strike ? 'line-through' : ''].filter(Boolean).join(' ')}>
              {s.text}
            </span>
          ))}
        </span>
      ))}
    </div>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

interface BeamMPTextEditorProps {
  name: string
  value: string
  onChange: (v: string) => void
  multiline?: boolean
  placeholder?: string
}

export function BeamMPTextEditor({ name, value, onChange, multiline = false, placeholder }: BeamMPTextEditorProps) {
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null)
  const { t } = useI18n()

  const insert = (code: string) => {
    const el = ref.current
    if (!el) return
    const start = el.selectionStart ?? value.length
    const end   = el.selectionEnd   ?? value.length
    const next  = value.slice(0, start) + `^${code}` + value.slice(end)
    onChange(next)
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + 2
      el.setSelectionRange(pos, pos)
    })
  }

  return (
    <div className="space-y-2">
      {/* Toolbar */}
      <div className="flex flex-wrap gap-1 items-center">
        {/* Format buttons */}
        {FORMATS.map(f => (
          <button key={f.code} type="button" title={f.title} onClick={() => insert(f.code)}
            className={`px-2 py-0.5 text-xs rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 ${f.className}`}>
            {f.label}
          </button>
        ))}
        {multiline && (
          <button type="button" title={t('new_line')} onClick={() => insert('p')}
            className="px-2 py-0.5 text-xs rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300">
            {t('new_line')}
          </button>
        )}
        <div className="w-px h-4 bg-zinc-700 mx-0.5" />
        {/* Color palette */}
        {COLORS.map(c => (
          <button key={c.code} type="button" title={c.name} onClick={() => insert(c.code)}
            className="w-5 h-5 rounded border border-zinc-600 hover:scale-110 transition-transform flex-shrink-0"
            style={{ backgroundColor: c.hex }} />
        ))}
      </div>

      {/* Input */}
      {multiline ? (
        <textarea ref={ref as React.RefObject<HTMLTextAreaElement>} name={name} value={value}
          onChange={e => onChange(e.target.value)} rows={3} placeholder={placeholder}
          className="input w-full font-mono text-xs resize-none" />
      ) : (
        <input ref={ref as React.RefObject<HTMLInputElement>} name={name} value={value}
          onChange={e => onChange(e.target.value)} placeholder={placeholder}
          className="input w-full font-mono text-xs" />
      )}

      {/* Live preview */}
      <div className="space-y-0.5">
        <p className="text-[10px] text-zinc-500 uppercase tracking-wide">{t('preview')}</p>
        <Preview value={value} multiline={multiline} />
      </div>

      {/* Hidden input for form compat */}
      <input type="hidden" name={name} value={value} />
    </div>
  )
}

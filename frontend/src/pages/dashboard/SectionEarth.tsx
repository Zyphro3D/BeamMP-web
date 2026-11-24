import { useCallback, useEffect, useState } from 'react'
import { Globe2, RotateCcw } from 'lucide-react'
import { api, type EarthOverview, type EarthSettings, type EarthWeather } from '../../lib/api'
import { useI18n } from '../../context/I18nContext'
import { Toggle } from '../../components/ui/Toggle'
import { formatUptimeMs } from '../../lib/format'

const WEATHERS: EarthWeather[] = ['real', 'clear', 'cloudy', 'rain', 'storm', 'snow', 'fog']
const SPEEDS = [0, 1, 60]
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/

// Le formulaire n'écrit dans settings.json que ce qui diffère des valeurs de main.lua :
// une mise à jour du plugin qui change une valeur par défaut reste suivie pour le reste.
function diff(form: EarthSettings, defaults: EarthSettings): Partial<EarthSettings> {
  const out: Partial<EarthSettings> = {}
  for (const k of Object.keys(form) as (keyof EarthSettings)[]) {
    if (form[k] !== defaults[k]) (out as Record<string, unknown>)[k] = form[k]
  }
  return out
}

export function SectionEarth({ instanceId }: { instanceId: string }) {
  const { t } = useI18n()
  const [data, setData]       = useState<EarthOverview | null>(null)
  const [form, setForm]       = useState<EarthSettings | null>(null)
  const [dirty, setDirty]     = useState(false)
  const [saving, setSaving]   = useState(false)
  const [saved, setSaved]     = useState(false)
  const [error, setError]     = useState('')

  const load = useCallback(() => api.earth(instanceId).then(d => {
    setData(d)
    // (le formulaire suit le fichier tant qu'on ne l'a pas touché)
    if (d.defaults) setForm(f => (f && dirty) ? f : { ...d.defaults!, ...d.file } as EarthSettings)
  }).catch(e => setError(e.message)), [instanceId, dirty])

  useEffect(() => { load(); const id = setInterval(load, 5000); return () => clearInterval(id) }, [load])

  if (!data || !form) return <p className="text-sm text-zinc-600">{error || t('loading')}</p>
  if (!data.installed) return <p className="text-sm text-zinc-500">{t('earth_not_installed')}</p>

  const defaults = data.defaults!
  const state = data.state
  const running = !!state?.fresh
  const fixedTime = form.time !== 'real'
  const timeOk = !fixedTime || TIME_RE.test(form.time)

  const set = <K extends keyof EarthSettings>(k: K, v: EarthSettings[K]) => {
    setForm(f => f && ({ ...f, [k]: v })); setDirty(true); setSaved(false)
  }
  const num = (k: 'timeSpeed' | 'shareStoreMb' | 'shareOutKbps' | 'meetM') => (e: React.ChangeEvent<HTMLInputElement>) =>
    set(k, e.target.value === '' ? defaults[k] : Number(e.target.value))

  const save = async (settings: Partial<EarthSettings>) => {
    setSaving(true); setError('')
    try {
      await api.saveEarthSettings(instanceId, settings)
      setDirty(false); setSaved(true); setTimeout(() => setSaved(false), 2000)
      const d = await api.earth(instanceId)
      setData(d); setForm({ ...d.defaults!, ...d.file } as EarthSettings)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('error'))
    } finally { setSaving(false) }
  }

  const def = (v: unknown) => <span className="text-[10px] text-zinc-500">{t('earth_default')} : {String(v)}</span>

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      {/* État du plugin */}
      <div className="card p-5 space-y-3">
        <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider flex items-center gap-1.5">
          <Globe2 size={13} /> {t('earth_plugin')}
        </p>
        <div className="flex items-center gap-2 text-sm">
          <span className={`w-2 h-2 rounded-full ${running ? 'bg-green-400' : 'bg-red-400'}`} />
          <span>{running ? t('earth_running') : t('earth_stopped')}</span>
          {running && state?.uptime != null && (
            <span className="text-xs text-zinc-500">· {t('uptime')} {formatUptimeMs(state.uptime * 1000)}</span>
          )}
        </div>
        {running && (
          <p className="text-xs text-zinc-500">{t('earth_players_on_map')} : {state!.players.length}</p>
        )}
        {!data.supportsSettings && <p className="text-xs text-amber-700 dark:text-amber-400">{t('earth_old_plugin')}</p>}
        {data.fileError && <p className="text-xs text-red-400">{data.fileError}</p>}
        {state?.fresh && state.warnings.length > 0 && (
          <ul className="text-xs text-amber-700 dark:text-amber-400 list-disc pl-4 space-y-0.5">
            {state.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        )}

        <div className="pt-2 border-t border-surface-border space-y-1.5">
          <p className="text-xs font-semibold text-zinc-400">{t('earth_listing_title')}</p>
          <p className="text-xs text-zinc-500">{t(`earth_listing_${data.listing}`)}</p>
          <p className="text-[11px] text-zinc-500">{t('earth_listing_private_note')}</p>
        </div>
      </div>

      {/* Réglages */}
      <div className="card p-5">
        <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4">⚙ {t('earth_settings')}</p>
        {error && <p className="text-xs text-red-400 mb-3">{error}</p>}
        <form className="space-y-4" onSubmit={e => { e.preventDefault(); if (timeOk) save(diff(form, defaults)) }}>
          <div className="space-y-1.5">
            <label className="inline-block text-xs text-zinc-400">{t('earth_listed')}</label>
            <div className="flex items-center gap-2">
              <Toggle checked={form.listed} onChange={() => set('listed', !form.listed)} />
              <span className="text-xs text-zinc-500">{form.listed ? t('enabled') : t('disabled')}</span>
            </div>
            <p className="text-[11px] text-zinc-500">{t('earth_listed_help')}</p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="earth-time-mode" className="inline-block text-xs text-zinc-400">{t('earth_time')}</label>
            <div className="flex gap-2">
              <select id="earth-time-mode" className="input" value={fixedTime ? 'fixed' : 'real'}
                onChange={e => set('time', e.target.value === 'real' ? 'real' : '20:00')}>
                <option value="real">{t('earth_time_real')}</option>
                <option value="fixed">{t('earth_time_fixed')}</option>
              </select>
              {fixedTime && (
                <input aria-label={t('earth_time_fixed')} className={`input w-24 ${timeOk ? '' : 'border-red-400'}`}
                  value={form.time} placeholder="HH:MM" onChange={e => set('time', e.target.value)} />
              )}
            </div>
            {fixedTime && (
              <div className="flex gap-2 items-center">
                <label htmlFor="earth-speed" className="text-xs text-zinc-400">{t('earth_time_speed')}</label>
                <select id="earth-speed" className="input w-auto" value={SPEEDS.includes(form.timeSpeed) ? form.timeSpeed : 'custom'}
                  onChange={e => { if (e.target.value !== 'custom') set('timeSpeed', Number(e.target.value)) }}>
                  <option value={0}>{t('earth_speed_0')}</option>
                  <option value={1}>{t('earth_speed_1')}</option>
                  <option value={60}>{t('earth_speed_60')}</option>
                  {!SPEEDS.includes(form.timeSpeed) && <option value="custom">×{form.timeSpeed}</option>}
                </select>
              </div>
            )}
            {def(defaults.time === 'real' ? t('earth_time_real') : defaults.time)}
          </div>

          <div className="space-y-1.5">
            <label htmlFor="earth-weather" className="inline-block text-xs text-zinc-400">{t('earth_weather')}</label>
            <select id="earth-weather" className="input" value={form.weather}
              onChange={e => set('weather', e.target.value as EarthWeather)}>
              {WEATHERS.map(w => <option key={w} value={w}>{t(`earth_weather_${w}`)}</option>)}
            </select>
            <p className="text-[11px] text-zinc-500">{t('earth_sky_manual_note')}</p>
            {def(t(`earth_weather_${defaults.weather}`))}
          </div>

          <details className="space-y-3">
            <summary className="text-xs text-zinc-400 cursor-pointer">{t('earth_advanced')}</summary>
            <div className="space-y-1.5 pt-2">
              <label htmlFor="earth-store" className="inline-block text-xs text-zinc-400">{t('earth_store_mb')}</label>
              <input id="earth-store" type="number" min={16} step={1} className="input" value={form.shareStoreMb} onChange={num('shareStoreMb')} />
              {def(defaults.shareStoreMb)}
            </div>
            <div className="space-y-1.5">
              <label htmlFor="earth-out" className="inline-block text-xs text-zinc-400">{t('earth_out_kbps')}</label>
              <input id="earth-out" type="number" min={16} step={1} className="input" value={form.shareOutKbps} onChange={num('shareOutKbps')} />
              {def(defaults.shareOutKbps)}
            </div>
            <div className="space-y-1.5">
              <label htmlFor="earth-meet" className="inline-block text-xs text-zinc-400">{t('earth_meet_m')}</label>
              <input id="earth-meet" type="number" min={0} step={100} className="input" value={form.meetM} onChange={num('meetM')} />
              <p className="text-[11px] text-zinc-500">{t('earth_meet_help')}</p>
              {def(defaults.meetM)}
            </div>
          </details>

          <p className="text-[11px] text-zinc-500">{t('earth_live_note')}</p>
          <div className="flex gap-2">
            <button type="submit" disabled={saving || !timeOk || !data.supportsSettings} className="btn-accent flex-1 justify-center disabled:opacity-40">
              {saving ? t('saving') : saved ? t('saved') : t('save_config')}
            </button>
            <button type="button" disabled={saving || !data.supportsSettings} onClick={() => save({})}
              className="btn-ghost justify-center disabled:opacity-40" title={t('earth_reset')} aria-label={t('earth_reset')}>
              <RotateCcw size={13} />
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

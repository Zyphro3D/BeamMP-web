import { useEffect, useState } from 'react'
import { Users, Package, Coffee, MessageSquare, Map } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useServerStatus } from '../hooks/useServerStatus'
import { api, type Mod, type ServerInfo } from '../lib/api'
import { isAuthenticated } from '../lib/auth'
import { ThemeToggle } from '../components/ui/ThemeToggle'
import { LangToggle } from '../components/ui/LangToggle'
import { useI18n } from '../context/I18nContext'
import { desc } from '../lib/desc'

export function Home() {
  const [instanceId, setInstanceId] = useState('default')
  const status = useServerStatus(instanceId)
  const [mods, setMods] = useState<Mod[]>([])
  const [modsLoading, setModsLoading] = useState(true)
  const [info, setInfo] = useState<ServerInfo | null>(null)
  const auth = isAuthenticated()
  const { t, lang } = useI18n()

  useEffect(() => {
    // Fetch first instance id, then load mods for that instance
    api.instances().then(list => {
      const id = list[0]?.id ?? 'default'
      setInstanceId(id)
      api.activeMods(id).then(setMods).catch(() => {}).finally(() => setModsLoading(false))
    }).catch(() => {
      api.activeMods('default').then(setMods).catch(() => {}).finally(() => setModsLoading(false))
    })
    api.info().then(setInfo).catch(() => {})
  }, [])

  // activeMods endpoint already filters active=true, so all returned items are active
  const activeMap = mods.find((m) => m.type === 'map')
  const vehicles  = mods.filter((m) => m.type === 'vehicle')
  const otherMods = mods.filter((m) => m.type === 'mod')

  return (
    <div className="min-h-screen bg-surface text-zinc-800 dark:text-zinc-100">
      {/* Header */}
      <header className="border-b border-surface-border bg-surface-raised">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center shrink-0">
              <span className="text-white text-base font-bold">B</span>
            </div>
            <div>
              <p className="text-sm font-semibold text-zinc-900 dark:text-white">
                {status.serverName || 'BeamMP Server'}
              </p>
              <div className="flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${status.online ? 'bg-green-400' : 'bg-red-400'}`} />
                <span className={`text-[10px] font-medium ${status.online ? 'text-green-500 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
                  {status.online ? t('online') : t('offline')}
                </span>
                {status.maxPlayers > 0 && (
                  <span className="text-[10px] text-zinc-400 font-mono ml-1">
                    {status.playerCount}/{status.maxPlayers}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {info?.discordUrl && (
              <a href={info.discordUrl} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#5865F2]/15 text-[#7289da]
                           hover:bg-[#5865F2]/25 text-xs font-medium transition-colors">
                <MessageSquare size={13} />
                Discord
              </a>
            )}
            {info?.kofiUrl && (
              <a href={info.kofiUrl} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#FF5E5B]/10 text-[#FF5E5B]
                           hover:bg-[#FF5E5B]/20 text-xs font-medium transition-colors">
                <Coffee size={13} />
                Ko-fi
              </a>
            )}
            <LangToggle />
            <ThemeToggle />
            {auth ? (
              <Link to="/dashboard" className="btn-accent text-xs py-1.5 px-3">
                {t('dashboard')}
              </Link>
            ) : (
              <Link to="/login" className="btn-accent text-xs py-1.5 px-3">
                {t('connexion')}
              </Link>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8 space-y-8">

        {/* Server description */}
        {info?.serverDescription && (
          <p className="text-sm text-zinc-500 text-center">{info.serverDescription}</p>
        )}

        {/* Stats row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="card p-4">
            <div className="flex items-center gap-2 mb-1">
              <Users size={14} className="text-accent" />
              <span className="text-[11px] text-zinc-400 uppercase tracking-wider">{t('players')}</span>
            </div>
            <p className="text-2xl font-bold">
              {status.playerCount}
              {status.maxPlayers > 0 && (
                <span className="text-sm font-normal text-zinc-400"> / {status.maxPlayers}</span>
              )}
            </p>
          </div>

          <div className="card p-4">
            <div className="flex items-center gap-2 mb-1">
              <Map size={14} className="text-accent" />
              <span className="text-[11px] text-zinc-400 uppercase tracking-wider">{t('map')}</span>
            </div>
            <p className="text-sm font-semibold truncate">
              {status.mapName || status.map || '—'}
            </p>
          </div>

          <div className="card p-4">
            <div className="flex items-center gap-2 mb-1">
              <Package size={14} className="text-accent" />
              <span className="text-[11px] text-zinc-400 uppercase tracking-wider">{t('vehicles')}</span>
            </div>
            <p className="text-2xl font-bold">{modsLoading ? '—' : vehicles.length}</p>
          </div>

          <div className="card p-4">
            <div className="flex items-center gap-2 mb-1">
              <Package size={14} className="text-accent" />
              <span className="text-[11px] text-zinc-400 uppercase tracking-wider">{t('mods')}</span>
            </div>
            <p className="text-2xl font-bold">{modsLoading ? '—' : otherMods.length}</p>
          </div>
        </div>

        {/* Connected players */}
        {status.players.length > 0 && (
          <div className="card p-4">
            <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
              {t('connected_players')}
            </h2>
            <div className="flex flex-wrap gap-2">
              {status.players.map((p) => (
                <span key={p} className="px-2.5 py-1 bg-zinc-100 dark:bg-white/5 rounded-lg text-xs text-zinc-700 dark:text-zinc-300 font-medium">
                  {p}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Active map */}
        {activeMap && (
          <div>
            <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">{t('active_map')}</h2>
            <div className="card overflow-hidden">
              {activeMap.image ? (
                <img
                  src={`/images/${activeMap.image}`}
                  alt={activeMap.name}
                  className="w-full h-48 sm:h-64 object-cover"
                />
              ) : (
                <div className="w-full h-48 bg-surface-card flex items-center justify-center">
                  <Map size={32} className="text-zinc-400 dark:text-zinc-600" />
                </div>
              )}
              <div className="p-4">
                <p className="font-semibold">{activeMap.name}</p>
                {desc(activeMap.description, lang) && (
                  <p className="text-sm text-zinc-500 mt-1">{desc(activeMap.description, lang)}</p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Vehicles */}
        {vehicles.length > 0 && (
          <ModGrid title={t('vehicles')} mods={vehicles} lang={lang} />
        )}

        {/* Other mods */}
        {otherMods.length > 0 && (
          <ModGrid title={t('mods')} mods={otherMods} lang={lang} />
        )}

        {/* CTA */}
        {!auth && (
          <div className="card p-6 text-center space-y-3">
            <p className="text-sm text-zinc-500">{t('already_played')}</p>
            <div className="flex items-center justify-center gap-3">
              <Link to="/login" className="btn-accent text-sm">{t('connexion')}</Link>
              <Link to="/login?tab=request" className="btn-ghost text-sm">{t('request_account')}</Link>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

function ModGrid({ title, mods, lang }: { title: string; mods: Mod[]; lang: string }) {
  return (
    <div>
      <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">{title}</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
        {mods.map((mod) => (
          <div key={mod.id} className="card overflow-hidden">
            {mod.image ? (
              <img
                src={`/images/${mod.image}`}
                alt={mod.name}
                className="w-full h-28 object-cover"
              />
            ) : (
              <div className="w-full h-28 bg-surface-card flex items-center justify-center">
                <Package size={20} className="text-zinc-400 dark:text-zinc-600" />
              </div>
            )}
            <div className="p-3">
              <p className="text-xs font-semibold truncate">{mod.name}</p>
              {desc(mod.description, lang) && (
                <p className="text-[11px] text-zinc-500 truncate mt-0.5">{desc(mod.description, lang)}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

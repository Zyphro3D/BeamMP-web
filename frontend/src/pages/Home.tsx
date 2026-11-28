import { useEffect, useState } from 'react'
import { Users, Package, Coffee, MessageSquare, Map } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useServerStatus } from '../hooks/useServerStatus'
import { api, type CatalogItem, type InstanceInfo, type Mod, type ServerInfo, type ServerStatus } from '../lib/api'
import { isAuthenticated } from '../lib/auth'
import { ThemeToggle } from '../components/ui/ThemeToggle'
import { LangToggle } from '../components/ui/LangToggle'
import { useI18n } from '../context/I18nContext'
import { desc } from '../lib/desc'
import { ServerCatalog } from '../components/mods/ServerCatalog'

export function Home() {
  const [instanceId, setInstanceId] = useState('default')
  const status = useServerStatus(instanceId)
  const [mods, setMods] = useState<Mod[]>([])
  const [modsLoading, setModsLoading] = useState(true)
  const [info, setInfo] = useState<ServerInfo | null>(null)
  const [catalog, setCatalog] = useState<CatalogItem[]>([])
  const auth = isAuthenticated()
  const { t, lang } = useI18n()

  const [instances, setInstances] = useState<InstanceInfo[]>([])
  const [others, setOthers] = useState<Record<string, ServerStatus>>({})

  useEffect(() => {
    api.instances().then(list => {
      setInstances(list)
      setInstanceId(list[0]?.id ?? 'default')
    }).catch(() => {})
    api.info().then(setInfo).catch(() => {})
  }, [])

  // Mods et catalogue du serveur affiché
  useEffect(() => {
    setModsLoading(true)
    api.activeMods(instanceId).then(setMods).catch(() => setMods([])).finally(() => setModsLoading(false))
    api.catalog(instanceId).then(setCatalog).catch(() => setCatalog([]))
  }, [instanceId])

  // Plusieurs serveurs : l'état de chacun pour les onglets (celui affiché suit le flux en direct)
  useEffect(() => {
    if (instances.length < 2) return
    const poll = () => Promise.all(instances.map(i => api.instanceStatus(i.id).then(st => [i.id, st] as const).catch(() => null)))
      .then(rows => setOthers(Object.fromEntries(rows.filter(r => r !== null))))
    poll()
    const timer = setInterval(poll, 30_000)
    return () => clearInterval(timer)
  }, [instances])

  // activeMods endpoint already filters active=true, so all returned items are active
  // La carte que le serveur charge vraiment (`Map =`, dans status.map) : la base peut en garder une autre marquée
  // active quand le serveur tourne sur un niveau qui n'est pas une carte du panel (BeamNG.Earth, #4745).
  const levelOf = (id?: string | null) => (id ?? '').replace(/^\/?levels\//, '').replace(/\/(info\.json)?$/, '')
  const activeMap = mods.find((m) => m.type === 'map' && !!status.map && levelOf(m.map_id) === levelOf(status.map))
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

        {/* Plusieurs serveurs : un onglet chacun */}
        {instances.length > 1 && (
          <nav aria-label={t('servers_title')} className="flex flex-wrap gap-2">
            {instances.map(inst => {
              const st = inst.id === instanceId ? status : others[inst.id]
              const selected = inst.id === instanceId
              return (
                <button key={inst.id} type="button" onClick={() => setInstanceId(inst.id)} aria-pressed={selected}
                  className={`card px-3 py-2 flex items-center gap-2 text-sm transition-colors
                              ${selected ? 'ring-2 ring-accent' : 'hover:bg-zinc-100 dark:hover:bg-white/5'}`}>
                  <span className={`w-2 h-2 rounded-full ${st?.online ? 'bg-green-400' : 'bg-red-400'}`} aria-hidden />
                  <span className="font-medium">{st?.serverName && st.serverName !== 'BeamMP Server' ? st.serverName : inst.name}</span>
                  <span className="sr-only">{st?.online ? t('online') : t('offline')}</span>
                  {st && st.maxPlayers > 0 && (
                    <span className="text-[11px] text-zinc-500 font-mono">{st.playerCount}/{st.maxPlayers}</span>
                  )}
                </button>
              )
            })}
          </nav>
        )}

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

        {/* Catalogue complet du serveur (lecture seule) */}
        <ServerCatalog items={catalog} />

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
                src={`/images/thumb/${mod.image}`}
                alt={mod.name}
                loading="lazy"
                decoding="async"
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

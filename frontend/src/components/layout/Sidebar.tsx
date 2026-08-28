import { useEffect, useState } from 'react'
import { LayoutDashboard, Package, Map, Users, Upload, Settings, LogOut, Shield, MessageSquare, ScanSearch, FolderInput, KeyRound, SlidersHorizontal } from 'lucide-react'
import { useServerStatus } from '../../hooks/useServerStatus'
import { getStoredUser, clearAuth } from '../../lib/auth'
import { useNavigate } from 'react-router-dom'
import { ThemeToggle } from '../ui/ThemeToggle'
import { LangToggle } from '../ui/LangToggle'
import { Avatar } from '../ui/Avatar'
import { useI18n } from '../../context/I18nContext'
import { api, type ServerInfo } from '../../lib/api'
import { formatUptimeMs } from '../../lib/format'
import { ChangePasswordModal } from './ChangePasswordModal'

export type AdminSection =
  | 'dashboard' | 'mods' | 'maps' | 'players'
  | 'upload' | 'config' | 'presets' | 'admin' | 'consistency' | 'import'

interface Props {
  section: AdminSection
  onSection: (s: AdminSection) => void
  modCount?: number
  instanceId?: string
}

export function Sidebar({ section, onSection, modCount, instanceId = 'default' }: Props) {
  const status = useServerStatus(instanceId)
  const user = getStoredUser()
  const navigate = useNavigate()
  const { t } = useI18n()
  const [info, setInfo] = useState<ServerInfo | null>(null)
  const [changingPassword, setChangingPassword] = useState(false)
  useEffect(() => { api.info().then(setInfo).catch(() => {}) }, [])

  const logout = async () => {
    await api.logout().catch(() => {})
    clearAuth()
    navigate('/')
  }

  const nav = (s: AdminSection, icon: React.ReactNode, label: string, count?: number) => (
    <button onClick={() => onSection(s)} className={`nav-item w-full text-left ${section === s ? 'active' : ''}`}>
      <span className="shrink-0">{icon}</span>
      <span className="flex-1">{label}</span>
      {count !== undefined && (
        <span className="text-[11px] font-semibold bg-zinc-100 dark:bg-white/8 text-zinc-500 dark:text-zinc-400 px-1.5 py-0.5 rounded-md">
          {count}
        </span>
      )}
    </button>
  )

  return (
    <aside className="w-52 shrink-0 h-screen sticky top-0 bg-surface-raised border-r border-surface-border flex flex-col overflow-hidden">
      {/* Logo */}
      <div className="p-4 border-b border-surface-border">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center shrink-0">
            <span className="text-white text-base font-bold">B</span>
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-zinc-900 dark:text-white truncate">
              {status.serverName || 'BeamMP Panel'}
            </p>
            <p className="text-[10px] text-zinc-400 dark:text-zinc-500">BeamMP-Web v2</p>
          </div>
        </div>
      </div>

      {/* Status */}
      <div className="px-4 py-2.5 border-b border-surface-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${status.online ? 'bg-green-400' : 'bg-red-400'}`} />
            <span className={`text-xs font-medium ${status.online ? 'text-green-500 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
              {status.online ? t('online') : t('offline')}
            </span>
          </div>
          {status.maxPlayers > 0 && (
            <span className="text-xs text-zinc-400 font-mono">
              {status.playerCount} / {status.maxPlayers}
            </span>
          )}
        </div>
        {status.uptimeMs && status.uptimeMs > 0 && (
          <p className="text-[10px] text-zinc-400 dark:text-zinc-600 mt-0.5">
            {t('uptime')} {formatUptimeMs(status.uptimeMs)}
          </p>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
        <p className="section-label mt-2">{t('nav_management')}</p>
        {nav('dashboard', <LayoutDashboard size={15} />, t('nav_dashboard'))}
        {nav('mods',      <Package  size={15} />, t('nav_mods'), modCount)}
        {nav('maps',      <Map      size={15} />, t('nav_maps'))}
        {nav('players',   <Users    size={15} />, t('nav_players'))}

        <p className="section-label mt-4">{t('nav_administration')}</p>
        {(user?.role === 'superadmin' || user?.role === 'admin') && nav('upload', <Upload     size={15} />, t('nav_upload'))}
        {(user?.role === 'superadmin' || user?.role === 'admin') && nav('config', <Settings   size={15} />, t('nav_config'))}
        {(user?.role === 'superadmin' || user?.role === 'admin') && nav('presets', <SlidersHorizontal size={15} />, t('nav_presets'))}
        {(user?.role === 'superadmin' || user?.role === 'admin') && nav('consistency', <ScanSearch size={15} />, t('nav_consistency'))}
        {(user?.role === 'superadmin' || user?.role === 'admin') && nav('import', <FolderInput size={15} />, t('nav_import'))}
        {user?.role === 'superadmin' && nav('admin', <Shield size={15} />, t('nav_admin'))}

        {info?.discordUrl && (
          <div className="mt-3">
            <a href={info.discordUrl} target="_blank" rel="noopener noreferrer"
              className="nav-item w-full text-left text-[#7289da] hover:bg-[#5865F2]/10">
              <MessageSquare size={15} className="shrink-0" />
              <span className="flex-1">Discord</span>
            </a>
          </div>
        )}
      </nav>

      {/* User */}
      <div className="p-3 border-t border-surface-border">
        <div className="flex items-center gap-2">
          {user && <Avatar name={user.username} />}
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-zinc-700 dark:text-zinc-200 truncate">{user?.username}</p>
            <p className="text-[10px] text-zinc-400 dark:text-zinc-600 truncate">{user?.role}</p>
          </div>
          <LangToggle />
          <ThemeToggle />
          <button onClick={() => setChangingPassword(true)} title={t('change_password')} aria-label={t('change_password')}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-white/5 transition-colors shrink-0">
            <KeyRound size={14} />
          </button>
          <button onClick={logout} title={t('nav_logout')}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-red-500/10 transition-colors shrink-0">
            <LogOut size={14} />
          </button>
        </div>
      </div>
      {changingPassword && <ChangePasswordModal onClose={() => setChangingPassword(false)} />}
    </aside>
  )
}

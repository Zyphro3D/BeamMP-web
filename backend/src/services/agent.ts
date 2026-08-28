import type { InstanceConfig } from '../config'

/**
 * Client pour beammp-agent (/opt/beammp-agent/beammp-agent.py) — daemon HTTP
 * qui tourne sur l'hôte (hors Docker) et redémarre le service systemd du
 * serveur BeamMP via `sudo systemctl restart`, avec une whitelist de
 * services autorisés côté agent. Voir cybersecurity-expert.md.
 */
export async function restartViaAgent(inst: InstanceConfig): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!inst.agent) {
    return { ok: false, error: 'beammp-agent non configuré pour cette instance (BEAMMP_AGENT_URL/TOKEN/SERVICE)' }
  }

  try {
    const res = await fetch(`${inst.agent.url}/restart`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${inst.agent.token}`,
      },
      body:   JSON.stringify({ service: inst.agent.service }),
      signal: AbortSignal.timeout(35_000), // l'agent laisse jusqu'à 30s à systemctl
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      return { ok: false, error: body.error ?? `HTTP ${res.status}` }
    }

    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'beammp-agent injoignable' }
  }
}

// ── Mise à jour du serveur BeamMP ────────────────────────────────────────────

const GITHUB_RELEASES_URL = 'https://api.github.com/repos/BeamMP/BeamMP-Server/releases/latest'

interface GithubAsset {
  name: string
  browser_download_url: string
  digest: string | null // "sha256:<hex>"
}
interface GithubRelease {
  tag_name: string
  html_url: string
  assets: GithubAsset[]
}

export interface UpdateCheckResult {
  enabled:         boolean
  currentVersion:  string | null
  latestVersion:   string | null
  updateAvailable: boolean
  releaseUrl:      string | null
  error?:          string
}

function extractSemver(raw: string): string | null {
  const m = raw.match(/v?(\d+\.\d+\.\d+)/)
  return m ? m[1] : null
}

// Cache court (évite de cogner l'API GitHub — 60 req/h non-authentifiée — à
// chaque ouverture de l'onglet Configuration) et de rappeler l'agent pour la
// version installée à chaque poll.
const updateCache = new Map<string, { data: UpdateCheckResult; ts: number }>()
const UPDATE_CACHE_TTL_MS = 10 * 60 * 1000

export async function checkForUpdate(inst: InstanceConfig): Promise<UpdateCheckResult> {
  if (!inst.agent || !inst.agent.asset) {
    return { enabled: false, currentVersion: null, latestVersion: null, updateAvailable: false, releaseUrl: null }
  }

  const cached = updateCache.get(inst.id)
  if (cached && Date.now() - cached.ts < UPDATE_CACHE_TTL_MS) return cached.data

  const result = await fetchUpdateInfo(inst)
  updateCache.set(inst.id, { data: result, ts: Date.now() })
  return result
}

async function fetchUpdateInfo(inst: InstanceConfig): Promise<UpdateCheckResult> {
  const agent = inst.agent!
  try {
    const [versionRes, releaseRes] = await Promise.all([
      fetch(`${agent.url}/version`, {
        headers: { Authorization: `Bearer ${agent.token}` },
        signal:  AbortSignal.timeout(10_000),
      }),
      fetch(GITHUB_RELEASES_URL, { signal: AbortSignal.timeout(10_000) }),
    ])

    if (!versionRes.ok) {
      const body = await versionRes.json().catch(() => ({ error: `HTTP ${versionRes.status}` }))
      return { enabled: true, currentVersion: null, latestVersion: null, updateAvailable: false, releaseUrl: null, error: body.error ?? `HTTP ${versionRes.status}` }
    }
    if (!releaseRes.ok) {
      return { enabled: true, currentVersion: null, latestVersion: null, updateAvailable: false, releaseUrl: null, error: `GitHub API: HTTP ${releaseRes.status}` }
    }

    const { version: rawVersion } = await versionRes.json() as { version: string }
    const release = await releaseRes.json() as GithubRelease
    const currentVersion = extractSemver(rawVersion)
    const latestVersion  = extractSemver(release.tag_name)
    const asset = release.assets.find(a => a.name === `BeamMP-Server.${agent.asset}`)

    if (!asset) {
      return { enabled: true, currentVersion, latestVersion, updateAvailable: false, releaseUrl: release.html_url, error: `Aucun asset "BeamMP-Server.${agent.asset}" dans la dernière release` }
    }

    return {
      enabled: true,
      currentVersion,
      latestVersion,
      updateAvailable: !!currentVersion && !!latestVersion && currentVersion !== latestVersion,
      releaseUrl: release.html_url,
    }
  } catch (err) {
    return { enabled: true, currentVersion: null, latestVersion: null, updateAvailable: false, releaseUrl: null, error: err instanceof Error ? err.message : 'Vérification impossible' }
  }
}

export async function updateViaAgent(inst: InstanceConfig): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  if (!inst.agent || !inst.agent.asset) {
    return { ok: false, error: 'Mise à jour non configurée pour cette instance (BEAMMP_AGENT_ASSET manquant)' }
  }
  const agent = inst.agent

  const releaseRes = await fetch(GITHUB_RELEASES_URL, { signal: AbortSignal.timeout(10_000) }).catch(() => null)
  if (!releaseRes || !releaseRes.ok) {
    return { ok: false, error: 'Impossible de contacter GitHub pour récupérer la dernière release' }
  }
  const release = await releaseRes.json() as GithubRelease
  const asset = release.assets.find(a => a.name === `BeamMP-Server.${agent.asset}`)
  if (!asset || !asset.digest?.startsWith('sha256:')) {
    return { ok: false, error: `Asset "BeamMP-Server.${agent.asset}" introuvable ou sans empreinte sha256 dans la dernière release` }
  }

  try {
    const res = await fetch(`${agent.url}/update-server`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${agent.token}`,
      },
      body: JSON.stringify({
        service:      agent.service,
        download_url: asset.browser_download_url,
        sha256:       asset.digest.slice('sha256:'.length),
      }),
      signal: AbortSignal.timeout(180_000), // téléchargement + install + restart
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      return { ok: false, error: body.error ?? `HTTP ${res.status}` }
    }

    updateCache.delete(inst.id) // force un re-check après une mise à jour réussie
    return { ok: true, version: release.tag_name }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'beammp-agent injoignable' }
  }
}

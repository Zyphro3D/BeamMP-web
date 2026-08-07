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

import type { FastifyInstance } from 'fastify'
import { getServerStatus } from '../services/beammp'
import { getActivity } from '../services/activity'
import { db } from '../db'
import { config } from '../config'

const startedAt = new Date()

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  // List of instances (public — name + id + capabilities)
  app.get('/api/instances', async () =>
    config.instances.map(i => ({
      id:         i.id,
      name:       i.name,
      canRestart: i.agent !== null,
    }))
  )

  // Per-instance server status
  app.get<{ Params: { instanceId: string } }>('/api/i/:instanceId/status', async (req) => {
    const inst = config.instances.find(i => i.id === req.params.instanceId)
    if (!inst) return { online: false, playerCount: 0, maxPlayers: 0, players: [], map: '', mapName: '', serverName: '', uptimeMs: 0 }
    const status = await getServerStatus(inst)
    return { ...status, uptimeMs: Date.now() - startedAt.getTime() }
  })

  // Per-instance SSE stream
  app.get<{ Params: { instanceId: string } }>('/api/i/:instanceId/stream', async (req, reply) => {
    const inst = config.instances.find(i => i.id === req.params.instanceId)
    reply.raw.setHeader('Content-Type', 'text/event-stream')
    reply.raw.setHeader('Cache-Control', 'no-cache')
    reply.raw.setHeader('Connection', 'keep-alive')
    reply.raw.flushHeaders()

    const send = async () => {
      const status = inst
        ? await getServerStatus(inst)
        : { online: false, playerCount: 0, maxPlayers: 0, players: [], map: '', mapName: '', serverName: '', uptimeMs: 0 }
      reply.raw.write(`data: ${JSON.stringify({ ...status, uptimeMs: Date.now() - startedAt.getTime() })}\n\n`)
    }

    await send()
    const interval = setInterval(send, 10_000)
    req.raw.on('close', () => clearInterval(interval))
  })

  // Per-instance active mods (public)
  app.get<{ Params: { instanceId: string } }>('/api/i/:instanceId/mods/active', async (req) => {
    const result = await db.query(
      `SELECT id, name, type, image, description, map_id
       FROM mods WHERE instance_id = $1 AND active = true ORDER BY type, name`,
      [req.params.instanceId]
    )
    return result.rows
  })

  // Per-instance activity (public)
  app.get<{ Params: { instanceId: string } }>('/api/i/:instanceId/activity', async (req) =>
    getActivity(req.params.instanceId, 15)
  )

  // Public server info (global)
  app.get('/api/info', async () => ({
    discordUrl:        config.discord.serverUrl,
    kofiUrl:           config.public.kofiUrl,
    serverDescription: config.public.serverDescription,
  }))

  // Legacy routes → redirect to first instance (backward compat)
  app.get('/api/status', async () => {
    const inst = config.instances[0]
    const status = await getServerStatus(inst)
    return { ...status, uptimeMs: Date.now() - startedAt.getTime() }
  })

  app.get('/api/stream', async (req, reply) => {
    const inst = config.instances[0]
    reply.raw.setHeader('Content-Type', 'text/event-stream')
    reply.raw.setHeader('Cache-Control', 'no-cache')
    reply.raw.setHeader('Connection', 'keep-alive')
    reply.raw.flushHeaders()

    const send = async () => {
      const status = await getServerStatus(inst)
      reply.raw.write(`data: ${JSON.stringify({ ...status, uptimeMs: Date.now() - startedAt.getTime() })}\n\n`)
    }
    await send()
    const interval = setInterval(send, 10_000)
    req.raw.on('close', () => clearInterval(interval))
  })

  app.get('/api/mods/active', async () => {
    const inst = config.instances[0]
    const result = await db.query(
      `SELECT id, name, type, image, description, map_id
       FROM mods WHERE instance_id = $1 AND active = true ORDER BY type, name`,
      [inst.id]
    )
    return result.rows
  })

  app.get('/api/activity', async () => getActivity(config.instances[0].id, 15))
}

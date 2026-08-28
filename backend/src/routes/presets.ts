import type { FastifyInstance, FastifyReply } from 'fastify'
import { db } from '../db'
import { requireAuth, requireAdmin } from '../middleware/auth'
import { getInstance } from '../lib/getInstance'
import { setModActive, activateMap } from '../lib/modState'
import { invalidateCache } from '../services/beammp'
import { logActivity } from '../services/activity'
import { sendDiscordNotification } from '../services/discord'
import { restartViaAgent } from '../services/agent'

/**
 * Configs pré-établies : nom + liste de mods/véhicules à activer + une carte.
 * "Appliquer" bascule l'état actif à exactement ce que décrit la config
 * (désactive tout le reste), active la carte, puis tente un redémarrage —
 * l'objectif est un changement de scénario en un clic plutôt qu'une série
 * de bascules manuelles. Les mods/véhicules référencés qui n'existent plus
 * (supprimés depuis la sauvegarde de la config) sont silencieusement
 * ignorés : une config ne doit jamais devenir inutilisable parce qu'un seul
 * de ses mods a disparu.
 */
export async function presetsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { instanceId: string } }>(
    '/api/i/:instanceId/presets',
    { preHandler: requireAuth },
    async (req, reply) => {
      const inst = getInstance(req.params.instanceId, reply)
      if (!inst) return
      const result = await db.query(
        'SELECT * FROM config_presets WHERE instance_id = $1 ORDER BY name',
        [inst.id]
      )
      return result.rows
    }
  )

  app.post<{ Params: { instanceId: string }; Body: { name: string; mod_ids: number[]; map_id?: string | null } }>(
    '/api/i/:instanceId/presets',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const inst = getInstance(req.params.instanceId, reply)
      if (!inst) return
      const { name, mod_ids, map_id } = req.body
      if (!name || !name.trim()) return reply.code(400).send({ error: 'name is required' })
      if (!Array.isArray(mod_ids) || mod_ids.some(id => !Number.isInteger(id))) {
        return reply.code(400).send({ error: 'mod_ids must be an array of integers' })
      }
      try {
        const result = await db.query(
          `INSERT INTO config_presets (instance_id, name, mod_ids, map_id)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [inst.id, name.trim(), mod_ids, map_id || null]
        )
        return result.rows[0]
      } catch (e: unknown) {
        const err = e as { code?: string }
        if (err.code === '23505') return reply.code(409).send({ error: `Une config nommée "${name}" existe déjà` })
        throw e
      }
    }
  )

  app.put<{ Params: { instanceId: string; id: string }; Body: { name: string; mod_ids: number[]; map_id?: string | null } }>(
    '/api/i/:instanceId/presets/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const inst = getInstance(req.params.instanceId, reply)
      if (!inst) return
      const { name, mod_ids, map_id } = req.body
      if (!name || !name.trim()) return reply.code(400).send({ error: 'name is required' })
      if (!Array.isArray(mod_ids) || mod_ids.some(id => !Number.isInteger(id))) {
        return reply.code(400).send({ error: 'mod_ids must be an array of integers' })
      }
      try {
        const result = await db.query(
          `UPDATE config_presets SET name = $1, mod_ids = $2, map_id = $3
           WHERE id = $4 AND instance_id = $5 RETURNING *`,
          [name.trim(), mod_ids, map_id || null, req.params.id, inst.id]
        )
        if (!result.rows[0]) return reply.code(404).send({ error: 'Not found' })
        return result.rows[0]
      } catch (e: unknown) {
        const err = e as { code?: string }
        if (err.code === '23505') return reply.code(409).send({ error: `Une config nommée "${name}" existe déjà` })
        throw e
      }
    }
  )

  app.delete<{ Params: { instanceId: string; id: string } }>(
    '/api/i/:instanceId/presets/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const inst = getInstance(req.params.instanceId, reply)
      if (!inst) return
      const result = await db.query(
        'DELETE FROM config_presets WHERE id = $1 AND instance_id = $2 RETURNING id',
        [req.params.id, inst.id]
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Not found' })
      return { deleted: true }
    }
  )

  app.post<{ Params: { instanceId: string; id: string } }>(
    '/api/i/:instanceId/presets/:id/apply',
    {
      preHandler: requireAdmin,
      // Déclenche potentiellement un redémarrage — même prudence que
      // /server/restart directement.
      config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
    },
    async (req, reply: FastifyReply) => {
      const inst = getInstance(req.params.instanceId, reply)
      if (!inst) return

      const presetRes = await db.query(
        'SELECT * FROM config_presets WHERE id = $1 AND instance_id = $2',
        [req.params.id, inst.id]
      )
      const preset = presetRes.rows[0]
      if (!preset) return reply.code(404).send({ error: 'Not found' })

      // Ne considère que les mods/véhicules qui existent encore — une config
      // ne bloque jamais sur un mod supprimé depuis sa sauvegarde.
      const existingRes = await db.query(
        `SELECT id FROM mods WHERE instance_id = $1 AND type IN ('mod', 'vehicle')`,
        [inst.id]
      )
      const existingIds: number[] = existingRes.rows.map((r: { id: number }) => r.id)
      const wantedIds = new Set<number>(preset.mod_ids.filter((id: number) => existingIds.includes(id)))
      const missingCount = preset.mod_ids.length - wantedIds.size

      for (const id of existingIds) {
        await setModActive(inst, id, wantedIds.has(id))
      }

      let mapApplied: string | null = null
      let mapError: string | null = null
      if (preset.map_id) {
        const mapResult = await activateMap(inst, preset.map_id)
        if (mapResult.ok) mapApplied = String(mapResult.map.name)
        else mapError = mapResult.error
      }

      invalidateCache(inst.id)
      logActivity(inst.id, 'preset_applied', `Config appliquée : ${preset.name}`)
      await sendDiscordNotification('preset_applied', `Config **${preset.name}** appliquée${mapApplied ? ` — carte : **${mapApplied}**` : ''}`)

      let restarted = false
      let restartError: string | null = null
      if (inst.agent) {
        const restartResult = await restartViaAgent(inst)
        if (restartResult.ok) restarted = true
        else restartError = restartResult.error
      }

      return {
        applied: preset.name,
        modsActivated: wantedIds.size,
        modsMissing: missingCount,
        mapApplied,
        mapError,
        restarted,
        restartError,
        needsRestart: !restarted,
      }
    }
  )
}

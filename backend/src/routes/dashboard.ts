import type { FastifyInstance, FastifyReply } from 'fastify'
import path from 'path'
import fs from 'fs'
import { db } from '../db'
import { config } from '../config'
import { requireAuth, requireAdmin } from '../middleware/auth'
import { sendDiscordNotification } from '../services/discord'
import { invalidateCache } from '../services/beammp'
import { restartViaAgent, checkForUpdate, updateViaAgent } from '../services/agent'
import { getActiveCriticalAlerts } from '../services/logWatcher'
import { getInstance } from '../lib/getInstance'
import { extractZipPreviewImage } from '../lib/zipPreview'
import { setModActive, activateMap } from '../lib/modState'
import StreamZip from 'node-stream-zip'
import { logActivity } from '../services/activity'
import {
  readFile, readFileAsync, writeFile, uploadFile, deleteFile, ensureDir,
} from '../services/fileService'
import sharp from 'sharp'

const IMAGES = config.localImagesPath  // always local Docker volume

// Whitelist shared by GET (filter) and PATCH (validate) so the panel can
// never leak or write a ServerConfig.toml key outside this list. Tags/Debug
// are safe to expose (cosmetic / diagnostic). Port, AuthKey, IP,
// ResourceFolder, InformationPacket and AllowGuests stay OUT deliberately:
// a typo there breaks connectivity or leaks the server's BeamMP AuthKey —
// see cybersecurity-expert.md.
const ALLOWED_CONFIG_KEYS = ['Name', 'Description', 'MaxPlayers', 'MaxCars', 'Private', 'LogChat', 'Tags', 'Debug']

// ── Route registration ─────────────────────────────────────────

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {

  // ── Mods ────────────────────────────────────────────────────

  app.get<{ Params: { instanceId: string } }>(
    '/api/i/:instanceId/mods',
    { preHandler: requireAuth },
    async (req) => {
      const result = await db.query(
        'SELECT * FROM mods WHERE instance_id = $1 ORDER BY type, name',
        [req.params.instanceId]
      )
      return result.rows
    }
  )

  app.post<{ Params: { instanceId: string } }>(
    '/api/i/:instanceId/mods/upload',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const inst = getInstance(req.params.instanceId, reply)
      if (!inst) return

      const data = await req.file()
      if (!data) return reply.code(400).send({ error: 'No file' })

      const fields   = data.fields as Record<string, { value: string }>
      const name     = fields.name?.value
      const type     = fields.type?.value as 'mod' | 'vehicle' | 'map'
      const desc     = fields.description?.value ?? ''
      const map_id   = fields.map_id?.value ?? null

      if (!name || !type) return reply.code(400).send({ error: 'name and type are required' })

      // Validate file extension
      const ext = path.extname(data.filename).toLowerCase()
      if (!['.zip', '.pak'].includes(ext)) {
        return reply.code(400).send({ error: 'Seuls les fichiers .zip et .pak sont autorisés' })
      }

      const buffer = await data.toBuffer()

      // Validate magic bytes: ZIP/PAK must start with PK\x03\x04 (ZIP signature)
      if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4B ||
          buffer[2] !== 0x03 || buffer[3] !== 0x04) {
        return reply.code(400).send({ error: 'Fichier invalide : le contenu ne correspond pas à une archive ZIP/PAK valide' })
      }

      const destDir = path.join(inst.beammp.resourcesPath, 'Client')
      ensureDir(destDir)

      // Sanitise filename: only alphanum, dot, hyphen, underscore — no path separators
      const safeFilename = path.basename(data.filename).replace(/[^a-zA-Z0-9._-]/g, '_')
      if (!safeFilename || safeFilename.startsWith('.')) {
        return reply.code(400).send({ error: 'Nom de fichier invalide' })
      }

      // Check the DB *before* touching the filesystem — writing first would
      // silently overwrite an existing mod's file on a filename collision.
      const existingMod = await db.query(
        'SELECT id FROM mods WHERE instance_id = $1 AND filename = $2',
        [inst.id, safeFilename]
      )
      if (existingMod.rows.length > 0) {
        return reply.code(409).send({ error: `Un mod avec le fichier "${safeFilename}" existe déjà` })
      }

      const destPath = path.join(destDir, safeFilename)
      uploadFile(destPath, buffer)

      // Best-effort: reuse the same preview-image conventions as Scan & Import
      // so a manual upload doesn't require a follow-up image edit when the zip
      // already ships one (preview.jpg, icon.png, vehicles/<name>/*.jpg, …).
      let imageFilename: string | null = null
      try {
        const zip = new StreamZip.async({ file: destPath })
        try {
          const entries = await zip.entries()
          imageFilename = await extractZipPreviewImage(zip, entries, IMAGES, path.parse(safeFilename).name, inst.id)
        } finally {
          await zip.close()
        }
      } catch { /* not a browsable archive — no preview, non-critical */ }

      const descJson = desc ? JSON.stringify({ fr: desc }) : null

      // Maps: only one can be active at a time — new maps start inactive if one already exists
      let startActive = true
      if (type === 'map') {
        const existing = await db.query(
          `SELECT id FROM mods WHERE instance_id = $1 AND type = 'map' AND active = true LIMIT 1`,
          [inst.id]
        )
        if (existing.rows.length > 0) startActive = false
      }

      const result = await db.query(
        `INSERT INTO mods (instance_id, name, type, filename, description, active, map_id, image)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8) RETURNING *`,
        [inst.id, name, type, safeFilename, descJson, startActive, map_id, imageFilename]
      )

      logActivity(inst.id, 'mod_upload', `Mod uploadé · ${name}`)
      await sendDiscordNotification('mod_upload', `**${name}** (${type}) uploadé par un admin`)
      return result.rows[0]
    }
  )

  app.post<{ Params: { instanceId: string; id: string } }>(
    '/api/i/:instanceId/mods/:id/toggle',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const inst = getInstance(req.params.instanceId, reply)
      if (!inst) return

      // Maps have exactly one "active" slot managed by /maps/activate — a
      // plain toggle would leave the DB with 0 or 2+ active maps, exactly
      // the inconsistency the consistency-scan endpoint exists to catch.
      const typeCheck = await db.query('SELECT type, active FROM mods WHERE id = $1 AND instance_id = $2', [req.params.id, inst.id])
      if (!typeCheck.rows[0]) return reply.code(404).send({ error: 'Not found' })
      if (typeCheck.rows[0].type === 'map') {
        return reply.code(400).send({ error: 'Use /maps/activate to change the active map instead of toggling it' })
      }

      const mod = await setModActive(inst, Number(req.params.id), !typeCheck.rows[0].active)
      if (!mod) return reply.code(404).send({ error: 'Not found' })
      return { ...mod, needsRestart: true }
    }
  )

  app.delete<{ Params: { instanceId: string; id: string } }>(
    '/api/i/:instanceId/mods/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const inst = getInstance(req.params.instanceId, reply)
      if (!inst) return

      const check = await db.query(
        'SELECT * FROM mods WHERE id = $1 AND instance_id = $2',
        [req.params.id, inst.id]
      )
      if (!check.rows[0]) return reply.code(404).send({ error: 'Not found' })
      if (check.rows[0].is_official) return reply.code(403).send({ error: 'Cannot delete an official mod/map' })

      await db.query('DELETE FROM mods WHERE id = $1 AND instance_id = $2', [req.params.id, inst.id])
      const mod = check.rows[0]
      deleteFile(path.join(inst.beammp.resourcesPath, 'Client',       mod.filename))
      deleteFile(path.join(inst.beammp.resourcesPath, 'inactive_mod', mod.filename))
      deleteFile(path.join(inst.beammp.resourcesPath, 'inactive_map', mod.filename))
      if (mod.image) deleteFile(path.join(IMAGES, mod.image))
      return { deleted: true }
    }
  )

  app.patch<{ Params: { instanceId: string; id: string } }>(
    '/api/i/:instanceId/mods/:id/official',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const inst = getInstance(req.params.instanceId, reply)
      if (!inst) return
      const result = await db.query(
        'UPDATE mods SET is_official = NOT is_official WHERE id = $1 AND instance_id = $2 RETURNING *',
        [req.params.id, req.params.instanceId]
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Not found' })
      return result.rows[0]
    }
  )

  // ── Description JSONB (PATCH une langue) ────────────────────

  app.patch<{ Params: { instanceId: string; id: string } }>(
    '/api/i/:instanceId/mods/:id/description',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const inst = getInstance(req.params.instanceId, reply)
      if (!inst) return
      const { lang, text } = req.body as { lang: string; text: string }
      if (!lang || !/^[a-z]{2,5}$/.test(lang)) {
        return reply.code(400).send({ error: 'lang must be a 2-5 char code (fr, en, de…)' })
      }
      const result = await db.query(
        `UPDATE mods
         SET description = CASE
           WHEN $2 = '' THEN COALESCE(description, '{}'::jsonb) - $1
           ELSE COALESCE(description, '{}'::jsonb) || jsonb_build_object($1::text, $2)
         END
         WHERE id = $3 AND instance_id = $4 RETURNING *`,
        [lang, text ?? '', req.params.id, req.params.instanceId]
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Not found' })
      return result.rows[0]
    }
  )

  // ── Mod image ────────────────────────────────────────────────

  app.post<{ Params: { instanceId: string; id: string } }>(
    '/api/i/:instanceId/mods/:id/image',
    {
      preHandler: requireAdmin,
      // `id` feeds a filesystem path below — force it numeric so it can never
      // carry a path-traversal segment.
      schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: '^[0-9]+$' } } } },
    },
    async (req, reply) => {
      const data = await req.file()
      if (!data) return reply.code(400).send({ error: 'No file' })

      const imgName = `${req.params.id}.webp`
      const buffer  = await data.toBuffer()
      let webp: Buffer
      try {
        webp = await sharp(buffer).resize(400, 400, { fit: 'cover' }).webp({ quality: 80 }).toBuffer()
      } catch {
        return reply.code(400).send({ error: 'Fichier image invalide' })
      }
      // Images are always stored locally (Docker volume) regardless of instance mode
      if (!fs.existsSync(IMAGES)) fs.mkdirSync(IMAGES, { recursive: true })
      fs.writeFileSync(path.join(IMAGES, imgName), webp)

      const result = await db.query(
        'UPDATE mods SET image = $1 WHERE id = $2 AND instance_id = $3 RETURNING id',
        [imgName, req.params.id, req.params.instanceId]
      )
      if (!result.rows[0]) {
        fs.unlinkSync(path.join(IMAGES, imgName))
        return reply.code(404).send({ error: 'Not found' })
      }
      return { image: imgName }
    }
  )

  // ── Maps ────────────────────────────────────────────────────

  app.post<{ Params: { instanceId: string }; Body: { map_id: string } }>(
    '/api/i/:instanceId/maps/activate',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const inst = getInstance(req.params.instanceId, reply)
      if (!inst) return

      const { map_id } = req.body
      const result = await activateMap(inst, map_id)
      if (!result.ok) return reply.code(404).send({ error: result.error })

      invalidateCache(inst.id)
      logActivity(inst.id, 'map_change', `Carte changée → ${result.map.name}`)
      await sendDiscordNotification('map_change', `Nouvelle carte active : **${result.map.name}**`)
      return { activated: map_id, needsRestart: true }
    }
  )

  // ── Config ──────────────────────────────────────────────────

  app.get<{ Params: { instanceId: string } }>(
    '/api/i/:instanceId/config',
    { preHandler: requireAuth },
    async (req, reply) => {
      const inst = getInstance(req.params.instanceId, reply)
      if (!inst) return

      const content = readFile(inst.beammp.configPath)
      if (!content) return reply.code(404).send({ error: 'ServerConfig.toml not found or empty' })
      const entries: Record<string, string> = {}
      for (const line of content.split('\n')) {
        const m = line.match(/^(\w+)\s*=\s*(.+)$/)
        // Same whitelist as the PATCH below — ServerConfig.toml can hold a
        // BeamMP AuthKey or other values that must never reach the client.
        if (m && ALLOWED_CONFIG_KEYS.includes(m[1])) entries[m[1]] = m[2].replace(/^[\"']|[\"']$/g, '').trim()
      }
      return entries
    }
  )

  app.patch<{ Params: { instanceId: string }; Body: Record<string, string> }>(
    '/api/i/:instanceId/config',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const inst = getInstance(req.params.instanceId, reply)
      if (!inst) return

      for (const key of Object.keys(req.body)) {
        if (!ALLOWED_CONFIG_KEYS.includes(key)) {
          return reply.code(400).send({ error: `Clé de configuration non autorisée : ${key}` })
        }
      }

      let content = readFile(inst.beammp.configPath)
      if (!content) return reply.code(404).send({ error: 'ServerConfig.toml not found' })
      for (const [key, rawValue] of Object.entries(req.body)) {
        // Strip \r\n — otherwise a value could inject a whole new TOML line
        // (e.g. a bogus AuthKey) past the key whitelist above.
        // U+2028/U+2029 are line terminators for JS's /m regex flag (used to
        // re-match this key on a future PATCH) though not for TOML itself —
        // stripped anyway so a relecture never desyncs from what's on disk.
        const value   = String(rawValue).replace(/[\r\n\u2028\u2029]/g, '')
        const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        const re = new RegExp(`^${key}\\s*=\\s*.+$`, 'm')
        if (re.test(content)) {
          content = content.replace(re, `${key} = "${escaped}"`)
        } else {
          // Key absent from the file — append it instead of silently no-op'ing
          // (the caller gets { updated: true } either way, it must be true).
          content = content.trimEnd() + `\n${key} = "${escaped}"\n`
        }
      }
      writeFile(inst.beammp.configPath, content)
      invalidateCache(inst.id)
      return { updated: true }
    }
  )

  // ── Logs ────────────────────────────────────────────────────

  app.get<{ Params: { instanceId: string }; Querystring: { lines?: string } }>(
    '/api/i/:instanceId/logs',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const inst = getInstance(req.params.instanceId, reply)
      if (!inst) return

      const content = await readFileAsync(inst.beammp.logPath)
      if (!content) return { lines: [] }
      const parsed = parseInt(req.query.lines ?? '100', 10)
      const n = Number.isFinite(parsed) && parsed > 0 ? parsed : 100
      const all = content.split('\n').filter(Boolean)
      return { lines: all.slice(-n) }
    }
  )

  // Alertes critiques détectées dans Server.log (ex. AuthKey invalide) —
  // lecture seule, ouverte à tous les rôles comme le reste des données de
  // statut (cf. GET /api/admin/players).
  app.get<{ Params: { instanceId: string } }>(
    '/api/i/:instanceId/alerts',
    { preHandler: requireAuth },
    async (req, reply) => {
      const inst = getInstance(req.params.instanceId, reply)
      if (!inst) return
      return getActiveCriticalAlerts(inst.id)
    }
  )

  // ── Server restart ───────────────────────────────────────────
  // Passe par beammp-agent (daemon systemd sur l'hôte, hors Docker) —
  // seul moyen d'atteindre systemctl depuis un conteneur. 501 si l'agent
  // n'est pas configuré pour cette instance (BEAMMP_AGENT_*/AGENT_SERVICE).

  app.post<{ Params: { instanceId: string } }>(
    '/api/i/:instanceId/server/restart',
    {
      preHandler: requireAdmin,
      // A compromised admin session (XSS, stolen cookie) shouldn't be able
      // to flap the game server in a loop — same rationale as the login limit.
      config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
    },
    async (req, reply: FastifyReply) => {
      const inst = getInstance(req.params.instanceId, reply)
      if (!inst) return
      if (!inst.agent) {
        return reply.code(501).send({
          error: 'beammp-agent non configuré pour cette instance — voir BEAMMP_AGENT_URL/TOKEN/SERVICE dans .env',
        })
      }

      const result = await restartViaAgent(inst)
      if (!result.ok) {
        return reply.code(502).send({ error: result.error })
      }

      logActivity(inst.id, 'server_restart', 'Serveur redémarré')
      await sendDiscordNotification('server_restart', `Le serveur **${inst.name}** a été redémarré`)
      return { restarted: true }
    }
  )

  // ── Server update ─────────────────────────────────────────────
  // Vérifie/installe la dernière release BeamMP-Server officielle via
  // beammp-agent. Désactivé (enabled:false / 501) si BEAMMP_AGENT_ASSET
  // n'est pas configuré pour cette instance.

  app.get<{ Params: { instanceId: string } }>(
    '/api/i/:instanceId/server/update-check',
    { preHandler: requireAdmin },
    async (req, reply: FastifyReply) => {
      const inst = getInstance(req.params.instanceId, reply)
      if (!inst) return
      return checkForUpdate(inst)
    }
  )

  app.post<{ Params: { instanceId: string } }>(
    '/api/i/:instanceId/server/update',
    {
      preHandler: requireAdmin,
      // Télécharge et remplace un binaire système — même prudence que le
      // redémarrage, avec une marge en plus pour laisser le temps de cliquer
      // deux fois par erreur sans relancer un téléchargement de ~12 Mo.
      config: { rateLimit: { max: 2, timeWindow: '5 minute' } },
    },
    async (req, reply: FastifyReply) => {
      const inst = getInstance(req.params.instanceId, reply)
      if (!inst) return
      if (!inst.agent || !inst.agent.asset) {
        return reply.code(501).send({
          error: 'Mise à jour non configurée pour cette instance — voir BEAMMP_AGENT_ASSET dans .env',
        })
      }

      const result = await updateViaAgent(inst)
      if (!result.ok) {
        return reply.code(502).send({ error: result.error })
      }

      logActivity(inst.id, 'server_update', `Serveur mis à jour vers ${result.version}`)
      await sendDiscordNotification('server_update', `Le serveur **${inst.name}** a été mis à jour vers **${result.version}**`)
      return { updated: true, version: result.version }
    }
  )
}

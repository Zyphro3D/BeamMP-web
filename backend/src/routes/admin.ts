import type { FastifyInstance, FastifyReply } from 'fastify'
import path from 'path'
import fs from 'fs'
import StreamZip from 'node-stream-zip'
import sharp from 'sharp'
import { db } from '../db'
import { config } from '../config'
import { requireAuth, requireAdmin, requireSuperAdmin } from '../middleware/auth'
import { getInstance } from '../lib/getInstance'
import { hashPassword } from './auth'
import { listDir, moveFile, deleteFile, fileExists, ensureDir } from '../services/fileService'

// ── Scan-import helpers ────────────────────────────────────────────────────────

function cleanFilename(filename: string): string {
  return filename
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function findPreviewEntry(entries: string[]): string | null {
  const lower = entries.map(e => e.toLowerCase())
  const patterns: Array<(e: string) => boolean> = [
    e => /\/preview\.(jpg|jpeg|png|webp)$/.test(e),
    e => /\/icon\.(jpg|jpeg|png|webp)$/.test(e),
    // vehicle default skin — exclude license plates and templates
    e => /\/default\.(jpg|jpeg)$/.test(e) && !e.includes('licenseplate') && !e.includes('template'),
    // any jpg/png directly inside vehicles/<name>/
    e => /^vehicles\/[^/]+\/[^/]+\.jpg$/.test(e) && !e.includes('licenseplate'),
    // any jpg/png directly inside levels/<name>/
    e => /^levels\/[^/]+\/[^/]+\.(jpg|png)$/.test(e),
  ]
  for (const pattern of patterns) {
    const idx = lower.findIndex(e => pattern(e))
    if (idx >= 0) return entries[idx]
  }
  return null
}

interface ZipAnalysis {
  name:          string
  type:          'mod' | 'vehicle' | 'map'
  imageFilename: string | null
}

async function analyzeZip(
  zipPath:    string,
  defaultDir: 'client' | 'inactive_mod' | 'inactive_map',
  imagesDir:  string,
  baseName:   string,
): Promise<ZipAnalysis> {
  const zip = new StreamZip.async({ file: zipPath })
  try {
    const entries    = await zip.entries()
    const entryNames = Object.keys(entries)
    const lower      = entryNames.map(e => e.toLowerCase())

    // ── Type detection ──────────────────────────────────────────
    let type: 'mod' | 'vehicle' | 'map' = defaultDir === 'inactive_map' ? 'map' : 'mod'
    if (lower.some(e => e.startsWith('levels/'))) type = 'map'
    // `vehicles/common/...` holds shared parts (wheels, engines, textures) reusable by any
    // vehicle, and packs that only add parts/configs to an EXISTING stock vehicle (engine
    // swaps, wheel packs) reuse that vehicle's folder name too — neither defines a new
    // vehicle. BeamNG only ships a bare `info.json` (not `info_<variant>.json`) at the root
    // of a vehicle's own folder, so its presence is what actually signals "this zip defines
    // a selectable vehicle".
    else if (lower.some(e => /^vehicles\/(?!common\/)[^/]+\/info\.json$/.test(e))) type = 'vehicle'

    // ── Name from info.json ─────────────────────────────────────
    let name = cleanFilename(baseName)
    const infoEntry = entryNames.find(e => {
      const l = e.toLowerCase()
      return l.endsWith('/info.json') || l === 'info.json'
    })
    if (infoEntry) {
      try {
        const raw     = (await zip.entryData(infoEntry)).toString('utf8')
        // BeamNG uses trailing commas and // comments — strip them
        const cleaned = raw.replace(/,(\s*[}\]])/g, '$1').replace(/\/\/[^\n]*/g, '')
        const data    = JSON.parse(cleaned)
        const n       = data.Name ?? data.name
        if (typeof n === 'string' && n.trim()) name = n.trim()
      } catch { /* fallback to filename */ }
    }

    // ── Preview image ───────────────────────────────────────────
    let imageFilename: string | null = null
    const previewEntry = findPreviewEntry(entryNames)
    if (previewEntry) {
      try {
        const imgData = await zip.entryData(previewEntry)
        const destName = `${baseName.replace(/[^a-zA-Z0-9._-]/g, '_')}.webp`
        const destPath = path.join(imagesDir, destName)
        await sharp(imgData)
          .resize(400, 300, { fit: 'cover' })
          .webp({ quality: 85 })
          .toFile(destPath)
        imageFilename = destName
      } catch { /* no image, not critical */ }
    }

    return { name, type, imageFilename }
  } finally {
    await zip.close()
  }
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // ── Account requests ──────────────────────────────────────────
  app.get('/api/admin/requests', { preHandler: requireSuperAdmin }, async () => {
    const result = await db.query(
      `SELECT ar.*, kp.connection_count, kp.first_seen, kp.last_seen
       FROM account_requests ar
       LEFT JOIN known_players kp ON kp.beammp_username = ar.beammp_username
       ORDER BY ar.requested_at DESC`
    )
    return result.rows
  })

  app.post<{
    Params: { id: string }
    Body: { action: 'approve' | 'reject'; password?: string }
  }>(
    '/api/admin/requests/:id',
    { preHandler: requireSuperAdmin },
    async (req, reply) => {
      const { action, password } = req.body
      const requestRow = await db.query(
        'SELECT * FROM account_requests WHERE id = $1',
        [req.params.id]
      )
      const request = requestRow.rows[0]
      if (!request) return reply.code(404).send({ error: 'Not found' })
      if (request.status !== 'pending') {
        return reply.code(409).send({ error: 'Already processed' })
      }

      const reviewer = req.user as { id: number }

      if (action === 'approve') {
        if (!password || password.length < 8) {
          return reply.code(400).send({ error: 'Password required (min 8 chars)' })
        }
        const hash = await hashPassword(password)
        // Least privilege: self-service accounts start as moderator
        // (read-only). Promotion to admin is a deliberate SuperAdmin action
        // via PATCH /api/admin/users/:id/role, not the default.
        const inserted = await db.query(
          `INSERT INTO users (username, password, role) VALUES ($1, $2, 'moderator')
           ON CONFLICT (username) DO NOTHING RETURNING id`,
          [request.beammp_username, hash]
        )
        if (inserted.rows.length === 0) {
          // Username already taken — the ON CONFLICT swallowed the insert.
          // Don't mark the request approved, the player still can't log in.
          return reply.code(409).send({ error: `Le nom d'utilisateur "${request.beammp_username}" est déjà pris` })
        }
        await db.query(
          `UPDATE account_requests
           SET status = 'approved', reviewed_by = $1, reviewed_at = NOW()
           WHERE id = $2`,
          [reviewer.id, req.params.id]
        )
        return { approved: request.beammp_username }
      } else {
        await db.query(
          `UPDATE account_requests
           SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW()
           WHERE id = $2`,
          [reviewer.id, req.params.id]
        )
        return { rejected: request.beammp_username }
      }
    }
  )

  // ── Known players ─────────────────────────────────────────────
  app.get<{ Querystring: { instanceId?: string } }>(
    '/api/admin/players',
    { preHandler: requireSuperAdmin },
    async (req) => {
      // instanceId optional for back-compat — defaults to the first instance,
      // same pattern as the legacy routes in public.ts.
      const instanceId = req.query.instanceId ?? config.instances[0].id
      // "Top players" = ranked by playtime, not by recency — sorting here
      // and capping at 200 means the frontend never has to re-sort, and a
      // veteran player who hasn't connected in a while doesn't fall out of
      // the list just because 200 more-recent-but-shorter sessions exist.
      const result = await db.query(
        'SELECT * FROM known_players WHERE instance_id = $1 ORDER BY total_seconds DESC LIMIT 200',
        [instanceId]
      )
      return result.rows
    }
  )

  // ── User management ───────────────────────────────────────────
  app.get('/api/admin/users', { preHandler: requireSuperAdmin }, async () => {
    const result = await db.query(
      'SELECT id, username, role, created_at FROM users ORDER BY created_at'
    )
    return result.rows
  })

  app.patch<{
    Params: { id: string }
    Body: { role: string }
  }>(
    '/api/admin/users/:id/role',
    { preHandler: requireSuperAdmin },
    async (req, reply) => {
      const { role } = req.body
      if (!['superadmin', 'admin', 'moderator'].includes(role)) {
        return reply.code(400).send({ error: 'Invalid role' })
      }
      const result = await db.query(
        'UPDATE users SET role = $1 WHERE id = $2 RETURNING id, username, role',
        [role, req.params.id]
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Not found' })
      return result.rows[0]
    }
  )

  // Only way to fix a lost password before this was delete-then-recreate the
  // account (losing created_at/history) or editing the DB directly.
  app.patch<{
    Params: { id: string }
    Body: { password: string }
  }>(
    '/api/admin/users/:id/password',
    { preHandler: requireSuperAdmin },
    async (req, reply) => {
      const { password } = req.body
      if (!password || password.length < 8) {
        return reply.code(400).send({ error: 'Password required (min 8 chars)' })
      }
      const hash = await hashPassword(password)
      const result = await db.query(
        'UPDATE users SET password = $1 WHERE id = $2 RETURNING id, username, role',
        [hash, req.params.id]
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Not found' })
      return result.rows[0]
    }
  )

  app.delete<{ Params: { id: string } }>(
    '/api/admin/users/:id',
    { preHandler: requireSuperAdmin },
    async (req, reply) => {
      const me = req.user as { id: number }
      if (String(me.id) === req.params.id) {
        return reply.code(400).send({ error: 'Cannot delete yourself' })
      }
      await db.query('DELETE FROM users WHERE id = $1', [req.params.id])
      return { deleted: true }
    }
  )

  // ── Consistency check ─────────────────────────────────────────
  //
  // Scans the DB against the real filesystem and returns a list of
  // inconsistencies, each with a suggested automatic fix.
  //
  // Issue types:
  //  wrong_location  – mod active in DB but file in _inactive/ (or vice-versa)
  //  missing_file    – DB record exists but file not found anywhere
  //  orphan_file     – file on disk not referenced by any DB record
  //  missing_image   – image field in DB but image file missing
  //  orphan_image    – image file on disk not referenced by any DB record
  //  multiple_active_maps – more than one map has active=true

  app.get<{ Params: { instanceId: string } }>(
    '/api/admin/i/:instanceId/consistency',
    { preHandler: requireAuth },
    async (req, reply: FastifyReply) => {
      const inst = getInstance(req.params.instanceId, reply)
      if (!inst) return

      const clientDir      = path.join(inst.beammp.resourcesPath, 'Client')
      const inactiveModDir = path.join(inst.beammp.resourcesPath, 'inactive_mod')
      const inactiveMapDir = path.join(inst.beammp.resourcesPath, 'inactive_map')
      const imagesDir      = config.localImagesPath

      // ── 1. Gather DB state ────────────────────────────────────
      const { rows: dbMods } = await db.query(
        'SELECT * FROM mods WHERE instance_id = $1',
        [inst.id]
      )

      // ── 2. Gather filesystem state (parallel, non-blocking) ────
      const [clientFiles, inactiveModFiles, inactiveMapFiles, imageFiles] = await Promise.all([
        listDir(clientDir),
        listDir(inactiveModDir),
        listDir(inactiveMapDir),
        listDir(imagesDir),
      ])

      const clientSet      = new Set(clientFiles)
      const inactiveModSet = new Set(inactiveModFiles)
      const inactiveMapSet = new Set(inactiveMapFiles)
      const imageSet       = new Set(imageFiles)

      // Track which files are referenced by DB
      const referencedFiles  = new Set<string>()
      const referencedImages = new Set<string>()

      type Issue = {
        id: string
        type: 'wrong_location' | 'missing_file' | 'orphan_file' | 'missing_image' | 'orphan_image' | 'multiple_active_maps'
        severity: 'error' | 'warning'
        description: string
        fix?: string   // action key
        meta?: Record<string, string | number | boolean>
      }

      const issues: Issue[] = []

      // ── 3. Check each DB record ───────────────────────────────
      const activeMaps: typeof dbMods = []

      for (const mod of dbMods) {
        referencedFiles.add(mod.filename)
        if (mod.image) referencedImages.add(mod.image)

        // Maps officielles = intégrées au jeu, pas de fichier à gérer
        if (mod.is_official) {
          if (mod.type === 'map' && mod.active) activeMaps.push(mod)
          continue
        }

        const inClient      = clientSet.has(mod.filename)
        const inInactiveMod = inactiveModSet.has(mod.filename)
        const inInactiveMap = inactiveMapSet.has(mod.filename)
        const inInactive    = mod.type === 'map' ? inInactiveMap : inInactiveMod
        const inactiveDirName = mod.type === 'map' ? 'inactive_map' : 'inactive_mod'

        if (mod.type === 'map') {
          if (mod.active) activeMaps.push(mod)
        }

        // active ↔ Client/, inactive ↔ inactive_mod/ or inactive_map/
        if (mod.active && inInactive && !inClient) {
          issues.push({
            id:          `wrong_loc_active_${mod.id}`,
            type:        'wrong_location',
            severity:    'error',
            description: `"${mod.name}" est actif en BDD mais le fichier est dans ${inactiveDirName}/`,
            fix:         'move_to_client',
            meta:        { modId: mod.id, filename: mod.filename, inactiveDirName },
          })
        } else if (!mod.active && inClient && !inInactive) {
          issues.push({
            id:          `wrong_loc_inactive_${mod.id}`,
            type:        'wrong_location',
            severity:    'error',
            description: `"${mod.name}" est inactif en BDD mais le fichier est dans Client/`,
            fix:         'move_to_inactive',
            meta:        { modId: mod.id, filename: mod.filename, inactiveDirName },
          })
        } else if (!inClient && !inInactive) {
          issues.push({
            id:          `missing_file_${mod.id}`,
            type:        'missing_file',
            severity:    'error',
            description: `"${mod.name}" (${mod.filename}) introuvable ni dans Client/ ni dans ${inactiveDirName}/`,
            fix:         'delete_db_record',
            meta:        { modId: mod.id, filename: mod.filename, type: mod.type },
          })
        }

        // Image check
        if (mod.image && !imageSet.has(mod.image)) {
          issues.push({
            id:          `missing_image_${mod.id}`,
            type:        'missing_image',
            severity:    'warning',
            description: `Image de "${mod.name}" référencée en BDD (${mod.image}) mais fichier absent`,
            fix:         'clear_image_ref',
            meta:        { modId: mod.id, image: mod.image },
          })
        }
      }

      // ── 4. Multiple active maps ───────────────────────────────
      if (activeMaps.length > 1) {
        issues.push({
          id:          'multiple_active_maps',
          type:        'multiple_active_maps',
          severity:    'error',
          description: `${activeMaps.length} cartes marquées actives simultanément (${activeMaps.map(m => m.name).join(', ')}) — une seule devrait l'être`,
          fix:         'fix_multiple_active_maps',
          meta:        { keepId: activeMaps[0].id, ids: activeMaps.map(m => m.id).join(',') },
        })
      }

      // ── 5. Orphan files in Client/ ────────────────────────────
      for (const filename of clientFiles) {
        if (!referencedFiles.has(filename)) {
          issues.push({
            id:          `orphan_client_${filename}`,
            type:        'orphan_file',
            severity:    'warning',
            description: `Fichier orphelin dans Client/ : ${filename} (non référencé en BDD)`,
            fix:         'delete_orphan_file',
            meta:        { filename, location: 'client' },
          })
        }
      }

      // ── 6. Orphan files in inactive_mod/ ─────────────────────
      for (const filename of inactiveModFiles) {
        if (!referencedFiles.has(filename)) {
          issues.push({
            id:          `orphan_inactive_mod_${filename}`,
            type:        'orphan_file',
            severity:    'warning',
            description: `Fichier orphelin dans inactive_mod/ : ${filename} (non référencé en BDD)`,
            fix:         'delete_orphan_file',
            meta:        { filename, location: 'inactive_mod' },
          })
        }
      }

      // ── 7. Orphan files in inactive_map/ ─────────────────────
      for (const filename of inactiveMapFiles) {
        if (!referencedFiles.has(filename)) {
          issues.push({
            id:          `orphan_inactive_map_${filename}`,
            type:        'orphan_file',
            severity:    'warning',
            description: `Fichier orphelin dans inactive_map/ : ${filename} (non référencé en BDD)`,
            fix:         'delete_orphan_file',
            meta:        { filename, location: 'inactive_map' },
          })
        }
      }

      // ── 7. Orphan images ──────────────────────────────────────
      for (const img of imageFiles) {
        if (!referencedImages.has(img)) {
          issues.push({
            id:          `orphan_image_${img}`,
            type:        'orphan_image',
            severity:    'warning',
            description: `Image orpheline : ${img} (non référencée en BDD)`,
            fix:         'delete_orphan_image',
            meta:        { image: img },
          })
        }
      }

      return {
        instanceId: inst.id,
        scannedAt:  new Date().toISOString(),
        summary: {
          total:    issues.length,
          errors:   issues.filter(i => i.severity === 'error').length,
          warnings: issues.filter(i => i.severity === 'warning').length,
        },
        issues,
      }
    }
  )

  // ── Apply a single consistency fix ───────────────────────────
  //
  // Security note: `meta` is client-supplied and must never be trusted to
  // build filesystem paths directly (path traversal). Filenames for known
  // DB records are always re-derived server-side from `modId`. For orphan
  // files (no DB record to anchor on), the supplied name is reduced to a
  // safe basename and the resulting path is verified to stay within the
  // expected root before any filesystem operation.

  function safeBasename(name: unknown): string | null {
    if (typeof name !== 'string' || !name) return null
    const base = path.basename(name)
    if (!base || base !== name || base === '.' || base === '..') return null
    return base
  }

  function resolveWithin(root: string, name: string): string | null {
    const resolvedRoot = path.resolve(root)
    const target = path.resolve(resolvedRoot, name)
    if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) return null

    // Lexical containment isn't enough if a symlink inside the root points
    // outside it — nothing in the app writes such a symlink today, but this
    // is cheap insurance against that changing later.
    try {
      const realRoot   = fs.realpathSync(resolvedRoot)
      const realTarget = fs.realpathSync(target)
      if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) return null
    } catch {
      // Target doesn't exist yet — nothing to resolve, lexical check above stands.
    }
    return target
  }

  app.post<{
    Params: { instanceId: string }
    Body: { fix: string; meta: Record<string, string | number | boolean> }
  }>(
    '/api/admin/i/:instanceId/consistency/fix',
    { preHandler: requireAdmin },
    async (req, reply: FastifyReply) => {
      const inst = getInstance(req.params.instanceId, reply)
      if (!inst) return

      const { fix, meta } = req.body
      const clientDir = path.join(inst.beammp.resourcesPath, 'Client')

      switch (fix) {

        case 'move_to_client': {
          const { modId } = meta as { modId: number }
          const modRow = await db.query('SELECT * FROM mods WHERE id = $1 AND instance_id = $2', [modId, inst.id])
          const mod = modRow.rows[0]
          if (!mod) return reply.code(404).send({ error: 'Mod not found' })
          const inactiveDirName = mod.type === 'map' ? 'inactive_map' : 'inactive_mod'
          const src  = path.join(inst.beammp.resourcesPath, inactiveDirName, mod.filename)
          const dest = path.join(clientDir, mod.filename)
          if (fileExists(src)) moveFile(src, dest)
          await db.query('UPDATE mods SET active = true WHERE id = $1 AND instance_id = $2', [modId, inst.id])
          return { fixed: true, action: 'move_to_client', filename: mod.filename }
        }

        case 'move_to_inactive': {
          const { modId } = meta as { modId: number }
          const modRow = await db.query('SELECT * FROM mods WHERE id = $1 AND instance_id = $2', [modId, inst.id])
          const mod = modRow.rows[0]
          if (!mod) return reply.code(404).send({ error: 'Mod not found' })
          const inactiveDirName = mod.type === 'map' ? 'inactive_map' : 'inactive_mod'
          const destDir = path.join(inst.beammp.resourcesPath, inactiveDirName)
          const src     = path.join(clientDir, mod.filename)
          const dest    = path.join(destDir, mod.filename)
          if (fileExists(src)) {
            ensureDir(destDir)
            moveFile(src, dest)
          }
          await db.query('UPDATE mods SET active = false WHERE id = $1 AND instance_id = $2', [modId, inst.id])
          return { fixed: true, action: 'move_to_inactive', filename: mod.filename }
        }

        case 'delete_db_record': {
          const { modId } = meta as { modId: number }
          await db.query('DELETE FROM mods WHERE id = $1 AND instance_id = $2', [modId, inst.id])
          return { fixed: true, action: 'delete_db_record', modId }
        }

        case 'clear_image_ref': {
          const { modId } = meta as { modId: number }
          await db.query('UPDATE mods SET image = NULL WHERE id = $1 AND instance_id = $2', [modId, inst.id])
          return { fixed: true, action: 'clear_image_ref', modId }
        }

        case 'fix_multiple_active_maps': {
          const { keepId, ids } = meta as { keepId: number; ids: string }
          const allIds = ids.split(',').map(Number)
          const toDeactivate = allIds.filter(id => id !== keepId)
          for (const id of toDeactivate) {
            await db.query('UPDATE mods SET active = false WHERE id = $1 AND instance_id = $2', [id, inst.id])
          }
          return { fixed: true, action: 'fix_multiple_active_maps', deactivated: toDeactivate }
        }

        case 'delete_orphan_file': {
          const { filename, location } = meta as { filename: string; location: string }
          const locationMap: Record<string, string> = {
            client:       'Client',
            inactive_mod: 'inactive_mod',
            inactive_map: 'inactive_map',
          }
          const dir = locationMap[location]
          if (!dir) return reply.code(400).send({ error: `Unknown location: ${location}` })
          const safeName = safeBasename(filename)
          if (!safeName) return reply.code(400).send({ error: 'Invalid filename' })
          const filePath = resolveWithin(path.join(inst.beammp.resourcesPath, dir), safeName)
          if (!filePath) return reply.code(400).send({ error: 'Invalid path' })
          deleteFile(filePath)
          return { fixed: true, action: 'delete_orphan_file', filename: safeName }
        }

        case 'delete_orphan_image': {
          const { image } = meta as { image: string }
          const safeName = safeBasename(image)
          if (!safeName) return reply.code(400).send({ error: 'Invalid filename' })
          const imgPath = resolveWithin(config.localImagesPath, safeName)
          if (!imgPath) return reply.code(400).send({ error: 'Invalid path' })
          if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath)
          return { fixed: true, action: 'delete_orphan_image', image: safeName }
        }

        default:
          return reply.code(400).send({ error: `Unknown fix action: ${fix}` })
      }
    }
  )

  // ── Scan & Import ─────────────────────────────────────────────
  //
  // Scans Client/, inactive_mod/, inactive_map/ and creates DB entries
  // for every .zip not already registered.  Works in local mode only.
  // For each zip: reads central directory (fast, no full load), detects
  // type from internal structure, extracts name from info.json, extracts
  // a preview image if found.

  app.post<{ Params: { instanceId: string } }>(
    '/api/admin/i/:instanceId/scan-import',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const inst = getInstance(req.params.instanceId, reply)
      if (!inst) return

      type ScanResult = {
        filename: string
        name?:    string
        type?:    string
        active?:  boolean
        hasImage: boolean
        status:   'imported' | 'skipped' | 'error'
        error?:   string
      }

      const results: ScanResult[] = []
      const rp = inst.beammp.resourcesPath

      const dirs: Array<{ dir: string; active: boolean; dirKey: 'client' | 'inactive_mod' | 'inactive_map' }> = [
        { dir: path.join(rp, 'Client'),       active: true,  dirKey: 'client' },
        { dir: path.join(rp, 'inactive_mod'), active: false, dirKey: 'inactive_mod' },
        { dir: path.join(rp, 'inactive_map'), active: false, dirKey: 'inactive_map' },
      ]

      // One query for every already-known filename instead of one per file
      // in the scan loop below — same pattern already used by the
      // consistency-check endpoint.
      const existingRows = await db.query(
        'SELECT filename FROM mods WHERE instance_id = $1',
        [inst.id]
      )
      const existingFilenames = new Set<string>(existingRows.rows.map(r => r.filename))

      for (const { dir, active, dirKey } of dirs) {
        if (!fs.existsSync(dir)) continue
        const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.zip'))

        for (const filename of files) {
          if (existingFilenames.has(filename)) {
            results.push({ filename, hasImage: false, status: 'skipped' })
            continue
          }

          try {
            const baseName = filename.replace(/\.zip$/i, '')
            const analysis = await analyzeZip(
              path.join(dir, filename),
              dirKey,
              config.localImagesPath,
              baseName,
            )

            await db.query(
              `INSERT INTO mods (instance_id, name, type, filename, image, active)
               VALUES ($1,$2,$3,$4,$5,$6)
               ON CONFLICT (instance_id, filename) DO NOTHING`,
              [inst.id, analysis.name, analysis.type, filename, analysis.imageFilename, active]
            )
            existingFilenames.add(filename)

            results.push({
              filename,
              name:     analysis.name,
              type:     analysis.type,
              active,
              hasImage: !!analysis.imageFilename,
              status:   'imported',
            })
          } catch (err: any) {
            results.push({ filename, hasImage: false, status: 'error', error: err.message })
          }
        }
      }

      return {
        imported: results.filter(r => r.status === 'imported').length,
        skipped:  results.filter(r => r.status === 'skipped').length,
        errors:   results.filter(r => r.status === 'error').length,
        total:    results.length,
        results,
      }
    }
  )
}

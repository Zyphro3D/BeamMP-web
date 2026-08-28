import path from 'path'
import { db } from '../db'
import type { InstanceConfig } from '../config'
import { readFile, writeFile, moveFile, fileExists, ensureDir } from '../services/fileService'

/**
 * Bascule un mod/véhicule (jamais une carte, gérée à part par activateMap)
 * vers un état actif/inactif explicite, en déplaçant son fichier entre
 * Client/ et inactive_mod/ le cas échéant. Logique extraite de
 * `POST /mods/:id/toggle` pour être réutilisable par l'application d'une
 * config pré-établie (services/presets.ts), qui a besoin d'un état cible
 * précis plutôt que d'un simple NOT active.
 */
export async function setModActive(
  inst: InstanceConfig,
  modId: number,
  active: boolean,
): Promise<Record<string, unknown> | null> {
  const current = await db.query('SELECT * FROM mods WHERE id = $1 AND instance_id = $2', [modId, inst.id])
  const mod = current.rows[0]
  if (!mod || mod.type === 'map') return null
  if (mod.active === active) return mod // déjà dans l'état voulu, rien à faire

  const result = await db.query(
    'UPDATE mods SET active = $1 WHERE id = $2 AND instance_id = $3 RETURNING *',
    [active, modId, inst.id]
  )
  const updated = result.rows[0]

  const hasFile = !updated.is_official && updated.filename && !updated.filename.startsWith('__official__:')
  if (hasFile) {
    const activeDir   = path.join(inst.beammp.resourcesPath, 'Client')
    const inactiveDir = path.join(inst.beammp.resourcesPath, 'inactive_mod')
    ensureDir(inactiveDir)
    if (!updated.active) {
      const src = path.join(activeDir, updated.filename)
      if (fileExists(src)) moveFile(src, path.join(inactiveDir, updated.filename))
    } else {
      const src = path.join(inactiveDir, updated.filename)
      if (fileExists(src)) moveFile(src, path.join(activeDir, updated.filename))
    }
  }
  return updated
}

/**
 * Active une carte par son map_id : désactive l'ancienne (déplace son zip
 * vers inactive_map/ si elle en a un), active la nouvelle (déplace son zip
 * vers Client/), et met à jour `Map =` dans ServerConfig.toml. Logique
 * extraite de `POST /maps/activate` pour la même raison que setModActive
 * ci-dessus. Ne journalise rien (activité/Discord) — à la charge de
 * l'appelant, qui a le contexte pour un message pertinent.
 */
export async function activateMap(
  inst: InstanceConfig,
  mapId: string,
): Promise<{ ok: true; map: Record<string, unknown> } | { ok: false; error: string }> {
  const map = await db.query(
    `SELECT * FROM mods WHERE map_id = $1 AND type = 'map' AND instance_id = $2`,
    [mapId, inst.id]
  )
  if (!map.rows[0]) return { ok: false, error: 'Map not found' }

  const clientDir      = path.join(inst.beammp.resourcesPath, 'Client')
  const inactiveMapDir = path.join(inst.beammp.resourcesPath, 'inactive_map')

  const currentActive = await db.query(
    `SELECT * FROM mods WHERE type = 'map' AND active = true AND instance_id = $1 LIMIT 1`,
    [inst.id]
  )
  if (currentActive.rows[0]) {
    const cur = currentActive.rows[0]
    if (!cur.is_official && cur.filename && !cur.filename.startsWith('__official__:')) {
      const src = path.join(clientDir, cur.filename)
      if (fileExists(src)) {
        ensureDir(inactiveMapDir)
        moveFile(src, path.join(inactiveMapDir, cur.filename))
      }
    }
  }

  await db.query(`UPDATE mods SET active = false WHERE type = 'map' AND instance_id = $1`, [inst.id])
  await db.query('UPDATE mods SET active = true WHERE map_id = $1 AND instance_id = $2', [mapId, inst.id])

  const newMap = map.rows[0]
  if (!newMap.is_official && newMap.filename && !newMap.filename.startsWith('__official__:')) {
    const src = path.join(inactiveMapDir, newMap.filename)
    if (fileExists(src)) {
      ensureDir(clientDir)
      moveFile(src, path.join(clientDir, newMap.filename))
    }
  }

  const cfgPath = inst.beammp.configPath
  let content = readFile(cfgPath)
  if (content) {
    const mapValue = `/levels/${mapId}/info.json`
    if (/^Map\s*=/m.test(content)) {
      content = content.replace(/^Map\s*=.*$/m, `Map = "${mapValue}"`)
    } else {
      content = content.trimEnd() + `\nMap = "${mapValue}"\n`
    }
    writeFile(cfgPath, content)
  }

  return { ok: true, map: newMap }
}

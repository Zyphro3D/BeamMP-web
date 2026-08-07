/**
 * fileService — opérations fichiers locales.
 *
 * Tous les fichiers BeamMP sont accessibles via des volumes Docker montés
 * depuis l'hôte (Linux ou Windows). Les chemins passés aux fonctions sont
 * des chemins absolus dans le conteneur.
 */

import fs   from 'fs'
import path from 'path'

// ── Fichiers ───────────────────────────────────────────────────

export function readFile(filePath: string): string
export function readFile(filePath: string, binary: true): Buffer
export function readFile(filePath: string, binary = false): string | Buffer {
  if (!fs.existsSync(filePath)) return binary ? Buffer.alloc(0) : ''
  return binary ? fs.readFileSync(filePath) : fs.readFileSync(filePath, 'utf8')
}

// Async variant for GET /logs — polled every 5s while the Config tab is
// open. The sync readFile() above is fine for one-off reads (config forms,
// startup), but a blocking read+split of a large Server.log on a 5s timer,
// multiplied by every admin with that tab open, stalls the event loop for
// every other request in flight.
export async function readFileAsync(filePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}

export function writeFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, 'utf8')
}

export function uploadFile(destPath: string, buffer: Buffer): void {
  ensureDirSync(path.dirname(destPath))
  fs.writeFileSync(destPath, buffer)
}

export function deleteFile(filePath: string): void {
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
}

export function moveFile(src: string, dest: string): void {
  if (fs.existsSync(src)) {
    ensureDirSync(path.dirname(dest))
    fs.renameSync(src, dest)
  }
}

export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath)
}

export function ensureDir(dirPath: string): void {
  ensureDirSync(dirPath)
}

// Async + withFileTypes: no per-entry stat() syscall, and — unlike a sync
// listDir would — actually yields the event loop, so a Promise.all() of
// several of these (consistency scan, several hundred mods) runs in
// parallel instead of blocking every other request in the queue.
export async function listDir(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
    return entries.filter(e => e.isFile()).map(e => e.name)
  } catch {
    return []
  }
}

// ── Watch log ──────────────────────────────────────────────────

export function watchLog(
  logPath: string,
  onData:  (chunk: string) => void,
): () => void {
  if (!fs.existsSync(logPath)) console.warn(`[fileService] Log not found: ${logPath}`)

  let offset = 0
  try { offset = fs.statSync(logPath).size } catch { offset = 0 }

  const watcher = fs.watch(logPath, { persistent: false }, () => {
    try {
      const stat = fs.statSync(logPath)
      if (stat.size < offset) offset = 0
      const newBytes = stat.size - offset
      if (newBytes <= 0) return
      const buf = Buffer.alloc(newBytes)
      const fd  = fs.openSync(logPath, 'r')
      fs.readSync(fd, buf, 0, newBytes, offset)
      fs.closeSync(fd)
      offset = stat.size
      onData(buf.toString('utf8'))
    } catch (err) {
      console.error('[fileService] Log read error:', err)
    }
  })

  watcher.on('error', (err) => console.error('[fileService] Watch error:', err))
  return () => watcher.close()
}

// ── Helpers ────────────────────────────────────────────────────

function ensureDirSync(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true })
}

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

export function listDir(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return []
  return fs.readdirSync(dirPath).filter(f => {
    try { return fs.statSync(path.join(dirPath, f)).isFile() } catch { return false }
  })
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

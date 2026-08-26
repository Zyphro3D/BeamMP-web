import path from 'path'
import sharp from 'sharp'
import type StreamZip from 'node-stream-zip'

// Uncompressed size above which a "preview" entry is refused rather than
// decompressed — a zip bomb (a few KB of highly compressible data claiming
// to be a preview.jpg) could otherwise inflate to gigabytes in memory on the
// single Fastify process shared by every instance. No legitimate preview
// image needs anywhere close to this.
const MAX_PREVIEW_UNCOMPRESSED_SIZE = 20 * 1024 * 1024 // 20 MiB

export function findPreviewEntry(entries: string[]): string | null {
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

/** Extracts a preview image from a zip's known conventions and saves it as `<instanceId>_<baseName>.webp` in imagesDir. */
export async function extractZipPreviewImage(
  zip:        StreamZip.StreamZipAsync,
  entries:    Record<string, StreamZip.ZipEntry>,
  imagesDir:  string,
  baseName:   string,
  instanceId: string,
): Promise<string | null> {
  const entryNames = Object.keys(entries)
  const previewEntry = findPreviewEntry(entryNames)
  if (!previewEntry) return null
  // Uncompressed size is metadata from the zip's central directory — reading
  // it costs nothing and lets us reject an oversized entry before ever
  // calling entryData(), which would decompress it into memory regardless.
  if (entries[previewEntry].size > MAX_PREVIEW_UNCOMPRESSED_SIZE) return null
  try {
    const imgData  = await zip.entryData(previewEntry)
    // Instance-prefixed: imagesDir is a single shared volume across all
    // instances, and baseName alone (derived from the uploaded zip's name)
    // can collide between two different instances' mods of the same name.
    const safeBase = baseName.replace(/[^a-zA-Z0-9._-]/g, '_')
    const safeInst = instanceId.replace(/[^a-zA-Z0-9._-]/g, '_')
    const destName = `${safeInst}_${safeBase}.webp`
    const destPath = path.join(imagesDir, destName)
    await sharp(imgData)
      .resize(400, 300, { fit: 'cover' })
      .webp({ quality: 85 })
      .toFile(destPath)
    return destName
  } catch {
    return null // no valid preview image — not critical
  }
}

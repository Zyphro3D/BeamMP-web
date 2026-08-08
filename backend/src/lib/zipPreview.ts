import path from 'path'
import sharp from 'sharp'
import type StreamZip from 'node-stream-zip'

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

/** Extracts a preview image from a zip's known conventions and saves it as `<baseName>.webp` in imagesDir. */
export async function extractZipPreviewImage(
  zip:        StreamZip.StreamZipAsync,
  entryNames: string[],
  imagesDir:  string,
  baseName:   string,
): Promise<string | null> {
  const previewEntry = findPreviewEntry(entryNames)
  if (!previewEntry) return null
  try {
    const imgData  = await zip.entryData(previewEntry)
    const destName = `${baseName.replace(/[^a-zA-Z0-9._-]/g, '_')}.webp`
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

import type StreamZip from 'node-stream-zip'

// ── Types ───────────────────────────────────────────────────────────────────

export interface VehicleMeta {
  brand?:          string
  bodyStyle?:       string  // "Body Style" — Coupe/Sedan/Truck/SUV/…
  vehicleType?:     string  // "Type" — Car/Truck/…
  country?:         string
  derbyClass?:      string
  yearMin?:         number
  yearMax?:         number
  configCount:      number
  configurations:   string[] // e.g. "Street Drag (M)", "Rally (M)" — capped, see MAX_CONFIGS_LISTED
  drivetrains:      string[] // distinct values across configs: RWD/AWD/FWD/…
  fuelTypes:        string[] // distinct values across configs: Gasoline/Diesel/Electric/…
  transmissions:    string[]
  powerMin?:        number   // ch, across configs
  powerMax?:        number
  offRoadScoreMin?: number   // heuristique BeamNG, pas une vérité absolue — voir commentaire plus bas
  offRoadScoreMax?: number
}

export interface MapMeta {
  title?:       string
  description?: string
  sizeMeters?:  number  // largeur du terrain en mètres (levels/<name>/info.json → size[0])
  author?:      string
  tagLine?:     string  // résumé écrit par l'auteur, présent seulement si le mod vient du repository officiel BeamNG
  category?:    string
}

export interface OtherMeta {
  subtype: 'script' | 'sound' | 'ui' | 'prop' | 'unknown'
}

export interface ModMetadata {
  kind:     'vehicle' | 'map' | 'other'
  vehicle?: VehicleMeta
  map?:     MapMeta
  other?:   OtherMeta
}

// ── Lenient JSON (BeamNG's own files use trailing commas and // comments) ──

// BeamNG's game engine tolerates trailing commas and // line comments in its
// own JSON files (confirmed on real files from this server's mods — e.g.
// vehicles/dynamo/info.json ends several color entries with a trailing
// comma). Strict JSON.parse() rejects that outright, so every read here goes
// through this instead of failing on perfectly normal BeamNG data.
export function parseLenientJson(raw: string): unknown {
  const cleaned = raw
    .replace(/\/\/[^\n]*/g, '')
    .replace(/,(\s*[}\]])/g, '$1')
  return JSON.parse(cleaned)
}

// ── Guards ──────────────────────────────────────────────────────────────────

// info*.json files are a few KB in legitimate mods — this is generous
// headroom, not a working limit. Guards against a crafted entry claiming to
// be a tiny info.json while actually being huge (a cheap zip-bomb vector),
// consistent with the guard already used for preview images in zipPreview.ts.
const MAX_JSON_ENTRY_SIZE = 1 * 1024 * 1024

// A single vehicle mod can legitimately ship 20-30 configurations (seen on
// this server's own mods). Cap far above that so a pathological zip with
// thousands of tiny info_*.json entries can't turn analysis into a
// per-upload DoS, without ever affecting a normal mod.
const MAX_CONFIGS_SCANNED = 80
const MAX_CONFIGS_LISTED  = 12

async function readJsonEntry(
  zip:     StreamZip.StreamZipAsync,
  entries: Record<string, StreamZip.ZipEntry>,
  name:    string,
): Promise<Record<string, unknown> | null> {
  const entry = entries[name]
  if (!entry || entry.size > MAX_JSON_ENTRY_SIZE) return null
  try {
    const raw  = (await zip.entryData(name)).toString('utf8')
    const data = parseLenientJson(raw)
    return data && typeof data === 'object' ? data as Record<string, unknown> : null
  } catch {
    return null
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

// ── Vehicle ─────────────────────────────────────────────────────────────────

async function analyzeVehicle(
  zip:     StreamZip.StreamZipAsync,
  entries: Record<string, StreamZip.ZipEntry>,
): Promise<VehicleMeta | null> {
  const entryNames = Object.keys(entries)

  // BeamNG ships exactly one bare info.json (not info_<config>.json) at the
  // root of a vehicle's own folder — same signal already used by
  // admin.ts's scan-import to detect "this defines a selectable vehicle".
  const rootInfoName = entryNames.find(e => /^vehicles\/(?!common\/)[^/]+\/info\.json$/i.test(e))

  const meta: VehicleMeta = {
    configCount: 0, configurations: [], drivetrains: [], fuelTypes: [], transmissions: [],
  }

  if (rootInfoName) {
    const data = await readJsonEntry(zip, entries, rootInfoName)
    if (data) {
      meta.brand       = str(data.Brand)
      meta.bodyStyle    = str(data['Body Style'])
      meta.vehicleType  = str(data.Type)
      meta.country      = str(data.Country)
      meta.derbyClass   = str(data['Derby Class'])
      const years = data.Years
      if (years && typeof years === 'object') {
        meta.yearMin = num((years as Record<string, unknown>).min)
        meta.yearMax = num((years as Record<string, unknown>).max)
      }
    }
  }

  const vehicleDir = rootInfoName ? rootInfoName.slice(0, rootInfoName.lastIndexOf('/') + 1) : null
  const configEntries = (vehicleDir
    ? entryNames.filter(e => e.startsWith(vehicleDir) && /\/info_[^/]+\.json$/i.test(e))
    : entryNames.filter(e => /^vehicles\/[^/]+\/info_[^/]+\.json$/i.test(e))
  ).slice(0, MAX_CONFIGS_SCANNED)

  const drivetrains   = new Set<string>()
  const fuelTypes     = new Set<string>()
  const transmissions = new Set<string>()
  const configurations: string[] = []
  let powerMin: number | undefined, powerMax: number | undefined
  let offMin: number | undefined, offMax: number | undefined

  for (const entryName of configEntries) {
    const data = await readJsonEntry(zip, entries, entryName)
    if (!data) continue

    const configName = str(data.Configuration)
    if (configName) configurations.push(configName)

    const drivetrain = str(data.Drivetrain)
    if (drivetrain) drivetrains.add(drivetrain)
    const fuel = str(data['Fuel Type'])
    if (fuel) fuelTypes.add(fuel)
    const transmission = str(data.Transmission)
    if (transmission) transmissions.add(transmission)

    const power = num(data.Power)
    if (power !== undefined) {
      powerMin = powerMin === undefined ? power : Math.min(powerMin, power)
      powerMax = powerMax === undefined ? power : Math.max(powerMax, power)
    }
    // Score maison BeamNG, pas une mesure physique — un "Rally" peut scorer
    // aussi bas qu'un "Street Drag" du même véhicule (vérifié sur un mod réel
    // de ce serveur : 35 contre 33). À traiter comme un indice, jamais comme
    // une preuve de capacité tout-terrain.
    const offRoad = num(data['Off-Road Score'])
    if (offRoad !== undefined) {
      offMin = offMin === undefined ? offRoad : Math.min(offMin, offRoad)
      offMax = offMax === undefined ? offRoad : Math.max(offMax, offRoad)
    }
  }

  meta.configCount    = configurations.length
  meta.configurations = configurations.slice(0, MAX_CONFIGS_LISTED)
  meta.drivetrains    = [...drivetrains]
  meta.fuelTypes      = [...fuelTypes]
  meta.transmissions  = [...transmissions]
  meta.powerMin        = powerMin
  meta.powerMax        = powerMax
  meta.offRoadScoreMin = offMin
  meta.offRoadScoreMax = offMax

  const hasAnyData = meta.brand || meta.bodyStyle || meta.vehicleType || meta.configCount > 0
  return hasAnyData ? meta : null
}

// ── Map ─────────────────────────────────────────────────────────────────────

async function analyzeMap(
  zip:     StreamZip.StreamZipAsync,
  entries: Record<string, StreamZip.ZipEntry>,
): Promise<MapMeta | null> {
  const entryNames = Object.keys(entries)
  const levelInfoName = entryNames.find(e => /^levels\/[^/]+\/info\.json$/i.test(e))
  // Métadonnées du repository officiel BeamNG (repository.beammng.com) —
  // présentes uniquement si le mod a été téléchargé depuis là plutôt
  // qu'assemblé à la main ; absentes sans que ce soit une erreur.
  const modInfoName = entryNames.find(e => /^mod_info\/[^/]+\/info\.json$/i.test(e))

  const meta: MapMeta = {}

  if (levelInfoName) {
    const data = await readJsonEntry(zip, entries, levelInfoName)
    if (data) {
      meta.title       = str(data.title)
      meta.description = str(data.description)
      const size = data.size
      if (Array.isArray(size) && typeof size[0] === 'number') meta.sizeMeters = size[0]
    }
  }

  if (modInfoName) {
    const data = await readJsonEntry(zip, entries, modInfoName)
    if (data) {
      meta.author   = str(data.username) ?? meta.author
      meta.tagLine  = str(data.tag_line)
      meta.category = str(data.category_title)
      if (!meta.title) meta.title = str(data.title)
    }
  }

  const hasAnyData = meta.title || meta.sizeMeters !== undefined || meta.tagLine || meta.author
  return hasAnyData ? meta : null
}

// ── Other (scripts, sons, UI, décor) ─────────────────────────────────────────

function detectOtherSubtype(entryNames: string[]): OtherMeta {
  const lower = entryNames.map(e => e.toLowerCase())
  if (lower.some(e => e.includes('lua/ge/extensions/') || e.includes('lua/vehicle/extensions/'))) {
    return { subtype: 'script' }
  }
  if (lower.some(e => e.startsWith('art/sound/') || e.endsWith('.ogg'))) {
    return { subtype: 'sound' }
  }
  if (lower.some(e => e.includes('ui/entrypoints/') || e.includes('ui/modules/'))) {
    return { subtype: 'ui' }
  }
  if (lower.some(e => e.startsWith('art/shapes/')) &&
      !lower.some(e => e.startsWith('vehicles/') || e.startsWith('levels/'))) {
    return { subtype: 'prop' }
  }
  return { subtype: 'unknown' }
}

// ── Entrée principale ─────────────────────────────────────────────────────

// Best-effort : une archive inattendue ou un JSON illisible ne doit jamais
// faire échouer un upload ou un scan-import, juste renvoyer null (pas de
// badges affichés plutôt qu'une erreur remontée à l'admin).
export async function analyzeModContents(
  zip:     StreamZip.StreamZipAsync,
  entries: Record<string, StreamZip.ZipEntry>,
  type:    'mod' | 'vehicle' | 'map',
): Promise<ModMetadata | null> {
  try {
    if (type === 'vehicle') {
      const vehicle = await analyzeVehicle(zip, entries)
      return vehicle ? { kind: 'vehicle', vehicle } : null
    }
    if (type === 'map') {
      const map = await analyzeMap(zip, entries)
      return map ? { kind: 'map', map } : null
    }
    const other = detectOtherSubtype(Object.keys(entries))
    return other.subtype !== 'unknown' ? { kind: 'other', other } : null
  } catch {
    return null
  }
}

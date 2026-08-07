#!/usr/bin/env node
/**
 * Import TSV → PostgreSQL
 *
 * Lit players.tsv et mods.tsv (générés par mysqldump/mysql --batch)
 * et les insère dans la base PostgreSQL du panel BeamMP.
 *
 * Usage :
 *   cd migrate/
 *   npm install
 *   node import.js
 *
 * Les fichiers players.tsv et mods.tsv doivent être dans ce même dossier.
 */

const fs   = require('fs')
const path = require('path')
const { Pool } = require('pg')

// ── Charge .env ───────────────────────────────────────────────
try {
  const envPath = path.join(__dirname, '..', '.env')
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)\s*=\s*(.*)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
    }
  }
} catch { /* ignore */ }

const pg = new Pool({
  host:     process.env.POSTGRES_HOST     ?? 'localhost',
  port:     parseInt(process.env.POSTGRES_PORT ?? '5432'),
  user:     process.env.POSTGRES_USER     ?? 'beammp',
  password: process.env.POSTGRES_PASSWORD ?? 'beammp',
  database: process.env.POSTGRES_DB       ?? 'beammp',
})

// ── Helpers ───────────────────────────────────────────────────

/**
 * Parse un TSV sans en-tête (exporté avec --silent).
 * columns = noms de colonnes dans l'ordre exact du SELECT.
 * Toutes les lignes sont des données.
 */
function parseTsv(filePath, columns) {
  if (!fs.existsSync(filePath)) return null
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim())
  if (lines.length === 0) return { headers: columns, rows: [] }

  // Détecter si la première ligne ressemble à un en-tête MySQL (même valeurs que columns)
  const firstCells = lines[0].split('\t')
  const looksLikeHeader = columns.every((c, i) => firstCells[i]?.toLowerCase() === c.toLowerCase())
  const dataLines = looksLikeHeader ? lines.slice(1) : lines

  const rows = dataLines.map(l => {
    const values = l.split('\t')
    const obj = {}
    columns.forEach((h, i) => {
      const v = values[i] ?? ''
      obj[h] = (v === 'NULL' || v === '') ? null : v
    })
    return obj
  })
  return { headers: columns, rows }
}

function log(msg)  { console.log(`  ✓ ${msg}`) }
function warn(msg) { console.warn(`  ⚠  ${msg}`) }
function sep(t)    { console.log(`\n── ${t} ${'─'.repeat(45 - t.length)}`) }

function toInt(v, fallback = 0) {
  const n = parseInt(v ?? '')
  return isNaN(n) ? fallback : n
}

function toDate(v) {
  if (!v || v === 'NULL' || v === '0000-00-00 00:00:00') return null
  const d = new Date(v)
  return isNaN(d.getTime()) ? null : d
}

function toBool(v) {
  return v === '1' || v === 'true' || v === 1
}

// ── Import joueurs ────────────────────────────────────────────

async function importPlayers() {
  sep('Joueurs (known_players)')

  // Colonnes dans l'ordre exact du SELECT lors de l'export
  // Si votre export inclut last_disconnect, ajoutez-le ici dans le même ordre
  const COLS = ['username', 'connection_count', 'last_connect', 'last_disconnect', 'total_time']
  const data = parseTsv(path.join(__dirname, 'players.tsv'), COLS)
  if (!data) { warn('players.tsv introuvable — ignoré'); return }
  if (data.rows.length === 0) { warn('players.tsv vide'); return }

  console.log(`  Colonnes : ${data.headers.join(', ')}`)
  console.log(`  ${data.rows.length} ligne(s) à importer`)

  let ok = 0, skip = 0
  for (const r of data.rows) {
    if (!r.username) { skip++; continue }
    try {
      await pg.query(
        `INSERT INTO known_players (beammp_username, connection_count, first_seen, last_seen, total_seconds)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (beammp_username) DO UPDATE
           SET connection_count = EXCLUDED.connection_count,
               last_seen        = EXCLUDED.last_seen,
               total_seconds    = EXCLUDED.total_seconds`,
        [
          r.username,
          toInt(r.connection_count),
          toDate(r.last_connect) ?? new Date(),
          toDate(r.last_connect),
          toInt(r.total_time),
        ]
      )
      ok++
    } catch (e) {
      warn(`Joueur "${r.username}" ignoré : ${e.message}`)
      skip++
    }
  }
  log(`${ok} joueurs importés, ${skip} ignorés`)
}

// ── Résolution des descriptions JSON multilingues ─────────────

const DESC_DIR = path.join(__dirname, 'descriptions')
const PREF_LANGS = ['fr', 'en', 'de', 'es', 'it']

/**
 * Résout la description d'un mod en retournant un objet multilingue complet.
 * - Texte brut          → { fr: "texte" }
 * - Chemin vers un JSON → toutes les langues du fichier (ex: { fr: "...", en: "...", de: "..." })
 * - JSON inline         → toutes les langues
 * - Vide / introuvable  → null (pas de description)
 */
function resolveDescription(raw) {
  if (!raw) return null

  // Texte brut sans extension ni séparateur de chemin
  if (!raw.includes('.json') && !raw.includes('/') && !raw.includes('\\')) {
    return { fr: raw }
  }

  // Peut être du JSON inline (commençant par '{')
  if (raw.trim().startsWith('{')) {
    try { return JSON.parse(raw) } catch { return null }
  }

  // Chemin vers un fichier JSON → chercher dans ./descriptions/
  const filename = raw.replace(/^.*[\\/]/, '')
  const filepath = path.join(DESC_DIR, filename)

  if (!fs.existsSync(filepath)) {
    warn(`Description "${filename}" introuvable dans ${DESC_DIR}`)
    return null
  }

  try {
    const obj = JSON.parse(fs.readFileSync(filepath, 'utf8'))
    if (typeof obj === 'string') return { fr: obj }
    return obj
  } catch {
    warn(`Description "${filename}" : JSON invalide, ignoré`)
    return null
  }
}

// ── Import mods ───────────────────────────────────────────────

async function importMods() {
  sep('Mods / Maps / Véhicules')

  // Colonnes dans l'ordre exact du SELECT lors de l'export
  const COLS = ['nom', 'description', 'type', 'archive', 'image', 'id_map', 'map_active', 'mod_actif', 'date']
  const data = parseTsv(path.join(__dirname, 'mods.tsv'), COLS)
  if (!data) { warn('mods.tsv introuvable — ignoré'); return }
  if (data.rows.length === 0) { warn('mods.tsv vide'); return }

  console.log(`  Colonnes : ${data.headers.join(', ')}`)
  console.log(`  ${data.rows.length} ligne(s) à importer`)

  let ok = 0, skip = 0
  for (const r of data.rows) {
    if (!r.nom) { skip++; continue }

    // Déterminer le type
    let type
    if (r.type === 'map')                             type = 'map'
    else if (r.type === 'vehicule' || r.vehicule_type) type = 'vehicle'
    else                                               type = 'mod'

    const active = type === 'map'
      ? toBool(r.map_active)
      : toBool(r.mod_actif ?? '1')

    // filename : préfère la colonne "archive", sinon "chemin", sinon le nom
    const filename = r.archive || r.chemin || r.nom

    // La colonne image contient un chemin relatif "images/foo.webp" → extraire juste le nom
    const rawImage = r.image || null
    const imageFile = rawImage ? rawImage.replace(/^.*[\\/]/, '') : null

    // La colonne description : soit du texte, soit un chemin vers un JSON multilingue
    const description = resolveDescription(r.description)

    try {
      await pg.query(
        `INSERT INTO mods (name, type, filename, image, description, active, map_id, created_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
         ON CONFLICT (filename) DO UPDATE
           SET name        = EXCLUDED.name,
               type        = EXCLUDED.type,
               image       = EXCLUDED.image,
               description = EXCLUDED.description,
               active      = EXCLUDED.active,
               map_id      = EXCLUDED.map_id`,
        [
          r.nom,
          type,
          filename,
          imageFile,
          description ? JSON.stringify(description) : null,
          active,
          r.id_map || null,
          toDate(r.date) ?? new Date(),
        ]
      )
      ok++
    } catch (e) {
      warn(`Mod "${r.nom}" ignoré : ${e.message}`)
      skip++
    }
  }
  log(`${ok} mods/maps/véhicules importés, ${skip} ignorés`)
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  console.log('\n🚀 Import TSV → PostgreSQL')
  console.log(`   Cible : ${pg.options.user}@${pg.options.host}:${pg.options.port}/${pg.options.database}`)

  try {
    await pg.query('SELECT 1')
    log('Connexion PostgreSQL OK')
  } catch (e) {
    console.error(`\n❌ Impossible de se connecter à PostgreSQL : ${e.message}`)
    console.error('   Vérifiez POSTGRES_HOST/PORT/USER/PASSWORD/DB dans .env')
    process.exit(1)
  }

  await importPlayers()
  await importMods()

  console.log('\n✅ Import terminé.')
  await pg.end()
}

main().catch(e => { console.error('\n❌', e.message); process.exit(1) })

#!/usr/bin/env node
/**
 * Migration V1 -> V2 : reprend les données de l'ancien panel (MariaDB + PHP,
 * répertoire /DATA/images) pour les réappliquer sur cette instance V2.
 *
 * Reprend, par instance :
 *   - images des mods/véhicules/cartes (écrase les images déjà présentes en V2 —
 *     l'extraction automatique par zip donne souvent un résultat de moins bonne
 *     qualité que l'image choisie à la main en V1)
 *   - descriptions des mods/véhicules/cartes (ne remplit que les descriptions
 *     V2 actuellement vides — celles-ci sont du texte éditorial, contrairement
 *     aux images ; on n'écrase jamais un texte déjà (re)écrit côté V2). Les
 *     descriptions V1 générées automatiquement ("Description non fournie.",
 *     "Description pour X") sont ignorées, elles n'apportent rien.
 *   - statistiques joueurs (connection_count, temps de jeu, dernière connexion),
 *     fusionnées avec les stats déjà accumulées en V2 le cas échéant (pas un
 *     simple écrasement — utile si le script est relancé ou si le panel V2
 *     tournait déjà depuis un moment)
 *   - signale (sans rien écrire) les mods présents en V1 mais absents de la V2 :
 *     un mod ne peut pas être recréé sans son .zip, donc ceux-là restent à
 *     traiter à la main via Scan & Import si le fichier existe toujours
 *
 * Ne fait AUCUNE écriture sans --apply (mode aperçu par défaut).
 *
 * Usage :
 *   node scripts/migrate-v1-to-v2.mjs --v1-root=/var/www/mon-ancien-site [options]
 *
 * Options :
 *   --v1-root=<path>         Racine du site V1 (contient .env et DATA/) [requis]
 *   --v1-images=<path>       Dossier images V1 (défaut : <v1-root>/DATA/images)
 *   --v1-descriptions=<path> Dossier descriptions V1 (défaut : <v1-root>/DATA/descriptions)
 *   --instance=<id>          Instance V2 ciblée (défaut : default)
 *   --skip-images            Ne pas resynchroniser les images
 *   --skip-descriptions      Ne pas importer les descriptions
 *   --skip-players           Ne pas importer les joueurs
 *   --apply                  Applique réellement les changements (sinon dry-run)
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// ── CLI args ─────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...rest] = a.slice(2).split('=')
      return [k, rest.length ? rest.join('=') : true]
    })
)

if (!args['v1-root']) {
  console.error('Usage: node scripts/migrate-v1-to-v2.mjs --v1-root=/var/www/mon-ancien-site [--apply]')
  process.exit(1)
}

const V1_ROOT         = path.resolve(String(args['v1-root']))
const V1_IMAGES       = args['v1-images'] ? path.resolve(String(args['v1-images'])) : path.join(V1_ROOT, 'DATA', 'images')
const V1_DESCRIPTIONS = args['v1-descriptions'] ? path.resolve(String(args['v1-descriptions'])) : path.join(V1_ROOT, 'DATA', 'descriptions')
const INSTANCE_ID       = args.instance ?? 'default'
const APPLY             = !!args.apply
const SKIP_IMAGES       = !!args['skip-images']
const SKIP_DESCRIPTIONS = !!args['skip-descriptions']
const SKIP_PLAYERS      = !!args['skip-players']

// Descriptions auto-générées par la V1 quand l'utilisateur n'a rien renseigné —
// aucune valeur éditoriale, ne valent pas la peine d'être importées.
const PLACEHOLDER_DESCRIPTION_RE = /^(Description non fournie\.|Description pour .+)$/

function sqlEscape(str) {
  return String(str).replace(/'/g, "''")
}

// ── V1 : lecture des identifiants DB depuis le .env du site PHP ──────────
function readV1Credentials() {
  const envPath = path.join(V1_ROOT, '.env')
  if (!fs.existsSync(envPath)) {
    throw new Error(`Fichier .env introuvable dans ${V1_ROOT} — pointer --v1-root vers la racine du site V1`)
  }
  const content = fs.readFileSync(envPath, 'utf8')
  const get = key => {
    const m = content.match(new RegExp(`^${key}=(.*)$`, 'm'))
    return m ? m[1].trim() : null
  }
  const creds = {
    host:     get('DB_HOST') ?? '127.0.0.1',
    database: get('DB_NAME'),
    user:     get('DB_USER'),
    password: get('DB_PASSWORD'),
  }
  if (!creds.database || !creds.user || !creds.password) {
    throw new Error(`Identifiants DB incomplets dans ${envPath} (attendu DB_NAME/DB_USER/DB_PASSWORD)`)
  }
  return creds
}

function queryV1(creds, sql) {
  const out = execFileSync('mysql', [
    '-u', creds.user,
    `-p${creds.password}`,
    '-h', creds.host,
    '-N', // no column headers
    '-e', sql,
    creds.database,
  ], { encoding: 'utf8' })
  // The mysql CLI prints SQL NULL as the literal text "NULL" in -N/-e output —
  // normalize it back to a real null so callers can use plain truthiness checks.
  return out.split('\n').filter(l => l.length > 0)
    .map(l => l.split('\t').map(cell => (cell === 'NULL' ? null : cell)))
}

// ── V2 : exécution via `docker compose exec` (pas de dépendance réseau host) ─
function queryV2(sql) {
  const out = execFileSync('docker', [
    'compose', 'exec', '-T', 'postgres',
    'psql', '-U', 'beammp', '-d', 'beammp', '-t', '-A', '-F', '\t', '-c', sql,
  ], { encoding: 'utf8', cwd: path.join(import.meta.dirname, '..') })
  return out.split('\n').filter(l => l.length > 0).map(l => l.split('\t'))
}

function applyV2Sql(statements) {
  if (statements.length === 0) return
  const sqlFile = path.join(import.meta.dirname, '.migrate-v1-to-v2.tmp.sql')
  fs.writeFileSync(sqlFile, statements.join('\n'))
  try {
    execFileSync('docker', [
      'compose', 'cp', sqlFile, 'postgres:/tmp/migrate-v1-to-v2.sql',
    ], { cwd: path.join(import.meta.dirname, '..'), stdio: 'inherit' })
    execFileSync('docker', [
      'compose', 'exec', '-T', 'postgres',
      'psql', '-U', 'beammp', '-d', 'beammp', '-f', '/tmp/migrate-v1-to-v2.sql',
    ], { cwd: path.join(import.meta.dirname, '..'), stdio: 'inherit' })
    execFileSync('docker', [
      'compose', 'exec', '-T', 'postgres', 'rm', '-f', '/tmp/migrate-v1-to-v2.sql',
    ], { cwd: path.join(import.meta.dirname, '..') })
  } finally {
    fs.rmSync(sqlFile, { force: true })
  }
}

// ── Mods sans correspondance V2 (rapport seulement) ───────────────────────
// Un mod V1 ne peut pas être recréé en V2 sans son fichier zip (le schéma
// mods exige un filename réel sur disque) — on ne fait donc que signaler les
// entrées V1 orphelines pour un traitement manuel via Scan & Import.
function reportUnmatchedMods(creds) {
  console.log('\n=== Mods V1 sans correspondance V2 (info seulement) ===')
  // `chemin` est NULL pour les cartes officielles BeamNG (pas de zip propre,
  // identifiées autrement côté V2) — ce ne sont pas des mods orphelins.
  const v1Rows = queryV1(creds, `SELECT nom, chemin FROM beammp_Officiel WHERE chemin IS NOT NULL AND chemin != ''`)
  const v2Rows = queryV2(`SELECT filename FROM mods WHERE instance_id = '${sqlEscape(INSTANCE_ID)}'`)
  const v2Filenames = new Set(v2Rows.map(r => r[0]))
  const unmatched = v1Rows.filter(([, chemin]) => !v2Filenames.has(chemin))

  if (unmatched.length === 0) {
    console.log('Aucun — tous les mods V1 ont une correspondance en V2.')
    return
  }
  console.log(`${unmatched.length} mod(s) V1 sans équivalent en V2 — si leur .zip est toujours`)
  console.log(`présent dans Resources/, les enregistrer via Scan & Import (sidebar → Import) :`)
  for (const [nom, chemin] of unmatched) console.log(`  - ${nom} (${chemin})`)
}

// ── Images ───────────────────────────────────────────────────────────────
function syncImages(creds) {
  console.log('\n=== Images (mods/véhicules/cartes) ===')
  const v1Rows = queryV1(creds, `SELECT chemin, image FROM beammp_Officiel WHERE image IS NOT NULL AND image != ''`)
  const v2Rows = queryV2(`SELECT filename FROM mods WHERE instance_id = '${sqlEscape(INSTANCE_ID)}'`)
  const v2Filenames = new Set(v2Rows.map(r => r[0]))

  const matches = []
  for (const [chemin, image] of v1Rows) {
    if (!v2Filenames.has(chemin)) continue
    const basename = image.replace(/^\/?images\//, '')
    const srcPath = path.join(V1_IMAGES, basename)
    if (!fs.existsSync(srcPath)) {
      console.log(`  ! image absente du disque, ignorée : ${basename}`)
      continue
    }
    matches.push({ chemin, basename, srcPath })
  }

  console.log(`${matches.length} mod(s) V2 avec une image V1 correspondante (sur ${v2Filenames.size} au total).`)
  if (!APPLY) {
    console.log('(dry-run — relancer avec --apply pour copier les images et mettre à jour la BDD)')
    return
  }

  for (const m of matches) {
    execFileSync('docker', [
      'compose', 'cp', m.srcPath, `app:/app/images/${m.basename}`,
    ], { cwd: path.join(import.meta.dirname, '..') })
  }
  // Les fichiers copiés héritent des permissions Unix du serveur V1 d'origine
  // (souvent www-data, illisibles par le process Node du panel) — on les
  // aligne sur le reste du volume juste après.
  execFileSync('docker', [
    'compose', 'exec', '-u', 'root', '-T', 'app',
    'sh', '-c', 'chown -R node:node /app/images && chmod -R u+rw,g+r,o+r /app/images',
  ], { cwd: path.join(import.meta.dirname, '..') })

  const sql = matches.map(m =>
    `UPDATE mods SET image = '${sqlEscape(m.basename)}' WHERE filename = '${sqlEscape(m.chemin)}' AND instance_id = '${sqlEscape(INSTANCE_ID)}';`
  )
  applyV2Sql(sql)
  console.log(`${matches.length} image(s) synchronisée(s).`)
}

// ── Descriptions ─────────────────────────────────────────────────────────
function syncDescriptions(creds) {
  console.log('\n=== Descriptions (mods/véhicules/cartes) ===')
  const v1Rows = queryV1(creds, `SELECT chemin, description FROM beammp_Officiel WHERE description IS NOT NULL AND description != ''`)
  const v2Rows = queryV2(`SELECT filename FROM mods WHERE instance_id = '${sqlEscape(INSTANCE_ID)}' AND description IS NULL`)
  const v2FilenamesWithoutDesc = new Set(v2Rows.map(r => r[0]))

  const matches = []
  let placeholderCount = 0
  for (const [chemin, description] of v1Rows) {
    if (!v2FilenamesWithoutDesc.has(chemin)) continue
    const basename = description.replace(/^\/?descriptions\//, '')
    const srcPath = path.join(V1_DESCRIPTIONS, basename)
    if (!fs.existsSync(srcPath)) continue

    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(srcPath, 'utf8'))
    } catch {
      continue
    }
    const real = Object.fromEntries(
      Object.entries(parsed).filter(([, v]) => v && !PLACEHOLDER_DESCRIPTION_RE.test(String(v).trim()))
    )
    if (Object.keys(real).length === 0) { placeholderCount++; continue }
    matches.push({ chemin, description: real })
  }

  console.log(`${matches.length} mod(s) V2 sans description avec un contenu V1 exploitable`)
  console.log(`(${placeholderCount} ignorée(s) — texte V1 auto-généré sans valeur).`)
  if (!APPLY) {
    console.log('(dry-run — relancer avec --apply pour importer)')
    return
  }

  const sql = matches.map(m =>
    `UPDATE mods SET description = '${sqlEscape(JSON.stringify(m.description))}'::jsonb WHERE filename = '${sqlEscape(m.chemin)}' AND instance_id = '${sqlEscape(INSTANCE_ID)}' AND description IS NULL;`
  )
  applyV2Sql(sql)
  console.log(`${matches.length} description(s) importée(s).`)
}

// ── Joueurs ──────────────────────────────────────────────────────────────
function importPlayers(creds) {
  console.log('\n=== Joueurs ===')
  // total_time est en secondes ; last_connect/last_disconnect en DATETIME MySQL
  // (compatibles avec un cast direct en timestamptz côté Postgres).
  const v1Rows = queryV1(creds, `
    SELECT username, connection_count, total_time, last_connect, last_disconnect
    FROM beammp_users_Officiel
  `)
  console.log(`${v1Rows.length} joueur(s) trouvé(s) dans la V1.`)
  if (!APPLY) {
    console.log('(dry-run — relancer avec --apply pour importer)')
    return
  }

  // Fusionne avec les stats V2 déjà présentes plutôt que d'écraser : les
  // compteurs V1 et V2 couvrent des périodes disjointes (avant/après la
  // migration), donc ils s'additionnent ; les dates prennent la plus
  // ancienne/récente des deux sources. V1 ne trace pas de "première connexion"
  // séparée — on utilise last_connect comme approximation la plus proche
  // disponible pour first_seen.
  const sql = v1Rows.map(([username, count, totalTime, lastConnect, lastDisconnect]) => {
    const firstSeenGuess = lastConnect || lastDisconnect
    const lastSeenGuess  = lastDisconnect || lastConnect
    return `
      INSERT INTO known_players (instance_id, beammp_username, connection_count, total_seconds, first_seen, last_seen)
      VALUES ('${sqlEscape(INSTANCE_ID)}', '${sqlEscape(username)}', ${Number(count) || 0}, ${Number(totalTime) || 0},
              ${firstSeenGuess ? `'${sqlEscape(firstSeenGuess)}'` : 'NOW()'},
              ${lastSeenGuess ? `'${sqlEscape(lastSeenGuess)}'` : 'NULL'})
      ON CONFLICT (instance_id, beammp_username) DO UPDATE SET
        connection_count = known_players.connection_count + EXCLUDED.connection_count,
        total_seconds    = known_players.total_seconds + EXCLUDED.total_seconds,
        first_seen       = LEAST(known_players.first_seen, EXCLUDED.first_seen),
        last_seen         = GREATEST(known_players.last_seen, EXCLUDED.last_seen);
    `.trim()
  })
  applyV2Sql(sql)
  console.log(`${v1Rows.length} joueur(s) importé(s)/fusionné(s).`)
}

// ── Main ─────────────────────────────────────────────────────────────────
console.log(`Migration V1 -> V2 (instance "${INSTANCE_ID}") ${APPLY ? '[APPLY]' : '[DRY-RUN]'}`)
console.log(`V1 root: ${V1_ROOT}`)
console.log(`V1 images: ${V1_IMAGES}`)
console.log(`V1 descriptions: ${V1_DESCRIPTIONS}`)

const creds = readV1Credentials()
reportUnmatchedMods(creds)
if (!SKIP_IMAGES)       syncImages(creds)
if (!SKIP_DESCRIPTIONS) syncDescriptions(creds)
if (!SKIP_PLAYERS)      importPlayers(creds)

console.log('\nTerminé.')

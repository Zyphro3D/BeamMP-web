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
 *     fusionnées avec les stats déjà accumulées en V2 le cas échéant (ADDITIF —
 *     voir garde-fou anti-double-import ci-dessous, ne JAMAIS lancer cette étape
 *     deux fois pour le même site V1 sans le savoir)
 *   - signale (sans rien écrire) les mods présents en V1 mais absents de la V2 :
 *     un mod ne peut pas être recréé sans son .zip, donc ceux-là restent à
 *     traiter à la main via Scan & Import si le fichier existe toujours
 *
 * Toutes les écritures V2 passent par scripts/migrate-runner.mjs, exécuté à
 * l'intérieur du conteneur `app` : les valeurs sont transmises en JSON et
 * appliquées via des requêtes SQL paramétrées ($1, $2…) dans une transaction
 * unique, jamais construites par concaténation de chaînes.
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
 *   --force-players          Réimporter les joueurs même si déjà fait pour ce site V1
 *   --apply                  Applique réellement les changements (sinon dry-run)
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

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
const FORCE_PLAYERS     = !!args['force-players']

const REPO_ROOT = path.join(import.meta.dirname, '..')
const STATE_FILE = path.join(import.meta.dirname, '.migrate-v1-to-v2.state.json')

// Descriptions auto-générées par la V1 quand l'utilisateur n'a rien renseigné —
// aucune valeur éditoriale, ne valent pas la peine d'être importées.
const PLACEHOLDER_DESCRIPTION_RE = /^(Description non fournie\.|Description pour .+)$/

// Réduit une valeur venant de la V1 (nom de fichier potentiellement non
// maîtrisé) à un nom de fichier plat, sans composant de répertoire — rejette
// (plutôt que de la nettoyer silencieusement) toute valeur qui contiendrait
// un séparateur de chemin ou une séquence ".."  : même posture que
// `safeBasename()` dans backend/src/routes/admin.ts.
function safeBasename(name) {
  const str = String(name)
  const base = path.basename(str)
  if (!base || base !== str || base === '.' || base === '..') return null
  return base
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
  // Identifiants passés via un fichier temporaire (--defaults-extra-file)
  // plutôt qu'en argument `-p<mot de passe>` — un argument de commande est
  // visible par tout utilisateur local le temps de l'exécution (ps aux,
  // /proc/<pid>/cmdline).
  const credsFile = path.join(os.tmpdir(), `migrate-v1-mysql-${crypto.randomUUID()}.cnf`)
  fs.writeFileSync(
    credsFile,
    `[client]\nuser=${creds.user}\npassword=${creds.password}\nhost=${creds.host}\n`,
    { mode: 0o600 }
  )
  try {
    const out = execFileSync('mysql', [
      `--defaults-extra-file=${credsFile}`,
      '-N', // no column headers
      '-e', sql,
      creds.database,
    ], { encoding: 'utf8' })
    // The mysql CLI prints SQL NULL as the literal text "NULL" in -N/-e output —
    // normalize it back to a real null so callers can use plain truthiness checks.
    return out.split('\n').filter(l => l.length > 0)
      .map(l => l.split('\t').map(cell => (cell === 'NULL' ? null : cell)))
  } finally {
    fs.rmSync(credsFile, { force: true })
  }
}

// ── V2 : lecture (aperçu, non sensible) via `docker compose exec` ────────
// Identifiants lus depuis les variables d'environnement DU CONTENEUR postgres
// lui-même ($POSTGRES_USER/$POSTGRES_DB, déjà correctes quel que soit le
// .env du projet) plutôt que codés en dur — un projet qui a changé les
// identifiants par défaut (recommandé en production) ne casse pas le script.
function queryV2(sql) {
  const out = execFileSync('docker', [
    'compose', 'exec', '-T', 'postgres',
    'sh', '-c', 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A -F "$1" -c "$2"',
    '--', '\t', sql,
  ], { encoding: 'utf8', cwd: REPO_ROOT })
  return out.split('\n').filter(l => l.length > 0).map(l => l.split('\t'))
}

// ── V2 : écritures via scripts/migrate-runner.mjs (requêtes paramétrées, ─
// jamais de SQL construit par concaténation de chaînes) ──────────────────
function applyV2Ops(ops) {
  if (ops.length === 0) return
  const runId = crypto.randomUUID()
  const hostOpsFile = path.join(os.tmpdir(), `migrate-v1-to-v2-ops-${runId}.json`)
  fs.writeFileSync(hostOpsFile, JSON.stringify(ops), { mode: 0o600 })
  // Exécuté depuis /app (et non /tmp) à l'intérieur du conteneur : la
  // résolution de module Node de `migrate-runner.mjs` (import 'pg') a besoin
  // d'y trouver /app/node_modules, inaccessible depuis /tmp. /app appartient
  // à l'utilisateur node (cf. Dockerfile), donc inscriptible sans être root.
  const containerRunner = `/app/.migrate-runner-${runId}.mjs`
  const containerOps    = `/app/.migrate-ops-${runId}.json`
  try {
    execFileSync('docker', [
      'compose', 'cp', path.join(import.meta.dirname, 'migrate-runner.mjs'), `app:${containerRunner}`,
    ], { cwd: REPO_ROOT, stdio: 'inherit' })
    execFileSync('docker', [
      'compose', 'cp', hostOpsFile, `app:${containerOps}`,
    ], { cwd: REPO_ROOT, stdio: 'inherit' })
    try {
      execFileSync('docker', [
        'compose', 'exec', '-T', 'app', 'node', containerRunner, containerOps,
      ], { cwd: REPO_ROOT, stdio: 'inherit' })
    } finally {
      // Toujours nettoyer côté conteneur, même si le runner a échoué —
      // ces fichiers contiennent des données V1 (pseudos, noms de mods).
      execFileSync('docker', [
        'compose', 'exec', '-T', 'app', 'rm', '-f', containerRunner, containerOps,
      ], { cwd: REPO_ROOT })
    }
  } finally {
    fs.rmSync(hostOpsFile, { force: true })
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
  const v2Rows = queryV2(`SELECT filename FROM mods WHERE instance_id = '${INSTANCE_ID.replace(/'/g, "''")}'`)
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
  const v2Rows = queryV2(`SELECT filename FROM mods WHERE instance_id = '${INSTANCE_ID.replace(/'/g, "''")}'`)
  const v2Filenames = new Set(v2Rows.map(r => r[0]))

  const matches = []
  for (const [chemin, image] of v1Rows) {
    if (!v2Filenames.has(chemin)) continue
    const basename = safeBasename(image.replace(/^\/?images\//, ''))
    if (!basename) {
      console.log(`  ! nom d'image invalide, ignoré : ${image}`)
      continue
    }
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
    ], { cwd: REPO_ROOT })
  }
  // Les fichiers copiés héritent des permissions Unix du serveur V1 d'origine
  // (souvent www-data, illisibles par le process Node du panel) — on les
  // aligne sur le reste du volume juste après.
  execFileSync('docker', [
    'compose', 'exec', '-u', 'root', '-T', 'app',
    'sh', '-c', 'chown -R node:node /app/images && chmod -R u+rw,g+r,o+r /app/images',
  ], { cwd: REPO_ROOT })

  applyV2Ops(matches.map(m => ({
    sql: `UPDATE mods SET image = $1 WHERE filename = $2 AND instance_id = $3`,
    params: [m.basename, m.chemin, INSTANCE_ID],
  })))
  console.log(`${matches.length} image(s) synchronisée(s).`)
}

// ── Descriptions ─────────────────────────────────────────────────────────
function syncDescriptions(creds) {
  console.log('\n=== Descriptions (mods/véhicules/cartes) ===')
  const v1Rows = queryV1(creds, `SELECT chemin, description FROM beammp_Officiel WHERE description IS NOT NULL AND description != ''`)
  const v2Rows = queryV2(`SELECT filename FROM mods WHERE instance_id = '${INSTANCE_ID.replace(/'/g, "''")}' AND description IS NULL`)
  const v2FilenamesWithoutDesc = new Set(v2Rows.map(r => r[0]))

  const matches = []
  let placeholderCount = 0
  for (const [chemin, description] of v1Rows) {
    if (!v2FilenamesWithoutDesc.has(chemin)) continue
    const basename = safeBasename(description.replace(/^\/?descriptions\//, ''))
    if (!basename) continue
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

  applyV2Ops(matches.map(m => ({
    sql: `UPDATE mods SET description = $1::jsonb WHERE filename = $2 AND instance_id = $3 AND description IS NULL`,
    params: [JSON.stringify(m.description), m.chemin, INSTANCE_ID],
  })))
  console.log(`${matches.length} description(s) importée(s).`)
}

// ── Joueurs ──────────────────────────────────────────────────────────────
// La fusion des statistiques est ADDITIVE (connection_count/total_seconds
// s'accumulent au lieu d'être remplacés) : c'est correct pour une fusion
// unique de deux périodes disjointes (avant/après bascule), mais relancer
// cette étape une seconde fois pour le MÊME site V1 additionnerait deux fois
// les mêmes compteurs. On garde une trace locale (par site V1 + instance)
// pour avertir plutôt que de laisser corrompre les stats silencieusement.
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return { playersImported: [] }
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 })
}

function importPlayers(creds) {
  console.log('\n=== Joueurs ===')

  const stateKey = `${V1_ROOT}::${INSTANCE_ID}`
  const state = loadState()
  if (state.playersImported.includes(stateKey) && !FORCE_PLAYERS) {
    console.log(`Déjà importés pour ce site V1 + cette instance (${new Date().toISOString()} non enregistré, voir ${STATE_FILE}).`)
    console.log('Relancer avec --force-players si tu es certain de vouloir refusionner (les compteurs seront additionnés une seconde fois).')
    return
  }

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
  const ops = v1Rows.map(([username, count, totalTime, lastConnect, lastDisconnect]) => {
    const firstSeenGuess = lastConnect || lastDisconnect || new Date().toISOString()
    const lastSeenGuess  = lastDisconnect || lastConnect || null
    return {
      sql: `
        INSERT INTO known_players (instance_id, beammp_username, connection_count, total_seconds, first_seen, last_seen)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (instance_id, beammp_username) DO UPDATE SET
          connection_count = known_players.connection_count + EXCLUDED.connection_count,
          total_seconds    = known_players.total_seconds + EXCLUDED.total_seconds,
          first_seen       = LEAST(known_players.first_seen, EXCLUDED.first_seen),
          last_seen        = GREATEST(known_players.last_seen, EXCLUDED.last_seen)
      `.trim(),
      params: [INSTANCE_ID, username, Number(count) || 0, Number(totalTime) || 0, firstSeenGuess, lastSeenGuess],
    }
  })
  applyV2Ops(ops)
  console.log(`${v1Rows.length} joueur(s) importé(s)/fusionné(s).`)

  state.playersImported.push(stateKey)
  saveState(state)
}

// ── Vérification des dépendances externes ────────────────────────────────
function checkDependency(cmd, args, hint) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' })
  } catch {
    console.error(`❌ Commande "${cmd}" introuvable ou non fonctionnelle — ${hint}`)
    process.exit(1)
  }
}

// ── Main ─────────────────────────────────────────────────────────────────
checkDependency('mysql', ['--version'], 'client MySQL/MariaDB requis pour lire la base V1')
checkDependency('docker', ['compose', 'version'], 'Docker Compose v2 requis pour lire/écrire la base V2')

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

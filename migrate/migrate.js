#!/usr/bin/env node
/**
 * Migration depuis dump.sql MariaDB → PostgreSQL
 *
 * Usage (depuis l'intérieur du container Docker) :
 *   sudo docker cp /opt/beammp-web/beammp-panel/migrate beammp-panel-app-1:/tmp/
 *   sudo docker exec -it beammp-panel-app-1 sh -c "cd /tmp/migrate && npm install && node migrate.js"
 *
 * Prérequis : dump.sql dans le même dossier (généré par mysqldump)
 */

const fs   = require('fs')
const path = require('path')
const { Pool } = require('pg')
const crypto = require('crypto')

// ── Config PostgreSQL ─────────────────────────────────────────

try {
  const envPath = path.join(__dirname, '..', '.env')
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)\s*=\s*(.+)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
    }
  }
} catch {}

const INSTANCE = process.env.MARIADB_INSTANCE ?? 'default'

const pg = new Pool({
  host:     process.env.POSTGRES_HOST     ?? 'localhost',
  port:     parseInt(process.env.POSTGRES_PORT ?? '5432'),
  user:     process.env.POSTGRES_USER     ?? 'beammp',
  password: process.env.POSTGRES_PASSWORD ?? 'beammp',
  database: process.env.POSTGRES_DB       ?? 'beammp',
})

// ── Helpers ───────────────────────────────────────────────────

function log(msg)  { console.log(`  ✓ ${msg}`) }
function warn(msg) { console.warn(`  ⚠ ${msg}`) }
function sep(t)    { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 40 - t.length))}`) }

function placeholderHash() {
  return crypto.scryptSync('MIGRATED_RESET_REQUIRED', 'beammp-salt', 64).toString('hex')
}

// ── Parseur SQL ───────────────────────────────────────────────
// Extrait toutes les lignes VALUES d'une table donnée depuis le dump.
// Gère : NULL, entiers, chaînes entre quotes avec échappements MySQL.

function parseDump(sql, tableName) {
  // Trouver le bloc INSERT pour cette table
  const tablePattern = new RegExp(
    `INSERT INTO \`${tableName}\` VALUES\\s*\\n([\\s\\S]*?);\\s*\\n`,
    'g'
  )

  const allRows = []

  for (const match of sql.matchAll(tablePattern)) {
    const block = match[1]
    // Découper les lignes individuelles (chaque ligne est une row)
    // Format: ('val1','val2',NULL,0,...),
    const lines = block.split('\n')
    for (let line of lines) {
      line = line.trim().replace(/,\s*$/, '') // enlever la virgule finale
      if (!line.startsWith('(')) continue
      const row = parseRow(line)
      if (row) allRows.push(row)
    }
  }

  return allRows
}

// Parse une ligne type: ('val1',NULL,0,'val with \'quote\'',...)
function parseRow(line) {
  // Enlever les parenthèses externes
  if (!line.startsWith('(') || !line.endsWith(')')) return null
  line = line.slice(1, -1)

  const values = []
  let i = 0

  while (i < line.length) {
    // Sauter les espaces
    while (i < line.length && line[i] === ' ') i++

    if (line[i] === "'") {
      // Chaîne entre quotes
      i++ // sauter la quote ouvrante
      let str = ''
      while (i < line.length) {
        if (line[i] === '\\' && i + 1 < line.length) {
          // Séquence d'échappement MySQL
          const next = line[i + 1]
          if (next === "'") str += "'"
          else if (next === '\\') str += '\\'
          else if (next === 'n') str += '\n'
          else if (next === 'r') str += '\r'
          else if (next === 't') str += '\t'
          else str += next
          i += 2
        } else if (line[i] === "'") {
          // Fin de la chaîne ou double quote ''
          if (line[i + 1] === "'") {
            str += "'"
            i += 2
          } else {
            i++ // sauter la quote fermante
            break
          }
        } else {
          str += line[i]
          i++
        }
      }
      values.push(str)
    } else {
      // Valeur non quotée (NULL, entier)
      let token = ''
      while (i < line.length && line[i] !== ',') {
        token += line[i]
        i++
      }
      token = token.trim()
      values.push(token === 'NULL' ? null : token)
    }

    // Sauter la virgule séparatrice
    while (i < line.length && line[i] === ' ') i++
    if (i < line.length && line[i] === ',') i++
  }

  return values
}

// Nettoyage du champ image : retire le préfixe "images/" ou "/images/"
function cleanImage(raw) {
  if (!raw) return null
  return raw.replace(/^\/?images\//, '')
}

// ── Migration ─────────────────────────────────────────────────

async function migrate() {
  const dumpPath = path.join(__dirname, 'dump.sql')
  if (!fs.existsSync(dumpPath)) {
    console.error('\n❌ dump.sql introuvable dans', __dirname)
    process.exit(1)
  }

  console.log('\n🚀 Migration dump.sql → PostgreSQL')
  console.log(`   Instance : ${INSTANCE}`)
  console.log(`   Dest     : ${pg.options.user}@${pg.options.host}/${pg.options.database}`)
  console.log('   Lecture du dump...')

  const sql = fs.readFileSync(dumpPath, 'utf8')

  // ── 1. Users (admins) ────────────────────────────────────────
  sep('Utilisateurs admin')

  // Colonnes users : id, username, password, role, created_at
  // On cherche la table users
  const userRows = parseDump(sql, 'users')
  let usersOk = 0, usersSkip = 0

  for (const r of userRows) {
    // Colonnes MariaDB : 0:id, 1:username, 2:password_hash, 3:created_at, 4:role
    const username   = r[1]
    const created_at = r[3] ?? new Date().toISOString()
    const role = (r[4] ?? 'Admin').toLowerCase() === 'superadmin' ? 'superadmin' : 'admin'

    try {
      await pg.query(
        `INSERT INTO users (username, password, role, created_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (username) DO NOTHING`,
        [username, placeholderHash(), role, created_at]
      )
      usersOk++
    } catch (e) {
      warn(`User "${username}" ignoré : ${e.message}`)
      usersSkip++
    }
  }
  log(`${usersOk} utilisateurs migrés, ${usersSkip} ignorés`)
  warn('Mots de passe non migrés — chaque admin doit réinitialiser son mdp')

  // ── 2. Mods / Maps / Véhicules ────────────────────────────────
  sep('Mods / Maps / Véhicules')

  // Colonnes beammp_Officiel (dans l'ordre du CREATE TABLE) :
  // 0:nom, 1:description, 2:type, 3:chemin, 4:image, 5:id_map,
  // 6:map_active, 7:map_officielle, 8:mod_actif, 9:vehicule_type,
  // 10:car_type, 11:archive, 12:link, 13:date
  const modTable = `beammp_Officiel`
  const modRows = parseDump(sql, modTable)

  if (modRows.length === 0) {
    warn(`Aucune ligne trouvée pour la table "${modTable}" — vérifier le dump`)
  }

  let modsOk = 0, modsSkip = 0

  for (const r of modRows) {
    const nom          = r[0]
    const type_old     = r[2]
    const chemin       = r[3]   // nom du fichier sur disque (peut être NULL pour cartes officielles)
    const image        = cleanImage(r[4])
    const id_map       = r[5]
    const map_active   = r[6]
    const map_offic    = r[7]
    const date         = r[13]

    const type = type_old === 'vehicule' ? 'vehicle' : (type_old ?? 'mod')

    // Statut actif :
    // - maps    : map_active=1 → carte actuellement sélectionnée
    // - autres  : chemin non null → le fichier existe sur le serveur = actif
    const active = type === 'map'
      ? (String(map_active) === '1')
      : (chemin !== null)

    // Carte officielle BeamMP (incluse de base, pas de fichier à gérer)
    const is_official = String(map_offic) === '1'

    // filename = chemin (nom réel du fichier sur disque)
    // Pour les cartes officielles sans fichier, on utilise l'id_map comme identifiant
    const filename = chemin ?? (id_map ? `__official__:${id_map}` : null)
    if (!filename) {
      warn(`"${nom}" ignoré : pas de fichier ni d'id_map`)
      modsSkip++
      continue
    }

    try {
      await pg.query(
        `INSERT INTO mods
           (name, type, filename, image, description, active, map_id, created_at, instance_id, is_official)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [nom, type, filename, image, null, active, id_map, date ?? new Date(), INSTANCE, is_official]
      )
      modsOk++
    } catch (e) {
      warn(`"${nom}" ignoré : ${e.message}`)
      modsSkip++
    }
  }
  log(`${modsOk} mods/maps/véhicules migrés, ${modsSkip} ignorés`)

  // ── 3. Joueurs connus ─────────────────────────────────────────
  sep('Joueurs connus')

  // Essayer les deux variantes du nom de table
  let playerRows = parseDump(sql, `beammp_users_${INSTANCE}`)
  if (playerRows.length === 0) {
    playerRows = parseDump(sql, `beammp_users_Officielle`)
  }
  if (playerRows.length === 0) {
    playerRows = parseDump(sql, `beammp_users_Officiel`)
  }

  let playersOk = 0, playersSkip = 0

  for (const p of playerRows) {
    // Colonnes : id, username, last_connect, connection_count, total_time (à vérifier)
    // On prend ce qui est disponible
    const username         = p[1] ?? p[0]
    const connection_count = parseInt(p[3] ?? p[2] ?? '0') || 0
    const last_connect     = p[2] ?? null
    const total_time       = parseInt(p[4] ?? '0') || 0

    try {
      await pg.query(
        `INSERT INTO known_players
           (beammp_username, connection_count, first_seen, last_seen, total_seconds)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (beammp_username) DO UPDATE
           SET connection_count = EXCLUDED.connection_count,
               last_seen        = EXCLUDED.last_seen,
               total_seconds    = EXCLUDED.total_seconds`,
        [username, connection_count, last_connect ?? new Date(), last_connect, total_time]
      )
      playersOk++
    } catch (e) {
      warn(`Joueur "${username}" ignoré : ${e.message}`)
      playersSkip++
    }
  }
  log(`${playersOk} joueurs migrés, ${playersSkip} ignorés`)

  // ── Résumé ────────────────────────────────────────────────────
  console.log('\n✅ Migration terminée.')
  console.log('\n⚠️  Actions manuelles :')
  console.log('   1. Réinitialiser les mots de passe admins dans /admin')
  console.log('   2. Vérifier la cohérence BDD/fichiers via Admin → Cohérence')

  await pg.end()
}

migrate().catch(err => {
  console.error('\n❌ Erreur :', err.message)
  process.exit(1)
})

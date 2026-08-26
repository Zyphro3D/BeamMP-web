#!/usr/bin/env node
/**
 * Exécuté À L'INTÉRIEUR du conteneur `app` par scripts/migrate-v1-to-v2.mjs
 * (jamais directement). Lit un lot d'opérations SQL paramétrées depuis un
 * fichier JSON et les applique dans une seule transaction, via le module
 * `pg` déjà présent dans l'image — aucune valeur n'est jamais concaténée
 * dans du texte SQL, y compris côté script hôte qui génère ce fichier.
 *
 * Usage : node migrate-runner.mjs <ops.json>
 * Format de ops.json : [{ "sql": "UPDATE ... WHERE x = $1", "params": [...] }, ...]
 */
import fs from 'node:fs'
import pg from 'pg'

const opsPath = process.argv[2]
if (!opsPath) {
  console.error('Usage: node migrate-runner.mjs <ops.json>')
  process.exit(1)
}

const ops = JSON.parse(fs.readFileSync(opsPath, 'utf8'))

const pool = new pg.Pool({
  host:     process.env.POSTGRES_HOST,
  port:     Number(process.env.POSTGRES_PORT ?? 5432),
  user:     process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
})

const client = await pool.connect()
try {
  await client.query('BEGIN')
  for (const op of ops) {
    await client.query(op.sql, op.params)
  }
  await client.query('COMMIT')
  console.log(`${ops.length} opération(s) appliquée(s) (transaction unique).`)
} catch (e) {
  await client.query('ROLLBACK')
  console.error('Erreur — rollback effectué, aucune modification appliquée :', e.message)
  process.exitCode = 1
} finally {
  client.release()
  await pool.end()
}

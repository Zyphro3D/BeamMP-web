import type { FastifyInstance } from 'fastify'
import crypto from 'crypto'
import bcrypt from 'bcrypt'
import { db } from '../db'

const BCRYPT_ROUNDS = 12
const LEGACY_SALT   = 'beammp-salt' // kept only for one-time migration

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS)
}

async function verifyPassword(
  password: string,
  hash: string,
): Promise<{ ok: boolean; needsRehash: boolean }> {
  // Modern bcrypt hash
  if (hash.startsWith('$2b$') || hash.startsWith('$2a$')) {
    return { ok: await bcrypt.compare(password, hash), needsRehash: false }
  }
  // Legacy scrypt with hardcoded salt — verify then flag for rehash
  const legacy = crypto.scryptSync(password, LEGACY_SALT, 64).toString('hex')
  const ok = crypto.timingSafeEqual(Buffer.from(legacy), Buffer.from(hash))
  return { ok, needsRehash: ok }
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // ── Login ────────────────────────────────────────────────────
  app.post<{ Body: { username: string; password: string } }>(
    '/api/auth/login',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          properties: {
            username: { type: 'string', minLength: 1, maxLength: 100 },
            password: { type: 'string', minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (req, reply) => {
      const { username, password } = req.body
      const result = await db.query(
        'SELECT id, username, password, role FROM users WHERE username = $1',
        [username]
      )
      const user = result.rows[0]

      if (!user) {
        // Constant-time dummy compare to prevent timing-based user enumeration
        await bcrypt.compare(password, '$2b$12$invalidhashfortimingsafety0000000000000000000000000000')
        return reply.code(401).send({ error: 'Identifiants invalides' })
      }

      const { ok, needsRehash } = await verifyPassword(password, user.password)
      if (!ok) return reply.code(401).send({ error: 'Identifiants invalides' })

      // Transparently migrate legacy scrypt hash → bcrypt on successful login
      if (needsRehash) {
        const newHash = await hashPassword(password)
        await db.query('UPDATE users SET password = $1 WHERE id = $2', [newHash, user.id])
      }

      const token = app.jwt.sign(
        { id: user.id, username: user.username, role: user.role },
        { expiresIn: '7d' }
      )

      reply.setCookie('beammp_token', token, {
        httpOnly: true,
        // false par défaut pour compatibilité HTTP.
        // Mettre COOKIE_SECURE=true dans .env si le panel est derrière un reverse proxy HTTPS.
        secure:   process.env.COOKIE_SECURE === 'true',
        sameSite: 'strict',
        path:     '/',
        maxAge:   7 * 24 * 60 * 60, // 7 days in seconds
      })

      return { user: { id: user.id, username: user.username, role: user.role } }
    }
  )

  // ── Logout ───────────────────────────────────────────────────
  app.post('/api/auth/logout', async (_, reply) => {
    reply.clearCookie('beammp_token', { path: '/' })
    return { ok: true }
  })

  // ── Request account (known player only) ─────────────────────
  app.post<{ Body: { beammp_username: string } }>(
    '/api/auth/request-account',
    {
      schema: {
        body: {
          type: 'object',
          required: ['beammp_username'],
          properties: { beammp_username: { type: 'string', minLength: 1, maxLength: 100 } },
        },
      },
    },
    async (req, reply) => {
      const { beammp_username } = req.body

      const known = await db.query(
        'SELECT id FROM known_players WHERE beammp_username = $1',
        [beammp_username]
      )
      if (known.rows.length === 0) {
        return reply.code(400).send({
          error: "Ce nom de joueur est inconnu. Connectez-vous au serveur BeamMP d'abord.",
        })
      }

      const existing = await db.query(
        `SELECT id FROM account_requests WHERE beammp_username = $1 AND status IN ('pending', 'approved')`,
        [beammp_username]
      )
      if (existing.rows.length > 0) {
        return reply.code(409).send({ error: 'Une demande existe déjà pour ce joueur.' })
      }

      await db.query('INSERT INTO account_requests (beammp_username) VALUES ($1)', [beammp_username])
      return { message: 'Demande envoyée. En attente de validation par un SuperAdmin.' }
    }
  )
}

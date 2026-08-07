import type { FastifyRequest, FastifyReply } from 'fastify'
import { db } from '../db'

export interface AuthUser {
  id:       number
  username: string
  role:     string
}

// Verifies the JWT signature, then re-reads { id, username, role } from the
// DB and overwrites req.user with it. The JWT alone only proves "this is
// user N" for up to 7 days — without this refresh, a role downgrade or an
// account deletion would have no effect on an already-issued cookie until
// it expires naturally. Costs one indexed PK lookup per authenticated
// request, worth it for a panel with a handful of admins, not a hot path.
async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<AuthUser | null> {
  try {
    await req.jwtVerify()
  } catch {
    reply.code(401).send({ error: 'Unauthorized' })
    return null
  }
  const payload = req.user as { id: number }
  const result = await db.query('SELECT id, username, role FROM users WHERE id = $1', [payload.id])
  const user = result.rows[0] as AuthUser | undefined
  if (!user) {
    // Account deleted since the cookie was issued.
    reply.code(401).send({ error: 'Unauthorized' })
    return null
  }
  req.user = user
  return user
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await authenticate(req, reply)
}

export async function requireSuperAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await authenticate(req, reply)
  if (!user) return
  if (user.role !== 'superadmin') {
    reply.code(403).send({ error: 'Forbidden' })
  }
}

// superadmin/admin only — blocks `moderator`. Used on every route that
// mutates state (mods, maps, config, consistency fixes, scan-import,
// restart) and on the server logs, matching the V1 behaviour: moderator is
// read-only and never sees the raw log stream.
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await authenticate(req, reply)
  if (!user) return
  if (user.role !== 'superadmin' && user.role !== 'admin') {
    reply.code(403).send({ error: 'Forbidden' })
  }
}

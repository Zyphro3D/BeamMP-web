import type { FastifyRequest, FastifyReply } from 'fastify'

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await req.jwtVerify()
  } catch {
    reply.code(401).send({ error: 'Unauthorized' })
  }
}

export async function requireSuperAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await req.jwtVerify()
    const user = req.user as { role: string }
    if (user.role !== 'superadmin') {
      reply.code(403).send({ error: 'Forbidden' })
    }
  } catch {
    reply.code(401).send({ error: 'Unauthorized' })
  }
}

// superadmin/admin only — blocks `moderator`. Used on every route that
// mutates state (mods, maps, config, consistency fixes, scan-import,
// restart) and on the server logs, matching the V1 behaviour: moderator is
// read-only and never sees the raw log stream.
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await req.jwtVerify()
    const user = req.user as { role: string }
    if (user.role !== 'superadmin' && user.role !== 'admin') {
      reply.code(403).send({ error: 'Forbidden' })
    }
  } catch {
    reply.code(401).send({ error: 'Unauthorized' })
  }
}

import type { FastifyReply } from 'fastify'
import { config, type InstanceConfig } from '../config'

/** Resolve an instance by id or write a 404 and return null. Shared by
 * dashboard.ts and admin.ts so every instance-scoped route 404s the same way. */
export function getInstance(id: string, reply: FastifyReply): InstanceConfig | null {
  const inst = config.instances.find(i => i.id === id)
  if (!inst) { reply.code(404).send({ error: `Instance '${id}' not found` }); return null }
  return inst
}

import type { FastifyReply, FastifyRequest } from 'fastify'

export async function verifySession(this: { query: typeof import('../db.js').query }, req: FastifyRequest, reply: FastifyReply) {
  const userId = req.session.get('userId') as string | undefined
  if (!userId) { reply.code(401).send({ message: 'Sesión requerida' }); return }
  const { rows } = await this.query('SELECT id FROM users WHERE id = $1', [userId])
  if (!rows.length) { reply.code(401).send({ message: 'Sesión requerida' }); return }
  req.user = { id: rows[0].id as string }
  return
}
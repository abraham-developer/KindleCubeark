import bcrypt from 'bcryptjs'
import type { FastifyInstance } from 'fastify'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// hash real (de 'invalid') para pagar una comparación bcrypt aunque el email no exista,
// y así igualar el tiempo de respuesta entre credenciales correctas/incorrectas
const DUMMY_HASH = '$2a$10$f7LAqEcUc9Hbyu52kT786OAYa2JbY0TUA2u0vxipM2HBpgvzun3gq'

export default async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/register', async (req, reply) => {
    const { email, password } = req.body as { email?: string; password?: string }
    if (!email || !EMAIL_RE.test(email)) return reply.code(400).send({ message: 'Email inválido' })
    if (!password || password.length < 8) return reply.code(400).send({ message: 'La contraseña debe tener al menos 8 caracteres' })
    const hash = await bcrypt.hash(password, 10)
    try {
      const { rows } = await app.query<{ id: string; email: string }>(
        'INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id, email',
        [email.toLowerCase(), hash],
      )
      req.session.set('userId', rows[0].id)
      return reply.code(201).send(rows[0])
    } catch (e: any) {
      if (e.code === '23505') return reply.code(409).send({ message: 'Ese email ya está registrado' })
      throw e
    }
  })

  app.post('/api/auth/login', async (req, reply) => {
    const { email, password } = req.body as { email?: string; password?: string }
    const { rows } = await app.query<{ id: string; password_hash: string; email: string }>(
      'SELECT id, password_hash, email FROM users WHERE email = $1',
      [(email ?? '').toLowerCase()],
    )
    const ok = rows.length
      ? await bcrypt.compare(password ?? '', rows[0].password_hash)
      : await bcrypt.compare(password ?? '', DUMMY_HASH)
    if (!ok) return reply.code(401).send({ message: 'Email o contraseña incorrectos' })
    req.session.set('userId', rows[0].id)
    return { id: rows[0].id, email: rows[0].email }
  })

  app.post('/api/auth/logout', async (req, reply) => {
    req.session.delete()
    return reply.code(204).send()
  })

  app.get('/api/auth/me', { preHandler: app.verifySession }, async (req) => {
    const { rows } = await app.query<{ id: string; email: string }>('SELECT id, email FROM users WHERE id = $1', [req.user!.id])
    return rows[0]
  })
}
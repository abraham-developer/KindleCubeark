import secureSession from '@fastify/secure-session'
import type { FastifyInstance } from 'fastify'

export default async function session(app: FastifyInstance) {
  await app.register(secureSession, {
    key: Buffer.from(app.config.sessionSecret, 'utf8').subarray(0, 32),
    cookie: {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60,
    },
    cookieName: 'session',
  })
}
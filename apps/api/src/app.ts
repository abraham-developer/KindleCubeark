import Fastify from 'fastify'
import { loadConfig } from './config.js'
import { migrate } from './migrate.js'
import { query } from './db.js'
import session from './plugins/session.js'
import { verifySession } from './plugins/auth.js'
import health from './routes/health.js'
import auth from './routes/auth.js'

export async function buildApp(opts: { skipStatic?: boolean; config?: Partial<ReturnType<typeof loadConfig>> } = {}) {
  const config = { ...loadConfig(), ...opts.config }
  // margen del 25% para el overhead de multipart
  const app = Fastify({ logger: false, bodyLimit: Math.ceil(config.maxUploadMb * 1.25 * 1024 * 1024) })
  app.decorate('config', config)
  app.setErrorHandler((err, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500
    if (status >= 500) req.log.error(err)
    reply.status(status).send({ message: status >= 500 ? 'Error interno' : err.message })
  })
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ message: 'No encontrado' }))
  if (config.runMigrations) await migrate()
  // sin fastify-plugin: se llama directo para que @fastify/secure-session
  // (que sí es fp) decore la instancia raíz y req.session sea visible
  await session(app)
  app.decorate('query', (sql, values) => query(sql, values))
  app.decorateRequest('user', null)
  app.decorate('verifySession', verifySession)
  await app.register(health)
  await app.register(auth)
  return app
}
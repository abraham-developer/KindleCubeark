import Fastify from 'fastify'
import { existsSync } from 'node:fs'
import path from 'node:path'
import fastifyStatic from '@fastify/static'
import { loadConfig } from './config.js'
import { migrate, migrateWithRetry } from './migrate.js'
import { query } from './db.js'
import session from './plugins/session.js'
import { verifySession } from './plugins/auth.js'
import health from './routes/health.js'
import auth from './routes/auth.js'
import books from './routes/books.js'
import annotations from './routes/annotations.js'
import multipart from '@fastify/multipart'

export async function buildApp(opts: { skipStatic?: boolean; config?: Partial<ReturnType<typeof loadConfig>> } = {}) {
  const config = { ...loadConfig(), ...opts.config }
  // margen del 25% para el overhead de multipart
  const app = Fastify({ logger: false, bodyLimit: Math.ceil(config.maxUploadMb * 1.25 * 1024 * 1024) })
  const serveSpa = !opts.skipStatic && existsSync(path.resolve(config.webDist))
  app.decorate('config', config)
  app.setErrorHandler((err, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500
    if (status >= 500) req.log.error(err)
    reply.status(status).send({ message: status >= 500 ? 'Error interno' : err.message })
  })
  app.setNotFoundHandler((req, reply) => {
    // fallback SPA: GET a ruta no-api sin match (deep links del router) sirve el shell;
    // /api/* y métodos no-GET siguen devolviendo 404 JSON
    if (serveSpa && req.method === 'GET' && !req.url.startsWith('/api')) {
      return reply.sendFile('index.html')
    }
    reply.status(404).send({ message: 'No encontrado' })
  })
  if (config.runMigrations) await migrateWithRetry(migrate)
  // sin fastify-plugin: se llama directo para que @fastify/secure-session
  // (que sí es fp) decore la instancia raíz y req.session sea visible
  await session(app)
  // multipart siempre registrado (no lo afecta skipStatic)
  await app.register(multipart, { attachFieldsToBody: false })
  app.decorate('query', (sql, values) => query(sql, values))
  app.decorateRequest('user', null)
  app.decorate('verifySession', verifySession)
  await app.register(health)
  await app.register(auth)
  await app.register(books)
  await app.register(annotations)
  // estático solo en producción (los tests usan skipStatic); si el build web
  // aún no existe, no se registra para no romper el arranque
  if (serveSpa) {
    await app.register(fastifyStatic, { root: path.resolve(config.webDist), wildcard: false })
  }
  return app
}

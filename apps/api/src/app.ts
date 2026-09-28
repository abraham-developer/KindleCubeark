import Fastify from 'fastify'
import { loadConfig } from './config.js'
import health from './routes/health.js'

export async function buildApp(opts: { skipStatic?: boolean; config?: Partial<ReturnType<typeof loadConfig>> } = {}) {
  const config = { ...loadConfig(), ...opts.config }
  const app = Fastify({ logger: false, bodyLimit: 1 })
  app.decorate('config', config)
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500
    reply.status(status).send({ message: status >= 500 ? 'Error interno' : err.message })
  })
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ message: 'No encontrado' }))
  await app.register(health)
  return app
}
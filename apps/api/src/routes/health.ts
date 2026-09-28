import type { FastifyInstance } from 'fastify'

// el healthcheck del swarm (interval de 5 s) decide reinicios: si Postgres no
// responde hay que fallar rápido, no colgar la conexión hasta que traefik
// dé timeout. El §9 de la spec exige 503 cuando la DB no está.
const DB_TIMEOUT_MS = 2000

export default async function health(app: FastifyInstance) {
  app.get('/api/health', async (_req, reply) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        app.query('SELECT 1'),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`SELECT 1 no respondió en ${DB_TIMEOUT_MS}ms`)),
            DB_TIMEOUT_MS,
          )
        }),
      ])
      clearTimeout(timer)
      return { ok: true }
    } catch {
      clearTimeout(timer)
      return reply.code(503).send({ ok: false })
    }
  })
}
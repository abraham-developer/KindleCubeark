import type { FastifyInstance } from 'fastify'
export default async function health(app: FastifyInstance) {
  app.get('/api/health', async () => ({ ok: true }))
}
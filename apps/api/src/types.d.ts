import type { Config } from './config.js'
import type { verifySession } from './plugins/auth.js'

declare module '@fastify/secure-session' {
  interface SessionData {
    userId: string
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    config: Config
    query<T extends import('pg').QueryResultRow>(sql: string, values?: unknown[]): Promise<import('pg').QueryResult<T>>
    verifySession: typeof verifySession
  }
  interface FastifyRequest {
    user: { id: string } | null
  }
}
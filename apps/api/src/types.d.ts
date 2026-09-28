import type { Config } from './config.js'
declare module 'fastify' {
  interface FastifyInstance {
    config: Config
  }
}
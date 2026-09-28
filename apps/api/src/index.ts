import { buildApp } from './app.js'
import { loadConfig } from './config.js'

const app = await buildApp()
const cfg = loadConfig()
await app.listen({ port: cfg.port, host: '0.0.0.0' })
app.log.info(`api escuchando en :${cfg.port}`)

// cierre graceful en SIGTERM/SIGINT (docker stop y el rolling update de swarm
// mandan SIGTERM): se drena el server y, como seguridad, se corta a los 10s
let closing = false
function shutdown(signal: string) {
  if (closing) return
  closing = true
  app.log.info(`${signal} recibido: cerrando`)
  const timeout = setTimeout(() => process.exit(1), 10_000)
  timeout.unref()
  app
    .close()
    .then(() => process.exit(0))
    .catch(() => process.exit(1))
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
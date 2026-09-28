import { buildApp } from './app.js'
import { loadConfig } from './config.js'

const app = await buildApp()
const cfg = loadConfig()
await app.listen({ port: cfg.port, host: '0.0.0.0' })
app.log.info(`api escuchando en :${cfg.port}`)
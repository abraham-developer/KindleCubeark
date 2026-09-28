import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// levanta el entrypoint real (tsx) en un puerto propio, espera a que responda
// /api/health y manda SIGTERM: el cierre graceful debe salir con código 0
// (sin handler, SIGTERM mata el proceso con signal y code null)
const apiDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const tsxBin = path.join(apiDir, 'node_modules/.bin/tsx')

describe('apagado graceful', () => {
  it('SIGTERM drena el server y sale con código 0', { timeout: 40_000 }, async () => {
    const child = spawn(tsxBin, ['src/index.ts'], {
      cwd: apiDir,
      env: { ...process.env, PORT: '3123', RUN_MIGRATIONS: 'false' },
      stdio: 'ignore',
    })
    // esperar el arranque
    const deadline = Date.now() + 20_000
    let up = false
    while (Date.now() < deadline && !up) {
      try {
        const res = await fetch('http://127.0.0.1:3123/api/health')
        if (res.ok) up = true
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
    }
    if (!up) {
      child.kill('SIGKILL')
      throw new Error('la API no arrancó en 20s')
    }
    const code = await new Promise<number>((resolve) => {
      child.on('exit', (exitCode) => resolve(exitCode ?? -1))
      child.kill('SIGTERM')
    })
    expect(code).toBe(0)
  })
})
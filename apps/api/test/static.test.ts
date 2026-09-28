import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildApp } from '../src/app.js'

// dist falso de la SPA para probar el fallback sin contenedores ni build web
const webDist = mkdtempSync(path.join(tmpdir(), 'kindle-webdist-'))
writeFileSync(path.join(webDist, 'index.html'), '<!doctype html><html lang="es"><title>SPA</title>')
afterAll(() => rmSync(webDist, { recursive: true, force: true }))

const build = () => buildApp({ config: { runMigrations: false, webDist } })

describe('servido de SPA', () => {
  it('GET a ruta no-api sin match sirve index.html (fallback SPA)', async () => {
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/login' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('SPA')
  })

  it('GET /api/* desconocida sigue devolviendo 404 JSON', async () => {
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('application/json')
  })

  it('POST a ruta no-api → 404 JSON (no intenta servir index.html)', async () => {
    const app = await build()
    const res = await app.inject({ method: 'POST', url: '/login' })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('application/json')
  })

  it('con skipStatic (tests) las rutas no-api siguen 404 JSON', async () => {
    const app = await buildApp({ skipStatic: true, config: { runMigrations: false, webDist } })
    const res = await app.inject({ method: 'GET', url: '/login' })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('application/json')
  })
})
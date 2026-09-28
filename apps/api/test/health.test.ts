import { describe, it, expect, afterEach, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { pool } from '../src/db.js'

describe('health', () => {
  afterEach(() => { vi.restoreAllMocks() })
  it('GET /api/health → 200 {"ok":true} con la DB viva', async () => {
    const app = await buildApp({ skipStatic: true, config: { runMigrations: false } })
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })
  it('GET /api/health → 503 {"ok":false} si la DB no responde', async () => {
    const app = await buildApp({ skipStatic: true, config: { runMigrations: false } })
    const down = vi.spyOn(pool, 'query').mockRejectedValue(new Error('la DB no está'))
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(down).toHaveBeenCalledWith('SELECT 1', undefined)
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ ok: false })
    await app.close()
  })
  it('rutas desconocidas devuelven JSON, no HTML', async () => {
    const app = await buildApp({ skipStatic: true, config: { runMigrations: false } })
    const res = await app.inject({ method: 'GET', url: '/api/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json().message).toBeTruthy()
  })
  it('POST con cuerpo JSON a ruta desconocida → 404 JSON, no 413', async () => {
    const app = await buildApp({ skipStatic: true, config: { runMigrations: false } })
    const res = await app.inject({
      method: 'POST',
      url: '/api/nope',
      payload: { hello: 'mundo con un cuerpo de más de un byte' },
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().message).toBeTruthy()
  })
})
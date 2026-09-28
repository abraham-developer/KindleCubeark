import { describe, it, expect, beforeAll } from 'vitest'
import { buildApp } from '../src/app.js'

describe('health', () => {
  it('GET /api/health → 200 {"ok":true}', async () => {
    const app = await buildApp({ skipStatic: true })
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })
  it('rutas desconocidas devuelven JSON, no HTML', async () => {
    const app = await buildApp({ skipStatic: true })
    const res = await app.inject({ method: 'GET', url: '/api/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json().message).toBeTruthy()
  })
})
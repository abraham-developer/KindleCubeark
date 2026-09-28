import { describe, it, expect, beforeAll } from 'vitest'
import { buildApp } from '../src/app.js'
import { resetDb } from './helpers/db.js'

const EMAIL = 'a@test.dev'
const PASSWORD = 'correct horse battery'

beforeAll(async () => { await resetDb() })

describe('auth', () => {
  it('register crea usuario y sesión', async () => {
    const app = await buildApp({ skipStatic: true })
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: EMAIL, password: PASSWORD } })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ email: EMAIL })
    expect(res.headers['set-cookie']).toBeTruthy()
  })
  it('register rechaza password corto y email duplicado', async () => {
    const app = await buildApp({ skipStatic: true })
    const short = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'b@test.dev', password: '123' } })
    expect(short.statusCode).toBe(400)
    const dup = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: EMAIL, password: PASSWORD } })
    expect(dup.statusCode).toBe(409)
  })
  it('login con credenciales correctas/incorrectas', async () => {
    const app = await buildApp({ skipStatic: true })
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: EMAIL, password: 'nope' } })
    expect(bad.statusCode).toBe(401)
    const ok = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: EMAIL, password: PASSWORD } })
    expect(ok.statusCode).toBe(200)
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { session: ok.cookies.find(c => c.name === 'session')!.value } })
    expect(me.json().email).toBe(EMAIL)
  })
  it('me sin sesión → 401; logout borra sesión', async () => {
    const app = await buildApp({ skipStatic: true })
    const anon = await app.inject({ method: 'GET', url: '/api/auth/me' })
    expect(anon.statusCode).toBe(401)
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout' })
    expect(out.statusCode).toBe(204)
  })
})
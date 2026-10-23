import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { resetDb } from './helpers/db.js'
import { pool } from '../src/db.js'
import { registerAndGetCookie } from './helpers/upload.js'
import { rm } from 'node:fs/promises'

const DATA_DIR = 'test-tmp/data'

beforeEach(async () => {
  await resetDb()
  await rm('test-tmp', { recursive: true, force: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await rm('test-tmp', { recursive: true, force: true })
  await pool.end().catch(() => {})
})

function postTranslate(app: any, cookie: string | null, body: unknown) {
  return app.inject({
    method: 'POST',
    url: '/api/translate',
    ...(cookie ? { cookies: { session: cookie } } : {}),
    payload: body,
  })
}

describe('translate', () => {
  it('sin sesión → 401', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    expect((await postTranslate(app, null, { q: 'Hola', target: 'en' })).statusCode).toBe(401)
    await app.close()
  })

  it('sin LIBRETRANSLATE_URL → 503 (servicio no configurado)', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR, translateUrl: '' } })
    const cookie = await registerAndGetCookie(app, 'trnofoot@test.dev')
    const res = await postTranslate(app, cookie, { q: 'Hola mundo', target: 'en' })
    expect(res.statusCode).toBe(503)
    expect(res.json().message).toMatch(/no configurado/i)
    await app.close()
  })

  it('valida texto e idioma de destino', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR, translateUrl: 'http://translate:5000' } })
    const cookie = await registerAndGetCookie(app, 'trval@test.dev')
    expect((await postTranslate(app, cookie, { q: '', target: 'en' })).statusCode).toBe(400)
    expect((await postTranslate(app, cookie, { q: '   ', target: 'en' })).statusCode).toBe(400)
    expect((await postTranslate(app, cookie, { q: 'x'.repeat(5001), target: 'en' })).statusCode).toBe(400)
    expect((await postTranslate(app, cookie, { q: 'Hola', target: 'pt' })).statusCode).toBe(400)
    expect((await postTranslate(app, cookie, { q: 'Hola' })).statusCode).toBe(400)
    await app.close()
  })

  it('proxya a LibreTranslate y devuelve translated_text', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR, translateUrl: 'http://translate:5000' } })
    const cookie = await registerAndGetCookie(app, 'trok@test.dev')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ translatedText: 'Hello world' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await postTranslate(app, cookie, { q: 'Hola mundo', target: 'en' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ translated_text: 'Hello world' })
    // el francés también es destino válido (modo bilingüe con francés)
    const resFr = await postTranslate(app, cookie, { q: 'Hola mundo', target: 'fr' })
    expect(resFr.statusCode).toBe(200)
    // el español también es destino válido (leer en otro idioma)
    const resEs = await postTranslate(app, cookie, { q: 'Hello world', target: 'es' })
    expect(resEs.statusCode).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://translate:5000/translate',
      expect.objectContaining({ method: 'POST' }),
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({ q: 'Hola mundo', source: 'auto', target: 'en', format: 'text' })
    await app.close()
  })

  it('falla 502 si el motor cae o responde mal', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR, translateUrl: 'http://translate:5000' } })
    const cookie = await registerAndGetCookie(app, 'trdown@test.dev')

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('conexión rechazada') }))
    expect((await postTranslate(app, cookie, { q: 'Hola', target: 'de' })).statusCode).toBe(502)

    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    expect((await postTranslate(app, cookie, { q: 'Hola', target: 'de' })).statusCode).toBe(502)

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })))
    expect((await postTranslate(app, cookie, { q: 'Hola', target: 'zh' })).statusCode).toBe(502)
    await app.close()
  })
})

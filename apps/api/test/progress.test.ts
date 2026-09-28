import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { buildApp } from '../src/app.js'
import { resetDb } from './helpers/db.js'
import { pool } from '../src/db.js'
import { makeTestPdf, makeTestEpub } from './fixtures.js'
import { registerAndGetCookie, uploadBook } from './helpers/upload.js'
import { rm } from 'node:fs/promises'

const DATA_DIR = 'test-tmp/data'

beforeEach(async () => {
  await resetDb()
  await rm('test-tmp', { recursive: true, force: true })
})

afterAll(async () => {
  await rm('test-tmp', { recursive: true, force: true })
  await pool.end().catch(() => {})
})

function patchProgress(app: any, cookie: string, bookId: string, body: unknown) {
  return app.inject({
    method: 'PATCH',
    url: `/api/books/${bookId}/progress`,
    cookies: { session: cookie },
    payload: body,
  })
}

function patchProgressPost(app: any, cookie: string, bookId: string, body: unknown) {
  return app.inject({
    method: 'POST',
    url: `/api/books/${bookId}/progress`,
    cookies: { session: cookie },
    payload: body,
  })
}

describe('progress', () => {
  it('upsert crea y luego actualiza la misma fila', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookie = await registerAndGetCookie(app, 'prog@test.dev')
    const book = await uploadBook(app, cookie, await makeTestPdf(50, 'Progreso'))

    const first = await app.inject({
      method: 'PATCH',
      url: `/api/books/${book.id}/progress`,
      cookies: { session: cookie },
      payload: { position: { page: 12 }, percent: 4 },
    })
    expect(first.statusCode).toBe(200)
    expect(first.json().position).toEqual({ page: 12 })
    expect(first.json().percent).toBe(4)
    expect(first.json().updated_at).toBeTruthy()

    const second = await patchProgress(app, cookie, book.id, { position: { page: 30 }, percent: 10 })
    expect(second.statusCode).toBe(200)
    expect(second.json().position).toEqual({ page: 30 })
    expect(second.json().percent).toBe(10)

    const { rows } = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM reading_progress')
    expect(Number(rows[0].count)).toBe(1)
    await app.close()
  })

  it('rechaza position inválida para el formato', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookie = await registerAndGetCookie(app, 'progval@test.dev')
    const pdf = await uploadBook(app, cookie, await makeTestPdf(3, 'PDF corto'))
    const epub = await uploadBook(app, cookie, makeTestEpub({ title: 'EPUB prog' }), 'libro.epub', 'application/epub+zip')

    expect((await patchProgress(app, cookie, pdf.id, { position: { page: 0 }, percent: 1 })).statusCode).toBe(400)
    expect((await patchProgress(app, cookie, pdf.id, { position: { page: 9999 }, percent: 1 })).statusCode).toBe(400)
    expect((await patchProgress(app, cookie, pdf.id, { position: { page: 1.5 }, percent: 1 })).statusCode).toBe(400)
    expect((await patchProgress(app, cookie, epub.id, { position: {}, percent: 1 })).statusCode).toBe(400)
    expect((await patchProgress(app, cookie, epub.id, { position: { cfi: '' }, percent: 1 })).statusCode).toBe(400)

    // nada se escribió para las inválidas
    const { rows } = await pool.query('SELECT COUNT(*) FROM reading_progress')
    expect(Number(rows[0].count)).toBe(0)
    await app.close()
  })

  it('percent se acota a [0, 100]', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookie = await registerAndGetCookie(app, 'progpct@test.dev')
    const book = await uploadBook(app, cookie, await makeTestPdf(5, 'Pct'))

    const low = await patchProgress(app, cookie, book.id, { position: { page: 1 }, percent: -20 })
    expect(low.json().percent).toBe(0)
    const high = await patchProgress(app, cookie, book.id, { position: { page: 2 }, percent: 150 })
    expect(high.json().percent).toBe(100)
    const def = await patchProgress(app, cookie, book.id, { position: { page: 3 } })
    expect(def.json().percent).toBe(0)
    await app.close()
  })

  it('EPUB acepta position con cfi (+ percent y section opcionales)', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookie = await registerAndGetCookie(app, 'progepub@test.dev')
    const book = await uploadBook(app, cookie, makeTestEpub({ title: 'EPUB cfi' }), 'libro.epub', 'application/epub+zip')

    const res = await patchProgress(app, cookie, book.id, { position: { cfi: 'epubcfi(/6/4)', section: 1 }, percent: 33.5 })
    expect(res.statusCode).toBe(200)
    expect(res.json().position).toEqual({ cfi: 'epubcfi(/6/4)', section: 1 })
    expect(res.json().percent).toBe(33.5)
    await app.close()
  })

  it('POST es alias de PATCH (sendBeacon) con la misma semántica y una sola fila', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookie = await registerAndGetCookie(app, 'progbeacon@test.dev')
    const book = await uploadBook(app, cookie, await makeTestPdf(50, 'Beacon'))

    // PATCH escribe primero; POST (beacon) actualiza la MISMA fila
    await patchProgress(app, cookie, book.id, { position: { page: 1 }, percent: 2 })
    const post = await app.inject({
      method: 'POST',
      url: `/api/books/${book.id}/progress`,
      cookies: { session: cookie },
      payload: { position: { page: 2 }, percent: 50 },
    })
    expect(post.statusCode).toBe(200)
    expect(post.json().position).toEqual({ page: 2 })
    expect(post.json().percent).toBe(50)
    expect(post.json().updated_at).toBeTruthy()

    const { rows } = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM reading_progress')
    expect(Number(rows[0].count)).toBe(1)

    // el POST valida igual que el PATCH (400 sin sesión/posición inválida)
    expect((await app.inject({ method: 'POST', url: `/api/books/${book.id}/progress`, payload: { position: { page: 9999 } } })).statusCode).toBe(401)
    expect((await patchProgressPost(app, cookie, book.id, { position: { page: 0 } })).statusCode).toBe(400)
    await app.close()
  })

  it('DELETE resetea (404 después de resetear dos veces es 204 igual)', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookie = await registerAndGetCookie(app, 'progdel@test.dev')
    const book = await uploadBook(app, cookie, await makeTestPdf(10, 'Reset'))

    await patchProgress(app, cookie, book.id, { position: { page: 5 }, percent: 50 })
    const del = await app.inject({ method: 'DELETE', url: `/api/books/${book.id}/progress`, cookies: { session: cookie } })
    expect(del.statusCode).toBe(204)

    // idempotente: borrar dos veces sigue siendo 204
    const del2 = await app.inject({ method: 'DELETE', url: `/api/books/${book.id}/progress`, cookies: { session: cookie } })
    expect(del2.statusCode).toBe(204)

    const { rows } = await pool.query('SELECT COUNT(*) FROM reading_progress')
    expect(Number(rows[0].count)).toBe(0)
    await app.close()
  })

  it('otro usuario no puede escribir el progreso → 404', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookieA = await registerAndGetCookie(app, 'progown@test.dev')
    const cookieB = await registerAndGetCookie(app, 'progother@test.dev')
    const book = await uploadBook(app, cookieA, await makeTestPdf(10, 'Ajeno'))

    const res = await patchProgress(app, cookieB, book.id, { position: { page: 1 }, percent: 10 })
    expect(res.statusCode).toBe(404)
    // el reset de un ajeno tampoco toca nada
    const del = await app.inject({ method: 'DELETE', url: `/api/books/${book.id}/progress`, cookies: { session: cookieB } })
    expect(del.statusCode).toBe(204)
    const { rows } = await pool.query('SELECT COUNT(*) FROM reading_progress')
    expect(Number(rows[0].count)).toBe(0)
    await app.close()
  })

  it('sin sesión → 401', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookie = await registerAndGetCookie(app, 'proganon@test.dev')
    const book = await uploadBook(app, cookie, await makeTestPdf(2, 'Anon'))

    expect((await app.inject({ method: 'PATCH', url: `/api/books/${book.id}/progress`, payload: { position: { page: 1 } } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'DELETE', url: `/api/books/${book.id}/progress` })).statusCode).toBe(401)
    await app.close()
  })
})
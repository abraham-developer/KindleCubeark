import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { buildApp } from '../src/app.js'
import { resetDb } from './helpers/db.js'
import { pool } from '../src/db.js'
import { registerAndGetCookie, uploadBook } from './helpers/upload.js'
import { makeTestPdf } from './fixtures.js'
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

async function setup(email: string) {
  const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
  const cookie = await registerAndGetCookie(app, email)
  const book = await uploadBook(app, cookie, await makeTestPdf(1))
  return { app, cookie, bookId: book.id as string }
}

const progress = {
  word_index: 42, char_index: 3, total_words: 500,
  keyboard_layout: 'azerty-fr', target_lang: 'fr', bilingual: true,
}
const score = {
  wpm: 38.5, accuracy: 96.2, score: 812, words_completed: 30, errors: 4,
  duration_ms: 45_000, keyboard_layout: 'azerty-fr', target_lang: 'fr', bilingual: true,
}

describe('typing', () => {
  it('sin sesión → 401 y libro ajeno personal → 404', async () => {
    const { app, bookId } = await setup('ty1@test.dev')
    expect((await app.inject({ method: 'GET', url: `/api/books/${bookId}/typing` })).statusCode).toBe(401)
    const other = await registerAndGetCookie(app, 'ty2@test.dev')
    const res = await app.inject({ method: 'GET', url: `/api/books/${bookId}/typing`, cookies: { session: other } })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('guarda y retoma el progreso por libro, y lo reinicia conservando puntuaciones', async () => {
    const { app, cookie, bookId } = await setup('ty3@test.dev')
    const put = await app.inject({ method: 'PUT', url: `/api/books/${bookId}/typing/progress`, cookies: { session: cookie }, payload: progress })
    expect(put.statusCode).toBe(200)
    expect(put.json()).toMatchObject(progress)

    const got = await app.inject({ method: 'GET', url: `/api/books/${bookId}/typing`, cookies: { session: cookie } })
    expect(got.json().progress).toMatchObject(progress)
    expect(got.json().scores).toEqual([])

    const posted = await app.inject({ method: 'POST', url: `/api/books/${bookId}/typing/scores`, cookies: { session: cookie }, payload: score })
    expect(posted.statusCode).toBe(201)
    expect(posted.json()).toMatchObject(score)

    const del = await app.inject({ method: 'DELETE', url: `/api/books/${bookId}/typing/progress`, cookies: { session: cookie } })
    expect(del.statusCode).toBe(204)
    const after = await app.inject({ method: 'GET', url: `/api/books/${bookId}/typing`, cookies: { session: cookie } })
    expect(after.json().progress).toBeNull()
    expect(after.json().scores).toHaveLength(1)
    expect(after.json().best).toMatchObject({ score: 812 })
    await app.close()
  })

  it('valida layout, idioma y rangos', async () => {
    const { app, cookie, bookId } = await setup('ty4@test.dev')
    const badLayout = await app.inject({ method: 'PUT', url: `/api/books/${bookId}/typing/progress`, cookies: { session: cookie }, payload: { ...progress, keyboard_layout: 'colemak' } })
    expect(badLayout.statusCode).toBe(400)
    const badLang = await app.inject({ method: 'POST', url: `/api/books/${bookId}/typing/scores`, cookies: { session: cookie }, payload: { ...score, target_lang: 'pt' } })
    expect(badLang.statusCode).toBe(400)
    const badWpm = await app.inject({ method: 'POST', url: `/api/books/${bookId}/typing/scores`, cookies: { session: cookie }, payload: { ...score, wpm: 999 } })
    expect(badWpm.statusCode).toBe(400)
    await app.close()
  })
})

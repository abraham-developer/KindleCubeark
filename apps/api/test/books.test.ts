import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { buildApp } from '../src/app.js'
import { resetDb } from './helpers/db.js'
import { pool } from '../src/db.js'
import { makeTestPdf, makeTestEpub, jpeg1x1, png1x1 } from './fixtures.js'
import { registerAndGetCookie, uploadBook, multipartBody, BOUNDARY } from './helpers/upload.js'
import { readdir, rm } from 'node:fs/promises'

const DATA_DIR = 'test-tmp/data'

beforeEach(async () => {
  await resetDb()
  await rm('test-tmp', { recursive: true, force: true })
})

afterAll(async () => {
  await rm('test-tmp', { recursive: true, force: true })
  await pool.end().catch(() => {})
})

async function uploadCover(app: any, cookie: string, bookId: string, img: Buffer, mode: 'raw' | 'multipart', type = 'image/jpeg') {
  if (mode === 'raw') {
    return app.inject({
      method: 'PATCH',
      url: `/api/books/${bookId}/cover`,
      cookies: { session: cookie },
      headers: { 'content-type': type },
      payload: img,
    })
  }
  return app.inject({
    method: 'PATCH',
    url: `/api/books/${bookId}/cover`,
    cookies: { session: cookie },
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: multipartBody(img, 'portada.jpg', type, 'cover'),
  })
}

describe('books', () => {
  it('lista del usuario con su progreso', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookieA = await registerAndGetCookie(app, 'a@test.dev')
    const buf = await makeTestPdf(4, 'Libro de A')
    const book = await uploadBook(app, cookieA, buf)
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { session: cookieA } })
    await pool.query(
      'INSERT INTO reading_progress (user_id, book_id, position, percent) VALUES ($1,$2,$3,$4)',
      [me.json().id, book.id, JSON.stringify({ page: 2 }), 50],
    )

    const resA = await app.inject({ method: 'GET', url: '/api/books', cookies: { session: cookieA } })
    expect(resA.statusCode).toBe(200)
    const list = resA.json()
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe('Libro de A')
    expect(list[0].format).toBe('pdf')
    expect(parseFloat(list[0].percent)).toBe(50)
    expect(list[0].position).toEqual({ page: 2 })
    expect(list[0].last_read).toBeTruthy()
    // no expone rutas de disco; expone URLs servibles
    expect(list[0].file_path).toBeUndefined()
    expect(list[0].cover_path).toBeUndefined()
    expect(list[0].file_url).toBe(`/api/files/${list[0].user_id}/${book.id}.pdf`)
    expect(list[0].cover_url).toBeNull()

    // progreso embebido: null para un libro sin fila en reading_progress
    const cookieB = await registerAndGetCookie(app, 'b@test.dev')
    const resB = await app.inject({ method: 'GET', url: '/api/books', cookies: { session: cookieB } })
    expect(resB.statusCode).toBe(200)
    expect(resB.json()).toEqual([])
    await app.close()
  })

  it('GET /api/books/:id devuelve {book, progress}; el de otro usuario → 404', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookieA = await registerAndGetCookie(app, 'a2@test.dev')
    const cookieB = await registerAndGetCookie(app, 'b2@test.dev')
    const book = await uploadBook(app, cookieA, await makeTestPdf(2, 'De A'))

    const own = await app.inject({ method: 'GET', url: `/api/books/${book.id}`, cookies: { session: cookieA } })
    expect(own.statusCode).toBe(200)
    expect(own.json().book.title).toBe('De A')
    expect(own.json().book.file_path).toBeUndefined()
    expect(own.json().book.file_url).toBe(`/api/files/${own.json().book.user_id}/${book.id}.pdf`)
    expect(own.json().progress).toBeNull()

    const other = await app.inject({ method: 'GET', url: `/api/books/${book.id}`, cookies: { session: cookieB } })
    expect(other.statusCode).toBe(404)

    const anon = await app.inject({ method: 'GET', url: `/api/books/${book.id}` })
    expect(anon.statusCode).toBe(401)
    await app.close()
  })

  it('DELETE borra registro y archivos de disco', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookieA = await registerAndGetCookie(app, 'del@test.dev')
    const cookieB = await registerAndGetCookie(app, 'del2@test.dev')
    const book = await uploadBook(app, cookieA, makeTestEpub({ title: 'Borrar', withCover: true }))
    const filesBefore = await readdir(`${DATA_DIR}/${book.user_id}`)
    expect(filesBefore).toHaveLength(2) // .epub + .jpg

    const other = await app.inject({ method: 'DELETE', url: `/api/books/${book.id}`, cookies: { session: cookieB } })
    expect(other.statusCode).toBe(404)
    expect(await readdir(`${DATA_DIR}/${book.user_id}`)).toHaveLength(2)

    const res = await app.inject({ method: 'DELETE', url: `/api/books/${book.id}`, cookies: { session: cookieA } })
    expect(res.statusCode).toBe(204)
    expect(await readdir(`${DATA_DIR}/${book.user_id}`)).toEqual([])
    const gone = await app.inject({ method: 'GET', url: `/api/books/${book.id}`, cookies: { session: cookieA } })
    expect(gone.statusCode).toBe(404)
    await app.close()
  })

  it('GET /api/files/:userId/:file con cookie del dueño → 200 y bytes correctos', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookieA = await registerAndGetCookie(app, 'file@test.dev')
    const buf = await makeTestPdf(2, 'Archivo')
    const book = await uploadBook(app, cookieA, buf)

    const res = await app.inject({ method: 'GET', url: book.file_url, cookies: { session: cookieA } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.rawPayload.equals(buf)).toBe(true)
    await app.close()
  })

  it('GET /api/files/:userId/:file con cookie de otro → 404 (y casos raros, nunca 403)', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookieA = await registerAndGetCookie(app, 'iso@test.dev')
    const cookieB = await registerAndGetCookie(app, 'iso2@test.dev')
    const buf = await makeTestPdf(2, 'Aislado')
    const book = await uploadBook(app, cookieA, buf)
    const fileUrl: string = book.file_url

    const other = await app.inject({ method: 'GET', url: fileUrl, cookies: { session: cookieB } })
    expect(other.statusCode).toBe(404)

    // sin cookie → 401; archivo inexistente o traversal → 404
    expect((await app.inject({ method: 'GET', url: fileUrl })).statusCode).toBe(401)
    const userId = book.user_id
    expect((await app.inject({ method: 'GET', url: `/api/files/${userId}/no-existe.pdf`, cookies: { session: cookieA } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `/api/files/${userId}/..%2Fsecret.pdf`, cookies: { session: cookieA } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `/api/files/${userId}/${book.id}.png`, cookies: { session: cookieA } })).statusCode).toBe(404)
    await app.close()
  })
})

describe('cover', () => {
  it('PATCH /cover (cuerpo raw JPEG) guarda y sirve la portada', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookie = await registerAndGetCookie(app, 'cover@test.dev')
    const book = await uploadBook(app, cookie, await makeTestPdf(1, 'Con portada'))
    const img = jpeg1x1()

    const res = await uploadCover(app, cookie, book.id, img, 'raw')
    expect(res.statusCode).toBe(200)
    const updated = res.json()
    expect(updated.cover_path).toBeUndefined()
    expect(updated.cover_url).toBe(`/api/files/${updated.user_id}/${book.id}.jpg`)
    expect(updated.file_url).toBe(`/api/files/${updated.user_id}/${book.id}.pdf`)

    const served = await app.inject({ method: 'GET', url: updated.cover_url, cookies: { session: cookie } })
    expect(served.statusCode).toBe(200)
    expect(served.headers['content-type']).toBe('image/jpeg')
    expect(served.rawPayload.equals(img)).toBe(true)
    await app.close()
  })

  it('PATCH /cover multipart (image field) también funciona', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookie = await registerAndGetCookie(app, 'covermp@test.dev')
    const book = await uploadBook(app, cookie, await makeTestPdf(1, 'Multipart'))
    const img = jpeg1x1()

    const res = await uploadCover(app, cookie, book.id, img, 'multipart')
    expect(res.statusCode).toBe(200)
    expect(res.json().cover_url).toBe(`/api/files/${res.json().user_id}/${book.id}.jpg`)
    await app.close()
  })

  it('PATCH /cover con PNG → cover_url con .png', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookie = await registerAndGetCookie(app, 'coverpng@test.dev')
    const book = await uploadBook(app, cookie, await makeTestPdf(1, 'PNG'))

    const res = await uploadCover(app, cookie, book.id, png1x1(), 'raw', 'image/png')
    expect(res.statusCode).toBe(200)
    const updated = res.json()
    expect(updated.cover_url).toBe(`/api/files/${updated.user_id}/${book.id}.png`)
    const served = await app.inject({ method: 'GET', url: updated.cover_url, cookies: { session: cookie } })
    expect(served.headers['content-type']).toBe('image/png')
    await app.close()
  })

  it('PATCH /cover rechaza bytes que no son imagen (sin tocar la portada previa)', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookie = await registerAndGetCookie(app, 'coverbad@test.dev')
    const book = await uploadBook(app, cookie, makeTestEpub({ title: 'Ya con cover', withCover: true }))
    const before = await app.inject({ method: 'GET', url: `/api/books/${book.id}`, cookies: { session: cookie } })

    const res = await uploadCover(app, cookie, book.id, Buffer.from('no es imagen'), 'raw')
    expect(res.statusCode).toBe(400)
    const after = await app.inject({ method: 'GET', url: `/api/books/${book.id}`, cookies: { session: cookie } })
    expect(after.json().book.cover_url).toBe(before.json().book.cover_url)
    await app.close()
  })

  it('PATCH /cover de otro usuario → 404', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookieA = await registerAndGetCookie(app, 'coverown@test.dev')
    const cookieB = await registerAndGetCookie(app, 'coverother@test.dev')
    const book = await uploadBook(app, cookieA, await makeTestPdf(1, 'Ajeno'))

    const res = await uploadCover(app, cookieB, book.id, jpeg1x1(), 'raw')
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('reemplazar la portada cambia la extensión y borra el archivo viejo', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookie = await registerAndGetCookie(app, 'coverrepl@test.dev')
    const book = await uploadBook(app, cookie, await makeTestPdf(1, 'Reemplazo'))

    const first = await uploadCover(app, cookie, book.id, png1x1(), 'raw', 'image/png')
    expect(first.json().cover_url).toBe(`/api/files/${book.user_id}/${book.id}.png`)
    const second = await uploadCover(app, cookie, book.id, jpeg1x1(), 'raw')
    expect(second.statusCode).toBe(200)
    expect(second.json().cover_url).toBe(`/api/files/${book.user_id}/${book.id}.jpg`)

    const files = await readdir(`${DATA_DIR}/${book.user_id}`)
    expect(files.filter((f) => f.endsWith('.png'))).toEqual([])
    expect(files).toContain(`${book.id}.jpg`)
    // la portada vieja ya no se sirve
    expect((await app.inject({ method: 'GET', url: `/api/files/${book.user_id}/${book.id}.png`, cookies: { session: cookie } })).statusCode).toBe(404)
    await app.close()
  })
})
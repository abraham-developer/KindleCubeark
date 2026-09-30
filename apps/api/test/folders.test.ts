// apps/api/test/folders.test.ts — esquema de carpetas y efecto de borrarlas (Task 1).
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { buildApp } from '../src/app.js'
import { resetDb } from './helpers/db.js'
import { registerAndGetCookie, uploadBook } from './helpers/upload.js'
import { pool } from '../src/db.js'
import { makeTestPdf } from './fixtures.js'

beforeEach(async () => { await resetDb() })
afterAll(async () => { await pool.end().catch(() => {}) })

const build = async () => buildApp({ skipStatic: true })

describe('folders API', () => {
  it('POST crea, normaliza color a minúsculas y GET lista con book_count', async () => {
    const app = await build()
    const cookie = await registerAndGetCookie(app, 'a@test.dev')

    const res = await app.inject({
      method: 'POST', url: '/api/folders', cookies: { session: cookie },
      payload: { name: '  Novelas  ', color: '#FF00AA' },
    })
    expect(res.statusCode).toBe(201)
    const folder = res.json()
    expect(folder.name).toBe('Novelas')
    expect(folder.color).toBe('#ff00aa')
    expect(folder.book_count).toBe(0)
    expect(folder.created_at).toBeTruthy()
    expect(folder.id).toMatch(/^[0-9a-f-]{36}$/)

    const list = await app.inject({ method: 'GET', url: '/api/folders', cookies: { session: cookie } })
    expect(list.statusCode).toBe(200)
    expect(list.json()).toEqual([folder])
  })

  it('GET no lista carpetas de otro usuario', async () => {
    const app = await build()
    const cookieA = await registerAndGetCookie(app, 'a@test.dev')
    const cookieB = await registerAndGetCookie(app, 'b@test.dev')
    await app.inject({ method: 'POST', url: '/api/folders', cookies: { session: cookieA },
      payload: { name: 'De A', color: '#ff00aa' } })

    const res = await app.inject({ method: 'GET', url: '/api/folders', cookies: { session: cookieB } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })

  it('book_count cuenta los libros de la carpeta', async () => {
    const app = await build()
    const cookie = await registerAndGetCookie(app, 'a@test.dev')
    const folder = (await app.inject({ method: 'POST', url: '/api/folders', cookies: { session: cookie },
      payload: { name: 'C', color: '#ff00aa' } })).json()
    const { rows: [u] } = await pool.query("SELECT id FROM users WHERE email = 'a@test.dev'")
    await pool.query(
      `INSERT INTO books (user_id, title, format, file_path, file_size, folder_id)
       VALUES ($1,'L1','pdf','x/1.pdf',1,$2), ($1,'L2','epub','x/2.epub',1,$2), ($1,'L3','pdf','x/3.pdf',1,NULL)`,
      [u.id, folder.id],
    )
    const list = await app.inject({ method: 'GET', url: '/api/folders', cookies: { session: cookie } })
    expect(list.json()).toEqual([expect.objectContaining({ id: folder.id, book_count: 2 })])
  })

  it.each([
    ['nombre vacío', { name: '   ', color: '#ff00aa' }],
    ['nombre > 60', { name: 'x'.repeat(61), color: '#ff00aa' }],
    ['color inválido', { name: 'Ok', color: '#fff' }],
    ['color no hex', { name: 'Ok', color: 'red' }],
    ['color con alpha', { name: 'Ok', color: '#ff00aaff' }],
  ])('400 con %s', async (_label, payload) => {
    const app = await build()
    const cookie = await registerAndGetCookie(app, 'a@test.dev')
    const res = await app.inject({ method: 'POST', url: '/api/folders', cookies: { session: cookie }, payload })
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toBeTruthy()
  })

  it.each([
    ['sin cuerpo', undefined],
    ['solo name', { name: 'X' }],
    ['solo color', { color: '#ff00aa' }],
  ])('400 en POST con %s', async (_label, payload) => {
    const app = await build()
    const cookie = await registerAndGetCookie(app, 'a@test.dev')
    const res = await app.inject({ method: 'POST', url: '/api/folders', cookies: { session: cookie },
      ...(payload === undefined ? {} : { payload }) as any })
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toBe('El nombre y el color son obligatorios')
  })

  it('401 sin sesión', async () => {
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/folders' })
    expect(res.statusCode).toBe(401)
  })
})

describe('folders PATCH y DELETE', () => {
  async function makeFolder(app: any, cookie: string, name = 'Origen') {
    return (await app.inject({ method: 'POST', url: '/api/folders', cookies: { session: cookie },
      payload: { name, color: '#ff00aa' } })).json()
  }

  it('PATCH renombra y recolorea', async () => {
    const app = await build()
    const cookie = await registerAndGetCookie(app, 'a@test.dev')
    const folder = await makeFolder(app, cookie)

    const res = await app.inject({ method: 'PATCH', url: `/api/folders/${folder.id}`,
      cookies: { session: cookie }, payload: { name: ' Renombrada ', color: '#ABCDEF' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(expect.objectContaining({ name: 'Renombrada', color: '#abcdef' }))
  })

  it('PATCH con un solo campo cambia solo ese campo', async () => {
    const app = await build()
    const cookie = await registerAndGetCookie(app, 'a@test.dev')
    const folder = await makeFolder(app, cookie)
    const res = await app.inject({ method: 'PATCH', url: `/api/folders/${folder.id}`,
      cookies: { session: cookie }, payload: { color: '#123456' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(expect.objectContaining({ name: 'Origen', color: '#123456' }))
  })

  it('400 si PATCH no manda ni name ni color; 400 con valores inválidos', async () => {
    const app = await build()
    const cookie = await registerAndGetCookie(app, 'a@test.dev')
    const folder = await makeFolder(app, cookie)
    for (const payload of [{}, { name: '  ' }, { color: 'zzz' }]) {
      const res = await app.inject({ method: 'PATCH', url: `/api/folders/${folder.id}`,
        cookies: { session: cookie }, payload })
      expect(res.statusCode).toBe(400)
    }
  })

  it('PATCH y DELETE de carpeta ajena o inexistente → 404', async () => {
    const app = await build()
    const cookieA = await registerAndGetCookie(app, 'a@test.dev')
    const cookieB = await registerAndGetCookie(app, 'b@test.dev')
    const folder = await makeFolder(app, cookieA)

    const patch = await app.inject({ method: 'PATCH', url: `/api/folders/${folder.id}`,
      cookies: { session: cookieB }, payload: { name: 'Hack' } })
    expect(patch.statusCode).toBe(404)
    const del = await app.inject({ method: 'DELETE', url: `/api/folders/${folder.id}`,
      cookies: { session: cookieB } })
    expect(del.statusCode).toBe(404)
  })

  it('DELETE deja los libros con folder_id NULL', async () => {
    const app = await build()
    const cookie = await registerAndGetCookie(app, 'a@test.dev')
    const folder = await makeFolder(app, cookie)
    const { rows: [u] } = await pool.query("SELECT id FROM users WHERE email = 'a@test.dev'")
    const { rows: [book] } = await pool.query(
      `INSERT INTO books (user_id, title, format, file_path, file_size, folder_id)
       VALUES ($1,'L','pdf','x/1.pdf',1,$2) RETURNING *`, [u.id, folder.id],
    )

    const res = await app.inject({ method: 'DELETE', url: `/api/folders/${folder.id}`,
      cookies: { session: cookie } })
    expect(res.statusCode).toBe(204)

    const { rows: [after] } = await pool.query('SELECT folder_id FROM books WHERE id = $1', [book.id])
    expect(after.folder_id).toBeNull()
  })
})

describe('books folder (mover/sacar)', () => {
  async function setup(app: any) {
    const cookie = await registerAndGetCookie(app, 'a@test.dev')
    const book = await uploadBook(app, cookie, await makeTestPdf(2))
    const folder = (await app.inject({ method: 'POST', url: '/api/folders', cookies: { session: cookie },
      payload: { name: 'N', color: '#ff00aa' } })).json()
    return { cookie, book, folder }
  }

  it('GET /api/books expone folder_id (null al inicio, asignado tras PATCH)', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: 'test-tmp/data' } })
    const { cookie, book, folder } = await setup(app)

    let list = (await app.inject({ method: 'GET', url: '/api/books', cookies: { session: cookie } })).json()
    expect(list[0].folder_id).toBeNull()

    const res = await app.inject({ method: 'PATCH', url: `/api/books/${book.id}/folder`,
      cookies: { session: cookie }, payload: { folder_id: folder.id } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(expect.objectContaining({ id: book.id, folder_id: folder.id }))

    list = (await app.inject({ method: 'GET', url: '/api/books', cookies: { session: cookie } })).json()
    expect(list[0].folder_id).toBe(folder.id)
  })

  it('sacar con folder_id null', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: 'test-tmp/data' } })
    const { cookie, book, folder } = await setup(app)
    await app.inject({ method: 'PATCH', url: `/api/books/${book.id}/folder`,
      cookies: { session: cookie }, payload: { folder_id: folder.id } })

    const res = await app.inject({ method: 'PATCH', url: `/api/books/${book.id}/folder`,
      cookies: { session: cookie }, payload: { folder_id: null } })
    expect(res.statusCode).toBe(200)
    expect(res.json().folder_id).toBeNull()
  })

  it('400 si folder_id no es null ni uuid', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: 'test-tmp/data' } })
    const { cookie, book } = await setup(app)
    const res = await app.inject({ method: 'PATCH', url: `/api/books/${book.id}/folder`,
      cookies: { session: cookie }, payload: { folder_id: 'pepe' } })
    expect(res.statusCode).toBe(400)
  })

  it('404 con carpeta ajena/inexistente y con libro ajeno; 401 sin sesión', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: 'test-tmp/data' } })
    const cookieA = await registerAndGetCookie(app, 'a@test.dev')
    const cookieB = await registerAndGetCookie(app, 'b@test.dev')
    const folderA = (await app.inject({ method: 'POST', url: '/api/folders', cookies: { session: cookieA },
      payload: { name: 'De A', color: '#ff00aa' } })).json()
    const bookB = await uploadBook(app, cookieB, await makeTestPdf(2))

    // carpeta de A, libro de B: la búsqueda de carpeta scopea por usuario → 404
    const res1 = await app.inject({ method: 'PATCH', url: `/api/books/${bookB.id}/folder`,
      cookies: { session: cookieB }, payload: { folder_id: folderA.id } })
    expect(res1.statusCode).toBe(404)

    // libro de B, sesión de A → 404
    const res2 = await app.inject({ method: 'PATCH', url: `/api/books/${bookB.id}/folder`,
      cookies: { session: cookieA }, payload: { folder_id: null } })
    expect(res2.statusCode).toBe(404)

    const res3 = await app.inject({ method: 'PATCH', url: '/api/books/00000000-0000-4000-8000-000000000000/folder',
      cookies: { session: cookieA }, payload: { folder_id: null } })
    expect(res3.statusCode).toBe(404)

    const noSesion = await app.inject({ method: 'PATCH', url: `/api/books/${bookB.id}/folder`,
      payload: { folder_id: null } })
    expect(noSesion.statusCode).toBe(401)
  })
})

describe('esquema de carpetas', () => {
  it('crea la tabla folders y el FK books.folder_id con ON DELETE SET NULL', async () => {
    await buildApp({ skipStatic: true })
    const { rows: u } = await pool.query(
      "INSERT INTO users (email, password_hash) VALUES ('f@test.dev','x') RETURNING id",
    )
    const { rows: [folder] } = await pool.query(
      `INSERT INTO folders (user_id, name, color) VALUES ($1, 'Novelas', '#ff00aa') RETURNING *`,
      [u[0].id],
    )
    expect(folder.color).toBe('#ff00aa')

    const { rows: [book] } = await pool.query(
      `INSERT INTO books (user_id, title, format, file_path, file_size, folder_id)
       VALUES ($1,'Libro','pdf','x/libro.pdf',10,$2) RETURNING *`,
      [u[0].id, folder.id],
    )
    expect(book.folder_id).toBe(folder.id)

    await pool.query('DELETE FROM folders WHERE id = $1', [folder.id])
    const { rows: [after] } = await pool.query('SELECT folder_id FROM books WHERE id = $1', [book.id])
    expect(after.folder_id).toBeNull()
  })

  it('rechaza un color con formato inválido (CHECK de la migración)', async () => {
    await buildApp({ skipStatic: true })
    const { rows: [u] } = await pool.query(
      "INSERT INTO users (email, password_hash) VALUES ('f2@test.dev','x') RETURNING id",
    )
    await expect(pool.query(
      `INSERT INTO folders (user_id, name, color) VALUES ($1, 'X', 'red')`, [u.id],
    )).rejects.toThrow()
  })
})
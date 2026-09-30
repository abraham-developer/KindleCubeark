// apps/api/test/folders.test.ts — esquema de carpetas y efecto de borrarlas (Task 1).
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { buildApp } from '../src/app.js'
import { resetDb } from './helpers/db.js'
import { registerAndGetCookie } from './helpers/upload.js'
import { pool } from '../src/db.js'

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

  it('401 sin sesión', async () => {
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/folders' })
    expect(res.statusCode).toBe(401)
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
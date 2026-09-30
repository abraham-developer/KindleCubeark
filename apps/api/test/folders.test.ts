// apps/api/test/folders.test.ts — esquema de carpetas y efecto de borrarlas (Task 1).
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { buildApp } from '../src/app.js'
import { resetDb } from './helpers/db.js'
import { pool } from '../src/db.js'

beforeEach(async () => { await resetDb() })
afterAll(async () => { await pool.end().catch(() => {}) })

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
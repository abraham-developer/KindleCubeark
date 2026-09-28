import { pool } from '../../src/db.js'

export async function resetDb() {
  // tolera una base recién creada donde aún no existen las tablas (42P01)
  await pool.query('TRUNCATE annotations, reading_progress, books, users CASCADE').catch((err: { code?: string }) => {
    if (err.code !== '42P01') throw err
  })
}
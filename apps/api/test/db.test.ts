import { describe, it, expect } from 'vitest'
import { migrate } from '../src/migrate.js'
import { query } from '../src/db.js'
import { resetDb } from './helpers/db.js'

describe('db', () => {
  it('migrate crea las tablas', async () => {
    await resetDb(); await migrate()
    const { rows } = await query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`)
    const names = rows.map(r => r.table_name)
    expect(names).toEqual(expect.arrayContaining(['users', 'books', 'reading_progress', 'annotations']))
  })
})
import { describe, it, expect } from 'vitest'
import { writeFile, unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { migrate } from '../src/migrate.js'
import { query } from '../src/db.js'
import { resetDb } from './helpers/db.js'

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url))

describe('db', () => {
  it('migrate crea las tablas', async () => {
    await resetDb(); await migrate()
    const { rows } = await query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`)
    const names = rows.map(r => r.table_name)
    expect(names).toEqual(expect.arrayContaining(['users', 'books', 'reading_progress', 'annotations']))
  })

  it('migración atómica: un fallo no deja DDL parcial ni fila en _migrations', async () => {
    await resetDb(); await migrate()
    // primera sentencia válida + segunda inválida → debe fallar y deshacer TODO el archivo
    await writeFile(`${migrationsDir}/002_atomic_test.sql`, 'CREATE TABLE atomicity_probe(id int); ESTO NO ES SQL VALIDO;')
    try {
      await expect(migrate()).rejects.toThrow()
      const { rows } = await query(`SELECT 1 FROM _migrations WHERE name = '002_atomic_test.sql'`)
      expect(rows).toHaveLength(0)
      const { rows: probe } = await query(`SELECT to_regclass('atomicity_probe') AS reg`)
      expect(probe[0].reg).toBeNull()
    } finally {
      await unlink(`${migrationsDir}/002_atomic_test.sql`)
    }
    // tras quitar el archivo, migrate vuelve a quedar en estado limpio
    await migrate()
    const { rows } = await query(`SELECT name FROM _migrations ORDER BY name`)
    expect(rows.map(r => r.name)).toEqual(['001_init.sql', '002_folders.sql', '003_visibility.sql'])
  })
})
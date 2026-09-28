import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { pool } from './db.js'

export async function migrate(migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url))) {
  const files = (await readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort()
  await pool.query('CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())')
  for (const file of files) {
    const { rowCount } = await pool.query('SELECT 1 FROM _migrations WHERE name = $1', [file])
    if (rowCount) continue
    // transacción por archivo: un fallo a mitad del SQL no deja DDL parcial ni fila en _migrations
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(await readFile(path.join(migrationsDir, file), 'utf8'))
      await client.query('INSERT INTO _migrations(name) VALUES ($1)', [file])
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }
}
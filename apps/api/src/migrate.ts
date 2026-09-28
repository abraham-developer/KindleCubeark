import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pool } from './db.js'

export async function migrate(migrationsDir = new URL('../migrations', import.meta.url).pathname) {
  const files = (await readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort()
  await pool.query('CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())')
  for (const file of files) {
    const { rowCount } = await pool.query('SELECT 1 FROM _migrations WHERE name = $1', [file])
    if (rowCount) continue
    await pool.query(await readFile(path.join(migrationsDir, file), 'utf8'))
    await pool.query('INSERT INTO _migrations(name) VALUES ($1)', [file])
  }
}
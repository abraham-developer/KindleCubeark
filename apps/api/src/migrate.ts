import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { pool } from './db.js'

export type Sleep = (ms: number) => Promise<void>
const sleep: Sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// El primer deploy arranca la app y la initdb de Postgres a la vez: sin
// reintentos, migrate() quema los 3 intentos del restart_policy del swarm
// contra una DB que aún no acepta conexiones. Se reintenta con margen.
export const MIGRATE_ATTEMPTS = 5
export const MIGRATE_DELAY_MS = 3000

/** Reintenta `run` hasta `attempts` veces, con `delayMs` entre intentos. */
export async function migrateWithRetry(
  run: () => Promise<void>,
  {
    attempts = MIGRATE_ATTEMPTS,
    delayMs = MIGRATE_DELAY_MS,
    sleepFn = sleep,
    log = console.error,
  }: { attempts?: number; delayMs?: number; sleepFn?: Sleep; log?: (msg: string) => void } = {},
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await run()
      return
    } catch (err) {
      if (attempt >= attempts) throw err
      const message = err instanceof Error ? err.message : String(err)
      log(`[migrate] intento ${attempt}/${attempts} falló: ${message}; reintentando en ${delayMs}ms`)
      await sleepFn(delayMs)
    }
  }
}

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
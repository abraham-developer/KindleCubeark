import pg from 'pg'
import { loadConfig } from './config.js'

// la URL sale de loadConfig(): DATABASE_URL en claro o armada con la
// contraseña del docker secret (kindle_db_password)
export const pool = new pg.Pool({ connectionString: loadConfig().databaseUrl })

export function query<T extends pg.QueryResultRow>(text: string, values?: unknown[]) {
  return pool.query<T>(text, values)
}
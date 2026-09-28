import pg from 'pg'

// misma URL por defecto que loadConfig(): Postgres de dev en :5432
const connectionString = process.env.DATABASE_URL ?? 'postgres://kindle:kindle@localhost:5432/kindle'

export const pool = new pg.Pool({ connectionString })

export function query<T extends pg.QueryResultRow>(text: string, values?: unknown[]) {
  return pool.query<T>(text, values)
}
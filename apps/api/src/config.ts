import { readFileSync } from 'node:fs'

// paths por defecto de los docker secrets en el contenedor (deploy/swarm.yml)
export const DB_PASSWORD_FILE_DEFAULT = '/run/secrets/kindle_db_password'
export const SESSION_SECRET_FILE_DEFAULT = '/run/secrets/kindle_session_secret'

function readSecretFile(path: string): string | undefined {
  try {
    const value = readFileSync(path, 'utf8').trim()
    return value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

// DATABASE_URL en claro tiene prioridad (compose dev / entornos custom).
// Sin él, la contraseña se lee del docker secret (DB_PASSWORD_FILE) y la URL
// se arma con DB_HOST/DB_USER/DB_NAME. En producción no hay tercer recurso:
// sin credenciales el arranque falla; en dev cae a la base local.
function resolveDatabaseUrl(env: NodeJS.ProcessEnv): string {
  if (env.DATABASE_URL) return env.DATABASE_URL
  const password = readSecretFile(env.DB_PASSWORD_FILE ?? DB_PASSWORD_FILE_DEFAULT)
  if (password) {
    const host = env.DB_HOST ?? 'db'
    const port = env.DB_PORT ?? '5432'
    const user = encodeURIComponent(env.DB_USER ?? 'kindle')
    const name = env.DB_NAME ?? 'kindle'
    return `postgres://${user}:${encodeURIComponent(password)}@${host}:${port}/${name}`
  }
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'En producción se requiere DATABASE_URL o el docker secret kindle_db_password (/run/secrets/kindle_db_password)',
    )
  }
  return 'postgres://kindle:kindle@localhost:5432/kindle'
}

// el secret de sesión (archivo) gana a la env var; en producción no hay
// fallback: sin secreto las sesiones serían falsificables, así que se falla
// el arranque. En dev se usa una clave fija solo para desarrollo.
function resolveSessionSecret(env: NodeJS.ProcessEnv): string {
  const fromFile = readSecretFile(env.SESSION_SECRET_FILE ?? SESSION_SECRET_FILE_DEFAULT)
  if (fromFile) return fromFile
  if (env.SESSION_SECRET) return env.SESSION_SECRET
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'En producción se requiere SESSION_SECRET o el docker secret kindle_session_secret (/run/secrets/kindle_session_secret)',
    )
  }
  return 'dev-only-secret-change-me-0123456789abcdef'
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    port: Number(env.PORT ?? 3000),
    dataDir: env.DATA_DIR ?? '/data',
    maxUploadMb: Number(env.MAX_UPLOAD_MB ?? 100),
    sessionSecret: resolveSessionSecret(env),
    databaseUrl: resolveDatabaseUrl(env),
    runMigrations: env.RUN_MIGRATIONS !== 'false',
    webDist: env.WEB_DIST ?? 'web/dist',
    translateUrl: (env.LIBRETRANSLATE_URL ?? '').replace(/\/+$/, ''),
  }
}
export type Config = ReturnType<typeof loadConfig>
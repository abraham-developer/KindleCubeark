import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadConfig } from '../src/config.js'

// archivos temporales que simulan docker secrets (/run/secrets/...)
const tmpDirs: string[] = []
function tempSecret(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'kindle-secret-'))
  tmpDirs.push(dir)
  const file = path.join(dir, 'secret')
  writeFileSync(file, content, { mode: 0o600 })
  return file
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

// entorno base sin heredar variables del runner (DATABASE_URL, NODE_ENV, etc.)
function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...extra }
}

describe('loadConfig: SESSION_SECRET', () => {
  it('lee el secret de archivo (SESSION_SECRET_FILE) y recorta espacios', () => {
    const file = tempSecret('secreto-de-sesion-largo-0123456789\n')
    const cfg = loadConfig({ SESSION_SECRET_FILE: file })
    expect(cfg.sessionSecret).toBe('secreto-de-sesion-largo-0123456789')
  })

  it('el archivo del secret tiene prioridad sobre la env var', () => {
    const file = tempSecret('desde-archivo-0123456789abcdef')
    const cfg = loadConfig({ SESSION_SECRET_FILE: file, SESSION_SECRET: 'desde-env' })
    expect(cfg.sessionSecret).toBe('desde-archivo-0123456789abcdef')
  })

  it('sin archivo de secret usa la env var SESSION_SECRET', () => {
    const cfg = loadConfig({ SESSION_SECRET_FILE: '/run/secrets/inexistente', SESSION_SECRET: 'desde-env' })
    expect(cfg.sessionSecret).toBe('desde-env')
  })

  it('en producción sin secret ni env var lanza error de arranque', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', SESSION_SECRET_FILE: '/run/secrets/inexistente' }),
    ).toThrow(/SESSION_SECRET/)
  })

  it('en dev sin nada cae al secret de desarrollo', () => {
    const cfg = loadConfig({})
    expect(cfg.sessionSecret).toBe('dev-only-secret-change-me-0123456789abcdef')
  })
})

describe('loadConfig: DATABASE_URL', () => {
  it('DATABASE_URL en claro se usa tal cual (dev compose), ignora el secret', () => {
    const file = tempSecret('pass-del-secret')
    const cfg = loadConfig({ DATABASE_URL: 'postgres://otro:pass@host:5432/base', DB_PASSWORD_FILE: file })
    expect(cfg.databaseUrl).toBe('postgres://otro:pass@host:5432/base')
  })

  it('sin DATABASE_URL arma la URL leyendo la contraseña del secret', () => {
    const file = tempSecret('p4ssw0rd\n')
    const cfg = loadConfig({ DB_PASSWORD_FILE: file })
    expect(cfg.databaseUrl).toBe('postgres://kindle:p4ssw0rd@db:5432/kindle')
  })

  it('codifica la contraseña y respeta DB_HOST/DB_USER/DB_NAME', () => {
    const file = tempSecret('p@ss/w:rd')
    const cfg = loadConfig({
      DB_PASSWORD_FILE: file,
      DB_HOST: 'postgres.internal',
      DB_USER: 'lector',
      DB_NAME: 'biblioteca',
    })
    expect(cfg.databaseUrl).toBe('postgres://lector:p%40ss%2Fw%3Ard@postgres.internal:5432/biblioteca')
  })

  it('en producción sin DATABASE_URL ni secret de contraseña lanza error de arranque', () => {
    // SESSION_SECRET provisto: así el único recurso faltante es la credencial de db
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        SESSION_SECRET: 'un-secreto-de-sesion-0123456789abcdef',
        DB_PASSWORD_FILE: '/run/secrets/inexistente',
      }),
    ).toThrow(/DATABASE_URL|kindle_db_password/)
  })

  it('en dev sin nada cae a la URL de localhost por defecto', () => {
    const cfg = loadConfig({ DB_PASSWORD_FILE: '/run/secrets/inexistente' })
    expect(cfg.databaseUrl).toBe('postgres://kindle:kindle@localhost:5432/kindle')
  })
})

describe('loadConfig: webDist y demás', () => {
  it('WEB_DIST por defecto es web/dist relativo al runtime', () => {
    expect(loadConfig({}).webDist).toBe('web/dist')
  })

  it('WEB_DIST se sobreescribe por env', () => {
    expect(loadConfig({ WEB_DIST: '/srv/web/dist' }).webDist).toBe('/srv/web/dist')
  })

  it('defaults de port, dataDir, maxUploadMb y RUN_MIGRATIONS', () => {
    const cfg = loadConfig({})
    expect(cfg.port).toBe(3000)
    expect(cfg.dataDir).toBe('/data')
    expect(cfg.maxUploadMb).toBe(100)
    expect(cfg.runMigrations).toBe(true)
    expect(loadConfig({ RUN_MIGRATIONS: 'false' }).runMigrations).toBe(false)
  })
})
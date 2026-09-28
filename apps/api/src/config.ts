export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    port: Number(env.PORT ?? 3000),
    dataDir: env.DATA_DIR ?? '/data',
    maxUploadMb: Number(env.MAX_UPLOAD_MB ?? 100),
    sessionSecret: env.SESSION_SECRET ?? 'dev-only-secret-change-me-0123456789abcdef',
    databaseUrl: env.DATABASE_URL ?? 'postgres://kindle:kindle@localhost:5432/kindle',
    runMigrations: env.RUN_MIGRATIONS !== 'false',
    webDist: env.WEB_DIST ?? 'apps/web/dist',
  }
}
export type Config = ReturnType<typeof loadConfig>
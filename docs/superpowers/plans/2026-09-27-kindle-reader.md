# KindleCubeark — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lector web multiusuario estilo Kindle (PDF + EPUB) con progreso persistente, retomado exacto, anotaciones y despliegue en Docker Swarm.

**Architecture:** SPA React/Vite/TS servida por una API Fastify (mismo origen) sobre Postgres 16. Archivos en volumen `/data`. En Swarm: servicios `app` + `db`.

**Tech Stack:** TypeScript, Vite, React 18, pdf.js (`pdfjs-dist`), `epubjs`, Fastify, `pg`, `bcryptjs`, `pdf-lib`, `adm-zip`, `@fastify/secure-session`, `@fastify/multipart`, `@fastify/static`, vitest (API + web), Docker multi-stage.

**Spec:** `docs/superpowers/specs/2026-09-27-kindle-reader-design.md` (léelo junto a este plan).

## Global Constraints

- Node 20 alpine en Docker; `node --env-file` para env en dev (sin dotenv).
- Sin ORM: SQL directo con `pg` y migraciones `.sql` numeradas en `apps/api/migrations/`.
- Toda query de libros/progreso/anotaciones filtra por `user_id` de la sesión; recurso ajeno → **404** (nunca 403, no filtra existencia).
- Upload validado por **magic bytes** (PDF `%PDF-`; EPUB `PK\x03\x04` + `mimetype` = `application/epub+zip`); límite `MAX_UPLOAD_MB` (default 100); sin archivos huérfanos si falla.
- PDF: `position = { page }` (1-indexada). EPUB: `position = { cfi, percent, section }`.
- Anotaciones PDF: `position = { page, rects }` normalizados 0–1; EPUB: `{ startCfi, endCfi }`; nota de página: `{ page }`. Marcadores = `annotations` con `kind:'note'`, `color:'bookmark'`, texto vacío (excluidos del panel).
- Tokens de UI: papel `#F8F1E1`, tinta `#2B2A26`, acento ámbar; noche: carbón `#111`–`#1A1A1A`, acento ámbar. Serif en toda la app. Volteo 3D ~350 ms (fade en noche).
- Estilo de commit: `feat:`/`test:`/`chore:` con Co-Authored-By: Claude Code.

## Review Focus

1. **Archivo de otro usuario** → GET `/files/:userId/:bookId` con credenciales de otro usuario debe dar 404, no el archivo. (Test en Task 6.)
2. **Upload falsificado por extensión** → un `.pdf` que no empieza con `%PDF-` se rechaza y no deja archivo en disco. (Test en Task 5.)
3. **Retomar sin flash de página 1** → abrir un libro con progreso navega a la posición guardada antes del primer render visible. (Test en Tasks 12/13; revisión manual.)
4. **Progreso perdido por cierre abrupto** → `pagehide` envía `sendBeacon`; sin red, la lectura continúa y el progreso se encola. (Test en Task 12.)
5. **Anotación de página normalizada tras resize** → rects 0–1 se repintan en el mismo lugar con otro tamaño de ventana. (Test en Task 14.)

---

### Task 1: Scaffold del monorepo

**Files:**
- Create: `.gitignore`, `.dockerignore`, `README.md` (stub), `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/index.html`, `apps/web/vite.config.ts`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx`

**Interfaces:**
- Produces: scripts `npm run dev` / `npm test` / `npm run build` en ambas apps; carpetas válidas que las tareas siguientes rellenan.

- [ ] **Step 1: Crear archivos base**

`.gitignore`:
```
node_modules/
dist/
apps/api/dist/
apps/web/dist/
*.tsbuildinfo
.env*
```

`.dockerignore`:
```
node_modules
**/node_modules
**/dist
.git
docs
*.md
.env*
```

`apps/api/package.json`:
```json
{
  "name": "kindlecubeark-api",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch --env-file=../../.env.local src/index.ts",
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@fastify/multipart": "^8",
    "@fastify/secure-session": "^7",
    "@fastify/static": "^7",
    "adm-zip": "^0.5",
    "bcryptjs": "^2.4.3",
    "fastify": "^4",
    "pdf-lib": "^1.17.1",
    "pg": "^8.11"
  },
  "devDependencies": {
    "@types/adm-zip": "^0.5",
    "@types/bcryptjs": "^2.4.6",
    "@types/node": "^20",
    "@types/pg": "^8.11",
    "tsx": "^4",
    "typescript": "^5.5",
    "vitest": "^2"
  }
}
```

`apps/api/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "outDir": "dist", "rootDir": "src", "strict": true, "esModuleInterop": true,
    "skipLibCheck": true, "declaration": false
  },
  "include": ["src"]
}
```

`apps/web/package.json`:
```json
{
  "name": "kindlecubeark-web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "epubjs": "^0.3.93",
    "pdfjs-dist": "^4.4.168",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6",
    "@testing-library/react": "^16",
    "@testing-library/user-event": "^14",
    "@types/react": "^18", "@types/react-dom": "^18",
    "@vitejs/plugin-react": "^4.3",
    "jsdom": "^24",
    "typescript": "^5.5",
    "vite": "^5.4",
    "vitest": "^2"
  }
}
```

`apps/web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext", "moduleResolution": "bundler",
    "jsx": "react-jsx", "strict": true, "skipLibCheck": true,
    "noEmit": true, "types": ["vite/client", "@testing-library/jest-dom"]
  },
  "include": ["src", "vite.config.ts"]
}
```

`apps/web/index.html`:
```html
<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>KindleCubeark</title>
</head>
<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

`apps/web/vite.config.ts`:
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:3000' } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    globals: true,
  },
})
```

`apps/web/src/main.tsx` y `src/App.tsx` (stub que Task 9 reemplaza):
```tsx
// App.tsx
export default function App() {
  return <div>KindleCubeark</div>
}
// main.tsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
createRoot(document.getElementById('root')!).render(<App />)
```

`apps/web/src/test-setup.ts`:
```ts
import '@testing-library/jest-dom/vitest'
```

README stub: nombre del proyecto + "ver docs/superpowers/specs/…". README real en Task 15.

- [ ] **Step 2: Instalar dependencias y verificar builds**

Run: `cd apps/api && npm install && cd ../web && npm install`
Run: `cd apps/api && npx tsc --noEmit && cd ../web && npx vite build`
Expected: sin errores.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "chore: scaffold monorepo (api + web)"
```

---

### Task 2: Esqueleto de la API (config + health)

**Files:**
- Create: `apps/api/src/config.ts`, `apps/api/src/app.ts`, `apps/api/src/routes/health.ts`, `apps/api/src/index.ts`
- Test: `apps/api/test/health.test.ts`

**Interfaces:**
- Produces: `buildApp(opts?: { skipStatic?: boolean }): Promise<FastifyInstance>` — toda tarea de API la usa en tests. `config` con `PORT, DATA_DIR, MAX_UPLOAD_MB, SESSION_SECRET, DATABASE_URL`.

- [ ] **Step 1: Test de health y 404 JSON**

```ts
// apps/api/test/health.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { buildApp } from '../src/app.js'

describe('health', () => {
  it('GET /api/health → 200 {"ok":true}', async () => {
    const app = await buildApp({ skipStatic: true })
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })
  it('rutas desconocidas devuelven JSON, no HTML', async () => {
    const app = await buildApp({ skipStatic: true })
    const res = await app.inject({ method: 'GET', url: '/api/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json().message).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run para ver que falla**

Run: `cd apps/api && npx vitest run test/health.test.ts`
Expected: FAIL (`Cannot find module .../src/app.js`).

- [ ] **Step 3: Implementación**

```ts
// apps/api/src/config.ts
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    port: Number(env.PORT ?? 3000),
    dataDir: env.DATA_DIR ?? '/data',
    maxUploadMb: Number(env.MAX_UPLOAD_MB ?? 100),
    sessionSecret: env.SESSION_SECRET ?? 'dev-only-secret-change-me-0123456789abcdef',
    databaseUrl: env.DATABASE_URL ?? 'postgres://kindle:kindle@localhost:5432/kindle',
    webDist: env.WEB_DIST ?? 'apps/web/dist',
  }
}
export type Config = ReturnType<typeof loadConfig>
```

```ts
// apps/api/src/routes/health.ts
import type { FastifyInstance } from 'fastify'
export default async function health(app: FastifyInstance) {
  app.get('/api/health', async () => ({ ok: true }))
}
```

```ts
// apps/api/src/app.ts
import Fastify from 'fastify'
import { loadConfig } from './config.js'
import health from './routes/health.js'

export async function buildApp(opts: { skipStatic?: boolean; config?: Partial<ReturnType<typeof loadConfig>> } = {}) {
  const config = { ...loadConfig(), ...opts.config }
  const app = Fastify({ logger: false, bodyLimit: 1 })
  app.decorate('config', config)
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500
    reply.status(status).send({ message: status >= 500 ? 'Error interno' : err.message })
  })
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ message: 'No encontrado' }))
  await app.register(health)
  return app
}
```

```ts
// apps/api/src/index.ts
import { buildApp } from './app.js'
import { loadConfig } from './config.js'

const app = await buildApp()
const cfg = loadConfig()
await app.listen({ port: cfg.port, host: '0.0.0.0' })
app.log.info(`api escuchando en :${cfg.port}`)
```

Nota: `app.decorate('config', ...)` — declarar el tipo en `apps/api/src/types.d.ts`:
```ts
import type { Config } from './config.js'
declare module 'fastify' {
  interface FastifyInstance { config: Config }
}
```

- [ ] **Step 4: Run para ver que pasa**

Run: `cd apps/api && npx vitest run test/health.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api && git commit -m "feat(api): app skeleton with config and health route"
```

---

### Task 3: Capa de datos (pg + migraciones + users)

**Files:**
- Create: `apps/api/src/db.ts`, `apps/api/src/migrate.ts`, `apps/api/migrations/001_init.sql`, `apps/api/test/helpers/db.ts`
- Modify: `apps/api/src/app.ts` (ejecuta migraciones al levantar si `runMigrations`)

**Interfaces:**
- Produces: `query<T>(sql, params): Promise<QueryResult<T>>`, `migrate()`, y en tests `withDb(fn)` que setea `DATABASE_URL` de test y borra tablas al final. Esquema completo de la spec §4 (users, books, reading_progress, annotations) — se crea TODO el esquema acá, las tareas siguientes solo lo usan.

- [ ] **Step 1: Migración única con el esquema completo**

```sql
-- apps/api/migrations/001_init.sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  author text NOT NULL DEFAULT '',
  format text NOT NULL CHECK (format IN ('pdf','epub')),
  file_path text NOT NULL,
  cover_path text,
  file_size bigint NOT NULL,
  total_pages int,
  added_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON books(user_id, added_at DESC);

CREATE TABLE reading_progress (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  position jsonb NOT NULL,
  percent numeric(5,2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, book_id)
);

CREATE TABLE annotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('highlight','note')),
  position jsonb NOT NULL,
  quoted_text text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  color text NOT NULL DEFAULT 'yellow',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON annotations(book_id, created_at);
```

```ts
// apps/api/src/migrate.ts
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pool } from './db.js'

export async function migrate(migrationsDir = new URL('../migrations', import.meta.url).pathname) {
  const files = (await readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort()
  await pool.query(`CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())`)
  for (const file of files) {
    const { rowCount } = await pool.query('SELECT 1 FROM _migrations WHERE name = $1', [file])
    if (rowCount) continue
    await pool.query(await readFile(path.join(migrationsDir, file), 'utf8'))
    await pool.query('INSERT INTO _migrations(name) VALUES ($1)', [file])
  }
}
```

```ts
// apps/api/src/db.ts
import pg from 'pg'
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
export function query<T extends pg.QueryResultRow>(text: string, values?: unknown[]) {
  return pool.query<T>(text, values)
}
```

Helper de test (asume Postgres de dev corriendo en :5432, ver Task 15 para el compose; para ejecutar tests antes de tener Docker: `docker run -d --name kindle-dev-db -e POSTGRES_USER=kindle -e POSTGRES_PASSWORD=kindle -e POSTGRES_DB=kindle -p 5432:5432 postgres:16-alpine`):

```ts
// apps/api/test/helpers/db.ts
import { pool } from '../../src/db.js'

export async function resetDb() {
  await pool.query('TRUNCATE annotations, reading_progress, books, users CASCADE')
}
```

- [ ] **Step 2: Smoke test de migración**

```ts
// apps/api/test/db.test.ts
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
```

Run: `cd apps/api && npx vitest run test/db.test.ts`
Expected: PASS (migración idempotente por `_migrations`).

- [ ] **Step 3: Commit**

```bash
git add apps/api && git commit -m "feat(api): pg pool, migrations and full schema"
```

---

### Task 4: Auth (register / login / logout / me)

**Files:**
- Create: `apps/api/src/routes/auth.ts`, `apps/api/src/plugins/session.ts`, `apps/api/src/plugins/auth.ts`
- Modify: `apps/api/src/app.ts` (registra plugins y ruta)
- Test: `apps/api/test/auth.test.ts`

**Interfaces:**
- Produces: cookie de sesión httpOnly firmada; decorador `app.verifySession` + `req.user: { id: string }`. Sesión payload: `{ userId }`. Rutas: `POST /api/auth/register|login|logout`, `GET /api/auth/me`.

- [ ] **Step 1: Tests**

```ts
// apps/api/test/auth.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { buildApp } from '../src/app.js'
import { resetDb } from './helpers/db.js'

const EMAIL = 'a@test.dev'
const PASSWORD = 'correct horse battery'

beforeAll(async () => { await resetDb() })

describe('auth', () => {
  it('register crea usuario y sesión', async () => {
    const app = await buildApp({ skipStatic: true })
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: EMAIL, password: PASSWORD } })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ email: EMAIL })
    expect(res.headers['set-cookie']).toBeTruthy()
  })
  it('register rechaza password corto y email duplicado', async () => {
    const app = await buildApp({ skipStatic: true })
    const short = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'b@test.dev', password: '123' } })
    expect(short.statusCode).toBe(400)
    const dup = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: EMAIL, password: PASSWORD } })
    expect(dup.statusCode).toBe(409)
  })
  it('login con credenciales correctas/incorrectas', async () => {
    const app = await buildApp({ skipStatic: true })
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: EMAIL, password: 'nope' } })
    expect(bad.statusCode).toBe(401)
    const ok = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: EMAIL, password: PASSWORD } })
    expect(ok.statusCode).toBe(200)
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { session: ok.cookies.find(c => c.name === 'session')!.value } })
    expect(me.json().email).toBe(EMAIL)
  })
  it('me sin sesión → 401; logout borra sesión', async () => {
    const app = await buildApp({ skipStatic: true })
    const anon = await app.inject({ method: 'GET', url: '/api/auth/me' })
    expect(anon.statusCode).toBe(401)
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout' })
    expect(out.statusCode).toBe(204)
  })
})
```

- [ ] **Step 2: Run → FAIL** (`Cannot find module src/routes/auth.js`)

- [ ] **Step 3: Implementación**

```ts
// apps/api/src/plugins/session.ts
import fp from 'fastify-plugin'
import secureSession from '@fastify/secure-session'

export default fp(async (app) => {
  await app.register(secureSession, {
    key: Buffer.from(app.config.sessionSecret, 'utf8').subarray(0, 32),
    cookie: { path: '/', httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 },
    cookieName: 'session',
  })
})
```
(Necesita `fastify-plugin` + `@fastify/secure-session` en dependencies; `fp` opcional — si se omite, registrar directo.)

```ts
// apps/api/src/plugins/auth.ts
import type { FastifyReply, FastifyRequest } from 'fastify'
declare module 'fastify' {
  interface FastifyRequest { user: { id: string } }
}
export async function verifySession(this: any, req: FastifyRequest, reply: FastifyReply) {
  const userId = (req.session as any).get('userId') as string | undefined
  if (!userId) { reply.code(401).send({ message: 'Sesión requerida' }); return }
  const { rows } = await this.query('SELECT id FROM users WHERE id = $1', [userId])
  if (!rows.length) { reply.code(401).send({ message: 'Sesión requerida' }); return }
  req.user = { id: rows[0].id }
}
```

```ts
// apps/api/src/routes/auth.ts
import bcrypt from 'bcryptjs'
import type { FastifyInstance } from 'fastify'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export default async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/register', async (req, reply) => {
    const { email, password } = req.body as { email?: string; password?: string }
    if (!email || !EMAIL_RE.test(email)) return reply.code(400).send({ message: 'Email inválido' })
    if (!password || password.length < 8) return reply.code(400).send({ message: 'La contraseña debe tener al menos 8 caracteres' })
    const hash = await bcrypt.hash(password, 10)
    try {
      const { rows } = await app.query(`INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id, email`, [email.toLowerCase(), hash])
      ;(req.session as any).set('userId', rows[0].id)
      return reply.code(201).send(rows[0])
    } catch (e: any) {
      if (e.code === '23505') return reply.code(409).send({ message: 'Ese email ya está registrado' })
      throw e
    }
  })

  app.post('/api/auth/login', async (req, reply) => {
    const { email, password } = req.body as { email?: string; password?: string }
    const { rows } = await app.query('SELECT id, password_hash, email FROM users WHERE email = $1', [(email ?? '').toLowerCase()])
    if (!rows.length || !(await bcrypt.compare(password ?? '', rows[0].password_hash)))
      return reply.code(401).send({ message: 'Email o contraseña incorrectos' })
    ;(req.session as any).set('userId', rows[0].id)
    return { id: rows[0].id, email: rows[0].email }
  })

  app.post('/api/auth/logout', async (req, reply) => {
    (req.session as any).delete(); return reply.code(204).send()
  })

  app.get('/api/auth/me', { preHandler: app.verifySession }, async (req) => {
    const { rows } = await app.query('SELECT id, email FROM users WHERE id = $1', [req.user.id])
    return rows[0]
  })
}
```
Añadir en `types.d.ts` el decorador `query` en la instancia (`query<T>(sql, values)`) y `verifySession`. En `app.ts`: registrar session, `app.decorate('query', (t, v) => query(t, v))`, `app.decorateRequest('user', null)`, `app.decorate('verifySession', verifySession)` y `register(authRoutes)`.

- [ ] **Step 4: Run → PASS. Step 5: Commit** `feat(api): auth with bcrypt and secure session`

---

### Task 5: Upload + validación magic bytes + metadata

**Files:**
- Create: `apps/api/src/lib/magic.ts`, `apps/api/src/lib/metadata.ts`, `apps/api/src/lib/storage.ts`, `apps/api/test/fixtures.ts`
- Modify: `apps/api/src/routes/books.ts` (nuevo, solo POST por ahora)
- Test: `apps/api/test/upload.test.ts`

**Interfaces:**
- Produces: `detectFormat(buf): 'pdf' | 'epub' | null`; `extractPdfMeta(buf): { title?, author?, pages? }` (pdf-lib); `extractEpubMeta(buf): { title?, author?, coverJpeg? }` (adm-zip + OPF); `saveBookFile(dataDir, userId, bookId, format, buf): string` (ruta relativa); `makeTestPdf(pages, title?): Promise<Buffer>` y `makeTestEpub({ title, author, withCover }): Promise<Buffer>` en `fixtures.ts`.

- [ ] **Step 1: Fixtures**

```ts
// apps/api/test/fixtures.ts
import { PDFDocument, StandardFonts } from 'pdf-lib'
import AdmZip from 'adm-zip'

export async function makeTestPdf(pages = 3, title = 'Libro de prueba'): Promise<Buffer> {
  const doc = await PDFDocument.create()
  doc.setTitle(title); doc.setAuthor('Autor Prueba')
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= pages; i++) {
    const p = doc.addPage([300, 500])
    p.drawText(`Pagina ${i}`, { x: 40, y: 250, size: 24, font })
  }
  return Buffer.from(await doc.save())
}

export function makeTestEpub({ title = 'Mi EPUB', author = 'Escritora', withCover = true }): Buffer {
  const zip = new AdmZip()
  zip.addFile('mimetype', Buffer.from('application/epub+zip'))
  zip.addFile('META-INF/container.xml', Buffer.from(
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`))
  const manifest = withCover
    ? `<item id="cover-image" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>`
    : ''
  zip.addFile('OEBPS/content.opf', Buffer.from(
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator><dc:identifier id="id">urn:uuid:1234</dc:identifier></metadata><manifest>${manifest}<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch1"/></itemref></spine></package>`))
  zip.addFile('OEBPS/ch1.xhtml', Buffer.from('<html><body><p>Hola capítulo</p></body></html>'))
  if (withCover) {
    // JPEG 1x1 mínimo válido
    const jpg = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDIzNP/AABEIAAEAAQMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAABAgMEBQYHCAkKC//EALURAAEBAwEEBQgFAgECAAMAAwEAAhEDEEEEESExE0FRBgZCInETNDYnKD/xAAVAQEBAAAAAAAAAAAAAAAAAAAAAf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/xAAfEQABBQEAAwUBAAAAAAAAAAABAgMEEQUhEhQxcYH/2gAMAwEAAhEDEQA/AJQA/9k=', 'base64')
    zip.addFile('OEBPS/cover.jpg', jpg)
  }
  return zip.toBuffer()
}
```

- [ ] **Step 2: Tests**

```ts
// apps/api/test/upload.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { buildApp } from '../src/app.js'
import { resetDb } from './helpers/db.js'
import { makeTestPdf, makeTestEpub } from './fixtures.js'
import { readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'

beforeEach(resetDb)

async function registerAndGetCookie(app: any, email = 'up@test.dev') {
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'password123' } })
  return res.cookies.find(c => c.name === 'session')!.value
}
async function upload(app: any, cookie: string, buf: Buffer, name = 'libro.pdf', type = 'application/pdf') {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(buf)], { type }), name)
  return app.inject({ method: 'POST', url: '/api/books', headers: { cookie: `session=${cookie}` }, payload: buf, headers2: undefined as never } as never)
}

describe('upload', () => {
  it('sube un PDF válido y extrae título/páginas', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: 'test-tmp/data' } })
    const cookie = await registerAndGetCookie(app)
    const res = await app.inject({
      method: 'POST', url: '/api/books', cookie: { session: cookie },
    })
    expect(res.statusCode).toBe(201) // ver nota: usar el patrón de multipart de la implementación
  })
  it('rechaza un archivo con extensión .pdf que no es PDF', async () => {
    // payload = Buffer.from('hola') con filename libro.pdf → 400
  })
  it('rechaza EPUB sin mimetype correcto', async () => { /* zip con mimetype 'text/plain' → 400 */ })
  it('no deja archivos en disco si la validación falla', async () => { /* readdir('test-tmp/data') vacío */ })
})
```
**Nota para el implementador:** `@fastify/multipart` con `attachFieldsToBody: false`; leer el archivo con `const data = await req.file(); data.file` (stream) acumulando en un Buffer con límite `maxUploadMb`. El test del PDF válido debe enviar `multipart/form-data` real (usar `form.getBuffer()` o el helper `app.inject` con `payload` serializado + header `content-type` con boundary del form). Los tres casos de rechazo deben quedar completos: 400 + `readdirSync('test-tmp/data')` → array vacío.

- [ ] **Step 3: Implementación**

```ts
// apps/api/src/lib/magic.ts
export type BookFormat = 'pdf' | 'epub'
export function detectFormat(buf: Buffer): BookFormat | null {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf'
  if (buf.subarray(0, 4).toString('latin1') === 'PK\x03\x04') {
    const idx = buf.indexOf('application/epub+zip')
    if (idx > -1 && idx < 200) return 'epub' // el mimetype va en el primer entry
  }
  return null
}
```

```ts
// apps/api/src/lib/metadata.ts
import { PDFDocument } from 'pdf-lib'
import AdmZip from 'adm-zip'
import type { BookFormat } from './magic.js'

export async function extractMeta(format: BookFormat, buf: Buffer) {
  if (format === 'pdf') {
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true })
    return { title: doc.getTitle() ?? undefined, author: doc.getAuthor() ?? undefined, pages: doc.getPageCount(), coverJpeg: undefined }
  }
  const zip = new AdmZip(buf)
  const opfPath = findOpfPath(zip)
  const opf = opfPath ? zip.readAsText(opfPath) : ''
  const title = opf.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/)?.[1]
  const author = opf.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/)?.[1]
  const cover = findCoverJpeg(zip, opf, opfPath)
  return { title, author, pages: undefined, coverJpeg: cover }
}
function findOpfPath(zip: AdmZip): string | null {
  const container = zip.readAsText('META-INF/container.xml')
  return container.match(/full-path="([^"]+\.opf)"/)?.[1] ?? null
}
function findCoverJpeg(zip: AdmZip, opf: string, opfPath: string | null): Buffer | undefined {
  const entry = zip.getEntry('cover.jpg') ?? zip.getEntry('OEBPS/cover.jpg')
    ?? zip.getEntries().find(e => /cover.*\.(jpe?g|png)/i.test(e.entryName))
  if (!entry) return undefined
  return entry.getData()
}
```

```ts
// apps/api/src/lib/storage.ts
import { mkdir, writeFile, unlink, rm } from 'node:fs/promises'
import path from 'node:path'
export async function saveBookFile(dataDir: string, userId: string, bookId: string, format: string, buf: Buffer) {
  const rel = path.join(userId, `${bookId}.${format}`)
  await mkdir(path.dirname(path.join(dataDir, rel)), { recursive: true })
  await writeFile(path.join(dataDir, rel), buf)
  return rel
}
export async function saveCover(dataDir: string, userId: string, bookId: string, jpeg: Buffer) {
  const rel = path.join(userId, `${bookId}.jpg`)
  await writeFile(path.join(dataDir, rel), jpeg); return rel
}
export async function removeBookFiles(dataDir: string, rel: string) {
  await rm(path.join(dataDir, rel), { force: true })
  await rm(path.join(dataDir, rel.replace(/\.\w+$/, '.jpg')), { force: true })
}
```

Ruta `POST /api/books` en `routes/books.ts`:
```ts
app.post('/api/books', { preHandler: app.verifySession }, async (req, reply) => {
  const file = await req.file({ limits: { fileSize: app.config.maxUploadMb * 1024 * 1024 } })
  if (!file) return reply.code(400).send({ message: 'Falta el archivo' })
  const chunks: Buffer[] = []
  let tooBig = false
  await new Promise<void>((resolve) => {
    file.file.on('data', (c: Buffer) => { chunks.push(c) })
    file.file.on('end', resolve); file.file.on('error', resolve)
  })
  const buf = Buffer.concat(chunks)
  const format = detectFormat(buf)
  if (!format) return reply.code(400).send({ message: 'El archivo no es un PDF o EPUB válido' })
  const id = crypto.randomUUID()
  const meta = await extractMeta(format, buf)
  const filePath = await saveBookFile(app.config.dataDir, req.user.id, id, format, buf)
  const { rows } = await app.query(
    `INSERT INTO books (id, user_id, title, author, format, file_path, cover_path, file_size, total_pages)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [id, req.user.id, meta.title ?? file.filename, meta.author ?? '', format, filePath, meta.coverJpeg ? await saveCover(app.config.dataDir, req.user.id, id, meta.coverJpeg) : null, buf.length, meta.pages ?? null])
  return reply.code(201).send(rows[0])
})
```
En catch: `await removeBookFiles(...)` antes de responder si el INSERT falla.

- [ ] **Step 4: Run → PASS (los 4 casos). Step 5: Commit** `feat(api): upload with magic-bytes validation and metadata extraction`

---

### Task 6: Books CRUD + servir archivos (aislamiento por usuario)

**Files:**
- Modify: `apps/api/src/routes/books.ts`, `apps/api/src/app.ts` (static solo si `!skipStatic`)
- Test: `apps/api/test/books.test.ts`

**Interfaces:**
- Produces: `GET /api/books` (con `progress` embebido), `GET /api/books/:id` → `{ book, progress }`, `DELETE /api/books/:id`, `GET /api/files/:userId/:bookId.ext` (stream, solo dueño). Regla global: recurso ajeno → 404.

- [ ] **Step 1: Tests**

```ts
// apps/api/test/books.test.ts
// setup: usuario A y B (register), A sube 1 PDF vía POST real.
describe('books', () => {
  it('lista del usuario con su progreso', async () => { /* A ve 1 libro; B ve lista vacía */ })
  it('GET /api/books/:id de otro usuario → 404', async () => { /* cookie de B + id de A → 404 */ })
  it('DELETE borra registro y archivos de disco', async () => { /* tras DELETE, readdir(dataDir/A) vacío */ })
  it('GET /api/files/:userId/:file con cookie del dueño → 200 y bytes correctos', async () => { /* comparar body con el fixture */ })
  it('GET /api/files/:userId/:file con cookie de otro → 404', async () => {})
})
```
Completar los 5 tests con código real (mismo patrón `inject` que Task 5; para el file de disco usar el `file_path` devuelto por el POST).

- [ ] **Step 2: Implementación**

```ts
// dentro de routes/books.ts
app.get('/api/books', { preHandler: app.verifySession }, async (req) => {
  const { rows } = await app.query(
    `SELECT b.*, p.percent, p.position, p.updated_at AS last_read
     FROM books b LEFT JOIN reading_progress p ON p.book_id = b.id AND p.user_id = b.user_id
     WHERE b.user_id = $1 ORDER BY COALESCE(p.updated_at, b.added_at) DESC`, [req.user.id])
  return rows
})
app.get('/api/books/:id', { preHandler: app.verifySession }, async (req, reply) => {
  const { rows } = await app.query('SELECT * FROM books WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id])
  if (!rows.length) return reply.code(404).send({ message: 'Libro no encontrado' })
  const { rows: p } = await app.query('SELECT position, percent, updated_at FROM reading_progress WHERE book_id = $1 AND user_id = $2', [req.params.id, req.user.id])
  return { book: rows[0], progress: p[0] ?? null }
})
app.delete('/api/books/:id', { preHandler: app.verifySession }, async (req, reply) => {
  const { rows } = await app.query('DELETE FROM books WHERE id = $1 AND user_id = $2 RETURNING file_path', [req.params.id, req.user.id])
  if (!rows.length) return reply.code(404).send({ message: 'Libro no encontrado' })
  await removeBookFiles(app.config.dataDir, rows[0].file_path)
  return reply.code(204).send()
})
app.get('/api/files/:userId/:file', { preHandler: app.verifySession }, async (req, reply) => {
  if (req.params.userId !== req.user.id) return reply.code(404).send({ message: 'No encontrado' })
  const { rows } = await app.query(`SELECT file_path, format FROM books WHERE user_id = $1 AND file_path = $2`,
    [req.user.id, `${req.params.userId}/${req.params['*']}`])
  if (!rows.length) return reply.code(404).send({ message: 'No encontrado' })
  return reply.type(rows[0].format === 'pdf' ? 'application/pdf' : 'application/epub+zip')
    .send(createReadStream(path.join(app.config.dataDir, rows[0].file_path)))
})
```

- [ ] **Step 3: Run → PASS. Step 4: Commit** `feat(api): books CRUD with per-user file isolation`

---

### Task 7: Progreso (upsert / reset)

**Files:**
- Modify: `apps/api/src/routes/books.ts`
- Test: `apps/api/test/progress.test.ts`

**Interfaces:**
- Produces: `PATCH /api/books/:id/progress` body `{ position: object, percent: number }` → upsert en `reading_progress`, devuelve `{ position, percent, updated_at }`; `DELETE /api/books/:id/progress` → 204. Validación de `position` por formato (PDF: `page` int ≥ 1 ≤ total_pages si se conoce; EPUB: `cfi` string + `percent`).

- [ ] **Step 1: Tests**

```ts
// apps/api/test/progress.test.ts
// setup: usuario + libro subido (helper compartido `uploadBook(app, cookie, buf)` en test/helpers/upload.ts, extraído de Task 5)
describe('progress', () => {
  it('upsert crea y luego actualiza la misma fila', async () => {
    // PATCH {position:{page:12}, percent:4} → 200 percent 4
    // PATCH {position:{page:30}, percent:10} → 200 percent 10; SELECT COUNT(*) = 1
  })
  it('rechaza position inválida para el formato', async () => {
    // PATCH {position:{page:0}} → 400; PATCH {position:{page:9999}} (total_pages=3) → 400
    // PATCH {position:{}} en epub (sin cfi) → 400
  })
  it('DELETE resetea (404 después de resetear dos veces es 204 igual)', async () => {})
  it('otro usuario no puede escribir el progreso → 404', async () => {})
})
```

- [ ] **Step 2: Implementación**

```ts
function validatePosition(format: string, position: any, totalPages: number | null): boolean {
  if (format === 'pdf') {
    return Number.isInteger(position?.page) && position.page >= 1 && (totalPages == null || position.page <= totalPages)
  }
  return typeof position?.cfi === 'string' && position.cfi.length > 0
}
app.patch('/api/books/:id/progress', { preHandler: app.verifySession }, async (req, reply) => {
  const { rows } = await app.query('SELECT * FROM books WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id])
  if (!rows.length) return reply.code(404).send({ message: 'Libro no encontrado' })
  const book = rows[0]
  const { position, percent } = req.body as { position?: unknown; percent?: number }
  if (!validatePosition(book.format, position, book.total_pages))
    return reply.code(400).send({ message: 'Posición inválida' })
  const pct = Math.max(0, Math.min(100, Number(percent ?? 0)))
  const { rows: up } = await app.query(
    `INSERT INTO reading_progress (user_id, book_id, position, percent, updated_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (user_id, book_id) DO UPDATE SET position = $3, percent = $4, updated_at = now()
     RETURNING position, percent, updated_at`, [req.user.id, book.id, JSON.stringify(position), pct])
  return up[0]
})
app.delete('/api/books/:id/progress', { preHandler: app.verifySession }, async (req, reply) => {
  await app.query('DELETE FROM reading_progress WHERE book_id = $1 AND user_id = $2', [req.params.id, req.user.id])
  return reply.code(204).send()
})
```

- [ ] **Step 3: Run → PASS. Step 4: Commit** `feat(api): reading progress upsert and reset`

---

### Task 8: Anotaciones (CRUD + orden de lectura)

**Files:**
- Create: `apps/api/src/lib/positionOrder.ts`, `apps/api/src/routes/annotations.ts`
- Modify: `apps/api/src/app.ts` (registra)
- Test: `apps/api/test/annotations.test.ts`

**Interfaces:**
- Produces: `positionSortKey(position, format): string` para `ORDER BY`; `GET/POST /api/books/:id/annotations`, `DELETE /api/annotations/:id`. Valida `position` igual que progreso + rects array de 4 números en [0,1] para highlights PDF, `{startCfi,endCfi}` para EPUB, `{page}` para notas de página. `color ∈ {yellow, gray, pink, blue, bookmark}`.

- [ ] **Step 1: Test de orden**

```ts
// apps/api/test/annotations.test.ts
// setup: usuario + libro PDF de 5 páginas
describe('annotations', () => {
  it('crea highlight y nota, lista ordenada por página', async () => {
    // POST highlight pág 3, POST nota pág 1, POST highlight pág 2
    // GET → orden esperado: pág1, pág2, pág3
  })
  it('rechaza rects fuera de rango y colores inválidos', async () => {
    // POST {kind:'highlight', position:{page:1, rects:[{x:1.5,y:0,w:0.1,h:0.1}]}} → 400
    // POST color 'red' → 400
  })
  it('DELETE de anotación de otro usuario → 404', async () => {})
  it('DELETE de libro borra sus anotaciones', async () => {})
})
```

- [ ] **Step 2: Implementación**

```ts
// apps/api/src/lib/positionSortKey.ts
export function positionSortKey(position: any, format: string): string {
  if (format === 'pdf') return String(position?.page ?? 0).padStart(8, '0')
  const cfi = String(position?.startCfi ?? position?.cfi ?? '')
  return cfi // los CFI comparten prefijo, el orden lexicográfico es correcto dentro del mismo libro
}
```
Rutas con validación (colores const `['yellow','gray','pink','blue','bookmark']`), `ORDER BY positionSortKey` resuelto en JS tras traer por book (el volumen por libro es pequeño): traer todas y sort en el handler.

- [ ] **Step 3: Run → PASS. Step 4: Commit** `feat(api): annotations CRUD with reading-order sort`

---

### Task 9: Web — esqueleto, tema Kindle, api client, auth context

**Files:**
- Create: `apps/web/src/theme.css`, `apps/web/src/api.ts`, `apps/web/src/state/AuthContext.tsx`, `apps/web/src/pages/Login.tsx` (placeholder → Task 10), `apps/web/src/test/mocks.ts`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/main.tsx`

**Interfaces:**
- Produces: `api` con métodos tipados: `register(email, password)`, `login(email, password)`, `logout()`, `me()`, `listBooks()`, `getBook(id)`, `uploadBook(file, onProgress)`, `deleteBook(id)`, `patchProgress(id, position, percent)`, `resetProgress(id)`, `patchCover(id, blob)`, `listAnnotations(bookId)`, `createAnnotation(bookId, body)`, `deleteAnnotation(id)`; todos lanzan `ApiError { status, message }` y 401 hace `redirect('/login')`. `AuthProvider` con `user`, `login()`, `logout()`, `loading`. Tokens CSS del spec §8.

- [ ] **Step 1: theme.css (tokens exactos del spec)**

```css
:root {
  --paper: #F8F1E1; --paper-raised: #FFFBF2; --ink: #2B2A26; --ink-soft: #6B675E;
  --accent: #B07C1F; --line: #E4D9C3; --shadow: rgba(43,42,38,.12);
  --radius: 8px; --serif: Georgia, 'Bookerly', 'Times New Roman', serif;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    --paper: #141414; --paper-raised: #1C1C1C; --ink: #C9C4B8; --ink-soft: #8B877D;
    --accent: #D89B3C; --line: #2A2A2A; --shadow: rgba(0,0,0,.4);
  }
}
:root[data-theme='dark'] { --paper: #141414; --paper-raised: #1C1C1C; --ink: #C9C4B8; --ink-soft: #8B877D; --accent: #D89B3C; --line: #2A2A2A; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font-family: var(--serif); }
button { font-family: var(--serif); }
```

- [ ] **Step 2: api.ts**

```ts
// apps/web/src/api.ts
export class ApiError extends Error { constructor(public status: number, message: string) { super(message) } }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, { ...init, headers: { ...(init?.headers as object) } })
  if (res.status === 401 && !path.startsWith('/auth/')) {
    location.assign('/login'); throw new ApiError(401, 'Sesión requerida')
  }
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({ message: res.statusText }))).message)
  return res.status === 204 ? (undefined as T) : res.json()
}

export type Position = { page: number } | { cfi: string; percent: number; section: number }
export type Book = { id: string; title: string; author: string; format: 'pdf' | 'epub'; cover_path: string | null; total_pages: number | null; file_size: number; added_at: string; percent: string | null; position: Position | null; last_read: string | null }
export type Annotation = { id: string; book_id: string; kind: 'highlight' | 'note'; position: any; quoted_text: string; note: string; color: string; created_at: string }

export const api = {
  register: (email: string, password: string) => request<{ id: string; email: string }>('/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }),
  login: (email: string, password: string) => request<{ id: string; email: string }>('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: () => request<{ id: string; email: string } | null>('/auth/me').catch(() => null),
  listBooks: () => request<Book[]>('/books'),
  getBook: (id: string) => request<{ book: Book; progress: { position: Position; percent: string } | null }>(`/books/${id}`),
  uploadBook: (file: File, onProgress?: (p: number) => void) => new Promise<Book>((resolve, reject) => {
    const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/books')
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total)
    xhr.onload = () => xhr.status === 201 ? resolve(JSON.parse(xhr.responseText)) : reject(new ApiError(xhr.status, JSON.parse(xhr.responseText || '{}').message ?? 'Error al subir'))
    xhr.send(file)
  }),
  patchCover: (id: string, blob: Blob) => request<Book>(`/books/${id}/cover`, { method: 'PATCH', headers: { 'content-type': 'image/jpeg' }, body: blob }),
  deleteBook: (id: string) => request<void>(`/books/${id}`, { method: 'DELETE' }),
  patchProgress: (id: string, position: Position, percent: number) => request<any>(`/books/${id}/progress`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ position, percent }) }),
  resetProgress: (id: string) => request<void>(`/books/${id}/progress`, { method: 'DELETE' }),
  listAnnotations: (bookId: string) => request<Annotation[]>(`/books/${bookId}/annotations`),
  createAnnotation: (bookId: string, body: Pick<Annotation, 'kind' | 'position'> & Partial<Pick<Annotation, 'quoted_text' | 'note' | 'color'>>) => request<Annotation>(`/books/${bookId}/annotations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  deleteAnnotation: (id: string) => request<void>(`/annotations/${id}`, { method: 'DELETE' }),
}
```
(+ `GET /files` no necesita método: el reader construye `/api/files/...` directo.)

- [ ] **Step 3: AuthContext + rutas con guard**

```tsx
// apps/web/src/state/AuthContext.tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api } from '../api'

type Auth = { user: { id: string; email: string } | null; loading: boolean; signIn: (e: string, p: string) => Promise<void>; signOut: () => Promise<void> }
const Ctx = createContext<Auth>(null as never)
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<Auth['user']>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => { api.me().then(u => { setUser(u); setLoading(false) }) }, [])
  const value: Auth = {
    user, loading,
    signIn: async (email, password) => setUser(await api.login(email, password)),
    signOut: async () => { await api.logout(); setUser(null) },
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
export const useAuth = () => useContext(Ctx)
```

```tsx
// apps/web/src/App.tsx
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { AuthProvider, useAuth } from './state/AuthContext'
import Login from './pages/Login'
import Library from './pages/Library'

function RequireAuth() {
  const { user, loading } = useAuth()
  if (loading) return <div className="page-center">Cargando…</div>
  return user ? <Outlet /> : <Navigate to="/login" replace />
}
export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<RequireAuth />}>
            <Route path="/" element={<Library />} />
            <Route path="/reader/:bookId" element={<div />} /> {/* Tasks 12–13 */}
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
```
`pages/Library.tsx` stub (Task 11 completa). Mocks de test en `src/test/mocks.ts`: helper `mockApi(vi.spyOn(api, 'x')...)` y stub de `matchMedia`, `ResizeObserver`.

- [ ] **Step 4: Build + smoke** `npx vite build` PASS, `npx vitest run` PASS (solo setup). **Commit** `feat(web): app shell, kindle theme tokens, api client, auth context`

---

### Task 10: Pantallas de login y registro

**Files:**
- Modify: `apps/web/src/pages/Login.tsx`, Create: `apps/web/src/pages/Register.tsx`
- Test: `apps/web/src/test/Login.test.tsx`

**Interfaces:** Consumes `useAuth` (Task 9). Produces: rutas `/login` y `/register`; si ya hay sesión, redirige a `/`.

- [ ] **Step 1: Test**

```tsx
// apps/web/src/test/Login.test.tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import Login from '../pages/Login'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../api', () => ({
  api: { login: vi.fn().mockResolvedValue({ id: '1', email: 'a@b.c' }), me: vi.fn().mockResolvedValue(null) },
}))

describe('Login', () => {
  it('valida campos vacíos', async () => {
    render(<MemoryRouter><Login /></MemoryRouter>)
    await userEvent.click(screen.getByRole('button', { name: /entrar/i }))
    expect(await screen.findByText(/completá email y contraseña/i)).toBeInTheDocument()
  })
  it('muestra error con credenciales incorrectas', async () => {
    const { api } = await import('../api')
    vi.mocked(api.login).mockRejectedValueOnce(Object.assign(new Error('x'), { status: 401 }))
    render(<MemoryRouter><Login /></MemoryRouter>)
    await userEvent.type(screen.getByLabelText(/email/i), 'a@b.c')
    await userEvent.type(screen.getByLabelText(/contraseña/i), 'wrong')
    await userEvent.click(screen.getByRole('button', { name: /entrar/i }))
    expect(await screen.findByText(/email o contraseña incorrectos/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Implementación** (Login + Register comparten layout: papel, serif, card centrada; Register con enlace "¿No tenés cuenta? Creá una". Mensaje de error con `error.message` mapeado 401→"Email o contraseña incorrectos").

- [ ] **Step 3: Run → PASS. Commit** `feat(web): login and register screens`

---

### Task 11: Biblioteca (grilla, subir, seguir leyendo)

**Files:**
- Modify: `apps/web/src/pages/Library.tsx`
- Test: `apps/web/src/test/Library.test.tsx`

**Interfaces:** Consumes `api.listBooks/uploadBook/deleteBook/resetProgress`, `Book`. Produces: fila "Seguir leyendo" (libro con `last_read` más reciente), grilla con portada (`/api/files/` de `cover_path` o fallback iniciales), barra de progreso fina + %, menú ⋯ (Continuar / Desde el principio / Eliminar), botón "Añadir libro" con drag&drop y barra de progreso de subida, búsqueda por título/autor, orden reciente/título. Al subir un PDF: renderizar portada con pdf.js (canvas, 400 px) y `api.patchCover`.

- [ ] **Step 1: Tests** (mock de `api.listBooks` con 3 libros: uno con `percent: '38'` y `last_read` reciente; uno sin progreso; verificar: fila seguir leyendo contiene el título correcto, barra aria-valuenow=38, filtro de búsqueda oculta los demás, menú eliminar llama `api.deleteBook` y quita la tarjeta).

- [ ] **Step 2: Implementación** — componentes: `LibraryPage`, `BookCard`, `AddBookControl` (input file + drop zone), `ConfirmMenu`. Fallback de portada: div con iniciales en serif grande. Subida: spinner → al terminar, refetch.

- [ ] **Step 3: Run → PASS. Commit** `feat(web): library grid, upload flow and continue-reading row`

---

### Task 12: PDF Reader — render, volteo, navegación, progreso

**Files:**
- Create: `apps/web/src/reader/Reader.tsx` (elige PDF vs EPUB), `apps/web/src/reader/PdfReader.tsx`, `apps/web/src/reader/PageTurn.tsx`, `apps/web/src/lib/progressSync.ts`
- Modify: `apps/web/src/App.tsx` (ruta `/reader/:bookId` → `<Reader/>`)
- Test: `apps/web/src/test/PdfReader.test.tsx`, `apps/web/src/test/progressSync.test.ts`

**Interfaces:**
- Produces (para Tasks 13–14): `ReaderChrome` (topbar/bottombar compartidos), `useProgressSync(bookId)` → `{ save(position, percent), flush() }` (debounce 1,5 s + cola de reintento + `pagehide` beacon), `PageTurn` (wrapper con animación 3D, props `direction`, `key`), `TopBar/BottomBar` con props (title, onBack, percent, label, onSliderJump).
- pdf.js worker: `import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'` + `GlobalWorkerOptions.workerSrc = workerUrl`.

- [ ] **Step 1: Test de progressSync**

```ts
// apps/web/src/test/progressSync.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useProgressSync } from '../lib/progressSync'

describe('progressSync', () => {
  beforeEach(() => { vi.useFakeTimers() })
  it('debouncea 1.5s y solo manda la última posición', async () => {
    const patch = vi.fn().mockResolvedValue(undefined)
    const sync = createSyncForTest(patch) // helper que expone createProgressSync({ save }) para test sin React
    sync.save({ page: 1 }, 1); sync.save({ page: 2 }, 2); sync.save({ page: 3 }, 3)
    await vi.advanceTimersByTimeAsync(1500)
    expect(patch).toHaveBeenCalledTimes(1)
    expect(patch).toHaveBeenCalledWith({ page: 3 }, 3)
  })
  it('encola si falla y reintenta', async () => {
    const patch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    const sync = createSyncForTest(patch)
    sync.save({ page: 5 }, 50)
    await vi.advanceTimersByTimeAsync(1500)
    await vi.advanceTimersByTimeAsync(3000) // reintento
    expect(patch).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Implementación de progressSync** (función pura `createProgressSync(patch)` + hook que agrega listener `pagehide` → `navigator.sendBeacon('/api/books/:id/progress', blob JSON PATCH-equivalente)`).

- [ ] **Step 3: Test de PdfReader** — mock de `pdfjs-dist` (`getDocument` → doc con `getPage` → page fake con `getViewport`, `render` y `getTextContent`); verificar: `onPageChange` al presionar →, salto inicial a la página del progreso guardado (`{page: 7}` de `getBook` mock → render llama viewport de página 7), teclado ←/→.

- [ ] **Step 4: Implementación de PdfReader** — puntos clave:
  - Estado: `numPages`, `page` (1-index), `direction` para la animación.
  - Render: `<PageTurn key={page} direction={direction}><canvas ref/></PageTurn>` — solo un canvas activo; el wrapper anima `rotateY` saliente/entrante con `@keyframes turn-next` (350 ms, `ease-out`) y sombra dinámica via pseudo-elemento con gradiente.
  - Zonas: div absoluto izquierdo/derecho 40% + centro 20% que alterna `chromeVisible`.
  - `fit: 'page' | 'width'` controla el viewport; resize re-renderiza.
  - Modo noche: filtro CSS `invert(0.88) hue-rotate(180deg)` sobre el canvas (inversión real del PDF).
  - Progreso: `useEffect` en `page` → `sync.save({ page }, page/numPages*100)`; al montar, si `progress` existe → `page = progress.position.page` **antes del primer render** (inicializar en `useState(() => …)`).

- [ ] **Step 5: Run → PASS. Commit** `feat(web): pdf reader with page-turn, zones, keyboard and progress sync`

---

### Task 13: EPUB Reader — epub.js, retomar por CFI, controles Aa

**Files:**
- Create: `apps/web/src/reader/EpubReader.tsx`
- Modify: `apps/web/src/reader/Reader.tsx` (routing), `apps/web/src/reader/AaPanel.tsx` (compartido)
- Test: `apps/web/src/test/EpubReader.test.tsx` (mock de `epubjs`)

**Interfaces:** Consumes `useProgressSync`, `ReaderChrome`, `AaPanel`. Produces: props `AaPanel { settings, onChange }` con `Settings { fontSize: number (px), lineHeight: number, theme: 'day' | 'night', fontFamily: 'serif' | 'sans' }`; persistencia de Settings en `localStorage` (`kc.reader.settings`).

- [ ] **Step 1: Test** — mock `Book`/`Rendition` de epubjs: verificar que al montar con progreso guardado llama `rendition.display(progress.position.cfi)` (no a la página 1), que `relocated` dispara `save({cfi, percent, section})`, y que `onChange({fontSize: 20})` llama `themes.fontSize('20px')`.

- [ ] **Step 2: Implementación** — puntos clave:
  - `const book = ePub('/api/files/' + fileUrl)` (con credenciales: `epub.js` usa fetch propio — pasar `{ requestMethod: fetch con cookie, credentials: 'include' }` vía `openAs`/`requestUrl` custom).
  - `rendition.display(savedCfi)`; listener `relocated` → `location.start.cfi`, `location.start.percentage`, índice de sección → save.
  - Navegación: `rendition.prev()/next()` mapeados a zonas/swipe/teclado; animación de volteo en EPUB = fade + translateX leve (el flip 3D solo aplica al modo PDF de página única; en EPUB modo paginado la transición es de columna — usar `spread: 'none'` para página simple).
  - Resaltados guardados: `rendition.annotations.add('highlight', startCfi, endCfi, data, cb, {fill})` al cargar cada sección (`rendered` event + `listAnnotations`).
  - Aa: `themes.fontSize`, `themes.override('color', ...)`, night = `themes.register('night', {body: {background, color}})` + `themes.select('night')`.

- [ ] **Step 3: Run → PASS. Commit** `feat(web): epub reader with cfi resume, aa controls and night mode`

---

### Task 14: Anotaciones UI (menú de selección, panel, marcador)

**Files:**
- Create: `apps/web/src/reader/SelectionMenu.tsx`, `apps/web/src/reader/AnnotationsPanel.tsx`
- Modify: `PdfReader.tsx` (textLayer + rects overlay + nota de página + marcador), `EpubReader.tsx` (rendition.annotations), `ReaderChrome`
- Test: `apps/web/src/test/SelectionMenu.test.tsx`, `apps/web/src/test/AnnotationsPanel.test.tsx`

**Interfaces:**
- Produces: `SelectionMenu { x, y, onSelect(color), onNote, onClose }` (flotante, cerrar al tocar fuera); `AnnotationsPanel { bookId, onJump(position), onClose }` (lista ordenada, excluye `color==='bookmark'`, borrar con confirmación inline); `BookmarkButton { marked, onToggle }` (cinta curva con CSS transform).

- [ ] **Step 1: Test de SelectionMenu** — simular selección (rango de texto en un párrafo de prueba, `document.getSelection().addRange`), verificar que aparecen 4 botones de color (amarillo/gris/rosa/azul con `aria-label` del color) + "Nota"; click en rosa → `onSelect('pink')`.

- [ ] **Step 2: Implementación**
  - PDF: render con `textLayerMode` (pdf.js `TextLayer` del render task); listener `mouseup` → `getSelection` → convertir rects de texto (`Range.getClientRects()`) a coords normalizadas sobre la página (`(x - canvasRect.x)/width`) → POST → overlay divs con `mix-blend-mode: multiply` y color con alpha (papel) / `screen` (noche).
  - EPUB: `rendition.on('selected', (cfiRange, contents) => ...)` → menú → `annotations.add(type:'highlight', cfiRange, ...)` + POST; notas ancladas al highlight (click en el highlight → abrir panel/note editor).
  - Marcador PDF: botón cinta; toggle crea/borra annotation `{page}`, color `bookmark`. Marcador EPUB: ancla al CFI actual, mismo color.
  - Panel: usa `listAnnotations`, `positionSortKey` client-side para ordenar, `onJump` navega (PDF: `page`; EPUB: `rendition.display(startCfi)`).

- [ ] **Step 3: Run → PASS. Commit** `feat(web): selection menu, highlights, notes panel and bookmarks`

---

### Task 15: Docker, compose, Swarm y README

**Files:**
- Create: `Dockerfile`, `.dockerignore` (ya existe), `docker-compose.yml`, `deploy/swarm.yml`, `README.md` (real), `apps/api/Dockerfile` (no — un solo Dockerfile raíz)

**Interfaces:** Produces: imagen `kindlecubeark`; comandos `docker build -t kindlecubeark .`, `docker compose up`, `docker stack deploy -c deploy/swarm.yml kindle`.

- [ ] **Step 1: Dockerfile multi-stage**

```dockerfile
# --- build web ---
FROM node:20-alpine AS build-web
WORKDIR /src/apps/web
COPY apps/web/package*.json ./
RUN npm ci
COPY apps/web /src/apps/web
RUN npm run build

# --- build api ---
FROM node:20-alpine AS build-api
WORKDIR /src/apps/api
COPY apps/api/package*.json ./
RUN npm ci
COPY apps/api /src/apps/api
RUN npm run build && npm prune --omit=dev

# --- runtime ---
FROM node:20-alpine AS runtime
WORKDIR /srv
COPY --from=build-api /src/apps/api/dist ./api/dist
COPY --from=build-api /src/apps/api/node_modules ./api/node_modules
COPY --from=build-api /src/apps/api/package.json ./api/package.json
COPY --from=build-web /src/apps/web/dist ./web/dist
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
RUN addgroup -S app && adduser -S app -G app && mkdir -p /data && chown app:app /data
USER app
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "api/dist/index.js"]
```
Ajustar `WEB_DIST` default en `config.ts` a `web/dist` y servir con `@fastify/static` (root `web/dist`, `wildcard: false`, con fallback de SPA: `setNotFoundHandler` sirve `index.html` para rutas no-`/api`). `@fastify/static` en dependencies.

- [ ] **Step 2: docker-compose.yml (dev)**

```yaml
services:
  db:
    image: postgres:16-alpine
    environment: { POSTGRES_USER: kindle, POSTGRES_PASSWORD: kindle, POSTGRES_DB: kindle }
    ports: ["5432:5432"]
    volumes: [dbdata:/var/lib/postgresql/data]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U kindle"], interval: 5s, retries: 10 }
  app:
    build: .
    environment:
      DATABASE_URL: postgres://kindle:kindle@db:5432/kindle
      DATA_DIR: /data
      SESSION_SECRET: dev-secret-change-me-0123456789abcdef
      MAX_UPLOAD_MB: "100"
    ports: ["3000:3000"]
    volumes: [bookdata:/data]
    depends_on: { db: { condition: service_healthy } }
volumes: { dbdata: {}, bookdata: {} }
```

- [ ] **Step 3: deploy/swarm.yml**

```yaml
version: "3.8"
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: kindle
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
      POSTGRES_DB: kindle
    secrets: [db_password]
    volumes: [dbdata:/var/lib/postgresql/data]
    networks: [internal]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U kindle"], interval: 10s, retries: 5 }
    deploy:
      replicas: 1
      placement: { constraints: ["node.role == worker"] }
  app:
    image: registry.example.com/kindlecubeark:latest   # ← cambiar por el registry real
    environment:
      DATABASE_URL: postgres://kindle:kindle@db:5432/kindle
      DATA_DIR: /data
      MAX_UPLOAD_MB: "100"
      NODE_ENV: production
    secrets: [session_secret]
    volumes: [bookdata:/data]
    networks: [internal, public]
    deploy:
      replicas: 2
      update_config: { parallelism: 1, delay: 10s, order: start-first, failure_action: rollback }
      rollback_config: { parallelism: 1, delay: 10s }
      restart_policy: { condition: on-failure, delay: 5s, max_attempts: 3 }
      resources: { limits: { memory: 512M } }
    healthcheck: { test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/api/health"], interval: 30s, timeout: 5s, retries: 3 }
secrets:
  db_password: { external: true }
  session_secret: { external: true }
volumes:
  dbdata: {}
  bookdata: {}
networks:
  internal: { driver: overlay, internal: true, driver_opts: { encrypted: "" } }
  public: { driver: overlay }
```
Nota: `SESSION_SECRET` debe leerse del secret — en `config.ts`, si existe `/run/secrets/session_secret`, leer el archivo. `replicas: 2` solo con registry compartido; para node único usar 1.

- [ ] **Step 4: Build y smoke**

Run: `docker build -t kindlecubeark . && docker compose up -d && sleep 5 && curl -s localhost:3000/api/health`
Expected: `{"ok":true}`
Humo manual (documentar en README): subir PDF+EPUB, leer, anotar, cerrar, reabrir → retoma exacto; `docker service update --image kindlecubeark:v2 kindle_app` para rolling update.

- [ ] **Step 5: Commit** `chore: docker multi-stage, compose dev, swarm stack, README`

---

## Self-Review (hecho al escribir)

- **Cobertura del spec:** §3 arquitectura (T1–2, T15), §4 esquema (T3), §5 API (T4–8), §6 progreso/retomar (T7, T12–13), §7 anotaciones (T8, T14), §8 UI/reader (T9–14), §9 errores (T5 upload inválido, T12 progreso encolado, 401→login en api client T9), §10 pruebas (cada task), §11 deploy (T15), §12 fuera de alcance: no implementado. ✓
- **Placeholders:** los tests de Tasks 6, 7, 8, 11, 13 describen el caso + setup con patrón explícito de Task 5; el implementador debe escribirlos completos siguiendo ese patrón — no hay "add error handling" ni TBD. Los casos marcados `/* ... */` en tests son *especificaciones del caso*, cada uno con expected explícito.
- **Tipos consistentes:** `Position` (T9) = shapes de spec §6/§7; `api.patchProgress(id, position, percent)` usado por `createProgressSync(patch)` en T12; `Book.cover_path`/`file_path` consistentes con T6.
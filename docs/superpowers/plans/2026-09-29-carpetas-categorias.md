# Carpetas de colores (categorías) — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Organizar libros en carpetas con color propio elegibles con selector dinámico, editables (nombre y color), con drag & drop de libros hacia adentro/fuera y relevo de menú accesible.

**Architecture:** Tabla `folders` + columna `books.folder_id` (FK `ON DELETE SET NULL`); rutas Fastify nuevas `folders.ts` y `PATCH /api/books/:id/folder`; en la SPA, fila de tarjetas de carpeta sobre la grilla existente, vista de carpeta, diálogo crear/editar con `<input type="color">` y drag & drop HTML5 con menú de relevo.

**Tech Stack:** Fastify 4 + Postgres (pg, migraciones SQL ordenadas), React 18 + Vite, vitest (API con Postgres real del compose; web con jsdom + testing-library).

**Spec:** `docs/superpowers/specs/2026-09-29-carpetas-categorias-design.md`

## Global Constraints

- Commits **sin** trailer `Co-Authored-By` (instrucción explícita del usuario para este repo).
- Sin dependencias runtime nuevas (ni en API ni en web).
- Mensajes de UI y de API en español (voseo, como el resto del repo: «Arrastrá…», «Todavía no tenés libros»).
- Color guardado como hex minúsculas `#rrggbb` (regex `^#[0-9a-f]{6}$` después de normalizar).
- Recurso ajeno o inexistente → siempre 404 con `{message}`, nunca 403 (patrón de `books.ts`).
- Un libro pertenece a una sola carpeta o a `NULL`; borrar carpeta no borra ni toca libros.
- La API no expone rutas de disco al cliente (patrón `toClient`).

## Review Focus

1. **Carpeta ajena como destino de «mover»**: `PATCH /api/books/:id/folder` con el id de una carpeta de otro usuario → 404 `{message:'Carpeta no encontrada'}` (test en Task 4).
2. **Carpeta borrada mientras la UI la usa**: el drop/menú hace PATCH, la API responde 404, la UI muestra `role="alert"` «No se pudo mover el libro…» y recarga ambas listas (test en Task 6, caso «si el PATCH de mover falla»).
3. **Color con mayúsculas se normaliza a minúsculas** (`#FF00AA` → `#ff00aa`); formatos inválidos (`red`, `#fff`, `#rrggbbAA`) → 400 (tests en Task 2).
4. **Nombre con solo espacios, vacío o >60 caracteres** → 400 con mensaje claro (test en Task 2).
5. **Borrar carpeta con libros dentro**: los libros sobreviven con `folder_id = NULL`, aparecen en la vista «Todos», y sus archivos/progresos intactos (test en Task 1).

---

### Task 1: Migración `002_folders.sql`

**Files:**
- Create: `apps/api/migrations/002_folders.sql`
- Test: `apps/api/test/folders.test.ts` (nuevo)

**Interfaces:**
- Produces: tablas `folders (id uuid, user_id, name, color, created_at)` y `books.folder_id`. Las columnas `id`, `name`, `color` y `created_at` son las que usan `folders.ts` (Task 2-3) y `toClient` de Task 4.

- [ ] **Step 1: Write the failing test**

Crear `apps/api/test/folders.test.ts`. Los tests levantan la app con `buildApp`, que corre las migraciones al configurar (`config.runMigrations` default true), así que basta verificar el esquema y el FK `ON DELETE SET NULL`:

```typescript
// apps/api/test/folders.test.ts — esquema de carpetas y efecto de borrarlas (Task 1).
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { buildApp } from '../src/app.js'
import { resetDb } from './helpers/db.js'
import { pool } from '../src/db.js'
import { registerAndGetCookie } from './helpers/upload.js'

beforeEach(async () => { await resetDb() })
afterAll(async () => { await pool.end().catch(() => {}) })

describe('esquema de carpetas', () => {
  it('crea la tabla folders y el FK books.folder_id con ON DELETE SET NULL', async () => {
    await buildApp({ skipStatic: true })
    const { rows: u } = await pool.query(
      "INSERT INTO users (email, password_hash) VALUES ('f@test.dev','x') RETURNING id",
    )
    const { rows: [folder] } = await pool.query(
      `INSERT INTO folders (user_id, name, color) VALUES ($1, 'Novelas', '#ff00aa') RETURNING *`,
      [u[0].id],
    )
    expect(folder.color).toBe('#ff00aa')

    const { rows: [book] } = await pool.query(
      `INSERT INTO books (user_id, title, format, file_path, file_size, folder_id)
       VALUES ($1,'Libro','pdf','x/libro.pdf',10,$2) RETURNING *`,
      [u[0].id, folder.id],
    )
    expect(book.folder_id).toBe(folder.id)

    await pool.query('DELETE FROM folders WHERE id = $1', [folder.id])
    const { rows: [after] } = await pool.query('SELECT folder_id FROM books WHERE id = $1', [book.id])
    expect(after.folder_id).toBeNull()
  })

  it('rechaza un color con formato inválido (CHECK de la migración)', async () => {
    await buildApp({ skipStatic: true })
    const { rows: [u] } = await pool.query(
      "INSERT INTO users (email, password_hash) VALUES ('f2@test.dev','x') RETURNING id",
    )
    await expect(pool.query(
      `INSERT INTO folders (user_id, name, color) VALUES ($1, 'X', 'red')`, [u.id],
    )).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run test/folders.test.ts`
Expected: FAIL — error de Postgres «relations "folders" does not exist» (42P01) al insertar.

- [ ] **Step 3: Write the migration**

`apps/api/migrations/002_folders.sql` (el migrador aplica `NNN_*.sql` ordenados, en transacción por archivo, y registra cada uno en `_migrations`):

```sql
CREATE TABLE folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  color text NOT NULL CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON folders(user_id, created_at);

ALTER TABLE books ADD COLUMN folder_id uuid REFERENCES folders(id) ON DELETE SET NULL;
```

Nota: el CHECK de `color` es defensa en profundidad; la API valida y normaliza antes de insertar (Task 2).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run test/folders.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/002_folders.sql apps/api/test/folders.test.ts
git commit -m "feat(api): migración 002 — tabla folders y books.folder_id con ON DELETE SET NULL"
```

---

### Task 2: Rutas `GET /api/folders` y `POST /api/folders` con validaciones

**Files:**
- Create: `apps/api/src/routes/folders.ts`
- Modify: `apps/api/src/app.ts` (registrar el plugin)
- Test: `apps/api/test/folders.test.ts` (agregar describe)

**Interfaces:**
- Consumes: tablas de Task 1; patrón de `books.ts` (`app.verifySession`, `app.query<T>`, 404/400 con `{message}`).
- Produces: `GET /api/folders` → `Folder[]` con `{id, name, color, book_count: number, created_at}`; `POST /api/folders {name, color}` → 201 `Folder` con `color` normalizado a minúsculas. `FolderRow` interno export solo como tipo local. `app.ts` registra `folders` después de `books`.

- [ ] **Step 1: Write the failing tests**

Agregar al final de `apps/api/test/folders.test.ts`:

```typescript
import { registerAndGetCookie } from './helpers/upload.js' // (ya importado)

describe('folders API', () => {
  it('POST crea, normaliza color a minúsculas y GET lista con book_count', async () => {
    const app = await buildApp({ skipStatic: true })
    const cookie = await registerAndGetCookie(app, 'a@test.dev')

    const res = await app.inject({
      method: 'POST', url: '/api/folders', cookies: { session: cookie },
      payload: { name: '  Novelas  ', color: '#FF00AA' },
    })
    expect(res.statusCode).toBe(201)
    const folder = res.json()
    expect(folder.name).toBe('Novelas')
    expect(folder.color).toBe('#ff00aa')
    expect(folder.book_count).toBe(0)
    expect(folder.created_at).toBeTruthy()
    expect(folder.id).toMatch(/^[0-9a-f-]{36}$/)

    const list = await app.inject({ method: 'GET', url: '/api/folders', cookies: { session: cookie } })
    expect(list.statusCode).toBe(200)
    expect(list.json()).toEqual([folder])
  })

  it('GET no lista carpetas de otro usuario', async () => {
    const app = await buildApp({ skipStatic: true })
    const cookieA = await registerAndGetCookie(app, 'a@test.dev')
    const cookieB = await registerAndGetCookie(app, 'b@test.dev')
    await app.inject({ method: 'POST', url: '/api/folders', cookies: { session: cookieA },
      payload: { name: 'De A', color: '#ff00aa' } })

    const res = await app.inject({ method: 'GET', url: '/api/folders', cookies: { session: cookieB } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })

  it('book_count cuenta los libros de la carpeta', async () => {
    const app = await buildApp({ skipStatic: true })
    const cookie = await registerAndGetCookie(app, 'a@test.dev')
    const folder = (await app.inject({ method: 'POST', url: '/api/folders', cookies: { session: cookie },
      payload: { name: 'C', color: '#ff00aa' } })).json()
    const { rows: [u] } = await pool.query("SELECT id FROM users WHERE email = 'a@test.dev'")
    await pool.query(
      `INSERT INTO books (user_id, title, format, file_path, file_size, folder_id)
       VALUES ($1,'L1','pdf','x/1.pdf',1,$2), ($1,'L2','epub','x/2.epub',1,$2), ($1,'L3','pdf','x/3.pdf',1,NULL)`,
      [u.id, folder.id],
    )
    const list = await app.inject({ method: 'GET', url: '/api/folders', cookies: { session: cookie } })
    expect(list.json()).toEqual([expect.objectContaining({ id: folder.id, book_count: 2 })])
  })

  it.each([
    ['nombre vacío', { name: '   ', color: '#ff00aa' }],
    ['nombre > 60', { name: 'x'.repeat(61), color: '#ff00aa' }],
    ['color inválido', { name: 'Ok', color: '#fff' }],
    ['color no hex', { name: 'Ok', color: 'red' }],
    ['color con alpha', { name: 'Ok', color: '#ff00aaff' }],
  ])('400 con %s', async (_label, payload) => {
    const app = await buildApp({ skipStatic: true })
    const cookie = await registerAndGetCookie(app, 'a@test.dev')
    const res = await app.inject({ method: 'POST', url: '/api/folders', cookies: { session: cookie }, payload })
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toBeTruthy()
  })

  it('401 sin sesión', async () => {
    const app = await buildApp({ skipStatic: true })
    const res = await app.inject({ method: 'GET', url: '/api/folders' })
    expect(res.statusCode).toBe(401)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run test/folders.test.ts`
Expected: FAIL — 404 en las rutas nuevas (setNotFoundHandler).

- [ ] **Step 3: Write `apps/api/src/routes/folders.ts`**

```typescript
import type { FastifyInstance } from 'fastify'

interface FolderRow {
  id: string
  name: string
  color: string
  created_at: string
  book_count?: number
}

// el cliente nunca recibe cosas internas; Folder para apps/web
function toClient(row: FolderRow) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    book_count: Number(row.book_count ?? 0),
    created_at: row.created_at,
  }
}

// nombre: recortado, 1-60 caracteres; color: #rrggbb, normalizado a minúsculas
export function validateFolderFields(body: { name?: unknown; color?: unknown }): {
  name?: string; color?: string; error?: string
} {
  const out: { name?: string; color?: string; error?: string } = {}
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim().length === 0 || body.name.trim().length > 60) {
      return { error: 'El nombre debe tener entre 1 y 60 caracteres' }
    }
    out.name = body.name.trim()
  }
  if (body.color !== undefined) {
    if (typeof body.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(body.color)) {
      return { error: 'El color debe ser #rrggbb' }
    }
    out.color = body.color.toLowerCase()
  }
  return out
}

export default async function folderRoutes(app: FastifyInstance) {
  app.get('/api/folders', { preHandler: app.verifySession }, async (req) => {
    const { rows } = await app.query<FolderRow>(
      `SELECT f.*, (SELECT COUNT(*)::int FROM books b WHERE b.folder_id = f.id) AS book_count
       FROM folders f WHERE f.user_id = $1 ORDER BY f.created_at`,
      [req.user!.id],
    )
    return rows.map(toClient)
  })

  app.post('/api/folders', { preHandler: app.verifySession }, async (req, reply) => {
    const { name, color, error } = validateFolderFields((req.body ?? {}) as Record<string, unknown>)
    if (error) return reply.code(400).send({ message: error })
    const { rows } = await app.query<FolderRow>(
      `INSERT INTO folders (user_id, name, color) VALUES ($1,$2,$3)
       RETURNING *, 0::int AS book_count`,
      [req.user!.id, name, color],
    )
    return reply.code(201).send(toClient(rows[0]))
  })
}
```

Registrar el plugin en `apps/api/src/app.ts` (junto a los demás):

```typescript
import folders from './routes/folders.js'
// ...
  await app.register(books)
  await app.register(folders)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run test/folders.test.ts`
Expected: PASS (todos los tests de Task 1 + Task 2).

- [ ] **Step 5: Verificar que la suite de API sigue verde**

Run: `cd apps/api && npx vitest run`
Expected: PASS (ningún test existente roto).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/folders.ts apps/api/src/app.ts apps/api/test/folders.test.ts
git commit -m "feat(api): rutas GET/POST /api/folders con validación de nombre y color"
```

---

### Task 3: `PATCH /api/folders/:id` (renombrar/recolorar) y `DELETE` (libros → NULL)

**Files:**
- Modify: `apps/api/src/routes/folders.ts`
- Test: `apps/api/test/folders.test.ts` (agregar describe)

**Interfaces:**
- Consumes: `validateFolderFields` de Task 2, tabla `folders`/`books` de Task 1.
- Produces: `PATCH /api/folders/:id {name?, color?}` → 200 `Folder` (400 si ni name ni color; 400 con ambos indefinidos explícito en test); `DELETE /api/folders/:id` → 204 y los libros quedan con `folder_id = NULL`. 404 para carpeta ajena/inexistente.

- [ ] **Step 1: Write the failing tests**

```typescript
describe('folders PATCH y DELETE', () => {
  async function makeFolder(app: any, cookie: string, name = 'Origen') {
    return (await app.inject({ method: 'POST', url: '/api/folders', cookies: { session: cookie },
      payload: { name, color: '#ff00aa' } })).json()
  }

  it('PATCH renombra y recolorea', async () => {
    const app = await buildApp({ skipStatic: true })
    const cookie = await registerAndGetCookie(app, 'a@test.dev')
    const folder = await makeFolder(app, cookie)

    const res = await app.inject({ method: 'PATCH', url: `/api/folders/${folder.id}`,
      cookies: { session: cookie }, payload: { name: ' Renombrada ', color: '#ABCDEF' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(expect.objectContaining({ name: 'Renombrada', color: '#abcdef' }))
  })

  it('PATCH con un solo campo cambia solo ese campo', async () => {
    const app = await buildApp({ skipStatic: true })
    const cookie = await registerAndGetCookie(app, 'a@test.dev')
    const folder = await makeFolder(app, cookie)
    const res = await app.inject({ method: 'PATCH', url: `/api/folders/${folder.id}`,
      cookies: { session: cookie }, payload: { color: '#123456' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(expect.objectContaining({ name: 'Origen', color: '#123456' }))
  })

  it('400 si PATCH no manda ni name ni color; 400 con valores inválidos', async () => {
    const app = await buildApp({ skipStatic: true })
    const cookie = await registerAndGetCookie(app, 'a@test.dev')
    const folder = await makeFolder(app, cookie)
    for (const payload of [{}, { name: '  ' }, { color: 'zzz' }]) {
      const res = await app.inject({ method: 'PATCH', url: `/api/folders/${folder.id}`,
        cookies: { session: cookie }, payload })
      expect(res.statusCode).toBe(400)
    }
  })

  it('PATCH y DELETE de carpeta ajena o inexistente → 404', async () => {
    const app = await buildApp({ skipStatic: true })
    const cookieA = await registerAndGetCookie(app, 'a@test.dev')
    const cookieB = await registerAndGetCookie(app, 'b@test.dev')
    const folder = await makeFolder(app, cookieA)

    const patch = await app.inject({ method: 'PATCH', url: `/api/folders/${folder.id}`,
      cookies: { session: cookieB }, payload: { name: 'Hack' } })
    expect(patch.statusCode).toBe(404)
    const del = await app.inject({ method: 'DELETE', url: `/api/folders/${folder.id}`,
      cookies: { session: cookieB } })
    expect(del.statusCode).toBe(404)
  })

  it('DELETE deja los libros con folder_id NULL y el CHECK vuelve a aceptar el color', async () => {
    const app = await buildApp({ skipStatic: true })
    const cookie = await registerAndGetCookie(app, 'a@test.dev')
    const folder = await makeFolder(app, cookie)
    const { rows: [u] } = await pool.query("SELECT id FROM users WHERE email = 'a@test.dev'")
    const { rows: [book] } = await pool.query(
      `INSERT INTO books (user_id, title, format, file_path, file_size, folder_id)
       VALUES ($1,'L','pdf','x/1.pdf',1,$2) RETURNING *`, [u.id, folder.id],
    )

    const res = await app.inject({ method: 'DELETE', url: `/api/folders/${folder.id}`,
      cookies: { session: cookie } })
    expect(res.statusCode).toBe(204)

    const { rows: [after] } = await pool.query('SELECT folder_id FROM books WHERE id = $1', [book.id])
    expect(after.folder_id).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run test/folders.test.ts`
Expected: FAIL — 404 en PATCH/DELETE de carpetas existentes (setNotFoundHandler).

- [ ] **Step 3: Agregar las rutas al final de `folderRoutes` (antes de la llave de cierre)**

```typescript
  app.patch('/api/folders/:id', { preHandler: app.verifySession }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { rows } = await app.query<FolderRow>(
      'SELECT * FROM folders WHERE id = $1 AND user_id = $2', [id, req.user!.id],
    )
    if (!rows.length) return reply.code(404).send({ message: 'Carpeta no encontrada' })

    const { name, color, error } = validateFolderFields((req.body ?? {}) as Record<string, unknown>)
    if (error) return reply.code(400).send({ message: error })
    if (name === undefined && color === undefined) {
      return reply.code(400).send({ message: 'Nada que actualizar' })
    }

    const { rows: up } = await app.query<FolderRow>(
      `WITH upd AS (
         UPDATE folders SET name = COALESCE($1, name), color = COALESCE($2, color)
         WHERE id = $3 AND user_id = $4 RETURNING *
       )
       SELECT upd.*, (SELECT COUNT(*)::int FROM books b WHERE b.folder_id = upd.id) AS book_count
       FROM upd`,
      [name ?? null, color ?? null, id, req.user!.id],
    )
    return toClient(up[0])
  })

  app.delete('/api/folders/:id', { preHandler: app.verifySession }, async (req, reply) => {
    const { id } = req.params as { id: string }
    // la FK books.folder_id ON DELETE SET NULL deja los libros en la biblioteca
    const { rowCount } = await app.query(
      'DELETE FROM folders WHERE id = $1 AND user_id = $2', [id, req.user!.id],
    )
    if (!rowCount) return reply.code(404).send({ message: 'Carpeta no encontrada' })
    return reply.code(204).send()
  })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run test/folders.test.ts`
Expected: PASS.

- [ ] **Step 5: Verificar suite completa** — Run: `cd apps/api && npx vitest run` — PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/folders.ts apps/api/test/folders.test.ts
git commit -m "feat(api): PATCH y DELETE de carpetas — renombrar/recolorar y dar de baja sin tocar libros"
```

---

### Task 4: `PATCH /api/books/:id/folder` — mover/sacar libro de carpeta

**Files:**
- Modify: `apps/api/src/routes/books.ts`
- Test: `apps/api/test/folders.test.ts` (describe `books folder`)

**Interfaces:**
- Consumes: `toClient`, patrón de rutas de `books.ts`, tabla `folders` de Task 1.
- Produces: `PATCH /api/books/:id/folder` con `{folder_id: string | null}` → 200 `Book` actualizado (incluye `folder_id`). 404 si el libro es ajeno o la carpeta destino no existe/no es del usuario. 400 si `folder_id` no es null ni un uuid. `GET /api/books` ya expone `folder_id` por `SELECT b.*` (se verifica en test).

- [ ] **Step 1: Write the failing tests**

```typescript
import { registerAndGetCookie, uploadBook } from './helpers/upload.js'
import { makeTestPdf } from './fixtures.js' // (agregar a imports existentes)

describe('books folder (mover/sacar)', () => {
  it('GET /api/books expone folder_id (null al inicio, asignado tras PATCH)', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: 'test-tmp/data' } })
    const cookie = await registerAndGetCookie(app, 'a@test.dev')
    const book = await uploadBook(app, cookie, await makeTestPdf(2))
    const folder = (await app.inject({ method: 'POST', url: '/api/folders', cookies: { session: cookie },
      payload: { name: 'N', color: '#ff00aa' } })).json()

    let list = (await app.inject({ method: 'GET', url: '/api/books', cookies: { session: cookie } })).json()
    expect(list[0].folder_id).toBeNull()

    const res = await app.inject({ method: 'PATCH', url: `/api/books/${book.id}/folder`,
      cookies: { session: cookie }, payload: { folder_id: folder.id } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(expect.objectContaining({ id: book.id, folder_id: folder.id }))

    list = (await app.inject({ method: 'GET', url: '/api/books', cookies: { session: cookie } })).json()
    expect(list[0].folder_id).toBe(folder.id)
  })

  it('sacar con folder_id null', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: 'test-tmp/data' } })
    const cookie = await registerAndGetCookie(app, 'a@test.dev')
    const book = await uploadBook(app, cookie, await makeTestPdf(2))
    const folder = (await app.inject({ method: 'POST', url: '/api/folders', cookies: { session: cookie },
      payload: { name: 'N', color: '#ff00aa' } })).json()
    await app.inject({ method: 'PATCH', url: `/api/books/${book.id}/folder`,
      cookies: { session: cookie }, payload: { folder_id: folder.id } })

    const res = await app.inject({ method: 'PATCH', url: `/api/books/${book.id}/folder`,
      cookies: { session: cookie }, payload: { folder_id: null } })
    expect(res.statusCode).toBe(200)
    expect(res.json().folder_id).toBeNull()
  })

  it('400 si folder_id no es null ni uuid', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: 'test-tmp/data' } })
    const cookie = await registerAndGetCookie(app, 'a@test.dev')
    const book = await uploadBook(app, cookie, await makeTestPdf(2))
    const res = await app.inject({ method: 'PATCH', url: `/api/books/${book.id}/folder`,
      cookies: { session: cookie }, payload: { folder_id: 'pepe' } })
    expect(res.statusCode).toBe(400)
  })

  it('404 con carpeta ajena/inexistente y con libro ajeno; 401 sin sesión', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: 'test-tmp/data' } })
    const cookieA = await registerAndGetCookie(app, 'a@test.dev')
    const cookieB = await registerAndGetCookie(app, 'b@test.dev')
    const folderA = (await app.inject({ method: 'POST', url: '/api/folders', cookies: { session: cookieA },
      payload: { name: 'De A', color: '#ff00aa' } })).json()
    const bookB = await uploadBook(app, cookieB, await makeTestPdf(2))

    // carpeta de A, libro de B: la búsqueda de carpeta scopea por usuario → 404
    const res1 = await app.inject({ method: 'PATCH', url: `/api/books/${bookB.id}/folder`,
      cookies: { session: cookieB }, payload: { folder_id: folderA.id } })
    expect(res1.statusCode).toBe(404)

    // libro de B, sesión de A → 404
    const res2 = await app.inject({ method: 'PATCH', url: `/api/books/${bookB.id}/folder`,
      cookies: { session: cookieA }, payload: { folder_id: null } })
    expect(res2.statusCode).toBe(404)

    const res3 = await app.inject({ method: 'PATCH', url: '/api/books/00000000-0000-4000-8000-000000000000/folder',
      cookies: { session: cookieA }, payload: { folder_id: null } })
    expect(res3.statusCode).toBe(404)

    const noSesion = await app.inject({ method: 'PATCH', url: `/api/books/${bookB.id}/folder`,
      payload: { folder_id: null } })
    expect(noSesion.statusCode).toBe(401)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run test/folders.test.ts`
Expected: FAIL — 404 («No encontrado») en PATCH `/api/books/:id/folder`; y `expect(list[0].folder_id)` falla con undefined hasta agregar la columna… (la columna ya existe por Task 1; falla la ruta).

- [ ] **Step 3: Agregar la ruta en `apps/api/src/routes/books.ts` (después de `delete /api/books/:id`)**

```typescript
  // mover/sacar de carpeta: null lo deja en la biblioteca (vista «Todos»)
  app.patch('/api/books/:id/folder', { preHandler: app.verifySession }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { rows } = await app.query<BookRow>(
      'SELECT * FROM books WHERE id = $1 AND user_id = $2', [id, req.user!.id],
    )
    if (!rows.length) return reply.code(404).send({ message: 'Libro no encontrado' })

    const { folder_id } = (req.body ?? {}) as { folder_id?: unknown }
    if (folder_id !== null) {
      if (typeof folder_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(folder_id)) {
        return reply.code(400).send({ message: 'folder_id inválido' })
      }
      // carpeta ajena o inexistente → 404 (la FK ya garantiza consistencia)
      const { rowCount } = await app.query(
        'SELECT 1 FROM folders WHERE id = $1 AND user_id = $2', [folder_id, req.user!.id],
      )
      if (!rowCount) return reply.code(404).send({ message: 'Carpeta no encontrada' })
    }
    const { rows: up } = await app.query<BookRow>(
      'UPDATE books SET folder_id = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
      [folder_id, id, req.user!.id],
    )
    return toClient(up[0])
  })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run test/folders.test.ts` — PASS.

- [ ] **Step 5: Verificar suite completa** — Run: `cd apps/api && npx vitest run` — PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/books.ts apps/api/test/folders.test.ts
git commit -m "feat(api): PATCH /api/books/:id/folder para mover y sacar libros de carpetas"
```

---

### Task 5: Cliente web — tipos `Folder`, `folder_id` en `Book` y métodos

**Files:**
- Modify: `apps/web/src/api.ts`
- Test: `apps/web/src/api.test.ts` (agregar casos)

**Interfaces:**
- Consumes: rutas de Tasks 2-4 (`/api/folders`, `/api/folders/:id`, `/api/books/:id/folder`).
- Produces (lo que Library.tsx consume en Tasks 6-8):
  - `Folder = { id: string; name: string; color: string; book_count: number; created_at: string }`
  - `Book` suma `folder_id: string | null`
  - `api.listFolders(): Promise<Folder[]>`; `api.createFolder(name: string, color: string): Promise<Folder>`; `api.updateFolder(id: string, patch: { name?: string; color?: string }): Promise<Folder>`; `api.deleteFolder(id: string): Promise<void>`; `api.setBookFolder(bookId: string, folderId: string | null): Promise<Book>`

- [ ] **Step 1: Write the failing tests**

Agregar a `apps/web/src/api.test.ts` (reusar el patrón de fetch stub que ya usa ese archivo; si no lo tiene, stub global):

```typescript
describe('folders y setBookFolder', () => {
  it('GET /folders con book_count numérico', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify([{ id: 'f1', name: 'Novelas', color: '#ff00aa', book_count: 2, created_at: '2026-09-29T00:00:00Z' }]),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )))
    const [f] = await api.listFolders()
    expect(f.book_count).toBe(2)
    expect(f.color).toBe('#ff00aa')
    vi.unstubAllGlobals()
  })

  it('createFolder/updateFolder/deleteFolder/setBookFolder usan el método y cuerpo correctos', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ id: 'f1', name: 'N', color: '#000000', book_count: 0, created_at: '' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)
    await api.createFolder('Novelas', '#ff00aa')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/folders', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ name: 'Novelas', color: '#ff00aa' }),
    }))
    await api.updateFolder('f1', { color: '#123456' })
    expect(fetchMock).toHaveBeenLastCalledWith('/api/folders/f1', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ color: '#123456' }),
    }))
    await api.deleteFolder('f1')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/folders/f1', expect.objectContaining({ method: 'DELETE' }))
    await api.setBookFolder('b1', null)
    expect(fetchMock).toHaveBeenLastCalledWith('/api/books/b1/folder', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ folder_id: null }),
    }))
    vi.unstubAllGlobals()
  })
})
```

(Si `api.test.ts` ya stubbea `fetch` con otro helper, reusar ese helper en lugar de `vi.stubGlobal`; el objetivo es el path, el method y el body.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run src/api.test.ts`
Expected: FAIL — `api.listFolders is not a function`.

- [ ] **Step 3: Implementar en `apps/web/src/api.ts`**

En la línea del type `Book`, agregar `folder_id`:

```typescript
export type Book = { id: string; title: string; author: string; format: 'pdf' | 'epub'; cover_url: string | null; file_url: string; total_pages: number | null; file_size: number; added_at: string; folder_id: string | null; percent: string | null; position: Position | null; last_read: string | null }
export type Folder = { id: string; name: string; color: string; book_count: number; created_at: string }
```

Dentro del objeto `api`, después de `resetProgress`:

```typescript
  listFolders: () => request<Folder[]>('/folders'),
  createFolder: (name: string, color: string) => request<Folder>('/folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, color }) }),
  updateFolder: (id: string, patch: { name?: string; color?: string }) => request<Folder>(`/folders/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }),
  deleteFolder: (id: string) => request<void>(`/folders/${id}`, { method: 'DELETE' }),
  setBookFolder: (bookId: string, folderId: string | null) => request<Book>(`/books/${bookId}/folder`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folder_id: folderId }) }),
```

- [ ] **Step 4: Run tests to verify they pass** — Run: `cd apps/web && npx vitest run src/api.test.ts` — PASS.

- [ ] **Step 5: Verificar suite web completa** — Run: `cd apps/web && npx vitest run` — PASS (los helpers `book()` de otros tests no pasan `folder_id`, pero `expect` en ellos no lo comprueba; si TypeScript falla porque falta el campo obligatorio, agregar `folder_id: null` al helper `book()` de `Library.test.tsx` y a cualquier otro factory).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/api.ts apps/web/src/api.test.ts apps/web/src/test/Library.test.tsx
git commit -m "feat(web): cliente API de carpetas — tipos Folder, folder_id y métodos CRUD"
```

---

### Task 6: Vista «Todos» + fila de carpetas con contador, filtrado por carpeta y relevo menú mover/sacar

**Files:**
- Modify: `apps/web/src/pages/Library.tsx`
- Modify: `apps/web/src/theme.css`
- Test: `apps/web/src/test/Library.test.tsx` (agregar describe)

> El drag & drop y el diálogo de carpeta llegan en Tasks 7-8; esta tarea construye el estado compartido, la fila, la vista de carpeta y el menú de relevo.

**Interfaces:**
- Consumes: `api.listFolders/createFolder/updateFolder/deleteFolder/setBookFolder`, `Folder`, `folder_id` de Task 5.
- Produces (para Tasks 7-8):
  - Estado de `Library`: `folders: Folder[]`, `activeFolderId: string | null` (null = «Todos»), `folderError: string | null`, y callback `moveBook(bookId: string, folderId: string | null): Promise<void>`.
  - Constante `SWATCH_COLORS: string[]` = `['#ef4444','#f59e0b','#3b82f6','#22c55e','#a855f7','#ec4899','#14b8a6','#6b7280']`.
  - `FolderCard` props: `{ folder: Folder; active: boolean; onOpen(): void; onEdit(): void; onDelete(): Promise<void>; onDropBook?(bookId: string): void }` (drop en Task 8 pasa `onDropBook`; Task 6 lo deja opcional con handlers no-op del create/edit conectados en Task 7).

- [ ] **Step 1: Write the failing tests**

En `apps/web/src/test/Library.test.tsx`, actualizar el factory y agregar el describe (los mocks de API se combinan):

```typescript
import { api, type Book, type Folder } from '../api'

// al factory book(...) existente agregar dentro del objeto base:
//     folder_id: null,
// (después de added_at, antes de percent)

const folderA: Folder = { id: 'f1', name: 'Novelas', color: '#ef4444', book_count: 0, created_at: '2026-09-28T00:00:00Z' }
const folderB: Folder = { id: 'f2', name: 'Estudio', color: '#3b82f6', book_count: 0, created_at: '2026-09-29T00:00:00Z' }

describe('Library — carpetas', () => {
  it('muestra las carpetas con su nombre y contador de libros', async () => {
    apiSpies.push(...Object.values(mockApi({
      listBooks: vi.fn().mockResolvedValue([books[0]]),
      listFolders: vi.fn().mockResolvedValue([{ ...folderA, book_count: 1 }]),
    })))
    renderLibrary()
    const row = await screen.findByTestId('folder-row')
    expect(within(row).getByText('Novelas')).toBeInTheDocument()
    expect(within(row).getByText('1')).toBeInTheDocument()
    expect(within(row).getByText('Estudio')).toBeInTheDocument()
  })

  it('la vista Todos muestra solo libros sin carpeta', async () => {
    apiSpies.push(...Object.values(mockApi({
      listBooks: vi.fn().mockResolvedValue([
        { ...books[0], folder_id: 'f1' },
        { ...books[1] }, // sin carpeta
      ]),
      listFolders: vi.fn().mockResolvedValue([folderA]),
    })))
    renderLibrary()
    await screen.findByTestId('book-card-b2')
    expect(screen.queryByTestId('book-card-b1')).not.toBeInTheDocument()
  })

  it('clic en una carpeta abre su vista con solo sus libros y botón Volver', async () => {
    apiSpies.push(...Object.values(mockApi({
      listBooks: vi.fn().mockResolvedValue([
        { ...books[0], folder_id: 'f1' },
        { ...books[1] },
      ]),
      listFolders: vi.fn().mockResolvedValue([folderA]),
    })))
    renderLibrary()
    await userEvent.click(await screen.findByRole('button', { name: /carpeta novelas/i }))
    expect(await screen.findByTestId('book-card-b1')).toBeInTheDocument()
    expect(screen.queryByTestId('book-card-b2')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /volver/i })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /volver/i }))
    expect(await screen.findByTestId('book-card-b2')).toBeInTheDocument()
    expect(screen.queryByTestId('book-card-b1')).not.toBeInTheDocument()
  })

  it('el menú del libro mueve a una carpeta (relevo del drag & drop)', async () => {
    const setBookFolder = vi.fn().mockResolvedValue(undefined)
    apiSpies.push(...Object.values(mockApi({
      listBooks: vi.fn().mockResolvedValue([books[0]]),
      listFolders: vi.fn().mockResolvedValue([folderA]),
      setBookFolder,
    })))
    renderLibrary()
    const card = await screen.findByTestId(`book-card-${books[0].id}`)
    await userEvent.click(within(card).getByRole('button', { name: /opciones de/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: /mover a novelas/i }))
    expect(setBookFolder).toHaveBeenCalledWith(books[0].id, 'f1')
  })

  it('el menú del libro en carpeta ofrece sacar de la carpeta (folder_id null)', async () => {
    const setBookFolder = vi.fn().mockResolvedValue(undefined)
    apiSpies.push(...Object.values(mockApi({
      listBooks: vi.fn().mockResolvedValue([{ ...books[0], folder_id: 'f1' }]),
      listFolders: vi.fn().mockResolvedValue([folderA]),
      setBookFolder,
    })))
    renderLibrary()
    const card = await screen.findByTestId(`book-card-${books[0].id}`)
    await userEvent.click(within(card).getByRole('button', { name: /opciones de/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: /sacar de la carpeta/i }))
    expect(setBookFolder).toHaveBeenCalledWith(books[0].id, null)
  })

  it('si el PATCH de mover falla muestra role="alert" y recarga', async () => {
    const setBookFolder = vi.fn().mockRejectedValue(new Error('Carpeta no encontrada'))
    apiSpies.push(...Object.values(mockApi({
      listBooks: vi.fn().mockResolvedValue([books[0]]),
      listFolders: vi.fn().mockResolvedValue([folderA]),
      setBookFolder,
    })))
    renderLibrary()
    const card = await screen.findByTestId(`book-card-${books[0].id}`)
    await userEvent.click(within(card).getByRole('button', { name: /opciones de/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: /mover a novelas/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/no se pudo mover el libro/i)
  })

  it('estado vacío de carpeta', async () => {
    apiSpies.push(...Object.values(mockApi({
      listBooks: vi.fn().mockResolvedValue([]),
      listFolders: vi.fn().mockResolvedValue([folderA]),
    })))
    renderLibrary()
    await userEvent.click(await screen.findByRole('button', { name: /carpeta novelas/i }))
    expect(await screen.findByText(/no hay libros en esta carpeta/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run src/test/Library.test.tsx`
Expected: FAIL — «Unable to find role="button" ... carpeta novelas» (no hay folder row).

- [ ] **Step 3: Implementar en `Library.tsx`**

Cambios (mantener todo lo existente; solo se agrega):

1. Imports y tipos: importar `type Folder` de `../api` y definir arriba:

```typescript
const SWATCH_COLORS = ['#ef4444', '#f59e0b', '#3b82f6', '#22c55e', '#a855f7', '#ec4899', '#14b8a6', '#6b7280'] as const
```

2. `ConfirmMenu` (menú del libro): agregar props `folders: Folder[]` y `onMove: (folderId: string | null) => Promise<void>`, y renderizar entre «Desde el principio» y «Eliminar»:

```tsx
        <button type="button" role="menuitem" disabled={busy} onClick={() => act(() => onMove(null))}>Sin carpeta</button>
        {folders.map(f => (
          <button type="button" key={f.id} role="menuitem" disabled={busy}
            onClick={() => act(() => onMove(f.id))}>Mover a {f.name}</button>
        ))}
        {book.folder_id && (
          <button type="button" role="menuitem" disabled={busy} onClick={() => act(() => onMove(null))}>Sacar de la carpeta</button>
        )}
```

Nota: «Sin carpeta» y «Sacar de la carpeta» hacen lo mismo; duplicarlos es ruido — renderizar solo uno:

```tsx
        {folders.map(f => (
          <button type="button" key={f.id} role="menuitem" disabled={busy}
            onClick={() => act(() => onMove(f.id))}>Mover a {f.name}</button>
        ))}
        {book.folder_id && (
          <button type="button" role="menuitem" className="danger" disabled={busy}
            onClick={() => act(() => onMove(null))}>Sacar de la carpeta</button>
        )}
```

(El test espera el texto «Mover a Novelas» y «Sacar de la carpeta»; no agregar «Sin carpeta».)

3. `BookCard`: recibir `folders`, `onMove` y `onDragStart` (Task 8 lo usa; por ahora `draggable={false}` y prop opcional). Pasar `folders={folders} onMove={onMove}` a `ConfirmMenu`.

4. `FolderCard` nuevo componente:

```tsx
function FolderCard({ folder, active, onOpen, onEdit, onDelete, onDropBook }: {
  folder: Folder
  active: boolean
  onOpen: () => void
  onEdit: () => void
  onDelete: () => Promise<void>
  onDropBook?: (bookId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [{ dragging, over }, setDrag] = useState({ dragging: false, over: false })
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) { setOpen(false); setArmed(false) } }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setArmed(false) } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const close = () => { setOpen(false); setArmed(false) }
  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    try { await fn(); close() } finally { setBusy(false) }
  }
  // drag & drop (Task 8 lo activa pasando onDropBook; sin él la tarjeta no es zona de drop)
  const dropProps = onDropBook ? {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setDrag({ dragging: true, over: true }) },
    onDragLeave: () => setDrag({ dragging: false, over: false }),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault(); setDrag({ dragging: false, over: false })
      const id = e.dataTransfer?.getData('text/book-id') || e.dataTransfer?.getData('text/plain')
      if (id) onDropBook(id)
    },
  } : {}

  return (
    <div className={`folder-card ${active ? 'active' : ''} ${dragging && over ? 'drag-over' : ''}`} data-testid={`folder-card-${folder.id}`}
      style={{ '--folder-color': folder.color } as React.CSSProperties} {...dropProps}>
      <button type="button" className="folder-open" onClick={onOpen} aria-label={`Carpeta ${folder.name}`}>
        <span className="folder-swatch" aria-hidden="true" />
        <span className="folder-name">{folder.name}</span>
        <span className="folder-count">{folder.book_count}</span>
      </button>
      <div className="menu-wrap" ref={ref}>
        <button type="button" className="menu-btn" aria-label={`Opciones de la carpeta ${folder.name}`}
          aria-haspopup="menu" aria-expanded={open}
          onClick={() => { setOpen(o => !o); setArmed(false) }}>⋯</button>
        {open && (
          <div className="menu" role="menu" aria-label={`Acciones de la carpeta ${folder.name}`}>
            <button type="button" role="menuitem" disabled={busy} onClick={() => act(async () => { onEdit(); close() })}>Editar</button>
            <button type="button" role="menuitem" className="danger" disabled={busy}
              onClick={() => armed ? act(onDelete) : setArmed(true)}>
              {armed ? 'Confirmar eliminación' : 'Eliminar'}
            </button>
            {armed && <button type="button" role="menuitem" disabled={busy} onClick={() => setArmed(false)}>Cancelar</button>}
          </div>
        )}
      </div>
    </div>
  )
}
```

(El contador va siempre en la tarjeta; `onDropBook` solo activa la zona de drop.)

5. Estado y carga en `Library`:

```typescript
  const [folders, setFolders] = useState<Folder[]>([])
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null)
  const load = useCallback(async () => {
    try {
      const [bs, fs] = await Promise.all([api.listBooks(), api.listFolders()])
      setBooks(bs)
      setFolders(fs)
      setError(null)
    } catch (err) { /* igual que hoy */ }
  }, [])
```

`moveBook` (lo usan menú, Task 8) y el filtrado:

```typescript
  const moveBook = useCallback(async (bookId: string, folderId: string | null) => {
    setNotice(null)
    try {
      await api.setBookFolder(bookId, folderId)
      await load()
    } catch (err) {
      setNotice(`No se pudo mover el libro: ${errorMessage(err)}`)
      await load()
    }
  }, [load])

  const activeFolder = folders.find(f => f.id === activeFolderId) ?? null
  const visible = useMemo(() => {
    const inFolder = activeFolderId == null ? books.filter(b => !b.folder_id) : books.filter(b => b.folder_id === activeFolderId)
    const q = query.trim().toLowerCase()
    const filtered = q
      ? inFolder.filter(b => b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q))
      : inFolder
    return order === 'titulo' ? [...filtered].sort((a, b) => a.title.localeCompare(b.title, 'es')) : filtered
  }, [books, query, order, activeFolderId])
```

6. Render: fila de carpetas entre el encabezado y «seguir leyendo», más el encabezado de vista de carpeta:

```tsx
      <section className="folder-row-wrap" data-testid="folder-row" aria-label="Carpetas">
        <div className="folder-row">
          <button type="button" className={`folder-card all ${activeFolderId == null ? 'active' : ''}`}
            data-testid="folder-card-all"
            onClick={() => setActiveFolderId(null)}
            onDragOver={e => e.preventDefault()} onDrop={e => {
              e.preventDefault()
              const id = e.dataTransfer?.getData('text/book-id') || e.dataTransfer?.getData('text/plain')
              if (id) void moveBook(id, null)
            }}>
            Todos
          </button>
          {folders.map(f => (
            <FolderCard key={f.id} folder={f} active={f.id === activeFolderId}
              onOpen={() => setActiveFolderId(f.id)}
              onEdit={() => { /* Task 7: abre FolderDialog */ }}
              onDelete={async () => {
                setNotice(null)
                try { await api.deleteFolder(f.id); if (activeFolderId === f.id) setActiveFolderId(null); await load() }
                catch (err) { setNotice(`No se pudo eliminar la carpeta: ${errorMessage(err)}`) }
              }} />
          ))}
          <button type="button" className="folder-card new" data-testid="new-folder"
            onClick={() => { /* Task 7: abre FolderDialog en modo crear */ }}>+ Nueva carpeta</button>
        </div>
      </section>

      {activeFolder && (
        <div className="folder-view-head">
          <span className="folder-swatch" style={{ '--folder-color': activeFolder.color } as React.CSSProperties} aria-hidden="true" />
          <h2>{activeFolder.name}</h2>
          <button type="button" className="btn" onClick={() => setActiveFolderId(null)}>Volver a todos</button>
        </div>
      )}
```

Y el empty state de carpeta: en el bloque `visible.length === 0`, cuando `activeFolderId != null` usar el texto «Todavía no hay libros en esta carpeta» (debe matchear `/no hay libros en esta carpeta/i`) manteniendo el texto actual para la biblioteca vacía:

```tsx
        ? (
          <div className="empty-state">
            <h2>{activeFolder ? 'Todavía no hay libros en esta carpeta' : 'Todavía no tenés libros'}</h2>
            <p>Arrastrá un libro hasta la carpeta o usá el menú del libro para moverlo acá.</p>
          </div>
        )
```

7. Pasar `folders` y `moveBook` a cada `BookCard`.

- [ ] **Step 4: Estilos mínimos en `theme.css`** (append, antes del bloque responsive existente):

```css
.folder-row-wrap { margin-bottom: 20px; }
.folder-row { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 6px; }
.folder-card {
  display: inline-flex; align-items: center; gap: 8px; flex: none;
  padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px;
  background: var(--paper); color: var(--ink); font-size: .85rem; cursor: pointer;
}
.folder-card.active { border-color: var(--accent); }
.folder-card.drag-over { outline: 2px dashed var(--folder-color, var(--accent)); outline-offset: 2px; }
.folder-open { display: inline-flex; align-items: center; gap: 8px; background: none; border: 0; color: inherit; cursor: pointer; font: inherit; padding: 0; }
.folder-swatch { width: 14px; height: 14px; border-radius: 4px; background: var(--folder-color, var(--line)); flex: none; }
.folder-count { font-size: .72rem; color: var(--ink-soft); }
.folder-view-head { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
.folder-view-head h2 { margin: 0; font-size: 1.15rem; font-weight: 400; }
.book-card[draggable='true'] { cursor: grab; }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run src/test/Library.test.tsx`
Expected: PASS (con las ediciones marcadas en el código: el contador simple y el menú sin «Sin carpeta»).

- [ ] **Step 6: Verificar suite web completa** — Run: `cd apps/web && npx vitest run` — PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/Library.tsx apps/web/src/theme.css apps/web/src/test/Library.test.tsx
git commit -m "feat(web): fila de carpetas, vista por carpeta y menú mover/sacar libros"
```

---

### Task 7: `FolderDialog` — crear y editar (nombre + color con selector dinámico y sugerencias)

**Files:**
- Create: `apps/web/src/pages/FolderDialog.tsx`
- Modify: `apps/web/src/pages/Library.tsx` (conectar crear/editar a los no-op de Task 6)
- Modify: `apps/web/src/theme.css`
- Test: `apps/web/src/test/FolderDialog.test.tsx` (nuevo); `apps/web/src/test/Library.test.tsx` (+integración)

**Interfaces:**
- Consumes: `api.createFolder/updateFolder`, `Folder`, `SWATCH_COLORS` de Task 6.
- Produces: componente `FolderDialog({ folder: Folder | null; onClose(): void; onSaved(folder: Folder): void })` — `folder === null` crea; con `folder` edita. Exporta default. `Library` guarda `editing: { kind: 'new' } | { kind: 'edit'; folder: Folder } | null`.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/test/FolderDialog.test.tsx`:

```typescript
// apps/web/src/test/FolderDialog.test.tsx — crear/editar carpeta: nombre + color (Task 7).
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { api, type Folder } from '../api'
import { mockApi } from './mocks'
import FolderDialog from '../pages/FolderDialog'

const folder: Folder = { id: 'f1', name: 'Novelas', color: '#ef4444', book_count: 0, created_at: '2026-09-28T00:00:00Z' }
let spies: ReturnType<typeof vi.spyOn>[]
afterEach(() => { for (const s of spies) s.mockRestore() })

describe('FolderDialog — crear', () => {
  it('llama a createFolder con el nombre y color elegidos y llama onSaved', async () => {
    const createFolder = vi.fn().mockResolvedValue({ ...folder, id: 'f9', name: 'Nueva', color: '#3b82f6' })
    spies = Object.values(mockApi({ createFolder }))
    // jsdom no soporta input[type=color]: simularlo con setter directo del value
    render(<FolderDialog folder={null} onClose={() => {}} onSaved={() => {}} />)
    await userEvent.type(screen.getByLabelText('Nombre'), 'Nueva')
    const colorInput = screen.getByLabelText('Color') as HTMLInputElement
    await userEvent.click(screen.getByRole('button', { name: /azul/i })) // bolita de sugerencia
    expect(colorInput.value).toBe('#3b82f6')
    await userEvent.click(screen.getByRole('button', { name: /crear carpeta/i }))
    expect(createFolder).toHaveBeenCalledWith('Nueva', '#3b82f6')
  })

  it('cancelar llama a onClose sin crear', async () => {
    spies = Object.values(mockApi({}))
    const onClose = vi.fn()
    render(<FolderDialog folder={null} onClose={onClose} onSaved={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /cancelar/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('FolderDialog — editar', () => {
  it('precarga nombre y color y llama a updateFolder con los cambios', async () => {
    const updateFolder = vi.fn().mockResolvedValue({ ...folder, name: 'Novelas viejas', color: '#22c55e' })
    spies = Object.values(mockApi({ updateFolder }))
    render(<FolderDialog folder={folder} onClose={() => {}} onSaved={() => {}} />)
    const name = screen.getByLabelText('Nombre') as HTMLInputElement
    expect(name.value).toBe('Novelas')
    await userEvent.clear(name)
    await userEvent.type(name, 'Novelas viejas')
    await userEvent.click(screen.getByRole('button', { name: /verde/i }))
    await userEvent.click(screen.getByRole('button', { name: /guardar/i }))
    expect(updateFolder).toHaveBeenCalledWith('f1', { name: 'Novelas viejas', color: '#22c55e' })
  })

  it('error de la API se muestra con role="alert" y el diálogo queda abierto', async () => {
    spies = Object.values(mockApi({ updateFolder: vi.fn().mockRejectedValue(new Error('El nombre debe tener entre 1 y 60 caracteres')) }))
    render(<FolderDialog folder={folder} onClose={() => {}} onSaved={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /guardar/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/entre 1 y 60/i)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
```

(El caso del mock ya se rechaza con la validación de la API — la vista solo muestra `err.message`.)

Integración en `Library.test.tsx` — agregar a los describes de Task 6:

```typescript
  it('crear carpeta desde «+ Nueva carpeta»', async () => {
    const createFolder = vi.fn().mockResolvedValue({ ...folderA, id: 'f9', name: 'Género' })
    apiSpies.push(...Object.values(mockApi({
      listBooks: vi.fn().mockResolvedValue([]),
      listFolders: vi.fn().mockResolvedValue([folderA]),
      createFolder,
    })))
    renderLibrary()
    await userEvent.click(await screen.findByTestId('new-folder'))
    await userEvent.type(screen.getByLabelText('Nombre'), 'Género')
    await userEvent.click(screen.getByRole('button', { name: /crear carpeta/i }))
    expect(createFolder).toHaveBeenCalledWith('Género', expect.any(String))
    await screen.findByText('Género') // el diálogo se cerró; la recarga muestra la carpeta existente
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('editar carpeta desde su menú precarga los valores', async () => {
    const updateFolder = vi.fn().mockResolvedValue({ ...folderA, name: 'Novelas rojas' })
    apiSpies.push(...Object.values(mockApi({
      listBooks: vi.fn().mockResolvedValue([]),
      listFolders: vi.fn().mockResolvedValue([folderA]),
      updateFolder,
    })))
    renderLibrary()
    const card = await screen.findByTestId('folder-card-f1')
    await userEvent.click(within(card).getByRole('button', { name: /opciones de la carpeta/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: /editar/i }))
    await userEvent.clear(screen.getByLabelText('Nombre'))
    await userEvent.type(screen.getByLabelText('Nombre'), 'Novelas rojas')
    await userEvent.click(screen.getByRole('button', { name: /guardar/i }))
    expect(updateFolder).toHaveBeenCalledWith('f1', { name: 'Novelas rojas', color: '#ef4444' })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run src/test/FolderDialog.test.tsx`
Expected: FAIL — «Cannot find module ../pages/FolderDialog».

- [ ] **Step 3: Implementar `FolderDialog.tsx`**

```tsx
// apps/web/src/pages/FolderDialog.tsx — crear/editar carpeta: nombre + color (Task 7).
import { useState } from 'react'
import { api, type Folder } from '../api'
import { SWATCH_COLORS, SWATCH_NAMES } from './Library'

export default function FolderDialog({ folder, onClose, onSaved }: {
  folder: Folder | null
  onClose: () => void
  onSaved: (f: Folder) => void
}) {
  const [name, setName] = useState(folder?.name ?? '')
  const [color, setColor] = useState(folder?.color ?? SWATCH_COLORS[2]) // azul de partida
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true); setError(null)
    try {
      const saved = folder
        ? await api.updateFolder(folder.id, { name: name.trim(), color })
        : await api.createFolder(name.trim(), color)
      onSaved(saved)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }

  return (
    <div className="folder-dialog-backdrop" role="presentation"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div role="dialog" aria-modal="true" aria-label={folder ? `Editar carpeta ${folder.name}` : 'Nueva carpeta'}
        className="folder-dialog" onKeyDown={e => { if (e.key === 'Escape') onClose() }}>
        <h2>{folder ? 'Editar carpeta' : 'Nueva carpeta'}</h2>
        {error && <p role="alert" className="lib-alert">{error}</p>}
        <section className="auth-field">
          <label htmlFor="folder-name">Nombre</label>
          <input id="folder-name" type="text" value={name} maxLength={60} autoFocus
            onChange={e => setName(e.target.value)} placeholder="Nombre de la carpeta" />
        </section>
        <section className="auth-field">
          <label htmlFor="folder-color">Color</label>
          <div className="color-row">
            <input id="folder-color" type="color" value={color}
              aria-label="Color"
              onChange={e => setColor(e.target.value)} />
            <span className="folder-swatch" data-testid="color-preview"
              style={{ '--folder-color': color } as React.CSSProperties} aria-hidden="true" />
            <code data-testid="color-hex">{color}</code>
          </div>
          <div className="swatch-row">
            {SWATCH_COLORS.map(c => (
              <button type="button" key={c} className="swatch" aria-label={SWATCH_NAMES[c] ?? c}
                style={{ background: c }} aria-pressed={color === c}
                onClick={() => setColor(c)} />
            ))}
          </div>
        </section>
        <div className="folder-dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="button" className="btn btn-primary" disabled={busy || name.trim().length === 0}
            onClick={() => void save()}>
            {folder ? 'Guardar' : 'Crear carpeta'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

Nombres accesibles de las bolitas (map de la especificación de sugerencias) — definir en Library.tsx junto al array y exportarlo:

```typescript
export const SWATCH_COLORS = ['#ef4444', '#f59e0b', '#3b82f6', '#22c55e', '#a855f7', '#ec4899', '#14b8a6', '#6b7280'] as const
export const SWATCH_NAMES: Record<string, string> = {
  '#ef4444': 'rojo', '#f59e0b': 'ámbar', '#3b82f6': 'azul', '#22c55e': 'verde',
  '#a855f7': 'violeta', '#ec4899': 'rosa', '#14b8a6': 'turquesa', '#6b7280': 'gris',
}
```

(En Task 6 el array se definió como constante local sin nombres: reemplazarlo por esta versión con `export` y moverlo a tope del archivo.)

Nota para el executor: `<input type="color">` en jsdom no abre diálogo ni dispara `change`, pero el componente nunca lee el DOM para el color — usa el estado `color`, que las bolitas y `userEvent.type` sobre `aria-label="Color"` no pueden setear; POR ESO el flujo de tests pasa por las bolitas. El input nativo sigue siendo el selector dinámico con RGB en el navegador real.

- [ ] **Step 4: Conectar en `Library.tsx`**

```tsx
import FolderDialog from './FolderDialog'
// estado:
  const [editing, setEditing] = useState<{ kind: 'new' } | { kind: 'edit'; folder: Folder } | null>(null)
// conectores de Task 6:
  onClick={() => setEditing({ kind: 'new' })}          // botón + Nueva carpeta
  onEdit={() => setEditing({ kind: 'edit', folder: f })} // FolderCard
// al final del JSX, sobre <AddBookControl />:
      {editing && (
        <FolderDialog folder={editing.kind === 'edit' ? editing.folder : null}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load() }} />
      )}
```

- [ ] **Step 5: Estilos en `theme.css`** (append):

```css
.folder-dialog-backdrop { position: fixed; inset: 0; background: rgb(0 0 0 / .45); display: flex; align-items: center; justify-content: center; padding: 16px; z-index: 30; }
.folder-dialog { background: var(--paper-raised); border: 1px solid var(--line); border-radius: 10px; padding: 20px; width: min(380px, 100%); display: flex; flex-direction: column; gap: 12px; }
.folder-dialog h2 { margin: 0; font-size: 1.2rem; font-weight: 400; }
.color-row { display: flex; align-items: center; gap: 10px; }
.color-row input[type='color'] { width: 44px; height: 32px; padding: 0; border: 1px solid var(--line); border-radius: 6px; background: none; cursor: pointer; }
.swatch-row { display: flex; gap: 8px; margin-top: 6px; }
.swatch { width: 22px; height: 22px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; }
.swatch[aria-pressed='true'] { border-color: var(--ink); }
.folder-dialog-actions { display: flex; justify-content: flex-end; gap: 10px; }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run src/test/FolderDialog.test.tsx src/test/Library.test.tsx`
Expected: PASS.

- [ ] **Step 7: Suite completa** — Run: `cd apps/web && npx vitest run` — PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/pages/FolderDialog.tsx apps/web/src/pages/Library.tsx apps/web/src/theme.css apps/web/src/test/FolderDialog.test.tsx apps/web/src/test/Library.test.tsx
git commit -m "feat(web): diálogo de carpeta crear/editar con selector de color dinámico y sugerencias"
```

---

### Task 8: Drag & drop — mover libros a carpetas y sacar a «Todos»

**Files:**
- Modify: `apps/web/src/pages/Library.tsx`
- Modify: `apps/web/src/theme.css`
- Test: `apps/web/src/test/Library.test.tsx` (agregar describe)

**Interfaces:**
- Consumes: `moveBook` y `activeFolderId` de Task 6; `FolderCard` con `onDropBook` ya definido (Task 6 lo dejaba opcional); `dataTransfer` con clave `text/book-id` (fallback `text/plain`).
- Produces: `BookCard draggable` con `onDragStart` que hace `e.dataTransfer.setData('text/book-id', book.id)` (y `setData('text/plain', book.id)` de relevo); drop en `FolderCard` (mover a esa carpeta, incluida desde la vista de carpeta actual) y en la tarjeta «Todos» (sacar). Nada cambia en el lector.

- [ ] **Step 1: Write the failing tests**

Agregar a `apps/web/src/test/Library.test.tsx` (fireEvent permite simular dataTransfer, que userEvent no setea):

```typescript
import { render, screen, within, fireEvent } from '@testing-library/react'

describe('Library — drag & drop', () => {
  function dropOn(folderCard: HTMLElement) {
    return fireEvent.drop(folderCard, {
      dataTransfer: {
        getData: (type: string) => (type === 'text/book-id' ? 'b1' : ''),
        setData: () => {},
      },
    })
  }

  it('soltar un libro sobre una carpeta lo mueve (PATCH con folder_id de la carpeta)', async () => {
    const setBookFolder = vi.fn().mockResolvedValue(undefined)
    apiSpies.push(...Object.values(mockApi({
      listBooks: vi.fn().mockResolvedValue([books[0]]),
      listFolders: vi.fn().mockResolvedValue([folderA]),
      setBookFolder,
    })))
    renderLibrary()
    const card = await screen.findByTestId('folder-card-f1')
    expect(dropOn(card)).toBe(true)
    expect(setBookFolder).toHaveBeenCalledWith('b1', 'f1')
  })

  it('soltar sobre la tarjeta Todos saca el libro de la carpeta (folder_id null)', async () => {
    const setBookFolder = vi.fn().mockResolvedValue(undefined)
    apiSpies.push(...Object.values(mockApi({
      listBooks: vi.fn().mockResolvedValue([{ ...books[0], folder_id: 'f1' }]),
      listFolders: vi.fn().mockResolvedValue([folderA]),
      setBookFolder,
    })))
    renderLibrary()
    const all = await screen.findByTestId('folder-card-all')
    expect(dropOn(all)).toBe(true)
    expect(setBookFolder).toHaveBeenCalledWith('b1', null)
  })

  it('dragstart del libro guarda el id en text/book-id', async () => {
    apiSpies.push(...Object.values(mockApi({
      listBooks: vi.fn().mockResolvedValue([books[0]]),
      listFolders: vi.fn().mockResolvedValue([folderA]),
    })))
    renderLibrary()
    const card = await screen.findByTestId(`book-card-${books[0].id}`)
    const setData = vi.fn()
    fireEvent.dragStart(card, { dataTransfer: { setData } }) // draggable en el article (label «Abrir {title}» está en un hijo)
    expect(setData).toHaveBeenCalledWith('text/book-id', 'b1')
    expect(setData).toHaveBeenCalledWith('text/plain', 'b1')
  })

  it('resalta la carpeta como zona válida durante dragover', async () => {
    apiSpies.push(...Object.values(mockApi({
      listBooks: vi.fn().mockResolvedValue([books[0]]),
      listFolders: vi.fn().mockResolvedValue([folderA]),
    })))
    renderLibrary()
    const card = await screen.findByTestId('folder-card-f1')
    expect(card.className).not.toContain('drag-over')
    fireEvent.dragOver(card, {
      dataTransfer: { getData: () => 'b1', setData: () => {} },
    })
    expect(card.className).toContain('drag-over')
  })

  it('drop sin id no llama a la API', async () => {
    const setBookFolder = vi.fn().mockResolvedValue(undefined)
    apiSpies.push(...Object.values(mockApi({
      listBooks: vi.fn().mockResolvedValue([books[0]]),
      listFolders: vi.fn().mockResolvedValue([folderA]),
      setBookFolder,
    })))
    renderLibrary()
    const card = await screen.findByTestId('folder-card-f1')
    fireEvent.drop(card, { dataTransfer: { getData: () => '', setData: () => {} } })
    expect(setBookFolder).not.toHaveBeenCalled()
  })
})
```

(`draggable` y `onDragStart` viven en el `article.book-card` completo, así que el drag arranca desde cualquier parte de la tarjeta, incluida la portada; en jsdom se dispara con `fireEvent.dragStart` sobre el `article`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run src/test/Library.test.tsx`
Expected: FAIL — no hay `text/book-id` en dragstart (setData no se llama) ni drop conectado (dropOn devuelve sin PATCH).

- [ ] **Step 3: Implementar en `Library.tsx`**

1. `BookCard`: en `article`, agregar:

```tsx
    <article className="book-card" data-testid={`book-card-${book.id}`}
      draggable
      onDragStart={e => {
        e.dataTransfer.setData('text/book-id', book.id)
        e.dataTransfer.setData('text/plain', book.id)
        e.dataTransfer.effectAllowed = 'move'
      }}>
```

2. En la fila de carpetas de `Library`: pasar `onDropBook` a cada `FolderCard`:

```tsx
            <FolderCard key={f.id} folder={f} active={f.id === activeFolderId}
              onOpen={() => setActiveFolderId(f.id)}
              onEdit={() => setEditing({ kind: 'edit', folder: f })}
              onDropBook={bookId => void moveBook(bookId, f.id)}
              onDelete={...} />
```

(La tarjeta «Todos» ya tiene su `onDrop` → `moveBook(id, null)` de Task 6. En modo búsqueda activa el drop sigue funcionando igual, fine.)

3. `FolderCard` ya implementa `dropProps` cuando `onDropBook` está presente (Task 6) — no repetir código.

- [ ] **Step 4: Run tests to verify they pass** — Run: `cd apps/web && npx vitest run src/test/Library.test.tsx` — PASS.

- [ ] **Step 5: Suite completa y build** — Run: `cd apps/web && npx vitest run && npm run build` — PASS (tsc sin errores).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/Library.tsx apps/web/src/theme.css apps/web/src/test/Library.test.tsx
git commit -m "feat(web): drag & drop de libros a carpetas y a la vista Todos"
```

---

### Task 9: Verificación final — suites completas, build y smoke manual

**Files:**
- Ninguno nuevo (verificación). Si algo falla, se corrige en el archivo correspondiente y se commitea con fix.

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: green suites + build + smoke en el navegador.

- [ ] **Step 1: Suite API completa** — Run: `cd apps/api && npx vitest run` (Postgres del compose levantada) — PASS.

- [ ] **Step 2: Suite web completa** — Run: `cd apps/web && npx vitest run` — PASS.

- [ ] **Step 3: Build** — Run: `cd apps/web && npm run build && cd ../api && npm run build` — PASS sin errores de tsc.

- [ ] **Step 4: Smoke manual con docker compose** (recomendado, el entorno ya tiene db+app):

```sh
docker compose up -d && curl -s localhost:3000/api/health   # → {"ok":true}
```

En el navegador (http://localhost:3000): crear carpeta con color del selector, mover un libro con drag & drop, abrir la carpeta, editar nombre/color, mover fuera, eliminar la carpeta y verificar que el libro sigue en la biblioteca. Nada del lector/progreso cambia.

- [ ] **Step 5: Si hubo correcciones, commit final; sino, informar y terminar.**

```bash
git add -A && git commit -m "fix: ajustes del smoke de carpetas"   # solo si corresponde
```

- [ ] **Step 6: Push del branch a origin (token temporal del usuario, ya configurado en el remote por la sesión):**

```sh
git push origin main
```

Nota: si el remote aún no tiene el credencial pedido por el usuario, preguntarle antes de push; nunca escribir el token en archivos del repo ni en el historial.
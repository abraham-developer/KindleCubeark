# KindleCubeark — Lector web estilo Kindle (especificación de diseño)

Fecha: 2026-09-27
Estado: aprobado en chat, pendiente de revisión escrita

## 1. Objetivo

Aplicación web multiusuario para leer PDF y EPUB con la experiencia visual e interacción del Kindle físico clásico: papel cálido, tipografía serif, volteo de página animado, modo noche ámbar. Cada usuario sube sus libros, ve el avance de lectura, retoma exactamente donde quedó y hace anotaciones (resaltados + notas).

## 2. Decisiones clave

| Decisión | Elección | Motivo |
|---|---|---|
| Usuarios | Multiusuario con login | Elección del usuario; aísla bibliotecas |
| Estilo | Kindle clásico e-ink (día + noche) | Elección del usuario |
| Formatos | PDF (pdf.js) + EPUB (epub.js) | Librerías más probadas; CFI confiable |
| Backend | Fastify (Node/TS) + Postgres | Robusto en Swarm, 2 servicios |
| Archivos | Disco en volumen `/data` | Simple; se sirven solo al dueño |
| Despliegue | Docker Swarm: `app` + `db` | Elección del usuario |
| Anotaciones | Resaltados + notas (sin gestor global ni export) | YAGNI |

## 3. Arquitectura

```
Navegador (SPA React, Vite, TS)
   │  cookie de sesión
   ▼
Fastify (Node/TS) ─── /api/*  REST
   │  @fastify/static ─── build del SPA + archivos de libros
   ▼
Postgres (servicio separado en Swarm)

Archivos subidos: /data/{userId}/{bookId}.{pdf|epub}
Portadas:         /data/{userId}/{bookId}.jpg
```

- **Monorepo simple**, sin workspaces: `apps/web` (SPA) y `apps/api` (Fastify), cada uno con su `package.json` y `tsconfig.json`. Raíz con `deploy/`, `README.md` y docker-compose.
- La API sirve el build de Vite en producción (un solo origen, cero CORS) y, en dev, Vite corre con proxy a la API.
- Autenticación: email + contraseña (bcrypt), sesión httpOnly de 30 días (`@fastify/secure-session` o equivalente). Sin OAuth.

## 4. Modelo de datos (Postgres 16)

```sql
users(
  id uuid PK, email text UNIQUE NOT NULL,
  password_hash text NOT NULL, created_at timestamptz DEFAULT now()
)

books(
  id uuid PK, user_id uuid FK users ON DELETE CASCADE,
  title text NOT NULL, author text NOT NULL DEFAULT '',
  format text CHECK (format IN ('pdf','epub')),
  file_path text NOT NULL,           -- ruta relativa a DATA_DIR
  cover_path text,                   -- jpg generada en upload (null = fallback)
  file_size bigint NOT NULL,
  total_pages int,                   -- PDF: páginas; EPUB: null
  added_at timestamptz DEFAULT now()
)
CREATE INDEX ON books(user_id, added_at DESC);

reading_progress(
  user_id uuid FK users, book_id uuid FK books,
  position jsonb NOT NULL,           -- ver §6
  percent numeric(5,2) NOT NULL DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, book_id)
)

annotations(
  id uuid PK, user_id uuid FK users ON DELETE CASCADE, book_id uuid FK books ON DELETE CASCADE,
  kind text CHECK (kind IN ('highlight','note')),
  position jsonb NOT NULL,           -- ver §7
  quoted_text text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  color text NOT NULL DEFAULT 'yellow',
  created_at timestamptz DEFAULT now()
)
CREATE INDEX ON annotations(book_id, created_at);
```

Reglas de aislamiento: toda query de libros/progreso/anotaciones filtra por `user_id` de la sesión; los archivos se sirven leyendo `file_path` del registro que pertenezca al usuario de la sesión. Un 404 (no un error) si no existe o no es del usuario.

## 5. API REST (todas bajo `/api`)

```
POST /auth/register        {email, password} → 201 + sesión
POST /auth/login           {email, password} → 200 + sesión
POST /auth/logout          → 204
GET  /auth/me              → 200 {id, email} | 401

GET    /books              → lista del usuario con progress resumido
POST   /books              multipart (file) → valida, extrae metadata+portada → 201
GET    /books/:id          → 200 {book, progress} | 404
DELETE /books/:id          → borra registro + archivos → 204
PATCH  /books/:id/progress {position, percent} → upsert → 200
PATCH  /books/:id/cover     multipart (image/jpeg) → guarda y actualiza cover_path → 200
DELETE /books/:id/progress → reset "empezar desde el principio" → 204

GET  /books/:id/annotations     → lista ordenada por posición de lectura
POST /books/:id/annotations     {kind, position, quoted_text?, note?, color?}
DELETE /annotations/:id         → 204 (404 si no es del usuario)
GET  /files/:userId/:bookId.ext → stream del archivo, solo al dueño
GET  /api/health                → 200 (usado por HEALTHCHECK)
```

- Validación de subida por **magic bytes**: PDF `%PDF-`, EPUB zip `PK\x03\x04` + presencia de `mimetype` con `application/epub+zip`. Límite `MAX_UPLOAD_MB` (default 100). Si falla, se rechaza sin dejar archivos huérfanos.
- Al subir, el servidor extrae título/autor/páginas/capítulos: PDF via `pdf-lib` (metadata + conteo de páginas), EPUB via metadata OPF del zip. Si la extracción falla, se guarda con título = nombre de archivo y `cover_path = null` (la UI muestra portada generada con iniciales).
- **Portadas:** la del EPUB se extrae del archivo en el servidor (bytes del zip). La del PDF se genera en el navegador (canvas de pdf.js sobre la página 1, JPEG 400 px de ancho) y se envía vía `PATCH /books/:id/cover` justo después del upload; hasta entonces la portada es el fallback de iniciales. Evita rasterizar en el servidor.

## 6. Progreso y retomar

- **PDF:** `position = { page: number }` (1-indexada). `percent = page / total_pages`.
- **EPUB:** `position = { cfi: string, percent: number, section: number }` (CFI del location actual de epub.js). `percent` es el porcentaje reportado por epub.js.
- Al abrir un libro el cliente pide `/books/:id` y, si hay progreso > 0, navega a esa posición **antes de mostrar la primera página** (sin flash de página 1).
- El cliente persiste el progreso: debounce 1,5 s tras cada cambio de página + `navigator.sendBeacon` al `pagehide`. Si falla la red, se encola en memoria y reintenta al reconectar; la lectura no se interrumpe.
- En la biblioteca cada libro muestra `percent` y, para PDF, "Pág. N de M"; el libro con `updated_at` más reciente encabeza la fila "Seguir leyendo".

## 7. Anotaciones

- **EPUB:** selección de texto → menú flotante (colores amarillo/gris/rosa/azul + "Nota"). `position = { startCfi, endCfi }`. Se renderizan con `epub.js` (`addAnnotation`/overlays) al cargar el capítulo. Las notas anclan al resaltado; tocar el resaltado abre la nota.
- **PDF:** selección sobre la textLayer de pdf.js → mismas acciones. `position = { page, rects: [{x,y,w,h}] }` con coordenadas normalizadas 0–1 sobre la página, así los resaltados se repintan igual en cualquier tamaño de ventana.
- **Nota de página** (PDF, incluidos escaneados): `position = { page }`, `kind = 'note'`, sin rects.
- **Panel "Mis anotaciones":** lista del libro en orden de lectura (por posición), cita + nota + color; tocar salta a la posición (mismo mecanismo de navegación del reader); borrar con confirmación inline. Los marcadores no aparecen en este panel (se ven en el libro). Sin export ni vista global entre libros.

## 8. UI / Reader

### Estética Kindle clásico
- Tokens: papel `#F8F1E1` aprox., tinta `#2B2A26`, acento ámbar; modo noche: fondo carbón `#111`–`#1A1A1A`, texto atenuado, acento ámbar. Serif (Georgia/Bookerly-like) en toda la app. Sombras suaves, bordes finos, sin esquinas muy redondeadas (≈8 px).
- Transiciones 150–250 ms; nada de colores saturados.

### Modo inmersivo
- Pantalla = solo el libro. Un tap en la zona central (~20% central) alterna topbar/bottombar.
- **Topbar:** ← biblioteca, título, marcador, "Aa", "Nota".
- **Bottombar:** barra fina de progreso + %, "pág. N de M" (PDF) o capítulo (EPUB). Tocarla abre slider para saltar a cualquier página/capítulo.

### Pasar página
1. Tap: ~40% izquierdo atrás / ~40% derecho adelante (zona central = menús).
2. Swipe horizontal con inercia leve.
3. Teclado: ←/→, espacio, PageUp/PageDown.
4. Animación de volteo: CSS 3D (perspective + rotateY) con sombra dinámica, ~350 ms; en modo noche, fade simple.

### Controles "Aa" y marcador
- **Aa:** tamaño de letra, fuente (serif/sans para EPUB), interlineado, modo día/noche, y en PDF modo de ajuste (página/ancho) + inversión de color en noche. En EPUB se aplican como CSS al contenido; en PDF solo controlan la vista.
- **Marcador:** cinta en esquina superior derecha que se curva hacia adentro cuando la página está marcada. Marcadores se guardan como `annotations` de kind `note` con `color: 'bookmark'` y texto vacío (evita una tabla nueva).

## 9. Errores

- Upload inválido (magic bytes) → mensaje claro, sin basura en disco.
- EPUB corrupto/DRM → "No se pudo abrir este libro" + reintentar/eliminar.
- Corte de red en lectura → sigue funcionando en memoria; progreso encolado y reintentado.
- Sesión expirada → redirect al login, indicando que la última posición quedó guardada.
- Postgres no disponible → `/api/health` falla; Swarm reinicia el contenedor.

## 10. Pruebas

- **API (vitest):** auth (registro/login/logout/401), upload con validación por magic bytes y limpieza de huérfanos, aislamiento entre usuarios (otro usuario → 404 en libro/archivo/progreso/anotación), upsert y reset de progreso, CRUD de anotaciones.
- **Web (vitest + testing-library):** retomar posición al abrir un libro con progreso, menú de anotaciones sobre selección, navegación por tap de zonas/teclado, persistencia de progreso con debounce y `pagehide`.
- **Humo con Docker (manual):** subir PDF+EPUB, leer, anotar, cerrar, reabrir y verificar retomado exacto; `docker service update --image` para validar rolling update.

## 11. Despliegue

### Dockerfile (multi-stage, nodo no-root, HEALTHCHECK)
1. `build-web`: node:20-alpine, `npm ci` + `vite build` → `/dist`.
2. `build-api`: node:20-alpine, `npm ci` + `tsc`.
3. `runtime`: node:20-alpine con build de API + `/dist` de web; `CMD node apps/api/dist/index.js`.

### deploy/swarm.yml
- `app`: imagen propia, volumen `bookdata:/data`, `MAX_UPLOAD_MB`, `SESSION_SECRET` (docker secret), memoria limitada, rolling update (`update_config`), healthcheck.
- `db`: postgres:16-alpine, volumen propio, healthcheck; red interna cifrada entre app y db.
- `docker-compose.yml` espejo para dev local con bind-mounts y hot-reload (Vite dev server + tsx watch en API).

## 12. Fuera de alcance

Export de anotaciones, vista global "Mis anotaciones" entre libros, lectura offline (PWA), conversión de formatos, DRM, envío por email tipo Send-to-Kindle, sincronización en tiempo real entre pestañas.
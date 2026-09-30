# Carpetas de colores (categorías) en la biblioteca

Spec: función nueva para organizar libros en carpetas con color, editables
(nombre y color) y con drag & drop de libros hacia adentro y hacia afuera.
Extiende `2026-09-27-kindle-reader-design.md`; no cambia nada del lector,
del progreso ni de las anotaciones.

## Decisiones tomadas (aprobadas con el usuario)

- **Un libro está en una sola carpeta o en ninguna.** Arrastrar a otra carpeta lo mueve. Columna `folder_id` nullable; no tabla intermedia.
- **Carpeta eliminada → sus libros vuelven a la biblioteca** (ningún libro se borra), con confirmación en línea.
- **Vista**: fila de tarjetas de carpeta arriba de la grilla; un clic abre la carpeta y muestra solo sus libros. La vista "Todos" muestra solo los libros sin carpeta.
- **Drag & drop**: HTML5 Drag and Drop nativo (escritorio). Relevo accesible/táctil: menú ⋯ del libro con «Mover a…» / «Sacar de la carpeta».
- **Color**: `<input type="color">` nativo (selector dinámico con RGB) + 8 bolitas de sugerencia. Se guarda hex `#rrggbb`.
- Carpetas por orden de creación; sin reordenar carpetas por arrastre (fuera de alcance).
- Multiusuario: cada usuario ve solo sus carpetas, con los mismos criterios de la API de libros (recurso ajeno/inexistente → 404).

## Modelo de datos

Migración nueva `002_folders.sql` (el migrador ya aplica archivos `NNN_*.sql`
ordenados y registrados en `_migrations`):

```sql
CREATE TABLE folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text NOT NULL CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON folders(user_id, created_at);

ALTER TABLE books ADD COLUMN folder_id uuid REFERENCES folders(id) ON DELETE SET NULL;
```

`ON DELETE SET NULL` hace que borrar la carpeta deje a los libros en la
biblioteca sin tocar sus archivos ni su progreso.

## API (apps/api)

Rutas nuevas en `apps/api/src/routes/folders.ts` (mismo patrón que
`books.ts`: `app.verifySession`, scope por `user_id`, 404 para recurso
ajeno o inexistente). `app.ts` las registra.

Validaciones (400 con `{message}` en español, como el resto):

- `name`: string recortado, no vacío, máx. 60 caracteres.
- `color`: hex `#rrggbb` (se normaliza a minúsculas antes de guardar).
- `PATCH` exige al menos uno de `name`/`color` (400 si ninguno).

| Método / ruta | Cuerpo | Respuesta | Notas |
|---|---|---|---|
| `GET /api/folders` | — | `Folder[]` con `book_count` | JOIN con `books` por `folder_id` |
| `POST /api/folders` | `{name, color}` | 201 `Folder` | |
| `PATCH /api/folders/:id` | `{name?, color?}` | `Folder` | renombrar y/o recolorar |
| `DELETE /api/folders/:id` | — | 204 | libros quedan con `folder_id = NULL` |
| `PATCH /api/books/:id/folder` | `{folder_id: string \| null}` | `Book` | mover/sacar; 404 si la carpeta no existe o es ajena |

`Folder` para el cliente: `{id, name, color, book_count, created_at}`.

`GET /api/books` ya hace `SELECT b.*`, así que `folder_id` queda incluido
sin cambios en la consulta; `toClient` lo expone (el cliente no recibe
rutas de disco, y `folder_id` no es una ruta).

## apps/web

### types y api client (`api.ts`)

- `Book` suma `folder_id: string | null`.
- `Folder = { id: string; name: string; color: string; book_count: number; created_at: string }`.
- Método nuevo: `listFolders`, `createFolder`, `updateFolder`, `deleteFolder`, `setBookFolder(id, folderId)`.

### Biblioteca (`Library.tsx`)

Estado nuevo: `folders`, `folderId` (`'<all>'` por defecto o un id de carpeta),
y recarga conjunta `Promise.all([api.listBooks(), api.listFolders()])`.

Vistas:

- **Fila de carpetas** (arriba de la grilla, bajo el encabezado): tarjetas con
  franja/borde del color de la carpeta, nombre, contador de libros, botón de
  menú (editar / eliminar con confirmación en línea) y tarjeta para crear
  («+ Nueva carpeta»). La vista "Todos" es una tarjeta más (drop zone para
  sacar libros); con búsqueda activa sigue filtrando por título/autor en la
  vista actual.
- **Vista de carpeta**: al hacer clic en una tarjeta se abren solo sus libros
  (misma grilla), con encabezado de color de la carpeta y botón «Volver a todos».
- **Drag & drop**: `BookCard` `draggable`; en `dragstart` manda el id del libro
  por `dataTransfer`. Zonas de drop: cada tarjeta de carpeta (mover) y la vista
  "Todos" (sacar). Resaltar zona válida en `dragover`. Tras el drop, PATCH y
  recarga.
- **Diálogo de carpeta** (crear/editar, componente `FolderDialog`): input de
  nombre, `<input type="color">` más 8 bolitas predefinidas, guardar/cancelar.
  La vista previa del diálogo usa el color elegido en vivo.
- **Relevo accesible**: en el menú ⋯ del libro, «Mover a…» (lista de carpetas
  del usuario, más «Sin carpeta») y «Sacar de la carpeta» cuando el libro está
  en una. Errores → aviso `role="alert"` igual que el resto de la página.

`BookCard` recibe props extra mínimas (`draggable/menú mover`); el lector
(`/reader/:id`) no cambia.

### Estilos (`theme.css`)

Clases nuevas: `.folder-row`, `.folder-card` (franja de color vía variable CSS
inline `--folder-color`), estados `drag-over` y `.folder-dialog`. Reusa
variables/mensajes existentes; funciona a ancho de teléfono (la fila scrollea
horizontal si no caben).

## Manejo de errores

- Mismos códigos que books.ts: 400 validación, 404 ajeno/inexistente, 401 sesión.
- Carpeta eliminada mientras se arrastra un libro hacia ella → el PATCH responde
  404 y la UI muestra aviso y recarga (la lista de carpetas quedó vieja).
- Renombrar a texto vacío o color mal formado → 400 con mensaje claro.

## Pruebas

apps/api (vitest, Postgres real del compose):

1. `POST` crea y normaliza color a minúsculas; 400 con nombre vacío, nombre
   > 60, color sin formato `#rrggbb`.
2. `GET` lista solo las del usuario con `book_count` correcto.
3. `PATCH` cambia nombre y/o color; 400 si no manda ninguno; 404 ajeno.
4. `DELETE` → 204, `books.folder_id` queda NULL (FK `ON DELETE SET NULL`),
   archivos y progreso intactos.
5. `PATCH /books/:id/folder`: mover, sacar con `null`, 404 si la carpeta es
   de otro usuario; el libro queda solo accesible por su dueño.

apps/web (vitest + jsdom):

6. Fila de carpetas renderiza nombre/color/contador; clic filtra la grilla.
7. Dialog: crear/renombrar/recolorar llama al endpoint de la API.
8. Menú «Mover a…» asigna carpeta; «Sacar de la carpeta» la limpia (ruta de
   relevo del HTML5 DnD, que jsdom no soporta).
9. Estado vacío de carpeta y mensajes de error con `role="alert"`.
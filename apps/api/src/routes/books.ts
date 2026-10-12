import crypto from 'node:crypto'
import path from 'node:path'
import { createReadStream } from 'node:fs'
import { stat, rm, readFile } from 'node:fs/promises'
import type { FastifyInstance } from 'fastify'
import { detectFormat } from '../lib/magic.js'
import { extractMeta } from '../lib/metadata.js'
import { saveBookFile, saveCover, removeBookFiles } from '../lib/storage.js'

interface BookRow {
  id: string
  user_id: string
  title: string
  author: string
  format: string
  file_path: string
  cover_path: string | null
  file_size: string | number
  total_pages: number | null
  added_at: string
  folder_id: string | null
  visibility: string
  // solo en la lista (JOIN con reading_progress)
  percent?: string | null
  position?: unknown
  last_read?: string | null
  // solo en la lista global (JOIN con users)
  owner_email?: string
  is_mine?: boolean
}

type ClientBook = Omit<BookRow, 'file_path' | 'cover_path'> & {
  cover_url: string | null
  file_url: string
}

// el cliente nunca recibe rutas de disco: URLs servibles vía /api/files
function toClient(row: BookRow): ClientBook {
  const { file_path: _fp, cover_path: coverPath, ...rest } = row
  return {
    ...rest,
    cover_url: coverPath ? `/api/files/${row.user_id}/${path.basename(coverPath)}` : null,
    file_url: `/api/files/${row.user_id}/${row.id}.${row.format}`,
  }
}

// MIME por la extensión REAL del archivo en disco, nunca adivinada
const FILE_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.epub': 'application/epub+zip',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
}

export default async function bookRoutes(app: FastifyInstance) {
  // PATCH /cover con cuerpo binario crudo (image/*): Fastify sin parser daría 415
  app.addContentTypeParser(/^(image\/.+|application\/octet-stream)$/i, { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body)
  })

  app.post('/api/books', { preHandler: app.verifySession }, async (req, reply) => {
    // parts() en vez de file(): además del archivo se lee el campo
    // 'visibility' (personal|global). También se acepta ?visibility=global.
    const limit = app.config.maxUploadMb * 1024 * 1024
    let visibility = (req.query as { visibility?: unknown } | undefined)?.visibility === 'global'
      ? 'global' : 'personal'
    let filename: string | undefined
    let buf: Buffer | null = null
    let truncated = false
    for await (const part of req.parts({ limits: { fileSize: limit } })) {
      if (part.type === 'file' && part.fieldname === 'file' && buf === null) {
        filename = part.filename
        const chunks: Buffer[] = []
        await new Promise<void>((resolve) => {
          part.file.on('data', (c: Buffer) => { chunks.push(c) })
          part.file.on('end', resolve)
          part.file.on('error', resolve)
        })
        // busboy marca el stream al cortar por limits.fileSize (el evento 'limit'
        // puede dispararse antes de que este handler lo escuche)
        truncated = truncated || (part.file as { truncated?: boolean }).truncated === true
        buf = Buffer.concat(chunks)
      } else if (part.type === 'field' && part.fieldname === 'visibility' && typeof part.value === 'string') {
        // valor inválido → se ignora y queda personal
        if (part.value === 'global' || part.value === 'personal') visibility = part.value
      } else if (part.type === 'file') {
        part.file.resume() // parte inesperada: drenar para no colgar busboy
      }
    }
    if (buf === null) return reply.code(400).send({ message: 'Falta el archivo' })
    if (truncated) return reply.code(400).send({ message: 'El archivo excede el tamaño máximo' })

    // validación solo por magic bytes: si falla, no se escribe nada en disco
    const format = detectFormat(buf)
    if (!format) return reply.code(400).send({ message: 'El archivo no es un PDF o EPUB válido' })

    const id = crypto.randomUUID()
    // metadatos corruptos/ilegibles → 400, sin haber escrito nada aún
    let meta
    try {
      meta = await extractMeta(format, buf)
    } catch {
      return reply.code(400).send({ message: 'El archivo está corrupto o es ilegible' })
    }
    try {
      const filePath = await saveBookFile(app.config.dataDir, req.user!.id, id, format, buf)
      const coverPath = meta.coverJpeg
        ? await saveCover(app.config.dataDir, req.user!.id, id, meta.coverJpeg)
        : null
      const { rows } = await app.query<BookRow>(
        `INSERT INTO books (id, user_id, title, author, format, file_path, cover_path, file_size, total_pages, visibility)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [id, req.user!.id, meta.title ?? filename ?? 'Sin título', meta.author ?? '', format, filePath, coverPath, buf.length, meta.pages ?? null, visibility],
      )
      return reply.code(201).send(toClient(rows[0]))
    } catch (e) {
      // si el guardado o el INSERT fallan, no dejar huérfanos en disco
      await removeBookFiles(app.config.dataDir, path.join(req.user!.id, `${id}.${format}`))
      throw e
    }
  })

  app.get('/api/books', { preHandler: app.verifySession }, async (req) => {
    const { rows } = await app.query<BookRow>(
      `SELECT b.*, p.percent, p.position, p.updated_at AS last_read
       FROM books b LEFT JOIN reading_progress p ON p.book_id = b.id AND p.user_id = b.user_id
       WHERE b.user_id = $1 ORDER BY COALESCE(p.updated_at, b.added_at) DESC`,
      [req.user!.id],
    )
    return rows.map(toClient)
  })

  // biblioteca global: libros visibility='global' de todos los usuarios,
  // con el progreso PROPIO del lector (cada quien retoma donde iba).
  // ?q= filtra por título o autor (case-insensitive).
  app.get('/api/books/global', { preHandler: app.verifySession }, async (req) => {
    const q = String((req.query as { q?: unknown } | undefined)?.q ?? '').trim().slice(0, 80)
    const like = `%${q.replace(/[\\%_]/g, m => `\\${m}`)}%`
    const { rows } = await app.query<BookRow>(
      `SELECT b.*, u.email AS owner_email, (b.user_id = $1) AS is_mine,
              p.percent, p.position, p.updated_at AS last_read
       FROM books b JOIN users u ON u.id = b.user_id
       LEFT JOIN reading_progress p ON p.book_id = b.id AND p.user_id = $1
       WHERE b.visibility = 'global' AND ($2 = '%%' OR b.title ILIKE $2 ESCAPE '\\' OR b.author ILIKE $2 ESCAPE '\\')
       ORDER BY b.added_at DESC LIMIT 100`,
      [req.user!.id, like],
    )
    return rows.map(toClient)
  })

  // lectura compartida: propio o global ajeno (el personal ajeno sigue 404)
  app.get('/api/books/:id', { preHandler: app.verifySession }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { rows } = await app.query<BookRow>(
      `SELECT b.*, (b.user_id = $2) AS is_mine FROM books b
       WHERE b.id = $1 AND (b.user_id = $2 OR b.visibility = 'global')`, [id, req.user!.id],
    )
    if (!rows.length) return reply.code(404).send({ message: 'Libro no encontrado' })
    const { rows: p } = await app.query(
      'SELECT position, percent, updated_at FROM reading_progress WHERE book_id = $1 AND user_id = $2',
      [id, req.user!.id],
    )
    return { book: toClient(rows[0]), progress: p[0] ?? null }
  })

  // adoptar un libro global: copia los bytes a mi carpeta y crea mi propio
  // registro (personal). Mi progreso, anotaciones y carpetas viven sobre mi
  // copia; el original global no se toca.
  app.post('/api/books/:id/adopt', { preHandler: app.verifySession }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { rows } = await app.query<BookRow>(
      `SELECT * FROM books WHERE id = $1 AND visibility = 'global'`, [id],
    )
    if (!rows.length) return reply.code(404).send({ message: 'Libro no encontrado' })
    const src = rows[0]
    if (src.user_id === req.user!.id) {
      return reply.code(400).send({ message: 'El libro ya está en tu biblioteca' })
    }
    let data: Buffer
    try {
      data = await readFile(path.join(app.config.dataDir, src.file_path))
    } catch {
      return reply.code(404).send({ message: 'El archivo ya no está disponible' })
    }
    let cover: Buffer | null = null
    if (src.cover_path) {
      try {
        cover = await readFile(path.join(app.config.dataDir, src.cover_path))
      } catch {
        cover = null // sin portada en disco: la copia queda con iniciales
      }
    }
    const newId = crypto.randomUUID()
    try {
      const filePath = await saveBookFile(app.config.dataDir, req.user!.id, newId, src.format, data)
      const coverPath = cover
        ? await saveCover(app.config.dataDir, req.user!.id, newId, cover)
        : null
      const { rows: created } = await app.query<BookRow>(
        `INSERT INTO books (id, user_id, title, author, format, file_path, cover_path, file_size, total_pages, visibility)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'personal') RETURNING *`,
        [newId, req.user!.id, src.title, src.author, src.format, filePath, coverPath, data.length, src.total_pages],
      )
      return reply.code(201).send(toClient(created[0]))
    } catch (e) {
      await removeBookFiles(app.config.dataDir, path.join(req.user!.id, `${newId}.${src.format}`))
      throw e
    }
  })

  // cambiar visibilidad de un libro propio (personal <-> global)
  app.patch('/api/books/:id/visibility', { preHandler: app.verifySession }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { visibility } = (req.body ?? {}) as { visibility?: unknown }
    if (visibility !== 'personal' && visibility !== 'global') {
      return reply.code(400).send({ message: 'visibility debe ser personal o global' })
    }
    const { rows } = await app.query<BookRow>(
      'UPDATE books SET visibility = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
      [visibility, id, req.user!.id],
    )
    if (!rows.length) return reply.code(404).send({ message: 'Libro no encontrado' })
    return toClient(rows[0])
  })

  app.delete('/api/books/:id', { preHandler: app.verifySession }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { rows } = await app.query<{ file_path: string }>(
      'DELETE FROM books WHERE id = $1 AND user_id = $2 RETURNING file_path', [id, req.user!.id],
    )
    if (!rows.length) return reply.code(404).send({ message: 'Libro no encontrado' })
    // borra el libro y cualquier portada (.jpg/.jpeg/.png) sin dejar huérfanos
    await removeBookFiles(app.config.dataDir, rows[0].file_path)
    return reply.code(204).send()
  })

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

  // la portada del PDF se genera en el navegador y llega justo después del upload
  // (spec §5). Acepta cuerpo raw image/* y también multipart, por magic bytes.
  app.patch('/api/books/:id/cover', { preHandler: app.verifySession }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { rows } = await app.query<BookRow>(
      'SELECT * FROM books WHERE id = $1 AND user_id = $2', [id, req.user!.id],
    )
    if (!rows.length) return reply.code(404).send({ message: 'Libro no encontrado' })
    const book = rows[0]

    let img: Buffer | null = null
    const contentType = (req.headers['content-type'] ?? '').toString()
    if (contentType.startsWith('multipart/form-data')) {
      const file = await req.file({ limits: { fileSize: app.config.maxUploadMb * 1024 * 1024 } })
      if (!file) return reply.code(400).send({ message: 'Falta la imagen' })
      const parts: Buffer[] = []
      await new Promise<void>((resolve) => {
        file.file.on('data', (c: Buffer) => { parts.push(c) })
        file.file.on('end', resolve)
        file.file.on('error', resolve)
      })
      if (file.file.truncated) return reply.code(400).send({ message: 'La imagen excede el tamaño máximo' })
      img = Buffer.concat(parts)
    } else if (Buffer.isBuffer(req.body)) {
      img = req.body
    }
    if (!img || img.length === 0) return reply.code(400).send({ message: 'Falta la imagen' })

    // validación por magic bytes: \xFF\xD8 → jpeg, \x89PNG → png
    const isJpeg = img[0] === 0xff && img[1] === 0xd8
    const isPng = img.subarray(0, 4).toString('latin1') === '\x89PNG'
    if (!isJpeg && !isPng) return reply.code(400).send({ message: 'La imagen debe ser JPEG o PNG' })

    const coverPath = await saveCover(app.config.dataDir, req.user!.id, book.id, img)
    // si la nueva portada cambia de extensión, la vieja queda huérfana en disco
    if (book.cover_path && book.cover_path !== coverPath) {
      await rm(path.join(app.config.dataDir, book.cover_path), { force: true })
    }
    const { rows: updated } = await app.query<BookRow>(
      'UPDATE books SET cover_path = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
      [coverPath, book.id, req.user!.id],
    )
    return toClient(updated[0])
  })

  // la posición se valida por formato: PDF → page int ≥ 1 ≤ total_pages (si se conoce),
  // con block/blockCount opcionales (vista por bloques); EPUB → cfi no vacía.
  function validatePosition(format: string, position: unknown, totalPages: number | null): boolean {
    const pos = position as { page?: unknown; block?: unknown; blockCount?: unknown; cfi?: unknown } | null | undefined
    if (format === 'pdf') {
      if (!(typeof pos?.page === 'number' && Number.isInteger(pos.page) && pos.page >= 1 &&
        (totalPages == null || pos.page <= totalPages))) return false
      // sin block/blockCount es la posición clásica de página completa
      if (pos.block === undefined && pos.blockCount === undefined) return true
      return typeof pos.block === 'number' && Number.isInteger(pos.block) && pos.block >= 0 &&
        typeof pos.blockCount === 'number' && Number.isInteger(pos.blockCount) && pos.blockCount >= 1 &&
        pos.block < pos.blockCount
    }
    return typeof pos?.cfi === 'string' && pos.cfi.length > 0
  }

  // PATCH lo usa el lector; POST es el alias equivalente porque
  // navigator.sendBeacon sólo puede enviar POST (beacon al cerrar la página).
  app.route({
    method: ['POST', 'PATCH'],
    url: '/api/books/:id/progress',
    preHandler: app.verifySession,
    handler: async (req, reply) => {
      const { id } = req.params as { id: string }
      const { rows } = await app.query<BookRow>(
        'SELECT * FROM books WHERE id = $1 AND (user_id = $2 OR visibility = \'global\')', [id, req.user!.id],
      )
      if (!rows.length) return reply.code(404).send({ message: 'Libro no encontrado' })
      const book = rows[0]

      const { position, percent } = (req.body ?? {}) as { position?: unknown; percent?: unknown }
      if (!validatePosition(book.format, position, book.total_pages)) {
        return reply.code(400).send({ message: 'Posición inválida' })
      }
      const pct = Math.max(0, Math.min(100, Number(percent ?? 0)))
      if (!Number.isFinite(pct)) return reply.code(400).send({ message: 'percent inválido' })

      const { rows: up } = await app.query<{ position: unknown; percent: string; updated_at: string }>(
        `INSERT INTO reading_progress (user_id, book_id, position, percent, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (user_id, book_id) DO UPDATE SET position = $3, percent = $4, updated_at = now()
         RETURNING position, percent, updated_at`,
        [req.user!.id, book.id, JSON.stringify(position), pct],
      )
      // pg devuelve numeric como string: la API expone número (lo espera apps/web)
      return { position: up[0].position, percent: Number(up[0].percent), updated_at: up[0].updated_at }
    },
  })

  app.delete('/api/books/:id/progress', { preHandler: app.verifySession }, async (req, reply) => {
    const { id } = req.params as { id: string }
    // idempotente: sin fila (ya reseteado o ajeno) es igualmente 204
    await app.query('DELETE FROM reading_progress WHERE book_id = $1 AND user_id = $2', [id, req.user!.id])
    return reply.code(204).send()
  })

  // sirve el libro o la portada del dueño, o de un libro global ajeno;
  // recurso personal ajeno o inexistente → 404 (nunca 403)
  app.get('/api/files/:userId/:file', { preHandler: app.verifySession }, async (req, reply) => {
    const { userId, file } = req.params as { userId: string; file: string }
    // sin traversal ni subrutas: ambos segmentos deben ser basenames reales
    if (userId !== path.basename(userId) || file !== path.basename(file)) {
      return reply.code(404).send({ message: 'No encontrado' })
    }
    const ext = path.extname(file).toLowerCase()
    const mime = FILE_MIME[ext]
    if (!mime) return reply.code(404).send({ message: 'No encontrado' })

    const rel = `${userId}/${file}`
    const { rows } = await app.query<{ user_id: string; visibility: string }>(
      'SELECT user_id, visibility FROM books WHERE file_path = $1 OR cover_path = $1',
      [rel],
    )
    if (!rows.length) return reply.code(404).send({ message: 'No encontrado' })
    const row = rows[0]
    if (row.user_id !== req.user!.id && row.visibility !== 'global') {
      return reply.code(404).send({ message: 'No encontrado' })
    }

    const abs = path.join(app.config.dataDir, rel)
    let size: number
    try {
      size = (await stat(abs)).size
    } catch {
      return reply.code(404).send({ message: 'No encontrado' })
    }
    reply.header('content-length', size)
    return reply.type(mime).send(createReadStream(abs))
  })
}

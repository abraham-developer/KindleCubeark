import crypto from 'node:crypto'
import path from 'node:path'
import { createReadStream } from 'node:fs'
import { stat, rm } from 'node:fs/promises'
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
  // solo en la lista (JOIN con reading_progress)
  percent?: string | null
  position?: unknown
  last_read?: string | null
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
    const file = await req.file({ limits: { fileSize: app.config.maxUploadMb * 1024 * 1024 } })
    if (!file) return reply.code(400).send({ message: 'Falta el archivo' })
    const chunks: Buffer[] = []
    await new Promise<void>((resolve) => {
      file.file.on('data', (c: Buffer) => { chunks.push(c) })
      file.file.on('end', resolve)
      file.file.on('error', resolve)
    })
    // busboy marca el stream al cortar por limits.fileSize (el evento 'limit'
    // puede dispararse antes de que este handler lo escuche)
    if (file.file.truncated) return reply.code(400).send({ message: 'El archivo excede el tamaño máximo' })
    const buf = Buffer.concat(chunks)

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
        `INSERT INTO books (id, user_id, title, author, format, file_path, cover_path, file_size, total_pages)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [id, req.user!.id, meta.title ?? file.filename ?? 'Sin título', meta.author ?? '', format, filePath, coverPath, buf.length, meta.pages ?? null],
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

  app.get('/api/books/:id', { preHandler: app.verifySession }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { rows } = await app.query<BookRow>(
      'SELECT * FROM books WHERE id = $1 AND user_id = $2', [id, req.user!.id],
    )
    if (!rows.length) return reply.code(404).send({ message: 'Libro no encontrado' })
    const { rows: p } = await app.query(
      'SELECT position, percent, updated_at FROM reading_progress WHERE book_id = $1 AND user_id = $2',
      [id, req.user!.id],
    )
    return { book: toClient(rows[0]), progress: p[0] ?? null }
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
        'SELECT * FROM books WHERE id = $1 AND user_id = $2', [id, req.user!.id],
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

  // sirve el libro o la portada del dueño; recurso ajeno o inexistente → 404 (nunca 403)
  app.get('/api/files/:userId/:file', { preHandler: app.verifySession }, async (req, reply) => {
    const { userId, file } = req.params as { userId: string; file: string }
    // sin traversal ni subrutas: el nombre debe ser un basename real
    if (userId !== req.user!.id || file !== path.basename(file)) {
      return reply.code(404).send({ message: 'No encontrado' })
    }
    const ext = path.extname(file).toLowerCase()
    const mime = FILE_MIME[ext]
    if (!mime) return reply.code(404).send({ message: 'No encontrado' })

    const rel = `${userId}/${file}`
    const { rows } = await app.query(
      'SELECT file_path, cover_path FROM books WHERE user_id = $1 AND (file_path = $2 OR cover_path = $2)',
      [req.user!.id, rel],
    )
    if (!rows.length) return reply.code(404).send({ message: 'No encontrado' })

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

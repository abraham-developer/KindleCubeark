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

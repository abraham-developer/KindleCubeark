import crypto from 'node:crypto'
import path from 'node:path'
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
}

export default async function bookRoutes(app: FastifyInstance) {
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
      return reply.code(201).send(rows[0])
    } catch (e) {
      // si el guardado o el INSERT fallan, no dejar huérfanos en disco
      await removeBookFiles(app.config.dataDir, path.join(req.user!.id, `${id}.${format}`))
      throw e
    }
  })
}
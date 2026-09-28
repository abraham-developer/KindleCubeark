import type { FastifyInstance } from 'fastify'
import { positionSortKey } from '../lib/positionSortKey.js'

const KINDS = ['highlight', 'note'] as const
// bookmark = marcador (kind note, texto vacío): lo manda el lector para "marcar página"
const COLORS = ['yellow', 'gray', 'pink', 'blue', 'bookmark'] as const

interface AnnotationRow {
  id: string
  user_id: string
  book_id: string
  kind: string
  position: unknown
  quoted_text: string
  note: string
  color: string
  created_at: string
}

// KINDS y COLORS arriba; caps de volumen para que una anotación no pueda
// inflar la fila jsonb ni la DB (un PDF real no genera más de ~100 rects/página)
const MAX_RECTS = 200
const MAX_TEXT_CHARS = 10_000

interface Rect {
  x: unknown
  y: unknown
  w: unknown
  h: unknown
}

interface CreateBody {
  kind?: unknown
  position?: unknown
  quoted_text?: unknown
  note?: unknown
  color?: unknown
}

function isUnit(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
}

// la posición se valida por formato, igual que la de progreso:
// - PDF highlight: {page int en [1, total_pages], rects: array no vacío de {x,y,w,h} en [0,1]}
// - PDF nota de página: {page int en [1, total_pages]} sin rects
// - EPUB highlight: {startCfi, endCfi} strings no vacías
// - EPUB nota: {cfi} o {startCfi} (el lector manda cfi para notas de página)
function validatePosition(
  format: string,
  kind: string,
  position: unknown,
  totalPages: number | null,
): boolean {
  const pos = (position ?? {}) as {
    page?: unknown
    rects?: unknown
    cfi?: unknown
    startCfi?: unknown
    endCfi?: unknown
  }
  if (format === 'pdf') {
    const pageOk = typeof pos.page === 'number' && Number.isInteger(pos.page) &&
      pos.page >= 1 && (totalPages == null || pos.page <= totalPages)
    if (!pageOk) return false
    if (kind === 'highlight') {
      if (!Array.isArray(pos.rects) || pos.rects.length === 0) return false
      if (pos.rects.length > MAX_RECTS) return false
      return pos.rects.every((r) => {
        const rect = (r ?? {}) as Rect
        return isUnit(rect.x) && isUnit(rect.y) && isUnit(rect.w) && isUnit(rect.h)
      })
    }
    // nota de página: solo {page}
    return pos.rects === undefined
  }
  if (kind === 'highlight') {
    return typeof pos.startCfi === 'string' && pos.startCfi.length > 0 &&
      typeof pos.endCfi === 'string' && pos.endCfi.length > 0
  }
  return (typeof pos.cfi === 'string' && pos.cfi.length > 0) ||
    (typeof pos.startCfi === 'string' && pos.startCfi.length > 0)
}

function text(value: unknown): string | null {
  if (value === undefined) return ''
  return typeof value === 'string' ? value : null
}

export default async function annotationRoutes(app: FastifyInstance) {
  // las anotaciones de un libro se traen todas y se ordenan en JS por posición
  // de lectura (el volumen por libro es pequeño): positionSortKey ya resuelve
  // páginas con ceros y CFI lexicográfico
  app.get('/api/books/:id/annotations', { preHandler: app.verifySession }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { rows: books } = await app.query<{ format: string }>(
      'SELECT format FROM books WHERE id = $1 AND user_id = $2', [id, req.user!.id],
    )
    if (!books.length) return reply.code(404).send({ message: 'Libro no encontrado' })

    // los bookmarks (color bookmark) también se devuelven: el lector los filtra
    const { rows } = await app.query<AnnotationRow>(
      'SELECT id, book_id, kind, position, quoted_text, note, color, created_at FROM annotations WHERE book_id = $1 AND user_id = $2',
      [id, req.user!.id],
    )
    // comparación por puntos de código (no localeCompare): determinista y
    // idéntica a la que hará el cliente al reutilizar positionSortKey.
    // Claves secundarias created_at y luego id: dos anotaciones en la misma
    // posición quedan siempre en el mismo orden
    const format = books[0].format
    return rows.sort((a, b) => {
      const ka = positionSortKey(a.position, format)
      const kb = positionSortKey(b.position, format)
      if (ka !== kb) return ka < kb ? -1 : 1
      const ta = new Date(a.created_at).getTime()
      const tb = new Date(b.created_at).getTime()
      if (ta !== tb) return ta < tb ? -1 : 1
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
  })

  app.post('/api/books/:id/annotations', { preHandler: app.verifySession }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { rows: books } = await app.query<{ format: string; total_pages: number | null }>(
      'SELECT format, total_pages FROM books WHERE id = $1 AND user_id = $2', [id, req.user!.id],
    )
    if (!books.length) return reply.code(404).send({ message: 'Libro no encontrado' })
    const book = books[0]

    const body = (req.body ?? {}) as CreateBody
    const kind = body.kind
    if (typeof kind !== 'string' || !KINDS.includes(kind as (typeof KINDS)[number])) {
      return reply.code(400).send({ message: 'kind inválido' })
    }
    const color = body.color === undefined ? 'yellow' : body.color
    if (typeof color !== 'string' || !COLORS.includes(color as (typeof COLORS)[number])) {
      return reply.code(400).send({ message: 'color inválido' })
    }
    if (!validatePosition(book.format, kind, body.position, book.total_pages)) {
      return reply.code(400).send({ message: 'Posición inválida' })
    }
    const quoted = text(body.quoted_text)
    const noteText = text(body.note)
    if (quoted == null || noteText == null) {
      return reply.code(400).send({ message: 'quoted_text y note deben ser texto' })
    }
    if (quoted.length > MAX_TEXT_CHARS || noteText.length > MAX_TEXT_CHARS) {
      return reply.code(400).send({ message: `quoted_text y note no pueden superar ${MAX_TEXT_CHARS} caracteres` })
    }
    // el marcador es puro: kind note, sin texto citado ni nota
    if (color === 'bookmark' && (kind !== 'note' || quoted !== '' || noteText !== '')) {
      return reply.code(400).send({ message: 'Un marcador no puede tener texto ni resaltado' })
    }

    // la posición se guarda verbatim (jsonb), igual que en reading_progress
    const { rows } = await app.query<AnnotationRow>(
      `INSERT INTO annotations (user_id, book_id, kind, position, quoted_text, note, color)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, book_id, kind, position, quoted_text, note, color, created_at`,
      [req.user!.id, id, kind, JSON.stringify(body.position), quoted, noteText, color],
    )
    return reply.code(201).send(rows[0])
  })

  // ajena o inexistente → 404 (nunca 403), igual que el resto de recursos
  app.delete('/api/annotations/:id', { preHandler: app.verifySession }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { rowCount } = await app.query(
      'DELETE FROM annotations WHERE id = $1 AND user_id = $2', [id, req.user!.id],
    )
    if (!rowCount) return reply.code(404).send({ message: 'Anotación no encontrada' })
    return reply.code(204).send()
  })
}
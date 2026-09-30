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
    if (name === undefined || color === undefined) {
      return reply.code(400).send({ message: 'El nombre y el color son obligatorios' })
    }
    const { rows } = await app.query<FolderRow>(
      `INSERT INTO folders (user_id, name, color) VALUES ($1,$2,$3)
       RETURNING *, 0::int AS book_count`,
      [req.user!.id, name, color],
    )
    return reply.code(201).send(toClient(rows[0]))
  })

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
}
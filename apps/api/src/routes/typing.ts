import type { FastifyInstance } from 'fastify'

// Modo typing (solo escritorio en el cliente): progreso reanudable palabra a
// palabra y puntuaciones históricas, siempre por (usuario, libro).
export const TYPING_LAYOUTS = ['qwerty-es', 'qwerty-us', 'azerty-fr', 'qwertz-de', 'dvorak-us'] as const
export const TYPING_LANGS = ['en', 'fr', 'de', 'zh', 'es'] as const

const MAX_WORD_INDEX = 10_000_000

interface ProgressRow {
  word_index: number
  char_index: number
  keyboard_layout: string
  target_lang: string
  bilingual: boolean
  total_words: number
  updated_at: string
}

interface ScoreRow {
  id: string
  wpm: string | number
  accuracy: string | number
  score: number
  words_completed: number
  errors: number
  duration_ms: number
  keyboard_layout: string
  target_lang: string
  bilingual: boolean
  created_at: string
}

function isIntIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

async function findBook(app: FastifyInstance, id: string, userId: string) {
  const { rows } = await app.query<{ id: string }>(
    `SELECT id FROM books WHERE id = $1 AND (user_id = $2 OR visibility = 'global')`,
    [id, userId],
  )
  return rows[0] ?? null
}

function toScore(row: ScoreRow) {
  return { ...row, wpm: Number(row.wpm), accuracy: Number(row.accuracy) }
}

export default async function typingRoutes(app: FastifyInstance) {
  app.get('/api/books/:id/typing', { preHandler: app.verifySession }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!await findBook(app, id, req.user!.id)) {
      return reply.code(404).send({ message: 'Libro no encontrado' })
    }
    const { rows: progress } = await app.query<ProgressRow>(
      `SELECT word_index, char_index, keyboard_layout, target_lang, bilingual, total_words, updated_at
       FROM typing_progress WHERE user_id = $1 AND book_id = $2`,
      [req.user!.id, id],
    )
    const { rows: scores } = await app.query<ScoreRow>(
      `SELECT id, wpm, accuracy, score, words_completed, errors, duration_ms,
              keyboard_layout, target_lang, bilingual, created_at
       FROM typing_scores WHERE user_id = $1 AND book_id = $2
       ORDER BY created_at DESC LIMIT 50`,
      [req.user!.id, id],
    )
    const list = scores.map(toScore)
    const best = list.reduce<{ wpm: number; accuracy: number; score: number } | null>((acc, s) => (
      !acc || s.score > acc.score ? { wpm: s.wpm, accuracy: s.accuracy, score: s.score } : acc
    ), null)
    return { progress: progress[0] ?? null, scores: list, best }
  })

  app.put('/api/books/:id/typing/progress', { preHandler: app.verifySession }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!await findBook(app, id, req.user!.id)) {
      return reply.code(404).send({ message: 'Libro no encontrado' })
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    const { word_index, char_index, total_words } = body
    if (!isIntIn(word_index, 0, MAX_WORD_INDEX) || !isIntIn(char_index, 0, 10_000)
      || !isIntIn(total_words, 0, MAX_WORD_INDEX)) {
      return reply.code(400).send({ message: 'Progreso de typing inválido' })
    }
    const keyboardLayout = body.keyboard_layout === undefined ? 'qwerty-es' : body.keyboard_layout
    const targetLang = body.target_lang === undefined ? 'en' : body.target_lang
    if (!(TYPING_LAYOUTS as readonly unknown[]).includes(keyboardLayout)
      || !(TYPING_LANGS as readonly unknown[]).includes(targetLang)
      || (body.bilingual !== undefined && typeof body.bilingual !== 'boolean')) {
      return reply.code(400).send({ message: 'Progreso de typing inválido' })
    }
    const { rows } = await app.query<ProgressRow>(
      `INSERT INTO typing_progress
         (user_id, book_id, word_index, char_index, keyboard_layout, target_lang, bilingual, total_words, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (user_id, book_id) DO UPDATE SET
         word_index = EXCLUDED.word_index, char_index = EXCLUDED.char_index,
         keyboard_layout = EXCLUDED.keyboard_layout, target_lang = EXCLUDED.target_lang,
         bilingual = EXCLUDED.bilingual, total_words = EXCLUDED.total_words, updated_at = now()
       RETURNING word_index, char_index, keyboard_layout, target_lang, bilingual, total_words, updated_at`,
      [req.user!.id, id, word_index, char_index, keyboardLayout, targetLang, body.bilingual === true, total_words],
    )
    return rows[0]
  })

  app.delete('/api/books/:id/typing/progress', { preHandler: app.verifySession }, async (req, reply) => {
    const { id } = req.params as { id: string }
    // Idempotente: reiniciar sin progreso previo también es 204. Las
    // puntuaciones históricas se conservan (son el historial por libro).
    await app.query('DELETE FROM typing_progress WHERE user_id = $1 AND book_id = $2', [req.user!.id, id])
    return reply.code(204).send()
  })

  app.post('/api/books/:id/typing/scores', { preHandler: app.verifySession }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!await findBook(app, id, req.user!.id)) {
      return reply.code(404).send({ message: 'Libro no encontrado' })
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    const wpm = typeof body.wpm === 'number' && Number.isFinite(body.wpm) ? body.wpm : NaN
    const accuracy = typeof body.accuracy === 'number' && Number.isFinite(body.accuracy) ? body.accuracy : NaN
    if (!(wpm >= 0 && wpm <= 400) || !(accuracy >= 0 && accuracy <= 100)
      || !isIntIn(body.score, 0, 10_000_000)
      || !isIntIn(body.words_completed, 1, 100_000)
      || !isIntIn(body.errors, 0, 10_000_000)
      || !isIntIn(body.duration_ms, 1, 86_400_000)
      || !(TYPING_LAYOUTS as readonly unknown[]).includes(body.keyboard_layout)
      || !(TYPING_LANGS as readonly unknown[]).includes(body.target_lang)
      || typeof body.bilingual !== 'boolean') {
      return reply.code(400).send({ message: 'Puntuación de typing inválida' })
    }
    const { rows } = await app.query<ScoreRow>(
      `INSERT INTO typing_scores
         (user_id, book_id, wpm, accuracy, score, words_completed, errors, duration_ms, keyboard_layout, target_lang, bilingual)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, wpm, accuracy, score, words_completed, errors, duration_ms,
                 keyboard_layout, target_lang, bilingual, created_at`,
      [req.user!.id, id, wpm, accuracy, body.score, body.words_completed, body.errors,
        body.duration_ms, body.keyboard_layout, body.target_lang, body.bilingual],
    )
    return reply.code(201).send(toScore(rows[0]))
  })
}

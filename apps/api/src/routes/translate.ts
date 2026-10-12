import type { FastifyInstance } from 'fastify'

// Idiomas destino del modo estudio bilingüe (códigos LibreTranslate/Argos).
const TARGETS = new Set(['en', 'de', 'zh', 'es'])
const MAX_CHARS = 5000

export default async function translateRoutes(app: FastifyInstance) {
  // POST /api/translate: proxy autenticado hacia LibreTranslate (motor open
  // source autohospedado, ver LIBRETRANSLATE_URL). El navegador nunca habla
  // directo con el motor: así no se expone su URL ni se salta la sesión.
  app.post('/api/translate', { preHandler: app.verifySession }, async (req, reply) => {
    const { q, target } = (req.body ?? {}) as { q?: unknown; target?: unknown }
    if (typeof q !== 'string' || q.trim().length === 0 || q.length > MAX_CHARS) {
      return reply.code(400).send({ message: 'Texto inválido' })
    }
    if (typeof target !== 'string' || !TARGETS.has(target)) {
      return reply.code(400).send({ message: 'Idioma no admitido' })
    }
    const base = app.config.translateUrl
    if (!base) {
      return reply.code(503).send({ message: 'Servicio de traducción no configurado' })
    }

    let upstream: Response
    try {
      upstream = await fetch(`${base}/translate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q, source: 'auto', target, format: 'text' }),
        signal: AbortSignal.timeout(20_000),
      })
    } catch {
      return reply.code(502).send({ message: 'No se pudo contactar el servicio de traducción' })
    }
    if (!upstream.ok) {
      return reply.code(502).send({ message: 'No se pudo traducir el texto' })
    }
    const data = (await upstream.json().catch(() => null)) as {
      translatedText?: unknown
      translated_text?: unknown
    } | null
    const text = data?.translatedText ?? data?.translated_text
    if (typeof text !== 'string' || text.length === 0) {
      return reply.code(502).send({ message: 'No se pudo traducir el texto' })
    }
    return { translated_text: text }
  })
}

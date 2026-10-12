// apps/web/src/lib/dictionary.ts — significado de una palabra por pulsación
// larga. Fuente open data: Wikcionario (sin claves, multilingüe). Primero se
// buscan glosas en español (es.wiktionary, que también cubre palabras
// extranjeras) y de respaldo en inglés (API REST de en.wiktionary).
export type DictSense = { definition: string; example?: string }
export type DictEntry = { word: string; lang: 'es' | 'en'; pos: string; senses: DictSense[] }

export class DictNotFound extends Error {
  constructor(word: string) {
    super(`Sin definición para «${word}»`)
  }
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

const ES_API = 'https://es.wiktionary.org/w/api.php'
const EN_DEF_API = 'https://en.wiktionary.org/api/rest_v1/page/definition/'
const MAX_SENSES = 3
const DEF_MAX_CHARS = 280

// Secciones con sentidos (es.wiktionary): la primera bajo el primer idioma.
const POS_RE = /sustantivo|adjetivo|verbo\b|adverbio|pronombre|preposici|conjunci|interjecci|art culo/i

/** Quita etiquetas HTML y decodifica entidades (DOM si hay, regex si no). */
export function stripHtml(html: string): string {
  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
      return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim()
    } catch {
      /* cae al regex */
    }
  }
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function trunc(text: string, max = DEF_MAX_CHARS): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

type EsSection = { index: string; level: string; line: string }

/** Índice de la primera sección con sentidos del primer idioma, si hay. */
export function pickSenseSection(sections: EsSection[]): string | null {
  let inFirstLang = false
  for (const section of sections) {
    if (section.level === '2') {
      if (inFirstLang) break // segundo idioma: no pasar de aquí
      inFirstLang = true
      continue
    }
    if (inFirstLang && POS_RE.test(stripHtml(section.line))) return section.index
  }
  return null
}

/**
 * Sentidos desde el HTML de una sección (es.wiktionary lista cada acepción
 * como <dl><dt>n glosa</dt><dd>definición…</dd></dl>, a veces con <ul> de
 * uso/sinónimos dentro del <dd> que se descarta).
 */
export function parseEsSenses(sectionHtml: string): DictSense[] {
  const senses: DictSense[] = []
  const dls = sectionHtml.match(/<dl>([\s\S]*?)<\/dl>/gi) ?? []
  for (const dl of dls) {
    if (senses.length >= MAX_SENSES) break
    const dt = dl.match(/<dt>([\s\S]*?)<\/dt>/i)?.[1] ?? ''
    const ddRaw = dl.match(/<dd>([\s\S]*?)<\/dd>/i)?.[1] ?? ''
    if (!ddRaw) continue
    const dd = ddRaw.replace(/<ul>[\s\S]*?<\/ul>/gi, '')
    const definition = stripHtml(dd)
    if (!definition) continue
    const gloss = stripHtml(dt).replace(/^\d+\s*/, '')
    senses.push({ definition: trunc(gloss ? `${gloss}: ${definition}` : definition) })
  }
  return senses
}

type EnDefBlock = {
  partOfSpeech?: string
  definitions?: Array<{ definition?: string; examples?: string[] }>
}

/** Sentidos desde la API REST de definiciones (en.wiktionary). */
export function parseEnSenses(payload: unknown): { pos: string; senses: DictSense[] } | null {
  if (!payload || typeof payload !== 'object') return null
  const blocks = Object.values(payload as Record<string, EnDefBlock[]>).find(
    list => Array.isArray(list) && list.length > 0,
  )
  const entry = blocks?.[0]
  if (!entry) return null
  const senses: DictSense[] = []
  for (const item of entry.definitions ?? []) {
    if (senses.length >= MAX_SENSES) break
    const definition = stripHtml(item.definition ?? '')
    if (!definition) continue
    const rawExample = item.examples?.[0]
    const example = rawExample ? stripHtml(rawExample) : ''
    senses.push(example ? { definition: trunc(definition), example: trunc(example, 160) } : { definition: trunc(definition) })
  }
  if (senses.length === 0) return null
  return { pos: stripHtml(entry.partOfSpeech ?? ''), senses }
}

/** Variantes de capitalización a probar (los títulos distinguen mayúsculas). */
function titleTries(word: string): string[] {
  const lower = word.toLowerCase()
  const capped = word.charAt(0).toUpperCase() + word.slice(1)
  return [...new Set([word, lower, capped])]
}

async function fetchJson(fetchFn: FetchFn, url: string): Promise<unknown | null> {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return null
    return (await res.json().catch(() => null)) as unknown
  } catch {
    return null
  }
}

async function lookupSpanish(word: string, fetchFn: FetchFn): Promise<DictEntry | null> {
  for (const title of titleTries(word)) {
    const sectionsPayload = (await fetchJson(
      fetchFn,
      `${ES_API}?action=parse&page=${encodeURIComponent(title)}&prop=sections&redirects=1&format=json&origin=*`,
    )) as { parse?: { sections?: EsSection[] } } | null
    const sections = sectionsPayload?.parse?.sections
    if (!sections) continue
    const index = pickSenseSection(sections)
    if (index == null) continue
    const sectionPayload = (await fetchJson(
      fetchFn,
      `${ES_API}?action=parse&page=${encodeURIComponent(title)}&section=${index}&prop=text&redirects=1&format=json&origin=*`,
    )) as { parse?: { text?: { '*': string } } } | null
    const html = sectionPayload?.parse?.text?.['*']
    if (!html) continue
    const senses = parseEsSenses(html)
    if (senses.length > 0) {
      const pos = stripHtml(sections.find(s => s.index === index)?.line ?? '')
      return { word, lang: 'es', pos, senses }
    }
  }
  return null
}

async function lookupEnglish(word: string, fetchFn: FetchFn): Promise<DictEntry | null> {
  for (const title of titleTries(word)) {
    const payload = await fetchJson(fetchFn, `${EN_DEF_API}${encodeURIComponent(title)}`)
    if (!payload) continue
    const parsed = parseEnSenses(payload)
    if (parsed) return { word, lang: 'en', ...parsed }
  }
  return null
}

// Caché en memoria por palabra (en minúsculas): re-consultar no pega a la red.
const cache = new Map<string, DictEntry>()
const CACHE_MAX = 200

export function clearDictionaryCache(): void {
  cache.clear()
  bothCache.clear()
}

/** Significado de una palabra: español primero, inglés de respaldo. */
export async function lookupWord(word: string, fetchFn: FetchFn = fetch): Promise<DictEntry> {
  const clean = word.trim()
  if (!clean) throw new DictNotFound(word)
  const key = clean.toLowerCase()
  const hit = cache.get(key)
  if (hit) return hit
  const entry = (await lookupSpanish(clean, fetchFn)) ?? (await lookupEnglish(clean, fetchFn))
  if (!entry) throw new DictNotFound(clean)
  cache.set(key, entry)
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return entry
}

const HAN_RE = /\p{Script=Han}/u
const KANA_RE = /[\p{Script=Hiragana}\p{Script=Katakana}]/u
const WORD_CHAR_RE = /[\p{L}\p{M}\p{N}'’ʼ-]/u

type WordScan = { chars: string[]; startCp: number; endCp: number; candidates: string[] }

/**
 * Escaneo interno: palabra bajo un offset (UTF-16, como el DOM) con índices
 * en puntos de código. Latinas/kana van completas; hanzi hasta 2 (con
 * reintento de 1 si el compuesto no existe). Null fuera de palabra.
 */
function scanWord(text: string, offset: number): WordScan | null {
  if (!text || offset < 0 || offset >= text.length) return null
  const chars = Array.from(text)
  let index = 0
  let acc = 0
  for (; index < chars.length; index++) {
    if (acc + chars[index].length > offset) break
    acc += chars[index].length
  }
  const current = chars[index] ?? ''
  if (HAN_RE.test(current)) {
    const run = [current]
    const next = chars[index + 1]
    if (next && HAN_RE.test(next)) run.push(next)
    const two = run.join('')
    const candidates = two.length === 2 ? [two, run[0]] : [two]
    return { chars, startCp: index, endCp: index + run.length, candidates }
  }
  if (KANA_RE.test(current)) {
    let start = index
    let end = index
    while (start > 0 && KANA_RE.test(chars[start - 1])) start--
    while (end + 1 < chars.length && KANA_RE.test(chars[end + 1])) end++
    return { chars, startCp: start, endCp: end + 1, candidates: [chars.slice(start, end + 1).join('')] }
  }
  if (!WORD_CHAR_RE.test(current)) return null
  let start = index
  let end = index
  while (start > 0 && WORD_CHAR_RE.test(chars[start - 1])) start--
  while (end + 1 < chars.length && WORD_CHAR_RE.test(chars[end + 1])) end++
  const raw = chars.slice(start, end + 1).join('')
  // recorte de apóstrofos/guiones en bordes (todos BMP: 1 unidad = 1 punto)
  const leadCut = raw.match(/^['’ʼ-]+/)?.[0].length ?? 0
  const trailCut = raw.match(/['’ʼ-]+$/)?.[0].length ?? 0
  const word = raw.slice(leadCut, raw.length - trailCut)
  if (!word) return null
  return { chars, startCp: start + leadCut, endCp: end + 1 - trailCut, candidates: [word] }
}

/** Palabra(s) candidata(s) en un offset de texto (vacío fuera de palabra). */
export function wordCandidates(text: string, offset: number): string[] {
  return scanWord(text, offset)?.candidates ?? []
}

function cpToUtf16(chars: string[], cp: number): number {
  return chars.slice(0, cp).join('').length
}

export type WordSpan = { start: number; end: number; candidates: string[] }

/** Rango UTF-16 (listo para Range/selección) del candidato más largo. */
export function wordSpan(text: string, offset: number): WordSpan | null {
  const scan = scanWord(text, offset)
  if (!scan) return null
  return {
    start: cpToUtf16(scan.chars, scan.startCp),
    end: cpToUtf16(scan.chars, scan.endCp),
    candidates: scan.candidates,
  }
}

/** Significado en un offset de texto (prueba cada candidato en orden). */
export async function lookupAt(text: string, offset: number, fetchFn: FetchFn = fetch): Promise<DictEntry> {
  const candidates = wordCandidates(text, offset)
  let lastError: unknown = new DictNotFound('')
  for (const candidate of candidates) {
    try {
      return await lookupWord(candidate, fetchFn)
    } catch (err) {
      lastError = err
    }
  }
  throw lastError
}

export type PointRange = { range: Range; text: string; offset: number; candidates: string[] }

/**
 * Rango vivo bajo un punto de la pantalla (caretRangeFromPoint con relevo
 * a caretPositionFromPoint de Firefox). Null si no hay palabra. El rango
 * sirve para marcar la palabra en azul con la selección.
 */
export function wordRangeAtPoint(x: number, y: number): PointRange | null {
  try {
    const doc = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node | null; offset: number } | null
    }
    let range = doc.caretRangeFromPoint?.(x, y) ?? null
    if (!range) {
      const pos = doc.caretPositionFromPoint?.(x, y) ?? null
      if (pos?.offsetNode?.nodeType === Node.TEXT_NODE) {
        range = document.createRange()
        range.setStart(pos.offsetNode, pos.offset)
        range.collapse(true)
      }
    }
    if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) return null
    const text = range.startContainer.textContent ?? ''
    const offset = range.startOffset
    const candidates = wordCandidates(text, offset)
    if (candidates.length === 0) return null
    return { range, text, offset, candidates }
  } catch {
    /* sin APIs de caret no hay palabra */
  }
  return null
}

export type BothEntries = { word: string; es: DictEntry | null; en: DictEntry | null }

const bothCache = new Map<string, BothEntries>()

function evictOldest(map: Map<string, unknown>): void {
  if (map.size > CACHE_MAX) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest as string)
  }
}

/** Significado en español E inglés (modo estudio bilingüe muestra ambos). */
async function lookupBoth(word: string, fetchFn: FetchFn): Promise<BothEntries> {
  const clean = word.trim()
  const key = clean.toLowerCase()
  const hit = bothCache.get(key)
  if (hit) return hit
  const [es, en] = await Promise.all([lookupSpanish(clean, fetchFn), lookupEnglish(clean, fetchFn)])
  const result = { word: clean, es, en }
  bothCache.set(key, result)
  evictOldest(bothCache)
  return result
}

/** Ambos significados en un offset (prueba cada candidato en orden). */
export async function lookupAtBoth(text: string, offset: number, fetchFn: FetchFn = fetch): Promise<BothEntries> {
  const candidates = wordCandidates(text, offset)
  let lastWord = ''
  for (const candidate of candidates) {
    const result = await lookupBoth(candidate, fetchFn)
    if (result.es || result.en) return result
    lastWord = result.word
  }
  throw new DictNotFound(lastWord)
}

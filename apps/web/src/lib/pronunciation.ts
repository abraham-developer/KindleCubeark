// apps/web/src/lib/pronunciation.ts — pronunciación por bloques, sin costo:
// lee el bloque en voz alta con la síntesis de voz del navegador
// (Web Speech API, integrada y gratuita; las voces las pone el sistema)
// y genera una guía fonética de referencia escrita para hispanohablantes.
// Sin claves, sin backend y sin servicios de pago.
import type { StudyLang } from './study'

/** Voz BCP-47 que se pide al navegador para cada idioma de estudio. */
export const SPEECH_LANGS: Record<StudyLang, string> = {
  en: 'en-US',
  es: 'es-ES',
  fr: 'fr-FR',
  de: 'de-DE',
  zh: 'zh-CN',
}

export function speechLangFor(code: StudyLang): string {
  return SPEECH_LANGS[code]
}

/** El bloque original se asume en español salvo que la traducción ya lo sea. */
export function defaultOriginalLang(target: StudyLang): StudyLang {
  return target === 'es' ? 'en' : 'es'
}

/** ¿El navegador trae síntesis de voz integrada? */
export function isSpeechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
    && typeof SpeechSynthesisUtterance !== 'undefined'
}

type VoiceLike = { lang: string; default?: boolean }
type SynthLike = {
  speak: (utterance: SpeechSynthesisUtterance) => void
  cancel: () => void
  speaking?: boolean
  pending?: boolean
  resume?: () => void
  getVoices?: () => VoiceLike[]
  addEventListener?: (type: 'voiceschanged', fn: () => void) => void
  removeEventListener?: (type: 'voiceschanged', fn: () => void) => void
}

/** Voces instaladas en el navegador/sistema (puede ir vacío al principio). */
export function getSpeechVoices(synth?: SynthLike): VoiceLike[] {
  try {
    const s = synth ?? (isSpeechSupported() ? window.speechSynthesis as unknown as SynthLike : undefined)
    return s?.getVoices?.() ?? []
  } catch { return [] }
}

/** ¿Hay alguna voz instalada para este idioma? Sin voz, el navegador «lee» en silencio. */
export function hasSpeechVoice(lang: StudyLang, synth?: SynthLike): boolean {
  const code = lang.toLowerCase()
  const bcp = speechLangFor(lang).toLowerCase()
  return getSpeechVoices(synth).some(v => {
    const vl = v.lang.toLowerCase().replace('_', '-')
    return vl === bcp || vl.startsWith(`${code}-`) || vl === code
  })
}

/** Voz concreta para el idioma: exacta, luego por prefijo, luego la de defecto. */
export function pickVoice(voices: VoiceLike[], lang: StudyLang): VoiceLike | null {
  const code = lang.toLowerCase()
  const bcp = speechLangFor(lang).toLowerCase()
  const norm = (v: VoiceLike) => v.lang.toLowerCase().replace('_', '-')
  return voices.find(v => norm(v) === bcp)
    ?? voices.find(v => norm(v).startsWith(`${code}-`) || norm(v) === code)
    ?? voices.find(v => v.default)
    ?? null
}

/**
 * Las voces cargan asíncrono (voiceschanged): si aún no hay ninguna, se
 * espera un poco a que el navegador las anuncie antes de hablar.
 */
function waitForVoices(synth: SynthLike): Promise<VoiceLike[]> {
  const now = getSpeechVoices(synth)
  const add = synth.addEventListener
  if (now.length > 0 || !add) return Promise.resolve(now)
  return new Promise(resolve => {
    const done = () => { cleanup(); resolve(getSpeechVoices(synth)) }
    const timer = setTimeout(done, 400)
    const cleanup = () => { clearTimeout(timer); synth.removeEventListener?.('voiceschanged', done) }
    add.call(synth, 'voiceschanged', done)
  })
}

const CHUNK_MAX = 180

/** Trocea un texto en oraciones cortas (Chrome corta las lecturas largas). */
export function speechChunks(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return []
  const sentences = clean.match(/[^.!?…]+[.!?…]+["”»']?\s*|.+$/g) ?? [clean]
  const chunks: string[] = []
  for (const sentence of sentences) {
    const s = sentence.trim()
    if (!s) continue
    if (s.length <= CHUNK_MAX) { chunks.push(s); continue }
    // oración kilométrica: por cláusulas/palabras sin pasar el tope
    let current = ''
    for (const word of s.split(/(\s+)/)) {
      if (current && current.length + word.length > CHUNK_MAX) { chunks.push(current.trim()); current = '' }
      current += word
    }
    if (current.trim()) chunks.push(current.trim())
  }
  return chunks
}

export type SpeechPart = { text: string; lang: StudyLang }
export type SpeakOptions = {
  rate?: number
  synth?: SynthLike
  createUtterance?: (text: string, lang: string) => SpeechSynthesisUtterance
}

function defaultUtterance(text: string, lang: string): SpeechSynthesisUtterance {
  const u = new SpeechSynthesisUtterance(text)
  u.lang = lang
  return u
}

/** Detiene cualquier lectura en curso. */
export function stopSpeaking(synth?: SynthLike): void {
  try {
    ;(synth ?? (isSpeechSupported() ? window.speechSynthesis : undefined))?.cancel()
  } catch { /* sin voz no hay nada que detener */ }
}

/**
 * Lee las partes en orden (p. ej. original y luego traducción): cada una
 * arranca solo cuando termina la anterior. Sin soporte, resuelve sin hacer
 * nada. Una parte que falla no bloquea a la siguiente.
 */
// Chrome recolecta las utterances sin referencia viva y la lectura muere
// en silencio: se retienen aquí hasta que terminan.
const liveUtterances = new Set<SpeechSynthesisUtterance>()

export async function speakParts(parts: SpeechPart[], options: SpeakOptions = {}): Promise<void> {
  // la cola se expande por oraciones: bloque → frases en orden, idioma a idioma
  const queue: SpeechPart[] = parts.flatMap(p =>
    speechChunks(p.text).map(text => ({ text, lang: p.lang })))
  if (queue.length === 0) return
  const synth = options.synth ?? (isSpeechSupported() ? window.speechSynthesis as unknown as SynthLike : undefined)
  if (!synth) return
  const factory = options.createUtterance ?? defaultUtterance
  const rate = options.rate ?? 0.92
  const voices = await waitForVoices(synth)
  // Solo se cancela si hay algo sonando o en cola, y se espera un respiro:
  // cancelar en vacío y hablar al instante hace que Chrome descarte la
  // primera frase (la lectura «terminaba» en milisegundos sin sonar).
  if (synth.speaking || synth.pending) {
    try { synth.cancel() } catch { /* nada en curso */ }
    await new Promise(r => setTimeout(r, 60))
  }
  try { synth.resume?.() } catch { /* no estaba en pausa */ }
  await new Promise<void>(resolve => {
    let index = 0
    const next = () => {
      if (index >= queue.length) { resolve(); return }
      const part = queue[index++]
      let utterance: SpeechSynthesisUtterance
      try {
        utterance = factory(part.text, speechLangFor(part.lang))
      } catch { next(); return }
      const voice = pickVoice(voices, part.lang)
      if (voice) {
        try { (utterance as { voice?: unknown }).voice = voice } catch { /* voz de defecto */ }
      }
      utterance.rate = rate
      liveUtterances.add(utterance)
      const done = () => { liveUtterances.delete(utterance); next() }
      utterance.onend = done
      utterance.onerror = done
      try { synth.speak(utterance) } catch { done() }
    }
    next()
  })
}

// ── Guía fonética escrita (referencia, no sustituye a escuchar la voz) ────

const GUIDE_MAX_WORDS = 18

/** Referencia breve de cómo suena cada idioma para un hispanohablante. */
export function pronunciationNote(lang: StudyLang): string {
  switch (lang) {
    case 'es': return 'En español se lee como se escribe: cada letra suena igual que en la guía silábica.'
    case 'en': return 'Transcripción aproximada con sonidos del español. La «j» suena fuerte, como en inglés «house».'
    case 'fr': return 'Transcripción aproximada: «u» se pronuncia con los labios de «u» diciendo «i»; los sonidos nasales van entre comillas.'
    case 'de': return 'Transcripción aproximada: «v» suena como «f» suave y «j» como una jota suave.'
    case 'zh': return 'Los caracteres se leen con la voz en chino. Escucha el bloque y repite carácter a carácter.'
  }
}

const VOWELS = 'aeiouáéíóúü'
const STRONG = 'aeoáéó'

function vowelGroups(word: string): Array<[number, number]> {
  const groups: Array<[number, number]> = []
  let i = 0
  while (i < word.length) {
    if (!VOWELS.includes(word[i])) { i++; continue }
    let end = i + 1
    while (end < word.length && VOWELS.includes(word[end])) {
      const prev = word[end - 1]
      const cur = word[end]
      // diptongo salvo vocales fuertes juntas o débil acentuada (hiato)
      if ((STRONG.includes(prev) && STRONG.includes(cur)) || 'íú'.includes(cur) || 'íú'.includes(prev)) break
      end++
    }
    groups.push([i, end])
    i = end
  }
  return groups
}

const INSEPARABLE = new Set(['pr', 'br', 'tr', 'dr', 'cr', 'gr', 'fr', 'pl', 'bl', 'cl', 'gl', 'fl', 'ch', 'll', 'rr', 'qu', 'gu'])

/** Separa una palabra española en sílabas: «hola» → «ho·la». */
export function syllabifySpanish(raw: string): string {
  const word = raw.toLowerCase()
  if (word.length < 2) return word
  const groups = vowelGroups(word)
  if (groups.length <= 1) return word
  const cuts: number[] = []
  for (let g = 0; g < groups.length - 1; g++) {
    const consStart = groups[g][1]
    const consEnd = groups[g + 1][0]
    const cons = word.slice(consStart, consEnd)
    if (cons.length === 0) cuts.push(consEnd)
    else if (cons.length === 1) cuts.push(consStart)
    else if (INSEPARABLE.has(cons.slice(-2))) cuts.push(consEnd - 2)
    else cuts.push(consEnd - 1)
  }
  const parts: string[] = []
  let prev = 0
  for (const cut of cuts) { parts.push(word.slice(prev, cut)); prev = cut }
  parts.push(word.slice(prev))
  return parts.filter(Boolean).join('·')
}

/** Transcripción aproximada de una palabra inglesa con sonidos del español. */
export function respellEnglish(raw: string): string {
  let w = raw.toLowerCase()
  const voicedTh = new Set(['the', 'this', 'that', 'they', 'them', 'there', 'with'])
  w = w.replace(/th/g, voicedTh.has(w) ? 'd' : 'z')
  w = w
    .replace(/ph/g, 'f').replace(/sh/g, 'sh').replace(/ch/g, 'ch').replace(/ck/g, 'k')
    .replace(/oo/g, 'u').replace(/ee/g, 'i').replace(/ea/g, 'i')
    .replace(/ou/g, 'au').replace(/ow/g, 'au').replace(/ay/g, 'ei').replace(/ai/g, 'ei')
    .replace(/wh/g, 'u').replace(/h/g, 'j')
    .replace(/c([ei])/g, 's$1').replace(/g([ei])/g, 'y$1')
    .replace(/ll/g, 'l').replace(/ss/g, 's').replace(/tt/g, 't').replace(/pp/g, 'p')
  if (w.length > 3 && w.endsWith('e') && !w.endsWith('ee')) w = w.slice(0, -1)
  if (w.length > 2 && w.endsWith('y')) w = `${w.slice(0, -1)}i`
  return w
}

/** Transcripción aproximada de una palabra francesa. */
export function respellFrench(raw: string): string {
  let w = raw.toLowerCase()
  w = w
    .replace(/eau/g, 'o').replace(/ou/g, 'u').replace(/oi/g, 'ua')
    .replace(/ai|ei/g, 'e').replace(/au/g, 'o').replace(/ch/g, 'sh')
    .replace(/gn/g, 'ñ').replace(/qu/g, 'k').replace(/ç/g, 's')
    .replace(/u/g, 'ü')
  // consonante final muda salvo c, r, f, l
  if (w.length > 2 && /[bcdfghjklmnpqrstvwxz]$/.test(w) && !/[crfl]$/.test(w)) w = w.slice(0, -1)
  return w
}

/** Transcripción aproximada de una palabra alemana. */
export function respellGerman(raw: string): string {
  return raw.toLowerCase()
    .replace(/sch/g, 'sh').replace(/ei/g, 'ai').replace(/ie/g, 'i')
    .replace(/eu|äu/g, 'oi').replace(/ch/g, 'j').replace(/ß/g, 'ss')
    .replace(/w/g, 'v').replace(/v/g, 'f').replace(/z/g, 'ts')
    .replace(/j/g, 'i').replace(/ä/g, 'e')
}

function cleanWord(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'-]+$/gu, '')
}

/**
 * Guía escrita del bloque en el idioma dado: las primeras palabras con su
 * pronunciación de referencia. El resto se marca con «…» (truncated).
 */
export function pronunciationGuide(
  text: string,
  lang: StudyLang,
  maxWords = GUIDE_MAX_WORDS,
): { guide: string; truncated: boolean; totalWords: number } {
  const words = text.split(/\s+/).map(cleanWord).filter(Boolean)
  if (words.length === 0) return { guide: '', truncated: false, totalWords: 0 }
  const shown = words.slice(0, maxWords)
  const convert = (word: string): string => {
    switch (lang) {
      case 'es': return syllabifySpanish(word)
      case 'en': return respellEnglish(word)
      case 'fr': return respellFrench(word)
      case 'de': return respellGerman(word)
      case 'zh': return Array.from(word).join(' ')
    }
  }
  const truncated = words.length > shown.length
  return {
    guide: shown.map(convert).join(' ') + (truncated ? ' …' : ''),
    truncated,
    totalWords: words.length,
  }
}

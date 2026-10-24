// apps/web/src/test/pronunciation.test.ts — pronunciación por bloques:
// voz gratuita del navegador (Web Speech API) y guía fonética de referencia.
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  defaultOriginalLang, isSpeechSupported, pronunciationGuide, pronunciationNote,
  speakParts, speechLangFor, stopSpeaking, syllabifySpanish,
} from '../lib/pronunciation'

afterEach(() => { vi.restoreAllMocks() })

describe('idiomas de voz', () => {
  it('mapea cada idioma de estudio a su voz BCP-47', () => {
    expect(speechLangFor('en')).toBe('en-US')
    expect(speechLangFor('es')).toBe('es-ES')
    expect(speechLangFor('fr')).toBe('fr-FR')
    expect(speechLangFor('de')).toBe('de-DE')
    expect(speechLangFor('zh')).toBe('zh-CN')
  })

  it('el original por defecto es español salvo que la traducción ya sea español', () => {
    expect(defaultOriginalLang('en')).toBe('es')
    expect(defaultOriginalLang('es')).toBe('en')
  })
})

describe('guía de pronunciación', () => {
  it('en español separa en sílabas: se lee como se escribe', () => {
    expect(syllabifySpanish('hola')).toBe('ho·la')
    expect(syllabifySpanish('casa')).toBe('ca·sa')
    expect(pronunciationGuide('Hola casa', 'es').guide).toBe('ho·la ca·sa')
    expect(pronunciationNote('es')).toMatch(/como se escribe/i)
  })

  it('en inglés da una transcripción aproximada para hispanohablantes', () => {
    const { guide } = pronunciationGuide('Hello', 'en')
    expect(guide).toBe('jelo')
    expect(pronunciationGuide('the cat', 'en').guide).toContain('de')
    expect(pronunciationNote('en')).toMatch(/aproximada/i)
  })

  it('limita la guía a las primeras palabras del bloque y avisa del resto', () => {
    const text = Array.from({ length: 30 }, (_, i) => `palabra${i}`).join(' ')
    const { guide, truncated, totalWords } = pronunciationGuide(text, 'es')
    expect(totalWords).toBe(30)
    expect(truncated).toBe(true)
    expect(guide).toContain('…')
  })

  it('texto vacío produce guía vacía sin truncar', () => {
    expect(pronunciationGuide('   ', 'fr')).toEqual({ guide: '', truncated: false, totalWords: 0 })
  })
})

type FakeUtterance = {
  text: string; lang: string; rate: number
  onend: (() => void) | null; onerror: (() => void) | null
}

const tick = () => new Promise<void>(r => setTimeout(r, 0))

function fakeSynth() {
  const spoken: FakeUtterance[] = []
  const synth = {
    spoken,
    cancelled: 0,
    speak(u: FakeUtterance) { spoken.push(u) },
    cancel() { synth.cancelled++ },
  }
  const factory = (text: string, lang: string): FakeUtterance => ({ text, lang, rate: 1, onend: null, onerror: null })
  return { synth, factory }
}

describe('speakParts (voz del navegador, sin costo)', () => {
  it('sin soporte no lanza y resuelve', async () => {
    expect(isSpeechSupported()).toBe(false) // jsdom no trae speechSynthesis
    await expect(speakParts([{ text: 'Hola', lang: 'es' }])).resolves.toBeUndefined()
  })

  it('lee los bloques en orden: primero un idioma y al terminar el otro', async () => {
    const { synth, factory } = fakeSynth()
    const done = speakParts(
      [{ text: 'Hola mundo', lang: 'es' }, { text: 'Hello world', lang: 'en' }],
      { synth: synth as never, createUtterance: factory as never },
    )
    await tick() // las voces se esperan antes de hablar
    // solo arrancó el primer bloque
    expect(synth.spoken.map(u => [u.text, u.lang])).toEqual([['Hola mundo', 'es-ES']])
    synth.spoken[0].onend?.()
    expect(synth.spoken.map(u => [u.text, u.lang])).toEqual([
      ['Hola mundo', 'es-ES'], ['Hello world', 'en-US'],
    ])
    synth.spoken[1].onend?.()
    await expect(done).resolves.toBeUndefined()
  })

  it('no cancela en vacío antes de hablar (la cancelación asíncrona se llevaba la primera frase)', async () => {
    const { synth, factory } = fakeSynth()
    const done = speakParts([{ text: 'Hola mundo.', lang: 'es' }],
      { synth: synth as never, createUtterance: factory as never })
    await tick()
    expect(synth.cancelled).toBe(0)
    synth.spoken[0].onend?.()
    await expect(done).resolves.toBeUndefined()
  })

  it('trocea el bloque por oraciones y las lee en orden', async () => {
    const { synth, factory } = fakeSynth()
    const done = speakParts([{ text: 'Uno. Dos. Tres.', lang: 'es' }],
      { synth: synth as never, createUtterance: factory as never })
    await tick()
    expect(synth.spoken.map(u => u.text)).toEqual(['Uno.'])
    synth.spoken[0].onend?.()
    expect(synth.spoken.map(u => u.text)).toEqual(['Uno.', 'Dos.'])
    synth.spoken[1].onend?.()
    expect(synth.spoken.map(u => u.text)).toEqual(['Uno.', 'Dos.', 'Tres.'])
    synth.spoken[2].onend?.()
    await expect(done).resolves.toBeUndefined()
  })

  it('omite partes vacías y stopSpeaking cancela la voz', async () => {
    const { synth, factory } = fakeSynth()
    await speakParts([{ text: '   ', lang: 'es' }], { synth: synth as never, createUtterance: factory as never })
    expect(synth.spoken).toHaveLength(0)
    stopSpeaking(synth as never)
    expect(synth.cancelled).toBeGreaterThan(0)
  })
})

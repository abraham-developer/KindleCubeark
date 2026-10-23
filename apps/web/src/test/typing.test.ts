// apps/web/src/test/typing.test.ts — lógica pura del modo typing:
// tokenizado, lecciones, métricas, teclados (incl. AZERTY francés), puerta
// de escritorio y preferencias.
import { describe, it, expect, afterEach } from 'vitest'
import {
  KEYBOARD_LAYOUTS, LESSON_WORDS, computeStats, fingerHint, isDesktopTyping,
  isKeyboardLayout, keyboardLayout, layoutKeyFor, lessonRange, loadTypingPrefs,
  saveTypingPrefs, tokenizeText, wordCharStates,
} from '../lib/typing'

afterEach(() => { window.localStorage.clear() })

describe('tokenizeText y lecciones', () => {
  it('normaliza espacios, conserva acentos y descarta marcas sueltas', () => {
    expect(tokenizeText('  Hola   mundo\n¿cómo estás?  —  bien ')).toEqual(['Hola', 'mundo', '¿cómo', 'estás?', 'bien'])
    expect(tokenizeText('   ')).toEqual([])
  })
  it('parte el libro en lecciones de 30 palabras y acota el índice', () => {
    expect(LESSON_WORDS).toBe(30)
    expect(lessonRange(95, 0)).toEqual({ start: 0, end: 30 })
    expect(lessonRange(95, 44)).toEqual({ start: 30, end: 60 })
    expect(lessonRange(95, 95)).toEqual({ start: 90, end: 95 })
    expect(lessonRange(0, 0)).toEqual({ start: 0, end: 0 })
  })
})

describe('palabra en curso y métricas', () => {
  it('marca aciertos, errores y caracteres extra', () => {
    expect(wordCharStates('hola', 'hoxa')).toEqual(['correct', 'correct', 'incorrect', 'correct'])
    expect(wordCharStates('hola', 'holas')).toEqual(['correct', 'correct', 'correct', 'correct', 'extra'])
    expect(wordCharStates('hola', 'ho')).toEqual(['correct', 'correct', 'pending', 'pending'])
  })
  it('calcula PPM estándar, precisión y puntuación', () => {
    const s = computeStats({ correctChars: 250, typedChars: 260, errors: 10, durationMs: 60_000, wordsCompleted: 50 })
    expect(s.wpm).toBe(50)
    expect(s.accuracy).toBe(96.2)
    expect(s.score).toBeGreaterThan(0)
    expect(computeStats({ correctChars: 0, typedChars: 0, errors: 0, durationMs: 0, wordsCompleted: 0 }))
      .toMatchObject({ wpm: 0, accuracy: 100, score: 0 })
  })
})

describe('teclados seleccionables', () => {
  it('incluye AZERTY francés junto a QWERTY, QWERTZ y Dvorak', () => {
    expect(KEYBOARD_LAYOUTS.map(l => l.id)).toEqual(['qwerty-es', 'qwerty-us', 'azerty-fr', 'qwertz-de', 'dvorak-us'])
    const azerty = keyboardLayout('azerty-fr')
    expect(azerty.rows[1]).toMatch(/^azerty/)
    expect(layoutKeyFor('a', azerty)).toBe('a')
    expect(layoutKeyFor(' ', azerty)).toBe(' ')
    expect(isKeyboardLayout('azerty-fr')).toBe(true)
    expect(isKeyboardLayout('colemak')).toBe(false)
    expect(fingerHint(' ', azerty)).toBe('pulgar')
  })
  it('las preferencias persisten y se sanean', () => {
    expect(loadTypingPrefs()).toEqual({ layout: 'qwerty-es', bilingual: false, targetLang: 'fr' })
    saveTypingPrefs({ layout: 'azerty-fr', bilingual: true, targetLang: 'fr' })
    expect(loadTypingPrefs()).toEqual({ layout: 'azerty-fr', bilingual: true, targetLang: 'fr' })
    window.localStorage.setItem('kc.typing.prefs', JSON.stringify({ layout: 'xx', targetLang: 'pt' }))
    expect(loadTypingPrefs()).toEqual({ layout: 'qwerty-es', bilingual: false, targetLang: 'fr' })
  })
})

describe('solo escritorio', () => {
  it('exige puntero fino y ancho de sobremesa', () => {
    expect(isDesktopTyping({ width: 1440, pointerFine: true })).toBe(true)
    expect(isDesktopTyping({ width: 1440, pointerFine: false })).toBe(false)
    expect(isDesktopTyping({ width: 800, pointerFine: true })).toBe(false)
  })
})

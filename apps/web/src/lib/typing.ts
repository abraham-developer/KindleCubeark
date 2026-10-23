// apps/web/src/lib/typing.ts — modo typing estilo typing.com (solo
// escritorio): el texto del propio libro se escribe palabra por palabra, en
// lecciones cortas, con puntuación y retomado por libro. Este módulo es la
// lógica pura (tokenizar, lecciones, métricas, teclados); la pantalla vive
// en pages/TypingMode.tsx y la extracción del texto en lib/typingText.ts.
import type { StudyLang } from './study'

/** Palabras por lección: suficiente para una puntuación con sentido sin
 *  convertir cada lección en una maratón. */
export const LESSON_WORDS = 30

export type KeyboardLayoutId = 'qwerty-es' | 'qwerty-us' | 'azerty-fr' | 'qwertz-de' | 'dvorak-us'

export interface KeyboardLayout {
  id: KeyboardLayoutId
  label: string
  /** Filas de caracteres tal como se ven en las teclas (sin modificadores). */
  rows: string[]
  /** Dedo recomendado por columna de la fila guía, para la ayuda visual. */
  homeRow: string
}

export const KEYBOARD_LAYOUTS: KeyboardLayout[] = [
  { id: 'qwerty-es', label: 'QWERTY · Español', rows: ['1234567890', 'qwertyuiop', 'asdfghjklñ', 'zxcvbnm'], homeRow: 'asdfghjklñ' },
  { id: 'qwerty-us', label: 'QWERTY · English (US)', rows: ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'], homeRow: 'asdfghjkl' },
  { id: 'azerty-fr', label: 'AZERTY · Français', rows: ['1234567890', 'azertyuiop', 'qsdfghjklm', 'wxcvbn'], homeRow: 'qsdfghjklm' },
  { id: 'qwertz-de', label: 'QWERTZ · Deutsch', rows: ['1234567890', 'qwertzuiopü', 'asdfghjklöä', 'yxcvbnm'], homeRow: 'asdfghjklöä' },
  { id: 'dvorak-us', label: 'Dvorak · English (US)', rows: ['1234567890', 'pyfgcrl', 'aoeuidhtns', 'qjkxbmwvz'], homeRow: 'aoeuidhtns' },
]

export function isKeyboardLayout(value: unknown): value is KeyboardLayoutId {
  return KEYBOARD_LAYOUTS.some(l => l.id === value)
}

export function keyboardLayout(id: KeyboardLayoutId): KeyboardLayout {
  return KEYBOARD_LAYOUTS.find(l => l.id === id) ?? KEYBOARD_LAYOUTS[0]
}

/** Normaliza una tecla del layout para compararla con el carácter esperado
 *  (minúsculas; el espacio se representa como ' '). */
export function layoutKeyFor(char: string, layout: KeyboardLayout): string | null {
  if (char === ' ') return ' '
  const wanted = char.toLocaleLowerCase()
  for (const row of layout.rows) {
    if (row.includes(wanted)) return wanted
  }
  return null
}

const FINGERS = ['meñique', 'anular', 'medio', 'índice', 'índice', 'medio', 'anular', 'meñique'] as const

/** Dedo sugerido para una tecla de la fila guía (posición desde el centro). */
export function fingerHint(char: string, layout: KeyboardLayout): string | null {
  const key = layoutKeyFor(char, layout)
  if (key === ' ') return 'pulgar'
  if (key === null) return null
  for (const row of layout.rows) {
    const idx = row.indexOf(key)
    if (idx === -1) continue
    const half = Math.ceil(row.length / 2)
    const side = idx < half ? 'izquierdo' : 'derecho'
    const finger = FINGERS[Math.min(idx < half ? idx : idx - half, FINGERS.length - 1)]
    return `${finger} ${side}`
  }
  return null
}

/** Texto del libro → palabras escribibles. Descarta marcas sueltas y
 *  normaliza espacios; conserva puntuación y acentos (hay que teclearlos). */
export function tokenizeText(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(' ')
    .map(w => w.trim())
    .filter(w => /[\p{L}\p{N}]/u.test(w))
}

export function lessonRange(totalWords: number, wordIndex: number): { start: number; end: number } {
  const total = Math.max(0, Math.floor(totalWords) || 0)
  const at = Math.max(0, Math.min(Math.floor(wordIndex) || 0, total))
  const start = total === 0 ? 0 : Math.floor(at / LESSON_WORDS) * LESSON_WORDS
  return { start, end: Math.min(total, start + LESSON_WORDS) }
}

export type CharState = 'pending' | 'correct' | 'incorrect' | 'extra'

/** Estado por carácter de la palabra en curso frente a lo tecleado. */
export function wordCharStates(target: string, typed: string): CharState[] {
  const states: CharState[] = []
  for (let i = 0; i < Math.max(target.length, typed.length); i++) {
    if (i >= typed.length) states.push('pending')
    else if (i >= target.length) states.push('extra')
    else states.push(typed[i] === target[i] ? 'correct' : 'incorrect')
  }
  return states
}

export interface TypingStats {
  wpm: number
  accuracy: number
  /** Puntos de la lección: premia velocidad y precisión (máx. por palabra). */
  score: number
  correctChars: number
  typedChars: number
  errors: number
}

/**
 * Métricas de una lección. WPM estándar: (caracteres correctos / 5) por
 * minuto. Puntuación = palabras × 10 × precisión² × factor de velocidad
 * (tope 2× a partir de 60 WPM), redondeada.
 */
export function computeStats(input: {
  correctChars: number
  typedChars: number
  errors: number
  durationMs: number
  wordsCompleted: number
}): TypingStats {
  const correctChars = Math.max(0, input.correctChars)
  const typedChars = Math.max(0, input.typedChars)
  const minutes = input.durationMs / 60_000
  const wpm = minutes > 0 ? Math.round(((correctChars / 5) / minutes) * 10) / 10 : 0
  const accuracy = typedChars > 0 ? Math.round((correctChars / typedChars) * 1000) / 10 : 100
  const speedFactor = Math.min(2, 0.5 + wpm / 40)
  const score = Math.round(input.wordsCompleted * 10 * (accuracy / 100) ** 2 * speedFactor)
  return { wpm, accuracy, score, correctChars, typedChars, errors: Math.max(0, input.errors) }
}

/** Solo escritorio: puntero fino (ratón/trackpad) y ancho de sobremesa. El
 *  modo typing necesita teclado físico; en táctil se muestra el aviso. */
export function isDesktopTyping(env: { width: number; pointerFine: boolean }): boolean {
  return env.pointerFine && env.width >= 1024
}

export interface TypingPrefs {
  layout: KeyboardLayoutId
  bilingual: boolean
  targetLang: StudyLang
}

const PREFS_KEY = 'kc.typing.prefs'
export const DEFAULT_TYPING_PREFS: TypingPrefs = { layout: 'qwerty-es', bilingual: false, targetLang: 'fr' }

export function loadTypingPrefs(): TypingPrefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY)
    if (!raw) return { ...DEFAULT_TYPING_PREFS }
    const parsed = JSON.parse(raw) as Partial<TypingPrefs>
    return {
      layout: isKeyboardLayout(parsed.layout) ? parsed.layout : DEFAULT_TYPING_PREFS.layout,
      bilingual: parsed.bilingual === true,
      targetLang: (['en', 'fr', 'de', 'zh', 'es'] as const).includes(parsed.targetLang as StudyLang)
        ? parsed.targetLang as StudyLang
        : DEFAULT_TYPING_PREFS.targetLang,
    }
  } catch {
    return { ...DEFAULT_TYPING_PREFS }
  }
}

export function saveTypingPrefs(prefs: TypingPrefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* sin almacenamiento la preferencia simplemente no persiste */
  }
}

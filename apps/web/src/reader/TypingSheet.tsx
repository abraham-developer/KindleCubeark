// apps/web/src/reader/TypingSheet.tsx — hoja de typing a mitad de pantalla
// dentro del lector (siempre sobre la vista por bloques en PDF): se escribe
// el bloque/sección en lectura palabra por palabra, estilo typing.com. El
// avance dentro de esta hoja se guarda localmente por (libro, posición) y
// cada hoja completada guarda su puntuación en el servidor, por libro.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { STUDY_LANGS, translateBlock, type StudyLang } from '../lib/study'
import {
  KEYBOARD_LAYOUTS, computeStats, isDesktopTyping, keyboardLayout, loadTypingPrefs, saveTypingPrefs,
  tokenizeText, wordCharStates, type KeyboardLayoutId, type TypingStats,
} from '../lib/typing'
import TypingKeyboard from './TypingKeyboard'

interface SavedSheet {
  index: number
  typed: string
  correctChars: number
  typedChars: number
  errors: number
  wordsCompleted: number
  elapsedMs: number
  result: TypingStats | null
}

const EMPTY: SavedSheet = { index: 0, typed: '', correctChars: 0, typedChars: 0, errors: 0, wordsCompleted: 0, elapsedMs: 0, result: null }

function storageKey(bookId: string, positionKey: string): string {
  return `kc.typing.sheet.${bookId}.${positionKey}`
}

function loadSheet(bookId: string, positionKey: string): SavedSheet {
  try {
    const raw = window.localStorage.getItem(storageKey(bookId, positionKey))
    if (!raw) return EMPTY
    const parsed = JSON.parse(raw) as Partial<SavedSheet>
    return {
      index: Math.max(0, Math.floor(Number(parsed.index) || 0)),
      typed: typeof parsed.typed === 'string' ? parsed.typed : '',
      correctChars: Math.max(0, Number(parsed.correctChars) || 0),
      typedChars: Math.max(0, Number(parsed.typedChars) || 0),
      errors: Math.max(0, Number(parsed.errors) || 0),
      wordsCompleted: Math.max(0, Number(parsed.wordsCompleted) || 0),
      elapsedMs: Math.max(0, Number(parsed.elapsedMs) || 0),
      result: parsed.result && typeof parsed.result === 'object' ? parsed.result as TypingStats : null,
    }
  } catch {
    return EMPTY
  }
}

export default function TypingSheet({ bookId, text, positionKey, bilingual, targetLang, onNext, nextLabel = 'Siguiente bloque', onExit }: {
  bookId: string
  text: string
  /** Identifica la hoja (p. ej. `pdf:4:2`): el avance se retoma por hoja. */
  positionKey: string
  bilingual: boolean
  targetLang: StudyLang
  onNext?: () => void
  nextLabel?: string
  onExit?: () => void
}) {
  const words = useMemo(() => tokenizeText(text), [text])
  const [sheet, setSheet] = useState<SavedSheet>(() => loadSheet(bookId, positionKey))
  const [layoutId, setLayoutId] = useState<KeyboardLayoutId>(() => loadTypingPrefs().layout)
  const [pressed, setPressed] = useState<string | null>(null)
  const [scoreError, setScoreError] = useState<string | null>(null)
  const [desktop] = useState(() => isDesktopTyping({
    width: window.innerWidth,
    pointerFine: typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches,
  }))
  const startedAtRef = useRef<number | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const sheetRef = useRef(sheet)
  sheetRef.current = sheet

  const layout = keyboardLayout(layoutId)
  const index = Math.min(sheet.index, words.length)
  const currentWord = index < words.length ? words[index] : null
  const done = sheet.result !== null || (words.length > 0 && index >= words.length)
  const nextChar = currentWord ? (sheet.typed.length < currentWord.length ? currentWord[sheet.typed.length] : ' ') : null

  useEffect(() => { stageRef.current?.focus() }, [positionKey])
  useEffect(() => { saveTypingPrefs({ layout: layoutId, bilingual, targetLang }) }, [layoutId, bilingual, targetLang])

  // Guardado del avance en esta hoja (local, por libro y posición).
  useEffect(() => {
    try {
      const elapsedMs = sheet.elapsedMs + (startedAtRef.current ? Date.now() - startedAtRef.current : 0)
      window.localStorage.setItem(storageKey(bookId, positionKey), JSON.stringify({ ...sheet, elapsedMs }))
    } catch { /* sin almacenamiento no hay retomado intra-hoja */ }
  }, [sheet, bookId, positionKey])

  const finish = useCallback(async (final: SavedSheet) => {
    const durationMs = Math.max(1, final.elapsedMs + (startedAtRef.current ? Date.now() - startedAtRef.current : 0))
    const stats = computeStats({ ...final, durationMs })
    startedAtRef.current = null
    setSheet({ ...final, elapsedMs: durationMs, result: stats })
    try {
      await api.addTypingScore(bookId, {
        wpm: stats.wpm, accuracy: stats.accuracy, score: stats.score,
        words_completed: final.wordsCompleted, errors: stats.errors, duration_ms: Math.round(durationMs),
        keyboard_layout: layoutId, target_lang: targetLang, bilingual,
      })
      setScoreError(null)
    } catch {
      setScoreError('Hoja completada, pero no se pudo guardar la puntuación en el servidor.')
    }
  }, [bookId, layoutId, targetLang, bilingual])

  const commitWord = useCallback(() => {
    const current = sheetRef.current
    const word = words[Math.min(current.index, words.length)]
    if (!word || current.typed.length === 0 || current.result) return
    const states = wordCharStates(word, current.typed)
    const nextSheet: SavedSheet = {
      ...current,
      index: current.index + 1,
      typed: '',
      correctChars: current.correctChars + states.filter(s => s === 'correct').length,
      typedChars: current.typedChars + current.typed.length,
      errors: current.errors + states.filter(s => s === 'incorrect' || s === 'extra').length,
      wordsCompleted: current.wordsCompleted + 1,
    }
    if (nextSheet.index >= words.length) void finish(nextSheet)
    else setSheet(nextSheet)
  }, [words, finish])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!desktop || !currentWord || sheet.result) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    e.stopPropagation()
    if (e.key === 'Backspace') { e.preventDefault(); setSheet(s => ({ ...s, typed: s.typed.slice(0, -1) })); return }
    if (e.key === ' ') { e.preventDefault(); commitWord(); return }
    if (e.key.length === 1) {
      e.preventDefault()
      if (!startedAtRef.current) startedAtRef.current = Date.now()
      setSheet(s => (s.typed.length <= currentWord.length + 8 ? { ...s, typed: s.typed + e.key } : s))
      setPressed(e.key.toLocaleLowerCase())
      setTimeout(() => setPressed(p => (p === e.key.toLocaleLowerCase() ? null : p)), 120)
    }
  }

  const restartSheet = () => {
    startedAtRef.current = null
    setSheet(EMPTY)
    setScoreError(null)
    try { window.localStorage.removeItem(storageKey(bookId, positionKey)) } catch { /* noop */ }
    stageRef.current?.focus()
  }

  // Bilingüe: glosa de la palabra actual en el idioma de apoyo (p. ej. francés).
  const [gloss, setGloss] = useState<string | null>(null)
  useEffect(() => {
    if (!bilingual || !currentWord) { setGloss(null); return }
    let alive = true
    const t = setTimeout(() => {
      translateBlock(currentWord.replace(/[^\p{L}\p{N}'’-]/gu, ''), targetLang)
        .then(g => { if (alive) setGloss(g) }).catch(() => { if (alive) setGloss(null) })
    }, 250)
    return () => { alive = false; clearTimeout(t) }
  }, [bilingual, currentWord, targetLang])

  if (words.length === 0) {
    return (
      <div className="typing-sheet" role="note">
        <p className="typing-sheet-head">Modo typing</p>
        <p>Esta hoja no tiene texto escribible. Avanza al siguiente bloque para seguir practicando.</p>
        {onNext && <button type="button" className="btn btn-primary" onClick={onNext}>{nextLabel}</button>}
      </div>
    )
  }

  return (
    <section className="typing-sheet" aria-label="Modo typing sobre esta hoja">
      <div className="typing-sheet-bar">
        <span className="typing-sheet-head">Modo typing · esta hoja</span>
        <label>Teclado
          <select value={layoutId} onChange={e => setLayoutId(e.target.value as KeyboardLayoutId)} aria-label="Tipo de teclado">
            {KEYBOARD_LAYOUTS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </label>
        <span className="typing-sheet-count">{Math.min(index + (done ? 0 : 1), words.length)} / {words.length} palabras</span>
        <button type="button" className="reader-tool" onClick={restartSheet}>Reiniciar hoja</button>
        {onExit && <button type="button" className="reader-tool" onClick={onExit}>Salir del typing</button>}
      </div>

      {!desktop && <p className="typing-error" role="note">El typing necesita teclado físico: en esta pantalla puedes ver la hoja, pero no escribir. Ábrelo en escritorio.</p>}
      {scoreError && <p className="typing-error" role="alert">{scoreError}</p>}

      {done && sheet.result ? (
        <div className="typing-sheet-result">
          <h2>Hoja completada</h2>
          <p><strong>{sheet.result.wpm} PPM</strong> · <strong>{sheet.result.accuracy}%</strong> de precisión · <strong>{sheet.result.score} puntos</strong> · {sheet.result.errors} errores. Puntuación guardada en este libro.</p>
          <div className="typing-actions">
            {onNext && <button type="button" className="btn btn-primary" onClick={onNext}>{nextLabel}</button>}
            <button type="button" className="btn" onClick={restartSheet}>Repetir hoja</button>
          </div>
        </div>
      ) : (
        <div ref={stageRef} className="typing-sheet-stage" tabIndex={0} role="textbox"
          aria-label="Escribe la palabra resaltada con tu teclado" onKeyDown={onKeyDown} onClick={() => stageRef.current?.focus()}>
          <p className="typing-passage">
            {words.map((word, i) => {
              if (i < index) return <span key={i} className="typing-word done"><span className="ok">{word}</span>{' '}</span>
              if (i === index) {
                const states = wordCharStates(word, sheet.typed)
                return (
                  <span key={i} className="typing-word current" aria-current="true">
                    {states.map((s, ci) => <span key={ci} className={`${s}${ci === sheet.typed.length ? ' caret' : ''}`}>{ci < word.length ? word[ci] : sheet.typed[ci]}</span>)}
                    {sheet.typed.length >= word.length && <span className="caret-end" aria-hidden="true" />}{' '}
                  </span>
                )
              }
              return <span key={i} className="typing-word">{word}{' '}</span>
            })}
          </p>
          <p className="typing-hint">
            {currentWord ? <>Palabra actual: <strong>{currentWord}</strong> · Espacio confirma · Retroceso corrige · tu avance en esta hoja se guarda solo</> : '…'}
          </p>
          {bilingual && gloss && currentWord && (
            <p className="typing-gloss"><strong>{currentWord}</strong> → {gloss} <span>({STUDY_LANGS.find(l => l.code === targetLang)?.label})</span></p>
          )}
        </div>
      )}

      <TypingKeyboard layout={layout} nextChar={done ? null : nextChar} pressedKey={pressed} />
    </section>
  )
}

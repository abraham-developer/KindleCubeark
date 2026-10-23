// apps/web/src/pages/TypingMode.tsx — modo typing estilo typing.com, solo
// escritorio: se escribe el texto del propio libro palabra por palabra, en
// lecciones de 30 palabras, con modo bilingüe (incluye francés), teclado en
// pantalla según el layout elegido, progreso reanudable y puntuaciones
// guardadas por libro en el servidor.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, type Book, type TypingScore } from '../api'
import { STUDY_LANGS, translateBlock, type StudyLang } from '../lib/study'
import {
  KEYBOARD_LAYOUTS, LESSON_WORDS, computeStats, fingerHint, isDesktopTyping, isKeyboardLayout,
  keyboardLayout, lessonRange, loadTypingPrefs, saveTypingPrefs, tokenizeText, wordCharStates,
  type KeyboardLayoutId,
} from '../lib/typing'
import { extractBookText } from '../lib/typingText'
import TypingKeyboard from '../reader/TypingKeyboard'

interface LessonAcc { correctChars: number; typedChars: number; errors: number; wordsCompleted: number; startedAt: number | null }
const EMPTY_ACC: LessonAcc = { correctChars: 0, typedChars: 0, errors: 0, wordsCompleted: 0, startedAt: null }

function useIsDesktop(): boolean {
  const check = () => isDesktopTyping({
    width: window.innerWidth,
    pointerFine: typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches,
  })
  const [desktop, setDesktop] = useState<boolean>(check)
  useEffect(() => {
    const onChange = () => setDesktop(check())
    window.addEventListener('resize', onChange)
    return () => window.removeEventListener('resize', onChange)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return desktop
}

export default function TypingMode() {
  const { bookId = '' } = useParams()
  const navigate = useNavigate()
  const desktop = useIsDesktop()
  const [book, setBook] = useState<Book | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [extract, setExtract] = useState<{ done: number; total: number } | null>(null)
  const [words, setWords] = useState<string[] | null>(null)
  const [scores, setScores] = useState<TypingScore[]>([])
  const [best, setBest] = useState<{ wpm: number; accuracy: number; score: number } | null>(null)

  const prefs0 = useMemo(loadTypingPrefs, [])
  const [layoutId, setLayoutId] = useState<KeyboardLayoutId>(prefs0.layout)
  const [bilingual, setBilingual] = useState(prefs0.bilingual)
  const [targetLang, setTargetLang] = useState<StudyLang>(prefs0.targetLang)

  const [wordIndex, setWordIndex] = useState(0)
  const [typed, setTyped] = useState('')
  const [committed, setCommitted] = useState<Record<number, string>>({})
  const [acc, setAcc] = useState<LessonAcc>(EMPTY_ACC)
  const [lastResult, setLastResult] = useState<(ReturnType<typeof computeStats> & { at: number }) | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [pressed, setPressed] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [resetArmed, setResetArmed] = useState(false)
  const readyRef = useRef(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const accRef = useRef(acc)
  accRef.current = acc

  const layout = keyboardLayout(layoutId)
  const total = words?.length ?? 0
  const range = useMemo(() => lessonRange(total, wordIndex), [total, wordIndex])
  const lessonWords = useMemo(() => (words ? words.slice(range.start, range.end) : []), [words, range])
  const currentWord = words && wordIndex < total ? words[wordIndex] : null
  const finished = words !== null && total > 0 && wordIndex >= total
  const nextChar = currentWord ? (typed.length < currentWord.length ? currentWord[typed.length] : ' ') : null

  // ── Carga: libro + progreso/puntuaciones + texto escribible ────────────
  useEffect(() => {
    let alive = true
    readyRef.current = false
    api.getBook(bookId)
      .then(async res => {
        if (!alive) return
        setBook(res.book)
        const typing = await api.getTyping(bookId).catch(() => null)
        if (!alive) return
        if (typing) {
          setScores(typing.scores)
          setBest(typing.best)
          const savedProgress = typing.progress
          if (savedProgress) {
            setWordIndex(savedProgress.word_index)
            if (isKeyboardLayout(savedProgress.keyboard_layout)) setLayoutId(savedProgress.keyboard_layout)
            if ((STUDY_LANGS as readonly { code: string }[]).some(l => l.code === savedProgress.target_lang)) {
              setTargetLang(savedProgress.target_lang as StudyLang)
            }
            setBilingual(savedProgress.bilingual)
          }
        }
        const text = await extractBookText(res.book, (done, tot) => { if (alive) setExtract({ done, total: tot }) })
        if (!alive) return
        const tokenized = tokenizeText(text)
        setWords(tokenized)
        setWordIndex(prev => Math.max(0, Math.min(prev, tokenized.length)))
        readyRef.current = true
      })
      .catch(err => { if (alive) setLoadError(`No se pudo preparar el modo typing: ${err instanceof Error ? err.message : String(err)}`) })
    return () => { alive = false }
  }, [bookId])

  // ── Preferencias locales + guardado del progreso en el servidor ────────
  useEffect(() => { saveTypingPrefs({ layout: layoutId, bilingual, targetLang }) }, [layoutId, bilingual, targetLang])
  useEffect(() => {
    if (!readyRef.current || words === null) return
    const t = setTimeout(() => {
      api.saveTypingProgress(bookId, {
        word_index: wordIndex, char_index: typed.length, total_words: total,
        keyboard_layout: layoutId, target_lang: targetLang, bilingual,
      }).then(() => setSaveError(null)).catch(() => setSaveError('No se pudo guardar el progreso; se reintentará al seguir escribiendo.'))
    }, 500)
    return () => clearTimeout(t)
  }, [bookId, wordIndex, typed, total, layoutId, targetLang, bilingual, words])

  // Reloj para WPM en vivo mientras la lección está en marcha.
  useEffect(() => {
    if (!acc.startedAt) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [acc.startedAt])

  const focusStage = useCallback(() => { stageRef.current?.focus() }, [])
  useEffect(() => { if (desktop && words) focusStage() }, [desktop, words, focusStage])

  const finishLesson = useCallback(async (finalAcc: LessonAcc, durationMs: number) => {
    const stats = computeStats({ ...finalAcc, durationMs })
    setLastResult({ ...stats, at: Date.now() })
    setAcc(EMPTY_ACC)
    setCommitted({})
    try {
      const saved = await api.addTypingScore(bookId, {
        wpm: stats.wpm, accuracy: stats.accuracy, score: stats.score,
        words_completed: finalAcc.wordsCompleted, errors: stats.errors, duration_ms: Math.max(1, Math.round(durationMs)),
        keyboard_layout: layoutId, target_lang: targetLang, bilingual,
      })
      setScores(prev => [saved, ...prev].slice(0, 50))
      setBest(prev => (!prev || saved.score > prev.score ? { wpm: saved.wpm, accuracy: saved.accuracy, score: saved.score } : prev))
      setSaveError(null)
    } catch {
      setSaveError('La lección terminó, pero no se pudo guardar la puntuación.')
    }
  }, [bookId, layoutId, targetLang, bilingual])

  const commitWord = useCallback(() => {
    if (!currentWord || typed.length === 0) return
    const states = wordCharStates(currentWord, typed)
    const correct = states.filter(s => s === 'correct').length
    const errors = states.filter(s => s === 'incorrect' || s === 'extra').length
    const next: LessonAcc = {
      correctChars: accRef.current.correctChars + correct,
      typedChars: accRef.current.typedChars + typed.length,
      errors: accRef.current.errors + errors,
      wordsCompleted: accRef.current.wordsCompleted + 1,
      startedAt: accRef.current.startedAt ?? Date.now(),
    }
    const globalAt = wordIndex
    setCommitted(prev => ({ ...prev, [globalAt]: typed }))
    setTyped('')
    const nextIndex = wordIndex + 1
    setWordIndex(nextIndex)
    if (nextIndex >= range.end) {
      void finishLesson(next, Date.now() - (next.startedAt ?? Date.now()))
    } else {
      setAcc(next)
    }
  }, [currentWord, typed, wordIndex, range.end, finishLesson])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!desktop || !currentWord || lastResult) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === 'Backspace') { e.preventDefault(); setTyped(t => t.slice(0, -1)); return }
    if (e.key === ' ') { e.preventDefault(); commitWord(); return }
    if (e.key.length === 1) {
      e.preventDefault()
      setAcc(a => (a.startedAt ? a : { ...a, startedAt: Date.now() }))
      setTyped(t => (t.length <= currentWord.length + 8 ? t + e.key : t))
      setPressed(e.key.toLocaleLowerCase())
      setTimeout(() => setPressed(p => (p === e.key.toLocaleLowerCase() ? null : p)), 120)
    }
  }

  const resetProgress = async () => {
    if (!resetArmed) { setResetArmed(true); return }
    setResetArmed(false)
    try { await api.resetTypingProgress(bookId) } catch { /* el reinicio local manda */ }
    readyRef.current = true
    setWordIndex(0); setTyped(''); setCommitted({}); setAcc(EMPTY_ACC); setLastResult(null)
    focusStage()
  }

  // ── Bilingüe: traducción de la lección y glosa de la palabra actual ────
  const [lessonTranslation, setLessonTranslation] = useState<string | null>(null)
  const [gloss, setGloss] = useState<string | null>(null)
  const [transError, setTransError] = useState<string | null>(null)
  const lessonText = lessonWords.join(' ')
  useEffect(() => {
    if (!bilingual || !lessonText || finished) { setLessonTranslation(null); setGloss(null); return }
    let alive = true
    translateBlock(lessonText, targetLang)
      .then(t => { if (alive) { setLessonTranslation(t); setTransError(null) } })
      .catch(() => { if (alive) setTransError('Traducción no disponible en este momento.') })
    return () => { alive = false }
  }, [bilingual, lessonText, targetLang, finished])
  useEffect(() => {
    if (!bilingual || !currentWord) { setGloss(null); return }
    let alive = true
    const t = setTimeout(() => {
      translateBlock(currentWord.replace(/[^\p{L}\p{N}'’-]/gu, ''), targetLang)
        .then(g => { if (alive) setGloss(g) }).catch(() => { if (alive) setGloss(null) })
    }, 250)
    return () => { alive = false; clearTimeout(t) }
  }, [bilingual, currentWord, targetLang])

  const liveStats = computeStats({
    correctChars: acc.correctChars, typedChars: acc.typedChars, errors: acc.errors,
    durationMs: acc.startedAt ? now - acc.startedAt : 0, wordsCompleted: acc.wordsCompleted,
  })
  const bookProgress = total > 0 ? Math.round((Math.min(wordIndex, total) / total) * 100) : 0

  if (loadError) {
    return <div className="page-center typing-center"><p role="alert">{loadError}</p><button type="button" className="btn" onClick={() => navigate('/')}>Volver a la biblioteca</button></div>
  }
  if (!desktop) {
    return (
      <main className="typing-page"><div className="typing-notice" role="note">
        <h1>Modo typing · Solo escritorio</h1>
        <p>Esta práctica necesita un teclado físico y una pantalla amplia, como en typing.com. Abre este libro desde un ordenador para escribirlo palabra por palabra; tu progreso y tus puntuaciones por libro te esperarán guardados.</p>
        <div className="typing-actions">
          <button type="button" className="btn btn-primary" onClick={() => navigate(`/reader/${bookId}`)}>Seguir leyendo</button>
          <button type="button" className="btn" onClick={() => navigate('/')}>Biblioteca</button>
        </div>
      </div></main>
    )
  }

  return (
    <main className="typing-page">
      <header className="typing-head">
        <button type="button" className="reader-back" onClick={() => navigate(`/reader/${bookId}`)}>‹ Seguir leyendo</button>
        <div className="typing-title"><h1>{book?.title ?? 'Cargando…'}</h1><p>Modo typing · palabra por palabra</p></div>
        <button type="button" className="btn" onClick={() => navigate('/')}>Biblioteca</button>
      </header>

      <section className="typing-controls" aria-label="Configuración de la práctica">
        <label>Teclado
          <select value={layoutId} onChange={e => setLayoutId(e.target.value as KeyboardLayoutId)} aria-label="Tipo de teclado">
            {KEYBOARD_LAYOUTS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </label>
        <label className="typing-check">
          <input type="checkbox" checked={bilingual} onChange={e => setBilingual(e.target.checked)} /> Modo bilingüe
        </label>
        <label>Idioma de apoyo
          <select value={targetLang} disabled={!bilingual} onChange={e => setTargetLang(e.target.value as StudyLang)} aria-label="Idioma de apoyo">
            {STUDY_LANGS.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </label>
        <button type="button" className="btn" onClick={resetProgress}>{resetArmed ? 'Confirmar reinicio' : 'Reiniciar libro'}</button>
        {resetArmed && <button type="button" className="btn" onClick={() => setResetArmed(false)}>Cancelar</button>}
      </section>

      <div className="typing-layout">
        <section className="typing-main">
          <div className="typing-stats" aria-label="Estadísticas en vivo">
            <span><strong>{liveStats.wpm}</strong> PPM</span>
            <span><strong>{liveStats.accuracy}%</strong> precisión</span>
            <span><strong>{acc.errors}</strong> errores</span>
            <span><strong>{bookProgress}%</strong> del libro · palabra {Math.min(wordIndex + (finished ? 0 : 1), total)} de {total}</span>
            {best && <span>Mejor puntuación: <strong>{best.score}</strong></span>}
          </div>
          <div className="typing-progressbar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={bookProgress}><span style={{ width: `${bookProgress}%` }} /></div>
          {saveError && <p className="typing-error" role="alert">{saveError}</p>}

          {!words ? (
            <p className="typing-status">Preparando el texto del libro…{extract ? ` (${extract.done}/${extract.total})` : ''}</p>
          ) : total === 0 ? (
            <p className="typing-status">Este libro no tiene texto escribible (puede ser un escaneo de imágenes).</p>
          ) : finished && !lastResult ? (
            <div className="typing-result"><h2>Libro completado</h2><p>Ya escribiste todo el texto disponible de este libro. Puedes reiniciarlo para practicar de nuevo; tus puntuaciones quedan guardadas abajo.</p></div>
          ) : (
            <div ref={stageRef} className="typing-stage" tabIndex={0} role="textbox" aria-label="Escribe la palabra resaltada con tu teclado"
              aria-describedby="typing-hint" onKeyDown={onKeyDown} onClick={focusStage}>
              <p className="typing-passage" lang="auto">
                {lessonWords.map((word, i) => {
                  const global = range.start + i
                  if (global < wordIndex) {
                    const done = committed[global] ?? ''
                    return <span key={global} className="typing-word done">{[...word].map((ch, ci) => <span key={ci} className={done[ci] === ch ? 'ok' : 'bad'}>{ch}</span>)}{done.length > word.length && <span className="bad">{done.slice(word.length)}</span>} </span>
                  }
                  if (global === wordIndex) {
                    const states = wordCharStates(word, typed)
                    return <span key={global} className="typing-word current" aria-current="true">{states.map((s, ci) => <span key={ci} className={`${s}${ci === typed.length ? ' caret' : ''}`}>{ci < word.length ? word[ci] : typed[ci]}</span>)}{typed.length >= word.length && <span className="caret-end" aria-hidden="true" />} </span>
                  }
                  return <span key={global} className="typing-word">{word} </span>
                })}
              </p>
              <p id="typing-hint" className="typing-hint">
                {currentWord ? <>Palabra actual: <strong>{currentWord}</strong>{fingerHint(nextChar ?? '', layout) ? <> · siguiente tecla con el dedo {fingerHint(nextChar ?? '', layout)}</> : null} · Espacio confirma la palabra · Retroceso corrige</> : '…'}
              </p>
              {bilingual && (
                <div className="typing-bilingual" aria-label="Apoyo bilingüe">
                  {gloss && currentWord && <p className="typing-gloss"><strong>{currentWord}</strong> → {gloss} <span>({STUDY_LANGS.find(l => l.code === targetLang)?.label})</span></p>}
                  {lessonTranslation && <p className="typing-translation">{lessonTranslation}</p>}
                  {transError && <p className="typing-error">{transError}</p>}
                </div>
              )}
            </div>
          )}

          {lastResult && (
            <div className="typing-result" role="alertdialog" aria-label="Resultado de la lección">
              <h2>Lección completada</h2>
              <p><strong>{lastResult.wpm} PPM</strong> · <strong>{lastResult.accuracy}%</strong> de precisión · <strong>{lastResult.score} puntos</strong> · {lastResult.errors} errores</p>
              <button type="button" className="btn btn-primary" onClick={() => { setLastResult(null); focusStage() }}>{finished ? 'Ver libro completado' : 'Siguiente lección'}</button>
            </div>
          )}

          <TypingKeyboard layout={layout} nextChar={lastResult ? null : nextChar} pressedKey={pressed} />
          <p className="typing-note">Lecciones de {LESSON_WORDS} palabras. El progreso se guarda automáticamente en tu cuenta, por libro, y se retoma donde lo dejaste.</p>
        </section>

        <aside className="typing-scores" aria-label="Puntuaciones de este libro">
          <h2>Puntuaciones · este libro</h2>
          {scores.length === 0 ? <p className="typing-status">Todavía no hay lecciones completadas en este libro.</p> : (
            <ol>{scores.slice(0, 10).map(s => (
              <li key={s.id}><strong>{s.score} pts</strong><span>{s.wpm} PPM · {s.accuracy}% · {s.words_completed} palabras</span><span>{new Date(s.created_at).toLocaleDateString()} · {KEYBOARD_LAYOUTS.find(l => l.id === s.keyboard_layout)?.label ?? s.keyboard_layout}{s.bilingual ? ` · ${s.target_lang.toUpperCase()}` : ''}</span></li>
            ))}</ol>
          )}
        </aside>
      </div>
    </main>
  )
}

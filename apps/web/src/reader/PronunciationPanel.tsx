// apps/web/src/reader/PronunciationPanel.tsx — pronunciación por bloques:
// escucha el bloque en el idioma original, en el de estudio o en ambos
// seguidos, con la voz gratuita del navegador, y muestra la guía fonética
// de referencia de cómo debería pronunciarse. Solo vista por bloques.
import { useEffect, useRef, useState } from 'react'
import {
  defaultOriginalLang, isSpeechSupported, pronunciationGuide, pronunciationNote,
  speakParts, stopSpeaking,
} from '../lib/pronunciation'
import { STUDY_LANGS, studyLangLabel, type StudyLang } from '../lib/study'

type Speaking = 'idle' | 'orig' | 'trans' | 'both'

export default function PronunciationPanel({ originalText, translatedText, targetLang }: {
  originalText: string
  translatedText: string | null
  targetLang: StudyLang
}) {
  const [originalLang, setOriginalLang] = useState<StudyLang>(() => defaultOriginalLang(targetLang))
  const [speaking, setSpeaking] = useState<Speaking>('idle')
  const [showGuide, setShowGuide] = useState(false)
  const supported = isSpeechSupported()
  const runRef = useRef(0)

  // Al cambiar de bloque o desmontar, la voz se detiene: nunca lee el anterior.
  useEffect(() => {
    setSpeaking('idle')
    setShowGuide(false)
    stopSpeaking()
    return () => stopSpeaking()
  }, [originalText, translatedText])

  const listen = (mode: Exclude<Speaking, 'idle'>) => {
    if (!supported) return
    const parts = mode === 'orig'
      ? [{ text: originalText, lang: originalLang }]
      : mode === 'trans'
        ? (translatedText ? [{ text: translatedText, lang: targetLang }] : [])
        : [
            { text: originalText, lang: originalLang },
            ...(translatedText ? [{ text: translatedText, lang: targetLang }] : []),
          ]
    if (parts.length === 0) return
    const run = ++runRef.current
    setSpeaking(mode)
    void speakParts(parts).finally(() => {
      if (run === runRef.current) setSpeaking('idle')
    })
  }

  const stop = () => {
    runRef.current++
    stopSpeaking()
    setSpeaking('idle')
  }

  const origGuide = pronunciationGuide(originalText, originalLang)
  const transGuide = translatedText ? pronunciationGuide(translatedText, targetLang) : null

  return (
    <section className="pron-panel" aria-label="Pronunciación del bloque">
      <div className="pron-head">
        <h2>Pronunciación</h2>
        <label className="pron-lang">
          Original
          <select aria-label="Idioma del texto original" value={originalLang}
            onChange={e => setOriginalLang(e.target.value as StudyLang)}>
            {STUDY_LANGS.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </label>
      </div>

      {!supported && (
        <p className="pron-note">
          Tu navegador no trae voz integrada para leer en voz alta. La guía de
          pronunciación de abajo sigue disponible sin costo.
        </p>
      )}

      {supported && (
        <div className="pron-actions">
          <button type="button" className="reader-tool" disabled={speaking !== 'idle'}
            onClick={() => listen('orig')}>
            {speaking === 'orig' ? 'Leyendo original…' : `Escuchar original (${studyLangLabel(originalLang)})`}
          </button>
          {translatedText && (
            <button type="button" className="reader-tool" disabled={speaking !== 'idle'}
              onClick={() => listen('trans')}>
              {speaking === 'trans' ? 'Leyendo traducción…' : `Escuchar traducción (${studyLangLabel(targetLang)})`}
            </button>
          )}
          {translatedText && (
            <button type="button" className="reader-tool" disabled={speaking !== 'idle'}
              onClick={() => listen('both')}>
              {speaking === 'both' ? 'Leyendo ambos…' : 'Escuchar ambos'}
            </button>
          )}
          {speaking !== 'idle' && (
            <button type="button" className="reader-tool" onClick={stop}>Detener</button>
          )}
        </div>
      )}

      <button type="button" className="reader-tool pron-guide-toggle" aria-expanded={showGuide}
        onClick={() => setShowGuide(v => !v)}>
        {showGuide ? 'Ocultar cómo se pronuncia' : 'Cómo se pronuncia'}
      </button>

      {showGuide && (
        <div className="pron-guides">
          <div className="pron-guide">
            <h3>Original · {studyLangLabel(originalLang)}</h3>
            <p className="pron-guide-text" lang={originalLang}>{origGuide.guide}</p>
            <p className="pron-note">{pronunciationNote(originalLang)}</p>
            {origGuide.truncated && (
              <p className="pron-note">Guía de las primeras palabras ({origGuide.totalWords} en el bloque).</p>
            )}
          </div>
          {transGuide && (
            <div className="pron-guide">
              <h3>Traducción · {studyLangLabel(targetLang)}</h3>
              <p className="pron-guide-text" lang={targetLang}>{transGuide.guide}</p>
              <p className="pron-note">{pronunciationNote(targetLang)}</p>
              {transGuide.truncated && (
                <p className="pron-note">Guía de las primeras palabras ({transGuide.totalWords} en el bloque).</p>
              )}
            </div>
          )}
          <p className="pron-note">
            Referencia aproximada para practicar estilo estudio: escucha el
            bloque, repite en voz alta y compara con la guía.
          </p>
        </div>
      )}
    </section>
  )
}

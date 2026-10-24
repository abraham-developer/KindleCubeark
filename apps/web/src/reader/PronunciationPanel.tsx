// apps/web/src/reader/PronunciationPanel.tsx — pronunciación por bloques:
// escucha el bloque en el idioma original, en el de estudio o en ambos
// seguidos, con la voz gratuita del navegador, y muestra la guía fonética
// de referencia de cómo debería pronunciarse. Solo vista por bloques.
import { useEffect, useRef, useState } from 'react'
import {
  defaultOriginalLang, getSpeechVoices, hasSpeechVoice, isSpeechSupported,
  pronunciationGuide, pronunciationNote, speakParts, stopSpeaking,
} from '../lib/pronunciation'
import { studyLangLabel, type StudyLang } from '../lib/study'

type Speaking = 'idle' | 'orig' | 'trans' | 'both'

export default function PronunciationPanel({ originalText, translatedText, targetLang }: {
  originalText: string
  translatedText: string | null
  targetLang: StudyLang
}) {
  // Sin selector propio: la pareja sale del modo bilingüe (original por
  // defecto y el idioma de traducción ya elegido en la barra de estudio).
  const originalLang = defaultOriginalLang(targetLang)
  const [speaking, setSpeaking] = useState<Speaking>('idle')
  const [showGuide, setShowGuide] = useState(false)
  const [voiceCount, setVoiceCount] = useState(() => getSpeechVoices().length)
  const supported = isSpeechSupported()
  const runRef = useRef(0)

  // Las voces del sistema cargan asíncrono: se refresca el aviso al llegar.
  useEffect(() => {
    if (!supported) return
    const synth = window.speechSynthesis
    const refresh = () => setVoiceCount(getSpeechVoices().length)
    refresh()
    synth.addEventListener?.('voiceschanged', refresh)
    return () => synth.removeEventListener?.('voiceschanged', refresh)
  }, [supported])

  // Sin voz para un idioma el navegador «lee» en silencio y termina al
  // instante: mejor avisarlo que dejar el botón como si no hiciera nada.
  const missingVoice = supported && voiceCount > 0
    ? (!hasSpeechVoice(originalLang) ? originalLang : (translatedText && !hasSpeechVoice(targetLang) ? targetLang : null))
    : null

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
        <span className="pron-note">
          Original · {studyLangLabel(originalLang)} — Traducción · {studyLangLabel(targetLang)}
        </span>
      </div>

      {!supported && (
        <p className="pron-note">
          Tu navegador no trae voz integrada para leer en voz alta. La guía de
          pronunciación de abajo sigue disponible sin costo.
        </p>
      )}

      {supported && voiceCount === 0 && (
        <p className="pron-note" role="status">
          No se detectó ninguna voz instalada en tu navegador o sistema: el
          botón leerá en silencio. En Linux suele faltar el motor de voz
          (p. ej. espeak-ng) o las voces del idioma; en Android y Windows
          Chrome ya las trae. La guía escrita de abajo sí funciona.
        </p>
      )}

      {missingVoice && (
        <p className="pron-note" role="status">
          No hay una voz en {studyLangLabel(missingVoice)} instalada en tu
          navegador o sistema: ese idioma se leerá en silencio. Instala la
          voz del idioma o pruébalo en Chrome de Android/Windows. La guía
          escrita de abajo sí funciona.
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

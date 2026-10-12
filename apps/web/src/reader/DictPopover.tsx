// apps/web/src/reader/DictPopover.tsx — significado por pulsación larga:
// popover anclado al punto con acepciones del Wikcionario. Se cierra al
// tocar fuera, con Escape o con el siguiente tap sobre el lector.
import { useEffect, useRef } from 'react'
import type { DictEntry } from '../lib/dictionary'

type Props = {
  x: number
  y: number
  word: string
  entry: DictEntry | null
  /** Segunda acepción (modo estudio bilingüe: español + inglés). */
  entry2?: DictEntry | null
  loading: boolean
  error: string | null
  onRetry: () => void
  onClose: () => void
}

function langLabel(lang: DictEntry['lang']): string {
  return lang === 'es' ? 'Español' : 'English'
}

function EntrySenses({ entry }: { entry: DictEntry }) {
  return (
    <>
      {entry.pos && <p className="dict-pos">{entry.pos}</p>}
      <ol>
        {entry.senses.map((sense, i) => (
          <li key={i}>
            {sense.definition}
            {sense.example && <span className="dict-example">«{sense.example}»</span>}
          </li>
        ))}
      </ol>
    </>
  )
}

export default function DictPopover({ x, y, word, entry, entry2, loading, error, onRetry, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // anclado al punto, volteado hacia arriba si cae en la mitad inferior
  const vw = window.innerWidth
  const vh = window.innerHeight
  const popW = Math.min(320, vw - 24)
  const left = Math.max(12, Math.min(x - popW / 2, vw - popW - 12))
  const above = y > vh * 0.55
  const style = above
    ? { left, bottom: Math.max(12, vh - y + 12) }
    : { left, top: y + 12 }

  return (
    <div ref={ref} className="dict-popover" style={style} role="dialog" aria-label={`Significado de ${word}`}>
      <div className="dict-head">
        <p className="dict-word">{entry?.word ?? word}</p>
        {entry && <span className="dict-lang">{langLabel(entry.lang)}</span>}
        {entry2 && <span className="dict-lang">{langLabel(entry2.lang)}</span>}
        <button type="button" className="dict-close" aria-label="Cerrar diccionario" onClick={onClose}>
          ×
        </button>
      </div>
      {loading && <p className="dict-status">Buscando…</p>}
      {error && (
        <>
          <p role="alert" className="dict-error">{error}</p>
          <button type="button" className="reader-tool" onClick={onRetry}>Reintentar</button>
        </>
      )}
      {entry && <EntrySenses entry={entry} />}
      {entry2 && (
        <div className="dict-alt">
          <EntrySenses entry={entry2} />
        </div>
      )}
    </div>
  )
}

// apps/web/src/reader/AnnotationsPanel.tsx — panel "Mis anotaciones" (Task 14):
// lista del libro en orden de lectura (positionSortKey + created_at/id de
// desempate, igual que el server), excluye los marcadores (color 'bookmark'),
// salta a la posición con onJump y borra con confirmación inline.
import { useEffect, useState } from 'react'
import { api, type Annotation } from '../api'
import { positionSortKey } from '../lib/positionSortKey'

type Props = {
  bookId: string
  /** Formato del libro: elige la clave de orden (página vs CFI). */
  format?: 'pdf' | 'epub'
  onJump: (position: any) => void
  onClose: () => void
}

/** Deducir el formato de las posiciones si el lector no lo pasa. */
function inferFormat(rows: Annotation[]): 'pdf' | 'epub' {
  return rows.some(a => a.position && typeof a.position === 'object' && 'page' in a.position)
    ? 'pdf'
    : 'epub'
}

/** Orden de lectura: clave de posición + created_at + id (como el server). */
function sortAnnotations(rows: Annotation[], format: 'pdf' | 'epub'): Annotation[] {
  return rows.slice().sort((a, b) => {
    const ka = positionSortKey(a.position, format)
    const kb = positionSortKey(b.position, format)
    if (ka !== kb) return ka < kb ? -1 : 1
    const ta = new Date(a.created_at).getTime()
    const tb = new Date(b.created_at).getTime()
    if (ta !== tb) return ta < tb ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

export default function AnnotationsPanel({ bookId, format, onJump, onClose }: Props) {
  const [items, setItems] = useState<Annotation[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api.listAnnotations(bookId)
      .then(rows => {
        if (!alive) return
        const fmt = format ?? inferFormat(rows)
        // los marcadores no aparecen en el panel (se ven como cinta en el libro)
        setItems(sortAnnotations(rows.filter(a => a.color !== 'bookmark'), fmt))
      })
      .catch(() => { if (alive) setError('No se pudieron cargar las anotaciones') })
    return () => { alive = false }
  }, [bookId, format])

  const remove = async (annotation: Annotation) => {
    try {
      await api.deleteAnnotation(annotation.id)
      setItems(list => (list ? list.filter(a => a.id !== annotation.id) : list))
    } catch {
      setError('No se pudo borrar la anotación')
    }
    setConfirmId(null)
  }

  return (
    <section className="annotations-panel" role="region" aria-label="Mis anotaciones">
      <header className="annotations-head">
        <h2>Mis anotaciones</h2>
        <button type="button" className="reader-tool" aria-label="Cerrar anotaciones" onClick={onClose}>×</button>
      </header>

      {error && <p className="annotations-error" role="alert">{error}</p>}
      {!error && items === null && <p className="annotations-empty">Cargando…</p>}
      {items !== null && items.length === 0 && !error && (
        <p className="annotations-empty">Todavía no hay anotaciones</p>
      )}

      <ul aria-label="Anotaciones">
        {(items ?? []).map(annotation => (
          <li key={annotation.id} className="annotation-item">
            <span className={`dot ${annotation.color}`} aria-hidden="true" />
            {annotation.quoted_text && <p className="annotation-quote">{annotation.quoted_text}</p>}
            {annotation.note && <p className="annotation-note">{annotation.note}</p>}
            <div className="annotation-actions">
              <button type="button" className="reader-tool"
                onClick={() => onJump(annotation.position)}>
                Ir
              </button>
              {confirmId === annotation.id ? (
                <>
                  <span className="annotation-confirm">¿Borrar esta anotación?</span>
                  <button type="button" className="reader-tool annotations-danger"
                    onClick={() => void remove(annotation)}>
                    Sí, borrar
                  </button>
                  <button type="button" className="reader-tool" onClick={() => setConfirmId(null)}>
                    Cancelar
                  </button>
                </>
              ) : (
                <button type="button" className="reader-tool annotations-danger"
                  onClick={() => setConfirmId(annotation.id)}>
                  Borrar
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
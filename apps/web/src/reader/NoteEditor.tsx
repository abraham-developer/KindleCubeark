// apps/web/src/reader/NoteEditor.tsx — editor de nota (Task 14): popover con
// textarea para crear o editar la nota de una anotación. Guardar entrega el
// texto recortado (vacío no guarda); cancelar no toca nada.
import { useEffect, useRef, useState } from 'react'

type Props = {
  heading: string
  initialNote?: string
  quotedText?: string
  onSave: (note: string) => void
  onCancel: () => void
}

export default function NoteEditor({ heading, initialNote = '', quotedText, onSave, onCancel }: Props) {
  const [text, setText] = useState(initialNote)
  const areaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => { areaRef.current?.focus() }, [])

  const trimmed = text.trim()

  return (
    <div className="note-editor" role="dialog" aria-label={heading}>
      <p className="note-heading">{heading}</p>
      {quotedText ? <p className="note-quoted">“{quotedText}”</p> : null}
      <textarea ref={areaRef} rows={4} aria-label="Nota" value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape') onCancel() }} />
      <div className="note-actions">
        <button type="button" className="reader-tool" onClick={onCancel}>Cancelar</button>
        <button type="button" className="reader-tool note-save" disabled={!trimmed}
          onClick={() => onSave(trimmed)}>
          Guardar
        </button>
      </div>
    </div>
  )
}
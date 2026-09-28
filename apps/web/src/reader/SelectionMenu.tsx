// apps/web/src/reader/SelectionMenu.tsx — menú flotante sobre una selección de
// texto (Tasks 14): resaltado en 4 colores + "Nota". Se cierra al tocar fuera
// o con Escape; el mousedown sobre el menú no limpia la selección (el usuario
// puede seguir anotando el mismo rango).
import { useEffect, useRef } from 'react'

export type HighlightColor = 'yellow' | 'gray' | 'pink' | 'blue'

/** Colores del enum del server, en el orden del menú. */
export const HIGHLIGHT_COLORS: { key: HighlightColor; label: string }[] = [
  { key: 'yellow', label: 'amarillo' },
  { key: 'gray', label: 'gris' },
  { key: 'pink', label: 'rosa' },
  { key: 'blue', label: 'azul' },
]

/** Relleno translúcido de cada color (overlays del PDF y panel). */
export const HIGHLIGHT_FILL: Record<HighlightColor, string> = {
  yellow: 'rgba(255, 202, 44, .45)',
  gray: 'rgba(120, 120, 120, .38)',
  pink: 'rgba(255, 128, 171, .45)',
  blue: 'rgba(120, 180, 255, .45)',
}

type Props = {
  x: number
  y: number
  onSelect: (color: HighlightColor) => void
  onNote: () => void
  onClose: () => void
}

export default function SelectionMenu({ x, y, onSelect, onNote, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null)

  // cerrar al tocar fuera (mousedown/touchstart en capture) y con Escape
  useEffect(() => {
    const onDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node | null
      if (target && ref.current && !ref.current.contains(target)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('touchstart', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('touchstart', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // anclado con clamp para no salirse del viewport
  const left = Math.max(8, Math.min(x, (window.innerWidth || 800) - 190))
  const top = Math.max(8, Math.min(y, (window.innerHeight || 600) - 48))

  return (
    <div ref={ref} className="selection-menu" style={{ left, top }} onMouseDown={e => e.preventDefault()}>
      {HIGHLIGHT_COLORS.map(color => (
        <button key={color.key} type="button" aria-label={color.label}
          onClick={() => onSelect(color.key)}>
          <span className={`dot ${color.key}`} aria-hidden="true" />
        </button>
      ))}
      <span className="selection-sep" aria-hidden="true" />
      <button type="button" className="selection-note" onClick={onNote}>
        Nota
      </button>
    </div>
  )
}
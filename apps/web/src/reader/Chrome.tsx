// apps/web/src/reader/Chrome.tsx — topbar/bottombar compartidos por los
// lectores (Tasks 13–14): título + volver + modo noche, marcador de página
// (cinta), botón de notas (panel) y nota de página, y slider de salto,
// etiqueta «pág. N de M», porcentaje y ajuste de página/ancho.
export function TopBar({
  title,
  onBack,
  night,
  onToggleNight,
  onNotes,
  onPageNote,
}: {
  title: string
  onBack: () => void
  night: boolean
  onToggleNight: () => void
  /** Abre el panel «Mis anotaciones» (ambos lectores). */
  onNotes?: () => void
  /** Nueva nota de página (solo PDF, funciona también en escaneados). */
  onPageNote?: () => void
}) {
  return (
    <header className="reader-top">
      <button type="button" className="reader-back" onClick={onBack} aria-label="Volver a la biblioteca">
        ‹ Biblioteca
      </button>
      <h1 className="reader-title">{title}</h1>
      {onPageNote && (
        <button type="button" className="reader-tool" onClick={onPageNote} aria-label="Nueva nota de página">
          Nota
        </button>
      )}
      {onNotes && (
        <button type="button" className="reader-tool" onClick={onNotes} aria-label="Mis anotaciones">
          Notas
        </button>
      )}
      <button type="button" className="reader-tool" onClick={onToggleNight} aria-pressed={night}>
        {night ? 'Modo día' : 'Modo noche'}
      </button>
    </header>
  )
}

/** Cinta del marcador: esquina superior derecha, curva hacia adentro al marcar. */
export function BookmarkButton({ marked, onToggle }: { marked: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`bookmark-ribbon${marked ? ' marked' : ''}`}
      aria-pressed={marked}
      aria-label={marked ? 'Quitar marcador' : 'Marcar página'}
      onClick={onToggle}
    />
  )
}

export function BottomBar({
  page,
  numPages,
  percent,
  label,
  fit,
  onToggleFit,
  onSliderJump,
}: {
  page: number
  numPages: number
  percent: number
  label: string
  fit: 'page' | 'width'
  onToggleFit: () => void
  onSliderJump: (page: number) => void
}) {
  return (
    <footer className="reader-bottom">
      <button type="button" className="reader-tool" onClick={onToggleFit}>
        {fit === 'page' ? 'Ajustar: página' : 'Ajustar: ancho'}
      </button>
      <input
        type="range"
        className="reader-slider"
        min={1}
        max={Math.max(numPages, 1)}
        value={Math.min(Math.max(page, 1), Math.max(numPages, 1))}
        aria-label="Ir a página"
        onChange={e => onSliderJump(Number(e.target.value))}
      />
      <span className="reader-label">{label}</span>
      <span className="reader-pct">{Math.round(percent)}%</span>
    </footer>
  )
}

/** Combinación de ambas barras, lista para montarse dentro del lector. */
export default function ReaderChrome(props: React.ComponentProps<typeof TopBar> & {
  page: number
  numPages: number
  percent: number
  label: string
  fit: 'page' | 'width'
  onToggleFit: () => void
  onSliderJump: (page: number) => void
}) {
  const { title, onBack, night, onToggleNight, onNotes, onPageNote, ...bottom } = props
  return (
    <>
      <TopBar title={title} onBack={onBack} night={night} onToggleNight={onToggleNight} onNotes={onNotes} onPageNote={onPageNote} />
      <BottomBar {...bottom} />
    </>
  )
}
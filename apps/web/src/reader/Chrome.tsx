// apps/web/src/reader/Chrome.tsx — topbar/bottombar compartidos por los
// lectores (Tasks 13–14): título + volver + modo noche, y slider de salto,
// etiqueta «pág. N de M», porcentaje y ajuste de página/ancho.
export function TopBar({
  title,
  onBack,
  night,
  onToggleNight,
}: {
  title: string
  onBack: () => void
  night: boolean
  onToggleNight: () => void
}) {
  return (
    <header className="reader-top">
      <button type="button" className="reader-back" onClick={onBack} aria-label="Volver a la biblioteca">
        ‹ Biblioteca
      </button>
      <h1 className="reader-title">{title}</h1>
      <button type="button" className="reader-tool" onClick={onToggleNight} aria-pressed={night}>
        {night ? 'Modo día' : 'Modo noche'}
      </button>
    </header>
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
  const { title, onBack, night, onToggleNight, ...bottom } = props
  return (
    <>
      <TopBar title={title} onBack={onBack} night={night} onToggleNight={onToggleNight} />
      <BottomBar {...bottom} />
    </>
  )
}
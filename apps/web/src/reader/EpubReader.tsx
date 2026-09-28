// apps/web/src/reader/EpubReader.tsx — lector EPUB sobre epub.js: retomar por
// CFI guardado (sin flash a la página 1), guardado del progreso al «relocated»,
// navegación con zonas de tap / teclado / swipe, panel Aa (tamaño, interlineado,
// tipografía, día/noche) y slider por porcentaje (Task 13).
import { useCallback, useEffect, useRef, useState } from 'react'
import ePub, { type Book as EpubBook, type Location, type NavItem, type Rendition } from 'epubjs'
import { type Book, type Position } from '../api'
import { useProgressSync } from '../lib/progressSync'
import { TopBar } from './Chrome'
import AaPanel, { fontFamilyStack, loadSettings, type ReaderSettings } from './AaPanel'

type ReaderProgress = { position: Position; percent: string | number } | null

type Props = {
  book: Book
  progress: ReaderProgress
  onBack: () => void
}

function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg || 'Error inesperado'
}

/** CFI guardado, si el progreso del libro es de tipo EPUB (posición = CFI). */
function savedCfi(progress: ReaderProgress): string | undefined {
  const position = progress?.position
  return position && 'cfi' in position ? position.cfi : undefined
}

/** Aplica los ajustes de lectura al rendition (tamaño, tema, interlineado, fuente). */
function applySettings(rendition: Rendition, settings: ReaderSettings): void {
  rendition.themes.register('day', { body: { background: '#F8F1E1', color: '#2B2A26' } })
  rendition.themes.register('night', { body: { background: '#141414', color: '#C9C4B8' } })
  rendition.themes.select(settings.theme === 'night' ? 'night' : 'day')
  rendition.themes.fontSize(`${settings.fontSize}px`)
  rendition.themes.override('line-height', String(settings.lineHeight))
  rendition.themes.font(fontFamilyStack(settings.fontFamily))
}

/** Título del ítem del índice al que pertenece el href, si se encuentra barato. */
function tocTitle(navigation: { toc?: NavItem[] } | undefined, href?: string): string | null {
  if (!href || !navigation?.toc) return null
  const item = navigation.toc.find(t => href === t.href || href.endsWith(t.href) || t.href.endsWith(href))
  return item?.label ?? null
}

export default function EpubReader({ book, progress, onBack }: Props) {
  const [settings, setSettings] = useState<ReaderSettings>(() => loadSettings())
  const [chromeVisible, setChromeVisible] = useState(false) // inmersivo por defecto
  const [aaOpen, setAaOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [percent, setPercent] = useState(() => Number(progress?.percent ?? 0))
  const [chapter, setChapter] = useState<string | null>(null)

  const hostRef = useRef<HTMLDivElement | null>(null)
  const bookRef = useRef<EpubBook | null>(null)
  const renditionRef = useRef<Rendition | null>(null)
  const settingsRef = useRef(settings)
  const touchStart = useRef<{ x: number; y: number; t: number } | null>(null)
  const swipedAt = useRef(0)
  // El primer relocated tras el mount es el eco del propio display() de
  // resume: guardarlo re-escribiría en el server la posición recién cargada
  // (y con locations aún sin generar, el percent puede divergir del guardado).
  const firstRelocatedRef = useRef(true)
  // Timestamp del último arrastre del slider: mientras sigue vivo, el
  // relocated del salto no pisa el percent local que ve el usuario.
  const sliderMovedAt = useRef(0)

  const sync = useProgressSync(book.id)

  // Ref de ajustes para los callbacks/effect que no deben recrearse por cambio.
  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  const night = settings.theme === 'night'

  const onRelocated = useCallback((location?: Location) => {
    const start = location?.start
    if (!start) return
    const pct = Math.round((start.percentage ?? 0) * 1000) / 10
    // durante (y justo después de) un arrastre del slider, el percent que
    // pinta la barra lo manda el usuario, no el relocated del salto
    if (Date.now() - sliderMovedAt.current > 500) setPercent(pct)
    setChapter(tocTitle(bookRef.current?.navigation as { toc?: NavItem[] } | undefined, start.href))
    if (firstRelocatedRef.current) {
      firstRelocatedRef.current = false // eco del resume: no re-guarda
      return
    }
    sync.save({ cfi: start.cfi, percent: pct, section: start.index }, pct)
  }, [sync])

  // ── Carga del libro: renderTo + retomar por CFI antes de mostrar ────────
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    firstRelocatedRef.current = true // el eco del resume pertenece a este libro

    // epubjs tipa requestCredentials como «object», pero en runtime es un
    // boolean (xhr.withCredentials, para la cookie de sesión): se castea.
    const epubOptions = { requestCredentials: true } as never
    const epubBook = ePub(book.file_url, epubOptions)
    bookRef.current = epubBook
    const rendition = epubBook.renderTo(host, {
      width: '100%',
      height: '100%',
      spread: 'none', // una sola columna
      flow: 'paginated',
    })
    renditionRef.current = rendition
    applySettings(rendition, settingsRef.current)
    rendition.on('relocated', onRelocated)

    // Retomar: si hay CFI guardado se muestra ése; si no, el inicio.
    const target = savedCfi(progress)
    void (target ? rendition.display(target) : rendition.display())
      .then(() => { if (!cancelled) setLoading(false) })
      .catch(err => { if (!cancelled) { setLoadError(`No se pudo abrir el EPUB: ${errorMessage(err)}`); setLoading(false) } })

    // locations en segundo plano: habilita el salto exacto por porcentaje.
    void epubBook.ready
      .then(() => { if (!cancelled) return epubBook.locations.generate(1024) })
      .catch(() => { /* sin locations el slider cae al fallback por sección */ })

    return () => {
      cancelled = true
      renditionRef.current = null
      bookRef.current = null
      try { rendition.destroy() } catch { /* ya destruido */ }
      try { epubBook.destroy() } catch { /* ya destruido */ }
    }
  }, [book.file_url, book.id, onRelocated, progress])

  // ── Ajustes de lectura → rendition (también tras recargar el rendition) ──
  useEffect(() => {
    const rendition = renditionRef.current
    if (rendition) applySettings(rendition, settings)
  }, [settings, loading])

  // ── Modo noche global: las barras de chrome siguen el mismo tema ────────
  // En día no se fuerza tema global (igual que el lector PDF): sólo se marca
  // la noche, y al salir del modo —o del lector— se restaura el de la app.
  useEffect(() => {
    if (settings.theme === 'night') {
      document.documentElement.dataset.theme = 'dark'
    } else {
      document.documentElement.removeAttribute('data-theme')
    }
    return () => { document.documentElement.removeAttribute('data-theme') }
  }, [settings.theme])

  // ── Vuelta de página con fade en modo noche (columna epub.js en día) ────
  const animateTurn = useCallback((dir: 'next' | 'prev') => {
    if (settingsRef.current.theme !== 'night') return
    const host = hostRef.current
    if (!host) return
    host.classList.remove('epub-turn-next', 'epub-turn-prev')
    void host.offsetWidth // reinicia la animación CSS
    host.classList.add(dir === 'next' ? 'epub-turn-next' : 'epub-turn-prev')
  }, [])

  const turnNext = useCallback(() => {
    animateTurn('next')
    void renditionRef.current?.next()
  }, [animateTurn])

  const turnPrev = useCallback(() => {
    animateTurn('prev')
    void renditionRef.current?.prev()
  }, [animateTurn])

  const jumpToPercent = useCallback((value: number) => {
    const epubBook = bookRef.current
    const rendition = renditionRef.current
    if (!epubBook || !rendition) return
    const frac = Math.max(0, Math.min(100, value)) / 100
    // locations tiene «length» en runtime (epubjs no lo tipa)
    const locCount = (epubBook.locations as (typeof epubBook.locations & { length?: unknown }) | undefined)
    if (locCount && typeof locCount.length === 'function' && locCount.length() > 0) {
      void rendition.display(locCount.cfiFromPercentage(frac))
    } else {
      const spineLength = (epubBook.spine as unknown as { length?: number }).length
      if (spineLength) {
        // fallback sin locations: salta a la sección proporcional
        void rendition.display(Math.min(spineLength - 1, Math.floor(frac * spineLength)))
      }
    }
  }, [])

  // ── Teclado ←/→/espacio/PageUp/PageDown (mismo guard que el lector PDF) ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      // si el foco está en un control (slider, botón, input…), sus teclas
      // operan el control: ←/→ mueven el slider y espacio activa el botón
      const target = e.target as HTMLElement | null
      if (target?.closest?.('input, textarea, button, select, [role=slider], [role=menu]')) return
      switch (e.key) {
        case 'ArrowRight':
        case 'PageDown':
        case ' ':
          e.preventDefault()
          turnNext()
          break
        case 'ArrowLeft':
        case 'PageUp':
          e.preventDefault()
          turnPrev()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [turnNext, turnPrev])

  // ── Swipe horizontal (flick más corto que arrastre, como en el PDF) ─────
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.changedTouches[0]
    if (t) touchStart.current = { x: t.clientX, y: t.clientY, t: Date.now() }
  }
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchStart.current
    touchStart.current = null
    if (!start) return
    const t = e.changedTouches[0]
    const dx = t.clientX - start.x
    const dy = t.clientY - start.y
    const dt = Date.now() - start.t
    const threshold = dt < 220 ? 36 : 70
    if (Math.abs(dx) > threshold && Math.abs(dx) > Math.abs(dy) * 1.2) {
      swipedAt.current = Date.now()
      if (dx < 0) turnNext(); else turnPrev()
    }
  }

  // Un tap sobre una zona justo después de un swipe no repite la vuelta.
  const guardSwipe = (fn: () => void) => () => {
    if (Date.now() - swipedAt.current < 400) return
    fn()
  }

  const shownPercent = Math.max(0, Math.min(100, percent))

  return (
    <div className="reader" data-night={night || undefined}>
      {chromeVisible && (
        <TopBar
          title={book.title}
          onBack={onBack}
          night={night}
          onToggleNight={() => setSettings(s => ({ ...s, theme: s.theme === 'night' ? 'day' : 'night' }))}
        />
      )}

      <div className="reader-stage" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <div ref={hostRef} className="epub-host" aria-label="Contenido del libro" />

        {loading && !loadError && <div className="reader-loading">Cargando…</div>}
        {loadError && <p role="alert" className="lib-alert reader-error">{loadError}</p>}

        {/* Zonas de tap: 40 % izquierda (anterior), 20 % centro (controles), 40 % derecha (siguiente) */}
        <button type="button" className="reader-zone left" aria-label="Página anterior"
          onClick={guardSwipe(turnPrev)} />
        <button type="button" className="reader-zone center"
          aria-label={chromeVisible ? 'Ocultar controles' : 'Mostrar controles'}
          onClick={guardSwipe(() => setChromeVisible(v => !v))} />
        <button type="button" className="reader-zone right" aria-label="Página siguiente"
          onClick={guardSwipe(turnNext)} />
      </div>

      {chromeVisible && (
        <footer className="reader-bottom epub" role="contentinfo">
          <button type="button" className="reader-tool" aria-expanded={aaOpen}
            aria-controls="aa-panel"
            onClick={() => setAaOpen(v => !v)}>
            Aa
          </button>
          <input
            type="range"
            className="reader-slider"
            min={0}
            max={100}
            step={0.1}
            value={shownPercent}
            aria-label="Ir a posición"
            onChange={e => {
              const value = Number(e.target.value)
              sliderMovedAt.current = Date.now() // el salto manda sobre el relocated
              setPercent(value)
              jumpToPercent(value)
            }}
          />
          <span className="reader-label">{chapter ?? ''}</span>
          <span className="reader-pct">{Math.round(shownPercent)}%</span>
        </footer>
      )}

      {chromeVisible && aaOpen && (
        <div id="aa-panel" className="aa-anchor">
          <AaPanel settings={settings} onChange={setSettings} />
        </div>
      )}
    </div>
  )
}

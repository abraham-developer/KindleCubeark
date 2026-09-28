// apps/web/src/reader/PdfReader.tsx — lector PDF (pdf.js): render de página,
// volteo con animación, zonas de tap, teclado, swipe, ajuste página/ancho,
// modo noche (filtro CSS) y progreso sincronizado (Task 12).
import { useCallback, useEffect, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { type Book, type Position } from '../api'
import { useProgressSync } from '../lib/progressSync'
import PageTurn from './PageTurn'
import { TopBar, BottomBar } from './Chrome'

GlobalWorkerOptions.workerSrc = workerUrl

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

/** Página inicial del progreso guardado, antes del primer render (sin flash a la 1). */
function initialPage(book: Book, progress: ReaderProgress): number {
  const saved = progress?.position && 'page' in progress.position ? progress.position.page : 1
  const max = book.total_pages ?? saved
  return Math.max(1, Math.min(saved, max))
}

export default function PdfReader({ book, progress, onBack }: Props) {
  const [numPages, setNumPages] = useState(0)
  const [page, setPage] = useState(() => initialPage(book, progress))
  const [direction, setDirection] = useState<'next' | 'prev'>('next')
  const [fit, setFit] = useState<'page' | 'width'>('page')
  const [night, setNight] = useState(false)
  const [chromeVisible, setChromeVisible] = useState(false) // inmersivo por defecto
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const stageRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const docRef = useRef<PDFDocumentProxy | null>(null)
  const renderToken = useRef(0)
  const lastSaved = useRef<number | null>(page)
  const touchStart = useRef<{ x: number; y: number; t: number } | null>(null)
  const swipedAt = useRef(0)

  const sync = useProgressSync(book.id)

  // ── Carga del documento ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    docRef.current = null
    setLoading(true)
    const task = getDocument({ url: book.file_url })
    task.promise
      .then(doc => {
        if (cancelled) { void doc.destroy(); return }
        docRef.current = doc
        setNumPages(doc.numPages)
        setPage(p => Math.max(1, Math.min(p, doc.numPages))) // el guardado puede exceder el PDF
        setLoading(false)
      })
      .catch(err => {
        if (!cancelled) { setLoadError(`No se pudo abrir el PDF: ${errorMessage(err)}`); setLoading(false) }
      })
    return () => {
      cancelled = true
      const doc = docRef.current
      docRef.current = null
      void doc?.destroy()
    }
  }, [book.file_url])

  // ── Render de la página activa (único canvas; re-render al cambiar fit/tamaño) ──
  useEffect(() => {
    const doc = docRef.current
    if (!doc || !page || !numPages) return
    const token = ++renderToken.current
    let cancelled = false
    void (async () => {
      try {
        const pdfPage = await doc.getPage(page)
        if (cancelled || token !== renderToken.current) return
        const stage = stageRef.current
        const w = Math.max(stage?.clientWidth ?? 0, 1)
        const h = Math.max(stage?.clientHeight ?? 0, 1)
        const base = pdfPage.getViewport({ scale: 1 })
        const scale = fit === 'width' ? w / base.width : Math.min(w / base.width, h / base.height)
        const viewport = pdfPage.getViewport({ scale: Math.max(scale, 0.05) })
        const canvas = canvasRef.current
        const ctx = canvas?.getContext('2d')
        if (cancelled || token !== renderToken.current || !canvas || !ctx) return
        canvas.width = Math.round(viewport.width)
        canvas.height = Math.round(viewport.height)
        await pdfPage.render({ canvasContext: ctx, viewport }).promise
        if (!cancelled && token === renderToken.current) pdfPage.cleanup?.()
      } catch (err) {
        if (!cancelled) setLoadError(`No se pudo mostrar la página: ${errorMessage(err)}`)
      }
    })()
    return () => { cancelled = true }
  }, [page, fit, size, numPages])

  // ── Progreso: guardo cada vuelta de página (la inicial no repite el guardado) ──
  useEffect(() => {
    if (!numPages || page === lastSaved.current) return
    lastSaved.current = page
    sync.save({ page }, (page / numPages) * 100)
  }, [page, numPages, sync])

  // ── Vuelta de página ──────────────────────────────────────────────────
  const turnNext = useCallback(() => {
    if (page >= numPages) return
    setDirection('next')
    setPage(page + 1)
  }, [page, numPages])

  const turnPrev = useCallback(() => {
    if (page <= 1) return
    setDirection('prev')
    setPage(page - 1)
  }, [page])

  const jumpTo = useCallback((target: number) => {
    const t = Math.max(1, Math.min(Math.round(target), numPages || target))
    if (t === page) return
    setDirection(t > page ? 'next' : 'prev')
    setPage(t)
  }, [page, numPages])

  // ── Teclado ←/→/espacio/PageUp/PageDown ───────────────────────────────
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

  // ── Resize: re-render con el nuevo tamaño (fit page/width) ────────────
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const measure = () => setSize({ w: stage.clientWidth, h: stage.clientHeight })
    measure()
    let ro: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure)
      ro.observe(stage)
    }
    window.addEventListener('resize', measure)
    return () => { ro?.disconnect(); window.removeEventListener('resize', measure) }
  }, [])

  // ── Swipe horizontal con inercia ligera (flick más corto que arrastre) ──
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
    const threshold = dt < 220 ? 36 : 70 // flick rápido gatilla con menos recorrido
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

  const percent = numPages ? (page / numPages) * 100 : 0
  const label = numPages ? `pág. ${page} de ${numPages}` : ''

  return (
    <div className="reader" data-night={night || undefined}>
      {chromeVisible && (
        <TopBar title={book.title} onBack={onBack} night={night} onToggleNight={() => setNight(n => !n)} />
      )}

      <div className="reader-stage" ref={stageRef} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <PageTurn key={page} direction={direction} night={night}>
          <canvas ref={canvasRef} className={`pdf-canvas ${night ? 'night' : ''}`} aria-hidden="true" />
        </PageTurn>

        {loading && !loadError && <div className="reader-loading">Cargando…</div>}
        {loadError && <p role="alert" className="lib-alert reader-error">{loadError}</p>}

        {/* Zonas de tap: 40 % izquierda (anterior), 20 % centro (controles), 40 % derecha (siguiente) */}
        <button type="button" className="reader-zone left" aria-label="Página anterior"
          onClick={guardSwipe(turnPrev)} disabled={page <= 1} />
        <button type="button" className="reader-zone center"
          aria-label={chromeVisible ? 'Ocultar controles' : 'Mostrar controles'}
          onClick={guardSwipe(() => setChromeVisible(v => !v))} />
        <button type="button" className="reader-zone right" aria-label="Página siguiente"
          onClick={guardSwipe(turnNext)} />
      </div>

      {chromeVisible && (
        <BottomBar
          page={page}
          numPages={numPages}
          percent={percent}
          label={label}
          fit={fit}
          onToggleFit={() => setFit(f => (f === 'page' ? 'width' : 'page'))}
          onSliderJump={jumpTo}
        />
      )}
    </div>
  )
}
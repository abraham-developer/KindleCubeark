// apps/web/src/reader/PdfReader.tsx — lector PDF (pdf.js): render de página,
// volteo con animación, zonas de tap, teclado, swipe, ajuste página/ancho,
// modo noche (filtro CSS) y progreso sincronizado (Task 12). Task 14 agrega
// textLayer (selección de texto), menú de anotación, resaltados con overlays
// mix-blend-mode, notas de página y marcador (cinta).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { api, type Annotation, type Book, type Position } from '../api'
import { useProgressSync } from '../lib/progressSync'
import PageTurn from './PageTurn'
import { TopBar, BottomBar, BookmarkButton } from './Chrome'
import SelectionMenu, { type HighlightColor } from './SelectionMenu'
import NoteEditor from './NoteEditor'
import AnnotationsPanel from './AnnotationsPanel'

const { getDocument, GlobalWorkerOptions } = pdfjs
GlobalWorkerOptions.workerSrc = workerUrl

type ReaderProgress = { position: Position; percent: string | number } | null

type Rect = { x: number; y: number; w: number; h: number }

type Props = {
  book: Book
  progress: ReaderProgress
  onBack: () => void
}

type SelectionInfo = { page: number; rects: Rect[]; quoted: string }
type NoteDraft =
  | { kind: 'new'; position: { page: number }; quoted: string }
  | { kind: 'edit'; annotation: Annotation }

function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg || 'Error inesperado'
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value))
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

  // ── Anotaciones (Task 14) ────────────────────────────────────────────────
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [actionError, setActionError] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null)
  const [notesOpen, setNotesOpen] = useState(false)
  const selectionRef = useRef<SelectionInfo | null>(null)
  const textLayerRef = useRef<HTMLDivElement | null>(null)
  // Timestamp del último dismiss del menú: el mouseup que lo provocó no debe
  // voltear la página (el removeAllRanges del dismiss deja la selección vacía).
  const menuDismissedAt = useRef(0)

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
        // tamaño CSS explícito: el wrapper (.pdf-page) queda exactamente sobre el
        // canvas y las capas (texto/resaltados) se posicionan en porcentajes
        canvas.style.width = `${Math.round(viewport.width)}px`
        canvas.style.height = `${Math.round(viewport.height)}px`
        await pdfPage.render({ canvasContext: ctx, viewport }).promise
        if (cancelled || token !== renderToken.current) return
        // TextLayer (pdf.js) sobre el canvas: hace seleccionable el texto. Es
        // accesorio: si falla (o en tests, donde pdfjs está mockeado sin
        // TextLayer), la página se muestra igual.
        const layer = textLayerRef.current
        if (layer) {
          layer.textContent = ''
          try {
            const TextLayerCtor = (pdfjs as unknown as {
              TextLayer?: new (options: { textContentSource: unknown; container: HTMLElement; viewport: unknown }) => { render(): Promise<void> }
            }).TextLayer
            if (TextLayerCtor) {
              layer.style.setProperty('--scale-factor', String(viewport.scale))
              const content = await pdfPage.getTextContent()
              if (cancelled || token !== renderToken.current) return
              await new TextLayerCtor({ textContentSource: content, container: layer, viewport }).render()
            }
          } catch { /* el texto es seleccionable sólo si el text layer funciona */ }
        }
        pdfPage.cleanup?.()
      } catch (err) {
        if (!cancelled) setLoadError(`No se pudo mostrar la página: ${errorMessage(err)}`)
      }
    })()
    return () => { cancelled = true }
  }, [page, fit, size, numPages])

  // ── Anotaciones del libro (una sola descarga; el POST/borrado actualiza) ──
  useEffect(() => {
    let alive = true
    api.listAnnotations(book.id)
      .then(rows => { if (alive) setAnnotations(rows) })
      .catch(() => { /* sin anotaciones no se bloquea la lectura */ })
    return () => { alive = false }
  }, [book.id])

  const pageAnnotations = useMemo(() => annotations.filter(a =>
    a.position && typeof a.position === 'object' &&
    typeof (a.position as { page?: unknown }).page === 'number' &&
    (a.position as { page: number }).page === page), [annotations, page])

  const bookmarked = annotations.some(a =>
    a.color === 'bookmark' && typeof a.position?.page === 'number' && a.position.page === page)

  // Progreso: guardo cada vuelta de página (la inicial no repite el guardado)
  useEffect(() => {
    if (!numPages || page === lastSaved.current) return
    lastSaved.current = page
    sync.save({ page }, (page / numPages) * 100)
  }, [page, numPages, sync])

  // Un cambio de página invalida el menú/editor y la selección pendiente
  useEffect(() => {
    setMenu(null)
    setNoteDraft(null)
    selectionRef.current = null
    window.getSelection()?.removeAllRanges()
  }, [page])

  const addHighlight = async (color: HighlightColor) => {
    const sel = selectionRef.current
    closeSelectionMenu()
    if (!sel) return
    try {
      const created = await api.createAnnotation(book.id, {
        kind: 'highlight',
        position: { page: sel.page, rects: sel.rects },
        quoted_text: sel.quoted,
        color,
      })
      setAnnotations(prev => [...prev, created])
      setActionError(null)
    } catch {
      setActionError('No se pudo guardar el resaltado')
    }
  }

  const closeSelectionMenu = useCallback(() => {
    setMenu(null)
    selectionRef.current = null
    menuDismissedAt.current = Date.now()
    window.getSelection()?.removeAllRanges()
  }, [])

  const saveNote = async (text: string) => {
    const draft = noteDraft
    setNoteDraft(null)
    if (!draft) return
    try {
      if (draft.kind === 'edit') {
        // sin PATCH en la API: editar una nota la re-crea con la misma posición.
        // Create primero y delete después: si el delete falla queda duplicada
        // (recuperable), pero si fuera al revés un fallo perdería la nota.
        const old = draft.annotation
        const created = await api.createAnnotation(book.id, {
          kind: old.kind, position: old.position, quoted_text: old.quoted_text, note: text, color: old.color,
        })
        await api.deleteAnnotation(old.id)
        setAnnotations(prev => [...prev.filter(a => a.id !== old.id), created])
      } else {
        // nota de página (o sobre una selección): position {page}, sin rects
        const created = await api.createAnnotation(book.id, {
          kind: 'note', position: draft.position, quoted_text: draft.quoted, note: text, color: 'yellow',
        })
        setAnnotations(prev => [...prev, created])
      }
      setActionError(null)
    } catch {
      setActionError('No se pudo guardar la nota')
    }
  }

  const toggleBookmark = async () => {
    const existing = annotations.find(a =>
      a.color === 'bookmark' && typeof a.position?.page === 'number' && a.position.page === page)
    try {
      if (existing) {
        await api.deleteAnnotation(existing.id)
        setAnnotations(prev => prev.filter(a => a.id !== existing.id))
      } else {
        const created = await api.createAnnotation(book.id, { kind: 'note', position: { page }, color: 'bookmark' })
        setAnnotations(prev => [...prev, created])
      }
      setActionError(null)
    } catch {
      setActionError('No se pudo guardar el marcador')
    }
  }

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

  // ── Selección de texto sobre el textLayer (mouseup con puntero fino) ──
  // Con puntero fino (mouse) las zonas de tap dejan de capturar los eventos
  // (CSS @media pointer:fine): este handler hace de zona de tap y de menú.
  const onStageMouseUp = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement | null
    // controles propios (cinta, menú, editor, panel): su click no voltea
    if (target?.closest?.('button, .selection-menu, .note-editor, .annotations-panel')) return
    // un mouseup que cierra el menú (dismiss) no debe también voltear la página
    if (Date.now() - menuDismissedAt.current < 250) return
    const sel = window.getSelection()
    const layer = textLayerRef.current
    if (sel && !sel.isCollapsed && sel.rangeCount > 0 && layer && sel.anchorNode &&
        layer.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0)
      const canvasRect = canvasRef.current?.getBoundingClientRect()
      if (!canvasRect || !canvasRect.width || !canvasRect.height) return
      const rects: Rect[] = Array.from(range.getClientRects())
        .filter(r => r.width > 1 && r.height > 1)
        .map(r => ({
          x: clampUnit((r.left - canvasRect.left) / canvasRect.width),
          y: clampUnit((r.top - canvasRect.top) / canvasRect.height),
          w: clampUnit(r.width / canvasRect.width),
          h: clampUnit(r.height / canvasRect.height),
        }))
      if (!rects.length) return
      selectionRef.current = { page, rects, quoted: sel.toString() }
      const boxes = range.getClientRects()
      const last = boxes[boxes.length - 1]
      setMenu({ x: last.right, y: Math.max(8, last.top - 46) })
      return
    }
    // tap simple sobre el texto → mismas zonas que los botones (40/20/40)
    if (target && layer && (target === layer || layer.contains(target))) {
      const stage = stageRef.current
      if (!stage) return
      const rect = stage.getBoundingClientRect()
      const xr = rect.width ? (e.clientX - rect.left) / rect.width : 0.5
      if (xr < 0.4) turnPrev()
      else if (xr > 0.6) turnNext()
      else setChromeVisible(v => !v)
    }
  }

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
        <TopBar
          title={book.title}
          onBack={onBack}
          night={night}
          onToggleNight={() => setNight(n => !n)}
          onNotes={() => setNotesOpen(v => !v)}
          onPageNote={() => setNoteDraft({ kind: 'new', position: { page }, quoted: '' })}
        />
      )}

      <div className="reader-stage" ref={stageRef} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}
        onMouseUp={onStageMouseUp}>
        <PageTurn key={page} direction={direction} night={night}>
          <div className="pdf-page">
            <canvas ref={canvasRef} className={`pdf-canvas ${night ? 'night' : ''}`} aria-hidden="true" />
            {/* textLayer de pdf.js: texto seleccionable sobre la página */}
            <div ref={textLayerRef} className="textLayer" aria-hidden="true" />
            {/* resaltados guardados, en coords normalizadas 0–1 de la página */}
            <div className="pdf-highlights">
              {pageAnnotations.filter(a => Array.isArray(a.position?.rects)).flatMap(a =>
                (a.position.rects as Rect[]).map((rect, i) => (
                  <div
                    key={`${a.id}-${i}`}
                    className={`hl ${a.color}`}
                    data-annotation-id={a.id}
                    title={a.note || undefined}
                    style={{
                      left: `${rect.x * 100}%`,
                      top: `${rect.y * 100}%`,
                      width: `${rect.w * 100}%`,
                      height: `${rect.h * 100}%`,
                    }}
                  />
                )),
              )}
            </div>
          </div>
        </PageTurn>

        {loading && !loadError && <div className="reader-loading">Cargando…</div>}
        {loadError && <p role="alert" className="lib-alert reader-error">{loadError}</p>}
        {actionError && <p role="alert" className="lib-alert reader-error">{actionError}</p>}

        {/* Marcador: cinta en la esquina, visible también en modo inmersivo */}
        <BookmarkButton marked={bookmarked} onToggle={() => void toggleBookmark()} />

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

      {notesOpen && (
        <div className="notes-anchor">
          <AnnotationsPanel
            bookId={book.id}
            format="pdf"
            onDeleted={id => setAnnotations(prev => prev.filter(a => a.id !== id))}
            onJump={pos => {
              setNotesOpen(false)
              if (pos && typeof pos.page === 'number') jumpTo(pos.page)
            }}
            onClose={() => setNotesOpen(false)}
          />
        </div>
      )}

      {menu && selectionRef.current && (
        <SelectionMenu
          x={menu.x}
          y={menu.y}
          onSelect={color => void addHighlight(color)}
          onNote={() => {
            const sel = selectionRef.current
            if (sel) setNoteDraft({ kind: 'new', position: { page: sel.page }, quoted: sel.quoted })
            setMenu(null)
          }}
          onClose={closeSelectionMenu}
        />
      )}

      {noteDraft && (
        <div className="note-anchor">
          <NoteEditor
            heading={noteDraft.kind === 'edit' ? 'Editar nota' : 'Nueva nota'}
            initialNote={noteDraft.kind === 'edit' ? noteDraft.annotation.note : ''}
            quotedText={noteDraft.kind === 'edit' ? noteDraft.annotation.quoted_text : noteDraft.quoted}
            onSave={text => void saveNote(text)}
            onCancel={() => setNoteDraft(null)}
          />
        </div>
      )}
    </div>
  )
}
// apps/web/src/reader/EpubReader.tsx — lector EPUB sobre epub.js: retomar por
// CFI guardado (sin flash a la página 1), guardado del progreso al «relocated»,
// navegación con zonas de tap / teclado / swipe, panel Aa (tamaño, interlineado,
// tipografía, día/noche) y slider por porcentaje (Task 13). Task 14 agrega
// selección → menú de anotación, resaltados con rendition.annotations, notas
// ancladas al resaltado (click → editor) y marcador (cinta).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ePub, { type Book as EpubBook, type Location, type NavItem, type Rendition } from 'epubjs'
import { api, type Annotation, type Book, type Position } from '../api'
import { useProgressSync } from '../lib/progressSync'
import { splitCfiRange, joinCfiRange, cfiSection } from '../lib/cfiRange'
import { TopBar, BookmarkButton } from './Chrome'
import AaPanel, { fontFamilyStack, loadSettings, type ReaderSettings } from './AaPanel'
import SelectionMenu, { HIGHLIGHT_FILL, type HighlightColor } from './SelectionMenu'
import NoteEditor from './NoteEditor'
import AnnotationsPanel from './AnnotationsPanel'

type ReaderProgress = { position: Position; percent: string | number } | null

type Props = {
  book: Book
  progress: ReaderProgress
  onBack: () => void
}

type SelectionInfo = { startCfi: string; endCfi: string; text: string; contents: unknown }
type NoteDraft =
  | { kind: 'new'; selection: SelectionInfo }
  | { kind: 'edit'; annotation: Annotation }

function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg || 'Error inesperado'
}

/** CFI guardado, si el progreso del libro es de tipo EPUB (posición = CFI). */
function savedCfi(progress: ReaderProgress): string | undefined {
  const position = progress?.position
  return position && 'cfi' in position ? position.cfi : undefined
}

/** Rango CFI {start,end} de una anotación, si es anclable como resaltado. */
function annotationCfiRange(annotation: Annotation): { start: string; end: string } | null {
  const position = annotation.position as { startCfi?: unknown; endCfi?: unknown } | undefined
  if (position && typeof position.startCfi === 'string' && typeof position.endCfi === 'string') {
    return { start: position.startCfi, end: position.endCfi }
  }
  return null
}

/** Texto y rectángulo de la selección dentro de los contents de epub.js. */
function contentsSelection(contents: unknown): { text: string; rect: DOMRect | null } {
  try {
    const win = (contents as { window?: Window }).window
    const selection = win?.getSelection?.()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return { text: '', rect: null }
    }
    const range = selection.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    return { text: selection.toString(), rect: rect && rect.width > 0 ? rect : null }
  } catch {
    return { text: '', rect: null }
  }
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

  // ── Anotaciones (Task 14) ────────────────────────────────────────────────
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [actionError, setActionError] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  // Espejo del menú en un ref: los handlers del rendition (closures del mount)
  // consultan si hay menú vivo sin re-crearlos por render.
  const menuOpenRef = useRef(false)
  useEffect(() => { menuOpenRef.current = menu != null }, [menu])
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null)
  const [notesOpen, setNotesOpen] = useState(false)
  const selectionRef = useRef<SelectionInfo | null>(null)
  const currentCfiRef = useRef<string | null>(null)
  const [currentCfi, setCurrentCfi] = useState<string | null>(null)
  // id → rango pintado en el rendition (y modo día/noche del estilo inline)
  const renderedRef = useRef<Map<string, { mode: string; cfiRange: string }>>(new Map())

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
    // CFI actual: el marcador y la verificación de «página marcada» lo usan
    currentCfiRef.current = start.cfi
    setCurrentCfi(start.cfi)
    // la selección queda desfasada al cambiar de página
    setMenu(null)
    selectionRef.current = null
    if (firstRelocatedRef.current) {
      firstRelocatedRef.current = false // eco del resume: no re-guarda
      return
    }
    sync.save({ cfi: start.cfi, percent: pct, section: start.index }, pct)
  }, [sync])

  // ── Anotaciones del libro (una sola descarga; el POST/borrado actualiza) ──
  useEffect(() => {
    let alive = true
    api.listAnnotations(book.id)
      .then(rows => { if (alive) setAnnotations(rows) })
      .catch(() => { /* sin anotaciones no se bloquea la lectura */ })
    return () => { alive = false }
  }, [book.id])

  const bookmarks = useMemo(() => annotations.filter(a => a.color === 'bookmark'), [annotations])
  const bookmarked = useMemo(() => {
    const here = cfiSection(currentCfi)
    if (here === null) return false
    // tolerancia: basta que el marcador caiga en la misma sección
    return bookmarks.some(b => cfiSection((b.position as { startCfi?: unknown }).startCfi) === here)
  }, [bookmarks, currentCfi])

  /** Pinta/limpia los resaltados en el rendition según las anotaciones vigentes. */
  const syncAnnotations = useCallback((rendition: Rendition, isNight: boolean) => {
    const mode = isNight ? 'night' : 'day'
    const wanted = new Map<string, { annotation: Annotation; cfiRange: string }>()
    for (const annotation of annotations) {
      if (annotation.color === 'bookmark') continue
      const range = annotationCfiRange(annotation)
      if (!range) continue // notas de página sin rango no se pintan
      wanted.set(annotation.id, { annotation, cfiRange: joinCfiRange(range.start, range.end) })
    }
    for (const [id, rendered] of Array.from(renderedRef.current)) {
      const wantedEntry = wanted.get(id)
      if (wantedEntry && wantedEntry.cfiRange === rendered.cfiRange && rendered.mode === mode) continue
      try { rendition.annotations.remove(rendered.cfiRange, 'highlight') } catch { /* capítulo no montado */ }
      renderedRef.current.delete(id)
    }
    for (const [id, entry] of wanted) {
      if (renderedRef.current.has(id)) continue
      const { annotation, cfiRange } = entry
      try {
        rendition.annotations.add(
          'highlight',
          cfiRange,
          annotation,
          // tocar un resaltado anclado con nota abre el editor
          () => { if (annotation.note || annotation.kind === 'note') setNoteDraft({ kind: 'edit', annotation }) },
          'kc-annotation',
          {
            fill: HIGHLIGHT_FILL[(annotation.color as HighlightColor)] ?? HIGHLIGHT_FILL.yellow,
            'mix-blend-mode': isNight ? 'screen' : 'multiply',
          },
        )
        renderedRef.current.set(id, { mode, cfiRange })
      } catch { /* rango no renderizable en la sección actual */ }
    }
  }, [annotations])

  // tras cada cambio de anotaciones o de modo, re-sincroniza los resaltados
  useEffect(() => {
    const rendition = renditionRef.current
    if (!rendition) return
    syncAnnotations(rendition, night)
  }, [annotations, night, syncAnnotations])

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

    // Selección de texto: epub.js la detecta con debounce y emite el CFI de rango
    rendition.on('selected', (cfiRange: unknown, contents: unknown) => {
      const parts = splitCfiRange(String(cfiRange ?? ''))
      if (!parts) return
      const { text, rect } = contentsSelection(contents)
      selectionRef.current = { startCfi: parts.startCfi, endCfi: parts.endCfi, text, contents }
      const hostRect = host.getBoundingClientRect()
      const x = hostRect.left + (rect ? rect.left + rect.width / 2 : hostRect.width / 2)
      const y = hostRect.top + Math.max(8, (rect ? rect.top : hostRect.height / 4) - 52)
      setMenu({ x, y })
    })

    // Con puntero fino las zonas de tap no capturan (CSS): el tap sobre el
    // contenido llega por los eventos que epub.js re-emite del iframe.
    rendition.on('mouseup', (ev: MouseEvent, contents: unknown) => {
      if (!ev || ev.button !== 0) return
      const selection = contentsSelection(contents)
      if (selection.text) return // arrastre con selección: abrirá el menú
      // tap sin selección sobre el contenido: un menú de selección vivo
      // (abierto por una selección anterior) se cierra con el mismo gesto
      if (menuOpenRef.current) closeSelectionMenu()
      const hostRect = host.getBoundingClientRect()
      const xr = hostRect.width ? (ev.clientX - hostRect.left) / hostRect.width : 0.5
      if (xr < 0.4) turnPrev()
      else if (xr > 0.6) turnNext()
      else setChromeVisible(v => !v)
    })
    // los touch re-enviados alimentan el mismo swipe que el stage
    rendition.on('touchstart', (ev: TouchEvent) => {
      onTouchStartAt((ev as TouchEvent).changedTouches?.[0])
    })
    rendition.on('touchend', (ev: TouchEvent) => {
      onTouchEndAt((ev as TouchEvent).changedTouches?.[0])
    })

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
      renderedRef.current.clear()
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

  // ── Acciones de anotación ────────────────────────────────────────────────
  const closeSelectionMenu = useCallback(() => {
    setMenu(null)
    const selection = selectionRef.current
    selectionRef.current = null
    try {
      const win = (selection?.contents as { window?: Window } | undefined)?.window
      win?.getSelection?.()?.removeAllRanges()
    } catch { /* iframe ya destruido */ }
  }, [])

  const addHighlight = async (color: HighlightColor) => {
    const sel = selectionRef.current
    closeSelectionMenu()
    if (!sel) return
    try {
      const created = await api.createAnnotation(book.id, {
        kind: 'highlight',
        position: { startCfi: sel.startCfi, endCfi: sel.endCfi },
        quoted_text: sel.text,
        color,
      })
      setAnnotations(prev => [...prev, created])
      setActionError(null)
    } catch {
      setActionError('No se pudo guardar el resaltado')
    }
  }

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
        const created = await api.createAnnotation(book.id, {
          kind: 'note',
          position: { startCfi: draft.selection.startCfi, endCfi: draft.selection.endCfi },
          quoted_text: draft.selection.text,
          note: text,
          color: 'yellow',
        })
        setAnnotations(prev => [...prev, created])
      }
      setActionError(null)
    } catch {
      setActionError('No se pudo guardar la nota')
    }
  }

  const toggleBookmark = async () => {
    const here = cfiSection(currentCfiRef.current)
    const existing = bookmarks.find(b =>
      cfiSection((b.position as { startCfi?: unknown }).startCfi) === here)
    if (here === null) return // todavía no hay posición (relocated pendiente)
    try {
      if (existing) {
        await api.deleteAnnotation(existing.id)
        setAnnotations(prev => prev.filter(a => a.id !== existing.id))
      } else {
        const cfi = currentCfiRef.current!
        const created = await api.createAnnotation(book.id, {
          kind: 'note', position: { startCfi: cfi, endCfi: cfi }, color: 'bookmark',
        })
        setAnnotations(prev => [...prev, created])
      }
      setActionError(null)
    } catch {
      setActionError('No se pudo guardar el marcador')
    }
  }

  const openNoteFromMenu = () => {
    const sel = selectionRef.current
    if (sel) setNoteDraft({ kind: 'new', selection: sel })
    setMenu(null)
  }

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
  // Compartido por los touch del stage (coarse) y los que epub.js re-emite.
  const onTouchStartAt = (touch: { clientX: number; clientY: number } | null | undefined) => {
    if (touch) touchStart.current = { x: touch.clientX, y: touch.clientY, t: Date.now() }
  }
  const onTouchEndAt = (touch: { clientX: number; clientY: number } | null | undefined) => {
    const start = touchStart.current
    touchStart.current = null
    if (!start || !touch) return
    const dx = touch.clientX - start.x
    const dy = touch.clientY - start.y
    const dt = Date.now() - start.t
    const threshold = dt < 220 ? 36 : 70
    if (Math.abs(dx) > threshold && Math.abs(dx) > Math.abs(dy) * 1.2) {
      swipedAt.current = Date.now()
      if (dx < 0) turnNext(); else turnPrev()
    }
  }
  const onTouchStart = (e: React.TouchEvent) => onTouchStartAt(e.changedTouches[0])
  const onTouchEnd = (e: React.TouchEvent) => onTouchEndAt(e.changedTouches[0])

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
          onNotes={() => setNotesOpen(v => !v)}
        />
      )}

      <div className="reader-stage" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <div ref={hostRef} className="epub-host" aria-label="Contenido del libro" />

        {loading && !loadError && <div className="reader-loading">Cargando…</div>}
        {loadError && <p role="alert" className="lib-alert reader-error">{loadError}</p>}
        {actionError && <p role="alert" className="lib-alert reader-error">{actionError}</p>}

        {/* Marcador: cinta en la esquina, visible también en modo inmersivo */}
        <BookmarkButton marked={bookmarked} onToggle={() => void toggleBookmark()} />

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

      {notesOpen && (
        <div className="notes-anchor">
          <AnnotationsPanel
            bookId={book.id}
            format="epub"
            onDeleted={id => setAnnotations(prev => prev.filter(a => a.id !== id))}
            onJump={pos => {
              setNotesOpen(false)
              const target = pos?.startCfi ?? pos?.cfi
              if (typeof target === 'string' && target) void renditionRef.current?.display(target)
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
          onNote={openNoteFromMenu}
          onClose={closeSelectionMenu}
        />
      )}

      {noteDraft && (
        <div className="note-anchor">
          <NoteEditor
            heading={noteDraft.kind === 'edit' ? 'Editar nota' : 'Nueva nota'}
            initialNote={noteDraft.kind === 'edit' ? noteDraft.annotation.note : ''}
            quotedText={noteDraft.kind === 'edit' ? noteDraft.annotation.quoted_text : noteDraft.selection.text}
            onSave={text => void saveNote(text)}
            onCancel={() => setNoteDraft(null)}
          />
        </div>
      )}
    </div>
  )
}
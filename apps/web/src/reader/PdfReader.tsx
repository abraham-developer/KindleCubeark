// apps/web/src/reader/PdfReader.tsx — lector PDF (pdf.js): render de página,
// volteo con animación, zonas de tap, teclado, swipe, ajuste página/ancho,
// modo noche (filtro CSS) y progreso sincronizado (Task 12). Task 14 agrega
// textLayer (selección de texto), menú de anotación, resaltados con overlays
// mix-blend-mode, notas de página y marcador (cinta). Además: vista por
// bloques estilo Kindle (minilecturas con progreso a nivel de bloque), modo
// estudio bilingüe opcional (original + traducción lado a lado), figuras de
// página en bloques (ver imágenes) y diccionario por pulsación larga.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { api, ApiError, type Annotation, type Book, type Position } from '../api'
import { useProgressSync } from '../lib/progressSync'
import {
  blockPercent, buildContentBlocks, initialBlock, itemsToSpans, loadPdfView, resumeBlockFace,
  savePdfView, studyScreenPosition,
  type BlockFace, type ContentBlock, type PdfTextItem, type PdfView,
} from '../lib/blocks'
import { extractPageImages, type ImageOps } from '../lib/pageImages'
import {
  STUDY_LANGS, loadStudyPrefs, saveStudyPrefs, studyLangLabel, translateBlock,
  type StudyLang,
} from '../lib/study'
import {
  DictNotFound, lookupAt, lookupAtBoth, wordCandidates, wordRangeAtPoint, wordSpan,
  type DictEntry,
} from '../lib/dictionary'
import PageTurn from './PageTurn'
import { TopBar, BottomBar, BookmarkButton } from './Chrome'
import SelectionMenu, { type HighlightColor } from './SelectionMenu'
import NoteEditor from './NoteEditor'
import AnnotationsPanel from './AnnotationsPanel'
import DictPopover from './DictPopover'

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

// ── Lupa / zoom (vista página y vista bloques comparten el nivel) ──────────
const ZOOM_KEY = 'kc.pdf.zoom'
const ZOOM_MIN = 0.5
const ZOOM_MAX = 3
const ZOOM_STEP = 1.25

function loadZoom(): number {
  try {
    const raw = window.localStorage.getItem(ZOOM_KEY)
    // Number(null) es 0 (finito): la ausencia explícita es 100 %
    if (raw == null || raw === '') return 1
    const v = Number(raw)
    if (!Number.isFinite(v)) return 1
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v))
  } catch {
    return 1
  }
}

function stepZoom(current: number, dir: 'in' | 'out'): number {
  const next = dir === 'in' ? current * ZOOM_STEP : current / ZOOM_STEP
  const rounded = Math.round(next * 100) / 100
  // caer exacto al 100 % al pasar por él
  if ((dir === 'in' && current < 1 && rounded >= 1) || (dir === 'out' && current > 1 && rounded <= 1)) return 1
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, rounded))
}

/** Hoja PDF (canvas + texto seleccionable + resaltados), compartida por la
 *  vista centrada con volteo y la vista con lupa (scroll/paneable). */
function PdfPageCanvas({ canvasRef, textLayerRef, night, pageAnnotations }: {
  canvasRef: React.RefObject<HTMLCanvasElement>
  textLayerRef: React.RefObject<HTMLDivElement>
  night: boolean
  pageAnnotations: Annotation[]
}) {
  return (
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
  )
}

/** Mensaje en español neutro para un fallo de traducción según la causa. */
function translateErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 503) return 'Traducción no disponible: el servicio no está configurado'
    if (err.status === 502) return 'No se pudo traducir este bloque, inténtalo de nuevo'
  }
  return `No se pudo traducir este bloque: ${errorMessage(err)}`
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

  // ── Lupa: 50 %–300 %, persiste entre sesiones ─────────────────────────────
  const [zoom, setZoom] = useState(() => loadZoom())
  useEffect(() => {
    try { window.localStorage.setItem(ZOOM_KEY, String(zoom)) } catch { /* sin persistencia */ }
  }, [zoom])
  const zoomIn = useCallback(() => setZoom(z => stepZoom(z, 'in')), [])
  const zoomOut = useCallback(() => setZoom(z => stepZoom(z, 'out')), [])
  const zoomReset = useCallback(() => setZoom(1), [])
  const zoomed = zoom !== 1

  // ── Vista por bloques (minilecturas estilo Kindle) ───────────────────────
  const [view, setView] = useState<PdfView>(() => loadPdfView())
  // el bloque guardado se sanea contra el total real al extraer cada página
  const [block, setBlock] = useState(() => initialBlock(progress?.position, Number.MAX_SAFE_INTEGER))
  // null = extrayendo; cada bloque es texto refluido o imagen en hoja propia
  const [pageBlocks, setPageBlocks] = useState<ContentBlock[] | null>(null)
  const [blocksError, setBlocksError] = useState<string | null>(null)
  const blocksCache = useRef(new Map<number, ContentBlock[]>())
  const extractToken = useRef(0)
  // al retroceder de página en vista bloques se cae al ÚLTIMO bloque nuevo
  const pendingEdge = useRef<'last' | null>(null)

  // ── Modo estudio bilingüe (opcional; vive sobre la vista por bloques) ────
  // Intercala pantallas: original, traducción, original… (una por pantalla).
  const [studyOn, setStudyOn] = useState(() => loadStudyPrefs().on)
  const [studyLang, setStudyLang] = useState<StudyLang>(() => loadStudyPrefs().lang)
  const [face, setFace] = useState<BlockFace>('orig')
  const resumedRef = useRef(false) // el retomado se aplica una sola vez
  const [translation, setTranslation] = useState<string | null>(null)
  const [translating, setTranslating] = useState(false)
  const [transError, setTransError] = useState<string | null>(null)
  const [transNonce, setTransNonce] = useState(0) // reintento manual
  const transToken = useRef(0)

  // ── Diccionario (pulsación larga con el dedo sobre una palabra) ──────────
  const [dictReq, setDictReq] = useState<{ x: number; y: number; text: string; offset: number } | null>(null)
  const [dictEntry, setDictEntry] = useState<DictEntry | null>(null)
  const [dictEntry2, setDictEntry2] = useState<DictEntry | null>(null) // segundo idioma en estudio
  const [dictLoading, setDictLoading] = useState(false)
  const [dictError, setDictError] = useState<string | null>(null)
  const [dictNonce, setDictNonce] = useState(0) // reintento manual
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const holdPoint = useRef<{ x: number; y: number } | null>(null)
  const dictHoldAt = useRef(0) // la pulsación que abrió el popover no navega
  const dictClosedAt = useRef(0) // el tap que cerró el popover no navega

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
  // render de pdf.js en curso: hay que cancelarlo (y esperar la cancelación)
  // antes de renderizar de nuevo el mismo canvas — pdf.js lanza «Cannot use
  // the same canvas during multiple render() operations» si se pisa. (En los
  // tests el render es fake y puede venir sin cancel().)
  const renderTaskRef = useRef<{ cancel?(): void; promise: Promise<unknown> } | null>(null)
  const renderToken = useRef(0)
  // última posición guardada («página» o «página:bloque:cara»): la inicial no repite el guardado
  const lastSaved = useRef<string>(view === 'blocks' ? `${page}:${block}:orig` : `${page}`)
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
  // El canvas se pinta a la densidad del dispositivo (devicePixelRatio): sin
  // esto, en pantallas HiDPI el navegador estira el backing store 1× y el
  // texto se ve borroso. Y pdf.js no admite dos render() en el mismo canvas:
  // el render anterior (re-render de la misma página por resize/fit) se
  // cancela y se espera su cancelación antes de volver a renderizar.
  useEffect(() => {
    if (view === 'blocks') return // en vista bloques no hay canvas que pintar
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
        const cssScale = Math.max(
          fit === 'width' ? w / base.width : Math.min(w / base.width, h / base.height), 0.05) * zoom
        const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3))
        const cssViewport = pdfPage.getViewport({ scale: cssScale })
        // tope de área como pdf.js viewer: canvas demasiado grande en iOS queda
        // en blanco; si excede, se reduce el dpr antes que romper el render
        let renderScale = cssScale * dpr
        const maxPixels = 16_000_000
        if (cssViewport.width * cssViewport.height * dpr * dpr > maxPixels) {
          renderScale = Math.max(cssScale,
            Math.sqrt(maxPixels / (cssViewport.width * cssViewport.height)))
        }
        const renderViewport = pdfPage.getViewport({ scale: renderScale })
        const canvas = canvasRef.current
        const ctx = canvas?.getContext('2d')
        if (cancelled || token !== renderToken.current || !canvas || !ctx) return
        canvas.width = Math.round(renderViewport.width)
        canvas.height = Math.round(renderViewport.height)
        // tamaño CSS explícito: el wrapper (.pdf-page) queda exactamente sobre el
        // canvas y las capas (texto/resaltados) se posicionan en porcentajes
        canvas.style.width = `${Math.round(cssViewport.width)}px`
        canvas.style.height = `${Math.round(cssViewport.height)}px`
        const prev = renderTaskRef.current
        if (prev) { prev.cancel?.(); await prev.promise.catch(() => { /* cancelado */ }) }
        if (cancelled || token !== renderToken.current) return
        const task = pdfPage.render({ canvasContext: ctx, viewport: renderViewport })
        renderTaskRef.current = task
        await task.promise
        if (cancelled || token !== renderToken.current) return
        // TextLayer (pdf.js) sobre el canvas: hace seleccionable el texto. Es
        // accesorio: si falla (o en tests, donde pdfjs está mockeado sin
        // TextLayer), la página se muestra igual. Va con el viewport CSS (el
        // render va escalado por dpr, pero la capa vive en px lógicos).
        const layer = textLayerRef.current
        if (layer) {
          layer.textContent = ''
          try {
            const TextLayerCtor = (pdfjs as unknown as {
              TextLayer?: new (options: { textContentSource: unknown; container: HTMLElement; viewport: unknown }) => { render(): Promise<void> }
            }).TextLayer
            if (TextLayerCtor) {
              layer.style.setProperty('--scale-factor', String(cssViewport.scale))
              const content = await pdfPage.getTextContent()
              if (cancelled || token !== renderToken.current) return
              await new TextLayerCtor({ textContentSource: content, container: layer, viewport: cssViewport }).render()
            }
          } catch { /* el texto es seleccionable sólo si el text layer funciona */ }
        }
        pdfPage.cleanup?.()
      } catch (err) {
        if (!cancelled) setLoadError(`No se pudo mostrar la página: ${errorMessage(err)}`)
      }
    })()
    return () => {
      cancelled = true
      renderTaskRef.current?.cancel?.()
    }
  }, [page, fit, size, numPages, view, zoom])

  // Fija bloque y cara tras extraer: retomado guardado (una sola vez),
  // borde pendiente al retroceder de página, o saneo contra el total real.
  const settleBlockFace = (blocks: ContentBlock[]) => {
    const len = blocks.length
    const edge = pendingEdge.current
    pendingEdge.current = null
    const savedPage = progress?.position && 'page' in progress.position ? progress.position.page : null
    if (!resumedRef.current && savedPage != null && savedPage === page) {
      resumedRef.current = true
      const mapped = resumeBlockFace(progress?.position, blocks, studyOn)
      setBlock(mapped.block)
      setFace(mapped.face)
      return
    }
    if (edge === 'last') {
      setBlock(Math.max(0, len - 1))
      setFace(studyOn && blocks[len - 1]?.kind === 'text' ? 'trans' : 'orig')
      return
    }
    setBlock(b => initialBlock({ block: b }, len))
  }

  // ── Extracción de bloques de la página activa (solo vista bloques) ──────
  // Texto por posición + imágenes recortadas del render, intercalados en
  // orden de lectura. Se cachea por página; si las imágenes fallan, igual
  // se muestra el texto (nunca tumban la página).
  useEffect(() => {
    if (view !== 'blocks' || !numPages) return
    const doc = docRef.current
    if (!doc) return
    const cached = blocksCache.current.get(page)
    if (cached) {
      setBlocksError(null)
      setPageBlocks(cached)
      settleBlockFace(cached)
      return
    }
    const token = ++extractToken.current
    let cancelled = false
    setPageBlocks(null)
    setBlocksError(null)
    void (async () => {
      try {
        const pdfPage = await doc.getPage(page)
        if (cancelled || token !== extractToken.current) return
        const content = await pdfPage.getTextContent()
        if (cancelled || token !== extractToken.current) return
        const items = (content.items as unknown as Array<Partial<PdfTextItem>>)
          .filter((it): it is PdfTextItem => typeof it.str === 'string' && Array.isArray(it.transform))
        const spans = itemsToSpans(items)
        const ops = (pdfjs as unknown as { OPS?: ImageOps }).OPS
        const images = await extractPageImages(pdfPage, ops).catch(() => [])
        if (cancelled || token !== extractToken.current) return
        const blocks = buildContentBlocks(spans, images)
        blocksCache.current.set(page, blocks)
        setPageBlocks(blocks)
        settleBlockFace(blocks)
        pdfPage.cleanup?.()
      } catch {
        if (!cancelled && token === extractToken.current) {
          setBlocksError('No se pudo extraer el texto de esta página')
          setPageBlocks([])
        }
      }
    })()
    return () => { cancelled = true }
    // settleBlockFace lee el estado vigente; studyOn re-evalúa el retomado.
  }, [view, page, numPages, studyOn])

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

  // Progreso: en vista página guardo {page} (contrato clásico); en vista
  // bloques guardo {page, block, blockCount} y en estudio sumo la cara.
  // El porcentaje reparte la página entre pantallas (las imágenes no duplican).
  useEffect(() => {
    if (!numPages) return
    if (view === 'blocks' && !pageBlocks) return // extrayendo: aún no hay total real
    const key = view === 'blocks' ? `${page}:${block}:${face}` : `${page}`
    if (key === lastSaved.current) return
    lastSaved.current = key
    if (view === 'blocks' && pageBlocks) {
      const count = Math.max(pageBlocks.length, 1)
      if (studyOn) {
        const { index, total } = studyScreenPosition(pageBlocks, block, face, true)
        sync.save({ page, block, blockCount: count, face }, blockPercent(page, index, total, numPages))
      } else {
        sync.save({ page, block, blockCount: count }, blockPercent(page, block, count, numPages))
      }
    } else {
      sync.save({ page }, (page / numPages) * 100)
    }
  }, [page, block, face, pageBlocks, view, numPages, studyOn, sync])

  // ── Estudio bilingüe: traducir el bloque en lectura (solo si está activo) ─
  useEffect(() => {
    saveStudyPrefs({ on: studyOn, lang: studyLang })
  }, [studyOn, studyLang])

  const activeBlock = view === 'blocks' && pageBlocks && pageBlocks.length > 0
    ? pageBlocks[Math.min(block, pageBlocks.length - 1)]
    : null
  const blockText = activeBlock?.kind === 'text' ? activeBlock.paragraphs.join('\n\n') : ''

  useEffect(() => {
    if (!studyOn || view !== 'blocks' || !blockText) {
      setTranslation(null)
      setTranslating(false)
      setTransError(null)
      return
    }
    const token = ++transToken.current
    setTranslating(true)
    setTransError(null)
    translateBlock(blockText, studyLang).then(
      text => {
        if (token !== transToken.current) return
        setTranslation(text)
        setTranslating(false)
      },
      err => {
        if (token !== transToken.current) return
        setTranslation(null)
        setTranslating(false)
        setTransError(translateErrorMessage(err))
      },
    )
  }, [studyOn, view, blockText, studyLang, transNonce])

  // ── Diccionario: buscar el significado de la palabra pulsada ─────────────
  // En estudio bilingüe trae ambos (español + inglés); si no, español con
  // respaldo en inglés. Al resolver ajusta el marcado azul a la palabra hallada.
  useEffect(() => {
    if (!dictReq) {
      setDictEntry(null)
      setDictEntry2(null)
      setDictLoading(false)
      setDictError(null)
      return
    }
    let cancelled = false
    setDictLoading(true)
    setDictError(null)
    setDictEntry(null)
    setDictEntry2(null)
    const done = (word: string, first: DictEntry | null, second: DictEntry | null) => {
      if (cancelled) return
      setDictEntry(first)
      setDictEntry2(second)
      setDictLoading(false)
      adjustDictSelection(dictReq.text, dictReq.offset, word)
    }
    const failed = (err: unknown) => {
      if (cancelled) return
      setDictLoading(false)
      setDictError(err instanceof DictNotFound
        ? 'Sin definición para esta palabra'
        : `No se pudo consultar el diccionario: ${errorMessage(err)}`)
    }
    if (studyOn) {
      lookupAtBoth(dictReq.text, dictReq.offset).then(
        ({ word, es, en }) => done(word, es ?? en, es && en ? en : null),
        failed,
      )
    } else {
      lookupAt(dictReq.text, dictReq.offset).then(
        entry => done(entry.word, entry, null),
        failed,
      )
    }
    return () => { cancelled = true }
  }, [dictReq, dictNonce, studyOn])

  // El timer de pulsación larga no sobrevive al desmonte del lector.
  useEffect(() => () => {
    if (holdTimer.current != null) clearTimeout(holdTimer.current)
  }, [])

  // Un cambio de página/bloque invalida el menú/editor, la selección
  // pendiente y el diccionario
  useEffect(() => {
    setMenu(null)
    setNoteDraft(null)
    selectionRef.current = null
    setDictReq(null)
    window.getSelection()?.removeAllRanges()
  }, [page, block])

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
    window.getSelection()?.removeAllRanges()
  }, [])

  // El stamp de dismiss vive sólo en el cierre por gesto externo (tap fuera /
  // Escape, onClose del menú): los cierres por acción (color, Nota) no deben
  // bloquear el volteo legítimo que venga inmediatamente después.
  const dismissSelectionMenu = useCallback(() => {
    menuDismissedAt.current = Date.now()
    closeSelectionMenu()
  }, [closeSelectionMenu])

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

  // ── Vuelta de página (bloques: por bloques; estudio: intercalado) ────────
  // En estudio los bloques de texto ocupan dos pantallas (original y
  // traducción); las imágenes, una sola (se saltan la cara traducida).
  const turnNext = useCallback(() => {
    if (view === 'blocks' && pageBlocks && pageBlocks.length > 0) {
      if (studyOn && face === 'orig' && pageBlocks[block]?.kind === 'text') {
        setDirection('next')
        setFace('trans')
        return
      }
      if (block < pageBlocks.length - 1) {
        setDirection('next')
        setBlock(block + 1)
        setFace('orig')
        return
      }
      if (page >= numPages) return
      setDirection('next')
      setBlock(0)
      setFace('orig')
      setPage(page + 1)
      return
    }
    if (page >= numPages) return
    setDirection('next')
    setPage(page + 1)
  }, [page, numPages, view, block, face, studyOn, pageBlocks])

  const turnPrev = useCallback(() => {
    if (view === 'blocks' && pageBlocks && pageBlocks.length > 0) {
      if (studyOn && face === 'trans') {
        setDirection('prev')
        setFace('orig')
        return
      }
      if (block > 0) {
        setDirection('prev')
        setBlock(block - 1)
        setFace(studyOn && pageBlocks[block - 1]?.kind === 'text' ? 'trans' : 'orig')
        return
      }
      if (page <= 1) return
      setDirection('prev')
      pendingEdge.current = 'last'
      setPage(page - 1)
      return
    }
    if (page <= 1) return
    setDirection('prev')
    setPage(page - 1)
  }, [page, numPages, view, block, face, studyOn, pageBlocks])

  const jumpTo = useCallback((target: number, targetBlock = 0) => {
    const t = Math.max(1, Math.min(Math.round(target), numPages || target))
    pendingEdge.current = null
    if (t === page) {
      if (view === 'blocks') {
        setBlock(Math.max(0, targetBlock))
        setFace('orig')
      }
      return
    }
    setDirection(t > page ? 'next' : 'prev')
    setBlock(Math.max(0, targetBlock))
    setFace('orig')
    setPage(t)
  }, [page, numPages, view])

  const setViewAndPersist = useCallback((next: PdfView) => {
    setView(next)
    savePdfView(next)
  }, [])

  const toggleStudy = useCallback(() => {
    const next = !studyOn
    setStudyOn(next)
    setFace('orig') // al cambiar de modo se cae al original del bloque actual
    if (next) setViewAndPersist('blocks') // el estudio vive sobre los bloques
  }, [studyOn, setViewAndPersist])

  // Navegación fresca para el listener global: se suscribe una sola vez y
  // lee el turno vigente por ref (un closure viejo giraría página en vez
  // de bloque justo después de extraer).
  const navRef = useRef({ turnNext, turnPrev, zoomIn, zoomOut, zoomReset })
  navRef.current = { turnNext, turnPrev, zoomIn, zoomOut, zoomReset }

  // ── Teclado ←/→/espacio/PageUp/PageDown y lupa +/−/0 ──────────────────
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
          navRef.current.turnNext()
          break
        case 'ArrowLeft':
        case 'PageUp':
          e.preventDefault()
          navRef.current.turnPrev()
          break
        case '+':
        case '=':
          e.preventDefault()
          navRef.current.zoomIn()
          break
        case '-':
        case '_':
          e.preventDefault()
          navRef.current.zoomOut()
          break
        case '0':
          e.preventDefault()
          navRef.current.zoomReset()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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

  // ── Lupa con Ctrl+rueda (y pinch de trackpad): listener nativo no pasivo
  // para poder preventDefault y que la página no haga scroll/zoom del navegador
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      setZoom(z => stepZoom(z, e.deltaY < 0 ? 'in' : 'out'))
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [])

  // ── Pulsación larga: diccionario sobre la palabra (dedo o mouse) ─────────
  // Mantener 550 ms quieto marca la palabra en azul y abre su significado;
  // mover cancela (scroll, swipe o selección siguen intactos). Tap corto:
  // controles o vuelta de página, como siempre. La pulsación que abre —y el
  // tap que cierra— no navegan ni abren el menú de resaltado.
  const HOLD_MS = 550

  const clearHold = () => {
    if (holdTimer.current != null) { clearTimeout(holdTimer.current); holdTimer.current = null }
    holdPoint.current = null
  }

  const fireHold = (x: number, y: number) => {
    holdTimer.current = null
    holdPoint.current = null
    // las zonas de tap tapan el texto: se transparentan un instante para
    // preguntar la palabra bajo el punto (sin pintar entre medias)
    const stage = stageRef.current
    const zones = stage ? Array.from(stage.querySelectorAll<HTMLElement>('.reader-zone')) : []
    const prev = zones.map(z => z.style.pointerEvents)
    zones.forEach(z => { z.style.pointerEvents = 'none' })
    let found = null
    try {
      found = wordRangeAtPoint(x, y)
    } finally {
      zones.forEach((z, i) => { z.style.pointerEvents = prev[i] })
    }
    if (!found) return
    const span = wordSpan(found.text, found.offset)
    if (!span) return
    dictHoldAt.current = Date.now()
    // marca azul exacta sobre la palabra (reemplaza la selección nativa)
    try {
      const node = found.range.startContainer
      found.range.setStart(node, span.start)
      found.range.setEnd(node, span.end)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(found.range)
    } catch {
      /* igual se abre el popover */
    }
    try { navigator.vibrate?.(10) } catch { /* sin vibración */ }
    setDictReq({ x, y, text: found.text, offset: found.offset })
  }

  // Achica el marcado a la palabra hallada (el hanzi compuesto puede caer
  // al simple). Solo toca la selección si sigue siendo la del diccionario.
  const adjustDictSelection = (text: string, offset: number, word: string) => {
    try {
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return
      const span = wordSpan(text, offset)
      if (!span) return
      const range = sel.getRangeAt(0)
      const node = range.startContainer
      if (node.nodeType !== Node.TEXT_NODE || node.textContent !== text) return
      range.setStart(node, span.start)
      range.setEnd(node, span.start + word.length)
      sel.removeAllRanges()
      sel.addRange(range)
    } catch {
      /* el marcado aproximado igual sirve */
    }
  }

  const startHold = (x: number, y: number) => {
    clearHold()
    holdPoint.current = { x, y }
    holdTimer.current = setTimeout(() => fireHold(x, y), HOLD_MS)
  }

  // el dedo tiembla más que el mouse: tolerancias distintas
  const cancelHoldOnMove = (x: number, y: number, slop: number) => {
    const p = holdPoint.current
    if (p && Math.hypot(x - p.x, y - p.y) > slop) clearHold()
  }

  const closeDict = useCallback(() => {
    dictClosedAt.current = Date.now()
    setDictReq(null)
    window.getSelection()?.removeAllRanges() // se lleva el marcado azul
  }, [])

  const dictBusy = () => Date.now() - dictHoldAt.current < 1200 || Date.now() - dictClosedAt.current < 400

  // Controles donde la pulsación larga no aplica (las zonas de tap sí: son
  // transparentes al dedo y la palabra vive debajo de ellas).
  const holdBlocked = (target: HTMLElement | null) =>
    target?.closest?.('.bookmark-ribbon, .dict-popover, .selection-menu, .note-editor, .annotations-panel, input, select, textarea') != null

  // ── Selección de texto sobre el textLayer (mouseup con puntero fino) ──
  // Con puntero fino (mouse) las zonas de tap dejan de capturar los eventos
  // (CSS @media pointer:fine): este handler hace de zona de tap y de menú.
  const onStageMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    if (holdBlocked(e.target as HTMLElement | null)) return
    startHold(e.clientX, e.clientY)
  }

  const onStageMouseMove = (e: React.MouseEvent) => cancelHoldOnMove(e.clientX, e.clientY, 10)

  const onStageMouseUp = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    clearHold()
    const target = e.target as HTMLElement | null
    // controles propios (cinta, menú, editor, panel, diccionario): su click no voltea
    if (target?.closest?.('button, .selection-menu, .note-editor, .annotations-panel, .dict-popover')) return
    if (dictBusy()) return // la pulsación que abrió (o cerró) el diccionario no navega
    if (dictReq) { closeDict(); return } // primer tap cierra el diccionario
    // un mouseup que cierra el menú (dismiss) no debe también voltear la página
    if (Date.now() - menuDismissedAt.current < 250) return
    const sel = window.getSelection()
    // en vista bloques (puntero fino) el tap simple navega por zonas 40/20/40,
    // salvo que haya una selección de texto en curso (se respeta el arrastre)
    if (view === 'blocks') {
      if (sel && !sel.isCollapsed && sel.rangeCount > 0) return
      const stage = stageRef.current
      if (!stage) return
      const rect = stage.getBoundingClientRect()
      const xr = rect.width ? (e.clientX - rect.left) / rect.width : 0.5
      if (xr < 0.4) turnPrev()
      else if (xr > 0.6) turnNext()
      else setChromeVisible(v => !v)
      return
    }
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
    // un solo dedo quieto: arranca la pulsación larga del diccionario
    if (e.touches.length === 1 && t && !holdBlocked(e.target as HTMLElement | null)) {
      startHold(t.clientX, t.clientY)
    }
  }
  const onTouchMove = (e: React.TouchEvent) => {
    const t = e.touches[0]
    if (t) cancelHoldOnMove(t.clientX, t.clientY, 24)
  }
  const onTouchEnd = (e: React.TouchEvent) => {
    clearHold()
    const start = touchStart.current
    touchStart.current = null
    if (!start) return
    // con lupa el gesto horizontal panea el contenido (scroll nativo): no voltea
    if (zoomed) return
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

  // Un tap sobre una zona justo después de un swipe no repite la vuelta;
  // tampoco navega la pulsación del diccionario ni el tap que lo cierra.
  const guardSwipe = (fn: () => void) => () => {
    if (Date.now() - swipedAt.current < 400) return
    if (dictBusy()) return
    if (dictReq) { closeDict(); return }
    fn()
  }

  const blockCount = view === 'blocks' && pageBlocks ? pageBlocks.length : 0
  const blockTag = blockCount > 0
    ? (activeBlock?.kind === 'image'
      ? ' · imagen'
      : studyOn ? (face === 'trans' ? ' · traducción' : ' · original') : '')
    : ''
  const percent = numPages
    ? (view === 'blocks' && pageBlocks && blockCount > 0
      ? (() => {
        const { index, total } = studyScreenPosition(pageBlocks, block, face, studyOn)
        return blockPercent(page, index, total, numPages)
      })()
      : (page / numPages) * 100)
    : 0
  const label = numPages
    ? (view === 'blocks' && blockCount > 0
      ? `pág. ${page} de ${numPages} · bloque ${block + 1} de ${blockCount}${blockTag}`
      : `pág. ${page} de ${numPages}`)
    : ''
  const activeParagraphs = activeBlock?.kind === 'text' ? activeBlock.paragraphs : null
  const translationParagraphs = translation
    ? translation.split(/\n+/).map(p => p.trim()).filter(p => p.length > 0)
    : []
  const imageOrdinal = activeBlock?.kind === 'image' && pageBlocks
    ? pageBlocks.filter(b => b.kind === 'image').indexOf(activeBlock) + 1
    : 0
  const imageTotal = pageBlocks ? pageBlocks.filter(b => b.kind === 'image').length : 0

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

      {chromeVisible && (
        <div className="reader-subbar" role="toolbar" aria-label="Opciones de lectura">
          <div className="seg" role="group" aria-label="Vista">
            <button type="button" className="reader-tool" aria-pressed={view === 'page'}
              onClick={() => setViewAndPersist('page')}>
              Página
            </button>
            <button type="button" className="reader-tool" aria-pressed={view === 'blocks'}
              onClick={() => setViewAndPersist('blocks')}>
              Bloques
            </button>
          </div>
          <button type="button" className="reader-tool" aria-pressed={studyOn} onClick={toggleStudy}>
            {studyOn ? 'Estudio: activado' : 'Estudio bilingüe'}
          </button>
          {studyOn && (
            <select className="reader-tool reader-select" aria-label="Idioma de traducción"
              value={studyLang} onChange={e => setStudyLang(e.target.value as StudyLang)}>
              {STUDY_LANGS.map(l => (
                <option key={l.code} value={l.code}>{l.label}</option>
              ))}
            </select>
          )}
          <div className="seg" role="group" aria-label="Lupa">
            <button type="button" className="reader-tool" aria-label="Reducir zoom"
              disabled={zoom <= ZOOM_MIN} onClick={zoomOut}>−</button>
            <button type="button" className="reader-tool zoom-value" aria-label="Restablecer zoom"
              title="Restablecer zoom (0)" onClick={zoomReset}>{Math.round(zoom * 100)}%</button>
            <button type="button" className="reader-tool" aria-label="Aumentar zoom"
              disabled={zoom >= ZOOM_MAX} onClick={zoomIn}>+</button>
          </div>
        </div>
      )}

      <div className="reader-stage" ref={stageRef} onTouchStart={onTouchStart} onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd} onMouseDown={onStageMouseDown} onMouseMove={onStageMouseMove}
        onMouseUp={onStageMouseUp}>
        {view === 'blocks' ? (
          <div className="block-screen" key={`${page}:${block}:${face}`}
            style={{ '--block-zoom': zoom } as React.CSSProperties}>
            {pageBlocks === null && !blocksError && (
              <div className="reader-loading">Extrayendo texto…</div>
            )}
            {blocksError && <p role="alert" className="lib-alert reader-error">{blocksError}</p>}
            {pageBlocks !== null && blockCount === 0 && !blocksError && (
              <div className="block-empty">
                <p>Esta página no tiene contenido extraíble.</p>
                <button type="button" className="btn" onClick={() => setViewAndPersist('page')}>
                  Ver página original
                </button>
              </div>
            )}
            {activeBlock?.kind === 'image' && (
              <figure className="block-figure" key={`img-${block}`}>
                <img src={activeBlock.src} alt={activeBlock.alt} />
                <figcaption>Imagen {imageOrdinal} de {imageTotal} · pág. {page}</figcaption>
              </figure>
            )}
            {activeParagraphs && (!studyOn || face === 'orig') && (
              <article className="block-prose">
                {activeParagraphs.map((p, i) => <p key={i}>{p}</p>)}
              </article>
            )}
            {activeParagraphs && studyOn && face === 'trans' && (
              <article className="block-prose" lang={studyLang}>
                <p className="block-note">Traducción · {studyLangLabel(studyLang)}</p>
                {translating && <p className="block-note">Traduciendo…</p>}
                {transError && (
                  <>
                    <p role="alert" className="lib-alert">{transError}</p>
                    <p>
                      <button type="button" className="reader-tool"
                        onClick={() => setTransNonce(n => n + 1)}>
                        Reintentar
                      </button>
                    </p>
                  </>
                )}
                {!translating && !transError && translationParagraphs.map((p, i) => <p key={i}>{p}</p>)}
              </article>
            )}
            {blockCount > 0 && (
              <p className="block-pager">
                Bloque {Math.min(block, blockCount - 1) + 1} de {blockCount}{blockTag}
              </p>
            )}
          </div>
        ) : zoomed ? (
        <div className="zoom-scroll">
          <PdfPageCanvas canvasRef={canvasRef} textLayerRef={textLayerRef} night={night} pageAnnotations={pageAnnotations} />
        </div>
        ) : (
        <PageTurn key={page} direction={direction} night={night}>
          <PdfPageCanvas canvasRef={canvasRef} textLayerRef={textLayerRef} night={night} pageAnnotations={pageAnnotations} />
        </PageTurn>
        )}

        {loading && !loadError && <div className="reader-loading">Cargando…</div>}
        {loadError && <p role="alert" className="lib-alert reader-error">{loadError}</p>}
        {actionError && <p role="alert" className="lib-alert reader-error">{actionError}</p>}

        {/* Marcador: cinta en la esquina, visible también en modo inmersivo */}
        <BookmarkButton marked={bookmarked} onToggle={() => void toggleBookmark()} />

        {/* Con lupa las zonas se esconden: taparían el paneo del contenido */}
        {!zoomed && (
          <>
            {/* Zonas de tap: 40 % izquierda (anterior), 20 % centro (controles), 40 % derecha (siguiente) */}
            <button type="button" className="reader-zone left" aria-label="Página anterior"
              onClick={guardSwipe(turnPrev)} disabled={page <= 1} />
            <button type="button" className="reader-zone center"
              aria-label={chromeVisible ? 'Ocultar controles' : 'Mostrar controles'}
              onClick={guardSwipe(() => setChromeVisible(v => !v))} />
            <button type="button" className="reader-zone right" aria-label="Página siguiente"
              onClick={guardSwipe(turnNext)} />
          </>
        )}
      </div>

      {/* Barra flotante con lupa: visible aun en inmersivo, con vuelta de hoja */}
      {zoomed && (
        <div className="zoom-bar floating" role="toolbar" aria-label="Lupa">
          <button type="button" className="reader-tool" aria-label="Anterior" onClick={turnPrev}>‹</button>
          <button type="button" className="reader-tool" aria-label="Reducir zoom"
            disabled={zoom <= ZOOM_MIN} onClick={zoomOut}>−</button>
          <button type="button" className="reader-tool zoom-value" aria-label="Restablecer zoom"
            onClick={zoomReset}>{Math.round(zoom * 100)}%</button>
          <button type="button" className="reader-tool" aria-label="Aumentar zoom"
            disabled={zoom >= ZOOM_MAX} onClick={zoomIn}>+</button>
          <button type="button" className="reader-tool" aria-label="Siguiente" onClick={turnNext}>›</button>
        </div>
      )}

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
              if (pos && typeof pos.page === 'number') {
                jumpTo(pos.page, typeof pos.block === 'number' ? pos.block : 0)
              }
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
          onClose={dismissSelectionMenu}
        />
      )}

      {dictReq && (
        <DictPopover
          x={dictReq.x}
          y={dictReq.y}
          word={wordCandidates(dictReq.text, dictReq.offset)[0] ?? ''}
          entry={dictEntry}
          entry2={dictEntry2}
          loading={dictLoading}
          error={dictError}
          onRetry={() => setDictNonce(n => n + 1)}
          onClose={closeDict}
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
// apps/web/src/pages/Library.tsx — biblioteca estilo estantería: pestaña «Mis libros»
// (grilla de estantes, seguir leyendo, subida personal/global y menú contextual)
// y pestaña «Biblioteca global» (libros compartidos con búsqueda y adopción).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type Book, type Folder, type Visibility } from '../api'
import { useAuth } from '../state/AuthContext'
import FolderDialog from './FolderDialog'

const ACCEPT = '.pdf,.epub'

export const SWATCH_COLORS = ['#ef4444', '#f59e0b', '#3b82f6', '#22c55e', '#a855f7', '#ec4899', '#14b8a6', '#6b7280'] as const
export const SWATCH_NAMES: Record<string, string> = {
  '#ef4444': 'rojo', '#f59e0b': 'ámbar', '#3b82f6': 'azul', '#22c55e': 'verde',
  '#a855f7': 'violeta', '#ec4899': 'rosa', '#14b8a6': 'turquesa', '#6b7280': 'gris',
}

function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg || 'Error inesperado'
}

/** Iniciales del título (hasta dos letras) para la portada de relleno. */
function initials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean)
  return words.slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || '?'
}

function fileSizeLabel(size: unknown): string | null {
  const n = Number(size)
  if (!Number.isFinite(n) || n <= 0) return null
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`
}

export function Cover({ book, className }: { book: Book; className?: string }) {
  return book.cover_url
    ? <img src={book.cover_url} alt={`Portada de ${book.title}`} />
    : <div className={`cover-fallback ${className ?? ''}`} aria-hidden="true">{initials(book.title)}</div>
}

function ProgressBar({ value, className }: { value: number; className?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)))
  return (
    <div className={`progress ${className ?? ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <span className="bar"><span style={{ width: `${pct}%` }} /></span>
      <span className="pct">{pct}%</span>
    </div>
  )
}

/** Menú contextual con confirmación en línea para eliminar. */
function ConfirmMenu({ book, folders, onContinue, onReset, onMove, onDelete }: {
  book: Book
  folders: Folder[]
  onContinue: () => void
  onReset: () => Promise<void>
  onMove: (folderId: string | null) => Promise<void>
  onDelete: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) { setOpen(false); setArmed(false) } }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setArmed(false) } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const close = () => { setOpen(false); setArmed(false) }

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    try { await fn(); close() } finally { setBusy(false) }
  }

  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className="menu-btn" aria-label={`Opciones de ${book.title}`}
        aria-haspopup="menu" aria-expanded={open}
        onClick={() => { setOpen(o => !o); setArmed(false) }}>⋯</button>
      {open && (
        <div className="menu" role="menu" aria-label={`Acciones de ${book.title}`}>
          <button type="button" role="menuitem" disabled={busy} onClick={() => act(async () => { onContinue() })}>Continuar</button>
          <button type="button" role="menuitem" disabled={busy} onClick={() => act(onReset)}>Desde el principio</button>
          {folders.map(f => (
            <button type="button" key={f.id} role="menuitem" disabled={busy}
              onClick={() => act(() => onMove(f.id))}>Mover a {f.name}</button>
          ))}
          {book.folder_id && (
            <button type="button" role="menuitem" disabled={busy}
              onClick={() => act(() => onMove(null))}>Sacar de la carpeta</button>
          )}
          <button type="button" role="menuitem" className="danger" disabled={busy}
            onClick={() => armed ? act(onDelete) : setArmed(true)}>
            {armed ? 'Confirmar eliminación' : 'Eliminar'}
          </button>
          {armed && <button type="button" role="menuitem" disabled={busy} onClick={() => setArmed(false)}>Cancelar</button>}
        </div>
      )}
    </div>
  )
}

// ── Estantería ─────────────────────────────────────────────────────────────
// Los libros se agrupan en filas (tantas columnas como quepan según el ancho
// medido) y cada fila lleva su tabla de madera debajo. La altura de cada lomo
// varía por hash del id para el look de estante real; el ancho sale de la
// proporción 2/3 y es el mismo en el estante y en su etiqueta.
const SHELF_HEIGHTS = [172, 192, 208, 182, 200, 164]

function shelfHeight(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return SHELF_HEIGHTS[h % SHELF_HEIGHTS.length]
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function ShelfGrid({ books, renderStand, renderCaption }: {
  books: Book[]
  renderStand: (book: Book) => React.ReactNode
  renderCaption: (book: Book) => React.ReactNode
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  // jsdom no mide (clientWidth 0): 4 columnas de relevo para que todo se vea
  const [cols, setCols] = useState(4)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => {
      const w = el.clientWidth
      if (!w) { setCols(4); return }
      setCols(Math.max(2, Math.min(6, Math.floor((w + 16) / (150 + 16)))))
    }
    measure()
    let ro: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure)
      ro.observe(el)
    }
    window.addEventListener('resize', measure)
    return () => { ro?.disconnect(); window.removeEventListener('resize', measure) }
  }, [])
  const rows = useMemo(() => chunk(books, Math.max(cols, 1)), [books, cols])
  return (
    <div className="shelves" ref={wrapRef}>
      {rows.map((row, i) => (
        <div className="shelf-row" key={i}>
          <div className="shelf-stands">
            {row.map(b => (
              <div className="shelf-stand" key={b.id} style={{ '--book-h': `${shelfHeight(b.id)}px` } as React.CSSProperties}>
                {renderStand(b)}
              </div>
            ))}
          </div>
          <div className="shelf-plank" aria-hidden="true" />
          <div className="shelf-captions">
            {row.map(b => (
              <div className="shelf-caption" key={b.id} style={{ '--book-h': `${shelfHeight(b.id)}px` } as React.CSSProperties}>
                {renderCaption(b)}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function MineStand({ book, folders, onMove, onReset, onDelete }: {
  book: Book
  folders: Folder[]
  onMove: (bookId: string, folderId: string | null) => Promise<void>
  onReset: (b: Book) => Promise<void>
  onDelete: (b: Book) => Promise<void>
}) {
  const navigate = useNavigate()
  const open = () => navigate(`/reader/${book.id}`)
  return (
    <article className="book-card shelf-book" data-testid={`book-card-${book.id}`}
      style={{ '--book-h': `${shelfHeight(book.id)}px` } as React.CSSProperties}
      draggable
      onDragStart={e => {
        // HTML5 DnD nativo (desktop); el menú «Mover a…» es el relevo accesible/táctil
        e.dataTransfer.setData('text/book-id', book.id)
        e.dataTransfer.setData('text/plain', book.id)
        e.dataTransfer.effectAllowed = 'move'
      }}>
      <button type="button" className="book-cover shelf-cover" onClick={open} aria-label={`Abrir ${book.title}`}>
        <Cover book={book} />
        <span className="spine" aria-hidden="true" />
      </button>
      <ConfirmMenu book={book} folders={folders} onContinue={open} onReset={() => onReset(book)}
        onMove={folderId => onMove(book.id, folderId)} onDelete={() => onDelete(book)} />
      {book.visibility === 'global' && <span className="badge-global" title="Este libro lo compartes con todos">Global</span>}
    </article>
  )
}

function MineCaption({ book }: { book: Book }) {
  const pct = book.percent == null ? 0 : Number(book.percent)
  const pagesLabel = book.format === 'pdf' && book.total_pages != null
    && book.position && 'page' in book.position && pct > 0
    ? `Pág. ${book.position.page} de ${book.total_pages}`
    : null
  const size = fileSizeLabel(book.file_size)
  return (
    <div className="book-meta">
      <h3 className="book-title">{book.title}</h3>
      <p className="book-author">{book.author}</p>
      <ProgressBar value={pct} />
      {pagesLabel && <span className="book-pages">{pagesLabel}</span>}
      {size && <span className="book-size">{size}</span>}
    </div>
  )
}

function GlobalStand({ book }: { book: Book }) {
  const navigate = useNavigate()
  return (
    <article className="book-card shelf-book" data-testid={`global-card-${book.id}`}
      style={{ '--book-h': `${shelfHeight(book.id)}px` } as React.CSSProperties}>
      <button type="button" className="book-cover shelf-cover" onClick={() => navigate(`/reader/${book.id}`)}
        aria-label={`Leer ${book.title}`}>
        <Cover book={book} />
        <span className="spine" aria-hidden="true" />
      </button>
      <span className="badge-global" title={book.owner_email ? `Compartido por ${book.owner_email}` : 'Libro global'}>Global</span>
    </article>
  )
}

function GlobalCaption({ book, adopted, adopting, onAdopt }: {
  book: Book
  adopted: boolean
  adopting: boolean
  onAdopt: (b: Book) => void
}) {
  const pct = book.percent == null ? 0 : Number(book.percent)
  const mine = adopted || book.is_mine
  return (
    <div className="book-meta">
      <h3 className="book-title">{book.title}</h3>
      <p className="book-author">{book.author}</p>
      {book.owner_email && <p className="book-owner">de {book.owner_email}</p>}
      {book.last_read && <ProgressBar value={pct} />}
      {mine
        ? <span className="book-adopted">En tu biblioteca</span>
        : (
          <button type="button" className="btn btn-primary btn-adopt" disabled={adopting}
            onClick={() => onAdopt(book)}>
            {adopting ? 'Añadiendo…' : '+ Añadir a mi biblioteca'}
          </button>
        )}
    </div>
  )
}

/** Tarjeta de carpeta: color, nombre, contador, menú editar/eliminar y zona de drop. */
function FolderCard({ folder, active, onOpen, onEdit, onDelete, onDropBook }: {
  folder: Folder
  active: boolean
  onOpen: () => void
  onEdit: () => void
  onDelete: () => Promise<void>
  onDropBook?: (bookId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) { setOpen(false); setArmed(false) } }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setArmed(false) } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const close = () => { setOpen(false); setArmed(false) }
  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    try { await fn(); close() } finally { setBusy(false) }
  }
  // sin onDropBook la tarjeta no es zona de drop (se activa en Task 8)
  const dropProps = onDropBook ? {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setOver(true) },
    onDragLeave: () => setOver(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault(); setOver(false)
      const id = e.dataTransfer?.getData('text/book-id') || e.dataTransfer?.getData('text/plain')
      if (id) onDropBook(id)
    },
  } : {}

  return (
    <div className={`folder-card ${active ? 'active' : ''} ${over ? 'drag-over' : ''}`}
      data-testid={`folder-card-${folder.id}`}
      style={{ '--folder-color': folder.color } as React.CSSProperties}
      {...dropProps}>
      <button type="button" className="folder-open" onClick={onOpen} aria-label={`Carpeta ${folder.name}`}>
        <span className="folder-swatch" aria-hidden="true" />
        <span className="folder-name">{folder.name}</span>
        <span className="folder-count">{folder.book_count}</span>
      </button>
      <div className="menu-wrap" ref={ref}>
        <button type="button" className="menu-btn" aria-label={`Opciones de la carpeta ${folder.name}`}
          aria-haspopup="menu" aria-expanded={open}
          onClick={() => { setOpen(o => !o); setArmed(false) }}>⋯</button>
        {open && (
          <div className="menu" role="menu" aria-label={`Acciones de la carpeta ${folder.name}`}>
            <button type="button" role="menuitem" disabled={busy}
              onClick={() => { onEdit(); close() }}>Editar</button>
            <button type="button" role="menuitem" className="danger" disabled={busy}
              onClick={() => armed ? act(onDelete) : setArmed(true)}>
              {armed ? 'Confirmar eliminación' : 'Eliminar'}
            </button>
            {armed && <button type="button" role="menuitem" disabled={busy} onClick={() => setArmed(false)}>Cancelar</button>}
          </div>
        )}
      </div>
    </div>
  )
}

/** Botón + zona de arrastrar y soltar para subir libros, con alcance personal/global. */
function AddBookControl({ uploading, visibility, onVisibility, onFile }: {
  uploading: { name: string; progress: number } | null
  visibility: Visibility
  onVisibility: (v: Visibility) => void
  onFile: (file: File) => Promise<void>
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer?.files?.[0]
    if (file) await onFile(file)
  }

  return (
    <section className="add-book">
      <div className="add-book-row">
        <button type="button" className="btn btn-primary" disabled={!!uploading}
          onClick={() => inputRef.current?.click()}>Añadir libro</button>
        <div className="seg" role="group" aria-label="Quién puede ver el libro">
          <button type="button" className="reader-tool" aria-pressed={visibility === 'personal'}
            disabled={!!uploading} onClick={() => onVisibility('personal')}
            title="Solo tú verás este libro">
            Solo para mí
          </button>
          <button type="button" className="reader-tool" aria-pressed={visibility === 'global'}
            disabled={!!uploading} onClick={() => onVisibility('global')}
            title="Todos podrán verlo y añadirlo a su biblioteca">
            Para todos
          </button>
        </div>
        <input ref={inputRef} type="file" accept={ACCEPT} aria-label="Elegir archivo para subir" className="visually-hidden"
          onChange={async e => {
            const file = e.target.files?.[0]
            if (file) await onFile(file)
            e.target.value = ''
          }} />
      </div>
      <div className={`drop-zone ${dragging ? 'drag' : ''}`}
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}>
        Arrastra un PDF o EPUB aquí para agregarlo
        {visibility === 'global' ? ' (visible para todos)' : ' (solo para ti)'}
      </div>
      {uploading && (
        <div className="upload-bar">
          <p className="upload-name">Subiendo {uploading.name}…</p>
          <ProgressBar value={uploading.progress * 100} />
        </div>
      )}
    </section>
  )
}

/** Bytes del archivo; usa arrayBuffer si existe y FileReader como relevo. */
function fileBytes(file: File): Promise<Uint8Array> {
  if (typeof (file as Blob).arrayBuffer === 'function') {
    return (file as Blob).arrayBuffer().then(b => new Uint8Array(b))
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error ?? new Error('No se pudo leer el archivo'))
    reader.readAsArrayBuffer(file)
  })
}

/** Genera una portada JPEG de 400 px desde la primera página de un PDF.
 *  pdfjs se importa dinámicamente para no meterlo en el bundle principal. */
export async function makePdfCover(file: File): Promise<Blob> {
  const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist')
  GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
  const data = await fileBytes(file)
  const doc = await getDocument({ data }).promise
  try {
    const page = await doc.getPage(1)
    const base = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: 400 / base.width })
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(viewport.width)
    canvas.height = Math.round(viewport.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas no disponible')
    await page.render({ canvasContext: ctx, viewport }).promise
    page.cleanup()
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8))
    if (!blob) throw new Error('No se pudo generar la portada')
    return blob
  } finally {
    await doc.destroy()
  }
}

export default function Library() {
  const navigate = useNavigate()
  const { signOut } = useAuth()
  const [books, setBooks] = useState<Book[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [order, setOrder] = useState<'reciente' | 'titulo'>('reciente')
  const [uploading, setUploading] = useState<{ name: string; progress: number } | null>(null)
  const [visibility, setVisibility] = useState<Visibility>('personal')
  const [folders, setFolders] = useState<Folder[]>([])
  const [foldersFailed, setFoldersFailed] = useState(false)
  const [allOver, setAllOver] = useState(false)
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ kind: 'new' } | { kind: 'edit'; folder: Folder } | null>(null)
  // pestaña global: se carga perezosa al abrirla por primera vez
  const [tab, setTab] = useState<'mine' | 'global'>('mine')
  const [globalBooks, setGlobalBooks] = useState<Book[]>([])
  const [globalLoaded, setGlobalLoaded] = useState(false)
  const [globalLoading, setGlobalLoading] = useState(false)
  const [globalError, setGlobalError] = useState<string | null>(null)
  const [globalQuery, setGlobalQuery] = useState('')
  const [adopting, setAdopting] = useState<string | null>(null)
  const [adopted, setAdopted] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    try {
      // la lista de carpetas es secundaria, pero su fallo no puede
      // esconder libros: se avisa y se muestran todos (sin filtro de carpeta)
      const [booksRes, foldersRes] = await Promise.allSettled([api.listBooks(), api.listFolders()])
      if (booksRes.status === 'rejected') {
        setError(`No se pudo cargar la biblioteca: ${errorMessage(booksRes.reason)}`)
      } else {
        setBooks(booksRes.value)
        setError(null)
      }
      if (foldersRes.status === 'fulfilled') {
        setFolders(foldersRes.value)
        setFoldersFailed(false)
      } else {
        setFolders([])
        setFoldersFailed(true)
        setActiveFolderId(null)
        setNotice(`No se pudieron cargar las carpetas: ${errorMessage(foldersRes.reason)}`)
      }
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (tab !== 'global' || globalLoaded) return
    setGlobalLoading(true)
    api.listGlobalBooks()
      .then(rows => { setGlobalBooks(rows); setGlobalError(null) })
      .catch(err => setGlobalError(`No se pudo cargar la biblioteca global: ${errorMessage(err)}`))
      .finally(() => { setGlobalLoading(false); setGlobalLoaded(true) })
  }, [tab, globalLoaded])

  const continueBook = useMemo(() => {
    return books.reduce<Book | null>((best, b) => {
      if (!b.last_read) return best
      if (!best || (b.last_read ?? '') > (best.last_read ?? '')) return b
      return best
    }, null)
  }, [books])

  const visible = useMemo(() => {
    // Todos muestra toda la biblioteca sin importar la carpeta; solo al
    // entrar a una carpeta se filtra a sus libros
    const inFolder = foldersFailed || activeFolderId == null
      ? books
      : books.filter(b => b.folder_id === activeFolderId)
    const q = query.trim().toLowerCase()
    const filtered = q
      ? inFolder.filter(b => b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q))
      : inFolder
    return order === 'titulo' ? [...filtered].sort((a, b) => a.title.localeCompare(b.title, 'es')) : filtered
  }, [books, query, order, activeFolderId, foldersFailed])

  const globalVisible = useMemo(() => {
    const q = globalQuery.trim().toLowerCase()
    if (!q) return globalBooks
    return globalBooks.filter(b =>
      b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q) ||
      (b.owner_email ?? '').toLowerCase().includes(q))
  }, [globalBooks, globalQuery])

  const activeFolder = activeFolderId == null ? null : folders.find(f => f.id === activeFolderId) ?? null

  const moveBook = useCallback(async (bookId: string, folderId: string | null) => {
    setNotice(null)
    try {
      await api.setBookFolder(bookId, folderId)
      await load()
    } catch (err) {
      setNotice(`No se pudo mover el libro: ${errorMessage(err)}`)
      await load()
    }
  }, [load])

  const adopt = useCallback(async (book: Book) => {
    setNotice(null)
    setAdopting(book.id)
    try {
      await api.adoptBook(book.id)
      setAdopted(prev => new Set(prev).add(book.id))
      setNotice(`«${book.title}» se añadió a tu biblioteca.`)
      await load() // mi estante ya incluye la copia
    } catch (err) {
      setNotice(`No se pudo añadir el libro: ${errorMessage(err)}`)
    } finally {
      setAdopting(null)
    }
  }, [load])

  const handleFile = async (file: File) => {
    setNotice(null)
    if (!/\.(pdf|epub)$/i.test(file.name)) {
      setNotice('Formato no admitido: sólo PDF o EPUB.')
      return
    }
    setUploading({ name: file.name, progress: 0 })
    try {
      const created = await api.uploadBook(file, p => setUploading(u => u ? { ...u, progress: p } : u), visibility)
      if (created.format === 'pdf') {
        try {
          const blob = await makePdfCover(file)
          await api.patchCover(created.id, blob)
        } catch { /* sin portada generada: queda la de iniciales */ }
      }
      await load()
    } catch (err) {
      setNotice(`No se pudo subir el archivo: ${errorMessage(err)}`)
    } finally {
      setUploading(null)
    }
  }

  if (loading) return <div className="page-center">Cargando…</div>

  return (
    <main className="library">
      <header className="lib-top">
        <h1>{tab === 'mine' ? 'Mi biblioteca' : 'Biblioteca global'}</h1>
        <div className="lib-tools">
          {tab === 'mine' && (
            <>
              <input type="search" aria-label="Buscar" placeholder="Buscar por título o autor"
                value={query} onChange={e => setQuery(e.target.value)} />
              <select aria-label="Orden" value={order} onChange={e => setOrder(e.target.value as 'reciente' | 'titulo')}>
                <option value="reciente">Reciente</option>
                <option value="titulo">Título</option>
              </select>
            </>
          )}
          <button type="button" className="btn" aria-label="Cerrar sesión"
            onClick={() => { void signOut().finally(() => navigate('/login')) }}>
            Salir
          </button>
        </div>
      </header>

      <div className="lib-tabs" role="tablist" aria-label="Bibliotecas">
        <button type="button" role="tab" aria-selected={tab === 'mine'}
          className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')}>
          Mis libros
        </button>
        <button type="button" role="tab" aria-selected={tab === 'global'}
          className={tab === 'global' ? 'active' : ''} onClick={() => setTab('global')}>
          Biblioteca global
        </button>
      </div>

      {error && <p role="alert" className="lib-alert">{error}</p>}
      {notice && <p role="alert" className="lib-alert">{notice}</p>}

      {tab === 'global' ? (
        <section aria-label="Libros compartidos por todos">
          <div className="lib-tools global-search">
            <input type="search" aria-label="Buscar en la biblioteca global" placeholder="Buscar por título, autor o quién lo compartió"
              value={globalQuery} onChange={e => setGlobalQuery(e.target.value)} />
          </div>
          {globalLoading && <div className="page-center">Cargando…</div>}
          {globalError && <p role="alert" className="lib-alert">{globalError}</p>}
          {!globalLoading && !globalError && globalVisible.length === 0 && (
            <div className="empty-state">
              {globalQuery
                ? (<><h2>Sin resultados</h2><p>Ningún libro global coincide con «{globalQuery.trim()}».</p></>)
                : (<><h2>Aún no hay libros globales</h2><p>Cuando alguien suba un libro «Para todos» aparecerá aquí para leerlo o añadirlo a tu biblioteca.</p></>)}
            </div>
          )}
          {!globalLoading && !globalError && globalVisible.length > 0 && (
            <ShelfGrid books={globalVisible}
              renderStand={b => <GlobalStand book={b} />}
              renderCaption={b => (
                <GlobalCaption book={b} adopted={adopted.has(b.id)} adopting={adopting === b.id} onAdopt={adopt} />
              )} />
          )}
        </section>
      ) : (
        <>
          {/* con carpetas caídas se oculta la fila: sin carpetas conocidas el filtro sería una trampa */}
          {!foldersFailed && (
          <section className="folder-row-wrap" data-testid="folder-row" aria-label="Carpetas">
            <div className="folder-row">
              <button type="button" className={`folder-card all ${activeFolderId == null ? 'active' : ''} ${allOver ? 'drag-over' : ''}`}
                data-testid="folder-card-all"
                onClick={() => setActiveFolderId(null)}
                onDragOver={e => { e.preventDefault(); setAllOver(true) }}
                onDragLeave={() => setAllOver(false)}
                onDrop={e => {
                  e.preventDefault(); setAllOver(false)
                  const id = e.dataTransfer?.getData('text/book-id') || e.dataTransfer?.getData('text/plain')
                  if (id) void moveBook(id, null)
                }}>
                Todos
              </button>
              {folders.map(f => (
                <FolderCard key={f.id} folder={f} active={f.id === activeFolderId}
                  onOpen={() => setActiveFolderId(f.id)}
                  onEdit={() => setEditing({ kind: 'edit', folder: f })}
                  onDropBook={bookId => void moveBook(bookId, f.id)}
                  onDelete={async () => {
                    setNotice(null)
                    try {
                      await api.deleteFolder(f.id)
                      if (activeFolderId === f.id) setActiveFolderId(null)
                      await load()
                    } catch (err) {
                      setNotice(`No se pudo eliminar la carpeta: ${errorMessage(err)}`)
                    }
                  }} />
              ))}
              <button type="button" className="folder-card new" data-testid="new-folder"
                onClick={() => setEditing({ kind: 'new' })}>+ Nueva carpeta</button>
            </div>
          </section>
          )}

          {activeFolder && (
            <div className="folder-view-head">
              <span className="folder-swatch" style={{ '--folder-color': activeFolder.color } as React.CSSProperties} aria-hidden="true" />
              <h2>{activeFolder.name}</h2>
              <button type="button" className="btn" onClick={() => setActiveFolderId(null)}>Volver a todos</button>
            </div>
          )}

          {continueBook && (
            <section className="continue" data-testid="continue-reading" aria-label="Seguir leyendo">
              <div className="continue-cover"><Cover book={continueBook} /></div>
              <div className="continue-info">
                <p className="eyebrow">Seguir leyendo</p>
                <h2 className="continue-title">{continueBook.title}</h2>
                <p className="continue-meta">{continueBook.author}</p>
                <ProgressBar value={continueBook.percent == null ? 0 : Number(continueBook.percent)} />
              </div>
              <button type="button" className="btn btn-primary" onClick={() => navigate(`/reader/${continueBook.id}`)}>Continuar</button>
            </section>
          )}

          {visible.length === 0
            ? (
              <div className="empty-state">
                {activeFolder
                  ? (
                    <>
                      <h2>Todavía no hay libros en esta carpeta</h2>
                      <p>Arrastra un libro hasta la carpeta o usa el menú del libro para moverlo aquí.</p>
                    </>
                  )
                  : (
                    <>
                      <h2>Todavía no tienes libros</h2>
                      <p>Añade el primero con «Añadir libro» o arrastrando un PDF o EPUB a la zona de subida.</p>
                    </>
                  )}
              </div>
            )
            : (
              <ShelfGrid books={visible}
                renderStand={b => (
                  <MineStand book={b} folders={folders} onMove={moveBook}
                    onReset={async book => {
                      try {
                        await api.resetProgress(book.id)
                        await load()
                      } catch (err) {
                        setNotice(`No se pudo reiniciar el progreso: ${errorMessage(err)}`)
                      }
                    }}
                    onDelete={async book => {
                      try {
                        await api.deleteBook(book.id)
                        await load()
                      } catch (err) {
                        setNotice(`No se pudo eliminar el libro: ${errorMessage(err)}`)
                      }
                    }} />
                )}
                renderCaption={b => <MineCaption book={b} />} />
            )}

          <AddBookControl uploading={uploading} visibility={visibility} onVisibility={setVisibility} onFile={handleFile} />
        </>
      )}

      {editing && (
        <FolderDialog folder={editing.kind === 'edit' ? editing.folder : null}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load() }} />
      )}
    </main>
  )
}

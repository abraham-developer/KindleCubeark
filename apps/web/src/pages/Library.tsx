// apps/web/src/pages/Library.tsx — biblioteca: grilla, seguir leyendo, subida y menú contextual (Task 11).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type Book } from '../api'
import { useAuth } from '../state/AuthContext'

const ACCEPT = '.pdf,.epub'

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
function ConfirmMenu({ book, onContinue, onReset, onDelete }: {
  book: Book
  onContinue: () => void
  onReset: () => Promise<void>
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

function BookCard({ book, onReset, onDelete }: { book: Book; onReset: (b: Book) => Promise<void>; onDelete: (b: Book) => Promise<void> }) {
  const navigate = useNavigate()
  const open = () => navigate(`/reader/${book.id}`)
  const pct = book.percent == null ? 0 : Number(book.percent)
  const pagesLabel = book.format === 'pdf' && book.total_pages != null
    && book.position && 'page' in book.position && pct > 0
    ? `Pág. ${book.position.page} de ${book.total_pages}`
    : null
  const size = fileSizeLabel(book.file_size)

  return (
    <article className="book-card" data-testid={`book-card-${book.id}`}>
      <button type="button" className="book-cover" onClick={open} aria-label={`Abrir ${book.title}`}>
        <Cover book={book} />
      </button>
      <ConfirmMenu book={book} onContinue={open} onReset={() => onReset(book)} onDelete={() => onDelete(book)} />
      <div className="book-meta">
        <h3 className="book-title">{book.title}</h3>
        <p className="book-author">{book.author}</p>
        <ProgressBar value={pct} />
        {pagesLabel && <span className="book-pages">{pagesLabel}</span>}
        {size && <span className="book-size">{size}</span>}
      </div>
    </article>
  )
}

/** Botón + zona de arrastrar y soltar para subir libros. */
function AddBookControl({ uploading, onFile }: {
  uploading: { name: string; progress: number } | null
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
        Arrastrá un PDF o EPUB acá para agregarlo
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

  const load = useCallback(async () => {
    try {
      setBooks(await api.listBooks())
      setError(null)
    } catch (err) {
      setError(`No se pudo cargar la biblioteca: ${errorMessage(err)}`)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { load() }, [load])

  const continueBook = useMemo(() => {
    return books.reduce<Book | null>((best, b) => {
      if (!b.last_read) return best
      if (!best || (b.last_read ?? '') > (best.last_read ?? '')) return b
      return best
    }, null)
  }, [books])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? books.filter(b => b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q))
      : books
    return order === 'titulo' ? [...filtered].sort((a, b) => a.title.localeCompare(b.title, 'es')) : filtered
  }, [books, query, order])

  const handleFile = async (file: File) => {
    setNotice(null)
    if (!/\.(pdf|epub)$/i.test(file.name)) {
      setNotice('Formato no admitido: sólo PDF o EPUB.')
      return
    }
    setUploading({ name: file.name, progress: 0 })
    try {
      const created = await api.uploadBook(file, p => setUploading(u => u ? { ...u, progress: p } : u))
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
        <h1>Mi biblioteca</h1>
        <div className="lib-tools">
          <input type="search" aria-label="Buscar" placeholder="Buscar por título o autor"
            value={query} onChange={e => setQuery(e.target.value)} />
          <select aria-label="Orden" value={order} onChange={e => setOrder(e.target.value as 'reciente' | 'titulo')}>
            <option value="reciente">Reciente</option>
            <option value="titulo">Título</option>
          </select>
          <button type="button" className="btn" aria-label="Cerrar sesión"
            onClick={() => { void signOut().then(() => navigate('/login')) }}>
            Salir
          </button>
        </div>
      </header>

      {error && <p role="alert" className="lib-alert">{error}</p>}
      {notice && <p role="alert" className="lib-alert">{notice}</p>}

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
            <h2>Todavía no tenés libros</h2>
            <p>Añadí el primero con «Añadir libro» o arrastrando un PDF o EPUB a la zona de subida.</p>
          </div>
        )
        : (
          <div className="grid">
            {visible.map(b => (
              <BookCard key={b.id} book={b}
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
            ))}
          </div>
        )}

      <AddBookControl uploading={uploading} onFile={handleFile} />
    </main>
  )
}
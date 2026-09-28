// apps/web/src/reader/Reader.tsx — ruta /reader/:bookId: carga el libro con
// api.getBook y elige el lector según el formato (PDF o EPUB), con los
// lectores en chunks separados (React.lazy) para no inflar el bundle.
import { Suspense, lazy, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, type Book, type Position } from '../api'

const PdfReader = lazy(() => import('./PdfReader'))
const EpubReader = lazy(() => import('./EpubReader'))

type ReaderProgress = { position: Position; percent: string | number } | null

type InnerProps = { book: Book; progress: ReaderProgress; onBack: () => void }

function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg || 'Error inesperado'
}

export default function Reader() {
  const { bookId = '' } = useParams()
  const navigate = useNavigate()
  const [loaded, setLoaded] = useState<{ book: Book; progress: ReaderProgress } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoaded(null)
    setError(null)
    api.getBook(bookId)
      .then(res => { if (alive) setLoaded(res) })
      .catch(err => { if (alive) setError(`No se pudo abrir el libro: ${errorMessage(err)}`) })
    return () => { alive = false }
  }, [bookId])

  const onBack = () => navigate('/')

  if (error) {
    return (
      <div className="page-center" role="alert">
        <p>{error}</p>
        <button type="button" className="btn" onClick={onBack}>Volver a la biblioteca</button>
      </div>
    )
  }
  if (!loaded) return <div className="page-center">Cargando…</div>

  const Inner = loaded.book.format === 'epub' ? EpubReader : PdfReader
  return (
    <Suspense fallback={<div className="page-center">Cargando…</div>}>
      <Inner book={loaded.book} progress={loaded.progress} onBack={onBack} />
    </Suspense>
  )
}
// apps/web/src/reader/EpubReader.tsx — stub del lector EPUB; Task 13 lo
// implementa con epubjs (mantener como chunk separado, sin importar epubjs acá).
import type { Book, Position } from '../api'

type ReaderProgress = { position: Position; percent: string | number } | null

export default function EpubReader(_props: { book: Book; progress: ReaderProgress; onBack: () => void }) {
  return <div className="page-center">Lector EPUB en preparación</div>
}
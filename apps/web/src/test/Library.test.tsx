// apps/web/src/test/Library.test.tsx — biblioteca: grilla, seguir leyendo, menú, subida (Task 11).
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { api, type Book } from '../api'
import { mockApi, stubBrowser } from './mocks'
import { AuthProvider } from '../state/AuthContext'
import Library from '../pages/Library'

// pdfjs-dist se stubbea a nivel de módulo: jsdom no necesita un worker real.
vi.mock('pdfjs-dist', () => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: { workerSrc: '' },
}))
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/pdf.worker.mjs' }))

type Spy = ReturnType<typeof vi.spyOn>
let apiSpies: Spy[] = []
afterEach(() => {
  for (const s of apiSpies) s.mockRestore()
  apiSpies = []
  vi.clearAllMocks()
})

function book(over: Partial<Book> & { id: string }): Book {
  return {
    title: over.title ?? 'Sin título',
    author: over.author ?? 'Anónimo',
    format: 'epub',
    cover_url: null,
    file_url: `/api/files/${over.id}`,
    total_pages: null,
    file_size: 1_200_000,
    added_at: '2026-09-01T00:00:00Z',
    percent: null,
    position: null,
    last_read: null,
    ...over,
  }
}

const books: Book[] = [
  book({ id: 'b1', title: 'Cien años de soledad', author: 'García Márquez', percent: '38', last_read: '2026-09-20T10:00:00Z', position: { cfi: 'x', percent: 0.38, section: 0 } }),
  book({ id: 'b2', title: 'El Aleph', author: 'Borges', cover_url: '/api/files/b2/cover.jpg' }),
  book({ id: 'b3', title: 'Manual de jardinería', author: 'Ana Pérez', format: 'pdf', total_pages: 240, percent: '5', position: { page: 12 }, last_read: '2026-09-10T08:00:00Z' }),
]

function renderLibrary(entry = '/') {
  // la biblioteca usa AuthContext (logout): provider + espía de me()
  apiSpies.push(...Object.values(mockApi({ me: vi.fn(async () => null) })))
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<Library />} />
          <Route path="/reader/:bookId" element={<div>pantalla de lectura</div>} />
          <Route path="/login" element={<div>pantalla de login</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('Library — seguir leyendo', () => {
  it('muestra el libro leído más recientemente y no los otros', async () => {
    apiSpies.push(...Object.values(mockApi({ listBooks: vi.fn().mockResolvedValue(books) })))
    renderLibrary()
    const row = await screen.findByTestId('continue-reading')
    expect(within(row).getByText('Cien años de soledad')).toBeInTheDocument()
    expect(within(row).queryByText('El Aleph')).not.toBeInTheDocument()
    expect(within(row).queryByText('Manual de jardinería')).not.toBeInTheDocument()
  })

  it('se oculta cuando ningún libro tiene last_read', async () => {
    apiSpies.push(...Object.values(mockApi({ listBooks: vi.fn().mockResolvedValue([books[1]]) })))
    renderLibrary()
    await screen.findByTestId('book-card-b2')
    expect(screen.queryByTestId('continue-reading')).not.toBeInTheDocument()
  })

  it('la fila y el menú navegan a /reader/:id', async () => {
    apiSpies.push(...Object.values(mockApi({ listBooks: vi.fn().mockResolvedValue(books) })))
    renderLibrary()
    const row = await screen.findByTestId('continue-reading')
    await userEvent.click(within(row).getByRole('button', { name: /continuar/i }))
    expect(await screen.findByText('pantalla de lectura')).toBeInTheDocument()
  })
})

describe('Library — grilla', () => {
  it('la barra de progreso refleja el porcentaje 38', async () => {
    apiSpies.push(...Object.values(mockApi({ listBooks: vi.fn().mockResolvedValue(books) })))
    renderLibrary()
    await screen.findByTestId('book-card-b1')
    const values = screen.getAllByRole('progressbar').map(el => el.getAttribute('aria-valuenow'))
    expect(values).toContain('38')
    expect(screen.getAllByText('38%').length).toBeGreaterThan(0)
  })

  it('muestra "Pág. N de M" para PDF con total_pages', async () => {
    apiSpies.push(...Object.values(mockApi({ listBooks: vi.fn().mockResolvedValue([books[2]]) })))
    renderLibrary()
    await screen.findByTestId('book-card-b3')
    expect(screen.getByText('Pág. 12 de 240')).toBeInTheDocument()
  })

  it('la búsqueda filtra las tarjetas por título y por autor', async () => {
    apiSpies.push(...Object.values(mockApi({ listBooks: vi.fn().mockResolvedValue(books) })))
    renderLibrary()
    await screen.findByTestId('book-card-b1')
    await userEvent.type(screen.getByLabelText(/buscar/i), 'Aleph')
    expect(screen.queryByTestId('book-card-b1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('book-card-b3')).not.toBeInTheDocument()
    expect(screen.getByTestId('book-card-b2')).toBeInTheDocument()
    await userEvent.clear(screen.getByLabelText(/buscar/i))
    await userEvent.type(screen.getByLabelText(/buscar/i), 'Borges')
    expect(screen.getByTestId('book-card-b2')).toBeInTheDocument()
    expect(screen.queryByTestId('book-card-b1')).not.toBeInTheDocument()
  })

  it('el orden "Título" ordena alfabéticamente', async () => {
    apiSpies.push(...Object.values(mockApi({ listBooks: vi.fn().mockResolvedValue(books) })))
    renderLibrary()
    await screen.findByTestId('book-card-b1')
    await userEvent.selectOptions(screen.getByLabelText(/orden/i), 'titulo')
    const ids = screen.getAllByTestId(/^book-card-/).map(el => el.getAttribute('data-testid'))
    expect(ids).toEqual(['book-card-b1', 'book-card-b2', 'book-card-b3'])
  })

  it('estado vacío cuando no hay libros', async () => {
    apiSpies.push(...Object.values(mockApi({ listBooks: vi.fn().mockResolvedValue([]) })))
    renderLibrary()
    expect(await screen.findByText(/todavía no tenés libros/i)).toBeInTheDocument()
  })
})

describe('Library — sesión', () => {
  it('«Salir» llama logout y navega a /login', async () => {
    const logout = vi.fn().mockResolvedValue(undefined)
    apiSpies.push(...Object.values(mockApi({ listBooks: vi.fn().mockResolvedValue(books), logout })))
    renderLibrary()
    await screen.findByTestId('book-card-b1')
    await userEvent.click(screen.getByRole('button', { name: /cerrar sesión/i }))
    expect(logout).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('pantalla de login')).toBeInTheDocument()
  })
})

describe('Library — menú contextual', () => {
  it('"Desde el principio" llama resetProgress y refresca', async () => {
    const listBooks = vi.fn().mockResolvedValueOnce(books).mockResolvedValueOnce(books)
    const resetProgress = vi.fn().mockResolvedValue(undefined)
    apiSpies.push(...Object.values(mockApi({ listBooks, resetProgress })))
    renderLibrary()
    const card = await screen.findByTestId('book-card-b1')
    await userEvent.click(within(card).getByRole('button', { name: /opciones/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: /desde el principio/i }))
    expect(resetProgress).toHaveBeenCalledWith('b1')
    expect(listBooks).toHaveBeenCalledTimes(2)
  })

  it('eliminar requiere confirmación y quita la tarjeta', async () => {
    const listBooks = vi.fn().mockResolvedValueOnce(books).mockResolvedValueOnce(books.filter(b => b.id !== 'b1'))
    const deleteBook = vi.fn().mockResolvedValue(undefined)
    apiSpies.push(...Object.values(mockApi({ listBooks, deleteBook })))
    renderLibrary()
    const card = await screen.findByTestId('book-card-b1')
    await userEvent.click(within(card).getByRole('button', { name: /opciones/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: /^eliminar$/i }))
    expect(deleteBook).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('menuitem', { name: /confirmar/i }))
    expect(deleteBook).toHaveBeenCalledWith('b1')
    expect(await screen.findByTestId('book-card-b2')).toBeInTheDocument()
    expect(screen.queryByTestId('book-card-b1')).not.toBeInTheDocument()
  })

  it('si falla el reinicio o el borrado muestra el aviso y la tarjeta queda', async () => {
    const listBooks = vi.fn().mockResolvedValue(books)
    const resetProgress = vi.fn().mockRejectedValue(new Error('Reinicio rechazado'))
    const deleteBook = vi.fn().mockRejectedValue(new Error('Borrado rechazado'))
    apiSpies.push(...Object.values(mockApi({ listBooks, resetProgress, deleteBook })))
    renderLibrary()
    const card = await screen.findByTestId('book-card-b1')
    await userEvent.click(within(card).getByRole('button', { name: /opciones/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: /desde el principio/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/no se pudo reiniciar el progreso/i)
    expect(screen.getByTestId('book-card-b1')).toBeInTheDocument()

    // eliminar: confirmación y aviso de fallo con la tarjeta intacta
    await userEvent.click(within(card).getByRole('button', { name: /opciones/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: /^eliminar$/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: /confirmar/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/no se pudo eliminar el libro/i)
    expect(screen.getByTestId('book-card-b1')).toBeInTheDocument()
    expect(listBooks).toHaveBeenCalledTimes(1) // sin refresco: la carga no cambió
  })
})

describe('Library — subida', () => {
  const pdfFile = new File(['%PDF-1.4 contenido'], 'libro.pdf', { type: 'application/pdf' })

  it('happy path: uploadBook + patchCover con el PDF renderizado', async () => {
    const newBook = book({ id: 'b4', title: 'Libro nuevo', author: 'Autor', format: 'pdf', total_pages: 100 })
    const uploadBook = vi.fn().mockImplementation((_file: File, onProgress?: (p: number) => void) => {
      onProgress?.(0.5)
      return Promise.resolve(newBook)
    })
    const patchCover = vi.fn().mockResolvedValue(newBook)
    const listBooks = vi.fn().mockResolvedValueOnce(books).mockResolvedValueOnce([...books, newBook])
    apiSpies.push(...Object.values(mockApi({ listBooks, uploadBook, patchCover })))

    const { getDocument } = await import('pdfjs-dist')
    const mockPage = {
      getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale, scale })),
      render: vi.fn(() => ({ promise: Promise.resolve() })),
      cleanup: vi.fn(),
    }
    const destroy = vi.fn().mockResolvedValue(undefined)
    vi.mocked(getDocument).mockReturnValue({ promise: Promise.resolve({ getPage: vi.fn().mockResolvedValue(mockPage), destroy }), destroy } as never)

    const fakeCtx = { drawImage: vi.fn() }
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeCtx as never)
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, cb: (b: Blob) => void) {
      cb(new Blob([this.width + 'x' + this.height], { type: 'image/jpeg' }))
    } as never)

    renderLibrary()
    await userEvent.upload(await screen.findByLabelText(/elegir archivo/i), pdfFile)
    expect(await screen.findByTestId('book-card-b4')).toBeInTheDocument()
    expect(uploadBook).toHaveBeenCalledWith(pdfFile, expect.any(Function))
    expect(mockPage.render).toHaveBeenCalled()
    expect(patchCover).toHaveBeenCalledWith('b4', expect.any(Blob))
    expect(patchCover.mock.calls[0][1].type).toBe('image/jpeg')
    expect(getContext).toHaveBeenCalled()
    getContext.mockRestore()
    toBlob.mockRestore()
  })

  it('si falla la subida muestra un mensaje inline', async () => {
    apiSpies.push(...Object.values(mockApi({
      listBooks: vi.fn().mockResolvedValue(books),
      uploadBook: vi.fn().mockRejectedValue(Object.assign(new Error('Archivo inválido'), { status: 400 })),
    })))
    renderLibrary()
    await userEvent.upload(await screen.findByLabelText(/elegir archivo/i), pdfFile)
    expect(await screen.findByRole('alert')).toHaveTextContent(/archivo inválido/i)
  })
})
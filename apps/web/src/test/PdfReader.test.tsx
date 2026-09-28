// apps/web/src/test/PdfReader.test.tsx — lector PDF: página inicial del
// progreso, teclado, zonas de tap, slider y guardado de progreso (Task 12).
// jsdom no pinta canvas: se verifican los argumentos de las llamadas mock.
// Con React 18 + jsdom los fake timers dejan sin girar el scheduler
// (MessageChannel), así que estos tests esperan con temporizadores reales.
import { render, act, fireEvent, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { getDocument } from 'pdfjs-dist'
import { api, type Book, type Position } from '../api'
import { mockApi, stubBrowser } from './mocks'
import Reader from '../reader/Reader'

vi.mock('pdfjs-dist', () => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: { workerSrc: '' },
}))
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/pdf.worker.mjs' }))

const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

type Spy = ReturnType<typeof vi.spyOn>
const apiSpies: Spy[] = []

type FakePage = {
  pageNumber: number
  getViewport: ReturnType<typeof vi.fn>
  render: ReturnType<typeof vi.fn>
  getTextContent: ReturnType<typeof vi.fn>
  cleanup: ReturnType<typeof vi.fn>
}

function makePage(n: number): FakePage {
  return {
    pageNumber: n,
    getViewport: vi.fn(() => ({ width: 600, height: 800 })),
    render: vi.fn(() => ({ promise: Promise.resolve() })),
    getTextContent: vi.fn(async () => ({ items: [] })),
    cleanup: vi.fn(),
  }
}

const pages = new Map<number, FakePage>()
let getPage: ReturnType<typeof vi.fn>
let getContextSpy: { mockRestore: () => void } | null = null
const ctxStub = {
  fillRect: vi.fn(), clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(),
  beginPath: vi.fn(), closePath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
  stroke: vi.fn(), fill: vi.fn(), arc: vi.fn(), rect: vi.fn(),
  translate: vi.fn(), scale: vi.fn(), rotate: vi.fn(), transform: vi.fn(),
  setTransform: vi.fn(), drawImage: vi.fn(), getImageData: vi.fn(), putImageData: vi.fn(),
  createLinearGradient: vi.fn(), createRadialGradient: vi.fn(),
  path: {}, canvas: null, fillStyle: '', strokeStyle: '',
}

const NUM_PAGES = 12

const pdfBook: Book = {
  id: 'bk1',
  title: 'Manual de jardinería',
  author: 'Ana Pérez',
  format: 'pdf',
  cover_url: null,
  file_url: '/api/files/bk1',
  total_pages: NUM_PAGES,
  file_size: 900_000,
  added_at: '2026-09-01T00:00:00Z',
  percent: '70',
  position: { page: 7 },
  last_read: '2026-09-20T10:00:00Z',
}

/** Espera (temporizador real) hasta que `cond` sea verdadera, con flush de act. */
async function until(cond: () => boolean, steps = 160): Promise<boolean> {
  for (let i = 0; i < steps; i++) {
    if (cond()) return true
    await act(async () => { await realSleep(25) })
  }
  return cond()
}

function renderReader(progress: { position: Position; percent: string } | null) {
  const getBook = vi.fn(async () => ({ book: pdfBook, progress }))
  const patchProgress = vi.fn(async (_id: string, position: Position, percent: number) => ({
    position, percent, updated_at: '2026-09-27T00:00:00Z',
  }))
  apiSpies.push(...Object.values(mockApi({ getBook, patchProgress })))
  render(
    <MemoryRouter initialEntries={['/reader/bk1']}>
      <Routes>
        <Route path="/reader/:bookId" element={<Reader />} />
      </Routes>
    </MemoryRouter>,
  )
  return { patchProgress }
}

beforeEach(() => {
  stubBrowser()
  pages.clear()
  getPage = vi.fn(async (n: number) => {
    if (!pages.has(n)) pages.set(n, makePage(n))
    return pages.get(n)
  })
  const doc = { numPages: NUM_PAGES, getPage, destroy: vi.fn(async () => {}) }
  vi.mocked(getDocument).mockImplementation(() => ({ promise: Promise.resolve(doc) }) as never)
  getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctxStub as never)
})

afterEach(() => {
  getContextSpy?.mockRestore()
  for (const s of apiSpies) s.mockRestore()
  apiSpies.length = 0
  vi.clearAllMocks()
})

describe('PdfReader', () => {
  it('abre en la página guardada (7) sin renderizar la página 1', async () => {
    renderReader({ position: { page: 7 }, percent: '70' })
    expect(await until(() => pages.get(7)?.render.mock.calls.length === 1)).toBe(true)
    expect(getPage).toHaveBeenCalledWith(7)
    expect(getPage).not.toHaveBeenCalledWith(1)
    // el render se hizo con el viewport de la página fake (600×800)
    expect(pages.get(7)!.render).toHaveBeenCalledWith(expect.objectContaining({
      canvasContext: ctxStub,
      viewport: expect.objectContaining({ width: 600, height: 800 }),
    }))
  })

  it('→ avanza a la página 8, la renderiza y guarda el progreso tras el debounce', async () => {
    const { patchProgress } = renderReader({ position: { page: 7 }, percent: '70' })
    await until(() => pages.has(7))

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(await until(() => (pages.get(8)?.render.mock.calls.length ?? 0) >= 1)).toBe(true)
    expect(patchProgress).not.toHaveBeenCalled() // debounce de 1,5 s en curso
    await realSleep(600)
    expect(patchProgress).not.toHaveBeenCalled() // todavía dentro del debounce
    expect(await until(() => patchProgress.mock.calls.length === 1, 120)).toBe(true)
    const [id, position, percent] = patchProgress.mock.calls[0]
    expect(id).toBe('bk1')
    expect(position).toEqual({ page: 8 })
    expect(percent).toBeCloseTo((8 / NUM_PAGES) * 100, 5)
  })

  it('las zonas de tap cambian de página, el centro muestra los controles y el slider salta', async () => {
    renderReader({ position: { page: 7 }, percent: '70' })
    await until(() => pages.has(7))
    // inmersivo por defecto: sin chrome visible
    expect(screen.queryByText(/jardinería/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Página anterior' }))
    expect(await until(() => pages.has(6))).toBe(true)
    expect(pages.get(6)!.render).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Página siguiente' }))
    await until(() => (pages.get(7)?.render.mock.calls.length ?? 0) === 2)

    fireEvent.click(screen.getByRole('button', { name: /mostrar controles/i }))
    expect(await until(() => screen.queryByText(/jardinería/i) != null)).toBe(true)
    expect(screen.getByText('pág. 7 de 12')).toBeInTheDocument()
    expect(screen.getByText('58%')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('slider', { name: /ir a página/i }), { target: { value: '3' } })
    expect(await until(() => pages.has(3))).toBe(true)
    expect(pages.get(3)!.render).toHaveBeenCalled()
    expect(screen.getByText('pág. 3 de 12')).toBeInTheDocument()
  })

  it('el modo noche invierte el canvas con un filtro CSS (no píxeles)', async () => {
    renderReader({ position: { page: 7 }, percent: '70' })
    await until(() => pages.has(7))
    fireEvent.click(screen.getByRole('button', { name: /mostrar controles/i }))
    await until(() => document.querySelector('canvas') != null)
    const canvas = document.querySelector('canvas')
    expect(canvas).not.toHaveClass('night')

    fireEvent.click(screen.getByRole('button', { name: /modo noche/i }))
    expect(canvas).toHaveClass('night')
  })
})
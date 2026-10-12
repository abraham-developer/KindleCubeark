// apps/web/src/test/PdfBlocks.test.tsx — vista por bloques del PDF: parte la
// página en minilecturas, navega por bloques, guarda el progreso a nivel de
// bloque y muestra el estudio bilingüe solo cuando está activado.
import { render, act, fireEvent, screen, configure } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Suite pesada con timers reales: margen para los findBy bajo workers en paralelo.
configure({ asyncUtilTimeout: 5000 })
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { getDocument } from 'pdfjs-dist'
import { api, type Book, type Position } from '../api'
import { mockApi, stubBrowser } from './mocks'
import { clearDictionaryCache } from '../lib/dictionary'
import Reader from '../reader/Reader'

vi.mock('pdfjs-dist', () => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: { workerSrc: '' },
  OPS: { paintImageXObject: 999 },
  TextLayer: class {
    constructor(public options: unknown) {}
    async render() { /* jsdom no pinta */ }
  },
}))
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/pdf.worker.mjs' }))

const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

type Spy = ReturnType<typeof vi.spyOn>
const apiSpies: Spy[] = []

const NUM_PAGES = 12

const pdfBook: Book = {
  id: 'bk1',
  folder_id: null,
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

// 30 líneas numeradas (~55 caracteres cada una): la página se parte en 3 bloques.
function pageTextItems() {
  const items = []
  for (let i = 1; i <= 30; i++) {
    const n = String(i).padStart(2, '0')
    items.push({
      str: `Línea ${n}: el jardín florece con la lluvia de abril.`,
      transform: [12, 0, 0, 12, 10, 700 - i * 24] as [number, number, number, number, number, number],
      width: 330,
      height: 12,
      hasEOL: true,
    })
  }
  return items
}

let getPage: ReturnType<typeof vi.fn>

async function until(cond: () => boolean, steps = 160): Promise<boolean> {
  for (let i = 0; i < steps; i++) {
    if (cond()) return true
    await act(async () => { await realSleep(25) })
  }
  return cond()
}

function renderReader(progress: { position: Position; percent: string } | null, overrides: Record<string, unknown> = {}) {
  const getBook = vi.fn(async () => ({ book: pdfBook, progress }))
  const patchProgress = vi.fn(async (_id: string, position: Position, percent: number) => ({
    position, percent, updated_at: '2026-09-27T00:00:00Z',
  }))
  apiSpies.push(...Object.values(mockApi({ getBook, patchProgress, listAnnotations: vi.fn(async () => []), ...overrides })))
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
  window.localStorage.clear()
  window.localStorage.setItem('kc.pdf.view', 'blocks')
  getPage = vi.fn(async (n: number) => ({
    pageNumber: n,
    getViewport: vi.fn(() => ({ width: 600, height: 800 })),
    render: vi.fn(() => ({ promise: Promise.resolve() })),
    getTextContent: vi.fn(async () => ({ items: pageTextItems() })),
    getOperatorList: vi.fn(async () => ({ fnArray: [], argsArray: [] })),
    cleanup: vi.fn(),
  }))
  const doc = { numPages: NUM_PAGES, getPage, destroy: vi.fn(async () => {}) }
  vi.mocked(getDocument).mockImplementation(() => ({ promise: Promise.resolve(doc) }) as never)
})

afterEach(() => {
  window.localStorage.clear()
  clearDictionaryCache()
  vi.unstubAllGlobals()
  delete (document as unknown as { caretRangeFromPoint?: unknown }).caretRangeFromPoint
  for (const s of apiSpies) s.mockRestore()
  apiSpies.length = 0
  vi.clearAllMocks()
})

describe('PdfReader por bloques', () => {
  // Timeout amplio: debounce real de 1,5 s + workers en paralelo bajo carga.
  it('parte la página en bloques, navega entre ellos y guarda {page, block, blockCount}', async () => {
    const { patchProgress } = renderReader({ position: { page: 7 }, percent: '70' })

    // primer bloque visible con su paginador (la página no se renderiza en canvas)
    expect(await screen.findByText('Bloque 1 de 3')).toBeInTheDocument()
    expect(screen.getByText(/Línea 01:/)).toBeInTheDocument()
    expect(document.querySelector('canvas')).toBeNull()

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(await screen.findByText('Bloque 2 de 3')).toBeInTheDocument()
    expect(screen.queryByText(/Línea 01:/)).toBeNull()

    // el progreso se guarda a nivel de bloque tras el debounce
    expect(await until(() => patchProgress.mock.calls.length === 1, 200)).toBe(true)
    const [id, position, percent] = patchProgress.mock.calls[0]
    expect(id).toBe('bk1')
    expect(position).toEqual({ page: 7, block: 1, blockCount: 3 })
    expect(percent).toBeCloseTo(((7 - 1) + 2 / 3) / NUM_PAGES * 100, 5)
  }, 15_000)

  it('retoma el bloque guardado sin pasar por el primero', async () => {
    renderReader({ position: { page: 7, block: 2, blockCount: 3 }, percent: '58' })
    expect(await screen.findByText('Bloque 3 de 3')).toBeInTheDocument()
    expect(screen.queryByText(/Línea 01:/)).toBeNull()
  })

  it('el estudio bilingüe parte la pantalla solo cuando está activado', async () => {
    window.localStorage.setItem('kc.study.on', '1')
    window.localStorage.setItem('kc.study.lang', 'de')
    const translate = vi.fn(async () => ({ translated_text: 'Der Garten blüht im Aprilregen.' }))
    apiSpies.push(...Object.values(mockApi({ translate })))
    renderReader({ position: { page: 7 }, percent: '70' })

    expect(await screen.findByText('Original')).toBeInTheDocument()
    expect(screen.getByText('Traducción · Alemán')).toBeInTheDocument()
    expect(await screen.findByText('Der Garten blüht im Aprilregen.')).toBeInTheDocument()
    expect(translate).toHaveBeenCalledWith(expect.stringContaining('Línea 01:'), 'de')

    // desactivarlo vuelve a la minilectura simple (un solo texto)
    fireEvent.click(screen.getByRole('button', { name: /mostrar controles/i }))
    fireEvent.click(await screen.findByRole('button', { name: /estudio: activado/i }))
    expect(await until(() => screen.queryByText('Traducción · Alemán') == null)).toBe(true)
    expect(screen.getByText(/Línea 01:/)).toBeInTheDocument()
  })

  it('sin estudio activado no traduce ni muestra la columna traducida', async () => {
    const translate = vi.fn(async () => ({ translated_text: 'no debería verse' }))
    apiSpies.push(...Object.values(mockApi({ translate })))
    renderReader({ position: { page: 7 }, percent: '70' })

    expect(await screen.findByText('Bloque 1 de 3')).toBeInTheDocument()
    expect(screen.queryByText('Traducción · Inglés')).not.toBeInTheDocument()
    expect(translate).not.toHaveBeenCalled()
  })

  it('pulsación larga sobre una palabra abre el diccionario sin navegar', async () => {
    const fetchStub = vi.fn(async (url: string) => {
      if (url.includes('prop=sections')) {
        return new Response(JSON.stringify({ parse: { sections: [
          { index: '1', level: '2', line: 'Español' },
          { index: '2', level: '3', line: 'Sustantivo femenino' },
        ] } }), { status: 200 })
      }
      if (url.includes('prop=text')) {
        return new Response(JSON.stringify({
          parse: { text: { '*': '<dl><dt>1</dt><dd>Lugar con plantas.</dd></dl>' } },
        }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchStub)
    renderReader({ position: { page: 7 }, percent: '70' })

    // caret bajo el punto: offset 2 del texto («Línea 01: …»)
    const para = await screen.findByText(/Línea 01:/)
    const range = document.createRange()
    range.setStart(para.firstChild as Text, 2)
    range.collapse(true)
    ;(document as unknown as { caretRangeFromPoint?: unknown }).caretRangeFromPoint = () => range

    const stage = document.querySelector('.reader-stage') as HTMLElement
    fireEvent.mouseDown(stage, { button: 0, clientX: 100, clientY: 100 })
    expect(await screen.findByRole('dialog', { name: /significado de línea/i }, { timeout: 3000 }))
      .toBeInTheDocument()
    expect(await screen.findByText('Lugar con plantas.')).toBeInTheDocument()
    // la palabra queda marcada en azul con la selección
    expect(window.getSelection()?.toString()).toBe('Línea')

    // el mouseup que suelta la pulsación no navega: sigue el bloque 1
    fireEvent.mouseUp(stage, { button: 0, clientX: 100, clientY: 100 })
    expect(screen.getByText('Bloque 1 de 3')).toBeInTheDocument()
    expect(fetchStub).toHaveBeenCalled()
  })

  it('en modo estudio la pulsación larga muestra ambos significados', async () => {
    window.localStorage.setItem('kc.study.on', '1')
    const fetchStub = vi.fn(async (url: string) => {
      if (url.includes('prop=sections')) {
        return new Response(JSON.stringify({ parse: { sections: [
          { index: '1', level: '2', line: 'Español' },
          { index: '2', level: '3', line: 'Sustantivo' },
        ] } }), { status: 200 })
      }
      if (url.includes('prop=text')) {
        return new Response(JSON.stringify({
          parse: { text: { '*': '<dl><dt>1</dt><dd>Lugar con plantas.</dd></dl>' } },
        }), { status: 200 })
      }
      if (url.includes('/definition/')) {
        return new Response(JSON.stringify({
          en: [{ partOfSpeech: 'Noun', definitions: [{ definition: 'A <b>garden</b>.' }] }],
        }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchStub)
    const translate = vi.fn(async () => ({ translated_text: 'línea traducida' }))
    renderReader({ position: { page: 7 }, percent: '70' }, { translate })

    const para = await screen.findByText(/Línea 01:/)
    const range = document.createRange()
    range.setStart(para.firstChild as Text, 2)
    range.collapse(true)
    ;(document as unknown as { caretRangeFromPoint?: unknown }).caretRangeFromPoint = () => range

    const stage = document.querySelector('.reader-stage') as HTMLElement
    fireEvent.mouseDown(stage, { button: 0, clientX: 100, clientY: 100 })
    expect(await screen.findByText('Lugar con plantas.', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(await screen.findByText('A garden.')).toBeInTheDocument()
    expect(screen.getByText('Español')).toBeInTheDocument()
    expect(screen.getByText('English')).toBeInTheDocument()
  })

  it('página con imágenes ofrece verlas inline sin salir de bloques', async () => {
    // la misma imagen pintada dos veces cuenta una sola vez
    getPage.mockImplementation(async (n: number) => ({
      pageNumber: n,
      getViewport: vi.fn(() => ({ width: 600, height: 800 })),
      render: vi.fn(() => ({ promise: Promise.resolve() })),
      getTextContent: vi.fn(async () => ({ items: pageTextItems() })),
      getOperatorList: vi.fn(async () => ({
        fnArray: [999, 999, 5],
        argsArray: [['img-paisaje'], ['img-paisaje'], []],
      })),
      cleanup: vi.fn(),
    }))
    renderReader({ position: { page: 7 }, percent: '70' })

    const toggle = await screen.findByRole('button', { name: /ver 1 imagen de la página/i })
    fireEvent.click(toggle)
    expect(await screen.findByText('Página 7 original')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /ocultar imágenes/i }))
    expect(screen.queryByText('Página 7 original')).not.toBeInTheDocument()
  })
})

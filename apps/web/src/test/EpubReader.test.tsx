// apps/web/src/test/EpubReader.test.tsx — lector EPUB (epubjs): retomar por
// CFI guardado, guardado al «relocated», panel Aa y slider por porcentaje.
// epubjs se mockea a nivel de módulo: sólo se verifican los argumentos de las
// llamadas fake (jsdom no renderiza iframes). Con React 18 + jsdom los fake
// timers dejan sin girar el scheduler, así que se esperan con reales.
import { render, act, fireEvent, screen, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import ePub from 'epubjs'
import { api, type Annotation, type Book, type Position } from '../api'
import { mockApi, stubBrowser } from './mocks'
import Reader from '../reader/Reader'

vi.mock('epubjs', () => ({ default: vi.fn() }))

const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

type Spy = ReturnType<typeof vi.spyOn>
const apiSpies: Spy[] = []

type Handler = (payload?: unknown, ...rest: unknown[]) => void

const handlers = new Map<string, Handler>()

const renditionFns = {
  display: vi.fn(async (_target?: unknown) => {}),
  prev: vi.fn(async () => {}),
  next: vi.fn(async () => {}),
  on: vi.fn((type: string, cb: Handler) => { handlers.set(type, cb) }),
  off: vi.fn(),
  destroy: vi.fn(),
  themes: {
    fontSize: vi.fn(),
    register: vi.fn(),
    select: vi.fn(),
    override: vi.fn(),
    font: vi.fn(),
  },
  annotations: { add: vi.fn(), remove: vi.fn() },
}

const bookFns = {
  renderTo: vi.fn(() => renditionFns),
  destroy: vi.fn(),
  ready: Promise.resolve(),
  locations: {
    generate: vi.fn(async () => [] as string[]),
    cfiFromPercentage: vi.fn(() => 'epubcfi(/6/10)'),
    length: vi.fn(() => 0),
  },
  spine: { length: 24, get: vi.fn(), each: vi.fn() },
  navigation: { toc: [{ id: 'c3', href: 'OEBPS/chapter3.xhtml', label: 'El río' }] },
}

const epubBook: Book = {
  id: 'bk-epub',
  title: 'Cuentos de la aldea',
  author: 'Luisa Márquez',
  format: 'epub',
  cover_url: null,
  file_url: '/api/files/bk-epub',
  total_pages: null,
  file_size: 1_400_000,
  added_at: '2026-09-01T00:00:00Z',
  percent: '70',
  position: { cfi: 'epubcfi(/6/4)', percent: 70, section: 2 },
  last_read: '2026-09-20T10:00:00Z',
}

async function until(cond: () => boolean, steps = 160): Promise<boolean> {
  for (let i = 0; i < steps; i++) {
    if (cond()) return true
    await act(async () => { await realSleep(25) })
  }
  return cond()
}

function renderReader(progress: { position: Position; percent: string } | null) {
  const getBook = vi.fn(async () => ({ book: epubBook, progress }))
  const patchProgress = vi.fn(async (_id: string, position: Position, percent: number) => ({
    position, percent, updated_at: '2026-09-27T00:00:00Z',
  }))
  apiSpies.push(...Object.values(mockApi({ getBook, patchProgress })))
  render(
    <MemoryRouter initialEntries={['/reader/bk-epub']}>
      <Routes>
        <Route path="/reader/:bookId" element={<Reader />} />
      </Routes>
    </MemoryRouter>,
  )
  return { patchProgress }
}

beforeEach(() => {
  stubBrowser()
  localStorage.removeItem('kc.reader.settings')
  handlers.clear()
  vi.mocked(ePub).mockReset()
  vi.mocked(ePub).mockReturnValue(bookFns as never)
})

afterEach(() => {
  for (const s of apiSpies) s.mockRestore()
  apiSpies.length = 0
  vi.clearAllMocks()
  document.documentElement.removeAttribute('data-theme')
})

describe('EpubReader', () => {
  it('muestra el CFI guardado (no la página 1) y pide el archivo con credenciales', async () => {
    renderReader({ position: { cfi: 'epubcfi(/6/4)', percent: 70, section: 2 }, percent: '70' })

    await until(() => renditionFns.display.mock.calls.length >= 1)
    expect(renditionFns.display).toHaveBeenCalledWith('epubcfi(/6/4)')
    expect(renditionFns.display).not.toHaveBeenCalledWith()
    expect(renditionFns.display).not.toHaveBeenCalledWith(expect.any(Number))
    // el endpoint /api/files requiere la cookie de sesión
    expect(vi.mocked(ePub)).toHaveBeenCalledWith(
      expect.stringContaining('/api/files/bk-epub'),
      expect.objectContaining({ requestCredentials: true }),
    )
    // el contenedor se monta con paginación de una sola columna
    expect(bookFns.renderTo).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ spread: 'none', flow: 'paginated' }),
    )
  })

  it('sin CFI guardado muestra el inicio y genera locations en segundo plano', async () => {
    renderReader(null)
    await until(() => renditionFns.display.mock.calls.length >= 1)
    expect(renditionFns.display).toHaveBeenCalledWith()
    expect(await until(() => bookFns.locations.generate.mock.calls.length === 1)).toBe(true)
  })

  it('el relocated del resume no re-guarda la posición recién cargada; los siguientes sí', async () => {
    const { patchProgress } = renderReader({ position: { cfi: 'epubcfi(/6/4)', percent: 70, section: 2 }, percent: '70' })
    await until(() => handlers.has('relocated'))

    // 1.er relocated tras el mount: el eco del propio display(savedCfi) —
    // no debe encolar el PATCH (posición idéntica a la ya guardada).
    act(() => {
      handlers.get('relocated')!({
        start: { cfi: 'epubcfi(/6/4)', percentage: 0.7, index: 2 },
        end: { cfi: 'epubcfi(/6/5)', percentage: 0.75, index: 3 },
      })
    })
    await realSleep(1700) // más que el debounce: nada puede haberse programado
    expect(patchProgress).not.toHaveBeenCalled()

    // relocated posterior (vuelta de página real) sí guarda
    act(() => {
      handlers.get('relocated')!({
        start: { cfi: 'epubcfi(/6/8)', percentage: 0.8, index: 4 },
        end: { cfi: 'epubcfi(/6/9)', percentage: 0.85, index: 5 },
      })
    })
    expect(await until(() => patchProgress.mock.calls.length === 1, 120)).toBe(true)
    const [id, position, percent] = patchProgress.mock.calls[0]
    expect(id).toBe('bk-epub')
    expect(position).toEqual({ cfi: 'epubcfi(/6/8)', percent: 80, section: 4 })
    expect(percent).toBeCloseTo(80, 5)
  })

  it('el panel Aa aplica el tamaño al rendition (themes.fontSize) y el tema noche al documento', async () => {
    renderReader(null)
    await until(() => renditionFns.display.mock.calls.length >= 1)

    // el centro muestra el chrome; el botón «Aa» abre el panel de ajustes
    fireEvent.click(screen.getByRole('button', { name: /mostrar controles/i }))
    expect(await until(() => screen.queryByRole('button', { name: /^Aa$/ }) != null)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /^Aa$/ }))
    expect(await until(() => screen.queryByRole('group', { name: /ajustes de lectura/i }) != null)).toBe(true)
    const panel = within(screen.getByRole('group', { name: /ajustes de lectura/i }))

    // tamaño por defecto 18px → A+ llega a 20px
    fireEvent.click(panel.getByRole('button', { name: /aumentar texto/i }))
    expect(renditionFns.themes.fontSize).toHaveBeenCalledWith('20px')

    // noche: registra el tema, lo selecciona y setea el tema global del documento
    fireEvent.click(panel.getByRole('button', { name: /modo noche/i }))
    expect(renditionFns.themes.register).toHaveBeenCalledWith(
      'night',
      expect.objectContaining({ body: expect.objectContaining({ background: expect.any(String), color: expect.any(String) }) }),
    )
    expect(renditionFns.themes.select).toHaveBeenCalledWith('night')
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')

    // vuelta al día: no se fuerza tema global (igual que el lector PDF)
    fireEvent.click(panel.getByRole('button', { name: /modo día/i }))
    expect(renditionFns.themes.select).toHaveBeenCalledWith('day')
    expect(document.documentElement).not.toHaveAttribute('data-theme')
  })

  it('prev/next con zonas de tap y teclado; el slider salta por porcentaje', async () => {
    renderReader({ position: { cfi: 'epubcfi(/6/4)', percent: 70, section: 2 }, percent: '70' })
    await until(() => renditionFns.display.mock.calls.length >= 1)

    fireEvent.click(screen.getByRole('button', { name: 'Página anterior' }))
    expect(await until(() => renditionFns.prev.mock.calls.length === 1)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Página siguiente' }))
    expect(await until(() => renditionFns.next.mock.calls.length === 1)).toBe(true)

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(await until(() => renditionFns.next.mock.calls.length === 2)).toBe(true)
    fireEvent.keyDown(window, { key: ' ' })
    expect(await until(() => renditionFns.next.mock.calls.length === 3)).toBe(true)
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(await until(() => renditionFns.prev.mock.calls.length === 2)).toBe(true)

    // slider 0–100 por porcentaje: usa cfiFromPercentage cuando hay locations
    fireEvent.click(screen.getByRole('button', { name: /mostrar controles/i }))
    await until(() => screen.queryByRole('slider') != null)
    expect(screen.getByRole('slider', { name: /ir a posición/i })).toBeTruthy()
    bookFns.locations.length.mockReturnValue(500)
    bookFns.locations.cfiFromPercentage.mockReturnValue('epubcfi(/6/14)')
    fireEvent.change(screen.getByRole('slider', { name: /ir a posición/i }), { target: { value: '55' } })
    expect(await until(() => renditionFns.display.mock.calls.some(c => c[0] === 'epubcfi(/6/14)'))).toBe(true)
    expect(bookFns.locations.cfiFromPercentage).toHaveBeenCalledWith(0.55)
  })

  it('los controles del AaPanel no cambian de página con el teclado (guard de foco)', async () => {
    renderReader(null)
    await until(() => renditionFns.display.mock.calls.length >= 1)

    fireEvent.click(screen.getByRole('button', { name: /mostrar controles/i }))
    await until(() => screen.getByRole('slider', { name: /ir a posición/i }) != null)
    const nextCount = renditionFns.next.mock.calls.length
    // espacio/← sobre un control del chrome (botón/slider) no voltean página
    const slider = screen.getByRole('slider', { name: /ir a posición/i })
    slider.focus()
    fireEvent.keyDown(slider, { key: ' ' })
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(renditionFns.next.mock.calls.length).toBe(nextCount)
  })

  it('la etiqueta del bottom muestra el porcentaje y el capítulo del relocated', async () => {
    renderReader({ position: { cfi: 'epubcfi(/6/4)', percent: 70, section: 2 }, percent: '70' })
    await until(() => renditionFns.display.mock.calls.length >= 1)
    fireEvent.click(screen.getByRole('button', { name: /mostrar controles/i }))
    expect(await until(() => screen.queryByRole('contentinfo') != null)).toBe(true)
    const bottom = screen.getByRole('contentinfo') as HTMLElement
    expect(await until(() => bottom.textContent?.includes('70%') ?? false)).toBe(true)

    // un relocated cuyo href pertenece a un ítem del índice muestra el título
    act(() => {
      handlers.get('relocated')!({
        start: { cfi: 'epubcfi(/6/12)', percentage: 0.62, index: 5, href: 'OEBPS/chapter3.xhtml' },
        end: { cfi: 'epubcfi(/6/13)', percentage: 0.66, index: 6 },
      })
    })
    expect(await until(() => bottom.textContent?.includes('El río') ?? false)).toBe(true)
    expect(await until(() => bottom.textContent?.includes('62%') ?? false)).toBe(true)
  })

  it('selección de texto → menú → rosa crea el resaltado y lo pinta con annotations.add', async () => {
    const createAnnotation = vi.fn(async () => ({
      id: 'an1', book_id: 'bk-epub', kind: 'highlight',
      position: { startCfi: 'epubcfi(/6/4!/4/2/1:0)', endCfi: 'epubcfi(/6/4!/4/4/1:2)' },
      quoted_text: 'párrafo elegido', note: '', color: 'pink', created_at: '2026-09-27T00:00:00Z',
    }))
    apiSpies.push(...Object.values(mockApi({ listAnnotations: vi.fn(async () => []), createAnnotation })))
    renderReader({ position: { cfi: 'epubcfi(/6/4)', percent: 70, section: 2 }, percent: '70' })
    await until(() => renditionFns.display.mock.calls.length >= 1)

    // epub.js emite 'selected' con el CFI de rango y los contents del iframe
    const fakeContents = {
      window: {
        getSelection: () => ({
          isCollapsed: false, rangeCount: 1,
          toString: () => 'párrafo elegido',
          removeAllRanges: vi.fn(),
          getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 30, top: 40, width: 200, height: 22 }) }),
        }),
      },
    }
    act(() => {
      handlers.get('selected')!('epubcfi(/6/4!/4/2/1:0,/4/4/1:2)', fakeContents)
    })
    expect(await until(() => document.querySelector('.selection-menu') != null)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'rosa' }))

    expect(await until(() => createAnnotation.mock.calls.length === 1)).toBe(true)
    expect(createAnnotation).toHaveBeenCalledWith('bk-epub', {
      kind: 'highlight',
      position: { startCfi: 'epubcfi(/6/4!/4/2/1:0)', endCfi: 'epubcfi(/6/4!/4/4/1:2)' },
      quoted_text: 'párrafo elegido',
      color: 'pink',
    })
    // el resaltado se pinta con el CFI de rango re-armado y el color
    expect(await until(() => renditionFns.annotations.add.mock.calls.length === 1)).toBe(true)
    const [type, cfiRange, data, cb, className, styles] = renditionFns.annotations.add.mock.calls[0]
    expect(type).toBe('highlight')
    expect(cfiRange).toBe('epubcfi(/6/4!/4/2/1:0,/4/4/1:2)')
    expect(data.quoted_text).toBe('párrafo elegido')
    expect(className).toBe('kc-annotation')
    expect(styles['mix-blend-mode']).toBe('multiply')
    expect(typeof cb).toBe('function')
  })

  it('los resaltados guardados se pintan al abrir; una nota anclada se abre con el editor', async () => {
    const noted: Annotation = {
      id: 'an-note', book_id: 'bk-epub', kind: 'note',
      position: { startCfi: 'epubcfi(/6/4!/4/2/1:0)', endCfi: 'epubcfi(/6/4!/4/4/1:2)' },
      quoted_text: 'con nota', note: 'comentario previo', color: 'yellow',
      created_at: '2026-09-20T10:00:00Z',
    }
    apiSpies.push(...Object.values(mockApi({ listAnnotations: vi.fn(async () => [noted]) })))
    renderReader({ position: { cfi: 'epubcfi(/6/4)', percent: 70, section: 2 }, percent: '70' })
    await until(() => renditionFns.display.mock.calls.length >= 1)
    expect(await until(() => renditionFns.annotations.add.mock.calls.length === 1)).toBe(true)

    // click sobre el resaltado anclado con nota → editor de nota
    const [, , , cb] = renditionFns.annotations.add.mock.calls[0]
    act(() => { (cb as () => void)() })
    expect(await until(() => document.querySelector('.note-editor') != null)).toBe(true)
    expect((document.querySelector('.note-editor textarea') as HTMLTextAreaElement).value).toBe('comentario previo')
  })

  it('el marcador ancla al CFI actual y marca la cinta en la misma sección', async () => {
    const bookmark: Annotation = {
      id: 'bm1', book_id: 'bk-epub', kind: 'note',
      position: { startCfi: 'epubcfi(/6/8!/4/2)', endCfi: 'epubcfi(/6/8!/4/2)' },
      quoted_text: '', note: '', color: 'bookmark', created_at: '2026-09-20T10:00:00Z',
    }
    const deleteAnnotation = vi.fn(async () => undefined)
    const createAnnotation = vi.fn(async () => ({ ...bookmark, id: 'bm2', created_at: '2026-09-27T00:00:00Z' }))
    apiSpies.push(...Object.values(mockApi({
      listAnnotations: vi.fn(async () => [bookmark]), deleteAnnotation, createAnnotation,
    })))
    renderReader({ position: { cfi: 'epubcfi(/6/4)', percent: 70, section: 2 }, percent: '70' })
    await until(() => renditionFns.display.mock.calls.length >= 1)

    // relocated a /6/8: misma sección del bookmark existente → cinta marcada
    act(() => {
      handlers.get('relocated')!({
        start: { cfi: 'epubcfi(/6/8)', percentage: 0.8, index: 4 },
        end: { cfi: 'epubcfi(/6/9)', percentage: 0.85, index: 5 },
      })
    })
    expect(await until(() => screen.queryByRole('button', { name: 'Quitar marcador' }) != null)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Quitar marcador' }))
    expect(await until(() => deleteAnnotation.mock.calls.length === 1)).toBe(true)
    expect(deleteAnnotation).toHaveBeenCalledWith('bm1')

    // sin marcador: crea la annotation {startCfi, endCfi} con el CFI actual como ambos
    await until(() => screen.queryByRole('button', { name: 'Marcar página' }) != null)
    fireEvent.click(screen.getByRole('button', { name: 'Marcar página' }))
    expect(await until(() => createAnnotation.mock.calls.length === 1)).toBe(true)
    expect(createAnnotation).toHaveBeenCalledWith('bk-epub', {
      kind: 'note', position: { startCfi: 'epubcfi(/6/8)', endCfi: 'epubcfi(/6/8)' }, color: 'bookmark',
    })
  })

  it('borrar una anotación desde el panel la remueve del rendition sin reabrir el libro', async () => {
    const noted: Annotation = {
      id: 'an-note', book_id: 'bk-epub', kind: 'note',
      position: { startCfi: 'epubcfi(/6/4!/4/2/1:0)', endCfi: 'epubcfi(/6/4!/4/4/1:2)' },
      quoted_text: 'con nota', note: 'comentario previo', color: 'yellow',
      created_at: '2026-09-20T10:00:00Z',
    }
    const deleteAnnotation = vi.fn(async () => undefined)
    apiSpies.push(...Object.values(mockApi({
      listAnnotations: vi.fn(async () => [noted]), deleteAnnotation,
    })))
    renderReader({ position: { cfi: 'epubcfi(/6/4)', percent: 70, section: 2 }, percent: '70' })
    await until(() => renditionFns.display.mock.calls.length >= 1)
    expect(await until(() => renditionFns.annotations.add.mock.calls.length === 1)).toBe(true)

    // abrir el panel desde el topbar y borrar la nota con confirmación inline
    fireEvent.click(screen.getByRole('button', { name: /mostrar controles/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Mis anotaciones' }))
    const item = (await screen.findByText('con nota')).closest('li') as HTMLElement
    fireEvent.click(item.querySelector('.annotations-danger') as HTMLElement)
    fireEvent.click(await screen.findByRole('button', { name: 'Sí, borrar' }))

    expect(await until(() => deleteAnnotation.mock.calls.length === 1)).toBe(true)
    expect(deleteAnnotation).toHaveBeenCalledWith('an-note')
    // el lector re-sincroniza: annotations.remove con el CFI de rango, sin reabrir
    expect(await until(() => renditionFns.annotations.remove.mock.calls.length === 1)).toBe(true)
    expect(renditionFns.annotations.remove).toHaveBeenCalledWith(
      'epubcfi(/6/4!/4/2/1:0,/4/4/1:2)', 'highlight',
    )
  })

  it('editar una nota guarda la nueva antes de borrar la vieja (create-then-delete)', async () => {
    const noted: Annotation = {
      id: 'an-note', book_id: 'bk-epub', kind: 'note',
      position: { startCfi: 'epubcfi(/6/4!/4/2/1:0)', endCfi: 'epubcfi(/6/4!/4/4/1:2)' },
      quoted_text: 'con nota', note: 'comentario previo', color: 'yellow',
      created_at: '2026-09-20T10:00:00Z',
    }
    const deleteAnnotation = vi.fn(async () => undefined)
    const createAnnotation = vi.fn(async () => ({ ...noted, id: 'an-note-2', created_at: '2026-09-27T00:00:00Z' }))
    apiSpies.push(...Object.values(mockApi({
      listAnnotations: vi.fn(async () => [noted]), deleteAnnotation, createAnnotation,
    })))
    renderReader({ position: { cfi: 'epubcfi(/6/4)', percent: 70, section: 2 }, percent: '70' })
    await until(() => renditionFns.display.mock.calls.length >= 1)
    expect(await until(() => renditionFns.annotations.add.mock.calls.length === 1)).toBe(true)

    // click en el resaltado anclado con nota → editor con el texto previo
    const [, , , cb] = renditionFns.annotations.add.mock.calls[0]
    act(() => { (cb as () => void)() })
    expect(await until(() => document.querySelector('.note-editor') != null)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    // create primero, delete después: si delete falla, la nota ya existe
    expect(await until(() => deleteAnnotation.mock.calls.length === 1)).toBe(true)
    expect(createAnnotation).toHaveBeenCalledWith('bk-epub', {
      kind: 'note',
      position: { startCfi: 'epubcfi(/6/4!/4/2/1:0)', endCfi: 'epubcfi(/6/4!/4/4/1:2)' },
      quoted_text: 'con nota',
      note: 'comentario previo',
      color: 'yellow',
    })
    expect(createAnnotation.mock.invocationCallOrder[0])
      .toBeLessThan(deleteAnnotation.mock.invocationCallOrder[0])
    // el estado local queda con la nota nueva (el rendition la re-pinta)
    expect(await until(() => renditionFns.annotations.add.mock.calls.length === 2)).toBe(true)
    expect(renditionFns.annotations.remove).toHaveBeenCalledWith(
      'epubcfi(/6/4!/4/2/1:0,/4/4/1:2)', 'highlight',
    )
  })

  it('un tap sobre el contenido (mouseup sin selección) cierra el menú de selección', async () => {
    apiSpies.push(...Object.values(mockApi({ listAnnotations: vi.fn(async () => []) })))
    renderReader({ position: { cfi: 'epubcfi(/6/4)', percent: 70, section: 2 }, percent: '70' })
    await until(() => renditionFns.display.mock.calls.length >= 1)

    const fakeContents = {
      window: {
        getSelection: () => ({
          isCollapsed: false, rangeCount: 1,
          toString: () => 'párrafo elegido',
          removeAllRanges: vi.fn(),
          getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 30, top: 40, width: 200, height: 22 }) }),
        }),
      },
    }
    act(() => {
      handlers.get('selected')!('epubcfi(/6/4!/4/2/1:0,/4/4/1:2)', fakeContents)
    })
    expect(await until(() => document.querySelector('.selection-menu') != null)).toBe(true)

    // tap en el iframe sin selección: el menú debe cerrarse
    const tapContents = { window: { getSelection: () => null } }
    act(() => {
      handlers.get('mouseup')!({ button: 0, clientX: 250 }, tapContents)
    })
    expect(await until(() => document.querySelector('.selection-menu') == null)).toBe(true)
  })

  it('el tap del iframe que cierra el menú no voltea la página (guard simétrico al PDF)', async () => {
    apiSpies.push(...Object.values(mockApi({ listAnnotations: vi.fn(async () => []) })))
    renderReader({ position: { cfi: 'epubcfi(/6/4)', percent: 70, section: 2 }, percent: '70' })
    await until(() => renditionFns.display.mock.calls.length >= 1)

    // rects del host: jsdom da ceros y el tap caería en el centro
    const hostRectSpy = vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ left: 0, top: 0, width: 600, height: 800 } as DOMRect)

    // menú de selección abierto (selección previa en el iframe)
    const fakeContents = {
      window: {
        getSelection: () => ({
          isCollapsed: false, rangeCount: 1,
          toString: () => 'párrafo elegido',
          removeAllRanges: vi.fn(),
          getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 30, top: 40, width: 200, height: 22 }) }),
        }),
      },
    }
    act(() => {
      handlers.get('selected')!('epubcfi(/6/4!/4/2/1:0,/4/4/1:2)', fakeContents)
    })
    expect(await until(() => document.querySelector('.selection-menu') != null)).toBe(true)

    // tap en la zona izquierda del iframe (sin selección): cierra el menú y NO voltea
    act(() => {
      handlers.get('mouseup')!({ button: 0, clientX: 100 }, { window: { getSelection: () => null } })
    })
    expect(await until(() => document.querySelector('.selection-menu') == null)).toBe(true)
    expect(renditionFns.prev).not.toHaveBeenCalled()
    expect(renditionFns.next).not.toHaveBeenCalled()
    hostRectSpy.mockRestore()
  })
})

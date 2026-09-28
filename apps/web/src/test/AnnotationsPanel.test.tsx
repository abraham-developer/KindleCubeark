// apps/web/src/test/AnnotationsPanel.test.tsx — panel "Mis anotaciones":
// lista en orden de lectura (positionSortKey + created_at/id de desempate),
// sin marcadores (color 'bookmark'), salto con onJump(position) y borrado con
// confirmación inline.
import { render, fireEvent, screen, within, act } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { api, type Annotation } from '../api'
import { mockApi } from './mocks'
import AnnotationsPanel from '../reader/AnnotationsPanel'

type Spy = ReturnType<typeof vi.spyOn>
const apiSpies: Spy[] = []

const PDF_ROWS: Annotation[] = [
  { id: 'a10', book_id: 'bk1', kind: 'highlight', position: { page: 10, rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }] }, quoted_text: 'cita de la página diez', note: '', color: 'blue', created_at: '2026-09-03T00:00:00Z' },
  { id: 'a3', book_id: 'bk1', kind: 'highlight', position: { page: 3, rects: [{ x: 0.2, y: 0.3, w: 0.4, h: 0.04 }] }, quoted_text: 'cita temprana', note: '', color: 'yellow', created_at: '2026-09-01T00:00:00Z' },
  { id: 'bm5', book_id: 'bk1', kind: 'note', position: { page: 5 }, quoted_text: '', note: '', color: 'bookmark', created_at: '2026-09-02T00:00:00Z' },
  { id: 'a1', book_id: 'bk1', kind: 'note', position: { page: 1 }, quoted_text: 'cita de la página uno', note: 'recordar esto', color: 'yellow', created_at: '2026-09-04T00:00:00Z' },
]

function renderPanel(props: Partial<Parameters<typeof AnnotationsPanel>[0]> = {}) {
  const onJump = vi.fn()
  const onClose = vi.fn()
  render(<AnnotationsPanel bookId="bk1" format="pdf" onJump={onJump} onClose={onClose} {...props} />)
  return { onJump, onClose }
}

afterEach(() => {
  for (const s of apiSpies) s.mockRestore()
  apiSpies.length = 0
  vi.clearAllMocks()
})

describe('AnnotationsPanel', () => {
  it('lista sin marcadores y en orden de lectura (página 1, 3, 10)', async () => {
    apiSpies.push(...Object.values(mockApi({ listAnnotations: vi.fn(async () => PDF_ROWS) })))
    renderPanel()

    const list = await screen.findByRole('list', { name: /anotaciones/i })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(3) // el bookmark de la página 5 no aparece
    const quotes = items.map(i => i.querySelector('.annotation-quote')?.textContent)
    expect(quotes).toEqual(['cita de la página uno', 'cita temprana', 'cita de la página diez'])
    expect(screen.queryByText(/página 5/i)).toBeNull()
  })

  it('muestra cita, nota y color de cada anotación', async () => {
    apiSpies.push(...Object.values(mockApi({ listAnnotations: vi.fn(async () => PDF_ROWS) })))
    renderPanel()
    const item = (await screen.findByText('cita de la página uno')).closest('li') as HTMLElement
    expect(within(item).getByText('recordar esto')).toBeTruthy()
    expect(item.querySelector('.dot.yellow')).toBeTruthy()
  })

  it('onJump recibe la position de la anotación (Ir)', async () => {
    apiSpies.push(...Object.values(mockApi({ listAnnotations: vi.fn(async () => PDF_ROWS) })))
    const { onJump } = renderPanel()
    const item = (await screen.findByText('cita temprana')).closest('li') as HTMLElement
    fireEvent.click(within(item).getByRole('button', { name: /ir/i }))
    expect(onJump).toHaveBeenCalledWith({ page: 3, rects: [{ x: 0.2, y: 0.3, w: 0.4, h: 0.04 }] })
  })

  it('borra con confirmación inline: Cancelar no toca la API, Sí borra y saca el ítem', async () => {
    const deleteAnnotation = vi.fn(async () => undefined)
    apiSpies.push(...Object.values(mockApi({ listAnnotations: vi.fn(async () => PDF_ROWS), deleteAnnotation })))
    renderPanel()
    const item = (await screen.findByText('cita temprana')).closest('li') as HTMLElement

    // 1er click: aparece la confirmación inline, no se borra
    fireEvent.click(within(item).getByRole('button', { name: /borrar/i }))
    expect(await within(item).findByText(/¿borrar/i)).toBeTruthy()
    expect(deleteAnnotation).not.toHaveBeenCalled()

    // Cancelar: vuelve al estado normal, sin borrar
    fireEvent.click(within(item).getByRole('button', { name: /cancelar/i }))
    expect(within(item).queryByText(/¿borrar/i)).toBeNull()

    // confirmar: borra esa anotación y la saca de la lista
    fireEvent.click(within(item).getByRole('button', { name: /borrar/i }))
    fireEvent.click(await within(item).findByRole('button', { name: /sí, borrar/i }))
    expect(deleteAnnotation).toHaveBeenCalledWith('a3')
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByText('cita temprana')).toBeNull()
    expect(screen.getByText('cita de la página uno')).toBeTruthy() // el resto queda
  })

  it('estado vacío y error de carga', async () => {
    apiSpies.push(...Object.values(mockApi({ listAnnotations: vi.fn(async () => []) })))
    renderPanel()
    expect(await screen.findByText(/todavía no hay anotaciones/i)).toBeTruthy()

    apiSpies.push(...Object.values(mockApi({ listAnnotations: vi.fn(async () => { throw new Error('red') }) })))
    renderPanel()
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('format epub: ordena por CFI y el salto manda la position sin cambiarla', async () => {
    const rows: Annotation[] = [
      { id: 'e2', book_id: 'bk2', kind: 'highlight', position: { startCfi: 'epubcfi(/6/10!/4/2)', endCfi: 'epubcfi(/6/10!/4/4)' }, quoted_text: 'epub dos', note: '', color: 'pink', created_at: '2026-09-03T00:00:00Z' },
      { id: 'e1', book_id: 'bk2', kind: 'note', position: { cfi: 'epubcfi(/6/4!/4/2)' }, quoted_text: '', note: 'nota epub', color: 'gray', created_at: '2026-09-01T00:00:00Z' },
    ]
    apiSpies.push(...Object.values(mockApi({ listAnnotations: vi.fn(async () => rows) })))
    const onJump = vi.fn()
    render(<AnnotationsPanel bookId="bk2" format="epub" onJump={onJump} onClose={vi.fn()} />)
    const list = await screen.findByRole('list', { name: /anotaciones/i })
    const items = within(list).getAllByRole('listitem')
    const quotes = items.map(i => i.querySelector('.annotation-quote')?.textContent)
    expect(quotes[0]).toBe('epub dos')
    // e1 es nota de página sin cita (no hay elemento de cita)
    expect(items[1].querySelector('.annotation-quote')).toBeNull()
    // e1 va primera por CFI (/6/4 < /6/10)
    expect(within(items[0]).getByText('epub dos')).toBeTruthy()
    const noteItem = items[1]
    fireEvent.click(within(noteItem as HTMLElement).getByRole('button', { name: /ir/i }))
    expect(onJump).toHaveBeenCalledWith({ cfi: 'epubcfi(/6/4!/4/2)' })
  })

  it('cierra con el botón de la cabecera', async () => {
    apiSpies.push(...Object.values(mockApi({ listAnnotations: vi.fn(async () => PDF_ROWS) })))
    const { onClose } = renderPanel()
    await screen.findByRole('list', { name: /anotaciones/i })
    fireEvent.click(screen.getByRole('button', { name: /cerrar anotaciones/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('el desempate en la misma posición usa created_at y luego id (igual que el server)', async () => {
    const rows: Annotation[] = [
      { id: 'b', book_id: 'bk1', kind: 'highlight', position: { page: 4, rects: [{ x: 0, y: 0, w: 1, h: 0.1 }] }, quoted_text: 'segunda', note: '', color: 'blue', created_at: '2026-09-02T00:00:00Z' },
      { id: 'a', book_id: 'bk1', kind: 'highlight', position: { page: 4, rects: [{ x: 0, y: 0.2, w: 1, h: 0.1 }] }, quoted_text: 'cita anterior', note: '', color: 'pink', created_at: '2026-09-01T00:00:00Z' },
    ]
    apiSpies.push(...Object.values(mockApi({ listAnnotations: vi.fn(async () => rows) })))
    renderPanel()
    const list = await screen.findByRole('list', { name: /anotaciones/i })
    const quotes = within(list).getAllByRole('listitem').map(i => i.querySelector('.annotation-quote')?.textContent)
    expect(quotes).toEqual(['cita anterior', 'segunda']) // misma página: gana created_at más viejo
  })
})
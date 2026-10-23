// apps/web/src/test/TypingMode.test.tsx — pantalla typing en escritorio:
// se escribe palabra por palabra, el progreso se guarda en el servidor y
// en móvil/táctil se muestra el aviso de solo escritorio.
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { api } from '../api'
import TypingMode from '../pages/TypingMode'

vi.mock('../lib/typingText', () => ({
  extractBookText: vi.fn(async () => 'hola mundo chau'),
  MAX_TYPING_WORDS: 60_000,
}))

let spies: Array<{ mockRestore(): void }> = []
function mockDesktop(pointerFine: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: query === '(pointer: fine)' ? pointerFine : false, media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }),
  })
}
function setup(pointerFine = true) {
  mockDesktop(pointerFine)
  spies.push(vi.spyOn(api, 'getBook').mockResolvedValue({
    book: { id: 'b1', title: 'Libro typing', author: 'Autora', format: 'pdf', visibility: 'personal', cover_url: null, file_url: '/x', total_pages: 1, file_size: 10, added_at: '', folder_id: null, percent: null, position: null, last_read: null },
    progress: null,
  } as never))
  spies.push(vi.spyOn(api, 'getTyping').mockResolvedValue({ progress: null, scores: [], best: null }))
  const save = vi.fn(async () => ({}))
  spies.push(vi.spyOn(api, 'saveTypingProgress').mockImplementation(save as never))
  render(<MemoryRouter initialEntries={['/typing/b1']}><Routes><Route path="/typing/:bookId" element={<TypingMode />} /></Routes></MemoryRouter>)
  return { save }
}
beforeEach(() => { Object.defineProperty(window, 'innerWidth', { writable: true, value: 1440 }) })
afterEach(() => { spies.forEach(s => s.mockRestore()); spies = []; vi.clearAllMocks(); window.localStorage.clear() })

describe('TypingMode', () => {
  it('escribe palabra por palabra y guarda el progreso por libro', async () => {
    const { save } = setup()
    const stage = await screen.findByRole('textbox')
    expect(screen.getByText('Modo typing · palabra por palabra')).toBeInTheDocument()
    fireEvent.keyDown(stage, { key: 'h' }); fireEvent.keyDown(stage, { key: 'o' })
    fireEvent.keyDown(stage, { key: 'l' }); fireEvent.keyDown(stage, { key: 'a' })
    fireEvent.keyDown(stage, { key: ' ' })
    // la segunda palabra pasa a ser la actual
    await waitFor(() => expect(screen.getByText(/Palabra actual:/).textContent).toContain('mundo'))
    await waitFor(() => expect(save).toHaveBeenCalledWith('b1', expect.objectContaining({ word_index: 1, total_words: 3 })))
  })

  it('ofrece AZERTY francés y el modo bilingüe con francés', async () => {
    setup()
    await screen.findByRole('textbox')
    const layout = screen.getByLabelText('Tipo de teclado') as HTMLSelectElement
    expect([...layout.options].map(o => o.value)).toContain('azerty-fr')
    fireEvent.change(layout, { target: { value: 'azerty-fr' } })
    expect(layout.value).toBe('azerty-fr')
    fireEvent.click(screen.getByLabelText(/Modo bilingüe/))
    expect((screen.getByLabelText('Idioma de apoyo') as HTMLSelectElement).value).toBe('fr')
    expect(screen.getByText('AZERTY · Français')).toBeInTheDocument()
  })

  it('en táctil muestra el aviso de solo escritorio y no captura escritura', async () => {
    setup(false)
    expect(await screen.findByText('Modo typing · Solo escritorio')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
})

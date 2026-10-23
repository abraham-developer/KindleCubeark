// apps/web/src/test/TypingSheet.test.tsx — hoja de typing dentro del lector:
// escribe el bloque en lectura palabra por palabra, guarda la puntuación
// por libro al completarla y retoma el avance de esa hoja.
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { api } from '../api'
import TypingSheet from '../reader/TypingSheet'

let spies: Array<{ mockRestore(): void }> = []
function mockDesktop() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: query === '(pointer: fine)', media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }),
  })
  Object.defineProperty(window, 'innerWidth', { writable: true, value: 1440 })
}
afterEach(() => { spies.forEach(s => s.mockRestore()); spies = []; vi.clearAllMocks(); window.localStorage.clear() })

function typeWord(stage: HTMLElement, word: string) {
  for (const ch of word) fireEvent.keyDown(stage, { key: ch })
  fireEvent.keyDown(stage, { key: ' ' })
}

describe('TypingSheet', () => {
  it('escribe la hoja palabra por palabra y guarda la puntuación del libro', async () => {
    mockDesktop()
    const addScore = vi.fn(async () => ({}))
    spies.push(vi.spyOn(api, 'addTypingScore').mockImplementation(addScore as never))
    render(<TypingSheet bookId="b1" text="hola mundo" positionKey="pdf:1:0" bilingual={false} targetLang="fr" />)
    const stage = screen.getByRole('textbox')
    typeWord(stage, 'hola')
    expect(screen.getByText(/Palabra actual:/).textContent).toContain('mundo')
    // el avance de esta hoja queda guardado para retomarlo
    expect(window.localStorage.getItem('kc.typing.sheet.b1.pdf:1:0')).toContain('"index":1')
    typeWord(stage, 'mundo')
    await waitFor(() => expect(screen.getByText('Hoja completada')).toBeInTheDocument())
    await waitFor(() => expect(addScore).toHaveBeenCalledWith('b1', expect.objectContaining({ words_completed: 2, keyboard_layout: 'qwerty-es', target_lang: 'fr' })))
  })

  it('retoma el avance guardado de la misma hoja', () => {
    mockDesktop()
    window.localStorage.setItem('kc.typing.sheet.b1.pdf:1:0', JSON.stringify({
      index: 1, typed: '', correctChars: 4, typedChars: 4, errors: 0, wordsCompleted: 1, elapsedMs: 1000, result: null,
    }))
    render(<TypingSheet bookId="b1" text="hola mundo" positionKey="pdf:1:0" bilingual={false} targetLang="fr" />)
    expect(screen.getByText(/Palabra actual:/).textContent).toContain('mundo')
    expect(screen.getByText('2 / 2 palabras')).toBeInTheDocument()
  })
})

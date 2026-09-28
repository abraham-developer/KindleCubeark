// apps/web/src/test/Reader.test.tsx — ruta /reader/:bookId: error de apertura
// con salida (botón «Volver a la biblioteca»).
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { api } from '../api'
import { mockApi, stubBrowser } from './mocks'
import Reader from '../reader/Reader'

type Spy = ReturnType<typeof vi.spyOn>
let apiSpies: Spy[] = []
afterEach(() => {
  for (const s of apiSpies) s.mockRestore()
  apiSpies = []
  vi.clearAllMocks()
})

describe('Reader — error de apertura', () => {
  it('muestra el error y el botón vuelve a la biblioteca', async () => {
    stubBrowser()
    apiSpies.push(...Object.values(mockApi({
      getBook: vi.fn().mockRejectedValue(new Error('Libro no encontrado')),
    })))
    render(
      <MemoryRouter initialEntries={['/reader/bk-fantasma']}>
        <Routes>
          <Route path="/" element={<div>biblioteca</div>} />
          <Route path="/reader/:bookId" element={<Reader />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(/no se pudo abrir el libro/i)
    await userEvent.click(screen.getByRole('button', { name: /volver a la biblioteca/i }))
    expect(await screen.findByText('biblioteca')).toBeInTheDocument()
  })
})
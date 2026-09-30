// apps/web/src/test/FolderDialog.test.tsx — crear/editar carpeta: nombre + color (Task 7).
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { api, type Folder } from '../api'
import { mockApi } from './mocks'
import FolderDialog from '../pages/FolderDialog'

const folder: Folder = { id: 'f1', name: 'Novelas', color: '#ef4444', book_count: 0, created_at: '2026-09-28T00:00:00Z' }
let spies: ReturnType<typeof vi.spyOn>[] = []
afterEach(() => {
  for (const s of spies) s.mockRestore()
  spies = []
})

describe('FolderDialog — crear', () => {
  it('llama a createFolder con el nombre y color elegidos y llama onSaved', async () => {
    const createFolder = vi.fn().mockResolvedValue({ ...folder, id: 'f9', name: 'Nueva', color: '#3b82f6' })
    spies = Object.values(mockApi({ createFolder }))
    // jsdom no soporta input[type=color]: el flujo pasa por las bolitas de sugerencia
    let saved: Folder | null = null
    render(<FolderDialog folder={null} onClose={() => {}} onSaved={f => { saved = f }} />)
    await userEvent.type(screen.getByLabelText('Nombre'), 'Nueva')
    await userEvent.click(screen.getByRole('button', { name: 'azul' }))
    expect((screen.getByLabelText('Color') as HTMLInputElement).value).toBe('#3b82f6')
    await userEvent.click(screen.getByRole('button', { name: /crear carpeta/i }))
    expect(createFolder).toHaveBeenCalledWith('Nueva', '#3b82f6')
    expect(saved).toEqual(expect.objectContaining({ id: 'f9' }))
  })

  it('cancelar llama a onClose sin crear', async () => {
    spies = Object.values(mockApi({}))
    const onClose = vi.fn()
    render(<FolderDialog folder={null} onClose={onClose} onSaved={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /cancelar/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('muestra el color elegido en vivo (preview y hex)', async () => {
    spies = Object.values(mockApi({}))
    render(<FolderDialog folder={null} onClose={() => {}} onSaved={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'verde' }))
    expect(screen.getByTestId('color-hex')).toHaveTextContent('#22c55e')
  })
})

describe('FolderDialog — editar', () => {
  it('precarga nombre y color y llama a updateFolder con los cambios', async () => {
    const updateFolder = vi.fn().mockResolvedValue({ ...folder, name: 'Novelas viejas', color: '#22c55e' })
    spies = Object.values(mockApi({ updateFolder }))
    render(<FolderDialog folder={folder} onClose={() => {}} onSaved={() => {}} />)
    const name = screen.getByLabelText('Nombre') as HTMLInputElement
    expect(name.value).toBe('Novelas')
    await userEvent.clear(name)
    await userEvent.type(name, 'Novelas viejas')
    await userEvent.click(screen.getByRole('button', { name: 'verde' }))
    await userEvent.click(screen.getByRole('button', { name: /guardar/i }))
    expect(updateFolder).toHaveBeenCalledWith('f1', { name: 'Novelas viejas', color: '#22c55e' })
  })

  it('error de la API se muestra con role="alert" y el diálogo queda abierto', async () => {
    spies = Object.values(mockApi({ updateFolder: vi.fn().mockRejectedValue(new Error('El nombre debe tener entre 1 y 60 caracteres')) }))
    render(<FolderDialog folder={folder} onClose={() => {}} onSaved={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /guardar/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/entre 1 y 60/i)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
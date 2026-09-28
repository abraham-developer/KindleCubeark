// apps/web/src/test/SelectionMenu.test.tsx — menú flotante de anotación sobre
// una selección de texto: 4 colores + "Nota", cerrar al tocar fuera / Escape y
// conservación de la selección al pulsar un botón (preventDefault en mousedown).
import { render, fireEvent, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import SelectionMenu, { HIGHLIGHT_COLORS } from '../reader/SelectionMenu'
import NoteEditor from '../reader/NoteEditor'

function renderMenu(overrides: Partial<Parameters<typeof SelectionMenu>[0]> = {}) {
  const props = {
    x: 40,
    y: 60,
    onSelect: vi.fn(),
    onNote: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  const view = render(<SelectionMenu {...props} />)
  return { ...props, ...view }
}

describe('SelectionMenu', () => {
  it('muestra los 4 colores con aria-label del color y el botón Nota', () => {
    renderMenu()
    expect(HIGHLIGHT_COLORS.map(c => c.key)).toEqual(['yellow', 'gray', 'pink', 'blue'])
    for (const color of HIGHLIGHT_COLORS) {
      expect(screen.getByRole('button', { name: color.label })).toBeTruthy()
    }
    expect(screen.getByRole('button', { name: /nota/i })).toBeTruthy()
  })

  it('click en rosa llama onSelect("pink")', () => {
    const onSelect = vi.fn()
    renderMenu({ onSelect })
    fireEvent.click(screen.getByRole('button', { name: 'rosa' }))
    expect(onSelect).toHaveBeenCalledWith('pink')
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('cada botón de color manda su valor del enum del server', () => {
    const onSelect = vi.fn()
    renderMenu({ onSelect })
    fireEvent.click(screen.getByRole('button', { name: 'amarillo' }))
    fireEvent.click(screen.getByRole('button', { name: 'gris' }))
    fireEvent.click(screen.getByRole('button', { name: 'azul' }))
    expect(onSelect.mock.calls.map(c => c[0])).toEqual(['yellow', 'gray', 'blue'])
  })

  it('click en Nota llama onNote', () => {
    const onNote = vi.fn()
    renderMenu({ onNote })
    fireEvent.click(screen.getByRole('button', { name: /nota/i }))
    expect(onNote).toHaveBeenCalledTimes(1)
  })

  it('se ancla en las coordenadas recibidas (x, y)', () => {
    const { container } = renderMenu({ x: 120, y: 88 })
    const menu = container.firstElementChild as HTMLElement
    expect(menu.style.left).toBe('120px')
    expect(menu.style.top).toBe('88px')
  })

  it('un mousedown fuera cierra; uno dentro no', () => {
    const onClose = vi.fn()
    const { container } = renderMenu({ onClose })
    // dentro del menú: no cierra
    fireEvent.mouseDown(screen.getByRole('button', { name: /nota/i }))
    expect(onClose).not.toHaveBeenCalled()
    // fuera del menú: cierra (tap sobre el fondo, como pide el brief)
    fireEvent.mouseDown(container)
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.touchStart(document.body)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('Escape cierra el menú', () => {
    const onClose = vi.fn()
    renderMenu({ onClose })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('pulsar un color conserva la selección de texto (no la borra el mousedown)', () => {
    const onSelect = vi.fn()
    const { container } = render(<>
      <p id="parrafo">Un fragmento resaltable del libro.</p>
      <SelectionMenu x={10} y={10} onSelect={onSelect} onNote={vi.fn()} onClose={vi.fn()} />
    </>)
    // selección real sobre el párrafo, como haría el lector
    const paragraph = document.getElementById('parrafo') ?? container.querySelector('p')
    if (!paragraph) throw new Error('no hay párrafo')
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    const selection = document.getSelection()
    selection!.removeAllRanges()
    selection!.addRange(range)
    expect(selection!.toString()).toContain('resaltable')

    const rosa = screen.getByRole('button', { name: 'rosa' })
    // el mousedown sobre el botón (lo que un click real dispara primero)
    // ejercita el preventDefault del menú: no borra la selección
    fireEvent.mouseDown(rosa)
    expect(onSelect).not.toHaveBeenCalled()
    expect(document.getSelection()!.toString()).toContain('resaltable')
    fireEvent.click(rosa)
    expect(onSelect).toHaveBeenCalledWith('pink')
    // el mousedown del click sobre el menú no limpia la selección
    expect(document.getSelection()!.toString()).toContain('resaltable')
  })
})

describe('NoteEditor', () => {
  it('guarda el texto recortado y no guarda vacío', () => {
    const onSave = vi.fn()
    render(<NoteEditor heading="Nueva nota" initialNote="" quotedText="una cita" onSave={onSave} onCancel={vi.fn()} />)
    const area = screen.getByRole('textbox', { name: /nota/i }) as HTMLTextAreaElement
    expect(screen.getByText(/una cita/)).toBeTruthy()
    const guardar = screen.getByRole('button', { name: /guardar/i }) as HTMLButtonElement
    expect(guardar.disabled).toBe(true) // sin texto no se puede guardar
    fireEvent.change(area, { target: { value: '  mi nota  ' } })
    expect(guardar.disabled).toBe(false)
    fireEvent.click(guardar)
    expect(onSave).toHaveBeenCalledWith('mi nota')
  })

  it('precarga la nota existente (editar) y Cancelar no guarda', () => {
    const onSave = vi.fn()
    const onCancel = vi.fn()
    render(<NoteEditor heading="Editar nota" initialNote="texto previo" onSave={onSave} onCancel={onCancel} />)
    expect((screen.getByRole('textbox', { name: /nota/i }) as HTMLTextAreaElement).value).toBe('texto previo')
    fireEvent.click(screen.getByRole('button', { name: /cancelar/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSave).not.toHaveBeenCalled()
  })
})
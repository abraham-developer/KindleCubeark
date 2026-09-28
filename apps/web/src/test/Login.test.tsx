// apps/web/src/test/Login.test.tsx — pantallas de login y registro (Task 10).
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from '../state/AuthContext'
import Login from '../pages/Login'
import Register from '../pages/Register'

vi.mock('../api', () => ({
  api: {
    login: vi.fn().mockResolvedValue({ id: '1', email: 'a@b.c' }),
    register: vi.fn().mockResolvedValue({ id: '1', email: 'a@b.c' }),
    logout: vi.fn().mockResolvedValue(undefined),
    me: vi.fn().mockResolvedValue(null),
  },
}))

afterEach(() => {
  // clearAllMocks limpia llamadas sin quitar las implementaciones de la factoría
  vi.clearAllMocks()
})

function renderWith(initialEntry: string) {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/" element={<div>home</div>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  )
}

describe('Login', () => {
  it('valida campos vacíos', async () => {
    renderWith('/login')
    await userEvent.click(screen.getByRole('button', { name: /entrar/i }))
    expect(await screen.findByText(/completá email y contraseña/i)).toBeInTheDocument()
    const { api } = await import('../api')
    expect(api.login).not.toHaveBeenCalled()
  })

  it('muestra error con credenciales incorrectas', async () => {
    const { api } = await import('../api')
    vi.mocked(api.login).mockRejectedValueOnce(Object.assign(new Error('x'), { status: 401 }))
    renderWith('/login')
    await userEvent.type(screen.getByLabelText(/email/i), 'a@b.c')
    await userEvent.type(screen.getByLabelText(/contraseña/i), 'wrong')
    await userEvent.click(screen.getByRole('button', { name: /entrar/i }))
    expect(await screen.findByText(/email o contraseña incorrectos/i)).toBeInTheDocument()
  })

  it('con error de red muestra mensaje de conexión', async () => {
    const { api } = await import('../api')
    vi.mocked(api.login).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    renderWith('/login')
    await userEvent.type(screen.getByLabelText(/email/i), 'a@b.c')
    await userEvent.type(screen.getByLabelText(/contraseña/i), 'secret1')
    await userEvent.click(screen.getByRole('button', { name: /entrar/i }))
    expect(await screen.findByText(/error de conexión/i)).toBeInTheDocument()
  })

  it('login exitoso navega a /', async () => {
    renderWith('/login')
    await userEvent.type(screen.getByLabelText(/email/i), 'a@b.c')
    await userEvent.type(screen.getByLabelText(/contraseña/i), 'secret1')
    await userEvent.click(screen.getByRole('button', { name: /entrar/i }))
    expect(await screen.findByText('home')).toBeInTheDocument()
  })

  it('con sesión activa redirige a /', async () => {
    const { api } = await import('../api')
    vi.mocked(api.me).mockResolvedValueOnce({ id: '1', email: 'a@b.c' })
    renderWith('/login')
    expect(await screen.findByText('home')).toBeInTheDocument()
  })

  it('enlaza al registro', async () => {
    renderWith('/login')
    await userEvent.click(screen.getByRole('link', { name: /creá una/i }))
    expect(await screen.findByRole('button', { name: /crear cuenta/i })).toBeInTheDocument()
  })
})

describe('Register', () => {
  it('valida campos vacíos', async () => {
    renderWith('/register')
    await userEvent.click(screen.getByRole('button', { name: /crear cuenta/i }))
    expect(await screen.findByText(/completá email y contraseña/i)).toBeInTheDocument()
    const { api } = await import('../api')
    expect(api.register).not.toHaveBeenCalled()
  })

  it('muestra el mensaje del servidor en error 400', async () => {
    const { api } = await import('../api')
    vi.mocked(api.register).mockRejectedValueOnce(Object.assign(new Error('La contraseña debe tener al menos 8 caracteres'), { status: 400 }))
    renderWith('/register')
    await userEvent.type(screen.getByLabelText(/email/i), 'a@b.c')
    await userEvent.type(screen.getByLabelText(/contraseña/i), 'corta')
    await userEvent.click(screen.getByRole('button', { name: /crear cuenta/i }))
    expect(await screen.findByText(/al menos 8 caracteres/i)).toBeInTheDocument()
  })

  it('registro exitoso navega a /', async () => {
    renderWith('/register')
    await userEvent.type(screen.getByLabelText(/email/i), 'a@b.c')
    await userEvent.type(screen.getByLabelText(/contraseña/i), 'secret1')
    await userEvent.click(screen.getByRole('button', { name: /crear cuenta/i }))
    expect(await screen.findByText('home')).toBeInTheDocument()
  })

  it('enlaza al login', async () => {
    renderWith('/register')
    await userEvent.click(screen.getByRole('link', { name: /iniciá sesión/i }))
    expect(await screen.findByRole('button', { name: /entrar/i })).toBeInTheDocument()
  })
})
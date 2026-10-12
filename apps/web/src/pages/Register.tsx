// apps/web/src/pages/Register.tsx — pantalla de creación de cuenta.
import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../state/AuthContext'
import { AuthLayout, authErrorMessage } from './AuthLayout'

export default function Register() {
  const { user, loading, signIn } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!loading && user) return <Navigate to="/" replace />

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!email.trim() || !password) { setError('Completa tu correo electrónico y contraseña'); return }
    setError(null); setBusy(true)
    try {
      await api.register(email.trim(), password)
      await signIn(email.trim(), password) // el registro ya crea la sesión; así el estado queda sincronizado
      navigate('/', { replace: true })
    } catch (err) {
      setError(authErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout sub="Empieza a leer en minutos.">
      <form onSubmit={onSubmit}>
        <div className="auth-field">
          <label htmlFor="register-email">Email</label>
          <input id="register-email" type="email" autoComplete="email" value={email}
            onChange={e => setEmail(e.target.value)} />
        </div>
        <div className="auth-field">
          <label htmlFor="register-password">Contraseña</label>
          <input id="register-password" type="password" autoComplete="new-password" value={password}
            onChange={e => setPassword(e.target.value)} />
        </div>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={busy}>Crear cuenta</button>
        <p className="auth-alt">
          ¿Ya tienes cuenta? <Link to="/login">Inicia sesión</Link>
        </p>
      </form>
    </AuthLayout>
  )
}
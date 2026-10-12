// apps/web/src/pages/Login.tsx — pantalla de inicio de sesión.
import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../state/AuthContext'
import { AuthLayout, authErrorMessage } from './AuthLayout'

export default function Login() {
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
      await signIn(email.trim(), password)
      navigate('/', { replace: true })
    } catch (err) {
      setError(authErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout sub="Tu biblioteca, donde la dejaste.">
      <form onSubmit={onSubmit}>
        <div className="auth-field">
          <label htmlFor="login-email">Email</label>
          <input id="login-email" type="email" autoComplete="email" value={email}
            onChange={e => setEmail(e.target.value)} />
        </div>
        <div className="auth-field">
          <label htmlFor="login-password">Contraseña</label>
          <input id="login-password" type="password" autoComplete="current-password" value={password}
            onChange={e => setPassword(e.target.value)} />
        </div>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={busy}>Entrar</button>
        <p className="auth-alt">
          ¿No tienes cuenta? <Link to="/register">Crea una</Link>
        </p>
      </form>
    </AuthLayout>
  )
}
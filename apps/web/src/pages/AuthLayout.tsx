// apps/web/src/pages/AuthLayout.tsx — layout compartido de login/registro y mapeo de errores.
import type { ReactNode } from 'react'

/** Pantalla de autenticación: título, sublínea y card centrada sobre papel cálido. */
export function AuthLayout({ sub, children }: { sub: string; children: ReactNode }) {
  return (
    <div className="auth-page">
      <h1 className="auth-title">KindleCubeark</h1>
      <p className="auth-sub">{sub}</p>
      <div className="auth-card">{children}</div>
    </div>
  )
}

/** 401 → mensaje fijo; otro error HTTP → mensaje del servidor; sin estado HTTP → conexión. */
export function authErrorMessage(err: unknown): string {
  const status = (err as { status?: unknown } | null)?.status
  if (typeof status !== 'number') return 'Error de conexión'
  return status === 401 ? 'Email o contraseña incorrectos' : (err as Error).message
}
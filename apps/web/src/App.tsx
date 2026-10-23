// apps/web/src/App.tsx
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { AuthProvider, useAuth } from './state/AuthContext'
import Login from './pages/Login'
import Register from './pages/Register'
import Library from './pages/Library'
import { Suspense, lazy } from 'react'
import Reader from './reader/Reader'

const TypingMode = lazy(() => import('./pages/TypingMode'))

function RequireAuth() {
  const { user, loading } = useAuth()
  if (loading) return <div className="page-center">Cargando…</div>
  return user ? <Outlet /> : <Navigate to="/login" replace />
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route element={<RequireAuth />}>
            <Route path="/" element={<Library />} />
            <Route path="/reader/:bookId" element={<Reader />} />
            <Route path="/typing/:bookId" element={<Suspense fallback={<div className="page-center">Cargando…</div>}><TypingMode /></Suspense>} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
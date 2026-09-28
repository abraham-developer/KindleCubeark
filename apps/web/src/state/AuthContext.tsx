// apps/web/src/state/AuthContext.tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api } from '../api'

type Auth = { user: { id: string; email: string } | null; loading: boolean; signIn: (e: string, p: string) => Promise<void>; signOut: () => Promise<void> }
const Ctx = createContext<Auth>(null as never)
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Auth['user']>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => { api.me().then(u => { setUser(u); setLoading(false) }) }, [])
  const value: Auth = {
    user, loading,
    signIn: async (email, password) => setUser(await api.login(email, password)),
    signOut: async () => { await api.logout(); setUser(null) },
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
export const useAuth = () => useContext(Ctx)
// apps/web/src/lib/progressSync.ts — sincronización de progreso con debounce,
// cola de reintento y beacon al cerrar la página (Task 12).
import { useEffect, useMemo, useRef } from 'react'
import { api, type Position } from '../api'

export type ProgressPatchFn = (position: Position, percent: number) => Promise<unknown>
export type PendingProgress = { position: Position; percent: number }

export type ProgressSync = {
  save(position: Position, percent: number): void
  flush(): Promise<void>
  getPending(): PendingProgress | null
  clearPending(): void
}

const DEBOUNCE_MS = 1500
const RETRY_BASE_MS = 1500
const RETRY_MAX_MS = 30_000

/**
 * Máquina de estados pura (sin React): `save` deboncea 1,5 s y manda sólo la
 * última posición; si el PATCH falla, la entrada queda en cola y se reintenta
 * con backoff exponencial (1,5 s · 2^n, tope 30 s).
 */
export function createProgressSync(patch: ProgressPatchFn): ProgressSync {
  let pending: PendingProgress | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let attempts = 0

  const send = async (): Promise<void> => {
    timer = null
    const item = pending
    if (!item) return
    try {
      await patch(item.position, item.percent)
      pending = null
      attempts = 0
    } catch {
      // sin red u error del servidor: se reencola y reintenta
      attempts += 1
      const delay = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS)
      timer = setTimeout(() => { void send() }, delay)
    }
  }

  return {
    save(position, percent) {
      pending = { position, percent } // siempre gana la última posición
      if (timer) return // debounce o reintento ya programado
      timer = setTimeout(() => { void send() }, DEBOUNCE_MS)
    },
    async flush() {
      if (timer) { clearTimeout(timer); timer = null }
      const item = pending
      if (!item) return
      pending = null
      try {
        await patch(item.position, item.percent)
        attempts = 0
      } catch {
        pending = item // queda en cola para el próximo intento
      }
    },
    getPending: () => pending,
    clearPending: () => { pending = null },
  }
}

/** Alias pensado para los tests: expone la máquina sin React. */
export const createSyncForTest = createProgressSync

/**
 * Hook del lector: `save` deboncea contra `api.patchProgress` y, al
 * `pagehide`, manda lo pendiente con `navigator.sendBeacon` (puede que la
 * página muera antes de que la promesa termine).
 */
export function useProgressSync(bookId: string): {
  save(position: Position, percent: number): void
  flush(): Promise<void>
} {
  const syncRef = useRef<ProgressSync | null>(null)
  const idRef = useRef<string | null>(null)
  if (!syncRef.current || idRef.current !== bookId) {
    syncRef.current = createProgressSync((position, percent) => api.patchProgress(bookId, position, percent))
    idRef.current = bookId
  }
  const sync = syncRef.current

  useEffect(() => {
    const onHide = () => {
      const item = sync.getPending()
      if (!item) return
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        const blob = new Blob([JSON.stringify({ position: item.position, percent: item.percent })], { type: 'application/json' })
        // false = el navegador no pudo encolar el beacon: queda pendiente para
        // que flush()/reintento lo entregue por la vía normal
        if (navigator.sendBeacon(`/api/books/${bookId}/progress`, blob)) sync.clearPending()
      }
    }
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      void sync.flush()
    }
  }, [bookId, sync])

  return useMemo(() => ({ save: sync.save.bind(sync), flush: () => sync.flush() }), [sync])
}
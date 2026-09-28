// apps/api/test/migrate.test.ts — reintentos de la migración al arranque:
// el primer deploy corre contra una initdb que aún no acepta conexiones, así
// que migrate() se reintenta con backoff fijo (swarm restart_policy: 3 intentos).
import { describe, it, expect, vi } from 'vitest'
import { migrateWithRetry } from '../src/migrate.js'

describe('migrateWithRetry', () => {
  it('reintenta hasta que run() pasa (falla 2 veces, pasa en la 3.ª)', async () => {
    const sleepFn = vi.fn(async () => {})
    const log = vi.fn()
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('la base de datos no está lista'))
      .mockResolvedValueOnce(undefined)

    await expect(migrateWithRetry(run, { attempts: 5, delayMs: 3000, sleepFn, log })).resolves.toBeUndefined()

    expect(run).toHaveBeenCalledTimes(3)
    expect(sleepFn).toHaveBeenCalledTimes(2)
    expect(sleepFn).toHaveBeenCalledWith(3000)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('intento 1/5'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'))
  })

  it('agota los intentos y propaga el último error', async () => {
    const sleepFn = vi.fn(async () => {})
    const run = vi.fn().mockRejectedValue(new Error('DB caída'))

    await expect(
      migrateWithRetry(run, { attempts: 3, delayMs: 1, sleepFn, log: () => {} }),
    ).rejects.toThrow('DB caída')
    expect(run).toHaveBeenCalledTimes(3)
    expect(sleepFn).toHaveBeenCalledTimes(2)
  })

  it('sin fallos corre una sola vez (sin sleep ni log)', async () => {
    const sleepFn = vi.fn(async () => {})
    const log = vi.fn()
    const run = vi.fn().mockResolvedValue(undefined)

    await migrateWithRetry(run, { attempts: 5, delayMs: 3000, sleepFn, log })
    expect(run).toHaveBeenCalledTimes(1)
    expect(sleepFn).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })
})
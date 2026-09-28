// apps/web/src/test/progressSync.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useProgressSync } from '../lib/progressSync'
import { createSyncForTest } from '../lib/progressSync'

describe('progressSync', () => {
  beforeEach(() => { vi.useFakeTimers() })
  it('debouncea 1.5s y solo manda la última posición', async () => {
    const patch = vi.fn().mockResolvedValue(undefined)
    const sync = createSyncForTest(patch) // helper que expone createProgressSync({ save }) para test sin React
    sync.save({ page: 1 }, 1); sync.save({ page: 2 }, 2); sync.save({ page: 3 }, 3)
    await vi.advanceTimersByTimeAsync(1500)
    expect(patch).toHaveBeenCalledTimes(1)
    expect(patch).toHaveBeenCalledWith({ page: 3 }, 3)
  })
  it('encola si falla y reintenta', async () => {
    const patch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    const sync = createSyncForTest(patch)
    sync.save({ page: 5 }, 50)
    await vi.advanceTimersByTimeAsync(1500)
    await vi.advanceTimersByTimeAsync(3000) // reintento
    expect(patch).toHaveBeenCalledTimes(2)
  })
})
// apps/web/src/test/mocks.ts — helpers de test para stubs del navegador y de la API.
import { vi } from 'vitest'
import { api } from '../api'

/** Espía los métodos de `api` dados; los no listados quedan intactos. */
export function mockApi(overrides: Partial<Record<keyof typeof api, unknown>>) {
  const spies: Record<string, any> = {}
  for (const key of Object.keys(overrides) as (keyof typeof api)[]) {
    spies[key] = vi.spyOn(api, key).mockImplementation(overrides[key] as never)
  }
  return spies
}

/** jsdom no implementa matchMedia. */
export function stubMatchMedia() {
  if (typeof window !== 'undefined' && !window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false, media: query, onchange: null,
        addListener: vi.fn(), removeListener: vi.fn(),
        addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
      }),
    })
  }
}

/** jsdom no implementa ResizeObserver. */
export function stubResizeObserver() {
  if (typeof globalThis !== 'undefined' && !(globalThis as any).ResizeObserver) {
    ;(globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
}

export function stubBrowser() {
  stubMatchMedia()
  stubResizeObserver()
}
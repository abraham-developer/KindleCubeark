// apps/web/src/test/positionSortKey.test.ts — orden de lectura client-side
// (misma lógica que el server): páginas con ceros, CFI lexicográfico.
import { describe, it, expect } from 'vitest'
import { positionSortKey } from '../lib/positionSortKey'

describe('positionSortKey', () => {
  it('PDF: páginas con ceros a la izquierda (el orden del string es el numérico)', () => {
    expect(positionSortKey({ page: 3 }, 'pdf')).toBe('00000003')
    expect(positionSortKey({ page: 3 }, 'pdf') < positionSortKey({ page: 10 }, 'pdf')).toBe(true)
    expect(positionSortKey({ page: 10 }, 'pdf') < positionSortKey({ page: 120 }, 'pdf')).toBe(true)
    expect(positionSortKey({ page: 12, rects: [] }, 'pdf')).toBe('00000012') // ignora lo demás
  })

  it('PDF: posición ausente cae a la página 0 (queda primera)', () => {
    expect(positionSortKey(undefined, 'pdf')).toBe('00000000')
    expect(positionSortKey({}, 'pdf')).toBe('00000000')
  })

  it('EPUB: startCfi (resaltados) y cfi (notas de página) pasan tal cual', () => {
    expect(positionSortKey({ startCfi: 'epubcfi(/6/4!/4/2)' }, 'epub')).toBe('epubcfi(/6/4!/4/2)')
    expect(positionSortKey({ cfi: 'epubcfi(/6/8)' }, 'epub')).toBe('epubcfi(/6/8)')
    // dentro del mismo spine item el orden lexicográfico da el orden de lectura
    expect(positionSortKey({ startCfi: 'epubcfi(/6/4!/4/2)' }, 'epub') <
      positionSortKey({ startCfi: 'epubcfi(/6/4!/4/8)' }, 'epub')).toBe(true)
  })

  it('con ceros el orden del string coincide con el numérico (9 < 10)', () => {
    // sin ceros "10" < "9"; con ceros la página menor queda primera
    expect(positionSortKey({ page: 9 }, 'pdf') < positionSortKey({ page: 10 }, 'pdf')).toBe(true)
  })
})
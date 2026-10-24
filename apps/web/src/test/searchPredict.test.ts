// apps/web/src/test/searchPredict.test.ts — búsqueda predictiva de la
// biblioteca: coincidencias sin acentos y sugerencias ordenadas.
import { describe, it, expect } from 'vitest'
import { matchesQuery, normalizeSearch, searchSuggestions } from '../lib/searchPredict'

const books = [
  { id: '1', title: 'Cien años de soledad', author: 'Gabriel García Márquez' },
  { id: '2', title: 'El Aleph', author: 'Jorge Luis Borges' },
  { id: '3', title: 'Aleph y otros cuentos', author: 'Ana Pérez' },
]

describe('normalizeSearch / matchesQuery', () => {
  it('ignora acentos y mayúsculas', () => {
    expect(normalizeSearch('  García ')).toBe('garcia')
    expect(matchesQuery('Gabriel García Márquez', 'garcia')).toBe(true)
    expect(matchesQuery('El Aleph', 'borges')).toBe(false)
  })
})

describe('searchSuggestions', () => {
  it('prioriza el título que empieza por la búsqueda sobre el que solo la contiene', () => {
    const out = searchSuggestions(books, 'aleph')
    expect(out.map(b => b.id)).toEqual(['3', '2'])
  })

  it('encuentra por autor sin acentos y respeta el límite', () => {
    expect(searchSuggestions(books, 'garcia').map(b => b.id)).toEqual(['1'])
    expect(searchSuggestions(books, 'a', 2)).toHaveLength(2)
  })

  it('sin texto no sugiere nada', () => {
    expect(searchSuggestions(books, '   ')).toEqual([])
  })
})

// apps/web/src/lib/searchPredict.ts — búsqueda predictiva de la biblioteca:
// normaliza acentos/mayúsculas y ordena sugerencias (el título que empieza
// por lo escrito va primero, luego el que lo contiene, luego el autor).

export type SearchableBook = { id: string; title: string; author: string; owner_email?: string | null }

/** Minúsculas sin acentos ni espacios sobrantes: «García» ≡ «garcia». */
export function normalizeSearch(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/\s+/g, ' ')
}

export function matchesQuery(haystack: string, query: string): boolean {
  const q = normalizeSearch(query)
  return q === '' || normalizeSearch(haystack).includes(q)
}

/** Hasta `limit` sugerencias para el texto escrito, en orden de relevancia. */
export function searchSuggestions<T extends SearchableBook>(books: T[], query: string, limit = 6): T[] {
  const q = normalizeSearch(query)
  if (!q) return []
  const scored: Array<{ book: T; score: number }> = []
  for (const book of books) {
    const title = normalizeSearch(book.title)
    const author = normalizeSearch(book.author)
    const owner = normalizeSearch(book.owner_email ?? '')
    let score = -1
    if (title.startsWith(q)) score = 0
    else if (title.includes(q)) score = 1
    else if (author.startsWith(q)) score = 2
    else if (author.includes(q) || owner.includes(q)) score = 3
    if (score >= 0) scored.push({ book, score })
  }
  scored.sort((a, b) => a.score - b.score || a.book.title.localeCompare(b.book.title, 'es'))
  return scored.slice(0, Math.max(0, limit)).map(s => s.book)
}

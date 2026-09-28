// CFI de rango de epub.js ↔ par de CFIs puntuales de la API de anotaciones.
// El server guarda position = { startCfi, endCfi } (dos strings); epub.js
// trabaja con un único CFI de rango 'epubcfi(/6/4!/4/2/1:0,/4/4/1:2)'. La
// separación y re-unión se hacen por el separador de rango (la coma de primer
// nivel del CFI) y el prefijo común hasta '!' (la parte del spine item).
export function splitCfiRange(cfiRange: string): { startCfi: string; endCfi: string } | null {
  const m = /^epubcfi\((.*)\)$/.exec(cfiRange.trim())
  if (!m) return null
  const comma = m[1].indexOf(',')
  if (comma === -1) {
    // CFI puntual: la selección quedó colapsada, empieza y termina igual
    return { startCfi: cfiRange.trim(), endCfi: cfiRange.trim() }
  }
  const left = m[1].slice(0, comma)
  const right = m[1].slice(comma + 1)
  // la segunda mitad del rango es relativa al spine item: se re-arma absoluta
  // con el prefijo común (todo hasta '!') para que endCfi sea un CFI válido
  const bang = left.indexOf('!')
  const prefix = bang !== -1 ? left.slice(0, bang + 1) : ''
  const rightAbsolute = prefix && !right.startsWith(prefix) ? prefix + right : right
  return { startCfi: `epubcfi(${left})`, endCfi: `epubcfi(${rightAbsolute})` }
}

/** Reconstruye el CFI de rango para rendition.annotations.add. */
export function joinCfiRange(startCfi: string, endCfi: string): string {
  if (startCfi === endCfi) return startCfi
  const inner = (s: string) => {
    const m = /^epubcfi\((.*)\)$/.exec(s.trim())
    return m ? m[1] : s.trim()
  }
  const a = inner(startCfi)
  const b = inner(endCfi)
  const bang = a.indexOf('!')
  // sólo si comparten el prefijo del spine item ('/6/4!') el rango re-armado
  // es válido; si no, se usa el CFI inicial (epub.js ancla igual)
  if (bang !== -1 && b.slice(0, bang + 1) === a.slice(0, bang + 1)) {
    return `epubcfi(${a},${b.slice(bang + 1)})`
  }
  return startCfi
}

/** Sección (índice de spine) que un CFI indica: epubcfi(/6/4...) → 2. */
export function cfiSection(cfi: unknown): number | null {
  if (typeof cfi !== 'string') return null
  const m = /^epubcfi\(\/6\/(\d+)/.exec(cfi)
  if (!m) return null
  return Math.floor(Number(m[1]) / 2)
}
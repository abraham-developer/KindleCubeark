// Clave de orden de lectura como string, para ordenar anotaciones de un libro
// (y reutilizable en el cliente: apps/web copia esta lógica en Task 14).
//
// PDF → página con ceros a la izquierda: el orden lexicográfico del string
// coincide con el numérico aunque las páginas tengan distinta cantidad de dígitos.
// EPUB → CFI; los CFI de un mismo libro comparten prefijo, así que el orden
// lexicográfico es estable dentro del libro.
export function positionSortKey(position: any, format: string): string {
  if (format === 'pdf') return String(position?.page ?? 0).padStart(8, '0')
  const cfi = String(position?.startCfi ?? position?.cfi ?? '')
  return cfi // los CFI comparten prefijo, el orden lexicográfico es correcto dentro del mismo libro
}
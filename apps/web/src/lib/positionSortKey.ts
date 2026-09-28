// Clave de orden de lectura en el cliente: espejo de la del server
// (apps/api/src/lib/positionSortKey.ts), usada por el panel de anotaciones.
// PDF → página con ceros a la izquierda (el orden lexicográfico del string
// coincide con el numérico); EPUB → CFI (los CFI del mismo libro comparten
// prefijo, el orden lexicográfico es estable).
export function positionSortKey(position: any, format: string): string {
  if (format === 'pdf') return String(position?.page ?? 0).padStart(8, '0')
  return String(position?.startCfi ?? position?.cfi ?? '')
}
export type BookFormat = 'pdf' | 'epub'

export function detectFormat(buf: Buffer): BookFormat | null {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf'
  if (buf.subarray(0, 4).toString('latin1') === 'PK\x03\x04') {
    const idx = buf.indexOf('application/epub+zip')
    if (idx > -1 && idx < 200) return 'epub' // el mimetype va en el primer entry
  }
  return null
}
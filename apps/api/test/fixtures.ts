import { PDFDocument, StandardFonts } from 'pdf-lib'
import zlib from 'node:zlib'

export async function makeTestPdf(pages = 3, title = 'Libro de prueba'): Promise<Buffer> {
  const doc = await PDFDocument.create()
  doc.setTitle(title)
  doc.setAuthor('Autor Prueba')
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= pages; i++) {
    const p = doc.addPage([300, 500])
    p.drawText(`Pagina ${i}`, { x: 40, y: 250, size: 24, font })
  }
  return Buffer.from(await doc.save())
}

interface ZipEntry {
  name: string
  data: Buffer
}

// Construye un ZIP con entradas STORED (sin comprimir) y en el orden dado.
// Necesario para el EPUB: por spec el primer entry debe ser 'mimetype',
// sin comprimir, con 'application/epub+zip' — adm-zip desinfla (method 8)
// y escribe en otro orden, así que la validación por magic bytes fallaría.
function buildStoredZip(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = zlib.crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // firma local file header
    local.writeUInt16LE(20, 4) // versión necesaria
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // método: STORED
    local.writeUInt16LE(0, 10) // hora
    local.writeUInt16LE(0x21, 12) // fecha válida cualquiera
    local.writeUInt32LE(crc >>> 0, 14)
    local.writeUInt32LE(data.length, 18) // tamaño comprimido
    local.writeUInt32LE(data.length, 22) // tamaño sin comprimir
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // nombre extra: 0
    chunks.push(local, nameBuf, data)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0) // firma central directory
    centralHeader.writeUInt16LE(20, 4) // versión hecha por
    centralHeader.writeUInt16LE(20, 6) // versión necesaria
    centralHeader.writeUInt16LE(0, 8) // flags
    centralHeader.writeUInt16LE(0, 10) // método STORED
    centralHeader.writeUInt16LE(0, 12) // hora
    centralHeader.writeUInt16LE(0x21, 14) // fecha
    centralHeader.writeUInt32LE(crc >>> 0, 16)
    centralHeader.writeUInt32LE(data.length, 20)
    centralHeader.writeUInt32LE(data.length, 24)
    centralHeader.writeUInt16LE(nameBuf.length, 28)
    centralHeader.writeUInt16LE(0, 30) // extra
    centralHeader.writeUInt16LE(0, 32) // comentario
    centralHeader.writeUInt16LE(0, 34) // disco inicial
    centralHeader.writeUInt16LE(0, 36) // atributos internos
    centralHeader.writeUInt32LE(0, 38) // atributos externos
    centralHeader.writeUInt32LE(offset, 42) // offset del local header
    central.push(centralHeader, nameBuf)
    offset += local.length + nameBuf.length + data.length
  }
  const centralStart = offset
  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8) // entradas en este disco
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(centralStart, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, centralBuf, end])
}

function epubEntries(mimetype: string, { title, author, withCover }: { title: string; author: string; withCover: boolean }): ZipEntry[] {
  const manifest = withCover
    ? `<item id="cover-image" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>`
    : ''
  return [
    { name: 'mimetype', data: Buffer.from(mimetype) },
    { name: 'META-INF/container.xml', data: Buffer.from(
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`) },
    { name: 'OEBPS/content.opf', data: Buffer.from(
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator><dc:identifier id="id">urn:uuid:1234</dc:identifier></metadata><manifest>${manifest}<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch1"/></itemref></spine></package>`) },
    { name: 'OEBPS/ch1.xhtml', data: Buffer.from('<html><body><p>Hola capítulo</p></body></html>') },
    ...(withCover ? [{ name: 'OEBPS/cover.jpg', data: jpeg1x1() }] : []),
  ]
}

// JPEG 1x1 mínimo válido
function jpeg1x1(): Buffer {
  return Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDIzNP/AABEIAAEAAQMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAABAgMEBQYHCAkKC//EALURAAEBAwEEBQgFAgECAAMAAwEAAhEDEEEEESExE0FRBgZCInETNDYnKD/xAAVAQEBAAAAAAAAAAAAAAAAAAAAAf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/xAAfEQABBQEAAwUBAAAAAAAAAAABAgMEEQUhEhQxcYH/2gAMAwEAAhEDEQA/AJQA/9k=', 'base64')
}

export function makeTestEpub(
  { title = 'Mi EPUB', author = 'Escritora', withCover = true }:
  { title?: string; author?: string; withCover?: boolean } = {},
): Buffer {
  return buildStoredZip(epubEntries('application/epub+zip', { title, author, withCover }))
}

// EPUB con el entry mimetype incorrecto (p.ej. 'text/plain') para probar la validación
export function makeBadMimetypeEpub(): Buffer {
  return buildStoredZip(epubEntries('text/plain', { title: 'X', author: 'Y', withCover: false }))
}
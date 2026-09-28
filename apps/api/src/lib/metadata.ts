import { PDFDocument } from 'pdf-lib'
import AdmZip from 'adm-zip'
import type { BookFormat } from './magic.js'

export interface BookMeta {
  title?: string
  author?: string
  pages?: number
  coverJpeg?: Buffer
}

// tope por entry: leer texto o portada de un entry que declare más de 10 MB
// sin comprimir sería una vía rápida a un zip-bomb; se salta
export const MAX_TEXT_ENTRY_BYTES = 10 * 1024 * 1024
// tope del total declarado sin comprimir de todos los entries
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 512 * 1024 * 1024

export async function extractMeta(format: BookFormat, buf: Buffer): Promise<BookMeta> {
  if (format === 'pdf') {
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true })
    return {
      title: doc.getTitle() ?? undefined,
      author: doc.getAuthor() ?? undefined,
      pages: doc.getPageCount(),
    }
  }
  return extractEpubMeta(buf)
}

function extractEpubMeta(buf: Buffer): BookMeta {
  const zip = new AdmZip(buf)
  checkZipCaps(zip)

  const mimetypeEntry = zip.getEntry('mimetype')
  // mimetype ausente o que declare un tamaño irrazonable → archivo inválido
  if (!mimetypeEntry || mimetypeEntry.header.size > MAX_TEXT_ENTRY_BYTES) {
    throw new Error('EPUB: mimetype ausente o con tamaño declarado irrazonable')
  }
  if (zip.readAsText(mimetypeEntry).trim() !== 'application/epub+zip') {
    throw new Error('EPUB: mimetype no es application/epub+zip')
  }

  const container = readTextCapped(zip, 'META-INF/container.xml') ?? ''
  const opfPath = container.match(/full-path="([^"]+\.opf)"/)?.[1]
  const opf = opfPath ? (readTextCapped(zip, opfPath) ?? '') : ''
  const title = opf.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/)?.[1]
  const author = opf.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/)?.[1]
  const cover = findCoverJpeg(zip, opf)
  return { title, author, coverJpeg: cover }
}

// comprueba el total declarado (header.size es el tamaño SIN comprimir) para
// detectar bombs antes de descomprimir nada
function checkZipCaps(zip: AdmZip): void {
  const total = zip.getEntries().reduce((sum, e) => sum + Number(e.header.size ?? 0), 0)
  if (total > MAX_TOTAL_UNCOMPRESSED_BYTES) {
    throw new Error('EPUB: tamaño sin comprimir declarado excesivo')
  }
}

// lee texto de un entry solo si existe y declara un tamaño razonable
function readTextCapped(zip: AdmZip, name: string): string | null {
  const entry = zip.getEntry(name)
  if (!entry || Number(entry.header.size) > MAX_TEXT_ENTRY_BYTES) return null
  return zip.readAsText(entry)
}

function findCoverJpeg(zip: AdmZip, opf: string): Buffer | undefined {
  // portada declarada en el manifest del OPF (properties="cover-image"), si la hay
  const declared = opf.match(/<item[^>]*href="([^"]+\.jpe?g|[^"]+\.png)"[^>]*properties="cover-image"/i)
    ?? opf.match(/<item[^>]*properties="cover-image"[^>]*href="([^"]+\.jpe?g|[^"]+\.png)"/i)
  if (declared) {
    const entry = findEntry(zip, declared[1])
    if (entry) return readEntryCapped(zip, entry)
  }
  const fallback = zip.getEntry('cover.jpg') ?? zip.getEntry('OEBPS/cover.jpg')
    ?? zip.getEntries().find(e => /cover.*\.(jpe?g|png)/i.test(e.entryName))
  return fallback ? readEntryCapped(zip, fallback) : undefined
}

// descomprime la portada solo si el tamaño declarado es razonable
function readEntryCapped(zip: AdmZip, entry: import('adm-zip').IZipEntry): Buffer | undefined {
  if (Number(entry.header.size) > MAX_TEXT_ENTRY_BYTES) return undefined
  return entry.getData()
}

function findEntry(zip: AdmZip, href: string) {
  const clean = href.replace(/^\.\//, '')
  return zip.getEntry(clean)
    ?? zip.getEntries().find(e => e.entryName.endsWith(`/${clean}`))
}
import { PDFDocument } from 'pdf-lib'
import AdmZip from 'adm-zip'
import type { BookFormat } from './magic.js'

export interface BookMeta {
  title?: string
  author?: string
  pages?: number
  coverJpeg?: Buffer
}

export async function extractMeta(format: BookFormat, buf: Buffer): Promise<BookMeta> {
  if (format === 'pdf') {
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true })
    return {
      title: doc.getTitle() ?? undefined,
      author: doc.getAuthor() ?? undefined,
      pages: doc.getPageCount(),
    }
  }
  const zip = new AdmZip(buf)
  const opfPath = findOpfPath(zip)
  const opf = opfPath ? zip.readAsText(opfPath) : ''
  const title = opf.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/)?.[1]
  const author = opf.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/)?.[1]
  const cover = findCoverJpeg(zip, opf)
  return { title, author, coverJpeg: cover }
}

function findOpfPath(zip: AdmZip): string | null {
  const container = zip.readAsText('META-INF/container.xml')
  return container.match(/full-path="([^"]+\.opf)"/)?.[1] ?? null
}

function findCoverJpeg(zip: AdmZip, opf: string): Buffer | undefined {
  // portada declarada en el manifest del OPF (properties="cover-image"), si la hay
  const declared = opf.match(/<item[^>]*href="([^"]+\.jpe?g)"[^>]*properties="cover-image"/i)
    ?? opf.match(/<item[^>]*properties="cover-image"[^>]*href="([^"]+\.jpe?g)"/i)
  if (declared) {
    const entry = findEntry(zip, declared[1])
    if (entry) return entry.getData()
  }
  const fallback = zip.getEntry('cover.jpg') ?? zip.getEntry('OEBPS/cover.jpg')
    ?? zip.getEntries().find(e => /cover.*\.(jpe?g|png)/i.test(e.entryName))
  return fallback ? fallback.getData() : undefined
}

function findEntry(zip: AdmZip, href: string) {
  const clean = href.replace(/^\.\//, '')
  return zip.getEntry(clean)
    ?? zip.getEntries().find(e => e.entryName.endsWith(`/${clean}`))
}
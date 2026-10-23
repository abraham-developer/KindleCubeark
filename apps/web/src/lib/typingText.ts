// apps/web/src/lib/typingText.ts — extracción del texto escribible de un
// libro para el modo typing: PDF con pdf.js (mismos ítems que la vista por
// bloques) y EPUB con epub.js (texto de cada sección del spine). El texto
// se tokeniza con lib/typing, no aquí.
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import ePub from 'epubjs'
import type { Book } from '../api'
import { itemsToParagraphs, type PdfTextItem } from './blocks'

const { getDocument, GlobalWorkerOptions } = pdfjs
GlobalWorkerOptions.workerSrc = workerUrl

/** Tope de palabras por libro: un libro largo no necesita cargarse entero
 *  para practicar; el progreso queda acotado a este frente de práctica. */
export const MAX_TYPING_WORDS = 60_000

export async function extractBookText(book: Book, onProgress?: (done: number, total: number) => void): Promise<string> {
  return book.format === 'epub' ? extractEpubText(book, onProgress) : extractPdfText(book, onProgress)
}

async function extractPdfText(book: Book, onProgress?: (done: number, total: number) => void): Promise<string> {
  const doc = await getDocument({ url: book.file_url }).promise
  try {
    const paragraphs: string[] = []
    let words = 0
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      const page = await doc.getPage(pageNo)
      const content = await page.getTextContent()
      const items = (content.items as unknown as Array<Partial<PdfTextItem>>)
        .filter((it): it is PdfTextItem => typeof it.str === 'string' && Array.isArray(it.transform))
      const pageParagraphs = itemsToParagraphs(items)
      paragraphs.push(...pageParagraphs)
      words += pageParagraphs.join(' ').split(/\s+/).filter(Boolean).length
      page.cleanup?.()
      onProgress?.(pageNo, doc.numPages)
      if (words >= MAX_TYPING_WORDS) break
    }
    return paragraphs.join('\n')
  } finally {
    void doc.destroy()
  }
}

async function extractEpubText(book: Book, onProgress?: (done: number, total: number) => void): Promise<string> {
  const epub = ePub(book.file_url, { requestCredentials: true } as never)
  try {
    await epub.ready
    const spine = (epub.spine as unknown as {
      spineItems?: Array<{ load: (book: unknown) => Promise<unknown>; unload?: () => void }>
      length?: number
      get?: (i: number) => { load: (book: unknown) => Promise<unknown>; unload?: () => void } | undefined
    })
    const items: Array<{ load: (book: unknown) => Promise<unknown>; unload?: () => void }> = []
    if (Array.isArray(spine.spineItems)) items.push(...spine.spineItems)
    else if (typeof spine.get === 'function' && typeof spine.length === 'number') {
      for (let i = 0; i < spine.length; i++) {
        const item = spine.get(i)
        if (item) items.push(item)
      }
    }
    const texts: string[] = []
    let words = 0
    for (let i = 0; i < items.length; i++) {
      try {
        const doc = await items[i].load(epub) as Document | undefined
        const text = (doc?.body?.textContent ?? '').replace(/\s+/g, ' ').trim()
        if (text) {
          texts.push(text)
          words += text.split(' ').length
        }
      } catch { /* sección ilegible: se salta, no tumba la práctica */ }
      items[i].unload?.()
      onProgress?.(i + 1, items.length)
      if (words >= MAX_TYPING_WORDS) break
    }
    return texts.join('\n')
  } finally {
    try { epub.destroy() } catch { /* ya destruido */ }
  }
}

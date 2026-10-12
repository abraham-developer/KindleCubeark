// apps/web/src/lib/blocks.ts — lectura por bloques estilo Kindle para PDF:
// agrupa los ítems de texto de pdf.js en párrafos y los parte en bloques
// cortos (minilecturas) con progreso a nivel de bloque.
export type PdfTextItem = {
  str: string
  transform: [number, number, number, number, number, number]
  width?: number
  height?: number
  hasEOL?: boolean
}

/** Tamaño objetivo de cada bloque, en caracteres (se corta por párrafo). */
export const BLOCK_TARGET_CHARS = 700

/** Clave de localStorage para la vista preferida del lector PDF. */
export const PDF_VIEW_KEY = 'kc.pdf.view'

export type PdfView = 'page' | 'blocks'

export function loadPdfView(): PdfView {
  try {
    return window.localStorage.getItem(PDF_VIEW_KEY) === 'blocks' ? 'blocks' : 'page'
  } catch {
    return 'page'
  }
}

export function savePdfView(view: PdfView): void {
  try {
    window.localStorage.setItem(PDF_VIEW_KEY, view)
  } catch {
    /* sin almacenamiento la vista simplemente no persiste */
  }
}

type Line = { y: number; x: number; text: string }

/**
 * Agrupa ítems de pdf.js en líneas (por coordenada Y) y luego en párrafos:
 * un salto vertical mayor a ~1.6× la altura típica de línea abre un párrafo
 * nuevo. Une palabras con espacio y resuelve guiones de corte de línea.
 */
export function itemsToParagraphs(items: PdfTextItem[]): string[] {
  const usable = items.filter(it => it.str != null && it.str !== '')
  if (usable.length === 0) return []

  const sorted = [...usable].sort((a, b) =>
    (b.transform[5] - a.transform[5]) || (a.transform[4] - b.transform[4]))

  const heights = sorted.map(it => Math.abs(it.transform[0]) || it.height || 12)
  const medianH = heights.slice().sort((a, b) => a - b)[Math.floor(heights.length / 2)] || 12
  const sameLineTol = Math.max(2, medianH * 0.4)
  const paragraphGap = medianH * 1.6

  const lines: Line[] = []
  for (const it of sorted) {
    const y = it.transform[5]
    const x = it.transform[4]
    const last = lines[lines.length - 1]
    if (last && Math.abs(y - last.y) <= sameLineTol && !last.text.endsWith('\n')) {
      last.text = joinWord(last.text, it.str)
      last.x = Math.min(last.x, x)
    } else {
      lines.push({ y, x, text: it.str })
    }
    if (it.hasEOL && lines.length > 0) {
      lines[lines.length - 1].text += '\n'
    }
  }

  const paragraphs: string[] = []
  let current = ''
  let prevY: number | null = null
  for (const line of lines) {
    const text = line.text.replace(/\n$/, '')
    const gapBreak = prevY != null && prevY - line.y > paragraphGap
    const eolBreak = line.text.endsWith('\n') && /[.!?…:;»"”']\s*$/.test(text)
    if ((gapBreak || eolBreak) && current.trim()) {
      paragraphs.push(current.trim())
      current = text
    } else {
      current = current ? joinWord(current, text) : text
    }
    prevY = line.y
  }
  if (current.trim()) paragraphs.push(current.trim())
  return paragraphs.filter(p => p.length > 0)
}

/** Une dos fragmentos con espacio, salvo guion de corte de línea («pala-» + «bra»). */
function joinWord(left: string, right: string): string {
  if (!left) return right
  if (!right) return left
  if (left.endsWith('\n')) return left + right
  if (/-$/.test(left.trimEnd()) && /^[a-záéíóúñ]/i.test(right.trimStart())) {
    return `${left.trimEnd().slice(0, -1)}${right.trimStart()}`
  }
  if (/\s$/.test(left) || /^\s/.test(right)) return left + right
  return `${left} ${right}`
}

/**
 * Parte párrafos en bloques de ~targetChars caracteres, cortando siempre por
 * párrafo. Un párrafo más largo que el objetivo se divide por oraciones.
 */
export function chunkParagraphs(paragraphs: string[], targetChars = BLOCK_TARGET_CHARS): string[][] {
  const blocks: string[][] = []
  let current: string[] = []
  let currentLen = 0
  const flush = () => {
    if (current.length > 0) blocks.push(current)
    current = []
    currentLen = 0
  }
  for (const paragraph of paragraphs) {
    const parts = paragraph.length > targetChars ? splitLongParagraph(paragraph, targetChars) : [paragraph]
    for (const part of parts) {
      if (currentLen + part.length > targetChars && current.length > 0) flush()
      current.push(part)
      currentLen += part.length
    }
  }
  flush()
  return blocks
}

/** Divide un párrafo largo por oraciones (y por palabras si no hay puntos). */
function splitLongParagraph(paragraph: string, targetChars: number): string[] {
  const sentences = paragraph.match(/[^.!?…]+[.!?…]+["”»']?\s*|.+$/g) ?? [paragraph]
  const parts: string[] = []
  let current = ''
  const flush = () => {
    if (current.trim()) parts.push(current.trim())
    current = ''
  }
  for (const sentence of sentences) {
    // oración aún más larga que el objetivo (p. ej. sin puntuación): por palabras
    if (sentence.length > targetChars) {
      flush()
      for (const word of sentence.split(/(\s+)/).filter(w => w.length > 0)) {
        if (current && current.length + word.length > targetChars) flush()
        current += word
      }
      flush()
      continue
    }
    if (current && current.length + sentence.length > targetChars) flush()
    current += sentence
  }
  flush()
  return parts.filter(p => p.length > 0)
}

/** Atajo: ítems de una página → bloques listos para mostrar. */
export function pageItemsToBlocks(items: PdfTextItem[], targetChars = BLOCK_TARGET_CHARS): string[][] {
  return chunkParagraphs(itemsToParagraphs(items), targetChars)
}

/**
 * Porcentaje de lectura con precisión de bloque: la página aporta su
 * fracción completa repartida entre sus bloques.
 */
export function blockPercent(page: number, block: number, blockCount: number, numPages: number): number {
  if (!numPages || numPages <= 0) return 0
  const count = Math.max(1, Math.floor(blockCount) || 1)
  const idx = Math.max(0, Math.min(Math.floor(block) || 0, count - 1))
  return (((page - 1) + (idx + 1) / count) / numPages) * 100
}

/** Índice de bloque inicial desde el progreso guardado (con saneo). */
export function initialBlock(position: unknown, blockCount: number): number {
  const block = typeof position === 'object' && position !== null && 'block' in position
    ? (position as { block?: unknown }).block
    : undefined
  const raw = typeof block === 'number' ? Math.floor(block) : 0
  if (!Number.isFinite(raw) || raw < 0) return 0
  return Math.min(raw, Math.max(0, blockCount - 1))
}

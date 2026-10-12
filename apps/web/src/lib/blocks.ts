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

/** Párrafo con su rango vertical (unidades usuario PDF, Y hacia arriba). */
export type TextSpan = { text: string; yTop: number; yBottom: number }

/** Imagen extraída con su rango vertical (mismo espacio que TextSpan). */
export type PageImage = { src: string; alt: string; yTop: number; yBottom: number }

/** Bloque de lectura: texto refluido o imagen en hoja propia. */
export type ContentBlock =
  | { kind: 'text'; paragraphs: string[] }
  | { kind: 'image'; src: string; alt: string }

/**
 * Agrupa ítems de pdf.js en líneas (por coordenada Y) y luego en párrafos
 * con su rango vertical: un salto mayor a ~1.6× la altura típica de línea
 * abre un párrafo nuevo. Une palabras con espacio y resuelve guiones de
 * corte de línea.
 */
export function itemsToSpans(items: PdfTextItem[]): TextSpan[] {
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

  const spans: TextSpan[] = []
  let current = ''
  let top = 0
  let bottom = 0
  let prevY: number | null = null
  const flush = () => {
    const text = current.trim()
    if (text) spans.push({ text, yTop: top, yBottom: bottom })
    current = ''
  }
  for (const line of lines) {
    const text = line.text.replace(/\n$/, '')
    const gapBreak = prevY != null && prevY - line.y > paragraphGap
    const eolBreak = line.text.endsWith('\n') && /[.!?…:;»"”']\s*$/.test(text)
    if ((gapBreak || eolBreak) && current.trim()) {
      flush()
      current = text
      top = line.y
      bottom = line.y
    } else {
      if (!current) { top = line.y; bottom = line.y }
      current = current ? joinWord(current, text) : text
      top = Math.max(top, line.y)
      bottom = Math.min(bottom, line.y)
    }
    prevY = line.y
  }
  flush()
  return spans
}

/** Atajo clásico: ítems → solo textos de párrafo (sin posiciones). */
export function itemsToParagraphs(items: PdfTextItem[]): string[] {
  return itemsToSpans(items).map(s => s.text)
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

export type ContentItem =
  | { kind: 'text'; text: string }
  | { kind: 'image'; src: string; alt: string }

/**
 * Parte contenido en bloques: el texto se acumula hasta ~targetChars
 * caracteres (cortando por párrafo, u oración si uno excede el objetivo)
 * y cada imagen ocupa su propio bloque (vacía el texto pendiente).
 */
export function chunkContentItems(items: ContentItem[], targetChars = BLOCK_TARGET_CHARS): ContentBlock[] {
  const blocks: ContentBlock[] = []
  let current: string[] = []
  let currentLen = 0
  const flushText = () => {
    if (current.length > 0) blocks.push({ kind: 'text', paragraphs: current })
    current = []
    currentLen = 0
  }
  for (const item of items) {
    if (item.kind === 'image') {
      flushText()
      blocks.push({ kind: 'image', src: item.src, alt: item.alt })
      continue
    }
    const parts = item.text.length > targetChars ? splitLongParagraph(item.text, targetChars) : [item.text]
    for (const part of parts) {
      if (currentLen + part.length > targetChars && current.length > 0) flushText()
      current.push(part)
      currentLen += part.length
    }
  }
  flushText()
  return blocks
}

/**
 * Parte párrafos en bloques de ~targetChars caracteres, cortando siempre por
 * párrafo. Un párrafo más largo que el objetivo se divide por oraciones.
 */
export function chunkParagraphs(paragraphs: string[], targetChars = BLOCK_TARGET_CHARS): string[][] {
  return chunkContentItems(paragraphs.map(text => ({ kind: 'text' as const, text })), targetChars)
    .filter((b): b is { kind: 'text'; paragraphs: string[] } => b.kind === 'text')
    .map(b => b.paragraphs)
}

/**
 * Arma los bloques de una página mezclando texto e imágenes en orden de
 * lectura (de arriba hacia abajo por borde superior; el texto gana empates).
 */
export function buildContentBlocks(
  spans: TextSpan[],
  images: PageImage[],
  targetChars = BLOCK_TARGET_CHARS,
): ContentBlock[] {
  const items: Array<ContentItem & { yTop: number }> = [
    ...spans.map(s => ({ kind: 'text' as const, text: s.text, yTop: s.yTop })),
    ...images.map(img => ({ kind: 'image' as const, src: img.src, alt: img.alt, yTop: img.yTop })),
  ]
  items.sort((a, b) => (b.yTop - a.yTop) || (a.kind === 'text' ? -1 : 1))
  return chunkContentItems(items, targetChars)
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
 * Pantalla dentro de la página en vista bloques: en lectura normal cada
 * bloque es una pantalla; en estudio cada bloque de TEXTO ocupa dos
 * (original + traducción) y las imágenes una sola (no se traducen).
 */
export function studyScreenPosition(
  blocks: ContentBlock[],
  block: number,
  face: BlockFace,
  study: boolean,
): { index: number; total: number } {
  const screensOf = (b: ContentBlock) => 1 + (study && b.kind === 'text' ? 1 : 0)
  const total = Math.max(1, blocks.reduce((acc, b) => acc + screensOf(b), 0))
  const at = Math.max(0, Math.min(Math.floor(block) || 0, Math.max(0, blocks.length - 1)))
  let index = blocks.slice(0, at).reduce((acc, b) => acc + screensOf(b), 0)
  if (study && face === 'trans' && blocks[at]?.kind === 'text') index += 1
  return { index: Math.min(index, total - 1), total }
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

/** Cara visible en estudio bilingüe: el bloque original o su traducción. */
export type BlockFace = 'orig' | 'trans'

/**
 * Retomado en vista bloques. La posición guarda el bloque ORIGINAL con su
 * cara ({block, blockCount, face?}): se acota al total real y la cara solo
 * aplica en estudio sobre bloques de texto (las imágenes no se traducen).
 * También tolera el esquema previo de índice doble (blockCount === 2N).
 */
export function resumeBlockFace(
  position: unknown,
  blocks: ContentBlock[],
  study: boolean,
): { block: number; face: BlockFace } {
  const count = blocks.length
  if (count <= 0) return { block: 0, face: 'orig' }
  const pos = (typeof position === 'object' && position !== null ? position : {}) as {
    block?: unknown
    blockCount?: unknown
    face?: unknown
  }
  const rawBlock = typeof pos.block === 'number' && Number.isFinite(pos.block) ? Math.floor(pos.block) : 0
  const rawCount = typeof pos.blockCount === 'number' && Number.isFinite(pos.blockCount)
    ? Math.floor(pos.blockCount)
    : 0
  const clamp = (value: number) => Math.max(0, Math.min(value, count - 1))
  let block: number
  let face: BlockFace = 'orig'
  if (rawCount === count * 2) {
    // esquema previo de índice doble: pantalla i = bloque floor(i/2), cara i%2
    block = clamp(Math.floor(rawBlock / 2))
    if (study && rawBlock % 2 === 1) face = 'trans'
  } else {
    block = clamp(rawBlock)
    if (study && pos.face === 'trans') face = 'trans'
  }
  if (face === 'trans' && blocks[block]?.kind !== 'text') face = 'orig'
  return { block, face }
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

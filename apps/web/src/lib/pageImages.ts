// apps/web/src/lib/pageImages.ts — imágenes de una página PDF con su
// posición: simula la pila gráfica de la lista de operadores (save/restore
// y cm) para ubicar cada pintado de imagen, renderiza la página una vez y
// recorta cada región. Así texto e imágenes se intercalan en orden de
// lectura en la vista por bloques.
import type { PageImage } from './blocks'

/** Caja de imagen en espacio usuario PDF (Y hacia arriba). */
export type ImageBox = { name: unknown; x0: number; y0: number; x1: number; y1: number }

/** Códigos de operador pdf.js que nos interesan (se inyectan por tests). */
export type ImageOps = {
  save: unknown
  restore: unknown
  transform: unknown
  paintImageXObject: unknown
  paintInlineImageXObject?: unknown
}

type Matrix = [number, number, number, number, number, number]

/** Multiplica matrices (vectores fila PDF): aplica m1 y después m2. */
function concat(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ]
}

function applyToPoint(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

/**
 * Cajas de imagen desde la lista de operadores. Cada pintado usa el CTM
 * vigente sobre el cuadrado unidad; el mismo XObject repetido (logo,
 * fondo) se reporta una sola vez en su primera posición. Las máscaras
 * (paintImageMask*) se ignoran: son esténciles decorativos.
 */
export function imageBoxesFromOpList(
  fnArray: ArrayLike<unknown>,
  argsArray: ArrayLike<ArrayLike<unknown>>,
  ops: ImageOps,
): ImageBox[] {
  const boxes: ImageBox[] = []
  const seen = new Set<unknown>()
  let ctm: Matrix = [1, 0, 0, 1, 0, 0]
  const stack: Matrix[] = []
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]
    const args = argsArray[i]
    if (fn === ops.save) {
      stack.push([...ctm] as Matrix)
    } else if (fn === ops.restore) {
      const prev = stack.pop()
      if (prev) ctm = prev
    } else if (fn === ops.transform) {
      const m = Array.from(args ?? []).slice(0, 6)
      if (m.length === 6 && m.every(n => typeof n === 'number' && Number.isFinite(n))) {
        // cm concatena: CTM' = M × CTM (primero M, luego el vigente)
        ctm = concat(m as Matrix, ctm)
      }
    } else if (fn === ops.paintImageXObject || (ops.paintInlineImageXObject !== undefined && fn === ops.paintInlineImageXObject)) {
      const name = args?.[0] ?? i
      if (seen.has(name)) continue
      seen.add(name)
      const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => applyToPoint(ctm, x, y))
      const xs = corners.map(c => c[0])
      const ys = corners.map(c => c[1])
      boxes.push({
        name,
        x0: Math.min(...xs),
        y0: Math.min(...ys),
        x1: Math.max(...xs),
        y1: Math.max(...ys),
      })
    }
  }
  return boxes
}

export type PdfPageLike = {
  getViewport: (o: { scale: number }) => { width: number; height: number }
  view?: readonly number[] | null
  // método (bivariante) para aceptar el render real de pdf.js sin casts
  render(o: { canvasContext: unknown; viewport: unknown }): { promise: Promise<unknown> }
  getOperatorList: () => Promise<{ fnArray: unknown[]; argsArray: unknown[][] }>
}

/**
 * Extrae las imágenes visibles de la página como recortes del render.
 * Filtra motas (menos de minAreaFraction del área, p. ej. píxeles de
 * rastreo). Limitación: ignora /Rotate (la mayoría de libros es 0°).
 */
export async function extractPageImages(
  pdfPage: PdfPageLike,
  ops: ImageOps | null | undefined,
  opts?: { renderWidth?: number; minAreaFraction?: number },
): Promise<PageImage[]> {
  if (!ops || ops.paintImageXObject === undefined) return []
  if (typeof document === 'undefined') return []
  let opList: { fnArray: unknown[]; argsArray: unknown[][] }
  try {
    opList = await pdfPage.getOperatorList()
  } catch {
    return []
  }
  const boxes = imageBoxesFromOpList(opList.fnArray, opList.argsArray, ops)
  if (boxes.length === 0) return []

  const base = pdfPage.getViewport({ scale: 1 })
  const view = pdfPage.view != null && pdfPage.view.length === 4
    ? pdfPage.view
    : [0, 0, base.width, base.height]
  const vw = view[2] - view[0]
  const vh = view[3] - view[1]
  if (!(vw > 0 && vh > 0)) return []
  const minArea = opts?.minAreaFraction ?? 0.005
  const big = boxes.filter(b => ((b.x1 - b.x0) * (b.y1 - b.y0)) / (vw * vh) >= minArea)
  if (big.length === 0) return []

  const renderWidth = opts?.renderWidth ?? 900
  const viewport = pdfPage.getViewport({ scale: renderWidth / base.width })
  const pageCanvas = document.createElement('canvas')
  pageCanvas.width = Math.max(1, Math.round(viewport.width))
  pageCanvas.height = Math.max(1, Math.round(viewport.height))
  const pageCtx = pageCanvas.getContext('2d')
  if (!pageCtx) return []
  try {
    await pdfPage.render({ canvasContext: pageCtx, viewport }).promise
  } catch {
    return []
  }

  const images: PageImage[] = []
  big.forEach((b, i) => {
    const cx0 = Math.max(0, Math.floor(((b.x0 - view[0]) / vw) * pageCanvas.width))
    const cx1 = Math.min(pageCanvas.width, Math.ceil(((b.x1 - view[0]) / vw) * pageCanvas.width))
    // Y del PDF va hacia arriba; el canvas hacia abajo
    const cy0 = Math.max(0, Math.floor((1 - (b.y1 - view[1]) / vh) * pageCanvas.height))
    const cy1 = Math.min(pageCanvas.height, Math.ceil((1 - (b.y0 - view[1]) / vh) * pageCanvas.height))
    const w = cx1 - cx0
    const h = cy1 - cy0
    if (w < 8 || h < 8) return
    const crop = document.createElement('canvas')
    crop.width = w
    crop.height = h
    const ctx = crop.getContext('2d')
    if (!ctx) return
    ctx.drawImage(pageCanvas, cx0, cy0, w, h, 0, 0, w, h)
    let src = ''
    try {
      src = crop.toDataURL()
    } catch {
      return
    }
    if (!src) return
    images.push({ src, alt: `Imagen ${i + 1}`, yTop: b.y1, yBottom: b.y0 })
  })
  return images
}

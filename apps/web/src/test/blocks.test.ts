// apps/web/src/test/blocks.test.ts — párrafos desde ítems pdf.js, partición
// en bloques y porcentaje a nivel de bloque (vista por bloques del PDF).
import { describe, it, expect } from 'vitest'
import {
  BLOCK_TARGET_CHARS, blockPercent, buildContentBlocks, chunkContentItems, chunkParagraphs,
  initialBlock, itemsToParagraphs, itemsToSpans, loadPdfView, pageItemsToBlocks, resumeBlockFace,
  savePdfView, studyScreenPosition,
  type ContentBlock, type PdfTextItem,
} from '../lib/blocks'

function item(str: string, x: number, y: number, extra?: Partial<PdfTextItem>): PdfTextItem {
  return { str, transform: [12, 0, 0, 12, x, y], width: str.length * 6, height: 12, ...extra }
}

describe('itemsToParagraphs', () => {
  it('une palabras de la misma línea y separa párrafos por salto vertical', () => {
    const items = [
      item('Hola', 10, 700), item('mundo.', 50, 700),
      item('Otro', 10, 660), item('párrafo.', 50, 660),
    ]
    expect(itemsToParagraphs(items)).toEqual(['Hola mundo.', 'Otro párrafo.'])
  })

  it('ordena por lectura (de arriba hacia abajo) aunque lleguen mezclados', () => {
    const items = [item('segunda.', 10, 688), item('Primera', 10, 700)]
    expect(itemsToParagraphs(items)).toEqual(['Primera segunda.'])
  })

  it('resuelve guiones de corte de línea («pala-» + «bra» → «palabra»)', () => {
    const items = [item('pala-', 10, 700), item('bra', 50, 700)]
    expect(itemsToParagraphs(items)).toEqual(['palabra'])
  })

  it('ignora ítems vacíos y devuelve [] sin texto', () => {
    expect(itemsToParagraphs([])).toEqual([])
    expect(itemsToParagraphs([item('', 0, 0), item('  ', 0, 0)])).toEqual([])
  })
})

describe('chunkParagraphs', () => {
  it('corta por párrafo cerca del objetivo sin romper palabras', () => {
    const paras = ['a'.repeat(400), 'b'.repeat(400), 'c'.repeat(100)]
    const blocks = chunkParagraphs(paras, 700)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual(['a'.repeat(400)])
    expect(blocks[1]).toEqual(['b'.repeat(400), 'c'.repeat(100)])
  })

  it('un párrafo larguísimo se divide por oraciones', () => {
    const para = `${'x'.repeat(400)}. ${'y'.repeat(400)}. ${'z'.repeat(100)}.`
    const blocks = chunkParagraphs([para], 700)
    expect(blocks.length).toBeGreaterThan(1)
    expect(blocks.flat().join(' ')).toBe(para)
  })

  it('pageItemsToBlocks integra extracción + partición', () => {
    const big = 'palabra '.repeat(200) // ~1600 caracteres
    const blocks = pageItemsToBlocks([item(big, 10, 700)])
    expect(blocks.length).toBeGreaterThan(1)
    expect(BLOCK_TARGET_CHARS).toBe(700)
  })
})

describe('blockPercent', () => {
  it('reparte la página entre sus bloques', () => {
    // pág. 2 de 4, bloque 1 de 2 → (1 + 2/2) / 4 = 50%
    expect(blockPercent(2, 1, 2, 4)).toBeCloseTo(50, 5)
    // pág. 2 de 4, bloque 0 de 2 → (1 + 1/2) / 4 = 37.5%
    expect(blockPercent(2, 0, 2, 4)).toBeCloseTo(37.5, 5)
  })

  it('sanea entradas raras sin romper', () => {
    expect(blockPercent(1, 0, 0, 0)).toBe(0)
    expect(blockPercent(1, 99, 3, 10)).toBeCloseTo(blockPercent(1, 2, 3, 10), 5)
  })
})

describe('initialBlock', () => {
  it('lee el bloque guardado y lo acota al total real', () => {
    expect(initialBlock({ page: 7, block: 2, blockCount: 5 }, 5)).toBe(2)
    expect(initialBlock({ page: 7, block: 9, blockCount: 5 }, 5)).toBe(4)
    expect(initialBlock({ page: 7 }, 5)).toBe(0)
    expect(initialBlock({ cfi: 'epubcfi(/6/4)' }, 5)).toBe(0)
    expect(initialBlock(null, 5)).toBe(0)
    expect(initialBlock({ block: -3 }, 5)).toBe(0)
  })
})

describe('resumeBlockFace', () => {
  const text3: ContentBlock[] = [
    { kind: 'text', paragraphs: ['a'] },
    { kind: 'text', paragraphs: ['b'] },
    { kind: 'text', paragraphs: ['c'] },
  ]
  const mixed: ContentBlock[] = [
    { kind: 'text', paragraphs: ['a'] },
    { kind: 'image', src: 'x', alt: 'Imagen 1' },
    { kind: 'text', paragraphs: ['c'] },
  ]

  it('retoma bloque y cara guardados, acotando al total real', () => {
    expect(resumeBlockFace({ page: 7, block: 1, blockCount: 3, face: 'trans' }, text3, true))
      .toEqual({ block: 1, face: 'trans' })
    expect(resumeBlockFace({ page: 7, block: 9, blockCount: 3, face: 'trans' }, text3, true))
      .toEqual({ block: 2, face: 'trans' })
    expect(resumeBlockFace({ page: 7 }, text3, true)).toEqual({ block: 0, face: 'orig' })
    expect(resumeBlockFace({ page: 7, block: 1, blockCount: 3 }, [], true))
      .toEqual({ block: 0, face: 'orig' })
  })

  it('la cara solo aplica en estudio y sobre texto (imágenes siempre orig)', () => {
    expect(resumeBlockFace({ page: 7, block: 1, blockCount: 3, face: 'trans' }, text3, false))
      .toEqual({ block: 1, face: 'orig' })
    expect(resumeBlockFace({ page: 7, block: 1, blockCount: 3, face: 'trans' }, mixed, true))
      .toEqual({ block: 1, face: 'orig' })
  })

  it('tolera el esquema previo de índice doble (blockCount 2N)', () => {
    expect(resumeBlockFace({ page: 7, block: 3, blockCount: 6 }, text3, true))
      .toEqual({ block: 1, face: 'trans' })
    expect(resumeBlockFace({ page: 7, block: 3, blockCount: 6 }, text3, false))
      .toEqual({ block: 1, face: 'orig' })
  })
})

describe('itemsToSpans', () => {
  it('párrafos con su rango vertical de arriba hacia abajo', () => {
    const items = [
      item('Hola', 10, 700), item('mundo.', 50, 700),
      item('Otro', 10, 660), item('párrafo.', 50, 660),
    ]
    expect(itemsToSpans(items)).toEqual([
      { text: 'Hola mundo.', yTop: 700, yBottom: 700 },
      { text: 'Otro párrafo.', yTop: 660, yBottom: 660 },
    ])
  })
})

describe('buildContentBlocks', () => {
  it('intercala texto e imágenes en orden de lectura', () => {
    const spans = [
      { text: 'Arriba.', yTop: 700, yBottom: 700 },
      { text: 'Abajo.', yTop: 500, yBottom: 500 },
    ]
    const images = [{ src: 'img', alt: 'Imagen 1', yTop: 600, yBottom: 550 }]
    expect(buildContentBlocks(spans, images)).toEqual([
      { kind: 'text', paragraphs: ['Arriba.'] },
      { kind: 'image', src: 'img', alt: 'Imagen 1' },
      { kind: 'text', paragraphs: ['Abajo.'] },
    ])
  })

  it('el texto gana empates y se acumula hasta el objetivo', () => {
    const spans = [
      { text: 'a'.repeat(400), yTop: 700, yBottom: 700 },
      { text: 'b'.repeat(100), yTop: 690, yBottom: 690 },
    ]
    const images = [{ src: 'img', alt: 'Imagen 1', yTop: 690, yBottom: 680 }]
    const blocks = buildContentBlocks(spans, images, 700)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({ kind: 'text', paragraphs: ['a'.repeat(400), 'b'.repeat(100)] })
    expect(blocks[1]).toEqual({ kind: 'image', src: 'img', alt: 'Imagen 1' })
  })

  it('chunkContentItems vacía el texto pendiente ante cada imagen', () => {
    const blocks = chunkContentItems([
      { kind: 'text', text: 'uno' },
      { kind: 'image', src: 'a', alt: 'A' },
      { kind: 'image', src: 'b', alt: 'B' },
      { kind: 'text', text: 'dos' },
    ])
    expect(blocks).toEqual([
      { kind: 'text', paragraphs: ['uno'] },
      { kind: 'image', src: 'a', alt: 'A' },
      { kind: 'image', src: 'b', alt: 'B' },
      { kind: 'text', paragraphs: ['dos'] },
    ])
  })
})

describe('studyScreenPosition', () => {
  const mixed: ContentBlock[] = [
    { kind: 'text', paragraphs: ['a'] },
    { kind: 'image', src: 'x', alt: 'Imagen 1' },
    { kind: 'text', paragraphs: ['c'] },
  ]

  it('normal: un bloque = una pantalla', () => {
    expect(studyScreenPosition(mixed, 1, 'orig', false)).toEqual({ index: 1, total: 3 })
  })

  it('estudio: el texto duplica, la imagen no', () => {
    expect(studyScreenPosition(mixed, 0, 'orig', true)).toEqual({ index: 0, total: 5 })
    expect(studyScreenPosition(mixed, 0, 'trans', true)).toEqual({ index: 1, total: 5 })
    expect(studyScreenPosition(mixed, 1, 'orig', true)).toEqual({ index: 2, total: 5 })
    expect(studyScreenPosition(mixed, 2, 'trans', true)).toEqual({ index: 4, total: 5 })
  })
})

describe('vista PDF persistida', () => {
  it('load/savePdfView redondean la preferencia', () => {
    window.localStorage.clear()
    expect(loadPdfView()).toBe('page')
    savePdfView('blocks')
    expect(loadPdfView()).toBe('blocks')
    savePdfView('page')
    expect(loadPdfView()).toBe('page')
    window.localStorage.clear()
  })
})

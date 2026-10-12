// apps/web/src/test/blocks.test.ts — párrafos desde ítems pdf.js, partición
// en bloques y porcentaje a nivel de bloque (vista por bloques del PDF).
import { describe, it, expect } from 'vitest'
import {
  BLOCK_TARGET_CHARS, blockPercent, chunkParagraphs, initialBlock,
  itemsToParagraphs, loadPdfView, pageItemsToBlocks, savePdfView,
  type PdfTextItem,
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

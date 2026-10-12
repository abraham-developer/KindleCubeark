// apps/web/src/test/pageImages.test.ts — cajas de imagen desde la lista de
// operadores: simulación de CTM (save/restore/cm) y posiciones en Y.
import { describe, it, expect } from 'vitest'
import { imageBoxesFromOpList } from '../lib/pageImages'

// Códigos inventados (lo que importa es la identidad, como con pdfjs.OPS).
const OPS = { save: 1, restore: 2, transform: 3, paintImageXObject: 99, paintInlineImageXObject: 100 }

describe('imageBoxesFromOpList', () => {
  it('ubica la imagen con el CTM vigente (cm 100x100 en 50,600)', () => {
    const boxes = imageBoxesFromOpList(
      [OPS.transform, OPS.paintImageXObject],
      [[100, 0, 0, 100, 50, 600], ['foto']],
      OPS,
    )
    expect(boxes).toEqual([{ name: 'foto', x0: 50, y0: 600, x1: 150, y1: 700 }])
  })

  it('respeta save/restore anidados', () => {
    const boxes = imageBoxesFromOpList(
      [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore, OPS.paintImageXObject],
      [[], [10, 0, 0, 10, 0, 0], ['a'], [], ['b']],
      OPS,
    )
    // 'a' con escala 10, 'b' con identidad (restore deshizo el cm)
    expect(boxes).toEqual([
      { name: 'a', x0: 0, y0: 0, x1: 10, y1: 10 },
      { name: 'b', x0: 0, y0: 0, x1: 1, y1: 1 },
    ])
  })

  it('concatena transforms y reporta repetidos una sola vez', () => {
    const boxes = imageBoxesFromOpList(
      [OPS.transform, OPS.transform, OPS.paintImageXObject, OPS.paintImageXObject],
      [
        [2, 0, 0, 2, 0, 0],
        [1, 0, 0, 1, 10, 20],
        ['logo'],
        ['logo'],
      ],
      OPS,
    )
    // escala×2 y luego traslada en ese espacio: unidad → (20,40)-(22,42), una sola vez
    expect(boxes).toEqual([{ name: 'logo', x0: 20, y0: 40, x1: 22, y1: 42 }])
  })

  it('cubre imágenes inline e ignora operadores desconocidos', () => {
    const boxes = imageBoxesFromOpList(
      ['otro', OPS.paintInlineImageXObject],
      [[], ['inline1']],
      OPS,
    )
    expect(boxes).toEqual([{ name: 'inline1', x0: 0, y0: 0, x1: 1, y1: 1 }])
  })

  it('cm inválido no rompe el CTM vigente', () => {
    const boxes = imageBoxesFromOpList(
      [OPS.transform, OPS.paintImageXObject],
      [[['x']], ['foto']],
      OPS,
    )
    expect(boxes).toEqual([{ name: 'foto', x0: 0, y0: 0, x1: 1, y1: 1 }])
  })
})

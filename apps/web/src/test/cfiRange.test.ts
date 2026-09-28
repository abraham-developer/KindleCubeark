// apps/web/src/test/cfiRange.test.ts — CFI de rango ↔ CFIs puntuales de la API.
import { describe, it, expect } from 'vitest'
import { splitCfiRange, joinCfiRange, cfiSection } from '../lib/cfiRange'

describe('splitCfiRange', () => {
  it('separa el rango de epub.js en dos CFIs puntuales', () => {
    expect(splitCfiRange('epubcfi(/6/4!/4/2/1:0,/4/4/1:2)')).toEqual({
      startCfi: 'epubcfi(/6/4!/4/2/1:0)',
      endCfi: 'epubcfi(/6/4!/4/4/1:2)',
    })
  })

  it('un CFI puntual (sin coma) da start = end', () => {
    expect(splitCfiRange('epubcfi(/6/4)')).toEqual({
      startCfi: 'epubcfi(/6/4)',
      endCfi: 'epubcfi(/6/4)',
    })
  })

  it('formato inválido → null', () => {
    expect(splitCfiRange('no-es-un-cfi')).toBeNull()
    expect(splitCfiRange('')).toBeNull()
  })
})

describe('joinCfiRange', () => {
  it('re-arma el rango compartiendo el prefijo del spine item', () => {
    expect(joinCfiRange('epubcfi(/6/4!/4/2/1:0)', 'epubcfi(/6/4!/4/4/1:2)'))
      .toBe('epubcfi(/6/4!/4/2/1:0,/4/4/1:2)')
  })

  it('idénticos → CFI puntual tal cual (marcador)', () => {
    expect(joinCfiRange('epubcfi(/6/4!/4/2)', 'epubcfi(/6/4!/4/2)')).toBe('epubcfi(/6/4!/4/2)')
  })

  it('si el prefijo no coincide usa el CFI inicial (fallback anclable)', () => {
    expect(joinCfiRange('epubcfi(/6/4!/4/2)', 'epubcfi(/6/8!/4/2)')).toBe('epubcfi(/6/4!/4/2)')
  })
})

describe('cfiSection', () => {
  it('mapea el step del spine a índice (epubcfi(/6/8) → 4)', () => {
    expect(cfiSection('epubcfi(/6/8!/4/2/1:0)')).toBe(4)
    expect(cfiSection('epubcfi(/6/4)')).toBe(2)
  })

  it('entrada inválida → null', () => {
    expect(cfiSection(undefined)).toBeNull()
    expect(cfiSection('texto')).toBeNull()
    expect(cfiSection({})).toBeNull()
  })
})
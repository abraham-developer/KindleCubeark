// apps/web/src/test/dictionary.test.ts — pulsación larga: extracción de la
// palabra bajo el punto, parseo de Wikcionario (es + en) y caché.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  DictNotFound, clearDictionaryCache, lookupAt, lookupAtBoth, lookupWord, parseEnSenses,
  parseEsSenses, pickSenseSection, stripHtml, wordCandidates, wordSpan,
} from '../lib/dictionary'

beforeEach(() => {
  clearDictionaryCache()
})

const ES_SECTIONS = {
  parse: {
    sections: [
      { index: '1', level: '2', line: 'Español' },
      { index: '2', level: '3', line: 'Etimología 1' },
      { index: '3', level: '4', line: 'Sustantivo femenino' },
      { index: '4', level: '2', line: 'Aragonés' },
      { index: '5', level: '3', line: 'Sustantivo' },
    ],
  },
}

const ES_HTML = '<h4>Sustantivo femenino</h4>'
  + '<dl><dt>1 Vivienda</dt><dd><a href="/wiki/x">Edificación</a> destinada a vivienda.</dd></dl>'
  + '<dl><dt>2</dt><dd>Domicilio.<ul><li><b>Uso:</b> coloquial.</li></ul></dd></dl>'

const EN_PAYLOAD = {
  en: [{
    partOfSpeech: 'Noun',
    definitions: [
      { definition: '' },
      { definition: 'A <b>house</b>.', examples: ['My <b>house</b>.'] },
    ],
  }],
}

function stubFetch(handler: (url: string) => unknown) {
  return vi.fn(async (url: string) => {
    const body = handler(url)
    return body === null
      ? new Response('{}', { status: 404 })
      : new Response(JSON.stringify(body), { status: 200 })
  })
}

describe('stripHtml', () => {
  it('quita etiquetas y decodifica entidades', () => {
    expect(stripHtml('<a href="/x">Edificación</a> &amp; <b>casa</b>')).toBe('Edificación & casa')
  })
})

describe('pickSenseSection', () => {
  it('elige la primera sección con sentidos del primer idioma', () => {
    expect(pickSenseSection(ES_SECTIONS.parse.sections)).toBe('3')
  })

  it('null si no hay sentidos en el primer idioma', () => {
    expect(pickSenseSection([
      { index: '1', level: '2', line: 'Español' },
      { index: '2', level: '3', line: 'Etimología' },
      { index: '3', level: '2', line: 'Inglés' },
      { index: '4', level: '3', line: 'Noun' },
    ])).toBeNull()
  })
})

describe('parseEsSenses', () => {
  it('lee glosa + definición y descarta las listas de uso', () => {
    expect(parseEsSenses(ES_HTML)).toEqual([
      { definition: 'Vivienda: Edificación destinada a vivienda.' },
      { definition: 'Domicilio.' },
    ])
  })

  it('tope de 3 sentidos', () => {
    const html = [1, 2, 3, 4, 5].map(n => `<dl><dt>${n}</dt><dd>Acepción ${n}.</dd></dl>`).join('')
    expect(parseEsSenses(html)).toHaveLength(3)
  })
})

describe('parseEnSenses', () => {
  it('lee categoría, definiciones y ejemplo; salta vacías', () => {
    expect(parseEnSenses(EN_PAYLOAD)).toEqual({
      pos: 'Noun',
      senses: [{ definition: 'A house.', example: 'My house.' }],
    })
  })

  it('null sin contenido útil', () => {
    expect(parseEnSenses({})).toBeNull()
    expect(parseEnSenses({ en: [{ definitions: [{ definition: '' }] }] })).toBeNull()
  })
})

describe('wordCandidates', () => {
  it('palabra latina completa con tildes', () => {
    expect(wordCandidates('hola mundo', 2)).toEqual(['hola'])
    expect(wordCandidates('el jardín', 4)).toEqual(['jardín'])
    expect(wordCandidates("(hi)", 1)).toEqual(['hi'])
    expect(wordCandidates("l'amour", 1)).toEqual(["l'amour"])
  })

  it('vacío fuera de palabra o de rango', () => {
    expect(wordCandidates('hi there', 2)).toEqual([])
    expect(wordCandidates('', 0)).toEqual([])
    expect(wordCandidates('hola', 9)).toEqual([])
  })

  it('hanzi: compuesto de 2 con reintento de 1; kana corrido', () => {
    expect(wordCandidates('喝水好', 1)).toEqual(['水好', '水'])
    expect(wordCandidates('水', 0)).toEqual(['水'])
    expect(wordCandidates('あいう', 1)).toEqual(['あいう'])
  })
})

describe('wordSpan', () => {
  it('rango UTF-16 de la palabra para marcarla en azul', () => {
    expect(wordSpan('hola mundo', 2)).toEqual({ start: 0, end: 4, candidates: ['hola'] })
    expect(wordSpan('el jardín', 4)).toEqual({ start: 3, end: 9, candidates: ['jardín'] })
    expect(wordSpan('hi there', 2)).toBeNull()
  })

  it('cuenta bien con astrales antes (emoji = 2 unidades UTF-16)', () => {
    expect(wordSpan('📚casa', 3)).toEqual({ start: 2, end: 6, candidates: ['casa'] })
    expect(wordSpan('喝水好', 1)).toEqual({ start: 1, end: 3, candidates: ['水好', '水'] })
  })
})

describe('lookupWord', () => {
  it('busca en español y cachea por palabra', async () => {
    const fetchFn = stubFetch(url =>
      url.includes('prop=sections') ? ES_SECTIONS
        : url.includes('prop=text') ? { parse: { text: { '*': ES_HTML } } }
          : null)
    const entry = await lookupWord('casa', fetchFn as never)
    expect(entry).toEqual({
      word: 'casa', lang: 'es', pos: 'Sustantivo femenino',
      senses: [
        { definition: 'Vivienda: Edificación destinada a vivienda.' },
        { definition: 'Domicilio.' },
      ],
    })
    expect(fetchFn).toHaveBeenCalledTimes(2)
    await lookupWord('casa', fetchFn as never)
    expect(fetchFn).toHaveBeenCalledTimes(2) // la segunda sale de la caché
  })

  it('si no hay español cae al inglés', async () => {
    const fetchFn = stubFetch(url => (url.includes('/definition/') ? EN_PAYLOAD : null))
    const entry = await lookupWord('book', fetchFn as never)
    expect(entry.lang).toBe('en')
    expect(entry.senses).toEqual([{ definition: 'A house.', example: 'My house.' }])
  })

  it('sin nada en ningún idioma lanza DictNotFound', async () => {
    const fetchFn = stubFetch(() => null)
    await expect(lookupWord('zzzqqq', fetchFn as never)).rejects.toThrow(DictNotFound)
  })
})

describe('lookupAt', () => {
  it('prueba los candidatos en orden (compuesto hanzi, luego simple)', async () => {
    const tried: string[] = []
    const fetchFn = stubFetch(url => {
      const m = url.match(/page=([^&]+)/)
      if (m) tried.push(decodeURIComponent(m[1]))
      // solo 水 existe en español
      if (url.includes('prop=sections') && url.includes(encodeURIComponent('水'))
        && !url.includes(encodeURIComponent('水好'))) return ES_SECTIONS
      if (url.includes('prop=text')) return { parse: { text: { '*': ES_HTML } } }
      return null
    })
    const entry = await lookupAt('喝水好', 1, fetchFn as never)
    expect(entry.word).toBe('水')
    expect(entry.lang).toBe('es')
    expect(tried[0]).toBe('水好')
  })
})

describe('lookupAtBoth', () => {
  it('trae español e inglés en paralelo', async () => {
    const fetchFn = stubFetch(url =>
      url.includes('prop=sections') ? ES_SECTIONS
        : url.includes('prop=text') ? { parse: { text: { '*': ES_HTML } } }
          : url.includes('/definition/') ? EN_PAYLOAD
            : null)
    const both = await lookupAtBoth('la casa', 4, fetchFn as never)
    expect(both.word).toBe('casa')
    expect(both.es?.senses).toHaveLength(2)
    expect(both.en?.senses).toEqual([{ definition: 'A house.', example: 'My house.' }])
  })

  it('con un solo idioma trae ese; sin ninguno lanza DictNotFound', async () => {
    const onlyEn = stubFetch(url => (url.includes('/definition/') ? EN_PAYLOAD : null))
    const both = await lookupAtBoth('book', 1, onlyEn as never)
    expect(both.es).toBeNull()
    expect(both.en?.lang).toBe('en')

    const none = stubFetch(() => null)
    await expect(lookupAtBoth('zzzqqq', 1, none as never)).rejects.toThrow(DictNotFound)
  })
})

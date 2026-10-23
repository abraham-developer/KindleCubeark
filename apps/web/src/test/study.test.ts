// apps/web/src/test/study.test.ts — modo estudio bilingüe: idiomas, prefs y
// caché de traducción (la API real la proxya LibreTranslate en el backend).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { api } from '../api'
import {
  STUDY_LANGS, clearTranslationCache, isStudyLang, loadStudyPrefs,
  saveStudyPrefs, studyLangLabel, translateBlock,
} from '../lib/study'

afterEach(() => {
  clearTranslationCache()
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('idiomas de estudio', () => {
  it('ofrece inglés, francés, alemán, chino y español', () => {
    expect(STUDY_LANGS.map(l => l.code)).toEqual(['en', 'fr', 'de', 'zh', 'es'])
    expect(studyLangLabel('de')).toBe('Alemán')
    expect(studyLangLabel('fr')).toBe('Francés')
    expect(isStudyLang('zh')).toBe(true)
    expect(isStudyLang('fr')).toBe(true)
    expect(isStudyLang('pt')).toBe(false)
  })

  it('las prefs persisten activación e idioma', () => {
    expect(loadStudyPrefs()).toEqual({ on: false, lang: 'en' })
    saveStudyPrefs({ on: true, lang: 'zh' })
    expect(loadStudyPrefs()).toEqual({ on: true, lang: 'zh' })
  })
})

describe('translateBlock', () => {
  it('llama a api.translate y cachea por (idioma + texto)', async () => {
    const translate = vi.spyOn(api, 'translate')
      .mockImplementation(async (q: string, target: string) => ({ translated_text: `[${target}] ${q}` }))
    expect(await translateBlock('Hola mundo', 'en')).toBe('[en] Hola mundo')
    expect(await translateBlock('Hola mundo', 'en')).toBe('[en] Hola mundo')
    expect(translate).toHaveBeenCalledTimes(1) // el segundo sale de la caché
    expect(await translateBlock('Hola mundo', 'de')).toBe('[de] Hola mundo')
    expect(translate).toHaveBeenCalledTimes(2) // otro idioma sí pega de nuevo
    expect(translate).toHaveBeenCalledWith('Hola mundo', 'en')
  })

  it('texto vacío no pega a la API', async () => {
    const translate = vi.spyOn(api, 'translate').mockImplementation(async () => ({ translated_text: '' }))
    expect(await translateBlock('   ', 'en')).toBe('')
    expect(translate).not.toHaveBeenCalled()
  })
})

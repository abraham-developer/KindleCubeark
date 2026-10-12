// apps/web/src/lib/study.ts — modo estudio bilingüe: traduce el bloque en
// lectura con el endpoint /api/translate (la API lo proxya a LibreTranslate,
// motor open source autohospedado). Solo se usa si el lector activa la opción.
import { api } from '../api'

export const STUDY_LANGS = [
  { code: 'en', label: 'Inglés' },
  { code: 'de', label: 'Alemán' },
  { code: 'zh', label: 'Chino' },
  { code: 'es', label: 'Español' },
] as const

export type StudyLang = (typeof STUDY_LANGS)[number]['code']

export function isStudyLang(value: unknown): value is StudyLang {
  return value === 'en' || value === 'de' || value === 'zh' || value === 'es'
}

export function studyLangLabel(code: StudyLang): string {
  return STUDY_LANGS.find(l => l.code === code)?.label ?? code
}

const STUDY_ON_KEY = 'kc.study.on'
const STUDY_LANG_KEY = 'kc.study.lang'

export function loadStudyPrefs(): { on: boolean; lang: StudyLang } {
  try {
    const lang = window.localStorage.getItem(STUDY_LANG_KEY)
    return {
      on: window.localStorage.getItem(STUDY_ON_KEY) === '1',
      lang: isStudyLang(lang) ? lang : 'en',
    }
  } catch {
    return { on: false, lang: 'en' }
  }
}

export function saveStudyPrefs(prefs: { on: boolean; lang: StudyLang }): void {
  try {
    window.localStorage.setItem(STUDY_ON_KEY, prefs.on ? '1' : '0')
    window.localStorage.setItem(STUDY_LANG_KEY, prefs.lang)
  } catch {
    /* sin almacenamiento la preferencia simplemente no persiste */
  }
}

// Caché en memoria por (idioma + texto): volver a un bloque ya traducido no
// pega de nuevo a la API. Tope sencillo para no crecer sin límite.
const cache = new Map<string, string>()
const CACHE_MAX = 200

export function clearTranslationCache(): void {
  cache.clear()
}

/** Traduce un bloque; usa la caché cuando el texto ya se tradujo a ese idioma. */
export async function translateBlock(text: string, target: StudyLang): Promise<string> {
  const source = text.trim()
  if (!source) return ''
  const key = `${target}\n${source}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const res = await api.translate(source, target)
  cache.set(key, res.translated_text)
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return res.translated_text
}

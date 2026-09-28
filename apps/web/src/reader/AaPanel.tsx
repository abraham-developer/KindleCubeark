// apps/web/src/reader/AaPanel.tsx — panel de ajustes de lectura compartido por
// los lectores (EPUB en Task 13; PDF en Task 14): tamaño de letra, interlineado,
// tipografía y modo día/noche. La configuración persiste en localStorage
// («kc.reader.settings») para que el lector la recupere al volver.
import { useEffect } from 'react'

export type ReaderSettings = {
  fontSize: number // px
  lineHeight: number
  fontFamily: 'serif' | 'sans'
  theme: 'day' | 'night'
}

export const SETTINGS_KEY = 'kc.reader.settings'

export const DEFAULT_SETTINGS: ReaderSettings = {
  fontSize: 18,
  lineHeight: 1.5,
  fontFamily: 'serif',
  theme: 'day',
}

const FONT_MIN = 12
const FONT_MAX = 32
const FONT_STEP = 2

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/** Lee los ajustes guardados; tolera datos corruptos o parciales. */
export function loadSettings(): ReaderSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = JSON.parse(raw) as Partial<ReaderSettings> | null
    if (!parsed || typeof parsed !== 'object') return DEFAULT_SETTINGS
    const fontSize = Number(parsed.fontSize)
    const lineHeight = Number(parsed.lineHeight)
    return {
      fontSize: Number.isFinite(fontSize) ? clamp(fontSize, FONT_MIN, FONT_MAX) : DEFAULT_SETTINGS.fontSize,
      lineHeight: Number.isFinite(lineHeight) ? clamp(lineHeight, 1, 2.4) : DEFAULT_SETTINGS.lineHeight,
      fontFamily: parsed.fontFamily === 'sans' ? 'sans' : 'serif',
      theme: parsed.theme === 'night' ? 'night' : 'day',
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(settings: ReaderSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // storage lleno o bloqueado: los ajustes sólo viven en la sesión
  }
}

/** Familia tipográfica efectiva (px CSS) según la preferencia. */
export function fontFamilyStack(fontFamily: 'serif' | 'sans'): string {
  return fontFamily === 'sans'
    ? "Helvetica, Arial, 'Segoe UI', sans-serif"
    : "Georgia, 'Bookerly', 'Times New Roman', serif"
}

export default function AaPanel({
  settings,
  onChange,
}: {
  settings: ReaderSettings
  onChange: (next: ReaderSettings) => void
}) {
  const patch = (delta: Partial<ReaderSettings>) => onChange({ ...settings, ...delta })

  // Persistencia: cada cambio se guarda al momento (clave kc.reader.settings).
  useEffect(() => {
    saveSettings(settings)
  }, [settings])

  return (
    <div className="aa-panel" role="group" aria-label="Ajustes de lectura">
      <div className="aa-row">
        <button
          type="button"
          className="reader-tool"
          onClick={() => patch({ fontSize: clamp(settings.fontSize - FONT_STEP, FONT_MIN, FONT_MAX) })}
          aria-label="Reducir texto"
        >
          A−
        </button>
        <span className="aa-value" aria-live="polite">{settings.fontSize}px</span>
        <button
          type="button"
          className="reader-tool"
          onClick={() => patch({ fontSize: clamp(settings.fontSize + FONT_STEP, FONT_MIN, FONT_MAX) })}
          aria-label="Aumentar texto"
        >
          A+
        </button>
      </div>

      <button
        type="button"
        className="reader-tool aa-option"
        onClick={() => patch({ lineHeight: settings.lineHeight >= 1.8 ? 1.2 : Math.round((settings.lineHeight + 0.3) * 10) / 10 })}
      >
        Interlineado: {settings.lineHeight.toFixed(1)}
      </button>

      <button
        type="button"
        className="reader-tool aa-option"
        onClick={() => patch({ fontFamily: settings.fontFamily === 'serif' ? 'sans' : 'serif' })}
      >
        Tipografía: {settings.fontFamily === 'serif' ? 'serif' : 'sans'}
      </button>

      <button
        type="button"
        className="reader-tool aa-option"
        onClick={() => patch({ theme: settings.theme === 'day' ? 'night' : 'day' })}
        aria-pressed={settings.theme === 'night'}
      >
        {settings.theme === 'day' ? 'Modo noche' : 'Modo día'}
      </button>
    </div>
  )
}
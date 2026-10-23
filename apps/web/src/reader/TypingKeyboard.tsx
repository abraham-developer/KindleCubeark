// apps/web/src/reader/TypingKeyboard.tsx — teclado en pantalla del modo
// typing: refleja el layout elegido, resalta la próxima tecla y el dedo
// sugerido. Es una ayuda visual; la entrada llega del teclado físico.
import { fingerHint, layoutKeyFor, type KeyboardLayout } from '../lib/typing'

export default function TypingKeyboard({ layout, nextChar, pressedKey }: {
  layout: KeyboardLayout
  nextChar: string | null
  pressedKey: string | null
}) {
  const next = nextChar === null ? null : layoutKeyFor(nextChar, layout)
  const hint = nextChar === null ? null : fingerHint(nextChar, layout)
  return (
    <div className="typing-keyboard" aria-label={`Teclado ${layout.label}`}>
      {layout.rows.map((row, i) => (
        <div className="typing-kb-row" key={i}>
          {[...row].map(ch => (
            <kbd
              key={ch}
              className={`typing-key${next === ch ? ' next' : ''}${pressedKey === ch ? ' pressed' : ''}`}
              data-key={ch}
            >
              {ch === ' ' ? '' : ch}
            </kbd>
          ))}
        </div>
      ))}
      <div className="typing-kb-row">
        <kbd className={`typing-key typing-key-space${next === ' ' ? ' next' : ''}${pressedKey === ' ' ? ' pressed' : ''}`} data-key=" ">
          {next === ' ' ? 'espacio' : ''}
        </kbd>
      </div>
      <p className="typing-finger" aria-live="polite">
        {nextChar === null
          ? 'Lección terminada'
          : <>Siguiente: <strong>{nextChar === ' ' ? 'espacio' : nextChar}</strong>{hint ? <> · dedo {hint}</> : null}</>}
      </p>
    </div>
  )
}

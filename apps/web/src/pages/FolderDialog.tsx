// apps/web/src/pages/FolderDialog.tsx — crear/editar carpeta: nombre + color (Task 7).
import { useState } from 'react'
import { type Folder } from '../api'
import { api } from '../api'
import { SWATCH_COLORS, SWATCH_NAMES } from './Library'

export default function FolderDialog({ folder, onClose, onSaved }: {
  folder: Folder | null
  onClose: () => void
  onSaved: (f: Folder) => void
}) {
  const [name, setName] = useState(folder?.name ?? '')
  const [color, setColor] = useState(folder?.color ?? SWATCH_COLORS[2]) // azul de partida
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const saved = folder
        ? await api.updateFolder(folder.id, { name: name.trim(), color })
        : await api.createFolder(name.trim(), color)
      onSaved(saved)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="folder-dialog-backdrop" role="presentation"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div role="dialog" aria-modal="true" aria-label={folder ? `Editar carpeta ${folder.name}` : 'Nueva carpeta'}
        className="folder-dialog" onKeyDown={e => { if (e.key === 'Escape') onClose() }}>
        <h2>{folder ? 'Editar carpeta' : 'Nueva carpeta'}</h2>
        {error && <p role="alert" className="lib-alert">{error}</p>}
        <section className="auth-field">
          <label htmlFor="folder-name">Nombre</label>
          <input id="folder-name" type="text" value={name} maxLength={60} autoFocus
            onChange={e => setName(e.target.value)} placeholder="Nombre de la carpeta" />
        </section>
        <section className="auth-field">
          <label htmlFor="folder-color">Color</label>
          <div className="color-row">
            {/* selector dinámico nativo: RGB y pipeta según el navegador */}
            <input id="folder-color" type="color" value={color}
              onChange={e => setColor(e.target.value)} />
            <span className="folder-swatch" data-testid="color-preview"
              style={{ '--folder-color': color } as React.CSSProperties} aria-hidden="true" />
            <code data-testid="color-hex">{color}</code>
          </div>
          <div className="swatch-row">
            {SWATCH_COLORS.map(c => (
              <button type="button" key={c} className="swatch" aria-label={SWATCH_NAMES[c] ?? c}
                style={{ background: c }} aria-pressed={color === c}
                onClick={() => setColor(c)} />
            ))}
          </div>
        </section>
        <div className="folder-dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="button" className="btn btn-primary" disabled={busy || name.trim().length === 0}
            onClick={() => void save()}>
            {folder ? 'Guardar' : 'Crear carpeta'}
          </button>
        </div>
      </div>
    </div>
  )
}
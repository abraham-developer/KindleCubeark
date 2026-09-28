import { mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'

export async function saveBookFile(dataDir: string, userId: string, bookId: string, format: string, buf: Buffer): Promise<string> {
  const rel = path.join(userId, `${bookId}.${format}`)
  await mkdir(path.dirname(path.join(dataDir, rel)), { recursive: true })
  await writeFile(path.join(dataDir, rel), buf)
  return rel
}

// guarda la portada con su extensión real según magic bytes
// (\x89PNG → .png, \xFF\xD8 → .jpg) y devuelve la ruta relativa usada
export async function saveCover(dataDir: string, userId: string, bookId: string, cover: Buffer): Promise<string> {
  const ext = cover.subarray(0, 4).toString('latin1').startsWith('\x89PNG') ? 'png' : 'jpg'
  const rel = path.join(userId, `${bookId}.${ext}`)
  await mkdir(path.dirname(path.join(dataDir, rel)), { recursive: true })
  await writeFile(path.join(dataDir, rel), cover)
  return rel
}

// borra el libro y cualquier portada asociada (.jpg/.jpeg/.png) sin dejar huérfanos
export async function removeBookFiles(dataDir: string, rel: string): Promise<void> {
  await rm(path.join(dataDir, rel), { force: true })
  const base = rel.replace(/\.\w+$/, '')
  for (const ext of ['jpg', 'jpeg', 'png']) {
    await rm(path.join(dataDir, `${base}.${ext}`), { force: true })
  }
}
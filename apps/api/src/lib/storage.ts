import { mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'

export async function saveBookFile(dataDir: string, userId: string, bookId: string, format: string, buf: Buffer): Promise<string> {
  const rel = path.join(userId, `${bookId}.${format}`)
  await mkdir(path.dirname(path.join(dataDir, rel)), { recursive: true })
  await writeFile(path.join(dataDir, rel), buf)
  return rel
}

export async function saveCover(dataDir: string, userId: string, bookId: string, jpeg: Buffer): Promise<string> {
  const rel = path.join(userId, `${bookId}.jpg`)
  await mkdir(path.dirname(path.join(dataDir, rel)), { recursive: true })
  await writeFile(path.join(dataDir, rel), jpeg)
  return rel
}

export async function removeBookFiles(dataDir: string, rel: string): Promise<void> {
  await rm(path.join(dataDir, rel), { force: true })
  await rm(path.join(dataDir, rel.replace(/\.\w+$/, '.jpg')), { force: true })
}
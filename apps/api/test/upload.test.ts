import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { buildApp } from '../src/app.js'
import { resetDb } from './helpers/db.js'
import { makeTestPdf, makeTestEpub, makeBadMimetypeEpub, makeBombEpub, makeCorruptPdf } from './fixtures.js'
import { readdir, rm } from 'node:fs/promises'

const DATA_DIR = 'test-tmp/data'
const BOUNDARY = '----kindlecubeformboundary7d1b'

beforeEach(async () => {
  await resetDb()
  await rm('test-tmp', { recursive: true, force: true })
})

afterAll(async () => {
  await rm('test-tmp', { recursive: true, force: true })
})

async function registerAndGetCookie(app: any, email = 'up@test.dev') {
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'password123' } })
  return res.cookies.find((c: { name: string }) => c.name === 'session')!.value
}

// multipart/form-data real construido a mano: boundary + parte del archivo
function multipartBody(buf: Buffer, name: string, type: string): Buffer {
  const head = Buffer.from(
    `--${BOUNDARY}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${name}"\r\n` +
    `Content-Type: ${type}\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`)
  return Buffer.concat([head, buf, tail])
}

async function upload(app: any, cookie: string, buf: Buffer, name = 'libro.pdf', type = 'application/pdf') {
  return app.inject({
    method: 'POST',
    url: '/api/books',
    cookies: { session: cookie },
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: multipartBody(buf, name, type),
  })
}

async function listStoredFiles(): Promise<string[]> {
  return readdir(DATA_DIR).catch(() => [])
}

describe('upload', () => {
  it('sube un PDF válido y extrae título/páginas', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookie = await registerAndGetCookie(app)
    const buf = await makeTestPdf(3, 'Libro de prueba')
    const res = await upload(app, cookie, buf)
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.title).toBe('Libro de prueba')
    expect(body.author).toBe('Autor Prueba')
    expect(body.format).toBe('pdf')
    expect(body.total_pages).toBe(3)
    expect(Number(body.file_size)).toBe(buf.length)
    await app.close()
  })

  it('sube un EPUB válido, extrae metadatos y guarda la portada', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookie = await registerAndGetCookie(app, 'epub@test.dev')
    const buf = makeTestEpub({ title: 'Mi EPUB', author: 'Escritora', withCover: true })
    const res = await upload(app, cookie, buf, 'libro.epub', 'application/epub+zip')
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.title).toBe('Mi EPUB')
    expect(body.author).toBe('Escritora')
    expect(body.format).toBe('epub')
    expect(body.cover_path).toBe(`${body.user_id}/${body.id}.jpg`)
    const stored = await readdir(DATA_DIR, { recursive: true })
    expect(stored.filter(f => f.endsWith('.epub') || f.endsWith('.jpg'))).toHaveLength(2)
    await app.close()
  })

  it('rechaza un archivo con extensión .pdf que no es PDF', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookie = await registerAndGetCookie(app)
    const res = await upload(app, cookie, Buffer.from('hola'), 'libro.pdf')
    expect(res.statusCode).toBe(400)
    expect(await listStoredFiles()).toEqual([])
    await app.close()
  })

  it('rechaza EPUB sin mimetype correcto', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookie = await registerAndGetCookie(app)
    const res = await upload(app, cookie, makeBadMimetypeEpub(), 'libro.epub', 'application/epub+zip')
    expect(res.statusCode).toBe(400)
    expect(await listStoredFiles()).toEqual([])
    await app.close()
  })

  it('no deja archivos en disco si la validación falla', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookie = await registerAndGetCookie(app)
    await upload(app, cookie, Buffer.from('hola'), 'falso.pdf')
    await upload(app, cookie, makeBadMimetypeEpub(), 'falso.epub', 'application/epub+zip')
    await upload(app, cookie, makeTestEpub({ withCover: false }).subarray(0, 10), 'truncado.epub', 'application/epub+zip')
    expect(await listStoredFiles()).toEqual([])
    await app.close()
  })

  it('rechaza un EPUB zip-bomb (mimetype con tamaño declarado enorme) sin consumir memoria', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookie = await registerAndGetCookie(app, 'bomb@test.dev')
    // payload minúsculo (~300 B) que declara 100 MB sin comprimir en el mimetype
    const res = await upload(app, cookie, makeBombEpub(), 'bomba.epub', 'application/epub+zip')
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toBe('El archivo está corrupto o es ilegible')
    expect(await listStoredFiles()).toEqual([])
    await app.close()
  })

  it('rechaza un EPUB con mimetype ausente o total declarado excesivo', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookie = await registerAndGetCookie(app, 'bomb2@test.dev')
    // mimetype ok pero OPF declara 200 MB sin comprimir
    const zip = makeTestEpub({ withCover: false })
    const res = await upload(app, cookie, zip.subarray(0, 60), 'cortado.epub', 'application/epub+zip')
    expect(res.statusCode).toBe(400)
    expect(await listStoredFiles()).toEqual([])
    await app.close()
  })

  it('rechaza un PDF con magic bytes válidos pero contenido ilegible', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookie = await registerAndGetCookie(app, 'corrupto@test.dev')
    const res = await upload(app, cookie, makeCorruptPdf(), 'corrupto.pdf')
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toBe('El archivo está corrupto o es ilegible')
    expect(await listStoredFiles()).toEqual([])
    await app.close()
  })

  it('rechaza por límite de tamaño con maxUploadMb pequeño', async () => {
    // maxUploadMb: 0.001 → bodyLimit ≈ 1311 B, límite fileSize ≈ 1049 B;
    // el payload debe quedar ENTRE ambos para que el recorte sea del multipart (400)
    // y no del bodyLimit (413)
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR, maxUploadMb: 0.001 } })
    const cookie = await registerAndGetCookie(app, 'grande@test.dev')
    const base = await makeTestPdf(1, 'Chico')
    const target = 1200
    const buf = base.length < target
      ? Buffer.concat([base, Buffer.from('%' + 'a'.repeat(target - base.length))])
      : base
    expect(buf.length).toBeGreaterThan(0.001 * 1024 * 1024)
    expect(buf.length).toBeLessThanOrEqual(Math.ceil(0.001 * 1.25 * 1024 * 1024))
    const res = await upload(app, cookie, buf)
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toBe('El archivo excede el tamaño máximo')
    expect(await listStoredFiles()).toEqual([])
    await app.close()
  })

  it('guarda la portada con su extensión real (PNG)', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookie = await registerAndGetCookie(app, 'png@test.dev')
    const buf = makeTestEpub({ withCover: true, coverFormat: 'png' })
    const res = await upload(app, cookie, buf, 'libro.epub', 'application/epub+zip')
    expect(res.statusCode).toBe(201)
    expect(res.json().cover_path).toBe(`${res.json().user_id}/${res.json().id}.png`)
    await app.close()
  })
})
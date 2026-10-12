import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { buildApp } from '../src/app.js'
import { resetDb } from './helpers/db.js'
import { makeTestPdf } from './fixtures.js'
import { registerAndGetCookie, multipartBody, uploadBook, BOUNDARY } from './helpers/upload.js'
import { rm } from 'node:fs/promises'

const DATA_DIR = 'test-tmp/data'

beforeEach(async () => {
  await resetDb()
  await rm('test-tmp', { recursive: true, force: true })
})

afterAll(async () => {
  await rm('test-tmp', { recursive: true, force: true })
})

// multipart con archivo + campo texto extra (p.ej. visibility)
function multipartWithField(buf: Buffer, name: string, type: string, field: string, value: string): Buffer {
  const body = multipartBody(buf, name, type)
  const closing = Buffer.from(`--${BOUNDARY}--\r\n`)
  const inner = body.subarray(0, body.length - closing.length)
  const fieldPart = Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${field}"\r\n\r\n${value}\r\n`,
  )
  return Buffer.concat([inner, fieldPart, closing])
}

async function uploadWithVisibility(app: any, cookie: string, buf: Buffer, visibility: string) {
  return app.inject({
    method: 'POST',
    url: '/api/books',
    cookies: { session: cookie },
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: multipartWithField(buf, 'libro.pdf', 'application/pdf', 'visibility', visibility),
  })
}

describe('visibilidad global/personal', () => {
  it('la subida sin visibility queda personal e invisible para otros', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookieA = await registerAndGetCookie(app, 'due@test.dev')
    const cookieB = await registerAndGetCookie(app, 'otro@test.dev')
    const book = await uploadBook(app, cookieA, await makeTestPdf(2, 'Privado'))
    expect(book.visibility).toBe('personal')

    const global = await app.inject({ method: 'GET', url: '/api/books/global', cookies: { session: cookieB } })
    expect(global.statusCode).toBe(200)
    expect(global.json()).toEqual([])
    const direct = await app.inject({ method: 'GET', url: `/api/books/${book.id}`, cookies: { session: cookieB } })
    expect(direct.statusCode).toBe(404)
    const file = await app.inject({ method: 'GET', url: book.file_url, cookies: { session: cookieB } })
    expect(file.statusCode).toBe(404)
    await app.close()
  })

  it('la subida global se ve en /api/books/global y se puede leer', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookieA = await registerAndGetCookie(app, 'autor@test.dev')
    const cookieB = await registerAndGetCookie(app, 'lector@test.dev')
    const buf = await makeTestPdf(2, 'Compartido')
    const up = await uploadWithVisibility(app, cookieA, buf, 'global')
    expect(up.statusCode).toBe(201)
    expect(up.json().visibility).toBe('global')
    const book = up.json()

    const global = await app.inject({ method: 'GET', url: '/api/books/global', cookies: { session: cookieB } })
    expect(global.statusCode).toBe(200)
    expect(global.json()).toHaveLength(1)
    expect(global.json()[0]).toMatchObject({ id: book.id, owner_email: 'autor@test.dev', is_mine: false })

    // lectura directa del original: detalle, archivo, progreso y anotación propios
    const direct = await app.inject({ method: 'GET', url: `/api/books/${book.id}`, cookies: { session: cookieB } })
    expect(direct.statusCode).toBe(200)
    const file = await app.inject({ method: 'GET', url: book.file_url, cookies: { session: cookieB } })
    expect(file.statusCode).toBe(200)
    expect(file.rawPayload.equals(buf)).toBe(true)
    const prog = await app.inject({
      method: 'PATCH', url: `/api/books/${book.id}/progress`, cookies: { session: cookieB },
      payload: { position: { page: 2 }, percent: 99 },
    })
    expect(prog.statusCode).toBe(200)
    const note = await app.inject({
      method: 'POST', url: `/api/books/${book.id}/annotations`, cookies: { session: cookieB },
      payload: { kind: 'note', position: { page: 1 }, note: 'hola' },
    })
    expect(note.statusCode).toBe(201)
    await app.close()
  })

  it('?q= filtra la biblioteca global por título o autor', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookieA = await registerAndGetCookie(app, 'bib@test.dev')
    const cookieB = await registerAndGetCookie(app, 'busca@test.dev')
    await uploadWithVisibility(app, cookieA, await makeTestPdf(1, 'Cocina fácil'), 'global')
    await uploadWithVisibility(app, cookieA, await makeTestPdf(1, 'Historia naval'), 'global')

    const res = await app.inject({ method: 'GET', url: '/api/books/global?q=cocina', cookies: { session: cookieB } })
    expect(res.json().map((b: { title: string }) => b.title)).toEqual(['Cocina fácil'])
    const all = await app.inject({ method: 'GET', url: '/api/books/global', cookies: { session: cookieB } })
    expect(all.json()).toHaveLength(2)
    await app.close()
  })

  it('adoptar copia el libro a mi biblioteca como personal', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookieA = await registerAndGetCookie(app, 'orig@test.dev')
    const cookieB = await registerAndGetCookie(app, 'adopta@test.dev')
    const buf = await makeTestPdf(3, 'Adoptable')
    const book = (await uploadWithVisibility(app, cookieA, buf, 'global')).json()

    const res = await app.inject({ method: 'POST', url: `/api/books/${book.id}/adopt`, cookies: { session: cookieB } })
    expect(res.statusCode).toBe(201)
    const copy = res.json()
    expect(copy.id).not.toBe(book.id)
    expect(copy).toMatchObject({ title: 'Adoptable', visibility: 'personal' })
    const file = await app.inject({ method: 'GET', url: copy.file_url, cookies: { session: cookieB } })
    expect(file.statusCode).toBe(200)
    expect(file.rawPayload.equals(buf)).toBe(true)
    const mine = await app.inject({ method: 'GET', url: '/api/books', cookies: { session: cookieB } })
    expect(mine.json().map((b: { id: string }) => b.id)).toContain(copy.id)

    // el dueño no puede adoptarse a sí mismo; lo personal ajeno no se adopta
    const self = await app.inject({ method: 'POST', url: `/api/books/${book.id}/adopt`, cookies: { session: cookieA } })
    expect(self.statusCode).toBe(400)
    const priv = await uploadBook(app, cookieA, await makeTestPdf(1, 'Mío'))
    const nope = await app.inject({ method: 'POST', url: `/api/books/${priv.id}/adopt`, cookies: { session: cookieB } })
    expect(nope.statusCode).toBe(404)
    await app.close()
  })

  it('si el dueño borra el global, las copias adoptadas sobreviven', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookieA = await registerAndGetCookie(app, 'borra@test.dev')
    const cookieB = await registerAndGetCookie(app, 'guarda@test.dev')
    const book = (await uploadWithVisibility(app, cookieA, await makeTestPdf(1, 'Efímero'), 'global')).json()
    const copy = (await app.inject({ method: 'POST', url: `/api/books/${book.id}/adopt`, cookies: { session: cookieB } })).json()

    const del = await app.inject({ method: 'DELETE', url: `/api/books/${book.id}`, cookies: { session: cookieA } })
    expect(del.statusCode).toBe(204)
    const mine = await app.inject({ method: 'GET', url: `/api/books/${copy.id}`, cookies: { session: cookieB } })
    expect(mine.statusCode).toBe(200)
    const file = await app.inject({ method: 'GET', url: copy.file_url, cookies: { session: cookieB } })
    expect(file.statusCode).toBe(200)
    await app.close()
  })
})

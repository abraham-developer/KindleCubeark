import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { buildApp } from '../src/app.js'
import { resetDb } from './helpers/db.js'
import { pool } from '../src/db.js'
import { makeTestPdf, makeTestEpub } from './fixtures.js'
import { registerAndGetCookie, uploadBook } from './helpers/upload.js'
import { rm } from 'node:fs/promises'

const DATA_DIR = 'test-tmp/data'

beforeEach(async () => {
  await resetDb()
  await rm('test-tmp', { recursive: true, force: true })
})

afterAll(async () => {
  await rm('test-tmp', { recursive: true, force: true })
  await pool.end().catch(() => {})
})

interface PostOptions {
  kind: string
  position: unknown
  quoted_text?: string
  note?: string
  color?: string
}

function postAnnotation(app: any, cookie: string, bookId: string, body: PostOptions) {
  return app.inject({
    method: 'POST',
    url: `/api/books/${bookId}/annotations`,
    cookies: { session: cookie },
    payload: body,
  })
}

function listAnnotations(app: any, cookie: string, bookId: string) {
  return app.inject({
    method: 'GET',
    url: `/api/books/${bookId}/annotations`,
    cookies: { session: cookie },
  })
}

function deleteAnnotation(app: any, cookie: string, id: string) {
  return app.inject({
    method: 'DELETE',
    url: `/api/annotations/${id}`,
    cookies: { session: cookie },
  })
}

describe('annotations', () => {
  it('crea highlight y nota, lista ordenada por página', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookie = await registerAndGetCookie(app, 'ann@test.dev')
    const book = await uploadBook(app, cookie, await makeTestPdf(5, 'Anotado'))

    const h3 = await postAnnotation(app, cookie, book.id, {
      kind: 'highlight',
      position: { page: 3, rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.03 }] },
      quoted_text: 'Pagina 3',
      color: 'pink',
    })
    expect(h3.statusCode).toBe(201)
    expect(h3.json().kind).toBe('highlight')
    expect(h3.json().position).toEqual({ page: 3, rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.03 }] })
    expect(h3.json().color).toBe('pink')

    const n1 = await postAnnotation(app, cookie, book.id, {
      kind: 'note',
      position: { page: 1 },
      note: 'Esta página mola',
      color: 'blue',
    })
    expect(n1.statusCode).toBe(201)

    const h2 = await postAnnotation(app, cookie, book.id, {
      kind: 'highlight',
      position: { page: 2, rects: [{ x: 0, y: 0, w: 1, h: 1 }] },
    })
    expect(h2.statusCode).toBe(201)
    // color por defecto
    expect(h2.json().color).toBe('yellow')

    const list = await listAnnotations(app, cookie, book.id)
    expect(list.statusCode).toBe(200)
    const body = list.json()
    expect(body).toHaveLength(3)
    expect(body.map((a: { position: { page: number } }) => a.position.page)).toEqual([1, 2, 3])
    expect(body[0].note).toBe('Esta página mola')
    expect(body[2].quoted_text).toBe('Pagina 3')
    await app.close()
  })

  it('rechaza rects fuera de rango y colores inválidos', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookie = await registerAndGetCookie(app, 'annval@test.dev')
    const pdf = await uploadBook(app, cookie, await makeTestPdf(3, 'PDF corto'))
    const epub = await uploadBook(app, cookie, makeTestEpub({ title: 'EPUB ann' }), 'libro.epub', 'application/epub+zip')

    // cada caso va contra el formato correcto: los cfi contra el EPUB, el resto al PDF
    const cases: Array<{ target: string; body: PostOptions }> = [
      // rects: valores fuera de [0,1]
      { target: pdf.id, body: { kind: 'highlight', position: { page: 1, rects: [{ x: 1.5, y: 0, w: 0.1, h: 0.1 }] } } },
      { target: pdf.id, body: { kind: 'highlight', position: { page: 1, rects: [{ x: -0.1, y: 0, w: 0.1, h: 0.1 }] } } },
      { target: pdf.id, body: { kind: 'highlight', position: { page: 1, rects: [{ x: 0.1, y: 0, w: 'a', h: 0.1 }] } } },
      // rects vacíos o ausentes en un highlight
      { target: pdf.id, body: { kind: 'highlight', position: { page: 1, rects: [] } } },
      { target: pdf.id, body: { kind: 'highlight', position: { page: 1 } } },
      // page fuera de rango (int ≥ 1 y ≤ total_pages, igual que progreso)
      { target: pdf.id, body: { kind: 'highlight', position: { page: 0, rects: [{ x: 0, y: 0, w: 1, h: 1 }] } } },
      { target: pdf.id, body: { kind: 'highlight', position: { page: 4, rects: [{ x: 0, y: 0, w: 1, h: 1 }] } } },
      { target: pdf.id, body: { kind: 'highlight', position: { page: 1.5, rects: [{ x: 0, y: 0, w: 1, h: 1 }] } } },
      // nota de página con rects (la nota solo lleva {page})
      { target: pdf.id, body: { kind: 'note', position: { page: 1, rects: [{ x: 0, y: 0, w: 1, h: 1 }] } } },
      { target: pdf.id, body: { kind: 'note', position: { page: 0 } } },
      // color inválido
      { target: pdf.id, body: { kind: 'highlight', position: { page: 1, rects: [{ x: 0, y: 0, w: 1, h: 1 }] }, color: 'red' } },
      // kind inválido
      { target: pdf.id, body: { kind: 'scribble', position: { page: 1 } } },
      // EPUB highlight sin cfi completos
      { target: epub.id, body: { kind: 'highlight', position: { startCfi: 'epubcfi(/6/4)' } } },
      { target: epub.id, body: { kind: 'highlight', position: { startCfi: '', endCfi: 'epubcfi(/6/4)' } } },
      { target: epub.id, body: { kind: 'highlight', position: { endCfi: 'epubcfi(/6/4)' } } },
      { target: epub.id, body: { kind: 'highlight', position: {} } },
      // EPUB note sin cfi
      { target: epub.id, body: { kind: 'note', position: {} } },
    ]
    for (const { target, body } of cases) {
      const res = await postAnnotation(app, cookie, target, body)
      expect(res.statusCode, JSON.stringify(body)).toBe(400)
    }

    // nada se escribió para las inválidas
    const { rows } = await pool.query('SELECT COUNT(*) FROM annotations')
    expect(Number(rows[0].count)).toBe(0)
    await app.close()
  })

  it('EPUB: highlight {startCfi,endCfi} y nota {cfi} o {startCfi} verbatim', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookie = await registerAndGetCookie(app, 'annepub@test.dev')
    const book = await uploadBook(app, cookie, makeTestEpub({ title: 'EPUB ann 2' }), 'libro.epub', 'application/epub+zip')

    const h = await postAnnotation(app, cookie, book.id, {
      kind: 'highlight',
      position: { startCfi: 'epubcfi(/6/4!/4/2,/1:0,/1:10)', endCfi: 'epubcfi(/6/4!/4/2,/1:20,/1:40)' },
      quoted_text: 'Hola capítulo',
    })
    expect(h.statusCode).toBe(201)
    expect(h.json().position).toEqual({
      startCfi: 'epubcfi(/6/4!/4/2,/1:0,/1:10)',
      endCfi: 'epubcfi(/6/4!/4/2,/1:20,/1:40)',
    })

    // nota con cfi (lo que manda el lector para notas de nivel de página)
    const nCfi = await postAnnotation(app, cookie, book.id, { kind: 'note', position: { cfi: 'epubcfi(/6/4)' } })
    expect(nCfi.statusCode).toBe(201)
    expect(nCfi.json().position).toEqual({ cfi: 'epubcfi(/6/4)' })

    // nota con startCfi también se acepta
    const nStart = await postAnnotation(app, cookie, book.id, { kind: 'note', position: { startCfi: 'epubcfi(/6/2)' } })
    expect(nStart.statusCode).toBe(201)
    expect(nStart.json().position).toEqual({ startCfi: 'epubcfi(/6/2)' })

    const list = await listAnnotations(app, cookie, book.id)
    expect(list.json().map((a: { position: { cfi?: string; startCfi?: string } }) => a.position.cfi ?? a.position.startCfi))
      .toEqual(['epubcfi(/6/2)', 'epubcfi(/6/4!/4/2,/1:0,/1:10)', 'epubcfi(/6/4)'])
    await app.close()
  })

  it('acepta bookmark (kind note, color bookmark, texto vacío) y lo devuelve en la lista', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookie = await registerAndGetCookie(app, 'annmark@test.dev')
    const pdf = await uploadBook(app, cookie, await makeTestPdf(5, 'Marcas'))
    const epub = await uploadBook(app, cookie, makeTestEpub({ title: 'Marcas epub' }), 'libro.epub', 'application/epub+zip')

    const bmPdf = await postAnnotation(app, cookie, pdf.id, { kind: 'note', position: { page: 4 }, color: 'bookmark' })
    expect(bmPdf.statusCode).toBe(201)
    expect(bmPdf.json().color).toBe('bookmark')
    expect(bmPdf.json().note).toBe('')

    const bmEpub = await postAnnotation(app, cookie, epub.id, { kind: 'note', position: { cfi: 'epubcfi(/6/4)' }, color: 'bookmark' })
    expect(bmEpub.statusCode).toBe(201)

    const list = await listAnnotations(app, cookie, pdf.id)
    expect(list.json()).toHaveLength(1)
    expect(list.json()[0].color).toBe('bookmark')
    await app.close()
  })

  it('DELETE de anotación de otro usuario → 404; propia → 204', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookieA = await registerAndGetCookie(app, 'annown@test.dev')
    const cookieB = await registerAndGetCookie(app, 'annother@test.dev')
    const book = await uploadBook(app, cookieA, await makeTestPdf(5, 'Ajeno'))

    const ann = await postAnnotation(app, cookieA, book.id, {
      kind: 'highlight',
      position: { page: 1, rects: [{ x: 0, y: 0, w: 1, h: 1 }] },
    })
    const id = ann.json().id

    const foreign = await deleteAnnotation(app, cookieB, id)
    expect(foreign.statusCode).toBe(404)

    const own = await deleteAnnotation(app, cookieA, id)
    expect(own.statusCode).toBe(204)

    // borrada de verdad y ya no está en la lista
    const { rows } = await pool.query('SELECT COUNT(*) FROM annotations')
    expect(Number(rows[0].count)).toBe(0)
    const list = await listAnnotations(app, cookieA, book.id)
    expect(list.json()).toHaveLength(0)

    // inexistente → 404 igualmente
    expect((await deleteAnnotation(app, cookieA, id)).statusCode).toBe(404)
    await app.close()
  })

  it('DELETE de libro borra sus anotaciones (cascade)', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookie = await registerAndGetCookie(app, 'annbook@test.dev')
    const book = await uploadBook(app, cookie, await makeTestPdf(5, 'Cascada'))

    await postAnnotation(app, cookie, book.id, {
      kind: 'highlight',
      position: { page: 2, rects: [{ x: 0, y: 0, w: 1, h: 1 }] },
    })
    await postAnnotation(app, cookie, book.id, { kind: 'note', position: { page: 3 } })
    expect((await listAnnotations(app, cookie, book.id)).json()).toHaveLength(2)

    const del = await app.inject({ method: 'DELETE', url: `/api/books/${book.id}`, cookies: { session: cookie } })
    expect(del.statusCode).toBe(204)

    const { rows } = await pool.query('SELECT COUNT(*) FROM annotations')
    expect(Number(rows[0].count)).toBe(0)
    await app.close()
  })

  it('lista de libro ajeno → 404; POST a libro ajeno → 404; sin sesión → 401', async () => {
    const app = await buildApp({ skipStatic: true, config: { dataDir: DATA_DIR } })
    const cookieA = await registerAndGetCookie(app, 'annlist@test.dev')
    const cookieB = await registerAndGetCookie(app, 'annlist2@test.dev')
    const book = await uploadBook(app, cookieA, await makeTestPdf(5, 'Lista ajena'))

    const foreignList = await listAnnotations(app, cookieB, book.id)
    expect(foreignList.statusCode).toBe(404)

    const foreignPost = await postAnnotation(app, cookieB, book.id, {
      kind: 'highlight',
      position: { page: 1, rects: [{ x: 0, y: 0, w: 1, h: 1 }] },
    })
    expect(foreignPost.statusCode).toBe(404)

    expect((await app.inject({ method: 'POST', url: `/api/books/${book.id}/annotations`, payload: { kind: 'note', position: { page: 1 } } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: `/api/books/${book.id}/annotations` })).statusCode).toBe(401)
    expect((await app.inject({ method: 'DELETE', url: '/api/annotations/00000000-0000-0000-0000-000000000000', cookies: { session: cookieA } })).statusCode).toBe(404)
    await app.close()
  })
})
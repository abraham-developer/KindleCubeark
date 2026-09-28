// apps/web/src/api.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { api, ApiError } from './api'

class MockXHR {
  static instances: MockXHR[] = []
  status = 0
  responseText = ''
  upload = { onprogress: null as ((e: ProgressEvent) => void) | null }
  onload: (() => void) | null = null
  openCalledWith: [string, string] | null = null
  sent: unknown = null
  open(method: string, url: string) { this.openCalledWith = [method, url] }
  send(body: unknown) { this.sent = body; MockXHR.instances.push(this) }
}

describe('api.uploadBook', () => {
  beforeEach(() => {
    MockXHR.instances = []
    vi.stubGlobal('XMLHttpRequest', MockXHR)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('envía multipart FormData con la entrada "file"', async () => {
    const file = new File(['datos'], 'libro.epub', { type: 'application/epub+zip' })
    const promise = api.uploadBook(file)
    expect(MockXHR.instances).toHaveLength(1)
    const xhr = MockXHR.instances[0]
    expect(xhr.openCalledWith).toEqual(['POST', '/api/books'])
    expect(xhr.sent).toBeInstanceOf(FormData)
    expect((xhr.sent as FormData).get('file')).toBe(file)
    xhr.status = 201
    xhr.responseText = JSON.stringify({ id: 'b1', title: 'libro.epub', author: '', format: 'epub', cover_url: null, file_url: '/api/files/u1/b1.epub', total_pages: null, file_size: 5, added_at: 't', percent: null, position: null, last_read: null })
    xhr.onload?.()
    await expect(promise).resolves.toMatchObject({ id: 'b1', format: 'epub' })
  })

  it('reporta progreso y rechaza con ApiError en no-201', async () => {
    const file = new File(['datos'], 'libro.pdf', { type: 'application/pdf' })
    const seen: number[] = []
    const promise = api.uploadBook(file, (p) => seen.push(p))
    const xhr = MockXHR.instances[0]
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 4 } as ProgressEvent)
    xhr.status = 415
    xhr.responseText = JSON.stringify({ message: 'Unsupported Media Type' })
    xhr.onload?.()
    expect(seen).toEqual([0.5])
    await expect(promise).rejects.toMatchObject({ status: 415, message: 'Unsupported Media Type' })
    await expect(promise).rejects.toBeInstanceOf(ApiError)
  })

  it('rechaza con mensaje por defecto si la respuesta no es JSON', async () => {
    const promise = api.uploadBook(new File(['x'], 'a.pdf'))
    const xhr = MockXHR.instances[0]
    xhr.status = 500
    xhr.responseText = ''
    xhr.onload?.()
    await expect(promise).rejects.toMatchObject({ status: 500, message: 'Error al subir' })
  })
})
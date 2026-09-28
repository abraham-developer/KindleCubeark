// helpers compartidos para subir libros por multipart real (inyección con boundary a mano)
const BOUNDARY = '----kindlecubeformboundary7d1b'

export { BOUNDARY }

export function multipartBody(buf: Buffer, name = 'libro.pdf', type = 'application/pdf', fieldName = 'file'): Buffer {
  const head = Buffer.from(
    `--${BOUNDARY}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${name}"\r\n` +
    `Content-Type: ${type}\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`)
  return Buffer.concat([head, buf, tail])
}

export async function registerAndGetCookie(app: any, email = 'user@test.dev'): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'password123' } })
  return res.cookies.find((c: { name: string }) => c.name === 'session')!.value
}

// sube el libro y devuelve el registro creado (lo que Task 7 necesita)
export async function uploadBook(app: any, cookie: string, buf: Buffer, name = 'libro.pdf', type = 'application/pdf') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/books',
    cookies: { session: cookie },
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: multipartBody(buf, name, type),
  })
  if (res.statusCode !== 201) throw new Error(`upload falló: ${res.statusCode} ${res.body}`)
  return res.json()
}
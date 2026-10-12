// apps/web/src/api.ts
export class ApiError extends Error { constructor(public status: number, message: string) { super(message) } }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, { ...init, headers: { ...(init?.headers as object) } })
  if (res.status === 401 && !path.startsWith('/auth/')) {
    location.assign('/login'); throw new ApiError(401, 'Sesión requerida')
  }
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({ message: res.statusText }))).message)
  return res.status === 204 ? (undefined as T) : res.json()
}

export type Position = { page: number; block?: number; blockCount?: number; face?: 'orig' | 'trans' } | { cfi: string; percent: number; section: number }
export type Visibility = 'personal' | 'global'
export type Book = { id: string; title: string; author: string; format: 'pdf' | 'epub'; cover_url: string | null; file_url: string; total_pages: number | null; file_size: number; added_at: string; folder_id: string | null; visibility: Visibility; owner_email?: string | null; is_mine?: boolean; percent: string | null; position: Position | null; last_read: string | null }
export type Annotation = { id: string; book_id: string; kind: 'highlight' | 'note'; position: any; quoted_text: string; note: string; color: string; created_at: string }
export type Folder = { id: string; name: string; color: string; book_count: number; created_at: string }

export const api = {
  register: (email: string, password: string) => request<{ id: string; email: string }>('/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }),
  login: (email: string, password: string) => request<{ id: string; email: string }>('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: () => request<{ id: string; email: string } | null>('/auth/me').catch(() => null),
  listBooks: () => request<Book[]>('/books'),
  getBook: (id: string) => request<{ book: Book; progress: { position: Position; percent: string } | null }>(`/books/${id}`),
  uploadBook: (file: File, onProgress?: (p: number) => void, visibility: Visibility = 'personal') => new Promise<Book>((resolve, reject) => {
    const fd = new FormData(); fd.append('file', file); fd.append('visibility', visibility)
    const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/books')
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total)
    xhr.onload = () => xhr.status === 201 ? resolve(JSON.parse(xhr.responseText)) : reject(new ApiError(xhr.status, JSON.parse(xhr.responseText || '{}').message ?? 'Error al subir'))
    xhr.send(fd)
  }),
  listGlobalBooks: (q?: string) => request<Book[]>(`/books/global${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  adoptBook: (id: string) => request<Book>(`/books/${id}/adopt`, { method: 'POST' }),
  patchCover: (id: string, blob: Blob) => request<Book>(`/books/${id}/cover`, { method: 'PATCH', headers: { 'content-type': blob.type || 'image/jpeg' }, body: blob }),
  deleteBook: (id: string) => request<void>(`/books/${id}`, { method: 'DELETE' }),
  patchProgress: (id: string, position: Position, percent: number) => request<{ position: Position; percent: number; updated_at: string }>(`/books/${id}/progress`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ position, percent }) }),
  resetProgress: (id: string) => request<void>(`/books/${id}/progress`, { method: 'DELETE' }),
  listFolders: () => request<Folder[]>('/folders'),
  createFolder: (name: string, color: string) => request<Folder>('/folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, color }) }),
  updateFolder: (id: string, patch: { name?: string; color?: string }) => request<Folder>(`/folders/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }),
  deleteFolder: (id: string) => request<void>(`/folders/${id}`, { method: 'DELETE' }),
  setBookFolder: (bookId: string, folderId: string | null) => request<Book>(`/books/${bookId}/folder`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folder_id: folderId }) }),
  setBookVisibility: (bookId: string, visibility: Visibility) => request<Book>(`/books/${bookId}/visibility`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visibility }) }),
  listAnnotations: (bookId: string) => request<Annotation[]>(`/books/${bookId}/annotations`),
  createAnnotation: (bookId: string, body: Pick<Annotation, 'kind' | 'position'> & Partial<Pick<Annotation, 'quoted_text' | 'note' | 'color'>>) => request<Annotation>(`/books/${bookId}/annotations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  deleteAnnotation: (id: string) => request<void>(`/annotations/${id}`, { method: 'DELETE' }),
  translate: (q: string, target: string) => request<{ translated_text: string }>('/translate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q, target }) }),
}
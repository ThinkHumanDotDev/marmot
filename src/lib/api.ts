/**
 * Typed fetch wrapper for calling Marmot's own HTTP API (Payload REST + custom routes) from
 * client components. Always sends cookies so the `payload-token` session applies.
 */

export class ApiError extends Error {
  readonly status: number
  readonly details: unknown

  constructor(message: string, status: number, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.details = details
  }
}

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null

export interface RequestOptions extends Omit<RequestInit, 'body' | 'method'> {
  /** JSON-serialised request body. */
  body?: Json
  /** Query string parameters; `undefined` values are skipped. */
  query?: Record<string, string | number | boolean | undefined>
}

interface PayloadErrorBody {
  errors?: { message?: string; data?: unknown }[]
  message?: string
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const typed = body as PayloadErrorBody
    const first = typed.errors?.[0]?.message
    if (first) return first
    if (typed.message) return typed.message
  }
  return fallback
}

export async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  { body, query, headers, ...init }: RequestOptions = {},
): Promise<T> {
  const res = await fetch(buildUrl(path, query), {
    ...init,
    method,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  const data = await parseBody(res)
  if (!res.ok) {
    throw new ApiError(errorMessage(data, `${res.status} ${res.statusText}`), res.status, data)
  }
  return data as T
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>('GET', path, options),
  post: <T>(path: string, body?: Json, options?: RequestOptions) =>
    request<T>('POST', path, { ...options, body }),
  patch: <T>(path: string, body?: Json, options?: RequestOptions) =>
    request<T>('PATCH', path, { ...options, body }),
  put: <T>(path: string, body?: Json, options?: RequestOptions) =>
    request<T>('PUT', path, { ...options, body }),
  delete: <T>(path: string, options?: RequestOptions) => request<T>('DELETE', path, options),
}

// ---- Auth (Payload `users` auth endpoints) -------------------------------------------------

export interface SessionUser {
  id: string | number
  email: string
  name?: string | null
}

/**
 * `POST /api/auth/login`: either a signed-in user, or `requiresTwoFactor` when the account needs a
 * code (`POST /api/auth/2fa`). The challenge also travels in an HttpOnly cookie; the body copy is
 * for clients without a cookie jar.
 */
export interface LoginResponse {
  user?: SessionUser
  token?: string
  exp?: number
  requiresTwoFactor?: boolean
  challenge?: string
}

export interface TwoFactorLoginResponse {
  user: SessionUser
  exp?: number
  method: 'totp' | 'backup'
}

export interface AuthConfig {
  signupEnabled: boolean
}

/** `GET /api/auth/providers` (see `src/auth/oidc`). */
export interface AuthProviders {
  local: true
  oidc: { enabled: boolean; displayName: string }
}

export const authApi = {
  config: () => api.get<AuthConfig>('/api/auth/config'),
  providers: () => api.get<AuthProviders>('/api/auth/providers'),
  /** Ends the Payload session; `redirectTo` is the provider's end-session URL or `/login`. */
  oidcLogout: () => api.post<{ redirectTo: string }>('/api/auth/oidc/logout'),
  /** Marmot's login wrapper: honours two-factor authentication (see `src/auth/two-factor`). */
  login: (data: { email: string; password: string }) =>
    api.post<LoginResponse>('/api/auth/login', data),
  /** Second step: TOTP or backup code for the pending challenge. */
  twoFactor: (data: { code: string; challenge?: string }) =>
    api.post<TwoFactorLoginResponse>('/api/auth/2fa', data),
  signup: (data: { email: string; password: string; name?: string }) =>
    api.post<{ doc: SessionUser }>('/api/users', data),
  logout: () => api.post<{ message?: string }>('/api/users/logout'),
  forgotPassword: (data: { email: string }) =>
    api.post<{ message?: string }>('/api/users/forgot-password', data),
  resetPassword: (data: { token: string; password: string }) =>
    api.post<LoginResponse>('/api/users/reset-password', data),
  me: () => api.get<{ user: SessionUser | null }>('/api/users/me'),
}

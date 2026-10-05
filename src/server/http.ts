import { APIError, getPayload, type Payload } from 'payload'

import config from '@payload-config'
import type { User } from '@/payload-types'

/**
 * Helpers for Marmot's own Next.js route handlers (`src/app/api/**`). They authenticate the
 * request with Payload (cookie or `Authorization: JWT …`), normalise ids for the configured
 * database adapter and turn thrown errors into JSON responses.
 */

export type RequestUser = User & { collection: 'users' }

export async function getRequestContext(
  request: Request,
): Promise<{ payload: Payload; user: RequestUser | null }> {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: request.headers })
  return { payload, user: (user as RequestUser | null) ?? null }
}

/** Postgres/SQLite use numeric ids, MongoDB uses strings. */
export function parseId(payload: Payload, raw: string): string | number {
  return payload.db.defaultIDType === 'number' && /^\d+$/.test(raw) ? Number(raw) : raw
}

export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    const text = await request.text()
    return (text ? JSON.parse(text) : {}) as T
  } catch {
    throw new APIError('Request body must be JSON.', 400)
  }
}

export const jsonError = (message: string, status: number) =>
  Response.json({ errors: [{ message }] }, { status })

export const unauthorized = () => jsonError('You must be signed in.', 401)

/**
 * Wraps a handler so `APIError`s (and Payload validation errors) become `{ errors: [...] }`
 * responses with their status instead of 500s.
 */
export function withErrors<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args) => {
    try {
      return await handler(...args)
    } catch (error) {
      if (error instanceof APIError) {
        const status = error.status >= 400 && error.status < 600 ? error.status : 500
        return jsonError(error.message, status)
      }
      throw error
    }
  }
}

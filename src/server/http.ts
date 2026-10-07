import { APIError, getPayload, type Payload } from 'payload'

import config from '@payload-config'
import type { User } from '@/payload-types'
import {
  apiError,
  LocalizedAPIError,
  translateError,
  type ErrorKey,
  type ErrorValues,
} from '@/server/errors'
import { rememberRequestUser, requestLocale } from '@/server/request-locale'

export { errorText, requestLocale } from '@/server/request-locale'

/**
 * Helpers for Marmot's own Next.js route handlers (`src/app/api/**`). They authenticate the
 * request with Payload (cookie or `Authorization: JWT …`), normalise ids for the configured
 * database adapter and turn thrown errors into JSON responses. Error messages built from
 * `errors.*` keys (`apiError`, `localizedError`) are rendered in the request's locale.
 */

export type RequestUser = User & { collection: 'users' }

export async function getRequestContext(
  request: Request,
): Promise<{ payload: Payload; user: RequestUser | null }> {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: request.headers })
  rememberRequestUser(request, user as User | null)
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
    throw apiError('invalidJson', 400)
  }
}

export const jsonError = (message: string, status: number) =>
  Response.json({ errors: [{ message }] }, { status })

/** `jsonError` with an `errors.*` message in the request's locale. */
export const localizedError = (
  request: Request,
  key: ErrorKey,
  status: number,
  values?: ErrorValues,
) => jsonError(translateError(requestLocale(request), key, values), status)

export const unauthorized = (request: Request) => localizedError(request, 'unauthorized', 401)

export const forbidden = (request: Request) => localizedError(request, 'forbidden', 403)

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
        const request = args.find((arg): arg is Request => arg instanceof Request)
        const message =
          error instanceof LocalizedAPIError && request
            ? error.messageIn(requestLocale(request))
            : error.message
        return jsonError(message, status)
      }
      throw error
    }
  }
}

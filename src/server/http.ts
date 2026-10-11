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
import { authenticateRequest } from '@/server/auth/request-auth'
import { requestLocale } from '@/server/request-locale'

export { errorText, requestLocale } from '@/server/request-locale'

/**
 * Helpers for Marmot's own Next.js route handlers (`src/app/api/**`). They authenticate the
 * request with Payload (cookie or `Authorization: JWT …`), normalise ids for the configured
 * database adapter and turn thrown errors into JSON responses. Error messages built from
 * `errors.*` keys (`apiError`, `localizedError`) are rendered in the request's locale.
 */

export type RequestUser = User & { collection: 'users' }

/**
 * The Payload instance and the request principal (`authenticateRequest`: session, or an organization
 * API key on `/api/orgs/:orgId/…`). `response` is set when an API key was sent but may not make this
 * request (401/403/429); return it as is.
 */
export async function getRequestContext(
  request: Request,
): Promise<{ payload: Payload; user: RequestUser | null; response?: Response }> {
  const payload = await getPayload({ config })
  const auth = await authenticateRequest(payload, request)
  if (auth.response) return { payload, user: null, response: auth.response }
  return { payload, user: auth.user }
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

export const jsonError = (message: string, status: number, data?: unknown) =>
  Response.json({ errors: [{ message, ...(data !== undefined ? { data } : {}) }] }, { status })

/** Structured details a client may act on: the plan limit of a 402 (`entitlement_exceeded`). */
const publicData = (error: APIError): unknown => {
  const data = error.data as { code?: unknown } | undefined
  return data && data.code === 'entitlement_exceeded' ? data : undefined
}

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
        return jsonError(message, status, publicData(error))
      }
      throw error
    }
  }
}
